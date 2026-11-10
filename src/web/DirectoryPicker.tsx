import { useEffect, useState } from "react";
import type { Project } from "../shared/contracts.js";
import { api } from "./api.js";
import styles from "./ui.module.css";

type DirectoryPickerProps = {
  onSelected: (project: Pick<Project, "id" | "name">) => Promise<void>;
};

export function DirectoryPicker({ onSelected }: DirectoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = async (nextPath: string) => {
    setPending(true);
    setError("");
    try {
      const result = await api.directories(nextPath);
      setPath(result.path);
      setEntries(result.entries);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (open) void load(path);
    // Loading is intentionally triggered only when the panel opens.
  }, [open]);

  const choose = async (target: string) => {
    setPending(true);
    setError("");
    try {
      const project = await api.selectProject(target);
      await onSelected(project);
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };

  const createAndChoose = async () => {
    setPending(true);
    setError("");
    try {
      const created = await api.createDirectory(path, name);
      const project = await api.selectProject(created.path);
      await onSelected(project);
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className={styles.directoryPicker}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        瀏覽目錄
      </button>
      {open && (
        <div className={styles.directoryPanel} aria-label="目錄瀏覽器">
          <div aria-label="目錄路徑" className={styles.directoryBreadcrumb}>
            {["repos", ...path.split("/").filter(Boolean)].join(" / ")}
          </div>
          {path && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void load(path.split("/").slice(0, -1).join("/"))}
            >
              上一層
            </button>
          )}
          <div className={styles.directoryEntries} aria-label="子目錄">
            {pending && entries.length === 0 ? (
              <span role="status">載入中…</span>
            ) : entries.length ? (
              entries.map((entry) => {
                const target = path ? `${path}/${entry}` : entry;
                return (
                  <button
                    type="button"
                    key={entry}
                    disabled={pending}
                    onClick={() => void load(target)}
                  >
                    {entry}
                  </button>
                );
              })
            ) : (
              <span>沒有子目錄</span>
            )}
          </div>
          <button
            type="button"
            disabled={!path || pending}
            onClick={() => void choose(path)}
          >
            選擇此目錄
          </button>
          <label>
            <span>新目錄名稱</span>
            <input
              aria-label="新目錄名稱"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
            />
          </label>
          <button
            type="button"
            disabled={!name.trim() || pending}
            onClick={() => void createAndChoose()}
          >
            建立並選擇
          </button>
          {error && <div role="alert">{error}</div>}
        </div>
      )}
    </section>
  );
}
