# @rtrvr-ai/cli

Official RTRVR CLI for browser automation with cloud + extension routing.

## Install

```bash
npm install -g @rtrvr-ai/cli
# or
npx @rtrvr-ai/cli --help
```

## Requirements

- Node.js 18+

## Quickstart

```bash
# Authenticate
rtrvr auth login

# Run an agent task
rtrvr run "Extract the top 10 products" --url https://example.com

# Scrape a page
rtrvr scrape --url https://example.com

# Check capabilities
rtrvr capabilities

# Diagnose connectivity
rtrvr doctor
```

## Authentication

```bash
# OAuth bootstrap (interactive)
rtrvr auth login --oauth

# API key login
rtrvr auth login --api-key rtrvr_...

# Check auth status
rtrvr auth status

# Get raw token for automation
rtrvr auth token

# Logout (clear credentials)
rtrvr auth logout
```

**Token types:**

- `rtrvr_...` API keys can access cloud + MCP + control endpoints.
- `mcp_at_...` tokens are limited to MCP endpoints.

**Google OAuth for Drive/Docs/Sheets:**

```bash
# Check Google OAuth status
rtrvr auth google status

# Connect Google OAuth (opens browser)
rtrvr auth google login

# Use with --auth-token flag
rtrvr run "Extract data to Sheets" --url https://example.com --auth-token <google-token>
```

**Environment variables override stored credentials:**

```bash
export RTRVR_API_KEY=rtrvr_...
# or
export RTRVR_AUTH_TOKEN=rtrvr_...
```

**Credential storage:**

Credentials are stored in the OS keychain (macOS Keychain or Linux secret-service) when available, otherwise in `~/.config/rtrvr/config.json`.

**Login options:**

```bash
rtrvr auth login --oauth                    # OAuth bootstrap
rtrvr auth login --api-key rtrvr_...        # Direct API key
rtrvr auth login --storage keychain         # Force keychain storage
rtrvr auth login --strict-auth              # Fail if OAuth unavailable
rtrvr auth login --no-browser               # Don't auto-open browser
rtrvr auth login --prefer-extension         # Set default target to extension
```

## Core commands

```bash
rtrvr run "Do the task" --url https://example.com
rtrvr agent "Do the task" --url https://example.com
rtrvr scrape --url https://example.com
rtrvr extension "Run in local session" --url https://example.com
rtrvr devices list
```

Key flags for `run` / `agent`:

**Input options:**
- `<input...>` - positional task input
- `--input <text>` - task text (use `-` to read from stdin)
- `--input-file <path>` - read task from file
- `-u, --url <url...>` - starting URL(s)

**Routing options:**
- `--target auto|cloud|extension` - routing mode
- `--cloud` - shortcut for `--target cloud`
- `--extension` - shortcut for `--target extension`
- `--device-id <id>` - target extension device
- `--prefer-extension` - prefer extension in auto mode
- `--require-local-session` - require extension or fail

**Data and schema:**
- `--schema-file <path>` - JSON schema for structured output
- `--file-url <url...>` - file URL(s) for context

**Configuration:**
- `--settings-json <json>` - agent settings
- `--tools-json <json>` - tool configuration
- `--options-json <json>` - execution options
- `--response-json <json>` - response config (verbosity, inlineOutputMaxBytes)
- `--webhooks-json <json>` - webhook subscriptions array
- `--auth-token <token>` - Google OAuth access token for Drive/Docs/Sheets/Slides

**Output options:**
- `--json` - machine-readable JSON output
- `--no-stream` - disable SSE progress streaming
- `--no-stream-output` - hide tool output payloads in stream events

**Scrape options:**

All routing and output options above, plus:
- `-u, --url <url...>` - URL(s) to scrape (required)

## Skills

```bash
rtrvr skills templates
rtrvr skills install-template agent-web
rtrvr skills add ./my-skill.md
rtrvr skills list
rtrvr skills apply my-skill "Find financing options" --url https://example.com
```

## MCP helpers

```bash
rtrvr mcp init --client claude
rtrvr mcp init --client cursor
rtrvr mcp url
```

## Raw MCP tools

```bash
rtrvr raw tool planner --params-json '{"user_input":"Summarize"}'
rtrvr raw act "Click login" --url https://example.com
```

## Configuration

Config file: `~/.config/rtrvr/config.json`

**Available keys:**

```bash
rtrvr config set defaultTarget cloud               # auto|cloud|extension
rtrvr config set preferExtensionByDefault true     # boolean
rtrvr config set authStorage keychain              # auto|keychain|config
rtrvr config set telemetryOptIn false              # boolean
rtrvr config set retryMaxAttempts 3                # number
rtrvr config set retryBaseDelayMs 250              # number (ms)
rtrvr config set retryMaxDelayMs 4000              # number (ms)
rtrvr config set cloudBaseUrl https://api.rtrvr.ai
rtrvr config set mcpBaseUrl https://mcp.rtrvr.ai
rtrvr config set controlBaseUrl https://cli.rtrvr.ai
```

**Environment variable overrides:**

- `RTRVR_API_KEY` or `RTRVR_AUTH_TOKEN` - auth token
- `RTRVR_CONFIG_DIR` - config directory path
- `RTRVR_CLOUD_BASE_URL` - cloud API base URL
- `RTRVR_MCP_BASE_URL` - MCP base URL
- `RTRVR_CONTROL_BASE_URL` - CLI control base URL

**OAuth configuration:**

```bash
rtrvr config set oauthPollIntervalMs 2000          # OAuth poll interval
rtrvr config set oauthTimeoutMs 300000             # OAuth timeout (5 min)
```
