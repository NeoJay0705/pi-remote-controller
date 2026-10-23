# Service Stop Stale PID：需求

## 目標與現況

修正 `npm run service:restart` 在服務已停止但 PID 檔仍存在時，於 stop 階段回報 `pid_identity_mismatch` 的問題。本次調查僅讀取 PID metadata、該 PID 的 `/proc` 狀態與 4317 listener；記錄的 PID 不存在且 port 無 listener。這是當時快照，不保證之後狀態。

## 行為

- 保留固定 instance、stop → build → start、操作鎖與失敗立即中止。
- 只有記錄的 PID 已不存在，且 TCP 4317 無 listener，才把 stop 視為已完成。保留 PID metadata，不刪資料。
- PID 存在但 starttime 不符，即使 port 關閉也拒絕，不送 signal；PID 不存在但 port 被占用也拒絕。
- metadata 無效、程序狀態無法可靠讀取或 listener 檢查失敗時中止。不以權限錯誤當成程序不存在。
- 正常服務仍使用身分檢查、SIGTERM、最多 30 秒等待程序退出且 port 關閉；不 force kill、不重試、不 rollback。
- 停止邏輯納入 Git，避免修正只留在被忽略的正式 instance 檔案。

## 驗收與授權界線

用隔離測試驗證上述成功與拒絕分支、無錯誤 signal，以及 stop 失敗後不 build/start。不得使用正式服務測試，不執行正式 restart、不讀 token/session/DB、不請求正式 endpoint。完整 check 包含原地 build，本次不執行；僅執行必要的隔離測試及靜態檢查。
