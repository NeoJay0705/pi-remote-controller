# Service restart operation

- 使用者授權重啟，且操作者確認沒有需要保留的進行中工作後，執行 `npm run service:restart`。
- 命令固定正常停止 `.test-artifacts/live-instance`，在 repository 原地建置，再啟動同一 instance。建置期間服務停止；建置失敗時服務保持停止。
- 腳本失敗時停止並回報階段與錯誤；不重試、rollback、force kill 或繞過保護。
- 不掃描 session、不查 DB、不請求正式 endpoint，也不擴大成模型／browser 驗收。
- 建立／維護腳本的隔離測試不等於授權操作正式服務。

# 公開 repo 提交前檢查（強制）

AI 在每次 `git commit` / `git push` **之前**，必須自行完成下列檢查，並在回應中回報結果。未通過或未檢查，不得提交。

## 檢查項目

| # | 項目 | 說明 |
|---|------|------|
| 1 | Secrets | API key、token、密碼、私鑰（`*.pem`、`*.key`）、`.env`、cloud credentials、串流金鑰（stream key）、簽章 secret |
| 2 | 個資與環境資訊 | 本機絕對路徑（如 `/home/<user>/...`）、使用者名稱、email、內網 IP、內部主機名、內部 URL |
| 3 | 媒體與資料檔 | 私人或有版權的影片 / 音訊 / 圖片、大型二進位檔、資料庫檔、log、dump |
| 4 | 第三方內容 | 複製的程式碼、素材、字型的授權是否允許公開；新增依賴的授權是否相容 |
| 5 | `.gitignore` | 已涵蓋上述 1–3 類；新增敏感類型檔案時同步更新 |
| 6 | 設定檔 | 只提交範例（如 `.env.example`、`config.example.*`），內容為假值 |
| 7 | 文件與註解 | README、註解、測試資料、commit message 不含上述敏感資訊 |

## Git 規範

- 不得 `--no-verify`、不得 force push、不得改寫已 push 的歷史，除非使用者明確指示。
- 未經使用者要求，不主動 commit / push。
- 一個 commit 一個目的；commit message 說明「做了什麼與為什麼」，且不含敏感資訊。
