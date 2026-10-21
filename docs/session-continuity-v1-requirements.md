# 工作階段續留與操作安全修正 v1 — 需求

目標識別：`session-continuity-v1`。
狀態：需求已歸檔；程式與隔離自動化回歸完成。Safari／實體 iPhone 的原始繪圖問題仍待驗證；不包含正式服務部署。
設計見 [session-continuity-v1-design.md](session-continuity-v1-design.md)，結果與限制見 [session-continuity-v1-verification.md](session-continuity-v1-verification.md)。

## 1. 使用情境與需求完整性

1. 使用者正在閱讀某個 Project 的 session，重新整理同一個瀏覽器分頁。若登入 cookie 仍有效，應回到該 session，而不是停在未選 session 的初始畫面。驗證登入期間顯示載入狀態，不閃現登入表單。
2. iPhone 使用者向上閱讀後按一次「回到最新」。最新訊息應進入可見畫面，不需要再按一次或手動滑動。保留閱讀舊訊息、載入較舊歷史時的閱讀位置。
3. 使用者可能誤按與訊息送出按鈕相鄰的 Compact。必須明確二次確認才可送出壓縮操作；取消不改變草稿、不送 request。

需求足以採取有界設計。預設「當前頁」指同一分頁的 Project 與受管 session，不含草稿、展開面板、精確捲動位置、新分頁或跨裝置同步。這些不是本次驗收條件。

## 2. 續留與安全限制

- 登入由原有 HttpOnly cookie 及 server 驗證。不得將 Owner token、cookie、訊息或草稿寫入續留儲存，不延長八小時期限，不增加自動登入或背景操作。
- 只儲存版本化 Project/session 識別資訊於 sessionStorage。重新整理只執行既有唯讀清單、snapshot、history、SSE 路徑，不啟動 Pi、不接管 writer、不重送 operation。
- 必須先完成登入及清單驗證，再還原仍存在的 session；還原該 session 所屬 Project。無有效 session 時可還原仍存在的 Project，否則使用既有預設 Project，保持未選 session。
- 無效、過大、損壞、已移除的儲存或 storage 不可用不能使應用崩潰。不把儲存的識別資訊當成授權。
- 401 顯示登入表單。登入檢查遇網路或非 401 失敗須顯示可重試錯誤，不能當作密碼錯誤。清單或 session 載入失敗須保留明確錯誤／既有重試入口。
- 明確登出清除續留目標。登入失效清除畫面上的舊 session；可以保留續留目標供重新驗證成功後還原。遲到的登入、清單或 session 回應不得蓋掉新選擇或登出狀態。

## 3. 捲動與 Compact

- 回到最新不重新取 history、不重建整段訊息、不加入永久輪詢或無限制動畫。
- 對齊須涵蓋 React 更新完成及後續版面尺寸改變。取消舊 session 的排程，使用者向上閱讀後不得被舊排程拉回。
- 測試除底部距離外，須確認最新訊息內容與 viewport 相交。DOM 可見及座標不等於實體 Safari 已完成繪圖。
- Compact 使用原生確認視窗，說明壓縮目前 session 的上下文。取消為安全選項，接受後仍檢查 eligibility。一次接受最多一個 operation，沿用既有 operation ID、receipt、UNKNOWN 不重送及 server 防護。
- Released、running、blocked、stopping、離線、斷線、busy 或非空佇列不得執行 Compact。不變更 Prompt／Steering／Follow-up 快捷鍵。

## 4. 驗收與非目標

- 隔離 browser 測試：有效登入重新整理恢復 session（包含非預設 Project）、匿名啟動、失效登入、失效儲存、storage 拒絕、被移除 session、登出後不還原，以及遲到啟動回應。
- 捲動測試：一次回到最新、實際最新文字與 viewport 相交、延後的內容高度更新、持續串流、向上閱讀不拉回、切 session 取消舊排程。
- Compact 測試：取消零 POST、接受一 POST、保留草稿、禁用狀態不繞過；同步既有直接點擊 Compact 的案例。
- 執行靜態檢查、單元／整合及 browser 回歸，僅使用隔離 fixture 與 fake Pi。
- 既有 mobile 專案以 iPhone viewport 執行 Chromium，不是 iOS Safari。若環境沒有 WebKit／實體 iPhone，明列未驗證，不聲稱原機問題已確診或已通過。
- 不操作正式 endpoint、不查正式 DB、不掃描私人 session、不重啟服務、不呼叫真模型、不安裝新 browser 或依賴。部署與實體 iPhone 確認另行處理。
