# 工作階段續留與操作安全修正 v1 — 設計

狀態：已實作；父 agent 完成獨立 review，修正後隔離 check（199 tests）與 browser 回歸（74 cases）通過。Safari／實體 iPhone 未驗證，未執行正式部署或重啟。依據 [需求](session-continuity-v1-requirements.md)。
共同前綴：`session-continuity-v1-`。證據、過程修正與限制見 [驗證紀錄](session-continuity-v1-verification.md)。

## 1. 實作前確認的事實與待驗證假設

- `src/web/main.tsx` 初始 authenticated=false，啟動時 `api.me(false)` 成功後只載入清單。selected 沒有持久化，因此有效 cookie 也不會還原 session。
- `src/server/auth.ts` 使用記憶體登入 map 與八小時 HttpOnly cookie。服務重啟或 cookie 失效仍需重新登入。本次不修改 auth backend。
- 現有回到最新在 click handler 立即設定 scrollTop。useLayoutEffect 監看內容但沒有 isPinned dependency；ResizeObserver 也直接設定 scrollTop。缺少統一、可取消的畫面更新後對齊路徑。
- CSS 未使用 content-visibility 或訊息虛擬化。目前沒有證據證明 iPhone 問題是訊息資料缺失、Safari compositor、鍵盤或其他特定根因。延後版面對齊是待驗證的修正方向，不是已確診根因。
- Compact 現在直接 submit，只有按鈕 disabled 條件檢查 idle/queue；submit 共用 guard 未完整重查 Compact eligibility。
- Playwright mobile 使用 Chromium，現有本機 cache 沒有 WebKit。不得把該測試當成 Safari 繪圖證據。

## 2. 啟動與續留設計

新增小型前端純 helper `src/web/session-view.ts`，封裝版本化資料的解析、驗證、儲存／移除及還原目標選擇。key 為 `prw-session-view-v1`；值為 `{version:1, projectId:string, sessionId?:string}`。輸入總長上限 2048、單一 ID 最長 256。僅接受非空字串及已知版本。storage 存取必須 try/catch。測試不得把 token 放入此資料。

- 啟動有 checking／ready／probe-error 狀態。checking 顯示「正在確認登入狀態…」，不 render 登入表單。probe-error 顯示安全錯誤與「重試登入檢查」按鈕。
- `api.me(false)` 401 結束 checking，顯示原登入表單，不派送 auth-expired。其他錯誤保持 probe-error，按需重試，不輪詢。
- 首次成功 me 或手動 login 後共用清單載入與還原流程。調整 refreshLists 回傳其已接受的清單資料；維持 generation/request serial 防護，不讓不被接受的結果驅動還原。
- 在還原流程完成前不得由初始空 state 覆寫 storage。實作在接受清單後讀取儲存目標，再驗證與還原；沒有初始 state 的自動儲存 effect，因此不會先清掉目標。新驗證循環採序號或 epoch；登出／auth-expired 會使舊循環失效。回應每次跨 await 後均重查有效性。
- 儲存 session 存在，且其 Project 存在：設定該 Project，透過原 `selectSession(id)` 取得 snapshot/history 並連線 SSE。否則只還原有效 Project 或現有預設，不自動選其他 session；丟棄過期 sessionId。
- 使用者明確選 session 或 Project 時更新續留資訊。選中 session 為主要閱讀目標；還原時以清單中 session.projectId 為準，不信任 storage 的關聯。不得因 refreshLists、Profile 更新或重連反覆重新選 session。
- 登出同步使啟動流程失效並清除 storage；清除 selected 與舊畫面狀態，不能等遲到 bootstrap 把畫面重新登入。保留現有 logout request，不增加 token 儲存。請求失敗時明示本頁已登出但不能確認 server 登入撤銷；遲到失敗不得蓋掉新驗證循環的錯誤，不自動重試。
- auth-expired 清除 selected/snapshot/entries 等可見舊內容並使啟動流程失效，但保留 storage 供成功重新登入後還原。Session 載入失敗保留既有重試載入 UI。清單失敗顯示可讀錯誤，不假裝匿名或空清單成功。

```text
page load / retry
  -> me(false)
     -> 401: login form -> POST login
     -> network/5xx: retryable probe error
     -> valid: load projects + profiles + sessions
  -> validate stored view against accepted lists
  -> set project -> selectSession(id)
  -> GET snapshot + history -> render -> SSE
  -> no operation POST / no replay

explicit select -> save identifiers only
logout -> invalidate bootstrap + clear stored view + existing logout request
```

## 3. 捲動設計

在 main.tsx 統一「跟隨最新」的 DOM 對齊，不引入新套件或強制重掛 Conversation。

- 建立穩定 callback：立即將 container.scrollTop 對齊 scrollHeight，再排程有界 requestAnimationFrame（最多兩個連續 frame）重新量測、對齊。每次新排程取消前一次 frame。
- frame 必須確認相同 container、相同 generation、仍 pinned；條件失效則停止。unmount、selectSession、auth-expired、logout 取消排程。
- click 設 pinned/isPinned=true，經共同對齊 callback 處理。useLayoutEffect 加入 isPinned 依賴，在 React commit 後重新對齊。內容更新、送出訊息後的追尾及 ResizeObserver 採相同路徑。
- pendingAnchor 的較舊歷史補頁優先，保留現有高度差閱讀錨點。不對 unpinned 內容變動呼叫追尾。
- 不採用 window scroll、任意毫秒延遲、無限 rAF、整段 repaint hack、重新 fetch 或虛擬化。若測試發現需要改變此架構，停止交父 agent 判斷。
- 保持 onScroll 底部 48px 的既有語意；使用者捲離底部後舊 frame 不得再拉回。只在 pinned 時使用 ResizeObserver。

