# Pi Install Resolution：移除安裝路徑版本綁定

狀態：需求已實作並完成隔離驗證；使用者另行確認可中斷工作並授權後，正式設定已遷移且重啟成功。使用者選擇「隨啟動環境」。操作證據見[驗證紀錄](pi-install-resolution-verification.md)。

## 目標與範圍

移除正式設定內 Pi CLI 與 subagent extension 對具體 NVM／Node 版本目錄的綁定，而非再次把舊版本號替換為新版本號。涵蓋 `local.json` 的 `piCli`、`profiles[1].extensions[0]`，以及 Controller／受管理 TUI 對這些設定的使用方式。

## 已確認行為

- 採用跟隨啟動環境的設定模式：每次 Controller 或受管理 TUI 載入設定時，依該程序的 PATH 選取 `pi`；不讀 shell alias/function、不執行 shell、不掃描其他 NVM 安裝、不改主機 PATH。
- CLI 與隨套件提供的 subagent extension 必須來自同一個選定的 Pi 安裝，不混用不同安裝的檔案。PATH 中有多份 Pi 時按順序選取第一個可執行的一般檔案；選中後缺少 extension 不改用後面的 Pi。
- 同一次設定載入解析為具體 canonical 路徑並固定使用；已運作的 Controller/runtime 不因 PATH 或安裝位置變動而熱切換。更新後在下一次啟動採用當時環境；操作者須保留仍在使用的安裝檔案。
- 保留既有明確指定 CLI／extension 絕對路徑的設定用法，不把其他任意相對路徑解讀為 PATH 命令。
- 缺少 Pi 或必要 extension 時明確失敗，不靜默移除 extension、不換模型或降低設定。保留原本 profile、token、網路、lease、session 格式、DB schema、RPC 等其他驗證。
- 保持不檢查 Pi 套件版本；可以讀取 package 名稱來識別所選安裝的根目錄，但不依 version 欄位接受或拒絕。此點補充前次「不讀 package metadata」描述，並非恢復版本 gate。
- PATH 與正式設定是受信任的主機端輸入。Pi 安裝移動後不需在設定內逐一改 NVM 版本字串；但啟動環境須實際提供正確的 Pi。
- 本需求不移除歷史文件、測試 fixture 或 npm lockfile 的正常版本號，也不代表所有 Pi 版本相容。

前次[版本 gate 移除](pi-version-gate-removal-requirements.md)及[失效 extension 修正](service-start-stale-extension-requirements.md)是已完成的局部修復。本需求另行處理其尚未消除的安裝路徑耦合。

## 驗收與切換限制

- 用隔離的兩套 Pi 安裝改變 PATH 順序或移除舊安裝；不改版本路徑設定，即可解析新 CLI 與同套 extension。
- 驗證 symlink、PATH 順序、缺少 Pi／extension、套件身分錯誤、路徑越界、既有絕對路徑用法，以及 Controller／CLI 皆採用解析後設定。
- 不執行真 Pi、模型、browser、正式 endpoint 或讀正式 session/DB/token；隔離驗證不重寫運作中服務的 dist，不使用會編譯的 npm test/check wrapper。
- 程式與隔離驗證完成後，正式設定的兩個舊路徑須在另獲授權的停止／建置／啟動切換中一起遷移。此前保留現行正式設定，避免舊 dist CLI 無法理解新設定。不得將尚未切換描述成已部署。
