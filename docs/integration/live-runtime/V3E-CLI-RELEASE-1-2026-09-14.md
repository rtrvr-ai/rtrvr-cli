# CLI and SDK 0.3.0 verification

Recorded 2026-10-20 for cli-release-1 on v3/cli-release-1, base 5bc794f. The filename follows the standing lane-record convention.
Receipts: ~/.cache/rtrvr-cloud/v3/receipts/cli-release-1/.

## Proven root causes and changes

A post-admission 500/503 could cause a second paid admission because non-stream calls sent neither trajectoryId nor Idempotency-Key. Cloud agent and scrape calls now generate identity once, before retry, and send a matching header on every attempt. The encoded body is reused, including if the caller mutates its original object. Header overrides are case-insensitive. A legacy server may return 409 on reuse; the client never changes identity to bypass it.

Retries reset the old nine minute timeout, ignored Retry-After, and did not interrupt backoff on abort. One monotonic deadline now owns admission, backoff, event following and the final read. HTTP 429/503 honor delta seconds or HTTP dates. Timer re-arming respects Node's physical 2^31-1 ms ceiling. Encoding cannot admit a request after its budget expires. An unencodable body fails typed before fetch; zero budget admits nothing.

The held request and non-resuming relay stopped long runs at nine minutes. The client sends Prefer: respond-async. HTTP 202 follows the API-key MCP relay /cli/executions/:id/events, resumes durable since after EOF/drop, and reads the full cloud response after termination. HTTP 200 keeps its existing result path. The default wait covers the server's 45 minute maximum; an explicit timeoutMs bounds the whole call. API-key admission and a stream reconnect are separate operations, so a stream drop never reposts admission or sends cancel.

Ctrl-C posts /agent/cancel or /scrape/cancel with trajectoryId and waits for acknowledgement or a physical ten second wait envelope. A non-acknowledged cancel reports CANCEL_UNCONFIRMED with the run id. CLI abort/deadline completion exits even if an output pipe stopped reading. Auto-route device probes receive abort, and extension planner/scrape observers retain progress behavior.

The old renderer silently cut output at 180 characters and ignored stdout/stderr backpressure. Async observers now run sequentially with the run signal. CLI progress waits for drain. Physical frame-envelope repairs emit code, measured bytes, basis and partial cursor, then resume without streamed output. The full final response remains intact, including a failed final carrying a four MiB partial. The client-only includeEventOutput control preserves --no-stream-output without leaking a field onto the API wire.

Cloud bodies omit target, preferExtension, requireLocalSession and deviceId. Structural error decoding is shared across HTTP, relay refusals and logical MCP failures. It preserves code, fields, requestId, repair and partial result for flat, nested and string error shapes. Logical MCP errors retain their previous undefined HTTP status.

All packages are 0.3.0. The last separate snapshot proposes nonzero CLI exit for error/failed/cancelled final runs after printing their result. It requires the founder decision and can be omitted independently.

## Removed limits and parsing

- Removed the hard-coded ten-attempt clamp; the caller's configured retry policy remains explicit.
- Replaced the nine minute default with the server maximum run window. The server owns execution limits; the client owns its wait.
- Removed the 15 second SSE connect cutoff and 20 second startup cap. Reconnects use the run deadline.
- Replaced a one MiB character cap with a physical UTF-8 frame-buffer byte envelope. CRLF is framed structurally instead of by regex.
- Removed the 180-character progress preview truncation. Frame bytes and sink backpressure own memory instead.
- No row, page, code-size or input-count limit was added. No input regex was added. Core owns one durable cursor and no event history.

## Final local gates

Commands use Node 24.20.0, pnpm 10.30.2, heavy-run-v8.sh, the required test-reporter preload, made-up keys and receipts-only config/TMPDIR.
The initial baseline used the repo-pinned pnpm 10.11.0 before the installed 10.30.2 path was selected.

- Baseline: core 11, SDK 2 and CLI 13 tests pass, with build/typecheck passing.
- Frozen final command: pnpm install --frozen-lockfile --offline; pnpm build; pnpm typecheck; pnpm lint; pnpm -r --no-bail test.
- Final counts: core 70/70, SDK 12/12, CLI 35 passing and 19 listen-EPERM cases UNVERIFIED. Total 117 passing and 19 unverified, no skips.
- Lint scripts execute but report no configured rules. This is not a lint-rule verification claim.
- Five snapshot stages build/typecheck and pass their executable non-socket probes. See logs/replay-final-summary.log and snapshot-replay-final-item-*.log.
- Three package archives contain version 0.3.0, internal dependencies pinned to 0.3.0, and only the expected five package files each. No tests, source fixtures, receipts or credentials ship.
- The first physical 12-minute proof passed both cloud variants with one admission each. The exact frozen-source repeat also ends PASS in long-run-final.log.

The blocked-output probe first failed because the reporter preload deliberately made stdout synchronous. The child is a normal application, not a reporter. Its NODE_OPTIONS is cleared to exercise real asynchronous pipes; the test runner keeps the required preload. The exit-130 expectation is unchanged. Real socket tests remain enabled and unverified.

## Red-first and defect controls

