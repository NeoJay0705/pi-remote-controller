# Pi Remote Workspace v1 — 系統設計

## 1. 文件狀態與設計基線

- 名稱：Pi Remote Workspace v1。
- 狀態：**可開始分階段實作，尚未驗收**。
- 本文件與需求文件採共同 `workspace-v1-` 期別前綴；目前檔名為 `workspace-v1-design.md` 與 `workspace-v1-requirements.md`。
- 本文件歸檔已決定的系統設計，不代表已實作或已通過執行時驗收。
- 需求對照以 `docs/workspace-v1-requirements.md` 的 R01–R18、A01–A14 為準。

## 2. 技術基線與範圍

- 使用 TypeScript strict 與 Node.js 22.19+；目前基準為 Node.js 22.21.1。
- Linux 為第一個支援平台。
- 使用 React/Vite SPA、Fastify 同源 API 與正式靜態檔服務、CSS Modules、Vitest、Playwright。
- 歷史契約基準為 Pi 1.3.0 stdio RPC；目前 Controller 與受管理 TUI 暫不檢查 Pi 套件版本。此變更不代表新版本已完成 RPC 或其他相容性驗證，詳見[版本 gate 移除需求](pi-version-gate-removal-requirements.md)與[設計](pi-version-gate-removal-design.md)。
- 不採用 SSR，也不在服務內嵌 Pi SDK。
- 若手刻 RPC adapter，原因是需要嚴格的傳輸邊界、backpressure 與可證明的 child close join。官方 `RpcClient.stop` 不可單獨當成完成交接的證據。
- 服務是 Pi 原生 session 的遠端操作入口，不是新的 Agent 引擎。瀏覽器不直接連 Pi 的 stdin/stdout（R01）。
- v1 不提供公開網站、VPN 管理、跨主機 session 同步或 App（R18）。

## 3. 部署與設定

### 3.1 網路邊界

- Controller 只監聽 `127.0.0.1`。
- VPN 與 HTTPS 終止由 Owner 管理的反向代理提供。
- 設定固定的 `publicOrigin`。正式環境要求 HTTPS；`localhost` HTTP 僅供開發與測試。
- 不信任任意 `X-Forwarded-*` 標頭。
- 不直接將 Pi RPC 或控制介面公開到 Internet。

### 3.2 主機設定

- `PRW_CONFIG` 指向主機上的 JSON 設定檔。
- `PRW_OWNER_TOKEN` 由環境提供，至少 32 字元；不得進 URL 或瀏覽器 bundle。
- 設定包含 `port`、`dataDir`、`piCli`、`projects[{id,name,cwd,sessionDir}]` 及 `profiles[{id,name,provider?,model?,thinking?,extensions?,tools?,appendSystemPrompts?}]`。
- 所有主機設定路徑都必須明確驗證；網頁不得提供任意主機路徑或 CLI 參數。`piCli` 可為精確字串 `pi`，按程序啟動時 PATH 選第一個可執行一般檔案，也可為既有 canonical 絕對檔案路徑。extension 可為絕對檔案路徑或 `pi:<package-relative-path>`，後者必須位於所選 CLI 的 `@earendil-works/pi-coding-agent` 套件根目錄內。解析結果在該次 `loadConfig` 固定；重啟才重新採用啟動 PATH。套件名稱只用於定位根目錄，不檢查版本。shell alias／function 不會解析；必須由 npm 或 service manager 提供 PATH。完整規則見[Pi install resolution 需求](pi-install-resolution-requirements.md)與[設計](pi-install-resolution-design.md)。目前不檢查套件版本；歷史 1.3.0 契約基準不構成對新版本的相容性聲明，RPC、模型、extensions 與 TUI 相容性仍須個別驗證。
- 不得靜默 fuzzy fallback 模型。啟動後核對 `get_state` 的實際 provider、model、thinking；明確指定值不符即失敗。
- Profile argv 以參數陣列表示，不拼接 shell 字串。必要工具、模型或 extension 缺少時明確失敗，不靜默改用其他設定（R15）。

