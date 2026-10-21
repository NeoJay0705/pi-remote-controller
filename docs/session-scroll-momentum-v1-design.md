# 慣性捲動中的回到最新 v1 — 設計

共同前綴：`session-scroll-momentum-v1-`。
狀態：依據 [需求](session-scroll-momentum-v1-requirements.md) 與修改前最小失敗證據完成實作；父 agent 獨立 review、隔離 check（210 tests）及完整 browser 回歸（84 cases）通過。Safari／實體 iPhone 原生慣性及繪圖仍未驗證，未執行正式部署或重啟。證據、檔案復原事故與限制見 [驗證紀錄](session-scroll-momentum-v1-verification.md)。

## 1. 已確認事實與證據界線

- 修改前的 `main.tsx` onScroll 無條件由底部距離更新 pinned；alignLatest 的延後 frame 在 pinned=false 時直接退出。該版本不能區分舊慣性 scroll 與新的閱讀操作。
- 最小測試 `late momentum scroll after latest click keeps the latest position`：一次真實 click 後、對齊 frame 執行前，注入離底 240px 的 scroll，再執行捕獲的 frame 及三個 native rAF。Desktop/mobile 均仍離底 240px、latest 不與實際 scroller 相交、按鈕仍顯示。
- 修改前 source checksum 在 `.test-artifacts/session-scroll-momentum-v1/baseline-source.txt`；命令、失敗斷言與數值在 `baseline-race.log`。產品 bytes 未因前置驗證而改變。
- 這是有效的應用事件競態證據。它不是原生 iOS 慣性、compositor 或線上版本的證據；沒有把 Chromium 合成 scroll 當成真機重現。

## 2. 方案與取捨

不用「增加更多次 rAF」或只隱藏按鈕。改為一個有界的聊天捲動控制器，將以下意圖分開：

1. 普通內容追尾：沿用 pinned 與現有的立即對齊、最多兩個 rAF；不搶走閱讀舊訊息的位置。
2. 明確回到最新：先短暫中止聊天 scroller 的原生捲動，再對齊。建立「最新優先」意圖；沒有新使用者輸入的舊 scroll 不能將它改成閱讀模式。
3. 新的閱讀輸入：釋放最新優先意圖、取消舊排程及暫時樣式，再讓實際 onScroll 決定是否離開底部。

原生慣性的中止措施為暫時將**聊天 scroller** 的 overflow-y 設 hidden，跨一個 rAF 還原，不修改 body、側欄或 Conversation DOM。這是局部捲動控制，不是強制重掛訊息或整段 repaint。此 browser 策略在實體 iOS 上仍待驗證；不宣稱能保證 compositor 行為。

為避免舊慣性晚於兩個 frame 才到達，成功置底後保留最新優先意圖，直到新的閱讀輸入或 lifecycle 取消。它不設 timer、不永久排程；只有 scroll／內容尺寸改變時才處理。實際新閱讀輸入會在 scroll 發生前釋放，不能永久鎖住聊天。

## 3. Controller 契約

新增 `src/web/chat-scroll.ts`，factory `createChatScrollController`。參數為 getContainer、getGeneration、getPinned、setPinned，另可注入 requestFrame/cancelFrame 作單元測試。預設 rAF 在呼叫時取 window 函式，不在建立時綁死，以保留既有 browser fixture 的能力。

回傳方法：

- `alignLatest()`：普通追尾。先確認同一 element/generation 及 pinned；立即對齊，最多兩個 frame。新的排程使舊序號失效。明確跳轉的暫停階段進行中時，不由 commit／ResizeObserver 重新啟動或延長該階段。
- `jumpToLatest()`：僅明確按鈕使用。取消前一工作，保存原 element 與 generation，取得最新優先意圖，執行下面的兩階段跳轉。
- `onScroll(element)`：若有有效的最新優先意圖，偏離底部時重新對齊，不將這個 scroll 當成新閱讀；跳轉階段中不得因此取消它。若沒有該意圖，沿用底部 48px 的 pinned 語意。
- `interrupt()`：新閱讀輸入使用。取消 frame、釋放意圖、還原暫時樣式；不預先假裝使用者已離底，也不阻止 browser 預設輸入。隨後的真實 scroll 更新位置狀態。
- `cancel()`：同上，但供切 session、loadOlder 進入錨點閱讀、auth-expired、logout、unmount 使用，不對已 unmount 的 React state 寫入。

所有 callback 同時檢查工作序號、element identity 與 generation；取消過的 callback 就算已出隊而遲到，也不能再寫 scrollTop。舊 element 的樣式由該工作的保存參照還原，不可誤改新 element。

## 4. 明確跳轉的執行流程

保存 overflow-y、scroll-behavior 的原 inline 值與 priority。短暫使用 `overflow-y:hidden !important` 與 `scroll-behavior:auto !important`，確保不被 smooth scroll 轉成另一段動畫。只操作這兩個 longhand，還原時保留原值／priority；原本沒有 inline 值就 removeProperty。

```text
back-to-latest click
  -> cancel previous work and restore its styles
  -> capture element + generation + work serial
  -> acquire explicit-latest intent
  -> save style values/priorities
  -> overflow-y:hidden; scroll-behavior:auto
  -> read clientHeight to apply local scrolling change
  -> scrollTop = scrollHeight
  -> frame 1: validate ownership
       restore overflow-y -> measure -> align again
  -> frame 2: validate ownership
       align -> restore scroll-behavior -> verify real bottom
       success: keep latest intent, no more scheduled frames
       failure: release intent, show position-derived button

old scroll while latest intent is valid
  -> align to latest, not unpin

new chat pointer/touch/wheel/scroll-key input
  -> interrupt -> restore styles + invalidate frames + release intent
  -> default browser scroll -> ordinary onScroll / pinned calculation
```

