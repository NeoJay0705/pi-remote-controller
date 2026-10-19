# Session Access v1：免交接 Web／TUI 接續與原生 JSONL 按頁讀取

公開版本已將主機位址與個人路徑匿名化；下列歷史驗證結果不因此改變。

狀態：**大型 session 400 相容性修正版已部署；部署檢查通過；實際個人大 session 載入效果仍待 Owner 確認。真 Pi/TUI/模型完整端到端未驗證。**本文件保留本期需求，並記錄目前部署與驗證邊界。當前固定 release 為 `session-access-v1-history-fix-140`，正式 URL 為 `http://TAILNET_IP:4317`。設計見[設計文件](session-access-v1-design.md)，驗收見[驗收文件](session-access-v1-verification.md)。

大型 session 400 相容性修正已實作；隔離 23 files／140 tests、16 browser cases 通過。修正版已部署；此次部署前的 130／14 基準保留為前一部署歷史。尚未在 Owner 個人檔案確認觸發點或載入效果。

## 範圍與追蹤方式

共同識別前綴：`session-access-v1-`。下列需求涵蓋免手動交接接續，以及原生 JSONL 唯讀按頁歷史。對應驗收案例列於驗收文件。未列出的既有需求不因此改變。

## session-access-v1-R1：免交接的 Web／原生 Pi 接續

- 標準流程不依賴 owner 切換按鈕或受管理 TUI 入口。使用者可在同台主機以同一份原生 session 檔，在 Web 與原生 Pi 間接續工作。
- 清楚區分原生 Pi session ID 與 Controller App ID。提供可複製的 `pi --session` 命令，且命令含正確 cwd 與必要的 session-dir 參數。
- 跨機使用須透過 SSH 或其他方式存取同一份檔案。本需求不承諾跨機同步。
- 使用者須自行避免 Web 與原生 Pi 同時寫入。不宣稱可偵測未受管理 TUI 是否 idle，也不提供其 kernel 單 writer 保證。
- 工作完成須包括無 queue、無背景工作。正常退出 Pi 是最明確的完成方式。重用舊 TUI 前也須重新載入 session。
- 點選 session、重新整理或重連，只恢復最新原生 history 與 snapshot。這些動作不得因此中斷、重啟或強制 reload 忙碌 RPC。
- 接續 prompt 前，server 必須在同一 session 序列內依序執行檔案變動檢查、必要 reload、結果確認，再送出 prompt。不得只更新畫面而沿用舊模型上下文。
- RPC streaming、compacting、tool、retry、queue、dialog 或狀態未知時，不得強制 reload。若檔案有外部變動且 session 忙碌，須顯示衝突並擋新接續；不得強制 abort。
- Idle 時可用 `switch_session` 重載同一 canonical file。須驗證 `cancelled=false`，以及 identity、file、thinking、model/profile、branch、entries 與預期同步。Hook 取消、failure、timeout 或結果未知時，須擋 prompt；不得 silent fallback。
- 保留 operation ID 與 no replay。保留 draft，以及 generation、revision、runtime epoch 等 late-event 防護。
- 更新 metadata 只是變動信號，不是對未受管理 writer 的鎖，不宣稱 race-free。不得任意移除既有 flock 對 Controller 受管理 writer 的保護、close/join 規則或永久 lock 不刪規則。
- `desiredOwner=tui` 既有資料的相容方式列為實作前遷移檢查點。本需求不授權改 DB、刪 lock 或直接解除 blocked。

## session-access-v1-R2：原生 JSONL 是唯一歷史來源，並以有界工作分頁

- 對話歷史唯一來源是原生 JSONL。不另存對話副本、不改寫原生檔、不建立持久歷史索引檔或 SQLite 索引表。既有 project/session 登記、operations 與 receipts 可保留。
- 分頁游標與單次有界暫存不是持久索引。不得保留全檔長期 memory cache。Reader 使用 HMAC 簽署 cursor 與受簽 scan state；檔案 identity、預期 native ID 與內部 guard 用於拒絕失效／不符狀態。
- 列表與加入操作只讀 header 及必要 metadata，不要求載入整份 history。移除 32 MiB 等固定整檔大小拒絕；合法大檔不得默默隱藏。
- 權限錯誤、路徑越界、不支援格式與損壞檔案須安全顯示原因，不洩漏 raw history 或 stack。已管理 session 仍須排除。
- 後端須真正分頁：由檔尾分塊讀取完整 JSONL lines，並沿 parentId 找目前分支，不得以最後 N 行代替。須處理 compaction/context 相關 entry，並遵守既有 render 契約。
- 游標須驗證 file identity、offset、entry 與 branch。Append 時有效游標可續讀；replace、truncate 或 branch 變更令游標失效時，須明示重新載入。不完整尾行暫時忽略，待下次讀取。
- 無索引時最差情況可能掃描全檔；分塊資料用完即丟。不得整檔 `readFile`／`JSON.parse` 後再 `slice`。
- 每次讀取須限制工作量、memory、時間與 response bytes。實作 preflight 上限為 256 MiB／30 秒，body scan options 的 `maxReadBytes`／`maxMs` 預設也是 256 MiB／30 秒；這些限制不是整檔 size 上限。Parser retained bytes 上限 256 KiB，response 上限 1 MiB，tool preview 為 2–64 KiB。大型單筆 tool 輸出須安全投影、預覽、明示截斷，並可按需展開；不得因此使整份合法 session 無法加入。
- 超出工作預算須明示未完成並提供續讀或重試方式，不得偽裝成空 history。解除參照後可供 GC；不承諾 RSS 立即下降。
- Controller reader 改善不表示原生 Pi 自身改為分頁，也不保證任何大小的 history 都能載入模型 runtime。

## 驗收範圍

驗收須涵蓋完整 Web → 原生 Pi → Web 接續，且模型上下文看見本機新增訊息；原生 ID 與命令正確；忙碌時不 reload、無 prompt replay，以及 switch/reconnect 多視窗競態；取消、timeout、identity 或 profile 不符時擋送出。

歷史驗收須涵蓋至少 110 MiB 合成 JSONL 的列出、加入與翻頁，並量測 memory 有界；多分支、compaction、Unicode、CRLF、不完整尾行、append、truncate、replace、過大單筆 entry 與錯誤可見性。唯讀列出／加入／分頁階段須確認原檔 hash 不變，且沒有新增持久索引或歷史副本。

目前已部署的 release 為 `session-access-v1-history-fix-140`，正式 URL 為 `http://TAILNET_IP:4317`。部署檢查通過。實際個人大 session 載入效果仍待 Owner 確認；真 Pi/TUI/模型完整端到端與個人 session 驗收尚未驗證，且須另行授權。本次文件歸檔不讀取或修改個人 session，也不執行該驗收。
