# Pi Remote Workspace — v1 需求基線

公開版本已將主機位址與個人路徑匿名化；下列歷史驗證結果不因此改變。

## 1. 文件狀態與目標

狀態：需求已足夠進入系統設計。本文不代表系統已實作或驗收。

目標：透過 Tailscale 或其他 VPN，在電腦與手機瀏覽器中操作 Pi 主機上的原生 sessions，並能與該主機的 Pi TUI 交替接續開發工作。

專案位於獨立的 `pi-remote-controller` repo。它是 Pi 的遠端操作入口，不是新的 Agent 引擎。它不沿用 Telegram、Flow、guest 或試用配額機制。

本文將使用者已確認的使用政策與為達成政策所需的正確性條件分開說明。技術選型另於設計階段決定。所有執行時驗收目前均未驗證。

## 2. 已確認的範圍與使用政策

- 只有一位 Owner 使用服務。
- Owner 可能在多個裝置開啟網頁。使用前會重新載入頁面。
- 使用者預期同一時間只有一個網頁送出請求。不要求多人協作或多裝置同時編輯。
- 重新載入頁面不是防雙寫或存取驗證機制。
- PC 網頁與 smartphone 網頁均屬 v1 範圍。
- 未來可能開發 mobile app。本次不開發 app。
- VPN 是部署環境提供的連線前提。本 repo 不實作 VPN。具體 VPN 產品不是目前的應用綁定。
- 網頁非預期關閉、重新整理、VPN 斷線、手機鎖屏或切換到其他 session，都不代表取消工作。
- 工作由主機端持續執行。主機休眠、離線或程序故障不在瀏覽器可保證持續執行的範圍內。
- Owner 需要在 Web 與原生 Pi TUI 之間接續相同 session。
- Pi 原生允許同 session 雙開。不得依靠其目前行為防止雙寫。
- 使用者自行管理不同 sessions 操作相同檔案或 worktree 的風險。v1 不強制跨 session 的 worktree 排隊或檔案鎖。
- Git commit 是一般 prompt。沒有專用 Git GUI、commit 審批流程或自動 commit 功能需求。
- Prompt templates 已由使用者處理。使用者會透過 prompt 操作。不另外建置 template 編輯器或模板引擎。
- Extensions 可依使用者測試結果逐步加入。不得將未驗證 extension 描述成已支援。

## 3. 使用情境

### U01：選擇專案並接續 Session

Owner 選擇主機上的專案工作目錄。Owner 選擇既有 Pi session，或明確建立新 session。介面顯示操作目標與實際啟動設定。找不到指定 session 時，不得靜默建立替代 session。

### U02：討論、實作、Commit 與 Compact

Owner 透過 prompt 討論需求。Owner 以後續 prompt 要求實作或 commit。系統不額外解讀出專用 Git 工作流程。Owner 可執行 Pi 原生 compact，然後繼續同一個 session。不得以自製摘要和新 session 取代原生 compact。

### U03：執行中插入 Steering

Owner 明確選擇 steering，並送出訊息。訊息在目前 assistant turn 的工具呼叫完成後、下一次模型呼叫前交給 Pi。Steering 不代表立即中斷正在執行的工具。

### U04：執行中加入 Follow-up

Owner 明確選擇 follow-up，並送出訊息。Pi 在目前工作沒有剩餘工具呼叫或 steering 時，才處理 follow-up。介面不能把 follow-up 當成 steering。也不能把它顯示成已執行。

### U05：Esc 式停止，再送出 Prompt

Owner 要求停止目前 session 的執行。系統先清除待執行的 steering 與 follow-up，再要求 Pi abort。系統確認目前工作已停止後，才接受新的普通 prompt。清出的訊息保留原類型與各類內順序，供 Owner 檢視或重送。不得自動重送。不得覆蓋原本未送出的草稿。

### U06：離線、換裝置與切換 Session

Owner 關閉頁面、失去連線、換裝置或改看另一個 session。原工作持續執行。重連後，介面重新取得主機上的狀態、已保存歷史與可確認的佇列資訊。切換畫面只改變觀看目標，不更換正在執行工作的 session 綁定。

### U07：Web 與 TUI 交接

