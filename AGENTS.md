# Service restart operation

- 使用者授權重啟，且操作者確認沒有需要保留的進行中工作後，執行 `npm run service:restart`。
- 命令固定正常停止 `.test-artifacts/live-instance`，在 repository 原地建置，再啟動同一 instance。建置期間服務停止；建置失敗時服務保持停止。
- 腳本失敗時停止並回報階段與錯誤；不重試、rollback、force kill 或繞過保護。
- 不掃描 session、不查 DB、不請求正式 endpoint，也不擴大成模型／browser 驗收。
- 建立／維護腳本的隔離測試不等於授權操作正式服務。
