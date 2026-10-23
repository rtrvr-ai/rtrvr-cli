# rtrvr.ai CLI Operations Guide

Operational runbook for humans and agent runtimes using `rtrvr` in production.

## Recommended defaults

- `defaultTarget=auto`
- `preferExtensionByDefault=false` for server-side agents
- `authStorage=auto` (secure store first)
- `retryMaxAttempts=3` for network-variable environments

## Auth runbook

Interactive human setup:

```bash
rtrvr auth login --oauth
rtrvr auth status
```

Headless agent setup:

```bash
export RTRVR_AUTH_TOKEN=rtrvr_...
rtrvr auth status --json
```

Endpoint override setup (optional, for private domains/staging):

```bash
export RTRVR_CLOUD_BASE_URL=https://api.rtrvr.ai
export RTRVR_MCP_BASE_URL=https://mcp.rtrvr.ai
export RTRVR_CONTROL_BASE_URL=https://cli.rtrvr.ai
rtrvr auth status --json
```

Strict OAuth-only mode:

```bash
rtrvr auth login --oauth --strict-auth
```

## Targeting runbook

Use one of:

- `--target auto|cloud|extension`
- `--cloud` or `--extension` (fast shortcuts)

Examples:

```bash
rtrvr run --input "Summarize this page" --url https://example.com --cloud
rtrvr run --input "Continue checkout" --url https://example.com --extension --require-local-session
rtrvr scrape --url https://example.com --target auto
```

## Google artifact policy (v1)

- API/service mode without usable Google `authToken` runs in non-Google-write mode.
- In that mode, Sheets/Docs/Slides write operations are disabled.
- Prefer explicit `authToken` when you need Google artifact generation.
- Check capability state with `rtrvr auth google status --json`.

## Streaming + events policy

- Execution events are opt-in via `options.ui.emitEvents=true`.
- `rtrvr run` / `rtrvr agent` / `rtrvr scrape` stream by default and auto-enable `emitEvents` for that request.
- `--no-stream` hides progress and does not force `emitEvents`. HTTP 202 runs still follow events to completion.
- `--no-stream-output` keeps live status events while suppressing streamed output payloads.
- Payloads `<=1MB` remain inline in `output`/`result`; larger payloads keep inline preview markers plus ref fields (`outputRef` / `resultRef` / `responseRef`).
- Refs are additive: preview stays in `output`/`result`, and full content is downloaded via the ref URL/path.

## Run admission, deadlines and cancellation

Cloud `/agent` and `/scrape` send `Idempotency-Key` equal to `trajectoryId`. An omitted id is generated once per call, before retries, including `--no-stream` calls. Retry the same body and id when recovering an admission whose response was lost. A legacy server may answer 409 on a reused id; the client preserves that refusal and never invents a new identity to bypass it.

The client requests `Prefer: respond-async`. On HTTP 202 it follows `/cli/executions/:id/events` on the configured MCP base URL, with `includeOutput=1` internally. This is the API-key route on both clouds. EOF, network drops and temporary stream refusals reconnect from the last durable sequence. The gateway's proposed public `/agent/:id/events` route is not used.

On termination, the client reads the full response from the cloud run's `statusUrl` plus `/response`, using the same origin and credentials. Stream previews do not replace the full response. HTTP 200 returns the server's final result directly, including servers that ignore the preference.

The default client wait covers the server's 45 minute maximum run window. SDK `timeoutMs` bounds the entire call, including admission, retry delays, event following and final response retrieval. The server enforces its own run limits. A stream drop never posts another run or sends cancel.

Progress observers run sequentially, and stdout/stderr writes wait for drain under the run abort signal. SDK observers may return promises and receive that signal as their second argument. `includeEventOutput: false` is a client control for status-only events. The CLI uses it for `--no-stream-output` and `--no-stream`. Abort/deadline completion does not wait indefinitely for a blocked output pipe.

Ctrl-C sends `/agent/cancel` for an agent run, or `/scrape/cancel` for a scrape, with `{trajectoryId}`. The CLI exits with code 130 after acknowledgement or a 10 second cancellation wait. A cancellation that is not acknowledged reports `CANCEL_UNCONFIRMED` and retains the run id.

HTTP 429 and 503 honor `Retry-After` in seconds or HTTP-date form. A delay that cannot fit within the caller's remaining deadline stops with `REQUEST_DEADLINE` before another request starts. Stream frame buffers have a one MiB UTF-8 byte envelope. Oversized or unterminated output frames emit `SSE_EVENT_TOO_LARGE` as a typed repair with measured bytes and resume from the same cursor without streamed output. The full final response stays intact. A status-only stream that still breaches the envelope reports the repair and run handle.

## Skills runbook

```bash
rtrvr skills templates
rtrvr skills install-template agent-api-first
rtrvr skills validate agent-api-first
rtrvr skills apply agent-api-first "Get top headlines" --url https://news.ycombinator.com --cloud
```

## Diagnostics

```bash
rtrvr doctor --json
rtrvr profile --json
rtrvr capabilities --json
```

Key checks:

- `auth.authenticated=true`
- cloud `/health` reachable
- MCP HEAD reachable
- `devices` healthy when extension mode expected

## Failure playbooks

No auth token configured:

1. Run `rtrvr auth login --oauth` (interactive) or set `RTRVR_AUTH_TOKEN`.
2. Re-run `rtrvr auth status`.

Extension target unavailable:

1. Run `rtrvr devices list --json`.
2. If no FCM-capable device exists, sign into extension once.
3. Retry with `--target auto` to permit cloud fallback.

Capability mismatch for skills:

1. Run `rtrvr capabilities --json`.
2. Run `rtrvr skills validate <name>`.
3. Use `--skip-capability-check` only for controlled environments.

## Security posture

- Prefer secure credential storage (`authStorage=auto` or `keychain`).
- Avoid storing tokens in shell history.
- Prefer env injection from a secret manager in CI/agents.
- Rotate compromised keys immediately.

## Logging and automation

For machine pipelines, always use `--json` and parse structured output:

```bash
rtrvr run --input "task" --url https://example.com --json
```

Use `metadata.requestId` and `metadata.attempt` for traceability.

Errors preserve server `code`, offending `fields` and `requestId`. Include these when reporting a failed request. A retained partial result is printed with the error.
