# Pi Remote Workspace v1 — 驗證紀錄

目前狀態：Project root 選擇與 Compact 拒絕狀態修正已部署。本輪隔離驗收通過 97 tests／20 files 與 12 browser cases；前 83 tests／18 files、10 cases 為保留的上一階段結果。另有一次限定 `user-development` 真模型修復情境成功並自然 settled；這不代表本輪重跑模型或所有 extensions 全相容。歷史 child Python `SyntaxError` 的舊 run report 保持原樣，不以後續成功覆寫。真 steering、真 Compact/provider 新 prompt、受管理真 TUI、完整 extensions、實體 phone、跨裝置 VPN 與 HTTPS 尚未驗證。以下 clean-room 40 tests、delta 43 與 68 tests／8 cases 均為各自歷史結果，不覆寫或取代本輪結果，也不代表所有環境皆適用。

## 技術與測試範圍

Linux、Node 22.21.1、TypeScript strict、Fastify、React/Vite、CSS Modules、NodeSQLite；Pi 1.3.0 metadata 限制與 stdio RPC adapter。合成測試使用合成 session、fakePi 真子程序、真 HTTP、Linux flock、受管理 CLI 及 headless Chromium 的 desktop/mobile viewport。另有 Basic 真 Pi `openai / gpt-6.1-sol / high`（provider/model/thinking）nonce 與 write call/result/bytes/idle/settled 驗收；常用 Profile 真 subagent + codemode 執行後因 child Python `SyntaxError` 未建立 proof，未通過。真 steering、compact、TUI、完整 extensions、VPN、HTTPS、實體 phone 未驗。FakePi 只能驗 Controller 傳輸與協調，不能證明模型或原生工具實際 steering 時機。

## 已通過的受控檢查

以下為歷史 synthetic 基準；最新 Basic 與 Interface v2 結果見後文，不代表目前仍全部未驗證。

`npm run check`：format/lint/server-web typecheck、40 單元整合測試、server/web build。`npm run test:e2e`：8 cases（basic/history-security/queue-stop/session-reconnect x desktop/mobile）。最新本輪命令與 run root 附表必填真實 exit，不得因先前綠而標本輪綠。

覆蓋：登入/Origin/安全錯誤；原生 header/active branch/分頁/路徑防護；LF/CRLF/UTF8/oversize/late-reply/backpressure；ack/handled/fast-settled 與錯誤；clear_queue->先存結果->abort->確認 idle、timeout 保 lease、storage fail blocked；operation ID 去重/UNKNOWN 不 replay；kernel fd 繼承/Controller SIGKILL；真 CLI wrapper 的 Web->TUI->Web 歷史與 parent chain/SIGTERM join；HTTP release/prompt 舊 owner 競態；browser 切 session/離線續跑/草稿、native import/compact 同 ID、Markdown 禁 rawHTML/外部圖片/javascript 連結與長行。

## 驗收矩陣

以下為歷史 synthetic 基準；最新 Basic 與 Interface v2 結果見後文，不代表目前仍全部未驗證。

- A01：合成登入 + desktop/mobile viewport passed；VPN/HTTPS/實機未驗證。
- A02：合成原生 ID/cwd/history/import passed；真 Pi 相容未驗證。
- A03：fakeRPC 串流/工具活動/接受不等完成 passed；真 provider 未驗證。
- A04-A05：Controller 明確轉送 steer/follow_up、queue 分類 passed；真 Pi 工具交付時機未驗證。
- A06：fakePi stopclear/持久化/abort/idle/draft/timeout lock passed；未知 extensions 停止未驗證。
- A07：browser offline/reopen/switch 與主機工作續跑 passed；真鎖屏/VPN 中斷未驗證。
- A08：per-session 隔離與 view guard 有測試；不同 session 同 worktree 檔案衝突仍由 Owner 管理，未做隔離保證。
- A09-A11：Linux kernel lease、fakePi + 真 CLI 交接、crash 持鎖與失敗保護 passed；任意未受管 pi 不保證防雙寫。
- A12：去重/UNKNOWN/restart/storage failure passed；不承諾 shell/Git exactly-once 或副作用 rollback。
- A13：profile 表達與實際設定核對/不符拒絕有測試；使用者 gpt-6.1-sol/subagent/codemode/policy/實際 extension 未驗證。
- A14：Markdown 安全/長行/歷史/compact 原 ID synthetic passed；真模型 compact/Git commit/實機手機未驗證。

## 邊界與操作注意

瀏覽器不是 runtime owner；reload 不是同步/驗證/鎖保證。取消不回滾。永久 lock 不可刪。舊 Pi 仍持鎖就不能第二 writer；主機查核，不能用 timeout 假退出。Queue 不保證跨 process restart；未知操作只查 receipt 不重送。Basic extension dialog UI 已實作，尚未做完整 fake-dialog 往返 browser 矩陣，更未驗實際 extensions/TUI-only UI；不列為已相容。不同 session 工作目錄不是 sandbox，不保證清除獨立背景服務。

## 已知維護與證據限制

