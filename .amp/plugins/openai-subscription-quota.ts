// @openai-subscription-quota from https://raw.githubusercontent.com/tyde-code/tyde-amp-plugins/main/.amp/plugins/openai-subscription-quota.ts

import type { PluginAPI, PluginAIModel, PluginUI } from '@ampcode/plugin'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROBE_MODEL: PluginAIModel = 'openai/gpt-5.5'
const REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const
const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'
const MODEL_PROVIDER_SETTINGS_PATH = '/settings/model-providers'
// SECURITY: keep the auth path and usage URL as source-level constants. Never expose them
// as tool/command inputs — a prompt-injected agent could otherwise read arbitrary local
// files or send the Codex access token to an attacker-chosen endpoint.
const DEFAULT_CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_USAGE_TIMEOUT_MS = 10000
const WARNING_THRESHOLD_CONFIG_KEY = 'openaiSubscriptionQuotaWarningPercent'
const DEFAULT_WARNING_THRESHOLD_PERCENT = 7
// Amp notifications do not expose duration or dismiss options. Set to 'dialog' for a click-to-close warning.
const THREAD_START_WARNING_DISPLAY = 'notification' as ThreadStartWarningDisplay
//const THREAD_START_WARNING_DISPLAY = 'dialog' as ThreadStartWarningDisplay

export default function (amp: PluginAPI) {
	amp.logger.log('OpenAI subscription quota helper loaded')

	amp.on('session.start', async (_event, ctx) => {
		const threshold = await getWarningThreshold(amp)
		const usage = await readCodexUsage(DEFAULT_CODEX_AUTH_PATH)

		if (usage.status !== 'ok') {
			return
		}

		const lowWindows = lowQuotaWindows(usage.usage, threshold)

		if (lowWindows.length === 0) {
			return
		}

		await showLowQuotaWarning(ctx.ui, lowWindows, threshold)
	})

	amp.registerCommand(
		'openai-subscription-quota',
		{
			title: 'Check subscription quota',
			category: 'OpenAI',
			description: 'Read Codex ChatGPT quota from ~/.codex/auth.json, then fall back to an OpenAI provider probe.',
		},
		async (ctx) => {
			if (!ctx.thread) {
				await ctx.ui.notify('Open a thread before checking OpenAI subscription quota.')
				return
			}

			const usage = await readCodexUsage(DEFAULT_CODEX_AUTH_PATH)

			if (usage.status === 'ok') {
				await ctx.ui.confirm({
					title: 'OpenAI subscription quota',
					message: formatCodexUsageReport(usage, DEFAULT_CODEX_AUTH_PATH, amp.system.ampURL),
					confirmButtonText: 'Close',
				})
				return
			}

			const selectedEffort = await ctx.ui.select({
				title: 'Codex quota failed; run OpenAI probe?',
				message: 'Could not read Codex quota from the default Codex auth file. Choose reasoning effort for the fallback provider probe.',
				initialValue: DEFAULT_REASONING_EFFORT,
				options: [...REASONING_EFFORTS],
			})

			if (!selectedEffort) {
				return
			}

			const result = await probeOpenAIProvider(ctx.ai, ctx.thread.id, parseReasoningEffort(selectedEffort))

			await ctx.ui.confirm({
				title: 'OpenAI subscription quota',
				message: formatFallbackReport(usage, result, amp.system.ampURL),
				confirmButtonText: 'Close',
			})
		},
	)

	amp.registerCommand(
		'openai-quota-warning-threshold',
		{
			category: 'OpenAI',
			title: 'Set quota warning threshold',
			description: 'Configure the remaining quota percentage that triggers a thread-start warning. Defaults to 7%.',
		},
		async (ctx) => {
			const current = await getWarningThreshold(amp)
			const input = await ctx.ui.input({
				title: 'OpenAI quota warning threshold',
				helpText: 'Notify when a Codex quota window has this percentage remaining or less. Use 0 to disable warnings.',
				initialValue: String(current),
				submitButtonText: 'Save',
			})

			if (input === undefined) {
				return
			}

			const threshold = parseThreshold(input)

			if (threshold === null) {
				await ctx.ui.notify('Enter a number from 0 to 100 for the quota warning threshold.')
				return
			}

			await amp.configuration.update({ [WARNING_THRESHOLD_CONFIG_KEY]: threshold }, 'global')
			await ctx.ui.notify(`OpenAI quota warning threshold set to ${threshold}%.`)
		},
	)

	amp.registerTool({
		name: 'openai_subscription_quota',
		description:
			'Read ChatGPT/Codex subscription quota from Codex CLI auth.json. Falls back to probing whether Amp can reach the configured OpenAI subscription provider.',
		inputSchema: {
			type: 'object',
			properties: {
				reasoningEffort: {
					type: 'string',
					description: 'Reasoning effort for the fallback OpenAI subscription probe. Defaults to medium.',
					enum: [...REASONING_EFFORTS],
					default: DEFAULT_REASONING_EFFORT,
				},
			},
			additionalProperties: false,
		},
		async execute(input, ctx) {
			const usage = await readCodexUsage(DEFAULT_CODEX_AUTH_PATH)

			if (usage.status === 'ok') {
				return formatCodexUsageReport(usage, DEFAULT_CODEX_AUTH_PATH, undefined, { redactBilling: true })
			}

			const result = await probeOpenAIProvider(
				amp.ai,
				ctx.thread.id,
				parseReasoningEffort(input.reasoningEffort),
			)
			return formatFallbackReport(usage, result)
		},
	})
}

