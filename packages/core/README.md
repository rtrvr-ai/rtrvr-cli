# @rtrvr-ai/core

Low-level client, types, and HTTP transport for rtrvr.ai cloud and extension endpoints and MCP. This package powers `@rtrvr-ai/sdk` and `@rtrvr-ai/cli`.

## Install

```bash
npm install @rtrvr-ai/core
```

## Requirements

- Node.js 18+
- ESM (`"type": "module"`)

## Quickstart

```ts
import { RtrvrClient } from '@rtrvr-ai/core';

const client = new RtrvrClient({
  apiKey: process.env.RTRVR_API_KEY!,
  defaultTarget: 'auto',
});

const run = await client.run({
  input: 'Extract the top 5 products and prices',
  urls: ['https://example.com'],
});

console.log(run.metadata, run.data);
```

## Cloud agent and scrape

```ts
// Cloud /agent (requires rtrvr_ API key)
const agent = await client.agentRun({
  input: 'Summarize this page',
  urls: ['https://example.com'],
});

// Cloud /scrape (requires rtrvr_ API key)
const scrape = await client.scrapeRun({
  urls: ['https://example.com'],
});
```

## MCP tools and extension routing

```ts
// Call a tool directly through MCP
const extracted = await client.toolRun({
  tool: 'extract_from_tab',
  params: {
    user_input: 'Extract all product names and prices',
    tab_urls: ['https://example.com/products'],
  },
});

// List online extension devices
const devices = await client.listDevices();
```

## Routing behavior

- `run` and `scrape` support `target: 'cloud' | 'extension' | 'auto'`.
- `auto` checks for online extension devices via `list_devices` and falls back to cloud when needed.
- Use `deviceId` or `requireLocalSession: true` to force extension execution.

## Auth tokens

- `rtrvr_...` API keys can access cloud + MCP + control endpoints.
- `mcp_at_...` tokens are limited to MCP endpoints. Cloud calls throw an error.

## Client options

```ts
interface ClientOptions {
  apiKey: string;
  cloudBaseUrl?: string;              // default https://api.rtrvr.ai
  mcpBaseUrl?: string;                // default https://mcp.rtrvr.ai
  controlBaseUrl?: string;            // default https://cli.rtrvr.ai
  timeoutMs?: number;                 // default 45 minutes, shared across the whole call
  retryPolicy?: {
    maxAttempts?: number;             // default 1
    baseDelayMs?: number;             // default 250ms
    maxDelayMs?: number;              // default 4000ms
    retriableStatusCodes?: number[];  // default [408, 425, 429, 500, 502, 503, 504]
  };
  defaultTarget?: 'auto' | 'cloud' | 'extension';  // default 'auto'
  preferExtensionByDefault?: boolean;              // default false
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;           // custom fetch for tests or runtime
}
```

## Request options

### UnifiedRunRequest

```ts
interface UnifiedRunRequest {
  input: string;                      // task description
  urls?: string[];                    // starting URLs
  schema?: Record<string, unknown>;   // structured output schema
  files?: CloudFile[];                // structured file inputs
  fileUrls?: string[];                // URLs to files for context
  dataInputs?: unknown[];             // additional data inputs
  settings?: Record<string, unknown>; // agent settings
  tools?: Record<string, unknown>;    // tool configuration
  options?: Record<string, unknown>;  // execution options
  response?: {
    verbosity?: 'final' | 'steps' | 'debug';  // response detail level
    inlineOutputMaxBytes?: number;            // output size limit
  };
  webhooks?: WebhookSubscription[];   // event webhooks
  trajectoryId?: string;              // workflow tracking ID
  phase?: number;                     // workflow phase number
  recordingContext?: string;          // replay context
  authToken?: string;                 // Google OAuth token for Drive/Docs/Sheets
  target?: 'auto' | 'cloud' | 'extension';  // routing mode
  preferExtension?: boolean;          // prefer extension in auto mode
  requireLocalSession?: boolean;      // require extension or fail
  deviceId?: string;                  // target device ID
}
```

### Webhooks

```ts
interface WebhookSubscription {
  url: string;
  events?: string[];                  // event types to subscribe to
  auth?: WebhookAuth;                 // authentication config
  secret?: string;                    // webhook signing secret
}

type WebhookAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string };
```

## Tool names

MCP tools are `snake_case` (for example: `planner`, `act_on_tab`, `extract_from_tab`, `crawl_and_extract_from_tab`, `scrape`, `list_devices`, `get_current_credits`, `cloud_agent`, `cloud_scrape`).

Aliases are available for a few tool names: `act`, `extract`, `crawl`, `getPageData`, `listDevices`, `getCurrentCredits`.

## Errors

Requests throw `RtrvrError` with `status`, `requestId`, and optional `details` when available.

## 0.3.0 run behavior

Cloud agent and scrape calls send a generated or caller-supplied `trajectoryId` as `Idempotency-Key`. Retries reuse it. HTTP 429/503 `Retry-After` delays share the call deadline. SDK callers recovering across separate calls should reuse the same id and body; legacy servers may return 409 instead of replaying a result.

The client sends `Prefer: respond-async`. HTTP 202 follows the MCP events relay with `since` resume after stream ends or drops, then retrieves the complete final response. HTTP 200 keeps the existing final response behavior. The default wait covers 45 minutes; an explicit SDK `timeoutMs` bounds the whole call. The server owns the run limit.

Errors expose `RtrvrError.code`, `.fields`, `.requestId` and `.details`, including retained partial results. See [the operations guide](../../docs/CLI_OPERATIONS.md) for endpoint and cancellation details.

```ts
const controller = new AbortController();
const result = await client.run({
  input: 'Summarize the page',
  target: 'cloud',
  signal: controller.signal,
  onEvent: (event) => console.error(event.event),
});
// Calling controller.abort() while awaiting requests cloud cancellation.
```

Async `onEvent` observers run sequentially. The second argument is the run's AbortSignal; pass it to observer I/O so cancellation can stop pending work. `includeEventOutput: false` follows status without tool output and still returns the complete final response. Both controls stay off the API request body.