## 4. 身分驗證與 HTTP 安全

- Owner token 透過 JSON `POST` 登入，換取隨機 `HttpOnly`、`SameSite=Strict` cookie。正式環境 cookie 設 `Secure`。
- Session 有效期 8 小時，保存在記憶體；服務重啟後須重新登入。
- Token 驗證使用 constant-time 比較，登入端點限頻。
- 所有 mutating API 都必須驗證 `Origin` 精確等於 `publicOrigin`，並要求 `application/json`。不啟用 CORS。
- 登出使 cookie 失效。API 回應使用 `no-store`。
- 設定 CSP，禁止 frame、外部 script 與嵌入內容；設定 `nosniff` 與 `Referrer-Policy: no-referrer`。
- 模型 Markdown 不執行 raw HTML；不自動載入外部圖片。
- Provider 認證只在 Pi 主機端使用，不進 Web 或 log。對話和工具內容屬 Owner 授權資料；不宣稱具備通用秘密自動遮罩。
- Raw stderr 與 `error.stack` 不回傳 Web，也不寫入一般 log。
- 未授權、schema 錯誤、鎖競爭與安全錯誤使用受控錯誤回應，不洩漏未知 exception。

## 5. API 契約

API 前綴為 `/api/v1`。

| 方法與路徑                                              | 用途                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /auth/login`、`POST /auth/logout`、`GET /auth/me` | 登入、登出與目前認證狀態                                        |
| `GET /projects`、`GET /profiles`                        | 列出設定中的專案與設定檔                                        |
| `GET /projects/:id/native-sessions`                     | 列出該專案設定 `sessionDir` 內可用的原生 session 檔             |
| `POST /sessions`                                        | 使用 `{projectId,profileId,nativeFile?}` 明確新建或導入 session |
| `GET /sessions`                                         | 列出受管理 session                                              |
| `GET /sessions/:id/snapshot`                            | 取得 session 與 runtime 權威快照                                |
| `GET /sessions/:id/history?before&limit`                | 分頁讀取歷史；`limit` 上限 100                                  |
| `GET /sessions/:id/events`                              | 訂閱 session SSE 事件                                           |
| `POST /sessions/:id/operations`                         | 提交具 UUID `operationId` 的操作                                |
| `GET /operations/:operationId`                          | 查詢操作收據                                                    |

操作 body 的 `kind` 為 `prompt`、`steer`、`follow_up`、`stop`、`compact`、`release` 或 `claim`，並可包含 `text`。需要 extension response 時可使用 `ui_response`；必須驗證現存 dialog ID，不提供任意 raw RPC passthrough。

- 成功接受通常回 `202`。
- 已知重複且 payload 相同時回傳同一收據；同 ID、不同 payload 回 `409`。
- 狀態衝突回 `409`；未授權回 `401`；schema 錯誤回 `400`；鎖競爭回 `423`。
- 對應需求：R03–R12、R15–R16。

## 6. SQLite 操作帳本與資料

- 使用 Node 22 `node:sqlite` 的 `DatabaseSync`，不加 native driver。
- `dataDir` 權限為 `0700`，資料庫檔案為 `0600`；啟用 WAL、foreign keys 與 `busy_timeout`。
- `sessions` 保存 opaque app UUID、canonical native file、原生 Pi ID、project/profile 與 desired owner（`web` 或 `tui`）。
- `operations` 以 UUID 唯一識別，保存 session、kind、payload hash、狀態及安全結果。狀態為 `RECEIVED`、`DISPATCHED`、`ACCEPTED`、`HANDLED`、`REJECTED` 或 `UNKNOWN`。Stop 清出的訊息也保存；其敏感資料僅供 Owner 使用。
- 在任何副作用前先寫入 `DISPATCHED`。命令接受結果不明，或程序／服務崩潰時，標記 `UNKNOWN`，不得自動重播。
- 啟動時以 transaction 處理 schema 版本與遷移；遺留非終態收據標記 `UNKNOWN`。
- 若仍有 Pi 持鎖，不得啟動第二個 writer。
- 不假設原生 pending queue 能跨程序重啟持久化。儲存失敗時不得把操作當成成功。
- SQLite 只保存操作帳本與管理資料；原生 Pi session 是對話 SSOT，不複製 Agent 歷史到另一個資料庫（R02、R10、R12）。

## 7. 原生 session 檔與歷史

- 新 session 以 `O_EXCL`、`0600` 建立，並初始化一行原生 v3 `SessionHeader`，其中含 UUID、timestamp 與 canonical cwd。後續對話只由 Pi 寫入。
- 既有檔只能位於設定的 `sessionDir`。拒絕 symlink、非 regular file、hardlink、越界路徑；核對 header 的 `id` 與 `cwd`。
- 單檔上限 32 MiB，使用 strict UTF-8。活躍 TUI 檔案最後一行若未完整 LF，可略過並標示同步中；完整但損壞的行不得悄悄忽略。
- 列目錄有數量限制。歷史依 active leaf 的 parent 鏈讀取，不混入棄用分支，並支援分頁。
- Runtime 活著時以 RPC 同步實際狀態；runtime released 後可唯讀原生歷史。GET 不得偷偷啟動 Pi。
- 壞歷史 fail closed，不覆寫。導入只引用既有原生檔，不搬動或修改它。
- 對應需求：R02、R10、R14、R17。

## 8. WriterLease 與單一寫入者

### 8.1 Linux kernel lease

- 每個 canonical native file 旁建立永久 `.prw.lock`，權限 `0600`，供受管理 Web 與 TUI 共用。
- 以 `O_NOFOLLOW`／`O_CREAT` 開啟並保留 `FileHandle`。執行 `/usr/bin/flock -n -E73 3`，透過 `stdio[3]` 傳遞該 fd。
- Linux open-file-description lock 在 `flock` 子程序退出後仍由父程序持有。活 runtime 必須強引用 `FileHandle`，不能依賴 GC。
- Pi 也明確繼承該 fd 為 fd 3，因此 Controller 崩潰時 Pi 仍持鎖。
- 不得 unlink lock，也不得退回 PID 檔方案。
- 鎖目錄與 session 儲存目錄必須由 Owner 信任。此協定不防同 UID 惡意竄改。
- `dataDir` 另有 `controller.lock`，採相同 kernel lease，避免兩個 Controller 共用資料庫。
- TUI 必須使用相同 session lease；競爭時不啟 Pi。
- 實測必須證明跨程序競爭及 Controller death 後仍拒絕第二個 writer（R13–R14、A09–A11）。

### 8.2 交接入口

- `release` 只允許在 idle 且 queue 為空時執行；忙碌時回 `409`，Owner 明確 stop 後再試。
- 設為 `releasing`，關閉 stdin，等待 child 真正 `close` 且受管 process group 結束。Deadline 後送 TERM/KILL，仍須等待 close；無法證明退出時標為 `blocked` 並保留 lease。
- 完成後設定 `desiredOwner=tui`，UI 顯示受管理的 TUI 命令。
- TUI CLI：`prw tui --session <appUUID>`。它讀同一設定與 DB，確認 `desiredOwner=tui`，取得 kernel lease，使用固定 profile/native file，以 inherited stdio 執行 Pi；待 Pi 退出後才釋 lease。TUI 退出後仍保留 `tui` desired owner，直到 Web 明確 claim。
- `claim` 取得同一 lease；若 TUI 仍活著則回 `423` 且不改 owner。成功後以全新 runtime 載入 TUI 最新歷史，再設定 `desiredOwner=web`；不得依賴 cached memory。
- 未受管理的 Pi 啟動不在保證範圍內。未驗證 extension 背景程序不保證會被 abort 清除；獨立服務不屬受管 process group。

## 9. PiAdapter 與 RPC 傳輸

- 啟動形式：`spawn(process.execPath, [piCli, "--mode", "rpc", "--session", exactFile, ...profileArgs])`，使用 `shell:false`、固定 cwd、獨立受管 process group。
- 繼承 Owner 預期的 Pi 個人設定環境，但不得將 `PRW_OWNER_TOKEN` 傳給 Pi 子程序。設定與歷史不是 sandbox。
- 持續讀取 stdout，以 LF 分框，接受 CRLF，使用 strict UTF-8；每 frame 上限 16 MiB。
- Send queue 有界，遵守 stdin `drain`。stderr 有界丟棄且不回報原文。
- 使用唯一 command ID 關聯請求與回覆；送命令前先建立 listener。
- 啟動時驗證 `get_state`、session file/id/cwd/model，並明確設定兩種 queue mode 為 one-at-a-time。
- 未知或畸形 protocol 一律 fail blocked。
- `prompt` response 表示 handled/接受，不必等待 `agent_settled`。`agent_end` 不等於完成。
- `message_end` 的 stop reason 為 `error`、`length` 或 `aborted` 時，必須反映在狀態；不得把 settled 一律當成功。
- 影像、簽章等不直接由一般 UI render；UI 僅呈現安全的文字型內容。
- 對應需求：R01、R04–R05、R11、R16。

## 10. Runtime 狀態與操作順序

- 每個 session 有獨立 runtime；不設 worktree 全域排隊。
- 命令入口序列化，但不可等整個 run 結束才允許 steer、follow-up 或 stop。
- Runtime 狀態：`released`、`starting`、`idle`、`running`、`stopping`、`releasing`、`blocked`。`lastOutcome` 與 runtime 狀態分開保存。
- 執行期間收到普通 prompt 時拒絕，要求 Owner 明確選 steer 或 follow-up。
- Stop 順序：先設 `stopping` 並擋新操作；呼叫 `clear_queue`；保存清出訊息的類別與順序；再呼叫 abort；確認 idle 後才接受新 prompt。取消不回滾已發生的副作用。
- Timeout 或狀態未知時標記 `blocked`，不釋放 writer，也不回報假成功。
- Idle 時保留 runtime 與 lease，直到明確 release 或 server shutdown；v1 不做自動 idle 回收。
- 對應需求：R04–R14。

## 11. SSE 與瀏覽器同步

- SSE 以 session 訂閱。連線中斷只取消該連線 listener，不關閉 runtime。
- 每 client buffer 上限 512 KiB；超限即中斷並要求重新取得 snapshot。心跳每 15 秒；認證過期時結束連線。
- 事件限於 snapshot、安全 RPC 子集與 `resync-required`。原生歷史及 snapshot 用於恢復；不承諾完整 token replay。
- 前端切換 session 使用 generation guard，abort 舊 fetch 並清理舊 SSE，避免舊 session 事件污染新畫面。
- 送出時凍結 session ID、操作模式與 draft。`requestId` 保留到收據確認；未知操作不自動重送。
- 每 session draft 分開保存。Stop 清出的訊息列為待重送，不覆蓋原 draft。
- 對應需求：R03、R08、R10、R12。

## 12. Web UI 與 extension 範圍

介面提供：登入、專案／設定檔／原生 session 選擇與新建、session 清單、runtime owner/status/model/thinking、Markdown 聊天、可折疊工具活動、明確的 send/steering/follow-up、Stop 按鈕與 Esc、compact、release/claim、清出訊息、連線狀態，以及 operation receipt／未知狀態檢視。重連時重新取得 snapshot 與 history。

- Esc 不在輸入法 composition 期間觸發；停止後不自動送出訊息。
- 手機與桌面都能閱讀長文字和程式碼；UI 不以固定寬度終端為唯一介面（R17）。
- 支援基本 extension select、confirm、input、editor 與通知。未知 method 取消並標示不支援。
- 不建立完整 extension UI framework，不預設啟用使用者未測試的 extension。
- 原生 slash template 作為普通 prompt 交給 Pi；compact 使用 RPC 控制，不假設所有 TUI command 都有效。

## 13. TUI／Web 所有權狀態流程

```text
                 POST operation / GET snapshot / SSE
