# Service Start Stale Extension：設計

對應[需求](service-start-stale-extension-requirements.md)。

1. implementation-worker 只改 `.test-artifacts/live-instance/local.json` 的唯一舊 extension 路徑字串：`/home/OWNER/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts` 改為同路徑 v22.23.4。
2. 修改前核對 profiles[1].extensions[0] 等於舊值、舊字串在原 bytes 中唯一、新檔是一般檔案。保留原 bytes 為私有 0600 artifact，使用精準 edit，禁止全檔重寫。
3. worker 驗證 bytes 等於單次替換、其他 JSON 值未變、mode 未變，並檢查 piCli、extensions、appendSystemPrompts、projects cwd/sessionDir、dataDir 及 discovery 路徑存在和預期型態。不列目錄、不讀任何目標內容、不跑正式 loadConfig 或 startServer。
4. 父 agent 讀取差異及證據，確認範圍後執行正式 restart。此操作不是隔離測試；只使用既有 `npm run service:restart`，其 build/start 和既有健康檢查不額外擴大。不執行額外正式 endpoint 驗收。
5. 重啟結果與當次 PID/log 另行記錄；若失敗，按 AGENTS.md 停止並回報，不再重試。本次不修改 launcher 錯誤格式或建立自動路徑遷移框架。

## 維護限制

正式設定仍使用絕對路徑；NVM／Pi 安裝搬移後，piCli 與 extensions 等安裝相關路徑需一起核對更新。這次不加入 PATH fallback，不靜默移除必要 extension，也不宣稱新 Pi/extension 的完整相容性已驗證。
