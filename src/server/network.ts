import type { NetworkInterfaceInfo } from "node:os";

export type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
function ipv4Number(value: string): number | undefined {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part))
  )
    return;
  const nums = parts.map(Number);
  if (nums.some((part) => part > 255)) return;
  return nums.reduce((n, part) => (n * 256 + part) >>> 0, 0);
}
function loopback(host: string): boolean {
  const value = ipv4Number(host);
  return value !== undefined && value >>> 24 === 127;
}
function tailnet(host: string): boolean {
  const value = ipv4Number(host);
  return value !== undefined && value >= 0x64400000 && value <= 0x647fffff;
}
export function validateListenConfig(
  listenHost: string | undefined,
  allowTailnetHttp: boolean | undefined,
  publicOrigin: string,
  port: number,
  interfaces: Interfaces,
): string {
  const host = listenHost ?? "127.0.0.1";
  if (typeof host !== "string" || !host) throw new Error("invalid_listen_host");
  if (allowTailnetHttp !== undefined && typeof allowTailnetHttp !== "boolean")
    throw new Error("invalid_config");
  if (loopback(host)) {
    if (allowTailnetHttp === true) throw new Error("invalid_listen_host");
    const url = new URL(publicOrigin);
    if (!(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "localhost" || loopback(url.hostname)))
    ))
      throw new Error("invalid_origin");
    return host;
  }
  if (allowTailnetHttp !== true || !tailnet(host))
    throw new Error("invalid_listen_host");
  const assigned = interfaces.tailscale0?.some(
    (entry) =>
      entry.family === "IPv4" && !entry.internal && entry.address === host,
  );
  if (!assigned) throw new Error("invalid_listen_host");
  const url = new URL(publicOrigin);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.protocol !== "http:" ||
    url.hostname !== host ||
    (url.port !== String(port) && !(port === 80 && url.port === ""))
  )
    throw new Error("invalid_origin");
  return host;
}
