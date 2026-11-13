# RPC management v1 design

Status: user approved on 2026-11-13. Scope: [requirements](rpc-management-v1-requirements.md). All paths are repository-relative; all acceptance data must be synthetic.

## UI

Add an authenticated RPC management entry, opening a dedicated main-content view rather than embedding a list in the session sidebar. Preserve the conversation selection and draft in the parent application. Hide conversation controls while managing runtimes, including keyboard shortcuts that could stop a hidden conversation. Returning restores the conversation without sending or claiming anything.

Use a separate `RpcManagement` component and management-specific styles. Show name/fallback, controller session ID, full wrapping cwd, runtime state, release eligibility/reason, and per-row confirmation/release actions. Use a semantic list/table with narrow-screen wrapping. No bulk release or separate conversation-page Release button.

While open, poll every 5 seconds with one active list request at a time; support manual refresh and abort/ignore stale responses on navigation/logout. Disable release until initial load succeeds, while offline, after update failure, or after 15 seconds without a successful update. Report freshness and errors explicitly. A failed update must not erase the last known list and masquerade as an empty result.

Freeze the target ID/name/cwd in confirmation. Require another fresh eligibility check before dispatch after confirmation. Track pending releases by session ID so a duplicate click cannot dispatch another operation. Reuse the existing operation ID, receipt lookup and sessionStorage receipt key/shape; unresolved release receipts must survive component navigation/reload and keep the session's Release action disabled. Never replay a mutation. Success must be based on a confirmed receipt/result, not only row disappearance or HTTP success. Keep outcome notices visible even if a successful row disappears.

## Backend and contract

Add authenticated `GET /api/v1/runtimes`, returning `RuntimeSession[]` (shared contract) for all managed records whose snapshot runtime state is not `released`. Each summary has `id`, `nameInfo`, optional `cwd`, `runtimeState`, `releaseEligible`, and optional `releaseBlockedReason`. Use existing bounded session-name reading/fallback behavior only for included rows; do not return message, queue, or pending-dialog contents. Missing project metadata is unavailable information, not an empty real directory. Listing uses existing ledger/runtime state and must not start processes or discover external sessions.

Eligibility checks include known idle state, correct Web ownership, no in-flight HTTP operation, no runtime reload/profile transition, empty queue, no pending dialog, and no unresolved unsafe state. The list is advisory; the mutation rechecks independently. Make rejection reasons machine-readable and render clear localized text in UI.

Keep `POST /api/v1/sessions/:id/operations` with `kind: release` and its existing UUID receipts, authentication, Origin validation, and per-session operation tail. A release admitted while another operation owns the session tail is rejected rather than queued to close a later idle runtime. Preserve duplicate-operation-ID receipt semantics: repeated lookup of the same completed operation must not close anything again.

Immediately before cleanup, require an existing live runtime, correct ownership, idle snapshot, no reload, empty queue, no pending dialog, and no unresolved switch. Query the actual RPC `get_state`; validate session ID/file and well-formed idle indicators (`isStreaming === false`, `isCompacting === false`, `pendingMessageCount === 0`). After the await, recheck that the same live instance and all local safety conditions still hold. Missing, malformed, busy, failed or changed state must not invoke RPC close or release the lease. Known busy requests are rejected; synchronization uncertainty is explicitly represented rather than treated as success. Only then enter `releasing` and reuse existing RPC close / owner-to-tui / lease close / removal sequence. Do not add manual force-kill or bypass existing cleanup protection.

## Verification

Use isolated fixtures and the actual runtime/RPC and HTTP handlers, with deterministic gates and fake-Pi journals to establish no-close behavior, rather than only mocking eligibility predicates. Tests must check active process/session survival, writer-lease behavior, retained native session bytes/history, and which target was closed. Cover admission races, idle-to-running changes during state read, malformed/unknown RPC state, queued work, pending dialogs, transitions, auth/Origin, duplicate IDs, and existing release/claim behavior.

Browser tests must run the actual built frontend with isolated synthetic backend/fixtures on desktop and mobile. Verify discovery across projects, exact names/directories/statuses, navigation/draft preservation, confirmation/cancel, safe idle release, refusal of busy rows, refresh/failure/staleness/offline protection, and unknown receipt recovery without mutation replay.

Build only to feature-specific ignored artifact directories. Do not run repository `npm run build`, write `dist`, or modify/start/stop `.test-artifacts/live-instance`. Existing browser fixtures must support an isolated web-root override if needed; otherwise create a feature-specific fixture. Do not reuse an existing server. No production endpoint, model call, service restart, or sensitive data inspection.

## Practical nonfunctional scope

No new dependencies or distributed mechanisms. Reuse current same-session serialization and ownership/lease semantics. A single summary request per refresh avoids per-session frontend fan-out; existing bounded name-reading behavior prevents unbounded content reads. Main agent accepts backend evidence before frontend integration, then accepts frontend before dependent browser validation.
