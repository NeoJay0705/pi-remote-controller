import type { HistoryEntry } from "./api.js";

export type ToolStatus = "running" | "completed" | "failed" | "pending";
export type ChildMessage = {
  role: "assistant" | "toolCall" | "toolResult";
  toolName?: string;
  text: string;
  isError?: boolean;
};
export type ChildView = {
  index: number;
  status: string;
  agent?: string;
  model?: string;
  messages: ChildMessage[];
  truncated?: boolean;
};
export type ToolView = {
  id: string;
  name: string;
  args: string;
  output: string;
  status: ToolStatus;
  purpose: string;
  mode?: string;
  agent?: string;
  cwd?: string;
  model?: string;
  children?: ChildView[];
  childrenTruncated?: boolean;
  truncated?: boolean;
};
export type LiveToolsState = {
  tools: ToolView[];
  omitted: number;
  truncated: boolean;
  confirmed: string[];
};
export type ConversationMessage = {
  id: string;
  requestId: string;
  role: "user" | "assistant" | "toolResult" | "other";
  text: string;
  tools: ToolView[];
  incomplete?: boolean;
  truncated?: boolean;
};
const MAX_CALLS = 80,
  MAX_PREVIEW = 16 * 1024,
  MAX_TEXT = 256 * 1024,
  marker = "\n[內容已截斷]";
export const emptyLiveTools = (): LiveToolsState => ({
  tools: [],
  omitted: 0,
  truncated: false,
  confirmed: [],
});
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function bounded(value: unknown, limit = 30000): string {
  if (typeof value !== "string") return "";
  return value.length > limit
    ? value.slice(0, Math.max(0, limit - marker.length)) + marker
    : value;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      return item.type === "text" && typeof item.text === "string"
        ? item.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}