Owner 請求交接同一個 session。系統停止接受新的衝突操作。現有工作正常結束，或由 Owner 明確取消。待目前工作與必要清理真正完成後，系統關閉 RPC runtime，等待相關程序退出，再釋放寫入所有權。受管理的 TUI 入口取得同一份所有權後，才開啟該 session。TUI 完全退出後，Web 必須重新載入最新 session，而不是重用舊記憶體狀態。

## 4. 功能與正確性需求

| ID  | 需求                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | 主機端服務透過 Pi 原生 RPC 控制 session。瀏覽器不直接連接 Pi 的 stdin/stdout。                                                                        |
| R02 | 支援專案選擇、既有 session 接續與明確建立新 session。保留原生 session 身分與歷史。                                                                    |
| R03 | 顯示目前專案、session、模型、thinking、執行狀態與連線狀態。送出操作時綁定明確的 session，不隨目前畫面改變。                                           |
| R04 | 支援一般 prompt、執行中的 steering 與 follow-up。執行中必須明確標示訊息類型，不默默猜測。                                                             |
| R05 | 使用 Pi 原生 steering 與 follow-up 佇列。不額外建立另一套不相容的模型訊息排程。顯示可確認的待執行與已處理狀態。                                       |
| R06 | 提供 Esc 式「清除佇列並停止」。不能只呼叫 abort 後就宣稱所有排隊工作都停止。                                                                          |
| R07 | 停止期間不得讓新 prompt 或 enqueue 穿插破壞停止順序。新 prompt 必須等停止完成。取消不刪除已發生的對話，也不承諾回滾檔案、命令或 commit。              |
| R08 | 瀏覽器連線生命週期與 Pi runtime 生命週期分離。斷線、頁面關閉與切換畫面不自動取消或釋放 session 寫入所有權。                                           |
| R09 | 多個 sessions 可被管理與執行。它們的 prompt、佇列、停止操作、歷史和 runtime 狀態不得串用。不同 sessions 的檔案衝突由使用者負責。                      |
| R10 | 支援重新連線後恢復主機權威狀態。狀態同步前不得把舊畫面當成最新狀態。不要求逐字重播全部中間 token。                                                    |
| R11 | 區分操作已接受、已排入、正在處理、已停止與已結束。prompt 的成功回應不等於工作完成；一個低階 agent run 結束也不一定代表整個 session-level 工作已停止。 |
| R12 | 防止已知重複請求再次提交有副作用的工作。接受結果不明時先查核，不盲目重送。不得承諾任意 shell 或 Git 副作用具備 exactly-once。                         |
| R13 | Web 與受管理 TUI 共同遵守同 session 單一寫入者規則。idle 的活 RPC runtime 仍持有所有權。不得在程序與清理未完成時提早交接。                            |
| R14 | 交接失敗時保留安全的阻擋狀態並回報。不得因等待逾時就假設舊 writer 已消失。服務重啟後須處理仍存活的舊程序，不能直接啟動第二個 writer。                 |
| R15 | 支援可選的主機端啟動設定。不得把使用者提供的開發設定強制套用到所有 sessions。展示實際生效設定，不靜默改模型、thinking 或移除必要工具。                |
| R16 | 使用 Pi 原生 prompt template 行為。必要的 compact 等控制操作使用相對應 RPC 能力。不能把所有 TUI slash commands 都當成普通 prompt 可直接執行。         |
| R17 | PC 與手機網頁可閱讀串流及最終 Markdown、程式碼與工具活動。長行可捲動。長歷史可按需載入。不以固定寬度終端畫面作為唯一介面。                            |
| R18 | 未來 app 可使用同一服務能力。業務操作不僅存在於網頁元件內。本次不開發 app、app SDK、推播或完整 IDE。                                                  |

## 5. 原生 RPC 語意與限制

已核對 Pi 官方 RPC 文件。以下是文件契約，不是本專案已完成的執行時驗證。

