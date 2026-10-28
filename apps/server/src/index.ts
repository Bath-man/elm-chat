import { createChatServer } from "./server.js";
import { serverConfig } from "./config.js";

const config = serverConfig(process.env);
const chat = createChatServer({ publicDir: config.publicDir });
let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(code || 1), 8_000);
  timeout.unref();
  await chat.close();
  clearTimeout(timeout);
  process.exitCode = code;
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
chat.server.on("error", error => {
  console.error(`HTTP server error: ${error.message}`);
  void shutdown(1);
});
chat.server.listen(config.port, "0.0.0.0", () => {
  console.log(`Chat HTTP/WebSocket server listening on ${config.port} (memory only; run one instance).`);
});
