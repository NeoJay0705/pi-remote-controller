import React, { useState } from "react";
import type { ToolView } from "./conversation.js";
import styles from "./ui.module.css";
import { Message } from "./Message.js";

export function ToolCard({
  tool,
  truncated = false,
}: {
  tool: ToolView;
  truncated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = {
    running: "執行中",
    completed: "呼叫完成",
    failed: "失敗",
    pending: "狀態待同步",
  }[tool.status];
  const activeSubagent = tool.name === "subagent" && tool.status === "running";
  return (
    <details
      className={styles.toolCard}
      data-tool-call-id={tool.id}
      open={open || activeSubagent}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={styles.toolBadge}>{tool.name}</span> {tool.purpose} ·{" "}
        <b>{status}</b>
        {truncated && " · 此工具資料為有界預覽，部分資料未載入"}
        {activeSubagent ? " · 父 agent 等待子 agent 回報" : ""}
      </summary>
      {tool.name === "subagent" && (
        <p>
          {[
            tool.mode && `mode: ${tool.mode}`,
            tool.agent && `agent: ${tool.agent}`,
            tool.cwd && `cwd: ${tool.cwd}`,
            tool.model && `model: ${tool.model}`,
          ]
            .filter(Boolean)
            .join(" · ") ||
            (activeSubagent
              ? "等待 extension 回報子 agent 資料"
              : "子 agent 資料不可用")}
        </p>
      )}
      {tool.children && (
        <section aria-label="子 agent timeline">
          {tool.children.map((child) => (
            <div key={child.index}>
              <b>
                {child.agent || `Child ${child.index + 1}`} ·{" "}
                {child.status === "failed"
                  ? "失敗"
                  : child.status === "completed"
                    ? "程序結束／任務結果見訊息"
                    : "執行中／結果未確認"}
                {child.model ? ` · ${child.model}` : ""}
              </b>
              {child.messages.map((message, index) => (
                <div key={index}>
                  <small>
                    {message.role === "assistant"
                      ? "Assistant"
                      : message.role === "toolCall"
                        ? `工具呼叫${message.toolName ? ` · ${message.toolName}` : ""}`
                        : `工具結果${message.isError ? " · 失敗" : ""}`}
                  </small>
                  {message.role === "toolCall" ? (
                    <pre>{message.text}</pre>
                  ) : (
                    <Message>{message.text}</Message>
                  )}
                </div>
              ))}
              {child.truncated && <small>子訊息僅顯示最近 12 筆</small>}
            </div>
          ))}
          {tool.childrenTruncated && <small>子項目僅顯示前 8 個</small>}
        </section>
      )}
      <details>
        <summary>輸入</summary>
        <pre>{tool.args || "（無可顯示參數）"}</pre>
      </details>
      {tool.output && (
        <details>
          <summary>輸出</summary>
          <pre>{tool.output}</pre>
        </details>
      )}
      {tool.status === "completed" && (
        <small>工具呼叫完成，不代表整體任務成功。</small>
      )}
    </details>
  );
}