type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
type ThreadStartWarningDisplay = 'notification' | 'dialog'

type CodexUsageResult =
	| { status: 'ok'; usage: CodexUsage }
	| { status: 'failed'; error: string }

type CodexAuth = {
	tokens?: {
		access_token?: unknown
		account_id?: unknown
	}
}

type RateLimitWindow = {
	used_percent?: unknown
	limit_window_seconds?: unknown
	reset_after_seconds?: unknown
	reset_at?: unknown
}

type CodexUsage = {
	plan_type?: unknown
	rate_limit_reached_type?: unknown
	rate_limit?: {
		allowed?: unknown
		limit_reached?: unknown
		primary_window?: RateLimitWindow | null
		secondary_window?: RateLimitWindow | null
	} | null
	credits?: {
		has_credits?: unknown
		unlimited?: unknown
		overage_limit_reached?: unknown
		balance?: unknown
	} | null
	spend_control?: {
		reached?: unknown
		individual_limit?: unknown
	} | null
	rate_limit_reset_credits?: {
		available_count?: unknown
	} | null
}

type ProbeResult =
	| { status: 'reachable'; model: PluginAIModel; reasoningEffort: ReasoningEffort; reply: string }
	| { status: 'failed'; model: PluginAIModel; reasoningEffort: ReasoningEffort; error: string }

type AIProbeClient = {
	generate(request: {
		prompt: string
		threadID: `T-${string}`
		model: PluginAIModel
		reasoningEffort: ReasoningEffort
		maxTokens: number
	}): Promise<string>
}

type LowQuotaWindow = {
	label: string
	remainingPercent: number
	resetsIn: string
	resetsAt: string
}

async function getWarningThreshold(amp: PluginAPI) {
	try {
		const configuration = await amp.configuration.get()
		return normalizeThreshold(configuration[WARNING_THRESHOLD_CONFIG_KEY])
	} catch {
		return DEFAULT_WARNING_THRESHOLD_PERCENT
	}
}

function parseThreshold(input: string) {
	const value = Number(input.trim())
	return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value * 100) / 100 : null
}

function normalizeThreshold(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
		? value
		: DEFAULT_WARNING_THRESHOLD_PERCENT
}

function lowQuotaWindows(usage: CodexUsage, threshold: number) {
	if (threshold <= 0) {
		return []
	}

	return [
		lowQuotaWindow('Primary window', usage.rate_limit?.primary_window, threshold),
		lowQuotaWindow('Secondary window', usage.rate_limit?.secondary_window, threshold),
	].filter((window): window is LowQuotaWindow => window !== null)
}

function lowQuotaWindow(label: string, window: RateLimitWindow | null | undefined, threshold: number): LowQuotaWindow | null {
	const usedPercent = toNumber(window?.used_percent)

	if (usedPercent === null) {
		return null
	}

	const remainingPercent = Math.max(0, 100 - usedPercent)

	if (remainingPercent > threshold) {
		return null
	}

	const resetAfterSeconds = toNumber(window?.reset_after_seconds)
	const resetAt = toNumber(window?.reset_at)

	return {
		label,
		remainingPercent,
		resetsIn: resetAfterSeconds === null ? 'unknown' : formatDuration(resetAfterSeconds),
		resetsAt: resetAt === null ? 'unknown' : new Date(resetAt * 1000).toISOString(),
	}
}

