# Service Stop Stale PID：設計

對應 [需求](service-stop-stale-pid-requirements.md)。本設計更新 service-restart-v1「沿用 instance/stop.mjs」的決定，其他流程不變。

## 實作

- 新增 tracked `scripts/service-stop.mjs`。shell 的 stop 階段改用此腳本；舊 ignored instance/stop.mjs 不修改、不再由 restart 使用。build/start 不變。
- 腳本從自身位置取得 repo root，固定讀取 `.test-artifacts/live-instance/service.pid.json`，固定 TCP port 4317。入口與可測試的停止函式分離，不提供正式 CLI instance/force 等選項。
- 停止函式可注入少量 IO 相依：讀檔、listener 查詢、signal、時間及等待，供 unit test 隔離使用。正式依賴是 fs、`ss -H -ltn sport = :4317`、process.kill、Date.now 與 timer。
- metadata 必須包含大於 1 的安全整數 PID，以及正整數字串 starttime。無效則 fail closed。
- 以 Linux `/proc/<pid>/stat` 最後一個右括號後的第 20 個欄位取得 starttime；只有 ENOENT/ESRCH 代表不存在，其他錯誤傳出；格式不完整中止。
- 初始不存在：檢查 listener，沒有則成功並回報 already stopped，有則拒絕。初始存在但身分不符：拒絕且不 signal。
- 身分符合才 SIGTERM。沿用 30 秒期限與 300ms 等待；每次檢查記錄的程序身分已消失且 port 關閉才成功。失敗不重試、不清 metadata、不強制終止。
- 輸出不含設定、token 或 session。異常使 stop 階段非零退出。

## 驗證

worker 直接執行 `node node_modules/vitest/vitest.mjs run test/unit/service-stop.test.ts test/unit/service-restart.test.ts` 與修改檔案的 ESLint/Prettier 檢查，不執行 `npm test`（wrapper 會先編譯 server）、不 build/dist、不執行正式 stop/start/restart。以注入 IO 驗證 PID 不存在＋port 關閉成功、不存在＋占用拒絕、PID 重用拒絕、正常 SIGTERM 成功、timeout、讀取/ss 錯誤與無效 metadata。錯誤路徑需斷言不 signal。既有 shell fixture 更新為新 stop 位置，保留順序與失敗中止測試，並加入真停止入口搭配隔離 PID 檔與假的 ss 命令，驗證 stale PID 可接續 fixture build/start，以及 occupied port 不可接續。

所有測試限隔離 fixture，不接觸正式 PID/port。父 agent 讀取實作、測試及證據後獨立 review。正式重啟須另確認沒有需要保留的工作。
