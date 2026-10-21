# 慣性捲動中的回到最新 v1 — 驗證紀錄

目標識別：`session-scroll-momentum-v1`。
狀態：**應用事件競態修正、父 agent 獨立 review 與隔離回歸完成。Safari／實體 iPhone 原生慣性與畫面繪製仍未驗證。未執行正式部署或重啟。**

- [需求](session-scroll-momentum-v1-requirements.md)
- [設計](session-scroll-momentum-v1-design.md)
- [前輪記錄](session-continuity-v1-verification.md)

## 1. 使用者新證據與修改前基準

使用者補充：iPhone 靜止時按回到最新正常，慣性滑動中按會出現按鈕仍在、訊息顯示不完整。前輪測試沒有涵蓋這項時序，不能用前輪 74 cases 通過作為它已修復的證據。

父 agent 確認舊程式 onScroll 無條件用底距更新 pinned；點擊後的舊 scroll 能把 pinned 改為 false，使對齊 frame 退出。

先委派建立最小失敗測試，未修改產品：一次真實 click 後捕獲尚未執行的 rAF，注入離底 240px 的 scroll，執行 captured frame 並等待三個 native frame。Desktop/mobile 兩者皆失敗：

| 觀測                        | 修改前       |
| --------------------------- | ------------ |
| 注入／最終底距              | 240px／240px |
| latest 與實際 scroller 相交 | false        |
| 回到最新按鈕                | 仍可見       |
| operation POST              | 0            |

`baseline-race.log` 的 exit 1 是有效的產品競態失敗，不是環境問題。前置／最終幾何均有輸出；第一個 bottom <=2 斷言失敗後，其餘 assertion 未執行，不宣稱它們通過。

基準路徑：`.test-artifacts/session-scroll-momentum-v1/`。

- `baseline-source.txt`：main SHA-256 `e4335ed5b230466c6d0b578355cda7fa7d732b493a994894cecd5a2d4a88c1b0`，CSS SHA-256 `bd8c31cede294c40cc4caac7720a8431c7ab98b453feb0b2cf3451889eefa0d8`。
- `baseline-race.log`：命令、2 個失敗 case、數值、退出碼及 trace 路徑。

這只重現應用事件競態，不是 iOS 原生慣性或 compositor 的真機重現。

## 2. 交付與範圍

本輪產品／測試修改：

- 新增 `src/web/chat-scroll.ts`：共用 controller 管理普通追尾與明確跳轉。明確跳轉短暫設定聊天 scroller 的 overflow-y:hidden、scroll-behavior:auto，跨兩個有界 rAF 還原、重測及對齊；保存並還原原 inline 值與 priority。
- 完成後保留明確 latest 意圖。沒有新閱讀 input 的舊 scroll 不再取消追尾；新的 pointer、touch fallback、wheel、捲動按鍵會釋放意圖。不建立永久 timer／輪詢。
- `src/web/main.tsx`：接入 controller，整合 onScroll、按鈕、輸入與 select/auth-expired/logout/unmount 清理；loadOlder 進錨點閱讀前取消追尾。
- 工作序號、element、generation 防護先於 callback 副作用；舊 callback 不可取消新工作的樣式或排程。普通追尾仍須在每個 frame 重查 pinned。
- 跳轉失敗或 scrollTop 不接受寫入時，釋放意圖、還原樣式並依真實位置決定狀態，不只隱藏按鈕。
- 新增 `test/unit/chat-scroll.test.ts`；擴充 `test/e2e/session-continuity.spec.ts`；在 `session-ui-behavior.spec.ts` 補上代表新閱讀的 input，保留舊錨點、內容增長及 resize 斷言。

保留前輪全部未提交變更。沒有修改本輪以外的產品行為、CSS、API、backend、登入續留、Compact、套件或 lockfile；沒有留下被清空／刪除的測試檔。測試有原地 build dist，未操作正式 instance、正式 endpoint／DB 或個人 history，未使用真模型。

## 3. 最終驗收

測試由 implementation-worker 執行，父 agent 讀取程式、測試、差異及完整日誌核對；不因 worker 的 completed／partial 狀態直接接受。

工作目錄為 repository root。Browser executable：

```text
/absolute/path/to/chrome-headless-shell
```

公開文件以示意路徑取代本機絕對路徑；原始完整命令僅保留於未提交的本機日誌。

| 命令                                                 | 結果                                                             | 證據（`.test-artifacts/session-scroll-momentum-v1/` 下） |
| ---------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `npm run check`                                      | exit 0；format、lint、typecheck、37 files／210 tests、build 通過 | `final-check.log`                                        |
| `PRW_BROWSER_EXECUTABLE=<上述路徑> npm run test:e2e` | exit 0；desktop 42／mobile 42，共 84 cases 通過                  | `final-e2e.log`                                          |

完整回歸是在 controller review、測試復原及目標集合通過後執行。最終兩個命令各一次；worker 核對測前／測後 git 狀態與五個相關 source/test checksum 未改變。父 agent 核對最終 84 cases 及日誌，之後僅更新歸檔文件，未再修改產品或測試。

### 3.1 競態與幾何

