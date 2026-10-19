import React from "react";
import type { HistoryEntry } from "./api.js";
import { projectConversation } from "./conversation.js";
import { Message } from "./Message.js";
import { ToolCard } from "./ToolCard.js";

export function Conversation({
  entries,
  live = [],
  partial = "",
  omitted = 0,
}: {
  entries: HistoryEntry[];
  live?: import("./conversation.js").ToolView[];
  partial?: string;
  omitted?: number;
}) {
  const items = projectConversation(entries, live),
    groups = new Map<string, typeof items>();
  for (const item of items)
    groups.set(item.requestId, [...(groups.get(item.requestId) ?? []), item]);
  if (partial && !groups.has("live-sync"))
    groups.set("live-sync", [
      {
        id: "live-partial",
        requestId: "live-sync",
        role: "other",
        text: "",
        tools: [],
      },
    ]);
  return (
    <>
      {omitted > 0 && (
        <p role="status">即時工具資訊已省略 {omitted} 項（超過顯示預算）。</p>
      )}
      {[...groups].map(([requestId, messages]) => (
        <section
          className="request-group"
          data-request-id={requestId}
          key={requestId}
        >
          {messages.map((item) => (
            <article
              className={`conversation-entry role-${item.role}`}
              data-entry-id={item.id}
              key={item.id}
            >
              <small>
                {item.role === "user"
                  ? "你 · user"
                  : item.role === "assistant"
                    ? "Pi · assistant"
                    : item.role === "toolResult"
                      ? "工具結果 · toolResult"
                      : "歷史資訊"}
                {item.incomplete ? " · 歷史不完整（找不到對應工具呼叫）" : ""}
              </small>
              {item.text && (
                <Message truncated={!!item.truncated}>{item.text}</Message>
              )}
              {!item.text && item.truncated && (
                <small role="status">
                  此歷史項目為有界預覽，部分資料未載入。
                </small>
              )}
              {item.tools.map((tool) => (
                <ToolCard
                  key={tool.id}
                  tool={tool}
                  truncated={!!tool.truncated}
                />
              ))}
            </article>
          ))}
          {requestId === "live-sync" && partial && (
            <article className="conversation-entry role-assistant">
              <small>Assistant · 本次回覆尚未同步</small>
              <Message>{partial}</Message>
            </article>
          )}
        </section>
      ))}
    </>
  );
}
