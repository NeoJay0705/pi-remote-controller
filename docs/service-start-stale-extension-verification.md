# Service Start Stale Extension：正式啟動結果

對應[需求](service-start-stale-extension-requirements.md)與[設計](service-start-stale-extension-design.md)。狀態：已修正設定並實際啟動成功。

## 原因與修正

前次只更新 piCli，遺漏 profiles[1].extensions[0] 仍指向已移除的 Node v22.21.1 安裝目錄。loadConfig 對所有 profiles 執行 extension 路徑驗證，因檔案不存在而阻止啟動。本次只將該值改為 v22.23.4 對應檔案，不移除 extension 或其他 profile 設定。

worker 已核對新路徑為一般檔案、原字串唯一、修改後 bytes 恰為單次替換，其他 JSON 值及 0600 mode 未變；父 agent 已讀取前後 bytes 獨立核對。設定中的所有路徑亦已用 stat/realpath 確認存在與預期型態，未讀目標 session/prompt/extension 內容。

## 正式操作

- 使用者明確要求由操作者實際啟動成功。操作前確認記錄 PID 不存在且 4317 無 listener；未掃 session、查 DB 或刪 lock。
- 父 agent 執行一次 `npm run service:restart`：stop 回報 already stopped → server/client build 成功 → start 成功，命令 exit code 0。未重試、rollback 或 force kill。
- start 沿用既有健康檢查並回報 `service ready`，PID `60567`、starttime `987199084`，正式 URL 為 `http://TAILNET_IP:4317`。
- 當次 PID metadata 與上述輸出一致；服務日誌新增 `2026-10-23T06:29:55.006Z startup listening`。
- 原始重啟輸出：`.test-artifacts/service-start-stale-extension/restart.log`；設定差異核對：同目錄 `config-change.txt`；修改前 bytes：`local-config.before.original-bytes`。這些為本機 Git 忽略的證據。

本結果證明當次正式 Controller 啟動成功，不代表真 Pi／模型、subagent extension、瀏覽器或 TUI 完整相容性已驗證。沒有增加額外正式 endpoint 驗收。Pi 套件版本 gate 依使用者決定保持停用。
