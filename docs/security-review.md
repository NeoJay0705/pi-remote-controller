# 安全審查紀錄

## 結果與修補

本次處理兩項問題。第一，API 權限檢查先前可被 raw URL/encoded route 規避；已以 matched-route 權限判斷修正，並實測 encoded GET 與 mutation/CSRF regression。第二，`@fastify/static` 8.3.0 有 4 項 GHSA，最高 High；已升至 10.1.6。未部署本次修補。

已驗證 142 tests／23 files 及 16 browser cases。`npm audit` full 與 production 報告的實際 metadata 均為 0。這些結果不代表完整滲透測試，也不證明沒有未知漏洞。

## 審查範圍

Focused source review 涵蓋 auth、Origin 與 JSON 邊界、安全錯誤、path `NOFOLLOW` 與 identity、SQL parameterization、child process `shell: false` 與 `removeOwnerToken`，以及 Markdown 禁止 raw HTML 和外部 image。未宣稱全面滲透或涵蓋全部攻擊面。

秘密掃描中 13 筆 owner-token literal 均為合成測試 token。非 lockfile 的高熵候選經人工判讀，皆為文件、路徑、UUID、hash、錯誤識別字或合成 fixture，不是生產金鑰。lockfile entropy 由自動 invariant 掃描核對 integrity 與 registry URL。Node 22.21.1、作業系統與全域 Pi 套件未完成 CVE 審核。`npm audit` 不是 runtime／OS 安全證明。

## 限制與營運狀態

正式服務依本次 Owner 授權正常停止，尚未再次啟動；本次安全修正尚未部署。預覽截斷及工具結果配對提示仍未修正，因此不宣稱所有 UX 改善完成。

流程異常如實記錄：前輪 `commit-preflight` 曾誤用 root build，該隔離 check 不算通過；後續已有正確 prefix 隔離成功。`auth-fix` 階段只保存 baseline hash，缺少當時完整候選 bytes。最早完整候選副本保存於 `auth-fix` 修補之前，可核對整期總差異；但不能補足 `auth-fix` 當下未保存完整 bytes 的程序缺口。此程序缺口不補造、不抹除。歷史 root `dist` 異常仍保留，未還原。

詳細 audit 與測試證據位於本機 ignored 目錄 `.test-artifacts/commit-completion-20261018/`。這些是本機證據，不保證其他 clone 具有該報告。
