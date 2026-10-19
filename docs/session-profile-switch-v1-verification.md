# 受管 Session Profile 切換 v1：驗證與交付

## 結論

來源實作完成。父 agent 已 review 修改範圍、主要程式路徑、測試斷言與 worker 驗證紀錄。隔離合成驗收通過：32 files／181 個單元及整合測試、50 個 browser cases（desktop 25／mobile 25）。這不代表真 Pi、模型或所有 extensions 相容性已驗證。本次沒有部署、操作個人 session 或修改正式服務。

依據：[需求](session-profile-switch-v1-requirements.md)、[設計](session-profile-switch-v1-design.md)。

## 使用方式與行為

1. 選取受管 session。
2. 展開主畫面的「Session Profile」。Summary 持續顯示已保存 Profile。
3. 選擇已配置的目標 Profile。
4. 按「套用 Profile」。

側欄原有 Profile 選單仍只用於新建／加入 session。

- 冷 session 只保存設定，不啟動 Pi。畫面明示尚未啟動驗證。
- 活 session 必須安全閒置。系統保留 writer lease，先關閉並 join 舊程序群，再以完整新 Profile 及同一份原生 session 啟動候選程序。驗證後才原子保存 Profile、revision 與成功 receipt。
- 忙碌、有 queue/dialog、正在啟動／交接／停止、TUI desired owner 或狀態未知時拒絕。不自動 abort、不排程稍後切換、不送出或清除草稿。
- 不確定的切換保持 UNKNOWN／blocked。不自動回退或重播。需管理者依設計所列離線規則核對，不可刪除 lock 或盲目解鎖。
- 未指定的 Profile 欄位仍沿用既有 defaults／原生 session 語意。

## 修改範圍

- `src/shared/contracts.ts`：change_profile、Profile 預期值／revision 與 reconfiguring 合約。
- `src/server/app.ts`、`store.ts`、`runtime.ts`、`errors.ts`：schema、操作序列與 admission、原子 CAS／receipt、候選程序重建、失敗屏障及錯誤碼。
- `src/web/SessionProfile.tsx`、`main.tsx`、`api.ts`、`ui.module.css`：獨立控制項、saved/actual 區分、草稿保留、單調 revision、generation guard 與緊湊收合布局。
- 新增 Profile store／switch／failure／guard 與 browser 測試。FakePi 增加 opt-in argv journal 與設定回報。
- 調整既有 browser locator，保留原有文字及可見性斷言。既有 message 矩陣加入 reconfiguring。
- README 補用法及限制。

沒有修改 lockfile、正式設定或無關來源。沒有刪除來源檔案，沒有 commit。Build 僅更新忽略的 `dist`。

## 驗收對照與證據邊界

| 驗收 | 本輪證據 |
| --- | --- |
| A01 冷保存、原生檔不變、重開保留 | 整合測試比較原生 history bytes，確認沒有 Pi command journal；Ledger 重開後核對 Profile/revision。Browser 冷保存及 reload 後核對保存值與草稿。 |
| A02 活切換及完整設定 | 真 fakePi 子程序 journal 核對 provider/model/thinking、兩個 extension、tools 與附加提示參數。確認舊 exit 先於新 spawn、下一個 prompt 成功及 history 前綴保留。另在舊 close 完成與新 spawn 之間探測 lock 得 423，核對前後同一 lease object/fd。 |
| A03 不安全狀態拒絕 | 實際 busy prompt；queue/dialog RPC 事件注入；RPC compacting 回應注入；TUI owner 及真 competing WriterLease；starting/releasing/blocked 為 local snapshot 注入。斷言拒絕、保存值不變、無替代 spawn/abort/close。後三項不是完整原生生命週期競態證據。 |
| A04 去重與競態 | 成功 UUID 重送回原 receipt，argv journal 與 history bytes 不增；不同 payload 回 operation_conflict。真 A→B→A revision 2 拒絕舊 revision 0。HTTP tail 尚忙但 snapshot idle 時拒絕切換。舊 RPC event/failure 不污染成功的新 runtime。 |
| A05 失敗與未知 | 注入舊 close failure、候選最後 get_state 的 identity/provider/model/thinking 失配、RpcError timeout、DB commit failure、候選 cleanup failure。核對 UNKNOWN／blocked、舊保存值、未發布 target、重開後阻擋 prompt。Cleanup 失敗時保有候選程序參照及 lease，shutdown 可再次清理。SQLite trigger 證明 receipt 更新失敗會 rollback Profile/revision。 |
| A05 回應遺失邊界 | 使用丟棄首次回應、GET receipt 與同 UUID 重送的模擬。不是實際網路斷線／封包遺失驗證。 |
| A06 桌面／手機 | Desktop 1280×720、mobile Chromium 390×844。Pointer 展開與套用、冷／活切換、busy disable、草稿保留、外部多視窗更新、A 延遲回應不污染 B 均通過。 |
| A07 回歸與品質檢查 | 格式、lint、server/web typecheck、32 files／181 tests、build、全套 desktop/mobile 50 cases 通過。 |

