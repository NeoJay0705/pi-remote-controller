import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  emptyLiveTools,
  projectConversation,
  reconcileLiveTools,
  reduceLiveTools,
  sanitizeLiveTool,
  type LiveToolsState,
  type ToolView,
} from "../../src/web/conversation.js";
import { ToolCard } from "../../src/web/ToolCard.js";

const entry = (id: string, role: string, content: unknown, extra = {}) => ({
  id,
  parentId: null,
  type: "message",
  message: { role, content, ...extra },
});
const call = (id: string, args: unknown = {}) => ({
  type: "toolCall",
  id,
  name: "subagent",
  arguments: args,
});
const event = (
  type: string,
  id: string,
  extra: Record<string, unknown> = {},
) => ({
  type,
  toolCallId: id,
  toolName: "bash",
  args: { command: "echo ok" },
  ...extra,
});
const chars = (tools: ToolView[]) =>
  tools.reduce(
    (n, t) =>
      n +
      t.args.length +
      t.output.length +
      (t.children ?? []).reduce(
        (m, c) => m + c.messages.reduce((k, x) => k + x.text.length, 0),
        0,
      ),
    0,
  );

describe("conversation projection and live reducer", () => {
  it("pairs calls across requests, preserves real request IDs, and deduplicates duplicate results", () => {
    const projected = projectConversation([
      entry("u1", "user", "first"),
      entry("a1", "assistant", [call("call-1")]),
      entry("u2", "user", "second"),
      entry("a2", "assistant", [call("call-2")]),
      entry("r1", "toolResult", "out-1", { toolCallId: "call-1" }),
      entry("r2", "toolResult", "out-2", { toolCallId: "call-2" }),
      entry("r2", "toolResult", "duplicate", { toolCallId: "call-2" }),
    ]);
    expect(projected.find((item) => item.id === "a1")?.requestId).toBe("u1");
    expect(projected.find((item) => item.id === "a2")?.requestId).toBe("u2");
    expect(projected.find((item) => item.id === "a1")?.tools[0]?.output).toBe(
      "out-1",
    );
    expect(projected.filter((item) => item.role === "toolResult")).toHaveLength(
      0,
    );
  });
  it("keeps all orphans independent of the latest user and rejects overlong call IDs", () => {
    const projected = projectConversation([
      entry("u", "user", "question"),
      entry("orphan", "toolResult", "orphan output"),
      entry("orphan-with-id", "toolResult", "orphan with call ID", {
        toolCallId: "missing-call",
      }),
      entry("a", "assistant", [call("x".repeat(201))]),
    ]);
    const orphan = projected.find((item) => item.id === "orphan");
    expect(orphan?.requestId).toBe("orphan:orphan");
    expect(orphan?.incomplete).toBe(true);
    expect(
      projected.find((item) => item.id === "orphan-with-id")?.requestId,
    ).toBe("orphan:orphan-with-id");
    expect(projected.find((item) => item.id === "a")?.tools).toHaveLength(0);
  });
  it("retains history with more than 80 calls and lets history-final defeat late live progress", () => {
    const entries = [
      entry(
        "a",
        "assistant",
        Array.from({ length: 90 }, (_, i) => call(`c${i}`)),
      ),
      entry("r", "toolResult", "finished", {
        toolCallId: "c0",
        details: {
          results: [
            {
              agent: "worker",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "native-final" }],
                },
              ],
            },
          ],
        },
      }),
    ];
    const projected = projectConversation(entries, [
      sanitizeLiveTool(
        event("tool_execution_update", "c0", {
          toolName: "subagent",
          partialResult: {
            content: [{ type: "text", text: "late" }],
            details: {
              results: [
                {
                  agent: "worker",
                  exitCode: 0,
                  messages: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "late-child" }],
                    },
                  ],
                },
              ],
            },
          },
        }),
      )!,
    ]);
    const calls = projected.flatMap((item) => item.tools);
    expect(calls).toHaveLength(90);
    expect(calls[0]?.output).toBe("finished");
    expect(calls[0]?.children?.[0]).toMatchObject({
      status: "completed",
      messages: [{ role: "assistant", text: "native-final" }],
    });
    expect(
      calls[0]?.children?.[0]?.messages.map((message) => message.text),
    ).not.toContain("late-child");
  });
  it("does not render duplicate call IDs from later assistant messages", () => {
    const projected = projectConversation([
      entry("u", "user", "question"),
      entry("a1", "assistant", [call("duplicate")]),
      entry("a2", "assistant", [call("duplicate")]),
    ]);
    expect(projected.find((item) => item.id === "a1")?.tools).toHaveLength(1);
    expect(projected.find((item) => item.id === "a2")?.tools).toHaveLength(0);
  });
  it("retains a live overlay for history-pending calls; pending accepts end, terminal rejects late update", () => {
    const pending = projectConversation(
      [entry("a", "assistant", [call("c")])],
      [
        sanitizeLiveTool(
          event("tool_execution_update", "c", {
            partialResult: { content: [{ type: "text", text: "progress" }] },
          }),
        )!,
      ],
    );
    expect(pending[0]?.tools[0]?.output).toBe("progress");
    let state = reduceLiveTools(
      emptyLiveTools(),
      event("tool_execution_start", "c"),
    );
    state = {
      ...state,
      tools: state.tools.map((tool) => ({ ...tool, status: "pending" })),
    };
    state = reduceLiveTools(
      state,
      event("tool_execution_update", "c", {
        partialResult: { content: [{ type: "text", text: "resynced" }] },
      }),
    );
    expect(state.tools[0]?.output).toBe("resynced");
    state = {
      ...state,
      tools: state.tools.map((tool) => ({ ...tool, status: "pending" })),
    };
    state = reduceLiveTools(
      state,
      event("tool_execution_end", "c", {
        result: { content: [{ type: "text", text: "done" }] },
      }),
    );
    const terminal = reduceLiveTools(
      state,
      event("tool_execution_update", "c", {
        partialResult: { content: [{ type: "text", text: "late" }] },
      }),
    );
    expect(terminal.tools[0]?.status).toBe("completed");
    expect(terminal.tools[0]?.output).toBe("done");
  });
  it("always applies a true end and preserves existing args/agent/cwd when later events omit them", () => {
    let state = reduceLiveTools(emptyLiveTools(), {
      ...event("tool_execution_start", "c"),
      toolName: "subagent",
      args: { agent: "worker", cwd: "/tmp" },
    });
    state = reduceLiveTools(state, {
      type: "tool_execution_end",
      toolCallId: "c",
      isError: true,
      result: { content: [{ type: "text", text: "failed" }] },
    });
    expect(state.tools[0]).toMatchObject({
      status: "failed",
      agent: "worker",
      cwd: "/tmp",
    });
  });
  it("resets a new run and replaces repeated child snapshots instead of appending", () => {
    const snapshot = (text: string) =>
      event("tool_execution_update", "c", {
        toolName: "subagent",
        partialResult: {
          details: {
            results: [
              {
                messages: [
                  { role: "assistant", content: [{ type: "text", text }] },
                ],
              },
            ],
          },
        },
      });
    let state = reduceLiveTools(emptyLiveTools(), snapshot("one"));
    state = reduceLiveTools(state, snapshot("two"));
    expect(state.tools[0]?.children?.[0]?.messages).toHaveLength(1);
    expect(emptyLiveTools()).toMatchObject({
      tools: [],
      omitted: 0,
      truncated: false,
    });
  });
  it("reconciles confirmed calls and clears volatile state when the active branch changes", () => {
    const seed: LiveToolsState = {
      ...emptyLiveTools(),
      tools: ["confirmed", "provisional"].map((id) => ({
        id,
        name: "x",
        args: "",
        output: "",
        status: "running" as const,
        purpose: "x",
      })),
      confirmed: ["confirmed"],
    };
    const pruned = reconcileLiveTools(
      seed,
      [entry("leaf", "user", "x")],
      "leaf",
    );
    expect(pruned.tools.map((tool) => tool.id)).toEqual(["provisional"]);
    expect(
      reconcileLiveTools(seed, [entry("new-leaf", "user", "x")], "old-leaf")
        .tools,
    ).toEqual([]);
  });
  it("handles malformed inputs and sanitizes private data", () => {
    expect(sanitizeLiveTool(null)).toBeUndefined();
    expect(sanitizeLiveTool({ toolCallId: "x" })).toBeDefined();
    const projected = projectConversation([
      entry("sys", "system", "SYSTEM-SENTINEL"),
      entry("a", "assistant", [
        { type: "thinking", thinking: "THINKING-SENTINEL" },
        { type: "text", text: "visible" },
      ]),
      entry("r", "toolResult", "OUTER", {
        toolCallId: "missing",
        details: { stderr: "STDERR-SENTINEL", signature: "SIGNATURE-SENTINEL" },
      }),
    ]);
    expect(JSON.stringify(projected)).not.toMatch(
      /SYSTEM-SENTINEL|THINKING-SENTINEL|STDERR-SENTINEL|SIGNATURE-SENTINEL/,
    );
  });
  it("enforces 8-child, 12-message, 16 KiB per-tool, 256 KiB global and 80-call limits", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      agent: `a${i}`,
      exitCode: 0,
      messages: Array.from({ length: 14 }, () => ({
        role: "assistant",
        content: [{ type: "text", text: "x" }],
      })),
    }));
    const tool = sanitizeLiveTool(
      event("tool_execution_update", "big", {
        toolName: "subagent",
        args: { code: "x".repeat(30000) },
        partialResult: {
          content: [{ type: "text", text: "y".repeat(30000) }],
          details: { results },
        },
      }),
    )!;
    expect(
      tool.args.length +
        tool.output.length +
        (tool.children ?? []).reduce(
          (n, c) => n + c.messages.reduce((m, x) => m + x.text.length, 0),
          0,
        ),
    ).toBeLessThanOrEqual(16 * 1024);
    expect(tool.children).toHaveLength(8);
    expect(tool.children?.[0]?.messages).toHaveLength(12);
    expect(tool.children?.[0]?.status).toBe("running");
    let state = emptyLiveTools();
    for (let i = 0; i < 90; i++)
      state = reduceLiveTools(state, event("tool_execution_start", `c${i}`));
    expect(state.tools).toHaveLength(80);
    expect(state.omitted).toBe(10);
    expect(state.truncated).toBe(true);
    state = emptyLiveTools();
    for (let i = 0; i < 30; i++)
      state = reduceLiveTools(
        state,
        event("tool_execution_start", `g${i}`, {
          args: { code: "x".repeat(12000) },
        }),
      );
    expect(chars(state.tools)).toBeLessThanOrEqual(256 * 1024);
    expect(state.omitted).toBeGreaterThan(0);
    expect(
      reduceLiveTools(
        emptyLiveTools(),
        event("tool_execution_start", "z".repeat(201)),
      ).tools,
    ).toHaveLength(0);
  });
  it("projects historical child errors, repair messages, and typed DOM roles without thinking", () => {
    const history = [
      entry("a", "assistant", [
        call("parent", {
          agent: "worker",
          cwd: "/tmp",
          tasks: [{ prompt: "x" }, { prompt: "y" }],
        }),
      ]),
      entry("r", "toolResult", [{ type: "text", text: "parent done" }], {
        toolCallId: "parent",
        details: {
          results: [
            {
              agent: "worker",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  model: { id: "role-model", provider: "provider" },
                  content: [
                    { type: "thinking", thinking: "THINKING-SENTINEL" },
                    { type: "text", text: "repair continues" },
                  ],
                },
                {
                  role: "toolResult",
                  isError: true,
                  content: [{ type: "text", text: "bad tool result" }],
                },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "fixed" }],
                },
              ],
            },
          ],
        },
      }),
    ];
    const item = projectConversation(history)[0]?.tools[0];
    expect(item).toMatchObject({ mode: "parallel", status: "completed" });
    expect(item?.children?.[0]).toMatchObject({
      agent: "worker",
      model: "provider/role-model",
      status: "completed",
    });
    expect(item?.children?.[0]?.messages.map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const html = renderToStaticMarkup(
      React.createElement(ToolCard, { tool: item! }),
    );
    expect(html).toContain("工具結果 · 失敗");
    expect(html).toContain("Assistant");
    expect(html).not.toContain("THINKING-SENTINEL");
  });
  it("caps projected child blocks at 12 and marks the timeline truncated", () => {
    const tool = sanitizeLiveTool(
      event("tool_execution_update", "many-blocks", {
        toolName: "subagent",
        partialResult: {
          details: {
            results: [
              {
                messages: [
                  {
                    role: "assistant",
                    content: Array.from({ length: 15 }, (_, index) => ({
                      type: "text",
                      text: `block-${index}`,
                    })),
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(tool?.children?.[0]?.messages).toHaveLength(12);
    expect(tool?.children?.[0]?.truncated).toBe(true);
  });
  it("displays string child models and marks final child exit zero completed", () => {
    const history = projectConversation([
      entry("call", "assistant", [call("model-call")]),
      entry("result", "toolResult", "done", {
        toolCallId: "model-call",
        details: {
          results: [
            {
              agent: "worker",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  model: "gpt-6-luna",
                  provider: "fake",
                  content: [{ type: "text", text: "finished" }],
                },
              ],
            },
          ],
        },
      }),
    ]);
    expect(history[0]?.tools[0]?.children?.[0]).toMatchObject({
      status: "completed",
      model: "fake/gpt-6-luna",
    });
  });
  it("does not treat active partial exitCode zero as completion", () => {
    expect(
      sanitizeLiveTool(
        event("tool_execution_update", "c", {
          toolName: "subagent",
          partialResult: { exitCode: 0 },
        }),
      )?.status,
    ).toBe("running");
  });
});
