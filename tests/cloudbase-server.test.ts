import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { Room } from "../apps/server/src/room";
import type { RoomSocket } from "../apps/server/src/room-runtime";
import { createChatServer } from "../apps/server/src/server";
import { MemoryMetadataStore } from "../apps/server/src/storage";

const running: Awaited<ReturnType<typeof start>>[] = [];
const sockets: WebSocket[] = [];
async function start(store = new MemoryMetadataStore()) {
  const app = createChatServer({ store, publicDir: "/nonexistent" });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  return { app, origin, store };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const entry of running.splice(0)) await entry.app.close();
});
async function setup(store?: MemoryMetadataStore) {
  const entry = await start(store); running.push(entry); return entry;
}
async function create(origin: string) {
  const res = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(201); return res.json();
}
function event(ws: WebSocket, type?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error(`Missing ${type ?? "event"}`)); }, 4000);
    function onMessage(raw: Buffer) {
      const data = JSON.parse(raw.toString());
      if (type && data.type !== type) return;
      clearTimeout(timer); ws.off("message", onMessage); resolve(data);
    }
    ws.on("message", onMessage);
  });
}
async function open(origin: string, roomId: string) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/api/rooms/${roomId}/ws`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return ws;
}
const key = `B${"A".repeat(86)}`;
async function socketRejection(origin: string, roomId: string) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace("http", "ws")}/api/rooms/${roomId}/ws`);
    ws.on("error", () => {});
    ws.once("unexpected-response", (_request, response) => {response.resume(); resolve(response.statusCode!);});
    ws.once("open", () => {sockets.push(ws); reject(new Error("Unavailable room accepted a socket"));});
  });
}
async function join(origin: string, room: any, creator: boolean, sessionId = crypto.randomUUID(), identityKey = key, inviteToken?: string, reconnectToken?: string) {
  if (!creator && !inviteToken) {
    const res = await fetch(`${origin}/api/rooms/${room.roomId}/invites`, {
      method: "POST", body: JSON.stringify({ creatorToken: room.creatorToken })
    }); inviteToken = (await res.json()).token;
  }
  const ws = await open(origin, room.roomId);
  const next = event(ws);
  ws.send(JSON.stringify({ type: "join", sessionId, identityKey, agreementKey: identityKey, reconnectToken,
    ...(creator ? { creatorToken: room.creatorToken } : { inviteToken }) }));
  return { ws, result: await next, sessionId, inviteToken };
}
describe("CloudBase-compatible Node runtime", () => {
  it("permits only local blob image previews without allowing remote image hosts", async () => {
    const { origin } = await setup();
    const response = await fetch(`${origin}/healthz`);
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).not.toContain("img-src *");
  });

  it("is immediately ready without a lease or database and has no handoff endpoint", async () => {
    const { origin } = await setup();
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/readyz`)).status).toBe(200);
    expect((await fetch(`${origin}/api/runtime`)).status).toBe(404);
    await create(origin);
  });
  it("rejects unknown room metadata, invitations, destruction and sockets without creating room state", async () => {
    const { origin, store } = await setup();
    const url = `${origin}/api/rooms/missing`;
    expect((await fetch(url)).status).toBe(404);
    for (const action of ["invites", "invites/revoke", "destroy"]) {
      expect((await fetch(`${url}/${action}`, { method: "POST", body: JSON.stringify({ creatorToken: "old", token: "old" }) })).status).toBe(404);
    }
    expect(await socketRejection(origin, "missing")).toBe(404);
    expect(store.snapshot()).toEqual({});
  });
  it("creates rooms without exposing creator capability in metadata; health works", async () => {
    const { origin } = await setup(); const room = await create(origin);
    expect(room.roomUrl).toBe(`${origin}/c/${room.roomId}`);
    const res = await fetch(`${origin}/api/rooms/${room.roomId}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const metadata = await res.json();
    expect(metadata).not.toHaveProperty("creatorToken");
    expect(metadata).toMatchObject({inactivityTimeoutMs:null,disappearAfterReadSeconds:null});
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
  });
  it("releases the room queue after an invalid WebSocket handshake",async()=>{
    const entry = await setup(); const room = await create(entry.origin);
    const url=new URL(entry.origin);
    await new Promise<void>((done,reject)=>{
      const socket=connect(Number(url.port),url.hostname,()=>{
        socket.write(`GET /api/rooms/${room.roomId}/ws HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      socket.on("data",()=>{});socket.once("close",()=>done());socket.once("error",reject);
    });
    try {
      const res=await fetch(`${entry.origin}/api/rooms/${room.roomId}`,{signal:AbortSignal.timeout(500)});
      expect(res.status).toBe(200);
      expect((await join(entry.origin,room,true)).result.type).toBe("joined");
    } finally {
      // A regression may leave the queue pending; still close the test's listening socket.
      entry.app.server.closeAllConnections();entry.app.server.close();
      running.splice(running.indexOf(entry),1);
      // The fixed implementation also closes its queue/timer resources normally.
      void entry.app.close();
    }
  });
  it("requires creator permission to list/destroy/revoke and rejects malformed JSON", async () => {
    const { origin } = await setup(); const room = await create(origin);
    expect((await fetch(`${origin}/api/rooms/${room.roomId}/invites?creatorToken=${room.creatorToken}`)).status).toBe(403);
    expect((await fetch(`${origin}/api/rooms/${room.roomId}/destroy`, { method: "POST", body: JSON.stringify({creatorToken:"bad"}) })).status).toBe(403);
    expect((await fetch(`${origin}/api/rooms/${room.roomId}/invites`, {headers:{authorization:`Bearer ${room.creatorToken}`}})).status).toBe(200);
    expect((await fetch(`${origin}/api/rooms`,{method:"POST",body:"{"})).status).toBe(400);
  });
  it("preserves two admitted seats, reconnect identity and single-use invitations", async () => {
    const { origin } = await setup(); const room = await create(origin);
    expect((await join(origin, room, true)).result.type).toBe("joined");
    const guest = await join(origin, room, false); expect(guest.result.type).toBe("joined");
    guest.ws.close(); await new Promise(resolve => guest.ws.once("close", resolve));
    expect((await join(origin, room, false)).result).toMatchObject({type:"error",code:"room_full"});
    expect((await join(origin, room, false, guest.sessionId, `B${"C".repeat(86)}`, guest.inviteToken)).result.code).toBe("identity_mismatch");
    expect((await join(origin, room, false, guest.sessionId, key, guest.inviteToken, guest.result.reconnectToken)).result.type).toBe("joined");
  });
  it("requires a secret recovery token and replaces only the authenticated member socket", async () => {
    const { origin, store } = await setup(); const room = await create(origin);
    const creator = await join(origin, room, true);
    const guest = await join(origin, room, false);
    expect(guest.result.reconnectToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(store.snapshot())).not.toContain(guest.result.reconnectToken);
    expect((await join(origin, room, false, guest.sessionId, key, guest.inviteToken)).result.code).toBe("reconnect_required");
    expect((await join(origin, room, false, guest.sessionId, key, guest.inviteToken, "wrong")).result.code).toBe("reconnect_required");
    const kicked = event(guest.ws, "participant_kicked");
    const peerEvents: any[] = []; creator.ws.on("message", raw => peerEvents.push(JSON.parse(raw.toString())));
    const replacement = await join(origin, room, false, guest.sessionId, key, guest.inviteToken, guest.result.reconnectToken);
    expect(replacement.result).toMatchObject({type:"joined",creator:false,presence:{count:2}});
    expect(await kicked).toMatchObject({reason:"session-replaced"});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(peerEvents.filter(value => value.type === "peer_left")).toHaveLength(0);
    expect((await join(origin, room, false)).result.code).toBe("room_full");
  });
  it("recovers with the pre-saved credential when the first joined acknowledgement is lost", async () => {
    const {origin} = await setup(); const room = await create(origin);
    const creator = await join(origin, room, true);
    const inviteResponse = await fetch(`${origin}/api/rooms/${room.roomId}/invites`, {
      method:"POST",body:JSON.stringify({creatorToken:room.creatorToken})
    });
    const inviteToken = (await inviteResponse.json()).token;
    const sessionId = crypto.randomUUID(), reconnectToken = randomBytes(32).toString("base64url");
    const firstSocket = await open(origin, room.roomId);
    // Observe admission through the peer, deliberately never reading joined.
    const admitted = event(creator.ws, "peer_joined");
    firstSocket.send(JSON.stringify({type:"join",sessionId,identityKey:key,agreementKey:key,inviteToken,reconnectToken}));
    await admitted;
    const closed = new Promise(resolve => firstSocket.once("close",resolve));
    firstSocket.terminate(); await closed;
    expect((await join(origin, room, false, sessionId, key, inviteToken, randomBytes(32).toString("base64url"))).result.code).toBe("reconnect_required");
    const recovered = await join(origin, room, false, sessionId, key, inviteToken, reconnectToken);
    expect(recovered.result).toMatchObject({type:"joined",sessionId,reconnectToken,creator:false,presence:{count:2}});
  });
  it.each(["closing-visible", "removed-from-runtime"])("ignores superseded socket late close (%s)", async phase => {
    const values = new Map<string, unknown>();
    let connected: RoomSocket[] = [];
    const runtime = new Room({
      storage: {
        get: async <T>(name: string) => values.get(name) as T | undefined,
        put: async (name, value) => { values.set(name, structuredClone(value)); },
        setAlarm: async () => {}, deleteAlarm: async () => {}
      },
      blockConcurrencyWhile: async callback => callback(),
      getWebSockets: () => connected
    });
    const roomId = crypto.randomUUID(), creatorToken = crypto.randomUUID();
    await runtime.fetch(new Request("http://room/internal/bootstrap", {method:"POST",body:JSON.stringify({
      roomId,creatorToken,createdAt:Date.now(),expiresAt:null,inactivityTimeoutMs:null,maxAgeMs:null,disappearAfterReadSeconds:null
    })}));
    function socket() {
      let attachment: unknown;
      const result = {
        readyState:1, events:[] as any[],
        send(payload: string) { this.events.push(JSON.parse(payload)); },
        close() { this.readyState = 2; },
        serializeAttachment(value: unknown) { attachment = value; },
        deserializeAttachment() { return attachment; }
      };
      connected.push(result); return result;
    }
    const creator = socket(); await runtime.acceptSocket(creator);
    await runtime.webSocketMessage(creator,JSON.stringify({type:"join",sessionId:"creator",identityKey:key,agreementKey:key,creatorToken}));
    const invitation = await (await runtime.fetch(new Request("http://room/internal/invites/create",{
      method:"POST",body:JSON.stringify({creatorToken})
    }))).json();
    const old = socket(); await runtime.acceptSocket(old);
    await runtime.webSocketMessage(old,JSON.stringify({type:"join",sessionId:"guest",identityKey:key,agreementKey:key,inviteToken:invitation.token}));
    const reconnectToken = old.events.find(value => value.type === "joined").reconnectToken;
    old.readyState = 2;
    if (phase === "removed-from-runtime") connected = connected.filter(value => value !== old);
    const replacement = socket(); await runtime.acceptSocket(replacement);
    await runtime.webSocketMessage(replacement,JSON.stringify({type:"join",sessionId:"guest",identityKey:key,agreementKey:key,reconnectToken}));
    const membershipVersion = replacement.events.find(value => value.type === "joined").room.membershipVersion;
    creator.events.length = 0;
    await runtime.webSocketClose(old);
    expect(creator.events.filter(value => value.type === "peer_left")).toHaveLength(0);
    const metadata = await (await runtime.fetch(new Request("http://room/internal/metadata"))).json();
    expect(metadata).toMatchObject({participantCount:2,membershipVersion});
  });
  it("restores both identities after invite expiry without consuming another invitation", async () => {
    const { origin } = await setup(); const room = await create(origin);
    const creator = await join(origin, room, true); const guest = await join(origin, room, false);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect((await join(origin, room, false, guest.sessionId, key, undefined, guest.result.reconnectToken)).result.type).toBe("joined");
    expect((await join(origin, room, false, creator.sessionId, key, undefined, creator.result.reconnectToken)).result.creator).toBe(true);
  });
  it("invalidates recovery on invitation revocation and room destruction", async () => {
    const {origin} = await setup(); const room = await create(origin);
    const creator = await join(origin, room, true); const guest = await join(origin, room, false);
    guest.ws.close(); await new Promise(resolve => guest.ws.once("close", resolve));
    await fetch(`${origin}/api/rooms/${room.roomId}/invites/revoke`, {method:"POST",body:JSON.stringify({creatorToken:room.creatorToken,token:guest.inviteToken})});
    expect((await join(origin, room, false, guest.sessionId, key, guest.inviteToken, guest.result.reconnectToken)).result.code).toBe("reconnect_required");
    await fetch(`${origin}/api/rooms/${room.roomId}/destroy`, {method:"POST",body:JSON.stringify({creatorToken:room.creatorToken})});
    expect((await fetch(`${origin}/api/rooms/${room.roomId}`)).status).toBe(200);
    expect((await (await fetch(`${origin}/api/rooms/${room.roomId}`)).json()).status).toBe("destroyed");
    expect(creator.result.reconnectToken).toBeTruthy();
    expect(await socketRejection(origin, room.roomId)).toBe(410);
  });
  it("rejects old recovery credentials once the room has expired", async () => {
    const {origin} = await setup();
    const response = await fetch(`${origin}/api/rooms`, { method: "POST", body: JSON.stringify({ maxAgeMs: 1000 }) });
    const expiring = await response.json();
    const creator = await join(origin, expiring, true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1001);
    expect(creator.result.reconnectToken).toBeTruthy();
    expect(await socketRejection(origin, expiring.roomId)).toBe(410);
  });
  it("rejects kicked member credentials even after the member is offline", async () => {
    const {origin} = await setup(); const room = await create(origin);
    const creator = await join(origin, room, true); const guest = await join(origin, room, false);
    const kicked = event(guest.ws, "participant_kicked");
    creator.ws.send(JSON.stringify({type:"kick_participant",creatorToken:room.creatorToken,targetSessionId:guest.sessionId}));
    await kicked;
    expect((await join(origin, room, false, guest.sessionId, key, guest.inviteToken, guest.result.reconnectToken)).result.code).toBe("reconnect_required");
  });
  it("serializes simultaneous joins so only two identities are admitted", async () => {
    const { origin } = await setup(); const room = await create(origin);
    const results = await Promise.all(Array.from({length:5},()=>join(origin,room,true)));
    expect(results.filter(value=>value.result.type==="joined")).toHaveLength(2);
    expect(results.filter(value=>value.result.code==="room_full")).toHaveLength(3);
  });
  it("rejects unjoined traffic and unsigned/mismatched peer events", async () => {
    const { origin } = await setup(); const room = await create(origin);
    const outsider = await open(origin,room.roomId); let next = event(outsider);
    outsider.send(JSON.stringify({type:"ping"})); expect((await next).code).toBe("join_required");
    const creator = await join(origin,room,true); next=event(creator.ws,"error");
    creator.ws.send(JSON.stringify({type:"peer_data",data:{type:"sync_request"}}));
    expect((await next).code).toBe("invalid_peer_event");
  });
  it("rejects cross-origin room creation and socket connections",async()=>{
    const {origin}=await setup();const room=await create(origin);
    expect((await fetch(`${origin}/api/rooms`,{method:"POST",headers:{origin:"https://unrelated.example"},body:"{}"})).status).toBe(403);
    const status=await new Promise<number>((resolve,reject)=>{
      const ws=new WebSocket(`${origin.replace("http","ws")}/api/rooms/${room.roomId}/ws`,{origin:"https://unrelated.example"});
      ws.on("error",()=>{});
      ws.once("open",()=>reject(new Error("Cross-origin socket admitted")));
      ws.once("unexpected-response",(_req,res)=>{res.resume();resolve(res.statusCode!);});
    });
    expect(status).toBe(403);
  });
  it("relays original encrypted envelopes without persisting payloads", async () => {
    const { origin,store } = await setup(); const room = await create(origin);
    const a=await join(origin,room,true), b=await join(origin,room,false);
    const data={protocolVersion:1,roomId:room.roomId,senderSessionId:a.sessionId,targetSessionId:null,eventId:crypto.randomUUID(),signature:"signed",payload:{type:"chat_message",envelope:{ciphertext:"DO_NOT_PERSIST_CIPHERTEXT"}}};
    const next=event(b.ws,"peer_data"); a.ws.send(JSON.stringify({type:"peer_data",data}));
    expect((await next).data).toEqual(data);
    expect(JSON.stringify(store.snapshot())).not.toContain("DO_NOT_PERSIST_CIPHERTEXT");
  });
  it("loses rooms, invitations and admitted identities after server restart", async () => {
    const first = await setup(); const room = await create(first.origin);
    await join(first.origin, room, true); const guest = await join(first.origin, room, false);
    await first.app.close(); running.splice(running.indexOf(first), 1);
    const second = await setup();
    expect((await fetch(`${second.origin}/api/rooms/${room.roomId}`)).status).toBe(404);
    expect(await socketRejection(second.origin, room.roomId)).toBe(404);
    expect((await fetch(`${second.origin}/api/rooms/${room.roomId}/invites`, {
      method: "POST", body: JSON.stringify({ creatorToken: room.creatorToken })
    })).status).toBe(404);
    expect(second.store.snapshot()).toEqual({});
    expect(guest.result.reconnectToken).toBeTruthy();
    const replacement = await create(second.origin);
    expect(replacement.roomId).not.toBe(room.roomId);
    expect((await join(second.origin, replacement, true)).result.type).toBe("joined");
  });
  it("fails closed when metadata cannot be saved",async()=>{
    const store=new MemoryMetadataStore(); store.save=async()=>{throw new Error("room state unavailable");};
    const {origin}=await setup(store);
    expect((await fetch(`${origin}/api/rooms`,{method:"POST",body:"{}"})).status).toBe(503);
  });
});
