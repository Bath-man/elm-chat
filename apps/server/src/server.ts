import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ROOM_ID_BYTES, type CreateRoomResponse } from "@elm-chat/shared";
import { Room } from "./room.js";
import type { RoomContext, RoomSocket } from "./room-runtime.js";
import type { MetadataStore } from "./storage.js";

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
function securityHeaders(res: ServerResponse) {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}
async function respond(res: ServerResponse, response: Response) {
  securityHeaders(res); res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 16 * 1024) throw new HttpError(413, "Request too large.");
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, "Invalid JSON object."); }
}
function sameOrigin(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}
function duration(value: unknown, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 365 * 86400_000)
    throw new HttpError(400, "Invalid duration.");
  return value;
}
class Socket implements RoomSocket {
  private attachment: unknown = null;
  constructor(readonly ws: WebSocket) {}
  get readyState() { return this.ws.readyState; }
  send(data: string) { this.ws.send(data); }
  close(code?: number, reason?: string) { this.ws.close(code, reason); }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
type Entry = {
  room: Room; sockets: Set<Socket>; tail: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>; disposed: boolean;
};

export function createChatServer(options: {
  store: MetadataStore; publicDir: string; ownsLease?: () => boolean;
  heartbeatMs?: number; joinTimeoutMs?: number;
}) {
  const rooms = new Map<string, Promise<Entry>>();
  const ownsLease = options.ownsLease ?? (() => true);
  let closing = false;
  const alive = new WeakMap<WebSocket, boolean>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const ensureReady = () => { if (closing || !ownsLease()) throw new HttpError(503, "聊天服务正在切换，请稍后重试。"); };
  const dispose = (id: string, entry: Entry) => {
    entry.disposed = true; clearTimeout(entry.timer);
    for (const socket of entry.sockets) socket.ws.terminate();
    if (rooms.has(id)) rooms.delete(id);
  };
  async function entryFor(id: string): Promise<Entry> {
    const existing = rooms.get(id); if (existing) return existing;
    const loading = (async () => {
      let values = await options.store.load(id) ?? {};
      const entry = { sockets: new Set<Socket>(), tail: Promise.resolve(), disposed: false } as Entry;
      const ctx: RoomContext = {
        blockConcurrencyWhile: callback => callback(),
        getWebSockets: () => [...entry.sockets],
        storage: {
          get: async <T>(key: string) => structuredClone(values[key]) as T | undefined,
          put: async (key, value) => {
            ensureReady();
            const next = { ...values, [key]: structuredClone(value) };
            await options.store.save(id, next); values = next;
          },
          setAlarm: async timestamp => {
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              void enqueue(id, entry, () => entry.room.alarm()).catch(() => {});
            }, Math.max(1, Math.min(timestamp - Date.now(), 2_147_483_647)));
            entry.timer.unref();
          },
          deleteAlarm: async () => { clearTimeout(entry.timer); entry.timer = undefined; }
        }
      };
      entry.room = new Room(ctx); return entry;
    })();
    rooms.set(id, loading);
    try { return await loading; } catch (error) { rooms.delete(id); throw error; }
  }
  async function enqueue<T>(id: string, entry: Entry, action: () => Promise<T>): Promise<T> {
    const result = entry.tail.then(async () => {
      ensureReady(); if (entry.disposed) throw new HttpError(503, "Room state is reloading.");
      try { return await action(); } catch (error) {
        // A failed durable write must never leave an admitted but uncommitted identity live.
        if (!(error instanceof HttpError)) dispose(id, entry);
        throw error;
      }
    });
    entry.tail = result.catch(() => {}); return result;
  }
  async function roomRequest(id: string, path: string, req: IncomingMessage, payload?: unknown) {
    const entry = await entryFor(id);
    return enqueue(id, entry, () => entry.room.fetch(new Request(`http://room${path}`, {
      method: req.method, headers: req.headers.authorization ? {authorization:req.headers.authorization} : {},
      ...(req.method === "POST" ? {body:JSON.stringify(payload ?? {})} : {})
    })));
  }
  // Bounded per-process creation limiter. No IP addresses or message bodies are logged/stored.
  const creationTimes: number[] = [];
  async function api(req: IncomingMessage, url: URL): Promise<Response> {
    ensureReady();
    if (req.method === "POST" && !sameOrigin(req)) throw new HttpError(403, "Cross-origin request denied.");
    if (url.pathname === "/api/growth" && req.method === "POST") return new Response(null,{status:204});
    if (url.pathname === "/api/rooms" && req.method === "POST") {
      const now = Date.now();
      while (creationTimes.length && creationTimes[0] < now - 60_000) creationTimes.shift();
      if (creationTimes.length >= 60) throw new HttpError(429, "Too many rooms. Try again shortly.");
      creationTimes.push(now);
      const input = await body(req);
      const roomId = randomBytes(ROOM_ID_BYTES).toString("base64url");
      const maxAgeMs = duration(input.maxAgeMs, null);
      const output: CreateRoomResponse = {
        roomId, roomUrl: `${url.origin}/c/${roomId}`, websocketPath: `/api/rooms/${roomId}/ws`,
        creatorToken: randomBytes(32).toString("base64url"), createdAt: now,
        expiresAt: maxAgeMs === null ? null : now + maxAgeMs, maxAgeMs,
        inactivityTimeoutMs: duration(input.inactivityTimeoutMs, null),
        disappearAfterReadSeconds: duration(input.disappearAfterReadSeconds, null)
      };
      const response = await roomRequest(roomId,"/internal/bootstrap",req,output);
      if (!response.ok) return response;
      return json(output,201);
    }
    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,80})(?:\/(destroy|invites|invites\/revoke|ws))?$/);
    if (!match) return json({error:"Not found."},404);
    const [,id,action] = match;
    if (!action && req.method === "GET") return roomRequest(id,"/internal/metadata",req);
    if (action === "invites" && req.method === "GET") {
      if (!/^Bearer [A-Za-z0-9_-]+$/i.test(req.headers.authorization ?? "")) return json({error:"Unauthorized."},403);
      return roomRequest(id,"/internal/invites",req);
    }
    if (req.method === "POST" && ["destroy","invites","invites/revoke"].includes(action)) {
      const input = await body(req);
      if (typeof input.creatorToken !== "string") throw new HttpError(400,"Creator capability required.");
      if (input.ttlMs !== undefined) duration(input.ttlMs,null);
      if (action === "invites/revoke" && typeof input.token !== "string") throw new HttpError(400,"Invite token required.");
      return roomRequest(id,`/internal/${action === "invites" ? "invites/create" : action}`,req,input);
    }
    return json({error:"Method not allowed."},405);
  }
  const mime: Record<string,string> = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".ico":"image/x-icon",".zip":"application/zip",".txt":"text/plain; charset=utf-8",".json":"application/json"};
  async function assets(req: IncomingMessage, url: URL, res: ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405,"Method not allowed.");
    const root = resolve(options.publicDir);
    let path: string;
    try { path = resolve(root, `.${decodeURIComponent(url.pathname)}`); } catch { throw new HttpError(400,"Invalid path."); }
    if (!path.startsWith(root + sep) && path !== root) throw new HttpError(403,"Forbidden.");
    try {
      if (!(await stat(path)).isFile()) path = resolve(path,"index.html");
      await stat(path);
    } catch {
      if (extname(url.pathname)) throw new HttpError(404,"Not found.");
      path = resolve(root,"index.html");
    }
    let content: Buffer;
    try { content = await readFile(path); } catch { throw new HttpError(404,"Build frontend first."); }
    securityHeaders(res); res.setHeader("Content-Type",mime[extname(path)] ?? "application/octet-stream");
    res.setHeader("Cache-Control",url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
    res.end(req.method === "HEAD" ? undefined : content);
  }
  function requestUrl(req: IncomingMessage) {
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return new URL(req.url ?? "/",`${protocol}://${req.headers.host ?? "localhost"}`);
  }
  const server = createServer((req,res) => {
    void (async () => {
      const url = requestUrl(req);
      if (url.pathname === "/healthz") return respond(res,json({ok:true}));
      if (url.pathname === "/readyz") return respond(res,json({ready:!closing && ownsLease()},!closing && ownsLease() ? 200 : 503));
      if (url.pathname.startsWith("/api/")) return respond(res,await api(req,url));
      await assets(req,url,res);
    })().catch(error => {
      if (!res.headersSent) void respond(res,json({error:error instanceof HttpError ? error.message : "房间存储暂时不可用，请稍后重试。"},error instanceof HttpError ? error.status : 503));
      else res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on("upgrade",(req,socket,head) => {
    socket.on("error",()=>{});
    void (async () => {
      ensureReady();
      if (!sameOrigin(req)) throw new HttpError(403,"Cross-origin socket denied.");
      const match = requestUrl(req).pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,80})\/ws$/);
      if (!match) throw new HttpError(404,"Not found.");
      const id = match[1], entry = await entryFor(id);
      await enqueue(id,entry,async () => {
        const unavailable = await entry.room.socketStatus();
        if (unavailable) throw new HttpError(unavailable.status,"Room unavailable.");
        if (socket.destroyed || !socket.readable || !socket.writable) throw new HttpError(400,"Socket already closed.");
        await new Promise<void>((accepted, reject) => {
          const cleanup = () => { socket.off("close", onFailure); socket.off("error", onFailure); };
          const onFailure = () => { cleanup(); reject(new HttpError(400,"WebSocket handshake failed.")); };
          socket.once("close", onFailure); socket.once("error", onFailure);
          try { wss.handleUpgrade(req,socket,head,ws => {
          cleanup();
          alive.set(ws,true); ws.on("pong",()=>alive.set(ws,true));
          const peer = new Socket(ws); entry.sockets.add(peer);
          ws.on("error",()=>{});
          const joinedDeadline = setTimeout(()=>{
            if (!(peer.deserializeAttachment() as {sessionId?:string}|null)?.sessionId) ws.close(4408,"join timeout");
          },options.joinTimeoutMs ?? 15_000);
          joinedDeadline.unref();
          ws.on("message",(raw,isBinary) => {
            void enqueue(id,entry,()=>entry.room.webSocketMessage(peer,isBinary ? new ArrayBuffer(0) : raw.toString())).catch(()=>ws.close(1011,"Storage unavailable"));
          });
          ws.once("close",()=>{
            clearTimeout(joinedDeadline); entry.sockets.delete(peer);
            if (!closing && !entry.disposed && ownsLease()) void enqueue(id,entry,()=>entry.room.webSocketClose(peer)).catch(()=>{});
          });
          // Queue is still held: incoming messages append after initialization.
          void entry.room.acceptSocket(peer).then(accepted, reject);
          }); } catch (error) { cleanup(); reject(error); }
        });
      });
    })().catch(error => {
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${error instanceof HttpError ? error.status : 503} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
  });
  const heartbeat = setInterval(()=>{
    for (const ws of wss.clients) {
      if (!ownsLease() || closing) { ws.close(1012,"Service restarting"); continue; }
      if (ws.readyState === WebSocket.OPEN) {
        if (alive.get(ws) === false) { ws.terminate(); continue; }
        alive.set(ws,false); ws.ping();
      }
    }
  },options.heartbeatMs ?? 10_000);
  heartbeat.unref();
  return {
    server,
    async close() {
      if (closing) return; closing = true; clearInterval(heartbeat);
      const entries = await Promise.allSettled(rooms.values());
      for (const result of entries) if (result.status === "fulfilled") {
        const entry = result.value; clearTimeout(entry.timer);
        for (const peer of entry.sockets) peer.ws.terminate();
        await entry.tail;
      }
      wss.close();
      await new Promise<void>(resolveClose => { server.close(()=>resolveClose()); server.closeAllConnections(); });
      rooms.clear();
    }
  };
}