At 5bc794f: retry 15 reds; transport/timer edges 5 reds; async run 12 reds; SDK retry 5 reds; server errors 6 reds; release versions 4 reds; optional exit status 14 reds. Backpressure base probes add 6 reds. Subsequent controls caught a throwing thenable, large progress frame, status-only output, blocked-pipe exit and flat/string MCP logical errors. Each has a red log and a green run. RED-NAMES.md records names and commands.

Positive matrices cover both advisory 200 and async 202, 500/503 after admission, Retry-After date/seconds on 429/503, timeout/abort, EOF/drop, synthetic versus durable ids, CRLF across byte chunks, Unicode bytes, exact byte boundaries, status-only repair, full failed partials, sequential async sinks, stalled sinks and bounded cancel acknowledgement.

## D1-D9 audit

| Item | Evidence |
| --- | --- |
| D1 | SDK run, agent.run, agent.cloud, scrape.run and scrape.route all have retry and event-output probes. Core tests cover cloud, fallback and local-session paths; CLI run/agent/scrape/skills apply use the execution wrapper. |
| D2 | deadline.ts owns monotonic budgets and abortable waits; events.ts owns framing, cursor and reconnect; output.ts owns sink backpressure and abort exit. No second cache or admission owner exists. |
| D3 | Core 70 tests include deadline at encoding/backoff/stream/observer, a virtual 30-day Retry-After, abort before admission and a real ten-second unacknowledged cancel wait. |
| D4 | memory.mjs measures 100 calls each at 4 MiB and 12 MB, plus periodic RSS/heap samples over the physical 12-minute proof. METRICS-final.json records all numbers. |
| D5 | p50/p95 are measured against the original CLI event parser on the same fixtures; final-gates.log contains the final measurements. |
| D6 | Header, URL and JSON builders are real. JSON responses, byte-chunked SSE, size boundaries, concurrency and abort are exercised. Native sockets and edge compression are not claimed. |
| D7 | Original parity cases are retained in receipts copies. All five commit snapshots compile in order. The frozen whole CLI workspace runs; every remaining red is named. |
| D8 | Reconnect is required by the deployed relay's function window. Only a cursor, current frame and current observer are retained. Output repair changes the supported includeOutput mode, never admission identity. |
| D9 | Linux and native socket/edge proof remain verifier merge conditions. Nothing was run against cloud services or production. |

## Unverified commands and server-owned behavior

UNVERIFIED: node --test packages/cli/test/cloud-run.test.mjs. All 19 cases fail at listen EPERM on 127.0.0.1. Exact names are in RED-NAMES.md; tests stay enabled.

UNVERIFIED: bash harness/run-matrix-v2.sh and bash harness/run-stream-v2.sh for both prod/v3 variants. The fakes cannot listen and the scripts exit 3. These copied harnesses are under the lane receipts; parity-cli-1 files are unchanged.

UNVERIFIED: Linux execution of pnpm build, pnpm typecheck and pnpm -r --no-bail test, plus the same native harness commands through a compressing edge. This Mac-only lane cannot provide that result. Publishing, production and DNS-cutover behavior were not exercised.

The async reconnect guarantee starts after HTTP 202. Production disconnect-hold.ts and the gateway compatibility handler still own cancellation if a held admission/HTTP 200 POST disconnects. Prefer is advisory; preserving HTTP 200 preserves those legacy semantics. This client release changes no server policy.

The cloud batch ref is absent here: git rev-parse --verify refs/heads/ws/v3e-integration-22wb fails. This separate CLI repo has no runtime/ suite or Docker input generator. No cloud worktree was modified.

## Handoff

commit-plan-1.json carries ordered messages, every path, SHA-256 and per-stage source snapshots. The generic paths-only coordinator committer must not be used because shared files differ by stage. The materialization helper verifies digests and copies one item only; the Claude verifier stages explicit paths, adds its trailer and commits. Nothing was staged, committed, pushed, deployed or published by this lane.

The founder decides item 5, merges and publishes. The verifier must run the enabled native tests outside this sandbox before declaring the PR review-ready.

## Frozen-source results

The exact frozen-source 12-minute repeat ends PASS at 720018.457 ms (logs/long-run-final.log). Both variants admitted once. The async run used two streams with resumes [0,120]; every emitted event was observed, 718/718, and the full final response returned. The advisory HTTP 200 variant also completed after twelve minutes with its original final result.

Late RSS spans 59604992 to 65667072 bytes; live heap spans 7610080 to 7661584 bytes. Event history is not retained. In the 100-call burst measurements, V8 reserved RSS grows before plateauing; live heap and external buffers stay bounded. Raw before/after values are retained in METRICS-final.json.

Final p50/p95 for 4 MiB: 1.699/2.001 ms versus base 1.951/2.216 ms. For 12 MB: 4.592/4.824 ms versus base 5.182/5.422 ms. Each size has 100 measured calls.

The current integration checkout/build still refuses clientSurface. The R-1020-47 owner build at v3e-public-door accepts 12/12 generated SDK/CLI-shaped bodies, including files, CLI surface, streaming flags, routing-field removal and client-only controls. GATEWAY-PARSER-BUILD.json pins the exact parser build. No server worktree was rebuilt or changed. That gateway lane's merge remains a release dependency; the older integration refusal is not bypassed in the client.

The final matrix/stream attempts against that approved build still exit 3 because listeners are denied on both fake cloud variants (logs/harness-approved.log). This does not turn those probes green.
