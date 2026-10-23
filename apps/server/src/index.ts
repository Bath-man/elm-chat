import cloudbase from "@cloudbase/node-sdk";
import { createChatServer } from "./server.js";
import { serverConfig } from "./config.js";
import { CloudbaseLease } from "./lease.js";
import { createLeaseRuntime } from "./lease-runtime.js";
import { CloudbaseMetadataStore, FileMetadataStore, type MetadataStore, type CloudbaseDatabase } from "./storage.js";

const config = serverConfig(process.env);
let lease: CloudbaseLease | undefined;
let store: MetadataStore;
if (config.driver === "cloudbase") {
  const app = cloudbase.init({ env: config.environment!, accessKey: config.accessKey! });
  const db = app.database() as unknown as CloudbaseDatabase;
  lease = new CloudbaseLease(db, config.leaseCollection);
  store = new CloudbaseMetadataStore(db, config.collection, { owner: lease.owner, collection: config.leaseCollection });
} else {
  store = new FileMetadataStore(config.dataFile);
}
let runtime: ReturnType<typeof createLeaseRuntime> | undefined;
const chat = createChatServer({ store, publicDir: config.publicDir,
  ownsLease: () => !lease || Boolean(runtime?.ownsLease()),
  onActivity: () => runtime?.demand()
});
if (lease) runtime = createLeaseRuntime({ lease, pause: chat.pause, resume: chat.resume,
  onError: () => console.error("CloudBase unavailable: check environment, database collections and server credentials.") });
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return; stopping = true;
  const timeout = setTimeout(() => process.exit(code || 1), 8_000); timeout.unref();
  await runtime?.stop();
  await chat.close();
  clearTimeout(timeout); process.exitCode = code;
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
chat.server.on("error", error => { console.error(`HTTP server error: ${error.message}`); void shutdown(1); });
try {
  // Validate both collections/credentials before opening the deployment health port.
  if (lease) await store.load("runtime-startup-check");
  await runtime?.start();
  if (!stopping) chat.server.listen(config.port, "0.0.0.0", () => {
    console.log(`Chat HTTP/WebSocket server listening on ${config.port} (${config.driver} metadata).`);
  });
} catch {
  console.error("CloudBase startup failed: check runtime variables and access to both database collections.");
  await shutdown(1);
}
