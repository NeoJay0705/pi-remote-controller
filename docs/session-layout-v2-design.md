# Session 閱讀空間優化 v2 — 設計

狀態：設計已實作，隔離驗收完成；未操作正式服務。依據 `session-layout-v2-requirements.md` 及使用者接受的兩項選擇。測試結果、過程修正與限制見 `session-layout-v2-verification.md`。

## 1. 範圍與取捨

- 精簡頁首；原本獨立的狀態／Profile／資訊區改為一個收合區。必要警告不收合。
- 移除收據面板，不改操作及收據安全機制。
- 清單新增可選時間欄位；不改 Ledger schema、不掃描歷史取得最後訊息時間。
- Compact 併入送出操作區。桌面增加草稿預設高度；手機保留全寬。
- 不新增依賴、背景輪詢或正式部署操作。

## 2. 安全的時間投影

### 2.1 資料契約

`GET /api/v1/sessions` 與 `GET /api/v1/projects/:id/native-sessions` 每筆可多出 `fileUpdatedAt?: number`，單位為 Unix epoch 毫秒。欄位不存在代表未知；不使用現在時間作替代。

- `Session`、`NativeCandidate` 的前端型別接受此欄位。
- `NativeMetadata` 增加可選 `fileUpdatedAt`。從 `inspectOpened` 已驗證的 fd.stat 結果取 mtimeMs，只投影 finite、非負、JavaScript Date 可表示的值。
- 原生候選清單沿用 inspectNative 的 metadata；不新增不安全的 stat 路徑。
- 受管清單以小型 helper 呼叫 inspectNative，確認 native ID 等於 Ledger nativeId 才取時間。任一檔案檢查失敗時只省略該筆時間；保留原本 nameInfo／錯誤投影與整份清單。
- 此 helper 每筆最多讀既有有界 header，不能讀完整 JSONL，不能寫檔、啟動 Pi 或修改 lease。
- 不要求 POST 或 Snapshot 新增此欄位。現有 create 已 refreshLists；Snapshot merge 必須保留清單時間。
- GET 回傳順序不改成新 API 保證；前端統一排序。

### 2.2 排序與顯示

新增前端純 helper（例如 `session-list.ts`）：

1. 對有效時間降冪排序；未知最後。
2. 相同時間以固定 key 的字典序升冪排序。受管使用 App ID 作內部 key，候選使用 file 作內部 key。key 不因此出現在 UI。
3. 不修改輸入陣列；filter 同一 Project 後排序。
4. 顯示「檔案更新：」加本地日期、時間及時區。可用 Intl.DateTimeFormat 的 zh-TW、hourCycle h23、timeZoneName shortOffset。未知一律顯示「檔案更新：時間未知」。
5. 受管清單每筆只顯示名稱、Pi session ID 與時間；候選 option 顯示名稱／Pi session ID／時間，保留原 disabled 與安全錯誤。

時間是載入清單當下的檔案 metadata，不是訊息或模型完成時間。不為即時串流增加刷新。重新整理及既有 create／Profile refresh 路徑會更新排序。

## 3. 精簡頁首與收合資訊

### 3.1 結構

```text
main (viewport column)
  header: [menu] [truncated name] [runtime] [connection] [設定與資訊]
  optional bounded information panel (closed by default)
    full name / native ID / App ID / Provider / Model / Thinking
    existing SessionProfile component
    cwd / session dir / command / Outcome / writer safety note
  existing visible global/session errors and runtime notices
  chatViewport (flex:1; internal scrolling)
  pending extension dialogs / visible runtime warning
  composer
```

- 資訊入口為 button，提供 aria-expanded 與 aria-controls；資訊區為有名稱的 region，收合時不 render 或 hidden，不讓收合內容保有可聚焦元件。
- `informationOpen` 初始 false；selectSession 立即設 false；logout／auth-expired 也清除。未選到有效 Snapshot 時不提供可操作的資訊入口。
- 頁首使用 flex 或 grid，名稱區 `min-width:0`、單列 ellipsis；Runtime、連線及資訊按鈕不被長名稱擠出。窄螢幕使用精簡可見按鈕文字「資訊」，accessible name 固定「Session 設定與資訊」。
- 頁首固定單列；桌面目標不超過 64px、手機不超過 60px（正常字級）。320px 寬仍不得整頁水平溢出。
- 完整值在資訊區可換行，名稱與 ID 維持文字輸出，不能插入 HTML。
- 資訊區最大高度建議 `min(38dvh, 320px)`，內部 overflow:auto、flex-shrink:0。其他主區塊不因 flex-shrink 壓縮按鈕。chatViewport 最小高度維持約 100px；不足時可讓主內容有界捲動，不裁掉操作入口。
- SessionProfile 仍保留自身 details 與既有安全條件，放在外層資訊區內；已保存 Profile 在外層展開後可讀。不得改 Profile 操作語意。
- 原 status row 與 Session 資訊 details 不再作為獨立常駐列；原複製功能與 generation guard 保留。
- blocked、lastError、extension notices、全域／Session 錯誤保持原先可見與隔離規則。不要為本輪任務重設錯誤的安全語意。

### 3.2 收據