[Browser]  ----------------------------------------------+
                                                        |
                                                        v
                                                [Auth + Origin]
                                                        |
                                                        v
                                                  [Registry]
                                                        |
                                                        v
                                                   [Journal]
                                                        |
                                                        v
                                                   [Runtime]
                                                        |
                                                        v
                                                   [PiAdapter]
                                                        |
                                                        v
                                                  [Pi RPC child]
                                                   |          |
                         native session/history <---+          +-- fd 3 lease

 Web release: idle + empty queue -> close stdin -> join child/group -> release lease
      |                                                         |
      +---------------- desiredOwner=tui -----------------------+
                                                                v
                                              [prw tui --session <appUUID>]
                                                acquire same kernel lease
                                                fixed profile/native file
                                                                |
                     Pi exits -> release lease; desiredOwner stays tui
                                                                |
 Web claim -> lease acquired -> load fresh native history -> desiredOwner=web
```

API 到 Pi 的操作路徑依序經過認證、session registry、SQLite 操作帳本、session runtime、RPC adapter 與 Pi。Web/TUI 以同一 kernel lease 交接。Lock 競爭失敗時不得啟動 Pi。

## 14. 程式目錄與測試安排

預定目錄：

```text
src/server/       config, auth, store, lease, native-sessions, rpc, runtime, app, main
src/shared/       contracts
src/cli/
src/web/
config/example.json
README.md
test/unit/
test/integration/
test/e2e/
test/fixtures/
```

- 測試 fixture 使用合成資料與假 Pi 程序；不啟動真 Pi、不讀真 history/auth、不使用 provider 或 VPN。
- Vitest 明確包含 `test/**/*.test.ts`，排除 `.test-artifacts`；Playwright 的 `test/e2e` 獨立執行。
- 測試使用私有 HOME、XDG 與 TMPDIR，位置在 `.test-artifacts`。不得把可收集的 `*.test.ts` baseline 寫進 artifact；快照檔一律以 `.original-bytes` 結尾。
- 所有測試 listener 只綁 `127.0.0.1`，並在 `finally` 中 close/join。
- 必須有真 HTTP + 假 Pi 程序端到端測試；只有 Mock runtime 單元測試不能宣稱已驗證真 RPC 傳輸行為。

## 15. 驗證計畫與驗收矩陣

驗證至少涵蓋：

1. Schema、認證、CSRF、XSS。
2. Native file 安全、branch 與分頁。
3. Unicode、LF/CRLF、oversize、backpressure、malformed frame、late response。
4. Accepted 不等於 complete、handler handled、`agent_end` 後 retry。
5. Steering/follow-up/stop 順序；stop timeout 不釋鎖。
6. 實際 kernel lock、TUI/RPC fd 繼承、Controller crash。
7. Ledger 重複、UNKNOWN、restart 與 SQLite 故障。
8. SSE 斷線時工作繼續、視圖切換 race、手機與桌面 browser。
9. 實 HTTP + 假 Pi 程序端到端交接與恢復。

A01–A14 必須以矩陣逐項標示 `planned`、`passed` 或 `unverified`。本設計文件建立驗證計畫，不表示任何執行時驗收通過。以下明確不納入離線測試通過宣稱：真 Pi、真模型、實際 extension、VPN、HTTPS 與正式部署。

### 15.1 驗收對照

| 需求／驗收       | 設計對應                                                                       | 驗收狀態              |
| ---------------- | ------------------------------------------------------------------------------ | --------------------- |
| R01–R02、A02     | Pi stdio RPC、原生 session 檔及明確導入／新建                                  | planned；執行時未驗證 |
| R03–R05、A03–A05 | 凍結操作 session、狀態欄位、原生 prompt/steer/follow-up 語意                   | planned；執行時未驗證 |
| R06–R07、A06     | clear_queue 後 abort、保留清除項目、確認 idle                                  | planned；執行時未驗證 |
| R08、R10、A07    | runtime 獨立於 SSE 與頁面，重連重新 snapshot/history                           | planned；執行時未驗證 |
| R09、A08         | 每 session 獨立 runtime；不做 worktree 全域排隊                                | planned；執行時未驗證 |
| R11–R12、A12     | operation ledger、收據、UNKNOWN、不自動重播                                    | planned；執行時未驗證 |
| R13–R14、A09–A11 | kernel WriterLease、受管理 TUI 交接、失敗保留 lease                            | planned；執行時未驗證 |
| R15、A13         | 主機 profile、歷史版本基準（目前不檢查 Pi 套件版本）、實際 model/thinking 核對 | planned；執行時未驗證 |
| R16、A14         | 原生 template、compact RPC、slash command 限制                                 | planned；執行時未驗證 |
| R17、A01、A14    | 手機／桌面 SPA、安全 Markdown、同源 API                                        | planned；執行時未驗證 |
| R18              | API 與 shared contracts 分層；不開發 App                                       | planned；執行時未驗證 |

## 16. 故障安全條件與未驗證邊界

- 操作副作用前先持久化 `DISPATCHED`。接受結果不明、程序或服務崩潰時標 `UNKNOWN`，不自動重播。
- Stop 必須先清 queue 再 abort；未確認 idle 不接受新 prompt，不得宣稱停止完成。
- Release、claim、runtime 啟動或程序清理逾時時維持 `blocked` 並保留 lease。不得因 timeout 推定舊 writer 已退出。
- Controller 崩潰時 Pi 可透過繼承 fd 繼續持有 lease；啟動時遇到活 lease 不可再啟 writer。
- 原生 pending queue 不保證跨程序重啟；未知狀態須要求查核，不自動重送。
- SQLite 儲存失敗時不可回報操作成功。Native history 損壞時 fail closed，不覆寫。
- 工具、檔案與 Git 副作用不因取消而回滾。Provider／設定錯誤、extension 不相容及 RPC 畸形輸入均須明確失敗，不洩漏秘密或未知 exception。
- 受管理 process group 外的 extension 背景程序或獨立服務，未保證可被 abort 清除。未受管理的 `pi --session` 不保證遵守 WriterLease。
- 以下均未驗證：Pi 執行時及真 RPC、真模型/provider、使用者 extension、TUI/Web kernel lock 與崩潰交接、VPN/HTTPS/正式部署、實際手機與桌面端到端行為。
- 對話與工具內容是 Owner 授權資料，不宣稱通用秘密遮罩；專案工作目錄、Pi trust 與程序管理不是 OS sandbox。

## 17. 套件管理與主要取捨

- 僅在實作階段由 worker 另行獲授權後，才可安裝套件；允許範圍為 npm registry、精確 lockfile、`ignore-scripts`，且不得載入個人 npm auth 設定。本文件階段不安裝套件。
- 未來檢查命令為 format check、lint、typecheck、test、build；browser e2e 獨立執行。本文件階段不執行測試。
- SQLite 僅保存操作帳本與管理資料，不複製原生 history。
- 自有 transport 是為程序生命週期、邊界與 backpressure 需求，不是重造 Agent。
- SSE 比完整雙向 WebSocket 少一層握手；操作仍走 HTTP API。
- Linux `flock` 不提供跨 OS 保證。
- v1 暫不做 collaboration、worktree 隔離或插件市場。
