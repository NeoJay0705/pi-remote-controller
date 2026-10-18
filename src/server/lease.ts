import { constants } from "node:fs";
import { chmod, lstat, open, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";

export class WriterLease {
  private handle: FileHandle | undefined;
  private constructor(
    readonly path: string,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }
  static async acquire(path: string): Promise<WriterLease> {
    if (process.platform !== "linux") throw new Error("lease_unavailable");
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        path,
        constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const st = await handle.stat();
      const pathStat = await lstat(path);
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        pathStat.isSymbolicLink() ||
        pathStat.nlink !== 1 ||
        pathStat.dev !== st.dev ||
        pathStat.ino !== st.ino
      )
        throw new Error("unsafe_lock_file");
      await chmod(path, 0o600);
      const probe = spawn("/usr/bin/flock", ["-n", "-E", "73", "3"], {
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      });
      const result = await new Promise<{ code: number | null; error?: Error }>(
        (resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) {
              probe.kill("SIGKILL");
            }
          }, 5000);
          probe.once("error", (error) => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve({ code: null, error });
            }
          });
          probe.once("close", (code) => {
            if (!done) {
              done = true;
              clearTimeout(timer);
              resolve({ code });
            }
          });
        },
      );
      if (
        result.error ||
        result.code === null ||
        (result.code !== 0 && result.code !== 73)
      )
        throw new Error("lease_unavailable");
      if (result.code === 73)
        throw Object.assign(new Error("writer_locked"), { statusCode: 423 });
      return new WriterLease(path, handle);
    } catch (error) {
      await handle?.close();
      if (
        error instanceof Error &&
        ["writer_locked", "lease_unavailable", "unsafe_lock_file"].includes(
          error.message,
        )
      )
        throw error;
      throw new Error("lease_unavailable");
    }
  }
  get fd(): number {
    if (!this.handle) throw new Error("lease_closed");
    return this.handle.fd;
  }
  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) await handle.close();
  }
}
