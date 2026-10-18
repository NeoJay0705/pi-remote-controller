# Session Access v1：免交接 Web／TUI 接續與原生 JSONL 按頁讀取

> 最新安全修補驗證為 142 tests／23 files、16 browser cases。正式服務已依 Owner 授權停止，本次修補未部署。範圍、限制與證據見[安全審查紀錄](security-review.md)。以下 140 tests 等數字均為該階段歷史記錄。

狀態：**大型 session 400 相容性修正版已部署；部署檢查通過；實際個人大 session 載入效果仍待 Owner 確認。真 Pi/TUI/模型完整端到端未驗證。**本表逐案記錄已執行離線範圍與未驗部分。固定 release 為 `session-access-v1-history-fix-140`，正式 URL 為 <http://TAILNET_IP:4317>。需求見[需求文件](session-access-v1-requirements.md)，設計見[設計文件](session-access-v1-design.md)。

大型 session 400 相容性修正已實作；隔離 23 files／140 tests、16 browser cases 通過，且已完成部署。實際個人大 session 的觸發點與載入效果尚未在 Owner 檔案確認。原有 130／14 與 97／12 基準、部署成功歷史及舊部署 harness 的 snapshot metadata 檢查失敗歷史均保留。

## 需求至驗收案例對照

| 需求 ID              | 驗收 ID               | 驗收條件                                                                                                                                 | 狀態                                                                                        |
| -------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| session-access-v1-R1 | session-access-v1-A01 | 同一主機及檔案完成 Web → 原生 Pi → Web；模型上下文看見本機新增訊息。                                                                     | 未驗證：只有 fake cache／parent 鏈情境通過；真 Web/native TUI/model 端到端未測。            |
| session-access-v1-R1 | session-access-v1-A02 | 原生 session ID 與 App ID 清楚區分；複製命令含正確 cwd 與必要 session-dir 參數。                                                         | 列明離線來源／合成 UI 情境通過；真人複製與真 Pi 啟動未測。                                  |
| session-access-v1-R1 | session-access-v1-A03 | 忙碌 RPC、queue、dialog、compacting、tool、retry 或未知狀態時不 reload；點選、refresh、reconnect 只恢復 history/snapshot。               | 部分通過：已有指定離線案例；thinking profile／file-hook 矩陣未完整覆蓋。                    |
| session-access-v1-R1 | session-access-v1-A04 | 接續前 server 序列化檢查、必要 reload、確認與 prompt；不 replay prompt；switch/reconnect 多視窗競態不送舊操作。                          | 部分通過：合成 reload/no-replay 有驗；真多視窗 late events 與 context edits 未驗。          |
| session-access-v1-R1 | session-access-v1-A05 | Hook 取消、timeout、identity/file、thinking、model/profile 不符時阻擋 prompt，且無 silent fallback；draft 與 late-event guard 保持正確。 | 部分通過：若干取消／timeout／identity 情境已驗；完整 hook/profile 矩陣及 late events 未驗。 |
| session-access-v1-R1 | session-access-v1-A06 | 外部變動遇忙碌狀態時顯示衝突並擋新接續；不強制 abort；idle 同檔 switch 驗證 `cancelled=false` 與預期 branch/entries。                    | 離線列出的 busy conflict／同檔 reload 情境通過；不代表真 TUI。                              |
| session-access-v1-R1 | session-access-v1-A07 | 不聲稱偵測未受管理 TUI idle 或單 writer；工作完成檢查 queue/背景工作，舊 TUI 重用前重新載入。                                            | 邊界說明已 review；真人操作與 queue／背景工作完成流程未驗。                                 |
| session-access-v1-R2 | session-access-v1-A08 | 至少 110 MiB 合成 JSONL 可列出、加入及翻頁；量測單次工作、memory、時間與 response bytes 有界。                                           | 離線列出的 115,343,509-byte（約 110 MiB）fixture／分頁情境通過；不是 115 MiB。              |
| session-access-v1-R2 | session-access-v1-A09 | 多分支依 parentId、compaction/context、Unicode、CRLF 與不完整尾行正確讀取；不以最後 N 行充當分頁。                                       | 部分通過：已執行列出的 case；多分支與 compaction/context 的完整矩陣未驗。                   |
| session-access-v1-R2 | session-access-v1-A10 | Append 游標可續；truncate、replace、branch 變更明示重載；游標驗證 file identity、offset、entry、branch。                                 | 部分通過：部分 cursor 情境已驗；atomic replace／全部 branch 變更組合未驗。                  |
| session-access-v1-R2 | session-access-v1-A11 | 過大單筆 tool entry 安全投影／預覽／截斷並可按需展開；預算耗盡明示未完成，不偽裝空 history。                                             | 33 MiB 真 NativeEntry `toolResult` shape 離線兩級 preview 通過；耗盡／展開全矩陣未驗。      |
| session-access-v1-R2 | session-access-v1-A12 | 權限、越界、不支援格式與損壞原因安全可見；不洩漏 raw history／stack，已管理 session 排除。                                               | 部分通過：部分安全錯誤案例通過；實際 OS permissions、atomic replacement 情境未驗。          |
| session-access-v1-R2 | session-access-v1-A13 | 唯讀列出、加入及分頁前後原檔 hash 不變；沒有持久索引、SQLite history index 或歷史副本。                                                  | 離線 fixture hash 前後一致且無持久索引通過；僅對列明 fixture／操作成立。                    |