```text
back-to-latest / pinned content commit / pinned resize
  -> alignLatest()
  -> immediate align -> frame 1 remeasure -> frame 2 remeasure -> stop
     each step: same generation + same element + pinned?
  -> scroll away / session switch / logout -> stop old frames
```

此方案驗證的是版面時序與可見內容，不宣稱能保證 iOS compositor 行為。實體 iPhone 一次點擊後不需補滑動，仍為另列驗證項。

## 4. Compact 二次確認

保留 Compact 位置，使用 `window.confirm`，降低 modal focus、手機鍵盤與 backdrop 複雜度；此操作頻率低，原生阻塞對話可接受。文字例：「確定要 Compact 目前 session 嗎？這會壓縮對話上下文，不會送出草稿。」

- 新增共用 canCompact 條件：online、connected、有 snapshot、非 busy、idle、queue.length===0。按鈕及 submit("compact") 都檢查，維持 server 的最終安全檢查。
- 點擊先檢查 eligibility，儲存 sessionId/generation，顯示確認。取消直接 return；不建立 operation ID、不改草稿。接受後確認 session/generation 未變且仍可操作，才 submit。
- 所有前端 Compact 入口均經確認。一般 Prompt 快捷鍵不改；既有 receipt 與 no-replay 不改。

## 5. 隔離驗收與交付階段

所有修改及測試委派 implementation-worker。父 agent 負責文件、設計及獨立 review。不得操作正式服務、正式 endpoint、私人歷史、DB 或 service:restart。允許既有測試腳本原地 build dist；不啟動正式 instance。不得安裝依賴或 browser。

### 階段 A：實作與目標測試

允許改 `src/web/`、必要 `test/unit/`、`test/e2e/`，不改 server/auth、安全政策、套件或 lockfile。新增 `session-view` 單元及 `session-continuity` browser spec；更新既有 Compact 案例以接受確認視窗，不刪除原驗收斷言。

1. 最小路徑：`npm test -- test/unit/session-view.test.ts test/unit/api-auth.test.ts`、`npm run typecheck`。
2. 通過後執行 `npm run test:e2e -- test/e2e/session-continuity.spec.ts test/e2e/session-layout.spec.ts test/e2e/session-ui-behavior.spec.ts test/e2e/queue-stop.spec.ts`，使用已存在的 Chromium executable，必要時以 PRW_BROWSER_EXECUTABLE 指定絕對路徑。
3. 測試 fixture 須能在 reload 後仍回 authenticated=true，而不只是登入一次的 mock；證明重新整理前後 session/header、非預設 Project、history 最新文字相同，operation POST 數不增加。
4. 涵蓋匿名、401、network probe retry、失效 session/project、損壞 storage、storage 拒絕、logout 及遲到 bootstrap。斷言必須區分錯誤還原與正確目標，不只檢查頁面沒有 crash。
5. 捲動測試使用一次真實 click/tap；檢查最新文字非空、底部距離、最新 entry 與 viewport 相交。延後 frame 增高內容，並確認仍追尾；使用者向上與切 session 後不得被舊 frame 拉回。保留舊歷史 anchor、串流及 resize 測試。
6. Compact 取消零 request、接受一 request、草稿不變、非 idle/queue/offline 不可繞過。先證明最小測試能啟動，再跑目標集合。

本階段最多三輪局部修正。遇基礎環境阻擋、需求或架構新決策即停止回報。父 agent review 後才啟動階段 B，不自行延長預算或放寬斷言。

### 階段 B：完整回歸

父 agent 接受階段 A 後，另派執行 `npm run check` 及 `npm run test:e2e`，存下命令、退出碼及完整日誌。失敗需回報原因，不自動改無關檔案。browser 只用 127.0.0.1:4179 fixture，端口衝突停止，不 reuse 或終止未知服務。

最終文件依證據分開列：程式完成、隔離測試通過、未部署、未驗證 Safari／實體 iPhone。不用 Chromium 幾何斷言替代實機繪圖結論。

### 完整回歸後的局部修正決策

首輪 `npm run check` 通過（199 tests），完整 browser 70/72。父 agent 讀取失敗 trace 後確認兩個時序問題，沒有可靠證據宣稱它們在較早版本必然不存在：

1. 同一 Project 的 native listing 因 sessions 更新而重載，現有 effect 無條件清空選項與 nativeFile。Trace 顯示初始 native response 與手動 refresh 的第二份 response 交錯，使用者剛選的有效 candidate 被清除。修正為：Project 改變才立即清空；同 Project refresh 保留選項及目前選取，接受最新 response 後再驗證 selection，已不存在、已受管或不安全的候選必須清除。既有 nativeGeneration／abort 防 stale 回應保留。這是有界的輸入狀態修正，不改 import API／授權。新增延後 response 的隔離案例驗證有效選擇保留與失效選擇清除，不靠重試掩蓋。
2. Project discovery 測試在 POST create 回應後，未等前端完成 refreshLists/selectSession，就打開仍屬舊 session 的資訊面板。測試改為先等待 response 的 App ID 成為目前 header，再核對 Pi ID 與原有分組／檔案斷言，不放寬正確 ID 的斷言。

先委派上述局部修改及相關 browser specs，父 agent review 後才重新跑完整回歸；不直接反覆重跑完整集合。
