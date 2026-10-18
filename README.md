# Pi Remote Workspace

Pi 原生 session 的同源遠端介面。Linux 主機需求：Node.js 22.19 以上，目前只接受 Pi 1.3.0 套件 metadata。**本次安全修補已驗證：142 tests／23 files、16 browser cases；正式服務依 Owner 授權保持關閉，安全修補未部署。**`@fastify/static` 已由 8.3.0 升至 10.1.6；matched-route auth 修正已處理 encoded API 路徑繞過。詳見[安全審查紀錄](docs/security-review.md)。真 Pi/TUI/模型完整端到端未驗證。history-fix-140/140-16、ready-130/130-14、97-12 均為各自階段的歷史驗收，不因本次更新而改寫。限定 `user-development` 真模型修復仍是先前完成的限定情境。歷史 Python `SyntaxError` 的舊 run report 保持原樣。細節見 [Interface v2](docs/interface-v2-requirements-design.md)、[Session Access v1 驗收紀錄](docs/session-access-v1-verification.md) 與[舊驗證紀錄](docs/workspace-v1-verification.md)。環境曾有 npm 10 的 `edgesOut` 相容性證據；不必變更全域 npm。

## 安裝與建置

```sh
npm ci --ignore-scripts
npm run build
PRW_CONFIG=/absolute/path/to/config.json PRW_OWNER_TOKEN='至少 32 個字元的秘密 token' npm start
```

`PRW_CONFIG` 必須是絕對路徑。`PRW_OWNER_TOKEN` 至少 32 字元。設定須有 canonical 絕對路徑的 `piCli`、`dataDir`、project `cwd`/`sessionDir` 及 profiles。網站由 Fastify 同源提供 `dist/web`，不依賴 Vite dev server。`npm run dev` 僅供本機開發。

預設服務只監聽 `127.0.0.1`。正式使用仍建議由正式 HTTPS reverse proxy 提供 HTTPS，並將 `publicOrigin` 設成精確 HTTPS origin。SSE proxy 應設 `proxy_buffering off`，並提供足夠長的 read timeout。此 repo 不部署、不設定 VPN 或 proxy。

可選擇將 HTTP 僅綁定本機 `tailscale0` 的單一 IPv4。這需要 Owner 明確設定 `listenHost` 與 `allowTailnetHttp: true`，例如：

```json
{
  "listenHost": "100.64.12.34",
  "allowTailnetHttp": true,
  "port": 4317,
  "publicOrigin": "http://100.64.12.34:4317"
}
```

先在主機確認 `tailscale0` 已存在，且該 IPv4 是介面目前持有的位址。設定只接受正規 `100.64.0.0/10` 位址，並要求 `publicOrigin` 精確符合該 IP 與 port。此功能不會自動探索或追蹤位址變更；位址變更後需由 Owner 更新設定。它只綁定該單一 IP，不修改 VPN/防火牆，也不會公開 Internet。不要將 Tailscale 加密描述為瀏覽器 secure context 或 HTTPS。HTTP 無法使用 Secure cookie，且瀏覽器可能限制 Web Crypto、剪貼簿等 secure-context 功能；介面提供安全 UUID fallback 與手動複製備援，但 HTTPS 仍建議。VPN 不是應用程式認證；Owner token 與精確 Origin 驗證仍必要。

Pi 子程序會繼承 Owner 的 Pi 個人環境。工作目錄與 Pi trust 不是 sandbox。Profile 是主機設定的選擇，不是任意 CLI 輸入。建議先複製 `config/example.json` 並由 Owner 審核。

`user-development` 範例未設定 extension，也未做相容性實測。不能直接視為可用。`+subagent,+codemode` 若需要 extension，Owner 必須填入 canonical 絕對 extension 路徑與適當 policy。Controller 不會靜默替換 provider/model/thinking 或略過必要 extension。

## Project 與 sessionDir

Project 選擇不是固定綁定單一 Project。部署設定使用 `projectDiscovery.root=/home/<user>/repos` 與 `sessionRoot=/home/<user>/.pi/agent/sessions`。介面列出 root 的直接子目錄，只列非 hidden、非 symlink 目錄；不要求 Git repository，也不遞迴搜尋。每次 `GET /api/v1/projects` 都重新掃描，因此重新整理即可看到新增 repo。Project ID 由 repo 路徑產生穩定 SHA ID。既有靜態驗收 workspace 仍置頂，並保留原有 3 個 sessions；它不是唯一可用 Project。

通用設定可使用 `projectDiscovery`，而既有 `projects` 靜態設定仍支援。靜態陣列可為空，並由 discovery 提供選項：

```json
{
  "projectDiscovery": {
    "root": "/home/<user>/repos",
    "sessionRoot": "/home/<user>/.pi/agent/sessions"
  },
  "projects": []
}
```

Pi 預設在 `sessionRoot` 下使用 cwd 編碼的子目錄保存 sessions。Controller 不掃描個人 HOME，也不搬移既有 history。`GET /api/v1/projects` 不建立 session 目錄；只有 UI 新建 session 的 POST 才建立該目錄，權限為 `0700`。若要以 Pi settings 或 CLI override 指定其他 `sessionDir`，必須為該 Project 個別提供靜態配置；discovery 不會自動讀取個人設定。加入既有 session 只登記原檔，不搬移或轉換。受管理 TUI 期間由 lock 保護；不要另開未受管理 Pi 直接雙寫。

