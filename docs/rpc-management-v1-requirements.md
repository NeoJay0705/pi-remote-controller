# RPC management v1 requirements

Status: user confirmed the following functional scope on 2026-11-13. All repository paths in this document are repository-relative. Example directories in UI discussions are synthetic, not deployment information.

## Goal

Provide a dedicated RPC management view for safely releasing individual managed runtimes without opening each session's conversation. Keep the session sidebar focused on navigation rather than embedding a management list there.

## Navigation and listing

- Provide an authenticated RPC management entry and a return-to-conversation action.
- Preserve the selected session and its draft while navigating between views. Opening management must not start or claim a runtime, send a prompt, or release anything.
- List Controller-managed sessions whose runtime state is not `released`, across all projects rather than only the currently selected project.
- Do not discover, scan, or take over unrelated native Pi/TUI processes. A `blocked` record is a controller state, not proof that a process is alive.
- Each row shows a session name (with an honest fallback if unavailable), identifiable controller session ID, working directory (`cwd`), runtime state, and the reason release is unavailable when applicable.
- Support all existing runtime states other than `released`, including transitional and blocked states. Unknown directory/state information must not be presented as confirmed.
- Automatically refresh while management is open, and provide manual refresh. Clearly show loading, empty, failed, offline, and stale states. Failed/stale state must not permit release.
- Keep the management view usable on desktop and narrow mobile layouts.

## Release action

- Provide a per-row `Release RPC` button in the management view only; no separate conversation-page release button or bulk release is required.
- Request confirmation identifying the target session and working directory before dispatch.
- Only allow release for an idle runtime with an empty queue and no pending extension dialog. Other states remain visible but disabled with an explanation.
- The backend must revalidate at execution time rather than trusting list/button state. If work has started since the list was read, release must be rejected without closing the active runtime.
- Release must not silently wait behind another operation and later close a runtime on behalf of a now-stale request. In-flight operations and concurrent release attempts require safe admission and execution handling.
- On confirmed success, remove the released session from the active list and show the result. Do not delete session files, history, or the controller's managed record.
- On failure, show the reason and refresh state. Unknown outcomes must not be represented as success and must not trigger automatic operation replay. Do not enable a second release while the first one's outcome remains unresolved.
- Existing release ownership semantics remain: closing the RPC releases its writer lease and hands ownership back to `tui`. A later explicit Web prompt can reclaim/restart according to existing behavior.
- Releasing one runtime must not stop or restart the service or other runtimes.

## Safety and scope

Use existing authentication, request-origin protection, operation IDs, receipts, and session-level operation serialization. Status listing is read-only. Do not add force-close, bulk-release, auto-release, arbitrary OS process control, native TUI management, or destructive recovery functionality.

Implementation and verification must use isolated synthetic fixtures. Live-instance operations, production endpoint requests, real-model inference, and service restart are not authorized by this feature request. Public documentation and fixtures must contain no host-specific paths, credentials, internal addresses, or private session content.

## Acceptance outcomes

1. Multiple managed runtimes from different projects appear with correct IDs, synthetic fixture names/directories, and states; released records are excluded.
2. Listing and navigation do not start runtimes, change the selected conversation/draft, or affect existing work.
3. Idle release is confirmed and closes only the target RPC, releases its lease, retains history/record, and removes its row.
4. Running, queued, dialog-pending, transitional, blocked, stale/offline, and unconfirmed-operation rows cannot be released through UI or backend bypass.
5. Race tests demonstrate that an idle-to-running transition, work pending at admission, and concurrent operations cannot cause active prompt work to be closed by release.
6. Failed/unknown operations remain accurately represented, survive view navigation/reload through existing receipt facilities as appropriate, and are not automatically resent.
7. Desktop/mobile management interactions, refresh behavior, and return-to-conversation behavior work in an isolated browser test against the actual built frontend.
