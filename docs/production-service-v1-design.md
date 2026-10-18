# 正式服務安全部署與登入 v1：設計與分階段執行

**狀態：可攜部署設計。歷史部署摘要見[驗證文件](production-service-v1-verification.md)。Repository 不實作通用 deployment CLI。**

## 1. 目標與非目標

### 目標

- 從可信來源，在隔離的 `buildDir` 執行 build、check、e2e 及 compiled-app smoke。
- 人工 review 通過後，建立 exclusive、immutable 的 `releaseDir`，原子更新啟動 pointer，正常啟動並執行有限驗證。
- 保存足以判讀的 baseline、命令結果、斷言報告與限制，不暴露 token 或個人資料。
- 成功後依部署者決定維持服務；失敗時正常停止，不自動啟動舊版。

### 非目標

不更換 Owner token，不修改個人 JSONL、Pi 設定、VPN、防火牆或正式 ledger 資料。不送出模型 prompt，不啟動真 Pi，不連接 provider，不執行正式 sessions 或 operations mutation。不宣稱全面安全、零停機、HTTPS 保護或涵蓋真 Pi／模型／VPN 實體環境的測試。

## 2. 分階段流程

```text
trusted source
    |
    v
isolated buildDir: build + check/e2e + compiled smoke
    |
    v
human review: evidence, baseline, scope and explicit approval
    |
    v
exclusive immutable releaseDir -> atomic pointer
    |
    v
normal start -> limited verification -> report and review
```

每階段只能在負責人 review 後進入下一階段。任一停止條件觸發時，保留證據並回報；不得擴大範圍或猜測處置。上述流程是部署者的可攜設計，不表示 repository 提供 deployment CLI 或主機啟停腳本。

### 階段一：隔離 build 與檢查

- 以固定來源建立獨立 `buildDir`。禁止在執行中 release 內建置或覆寫檔案。
- 核對 source、lock、依賴版本及安裝來源。隔離執行格式、lint、typecheck、測試、build 與 compiled-app smoke；測試產物只寫入核准的隔離位置。
- 候選內容應有逐檔 manifest/hash。檢查依賴、symlink 目標、compiled route 權限判斷與靜態資產。
- 不以 exit code 0 代替斷言檢查。外部網路、真模型與正式服務均非必要測試依賴。

### 階段二：人工 review

- Review 候選來源、manifest、測試範圍、所有失敗與限制。
- 記錄必要的 pointer、設定、token hash（僅私有報告）、受保護資料、舊 release 與程序 baseline。
- 核對操作白名單、SQLite 物理與邏輯資料、受管 writer/lock、服務身分及 listener。
- 未獲明確核准不得進入切換。發現憑證或資料不明時停止。

### 階段三：不可變 release、原子 pointer 與有限驗證

- 將核准候選複製到唯一的 `releaseDir`。release 存在時停止；不得覆寫或刪除舊 release。核對複製後 manifest 與 symlink target。
- 使用排他建立的暫存 pointer、fsync 與 rename 原子更新啟動指標，再核對 pointer 與 release。
- 使用主機管理者的正常啟動方式。監督程序須以正常 SIGTERM／Ctrl-C 停止；不要強殺或刪除 lock。背景服務需另行配置 service manager。
- 只執行核准的有限驗證，例如 health、首頁/資產、登入與未登入 API 防護。不得在正式資料上做 mutation。
- 比對 protected paths 與 manifest。成功或失敗均保留證據；失敗時正常停止新服務，不自動切回並啟動舊版。

## 3. 資料與鎖定安全

區分 SQLite logical data 與 physical files。即使 read-only 開啟也可能建立 WAL/SHM sidecar。正式資料庫的檢查應先停止 writer、核對原始 identity/hash，再複製到隔離檢查目錄；schema、logical rows/counts 與 hash 僅在副本執行。不能忽略 WAL frames，也不能只複製主資料庫而假設 sidecar 無關。核對副本前後的正式 DB 與 sidecar identity/hash。

程序鎖核對須拒絕 symlink、非 regular file 或多重連結，並以精確 device/inode 比對 lock holder。只可排除已確認 `State: Z` 的 zombie；空 cmdline 或狀態不明不能視為安全。不得刪 lock。任何受管程序或資料狀態不明時停止。

部署操作白名單應逐路徑列出 pointer/temp、service pid/log、核准 cache/temp、SQLite sidecars 及 release subtree。其他新增、消失或變更皆視為 unexpected，必須停止並交由負責人決定。不要掃描無關個人 HOME。

## 4. 憑證、啟停與回復風險

Owner 在私有位置管理 canonical 設定與至少 32 字元的 token。以環境變數契約提供設定與 token；避免把秘密放入命令列參數、URL 或日誌。Token 不由本專案自動建立或管理。HTTP over Tailnet 不等於 HTTPS，且不提供 Secure cookie。正式部署建議使用 HTTPS reverse proxy。

成功 run 不代表所有歷史風險消失。失敗 stop 不得以 SIGKILL 代替；必須確認程序狀態後回報。不要自動啟動已知有安全缺口的舊版本。保留 release 不等於完成安全 rollback。正式資料及既有部署不在文件發布流程中清理或搬移。

## 5. 公開發布 gate

公開 docs-only precommit gate 至少包括：

1. 對所有 tracked 工作樹內容與全部新增候選文件執行秘密掃描，並掃描所有 reachable Git history blobs；記錄範圍與限制。
2. 執行 full 與 production dependency audit，保留原始 JSON、實際 metadata 與退出狀態。錯誤或漏洞須先交 review，不可寫成通過。
3. 核對 lock integrity/registry URL，檢查 Markdown 格式、相對連結、精確候選範圍及 host-specific metadata。
4. 核對忽略規則、修改前後 hash 與非預期變更。人工 review 完成後才可由負責人決定是否提交。

掃描不能證明沒有未知秘密或漏洞。不得重寫 Git history；發現真正或不確定的憑證時停止並交由負責人處置。
