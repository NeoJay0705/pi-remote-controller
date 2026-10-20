# Session 閱讀空間優化 v2 — 驗證紀錄

狀態：程式實作與隔離驗收完成。未重啟或操作正式服務，不能將本紀錄視為部署完成。

依據：[需求](session-layout-v2-requirements.md)、[設計](session-layout-v2-design.md)。

## 1. 交付內容

- 頁首固定單列：名稱省略、Runtime、連線與資訊入口。完整名稱、Pi session ID、App ID、實際模型設定及 Profile 等移至預設收合的有界資訊區。
- 切換 Session、登出或登入逾期時收合資訊區。錯誤、blocked 與 Session 提示仍直接呈現。
- 移除最近操作收據面板；保留內部收據保存與查詢，UNKNOWN／DISPATCHED 失敗顯示不確定結果及不要直接重送的提示。
- 受管清單移除 App ID／Profile；受管與候選清單依檔案更新時間新到舊排序並顯示時間及時區，未知時間置後。
- 安全 native metadata 與兩份清單 API 提供可選的 `fileUpdatedAt`（epoch 毫秒）；不增加資料庫欄位、不修改原生 Session、不啟動 Pi 取得時間。
- released／blocked 提示與輸入區共用縮排。桌面 Compact 放在 Prompt 上方的右側操作欄；手機草稿全寬、四個按鈕最多兩排。停止操作與原有權限限制保留。

## 2. 最終有效證據

所有命令由 implementation-worker 執行，工作目錄為 repository root。父 agent 未自行執行測試，而是閱讀程式、差異、測試斷言與結果，完成對委派成果的獨立 review。

本機完整紀錄：`.test-artifacts/session-layout-v2/final-confirmation/`。產物未加入版本控制；不存在於其他 clone 時，不應假設當地已有該證據。

| 命令 | 退出碼 | 結果 | 紀錄 |
| --- | --- | --- | --- |
| `npm run check` | 0 | format、lint、server/web typecheck、35 files／194 tests、server/Vite build 通過 | `check.command.txt`、`check.stdout.txt`、`check.stderr.txt`、`check.exitcode.txt` |
| `PRW_BROWSER_EXECUTABLE=<existing-headless-shell> npm run test:e2e` | 0 | desktop 29／mobile 29，共 58 cases 通過 | `e2e.command.txt`、`e2e.stdout.txt`、`e2e.stderr.txt`、`e2e.exitcode.txt` |

本次使用既有 `chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`，未下載 browser 或修改設定。E2E 只用 `127.0.0.1:4179` 的隔離 fixture 與 fake Pi。執行前後 Git 狀態記錄於 `git-status-before.txt`、`git-status-after.txt`，兩者相同。測試 stderr 的 SQLite experimental warning 未阻擋驗收。

最終全套完成後未再修改產品或測試，只由父 agent 更新本組需求／設計／驗證文件。

## 3. 驗收對應與證據邊界