- 成功必須到真實底部（容許 2px 幾何誤差）。不能只把 state 固定 true。若 browser 不接受 scrollTop、element 消失、generation 改變或操作中止，釋放樣式／意圖，不留下 hidden overflow；本頁仍能閱讀及重試。
- 處理失敗採安全 fallback：取消局部跳轉、恢復樣式，仍存在的當前 element 由實際位置更新 button，不新增輪詢／請求。無需新增全域錯誤面板。DOM/style 或排程失敗也要先 cleanup。
- 原始順序仍需受控：較舊歷史的 pendingAnchor 優先，建立錨點閱讀前 cancel，不讓最新優先意圖把補頁位置拉回。

## 5. React 整合與輸入邊界

- 用 stable ref 持有 controller。原 alignLatest 成為薄 wrapper；替換分散的 scrollFrame cleanup，沿用 scrollGeneration 作跨 session 邊界。共用控制器避免普通追尾與明確跳轉各有一套互相取消的 frame。
- 回到最新按鈕改用 jumpToLatest；onScroll 轉交 controller。submit 的普通追尾、layout effect、ResizeObserver 不取得新的明確跳轉意圖。
- scroller 綁定 onPointerDown、onTouchStart（相容 fallback）、onWheel 及捲動導向 onKeyDown（ArrowUp/Down、PageUp/Down、Home/End、Space；IME 組字不介入）。只釋放意圖，不 preventDefault、不 stopPropagation。
- 最新按鈕是 scroller 的 sibling，它自己的觸碰不會被當成聊天區的新閱讀取消。移除按鈕的舊 optimistic pinned/align 入口，所有明確跳轉由 controller 負責。
- 本輪不修改 API、登入續留、Compact、後端、layout 高度或訊息 DOM。

## 6. 驗收與委派階段

父 agent 負責需求、設計、決策與 review；產品及測試修改委派 implementation-worker。保留全部前輪未提交變更，不做 reset、rollback 或 commit。

### A. 實作與目標證據

允許 `src/web/main.tsx`、新 `src/web/chat-scroll.ts`、新 `test/unit/chat-scroll.test.ts`，以及必要 `test/e2e/session-continuity.spec.ts`、`test/e2e/session-ui-behavior.spec.ts`。不為本方案擴大 CSS/global 或 browser 設定。

1. 單元用可控 element/style/rAF 測 controller，不需新依賴。涵蓋舊 scroll 在兩階段中及成功後到達、最新意圖不被普通 align/ResizeObserver 延長、新輸入取消、generation/element/已取消 frame 無寫入、兩個 frame 後不留排程、原值與 !important 完整還原，以及 scrollTop 不接受／DOM 操作失敗的 cleanup。
2. `npm test -- test/unit/chat-scroll.test.ts` 與 `npm run typecheck`，通過後先跑既有最小 race case，再跑 continuity/behavior browser specs。
3. 基準 case 目前在 dispatch scroll 後才讀 injectedBottomDistance。若新 onScroll 同步修正位置，應把該量測移到**dispatch 前**，仍須斷言確實曾離底 >48。這只是正確量測注入，不放寬最終 bottom/文字相交/button/API 斷言。保留原失敗 log/checksum。
4. Browser 補充：在暫時鎖定階段與成功置底後分別注入無新輸入的舊 scroll；新 pointer/touch/wheel/key 後上捲則不得再拉回；暫時樣式還原到原值；切 session、auth-expired/logout 中止後不鎖住。記錄實際 request 與 operation 數不增加。
5. 舊 browser spec 中把 `scrollTop=...; dispatch(scroll)` 當作「使用者又向上閱讀」的地方，在明確回到最新之後需要先派送對應的新閱讀 input，再做位移。這是補足新輸入語意，不可對「舊慣性」案例加 input，也不可刪除原 anchor/growth 斷言。
6. Browser env（公開示意路徑）：`PRW_BROWSER_EXECUTABLE=/absolute/path/to/chrome-headless-shell`。先 `npm run test:e2e -- test/e2e/session-continuity.spec.ts --grep 'late momentum scroll after latest click'`，再 `npm run test:e2e -- test/e2e/session-continuity.spec.ts test/e2e/session-ui-behavior.spec.ts`。

本階段最多三輪局部修復。新架構決策、環境阻擋、預算耗盡時停止回父 agent；不能自行改策略或換 model。

### B. 完整回歸

父 agent review 接受 A 後，另派只執行 `npm run check` 及同 browser env 的 `npm run test:e2e`。每命令一次，失敗停止，不反覆跑到通過。若需修改，由父 agent 依具體證據另定局部任務。

全部命令／完整輸出／退出碼存 `.test-artifacts/session-scroll-momentum-v1/` 新檔，不覆蓋 baseline。測試只用 127.0.0.1:4179 fixture/fake Pi；允許既有腳本 build dist，但不正式服務／endpoint／DB／個人 session 操作，不重啟，不安裝browser/依賴。

## 7. 真機驗收界線

自動化證據只支持競態、幾何及清理。iPhone 驗收仍應在有授權的版本上：向上或向下快速滑動，手指離開但畫面還在動時按一次回到最新，觀察確實到底、訊息繪出且按鈕消失；再確認新的向上閱讀仍有效。未取得實機結果前，不宣稱已修復 iOS 原生慣性或畫面不完整問題。