function safe(
  value: unknown,
  budget: { left: number },
  limit = MAX_PREVIEW,
): string {
  const result = typeof value === "string" ? value : "",
    cap = Math.max(0, Math.min(limit, budget.left));
  const projected =
    result.length > cap
      ? cap === 0
        ? ""
        : result.slice(0, Math.max(0, cap - marker.length)) +
          (cap >= marker.length ? marker : "")
      : result;
  budget.left -= projected.length;
  return projected;
}
const argKeys = [
  "command",
  "path",
  "file_path",
  "pattern",
  "agent",
  "mode",
  "cwd",
  "model",
  "task",
  "code",
];
function argsSummary(
  name: string,
  args: unknown,
  budget: { left: number },
): string {
  const a = record(args),
    fields: string[] = [];
  for (const key of argKeys)
    if (["string", "number", "boolean"].includes(typeof a[key]))
      fields.push(`${key}: ${String(a[key])}`);
  if (!fields.length && name === "read") fields.push("讀取指定路徑");
  if (!fields.length && name === "write") fields.push("寫入指定路徑");
  if (!fields.length && name === "bash") fields.push("執行命令");
  if (!fields.length && name === "subagent") fields.push("委派子 agent 工作");
  if (!fields.length && name === "codemode") fields.push("執行協作腳本");
  return safe(fields.join("\n") || `呼叫 ${bounded(name, 100)} 工具`, budget);
}
function taskMode(args: unknown, details: unknown): string | undefined {
  const a = record(args),
    d = record(details);
  const tasks = Array.isArray(a.tasks)
    ? a.tasks
    : Array.isArray(a.chain)
      ? a.chain
      : undefined;
  if (Array.isArray(a.chain)) return "chain";
  if (tasks)
    return typeof d.mode === "string" &&
      ["single", "parallel", "chain"].includes(d.mode)
      ? d.mode
      : tasks.length > 1
        ? "parallel"
        : "single";
  if (
    typeof d.mode === "string" &&
    ["single", "parallel", "chain"].includes(d.mode)
  )
    return d.mode;
  return undefined;
}
function childTimeline(
  value: unknown,
  budget: { left: number },
  final = false,
): { children?: ChildView[]; truncated?: boolean } {
  const root = record(value),
    details = record(root.details),
    raw = Array.isArray(details.results) ? details.results : [];
  if (!raw.length) return {};
  const children = raw.slice(0, 8).map((value, index): ChildView => {
    const item = record(value),
      messages = Array.isArray(item.messages)
        ? item.messages
        : Array.isArray(item.events)
          ? item.events
          : [];
    const projected: ChildMessage[] = [];
    let actualModel: string | undefined;
    for (const rawMessage of messages.slice(-12)) {
      const msg = record(rawMessage),
        role = msg.role;
      if (role === "assistant") {
        const model = record(msg.model);
        if (!actualModel) {
          const provider =
            typeof msg.provider === "string"
              ? msg.provider
              : typeof model.provider === "string"
                ? model.provider
                : "";
          const id =
            typeof msg.model === "string"
              ? msg.model
              : typeof model.id === "string"
                ? model.id
                : "";
          if (provider || id)
            actualModel = bounded(
              [provider, id].filter(Boolean).join("/"),
              200,
            );
        }
        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          const part = record(block);
          if (part.type === "text" && typeof part.text === "string")
            projected.push({
              role: "assistant",
              text: safe(part.text, budget),
            });
          else if (part.type === "toolCall" && typeof part.name === "string")
            projected.push({
              role: "toolCall",
              toolName: bounded(part.name, 100),
              text: argsSummary(part.name, part.arguments, budget),
            });
        }
      } else if (role === "toolResult") {
        const call = record(msg);
        projected.push({
          role: "toolResult",
          text: safe(text(msg.content), budget),
          ...(call.isError === true ? { isError: true } : {}),
        });
      }
    }
    const exit = item.exitCode;
    const status =
      item.error || (typeof exit === "number" && exit !== 0)
        ? "failed"
        : final && typeof exit === "number"
          ? "completed"
          : "running";
    return {
      index,
      status,
      ...(typeof item.agent === "string"
        ? { agent: bounded(item.agent, 200) }
        : {}),
      ...(actualModel
        ? { model: actualModel }
        : typeof item.model === "string"
          ? { model: bounded(item.model, 200) }
          : {}),
      messages: projected.slice(0, 12),
      ...(projected.length > 12 || messages.length > 12
        ? { truncated: true }
        : {}),
    };
  });
  return { children, ...(raw.length > 8 ? { truncated: true } : {}) };
}
function purpose(name: string, args: unknown): string {
  const a = record(args);
  if (name === "read")
    return `讀取 ${bounded(a.path ?? a.file_path, 180) || "指定路徑"}`;
  if (name === "write")
    return `寫入 ${bounded(a.path ?? a.file_path, 180) || "指定路徑"}`;
  if (name === "bash")
    return `執行命令：${bounded(a.command, 180).split(/[\r\n]/)[0] || "命令摘要不可用"}`;
  if (name === "subagent")
    return `委派角色：${bounded(a.agent, 100) || "未提供"}`;
  if (name === "codemode") return "執行協作腳本";
  return `執行 ${bounded(name, 100)} 工具`;
}
function projectChildren(call: ToolView, result: unknown): void {
  if (call.name !== "subagent") return;
  const timeline = childTimeline(result, { left: MAX_PREVIEW }, true);
  if (timeline.children) call.children = timeline.children;
  else delete call.children;
  if (timeline.truncated) call.childrenTruncated = true;
  else delete call.childrenTruncated;
}
export function projectConversation(
  entries: HistoryEntry[],
  live: ToolView[] = [],
): ConversationMessage[] {
  const output: ConversationMessage[] = [],
    calls = new Map<string, ToolView>(),
    seenResults = new Set<string>(),
    seenResultCalls = new Set<string>(),
    resultCalls = new Set<string>();
  let requestId = "history-continuation",
    continuation = 0;
  for (const entry of entries) {
    if (entry.type === "compaction") {
      output.push({
        id: entry.id,
        requestId,
        role: "other",
        text: bounded(entry.summary ?? "摘要不可用"),
        tools: [],
        ...(entry.truncated ? { truncated: true } : {}),
      });
      continue;
    }
    const message = record(entry.message),
      role = message.role;
    if (role === "system") continue;
    if (role === "user") {
      requestId = entry.id || `history-continuation-${++continuation}`;
      output.push({
        id: entry.id,
        requestId,
        role: "user",
        text: bounded(text(message.content)),
        tools: [],
        ...(entry.truncated ? { truncated: true } : {}),
      });
      continue;
    }
    if (role === "assistant") {
      const tools: ToolView[] = [];
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        const part = record(block);
        if (
          part.type !== "toolCall" ||
          typeof part.id !== "string" ||
          !part.id ||
          part.id.length > 200
        )
          continue;
        const existing = calls.get(part.id);
        if (existing) continue;
        const name = bounded(part.name, 100) || "unknown",
          args = part.arguments,
          a = record(args),
          mode = taskMode(args, {}),
          view: ToolView = {
            id: part.id,
            name,
            args: argsSummary(name, args, { left: MAX_PREVIEW }),
            output: "",
            status: "pending",
            purpose: purpose(name, args),
            ...(name === "subagent"
              ? {
                  ...(mode ? { mode } : {}),
                  ...Object.fromEntries(
                    ["agent", "cwd", "model"]
                      .filter((key) => typeof a[key] === "string")
                      .map((key) => [key, bounded(a[key], 300)]),
                  ),
                }
              : {}),
          };
        calls.set(part.id, view);
        tools.push(view);
      }
      output.push({
        id: entry.id,
        requestId,
        role: "assistant",
        text: bounded(text(message.content)),
        tools,
        ...(entry.truncated ? { truncated: true } : {}),
      });
      continue;
    }
    if (role === "toolResult") {
      const callId =
          typeof message.toolCallId === "string" &&
          message.toolCallId.length <= 200
            ? message.toolCallId
            : "",
        call = calls.get(callId);
      if (seenResults.has(entry.id) || (callId && seenResultCalls.has(callId)))
        continue;
      seenResults.add(entry.id);
      if (callId) seenResultCalls.add(callId);
      if (call && !resultCalls.has(callId)) {
        const result = { content: message.content, details: message.details };
        call.output = safe(text(message.content), {
          left: Math.max(0, MAX_PREVIEW - call.args.length),
        });
        if (message.truncated === true || entry.truncated)
          call.truncated = true;
        call.status = message.isError === true ? "failed" : "completed";
        projectChildren(call, result);
        const details = record(message.details);
        if (call.name === "subagent") {
          const mode = call.mode ?? taskMode({}, details);
          if (mode) call.mode = mode;
          if (!call.agent && typeof details.agent === "string")
            call.agent = bounded(details.agent, 300);
          if (!call.cwd && typeof details.cwd === "string")
            call.cwd = bounded(details.cwd, 300);
          if (!call.model && typeof details.model === "string")
            call.model = bounded(details.model, 300);
        }
        resultCalls.add(callId);
      } else {
        output.push({
          id: entry.id,
          requestId: `orphan:${entry.id}`,
          role: "toolResult",
          text: bounded(text(message.content)),
          tools: [],
          incomplete: true,
          ...(entry.truncated ? { truncated: true } : {}),
        });
      }
    }
  }
  for (const call of calls.values()) Object.assign(call, sanitizeTool(call));
  const historyCalls = new Set(calls.keys());
  for (const item of live.slice(-MAX_CALLS)) {
    const existing = calls.get(item.id);
    if (existing) {
      if (
        !resultCalls.has(item.id) &&
        existing.status !== "completed" &&
        existing.status !== "failed"
      ) {
        const previouslyTruncated = existing.truncated;
        Object.assign(existing, item, { id: existing.id });
        if (previouslyTruncated) existing.truncated = true;
      }
    } else if (!historyCalls.has(item.id)) calls.set(item.id, item);
  }
  const transient = [...calls.values()]
    .filter((item) => !historyCalls.has(item.id))
    .slice(-MAX_CALLS);
  if (transient.length)
    output.push({
      id: "live-sync",
      requestId: "live-sync",
      role: "other",
      text: "本次請求同步中（尚未關聯原生歷史）",
      tools: transient,
    });
  return output;
}
export function sanitizeLiveTool(value: unknown): ToolView | undefined {
  const event = record(value),
    id = event.toolCallId;
  if (typeof id !== "string" || !id || id.length > 200) return;
  const name = bounded(event.toolName, 100) || "unknown",
    budget = { left: MAX_PREVIEW },
    args = event.args,
    a = record(args),
    end = event.type === "tool_execution_end",
    error = event.isError === true,
    result = end ? event.result : event.partialResult,
    details = record(record(result).details);
  const timeline = childTimeline(result, budget, end),
    mode = taskMode(args, details);
  const view: ToolView = {
    id,
    name,
    purpose: purpose(name, args),
    args: argsSummary(name, args, budget),
    output: safe(text(record(result).content), budget),
    status: end ? (error ? "failed" : "completed") : "running",
    ...(record(result).truncated === true ? { truncated: true } : {}),
    ...timeline,
  };
  if (name === "subagent") {
    if (mode) view.mode = mode;
    for (const key of ["agent", "cwd", "model"] as const)
      if (typeof a[key] === "string") view[key] = bounded(a[key], 300);
    if (!view.agent && typeof details.agent === "string")
      view.agent = bounded(details.agent, 300);
    if (!view.model && typeof details.model === "string")
      view.model = bounded(details.model, 300);
  }
  if (!end && record(result).exitCode === 0) view.status = "running";
  if (
    end &&
    record(result).exitCode === 0 &&
    name === "subagent" &&
    view.children?.some((child) => child.status === "running")
  )
    view.output = `${view.output}${view.output ? "\n" : ""}程序結束／任務結果見訊息`;
  return sanitizeTool(view);
}
function liveChars(tool: ToolView): number {
  return (
    tool.name.length +
    tool.purpose.length +
    tool.args.length +
    tool.output.length +
    [tool.mode, tool.agent, tool.cwd, tool.model].reduce(
      (n, value) => n + (value?.length ?? 0),
      0,
    ) +
    (tool.children ?? []).reduce(
      (n, child) =>
        n +
        (child.agent?.length ?? 0) +
        (child.model?.length ?? 0) +
        child.messages.reduce(
          (m, item) => m + item.text.length + (item.toolName?.length ?? 0),
          0,
        ),
      0,
    )
  );
}
function sanitizeTool(tool: ToolView): ToolView {
  const budget = { left: MAX_PREVIEW };
  const clean: ToolView = {
    id: bounded(tool.id, 200),
    name: safe(tool.name, budget, 100),
    purpose: safe(tool.purpose, budget, 500),
    args: safe(tool.args, budget),
    output: safe(tool.output, budget),
    status: tool.status,
    ...(tool.truncated ? { truncated: true } : {}),
  };
  for (const key of ["mode", "agent", "cwd", "model"] as const)
    if (typeof tool[key] === "string")
      clean[key] = safe(tool[key], budget, 300);
  if (tool.children) {
    clean.children = tool.children.slice(0, 8).map((child) => ({
      index: child.index,
      status: child.status,
      ...(child.agent ? { agent: safe(child.agent, budget, 200) } : {}),
      ...(child.model ? { model: safe(child.model, budget, 200) } : {}),
      messages: child.messages.slice(-12).map((item) => ({
        role: item.role,
        ...(item.toolName
          ? { toolName: safe(item.toolName, budget, 100) }
          : {}),
        text: safe(item.text, budget),
        ...(item.isError ? { isError: true } : {}),
      })),
      ...(child.truncated ? { truncated: true } : {}),
    }));
    if (tool.childrenTruncated) clean.childrenTruncated = true;
  }
  return clean;
}
export function reduceLiveTools(
  state: LiveToolsState,
  event: unknown,
): LiveToolsState {
  const tool = sanitizeLiveTool(event);
  if (!tool) return state;
  const eventType = record(event).type,
    at = state.tools.findIndex((item) => item.id === tool.id),
    old = at < 0 ? undefined : state.tools[at];
  if (
    old &&
    (old.status === "completed" || old.status === "failed") &&
    eventType !== "tool_execution_end"
  )
    return state;
  if (old) {
    if (!record(event).args) tool.args = old.args;
    if (!record(event).toolName) {
      tool.name = old.name;
      tool.purpose = old.purpose;
    }
    for (const key of ["agent", "cwd", "mode", "model"] as const)
      if (!tool[key] && old[key]) tool[key] = old[key];
  }
  const tools = state.tools.slice();
  if (at >= 0) tools[at] = sanitizeTool(tool);
  else tools.push(sanitizeTool(tool));
  let omitted = state.omitted;
  while (tools.length > MAX_CALLS) {
    const ix = tools.findIndex((item) => item.status !== "running");
    tools.splice(ix >= 0 ? ix : 0, 1);
    omitted++;
  }
  while (
    tools.reduce((sum, item) => sum + liveChars(item), 0) > MAX_TEXT &&
    tools.length
  ) {
    const ix = tools.findIndex((item) => item.status !== "running");
    tools.splice(ix >= 0 ? ix : 0, 1);
    omitted++;
  }
  return { tools, omitted, truncated: omitted > 0, confirmed: state.confirmed };
}
export function reconcileLiveTools(
  state: LiveToolsState,
  entries: HistoryEntry[],
  previousLeaf?: string,
): LiveToolsState {
  const leaf = entries.at(-1)?.id;
  if (
    previousLeaf &&
    (!leaf || !entries.some((entry) => entry.id === previousLeaf))
  )
    return emptyLiveTools();
  const historyIds = new Set<string>();
  for (const entry of entries) {
    const msg = record(entry.message);
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const p = record(part);
      if (
        p.type === "toolCall" &&
        typeof p.id === "string" &&
        p.id.length <= 200
      )
        historyIds.add(p.id);
    }
  }
  const liveIds = new Set(state.tools.map((tool) => tool.id));
  const confirmed = [...new Set([...state.confirmed, ...historyIds])].filter(
    (id) => liveIds.has(id),
  );
  return {
    ...state,
    confirmed,
    tools: state.tools.filter(
      (tool) => !confirmed.includes(tool.id) || historyIds.has(tool.id),
    ),
  };
}
