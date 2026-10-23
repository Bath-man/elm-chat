import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InteractionComposer, MessageEditDialog, contrastColor } from "../apps/web/src/InteractionDialogs";

const onSend = async () => true;
const onClose = () => {};

describe("interaction dialog initial views", () => {
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
