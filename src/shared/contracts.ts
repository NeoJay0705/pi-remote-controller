export type Owner = "web" | "tui";
export type RuntimeState =
  | "released"
  | "starting"
  | "reconfiguring"
  | "idle"
  | "running"
  | "stopping"
  | "releasing"
  | "blocked";
export type OperationKind =
  | "prompt"
  | "steer"
  | "follow_up"
  | "stop"
  | "compact"
  | "release"
  | "claim"
  | "ui_response"
  | "change_profile";
export interface Project {
  id: string;
  name: string;
  cwd: string;
  sessionDir: string;
}
export interface Profile {
  id: string;
  name: string;
  provider?: string;
  model?: string;
  thinking?: string;
  extensions?: string[];
  tools?: string[];
  appendSystemPrompts?: string[];
}
export interface ProjectDiscoveryConfig {
  root: string;
  sessionRoot: string;
}
export interface WorkspaceConfig {
  port: number;
  publicOrigin: string;
  dataDir: string;
  piCli: string;
  projects: Project[];
  projectDiscovery?: ProjectDiscoveryConfig;
  profiles: Profile[];
  secureCookies?: boolean;
  listenHost?: string;
  allowTailnetHttp?: boolean;
}
export interface OperationInput {
  operationId: string;
  kind: OperationKind;
  text?: string;
  dialogId?: string;
  method?: string;
  value?: unknown;
  profileId?: string;
  expectedProfileId?: string;
  expectedProfileRevision?: number;
}
export interface Receipt {
  operationId: string;
  sessionId: string;
  kind: OperationKind;
  status: string;
  result?: unknown;
}
export interface QueueItem {
  kind: "steer" | "follow_up";
  text: string;
}
export interface PendingDialog {
  id: string;
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  prefill?: string;
  expiresAt: number;
}
export interface SessionNameInfo {
  status: "named" | "unnamed" | "incomplete" | "error";
  name?: string;
  code?: string;
}
export interface Snapshot {
  id: string;
  nativeId: string;
  nameInfo?: SessionNameInfo;
  projectId: string;
  profileId: string;
  profileRevision: number;
  desiredOwner: Owner;
  runtimeState: RuntimeState;
  actualProvider?: string;
  actualModel?: string;
  actualThinking?: string;
  queue: QueueItem[];
  cleared: QueueItem[];
  pendingDialogs?: PendingDialog[];
  lastOutcome?: string;
  lastError?: string;
  cwd?: string;
  sessionDir?: string;
  nativeCommand?: string;
}
export type ReleaseBlockedReason =
  | "not_running"
  | "owner_mismatch"
  | "runtime_not_idle"
  | "operation_in_flight"
  | "runtime_transition"
  | "queue_not_empty"
  | "dialogs_pending"
  | "profile_switch_unresolved"
  | "cwd_unavailable"
  | "rpc_state_unavailable"
  | "rpc_state_mismatch"
  | "rpc_busy"
  | "runtime_changed";
export interface RuntimeSession {
  id: string;
  nameInfo: SessionNameInfo;
  cwd?: string;
  runtimeState: RuntimeState;
  releaseEligible: boolean;
  releaseBlockedReason?: ReleaseBlockedReason;
}
export interface ApiError {
  error: { code: string; message: string };
}
