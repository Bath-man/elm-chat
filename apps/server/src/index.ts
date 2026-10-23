import cloudbase from "@cloudbase/node-sdk";
import { createChatServer } from "./server.js";
import { serverConfig } from "./config.js";
import { CloudbaseLease } from "./lease.js";
import { CloudbaseMetadataStore, FileMetadataStore, type MetadataStore, type CloudbaseDatabase } from "./storage.js";

declare const __CHAT_RELEASE__: string | undefined;
// Undefined in local tsx development; immutable and ordered in production builds.
const release = typeof __CHAT_RELEASE__ === "string" ? __CHAT_RELEASE__ : undefined;
const config = serverConfig(process.env);
let lease: CloudbaseLease | undefined;
let store: MetadataStore;
if (config.driver === "cloudbase") {
  const app = cloudbase.init({ env: config.environment!, accessKey: config.accessKey! });
  // Pinned SDK: normal get returns an array, transactional get returns an object.
  const db = app.database() as unknown as CloudbaseDatabase;
  lease = new CloudbaseLease(db, config.leaseCollection, undefined, undefined, release);
  store = new CloudbaseMetadataStore(db, config.collection, { owner: lease.owner, collection: config.leaseCollection });
} else {
  store = new FileMetadataStore(config.dataFile);
}
const chat = createChatServer({ store, publicDir: config.publicDir, ownsLease: () => !lease || lease.isValid() });
let stopping = false;
let acquiredOnce = false;
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let renewing: Promise<void> = Promise.resolve();
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true; clearTimeout(renewTimer);
  const timeout = setTimeout(()=>process.exit(code || 1), 8_000); timeout.unref();
  await chat.close();
  await renewing.catch(()=>{});
  await lease?.release().catch(()=>{});
  clearTimeout(timeout); process.exitCode = code;
}
async function renewLease() {
  if (!lease || stopping) return;
  let acquired = false;
  try { acquired = await lease.renew(); }
  catch { console.error("CloudBase lease unavailable: check environment, collections and server credentials."); }
  if (acquiredOnce && !acquired) {
    // Never reuse cached room state after another process may have taken ownership.
    setImmediate(()=>void shutdown(1)); return;
  }
  acquiredOnce ||= acquired;
  if (!stopping) renewTimer = setTimeout(()=>{ renewing = renewLease(); },acquired ? 10_000 : 2_000);
}
process.on("SIGTERM",()=>void shutdown(0));
process.on("SIGINT",()=>void shutdown(0));
chat.server.listen(config.port,"0.0.0.0",()=>{
  console.log(`Chat HTTP/WebSocket server listening on ${config.port} (${config.driver} metadata).`);
  if (lease) renewing = renewLease();
});
chat.server.on("error",error=>{console.error(`HTTP server error: ${error.message}`); void shutdown(1);});
