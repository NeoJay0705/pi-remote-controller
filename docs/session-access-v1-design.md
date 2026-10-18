# Session Access v1：免交接 Web／TUI 接續與原生 JSONL 按頁讀取

狀態：**大型 session 400 相容性修正版已部署；部署檢查通過；實際個人大 session 載入效果仍待 Owner 確認。真 Pi/TUI/模型完整端到端未驗證。**本文記錄目前實作、部署與可確認的驗證證據。固定 release 為 `session-access-v1-history-fix-140`，正式 URL 為 <http://TAILNET_IP:4317>。需求見[需求文件](session-access-v1-requirements.md)，驗收見[驗收文件](session-access-v1-verification.md)。

大型 session 400 相容性修正已實作；隔離 23 files／140 tests、16 browser cases 通過。修正版已部署；130／14 基準保留為前一部署歷史。實際個人大 session 載入效果仍待 Owner 確認。

## 設計約束

共同識別前綴：`session-access-v1-`。架構以兩項已確認需求為界：免手動交接接續，以及原生 JSONL 唯讀且有界的歷史分頁。歷史仍以原生檔為唯一來源；不新增歷史副本或持久索引。

## Web 與原生 Pi 接續

- Web 與原生 Pi 使用同台主機上的同一份原生 session 檔。跨機只有在 SSH 或其他方式確保存取同一份檔案時才適用；不處理跨機同步。
- 顯示 native session ID 與 App ID 的差異，並產生帶正確 cwd、必要 session-dir 參數的可複製 `pi --session` 命令。
- 標準流程不依賴 owner 切換按鈕或受管理 TUI 入口。使用者負責避免 Web 與未受管理 Pi 同時寫入。不得宣稱能偵測未受管理 TUI idle，或能保證其 kernel 單 writer。
- 選取 session、重新整理與重連只取回最新原生 history／snapshot，不中斷、不重啟、不強制 reload 忙碌 RPC。GET 不得有重載副作用。
- 接續 prompt 由 server 在同 session 序列內完成：檔案變動檢查 → 必要 reload → 確認結果 → prompt。GET 只讀取 history／snapshot；接續準備由 POST 發送操作內部執行。POST admission owner claim 與 per-session 序列化保護競態；GET 不執行 reload 或設定 owner。
- 忙碌或狀態未知時不強制 reload。偵測外部變動且忙碌時顯示衝突並擋新接續，不強制 abort。Idle 時以 `switch_session` 載入同一 canonical file，核對 `cancelled=false`、identity/file、thinking、model/profile、branch 與 entries。取消、failure、timeout、未知或不符都阻擋 prompt，無 silent fallback。
- 維持 operation ID／no replay、draft 與 generation/revision/runtime epoch 防 late events。Metadata 更新只作變動信號，不是未受管理 writer 的鎖或 race-free 保證。
- 保留既有 flock 對 Controller 受管理 writer 的保護、close/join 與永久 lock 不刪規則。不得把新流程解讀為解除 lock。
- 實作前檢查既有 `desiredOwner=tui` 紀錄如何相容。資料遷移、DB 修改、刪鎖或解除 blocked 均不在本文件授權範圍。
- 工作完成狀態須考量 queue 與背景工作。正常退出 Pi 是最明確完成訊號。舊 TUI 重用前須重新載入。

## 原生 JSONL 歷史讀取

- 列出／加入只讀 header 及必要 metadata；不載入完整 history，不以固定整檔大小拒絕合法大檔。已管理 session 排除。
- Reader 由檔尾分塊讀完整行，依 parentId 找目前分支，處理 compaction/context entry，並遵守既有 render 契約。不可整檔 `readFile`／`JSON.parse` 後切片。
- 游標綁定 file identity、offset、entry、branch。Append 可延續仍有效的游標；replace、truncate 或 branch 變更須明示重載。不完整尾行暫略，待後續讀取。
- 不建立持久歷史索引檔或 SQLite 索引表，不長期快取全檔。既有 project/session 登記與 operations/receipts 可保留。分頁游標及一次性的有界暫存不屬持久索引。
- 每次工作限制讀取量、memory、時間及 response bytes。大型 tool entry 採安全投影／預覽／明示截斷及按需展開。預算耗盡要回報未完成與續讀／重試方式，不得回空 history。
- 權限、越界、不支援格式或損壞須回安全原因，不暴露 raw history 或 stack。唯讀操作須確保原生檔不變。
- 暫存參照解除後可供 GC；不承諾 RSS 立即下降。Controller reader 分頁不代表原生 Pi runtime 也分頁，亦不承諾任意大小均可載入模型上下文。

