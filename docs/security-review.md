# 安全審查紀錄

## 歷史結果與修補

歷史安全修補處理兩項問題。第一，API 權限檢查先前可被 raw URL／encoded route 規避；已改用 matched-route 權限判斷，並驗證 encoded GET 與 mutation／CSRF regression。第二，`@fastify/static` 8.3.0 有 4 項 GHSA，最高為 High；已升至 10.1.6。有限部署驗證摘要見[正式服務驗證文件](production-service-v1-verification.md)。

前期安全修補階段的 full 與 production dependency audit 曾回報 0 vulnerabilities。這是歷史結果，不是本次 fresh audit。歷史測試與 audit 不構成完整滲透測試，也不證明沒有未知漏洞。

## 審查範圍與限制

歷史 focused source review 涵蓋 auth、Origin 與 JSON 邊界、安全錯誤、path `NOFOLLOW` 與 identity、SQL parameterization、child process `shell: false`、`removeOwnerToken`，以及 Markdown 禁止 raw HTML 和外部 image。未涵蓋全部攻擊面，未宣稱全面滲透測試。

歷史秘密掃描曾將 13 筆 owner-token literal 判定為合成測試 token。非 lockfile 的高熵候選經人工判讀為文件、路徑、UUID、hash、錯誤識別字或合成 fixture；lockfile entropy 以 integrity 與 registry URL invariant 核對。這些是過往有限審查的結論，不代表本輪掃描結果。Node、作業系統與全域 Pi 套件未完成 CVE 審核。`npm audit` 不是 runtime／OS 安全證明。

歷史部署發生過 SQLite read-only 開啟建立 sidecar 的事故，並有後續隔離副本檢查與核對。事故及其失敗狀態保留於[驗證文件](production-service-v1-verification.md)，不宣稱整個過程從未有非預期差異。

## 先前公開文件發布檢查（歷史紀錄）

本輪 full audit 與 `--omit=dev` audit 均以 exit 0 完成，回傳 metadata 均列出 0 vulnerabilities。`--omit=dev` metadata 仍列出 dev 244、prod 163、total 406，因此不能獨立證明 filtered dependency count。Full audit 覆蓋 lockfile 的 406 個 dependency entries。首次 audit 的隔離環境將同一個空 npm 設定檔同時指定為 user 與 global；npm 拒絕重複載入。改用兩個不同空檔後，audit 成功。本輪未 audit 作業系統、Node.js 或全域 Pi 套件。

本輪使用本機 heuristic 掃描器，不是 gitleaks。本次提交前掃描涵蓋 90 個工作樹路徑、88 個 reachable history blob 與 5 個 staged blob。19 筆高熵候選經人工 review，屬於文件、CLI 範例與測試路徑。另有兩個公開贊助 URL 片段合計出現六次，位於 `package-lock.json` 的 `packages.*.funding[].url`，是 browserslist 與 caniuse-lite 的公開 Tidelift 贊助 URL，不含 userinfo 或 query credentials。原始掃描失敗證據保留於本機，未改寫。

本輪完成候選文件的格式、相對連結、metadata、ignore 規則及 lockfile registry URL／integrity 核對。Heuristic scan 以記憶體中的 exact comparison 檢查實際 Owner token，並檢查 private-key marker。最終掃描未發現實際 Owner token、private-key marker 或未分類候選。歷史 metadata 仍存在於舊文件與 Git history；新文件不含主機細節，不代表 history 已去識別化。此掃描不是完整秘密掃描，不能保證沒有未知秘密或漏洞。未檢查作業系統、Node.js 或全域 Pi 套件。沒有 push、history rewrite 或正式服務操作。

## 工作階段續留變更的公開提交檢查

本節適用於 `session-continuity-v1` 與 `session-scroll-momentum-v1` 的提交候選，不把前節的歷史 audit 當成 fresh 結果。檢查期間未修改產品程式、相依套件或 lockfile。

### 相依套件與安全回歸

