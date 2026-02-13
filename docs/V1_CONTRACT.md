# rtrvr.ai CLI/SDK v1 Contract

Canonical behavior contract for `rtrvr-cli`, `rtrvr-cloud-backend`, `rtrvr-web-agent`, and `rtrvr-relay`.

## Auth Tokens

- `rtrvr_...`
  - Full cloud/API + CLI control-plane access
  - Required for cloud endpoints (`/agent`, `/scrape`, `/cli/profile`, `/cli/capabilities`)
- `mcp_at_...`
  - MCP/OAuth flows only
  - Not valid for cloud `/agent` and `/scrape`

## Routing Targets

- `--target auto|cloud|extension` (canonical)
- `--cloud` / `--extension` (shortcuts)
- `auto` uses defaults + availability:
  - extension-first only when explicitly requested or configured
  - falls back to cloud with explicit metadata

## Output Contract

- Default CLI output is human-readable text.
- `--json` is the machine contract and returns stable structured payloads.
- Final execution truth is the primary API response body.
- Streaming events are best-effort progress and never replace final response.
- Output payload policy:
  - inline when payload size is `<= 1MB`
  - when payload is `> 1MB`, response/event keeps inline preview in `output`/`result` and includes storage references (`outputRef` / `resultRef` / `responseRef`)
  - reference fields are sibling fields (preview is preserved; full payload is retrieved through ref URLs/paths)
  - oversized event payloads keep a lightweight preview marker in `output`/`result` while full content is available via refs

## Execution Events Contract (`emitEvents`)

- Events are opt-in for both cloud and extension executions.
- `/agent`, routed `/scrape`, and extension/MCP runs write Firestore execution events only when `options.ui.emitEvents === true`.
- If `emitEvents` is omitted or `false`, no event-doc stream is produced.
- CLI behavior:
  - `rtrvr run`, `rtrvr agent`, and `rtrvr scrape` stream by default and set `options.ui.emitEvents=true`.
  - `--no-stream` disables streaming and CLI no longer forces `emitEvents`.
  - `--no-stream-output` keeps status/events while omitting streamed output payloads.

## Google Auth + Artifact Policy

- Google OAuth (`drive.file`) is optional for generic runs.
- If a request does not include a usable Google `authToken` in API/service mode:
  - Sheets/Docs/Slides write flows are disabled
  - execution falls back to API-style JSON/memory outputs where applicable
  - no implicit Sheets writes are performed
- Linked server-side refresh tokens are still surfaced via capability/status endpoints.

## Stable Endpoints

- Control plane: `https://cli.rtrvr.ai`
- MCP/events: `https://mcp.rtrvr.ai`
- Cloud execution: `https://api.rtrvr.ai`
