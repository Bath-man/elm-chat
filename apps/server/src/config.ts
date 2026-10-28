export function serverConfig(env: Record<string, string | undefined>) {
  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
  return { port, publicDir: env.PUBLIC_DIR ?? "apps/web/dist" };
}