- 保留真實 back button click，捕獲 frame 數 >0，確認當時 overflow-y:hidden 及 scroll-behavior:auto 都有效。
- scrollTop 賦值後、dispatch scroll **之前**量測實際底距為 240px，避免把同步修正後的 0 當成沒有注入；不是只用算式製造 240。
- 新程式完成後兩平台底距都是 0px、latest 文字正確且與實際 scroller 水平／垂直相交、button 消失、兩個暫時 style 還原。
- 成功置底後再注入無新 input 的舊 scroll，仍保持在底部。Controller unit 另涵蓋 active 階段及完成後的實際 240px 位移。
- 主跳轉觀察區間 API request 與 operation POST 都沒有增加。完成後額外 scroll 的幾何有測；request listener 在此前已移除，不把該分段當成獨立 API 計數覆蓋。

### 3.2 新閱讀與 lifecycle

- Browser 在 active hidden 階段分別派送 pointerdown、touchstart、wheel、PageUp，隨後位移並執行舊 callbacks／三個 native frame。每輪仍離底 >48px、button 可見、暫時樣式完整還原。這驗證 React 輸入綁定，不是真實觸控或原生鍵盤捲動。
- 切 session、auth-expired、logout 三案例都先確認 active hidden，再切換／失效／登出。舊 element（包含 detached 參照）的兩個 style 值及 priority 均還原。重放 captured callbacks 後，secondary 內容或 login 狀態保持正確。
- 單元對取消過的 A callback，在新 B 工作進行時手動執行，檢查沒有 scrollTop 寫入、B hidden／frame 不被取消且可完成；不能只憑位置剛好相同宣稱舊 callback 無副作用。
- 較舊歷史 anchor、串流內容增長、resize、重新登入、Compact 與其他安全操作仍由完整回歸覆蓋。

### 3.3 單元失敗邊界

11 個 controller tests 使用有 maxTop clamp、可變高度、寫入計數及可控 frame 的模型，涵蓋：普通 pinned=false 不再寫、A/B 工作隔離、兩個 frame 有界、原 style／priority 還原、generation／element 失效、重複 cancel、scrollTop 拒寫、完成後拒寫釋放意圖、一次 style 操作失敗及 requestFrame／cancelFrame 失敗。

模型不能證明 browser 在所有 CSS setter 拒絕下都能強制還原；它驗證可恢復的局部錯誤，不宣稱能繞過 browser 自身不可寫的 DOM。

## 4. 過程失敗與檔案復原

- 初稿少了普通 frame 的 pinned guard，舊 callback 又能清理新工作；父 agent review 後另派修正及有寫入計數的 unit。
- 初稿 unit scrollTop 不 clamp，會產生負底距的假成功；改為 DOM 相容的幾何模型，並補強缺漏 assertion。
- 舊 compact browser case 暫存 rAF 卻未 flush；新 controller 因此一直停在 active 階段，導致內容成長後追尾 assertion 失敗。補做已捕獲 callback、等待 native frame 及確認 style 還原，再保留原有 growth/anchor 驗證；沒有放寬幾何斷言。
- 部分 browser 命令曾因 executable 拼字錯誤失敗，屬命令設定問題；保留日誌／產物，不當作產品失敗，也不當作通過。

### 測試檔誤清空事故

實作 worker 曾誤把未追蹤的 `session-continuity.spec.ts` 清為 0 bytes，隨即停止回報。父 agent 沒有用片段重建：先確認最近已執行測試 trace 包含完整 source，並與該 run source map 的 sourcesContent[0] 逐 byte 相同，再派限定復原任務。

- 復原快照：29,228 bytes／842 lines，SHA-256 `e264cc2ddaffb002cbcf3c558bd971aa0320d51e2f89434a2d8e099c4c1b2efa`。
- 修改前基準測試快照：27,525 bytes／801 lines，SHA-256 `92c3cec809680dfda13a4e04cce66e0f89c9be885a4503de907cdacf89cc665a`。
- 完整來源、備份與 hash 核對見 `recovery/recovery-record.txt`。來源是最後可靠的**已執行**快照，不假稱取回清空前可能存在的未知未測試改動。
- 復原後再做必要局部修改並重跑驗收。父 agent 對照基準完整 source：原測試案例與 assertion 保留，變更僅為擴充型別／helper、新輸入、正確 frame 推進、dispatch 前量測與新增案例；沒有用刪測試取得通過。

局部最終證據位於 `worker-run-20261020T193500Z/`（11 unit、typecheck、race、30 browser cases）。它們先經父 agent review，才執行上述完整回歸；早期通過不能代替較晚 source 的證據。

## 5. 未驗證與實機驗收方式

- **未驗證 Safari／實體 iPhone。** Mobile 是 iPhone viewport 的 Chromium。合成舊 scroll 證據不能證明原生慣性真的終止，也不能證明原始缺片／空白已在 compositor 消失。
- 使用者回報所用 iOS／Safari、正式服務版本及 browser cache 未檢查；不宣稱正式 instance 已更新。
- Browser input 是合成事件配合實際 DOM 位移。IME、不同行動瀏覽器、所有鍵盤鍵值及 unmount 的實際裝置排列沒有逐一實測；程式有對應邊界，測試範圍如上。
- 未執行正式部署、重啟、正式 endpoint 驗收；未建立 commit。

有授權的版本可做以下真機確認：

1. 快速向上滑動，手指離開但畫面仍在動時，按一次回到最新。
2. 再以向下慣性、接近頂端／底端的彈性回捲重做。
3. 確認最新訊息底端確實在視窗內、可見區沒有未更新空白、button 消失。
4. 隨後重新向上滑動，確認不被拉回、沒有捲動鎖定。

結論：應用事件競態及清理已修正並通過隔離驗收；原始 iPhone 視覺症狀是否完全消除仍須上述實機證據。