## 歸檔設計：原生 JSONL reader 與安全投影

本節保存已決定的架構方向，並與目前實作對照閱讀；實作及逐案驗證狀態見本文件開頭與驗收文件。原生檔是唯一歷史來源。listing、join、runtime 與 CLI 只讀 metadata，不整檔載入或驗證 history。

- 新增 native-reader 與有界 JSON 投影 parser。安全開檔以 canonical session 目錄為根，拒絕 symlink（`NOFOLLOW`）、非 regular file 及 `nlink != 1`；對已開 fd 執行 stat，並比對開檔前後的 file identity。Header 上限 64 KiB，並驗證 cwd 與 native session ID。
- Reader 從檔尾以反向 64 KiB block 搜尋 LF，定位完整行的 byte offsets。不完整尾行忽略。沿 `parentId` 向前掃描目前分支，不建立全檔索引或持久副本。
- Parser 以串流方式消費 JSON record，不對巨大 line 呼叫 `JSON.parse` 或 `readFile`。限制 JSON depth、key 數、array 長度、string 長度與 parser retained bytes。結構欄位 `id`、`parentId` 不得截斷；payload 可截斷，但必須標示 preview/truncated。絕不回傳 system、thinking、raw stderr 或 signature。
- 歷史每頁最多 100 entries，response 不超過 1 MiB，單筆預覽不超過 64 KiB，parser retained bytes 不超過 256 KiB。大型文字 preview 為 2 KiB 至 64 KiB 的有界值。Preflight 為 256 MiB／30 秒；body scan 的 `maxReadBytes`／`maxMs` options 預設也是 256 MiB／30 秒。後兩項是 body scan 工作預算，不是整檔 size 上限。耗盡時回傳明確 `incomplete` 與 continuation，不可偽裝成空 history。Line 定位階段可續讀；極端 record 的 parse 預算超限回報 `work-budget`，不因此拒絕整個 session。
- Metadata 頁 cursor 綁定 file identity、header fingerprint、捕獲時 leaf、已讀 position、target parent 與內部 scan state。以 process-local HMAC key 簽章，最大 8 KiB；不得包含或洩漏 filesystem path，也不得接受任意 client offsets。Append 僅在祖先鏈連續時續讀。Replace、truncate 或 branch 變更回 `409`，要求重載。expectedNativeId 與內部 guard 拒絕錯誤身分與競態狀態。
- History API 回傳 `entries`、`nextBefore`、`continuation`、`incomplete`、`truncated`。UI 使用 server cursor，不從 entry ID 自行製造 cursor。
- `readNativePage` 取代 HTTP `historyPage(validateNative)`。舊 `validateNative`／`historyPage` 僅保留給有界相容小測試；產品 listing、join、RPC、CLI 不得呼叫它們讀取完整 history。
- `native-sessions` API 可維持 array 回應。錯誤 candidate 須包含安全分類的 file/id（若可得）與 error；UI 顯示且禁止選取，不可默默省略。

## 歸檔設計：RPC fresh 檢查與 reload

- 一般 POST prompt 在每個 session 既有 tail serialization 內執行 freshness 檢查。以 header 加最後完整 entry fingerprint 作為磁碟 tail 身分。呼叫 `get_entries(since=diskLeaf)`；只有結果為 empty 且 leaf ID 一致才視為 cache fresh。不可呼叫全量 `get_entries`。空檔須以安全的 state count 處理。
- 若 cache stale，僅在 session idle、queue 為零且 dialog 為零時，對同一 canonical file 呼叫 `switch_session`。驗證 `cancelled=false`、profile/provider/model/thinking、session identity，再讀磁碟 tail，並確認 `get_entries(since=tail)` 對上。明確設定 queue modes。任何未知狀態、timeout 或驗證失配都進入 blocked，保留 lease，不送 prompt。
- Busy 時不 reload。外部變動造成衝突時回 `409`。Steer、followup、compact 也須防止對 stale 狀態操作，但不可在執行中 reload。
- RPC 重新綁定時增加 runtime epoch。這是本地 listener 隔離，不代表 Pi 原生事件帶有 epoch。舊 listener event 不得覆蓋新狀態；回傳 `resync-required` 並清除 Web volatile state。這不能保證未受管理 TUI 的單 writer 或 race-free。對 uncertain `RpcError` 保留 `UNKNOWN`，不得 replay。

## 歸檔設計：唯讀取得、prompt 與相容 owner 流程

