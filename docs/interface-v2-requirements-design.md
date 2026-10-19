# Interface v2 增量需求與設計

公開版本已將主機位址與個人路徑匿名化；下列歷史驗證結果不因此改變。

狀態：Project root 選擇與 Compact 拒絕狀態修正已部署。本文只歸檔 Interface v2 增量，不取代 `docs/workspace-v1-requirements.md` 或 `docs/workspace-v1-design.md`。本輪隔離結果為 97 tests／20 files、12 browser cases 通過；83 tests／18 files、10 cases 是前一階段保留的歷史結果。限定 `user-development` 真模型修復是先前成功情境，不代表本輪重跑模型或所有 extensions 全相容。證據與限制見 [workspace-v1 驗證紀錄](workspace-v1-verification.md)。

## UX01：Project 與 session 目錄

- Project 選擇不是固定綁定單一 Project。部署設定為 `projectDiscovery.root=/home/<user>/repos`、`sessionRoot=/home/<user>/.pi/agent/sessions`。
- Discovery 只列 root 的直接子目錄，且只列非 hidden、非 symlink 目錄；不要求 Git repository，也不遞迴搜尋。每次 `GET /api/v1/projects` 重新掃描，重新整理即可看到新 repo。Project ID 是由 repo 路徑產生的穩定 SHA ID。
- 靜態驗收 workspace 仍置頂，保留其 3 個既有 sessions；workspace 不是唯一可用 Project。既有靜態 `projects` 設定仍支援，也可設空陣列並搭配通用 `projectDiscovery` JSON。
- Pi 以 cwd 編碼的子目錄保存 sessions。Controller 不掃描個人 HOME，不搬移既有 history。GET 不建立 session 目錄；只有 UI 新建 session 的 POST 才以 `0700` 建立目錄。
- 需要 settings/CLI override `sessionDir` 時，須為該 Project 個別靜態配置；Discovery 不讀取個人 settings。加入既有 session 只登記原檔，不搬移或轉換。
- 狀態：已部署。勿再將工作描述為等待 Owner 指定單一正式 cwd。

## UX02：加入既有 session

- 將「匯入原生 session」改稱「加入既有 Pi session」。按鈕文案為「加入選取的 session」。
- `native-sessions` API 排除 Ledger 已管理的 `nativeFile`。Client 也依已管理的 `nativeId` 與 project 排除剛加入的項目，並 refresh。
- 清單為空時明示「沒有尚未加入的 session」。
- 保留後端 duplicate 拒絕、安全路徑與 cwd 驗證。
- 此操作不是 upload、copy，也不接管活著的 TUI。
- 狀態：已實作，離線 browser/API 驗收通過。只列尚未加入項目；只登記原檔，不搬移或轉換。

## UX03：原生歷史與問答關聯

- 原生 JSONL 歷史仍是 SSOT。
- 依 native user entry 分組形成問答區。Assistant `toolCall` 依 `toolCallId` 與 `toolResult` 配對。工具卡留在發起它的 assistant/request 下，不顯示 session-global 累加的「工具活動(n)」。
- 同一個 `toolResult` 不重複顯示。若分頁缺少 call，保留結果並標示歷史不完整的 orphan；不得依 prompt 文字或最近問答猜配。
- SSE 中尚未同步到原生歷史的 call 暫列「本次請求同步中」，不放到舊問答下。History 有相符 callID 後移至正確問答區並去重。
- 新 agent run 清理上一 run 暫存。切 session、logout、branch、reconnect 沿用既有 generation guard，並以 fresh history 為權威。不重送 prompt。
- 狀態：已實作並離線通過。branch、late event 與 budget 情境由 unit tests 覆蓋；跨 session、reload、reconnect 由真 browser + fake Pi 覆蓋。

## UX04：工具與 subagent 卡片

- 工具卡顯示工具名、意圖摘要，以及「執行中」、「呼叫完成」、「失敗」或「狀態待同步」。輸入與輸出可折疊。Tool 呼叫完成不代表整體任務成功。
- Subagent 顯示 mode、agent、cwd、model，以及「執行中，父agent等待子agent回報」。
- `tool_execution_update.partialResult.details.results` 是累積 snapshot。以 callID + child index 替換，不 append 重複項目。
- 安全顯示 child assistant 文字、tool call 名稱／參數摘要及 toolResult 文字更新。父層與子層明確分開。
- 原 extension 通常在 `child message_end` 更新。不承諾逐 token 更新，也不自行輪詢製造假進度。沒有更新時保留等待標示。
- 未知 extension 降級為通用安全工具卡。Thinking、system prompt、簽章及 child raw stderr 不 render。
- Child 結果 exit 0 不能證明任務成功。執行中不得因 `exitCode` 預設為 0 而顯示完成。
- 狀態：已實作並離線通過。真 subagent 手機 viewport 僅 synthetic；限定 live repair 是 desktop loopback。

