export function serverConfig(env: Record<string, string | undefined>) {
  const driver = env.STORAGE_DRIVER ?? (env.NODE_ENV === "production" ? "cloudbase" : "file");
  if (env.NODE_ENV === "production" && driver !== "cloudbase") throw new Error("Production requires STORAGE_DRIVER=cloudbase; container files are ephemeral.");
  if (driver !== "file" && driver !== "cloudbase") throw new Error("Unsupported STORAGE_DRIVER.");
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  const environment = env.TCB_ENV_ID?.trim();
  const accessKey = env.CLOUDBASE_APIKEY?.trim();
  const collection = env.CLOUDBASE_COLLECTION ?? "chat_rooms";
  const leaseCollection = env.CLOUDBASE_LEASE_COLLECTION ?? "chat_runtime";
  if (driver === "cloudbase") {
    if (!environment) throw new Error("TCB_ENV_ID is required.");
    if (!accessKey) throw new Error("CLOUDBASE_APIKEY is required; keep it server-side only.");
    if (collection === leaseCollection) throw new Error("Room and lease collection names must differ.");
  }
  return { driver, port, environment, accessKey, collection, leaseCollection,
    dataFile: env.CHAT_DATA_FILE ?? ".data/rooms.json", publicDir: env.PUBLIC_DIR ?? "apps/web/dist" };
}
