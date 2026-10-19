# Session UI v1 驗證紀錄

最終狀態：passed（指定 targeted E2E、完整 desktop/mobile E2E、typecheck、lint、format check 與 unit tests 通過）。以下結果只適用於列出的合成測試範圍。

## 範圍與限制

- 一般 E2E 由 `scripts/test-env.mjs` 啟動 loopback fake server 與 fake Pi，並使用隔離環境。
- `test/e2e/session-ui-behavior.spec.ts` 以 Playwright route 與受控 EventSource 合成瀏覽器 HTTP/EventSource 行為。它不等同真實 SSE transport 驗收。
- 使用已設定的 `PRW_BROWSER_EXECUTABLE` 指向實際使用的既有 Chromium headless shell。
- 未連接真 Pi 或 provider。未執行真機手機觸控、鍵盤或輔助科技驗收。
- E2E build 產物只寫入 `dist/**`。Playwright 產物、隔離暫存與日誌只寫入 `.test-artifacts/**`。

## 五項需求驗收證據

1. **手機與桌面側欄**：`test/e2e/session-ui.spec.ts` 驗證手機遮罩、側欄內點擊、焦點移動、Escape 不觸發 stop，以及桌面隱藏 menu/無遮罩。`test/e2e/session-ui-behavior.spec.ts` 驗證視窗由手機寬度切至桌面時側欄與 inert 狀態。
2. **全域錯誤與 Session 錯誤隔離**：`test/e2e/session-ui.spec.ts` 驗證遲到操作失敗留在 A、B 不顯示 A 錯誤、回 A 可關閉錯誤及登入後 API 401 全域逾期。該檔新增的遲到成功案例驗證 A 的 ACCEPTED receipt 不觸發舊 view snapshot/history 請求，且 B 保持連線及可送出。`test/unit/api-auth.test.ts` 驗證匿名初始 `me` probe 的 401 與已登入 API 401 通知差異。真實網路錯誤及真 SSE 競態未驗證。
3. **三種訊息操作與快捷鍵**：`test/e2e/session-ui-behavior.spec.ts` 驗證 Prompt、Steering、Follow-up 在 runtime 狀態、offline、busy、空白草稿下的 enable/disable、請求 kind 及 Ctrl+Enter/IME 行為。`test/unit/session-ui.test.ts` 驗證純 eligibility 全矩陣及各阻擋條件，baseline 先確認為 true。E2E 未獨立驗證 macOS Cmd+Enter。
4. **置底、錨點與 resize**：`test/e2e/session-ui-behavior.spec.ts` 驗證初始置底、送出立即置底、即時輸出跟隨、向上閱讀與 loadOlder 錨點、置底/閱讀中 resize，以及同一 Session 重開後置底。此檔使用受控 EventSource 和 HTTP routes，屬瀏覽器合成 transport 測試，不代表真 SSE transport。
5. **資訊精簡與複製**：`test/e2e/session-access.spec.ts` 驗證 Session metadata 預設收合、展開後複製原生 Pi 命令與手動複製 fallback，以及安全警告；`test/e2e/queue-stop.spec.ts` 驗證 queue 文字複製 fallback 與延遲複製的 generation guard；`test/e2e/session-ui-behavior.spec.ts` 驗證切換 Session 後資訊重新收合。其餘既有 E2E 使用 fake Pi 與 loopback fake server，不代表真 Pi/provider。

## 本輪修改

- `src/web/main.tsx`：session 選取立即恢復置底；舊 generation 的 `sync` 在增加 serial 及發出 API 請求前返回。
- `test/unit/session-ui.test.ts`：修正阻擋案例，為每種操作先建立有效 baseline，再逐項驗證阻擋條件。
- `test/e2e/session-ui.spec.ts`：新增遲到成功 operation 回歸案例，等待 ACCEPTED receipt 與 B 的 Prompt 解鎖，不使用任意 sleep。
- `test/e2e/session-ui-behavior.spec.ts`：新增同 Session 重開後重新同步並置底的案例，保留既有 history prepend、anchor 與立即送出斷言。
- `docs/session-ui-v1-requirements-design.md`：說明匿名 `me` probe 401 不代表登入逾期；登入後 API 401 仍使登入全域逾期。說明不改後端 HTTP contract，但前端 wrapper 可接受通知選項。
- `docs/session-ui-v1-verification.md`：列出五項需求的測試證據及 transport 限制。

## 命令與結果

公開版命令以 `PRW_BROWSER_EXECUTABLE` 環境變數取代主機專屬的瀏覽器路徑；此替代不表示當時執行命令使用了不同路徑。工作目錄：repository root。日誌位於 `.test-artifacts/session-ui-v1/review-final-*.log`。

| 命令                                                                                                                                                                                                                             | 退出碼 | 結果                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------- |
| `node_modules/.bin/prettier --write src/web/main.tsx test/e2e/session-ui.spec.ts test/e2e/session-ui-behavior.spec.ts test/unit/session-ui.test.ts docs/session-ui-v1-requirements-design.md docs/session-ui-v1-verification.md` |      0 | 格式化六個授權檔案。                                                                                       |
| `PRW_BROWSER_EXECUTABLE="$PRW_BROWSER_EXECUTABLE" npm run test:e2e -- test/e2e/session-ui.spec.ts test/e2e/session-ui-behavior.spec.ts`                                                                                          |      0 | 10/10 desktop/mobile case-instance 通過。日誌：`.test-artifacts/session-ui-v1/review-final-targeted.log`。 |
| `PRW_BROWSER_EXECUTABLE="$PRW_BROWSER_EXECUTABLE" npm run test:e2e`                                                                                                                                                              |      0 | 26/26 desktop/mobile case-instance 通過。日誌：`.test-artifacts/session-ui-v1/review-final-e2e.log`。      |
| `npm run typecheck`                                                                                                                                                                                                              |      0 | 通過。日誌：`.test-artifacts/session-ui-v1/review-final-typecheck.log`。                                   |
| `npm run lint`                                                                                                                                                                                                                   |      0 | 通過。日誌：`.test-artifacts/session-ui-v1/review-final-lint.log`。                                        |
| `npm run format:check`                                                                                                                                                                                                           |      0 | 通過。日誌：`.test-artifacts/session-ui-v1/review-final-format-check.log`。                                |
| `npm test`                                                                                                                                                                                                                       |      0 | 25 個 test files、147 個 tests 通過。日誌：`.test-artifacts/session-ui-v1/review-final-test.log`。         |

## 驗收狀態

- 遲到 ACCEPTED 不觸發舊 view sync：通過。回歸案例確認 A 在切至 B 後成功回應，不增加 A snapshot/history 請求，B 仍 connected 且 Prompt enabled。
- 同 Session 重開置底：通過。先向上捲動超過 48px，再重新選取目前 Session；確認 snapshot/history 重載及距底不超過 2px。
- Unit 阻擋測試具有 true baseline：通過。三種操作各自先以有效 runtime 狀態斷言 true，再逐項斷言阻擋條件 false。
- Targeted E2E：通過，10/10 desktop/mobile case-instance。完整 E2E：通過，26/26 desktop/mobile case-instance。
- Typecheck、lint、format check 與 unit tests：通過。Unit tests 為 25 個 test files、147 個 tests。
- 五項需求對應證據：已列出各自測試檔；合成測試通過，不延伸宣稱真 Pi/provider 或真 transport 通過。
- 真 Pi/provider、真 SSE transport 與實機手機：未驗證。
