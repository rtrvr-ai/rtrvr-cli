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
- HTTP 200 carries the final execution response. HTTP 202 carries the run handle; the client follows events and reads its full final response.
- Stream previews never replace the full final response.
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
  - `--no-stream` hides progress and does not force `emitEvents`. HTTP 202 completion still uses the events relay.
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

## CLI/SDK 0.3.0 transport

- Cloud `/agent` and `/scrape` always carry a `trajectoryId` and matching `Idempotency-Key`. All attempts within a call use the same body and identity.
- `Retry-After` on 429/503 is a minimum delay within one monotonic caller deadline. Retries never reset it.
- `Prefer: respond-async` is advisory. HTTP 200 retains the existing result path. HTTP 202 follows the API-key MCP relay `/cli/executions/:id/events` with durable `since` resume until termination, then reads the full response.
- The default client wait covers 45 minutes. An explicit SDK `timeoutMs` bounds the complete call. The server owns run limits.
- Ctrl-C posts cloud cancel and waits for acknowledgement or a bounded 10 seconds, then exits 130. A network drop only reconnects the event follower.
- Routing controls stay off cloud request bodies. Errors retain server code, fields, requestId and any partial result.

- Async progress observers and CLI output obey backpressure under the same abort/deadline. SDK `includeEventOutput` is client-only.
- A progress byte-envelope repair resumes without output, retaining the run id and sequence. The client still reads the complete final response.
