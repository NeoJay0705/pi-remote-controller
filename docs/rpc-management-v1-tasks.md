# RPC management v1 tasks

All paths are repository-relative. Main agent owns these documents and final acceptance. Work is sequential; do not use unverified output as input to a dependent task.

## 1. Backend contract, list and release safety

Delegate to `system-execution-agent` at repository root. Allowed scope: `src/shared/contracts.ts`, necessary `src/server/` files, backend tests and necessary isolated fake-Pi support. No frontend, documentation, dependency, lockfile, dist or service edits.

Output: exact changed paths, summary API contract and reason codes, commands and results, deterministic runtime/HTTP tests with no-close and lease/history evidence. Acceptance: requirements and backend design satisfied; targeted tests and typechecks pass; tests exercise actual runtime/RPC/handlers, including known unsafe states, state-read and admission races, and deduplication. Main agent inspects diffs and independently verifies targeted evidence before proceeding.

## 2. Management UI and receipt/freshness handling

After step 1 is accepted, delegate to `system-execution-agent` at repository root. Allowed scope: necessary frontend files and focused frontend unit tests. No backend, docs, build outputs or dependencies. Main agent supplies the verified backend contract.

Output: exact paths, behavior summary, typecheck and focused test results. Acceptance: dedicated accessible desktop/mobile view, all required fields, confirmation, freshness/offline guards, no duplicate/replayed release, accurate retained receipts, preserved conversation/draft and inert hidden shortcuts. Main agent checks actual component and state handling before browser validation.

## 3. Isolated integrated browser acceptance

After step 2 is accepted, delegate to `system-execution-agent` at repository root. Allowed scope: feature-specific browser tests and necessary fixture/test isolation configuration only. Build into dedicated ignored feature artifacts, never repository dist or live instance. No application changes without a separately scoped correction.

Output: exact isolated build/start/test commands, desktop/mobile results, UI screenshots and server/process/journal evidence for required outcomes. Acceptance: actual built app passes the behavior scenarios in the design; no production use or regression of isolation. Main agent independently checks test code/output and representative screenshots and targeted runs, then writes final verification.

## Corrections

If an acceptance step fails, stop dependent work. Request only the necessary correction, name the failed requirement and acceptance evidence, and recheck before advancing. No automatic commit, push, deployment, or service restart.

## Final status

Steps 1–3 accepted after scoped corrections and independent main-agent checks. Final full regression: 291 tests across 44 files; isolated built-app browser acceptance: 10 cases across desktop/mobile. See [verification](rpc-management-v1-verification.md), including the disclosed initial test-wrapper build-isolation deviation and production limitations.
