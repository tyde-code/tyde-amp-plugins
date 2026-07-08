# Tyde Amp Plugins

Local Amp plugins maintained for the Tyde workspace.

This repo is structured so plugins live at the same relative path Amp expects inside a workspace:

```text
tyde-amp-plugins/
|-- LICENSE
|-- README.md
`-- .amp/
    `-- plugins/
        `-- openai-subscription-quota.ts
```

That makes installation a copy operation from this repo into another Amp workspace.

## Manual installation

Copy the plugin files you want from this repo:

```text
tyde-amp-plugins\.amp\plugins\
```

to the target workspace:

```text
<your-workspace>\.amp\plugins\
```

For example, to install the OpenAI subscription quota plugin into the Tyde workspace, copy:

```text
tyde-amp-plugins\.amp\plugins\openai-subscription-quota.ts
```

to:

```text
c:\share\tyde\.amp\plugins\openai-subscription-quota.ts
```

If the target workspace does not have an `.amp\plugins` folder yet, create it first. Restart Amp or reload the workspace after copying plugin files so Amp loads them.

## Plugins

### OpenAI Subscription Quota

File: `.amp/plugins/openai-subscription-quota.ts`

The OpenAI subscription quota plugin checks ChatGPT/Codex subscription quota from the Codex CLI auth file and warns when quota is low at thread start.

#### What it does

- Reads Codex/ChatGPT auth data from `~/.codex/auth.json`.
- Calls `https://chatgpt.com/backend-api/wham/usage` to fetch quota usage, with a 10 second timeout.
- Shows primary and secondary quota windows, remaining percentage, and reset timing.
- Shows a sanitized quota source label instead of the full local auth file path.
- Warns on Amp thread/session start when remaining quota is at or below the configured threshold.
- Falls back to a tiny OpenAI provider probe when the Codex quota endpoint cannot be read.

#### Commands

##### `OpenAI: Check subscription quota`

Command ID: `openai-subscription-quota`

Use this from Amp's command palette to show a quota report for the current thread.

If Codex quota can be read, the command shows:

- sanitized quota source label
- plan type
- allowed / limit-reached status
- primary quota window
- secondary quota window
- credits, spend control, and reset-credit details when present

If Codex quota cannot be read, the command asks for a reasoning effort and runs a small provider probe against `openai/gpt-5.5`.

##### `OpenAI: Set quota warning threshold`

Command ID: `openai-quota-warning-threshold`

Use this from Amp's command palette to configure when thread-start warnings appear.

- Value is a percentage from `0` to `100`.
- The warning triggers when a quota window has this percentage remaining or less.
- Use `0` to disable thread-start warnings.
- Default is controlled in the plugin by `DEFAULT_WARNING_THRESHOLD_PERCENT`.

#### Agent tool

Tool name: `openai_subscription_quota`

The agent can call this tool to return the same quota report in a thread.

Inputs:

| Input | Required | Default | Description |
|---|---:|---|---|
| `reasoningEffort` | No | `medium` | Reasoning effort for the fallback provider probe. One of `none`, `low`, `medium`, `high`, `xhigh`. |

For least privilege, the agent tool does not accept a custom auth file path. It always reads `DEFAULT_CODEX_AUTH_PATH` from the plugin source.

Example prompt:

```text
Use the openai_subscription_quota tool with reasoningEffort medium.
```

#### Configuration

Amp global config key:

```text
openaiSubscriptionQuotaWarningPercent
```

The plugin command `OpenAI: Set quota warning threshold` writes this value for you.

Manual meaning:

- `7` means warn when a quota window has about 7% or less remaining.
- `25` means warn when a quota window has about 25% or less remaining.
- `0` disables thread-start warnings.

If the config value is missing or invalid, the plugin uses:

```ts
const DEFAULT_WARNING_THRESHOLD_PERCENT = 7
```

#### Plugin constants

These are edited directly in `.amp/plugins/openai-subscription-quota.ts`.

##### `DEFAULT_CODEX_AUTH_PATH`

Default auth file location:

```ts
const DEFAULT_CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json')
```

Override only if Codex auth is stored somewhere else.

Custom auth paths are intentionally kept as a source-level constant instead of an agent tool input, so prompts cannot ask the tool to read arbitrary local files.

##### `DEFAULT_WARNING_THRESHOLD_PERCENT`

Fallback threshold used when Amp config does not contain a valid value:

```ts
const DEFAULT_WARNING_THRESHOLD_PERCENT = 7
```

Prefer using the command palette threshold command for normal changes.

##### `THREAD_START_WARNING_DISPLAY`

Controls how the low-quota warning appears when a thread/session starts:

```ts
const THREAD_START_WARNING_DISPLAY = 'notification' as ThreadStartWarningDisplay
//const THREAD_START_WARNING_DISPLAY = 'dialog' as ThreadStartWarningDisplay
```

Available values:

- `'notification'` - Amp banner notification. This is non-blocking, but Amp does not expose duration or click-dismiss controls for plugin notifications.
- `'dialog'` - Amp confirmation dialog with a `Close` button. This is click-to-close and stays visible until closed, but it is more intrusive than a banner.

To make the thread-start warning click-to-close, switch the active line to:

```ts
const THREAD_START_WARNING_DISPLAY = 'dialog' as ThreadStartWarningDisplay
```

#### Usage flow

1. Install `.amp/plugins/openai-subscription-quota.ts` into the target workspace.
2. Restart Amp or reload the workspace.
3. Open or start a thread.
4. If quota is low, the plugin checks Codex quota on `session.start` and shows a warning.
5. To check manually, run `OpenAI: Check subscription quota` from the command palette.
6. To change the low-quota threshold, run `OpenAI: Set quota warning threshold`.

#### Limitations

- The ChatGPT/Codex quota endpoint is not a public supported API and may change.
- The plugin depends on a valid Codex CLI auth file with `tokens.access_token` and `tokens.account_id`.
- Amp's plugin `ui.notify(message)` API does not currently expose notification duration, a close handle, or click callbacks.
- The fallback provider probe only confirms whether Amp can reach the configured OpenAI provider. It cannot reveal remaining ChatGPT Plus/Pro quota.

## Development checks

Use Bun to check that a plugin can transpile without relying on local `node_modules` TypeScript tooling:

```powershell
bun build .amp/plugins/openai-subscription-quota.ts --outfile _temp\openai-subscription-quota.check.js
del _temp\openai-subscription-quota.check.js
```

This catches syntax and bundling issues. It is not a full typecheck of Amp's plugin API.

## License

MIT License. See [LICENSE](LICENSE).