歷史 web-review 任務漏 fakePi fixture 修改前 bytes，該輪 fixture 精確增量 hash 未驗證；保留限制不補造 baseline，後續任務已有當下 bytes 基準與 fixture 回歸。UI 目前尚有大型 App 元件，可後續分拆，不影響本輪宣稱範圍。沒有 commit/push 或正式部署。

## Interface v2 最新驗收與真模型修復

離線 browser 驗收證據：`.test-artifacts/interface-v2/browser-final/report.txt`、`logs-check.log`、`logs-e2e-full.log`。既有報告記錄 `npm run check` exit 0，format、lint、typecheck、server/web build 通過，18 files／83 tests 通過；完整 E2E 10/10 cases 通過。這些是已保存結果，本次未重跑測試或 build。

指定 offline checkout 為 `.test-artifacts/interface-v2/offline-final/checkout`。限定 live harness 與正式工作目錄分離。真模型 repair 證據位於 `.test-artifacts/interface-v2/live-repair/ef348db5-a29e-45e4-bbca-bd9aa638fa2e/` 的 `run.mjs` 與 `report.json`。設定模型為 `openai / gpt-6.1-sol / high`；一次 UI prompt、一次 `user` scope `implementation-worker` subcall，child actual model 為 `openai / gpt-6-luna`。Native-discovery 雙檔只列未加入的 session；duplicate 回應 409；原 history bytes 不變；GET 不 spawn Pi。相關 tests 通過。Child 先遇到預期的初始 ENOENT，並有一次讀取路徑誤植；之後讀取成功，建立 proof 與 report。這只證明該限定情境，不宣稱萬用 repair。

Proof 為 33 bytes，SHA-256 `75e77306af72b29b1b36fe6b0471ada3718dd6c2055ebe51eabee6832ec107a9`；report 對應該 hash。Native history 顯示 codemode 兩次唯讀 call，結果均成功，未使用 write/edit/bash。Run report 的 codemode 路徑判定經 history 唯讀核對後校正：script 以 root 常數加兩個 basename 傳入 `tools.read`，不是完整絕對路徑 literal。校正沒有重送 prompt。校正前 report bytes 未保留，所以該版精確差異未驗證；不補造原版。Harness 本次修正 false checks 時不設 exit code 1 的缺陷；未重跑 harness。

Harness 在 67 次 running-state 抽樣中觀察到父等待與 child timeline；只存 bool/count，並非 67 筆更新；SSE 型別另記於 report。模型自然 settled，原生 history 含 DONE；UI 等待與進度已觀察；UI 最終 exact 文字未獨立斷言。Synthetic 手機 viewport 不等於真模型手機驗收；live 場景為 desktop loopback。

## Tailscale HTTP 與瀏覽器相容性增量驗證

本輪以真瀏覽器透過 `http://TAILNET_IP:4317` 完成 Basic 真 Pi prompt。結果確認 `window.isSecureContext === false`、`crypto.getRandomValues` 可用、`crypto.randomUUID` 不存在。瀏覽器完成登入、Basic session 建立與單次 prompt。真 Pi 回覆精確 nonce。Operation ID 為 UUIDv4。History assistant provider/model 與 snapshot actual provider/model/thinking 均為 `openai` / `gpt-6.1-sol` / `high`。Session 已 idle 且 settled。Cookie 只有 HttpOnly、SameSite=Strict，且沒有 Secure。未登入 API 回應 401。無效 Origin 登入被拒絕。Controller 維持監聽實際 Tailnet IP；Owner 可用 `.test-artifacts/live-instance/stop.mjs` 停止服務。證據在 `.test-artifacts/live-instance/report.json`。本輪未記錄 prompt 期間的 SSE `message_update` 與 `agent_settled`，因此這兩項未驗證。此為主機自行連到自己的 Tailnet IP，不代表跨裝置、VPN 路徑或實體手機驗收。

此增量採用 delta-only 43 tests 基準；這是本輪增量檢查口徑，不取代下方既有 clean-room 40 tests 歷史，也不改寫舊結果。本次完整 `npm run check` 共通過 62 tests。Basic 真 Pi 成功證據保留於 `.test-artifacts/live-acceptance/phase1-write-final/report.json`。本輪另有 fake Pi 瀏覽器測試報告 `.test-artifacts/tailnet-http/phase1-write-final/report.json`；本輪沒有執行真 Pi 或真模型。

commonProfile 的真實工具 subagent/codemode 往返曾成功，但 child Python `SyntaxError` 導致 proof 未建立。可查 `.test-artifacts/live-acceptance/phase2-verified/report-retry.json` 與 native history；不得宣稱完整通過。

仍未驗證真 steering、compact、TUI、extensions 全相容及實機遠端操作。HTTPS、VPN、防火牆與正式部署也未在本輪驗收。

## Project selection 與 Compact 修正部署歸檔

### 驗收命令與產物

