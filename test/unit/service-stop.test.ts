import { expect, it } from "vitest";
import {
  readProcessStarttime,
  stopService,
} from "../../scripts/service-stop.mjs";

const metadata = JSON.stringify({ pid: 2345, starttime: "67890" });

function createIO(overrides: Record<string, unknown> = {}) {
  const signals: Array<[number, string]> = [];
  const io = {
    readMetadata: async () => metadata,
    readStarttime: async () => "67890",
    hasListener: async () => false,
    signal: (pid: number, signal: string) => signals.push([pid, signal]),
    now: () => 0,
    wait: async () => {},
    ...overrides,
  };
  return { io, signals };
}

it("accepts an absent PID only when the port is closed", async () => {
  const { io, signals } = createIO({ readStarttime: async () => null });
  await expect(stopService(io)).resolves.toBe("already stopped");
  expect(signals).toEqual([]);
});

it("rejects an absent PID when the port is occupied without signaling", async () => {
  const { io, signals } = createIO({
    readStarttime: async () => null,
    hasListener: async () => true,
  });
  await expect(stopService(io)).rejects.toThrow("port 4317 is occupied");
  expect(signals).toEqual([]);
});

it("rejects a reused PID even when the port is closed without signaling", async () => {
  const { io, signals } = createIO({ readStarttime: async () => "99999" });
  await expect(stopService(io)).rejects.toThrow("identity mismatch");
  expect(signals).toEqual([]);
});

it("sends SIGTERM to a matching process and waits for exit and a closed port", async () => {
  let reads = 0;
  let time = 0;
  const { io, signals } = createIO({
    readStarttime: async () => (++reads === 1 ? "67890" : null),
    hasListener: async () => false,
    now: () => time,
    wait: async () => {
      time += 300;
    },
  });
  await expect(stopService(io)).resolves.toBe("stopped");
  expect(signals).toEqual([[2345, "SIGTERM"]]);
});

it("does not report stopped until the listener closes", async () => {
  let reads = 0;
  let checks = 0;
  let time = 0;
  const { io, signals } = createIO({
    readStarttime: async () => (++reads === 1 ? "67890" : null),
    hasListener: async () => ++checks === 1,
    now: () => time,
    wait: async () => {
      time += 300;
    },
  });
  await expect(stopService(io)).resolves.toBe("stopped");
  expect(checks).toBe(2);
  expect(signals).toEqual([[2345, "SIGTERM"]]);
});

it("reads Linux proc starttime after a comm containing spaces and parentheses", async () => {
  const fields = [
    "S",
    ...Array.from({ length: 18 }, (_, index) => `${index + 1}`),
    "98765",
  ];
  const read = async (path: string, encoding: string) => {
    expect(path).toBe("/proc/2345/stat");
    expect(encoding).toBe("utf8");
    return `2345 (name with ) parens) ${fields.join(" ")}`;
  };
  await expect(readProcessStarttime(2345, read)).resolves.toBe("98765");
});

it("maps only missing proc entries to null and propagates permission errors", async () => {
  for (const code of ["ENOENT", "ESRCH"]) {
    const read = async () => {
      throw Object.assign(new Error(code), { code });
    };
    await expect(readProcessStarttime(2345, read)).resolves.toBeNull();
  }
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  await expect(
    readProcessStarttime(2345, async () => {
      throw denied;
    }),
  ).rejects.toBe(denied);
});

it("rejects malformed proc stat", async () => {
  await expect(
    readProcessStarttime(2345, async () => "bad stat"),
  ).rejects.toThrow("invalid process stat");
});

it("times out while the process remains, even when the port is closed", async () => {
  let time = 0;
  let listenerChecks = 0;
  const { io, signals } = createIO({
    hasListener: async () => {
      listenerChecks++;
      return false;
    },
    now: () => time,
    wait: async (ms: number) => {
      time += ms;
    },
  });
  await expect(stopService(io)).rejects.toThrow("timed out");
  expect(time).toBe(30_000);
  expect(listenerChecks).toBe(0);
  expect(signals).toEqual([[2345, "SIGTERM"]]);
});

it("times out when the PID exits but the listener remains, without SIGKILL", async () => {
  let reads = 0;
  let time = 0;
  let checks = 0;
  const { io, signals } = createIO({
    readStarttime: async () => (++reads === 1 ? "67890" : null),
    hasListener: async () => {
      checks++;
      return true;
    },
    now: () => time,
    wait: async (ms: number) => {
      time += ms;
    },
  });
  await expect(stopService(io)).rejects.toThrow("timed out");
  expect(time).toBe(30_000);
  expect(checks).toBeGreaterThan(0);
  expect(signals).toEqual([[2345, "SIGTERM"]]);
  expect(signals.some(([, signal]) => signal === "SIGKILL")).toBe(false);
});

it("fails closed for invalid metadata and IO errors without signaling", async () => {
  for (const readMetadata of [
    async () => "not json",
    async () => JSON.stringify({ pid: 1, starttime: "2" }),
    async () => {
      throw new Error("metadata read failed");
    },
  ]) {
    const { io, signals } = createIO({ readMetadata });
    await expect(stopService(io)).rejects.toThrow();
    expect(signals).toEqual([]);
  }

  const procError = createIO({
    readStarttime: async () => Promise.reject(new Error("proc read failed")),
  });
  await expect(stopService(procError.io)).rejects.toThrow("proc read failed");
  expect(procError.signals).toEqual([]);

  const ssError = createIO({
    readStarttime: async () => null,
    hasListener: async () => Promise.reject(new Error("ss failed")),
  });
  await expect(stopService(ssError.io)).rejects.toThrow("ss failed");
  expect(ssError.signals).toEqual([]);
});

it("fails closed when SIGTERM fails", async () => {
  const { io } = createIO({
    signal: () => {
      throw new Error("signal failed");
    },
  });
  await expect(stopService(io)).rejects.toThrow("signal failed");
});
