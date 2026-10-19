# Session UI v1 真服務驗收紀錄

## 結果摘要

最後唯讀收尾已完成。沒有在本次收尾發出模型請求，也沒有發出 operations POST。服務保持啟動。驗收結果不是全面通過；限制與未驗證項目列於下方。

本次真瀏覽器驗收使用既有 A session，角色設定維持 `basic` profile。沒有切換 provider、model 或 thinking 設定。手機視窗為 390×844，桌面視窗為 1365×1000。兩張最終證據圖位於 `.test-artifacts/session-ui-v1/live-acceptance/closeout/mobile-proof.png` 與 `desktop-proof.png`。

## 驗收證據

| 驗收項目                                   | 結果                                                                                                                       | 證據                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 側欄行為與錯誤隔離                         | 原 browser 報告記錄行動側欄開合、焦點、Escape、錯誤隔離與錯誤關閉。                                                        | `.test-artifacts/session-ui-v1/live-acceptance/browser-report.json`；原截圖位於 `screenshots/`。 |
| Prompt、Follow-up、Steering 按鈕狀態與 SSE | v2 model 報告記錄 running 狀態下三按鈕狀態、Follow-up 接受、SSE `message_update`、`agent_settled` 與串流期間 pinned 結果。 | `.test-artifacts/session-ui-v1/live-acceptance/supplement/v2/model-report.json`。                |
| 初始捲動、resize 與回到最新                | readonly 報告記錄初始距底 0 px、resize pinned/reading 位置及回到最新距底 0 px。                                            | `.test-artifacts/session-ui-v1/live-acceptance/supplement/v2/readonly-report.json`。             |
| 串流期間 pinned-to-bottom                  | model 報告記錄內容高度增長，並量得距底 0 px。                                                                              | `.test-artifacts/session-ui-v1/live-acceptance/supplement/v2/model-report.json`。                |
| Metadata 與複製 fallback                   | readonly 報告記錄 metadata 預設收合、metadata 按鈕、複製 cwd/native command 與 draft 保留。                                | `.test-artifacts/session-ui-v1/live-acceptance/supplement/v2/readonly-report.json`。             |

原 browser 報告為 `partial`。該輪 Follow-up 在 initial turn settled 後才送出，屬 harness 排程錯誤。當時 Follow-up 未送出。v2 model 報告記錄改正在 runtime `running` 時送出 Follow-up，並收到接受結果。兩份原始報告均保留；不以後續結果改寫舊報告。

v2 model 報告記錄初始與 Follow-up assistant markers，以及 `settled` 狀態。這份報告沒有提供模型分支工具的 exit code。因此模型分支的 exit code 未取得。此處以實際 report、native assistant markers 與 settled 證據為準，不推定 exit code 為 0。

本次新增的真瀏覽器收尾報告位於 `.test-artifacts/session-ui-v1/live-acceptance/closeout/report.json`。它記錄 A 的正確 header、connected、精確 Follow-up assistant marker 已 render，以及兩種視窗最終距底均不超過 2 px。手機初始畫面已置底，因此沒有使用「回到最新」按鈕。若該按鈕有使用，報告會另外記錄該動作，不會把按鈕後位置當作初始置底結果。

## 完整性、服務與隱私

closeout report 記錄 repository source 20 項、root dist 24 項、舊 active release 11,793 項、新 release 10,441 項、root dist supplement manifest 19 項、native JSONL 6 項與 workspace 1 項的核對結果。這些 manifest 項目比較檔案與 symlink；不以一般目錄 mtime 判定內容變更。六個 native JSONL 依原始 `private/native-manifest.json` 核對，並確認其路徑集合符合 supplement baseline。A 的本次授權變更排除於「未變更」判定，其餘原始項目比對未見變更。workspace `hello.txt` 依 v2 workspace baseline 比對未變更。

protected local config、token file 與啟停 scripts 內容比對未變。active release pointer 另行核對，指向新版 release；不拿舊 pointer 當成應保持不變的內容。完整性報告只記錄 pass、count 與 changed paths，不保存或輸出 hash。

本次收尾由程式在記憶體讀取原 token file，供真瀏覽器登入使用。沒有輸出 token 或 cookie，沒有更換 token，也沒有保存登入 cookie。登入欄位期間沒有截圖、HAR 或 trace。瀏覽器登出後關閉。收尾 report 記錄 health HTTP 200、listener 身分及新版 active pointer。

本次收尾記錄 operations POST 數為 0，模型請求數為 0。沒有重啟服務、呼叫 operations POST、建立 session 或變更服務設定。瀏覽器只讀取既有 session 的 UI 與必要的 session API 資料；沒有讀取既有六個 session 的內容。

## 限制與未驗證項目

- 串流期間先上捲到中段，等待新文字更新，再確認 top 保持並回到最新，仍未實測。此項未驗證；不能以串流 pinned-to-bottom 或 readonly resize-reading 取代。
- 真手機裝置、真分頁情境與跨 VPN 未驗證。
- 模型分支工具 exit code 未取得。證據為 v2 model report、native assistant markers 與 settled 狀態。
- 不宣稱整套驗收全面 passed。原 browser 報告仍為 partial；本文件分開列出不同階段的通過證據與限制。