| 項目 | 實際觸發與斷言 | 結果 |
| --- | --- | --- |
| API 時間 | `test/unit/native-reader.test.ts`、`test/unit/session-list-time.test.ts` 與 `test/integration/session-names.test.ts` 使用固定 utimes，斷言確切 epoch 值；讀取前後核對內容與 mtime | 通過 |
| 缺失與安全錯誤 | 受管檔案缺失、native ID 不符、symlink 時省略時間且整份清單仍 200；候選 symlink 的 unsafe-path 保留；原有 duplicate／歷史保留／GET 不啟動 Pi 測試仍在 | 通過 |
| 排序與未知時間 | `test/unit/session-list.test.ts` 對兩份清單測新舊時間、tie-break、NaN／Infinity／負值／不可表示日期、未知及不 mutate；共用格式 helper 顯示時區或未知 | 通過 |
| 清單實際 UI | `test/e2e/session-layout.spec.ts` 驗證反內部 ID 字典序的受管排序、候選時間排序與 tie-break、候選未知時間／disabled、Project 切換、刷新後重排、加入後排除及受管排序 | 通過 desktop/mobile |
| 精簡資訊 | 同 spec 以長中文名稱／長 ID 驗證收合時無 panel 或複製按鈕，鍵盤 Enter 展開後完整值存在；面板內容確實超出、scrollTop 可大於 0；聊天與草稿可見；切到另一 Session 後收合 | 通過 desktop/mobile |
| 320px | 明確設為 320×700，斷言 document 無水平溢出、頁首不超過 60px、nowrap、名稱內容超過可用寬度；reconfiguring 長狀態下再次核對頁首與按鈕未超出 viewport | 通過 |
| 縮排與草稿 | released 提示內容左邊與 textarea 左邊差 <=1px；desktop Compact 在 Prompt 上方、textarea 高 >=100px；手機 textarea 等於 controls 內容寬度，四個按鈕最多兩排 | 通過 |
| Compact 與 UNKNOWN | idle 實際送出 kind=compact；released／running／blocked／queue 非空禁用且不增加請求；prompt abort 確實進 catch，顯示不確定結果、保存 UNKNOWN；reload 觸發 receipt GET 而不增加操作 POST；沒有收據面板 | 通過 |
| 既有回歸 | Profile 冷／熱切換、外部 revision、generation guard、複製 fallback、queue-stop、登入逾期、草稿、歷史分頁、聊天跟隨與向上閱讀、離線與重連、命名與安全渲染等既有案例適配新資訊入口後保留 | 通過本輪全套覆蓋範圍 |

排序只在既有清單載入／刷新時更新，不保證每個 SSE 事件即時重排。檔案時間不是最後訊息時間，也不是模型工作完成時間。以上沒有聲稱同樣 viewport 的修改前後實測多出幾個像素。

## 4. 過程失敗與修正

早期失敗均保留，未當作成功證據：

1. 預設 Playwright browser 路徑缺少執行檔；系統 Google Chrome 啟動 SIGTRAP。以現有 headless shell 先跑單一 desktop 最小路徑，確認有效後才擴大。
2. 新目標 spec 初期有 accessible name、CSS modules 定位、disabled option 判讀、手機側欄、SSE 時序及 controls 外框／內容寬度量測錯誤。依父 agent 讀取證據後的具體決策分次修正。沒有用放寬容差或刪除 UNKNOWN 斷言通過。
3. 既有測試原依賴常駐 App ID、Pi ID、模型與收據面板。改用 header 內部識別 attribute、可見 native ID、資訊入口及 sessionStorage 收據證據；Profile／copy／捲動等原場景保留。手機先正常關閉側欄，再操作 inert 主內容中的資訊入口，未用 force click 或移除 inert。
4. 第一次最終全套為 check 193/194、e2e 56/58，並非通過。原因包括 native-discovery 完整物件預期漏新增時間欄位、Profile 建立後尚未切到新 Session 就展開資訊，以及清單測試先選 Session 造成候選刷新清空剛選值。
5. 修正完整契約的固定 mtime 預期、等待新 Session ID，並將清單加入情境保持為不需先選受管 Session 的獨立流程。保留全部清單排序、排除及收據安全斷言。先通過 16 個受影響 browser cases，再取得第 2 節的最終全套結果。

過程紀錄位於 `.test-artifacts/session-layout-v2/` 的 `backend/`、`frontend/`、`frontend-completion/`、`browser-probe/`、`layout-targeted/`、`layout-repair/`、`composer-repair/`、`regression-migration/`、`mobile-regression-fix/`、`final/`、`final-test-repair/`。其中較早的成功或失敗不替代 `final-confirmation/` 對最後程式狀態的證據。

## 5. Review 與限制

