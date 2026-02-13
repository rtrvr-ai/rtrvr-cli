# @rtrvr-ai/sdk

Official TypeScript SDK for RTRVR APIs. It wraps `@rtrvr-ai/core` with a higher-level interface and re-exports all core types and helpers.

## Install

```bash
npm install @rtrvr-ai/sdk
```

## Requirements

- Node.js 18+
- ESM (`"type": "module"`)

## Quickstart

```ts
import { createRtrvrClient } from '@rtrvr-ai/sdk';

const client = createRtrvrClient({
  apiKey: process.env.RTRVR_API_KEY!,
  defaultTarget: 'auto',
});

const result = await client.run({
  input: 'Find the latest pricing',
  urls: ['https://example.com'],
});

console.log(result.metadata, result.data);
```

## Common operations

```ts
// Unified run with auto-routing
const result = await client.run({
  input: 'Find the latest pricing',
  urls: ['https://example.com'],
  target: 'auto',  // or 'cloud' or 'extension'
});

// Agent operations
const agent = await client.agent.run({
  input: 'Summarize the page',
  urls: ['https://example.com'],
  schema: { fields: [...] },  // optional structured output
});

// Cloud-only agent (requires rtrvr_ API key)
const cloud = await client.agent.cloud({
  input: 'Summarize the page',
  urls: ['https://example.com'],
});

// Scraping
const scrape = await client.scrape.route({
  urls: ['https://example.com'],
  target: 'auto',
});

// Extension-specific operations
const extensionResult = await client.extension.run({
  input: 'Click the login button',
  urls: ['https://example.com'],
  deviceId: 'my-device',
});

// MCP tool helpers
const extracted = await client.tools.extract({
  user_input: 'Extract product names and prices',
  tab_urls: ['https://example.com/products'],
});

const acted = await client.tools.act({
  user_input: 'Fill the form with user data',
  tab_urls: ['https://example.com/form'],
});

const crawled = await client.tools.crawl({
  user_input: 'Extract all product listings',
  tab_urls: ['https://example.com/catalog'],
});

const planned = await client.tools.planner({
  user_input: 'Navigate to settings and update profile',
  tab_urls: ['https://example.com'],
});

// Raw tool execution
const toolResult = await client.tools.run({
  tool: 'get_page_data',
  params: { tabIds: [123] },
  deviceId: 'my-device',
});

// Devices and credits
const devices = await client.devices.list();
const credits = await client.credits.get();

// Profile and capabilities
const profile = await client.profile.get();
const capabilities = await client.profile.capabilities();
```

## Auth tokens

- `rtrvr_...` API keys can access cloud + MCP + control endpoints.
- `mcp_at_...` tokens are limited to MCP endpoints. Cloud calls throw an error.

## Low-level access

You can always drop down to the raw client:

```ts
const raw = client.raw;
const response = await raw.toolRun({ tool: 'list_devices', params: {} });
```

## Advanced options

### Request configuration

```ts
// Full request with all options
const result = await client.run({
  input: 'Extract product data',
  urls: ['https://example.com'],
  schema: { fields: [...] },          // structured output schema
  files: [{ displayName, uri, mimeType }],  // file inputs
  fileUrls: ['https://...'],          // file URLs for context
  dataInputs: [...],                  // additional data
  settings: { llmIntegration: {...} }, // agent settings
  tools: { enabledTools: [...] },     // tool configuration
  options: { ui: { emitEvents: true } }, // execution options
  response: {
    verbosity: 'steps',               // 'final' | 'steps' | 'debug'
    inlineOutputMaxBytes: 50000,
  },
  webhooks: [{
    url: 'https://your-webhook.com',
    events: ['tool_complete', 'workflow_complete'],
    auth: { type: 'bearer', token: 'xxx' },
  }],
  trajectoryId: 'custom-id',          // workflow tracking
  phase: 1,                           // workflow phase
  authToken: 'google-oauth-token',    // for Drive/Docs/Sheets
  target: 'auto',                     // routing mode
  preferExtension: true,              // prefer extension in auto
  requireLocalSession: false,         // require extension or fail
  deviceId: 'my-device',              // target device
});
```

## What it exports

`@rtrvr-ai/sdk` re-exports everything from `@rtrvr-ai/core`, including:

- `RtrvrClient` - low-level client
- `RtrvrError` - error class with status and requestId
- `createRtrvrClient` - SDK factory function
- Request/response types: `UnifiedRunRequest`, `UnifiedRunResponse`, `UnifiedScrapeRequest`, etc.
- Helper types: `CloudFile`, `WebhookSubscription`, `WebhookAuth`, `DeviceInfo`, `RunMetadata`
- All type exports from core
