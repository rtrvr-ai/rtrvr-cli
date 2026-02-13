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
- `--no-stream` disables SSE and CLI does not force `emitEvents` (cloud + extension).
- `--no-stream-output` keeps live status events while suppressing streamed output payloads.
- Payloads `<=1MB` remain inline in `output`/`result`; larger payloads keep inline preview markers plus ref fields (`outputRef` / `resultRef` / `responseRef`).
- Refs are additive: preview stays in `output`/`result`, and full content is downloaded via the ref URL/path.

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
