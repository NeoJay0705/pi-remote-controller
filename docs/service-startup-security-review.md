# Service Startup：提交前資安與公開資訊核對

日期：2026-10-23。範圍：本次 service stop、Pi 版本 gate 移除、PATH／package-relative extension 解析及其測試文件。此紀錄不是完整滲透測試或零漏洞保證。

## 程式安全核對

父 agent 已讀取最終實作、差異與測試斷言，完成獨立 review：

- stop 僅在記錄的 PID 不存在且固定 port 無 listener 時接受已停止；PID 存在但 starttime 不符時拒絕，不送 signal。讀取或 listener 檢查失敗會中止，不以權限錯誤當成不存在。
- 正常停止只對身分匹配的正整數 PID 送 SIGTERM；保留 deadline、不送 SIGKILL、不刪 metadata 或 runtime lock。shell 保留操作鎖與 stop/build/start 失敗中止。
- Pi 搜尋不執行 shell 或任意設定命令；只解析主機端 PATH。選中安裝後缺少 extension 不改選另一套 Pi。
- `pi:` extension 拒絕 dot segment、絕對 suffix、NUL、反斜線及 canonical symlink 越界；確認一般檔案且位於同一 package root。
- runtime 取得的是已解析的 canonical 路徑，不在每次 RPC 重新搜尋 PATH；沒有跨設定載入的解析 cache。
- 移除 Pi 套件版本 gate 是使用者明確決定，不是相容性證明。PATH、cwd、設定與 Pi 安裝都必須是受信任的主機端輸入；不抵禦同帳號惡意修改。這些修改沒有放寬 token、網路、session／DB 格式或 lease 保護。

本次 review 未發現新增、需阻止本功能提交的安全缺陷；以下依賴問題仍存在，不能將此結論擴張為整個專案無漏洞。

## 依賴漏洞檢查與殘留項目

在隔離 HOME、空白且不同的 npm user/global config、無 auth 的環境，向公開 npm registry 執行包含 development dependencies 的 `npm audit --json --ignore-scripts`。沒有執行 audit fix、安裝或修改 lockfile。

結果：0 critical、0 high、2 moderate 受影響套件（皆為既有 dev dependencies）：

| 套件             | 已鎖定版本 | 關聯 advisory                                                                                                                                                                                                                                   |
| ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vitest/mocker` | 4.1.11     | [GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)：未驗證的 manual mock registration 可造成 code injection；[GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp)：Windows backslash traversal bypass |
| `vitest`         | 4.1.11     | 經由 `@vitest/mocker` 受影響                                                                                                                                                                                                                    |

npm 報告建議升級到 Vitest 4.1.12；本次沒有修改依賴，此修補尚待獨立安排。不要對不受信任的網路暴露開發／測試服務。dev dependency 不代表不可被利用；本次直接 `--run` 驗證及 Linux 環境不構成所有攻擊情境的驗證。

首次 audit 因同一 `/dev/null` 被同時指定為 user/global config 而在發出查詢前失敗；改用兩個不同空檔後，audit 正常完成，exit code 1 表示發現上述問題，並非掃描通過。

## GitHub Public 資訊核對

- 新文件的個人 home 前綴已改成 `/home/OWNER/`；公開部署 URL 使用 `TAILNET_IP`，不包含實際主機位址。
- 對 tracked working tree 與非 ignored untracked 檔執行常見 private-key PEM、平台 token、JWT、URL credentials、credential assignment、個人路徑及 Tailnet IP 的 pattern 掃描。命中均為 README 明示的範例位址及 network unit test 的合成範圍／位址，父 agent 已讀取來源核對。
- 正式 local.json、token、服務日誌、部署備份、掃描原始紀錄與 dist 均不納入提交；`.test-artifacts`、本機設定與環境檔保留既有 ignore。
- 沒有安裝或執行 gitleaks／trufflehog 等專用 scanner，也沒有掃描 Git history。pattern 掃描未見秘密不等於能證明不存在任何秘密；提交本次變更不會清理先前歷史。

## 功能與靜態驗證

implementation-worker 在隔離 HOME/XDG/TMPDIR、離線 Pi 環境下直接執行 Vitest unit suite：25 個檔案、189 項通過。`npm run lint`、`npm run typecheck`、本次檔案 Prettier、shell／Node 語法與差異 whitespace 檢查通過。未使用會建置的 npm test/check wrapper，未重啟服務或執行正式 endpoint／模型／browser 驗收。

本機證據：`.test-artifacts/precommit-public/20261023T160902+0800/` 的命令紀錄、unit/static logs、檔案雜湊與 pattern 掃描；完整 audit 位於其 `audit-retry-20261023T081651Z/`。證據為 Git 忽略的本機產物，不隨此提交公開。
