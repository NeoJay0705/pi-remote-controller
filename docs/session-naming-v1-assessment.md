# Session 命名與原生識別顯示評估 v1

## 狀態與目標

- 追蹤名稱：`session-naming-v1`。
- 目標：確認新建 session 的命名可行性，並確認既有 session 的名稱及原生 Pi session ID 是否顯示。
- 狀態：需求、靜態現況評估與後續設計建議已歸檔。未實作命名或名稱顯示功能。
- 本期只做評估。不得把建議行為解讀為目前功能，也不得把文件歸檔解讀為部署完成。

## 需求完整性與範圍

使用者需求：

> 新建 session 評估能不能命名，以及如果既有 session 有名稱，畫面上會不會也顯示該名稱和 pi session id。

需求足夠開始可行性評估與高階設計。評估須區分 Pi 原生能力、Controller API 能力及 Web 畫面行為。

原文尚未明確要求直接新增功能。因此，本期不變更 API、UI 或原生 session。若要實作，須先確認下列建議範圍。名稱格式上限與更新時機也須定案，再形成實作驗收標準。

## 使用情境

1. 使用者新建 session。使用者希望用工作名稱辨識 session，而不是只靠 ID。
2. 使用者加入已在 Pi 命名的既有 session。使用者希望保留原名稱，並在 Web 辨識相同 session。
3. 使用者切換多個受管 session。名稱可重複，因此仍須用原生 Pi session ID 確認身分。
4. 使用者開啟未命名 session。未命名不應阻止建立、加入或讀取。
5. 使用者在原生 Pi 修改名稱。後續 Web 讀取應有明確更新時機，不可宣稱未設計的即時同步。

## 現況結論

| 問題 | 結論 | 靜態依據 |
| --- | --- | --- |
| Pi 原生 session 能命名嗎？ | 可以。已安裝 Pi 1.3.0 文件提供 `/name`、`--name`／`-n` 及 RPC `set_session_name`。 | Pi `sessions.md`、`session-format.md`、`rpc-commands.md` |
| 此 Web 能在新建時輸入名稱嗎？ | 目前不行。UI 沒有名稱欄位。建立 API 的允許欄位不含名稱。 | `src/web/main.tsx` 的 `create` 與新建按鈕；`src/web/api.ts` 的 `api.create`；`src/server/app.ts` 的 `POST /api/v1/sessions` |
| 新建檔案有原生名稱嗎？ | Controller 目前只寫 session header，不寫 `session_info` 名稱紀錄。 | `src/server/native-sessions.ts` 的 `createNative` |
| 既有 session 的名稱會顯示嗎？ | 目前不會顯示為 session 標題或清單名稱。候選清單、受管清單及 Snapshot 沒有傳遞名稱欄位。 | `listNative`、`SessionRecord`、`Snapshot`、`src/web/api.ts` 與 `src/web/main.tsx` |
| 原生 Pi session ID 會顯示嗎？ | 會。加入候選選單顯示完整 ID；受管側欄顯示前 8 碼；成功載入 Snapshot 後，頁首顯示完整原生 ID。 | `src/web/main.tsx` 的加入選單、受管 nav 與 header |
| App ID 與 Pi session ID 是相同值嗎？ | 不是同一識別概念。頁首先顯示原生 ID，另列 App ID。不可用 App ID 代替 Pi session ID。 | `src/server/store.ts` 的 `SessionRecord` 與 `createSession`；Web header |

以上為 repository 原始碼及本機已安裝套件的靜態結論。沒有啟動瀏覽器、Pi、模型或正式服務。正式部署是否使用相同版本，未驗證。

## 已確認的技術限制

- 原生名稱是 JSONL 中的 `session_info.name`，不是 header 欄位、檔名或 session ID。
- 已安裝 Pi 的 `SessionManager.getSessionName()` 從所有 entries 的檔案追加順序反向尋找最新 `session_info`。它不是只看目前對話分支。
- 最新名稱為空字串時，Pi 會視為清除名稱。不得繼續沿用更早的非空名稱。
- RPC `get_state` 可回傳 `sessionName`。但未啟動 runtime 的 session 仍須能列出名稱，不能只依賴 RPC。
- 現行 `inspectNative` 只解析 header。現行候選清單依靠此函式，尚未讀取名稱紀錄。
- 名稱可能位於大型檔案深處。找不到近期名稱不等於未命名。掃描必須有工作量、記憶體、時間及清單總工作量限制。
- 既有 history 分頁以目前分支為依據。不得用某一頁的 history 代替全檔名稱 metadata。
- 原生 JSONL 是名稱的建議權威來源。不得另建一份與 Pi 名稱分歧的 Web 別名，除非使用者另行要求。
- 既有路徑驗證、唯讀 GET、單 writer 保護及未知操作不自動重播的規則須維持。

## 後續實作建議：待確認，不是本期已實作需求

### 建議範圍

- 新建時提供選填名稱。空白輸入維持未命名行為。不要求名稱唯一。
- 名稱寫入原生 `session_info`。不變更原生 ID、App ID、檔名或 project 身分。
- 加入既有 session 時只讀原名。加入動作不重新命名，也不改寫原檔。
- 加入候選清單、受管清單與主畫面標題顯示名稱。有名稱時仍提供原生 ID。沒有名稱時明示未命名。
- 主畫面使用明確的「Pi session ID」及「App ID」標籤。完整原生 ID 應可取得。側欄可保留縮寫，但不能把名稱或縮寫當作唯一識別。
- 本期不建議加入既有 session 重新命名、AI 自動命名、依名稱搜尋或排序。這些是獨立增量需求。