上述 A01..A13 狀態只涵蓋已列明的隔離離線測試，並未因部署而改寫。130 tests／23 files 與 14 browser cases 不等於完整 case 矩陣。Owner 功能測試待進行；真 model、真 TUI 與完整端到端未驗證。

## 大型 session 400 相容性修正歸檔

以下「修正版未部署」等狀態，均是修正實作與前一部署階段的歷史記錄，不代表目前狀態。修正症狀為合法大型 session 在 snapshot 階段呈現 200，歷史讀取卻因 invalid-record 失敗。合成 reproduction 的六個 parser case 重現並定位 metadata 業務欄位與巢狀 payload；大型內容與 nested subagent messages 也曾觸發 invalid-record。修正涉及七個授權路徑：`src/server/bounded-json.ts`、`src/server/native-reader.ts`、`src/web/main.tsx`、`src/web/api.ts`、`test/unit/bounded-json.test.ts`、`test/unit/native-reader.test.ts`、`test/e2e/session-access.spec.ts`。

Parser 超過 metadata 保留預算時，會安全省略 metadata，並保留 `truncated` 與根結構。合法巢狀 ID 不因業務 metadata ID 而誤判。含糊 metadata 會丟棄巢狀 object，不丟棄整個 session。Malformed record 仍安全回報 400。UI 載入失敗會顯示失敗狀態，允許手動 retry，保留草稿，且不送出 POST。

本輪證據為隔離 23 files／140 tests、16 browser cases，以及重新執行六個 parser case與兩個 native page case 的合成 reproduction。這些測試通過不代表變更範圍核對通過。最後與部署 acceptance baseline 比較時，發現 root `dist/cli/main.js` 與 `dist/server/{app,bounded-json,errors,native-reader,runtime}.js` 共六檔有非預期 hash 差異；原因及確切寫入指令未確認，不能稱這些差異在本輪修改前已存在。僅有 mtime 記錄（2026-10-18 17:59:19–20 +0800），不足以判定來源。保留現況，未還原或刪除。此事與下文記載的早期 worker 事故分開，不混為同一事件。該修正階段記錄：線上固定 release 與 pointer hash 未變，19 檔隔離 copydist hash 驗證相符；當時修正版未部署，後續若部署，只使用已驗證的隔離 copy，不使用 root dist。這是前一階段的歷史狀態。個人實檔的觸發點與修正效果仍未驗證；不表示 Owner 檔案已證實修好。

