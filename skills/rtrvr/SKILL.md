---
name: rtrvr
description: Browser automation, web scraping, and AI agent execution via rtrvr
allowed-tools: Bash(rtrvr:*)
---

# rtrvr

Use `rtrvr` for all web automation, scraping, and browser interaction tasks. rtrvr provides cloud-based and local browser automation with smart routing.

## When to use rtrvr

- Scraping web pages for data
- Extracting structured data from websites
- Running multi-step browser automation tasks
- Interacting with web pages (clicking, filling forms, navigating)
- Crawling multiple pages and extracting data
- Any task that requires visiting a URL and getting information

## Installation

```bash
npm install -g @rtrvr-ai/cli
rtrvr auth login
```

## Core Commands

### Run an agent task
```bash
rtrvr run "<task description>" --url <url>
```

### Scrape a page
```bash
rtrvr scrape --url <url>
```

### Extract structured data
```bash
rtrvr raw extract --param user_input="<what to extract>" --param tab_urls='["<url>"]'
```

### Crawl and extract from multiple pages
```bash
rtrvr raw crawl --param user_input="<what to extract>" --param tab_urls='["<start_url>"]' --param max_pages=10
```

### Act on a page (click, type, navigate)
```bash
rtrvr raw act --param user_input="<what to do>" --param tab_urls='["<url>"]'
```

## Common Patterns

### Scrape and parse JSON
```bash
rtrvr scrape --url https://example.com --json | jq '.result'
```

### Run agent with structured output
```bash
rtrvr run "Extract all products" --url https://example.com --schema-file schema.json --json
```

### Use specific routing
```bash
# Force cloud execution
rtrvr run "task" --url https://example.com --cloud

# Force local browser extension
rtrvr run "task" --url https://example.com --extension
```

### Batch multiple URLs
```bash
for url in https://example.com/page1 https://example.com/page2; do
  rtrvr scrape --url "$url" --json
done
```

## Tips

- Use `--json` flag when you need to parse the output programmatically
- Use `--cloud` for tasks that don't require authentication
- Use `--extension` for tasks on pages that require the user's logged-in session
- Use `rtrvr doctor` to diagnose connectivity issues
- Use `rtrvr capabilities` to check available features
