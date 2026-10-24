import { describe, expect, it } from "vitest";
import { messageOffsets, visibleMessageRange } from "../apps/web/src/virtual-messages";

describe("virtual message geometry", () => {
  it("uses measured heights and estimates only unseen messages", () => {
    expect(messageOffsets([{ id: "a" }, { id: "b" }, { id: "c" }], new Map([["b", 130]]), 80))
      .toEqual([0, 80, 210, 290]);
  });
  it("bounds the mounted range around a far viewport and supports reverse scrolling", () => {
    const offsets = Array.from({ length: 2001 }, (_, i) => i * 80);
    expect(visibleMessageRange(offsets, 80000, 600, 400)).toEqual({ start: 995, end: 1013 });
    expect(visibleMessageRange(offsets, 0, 600, 400)).toEqual({ start: 0, end: 13 });
    expect(visibleMessageRange(offsets, 159400, 600, 400)).toEqual({ start: 1987, end: 2000 });
  });
  it("handles empty lists, exact boundaries and offsets above the list", () => {
    expect(visibleMessageRange([0], 0, 600, 400)).toEqual({ start: 0, end: 0 });
    expect(visibleMessageRange([0, 80, 160], 80, 80, 0)).toEqual({ start: 1, end: 2 });
    expect(visibleMessageRange([0, 80, 160], -100, 50, 0)).toEqual({ start: 0, end: 0 });
  });
});