[修正範圍核對](../.test-artifacts/session-access-v1/large-session-400/closeout/scope-report.json)、[整期變更 diff](../.test-artifacts/session-access-v1/large-session-400/closeout/change.diff)、[重跑報告](../.test-artifacts/session-access-v1/large-session-400/closeout/reproduction/report.json)、[check attempt 6](../.test-artifacts/session-access-v1/large-session-400/fix-3/logs/check-attempt-6.log)、[E2E attempt 2](../.test-artifacts/session-access-v1/large-session-400/fix-3/logs/e2e-attempt-2.log)。fix-2 首次 unit log 曾被覆寫，fix-3 baseline 建立較晚。失敗證據保留原樣；改前 reader 與 E2E bytes 使用 fix-1 早期副本核對 acceptance scope 相同 hash。本文件不偽造原始 logs。

## 前一部署：session-access-v1-ready-130（歷史記錄）

以下內容記錄前一部署狀態，不代表目前 release。

Session Access v1 已部署於固定 release `session-access-v1-ready-130`，正式 URL 為 <http://TAILNET_IP:4317>。部署前已取得 Owner 授權正常重啟。舊服務 PID `21412`、starttime `942719935` 及其 children 均已退出，port 曾確認關閉；之後才更新 atomic pointer 並啟動服務。新服務 PID 為 `54786`、starttime `944935964`，只在 `TAILNET_IP:4317` 監聽。19 個新 release 檔案逐一 hash 比對已驗證的 copy，內容一致。該次部署結束時服務保持運行。

正式 URL 的 desktop `1365x1000` 與 mobile `390x844` 唯讀 UI 檢查均通過。畫面顯示 16 個 projects、2 個 profiles、native ID、cwd、sessionDir、command、SSE、draft 與寫入警語；沒有 handoff 控制項或 Owner badge。僅指定合成 workspace session 讀取 history。四個 session 與 22 筆 operation metadata 保持不變；檢查期間沒有 operation POST 或 new-session POST。個人 JSONL 僅做 stat。三個資產的 SHA-256 與 release manifest 相符。Token、config、source、rootdist 與兩個 release 的 hashes 均未變；本文件更新是預期的文件差異。服務未停止。

本次未使用 Owner 的 110 MiB 檔案功能測試，未送出模型 prompt。這些結果不代表真 Pi、真 TUI、provider 或完整端到端驗收。

部署驗收以[最終驗收報告](../.test-artifacts/session-access-v1/deployment/acceptance/final-report.json)與[範圍報告](../.test-artifacts/session-access-v1/deployment/acceptance/scope-report.json)為準；另有[API 報告](../.test-artifacts/session-access-v1/deployment/acceptance/api-report.json)、[瀏覽器報告](../.test-artifacts/session-access-v1/deployment/acceptance/browser-report.json)、[重啟報告](../.test-artifacts/session-access-v1/deployment/restart-v2/restart-report.json)及[release manifest](../.test-artifacts/session-access-v1/deployment/preparation-v2/release-manifest.json)。重啟報告仍保留 `failed (snapshot_metadata_mismatch)`：它記錄舊服務停止、新服務啟動、PID/listener 檢查成功，隨後 harness 因 snapshot metadata contract 誤判而在 post-check 失敗。此報告不回寫為通過，也不代表服務曾故障；部署最終驗收依上述 final-report 與 scope-report。其他 harness 歷史亦保留：一項 cookie 格式錯誤與另一項將 `GET /api/v1/projects` 僅回 `{id,name}` 誤判為 contract failure，是不同的測試問題，不能寫成服務曾壞。

## 本次部署：session-access-v1-history-fix-140

大型 session 400 相容性修正版已部署。當前 release 為 `session-access-v1-history-fix-140`，服務維持運行於 <http://TAILNET_IP:4317>。重啟報告記錄舊 PID `54786`／starttime `944935964` 與 child `5439`／starttime `945111926` 已退出、port 關閉後才 atomic 更新 pointer；新 PID `51533`／starttime `945568884` 是 `TAILNET_IP:4317` 唯一 listener。

報告驗證 6 sessions／24 operations ledger 完全不變，部署後 sessions 均 released，queue/dialog 為 0。Index、JS、CSS 三個資產 SHA-256 符合新 manifest。Owner HOME/environment 保持。sources、config、token、root dist 與所有舊 releases 的 before/after hash 不變。新 19 檔固定 release 來自已驗證隔離 copydist。六個 root dist 檔案的非預期差異事故仍如前文保留；本次部署範圍未改動它們，不代表前輪沒有事故。前輪 scope 失敗記錄維持失敗，沒有改寫為成功。

