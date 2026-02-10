# RTRVR Skills Contract (v1)

This document defines the stable local skill contract used by `rtrvr skills` for both humans and agent runtimes.
Legacy skill schema variants are not maintained in v1; normalize skills to this contract.

## Storage

- Default directory: `~/.config/rtrvr/skills`
- Persisted format: normalized JSON (`*.json`)
- Import format: JSON or Markdown frontmatter + body

## Skill Schema

```json
{
  "schemaVersion": "1",
  "name": "agent-web",
  "description": "Optional description",
  "defaultTarget": "auto",
  "requiresLocalSession": false,
  "mcpTools": ["planner", "act_on_tab", "extract_from_tab"],
  "promptTemplate": "Task: {{input}}"
}
```

## Field Semantics

- `schemaVersion`: required; currently `"1"`.
- `name`: required; unique local skill name.
- `description`: optional free text.
- `defaultTarget`: optional `auto|cloud|extension`; controls default route target for `skills apply`.
- `requiresLocalSession`: optional bool; forces extension-first local session behavior.
- `mcpTools`: optional list of required tools for preflight compatibility checks.
- `promptTemplate`: required prompt body; supports `{{input}}` and `{{user_input}}`.

## Compatibility Aliases

Tool preflight checks treat these as compatible:

- `scrape` <-> `cloud_scrape`
- `scrape` <-> `get_page_data`
- `cloud_agent` <-> `agent`

## CLI Operations

- Install from file: `rtrvr skills add ./skill.md`
- List: `rtrvr skills list`
- Show: `rtrvr skills show <name>`
- Validate: `rtrvr skills validate <name>`
- Apply: `rtrvr skills apply <name> "<task>" --target auto`
- Export markdown: `rtrvr skills export <name> --format markdown`

## Skills + Execution Events

- Skills do not implicitly enable execution event writes.
- For CLI runs, `rtrvr run`/`rtrvr agent`/`rtrvr scrape` stream by default and set `emitEvents=true`.
- Use `--no-stream` if you want non-streaming execution.
- For API/SDK flows, set `options.ui.emitEvents=true` explicitly when you want progress events.
- Streamed payloads stay inline through `1MB`; larger payloads keep inline preview markers and expose full payload refs in sibling fields (`outputRef` / `resultRef` / `responseRef`).

## Built-in Templates

- `agent-web`
- `extension-session`
- `bulk-scrape`
- `agent-api-first`

Use:

```bash
rtrvr skills templates
rtrvr skills install-template agent-api-first
```
