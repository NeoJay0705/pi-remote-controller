# 受管 Session Profile 切換 v1：需求

## 狀態與目標

使用者已同意本需求的範圍與生效限制。目標是在 Web 對已受管的 session 切換整份已配置的 Profile。不要求移除後重新加入 session。

## 已確認現況

- `src/web/main.tsx` 的 Profile 選單僅供新建或加入 session 使用。
- `src/server/store.ts` 保存 session 的 `profileId`。`src/server/runtime.ts` 啟動時依此選擇 Profile。
- Profile 可包含 provider、model、thinking、extensions、tools、appendSystemPrompts。只更新標籤或模型不符合需求。

## 使用情境

1. 已加入但尚未啟動的 session 可改用另一份既有 Profile。後續啟動使用新設定。UI 必須說明尚未啟動驗證。
2. 已啟動且安全閒置的 session 可明確套用另一份 Profile。系統可重建此 session 的 Pi 程序。不重啟整個服務。
3. 正在執行、有排隊訊息、等待 extension 互動、正在 compact、停止、啟動、交接或狀態未知時，拒絕切換。使用者待工作完成後重新操作。
4. 選取 session 與變更新建用 Profile 是不同操作。不因選取或變更新建選單而切換既有 session。

## 功能需求

- R01：只可切換至服務已配置的 Profile。本期不提供建立或編輯 Profile。
- R02：切換適用於整份 Profile。啟動參數沿用既有設定語意。未指定的欄位仍採既有 Pi defaults／原生 session 行為，不代表清除所有隱含設定。
- R03：切換只影響指定 session。App ID、原生 Pi ID、Project、檔案位置與既有對話保持不變。不另建、不搬移、不刪除或重寫既有 history。Pi 正常追加設定紀錄不屬於重寫既有 history。
- R04：切換必須由明確套用動作觸發。UI 區分待選 Profile、已保存的 Profile 與執行時實際設定。未啟動不假稱已驗證。
- R05：僅在安全閒置時切換。不能只依 Web 的閒置顯示判斷。後端須確認執行程序、原生 queue 與待處理互動均無工作。
- R06：忙碌時明確拒絕。不自動 abort、不丟棄 queue、不自動排程稍後套用。
- R07：操作保留既有草稿。不自動送出或重播 prompt。
- R08：同一 session 的 prompt、claim、release、compact 與切換須協調。多視窗不得以過期狀態覆寫較新的 Profile。舊 runtime 事件不得覆蓋新狀態。
- R09：延續既有 writer lease 與 close/join 保護。未確認舊程序退出前不得啟動新 writer。不可刪除永久 lock。
- R10：驗證失敗、timeout、storage failure 或結果未知不顯示成功。狀態無法確認時阻擋新寫入。不自動重試切換或 prompt，也不默默回退另一份 Profile。
- R11：重啟 Controller 後，成功保存的 Profile 仍生效。失敗狀態必須有明確的保存及恢復規則，不可讓 DB 與活程序互相矛盾。
- R12：維持既有登入、Origin、JSON schema、錯誤去敏與操作 receipt 規則。

## 取捨與邊界

- 採安全閒置切換，不支援執行中熱切換。這可避免同一輪工作混用設定。
- 完整 Profile 透過既有啟動參數生效。不得宣稱所有 extensions 與背景服務均可被列舉或驗證。獨立 extension 背景服務不在既有程序群清理保證內。
- 未受管理的 Pi 不遵守 Controller lease。使用者仍須避免外部同時寫入。本功能不增加 race-free 保證。
- 對 legacy TUI 所有權與活鎖持有者須保守拒絕。不擅自搶占或變更交接規則。
- 本次不授權正式部署、付費模型、個人 session 改寫或終止現有服務。

## 驗收

- A01：尚未啟動時可修改並保存 Profile。無 Pi 啟動、無 history 寫入。重開 Ledger 後設定保留。
- A02：安全閒置時，關閉舊程序後以新 Profile 啟動。驗證 identity/file、provider/model/thinking 與實際完整啟動參數。下一個 prompt 使用新程序。既有對話保留。
- A03：busy、queue、dialog、compacting、starting、stopping、releasing、blocked、TUI writer 等情境拒絕，且不 abort、不啟動替代 writer、不改 Profile。
- A04：重複 operation ID 不重做。競態與過期預期值拒絕。舊事件不污染新 snapshot。
- A05：啟動不符、timeout、close failure、DB failure 與回應遺失有可區分斷言。失敗不放行 prompt，不誤報成功。
- A06：桌面與手機可明確選擇及套用。列表與 snapshot 更新；草稿保留；切換 session 或 reconnect 後不套用到錯誤 session。
- A07：執行相關整合測試、既有回歸測試、型別檢查、lint、build 與隔離瀏覽器驗收。合成證據不得冒充真 Pi／模型／extension 相容性證據。
