import { describe, expect, it } from "vitest";
import { getInitialTheme } from "../apps/web/src/theme";

describe("night mode preference", () => {
  it("uses an explicit saved theme before system preference", () => {
    expect(getInitialTheme("light", true)).toBe("light");
    expect(getInitialTheme("dark", false)).toBe("dark");
  });
  it("follows the system when no valid choice is saved", () => {
    expect(getInitialTheme(null, true)).toBe("dark");
    expect(getInitialTheme(null, false)).toBe("light");
    expect(getInitialTheme("invalid", true)).toBe("dark");
  });
});
