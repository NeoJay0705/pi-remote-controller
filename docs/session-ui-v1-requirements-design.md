# Session 情境化與手機操作修正 v1

狀態：需求與設計歸檔。驗收結果另見 [驗證紀錄](session-ui-v1-verification.md)，尚未測試的項目不代表通過。

## 使用情境與需求

使用者以手機管理多個 Session 時，可辨識目前操作對象，側欄不遮擋安全操作；session 個別錯誤留在其所屬 session，不污染切換後畫面。操作種類以明確按鈕呈現，依連線、runtime、草稿和忙碌狀態限制。長歷史與即時輸出只在聊天容器內捲動。主要狀態快速可讀，診斷資訊可折疊，session 提示不受折疊影響。

## 需求與取捨

- 手機（寬度 <=700px）側欄開啟時顯示遮罩，層級在側欄下、主畫面上。點遮罩只關閉側欄。側欄內互動不關閉；保留關閉及選 session 關閉行為。桌面無遮罩。menu 提供 aria-expanded/aria-controls。開啟時焦點移至關閉按鈕；關閉後回 menu。Escape 忽略 IME；側欄開啟時先關側欄並結束處理，不能觸發 stop。主內容 inert。建立 session 後側欄行為維持既有設計。
- 錯誤拆為全域錯誤與 session ID 索引錯誤。登入、登入逾期、project/native 清單及 create 錯誤為全域。操作、snapshot/history/SSE 錯誤歸原 session。切換不刪除錯誤，只顯示所選 session。各錯誤區塊可辨識、可關閉。logout/auth-expired 清除 session 錯誤；成功登入清除舊登入錯誤。遲到操作以提交時凍結的 session ID 歸屬錯誤。無效 view generation 的讀取沿用 guard；SSE open 同步 catch 不可改動新 view 的連線狀態。
- 保留 UNKNOWN/no replay 和 operation receipt。錯誤不觸發切 session 或重送。
- 移除操作模式選單及通用送出。提供名稱精確為 Prompt、Steering、Follow-up 的按鈕，分別送 prompt、steer、follow_up。共用純 eligibility 函式，UI disabled 與 submit guard 一致。Prompt 僅 idle/released；其他兩種僅 running。全部需要非空 trim 草稿、連線、navigator.onLine、非 busy、有有效 snapshot。starting/blocked/stopping/releasing 等狀態禁用。Ctrl/Cmd+Enter 僅送 prompt；IME guard 保留。compact/stop/ui_response 規則及 session 草稿保留。
- 捲動限定 chat 容器。開 session 歷史 render 後置底；送出三種文字操作時置底並恢復跟隨。原在底時，歷史、partial、工具及 resize 更新持續置底。使用者向上捲停止跟隨；可回到最新。載入舊歷史以 scrollHeight/scrollTop 錨點保持視窗，不拉到底。切 session 清除舊錨點及 observer。不得輪詢或無界保存資料。
- 常駐狀態只顯示 Runtime/Provider/Model/Thinking；頁首保留 native ID/App ID。cwd、session dir、nativeCommand、Outcome 與並行寫入安全警告移至預設收合「Session 資訊」。複製操作與 generation guard 保留。lastError 與 extension notices 位於獨立 session 提示區，不被 details 隱藏。保留 blocked 警告。

## 錯誤處理

失敗訊息依來源分流，不因切換而清除其他 session 訊息。初始匿名 `me` probe 的 401 只表示目前未登入，不顯示「登入已逾期」。已登入狀態下的 API 401 仍使登入全域逾期並清除 session 錯誤。操作失敗仍以原 operation receipt 查詢未知結果；不得自動重送。失效 generation 的異步結果丟棄。

## 不做項目

不修改 backend、後端 HTTP API contract、runtime 安全規則或套件。前端 API wrapper 可接受通知選項，用來區分匿名 `me` probe 與登入後 401；這不改變後端 HTTP contract。不做真 Pi、provider、實機手機測試。不改建立 session 後側欄是否關閉。不做輪詢、不擴大捲動容器，也不更新 snapshots。

## 測試矩陣

| 面向          | 合成驗收                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 手機/桌面側欄 | 遮罩命中、內部點擊、Escape 不 stop、桌面無遮罩                                                                                       |
| 錯誤隔離      | A 錯誤在 B 隱藏、回 A 可關；延遲 A 操作失敗不污染 B；auth-expired 全域                                                               |
| 操作權限      | idle/released/running/offline/busy/blocked/stopping/releasing/空白 draft 矩陣；kind 正確；disabled 無請求；running 快捷鍵不送 prompt |
| 捲動          | 長歷史初始/送出/stream 跟隨、向上閱讀不跳、loadOlder 保持錨點                                                                        |
| 回歸          | 安全、queue stop、draft、receipt、history paging、copy fallback                                                                      |
| 未執行        | 真 Pi/provider、實機觸控/鍵盤/螢幕閱讀器體驗                                                                                         |

## ASCII 流程

```text
menu -> focus close -> [mobile overlay + inert main] -> close/Escape -> focus menu
session A operation -> freeze A id -> error[A] -> select B (show only error[B])
 draft + connectivity + runtime + busy + snapshot -> eligibility -> explicit kind -> receipt
chat scroll: pinned -> updates follow bottom; user scroll-up -> unpinned; loadOlder -> anchor restore
常駐 Runtime/Provider/Model/Thinking | Session 提示 | [Session 資訊: cwd/dir/command/outcome/safety]
```
