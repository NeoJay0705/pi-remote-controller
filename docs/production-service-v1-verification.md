# 正式服務安全部署與登入 v1：驗證與歷史摘要

**狀態：本文分別記錄既有部署的有限歷史驗證，以及本次公開文件發布檢查。部署歷史不代表任何 clone 的服務目前正在運行；本次檢查只涉及文件。**

## 歷史部署摘要

- 歷史部署使用含 `@fastify/static` 10.1.6 與 matched-route 權限修補的 release。產物由隔離 candidate 產生，未使用 repository 根目錄 `dist`。
- 歷史 candidate manifest 有 11,793 個 entries，包含目錄、一般檔案及 symlink；不是 JavaScript 檔案數量。
- P2 離線 `npm run check` 曾有 23 個測試檔、142 tests 通過；另有 16 個 desktop/mobile browser cases 與 18 項 compiled-app smoke assertions 通過。這些數字只代表執行範圍，不表示所有情境通過。
- P3 有 115 gates 通過。Gate 涵蓋 manifest、symlink、程序、資料核對及有限 HTTP 驗證；不是 115 個瀏覽器測試，也不是 115 個獨立安全案例。
- 有限 HTTP 驗證涵蓋 health、首頁與資產、未登入 API、登入、認證狀態、登出及舊 cookie 失效。沒有執行正式資料 mutation。
- 歷史來源 HEAD 為 `40d303941e4d07311345175fb02773c0056433d8`。此 hash 用於歷史追溯，不表示目前文件內容或目前服務狀態。
- 歷史 P2/P3 證據由部署者私有保存，未隨 repository 發布。忽略目錄中的證據不保證其他 clone 存在。

## 範圍核對與事故教訓

歷史記錄表示當時的 config、token、啟停 scripts、repo root source/dist/dependencies 與舊 release 未變；六個登記 native files hash 未變。Ledger logical `sessions` 六筆與 `operations` 二十五筆，部署前後相同。這些是限定範圍的歷史結論，不是本次新核對，也不代表掃描整個個人 HOME。

第一次 preflight 使用 SQLite read-only 開啟正式資料庫，仍建立 0-byte WAL 與 32,768-byte SHM。該次正式路徑不變驗收失敗。沒有手動刪除 sidecar，也沒有偽造成功。後續檢查改在隔離副本執行，並核對正式資料庫、sidecar 與 locks。歷史事故不因後續修正而消失。

## 操作說明

新部署與登入步驟見[README 的可攜部署與登入流程](../README.md#正式部署與登入)。該流程要求部署者自行管理獨立 build/release 目錄、canonical 設定、私有 token 及正常停止方式。Repository 不提供主機專用 start/stop 腳本。既有主機操作命令與實際路徑由部署者私下保存的 private runbook 管理；本文不提供私有路徑或憑證位置。

正式 HTTP 預設使用 loopback。若明確啟用 Tailnet HTTP，HTTP 仍不是 HTTPS，也沒有 Secure cookie。正式部署建議 HTTPS。背景服務需由部署者另行設定 service manager。

## 本次文件發布檢查

本次 docs-only publication checks 與上述歷史部署證據不同。檢查涵蓋五份候選文件的 Markdown 格式與相對連結、候選文件 metadata、ignore 規則與 lockfile registry URL／integrity，以及 tracked 工作樹、候選文件和 reachable Git history 的 heuristic secret scan。實際命令結果、範圍、限制與人工 disposition 見[安全審查紀錄](security-review.md)。本次只準備文件發布，沒有執行產品 test/build、正式服務操作、push 或 history rewrite。歷史部署報告仍由部署者私有保存，沒有隨 repository 發布。

## 未驗證範圍

歷史驗證未涵蓋真 Pi、模型/provider、實體手機、完整遠端 VPN、HTTPS、所有 file-hook、所有 thinking profile、全主機權限或完整滲透測試。歷史 audit 不代替新 audit。本次公開文件掃描是本機 heuristic，不是完整秘密掃描或安全保證；本輪只 audit repository lockfile，未 audit 作業系統、Node.js 或全域 Pi 套件。歷史 metadata 仍可能存在於舊文件與 Git history；本次文件更新不代表 history 已去識別化。

停止、備份與災難復原由部署者負責。保留舊 release 不表示可安全自動 rollback。不得因文件更新清理、重啟或修改既有正式部署與資料。
