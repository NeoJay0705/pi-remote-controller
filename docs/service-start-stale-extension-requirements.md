# Service Start Stale Extension：需求

## 目標

使用者要求修復正式 `service_start_failed`，並由操作者實際啟動成功後才回報完成。只套用隔離測試結果不足以宣稱正式服務已修復。

## 已確認問題及變更範圍

正式 local.json 的 profiles[1].extensions[0] 指向舊 Node v22.21.1 安裝的 subagent/index.ts，該檔案不存在。loadConfig 會驗證所有 profiles 的 extension 路徑，故此設定必然阻止啟動；launcher 只記 startup failed，未提供細節。新 Node v22.23.4 對應 extension 是現存一般檔案。

- 只將該 extension 路徑的 Node 目錄 v22.21.1 改為 v22.23.4；不移除 extension、不改 provider/model/thinking/tools/prompts、不恢復 Pi 版本 gate。
- 其餘 local.json bytes 與權限保留，保留原 bytes 備份。
- 先核對設定中全部路徑的存在狀態；不讀目標 session、prompt 或 extension 檔案內容，不查 DB，不啟 Pi／模型，不請求正式 endpoint。
- 使用者此次明確授權正式啟動。修改核對後，在確認記錄 PID 不存在且 4317 無 listener 的已停止狀態下，執行一次 `npm run service:restart`，沿用既有 start 檢查。
- 命令失敗立即停止並回報階段及錯誤，不重試、rollback、force kill 或繞過保護。成功才記錄正式啟動完成。
