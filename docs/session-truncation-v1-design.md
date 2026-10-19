# Session 截斷提示準確性與歷史預覽穩定化：設計

對應[需求](session-truncation-v1-requirements.md)。共同前綴：`session-truncation-v1`。狀態：已依本設計完成實作與本機驗收；父 agent review 完成。本文記錄離線及 fixture 驗收，不追蹤目前部署狀態；後續部署另行授權。見[驗收](session-truncation-v1-verification.md)。

## 根因

1. `parseBoundedJson` 使用全域 truncated。發現 `role=system` 或 `type=thinking` 時直接設 true；即使公開文字完整，也傳成 entry.truncated。
2. `readNativePage` 由新至舊掃描。每筆解析上限使用 `floor((1 MiB - 8192)/6) - retainedBytes`，最後僅保留最少 1024 bytes。因此項目內容會隨較新訊息的數量及大小改變。
3. UI 在頁頂、每筆 ID 清單、訊息與工具重複顯示同一句話。旗標實際是整個投影項目有損，不一定是可見文字有損。最新頁的 previewBytes=65536 重載也無法復原所有舊項目，且預設本來就是這個字串預覽上限。

## 決策

### D1：隱私省略不等於資源截斷

保留 bounded JSON parser 的串流與 fail-closed 機制，不改成整筆 JSON.parse。`truncated` 定義為保留的非私密投影因長度、數量、metadata 或 retained 預算損失；安全省略本身不設此旗標。

每個 container 開始時保存既有截斷狀態。結束時，若已確定為 system/thinking 私密 container，刪除其 payload，並恢復進入該 container 前的狀態；不可清除先前公開 sibling 的截斷。若 metadata 含糊、耗盡或有公開資料損失，仍採保守截斷。私密標記不論出現在前端、尾端、重複欄位或數量上限後，都保持既有 sticky privacy 規則。已跳過子樹內的資源裁切不應污染公開 sibling 的狀態。

明確省略 `thinkingSignature`、`textSignature`，以及既有 thinking/signature/stderr/rawStderr 欄位，不保留簽章。不要將敏感內容加入診斷報告。不要為了消除提示放寬安全規則。一般 parser 消費者（包含名稱讀取）仍使用相同 bounded/fail-closed 契約。

此期不提供精確到每一 text block 的 truncation path。非私密 metadata 被裁切仍可標記項目預覽，由 UI 文案清楚說明範圍。

### D2：單筆預算固定，頁面不足時分頁

使用固定常數 `floor((1 MiB - 8192)/6)` 作為 page retained 預算及每筆解析上限；仍小於 parser 的 256 KiB 上限。每筆使用同一上限，不減去本頁已保留量。保留 response bytes 的獨立檢查與 fitEntryResponse 防線。

沿目前分支取得下一筆時，若加進本頁會超出 retained/serialized 預算，且本頁已有項目，將 scanstate 恢復到該筆的 spanEnd，透過既有簽署 continuation 從該筆續讀。不要將不完整投影推入本頁。每頁可能少於 100 筆，這是刻意的安全取捨。

單筆本身超限仍為有界預覽。entry/page truncated 旗標須包含 fitEntryResponse 實際裁切，不能只計 parser 的旗標。延用目前 response-space 耗盡的 incomplete/continuation 契約，不新增 cursor 格式。驗證至少一筆進展及完整遍歷，防止空頁迴圈。

```
JSONL tail + signed cursor
          |
          v
reverseLines -> fixed-budget parseBoundedJson
          |               |
          |               +-> remove private payload
          |               +-> flag non-private projection loss
          v
match active parent chain
          |
          v
fits retained + serialized page budget?
     | yes                       | no
     v                           v
append entry              restore scanstate at entry
advance parent            return signed continuation
     |                           |
     +------------+--------------+
                  v
          history API -> Conversation -> scoped preview notice
```

### D3：提示與實際能力一致

- 整筆歷史旗標使用「此歷史項目為有界預覽，部分資料未載入」等項目範圍文案，不宣稱短文字被截斷。
- 工具卡也使用工具資料的範圍文案；前端本地文字長度限制的 `[內容已截斷]` marker 保留。
- 頁頂最多一個總覽；移除逐 entry ID 警告清單。對話內保留對應項目提示，以利定位。
- 重載最新頁按鈕維持原行為，標籤改為「重新載入最新頁（預覽有上限）」。使用 `aria-description` 與 `title` 補充「預覽仍有上限；此操作只重新載入最新頁，不保證展開較舊項目。較舊項目請載入歷史。」不在狹小手機歷史視窗上方常駐多行說明，避免將第一筆訊息擠出視窗。按鈕本身須直接說明 latest-page 與 bounded 能力，不能只依賴 hover。這是 browser 回歸發現 mobile 頂端沒有可見訊息錨點後的設計收斂；不修改或削弱既有捲動驗收。不新建虛假的逐項展開按鈕。不更改草稿、SSE 或送出流程。

## 錯誤處理與取捨

- 無索引反向掃描成本不變。多一筆暫時投影所占記憶體有界；不能持久保存來源或建立索引。
- 分頁增加 API 往返，但避免同一訊息只因相對位置改變而被進一步縮短。
- 原 session 的所有完整輸出不保證能顯示；真正長內容及大量 metadata 仍可能成為預覽。
- Invalid record、UTF-8、depth、identity/cursor mismatch、partial tail 與工作預算使用既有錯誤路徑，不吞錯、不偽裝空歷史。
- UI browser 測試是 fixture，原 session 為離線讀取證據。不宣稱已驗正式服務或真 Pi/模型全鏈。

## 實作範圍與驗證命令

允許改動 `src/server/bounded-json.ts`、`src/server/native-reader.ts`、`src/web/{Message,Conversation,ToolCard}.tsx`、`src/web/main.tsx` 與對應 unit/e2e tests；不得修改原 session。除需求指定的去識別化本機驗證產物外，不引入新套件或歷史副本。

先新增針對性 regression，確認修正前能區分錯誤／正確結果，再修正。最小測試命令：`npm test -- --run test/unit/bounded-json.test.ts test/unit/native-reader.test.ts test/unit/conversation.test.ts test/unit/web.test.ts`。完成後執行 `npm run check` 及 `npm run test:e2e -- --workers=1`。原 session 以 `npm exec tsx -- .test-artifacts/session-truncation-v1/repro.ts` 的延伸唯讀 harness 驗證，須保留修正前 report.json，不覆寫舊證據。

由父 agent 核對 patch、測試斷言、目標觸發情境與結果。若實作遇到設計無法處理的隱私或分頁問題，停止並回報，由父 agent 決定，不自行擴大設計。