- 隔離 check log：`.test-artifacts/project-selection/isolated-final/logs/check.log`。此 log 記錄 `npm run check` exit 0、format/lint/typecheck/build 通過，以及 20 files／97 tests 通過。
- 隔離 E2E log：`.test-artifacts/project-selection/e2e-corrected/test-e2e.log`。此 log 記錄 12/12 desktop/mobile cases 通過。執行使用隔離 checkout 的正確 cwd。
- E2E corrected 目錄的 TSV baseline 損壞。因此，root `dist` 在該次 E2E 前後是否改動為未驗證；不可據此宣稱 root `dist` 未變或被改動。
- 較早 `final-tests` 的 `npm run check` 曾在 root build 重寫 root `dist`，違反當時的測試隔離要求。沒有宣稱已還原。之後以正確隔離 checkout 重跑 check 97 tests／20 files 與 E2E 12 cases，並採固定 release rollforward；服務不再讀取 root `dist`。較早的失敗 log 與校正報告保留，不以後續成功覆蓋。

### 部署與 browser 驗證

- Restart 證據：`.test-artifacts/project-selection/deployment/restart-report.json`。URL 為 `http://TAILNET_IP:4317`；服務重啟到固定 release `project-selection-402c5830-8686-45cb-9cc0-b3c473daf7b4`。報告快照 PID `21412`、starttime `942719935`。這些是報告當時的識別資料，不是本次重新探測結果。
- Restart 報告確認 15 個直接 repo directory、原 token hash、3 個既有 JSONL 與 session metadata 未變、sessions released/owner web、public files、root dist 與 release manifest 未變。無刪 lock、Compact replay 或 JSONL 改寫。
- Browser 報告：`.test-artifacts/project-selection/deployment/browser/report.json`。真 URL 上 desktop/mobile 均列出 15 repos 與置頂 workspace，共 16 options；主題、native header、SSE connected、released runtime、無 blocked banner、logout cookie、assets hash match 均通過。報告記錄 0 operation POST、0 new session POST。runtime released 是 lazy 狀態，尚未 spawn；不代表要新建或重新加入 session。
- Browser 測試用原 token 登入並登出；token 未更換。Owner 重新整理時使用原 token 重新登入。本輪沒有動個人原生 sessions。
- 本輪沒有重新跑 live model，也沒有真 Compact 或 provider 新 prompt。限定 `user-development` live 修復成功是上一輪結果，不宣稱本輪重跑。Live report 內既有早期失敗與校正限制仍保留。

### 文件範圍與證據限制

- 歷史檔名（當輪授權修改範圍）：`README.md`、`docs/interface-v2.md`（當前對應 `docs/interface-v2-requirements-design.md`）、`docs/verification.md`（當前對應 `docs/workspace-v1-verification.md`），以及當時歸檔下的文件基準／diff／report。此處保留當時檔名，不表示當時已使用目前名稱。其他 source、config、dependency、lock、dist、release、live-instance service data/token/scripts/history 未作為該輪文件工作修改目標。
- Manifest 與報告證明 restart 前後可靠比對確認的內容不變。由於 E2E corrected TSV 基準損壞，不推論 root `dist` 在之後是否改變。該限制不得以 browser assets 通過取代。
- 安全限制仍適用：不刪永久 lock、不 replay Compact、不搬移或改寫 Pi history。實機 phone、跨裝置 VPN 與 HTTPS 未驗證。

## 本輪乾淨產物驗證

本節只記錄本輪在乾淨 checkout 執行的命令。未執行或未通過的命令不得視為通過。

| 命令                                                                                                                                                              | Checkout                                                                                                                               | Exit code | 結果摘要                                                                | Run root                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------: | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `npm run check`                                                                                                                                                   | `/home/<user>/repos/pi-remote-controller/.test-artifacts/final-verification/clean-room/6b58eb67-0dd8-4db9-8a48-a204ccd9367d/checkout` |         0 | format、lint、typecheck、40/40 tests（13 files）、server/web build 通過 | `.test-artifacts/runs/a3b09b6b-60eb-4832-a9ea-3a8abbf8d952` |
| `env PRW_BROWSER_EXECUTABLE=/home/<user>/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell npm run test:e2e` | `/home/<user>/repos/pi-remote-controller/.test-artifacts/final-verification/clean-room/6b58eb67-0dd8-4db9-8a48-a204ccd9367d/checkout` |         0 | 自動建置 dist/web；8/8 browser cases 通過                               | `.test-artifacts/runs/37b4c6d3-a553-4b04-b5c9-2291f2fe2cdd` |

## 本輪 tailnet-review 合成回歸

本輪只使用 fakePi、loopback HTTP 與指定 headless Chromium；未連接真 Pi、provider、VPN 或部署環境。`npm run check` 最終通過，包含 68/68 單元／整合測試、format、lint、typecheck 與 build。`npm run test:e2e` 最終通過 8/8 desktop/mobile browser cases。queue-stop 回歸包含 clipboard 無法使用時顯示手動複製備援，以及延遲 clipboard reject 後切回同一 session 不顯示過期備援、不改草稿且不新增 POST。完整 stdout/stderr 與實際 exit、run root、public file hash/status 比對見 `.test-artifacts/tailnet-review/check.log`、`e2e.log`、`e2e.attempt1.log`、`e2e.attempt2.log` 與 `commands-report.json`。本輪合成結果不覆蓋前述 clean-room 40 tests 歷史，也不代表真 Pi 或網路環境驗收。
