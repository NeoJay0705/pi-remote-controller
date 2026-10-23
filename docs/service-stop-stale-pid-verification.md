# Service Stop Stale PID：驗證紀錄

對應[需求](service-stop-stale-pid-requirements.md)及[設計](service-stop-stale-pid-design.md)。狀態：程式修正與隔離驗證完成，父 agent 已獨立核對實作、測試斷言與紀錄。正式重啟未執行、正式執行結果未驗證。

## 修改與證據範圍

- `scripts/service-restart.sh` 的 stop 改為 tracked `scripts/service-stop.mjs`。固定 instance、操作鎖、build/start 與失敗中止不變。舊 ignored instance/stop.mjs 未修改。
- PID 不存在且 port 關閉才接受 already stopped。PID 重用、port 占用、讀取或 ss 錯誤會中止；僅對身分匹配的 PID 送 SIGTERM，不送 SIGKILL、不刪 metadata。
- 測試包含 production `/proc/stat` parser 與錯誤分類、假時間 timeout、身分驗證與 signal 斷言；真 shell/stop CLI 複製到臨時目錄，使用確認不存在的 PID 和 fake ss，核對 4317 查詢參數、成功接續 fixture build/start，以及 occupied/ss failure 不接續。
- 正常 SIGTERM 以注入 IO 驗證；沒有向正式程序送 signal，也沒有完整真程序重啟驗收。

## 最終命令

以下由 implementation-worker 執行，均 exit code 0：

1. `node node_modules/vitest/vitest.mjs run test/unit/service-stop.test.ts test/unit/service-restart.test.ts`：2 個測試檔、19 項通過。
2. `node node_modules/eslint/bin/eslint.js scripts/service-stop.mjs test/unit/service-stop.test.ts test/unit/service-restart.test.ts`：原專案規則，沒有 globals 或 rule override。
3. `node node_modules/prettier/bin/prettier.cjs --check scripts/service-stop.mjs test/unit/service-stop.test.ts test/unit/service-restart.test.ts`。
4. `bash -n scripts/service-restart.sh`。
5. `node --check scripts/service-stop.mjs`。

完整命令、退出碼及輸出位於 `.test-artifacts/service-stop-stale-pid/final-results.txt` 與同目錄 `final-*.log`；這些是本機 Git 忽略的證據。

## 驗證偏離及限制

前一輪誤用 `npm test -- --run ...`。其 `scripts/test-env.mjs` wrapper 會先執行 `tsc -p tsconfig.server.json`，因此那一輪已編譯並重寫 server dist，違反原定不建置限制。發現後未 rollback，也未執行正式服務操作；最後一輪改為直接 Vitest，沒有再建置。不能將整次工作描述成未建置。

沒有執行正式 stop/start/restart、查詢正式 endpoint、讀取 token/session/DB 或做 browser／模型驗收。未執行完整 `npm run check`。操作者確認沒有需要保留的工作後，才可依既有授權流程正式重啟。