| 意圖         | 原生能力                                                    | 注意事項                                                                                                                |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 一般輸入     | `prompt`                                                    | 成功回應代表已接受、排入或由 handler 處理，不代表執行成功。                                                             |
| Steering     | `steer`，或 `prompt` 的 `streamingBehavior: "steer"`        | 在工具批次完成後交付，不立即打斷當前工具。                                                                              |
| Follow-up    | `follow_up`，或 `prompt` 的 `streamingBehavior: "followUp"` | 等工具與 steering 工作完成後交付。                                                                                      |
| Esc 式停止   | `clear_queue`，然後 `abort`                                 | `abort` 單獨使用時，留下的佇列仍可能繼續執行。清除結果要保留給 Owner。                                                  |
| 排隊模式     | `set_steering_mode`、`set_follow_up_mode`                   | Pi 支援 `all` 與 `one-at-a-time`。v1 不另加佇列管理 UI 需求。實際模式須明列。                                           |
| 狀態與佇列   | `get_state`、`queue_update` 等                              | 不能僅憑 command acknowledgement 推斷後續狀態。handler 也可能消耗訊息。                                                 |
| 執行結束     | `agent_settled` 等生命週期訊號                              | `agent_end` 之後仍可能有 retry、compaction、steering 或 follow-up。`agent_settled` 本身也不代表沒有發生 provider 錯誤。 |
| 原生 Compact | `compact`                                                   | 保留原生 session。失敗時明確回報，不改用新 session。                                                                    |
| 正常關閉     | 關閉 Pi 子程序 stdin，並等待退出                            | 等待逾時不是程序已退出的證據。具體升級終止與復原策略留待設計。                                                          |

直接使用 `steer` 或 `follow_up` 不能執行 extension commands。透過 `prompt` 送出 extension command 可能立即執行，不遵守一般排隊語意。不得把這種行為描述成已安全排隊。Extensions 的命令與 UI 相容性須另外驗證。

### 5.1 Session 寫入所有權的保證邊界

- 受管理的 Web 與 TUI 寫入者必須使用共同互斥協定。
- v1 設計須提供可遵守協定的 TUI 交接入口或等價方式。具體實作尚未決定。
- 僅在 Web 服務放一把鎖，不能阻止不遵守協定的原生 Pi。
- 使用者直接執行未受管理的 `pi --session ...` 仍可能造成雙寫。此路徑不在受管理入口的防護保證內。
- 不宣稱能可靠偵測所有外部 Pi 程序，也不以最後寫入者勝出作為同步策略。
- 若必須連任意原生啟動都強制防雙寫，需另行評估 Pi 本身或所有啟動入口的配合。這不是目前已具備的能力。
- RPC runtime idle 不等於已釋放所有權。關閉頁面也不等於交接。
- 跨主機複製 repository 與 session 後的同步不屬 v1。PC 與手機在本需求中都是連到同一個 Pi 主機的用戶端。

## 6. 使用者提供的開發設定

以下是目前常用的開發啟動範例。它不是所有 sessions 的強制預設。它也不是已驗證可用的產品設定。

```sh
PI_SUBAGENT_SRC="$(npm root -g)/@earendil-works/pi-coding-agent/examples/extensions/subagent"
pi --provider openai --model gpt-6.1-sol --thinking high \
  -e "$PI_SUBAGENT_SRC/index.ts" \
  --tools +subagent,+codemode \
  --append-system-prompt "$HOME/.pi/agent/subagent-parent-policy.md" \
  --session "<session-path-or-id>"
```

啟動設定需能表達 provider、model、thinking、extensions、tools、append-system-prompt 與目標 session。設定格式與管理介面留待設計。不得將網頁輸入拼接成任意 shell 啟動命令。

`+subagent,+codemode` 是在 Pi 預設工具上增補工具，不是只允許這兩個工具。Controller 不得誤改成不同的工具權限。

Policy 檔內容、模型可用性、subagent、codemode 與 extension 在 RPC 下的行為目前都未驗證。歸檔時沒有讀取個人 policy 或 auth，也沒有執行此命令。

先保留設定的表達能力。只有經使用者驗證的 extension 才列為支援。不得為了讓 session 啟動而靜默忽略必要 extension。若缺少依賴或功能不支援，應明確失敗或提示不相容，不自動換模型或降低設定。

Pi RPC 可轉送部分 extension UI，例如 select、confirm、input 與 editor。TUI-only custom UI 並不保證可用。初期不承諾完整 extension UI 覆蓋，也不先重建所有 TUI 元件。

## 7. 安全與錯誤處理

