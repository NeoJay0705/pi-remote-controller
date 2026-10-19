# 受管 Session Profile 切換 v1：設計

依據：`session-profile-switch-v1-requirements.md`。需求已確認。本設計足夠開始實作。測試與部署狀態另見驗證文件，不以設計代替執行證據。

## 1. 決策

使用既有 operation API 與 receipt。新增 `change_profile` operation。不新增另一套寫入路由。使用整份 Profile 的既有 CLI 參數，不以 `set_model` 冒充完整切換。

- 冷 session：取得短期 writer lease，核對原生檔案，保存新 Profile。不啟動 Pi。回報 `profile_saved`，明示尚未啟動驗證。
- 活 session：確認安全閒置。保留同一個 writer lease。正常關閉並 join 舊 Pi 程序群。以新 Profile 與同一個 session 檔啟動新 Pi。驗證後才保存並發布新 Profile。回報 `profile_applied`。
- 忙碌或 blocked：拒絕。不 abort、不清 queue、不排程背景切換。
- TUI desired owner：拒絕。不要把切換 Profile 解讀為 claim。
- 同一 Profile：通過預期值與安全檢查後，回報 `profile_unchanged`。不重建程序，不增加 revision。

未指定的 Profile 欄位沿用既有 defaults／原生 session 語意。既有 extensions 仍屬加載設定，不新增 extension isolation 保證。

## 2. 合約與持久化

`OperationInput` 新增僅供 `change_profile` 使用的欄位：

```json
{
  "operationId": "UUID",
  "kind": "change_profile",
  "profileId": "configured-target",
  "expectedProfileId": "saved-current",
  "expectedProfileRevision": 0
}
```

拒絕未知欄位。此 kind 不接受 text 或 UI response 欄位。其他 kind 不接受 Profile 欄位。Revision 必須是非負安全整數。無效 Profile 回傳 `invalid_profile`（400）；預期值不符回傳 `profile_conflict`（409）。

Session list 與 Snapshot 增加 `profileRevision`。新增 runtime state `reconfiguring`。Web 對此狀態關閉新寫入。

使用 additive `session_profile_revisions(session_id PRIMARY KEY REFERENCES sessions(id), revision NOT NULL)` 表。既有 session 無列時視為 0。不改既有 sessions 的六欄順序，不破壞原有建立流程或唯讀 CLI 的 version 1 相容檢查。唯讀 Ledger 缺少此 additive 表時可讀為 revision 0；需要寫入功能時由 writable open 建表。

新增 Ledger 原子提交方法。在同一 SQLite transaction 內：

1. 以 saved Profile、revision 與 desired owner 做 CAS 核對。
2. 更新 sessions.profile_id。
3. 插入或增加 revision。非 no-op 才增加。
4. 將對應 receipt 與結果寫成 ACCEPTED。
5. 提交。

runtime 不得在 transaction 成功前發布目標 Profile 為已保存。app 原有 finish 必須避免在原子提交後用不同結果覆寫成功 receipt。

## 3. Crash、失敗與恢復

沿用 operation 狀態作持久化保守屏障。不另造自動重播機制。

- `change_profile` 的 DISPATCHED／RECEIVED／UNKNOWN receipt 表示未確認的切換。Ledger 提供查詢方法。
- 本次正在執行的 switch 可排除自己的 operation ID。其他寫入與 ensure 不能排除。
- Controller 重開時沿用既有 DISPATCHED → UNKNOWN 恢復。若有未解決切換，snapshot 顯示 blocked，禁止 prompt、claim、release、compact 與其他切換。
- 在取得安全閒置證據與開始關閉前，確定的 schema、Profile、CAS、busy、owner 或 lease 拒絕可標 REJECTED，不設持久化屏障。
- 開始關閉或修改後失敗，保留 UNKNOWN。不得因已知錯誤代碼而錯標 REJECTED。使用帶 `uncertain=true` 的錯誤，並讓 app 優先採此標記。
- 新程序驗證或 DB 提交失敗：舊 saved Profile 不變；新程序不得接受 prompt。嘗試關閉新程序。無法證明清理完成時保留 lease。能完成清理仍保持此 session blocked，並保留未解決 receipt。
- DB commit 已成功但 HTTP 回應遺失：GET receipt 可確認 ACCEPTED。不重做。GET snapshot 與列表可確認保存值。
- 不自動回退啟動舊 Profile。不以 restart 當成失敗切換的自動重試。

本期不新增自動修復或管理者解鎖 API。未解決 receipt 的恢復屬離線管理作業。管理者須停止 Controller、確認舊 writer 已退出、核對 native file 身分與 operation 結果，再決定保留已提交值或確認未提交且標記該 receipt 為 REJECTED。不得刪 lock、盲改 Profile 或只重啟服務。UI 與 README 必須說明需要人工確認，不暗示重試可解鎖。這是安全優先的失敗處理取捨。

## 4. Runtime 流程與隔離

沿用 app 的每 session `tails` 序列。以最新 Ledger record 執行 operation。切換在 admission 時已忙碌或已有同 session 工作，須拒絕，不等到工作完成後偷偷套用；拒絕可在序列內建立 REJECTED receipt。重複 ID 則先回傳原 receipt。

Runtime 也要有同步設定的切換中 guard，保護直接 runtime 呼叫與 ensure／starting 的競態。跨 await 後重查 identity、revision、blocked、queue 與 pending dialogs。不要把測試對私有 map 的模擬當成唯一的整合證據。

活 session 的安全條件：

