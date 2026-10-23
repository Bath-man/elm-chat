import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface LockedPackage {
  version?: string;
  optional?: boolean;
  extraneous?: boolean;
  cpu?: string[];
  os?: string[];
  optionalDependencies?: Record<string, string>;
}

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  packages: Record<string, LockedPackage>;
};

describe("esbuild cross-platform lockfile", () => {
  it("keeps platform binaries optional instead of installing every platform", () => {
    const binaries = Object.entries(lock.packages).filter(([path]) => path.includes("node_modules/@esbuild/"));
    expect(binaries.length).toBeGreaterThan(0);
    for (const [path, binary] of binaries) {
      expect(binary.optional, path).toBe(true);
      expect(binary.extraneous, path).not.toBe(true);
      expect(binary.os?.length, path).toBeGreaterThan(0);
      expect(binary.cpu?.length, path).toBeGreaterThan(0);
    }
  });

  it("preserves every esbuild optional platform dependency and its locked version", () => {
    const wrappers = Object.entries(lock.packages).filter(([path]) => path.endsWith("node_modules/esbuild"));
    expect(wrappers.length).toBeGreaterThan(0);
    for (const [path, wrapper] of wrappers) {
      expect(wrapper.extraneous, path).not.toBe(true);
      const platforms = Object.entries(wrapper.optionalDependencies ?? {});
      expect(platforms.length, path).toBeGreaterThan(0);
      for (const [name, version] of platforms) {
        const binaryPath = `${path.slice(0, -"esbuild".length)}${name}`;
        expect(name, binaryPath).toMatch(/^@esbuild\//);
        expect(lock.packages[binaryPath]?.version, binaryPath).toBe(version);
        expect(lock.packages[binaryPath]?.optional, binaryPath).toBe(true);
      }
    }
  });
});
