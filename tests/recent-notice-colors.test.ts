import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRecentNoticeColors, rememberNoticeColor } from "../apps/web/src/recent-notice-colors";

function storage(initial: string | null = null) {
  let value = initial;
  const result = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; })
  };
  vi.stubGlobal("sessionStorage", result);
  return result;
}

afterEach(() => vi.unstubAllGlobals());

describe("recent custom notice colors", () => {
  it("remembers normalized colors, puts reused colors first, and keeps six", () => {
    storage();
    for (const color of ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#ABCDEF"]) rememberNoticeColor(color);
    rememberNoticeColor("#333333");
    expect(loadRecentNoticeColors()).toEqual(["#333333", "#abcdef", "#666666", "#555555", "#444444", "#222222"]);
  });

  it("filters presets, invalid values, and duplicates from storage", () => {
    storage(JSON.stringify([null, "#ABCDEF", "#abcdef", "#ffffff", "red"]));
    rememberNoticeColor("#FFF2A8");
    rememberNoticeColor("#123");
    expect(loadRecentNoticeColors()).toEqual(["#abcdef"]);
  });

  it("ignores malformed storage and storage access failures", () => {
    storage("oops");
    expect(loadRecentNoticeColors()).toEqual([]);
    vi.stubGlobal("sessionStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } });
    expect(loadRecentNoticeColors()).toEqual([]);
    expect(() => rememberNoticeColor("#123456")).not.toThrow();
  });
});