## 舊版 Web / TUI 交接相容流程

以下是已部署舊版的 legacy 相容流程，不是目前新版 UI 的標準操作；新版 UI 不提供 owner 交接按鈕。Web 使用舊版 release 後，以顯示的受管理命令開啟 TUI，例如：

```sh
npm run tui -- tui --session <app-session-id>
```

完全退出受管理 TUI 後，Web 使用 Claim 載入最新 history。Idle RPC runtime 仍持有 session lease。永久 `.prw.lock` 檔不可刪除。Controller crash 時 Pi 可繼續持鎖；只有主機端確認舊 writer 已消失後才可重試。未知操作絕不自動重播，只查 operation receipt。Controller crash 後原生 Pi queue 不能保證恢復。

取消不會回滾已發生的檔案或 commit 副作用。未受管理的 `pi --session` 不受雙寫保護。獨立 extension 背景程序的取消不保證。

## Web 功能與驗證

問答工具卡將工具活動關聯至發起的問答；父 agent 等待 child 回報時顯示狀態，不宣稱逐 token 更新。介面使用角色標示與乳白主題。詳見 [Interface v2](docs/interface-v2-requirements-design.md)。

本次離線合成驗收為 142 tests／23 files、16 desktop/mobile browser cases；只表示已執行的離線範圍，不代表所有 case 矩陣通過。正式服務已依本次 Owner 授權正常停止，尚未再次啟動；本次安全修補未部署。`session-access-v1-history-fix-140` 的 140／23、16 browser cases 部署，以及 `session-access-v1-ready-130` 的 130／23、14 browser cases 和 97／12，均保留為過去基準。Owner 功能測試尚待進行；真 Pi/TUI/模型完整端到端、完整 thinking profile 與 file-hook 矩陣、實際權限及 atomic-replace 等情境尚未驗證。詳見 [Session Access v1 驗收紀錄](docs/session-access-v1-verification.md)。

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run check
```

`npm test` 與 `npm run test:e2e` 會先在隔離環境建置需要的 `dist`，不要求既有 build。兩者會自動建立 `.test-artifacts/runs/` 下的隔離測試環境。測試程序使用專用的私有 HOME 與 XDG 目錄，不讀取 Owner 的 Pi 個人設定或憑證。E2E 測試需要已安裝的 Playwright Chromium；可使用預裝瀏覽器，或由 Owner 自行安裝。若瀏覽器執行檔不在預設位置，可透過 `PRW_BROWSER_EXECUTABLE` 指定執行檔路徑，不應硬碼主機路徑。直接執行 Vitest 僅提供合成的測試暫存目錄；建議使用 npm scripts 取得完整環境隔離。

假 Pi 測試使用合成資料。Basic 真 Pi `openai / gpt-6.1-sol / high`（provider/model/thinking）nonce 與 write call/result/bytes/idle/settled 驗收已完成，記錄於 `.test-artifacts/live-acceptance/phase1-write-final/report.json`。較早 phase2-verified 那次常用 Profile 的真 subagent + codemode 有執行，但 child Python `SyntaxError` 阻止 proof 建立，常用 Profile 情境未通過；本次 Interface v2 限定修復情境另已通過。Basic 驗收仍已通過。真 steering、真 Compact、TUI、完整 extensions、實體 phone、遠端 VPN 與 HTTPS 尚未驗證。測試通過不能代替這些主機端驗收。

## 文件期別

- `workspace-v1-`：基礎需求、設計及累積驗證紀錄；[需求](docs/workspace-v1-requirements.md)、[設計](docs/workspace-v1-design.md)、[驗證](docs/workspace-v1-verification.md)。
- `interface-v2-`：既有介面的增量需求與設計，合併記錄於 [Interface v2](docs/interface-v2-requirements-design.md)。
- `session-access-v1-`：本期實作與離線驗證歸檔；[需求](docs/session-access-v1-requirements.md)、[設計](docs/session-access-v1-design.md)、[驗收](docs/session-access-v1-verification.md)。

## Session Access v1

大型 session 400 相容性修正已部署；隔離 23 files／140 tests、16 browser cases 通過。當前固定 release 為 `session-access-v1-history-fix-140`。實際個人大 session 載入效果仍待 Owner 確認；尚未在 Owner 檔案證實觸發點已消失。97／12 歷史基準及 130／14 前一部署基準均保留。

本期目標為「Session Access v1：免交接 Web／TUI 接續與原生 JSONL 按頁讀取」。**Session Access v1 歷史部署與驗收仍依各期紀錄；正式服務目前依 Owner 授權保持關閉。本次安全修正未部署。**標準新用法使用 native ID 與可複製原生命令，在同主機同檔案間由使用者自管雙寫；送出前同步，GET 僅讀取。Reader 不建立持久索引，使用有界掃描。舊交接流程只保留為舊版相容。history-fix-140/140-16、ready-130/130-14、97-12 是各期歷史基準。安全審查見[安全審查紀錄](docs/security-review.md)。文件：[需求](docs/session-access-v1-requirements.md)、[設計](docs/session-access-v1-design.md)、[驗收](docs/session-access-v1-verification.md)。