## UX05：限定 workspace 的 live 測試

- 限定 workspace live 情境：讓 agent 自行修正可恢復的命令錯誤，並持續到自然結束。
- Controller 不因單一 tool `isError=true` 就設為 blocked。RPC、lease、storage、unknown unsafe 仍依原安全規則 block。
- 同一 UI prompt 最多一次。內部最多 3 次 single implementation-worker 分工；worker 使用 user、absolute cwd 與角色 model，並可修正。子工作者最多 5 輪局部修正與測試。
- 不換 model 或 thinking，不擴權，不無限重試。不得重送原 UI 操作。
- 正常 `agent_settled` 後分別判定成功、失敗或未完成。不因等待成功 marker 而無限 poll 已結束的失敗工作。
- 真模型狀態：限定 live repair 情境成功，自然 settled；不是通用 repair 保證。保留 child 初始預期 ENOENT 及一次讀取路徑誤植後修正成功的證據限制。

## UX06：全站淺色介面與可讀性

- 全站採乳白底、黑字及 CSS variables。背景 `#faf7f0`，主要文字 `#191919`。
- User、assistant、tool 卡以深色角色標籤及不同淺底／邊框區分。
- Code、controls、sidebar、login、dialog 全部採一致淺色，不只修改 chat。
- 工具狀態提供文字，不只依賴顏色。Focus 清楚可見。文字對比符合 WCAG AA。
- Mobile 長行只在卡片內捲動，不造成整頁 overflow。
- 狀態：已實作並離線 browser 驗收通過。

## UX07：既有安全性與有界會話視圖

- 不退化現有 Owner auth、Origin、Markdown 安全、queue-stop、draft、UNKNOWN/no-replay、lease、branch history 與 paging。
- 會話視圖有界：最多 80 個 live calls；單一 tool preview 最多 16 Ki chars；全部 live 文字預算最多 256 Ki chars。
- 子 timeline 最多 8 個 children，每個 child 最近 12 筆。超限時明示截斷。
- 完整 history 仍保存在原生資料，並按頁讀取。
- 只投影已知欄位。不 dump 任意 `details` 物件或私有思考。
- 狀態：已實作並離線回歸通過。

## 實作檔案候選

候選為 `src/web/conversation.ts`、`src/web/Conversation.tsx`、`src/web/ToolCard.tsx`、`src/web/main.tsx`、`src/web/ui.module.css`、`src/web/style.css` 及 `src/server/app.ts`。這是候選清單，不承諾每個檔案都新增或修改。

## 測試矩陣（實測狀態）

| 範圍           | 實測結果與限制                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 問答與工具關聯 | branch、late event、budget 由 unit tests 覆蓋；跨 session、reload、reconnect 由真 browser + fake Pi 覆蓋。83 tests／18 files 通過。 |
| Subagent       | 離線 start/progress/error/repair/end 等合成情境通過；真 subagent 手機 viewport 僅 synthetic。限定真 live 是 desktop loopback。      |
| 加入 session   | Join API/UI 排除已管理項目通過離線驗收。                                                                                            |
| 淺色 UI        | desktop/mobile browser cases 通過；10 cases 全通過。                                                                                |
| 回歸           | 本輪隔離結果為 97 tests／20 files、12 browser cases；83 tests／18 files、10 cases 是前一階段歷史結果。                              |
| Live repair    | 限定 `user-development` 情境成功並自然 settled；不是通用 extension/repair 保證。                                                    |

## UX08：Compact 拒絕後的安全復原

- 明確收到 Compact RPC 拒絕後，只在確認原 session `get_state` 為 idle、非 compacting、`pending` 為 0，且 queues/dialogs 均為 0、狀態非 failure/blocked 時，才將 runtime 恢復為 idle。
- 此拒絕以 HTTP 409 `compact_rejected` 回應，並顯示中文訊息。拒絕文字不直接洩漏到 UI。
- Timeout 或 state 未知時仍回 HTTP 503 `UNKNOWN`，保持 blocked 並保留 lease；不得把不確定狀態當成 idle。
- 六個 synthetic integration scenarios 覆蓋 too-small／Already compacted 訊息不洩漏、replay ID 不重做 Compact、後續 prompt 可用，以及 busy／state failure／timeout 保留 lease。
- 狀態：已部署並通過合成整合驗收。本輪未執行真 Compact 或 provider 新 prompt，不宣稱真 Compact 成功。

## 流程

```text
native entries -> group requests -> pair callId/result -> merge sanitized live snapshot -> role/tool cards
SSE unknown ownership -> provisional card -> native history confirmed -> exact group
```

Compact RPC 明確拒絕後的安全狀態復原已實作並部署，見 UX08。此處記錄 synthetic 驗收，不代表本輪執行真 Compact 或 provider prompt。
