# Pi Version Gate Removal：需求

使用者決定「先不檢查 Pi 版本」，取代 workspace-v1 的 Pi 1.3.0 啟動版本限制。

- Controller 與受管理 TUI 都不再讀取 Pi package metadata 或拒絕非 1.3.0 的版本，不加入環境開關或版本範圍設定。
- 保留 `loadConfig` 對 piCli 絕對路徑、realpath 與一般檔案的驗證，以及 token、網路、lease、DB、RPC／實際模型和 profile 等現有保護。
- 修正本機正式 `.test-artifacts/live-instance/local.json` 的失效 piCli：從 `/home/OWNER/.nvm/versions/node/v22.21.1/bin/pi` 改為已確認存在的 `/home/OWNER/.nvm/versions/node/v22.23.4/bin/pi`。只改此一值，其他 bytes 與權限保留。
- 此變更不表示 Pi 1.4.0 或任何其他版本已完成 RPC、模型、extensions 或 TUI 相容性驗證。
- 不安裝／降版 Pi、不修改依賴或 lockfile，不操作正式 stop/start/restart，不刪 lock、不讀正式 token/session/DB、不請求正式 endpoint。

驗收以隔離 fixture 與 mock 進行；程式碼驗證不執行 build，不使用會先編譯的 npm test/check wrapper。
