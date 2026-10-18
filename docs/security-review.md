# 安全審查紀錄

## 歷史結果與修補

歷史安全修補處理兩項問題。第一，API 權限檢查先前可被 raw URL／encoded route 規避；已改用 matched-route 權限判斷，並驗證 encoded GET 與 mutation／CSRF regression。第二，`@fastify/static` 8.3.0 有 4 項 GHSA，最高為 High；已升至 10.1.6。有限部署驗證摘要見[正式服務驗證文件](production-service-v1-verification.md)。

前期安全修補階段的 full 與 production dependency audit 曾回報 0 vulnerabilities。這是歷史結果，不是本次 fresh audit。歷史測試與 audit 不構成完整滲透測試，也不證明沒有未知漏洞。

## 審查範圍與限制

歷史 focused source review 涵蓋 auth、Origin 與 JSON 邊界、安全錯誤、path `NOFOLLOW` 與 identity、SQL parameterization、child process `shell: false`、`removeOwnerToken`，以及 Markdown 禁止 raw HTML 和外部 image。未涵蓋全部攻擊面，未宣稱全面滲透測試。

歷史秘密掃描曾將 13 筆 owner-token literal 判定為合成測試 token。非 lockfile 的高熵候選經人工判讀為文件、路徑、UUID、hash、錯誤識別字或合成 fixture；lockfile entropy 以 integrity 與 registry URL invariant 核對。這些是過往有限審查的結論，不代表本輪掃描結果。Node、作業系統與全域 Pi 套件未完成 CVE 審核。`npm audit` 不是 runtime／OS 安全證明。

歷史部署發生過 SQLite read-only 開啟建立 sidecar 的事故，並有後續隔離副本檢查與核對。事故及其失敗狀態保留於[驗證文件](production-service-v1-verification.md)，不宣稱整個過程從未有非預期差異。

## 本次公開文件發布檢查

本輪 full audit 與 `--omit=dev` audit 均以 exit 0 完成，回傳 metadata 均列出 0 vulnerabilities。`--omit=dev` metadata 仍列出 dev 244、prod 163、total 406，因此不能獨立證明 filtered dependency count。Full audit 覆蓋 lockfile 的 406 個 dependency entries。首次 audit 的隔離環境將同一個空 npm 設定檔同時指定為 user 與 global；npm 拒絕重複載入。改用兩個不同空檔後，audit 成功。本輪未 audit 作業系統、Node.js 或全域 Pi 套件。

本輪使用本機 heuristic 掃描器，不是 gitleaks。本次提交前掃描涵蓋 90 個工作樹路徑、88 個 reachable history blob 與 5 個 staged blob。19 筆高熵候選經人工 review，屬於文件、CLI 範例與測試路徑。另有兩個公開贊助 URL 片段合計出現六次，位於 `package-lock.json` 的 `packages.*.funding[].url`，是 browserslist 與 caniuse-lite 的公開 Tidelift 贊助 URL，不含 userinfo 或 query credentials。原始掃描失敗證據保留於本機，未改寫。

本輪完成候選文件的格式、相對連結、metadata、ignore 規則及 lockfile registry URL／integrity 核對。Heuristic scan 以記憶體中的 exact comparison 檢查實際 Owner token，並檢查 private-key marker。最終掃描未發現實際 Owner token、private-key marker 或未分類候選。歷史 metadata 仍存在於舊文件與 Git history；新文件不含主機細節，不代表 history 已去識別化。此掃描不是完整秘密掃描，不能保證沒有未知秘密或漏洞。未檢查作業系統、Node.js 或全域 Pi 套件。沒有 push、history rewrite 或正式服務操作。
