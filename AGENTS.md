# Agent Instructions for rtrvr-cli

This document provides instructions for AI coding agents working on the rtrvr-cli codebase.

## Project Structure

This is a pnpm monorepo with three packages:

```
packages/
  core/    @rtrvr-ai/core   — API client, types, HTTP transport
  sdk/     @rtrvr-ai/sdk    — High-level SDK wrapper
  cli/     @rtrvr-ai/cli    — CLI binary (rtrvr command)
```

Dependency chain: `cli → sdk → core`

## Setup

```bash
pnpm install
pnpm build
```

## Development

- All packages use ESM (`"type": "module"`)
- Build with `tsup` (ESM + DTS output)
- TypeScript strict mode enabled
- No external HTTP library — uses native Node `fetch`

## Code Style

- TypeScript strict mode with `noUncheckedIndexedAccess`
- ESM imports with explicit `.js` extensions in compiled output
- Use `snake_case` for API-facing tool names and parameters
- Use `camelCase` for internal TypeScript code
- Keep dependencies minimal — only `commander` and `gray-matter` as production deps for CLI

## Testing

```bash
pnpm build && pnpm test
```

Tests use Node's built-in test runner (`node --test`). Test files are in `test/*.test.mjs` within each package.

## Key Files

- `packages/core/src/client.ts` — Main API client with cloud/extension routing logic
- `packages/core/src/types.ts` — All type definitions
- `packages/core/src/http.ts` — HTTP transport with retry logic
- `packages/cli/src/index.ts` — CLI entry point and command registration
- `packages/cli/src/utils/oauth.ts` — OAuth bootstrap flow
- `packages/cli/src/utils/secrets.ts` — Keychain/secret-service integration
- `packages/cli/src/utils/mcp.ts` — MCP profile generation
- `packages/cli/src/utils/skills.ts` — Skill template management
- `packages/sdk/src/index.ts` — SDK factory and wrapper interface

## Important Notes

- The `USER_FUNCTiON_TIMEOUT` typo (lowercase `i`) in the codebase is pre-existing and intentional — do not "fix" it
- API tool names are canonical `snake_case`: `act_on_tab`, `extract_from_tab`, `crawl_and_extract_from_tab`
- Auth tokens use prefixes: `rtrvr_` for API keys, `mcp_at_` for OAuth tokens
- Never commit actual API keys or tokens