### 7.1 安全條件

- 私有 VPN 是網路邊界。服務仍須拒絕非 Owner 的操作。身份驗證與 VPN ACL 的具體結合留待設計。
- 不直接公開 Pi 原始 RPC 或控制介面到 Internet。
- 防止跨站請求與不可信來源利用瀏覽器執行操作。重新載入頁面不能取代這些控制。
- 模型回覆、工具輸出與專案內容都屬不可信呈現資料。不得執行其中的 HTML 或 JavaScript。不得預設載入不可信外部嵌入內容。
- Provider 憑證保留在主機端。不得放在 URL、一般日誌或回傳給瀏覽器。
- 專案工作目錄與 project trust 都不是 OS sandbox。Prompt 中的唯讀要求也不是硬性存取控制。
- 不因為遠端模式而自動批准未知專案或擴大 Pi 的 OS 權限。
- VPN 不會讓遠端 provider 變成本機離線模型。模型資料交換仍依 Pi 的 provider 設定運作。

### 7.2 故障行為

| 狀況                             | 必要行為                                                                 |
| -------------------------------- | ------------------------------------------------------------------------ |
| 頁面關閉、失去連線或切換 session | 保留工作與主機端所有權。重連後重新同步。                                 |
| 明確停止                         | 清除佇列，再 abort。等待實際停止。無法確認時不得顯示已停止。             |
| 停止後重送                       | Owner 明確重送。不得自動執行剛清出的訊息。                               |
| 清理、abort 或交接逾時           | 保留阻擋狀態。不得釋放寫入權或允許新 writer。                            |
| Pi 程序或服務崩潰                | 查核既有程序與歷史。回報失敗或結果不明，不盲目重跑有副作用的工作。       |
| 已排入訊息的執行狀態無法恢復     | 標示未確認或中斷。不得假稱原生記憶體佇列跨程序重啟仍存在。不得自動重送。 |
| Provider、認證、模型或設定失敗   | 回報安全且可處理的錯誤。不輸出憑證。不靜默替換設定。                     |
| Extension 命令或 UI 不相容       | 明確提示限制。不把未知互動當作已批准。                                   |
| Compact 失敗                     | 回報失敗。保留既有歷史。不建立替代 session。                             |
| 工具、檔案或 Git 已有副作用      | 取消不等於回滾。結果不明時要求查核，不自動重做。                         |

取消與程序退出的實作須核對受管理工具、subagent 和必要清理。不得僅因頂層收到 abort 回應，就宣稱未知或獨立背景服務也已終止。

## 8. 驗收條件

以下都是未來驗收案例。歸檔不表示任何案例已通過。

| ID  | 可觀察的驗收條件                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A01 | Owner 能從 VPN 內的 PC 與手機網頁使用服務。未授權操作不能啟動 Pi 或讀取 session 內容。                                              |
| A02 | 開啟既有 session 後保留原生 ID、歷史與工作目錄。找不到指定 session 時不靜默新建。                                                   |
| A03 | 一般 prompt 可串流顯示答覆與工具活動。最終狀態不會在 prompt acknowledgement 或單一 agent_end 時提前顯示成功。                       |
| A04 | 工作執行中加入 steering。它不立即中斷當前工具，並在 Pi 定義的時機交付。                                                             |
| A05 | 工作執行中加入 follow-up。它不被當作 steering，且在目前工具與 steering 工作完成後才交付。                                           |
| A06 | 有 steering 與 follow-up 排隊時執行 Esc 式停止。待執行佇列被清除，內容可恢復，沒有自動續跑。新 prompt 只在停止完成後執行。          |
| A07 | 執行中關頁、重新整理、鎖屏、斷 VPN 與切換 session。原工作不被自動取消。重連後能取得實際狀態與已保存結果。                           |
| A08 | 不同 sessions 的 prompt、佇列與取消不互相影響。沒有強制跨 session 的同 worktree 排隊。                                              |
| A09 | 在受管理 Web 與 TUI 同時請求同 session 寫入時，只有一個 writer 可以取得所有權。活著但 idle 的 RPC runtime 仍阻擋 TUI。              |
| A10 | 完成 Web 到 TUI 再回 Web 的交接。RPC 程序與必要清理在釋放權利前完成。Web 回來後取得 TUI 新增的最新歷史。                            |
| A11 | 交接或清理失敗時不啟動第二個 writer。服務重啟且舊 writer 仍存活時也不造成雙開。                                                     |
| A12 | 重複請求、接受結果不明或服務崩潰，不導致自動重做實作或 commit。原生佇列無法恢復時有明確狀態。                                       |
| A13 | 可以使用不同的啟動設定。必要模型、工具或 extension 不存在時明確回報。使用者範例未測試前不列為已相容。                               |
| A14 | 手機可閱讀長文字與程式碼。惡意 Markdown、HTML 或工具輸出不能執行腳本。Compact 保留同一個 session。Git commit 仍由一般 prompt 操作。 |

