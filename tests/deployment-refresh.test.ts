import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("explicit rollback cache refresh", () => {
  it("changes only the tracked marker, without credentials or deployment access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-release-"));
    try {
      await mkdir(join(directory, "scripts"));
      await copyFile(new URL("../scripts/refresh-release.mjs", import.meta.url), join(directory, "scripts/refresh-release.mjs"));
      const refresh = () => spawnSync(process.execPath, [join(directory, "scripts/refresh-release.mjs")], { cwd: tmpdir(), encoding: "utf8" });
      expect(refresh().status).toBe(0);
      const first = await readFile(join(directory, "deployment-version.txt"), "utf8");
      expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T.*-[0-9a-f-]{36}\n$/);
      expect(refresh().status).toBe(0);
      expect(await readFile(join(directory, "deployment-version.txt"), "utf8")).not.toBe(first);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
