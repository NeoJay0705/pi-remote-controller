# RPC management v1 verification

Date: 2026-11-13. Result: accepted for implementation and isolated synthetic verification; not deployed. Paths below are repository-relative. Host-specific paths, private session content, credentials and screenshots containing local environment information are not published in this document.

## Delivered behavior

- Authenticated dedicated RPC management view, reachable from the header or sidebar without selecting a conversation. Conversation controls/sidebar are hidden in management, hidden Escape-to-stop is disabled, and return preserves selection/draft.
- Authenticated `GET /api/v1/runtimes` summaries across managed projects: names with truthful fallbacks, controller IDs, full wrapping cwd, runtime state, eligibility and blocked reason. Released records are excluded; listing does not start or claim RPCs.
- Five-second single-flight refresh, manual refresh, failure retention, offline and fifteen-second freshness guards. Confirmation revalidates a fresh summary and frozen target identity before dispatch.
- Release admission rejects an existing operation tail. Execution validates actual RPC session identity/typed idle indicators and rechecks the same runtime, queue/dialog/transition/owner conditions after the probe, before closing anything.
- Successful release affects only its target, retains native history and the managed record, frees its writer lease and returns Owner to `tui`. A subsequent explicit prompt can restart the same session, which appears again despite historical success receipts.
- Persisted release intentions precede dispatch. Unresolved receipts are retained independently of the ordinary history limit, prohibit a second release and are only queried, never replayed. Receipt 404/transport errors are not treated as proof of non-delivery. Storage failure before dispatch prevents mutation.

## Main-agent acceptance

1. Inspected backend changes, RPC/HTTP safety tests, frontend component/receipt logic, browser fixture/runner and browser assertions. Rejected incomplete initial evidence and requested scoped corrections before dependent work.
2. Independently ran the targeted backend suite: 43 tests across 8 files passed. After strengthening admission assertions and fixing the test type, independently reran the HTTP management tests: 7 passed. Assertions cover no-close with writer lease retained, malformed/busy/failed state probes, gated local-state races, admission races for prompt/compact/profile, target-only close, retained history and duplicate-operation close-once behavior. Error/state injection wraps a real fake-Pi RPC and lease; it is not a real provider test.
3. Independently ran the frontend helper suite: 6 tests passed. Review additionally corrected historical-success filtering of restarted sessions, hidden sidebar CSS, non-release dispatched-receipt retention, and terminal result preservation.
4. Independently ran the complete Vitest suite directly in a fresh allowlisted HOME/XDG/TMP environment, without the existing build wrapper: **291 tests / 44 files passed**. Artifacts: `.test-artifacts/rpc-management-regression/6866d3f3-da27-46c8-9324-25925142ca06/`. Existing CLI/lifecycle regression tests still use the existing repository CLI build; the feature-specific compiled-app browser acceptance below uses a fresh isolated build.
5. Independently ran `scripts/test-rpc-management.mjs` with an explicitly selected installed Chromium executable: fresh isolated server TypeScript and Vite builds passed; **10 browser cases passed**, five on desktop and five on emulated mobile. Actual built UI and compiled backend used synthetic fake-Pi processes, not mocked success handlers.
6. `npm run typecheck`, ESLint over `src test scripts` and the feature Playwright config, Prettier over all changed/new implementation/test files and documentation, and `git diff --check` passed.
7. Isolated the feature specs from default Playwright discovery. Direct default-config collection lists 88 existing cases in 14 files without loading the dedicated descriptor-dependent specs; the dedicated config lists exactly 10 cases in 2 files. This is collection validation, not a claim that all existing browser cases were executed.

## Browser behavior and evidence

The five cases on each viewport verify:

- No-selection entry, cross-project identities/directories/states, released exclusion, no listing spawn/commands, hidden conversation/sidebar and no horizontal overflow.
- Confirmation cancellation without POST, exactly one accepted release POST, target writer-lease reacquisition, unchanged native bytes/managed record, survivor process still active, draft/selection preservation and same-session restart/reappearance.
- Automatic/manual refresh, failed updates retaining rows while disabling release, hung-update staleness, offline protection and no mutation.
- Lost successful response with temporarily missing receipts: original operation ID and lock retained across navigation/reload, exactly one POST, subsequent receipt lookup establishes the confirmed released result.
- SessionStorage failure with no POST, stale idle UI followed by actual running state rejected at preflight, blocked row disabled and Escape not stopping the hidden selected prompt. The held test prompt is released through its filesystem gate and observed settling to idle during cleanup.

Final independently executed build and browser artifacts: `.test-artifacts/rpc-management-v1/88ea22f3-c004-4a84-9da0-6fe3641f15f2/`. Representative screenshots: `screenshots/desktop-listing.png` and `screenshots/mobile-listing.png` inside that directory. Main agent inspected desktop/mobile screenshots from the earlier successful isolated run as well as test code and final actual results. All artifacts are ignored local evidence, not durable public deliverables.

## Isolation deviation and limits

Initial backend tests were invoked through the existing `npm test` wrapper before inspection revealed that it compiles into repository `dist`, despite isolating HOME/XDG/test data. Those runs therefore rewrote server build artifacts and did not meet the design's build-output isolation requirement. This was disclosed during implementation. No service restart, rollback, manual process termination, live endpoint call, live database query, or live session scan was performed to compensate or infer production health. Service impact was not verified. Subsequent acceptance used direct isolated Vitest execution and the dedicated runner, which compiles server/web only beneath its unique ignored artifact root. README now explicitly warns about the existing wrapper; this feature does not redesign that wrapper.

No live service lifecycle operation, real model inference, real provider credentials, external Pi/TUI process discovery, extension interoperability, physical mobile-device test, VPN or HTTPS acceptance was performed. Mobile results are Chromium device emulation. Generic cleanup failure is represented as blocked/unknown, not force-recovered. No commit, push, deployment or service restart is included in this implementation task.

## Delegation and corrections

Delegated three work packages: backend summaries/release protection, frontend management/receipts, and isolated browser acceptance. Independent backend test files were delegated in parallel only after implementation review, with disjoint file ownership. Scoped additional delegations corrected missing safety evidence, error/storage handling, test typing/lint, receipt/lifetime behavior, browser setup/coverage, gate cleanup and default test discovery. Every failed acceptance was rechecked before dependent integration; all final checks above passed.

Elapsed implementation and acceptance time: approximately 1 hour 50 minutes, excluding earlier requirement/design confirmation.