- 使用公開 npm registry、互異的空 user/global config 及隔離 cache，分別執行 full 與 `--omit=dev` audit，各一次；兩者 exit 0，皆回報 **0 項已知漏洞**。隔離副本的 package manifest 與 lockfile 均與 repository 逐 byte 相同。
- Full metadata 為 prod 163、dev 244、total 406。Production audit metadata 仍包含同一組數量，不能用它獨立證明已縮小依賴計數；full audit 的範圍涵蓋目前 lockfile。
- Fresh focused security regression：`session-view`、`session-ui`、`api-auth`、`app-security`、`web`、`security-sse`，6 files／20 tests，exit 0。核對匿名／已登入 401、授權與 Origin／JSON 邊界、Markdown 安全投影、SSE 隔離及斷線清理，以及續留解析與 Compact eligibility。
- 沿用相同產品與測試內容的完整回歸：37 files／210 tests、84 browser cases，format／lint／typecheck／build 通過。其後僅修改公開文件的示意路徑、排版與本節紀錄；不為文件變更重建程式已驗證的證據。

### 程式與公開內容 review

父 agent 核對變更及測試證據：續留只投影有界的 version／Project ID／session ID，不儲存憑證或訊息；登入與伺服器清單先於還原，儲存內容不構成授權。登出與逾期使舊回應及畫面失效，撤銷失敗不假稱 cookie 已失效。Compact 確認不取代後端檢查，取消不送操作，不引入自動重送。捲動控制僅操作聊天 element，沒有新增 HTML 注入、外部網路請求、程式執行或後端權限入口。

環境沒有 gitleaks，使用本機 heuristic scanner 與假資料自測。初掃涵蓋 143 個工作樹檔案、212 個去重的 HEAD reachable 歷史 blob，以及 10 則 commit message。補掃 Owner token、泛用 token／cookie／Authorization literal、URL host 與 IPv4（含 shared address space），不請求掃描到的地址，也不讀正式設定或秘密作 exact comparison。

- 初掃 1,225 筆候選：846 筆為 lockfile integrity／公開 npm registry 路徑；其餘逐類核對為文件與 CLI 路徑、package／funding URL、合成 fixture token、錯誤識別字或語法誤命中。
- 補掃的 160 筆 literal 規則候選，去重後 33 種規則／來源行內容組合，均為合成測試資料、說明文字或語法誤命中。兩個含 userinfo 的 URL 是既有拒絕測試，不是服務憑證。
- URL host 與 IPv4 去重後 33 種：公開套件服務、保留測試域名、loopback、文件示意值、network boundary fixtures 及文字解析誤命中；未發現新的私人服務位址。補掃同時廣泛列舉一般識別字與低熵字串；這些列舉不是完整的秘密判定，也不宣稱逐一排除所有未知秘密。
- Working tree／history 的 lockfile resolved URL、SRI 與 funding URL 另以 JSON 欄位位置核對；沒有私有 registry、URL credentials、secret query 或無效 SRI。不是整份忽略 lockfile。
- 發現三處新文件帶有本機 home 絕對路徑，已改為明確示意路徑；保留原始未提交日誌，不改寫歷史測試結果。修正後三份文件格式與相對 Markdown 連結檢查通過。

### 證據與限制

原始掃描、候選、audit、checksum、失敗的 scanner 自測及修正後結果保留在本機 ignored 目錄 `.test-artifacts/public-commit-security-v1/`；focused regression 與補掃在其 `followup/`。這些不是公開附件，其他 clone 不一定具備。沒有把測試產物、正式設定、token、資料庫、個人訊息或 browser trace 納入提交候選。

本次是有限的 source review、公開內容檢查與 npm advisory 檢查，不是完整滲透測試或沒有未知漏洞的保證。未審核 OS、Node.js、全域 Pi 或 browser 的 CVE；未掃描其他 branches／tags、reflog 或 unreachable objects。Git 作者／提交者 metadata 沿用既有設定，未去識別化或改寫歷史。Safari／實體 iPhone 的原始繪圖問題仍未驗證。提交前另核對 staged blobs 與候選一致；本次只建立本機 commit，不 push、不部署、不重啟服務。
