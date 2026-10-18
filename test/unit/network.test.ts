import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import {
  validateListenConfig,
  type Interfaces,
} from "../../src/server/network.js";

const tailnet: Interfaces = {
  tailscale0: [
    {
      address: "100.64.0.1",
      netmask: "255.192.0.0",
      family: "IPv4",
      mac: "",
      internal: false,
      cidr: "100.64.0.1/10",
    },
  ],
};
const check = (
  host: string | undefined,
  flag: boolean | undefined,
  origin: string,
  port = 4317,
  interfaces = tailnet,
) => validateListenConfig(host, flag, origin, port, interfaces);

describe("listen host validation", () => {
  it("defaults to loopback and keeps HTTPS defaults", () => {
    expect(check(undefined, undefined, "https://workspace.example")).toBe(
      "127.0.0.1",
    );
    expect(check(undefined, false, "http://localhost:4317")).toBe("127.0.0.1");
  });
  it.each(["100.64.0.0", "100.127.255.255"])(
    "allows assigned tailnet boundary %s",
    (host) => {
      const interfaces: Interfaces = {
        tailscale0: [{ ...tailnet.tailscale0![0]!, address: host }],
      };
      expect(check(host, true, `http://${host}:4317`, 4317, interfaces)).toBe(
        host,
      );
    },
  );
  it("retains localhost HTTP with the flag disabled", () => {
    expect(check("127.0.0.1", false, "http://127.0.0.1:4317")).toBe(
      "127.0.0.1",
    );
  });
  it.each([undefined, "127.0.0.1"])(
    "rejects tailnet HTTP opt-in on default or explicit loopback host %s",
    (host) => {
      expect(() => check(host, true, "http://127.0.0.1:4317")).toThrow(
        "invalid_listen_host",
      );
    },
  );
  it.each(["localhost", "::1"])("rejects listen host %s", (host) => {
    expect(() => check(host, false, "http://localhost:4317")).toThrow(
      "invalid_listen_host",
    );
  });
  it.each([
    ["100.64.0.1", false, "http://100.64.0.1:4317", tailnet],
    ["100.63.255.255", true, "http://100.63.255.255:4317", tailnet],
    ["100.128.0.0", true, "http://100.128.0.0:4317", tailnet],
    ["0.0.0.0", true, "http://0.0.0.0:4317", tailnet],
    ["192.168.1.2", true, "http://192.168.1.2:4317", tailnet],
    ["::", true, "http://[::]:4317", tailnet],
    ["100.64.0.2", true, "http://100.64.0.2:4317", tailnet],
    ["100.64.0.1", true, "http://100.64.0.1:4317", {}],
    [
      "100.64.0.1",
      true,
      "http://100.64.0.1:4317",
      {
        tailscale0: [
          {
            ...tailnet.tailscale0![0]!,
            internal: true,
          },
        ],
      },
    ],
    [
      "100.64.0.1",
      true,
      "http://100.64.0.1:4317",
      {
        tailscale0: [
          {
            ...tailnet.tailscale0![0]!,
            family: "IPv6",
          },
        ],
      },
    ],
  ] as const)("rejects unsafe bind %s", (host, flag, origin, interfaces) => {
    expect(() => check(host, flag, origin, 4317, interfaces)).toThrow();
  });
  it("rejects origin and port mismatches, and empty hosts", () => {
    expect(() => check("100.64.0.1", true, "http://100.64.0.1:4318")).toThrow();
    expect(() => check("100.64.0.1", true, "http://100.64.0.2:4317")).toThrow();
    expect(() =>
      check("100.64.0.1", true, "http://user@100.64.0.1:4317"),
    ).toThrow();
    expect(() =>
      check("100.64.0.1", true, "http://100.64.0.1:4317/path"),
    ).toThrow();
    expect(() =>
      check("100.64.0.1", true, "http://100.64.0.1:4317?x=1"),
    ).toThrow();
    expect(() => check("", true, "http://100.64.0.1:4317")).toThrow();
  });
  it("allows standard HTTP port 80 without an explicit port", () => {
    expect(check("100.64.0.1", true, "http://100.64.0.1", 80)).toBe(
      "100.64.0.1",
    );
  });
  it("connects loadConfig parsing and validation with strict opt-in types", async () => {
    const root = await mkdtemp(join(tmpdir(), "prw-network-"));
    try {
      const project = join(root, "project"),
        sessions = join(root, "sessions"),
        cli = join(root, "pi");
      await mkdir(project);
      await mkdir(sessions);
      await writeFile(cli, "test");
      const config = join(root, "config.json");
      const base = {
        port: 4317,
        publicOrigin: "http://127.0.0.1:4317",
        dataDir: join(root, "data"),
        piCli: cli,
        projects: [{ id: "p", name: "P", cwd: project, sessionDir: sessions }],
        profiles: [{ id: "f", name: "F" }],
      };
      await writeFile(config, JSON.stringify(base));
      expect((await loadConfig(config)).listenHost).toBe("127.0.0.1");
      await writeFile(
        config,
        JSON.stringify({
          ...base,
          listenHost: "100.64.0.1",
          allowTailnetHttp: "yes",
          publicOrigin: "http://100.64.0.1:4317",
        }),
      );
      await expect(loadConfig(config)).rejects.toThrow("invalid_config");
      await writeFile(config, JSON.stringify({ ...base, listenHost: 100 }));
      await expect(loadConfig(config)).rejects.toThrow("invalid_config");
      await writeFile(
        config,
        JSON.stringify({
          ...base,
          listenHost: "100.64.0.1",
          allowTailnetHttp: true,
          publicOrigin: "http://100.64.0.1:4317",
        }),
      );
      await expect(loadConfig(config)).rejects.toThrow("invalid_listen_host");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