function formatLowQuotaNotification(windows: LowQuotaWindow[], threshold: number) {
	const details = windows.map(
		(window) => `${window.label}: ~${window.remainingPercent}% remaining, resets in ${window.resetsIn}`,
	)

	return [`OpenAI/Codex quota is at or below ${threshold}%.`, ...details].join('\n')
}

async function showLowQuotaWarning(ui: PluginUI, windows: LowQuotaWindow[], threshold: number) {
	const message = formatLowQuotaNotification(windows, threshold)

	if (THREAD_START_WARNING_DISPLAY === 'dialog') {
		await ui.confirm({
			title: 'OpenAI/Codex quota warning',
			message,
			confirmButtonText: 'Close',
		})
		return
	}

	await ui.notify(message)
}

async function readCodexUsage(authJsonPath: string): Promise<CodexUsageResult> {
	let auth: CodexAuth

	try {
		auth = JSON.parse(await readFile(authJsonPath, 'utf8')) as CodexAuth
	} catch {
		// Fixed message: raw readFile/JSON errors leak the local path (and username) into reports.
		return { status: 'failed', error: 'Could not read or parse the Codex auth file' }
	}

	const accessToken = auth.tokens?.access_token
	const accountID = auth.tokens?.account_id

	if (typeof accessToken !== 'string' || !accessToken) {
		return { status: 'failed', error: 'No tokens.access_token found in Codex auth file' }
	}

	if (typeof accountID !== 'string' || !accountID) {
		return { status: 'failed', error: 'No tokens.account_id found in Codex auth file' }
	}

	try {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS)

		try {
			const response = await fetch(CODEX_USAGE_URL, {
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'ChatGPT-Account-Id': accountID,
				},
			})

			if (!response.ok) {
				// statusText is remote-controlled reason text; don't echo it.
				return { status: 'failed', error: `Codex usage request failed (HTTP ${response.status})` }
			}

			// Keep the abort timer active here: response.json() streams the body and can stall too.
			return { status: 'ok', usage: await response.json() as CodexUsage }
		} finally {
			clearTimeout(timeout)
		}
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return { status: 'failed', error: `Codex usage request timed out after ${CODEX_USAGE_TIMEOUT_MS / 1000}s` }
		}

		return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
	}
}