### 方案與取捨

1. 對全新且尚未交給 runtime 的檔案，可在建立時一併寫入合法 `session_info`。此方向可避免只為命名而啟動 Pi、模型設定及 extensions。須先以隔離測試確認 Pi 可載入且名稱不丟失。
2. RPC `set_session_name` 是 Pi 已提供的命名介面，但需要 runtime。它不應被誤當成目前 Web API 已支援的操作。若未來允許修改既有名稱，須另設 writer、安全與未知結果規則。
3. 只在前端顯示別名最省後端改動，但無法與原生 Pi 共用名稱，因此不建議。
4. 讀取名稱建議使用有界 metadata 掃描。遵守全檔最新紀錄語意，不新增持久歷史索引，也不為清單啟動 runtime。列表掃描總預算與續讀方式須在實作設計中定案。
5. 更新名稱可先採載入清單、選取 session 或明確重新整理時讀取。不承諾外部改名後即時更新。最終更新時機須先確認。

### 輸入與錯誤處理

- 名稱須當作純文字顯示。不得當 HTML、Markdown、shell 指令或檔名執行。
- 實作前定義 trim、換行／控制字元處理與長度單位及上限。前後端規則必須一致。超限不得靜默截斷後儲存。
- 名稱過長或格式無效時，拒絕建立並保留輸入。不得先建立未命名 session 再假裝命名成功。
- 原生 ID 已知但名稱掃描失敗或超出預算時，可降級顯示 ID。須標示「名稱讀取未完成／失敗」，不得假稱未命名。安全路徑或身分驗證失敗仍須遵守既有拒絕規則。
- 最新合法 `session_info` 的空名稱代表已清除。缺少紀錄、讀取未完成與檔案損壞須分開處理。
- 檔案在讀取期間被替換或截短時，須要求重新載入，不沿用錯誤的名稱與 ID 配對。
- 建立檔案成功但登記失敗時，須明示失敗並保留安全復原方式。不得刪除不確定歸屬的既有 session。
- 建立回應遺失時，不自動重送 POST，以免產生重複 session。先重新讀取清單以確認結果。

## 後續驗收矩陣：尚未執行

| 面向 | 未來實作須驗證的行為 |
| --- | --- |
| 新建命名 | 選填、空白、中文、同名、重啟後保留；原生 Pi 載入後得到相同名稱與 ID |
| 既有名稱 | 加入前、加入後、受管清單及主畫面均正確；加入前後原檔 hash 不變 |
| 最新名稱語意 | 多筆改名、最新空名稱清除、名稱位於非目前分支時符合 Pi 行為 |
| ID 辨識 | 同名 session 不混淆；原生 ID 與 App ID 標示正確；完整原生 ID 可取得 |
| 安全輸入 | HTML、換行、控制字元、長字串；名稱不得執行或影響路徑 |
| 有界讀取 | 大檔、無名稱、名稱離檔尾很遠、多檔清單；超出預算時狀態明確 |
| 外部更新 | 重新整理後讀到新名稱；replace、truncate、partial tail 不誤配身分 |
| 錯誤與競態 | 建立失敗、登記失敗、回應遺失、切換時遲到回應；不自動重送、不雙寫 |

## 資料流

目前：

```text
新建按鈕 -> create -> api.create(projectId, profileId)
         -> POST /sessions -> createNative(header only) -> ledger

既有檔案 -> inspectNative(header only) -> listNative(ID only)
         -> 加入 / ledger -> sessions + snapshot -> UI(ID only)
```

建議方向，尚未實作：

```text
選填名稱 -> 前後端驗證 -> 建立 header + session_info -> 登記
既有 JSONL -> 安全開檔 -> 有界 metadata 掃描 -> 最新 name + native ID
                                            -> API -> 清單與頁首
超出預算 / 讀取失敗 --------------------------> ID + 明確讀取狀態
```

## 評估驗收與自我檢查

- 已區分 Pi 支援與此 Web 尚未支援的功能。
- 已逐一回答新建命名、既有名稱與原生 ID 顯示問題。
- 已區分原生 ID、App ID、顯示名稱與檔名。
- 已列出使用情境、限制、取捨、錯誤處理及待確認事項。
- 已避免把建議行為或靜態閱讀當作實作及動態測試通過。
- 本期不需要功能測試。真 Pi 載入、名稱持久化、瀏覽器顯示與正式部署狀態均未驗證。

## 來源

Repository：`src/server/app.ts`、`src/server/native-sessions.ts`、`src/server/native-reader.ts`、`src/server/store.ts`、`src/server/runtime.ts`、`src/shared/contracts.ts`、`src/web/api.ts`、`src/web/main.tsx`。

本機已安裝 `@earendil-works/pi-coding-agent` 1.3.0：`docs/sessions.md`、`docs/session-format.md`、`docs/rpc.md`、`docs/rpc-commands.md`、`dist/core/session-manager.js` 的 `appendSessionInfo`／`getSessionName`。這些套件路徑相對於已安裝的 Pi package root，不是本 repository 的 `docs`。
