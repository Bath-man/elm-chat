import { describe, expect, it } from "vitest";
import { serverConfig } from "../apps/server/src/config";

describe("memory-only runtime configuration", () => {
  it("starts production and development without database credentials", () => {
    const defaults = { port: 8080, publicDir: "apps/web/dist" };
    expect(serverConfig({})).toEqual(defaults);
    expect(serverConfig({ NODE_ENV: "production" })).toEqual(defaults);
  });
  it("honors the listening port and static asset directory", () => {
    expect(serverConfig({ PORT: "3000", PUBLIC_DIR: "/web" })).toEqual({ port: 3000, publicDir: "/web" });
  });
  it.each(["0", "-1", "65536", "1.5", "NaN", ""])("rejects invalid PORT %s", PORT => {
    expect(() => serverConfig({ PORT })).toThrow("PORT");
  });
});
