# Session 命名與原生識別顯示 v1：設計

## 狀態與需求

追蹤前綴：`session-naming-v1-`。需求及初始現況見 [評估](session-naming-v1-assessment.md)。本設計將該評估的建議收斂為實作規格。評估文件保留為修改前的歷史基準。

狀態：實作與隔離驗證已完成。結果與限制見 [本期驗證紀錄](session-naming-v1-verification.md)。本文件不表示已部署。

目標：Web 新建 session 可選填原生名稱。既有名稱可讀。候選清單、受管清單及頁首同時提供名稱與原生 Pi session ID。名稱不是唯一識別。

不做：Web 重新命名既有 session、AI 命名、名稱搜尋或排序、跨機同步、部署、資料遷移、持久名稱索引及模型呼叫。

## 使用情境

- 新建時輸入工作名稱，稍後在 Pi 開啟同檔仍可讀到此名稱。
- 加入既有命名 session，不改寫原檔，並顯示原名。
- 兩個同名 session 可由 Pi session ID 區分，App ID 另行標示。
- 未命名 session 繼續正常工作。
- 外部 Pi 改名後，透過重新整理清單或重新選取 session 更新。重連時更新所選 session。不保證外部即時推播。

## 新建輸入規格

- 新增選填 `name` 字串。省略或 `trim()` 後為空時，不寫 `session_info`。
- 正規化後最多 128 個 Unicode code points。使用字元迭代計數，不使用 UTF-16 code unit 長度。
- 正規化後禁止 C0、C1 控制字元及 U+2028／U+2029。換行不轉成空格；內部換行會遭拒。首尾空白由 `trim()` 移除。
- 前後端使用同一純函式驗證。輸入無效時不建立檔案，回傳 HTTP 400 `invalid_session_name`。UI 保留輸入並顯示可操作錯誤。
- 名稱可重複。名稱是純文字，不作為檔名、shell、HTML 或 Markdown。
- `nativeFile` 與 `name` 同時出現時回傳 400，即使 name 是空字串也一樣。加入既有 session 不提供命名功能。

## 新建寫入與故障

沿用 `createNative` 的 canonical path、O_EXCL、O_NOFOLLOW、0600 及 fsync。只對本次全新檔案，將 header 與選填 `session_info` 一次寫入同一 file handle。`session_info` 有唯一 entry id、parentId:null、ISO timestamp 與正規化 name。空名稱維持 header-only 相容行為。

不啟動 Pi runtime 來命名。不修改 ledger schema，也不在 ledger 保存名稱副本。建立回傳 DTO 可攜帶本次已知名稱。

建立或登記失敗不得回報成功。不得自動重送 POST。保留輸入，提示重新整理清單確認。登記失敗留下的原生檔可透過候選清單復原。不得為清理而刪除不確定歸屬的檔案。本期不改造跨檔案與 SQLite 的交易流程。

## 名稱語意與讀取契約

新增共用 `SessionNameInfo`：

```text
{ status: named | unnamed | incomplete | error,
  name?: string,
  code?: safe_error_code }
```

- `named`：全檔追加順序中，最新完整 `session_info` 的 name 為非空字串。name 先 trim。
- `unnamed`：已掃描至 header 且無 `session_info`，或最新完整紀錄的 name 缺省／trim 後為空。不得退回更早名稱。
- `incomplete`：工作預算耗盡或檔案讀取期間變動。不得攜帶可能過期的 name。
- `error`：路徑、權限、身分、資料格式或名稱投影無法安全處理。只提供安全錯誤碼，不洩漏原始內容或 stack。
- `session_info.name` 為非字串且不是缺省時視為錯誤。既有名稱不套用新建 128 字元限制；安全讀取上限為 4096 UTF-8 bytes。超出時不截斷後假稱完整名稱，改為 error。
- 最後一筆不完整 JSONL line 暫時忽略。掃描檔案追加順序，不沿 parentId 選擇名稱，不依賴 history 頁面或 RPC 狀態。

在 `native-reader.ts` 新增安全名稱讀取。重用安全開檔、反向分塊及 bounded JSON parser。單次保留最多既有 parser 的 256 KiB 與固定區塊。截斷的 session_info 不可宣稱已取得完整名稱。非名稱紀錄可只保留有界投影。

單檔額外名稱讀取預算：最多 2 MiB 實際讀取、250 ms 合作式期限。清單所有名稱掃描共用最多 8 MiB、1000 ms。期限在區塊及紀錄邊界檢查，不承諾作業系統或單個 parser 工作可被硬中斷。Header 讀取、掃描及最終重新驗證讀取均計入名稱預算。現有候選清單本身的 header 驗證維持原安全規則；此額外預算不宣稱限制原有清單列舉總成本。

預算耗盡後，其餘項目仍列出 ID 並回報 incomplete，不啟動額外名稱掃描。第一版不做名稱掃描游標或背景重試。名稱距離檔尾太遠時，可能持續 incomplete；使用者仍可用 ID 操作，這是有界工作量的明確取捨。