本次未讀取個人 history，個人檔案僅 stat；未送出 prompt 或 provider request，未重新執行 browser。既有離線驗證為 23 files／140 tests、16 browser cases。實際個人檔案觸發點、個人大 session 載入效果及模型完整 E2E 仍未驗證；不能據此宣稱 400 已在 Owner 檔案證實消失。

部署證據：[restart-report.json](../.test-artifacts/session-access-v1/large-session-400/deployment/restart/restart-report.json)、[scope-report.json](../.test-artifacts/session-access-v1/large-session-400/deployment/restart/scope-report.json)、[release-manifest.json](../.test-artifacts/session-access-v1/large-session-400/deployment/preparation/release-manifest.json)。

## 本期離線證據與限制

來源驗收記錄為 130 tests／23 files 與 14 browser cases。這些是 fake Pi／fixture 測試，不是全矩陣覆蓋。大型 fixture 的 exact size 為 115,343,509 bytes（約 110 MiB，不是 115 MiB）。新補的獨立 native tool harness 證明 33 MiB `NativeEntry` 的 `message.role=toolResult` 及 `message.content[0].text` shape；2 KiB 與 64 KiB preview 分別回傳 2,048 與 65,536 bytes，皆標記 truncated，response 分別 2,353 與 65,842 bytes，long fixture 前後 SHA-256 一致。報告及 log 位於 [`closeout`](../.test-artifacts/session-access-v1/closeout/native-tool/report.json) 與 [`native-tool.log`](../.test-artifacts/session-access-v1/closeout/logs/native-tool.log)。舊 harness 的 33 MiB `root.content` 不作為 toolResult shape 證據。

新 harness 用 `node --max-old-space-size=128` 執行；128 是 V8 old-space MiB 旗標，不是 report 中的 bytes 欄位。舊報告欄位 `heapLimitBytes: "128"` 保留，不回寫；該次報告 RSS 為 140,259,328 bytes（約 133.8 MiB），elapsed 38,828 ms 是整個 harness 時間，不是每頁 latency。新補跑耗時 54,104 ms、RSS 141,340,672 bytes；這些數值只描述相應 harness run。

事故紀錄：早期 worker 曾以 root 執行測試，並改動 `dist/server/{native-reader,bounded-json}.js`，另寫出 repo 外 `/home/<user>/repos/logs-default.txt`。依授權保留現狀，沒有刪除或還原。本次 final copy 的保護 hash 未變，不代表整期沒有事故；部分中間 worker 缺乏基準，不補造證據。固定 release 的 17 項 hash 與 config hash 保持；`active-release.json` pointer 早期缺少 before baseline，目前只能確認可比的現況。離線實作階段未 stage、commit、部署或重啟服務；本次另獲授權完成正常部署，見上節。

## 先前離線 Pi 1.3 RPC 預實驗（非本期驗收）

此獨立預實驗使用真 Pi RPC，並由另一個 `SessionManager` 模擬外部 writer。RPC cache 在同路徑切換前仍排除外部 marker；同 path switch 成功且 `cancelled=false` 後讀到新 entry。原生 session ID、檔案路徑與 RPC PID 保持不變，送出 prompt 數為 0。這證明受控預實驗的同路徑重新載入結果，不是完整真 TUI → Web 端到端驗收。

- 報告：[repo 相對路徑](../.test-artifacts/handoff-evaluation/dce2c8ed-700c-4cbe-983c-616ae3fac962/report.json)；[絕對路徑](/home/<user>/repos/pi-remote-controller/.test-artifacts/handoff-evaluation/dce2c8ed-700c-4cbe-983c-616ae3fac962/report.json)。
- 報告記錄 `providerRequestsObserved: 0`，但該欄位不是獨立網路監測，不以此宣稱網路驗收。
- 報告記錄 RPC child exited、exit code 0。此為該預實驗記錄，不代表本期新功能已驗收。

## 舊驗收基準的範圍

既有 README 所述 97 tests／20 files 與 12 browser cases，屬於先前部署基準，不是本期新增功能驗收，不得標為本期通過。
