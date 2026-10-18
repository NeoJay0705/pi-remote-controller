import React, { useState } from "react";
import type { PendingDialog } from "../shared/contracts.js";

type Props = {
  dialogs: PendingDialog[];
  onRespond: (dialog: PendingDialog, value: unknown) => void;
  disabled?: boolean;
};

export function DialogPanel({ dialogs, onRespond, disabled = false }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <section aria-label="Extension 對話">
      {dialogs.map((dialog) => (
        <form
          key={dialog.id}
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            onRespond(
              dialog,
              dialog.method === "confirm"
                ? values[dialog.id] === "true"
                : dialog.method === "select"
                  ? (values[dialog.id] ?? "")
                  : (values[dialog.id] ?? dialog.prefill ?? ""),
            );
          }}
        >
          <h2>{dialog.title || dialog.method}</h2>
          {dialog.message && <p>{dialog.message}</p>}
          <p>到期時間：{new Date(dialog.expiresAt).toLocaleTimeString()}</p>
          {dialog.method === "confirm" ? (
            <select
              aria-label="確認結果"
              value={values[dialog.id] ?? ""}
              disabled={disabled}
              onChange={(event) =>
                setValues((old) => ({
                  ...old,
                  [dialog.id]: event.target.value,
                }))
              }
              required
            >
              <option value="" disabled>
                請明確選擇
              </option>
              <option value="true">確認</option>
              <option value="false">拒絕</option>
            </select>
          ) : dialog.method === "select" ? (
            <select
              aria-label="選項"
              value={values[dialog.id] ?? ""}
              disabled={disabled}
              onChange={(event) =>
                setValues((old) => ({
                  ...old,
                  [dialog.id]: event.target.value,
                }))
              }
              required
            >
              <option value="" disabled>
                請選擇
              </option>
              {(dialog.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : dialog.method === "editor" ? (
            <textarea
              aria-label="編輯器回應"
              placeholder={dialog.placeholder}
              disabled={disabled}
              value={values[dialog.id] ?? dialog.prefill ?? ""}
              onChange={(event) =>
                setValues((old) => ({
                  ...old,
                  [dialog.id]: event.target.value,
                }))
              }
            />
          ) : (
            <input
              aria-label="輸入回應"
              placeholder={dialog.placeholder}
              disabled={disabled}
              value={values[dialog.id] ?? dialog.prefill ?? ""}
              onChange={(event) =>
                setValues((old) => ({
                  ...old,
                  [dialog.id]: event.target.value,
                }))
              }
            />
          )}
          <button type="submit" disabled={disabled}>
            送出回應
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!disabled) onRespond(dialog, { cancelled: true });
            }}
          >
            取消
          </button>
        </form>
      ))}
    </section>
  );
}