讀取前後核對同一 canonical file 的 dev／ino、nlink、size、mtime／ctime 及 header identity。一般 append、replace 或 truncate 期間不回傳可能混配的名稱，回報 incomplete／reload-required。這不是未受管理 writer 的鎖，也不承諾對惡意同時原地改寫有 race-free 保證。

## API 與更新

- POST `/api/v1/sessions` 接受新建用 name。舊 client 不送 name 時維持行為。
- GET `/api/v1/projects/:id/native-sessions` 的候選新增 `nameInfo`。保留既有 id、file、error 與已加入排除規則。名稱錯誤不假稱無名稱。
- GET `/api/v1/sessions` 在 ledger 紀錄上衍生 `nameInfo`，不回寫 DB。
- GET `/api/v1/sessions/:id/snapshot` 在 runtime snapshot 上衍生 `nameInfo`，可用完整單檔預算。讀取名稱不得啟動、reload 或停止 runtime。
- Snapshot 型別可新增選填 nameInfo；runtime SSE snapshot 不必掃描名稱，也不可清除已讀 metadata。
- 名稱讀取錯誤只影響名稱 metadata。原有 history、路徑及 writer 安全檢查不得被繞過。

## Web 狀態與畫面

- 新建按鈕旁新增「Session 名稱（選填）」欄位。送出成功才清除名稱。新建失敗保留輸入。加入既有 session 不送此欄位。
- 加入候選顯示名稱與完整 Pi ID；受管清單顯示名稱及可縮寫的 Pi ID，保留 App ID 縮寫與 profile。
- 頁首標題顯示名稱。另列完整「Pi session ID」及「App ID」。未命名顯示「未命名 Session」。讀取未完成及失敗顯示不同文字。
- 名稱 metadata 以 App ID 索引，與高頻 SSE runtime snapshot 分開保存。HTTP metadata 只在既有 generation／serial guard 有效時套用。切換、logout、auth-expired 不可帶入其他 session 的名稱。
- 清單載入時填入名稱。選取、重連及既有 HTTP sync 成功時更新目前 session 名稱。SSE 不帶 nameInfo 時保留 metadata，不拿舊 runtime 值覆寫原生檔案結果。
- 新增「重新整理 Session 清單」按鈕。此動作更新受管清單與候選清單，不重播操作，也不強制 reload runtime。不新增輪詢。
- 長名稱與 ID 可換行。桌面及手機不能因名稱把主畫面撐出水平範圍。

## Execution flow

```text
name input -> shared normalize/validate -> POST schema
           -> O_EXCL create(header + session_info) -> fsync -> ledger -> DTO
native JSONL -> safe open/header -> reverse bounded metadata scan
             -> identity recheck -> nameInfo -> list/snapshot HTTP
HTTP + valid view generation -> name metadata map -> title/list + Pi ID
runtime SSE -----------------> runtime snapshot   (does not erase name)
manual refresh --------------> list GET only       (no operation replay)
```

## 前置證據

Pi 1.3.0 SessionManager 最小實測已驗證預寫 session_info 的讀取、純 open 不改 bytes、追加 user 訊息後重開名稱保留、最新名稱不在目前分支時仍採全檔追加順序，以及空名稱清除。

有效證據：`.test-artifacts/session-naming-v1-preflight/run-20261019T041602Z-32617/` 的腳本與 report。較早 preflight 的 branch fixture 未觸發真正的非目前分支情境，不引用該舊 fixture 證明此行為。這不是 CLI、provider 或完整 runtime 驗收。

## 驗收

- Unit：選填、空白、128／129 code points、中文／emoji、內部控制字元；全檔最新名稱、非目前分支、清除、partial tail、CRLF、非法／過長名稱及大筆資料。
- Budget：單檔與共用 byte／time 預算實際觸發；不能把 incomplete 當 unnamed；保留資料大小有界。
- API：named create、無名相容、name + nativeFile 拒絕且原檔 hash 不變、候選／受管／snapshot 名稱、原生身分不符、GET 不啟動 runtime、重啟後仍讀到名稱。
- Race：append、replace、truncate 期間拒絕混配；遲到 A metadata 不污染 B；SSE 缺少名稱不清除標題。
- Browser：desktop/mobile 新建、加入、同名區分、完整 Pi ID／App ID、純文字顯示、刷新後外部改名、錯誤保留輸入及長名稱排版。
- Regression：typecheck、lint、format、unit/integration、build 及 browser suite。只在隔離測試環境執行。不讀寫個人 session。不呼叫模型。不部署。

## 手機側欄補正

本期名稱欄位、刷新按鈕與較高的 session 列不得壓扁清單。側欄以 100dvh 限高並允許垂直捲動。控制項不受 flex 壓縮。受管 nav 至少保留 120px，列依內容高度排列，並在 nav 內捲動。較小螢幕可捲動整個側欄。驗收必須以實際 pointer click 選取多個 session，不得以鍵盤或強制點擊代替觸控可用性證據。
