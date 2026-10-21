# 工作階段續留與操作安全修正 v1 — 驗證紀錄

目標識別：`session-continuity-v1`。
狀態：**程式實作與隔離回歸完成，父 agent 已完成獨立 review。未執行正式部署或服務重啟；Safari／實體 iPhone 的原始繪圖問題仍未驗證。**

- [需求](session-continuity-v1-requirements.md)
- [設計及完整回歸後的修正決策](session-continuity-v1-design.md)

## 1. 交付內容

- `src/web/session-view.ts`：版本化、大小有界的 Project/session 識別資訊儲存與清單驗證。storage getter、方法拒絕存取與損壞內容均安全處理。寫入只投影識別欄位，不保存 Owner token、cookie、歷史或草稿。
- `src/web/main.tsx`：有效登入後還原原 session／所屬 Project；啟動檢查顯示 loading，401 顯示登入，網路／server 失敗可重試。登入與列表序號阻擋遲到回應。登出清除本頁續留與訊息，server 撤銷失敗時明示警告。
- 捲動統一由立即對齊加最多兩個連續 rAF 重新量測處理；commit 與 ResizeObserver 沿用同一路徑。切 session、登出、失效及 unmount 使舊排程失效；較舊歷史仍使用原錨點。
- `src/web/session-ui.ts` 及 Compact 入口：共用 eligibility，原生確認後才提交，取消零操作、草稿保留；不變更 operation ID／receipt／UNKNOWN 不重送語意。
- 同 Project 的 native 候選清單更新不再清除仍有效的選擇；最新回應仍必須移除已不存在、已受管或不安全的選擇。跨 Project 清空，不自動還原候選。
- 新增 `test/unit/session-view.test.ts`、`test/e2e/session-continuity.spec.ts`；擴充 `session-ui` 單元及 `basic`、`queue-stop`、`session-layout`、`project-discovery` E2E。既有 ID、hash、writer、安全與訊息操作斷言保留。

沒有修改 backend、套件／lockfile、正式設定或其他產品模組；沒有刪除未授權檔案。測試腳本有在 repository 建置 `dist`，未執行 `service:restart`、正式 endpoint 驗收或正式 DB 操作。

## 2. 最終可接受證據

所有測試均由 implementation-worker 執行。工作目錄為 repository root。Browser 使用既有 Chromium headless shell：

```text
/absolute/path/to/chrome-headless-shell
```

公開文件以示意路徑取代本機絕對路徑；原始完整命令僅保留於未提交的本機日誌。

測試伺服器僅為 `127.0.0.1:4179` 的隔離 fixture，使用 fake Pi、獨立 HOME／資料目錄；未使用真模型或個人歷史。

以下兩份最終證據是在 native 重載及 Project discovery 修正後取得，不用先前通過結果代替較晚產物：

