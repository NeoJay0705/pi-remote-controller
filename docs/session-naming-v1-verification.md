# Session 命名與原生識別顯示 v1：驗證紀錄

公開版本已將主機位址與個人路徑匿名化；下列歷史驗證結果不因此改變。

## 結論與範圍

狀態：實作完成，父 agent 已 review 程式差異、測試情境、斷言及執行證據。隔離 unit/integration 與 desktop/mobile browser 回歸通過。未部署，不代表正式服務已具備此功能。

需求歷史見 [評估](session-naming-v1-assessment.md)。定案規格見 [設計](session-naming-v1-design.md)。評估文件描述的是修改前現況，不能將其中「目前不支援」當成修改後程式狀態。

本次不讀寫個人 session，不呼叫 provider，不執行正式服務啟停、資料遷移或 git commit。

## 已完成行為

- 新建 Session 可選填名稱。前後端共用 trim、128 Unicode code points 與控制字元規則。無效名稱在建立檔案前拒絕。
- 名稱寫入新檔的原生 `session_info`。沒有另建名稱 DB 或 Web 別名，也不改原生 ID、App ID 或檔名。
- 加入候選、受管清單與頁首顯示名稱。頁首另列完整 Pi session ID 與 App ID。同名 session 仍以 ID 區分。
- 加入既有 session 不重新命名，也不改寫原檔。POST 同時帶 nativeFile 與 name 時拒絕。
- 名稱依全檔最新完整 `session_info` 選取，不限於目前對話分支。最新空白／缺省名稱代表清除，不退回舊名。
- 名稱讀取有單檔 2 MiB／250 ms 與清單共用 8 MiB／1000 ms 預算。狀態區分 named、unnamed、incomplete、error。
- 清單刷新、重新選取與重連可更新名稱。SSE runtime snapshot 不清除 HTTP 名稱 metadata。遲到的 A session 回應不污染 B 標題。
- 手機側欄有 viewport 高度與捲動配置。長清單可用正常 pointer click 切換 session，沒有以鍵盤或 force click 代替驗收。

## 最終有效檢查

所有命令在 repository 工作目錄執行。各階段的有效證據只用於其後未再改動的範圍。

| 檢查 | 結果 | 證據 |
| --- | --- | --- |
| `npm test` | 28 files／159 tests 通過 | `.test-artifacts/session-naming-v1-final-check/run-20261019T052151Z/unit-integration.log` |
| 完整 `npm run test:e2e` | desktop/mobile 共 40／40 通過 | `.test-artifacts/session-naming-v1-browser-regression/full-2.log` |
| `npm run format:check` | 通過 | `.test-artifacts/session-naming-v1-browser-regression/format-check-final.log` |
| `npm run lint` | 通過 | `.test-artifacts/session-naming-v1-browser-regression/lint-final.log` |
| `npm run typecheck` | 通過 | `.test-artifacts/session-naming-v1-browser-regression/typecheck-final.log` |
| `npm run build` | server 與 Vite build 通過 | `.test-artifacts/session-naming-v1-final-check/run-20261019T052151Z/build.log`；最終 browser wrapper 另建置最新來源與 CSS |
| Pi 1.3.0 implementation smoke | 本次 createNative → SessionManager.open → appendMessage → reopen，ID／名稱／訊息斷言通過 | `.test-artifacts/session-naming-v1-implementation/run-20261019T045125Z-48512/smoke.mjs` 與 `smoke.log` |

後續修改只有 browser 測試、CSS 與文件，沒有改動上述 159 tests 所驗證的 server/shared/web 邏輯。最後完整 browser suite 已使用最終 CSS。文件歸檔不另執行功能測試。

Browser 使用已存在且最小啟動驗證有效的 headless shell：

```bash
PRW_BROWSER_EXECUTABLE=/absolute/path/to/chrome-headless-shell npm run test:e2e
```

此處的瀏覽器路徑已匿名化。執行時使用本機已存在且通過最小啟動驗證的 headless shell；此路徑不是部署需求。測試 wrapper 使用私有 HOME、XDG、TMPDIR 與 loopback fake-Pi fixture。沒有安裝新瀏覽器或修改套件設定。

## 目標情境與斷言

