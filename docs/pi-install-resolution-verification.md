# Pi Install Resolution：隔離驗證與正式切換紀錄

對應[需求](pi-install-resolution-requirements.md)與[設計](pi-install-resolution-design.md)。狀態：來源碼與隔離驗證完成，父 agent 已獨立核對；使用者另行授權後，正式設定已遷移且重啟成功。

## 已實作

- `src/server/pi-install.ts` 實作 PATH 選取、實際 CLI 所屬 package root 識別及 package-relative extension 解析。
- `loadConfig` 支援 `piCli: "pi"` 與 `pi:examples/extensions/subagent/index.ts`，回傳 canonical 絕對路徑；相同載入共用 lazy root Promise，不跨載入快取，不檢查 package version。
- 既有絕對路徑仍相容；任意相對 CLI/extension 仍拒絕。必要 extension 缺少、metadata 身分不符或越界都明確失敗，不改選另一套 Pi。
- 更新範例、README 及 workspace 現行設計。沒有修改正式 instance、RPC/runtime、啟停腳本、依賴或 lockfile。

## 核對的驗收情境

- 同一 config bytes 下切換 PATH A:B/B:A，CLI 與 extension 都選取同套安裝。刪除前方 A 後，dangling A 被略過而選 B；先前已回傳的 config 保持 A。
- PATH 前方的 directory/non-executable 候選被略過；未設定 PATH 或無可用候選會失敗。空 PATH 項與相對 PATH 項均以 cwd 解析。
- package name 正確但 version 任意或缺失仍接受；完全沒有 package.json 的絕對 CLI/extension 也可用。
- 必要 extension 缺少不切到另一安裝；空引用、相對／絕對 suffix、NUL、反斜線、dot segment、directory 及 symlink escape 均拒絕。
- Controller startup 與來源 CLI 測試確實使用 `piCli: "pi"`，核對解析後 config 及 child argv 的 CLI/extension。app/runtime/store/lease/child 均為 mock，CLI 等到 close 與清理完成且 signal listeners 回復。foundation 使用臨時合成 DB，不碰正式資料。

## 最終驗證

implementation-worker 執行以下命令，均 exit code 0：

1. `node node_modules/vitest/vitest.mjs run test/unit/pi-install-resolution.test.ts test/unit/pi-version-policy.test.ts test/unit/network.test.ts test/unit/foundation.test.ts`：4 個檔案、54 項通過。
2. `node node_modules/eslint/bin/eslint.js src test scripts`。
3. `node node_modules/prettier/bin/prettier.cjs --check src/server/pi-install.ts src/server/config.ts test/unit/pi-install-resolution.test.ts test/unit/pi-version-policy.test.ts config/example.json README.md docs/workspace-v1-design.md`。
4. `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.server.json`。

證據：`.test-artifacts/pi-install-resolution/verified-results.txt` 與 `verified-{vitest,eslint,prettier,tsc}.log`。舊的 `final-vitest.log` 是中途 fixture 把 extension alias 誤當 PATH 值的失敗紀錄；已更正測試並重跑，沒有為使錯誤 fixture 通過而放寬 production 行為。

## 隔離階段界線

上述隔離驗證期間未執行 build/npm test/check 或正式 restart，沒有請求正式 endpoint、啟動真 Pi／模型或讀取正式 token/session/DB。當時保留既有正式設定，避免舊 dist CLI 讀不懂新格式。真 Pi/extension 相容性未驗證。

## 正式切換結果

使用者回覆「允許」，同意在沒有需要保留的進行中工作下遷移設定並重啟。此操作與先前隔離測試分開記錄：

- worker 備份正式 local.json 原 bytes（0600），只將 piCli 改為 `pi`、profiles[1].extensions[0] 改為 `pi:examples/extensions/subagent/index.ts`。其他 bytes／JSON 值與設定 mode 不變，父 agent 已讀取前後 bytes 獨立核對。
- worker 只呼叫來源 resolver 做受控解析：CLI、package root 與 extension 均屬當前 PATH 選取的同套安裝；不執行 Pi、不檢查 version、不讀正式 token/session/DB。
- 父 agent 執行一次 `npm run service:restart`，exit code 0：正常 stop 成功 → server/client build 成功 → start 回報 service ready，既有啟動健康檢查通過。沒有重試、rollback、force kill 或新增正式 endpoint 驗收。
- 新 PID `36294`、starttime `987730272`；當次 service.pid.json 一致。正式 URL 為 `http://TAILNET_IP:4317`。服務日誌依序新增 `2026-10-23T07:58:22.630Z shutdown SIGTERM` 與 `2026-10-23T07:58:26.870Z startup listening`。
- 證據目錄：`.test-artifacts/pi-install-resolution/deployment/20261023075651570-c580d7d6e842/`，包含 `local-config.before.original-bytes`、`verification.json` 與 `restart.log`。這些是本機 Git 忽略的產物。

正式 Controller 已採用 PATH 解析模式。此結果不等於真 Pi RPC、模型、subagent extension 或受管理 TUI 的完整端到端相容性驗證。
