import http from "node:http";
import { LedgerError, openLedger } from "@actledger/core";
import { allowedHosts, allowedOrigins, type Locale } from "@actledger/cli/console";
import { sendApiError, handleApi } from "./api.js";
import { handleConsole, sendConsoleError } from "./console.js";
import { assertInitialized, ledgerDir, serverDbPath } from "./data.js";
import { LoginLimiter } from "./limiter.js";
import { requestInfo } from "./request.js";
import { RemoteSessions } from "./sessions.js";
import { CredentialStore } from "./store.js";

export interface ServerOptions {
  data: string;
  host?: string;
  port?: number;
  trustProxy?: boolean;
  publicUrl?: string;
  now?: () => Date;
  sweepMs?: number;
  log?: (line: string) => void;
}

export interface ServerHandle {
  port: number;
  origin: string;
  publicUrl: string;
  sweep(): void;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  if (opts.publicUrl !== undefined) assertPublicUrl(opts.publicUrl);
  assertInitialized(opts.data);
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 4400;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sweepMs = opts.sweepMs ?? 5000;
  const trustProxy = opts.trustProxy ?? false;

  const engine = openLedger({ dir: ledgerDir(opts.data), now });
  let store: CredentialStore | undefined;
  let server: http.Server | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    store = CredentialStore.open(serverDbPath(opts.data), now);
    const limiter = new LoginLimiter(now);
    const sessions = new RemoteSessions(now, store);
    const liveStore = store;
    const liveEngine = engine;
    let hosts = new Set<string>();
    let origins = new Set<string>();
    let origin = "";

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const info = requestInfo(req, trustProxy);
      if (url.pathname === "/healthz" || url.pathname.startsWith("/v1/")) {
        void handleApi(req, res, { engine: liveEngine, store: liveStore, sessions, hosts, info }).catch((error: unknown) => {
          sendApiError(res, error, log);
        });
        return;
      }
      const localeBox: { locale: Locale } = { locale: "en" };
      void handleConsole(req, res, {
        engine: liveEngine,
        store: liveStore,
        sessions,
        limiter,
        hosts,
        origins,
        now,
        info,
        localeBox,
      }).catch((error: unknown) => {
        sendConsoleError(res, error, localeBox.locale, log);
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });

    const liveServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          reject(new LedgerError("invalid_request", `port ${requestedPort} is in use`, 400));
          return;
        }
        reject(error);
      };
      liveServer.once("error", onError);
      liveServer.listen(requestedPort, host, () => {
        liveServer.off("error", onError);
        const address = liveServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("server did not bind a tcp port"));
          return;
        }
        origin = httpOrigin(host, address.port);
        const publicBase = opts.publicUrl ?? origin;
        hosts = allowedHosts(address.port, publicBase);
        origins = allowedOrigins(address.port, publicBase);
        resolve();
      });
    });

    if (sweepMs > 0) {
      timer = setInterval(() => {
        try {
          liveEngine.sweep();
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown";
          log(`sweep failed: ${message}`);
        }
      }, sweepMs);
      timer.unref();
    }

    const bound = liveServer.address();
    const port = bound && typeof bound !== "string" ? bound.port : requestedPort;
    const publicUrl = opts.publicUrl ?? origin;
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (!closing) {
        closing = (async () => {
          if (timer) clearInterval(timer);
          liveServer.closeAllConnections();
          await new Promise<void>((resolve) => liveServer.close(() => resolve()));
          liveStore.close();
          liveEngine.close();
        })();
      }
      return closing;
    };
    return {
      port,
      origin,
      publicUrl,
      sweep() {
        liveEngine.sweep();
      },
      close,
    };
  } catch (error) {
    if (timer) clearInterval(timer);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    try {
      store?.close();
    } catch {
      // The credential store may already be closed.
    }
    try {
      engine.close();
    } catch {
      // The ledger may already be closed.
    }
    throw error;
  }
}

function assertPublicUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LedgerError("invalid_request", "public url is invalid", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LedgerError("invalid_request", "public url must be http or https", 400);
  }
}

function httpOrigin(host: string, port: number): string {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return `http://127.0.0.1:${port}`;
  if (host.includes(":") && !host.startsWith("[")) return `http://[${host}]:${port}`;
  return `http://${host}:${port}`;
}
