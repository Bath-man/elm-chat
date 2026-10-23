import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionComposer, MessageEditDialog, contrastColor } from "../apps/web/src/InteractionDialogs";

const onSend = async () => true;
const onClose = () => {};

afterEach(() => vi.unstubAllGlobals());

describe("interaction dialog initial views", () => {
  it("offers recently sent custom colors in the notice editor only", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify(["#123456", "#abcdef"]) });
    const notice = renderToStaticMarkup(createElement(InteractionComposer, {onSend, onClose}));
    expect(notice).toContain("最近使用的提醒颜色");
    expect(notice).toContain("选择最近使用的颜色 #123456");
    expect(notice).toContain("选择最近使用的颜色 #abcdef");
    const pin = renderToStaticMarkup(createElement(InteractionComposer, {initialKind: "pin", onSend, onClose}));
    expect(pin).not.toContain("最近使用的提醒颜色");
  });

  it("opens a small shared pin editor with existing text and color", () => {
    const html = renderToStaticMarkup(createElement(InteractionComposer, {initialKind: "pin", initialPin: {text: "一起喝水", color: "#d5f5dc"}, onSend, onClose}));
    expect(html).toContain("置顶文字");
    expect(html).toContain("一起喝水");
    expect(html).toContain("#d5f5dc");
  });

  it("opens hidden information with separate surface and hidden fields", () => {
    const html = renderToStaticMarkup(createElement(InteractionComposer, {initialKind: "hidden", onSend, onClose}));
    expect(html).toContain("表面文字");
    expect(html).toContain("隐藏文字");
  });

  it("allows a poll to remove its second option", () => {
    const html = renderToStaticMarkup(createElement(InteractionComposer, {initialKind: "poll", onSend, onClose}));
    expect(html).not.toMatch(/disabled=""[^>]*>移除末项/);
  });

  it("offers a readonly original message and replacement input", () => {
    const html = renderToStaticMarkup(createElement(MessageEditDialog, {text: "原来的文字", onSubmit: async () => true, onClose}));
    expect(html).toMatch(/readonly=""/i);
    expect(html).toContain("原来的文字");
    expect(html).toContain("替换文字");
    expect(html).toContain("选择");
  });

  it("chooses legible foreground colors", () => {
    expect(contrastColor("#ffffff")).toBe("#111111");
    expect(contrastColor("#000000")).toBe("#ffffff");
  });
});
