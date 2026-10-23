import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { connect } from "node:net";
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
async function join(origin: string, room: any, creator: boolean, sessionId = crypto.randomUUID(), identityKey = key, inviteToken?: string) {
  if (!creator && !inviteToken) {
    const res = await fetch(`${origin}/api/rooms/${room.roomId}/invites`, {
      method: "POST", body: JSON.stringify({ creatorToken: room.creatorToken })
    }); inviteToken = (await res.json()).token;
  }
  const ws = await open(origin, room.roomId);
  const next = event(ws);
  ws.send(JSON.stringify({ type: "join", sessionId, identityKey, agreementKey: identityKey,
    ...(creator ? { creatorToken: room.creatorToken } : { inviteToken }) }));
  return { ws, result: await next, sessionId, inviteToken };
}
describe("CloudBase-compatible Node runtime", () => {
  it("keeps liveness separate from lease readiness and rejects mutations without ownership",async()=>{
    const store=new MemoryMetadataStore();
    const app=createChatServer({store,publicDir:"/nonexistent",ownsLease:()=>false});
    await new Promise<void>(resolve=>app.server.listen(0,"127.0.0.1",resolve));
    const origin=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
    try {
      expect((await fetch(`${origin}/healthz`)).status).toBe(200);
      expect((await fetch(`${origin}/readyz`)).status).toBe(503);
      expect((await fetch(`${origin}/api/rooms`,{method:"POST",body:"{}"})).status).toBe(503);
      expect(store.snapshot()).toEqual({});
    } finally {await app.close();}
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
  it("does not strand the queue when a socket disconnects during metadata loading",async()=>{
    const first=await setup(); const room=await create(first.origin);
    const original=first.store.load.bind(first.store);
    first.store.load=async id=>{await new Promise(resolve=>setTimeout(resolve,150));return original(id);};
    const second=await setup(first.store);const url=new URL(second.origin);
    await new Promise<void>((done,reject)=>{
      const socket=connect(Number(url.port),url.hostname,()=>{
        socket.write(`GET /api/rooms/${room.roomId}/ws HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n`);
        setTimeout(()=>{socket.resetAndDestroy();done();},20);
      });socket.on("error",reject);
    });
    await new Promise(resolve=>setTimeout(resolve,250));
    const res=await fetch(`${second.origin}/api/rooms/${room.roomId}`,{signal:AbortSignal.timeout(1000)});
    expect(res.status).toBe(200);
    expect((await join(second.origin,room,true)).result.type).toBe("joined");
  });
  it("preserves two admitted seats, reconnect identity and single-use invitations", async () => {
    const { origin } = await setup(); const room = await create(origin);
    expect((await join(origin, room, true)).result.type).toBe("joined");
    const guest = await join(origin, room, false); expect(guest.result.type).toBe("joined");
    guest.ws.close(); await new Promise(resolve => guest.ws.once("close", resolve));
    expect((await join(origin, room, false)).result).toMatchObject({type:"error",code:"room_full"});
    expect((await join(origin, room, false, guest.sessionId, `B${"C".repeat(86)}`, guest.inviteToken)).result.code).toBe("identity_mismatch");
    expect((await join(origin, room, false, guest.sessionId, key, guest.inviteToken)).result.type).toBe("joined");
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
  it("restores admitted seats and invites after server restart", async () => {
    const first=await setup(); const room=await create(first.origin);
    await join(first.origin,room,true); const guest=await join(first.origin,room,false);
    for(const ws of sockets.splice(0)) ws.terminate();
    await first.app.close(); running.splice(running.indexOf(first),1);
    const second=await setup(first.store);
    expect((await join(second.origin,room,false,guest.sessionId,key,guest.inviteToken)).result.type).toBe("joined");
    expect((await join(second.origin,room,false)).result.code).toBe("room_full");
  });
  it("fails closed when metadata cannot be saved",async()=>{
    const store=new MemoryMetadataStore(); store.save=async()=>{throw new Error("database unavailable");};
    const {origin}=await setup(store);
    expect((await fetch(`${origin}/api/rooms`,{method:"POST",body:"{}"})).status).toBe(503);
  });
});
