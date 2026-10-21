import type { OperationKind, RuntimeState } from "../shared/contracts.js";

export function canSubmitMessage(input: {
  kind: "prompt" | "steer" | "follow_up";
  draft: string;
  runtimeState: RuntimeState | undefined;
  connected: boolean;
  online: boolean;
  busy: boolean;
  hasSnapshot: boolean;
}): boolean {
  const { kind, draft, runtimeState, connected, online, busy, hasSnapshot } =
    input;
  return (
    !!draft.trim() &&
    connected &&
    online &&
    !busy &&
    hasSnapshot &&
    ((kind === "prompt" &&
      (runtimeState === "idle" || runtimeState === "released")) ||
      ((kind === "steer" || kind === "follow_up") &&
        runtimeState === "running"))
  );
}

export function canCompact(input: {
  runtimeState: RuntimeState | undefined;
  queueLength: number;
  connected: boolean;
  online: boolean;
  busy: boolean;
  hasSnapshot: boolean;
}): boolean {
  return (
    input.runtimeState === "idle" &&
    input.queueLength === 0 &&
    input.connected &&
    input.online &&
    !input.busy &&
    input.hasSnapshot
  );
}

export type MessageKind = Extract<
  OperationKind,
  "prompt" | "steer" | "follow_up"
>;
