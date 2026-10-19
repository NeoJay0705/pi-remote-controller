const KNOWN_ERRORS = new Set([
  "invalid_config",
  "invalid_project_discovery_root",
  "invalid_port",
  "invalid_origin",
  "https_required",
  "config_required",
  "invalid_project",
  "invalid_profile",
  "invalid_project_cwd",
  "invalid_session_dir",
  "invalid_data_dir",
  "invalid_pi_cli",
  "invalid_extension_path",
  "invalid_prompt_path",
  "duplicate_config_id",
  "invalid_profile_setting",
  "pi_package_metadata_missing",
  "unsupported_pi_version",
  "owner_token_invalid",
  "invalid_native_path",
  "invalid_native_file",
  "native_session_exists",
  "native_path_forbidden",
  "native_file_changed",
  "invalid_native_history",
  "invalid_native_header",
  "native_cwd_mismatch",
  "native_id_mismatch",
  "native_parent_missing",
  "native_invalid_before",
  "session_directory_too_large",
  "invalid_history_query",
  "operation_conflict",
  "profile_conflict",
  "session_profile_blocked",
  "storage_error",
  "writer_locked",
  "lease_unavailable",
  "unsafe_lock_file",
  "lease_closed",
  "invalid_schema",
  "invalid_session_name",
  "origin_forbidden",
  "json_required",
  "unauthorized",
  "rate_limited",
  "not_found",
  "invalid_project_or_profile",
  "already_claimed",
  "not_running",
  "session_busy",
  "session_idle",
  "text_required",
  "session_blocked",
  "dialog_invalid",
  "extension_command_unsupported",
  "unsupported_operation",
  "rpc_session_mismatch",
  "rpc_id_mismatch",
  "rpc_model_mismatch",
  "rpc_provider_mismatch",
  "rpc_thinking_mismatch",
  "invalid_session_config",
  "tui_owner_required",
  "session_not_found",
  "tui_not_owner",
  "tui_failed",
  "internal_error",
  "rpc_command_rejected",
  "compact_rejected",
  "rpc_compact_unconfirmed",
  "project_discovery_unavailable",
  "project_discovery_too_large",
  "project_discovery_collision",
  "rpc_protocol_error",
  "rpc_invalid_utf8",
  "rpc_frame_too_large",
  "rpc_command_too_large",
  "rpc_write_queue_full",
  "rpc_timeout",
  "rpc_closed",
  "rpc_stdin_error",
  "rpc_stdout_error",
  "rpc_process_error",
  "cleanup_incomplete",
  "closing",
  "owner_mismatch",
  "unsafe-path",
  "unsupported-file",
  "permission-denied",
  "invalid-header",
  "invalid-record",
  "work-budget",
  "reload-required",
  "sync_conflict",
  "sync_cancelled",
  "sync_unconfirmed",
  "profile_switch_unconfirmed",
  "rpc_profile_mismatch",
]);
export function isKnownErrorCode(code: unknown): code is string {
  return typeof code === "string" && KNOWN_ERRORS.has(code);
}
export function safeErrorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR"
  )
    return "storage_error";
  if (error instanceof Error && isKnownErrorCode(error.message))
    return error.message;
  return "internal_error";
}
export function statusForError(
  error: unknown,
  code = safeErrorCode(error),
): number {
  if (
    code === "internal_error" ||
    code === "storage_error" ||
    code === "cleanup_incomplete"
  )
    return 500;
  if (
    code === "closing" ||
    code === "work-budget" ||
    code === "sync_unconfirmed" ||
    code === "profile_switch_unconfirmed" ||
    code === "rpc_profile_mismatch"
  )
    return 503;
  if (
    code === "reload-required" ||
    code === "sync_conflict" ||
    code === "sync_cancelled"
  )
    return 409;
  if (code === "rpc_command_rejected" || code === "compact_rejected")
    return 409;
  if (code === "rpc_compact_unconfirmed") return 503;
  if (
    code.startsWith("rpc_") &&
    (error as { uncertain?: boolean } | null)?.uncertain
  )
    return 503;
  if (
    code === "native_session_exists" ||
    code === "operation_conflict" ||
    code === "profile_conflict" ||
    code === "session_profile_blocked" ||
    code === "session_busy" ||
    code === "session_idle" ||
    code === "already_claimed" ||
    code === "not_running" ||
    code === "session_blocked" ||
    code === "dialog_invalid" ||
    code === "owner_mismatch" ||
    code === "tui_owner_required" ||
    code === "tui_not_owner"
  )
    return 409;
  if (code === "writer_locked") return 423;
  if (code === "unauthorized") return 401;
  if (code === "rate_limited") return 429;
  if (code === "origin_forbidden") return 403;
  if (code === "json_required") return 415;
  if (code === "not_found" || code === "session_not_found") return 404;
  return 400;
}
