# Pi Remote Workspace

Pi 原生 session 的同源遠端介面。Linux 主機需使用 Node.js 22.19 以上。專案目前只接受 Pi 1.3.0 套件 metadata。安全修補包含 `@fastify/static` 10.1.6 與 matched-route API 權限判斷。真 Pi/TUI/模型完整端到端尚未驗證。本文描述軟體功能與可攜操作方式，不代表任何服務目前正在運行。

歷史測試結果只適用於當時執行的範圍。離線合成驗收曾執行 142 tests／23 files、16 個 desktop/mobile browser cases，以及 18 項 compiled-app smoke assertions；這些數字不表示所有情境通過，也不等於全面安全保證。安全部署與有限驗證歷史見[正式服務安全部署與登入 v1 驗證](docs/production-service-v1-verification.md)及[安全審查紀錄](docs/security-review.md)。真 Pi/TUI/模型、完整 thinking profile、file-hook 矩陣、實際權限與 atomic-replace 等情境尚未驗證。

## 正式部署與登入

新部署前，請由主機管理者選擇獨立的 build/release 目錄及私有設定、資料目錄。不要在正在運行的 release 內建置或覆寫檔案。此 repository 不提供通用部署 CLI。功能驗收由使用者負責。既有且符合 instance 契約的服務，只有在使用者授權，且操作者確認沒有需要保留的進行中工作後，才執行：

```bash
npm run service:restart
```

命令固定依序正常停止 `.test-artifacts/live-instance`、在 repository 原地執行 `npm run build`，再啟動同一 instance。建置期間服務停止；建置失敗時服務保持停止。失敗時停止並回報階段，不重試或 rollback。

在獨立 build 目錄安裝與建置：

```bash
npm ci --ignore-scripts
npm run build
```

準備 canonical 絕對路徑的設定檔。`PRW_CONFIG` 必須指向此設定檔。設定須提供 canonical 絕對路徑的 `piCli`、`dataDir`、project `cwd`／`sessionDir` 及 profiles。設定格式範例見 [`config/example.json`](config/example.json)。Owner 必須自行安全管理至少 32 字元的 `PRW_OWNER_TOKEN`。軟體不會自動建立或管理 token。新部署可由安全隨機生成器產生至少 32 字元的 token；不要把生產 token 硬碼在命令、設定或文件內。

使用支援的環境變數啟動。`read -s` 是 Bash 功能，可避免 token 值進入 shell history：

```bash
export PRW_CONFIG=/absolute/path/to/config.json
read -r -s -p 'Owner token: ' PRW_OWNER_TOKEN
printf '\n'
export PRW_OWNER_TOKEN
npm start
```

Owner 可從私有憑證檔讀取既有 token，例如 `cat /absolute/path/to/private/owner-token.txt`。只在私有終端讀取。不要公開檔案、貼入 URL、命令列參數、日誌或對話。由主機管理者以正常 `SIGTERM` 或 `Ctrl-C` 停止程序。背景服務需要自行設定 service manager；本 repository 不提供通用啟停管理器。

服務啟動後，在可存取該服務的瀏覽器開啟設定的 `publicOrigin`。Tailnet 綁定時，瀏覽器須具備 Tailnet 連線。在 Owner token 欄貼入同一個私有 token，按「登入」。用完按「登出」。不要把 token 附加到網址，也不要把登入 cookie 分享給他人。登入失敗時先核對服務設定與 token，不要關閉認證。

預設服務只監聽 `127.0.0.1`。正式環境建議使用 HTTPS reverse proxy，並將 `publicOrigin` 設為精確的 HTTPS origin。SSE proxy 應設定 `proxy_buffering off`，並提供足夠長的 read timeout。此專案不部署或設定 proxy、VPN 或防火牆。

可選擇只綁定主機 `tailscale0` 介面的單一 IPv4，並明確設定 `listenHost` 與 `allowTailnetHttp: true`。以下位址是範例值，不保證屬於你的介面：

