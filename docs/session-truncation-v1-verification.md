# Session 截斷提示準確性與歷史預覽穩定化：驗收

對應[需求](session-truncation-v1-requirements.md)及[設計](session-truncation-v1-design.md)。狀態：**修正已完成，父 agent 已核對實作及驗收證據。本文記錄離線及 fixture 驗收，不追蹤目前部署狀態；後續部署另行授權。**

## 結論

指定本機 session（完整識別與 hash 僅在 Git 忽略的本機證據保存）確認存在兩種不同原因：

1. 只有 thinking/system 等安全省略，也被當成內容截斷。
2. 較新項目先消耗整頁 retained 預算，較舊項目因此縮減單筆預算，即使只有短文字也會被裁切。

現在私密省略與非私密投影損失分開計算。單筆解析預算固定；放不進整頁時使用 continuation，而非縮減下一筆。真正過大的單筆或 metadata 仍是有界預覽，UI 明確以歷史項目／工具資料為範圍說明，不再保證能展開所有內容。

## 來源與 before/after

本機去識別化證據位於 `.test-artifacts/session-truncation-v1/`；此目錄由 Git 忽略，不是部署產物，也不保證隨 repository 分發。完整 session 識別與 hash 僅在 Git 忽略的本機證據保存。報告沒有訊息原文、thinking 原文或簽章。

### 指定本機 session

- 修正前：`report.json`。最新 100 筆中 81 筆有 truncated 旗標。這不是 81 筆可見文字都不完整。
- 修正後：`verify-after.json`，由 `verify-after.ts` 產生。來源 parent chain 與讀回 189 筆完全相同；15 頁，無重複、遺失或額外 ID，跨頁順序相同，cursor 正常結束。
- 各頁 response 最大 148,108 bytes；retained 最大 171,167 bytes，低於 page budget 173,397 bytes。這是此 session 的觀察值，不是所有輸入的 memory/RSS 基準。
- 同一筆 user（單筆識別與 hash 僅在 Git 忽略的本機證據保存）：來源 160 UTF-8 bytes；修正前頁面只保留 101 bytes 且 truncated=true；修正後保留 160 bytes、與來源相等且 truncated=false。
- 修正後所有非 system 訊息的公開文字在此快照與來源相等。仍有 20 筆項目級 truncated，可能是參數／metadata 的有界投影；不等於有 20 筆文字損失。此數字涵蓋全部 189 筆，不能直接與舊最新 100 筆的 81 相減。
- 來源大小 8,417,492 bytes；修正前後 SHA-256 相同（完整 hash 僅在 Git 忽略的本機證據保存），size/mtime 也相同。沒有修改來源 session。

### 合成情境

- **20 bytes assistant + thinking**：修正前 `report.json` 的 synthetic 案例中 entry/page 都標記 truncated。修正後獨立暫存 JSONL fixture 經同一 `readNativePage`，公開文字完整且 entry/page truncated=false，序列化不含私密字串。證據為 `verify-after.json` 的 `syntheticAssistantThinking20Bytes`。此 fixture 與原 session 分開，不能混為同一原始訊息。
- **Append regression**：原來單獨存在的 4096 ASCII 字元 user text-block array，append 12 筆大型 toolResult 後，舊 reader 只保留 134 字元且 truncated=true；新 reader 保留 4096 且 false，6 頁可取回。舊 reader/parser 從 Git HEAD 原始碼建立隔離 baseline，不覆寫現行 source。證據：`logs/baseline-comparison-4096.log` 及 `baseline-comparison.ts`。
- 早期 27-byte／169-byte 直接字串 fixture 未觸發舊版資料損失，不作為成功證據。已改為可區分舊、新結果的 array fixture，且 repository regression 有真實 append、最終 cursor 結束、預算與完整 ID 集合斷言。

## 驗收對照