- 刪除最近收據 section 與其專屬 CSS、僅供該 UI 的 receiptStatus state。
- 保留 receipts state、sessionStorage、checkReceipt 的內部更新、啟動時 UNKNOWN／DISPATCHED 查詢，以及提交失敗後查詢等既有機制。
- 當 submit／changeProfile catch 得到 UNKNOWN 或 DISPATCHED，所屬 Session 錯誤需補上「操作結果尚未確認；不會自動重送，請勿直接重送。」。不增加輪詢或手動查詢面板。
- 遲到操作的提示仍歸 frozen session ID；保留既有 Profile generation 限制。

## 4. 輸入區

- released／blocked 提示套用共用水平 padding，與 controls 內容左邊界一致，段落 margin 有界。
- 桌面草稿採 grid：`minmax(0,1fr)` textarea 加約 120–140px 的操作欄；Compact、Prompt、Steering、Follow-up 依序排列，Compact 在 Prompt 上方。
- textarea 以合理預設高度（例如 140px）、min-height 約 100px，保留 resize 與既有上限 200px。操作欄不與 textarea 爭奪剩餘寬度。
- <=700px 草稿為全寬，操作欄為可換行的緊湊按鈕列；不讓四個按鈕建立四層直欄。
- 只有 running 的停止列保留在草稿區上方。idle/released 時沒有空 actions 列。
- Compact disabled expression、onClick submit("compact") 原樣保留；其他按鈕 eligibility、textarea 禁用、Ctrl/Cmd+Enter 與 IME guard 不變。

## 5. 測試與驗收

所有測試由 implementation-worker 執行。只用隔離 fixture 與 fake Pi，不呼叫正式 endpoint。

### 5.1 最小驗證路徑

1. 後端新增 metadata／清單欄位及時間測試。先執行：
   `npm test -- test/unit/native-reader.test.ts test/unit/native-names.test.ts test/integration/session-names.test.ts test/integration/session-access.test.ts test/unit/session-list-time.test.ts`
   最後一個新檔可集中後端 metadata 或另用明確新檔名並回報。前端 helper 測試於前端階段加入。
2. 前端完成後，先跑 helper unit 及 typecheck，再跑新增 `session-layout` browser spec 的 desktop／mobile。最小路徑通過後才跑完整回歸。
3. 最終依序執行 `npm run check` 與 `npm run test:e2e`。兩者會建置本機 dist，但不得重啟服務；e2e 僅用 127.0.0.1:4179 fixture。若端口已被佔用，不終止未知服務或 reuse；回報阻擋。

### 5.2 斷言必須觸發的情境

- 固定 utimes 的 native 檔案時間經兩份 API 傳出；讀取不修改內容或 mtime、不啟動 Pi。
- 受管檔案缺失、native ID 不符／不安全路徑不回傳時間，不使整份清單失敗；候選原安全錯誤仍禁用。
- unit 驗證兩清單 helper 的新到舊、同時間 tie-break、缺失／NaN／無法表示日期、不 mutate；顯示時區與未知。
- browser 提供與 ID／名稱字典序相反的時間，斷言兩份清單實際 DOM 順序與標注；跨 Project、加入後排除、刷新更新。
- browser 長中文名稱／長 ID：正常 viewport 與 320px 頁首單列、無水平 overflow；名稱 ellipsis，資訊完整值可在按鍵／點擊展開後取得。
- 收合時資訊內容不可見／不可聚焦；展開面板高度有界，內部可捲；chat 及草稿仍可到達；切 Session 後收合。
- 預設沒有狀態／Profile／資訊三列；沒有最近收據 UI。Profile 在資訊區仍可套用，copy fallback 仍可用。
- released 提示與草稿 controls 內容左邊界誤差不超過 1px；桌面 Compact 垂直位置在 Prompt 上方且 textarea 比舊 62px 高；手機 textarea 全寬、操作區不成四層。
- Compact 在 idle 可觸發 compact、released／running／blocked／queue 非空禁用；Prompt 快捷鍵、停止、草稿、錯誤隔離及聊天捲動不退化。
- 網路操作失敗的 UNKNOWN 明確提示、不自動重送；不因刪除收據 UI 使測試只刪斷言。

既有 browser 測試須改用可用的 native ID／新資訊入口來識別 Session，不可為通過測試把 App ID 偷放回受管清單或常駐頁首。舊收據 UI 斷言改為 receipt 內部保存／API 或 no-replay 行為證據。

## 6. 分階段交付與預算

1. 後端欄位及隔離驗證：最多 3 輪局部修復。父 agent review 後才進入前端。
2. 前端版面、helper 與目標測試：最多 4 輪局部修復。父 agent review 後才跑最終回歸。
3. 最終回歸若出現需決策的新問題，停止受影響步驟交父 agent；不得放寬斷言或改需求。
4. 達到當次派工預算時，worker 必須停止並回報。父 agent 依實際差異與失敗證據決定是否另派具體的局部修正；不得自動延長或直接重跑至通過。本輪後續測試移轉及同步修正的證據記於驗證紀錄。

驗證結果另歸檔 `session-layout-v2-verification.md`。模型／provider、實體手機、OS 鍵盤與螢幕閱讀器未驗證時須明列。完成程式與隔離測試不等於已部署。
