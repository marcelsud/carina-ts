import { timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { Service } from "./index";
import { Runtime } from "./runtime";
import { canonical, CarinaError, fail } from "./validation";

interface Watch { query: string; input: unknown; last?: string; pending?: { encoded: string; frame: string } }
interface Socket { authenticated: boolean; watches: Map<string, Watch>; authTimer?: ReturnType<typeof setTimeout> }
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function publicError(e: unknown) { return e instanceof CarinaError ? e : new CarinaError("ActionFailed", "Request failed"); }

export function serve(service: Service, options: { data: string; accessKey: string; host?: string; port?: number }) {
  if (!options.accessKey) fail("Unauthorized", "CARINA_ACCESS_KEY must be set");
  const runtime = new Runtime(service, options.data);
  const sockets = new Set<ServerWebSocket<Socket>>();
  let refresh: ReturnType<typeof setTimeout> | undefined;
  function sendPending(ws: ServerWebSocket<Socket>, id: string, watch: Watch) {
    if (!watch.pending || ws.getBufferedAmount() > 0) return;
    const result = ws.send(watch.pending.frame);
    if (result !== 0) { watch.last = watch.pending.encoded; watch.pending = undefined; }
  }
  function evaluate(ws: ServerWebSocket<Socket>, id: string, watch: Watch) {
    try {
      const result = runtime.query(watch.query, watch.input), encoded = canonical(result);
      watch.pending = encoded === watch.last ? undefined : { encoded, frame: JSON.stringify({ op: "result", id, result }) };
      sendPending(ws, id, watch);
    } catch (e) {
      ws.data.watches.delete(id);
      ws.send(JSON.stringify({ op: "error", id, error: publicError(e).toJSON() }));
    }
  }
  const unsubscribe = runtime.onCommit(() => {
    // ponytail: all watches refresh after writes; add selective invalidation only if measured query cost warrants it.
    if (refresh) return;
    refresh = setTimeout(() => {
      refresh = undefined;
      for (const ws of sockets) for (const [id, watch] of ws.data.watches) evaluate(ws, id, watch);
    }, 50);
  });
  let server;
  try {
    server = Bun.serve<Socket>({
      hostname: options.host ?? "127.0.0.1", port: options.port ?? 7070,
      maxRequestBodySize: 1_048_576,
      async fetch(request, server) {
        try {
          const url = new URL(request.url);
          if (url.pathname === "/v1/ws") {
            if (server.upgrade(request, { data: { authenticated: false, watches: new Map() } })) return;
            return new Response("WebSocket upgrade required", { status: 426 });
          }
          const token = request.headers.get("authorization") ?? "";
          if (!equal(token, `Bearer ${options.accessKey}`)) fail("Unauthorized");
          if (request.method !== "POST") fail("NotFound");
          let input: unknown;
          try { input = await request.json(); } catch { fail("InvalidInput", "Expected a JSON request body"); }
          let parts: string[];
          try { parts = url.pathname.split("/").slice(1).map(decodeURIComponent); } catch { fail("InvalidInput", "Invalid URL encoding"); }
          if (parts[0] === "v1" && parts[1] === "queries" && parts.length === 3) return Response.json({ result: runtime.query(parts[2]!, input) });
          if (parts[0] === "v1" && parts[1] === "actors") {
            const [, , type, key, operation, action] = parts;
            const requestId = request.headers.get("idempotency-key") ?? crypto.randomUUID();
            if (parts.length === 5 && operation === "create") return Response.json({ reply: await runtime.submit(type!, key!, "", input, requestId, true) });
            if (parts.length === 6 && operation === "actions") return Response.json({ reply: await runtime.submit(type!, key!, action!, input, requestId) });
          }
          fail("NotFound");
        } catch (e) { const error = publicError(e); return Response.json({ error: error.toJSON() }, { status: error.status }); }
      },
      websocket: {
        maxPayloadLength: 1_048_576,
        open(ws) {
          sockets.add(ws);
          ws.data.authTimer = setTimeout(() => { if (!ws.data.authenticated) ws.close(1008, "Authentication required"); }, 5000);
        },
        message(ws, raw) {
          let id: string | undefined;
          try {
            let message: any;
            try { message = JSON.parse(String(raw)); } catch { fail("InvalidInput", "Expected JSON"); }
            if (!message || typeof message !== "object") fail("InvalidInput");
            if (!ws.data.authenticated) {
              if (message.op !== "auth" || typeof message.accessKey !== "string" || !equal(message.accessKey, options.accessKey)) fail("Unauthorized");
              ws.data.authenticated = true;
              clearTimeout(ws.data.authTimer);
              ws.send(JSON.stringify({ op: "authenticated" }));
              return;
            }
            if (typeof message.id !== "string" || !message.id || message.id.length > 256) fail("InvalidInput", "A subscription ID is required");
            id = message.id;
            if (message.op === "stop") { ws.data.watches.delete(id!); ws.send(JSON.stringify({ op: "stopped", id })); return; }
            if (message.op !== "watch" || typeof message.query !== "string") fail("InvalidInput");
            const watch = { query: message.query, input: message.input };
            ws.data.watches.set(id!, watch);
            evaluate(ws, id!, watch);
          } catch (e) {
            ws.send(JSON.stringify({ op: "error", id, error: publicError(e).toJSON() }));
            if (!ws.data.authenticated) ws.close(1008, "Authentication failed");
          }
        },
        drain(ws) { for (const [id, watch] of ws.data.watches) sendPending(ws, id, watch); },
        close(ws) { clearTimeout(ws.data.authTimer); ws.data.watches.clear(); sockets.delete(ws); },
      },
    });
  } catch (e) { unsubscribe(); runtime.close(); throw e; }
  runtime.startDispatch();
  return {
    server, runtime,
    close() {
      unsubscribe(); clearTimeout(refresh);
      for (const ws of sockets) { clearTimeout(ws.data.authTimer); ws.close(1001, "Server shutting down"); }
      server.stop(true); runtime.close();
    },
  };
}
