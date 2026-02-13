# rtrvr CLI + SDK

[![npm version](https://img.shields.io/npm/v/@rtrvr-ai/cli)](https://www.npmjs.com/package/@rtrvr-ai/cli)
[![npm downloads](https://img.shields.io/npm/dm/@rtrvr-ai/cli)](https://www.npmjs.com/package/@rtrvr-ai/cli)
[![license](https://img.shields.io/npm/l/@rtrvr-ai/cli)](LICENSE)

Browser automation for AI agents and humans. One CLI, three execution modes: cloud, local browser extension, or auto-routed.

- **Cloud mode** — run agents and scrape pages via rtrvr's cloud infrastructure
- **Extension mode** — route to your local browser extension for authenticated sessions
- **Auto mode** — smart routing with automatic fallback between cloud and extension

## Install

```bash
# CLI (global)
npm install -g @rtrvr-ai/cli

# SDK (in your project)
npm install @rtrvr-ai/sdk
```

## Quick Start

```bash
# Authenticate
rtrvr auth login

# Run an AI agent task
rtrvr run "Extract the top 10 products and prices" --url https://example.com

# Scrape a page
rtrvr scrape --url https://example.com

# Check what you can do
rtrvr capabilities

# Diagnose connectivity
rtrvr doctor
```

## Authentication

### Login methods

```bash
# Browser-based OAuth (recommended)
rtrvr auth login --oauth

# Direct API key
rtrvr auth login --api-key rtrvr_...

# Check auth status
rtrvr auth status
```

### Token types

| Token | Prefix | Access |
|-------|--------|--------|
| API key | `rtrvr_` | Full cloud + CLI endpoints |
| OAuth token | `mcp_at_` | MCP endpoint only |

### Storage

Tokens are stored securely in your OS keychain (macOS Keychain / Linux secret-service) by default. Fallback to `~/.config/rtrvr/config.json` if no secure store is available.

Environment variables override stored credentials:

```bash
export RTRVR_API_KEY=rtrvr_...
# or
export RTRVR_AUTH_TOKEN=rtrvr_...
```

## Commands

### `rtrvr run` / `rtrvr agent`

Run an AI agent task with smart routing.

```bash
rtrvr run "Find the latest pricing for each plan" --url https://example.com
rtrvr run --input-file ./task.txt --url https://example.com --target cloud
echo "Summarize this page" | rtrvr run --url https://example.com
```

| Option | Description |
|--------|-------------|
| `<input>` | Task description (positional) |
| `--input <text>` | Task description (flag) |
| `--input-file <path>` | Read task from file |
| `--url <url>` | Target URL(s) |
| `--target <mode>` | Routing: `auto`, `cloud`, `extension` |
| `--cloud` | Shortcut for `--target cloud` |
| `--extension` | Shortcut for `--target extension` |
| `--device-id <id>` | Target a specific browser extension device |
| `--schema-file <path>` | JSON schema for structured output |
| `--json` | Machine-readable JSON output |
| `--no-stream` | Disable real-time progress streaming |

### `rtrvr scrape`

Scrape URLs with cloud or extension routing.

```bash
rtrvr scrape --url https://example.com
rtrvr scrape --url https://example.com --target extension --device-id my-device
```

| Option | Description |
|--------|-------------|
| `--url <url>` | URL(s) to scrape |
| `--target <mode>` | Routing: `auto`, `cloud`, `extension` |
| `--cloud` | Shortcut for `--target cloud` |
| `--extension` | Shortcut for `--target extension` |
| `--json` | Machine-readable JSON output |

### `rtrvr extension`

Route directly to the browser extension planner.

```bash
rtrvr extension "Click the login button and fill the form" --url https://example.com
```

### `rtrvr devices`

List online browser extension devices.

```bash
rtrvr devices list
```

### `rtrvr skills`

Manage local reusable skill templates.

```bash
rtrvr skills templates              # List built-in templates
rtrvr skills install-template agent-web
rtrvr skills add ./my-skill.md      # Add from markdown
rtrvr skills list                   # Show installed skills
rtrvr skills apply my-skill "Find financing options" --url https://example.com
```

### `rtrvr mcp`

Configure rtrvr as an MCP server for AI coding tools.

```bash
# Generate config for Claude Code
rtrvr mcp init --client claude

# Generate config for Cursor
rtrvr mcp init --client cursor

# Print the MCP endpoint URL
rtrvr mcp url
```

### `rtrvr config`

Manage CLI configuration.

```bash
rtrvr config get                          # Show all config
rtrvr config set defaultTarget cloud      # Set default routing
rtrvr config set retryMaxAttempts 3       # Set retry policy
```

### `rtrvr profile` / `rtrvr capabilities`

Check your identity and feature access.

```bash
rtrvr profile
rtrvr capabilities
```

### `rtrvr doctor`

Run diagnostics to verify endpoints, auth, and connectivity.

```bash
rtrvr doctor
```

## SDK Usage

```typescript
import { createRtrvrClient } from '@rtrvr-ai/sdk';

const client = createRtrvrClient({
  apiKey: process.env.RTRVR_API_KEY!,
  defaultTarget: 'auto',
});

// Run an agent task
const result = await client.run({
  input: 'Find latest headline and author',
  urls: ['https://example.com'],
  target: 'auto',
});

console.log(result);

// Use specific tools
const extracted = await client.tools.extract({
  user_input: 'Extract all product names and prices',
  tab_urls: ['https://example.com/products'],
});

// Scrape
const scraped = await client.scrape.run({
  urls: ['https://example.com'],
});

// List devices
const devices = await client.devices.list();

// Check credits
const credits = await client.credits.get();
```

## MCP Integration

rtrvr works as a native MCP server, giving AI coding tools (Claude Code, Cursor, etc.) direct access to browser automation.

```bash
# Auto-configure for Claude Code
rtrvr mcp init --client claude

# Auto-configure for Cursor
rtrvr mcp init --client cursor
```

This writes the MCP server config to the appropriate location so your AI tool can call rtrvr tools directly.

### Available MCP tools

| Tool | Description |
|------|-------------|
| `planner` | Multi-step browser automation planner |
| `act_on_tab` | Interact with a web page |
| `extract_from_tab` | Extract structured data from a page |
| `crawl_and_extract_from_tab` | Crawl and extract across multiple pages |
| `cloud_agent` | Run a cloud AI agent |
| `cloud_scrape` | Cloud-based page scraping |
| `list_devices` | List online extension devices |
| `get_current_credits` | Check credit balance |

## Routing Behavior

| Target | `run`/`agent` | `scrape` |
|--------|---------------|----------|
| `cloud` | Cloud `/agent` API | Cloud `/scrape` API |
| `extension` | Extension planner via MCP | Extension scrape via MCP |
| `auto` (default) | Check extension availability, fallback to cloud | Same with fallback |

The response includes routing metadata:

```json
{
  "metadata": {
    "selectedMode": "cloud",
    "fallbackApplied": true,
    "fallbackReason": "no extension devices online"
  }
}
```

## Progress Streaming

Long-running tasks stream real-time progress via SSE:

```bash
# Default: streaming enabled
rtrvr run "Complex multi-step task" --url https://example.com

# Disable streaming
rtrvr run "Quick task" --url https://example.com --no-stream
```

Events include: `planner_step`, `tool_start`, `tool_progress`, `tool_complete`, `credits_update`, and more.

## Configuration

Config is stored at `~/.config/rtrvr/config.json`.

| Key | Default | Description |
|-----|---------|-------------|
| `defaultTarget` | `auto` | Default routing mode |
| `preferExtensionByDefault` | `false` | Prefer extension in auto mode |
| `retryMaxAttempts` | `1` | Max retry attempts |
| `retryBaseDelayMs` | `250` | Base retry delay |
| `retryMaxDelayMs` | `4000` | Max retry delay |
| `telemetryOptIn` | `false` | Telemetry opt-in |

## Packages

| Package | Description |
|---------|-------------|
| [`@rtrvr-ai/cli`](https://www.npmjs.com/package/@rtrvr-ai/cli) | CLI binary (`rtrvr` command) |
| [`@rtrvr-ai/sdk`](https://www.npmjs.com/package/@rtrvr-ai/sdk) | TypeScript SDK for programmatic use |
| [`@rtrvr-ai/core`](https://www.npmjs.com/package/@rtrvr-ai/core) | Core API client, types, and transport |

## Development

```bash
git clone https://github.com/rtrvr-ai/rtrvr-cli.git
cd rtrvr-cli
pnpm install
pnpm build
node packages/cli/dist/index.js --help
```

## License

[Apache-2.0](LICENSE)
