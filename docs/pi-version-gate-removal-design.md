# Pi Version Gate Removal：設計

對應[需求](pi-version-gate-removal-requirements.md)。

## 既定實作

1. 移除 `src/server/main.ts`、`src/cli/main.ts` 的 verifyPiVersion import 與呼叫；移除 `src/server/config.ts` 不再使用的 verifyPiVersion 函式。保留所有 loadConfig 路徑及其他設定驗證。
2. README 與 workspace-v1-design 的現行版本 gate 說明改為暫不檢查 Pi 套件版本，歷史 1.3.0 契約基準保留並明確區分未驗證新版本。不得宣稱支援所有版本。
3. 新增 `test/unit/pi-version-policy.test.ts`。使用臨時合成設定與真 loadConfig；mock app/runtime/lease/store，確保不 listen、不讀正式 DB、不啟真 Pi。啟動測試用 Pi package 1.4.0 以及沒有 package metadata 的檔案，均可通過 Controller 啟動邊界並正常 close；舊 verifier 會拒絕兩者，使斷言可辨別 regression。驗證 missing/relative/directory piCli 仍失敗，以及缺 token 不取得 lease。
4. 同檔針對 CLI 用合成設定及 store mock 的 session_not_found sentinel，動態匯入來源 CLI，等待安全錯誤輸出，證明非 1.3.0 和缺 metadata 不在版本 gate 阻擋。mock 不得輸出真設定／token，不啟動 child。測試 restore 環境、argv、module mocks、signal listener 及臨時檔案，避免影響其他測試。
5. worker 直接執行 Vitest 指定本測試及既有 network/config 相關 unit。不要 npm test/check/build，不執行使用 dist CLI 的 integration。執行修改檔案 ESLint、Prettier 及 `tsc --noEmit -p tsconfig.server.json`。
6. 父 agent 完成程式與測試證據 review 後，另外派工只修改正式 local.json 的單一 piCli 字串。worker 不輸出整個設定；以 exact replacement、原內容僅此一處不同、mode 未變及新路徑 realpath 是一般檔案為驗收。不得執行 loadConfig 正式設定或 startServer 作為驗證，不做任何正式重啟。

## 完成紀錄

- Controller 與 CLI 已移除版本 verifier，保留路徑和其他啟動保護；父 agent 已獨立核對實作及隔離測試斷言。
- worker 直接執行兩個 Vitest 檔案：27 項通過；修改檔案 ESLint、Prettier、server `tsc --noEmit` 通過。證據為 `.test-artifacts/pi-version-gate-removal/{vitest-final,eslint-final,prettier-final,tsc}.log`。本次未執行 build 或 npm test/check。
- 正式 local.json 僅替換 piCli 路徑，父 agent 讀取前後 bytes 核對單次替換結果；其餘內容與 0600 權限保留。worker 記錄為同證據目錄 `local-config-change.txt`，原 bytes 備份為 `local-config.before.original-bytes`。
- 未執行正式 stop/start/restart，也沒有正式 endpoint、DB、session、token 或真 Pi 驗收。來源碼尚未建置到 dist；後續正式 restart 的 build 階段才會套用。

## 限制

這是暫停版本 gate，不是相容性驗證。未知的啟動或 RPC 失敗仍依既有安全機制回報。正式重啟仍由操作者先確認沒有需要保留的進行中工作，再按原流程授權執行。