- 所有 GET route 僅讀取。不得 spawn RPC、reload session 或設定 owner。
- 舊資料若為 `desiredOwner=tui`，只有明確 POST prompt 可呼叫既有 `ensure` explicitClaim。取得 lease 並完成驗證後，正常呼叫 `ledger.setOwner(web)`；不得直接執行 DB migration。保留舊 release/claim API 與受管理 CLI 作為相容介面。UI 移除 owner 按鈕及 owner 輸入門檻。
- 保留 lease、close/join、blocked 與 no-replay 規則。GET snapshot 增加 canonical cwd、sessionDir，以及可安全 shell-quote 的原生 ID 命令；命令包含 `cd` 與 `--session-dir`，不含 token。
- UI 顯示 native ID、App ID、本機命令與使用者自管雙寫提示。重整、切換 session、reconnect 只取得 history/snapshot；send 前由 server 準備與驗證。

## ASCII 流程：UI 讀取與 POST prompt

```text
UI select / refresh / reconnect
  -> GET snapshot + native-sessions + history
  -> metadata-only listing/join; native-reader validates header
  -> readNativePage (signed server cursor; bounded scan/projection)
  -> render history + snapshot; GET has no spawn/reload/owner side effect

UI send prompt
  -> POST prompt (operation ID; no replay)
  -> per-session tail serialization + lease / explicitClaim if required
  -> compare header and disk leaf fingerprint; get_entries(since=diskLeaf)
  -> fresh: continue | stale and idle: switch_session(same canonical file)
  -> validate cancelled=false, identity, profile/provider/model/thinking,
     and disk tail; verify entries since tail
  -> valid: ledger.setOwner(web) when explicit claim applies, then prompt
  -> busy conflict: 409 | unknown/timeout/mismatch: blocked, retain lease
  -> rebind increments runtime epoch; old events ignored, resync-required clears
     Web volatile state
```

## 模組與安全錯誤分類

| 模組／邊界                | 職責                                                                              | 可見的安全結果                                                           |
| ------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Native reader / safe open | Canonical directory、NOFOLLOW、single-link regular file、fd identity、header 驗證 | `unsafe-path`、`unsupported-file`、`permission-denied`、`invalid-header` |
| Bounded JSON projector    | 串流解析、限制保留量、遮蔽敏感欄位、標示 preview 截斷                             | `invalid-record`、`work-budget`；截斷以 `truncated` 表示                 |
| History page / cursor     | Parent chain、簽章 cursor、續讀與分頁                                             | `409 reload-required`；可續工作以 `incomplete`/`continuation` 表示       |
| RPC freshness / reload    | Tail 比對、idle reload 驗證、lease 與 no replay                                   | `409 conflict`、`blocked`、`resync-required`                             |
| Native sessions API / UI  | 顯示可選及錯誤候選，不隱藏失敗                                                    | candidate 附安全 `error`，UI 顯示且不可選                                |

錯誤回應不得包含 raw history、stack、filesystem path、token、raw stderr 或 signature。確切內部錯誤名稱與 HTTP mapping 可在實作 review 確認，但不得降低上述失敗可見性或安全條件。

## 測試隔離與實作 review checkpoints

- 測試只對當下來源 bytes 的隔離 copy 執行。不得改動 repo `dist`、fixed release、正式 4317 服務或個人 history。至少涵蓋 110 MiB 合成檔、超過 32 MiB 的單行、記憶體量測、多分支、cursor 與 safe projection。
- Reload 測試涵蓋取消、timeout、identity、profile、provider/model/thinking、queue/dialog 與磁碟 tail 失配。真 model、真 TUI、個人 session 與部署須另行授權；不得將它們宣稱為本輪通過。
- 實作 review 須確認 fd identity 欄位與 fingerprint 編碼、byte/time 預算及續讀狀態的精確格式、error 到 HTTP 的 mapping、safe shell quoting 與 `ensure` explicitClaim 的既有語意。這些是實作細節檢查點，不授權改換架構或放寬本文件決定。

## 歷史歸檔授權與本次實作歸檔

較早文件曾記錄「本次只歸檔／待實作」，該段是離線實作階段的歷史授權註記，不代表目前狀態。本期後續已另獲實作、隔離離線驗證與部署授權；本次更新只歸檔既有程式與證據，不修改產品來源、測試或設定。Session Access v1 已部署，離線驗證與正式 URL 唯讀檢查通過。Owner 功能測試尚待進行；真 Pi/TUI/模型完整端到端及個人 session 仍未驗證。詳細需求與逐案例狀態見互相連結文件。
