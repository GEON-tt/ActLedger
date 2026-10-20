import type http from "node:http";

export interface RequestInfo {
  ip: string;
  host: string | undefined;
  https: boolean;
}

function headerParts(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value.join(",") : value;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function asString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requestInfo(req: http.IncomingMessage, trustProxy: boolean): RequestInfo {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy) {
    return { ip: socketIp, host: asString(req.headers.host), https: false };
  }
  const forwarded = headerParts(req.headers["x-forwarded-for"]);
  const forwardedHost = headerParts(req.headers["x-forwarded-host"]);
  const proto = headerParts(req.headers["x-forwarded-proto"])[0]?.toLowerCase();
  return {
    ip: forwarded.length > 0 ? (forwarded[forwarded.length - 1] ?? socketIp) : socketIp,
    host: forwardedHost[0] ?? asString(req.headers.host),
    https: proto === "https",
  };
}
