import { useState } from "react";
import type { Profile, Snapshot } from "../shared/contracts.js";
import styles from "./ui.module.css";

export function SessionProfile({
  profiles,
  snapshot,
  connected,
  online,
  busy,
  onApply,
}: {
  profiles: Profile[];
  snapshot: Snapshot;
  connected: boolean;
  online: boolean;
  busy: boolean;
  onApply: (profileId: string) => void;
}) {
  const [target, setTarget] = useState(snapshot.profileId);
  const saved = profiles.find((profile) => profile.id === snapshot.profileId);
  const safeState =
    snapshot.runtimeState === "idle" || snapshot.runtimeState === "released";
  const ready =
    connected &&
    online &&
    !busy &&
    safeState &&
    snapshot.queue.length === 0 &&
    (snapshot.pendingDialogs?.length ?? 0) === 0 &&
    snapshot.desiredOwner === "web";
  return (
    <section className={styles.sessionProfile} aria-label="Session Profile">
      <details className={styles.sessionProfileDetails}>
        <summary className={styles.sessionProfileHeading}>
          <span className={styles.sessionProfileTitle}>Session Profile</span>
          <span
            className={styles.sessionProfileSaved}
            aria-label="已保存 Session Profile"
          >
            已保存：<strong>{saved?.name ?? "未知 Profile"}</strong>（
            {snapshot.profileId}）
          </span>
        </summary>
        <div className={styles.sessionProfileControls}>
          <label>
            待選 Profile
            <select
              aria-label="待選 Session Profile"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}（{profile.id}）
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={
              !ready ||
              !profiles.some((profile) => profile.id === target) ||
              target === snapshot.profileId
            }
            onClick={() => onApply(target)}
          >
            套用 Profile
          </button>
          {snapshot.runtimeState === "released" && (
            <p role="note">
              套用後已保存；Pi 尚未啟動驗證。實際設定會在啟動後確認。
            </p>
          )}
          {!ready && (
            <p role="note">
              忙碌、狀態未知、佇列或對話未清空、未連線或 owner 非 Web
              時不能套用。後端仍會再次檢查。
            </p>
          )}
        </div>
      </details>
    </section>
  );
}
