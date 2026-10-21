# 慣性捲動中的回到最新 v1 — 需求

目標名稱：**慣性捲動中的回到最新**。
共同前綴：`session-scroll-momentum-v1-`。
狀態：已先建立修改前失敗證據，再完成程式、父 agent 獨立 review 與隔離回歸。Safari／實體 iPhone 原生慣性及繪圖仍未驗證。
[設計](session-scroll-momentum-v1-design.md)／[驗證與限制](session-scroll-momentum-v1-verification.md)。前一輪與限制見 [session-continuity-v1-verification.md](session-continuity-v1-verification.md)。

## 1. 使用者提供的情境

- 裝置為 iPhone。畫面靜止時，按「回到最新」正常。
- 手指已放開、聊天仍在慣性滑動時，按一次「回到最新」會出現問題：看似飛到最底，但按鈕仍在，畫面訊息不完整；可能還需再按或滑動。
- 使用者指出主要條件為「滑動時按」，不是單純資料更新速度或靜態捲動座標問題。

本輪不需要使用者再提供 session 內容即可設計。iOS／Safari 版本、實際服務版本與 compositor 的細節仍未知；不得把假設寫成已確診根因。

## 2. 正確行為

1. 慣性尚未結束時按一次「回到最新」，應中止舊捲動並到達最新已載入訊息。待版面穩定，最新訊息底端在聊天視窗內，可見區域正常繪出、沒有未更新的空白或缺片，按鈕消失。長於視窗的訊息不要求一次顯示全文。
2. 按鈕狀態與實際位置一致。不能只隱藏按鈕或強制 pinned=true 掩蓋沒有到達底部。
3. 點擊前的舊捲動事件不得取消這次明確跳轉；點擊後新的向上閱讀操作則必須能中止跳轉，不可鎖住聊天或反覆把使用者拉回。
4. 靜止時點擊、串流追尾、resize、較舊歷史閱讀錨點、session 切換、登出與登入失效都不能退化。舊排程不得影響新 session。

## 3. 限制與取捨

- 只修改聊天捲動行為及必要測試，不改登入續留、Compact、資料 API、訊息投影或 backend。
- 不藉由重新 fetch、重掛整個 Conversation、刪除訊息、永久停用觸控、無限 rAF／輪詢或任意長時間鎖定來處理。
- 允許短暫、可還原的聊天 scroller 捲動控制以中止慣性；是否採用及階段數由最小證據與父 agent 設計決定。不可影響 body、側欄或整頁捲動。
- 錯誤／取消、session 切換、unmount、登出、auth-expired 都必須釋放暫時樣式與排程。失敗不能留下 overflow 鎖定，且不能假裝到達底部。
- 保留目前所有未提交修改，不 rollback 前一輪成果、不改 package／lockfile、不安裝 browser 或依賴、不操作正式服務或 endpoint、不掃描私人 session／DB、不呼叫真模型。

## 4. 證據與完成定義

- 先在當前程式建立最小可控制的「click 後、對齊 frame 完成前收到舊 scroll」失敗案例。它只證明應用事件競態，不代表模擬了 iOS 原生慣性或 compositor。
- 修正後斷言同時包含：底部距離、最新文字與實際 scroller 相交、按鈕消失、無額外 API／operation、暫時捲動樣式已還原。
- 證明新的閱讀輸入可取消，且在舊事件、內容更新、切 session 與清理後仍正確。測試需確認目標事件確實落在跳轉進行中，而不是只換測試名稱。
- 先目標測試，父 agent review 後再跑完整 check 與 browser 回歸。
- **Safari／實體 iPhone 的慣性與完整繪圖仍需真機確認。** Chromium 合成 scroll 事件通過不等於原問題通過。若沒有實機證據，交付只能稱程式與隔離競態修正完成，不能稱 iPhone 已驗收。