```json
{
  "listenHost": "100.64.12.34",
  "allowTailnetHttp": true,
  "port": 4317,
  "publicOrigin": "http://100.64.12.34:4317"
}
```

先確認介面存在，且設定的位址正由該介面持有。功能只綁定該單一 IP，不會自動探索或追蹤位址變更，也不會修改 VPN／防火牆或公開 Internet。Tailscale HTTP 不等於 HTTPS，也不構成瀏覽器 secure context。HTTP 無法使用 Secure cookie；瀏覽器可能限制 Web Crypto、剪貼簿等功能。介面提供安全 UUID fallback 與手動複製備援。VPN 不是應用程式認證；Owner token 與精確 Origin 驗證仍必要。

Pi 子程序會繼承服務使用者的 Pi 個人環境。工作目錄與 Pi trust 不是 sandbox。Profile 是主機設定的選擇，不是任意 CLI 輸入。`user-development` 範例未設定 extension，也未做相容性實測。若 `+subagent,+codemode` 需要 extension，Owner 必須設定 canonical 絕對 extension 路徑及適當 policy。Controller 不會靜默替換 provider/model/thinking 或略過必要 extension。

## Project 與 sessionDir

Project 選擇不固定綁定單一 Project。部署設定可用 `projectDiscovery.root` 與 `sessionRoot` 指定目錄。介面列出 root 的直接子目錄，只列非 hidden、非 symlink 目錄；不要求 Git repository，也不遞迴搜尋。每次 `GET /api/v1/projects` 都重新掃描。Project ID 由 repo 路徑產生穩定 SHA ID。既有 `projects` 靜態設定仍支援；靜態陣列可為空，並由 discovery 提供選項：

```json
{
  "projectDiscovery": {
    "root": "/absolute/path/to/projects",
    "sessionRoot": "/absolute/path/to/session-storage"
  },
  "projects": []
}
```

Controller 不掃描個人 HOME，也不搬移既有 history。`GET /api/v1/projects` 不建立 session 目錄；只有 UI 新建 session 的 POST 才建立該目錄，權限為 `0700`。若要以 Pi settings 或 CLI override 指定其他 `sessionDir`，必須為該 Project 個別提供靜態配置；discovery 不會自動讀取個人設定。加入既有 session 只登記原檔，不搬移或轉換。受管理 TUI 期間由 lock 保護；不要另開未受管理 Pi 直接雙寫。

## 受管 Session Profile

側欄的 `Profile` 選單只供新建或加入 Session 時選擇，不會變更已選取的 Session。要變更既有 Session，請先展開 `Session Profile` 區塊，再選擇一份已配置 Profile，並明確按「套用 Profile」。此區塊平時收合，可保留對話空間。套用操作會使用整份 Profile；未指定欄位仍使用既有 Pi defaults／原生 session 語意，不代表清除所有隱含設定。

未啟動的 Session 只會保存 Profile，Pi 尚未啟動驗證。已啟動的 Session 只可在確認安全閒置時套用，並會重建該 Session 的 Pi 程序；草稿會保留。Provider、model 與 thinking 顯示現有 runtime 狀態，不代表 extensions runtime 已完整驗證。忙碌或狀態未知時不能套用。

若切換結果無法確認，Session 會維持 UNKNOWN／blocked，不會自動回退，也不應盲目重試。請由管理者依離線恢復規則確認 writer 已退出、原生檔案身分及操作結果，再決定後續處理；不要刪除 lock 或執行未核對的 SQL 解鎖命令。本功能尚不代表已部署，也未證明真 Pi 或 extensions 相容性。詳見[需求](docs/session-profile-switch-v1-requirements.md)與[設計](docs/session-profile-switch-v1-design.md)。

## Session 與操作限制

