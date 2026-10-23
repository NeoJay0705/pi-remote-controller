# Pi Install Resolution：設計

對應[需求](pi-install-resolution-requirements.md)。決策已足夠開始實作；正式切換另行授權。

## 設定介面

```json
{
  "piCli": "pi",
  "profiles": [
    {
      "id": "development",
      "name": "Development",
      "extensions": ["pi:examples/extensions/subagent/index.ts"]
    }
  ]
}
```

- `piCli` 只新增精確字串 `pi` 這個模式，表示依啟動程序 PATH 選取。原本絕對檔案路徑仍用既有 canonical 驗證，非 `pi` 的相對值仍拒絕。
- extension 只新增 `pi:<package-relative-path>` 引用；絕對路徑仍照原規則。appendSystemPrompts 仍要求絕對路徑，不擴大本次範圍。
- WorkspaceConfig/Profile 對 runtime 暴露的形狀不變：piCli/extensions 都已解析為 canonical 絕對檔案路徑。Controller、RPC、受管理 TUI 繼續使用既有 argv 與 process.execPath，不重新搜尋 Pi。
- 不新增版本範圍、環境開關、fallback、registry 查詢或安裝器。

## 解析流程

新增 `src/server/pi-install.ts`，只用 Node fs/path，不執行命令：

1. `resolvePiFromPath()`：在函式開始取當時 PATH/cwd。PATH 未設定則報 `invalid_pi_cli`；有設定時按平台 delimiter 分割，空字串項視為 cwd，相對 PATH 項以啟動 cwd 解析，符合 Linux PATH 規則。依序找 `pi`，需是一般檔案且具 X_OK，symlink 以 realpath 解析。ENOENT/ENOTDIR/EACCES 的候選略過；其他 IO 錯誤以受控 `invalid_pi_cli` 中止。找到後返回 canonical 路徑，無候選則失敗；不搜尋其他目錄。
2. `findPiPackageRoot(piCli)`：從已解析 CLI 所在目錄向上至 filesystem root，找 package.json 的 name 精確等於 `@earendil-works/pi-coding-agent`。只檢查名稱，完全忽略 version。沒有 package.json 可繼續；其他讀取或解析失敗明確報既有 `pi_package_metadata_missing`，不猜測安裝結構。找不到相符名稱也報該錯誤。
3. `resolvePiPackageExtension(root, reference)`：取 `pi:` 後相對路徑，拒絕空值、NUL、反斜線、絕對路徑及空／`.`／`..` segment。不做 URL decoding。join 到 canonical root，realpath+stat 確認是一般檔案，並以 relative 確認 canonical 路徑仍位於 root 內（拒絕 symlink 逃逸）。錯誤統一報 `invalid_extension_path`，不嘗試別套 Pi。
4. config.ts：`piCli === 'pi'` 才呼叫 PATH resolver，否則維持 canonical。以該次 piCli 建立單次載入共用的 lazy package-root Promise，只有 profiles 確實使用 `pi:` 時才讀 metadata。這樣保留絕對 CLI 無 metadata 且不使用 package 引用的既有用法；多個 alias 共用同一 root 查詢，沒有跨 loadConfig 的全域 cache。非 alias extension 仍用 canonical。

## 可維護性與可靠性

- 解析每次 loadConfig 一次；PATH 搜尋成本為 PATH entries 數，root 搜尋成本為 CLI 路徑深度；不掃 filesystem tree、不碰 session 內容。
- 在 package-relative 模式中讀取 package 名稱是身分與根目錄解析，不是版本 gate。既有 safeErrorCode 可表達上述錯誤，不新增 runtime error codes。
- PATH 前方的 Pi 一旦選中，不因缺少 subagent extension 切到後方 Pi。必要 extension 缺失時仍阻止啟動。
- README 記載模式、選取規則、npm/service manager 會提供自己的啟動 PATH、非 shell alias/function，以及需重啟才重新解析。保留最低 Node 與版本相容性未驗證的說明。診斷採受控錯誤，不印 token 或任意 exception。

## 實作範圍

- 新增 src/server/pi-install.ts、test/unit/pi-install-resolution.test.ts；更新 src/server/config.ts。
- 更新 test/unit/pi-version-policy.test.ts：保留原版本 gate 移除的回歸測試，補 PATH+package extension 設定通過 Controller startup 及來源 CLI 的 sentinel 路徑，斷言解析後 CLI／extension 的實際值。不啟真 Pi/DB/listener。
- 更新 config/example.json 的 piCli 為 `pi`，development profile 的 extensions 使用上述 package-relative subagent 引用；保留 required policy 的絕對路徑 placeholder 與未驗證提示。
- 更新 README.md、docs/workspace-v1-design.md 的現行設定說明，指向本需求／設計；不改歷史驗證結果。
- 不改正式 live-instance、服務腳本、RPC/runtime/CLI 實作、其他未提交修改、依賴、lockfile 或 dist。

## 驗證

implementation-worker 建立 A/B 假 Pi 套件、可執行 CLI、bin symlink 與可區分的 extension 路徑。測試使用隔離環境，還原 PATH/cwd/mocks 並 finally 移除 fixture。

必要斷言：

- 同一份 `pi`＋`pi:...` config，PATH A:B 與 B:A 得到各自 CLI 和同套 extension；刪 A 後 PATH A:B 得到 B，不改 config bytes。
- 選中 A 但缺 extension，不可改選完整 B；缺 CLI、PATH 未設定、非 executable candidate、directory/dangling symlink 處理。
- CLI symlink 跨 bin/package 目錄仍以實際 package 為準；package 名稱不符／壞 metadata 失敗；任意 version 或缺 version 仍成功。
- 絕對 CLI/extension 仍可用，無 alias 不需 package metadata；其他相對 CLI/extension 仍拒絕。
- alias traversal／NUL／絕對 suffix／symlink escape 失敗，合法 nested 檔案成功。
- 已回傳的 config A 在後續 PATH 改 B 後仍保持 A；新一次 loadConfig 取得 B。
- Controller 與來源 CLI 確實使用解析後設定，而非僅測 helper。

直接執行指定 Vitest：`node node_modules/vitest/vitest.mjs run test/unit/pi-install-resolution.test.ts test/unit/pi-version-policy.test.ts test/unit/network.test.ts test/unit/foundation.test.ts`。另執行原設定 ESLint、修改檔案 Prettier 與 `tsc --noEmit -p tsconfig.server.json`。不要 npm test/check/build 或使用 dist 的 integration；不重寫運作中服務的 dist。

父 agent review 實作、情境觸發、斷言及證據後回報實作狀態。正式 local.json 的 piCli 與 extension 兩個值留待另外確認沒有進行中工作、獲准重啟後，備份原 bytes 並在停止／建置／啟動切換中遷移；未經授權不重啟、不預先改正式設定。