| 命令                                                            | 結果                                                             | 日誌（相對 repository）                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run check`                                                 | exit 0；format、lint、typecheck、36 files／199 tests、build 通過 | `.test-artifacts/session-continuity-v1/final-check-after-race-fix.log` |
| `PRW_BROWSER_EXECUTABLE=<上述 headless shell> npm run test:e2e` | exit 0；13 specs、desktop 37／mobile 37，共 74 cases 通過        | `.test-artifacts/session-continuity-v1/final-e2e-after-race-fix.log`   |

父 agent 讀取最終日誌，核對修改檔案、實際觸發情境、斷言、退出碼及範圍。測試後沒有再修改產品程式或測試，僅更新本輪需求、設計及驗證文件。

## 3. 目標情境與證據強度

### 3.1 續留與登入

- `session-continuity` 由 UI 選非預設 Project 與 primary session，檢查 storage 恰為 version/projectId/sessionId；reload 後核對相同 header ID、Project 值與具識別性的歷史訊息，operation POST 不增加。
- `basic` 使用隔離 Fastify 的真實登入 cookie，建立 session、送出 prompt 後 reload；確認 header 仍為新建 App ID、沒有登入表單、done 恰一筆且 operation ID 數仍為一。這補足 mock me200 不能證明真 cookie 整合的限制。
- 匿名及失效登入 reload 顯示 login，重新登入能還原。明確登出後 key 為空、畫面清空，再登入不還原原 session。
- `/me` network failure 與實際 HTTP 500 均觸發後才重試。啟動 pending 時沒有 token 表單。這不是延長登入期限或自動驗證 token。
- 損壞 storage、`window.sessionStorage` getter 拋 SecurityError、session 被移除及 Project 不存在都觸發 fallback；session 無效時保持空 selected，不選其他 session。
- gate 阻擋 bootstrap，派送 auth-expired 後釋放真正 HTTP 200；等待 response 完成及兩個 rAF 後仍為 login，沒有 header/history。
- logout request abort 時仍清本頁 view，但明示 server 登入未確認撤銷；不聲稱 cookie 已失效。

### 3.2 回到最新

- 歷史有 60 則訊息，先確認 scroller overflow 大於 100px，再向上閱讀及只做一次真實 click。
- 除底部距離 <=2px，還確認最新文字非空、具識別內容，並以**實際聊天 scroller** 的矩形檢查 latest entry 水平／垂直相交。不是使用 request-group 的 parent 矩形，也不是只檢查 DOM 存在。
- 隨後串流造成的 scrollHeight 確實增加，保持追尾；向上閱讀後再次增加內容，跨三個 rAF 檢查 scrollTop 與訊息 anchor 不變。
- click capture 階段確實捕獲待執行 frame（數量 >0）。切 secondary 後，在新 session pinned=true 的同步區段執行舊 callbacks，scrollTop setter 呼叫數為零；另在新 session 上捲後重做舊 callback，仍不拉回且 ID／歷史為 secondary。
- 舊歷史補頁錨點、串流、resize 由既有 `session-ui-behavior` 回歸保留。

這些證據支持前端對齊與時序防護，不證明 Safari compositor 已繪出原問題中的空白區。

### 3.3 Compact 與旁側回歸

- confirm 取消時零 POST，接受後恰一個 compact 操作，草稿保留。原生 confirm 不新增可繞過的送出捷徑。
- eligibility 單元涵蓋 online、connected、busy、queue、runtime 與 snapshot；layout／queue-stop 保留 disabled、不直接繞過、停止及 UNKNOWN 不重送驗證。
- native 候選延後回應測試先等待 request 開始，再於 pending 與成功接受新列表後檢查保留；加入新候選作為 response 已被接受的辨識。移除候選後清空選取，跨 Project 不還原。
- Project discovery 先等新 App ID 成為目前 header，才打開資訊核對 Pi ID；沒有放寬成接受舊 ID。

## 4. 過程失敗與修正紀錄

保留失敗證據，不把重試數或工具 completed 當作驗收：

1. 初期 worker 沒有建立專用 spec，命令回 `No tests found`；該輪未驗證。後續補建測試。
2. 使用完整 chrome binary 啟動曾 SIGTRAP；不是產品 assertion 失敗。父 agent 改為既有 headless shell，先獨立 setContent smoke 成功，才進入 browser 驗收。沒有安裝 browser 或切換 worker model。
3. 初期專用 spec 的 header role、手機 sidebar、about:blank storage、資料高度與未等待 response 等錯誤，經父 agent review 逐項補正。另補正相交對象與 pinned=true 舊 frame 斷言。先前只通過無效斷言的結果不作最終依據。
4. 第一輪完整回歸為 70/72（`final-e2e.log`）。父 agent 讀 trace 後決定修正 native 候選重載狀態，以及 Project discovery 測試同步；局部 38 cases 通過，再 review，最後完整 74/74。沒有可靠早期 baseline，所以不宣稱這兩項必然是既有問題或本輪才引入。

局部主要證據包括 `review-evidence-fix-01.log`、`final-safety-02.log`、`regression-race-fix-20261020T181317Z.log`。最終結果仍以前節修正後完整回歸為準。

## 5. 限制與尚待確認

- **未驗證 Safari／實體 iPhone。** 現有 mobile 專案是 iPhone 13 viewport 的 Chromium，不是 iOS Safari。原始「第一次回到最底但文字沒有繪出、補滑動才出現」沒有在真機重現，也沒有真機修正後證據。
- 未獨立測試遲到 manual-login／logout-failure 在後續驗證循環的全部排列；程式有序號保護，已測 bootstrap late-200，不把它當成所有排列的覆蓋。
- native selection 新測試直接覆蓋移除與跨 Project；無效 ID／error／已受管分支由程式檢查及既有清單安全案例支持，沒有逐一建立同樣延後回應的排列測試。
- 不保存草稿、精確閱讀位置、展開面板；sessionStorage 不承諾跨分頁或跨裝置。登入 cookie 過期或 server 記憶體登入 map 隨重啟消失時，仍需重新登入。
- 未執行正式部署、重啟或正式 endpoint 驗收；不對正式 instance 當下版本、狀態或瀏覽器快取作已驗證宣稱。未建立 commit。

結論：本輪程式與隔離自動化驗收已完成；原始 iPhone 視覺問題是否完全消除，必須在有授權的部署與實體裝置上另行確認。

## 後續回報：慣性滑動中的明確跳轉

使用者其後確認靜止時正常、慣性滑動中按回到最新仍異常。本文的 74 cases 沒有覆蓋該時序，不能用來證明它通過。後續先取得修改前舊 scroll 競態失敗證據，再完成專項修正與 84 cases 回歸；詳見 [session-scroll-momentum-v1-verification.md](session-scroll-momentum-v1-verification.md)。此連結不改寫本文較早的歷史證據，也不把後續 Chromium 結果當成實體 iPhone 的繪圖驗收。
