# rtrvr CLI + SDK

Unified CLI + SDK for rtrvr.ai, built for both humans and agentic runtimes.

## What this ships

- `@rtrvr-ai/cli` (`rtrvr` binary)
- `@rtrvr-ai/sdk` (TypeScript SDK)
- `@rtrvr-ai/core` (routing, auth, and transport primitives)

## Endpoint architecture

- Control plane (CLI auth/profile/capabilities): `https://cli.rtrvr.ai`
- Execution data plane (MCP + execution events): `https://mcp.rtrvr.ai`
- Cloud automation plane (`/agent`, `/scrape`): `https://api.rtrvr.ai`

## Install (local dev)

```bash
pnpm install
pnpm build
node packages/cli/dist/index.js --help
```

## CLI quickstart

```bash
rtrvr auth login --oauth
rtrvr run "Extract top 10 products and prices" --url https://example.com --target auto
rtrvr agent --input "Visit the URL and return a structured summary" --url https://example.com
rtrvr scrape --url https://example.com --target auto
rtrvr profile
rtrvr capabilities
rtrvr doctor
```

## Command model

- High-level commands: `run`, `agent`, `scrape`
- Introspection: `profile`, `capabilities`, `doctor`, `debug:endpoints`
- Auth: `auth login`, `auth status`, `auth logout`
- Skills: `skills add|list|show|validate|apply|export|templates`
- MCP setup: `mcp init`

### Input sources (`run`/`agent`)

Exactly one explicit source at a time:

- positional: `rtrvr run "task"`
- inline: `rtrvr run --input "task"`
- file: `rtrvr run --input-file ./task.txt`
- stdin: `echo "task" | rtrvr run`
- explicit stdin: `rtrvr run --input -`

## Routing behavior

Canonical selector:

- `--target auto|cloud|extension`

Fast selectors:

- `--cloud` and `--extension`

Behavior:

- `run`/`agent` with `target=cloud` routes to cloud `/agent`
- `run`/`agent` with `target=extension` routes to extension `planner` via MCP/direct API
- `scrape` with `target=extension` uses extension `scrape`
- `target=auto` uses configured defaults + availability/fallback logic

## Response model

- Default output is human-readable text.
- Use `--json` for strict machine parsing.
- Streaming is best-effort progress only; final output comes from the main response.

## Auth model

### Tokens

- `rtrvr_...` API keys: full cloud + CLI control endpoints
- `mcp_at_...` tokens: MCP/OAuth endpoint usage only

### Login methods

- OAuth bootstrap: `rtrvr auth login --oauth`
- Direct API key: `rtrvr auth login --api-key rtrvr_...`

### Storage

- default `authStorage=auto` (OS secure store preferred)
- fallback `authStorage=config`
- environment overrides:
  - `RTRVR_AUTH_TOKEN`
  - `RTRVR_API_KEY`
  - `RTRVR_CLOUD_BASE_URL`
  - `RTRVR_MCP_BASE_URL`
  - `RTRVR_CONTROL_BASE_URL`

### Google OAuth in CLI

Google OAuth is optional in CLI/API mode.

- If Google auth is not linked, generic tool flows still run in JSON/API mode.
- Google-dependent flows (Sheets/Docs/Drive/Slides) expose explicit capability status via:
  - `GET /cli/google-auth/status`
  - `rtrvr capabilities`
- In API/service mode without a usable `authToken`, Google write flows are disabled (no implicit Sheets writes).

## Progress streaming (SSE)

Long-running executions can be streamed from:

- `GET https://mcp.rtrvr.ai/cli/executions/{trajectoryId}/events`

Supported query params:

- `phase` (default `1`)
- `since` (sequence cursor; default `0`)
- `includeOutput` (default `false`)

Payload size policy for streamed outputs:

- inline `output`/`result` when payload is `<= 1MB`
- when payload is `> 1MB`, events keep inline preview markers in `output`/`result` and include storage-backed references (`outputRef`/`resultRef`)
- when the full envelope itself is oversized, responses may additionally include `metadata.responseRef`
- reference fields are additive (preview remains in `output`/`result`; full payload is in the ref URL/path)

The CLI consumes stream events opportunistically:

- stream failures do not invalidate final execution response
- final output always comes from the primary run response
- by default, `rtrvr run` / `rtrvr agent` / `rtrvr scrape` open SSE and set `options.ui.emitEvents=true`
- use `--no-stream` to disable SSE + emit events for that request
- use `--no-stream-output` to suppress streamed output payloads while keeping status events

`emitEvents` contract:

- Cloud/API (`/agent`, routed `/scrape`) : events are written only when `options.ui.emitEvents` is explicitly `true`
- Extension/MCP mode: execution events are written only when `options.ui.emitEvents` is explicitly `true`
- CLI `run`/`agent`/`scrape` default behavior: stream on + `emitEvents=true`
- CLI with `--no-stream`: does not force `emitEvents`

## Configuration

Common CLI config keys:

- `mcpBaseUrl` (default `https://mcp.rtrvr.ai`)
- `controlBaseUrl` (control plane; default `https://cli.rtrvr.ai`)
- `defaultTarget`
- `preferExtensionByDefault`
- `retryMaxAttempts`
- `retryBaseDelayMs`
- `retryMaxDelayMs`

Examples:

```bash
rtrvr config set controlBaseUrl https://cli.rtrvr.ai
rtrvr config set mcpBaseUrl https://mcp.rtrvr.ai
rtrvr config set retryMaxAttempts 3
```

## SDK quickstart

```ts
import { createRtrvrClient } from '@rtrvr-ai/sdk';

const client = createRtrvrClient({
  apiKey: process.env.RTRVR_API_KEY!,
  defaultTarget: 'auto',
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 2000,
  },
});

const result = await client.run({
  input: 'Find latest headline and author',
  urls: ['https://example.com'],
  target: 'auto',
  response: { inlineOutputMaxBytes: 1_048_576 },
  options: { ui: { emitEvents: true } }, // opt-in for API/SDK flows
});

// Canonical direct tool names are snake_case:
// act_on_tab | extract_from_tab | crawl_and_extract_from_tab
const extractResult = await client.tools.run({
  tool: 'extract_from_tab',
  params: {
    user_input: 'Extract order rows and totals',
    tab_urls: ['https://example.com/orders'],
  },
});

// Optional convenience wrappers are also available:
const actResult = await client.tools.act({
  user_input: 'Click the first result and summarize the page',
  tab_urls: ['https://example.com'],
});
```

SDK event/output policy:

- SDK/API requests do not auto-enable `emitEvents`; set `options.ui.emitEvents=true` explicitly.
- Inline payloads stay in `output`/`result` up to `1MB`.
- Over-limit payloads keep inline preview markers and include refs (`outputRef` / `resultRef` / `responseRef`) in sibling fields.

## Skills

Local skills path:

- `~/.config/rtrvr/skills/*.json`

Useful commands:

```bash
rtrvr skills templates
rtrvr skills add ./my-skill.md
rtrvr skills validate my-skill
rtrvr skills apply my-skill "Find financing options" --url https://example.com --target auto
```

## Tests

```bash
pnpm build
pnpm typecheck
pnpm test
```

## Additional docs

- `docs/CLI_OPERATIONS.md`
- `docs/SKILLS.md`
- `docs/V1_CONTRACT.md`