## 9. 非目標與待設計事項

### 9.1 v1 非目標

- Telegram、guest、invite、多租戶或多人協作。
- Mobile app、推播、app SDK、完整 IDE 或遠端桌面。
- 專用 Git GUI、commit 審批、自動 commit 或自動 push。
- Template 編輯器、另一套模板引擎或自製 compaction。
- 自動管理 worktree、跨 session 檔案鎖或強制跨 session 工作排隊。
- 完整重現所有 Pi TUI 或任意 extension UI。
- 任意未受管理原生 Pi 程序的強制防雙寫保證。
- 跨 Pi 主機的 session 和 repository 同步。
- 逐字重播所有中間串流 token。
- 保證任意工具副作用可回滾或 exactly-once。

### 9.2 留待系統設計

- 網頁框架、主機端語言、服務 API 與串流傳輸方式。
- VPN、身份驗證、瀏覽器來源限制與安全連線的部署方式。
- Session 定位、互斥協定、受管理 TUI 入口與程序監督。
- idle runtime 的保留與回收政策。回收不得破壞所有權與交接要求。
- 操作識別、狀態保存、重連同步、容量與保留期限。
- 停止與正常關閉的 deadline、升級終止和故障復原。
- 啟動設定的資料格式、實際排隊模式與設定相容性檢查。
- 支援的 Pi 版本、部署 OS、extension 清單與其取消／清理契約。
- PC 與手機的具體版面、元件與工具輸出折疊方式。

這些是設計工作，不要求使用者先選資料庫、WebSocket 或鎖實作，才能開始設計。

## 10. 參考與驗證邊界

### 10.1 本機版本基準

本次需求核對以本機全域安裝的 `@earendil-works/pi-coding-agent@1.3.0` 為基準，不是其他 repo 的 `node_modules` 版本。

核對的安裝目錄為 `$HOME/.nvm/versions/node/v22.21.1/lib/node_modules/@earendil-works/pi-coding-agent/`。目前 `PATH` 解析到的 `pi` 符號連結指向此套件的 `dist/bundle/cli.js`。版本依據是該套件的 `package.json`。

已核對此版本隨附的 RPC 文件、型別與相關實作。`steer`、`follow_up`、`clear_queue`、`abort` 及原生執行生命週期契約仍適用。`abort` 實作包含中止 retry、compaction 與 branch summary，並等待 session idle。這不表示任意 extension、subagent 或獨立背景程序的停止已經驗證。

此確認限於本機安裝版本與靜態契約。沒有查詢 npm registry，也沒有執行 `pi --version` 或啟動 Pi。不得據此宣稱網路上的最新發布版本或執行時驗收已通過。

### 10.2 文件來源與未驗證項目

Pi 文件來源：`@earendil-works/pi-coding-agent` 安裝套件內的 `docs/rpc.md`、`docs/rpc-commands.md`、`docs/json.md`、`docs/rpc-extension-ui.md`、`docs/cli.md`、`docs/sessions.md`、`docs/prompt-templates.md` 與 `docs/security.md`。

已完成的是文件核對與需求歸檔。尚未執行 Pi RPC、真模型、subagent、codemode、Web、VPN、TUI 交接或雙寫測試。設計與實作必須對目標 Pi 版本重新確認這些契約。

設計、決策、解釋與 review 由父 agent 負責。只有實際檔案修改與測試才委派 implementation-worker。需求歸檔不授權部署、讀取個人憑證或修改 Pi 本身。