- snapshot 是 idle，沒有 reloading／starting。
- Controller queue 為零，pending dialogs 為零。
- RPC get_state 的 identity/file 正確。明確指定的 provider/model/thinking 與舊 Profile 相符。
- isStreaming=false、isCompacting=false、pendingMessageCount=0，且 protocol 型別正確。
- 原生 canonical file 與 ID 正確。新程序讀取目前磁碟 history；不使用舊記憶體上下文。

關閉前再確認 local 狀態。設定 reconfiguring 後隔離舊 event 與 failure listener，增加 epoch。不要僅移除普通 event handler，而留下 failure closure 污染新狀態。

重建期間保留同一 WriterLease fd。新程序必須等 `PiRpc.close()` 確認舊 child close 與 process group 結束後才啟動。使用既有 close deadline／TERM／KILL 程序群清理。不新增強制終止其他服務的權限。

啟動可將既有 start 分離為可重用的內部 helper，接受已持有的 lease。切換候選 runtime 必須在內部處理 queue/dialog/failure，但在提交前不得向 Web 發布目標 Profile 為已套用，不得轉發候選 runtime 的 volatile RPC 事件。驗證 identity/file、指定 provider/model/thinking、idle／queue／dialog，以及磁碟 tail 與 get_entries 對應。正常 Pi 追加設定 metadata 可接受；不可要求整檔 hash 完全不變而誤拒合法設定紀錄。

所有成功、冷修改、失敗均發 snapshot／resync-required。冷 session 的 snapshot 不啟動程序。有 unresolved switch 而無 live object 時也能顯示 blocked。

```text
Web: select session -> choose target -> Apply
  -> POST operations(change_profile, expected id/revision, UUID)
  -> auth / origin / schema
  -> session admission + tails + Ledger.begin (deduplicate)
  -> latest record + CAS + unresolved guard
  -> runtime.changeProfile
       +-- no live -> acquire lease -> inspect -> atomic save + receipt
       |                                      -> release lease
       +-- live -> RPC idle proof -> reconfiguring
                   -> detach old listeners -> close/join old group
                   -> start candidate with same lease + full Profile
                   -> verify state/history -> atomic save + receipt
                   -> publish new runtime
       +-- unsafe/failure -> reject or UNKNOWN + blocked
  -> snapshot / resync -> Web refresh list + saved/actual status
```

## 5. Web

保留側欄既有 Profile 選單，標籤維持既有測試相容性。增加說明「供新建／加入使用」。在目前 session 的 status 附近增加獨立「Session Profile」區塊。

顯示已保存 Profile 名稱／ID、待選下拉選單與「套用 Profile」按鈕。冷修改提示「已保存；Pi 尚未啟動驗證」。實際 provider/model/thinking 沿用既有顯示。不為 extensions 虛構 runtime 驗證狀態。

- 待選值與 selected session／saved Profile revision 綁定。外部變更後重設待選值，不覆寫另一個 session。
- 只有 connected、online、非 busy、snapshot idle／released、queue/dialog 為零、desiredOwner=web 時提供套用。後端仍是最終權威。
- 發送時凍結 session ID、target、expected id/revision 與 generation。
- 透過既有 UUID／receipt 記錄操作。不傳草稿 text，不清除草稿。
- 回應與 resync 必須遵守 generation／revision guard。切換 session 後的舊 HTTP 回應不能套用到新畫面。
- 成功與 SSE 外部更新須更新受管列表 Profile。HTTP 失敗顯示錯誤並允許查 receipt。網路斷線不自動重送。
- 錯誤明示 busy、conflict、locked 或未確認需人工處理，不只顯示 generic 400。
- 桌面及手機 pointer 可操作。布局維持可捲動，不壓扁 session 列表或草稿。
- 回歸證據顯示，垂直堆疊的 Profile 控制項會使手機 chat 提前觸及既有 100px 最小高度，失去視窗縮放彈性。緊湊兩列雖恢復 resize，但不足以讓短手機畫面同時顯示歷史工具列與對話首筆。最終採預設收合的原生 details：summary 持續顯示「Session Profile」與 saved 資訊；使用者展開後才顯示待選與套用。展開內容仍採兩欄緊湊布局，說明占整列。這項取捨多一次展開操作，但平時不擠壓主要對話。不得以取消 chat 最小高度、強制點擊或弱化 resize／anchor 斷言掩蓋此問題。

## 6. 實作階段與驗收

第一階段：後端、共享合約、fakePi 與後端測試。父 agent review 後才開始相依前端。

第二階段：Web、瀏覽器測試、README。父 agent review 後執行完整回歸。

測試從最小 cold switch 路徑開始，再驗 active restart。FakePi 應能依 CLI 參數回報 provider/model/thinking；以 journal 記錄啟動 argv、pid、commands 與退出。不能只以 DB ID 變更作完整 Profile 生效證據。

必要目標案例：冷修改與 Ledger 重開；活切換 full argv、close-before-spawn、同 lease、下一 prompt；busy/queue/dialog/native compact/start/release/blocked/TUI 拒絕；CAS 包含 A→B→A 舊 revision 拒絕；重複 ID／不同 payload；啟動 identity/provider/model/thinking 失配及 timeout；舊 close failure 不啟動新程序；DB failure 與未解決 receipt 重開後阻擋；舊 event/failure 不污染；HTTP 回應遺失後只查 receipt；既有 history 前綴保留。

UI 案例須真正 pointer 套用冷與活 Profile，斷言草稿保留、saved/actual 分別更新，並涵蓋 busy disable、stale multiwindow、session generation 與 reconnect 不重播。只檢查測試名稱不算覆蓋。

使用 `npm test -- <target>`、`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build`、`npm run test:e2e -- <target>`，最後全套合成測試。所有測試由 implementation-worker 執行。只使用隔離 fakePi 與本機 test server。不啟動真 Pi、付費模型或個人 session。不部署。
