# Service Restart v1：直接入口重啟

停止階段的 stale-PID 行為詳見[需求](service-stop-stale-pid-requirements.md)與[設計](service-stop-stale-pid-design.md)。

狀態：已實作，隔離流程測試與專案檢查通過；正式重啟未執行。共同前綴：`service-restart-v1`。本版取代先前 release 管理腳本方案；見[設計](service-restart-v1-design.md)。

## 需求與使用情境

本機由操作者授權重啟，接受建置期間停機及建置失敗時保持停止。目標只是把既有服務的停止、建置、啟動串成固定命令，不提供部署管理平台。

- `npm run service:restart` 固定執行：tracked `scripts/service-stop.mjs` → repository 的 npm run build → 既有 start.mjs。只有記錄 PID 不存在且 TCP 4317 無 listener 才視為已停止；前一步失敗就停止，不重試、不自動 rollback。此 stop 決定取代沿用 instance/stop.mjs 的舊決定。
- 啟動器直接匯入 repository 的 dist/server/main.js，保留既有設定、token、正常 close 與日誌機制。不再讀 active-release.json。
- 只支援既有 `.test-artifacts/live-instance`。不提供 --instance、--restart-only、force 等選項。保留基本重複執行防護及失敗階段輸出。
- 執行前由操作者確認沒有需要保留的進行中工作；重啟可能中斷工作。腳本不登入、不列 session、不查 DB、不做 browser／模型驗收。啟動結果沿用既有 start 檢查。
- 撤除前次 scripts/service-restart.mjs、專屬大型測試及 fixtures，更新 README/package.json/AGENTS 與本組需求設計。不改訊息截斷修正、產品 runtime、依賴、設定、token、資料或現存 releases。
- 本次只修改啟動器檔案，不執行正式停止／啟動。正式切換須另有使用者重啟授權。保留舊 releases/pointer，不刪除歷史部署產物。

## 驗收與限制

隔離測試只核對 stop → build → start 的順序，以及 stop/build 失敗時不執行後續步驟；同套輕量 fixture 可驗證重複操作拒絕及參數拒絕。不得使用正式服務進行測試。沿用既有 npm run check 檢查專案，不增加 browser 或 session 驗收。

切換後，任何會重寫 repository dist 的命令都必須在服務停止時執行；npm run check 也包含 build。正常維護使用 service:restart，避免另行在服務運作時建置。
