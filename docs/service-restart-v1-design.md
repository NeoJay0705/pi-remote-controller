# Service Restart v1：停止、原地建置、直接入口

停止階段的 stale-PID 實作與驗證依據見[專屬設計](service-stop-stale-pid-design.md)及其[需求](service-stop-stale-pid-requirements.md)。

對應[需求](service-restart-v1-requirements.md)。狀態：已實作並完成父 agent 差異核對；隔離流程測試通過，正式切換未執行。本版取代之前的多實例、獨立 release 與驗收框架。

## 既定實作

1. 刪除 scripts/service-restart.mjs、test/integration/service-restart.test.ts、test/fixtures/service-restart/，專屬 unit 測試若仍存在也刪除。只刪本功能檔案，不 git reset 或 git clean。
2. 新增數十行的 scripts/service-restart.sh，package.json 的 service:restart 改為 bash scripts/service-restart.sh。
3. shell 從 BASH_SOURCE 推導 repo root，固定 instance=<repo>/.test-artifacts/live-instance，切到 repo 執行。拒絕所有額外參數，避免舊選項被默默忽略。
4. 使用已確認存在的 Linux flock 與 instance/service-restart.lock 做非阻塞排他鎖。鎖不刪檔，由 fd 關閉自動釋放；它不是 controller/session runtime lock。啟動子命令關閉鎖 fd，避免背景服務繼承。不要新增 mkdir stale-lock 管理框架。
5. set -euo pipefail；依序 node `scripts/service-stop.mjs`、npm run build、node instance/start.mjs。此 tracked stop 實作取代舊「沿用 instance/stop.mjs」決定。簡短顯示階段；任何命令失敗就非零退出，不重試、不回復 release、不強制終止、不刪 runtime lock。沿用既有 start 的啟動檢查，不另加 HTTP 驗收。只有記錄 PID 不存在且 TCP 4317 無 listener 才接受 stale PID；PID 身分不符或 PID 不存在但 port 占用均拒絕。
6. 只修改正式 instance/launcher.mjs 的入口選擇：刪除 pointer/releaseRoot 驗證，改為 import <repo>/dist/server/main.js 後呼叫既有 startServer。保留 config/token/tmp/cache、PI_OFFLINE 清除、安全日誌與正常關閉的原有邏輯。既有 start.mjs/stop.mjs 不改。
7. 修改 launcher 前保留原 bytes 至 `.test-artifacts/service-restart-v1/direct-entry/<unique>/launcher.before.mjs`，方便核對。不能讀 token、連正式 endpoint、執行正式 start/stop，不能刪既有 releases/pointer/資料。
8. README/AGENTS 改成單一命令、操作者先確認可中斷工作、建置期間停機、建置失敗保持停止、只有授權才執行；未來不臨時增加檢查流程。不再提舊選項。README 保留一般設定與登入說明。

## 輕量測試

隔離測試以 mkdtemp 建立 fixture，複製真 shell 與 tracked `scripts/service-stop.mjs`；假的 `ss` 僅回報 fixture 設定的 port 狀態。stop CLI 的 stale PID 成功情境驗證後續 build/start 執行，port 占用情境驗證 build/start 不執行。unit 測試另注入 IO 驗證 PID/port 分支、正常 SIGTERM 與等待、timeout、metadata／proc／ss 錯誤及無效 metadata；錯誤分支斷言無 signal。流程 fixture 中的 start 與 build 僅記錄事件，不啟動服務或建置產品。

測試命令：`node node_modules/vitest/vitest.mjs run test/unit/service-stop.test.ts test/unit/service-restart.test.ts`。`npm test` 會先執行 TypeScript 編譯並寫入 `dist`，因此此處直接執行 Vitest。僅對修改檔案執行 ESLint/Prettier。不跑 browser，不建置或操作正式服務；正式 stop/start/restart 未驗證。

## 完成紀錄

- `scripts/service-restart.sh` 為34行；舊 mjs、integration 測試及專屬 fixtures 已移除。
- worker 執行隔離測試：4項通過，涵蓋正常順序、stop/build 失敗中止、額外參數及已持有操作鎖時拒絕。
- worker 執行 `npm run check`：format、lint、typecheck、33個測試檔／190項測試與build通過。父 agent 已讀取最終實作、測試斷言、launcher 前後內容及最終紀錄，核對此次修改範圍。
- 證據：`.test-artifacts/service-restart-v1/direct-entry/<run-id>/unit-test-2.log`、`check-2.log`。launcher 原bytes備份為同目錄的 `launcher.before.mjs`。證據位於 Git 忽略的本機目錄，不隨 repository 發布。
- 未執行正式stop/start/restart；目前服務沒有因這次修改切換入口。正式入口啟動效果未驗證，須待另一次使用者授權重啟。