| 情境 | 證據範圍 |
| --- | --- |
| 中文、emoji、trim、128／129 字元及內部控制字元 | shared unit 與 API 驗證；browser 驗證 129 emoji 在 POST 前拒絕 |
| 新建命名／未命名及同名辨識 | API 與 browser 精確比較 App ID、Pi ID、名稱；同名新建等待各自的 POST 回應 |
| 既有名稱唯讀加入 | API 與 browser 以確切檔案 value 選取，加入前後 bytes／SHA-256 相同 |
| DB reopen | 重新開啟 app／runtime／ledger 後，比對原本確切 App ID、native ID 與名稱 |
| 全檔最新名稱、清除與非目前分支 | 合法 sibling branch 的最後 user leaf 不包含最新名稱 entry，reader 仍選全檔最新名稱；空白／缺省名稱不退回舊值 |
| 部分尾行、CRLF、非法／超過 4096 bytes／截斷的名稱 | Unit 斷言正確名稱或安全 error，不把截斷名稱當完整結果 |
| 單檔 byte 預算 | 固定 clock 排除時間耗盡；大筆紀錄使實際讀取量接近 2 MiB，但不超限，結果 incomplete |
| 共用 byte 預算 | 第一檔完整 named 且實際計數增加；第二檔因剩餘預算不足而 incomplete，總量不超限 |
| 時間與檔案競態 | 掃描已開始後期限跨越，以及真實 append／replace／truncate，結果 incomplete，不攜帶舊名 |
| GET 不啟動 Pi | API 以不存在的 piCli 測試清單與 Snapshot；runtime 維持 released |
| SSE 與遲到回應 | 觀察到真實 SSE snapshot 後名稱仍在；釋放 A 回應後 B 的不同名稱與身分不變 |
| 純文字與長名稱 | Browser 驗證 128 字元排版、markup-like 名稱文字完全一致、無新增 image、無 script 執行及無水平溢位 |
| 手機 pointer 操作 | 測試自行建立 8 個 session，先點第一個，再正常點第八個，精確比對切換前後名稱、App ID 與 Pi ID |
| 既有回歸 | 完整 browser 包含安全 history、110 MiB 原生檔接續、queue/stop、project grouping、離線重連、錯誤隔離與捲動 |

## Review 發現與已完成修正

- 初版前端未使用共用名稱驗證，已修正。
- 初版 header 先讀取後才檢查預算，已改為讀取前檢查並計入實際 bytes。
- 初版以 non-enumerable nameInfo 配合舊測試，已改回普通 DTO property，並更新精確斷言。
- 初版分支 fixture 及 byte-budget 測試未能區分目標行為，已補合法 sibling branch 與固定 clock、共用成本證據。
- 初版手機清單項目被其他控制項遮擋，已補側欄排版，並恢復正常 pointer 驗證。
- 舊 browser 測試依賴 ID-only 候選文案、舊頁首位置及空清單假設，已改為確切檔案／ID 身分及匯入前後候選集合比對。沒有取消歷史、安全或大檔情境。

較早 failed／partial 結果均保留於 artifact，不作為最終通過證據。最後以完整 40／40 browser 結果確認修正。父 agent 以原始碼、測試與日誌完成核對，不僅依 worker completed 或 exit code 判定。

## 限制與未驗證

- 真 Pi 驗證只直接使用 SessionManager，不含 CLI、AgentSession、extensions、provider 或完整 Web → 模型 → TUI 接續。
- Browser mobile 是 Chromium 模擬 viewport，不代表實體手機、觸控鍵盤或螢幕閱讀器驗收。
- 單筆解析與作業系統工作不能硬中斷。時間限制是合作式期限。
- 名稱離檔尾過遠時，可能持續 incomplete。本期沒有名稱掃描續讀游標、持久索引或背景重試。可繼續用 ID 操作。
- 本期未逐一注入磁碟寫入／fsync 失敗、登記失敗及建立回應遺失；不自動重送與錯誤提示已實作，不能把 503 browser 測試解讀為完整故障矩陣。
- 未受管理 writer 的同時原地改寫不具 race-free 保證。沒有擴大現有 writer 保護承諾。
- 名稱專屬的 logout 後遲到清單回應及多個清單刷新亂序未各自建立獨立 browser 情境；對應 generation／serial guard 已 review。
- 未部署或測試正式 URL、個人 session、VPN、HTTPS。未修改 package/lockfile、設定或 snapshots。

Artifact 目錄受 gitignore 忽略。此文件記錄當次有效證據，不承諾其他 clone 具有相同測試產物。

## 公開前安全檢查

2026-10-19 對公開版本 candidate 執行安全檢查。使用 Gitleaks 8.24.2 掃描目前 candidate 與 4 個可達歷史 commits，結果為 0 finding。`npm audit` 對 production 與 development dependencies 均回報 0 個已知漏洞。父 agent 已檢視名稱以純文字呈現、輸入驗證、安全檔案路徑、bounded read 與 safe error code。

私有設定、token、資料庫、個人 JSONL 與部署產物未納入 Git candidate。相關 ignored-artifact 首次 audit 證據見 [首次公開前 audit](../.test-artifacts/session-naming-v1-public-audit/20261019T072254Z-49777/report.md)。本次匿名化 candidate 的最終掃描與 manifest 見 [final run](../.test-artifacts/session-naming-v1-public-final/20261019T072254Z-db1714cd-6408-4afa-89f5-bcca34293e5e/)。

Gitleaks 預設規則與 npm audit 都不是無漏洞保證。文件匿名化只影響目前版本；既有 commits 仍可能含原主機位址與個人路徑。本次未改寫歷史。