舊版 Web／TUI 交接流程只保留為 legacy 相容流程，不是新版 UI 的標準操作。新版 UI 不提供 owner 交接按鈕。受管理 TUI 完全退出後，Web 可使用 Claim 載入最新 history；Idle RPC runtime 仍持有 session lease。永久 `.prw.lock` 檔不可刪除。Controller crash 時 Pi 可繼續持鎖；只有確認舊 writer 已消失後才可重試。未知操作絕不自動重播，只查 operation receipt。Controller crash 後原生 Pi queue 不能保證恢復。

取消不會回滾已發生的檔案或 commit 副作用。未受管理的 `pi --session` 不受雙寫保護。獨立 extension 背景程序的取消不保證。

## Web 功能與驗證

新建 Session 可選填原生名稱。名稱會寫入 Pi 原生 session 檔案；既有名稱會在候選清單、受管清單與頁首顯示。名稱可重複，請以完整 Pi session ID 與 App ID 區分 session。新建名稱會 trim 首尾空白，限制為 128 個 Unicode code points，並拒絕控制字元、換行及 U+2028／U+2029。加入既有 session 只讀原名，不會改寫原檔。原生 Pi 外部改名後，使用「重新整理 Session 清單」或重新選取 session 更新顯示；不保證即時推播。名稱讀取使用有界掃描：每檔最多 2 MiB／250 ms，每份清單共用最多 8 MiB／1000 ms。超出預算會標示讀取未完成，不會假稱未命名。完整規格見 [Session naming v1 設計](docs/session-naming-v1-design.md)。

問答工具卡將工具活動關聯至發起的問答；父 agent 等待 child 回報時顯示狀態，不宣稱逐 token 更新。介面使用角色標示與乳白主題。詳見 [Interface v2](docs/interface-v2-requirements-design.md)。

曾完成的離線合成驗收與限制見上方歷史摘要及驗證文件。較早的 history-fix-140／140-16、ready-130／130-14、97-12 均為各自階段的歷史基準。真 Pi/TUI/模型完整端到端、實體手機、遠端 VPN 與 HTTPS 尚未驗證。

常用專案檢查命令：

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run check
```

`npm test` 與 `npm run test:e2e` 會先在隔離環境建置所需的 `dist`，不要求既有 build。兩者會自動建立 `.test-artifacts/runs/` 下的隔離測試環境。測試程序使用專用的私有 HOME 與 XDG 目錄，不讀取 Owner 的 Pi 個人設定或憑證。E2E 測試需要 Playwright Chromium。若瀏覽器執行檔不在預設位置，可透過 `PRW_BROWSER_EXECUTABLE` 指定路徑。`.test-artifacts` 是 gitignore 忽略規則，不代表每個 clone 都有報告；其中若存放部署或資料，刪除前須由擁有者確認。

假 Pi 測試使用合成資料。Basic 真 Pi `openai / gpt-6.1-sol / high`（provider/model/thinking）nonce 與 write call/result/bytes/idle/settled 驗收曾完成。較早常用 Profile 的真 subagent + codemode 未通過，因 child Python `SyntaxError` 阻止 proof 建立；Interface v2 的限定修復情境另已通過。真 steering、真 Compact、TUI、完整 extensions、實體手機、遠端 VPN 與 HTTPS 尚未驗證。測試通過不能代替主機端驗收。

## 文件期別

- `workspace-v1-`：基礎需求、設計及累積驗證紀錄。
- `interface-v2-`：既有介面的增量需求與設計，見 [Interface v2](docs/interface-v2-requirements-design.md)。
- `session-access-v1-`：實作與離線驗證紀錄。
- `production-service-v1-`：可攜的服務需求、設計與部署驗證歷史。

Session Access v1 的歷史部署與驗收依各期紀錄；不得將歷史基準解讀為目前服務狀態。標準新用法使用 native ID 與可複製原生命令，在同主機同檔案間由使用者自管雙寫；送出前同步，GET 僅讀取。Reader 不建立持久索引，使用有界掃描。舊交接流程只保留為舊版相容。安全審查見[安全審查紀錄](docs/security-review.md)。
