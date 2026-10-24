import { describe, expect, it } from "vitest";
import { messageOffsets, messageSlots, visibleMessageRange } from "../apps/web/src/virtual-messages";

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

describe("virtual message slots", () => {
  const messages = (...ids: string[]) => ids.map(id => ({ id }));

  it("preserves overlapping messages when the window moves in either direction", () => {
    const initial = messageSlots(messages("a", "b", "c"), new Map());
    const next = messageSlots(messages("b", "c", "d"), initial);
    expect(next.get("b")).toBe(initial.get("b"));
    expect(next.get("c")).toBe(initial.get("c"));
    expect(next.get("d")).toBe(initial.get("a"));
    const reverse = messageSlots(messages("a", "b", "c"), next);
    expect(reverse).toEqual(initial);
  });

  it("retains slots across prepend, expiration and reordering without mutating committed slots", () => {
    const previous = new Map([["a", 0], ["b", 1], ["c", 2]]);
    const next = messageSlots(messages("new", "c", "b"), previous);
    expect([...next]).toEqual([["c", 2], ["b", 1], ["new", 0]]);
    expect([...previous]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(messageSlots([], next).size).toBe(0);
  });

  it("bounds the pool while recycling disjoint and changing-size windows", () => {
    const initial = messageSlots(messages("a", "b", "c"), new Map());
    const far = messageSlots(messages("x", "y"), initial);
    expect([...far.values()]).toEqual([0, 1]);
    const larger = messageSlots(messages("x", "y", "z", "w"), far);
    expect([...larger.values()]).toEqual([0, 1, 2, 3]);
    expect(new Set(larger.values()).size).toBe(larger.size);
  });
});