async function probeOpenAIProvider(
	ai: AIProbeClient,
	threadID: `T-${string}`,
	reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT,
): Promise<ProbeResult> {
	try {
		const reply = await ai.generate({
			threadID,
			model: PROBE_MODEL,
			reasoningEffort,
			maxTokens: 8,
			prompt: 'Reply with exactly: OK',
		})

		return { status: 'reachable', model: PROBE_MODEL, reasoningEffort, reply: reply.trim() }
	} catch (error) {
		return {
			status: 'failed',
			model: PROBE_MODEL,
			reasoningEffort,
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

function parseReasoningEffort(value: unknown): ReasoningEffort {
	return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort)
		? (value as ReasoningEffort)
		: DEFAULT_REASONING_EFFORT
}

function formatCodexUsageReport(
	result: Extract<CodexUsageResult, { status: 'ok' }>,
	authJsonPath: string,
	ampURL?: URL,
	options?: { redactBilling?: boolean },
) {
	const usage = result.usage
	const lines = [
		`Quota source: ${formatAuthSource(authJsonPath)}`,
		`Usage endpoint: ${CODEX_USAGE_URL}`,
		`Plan: ${formatValue(usage.plan_type)}`,
		`Allowed: ${formatValue(usage.rate_limit?.allowed)}`,
		`Limit reached: ${formatValue(usage.rate_limit?.limit_reached)}`,
		`Rate-limit reached type: ${formatValue(usage.rate_limit_reached_type)}`,
		'',
		...formatWindow('Primary window', usage.rate_limit?.primary_window),
		'',
		...formatWindow('Secondary window', usage.rate_limit?.secondary_window),
	]

	if (usage.credits) {
		lines.push(
			'',
			'Credits:',
			`  has_credits: ${formatValue(usage.credits.has_credits)}`,
			`  unlimited: ${formatValue(usage.credits.unlimited)}`,
			`  overage_limit_reached: ${formatValue(usage.credits.overage_limit_reached)}`,
			// Tool output enters the agent thread, which may sync to ampcode.com; keep the billing balance local-only.
			`  balance: ${options?.redactBilling ? '(redacted in tool output)' : formatValue(usage.credits.balance)}`,
		)
	}

	if (usage.spend_control) {
		lines.push(
			'',
			'Spend control:',
			`  reached: ${formatValue(usage.spend_control.reached)}`,
			`  individual_limit: ${usage.spend_control.individual_limit ? 'present' : 'none'}`,
		)
	}

	if (usage.rate_limit_reset_credits) {
		lines.push(
			'',
			'Reset credits:',
			`  available_count: ${formatValue(usage.rate_limit_reset_credits.available_count)}`,
		)
	}

	if (ampURL) {
		lines.push('', `Amp model provider settings: ${new URL(MODEL_PROVIDER_SETTINGS_PATH, ampURL).toString()}`)
	}

	return lines.join('\n')
}

function formatAuthSource(authJsonPath: string) {
	return authJsonPath === DEFAULT_CODEX_AUTH_PATH ? '~/.codex/auth.json' : 'custom Codex auth path'
}

function formatFallbackReport(usage: Extract<CodexUsageResult, { status: 'failed' }>, result: ProbeResult, ampURL?: URL) {
	const lines = [
		'Codex quota source: failed',
		`Codex quota error: ${sanitizeRemoteText(usage.error)}`,
		'',
		`Provider probe model: ${result.model}`,
		`Provider probe reasoning effort: ${result.reasoningEffort}`,
		`Provider probe status: ${result.status}`,
	]

	if (result.status === 'reachable') {
		lines.push(`Probe reply: ${result.reply ? sanitizeRemoteText(result.reply) : '(empty)'}`)
	} else {
		lines.push(`Probe error: ${sanitizeRemoteText(result.error)}`)
	}

	lines.push(
		'',
		'Remaining quota: unknown',
		'Amp plugins can make a tiny OpenAI-routed probe request, but the current Amp plugin API does not expose model-provider subscription details or remaining ChatGPT Plus/Pro message quota.',
		'OpenAI also does not publish a supported API for remaining ChatGPT Plus/Pro subscription quota. API billing/usage endpoints are separate from ChatGPT subscriptions.',
	)

	if (ampURL) {
		lines.push('', `Amp model provider settings: ${new URL(MODEL_PROVIDER_SETTINGS_PATH, ampURL).toString()}`)
	}

	return lines.join('\n')
}

function formatWindow(label: string, window: RateLimitWindow | null | undefined) {
	if (!window) {
		return [`${label}: unavailable`]
	}

	const usedPercent = toNumber(window.used_percent)
	const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent)
	const limitSeconds = toNumber(window.limit_window_seconds)
	const resetAfterSeconds = toNumber(window.reset_after_seconds)
	const resetAt = toNumber(window.reset_at)

	return [
		`${label}:`,
		`  used: ${usedPercent === null ? 'unknown' : `${usedPercent}%`}`,
		`  remaining: ${remainingPercent === null ? 'unknown' : `~${remainingPercent}%`}`,
		`  window: ${limitSeconds === null ? 'unknown' : formatDuration(limitSeconds)}`,
		`  resets in: ${resetAfterSeconds === null ? 'unknown' : formatDuration(resetAfterSeconds)}`,
		`  resets at: ${resetAt === null ? 'unknown' : new Date(resetAt * 1000).toISOString()}`,
	]
}

function formatDuration(totalSeconds: number) {
	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor((totalSeconds % 86400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)

	if (days > 0) {
		return `${days}d ${hours}h ${minutes}m`
	}

	if (hours > 0) {
		return `${hours}h ${minutes}m`
	}

	return `${minutes}m`
}

// The usage response comes from a remote endpoint and its string fields end up in
// tool output (agent context). Strip control characters and clamp length so a
// compromised or intercepted response cannot inject multi-line instructions.
const MAX_REMOTE_VALUE_LENGTH = 100

function sanitizeRemoteText(text: string) {
	const cleaned = text
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/[\u200b-\u200d\ufeff\u202a-\u202e]+/g, '')
		.trim()
	return cleaned.length > MAX_REMOTE_VALUE_LENGTH ? `${cleaned.slice(0, MAX_REMOTE_VALUE_LENGTH)}…` : cleaned
}

function formatValue(value: unknown) {
	return value === null || value === undefined || value === '' ? 'none' : sanitizeRemoteText(String(value))
}

function toNumber(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}