| 需求 | 證據與判定 |
| --- | --- |
| R1 私密省略不誤報 | Parser tests 涵蓋首尾 privacy marker、超長私密 payload、敏感巢狀陣列、一般文字簽章省略；20-byte fixture 確認 reader 輸出路徑（不等同真 session 的 HTTP／DOM 全鏈驗證）。公開 sibling 的真截斷仍標記。通過。 |
| R2 預覽不隨頁內預算降級 | 固定單筆預算、加入前檢查、恢復 scanstate；有效 append baseline、repository regression 及原 session 160-byte 對照。通過。 |
| R3 真預覽與範圍正確 | 超長公開文字仍 truncated；UI 用項目／工具範圍提示；本地文字裁切 marker 保留。原 session 仍有合法項目級提示。通過。 |
| R4 操作與文案一致 | Browser desktop/mobile 均檢查短 entry 無提示、true flag 項目提示、最新頁／有上限按鈕、aria-description/title 與 previewBytes=65536 請求。逐 ID 清單已移除。通過。 |
| R5 安全與相容性 | 原檔 hash/size/mtime 不變；189 筆 parent chain 完整、順序相同、頁預算有界。既有格式、游標、分支、runtime 等回歸及 build 通過。未新增持久歷史索引或對話副本。通過本次覆蓋範圍。 |

## 最終命令與結果

工作目錄：repository root。所有執行由 implementation-worker 完成；父 agent 讀取 source、diff、測試斷言及結果進行獨立 review，未自行執行測試。

| 命令 | 結果 | 本機證據 |
| --- | --- | --- |
| `npx tsx .test-artifacts/session-truncation-v1/baseline-comparison.ts` | 有效 before/after 差異，4096 → 舊134／新4096 | `logs/baseline-comparison-4096.log` |
| `npm exec tsx -- .test-artifacts/session-truncation-v1/verify-after.ts` | 原 session 與獨立20-byte fixture 通過 | `verify-after.json`、`logs/verify-after.log` |
| `PRW_BROWSER_EXECUTABLE=<existing-headless-shell> npm run test:e2e -- --workers=1 --project=mobile -g 'message operation browser matrix\|history truncation stays entry-scoped'` | 2/2 通過 | `logs/e2e-mobile-compact.log` |
| `PRW_BROWSER_EXECUTABLE=<existing-headless-shell> npm run test:e2e -- --workers=1` | 52/52 desktop/mobile cases 通過 | `logs/e2e-final.log` |
| `npm run check` | format、lint、typecheck、32 files／186 tests、build 通過 | `logs/check-compact.log` |

使用既有 `chromium_headless_shell-1208` 的 `chrome-headless-shell`，沒有下載套件或修改系統設定。最初 default browser 路徑缺執行檔；系統 Google Chrome 啟動 SIGTRAP。這些不是測試本體失敗，不作成功證據。後續以既有 headless shell 完成真 browser 測試。

一次中間完整 browser 執行為 51/52：本次常駐多行說明在手機頂端擠占訊息空間，使既有捲動案例找不到可見錨點。父 agent 更新 D3，改由緊湊按鈕標籤直接說明範圍，補充資訊放 aria-description/title；沒有修改或削弱既有捲動案例。修正後先驗兩個 mobile 案例，再驗全套52項。部分早期診斷 log 被 worker 覆寫，故不宣稱早期每次嘗試都有完整可重讀日誌；最終成功日誌使用獨立名稱保留。

## Review 與限制

- 父 agent 核對本次 tracked source/test 共10個檔案，修改限於 parser、reader、提示與對應測試。未刪除檔案、未改依賴或 lockfile；初始工作區沒有既有 tracked 變更。
- 父 agent 的需求、設計與驗收文件歸檔不改變 runtime 設定。實作與測試委派，需求／設計／決策／review 未委派。
- 本驗收未涵蓋正式服務重啟、資料庫修改或真 Pi／模型啟動；本文記錄離線及 fixture 驗收，不追蹤目前部署狀態；後續部署另行授權。Browser 使用 isolated fixture，不宣稱真模型端到端已驗證。
- 舊 session 快照檢查不能保證未來 append 的所有可能資料；極端 record、安全省略造成的 metadata 含糊及真正超限仍走有界預覽／安全錯誤路徑。
- 不承諾完整內容下載或逐 entry 無上限展開。每頁可能少於100筆，是穩定單筆預覽與有界 response 的取捨。