## 最後有效命令

所有測試由 `implementation-worker` 執行。父 agent 沒有自行執行測試。

| 命令 | 結果 |
| --- | --- |
| `npm run format:check` | 通過 |
| `npm run lint` | 通過 |
| `npm run typecheck` | 通過 |
| `npm test` | 通過：32 files、181 tests |
| `npm run build` | 通過 |
| `npm run test:e2e`，指定本機既有 headless shell | 通過：50 cases；desktop 25、mobile 25 |

隔離 runner 為 `scripts/test-env.mjs`。本機測試 server 為 127.0.0.1:4179。使用已有 Playwright headless shell，沒有下載瀏覽器。最後補強僅修改 active 整合測試；其後重跑全套 `npm test`、format 與 lint。產品及 browser 測試未變，因此保留上一輪有效 typecheck／build／50-case browser 證據，不重複宣稱曾再次執行。

本地詳細紀錄：

- `.test-artifacts/session-profile-switch-v1/release-validation.md`
- `.test-artifacts/session-profile-switch-v1/lease-receipt-report.md`
- `.test-artifacts/session-profile-switch-v1/core-failure-report.md`
- `.test-artifacts/session-profile-switch-v1/refusal-report.md`
- `.test-artifacts/session-profile-switch-v1/guards-report.md`
- `.test-artifacts/session-profile-switch-v1/desktop.png`
- `.test-artifacts/session-profile-switch-v1/mobile.png`

上述 `.test-artifacts` 路徑是本地忽略產物，不保證其他 clone 具備。

## 中途問題與處理

- 有過瀏覽器缺失、路徑拼字及 route handler 同步錯誤。這些輪次不作成功證據。
- 新提示使舊 locator 不唯一。修正為指定狀態區及警語，保留文字、可見／隱藏斷言。
- 首次全套有效 browser 為 49/50，暴露手機 chat 提早觸及最小高度的真布局回歸。緊湊兩列仍不足以顯示首筆對話。最後改為預設收合的原生 details，保留 saved summary。沒有改 chat 最小高度或弱化 resize／anchor 斷言。後續完整 50/50 通過。
- Review 修正過活 no-op 誤釋 lease、候選 queue modes 遺漏、最後設定驗證、舊 listener 隔離及 cleanup failure 保有候選控制權。以上不以早期僅成功路徑的結果取代最後有效證據。

## 未驗證

- 真 Pi、真 provider/model、實際 tools/extensions／附加系統提示的完整相容性矩陣。
- 真 TUI 操作、未受管理 writer 的同時改寫及獨立 extension 背景服務清理。
- 實體手機、VPN／HTTPS／跨裝置使用、真網路中斷及管理者實際離線恢復。
- 全部 OS／檔案系統故障組合與所有 shutdown 競態。合成注入不等同每種真環境故障。

未新增上述保證，也未取得正式部署證據。