- 父 agent 核對所有本次產品差異、測試移轉、關鍵斷言及最終命令結果。沒有修改或刪除未授權檔案；未改依賴、lockfile、runtime 所有權、Ledger schema 或服務腳本。文件由父 agent 撰寫並自行核對，不宣稱文件經獨立 review。
- **未驗證：**真 Pi/provider、正式服務載入新頁面、實體手機的觸控／OS 鍵盤、其他瀏覽器引擎及螢幕閱讀器體驗。
- `fileUpdatedAt` 的無效／負值／不可表示範圍由實作檢查，前端 helper 有合成測試；未在真實檔案系統直接建立所有特殊 mtime 值。時間讀取失敗的安全案例不等於每一種 OS I/O 錯誤都已注入。
- 沒有跨所有螢幕、縮放比例或字級宣稱版面都已驗證；320px 與設定的 desktop/mobile viewport 有本輪 browser 證據。
- 未執行 `service:restart`。建置 `dist/` 不等於服務已重啟或使用者瀏覽器已載入新版本。

## 6. 本次提交前資安檢查

本輪證據位於 `.test-artifacts/session-layout-v2/precommit-security/`，不納入 Git。父 agent review 掃描候選、原始碼差異與測試斷言，未將工具成功或 audit 零漏洞視為全面安全保證。

- **依賴漏洞：**在隔離 HOME、cache 與兩個不同的空 npm 設定檔下，固定使用 `https://registry.npmjs.org`，分別執行 fresh `npm audit --json` 與 `npm audit --omit=dev --json`。兩者 exit 0，各 severity 與 total 均為 0。未執行 install、update 或 audit fix。兩份 metadata 仍都列出 prod 163、dev 244、total 406，不以此宣稱 production-only dependency count 已獨立確認。
- **秘密與公開內容：**自訂 heuristic 掃描涵蓋 132 個目前 candidate 檔案及 184 個可達歷史 unique blobs，沒有因大小、數量或 symlink 而略過。工作樹 69 筆、歷史 108 筆候選經人工分類；秘密類候選是隔離測試的合成 token、文件／artifact 路徑等，未辨識出真實憑證或私鑰。工作樹的內網位址候選是 README 明示範例與網路測試資料。未讀取正式 token 或個人 session 來做 exact-match 比對。本輪未使用 Gitleaks、TruffleHog 或 Semgrep，不能將 heuristic 結果等同這些工具的完整掃描。
- **Lockfile：**406 個 resolved URL 均符合 HTTPS npm registry 與無憑證規則；406 個 integrity 均為 SHA-512，root dependency 宣告一致。四個 funding URL 候選是公開 GitHub 贊助連結的 `sponsor=1`，不是認證資料。未修改依賴或 lockfile。
- **增量程式 review：**時間僅由既有安全開檔後的 fd stat 取得，保留 canonical containment、NOFOLLOW、file identity 與 native ID 核對；缺失或不符時省略時間，不洩漏原始錯誤。名稱仍以 React 純文字呈現。移除收據面板沒有移除操作識別、保存、查詢或 UNKNOWN 不重送保護；Profile 與 Compact 的安全條件保留。本次未發現增量差異中的阻擋性資安問題。
- **Fresh focused regression：**`npm test -- test/unit/native-reader.test.ts test/unit/native-discovery.test.ts test/unit/api-auth.test.ts test/unit/app-security.test.ts test/integration/security-sse.test.ts test/integration/session-names.test.ts test/integration/session-access.test.ts` 通過 7 files／35 tests，exit 0。它補充第 2 節同一產品／測試內容的 194 tests 與 58 browser cases，不宣稱本輪重跑全部測試。

**公開歷史仍有限制：**可達舊 commits 仍含個人 HOME 路徑與實際內網位址；目前文件的匿名化不會移除這些歷史內容。既有 commit 作者 metadata 也包含姓名與電子郵件。此次未改寫歷史或變更作者設定。若不接受這些資訊公開，發布完整 Git history 前需另行處理；本次本地 commit 不等於公開歷史已去識別化，也不包含 push 授權。

未執行全面滲透測試，未 audit OS、Node.js 或全域 Pi 套件，不能保證沒有未知秘密或漏洞。未操作正式 endpoint、重啟服務或呼叫真 Pi／provider。
