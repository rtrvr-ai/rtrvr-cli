# Changelog

## 0.3.0 (unreleased)

- Cloud agent and scrape retries use the run's trajectoryId as Idempotency-Key, including CLI `--no-stream` and SDK calls. Retries preserve one admission identity instead of starting another run.
- HTTP 429 and 503 honor Retry-After in seconds or HTTP-date form within the caller's deadline.
- Request asynchronous execution and resume the MCP events relay from the last durable sequence after a stream ends or drops. HTTP 200 keeps the existing final-result path when a server ignores the preference.
- Replace the nine minute client wait with a default that covers the server's 45 minute maximum run window. Explicit SDK timeoutMs bounds the whole call. The server owns execution limits.
- Bound progress memory with sink backpressure. Oversized frames repair to status-only resume while preserving the complete final response.
- Ctrl-C requests cloud cancellation and waits for acknowledgement or a bounded 10 seconds before exiting 130.
- Keep routing controls off cloud bodies. Errors show the server code, offending fields and requestId, and preserve partial results.

The founder merges and publishes this release. The pipeline exit-code change is prepared as a separate final commit for the founder's decision.
