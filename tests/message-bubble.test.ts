import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../apps/web/src/MessageBubble";
import { encodeInteraction } from "../apps/web/src/interactions";

const message = { id: "text-1", senderSessionId: "peer", sentAt: 1, plaintext: "今天吃米饭" };
const render = (overrides = {}) => renderToStaticMarkup(createElement(MessageBubble, {
  message, mine: false, likes: 0, confirmed: false, onLike: async () => true, onEdit: () => {}, ...overrides
}));
describe("V1.1 chat bubble", () => {
  it("keeps imported messages read-only and does not show old requests as waiting", () => {
    const html = render({ message: { ...message, imported: true } });
    expect(html).toContain("导入记录");
    expect(html).not.toContain('aria-label="点赞消息"');
    expect(render({ message: { ...message, imported: true, plaintext: encodeInteraction({ type: "notice.request", id: "old-notice", text: "旧提醒", color: "#ffffff" }) } })).not.toContain("等待确认");
  });

  it("renders ordinary messages as accessible repeat-like controls", () => {
    const html = render({ likes: 12 });
    expect(html).toContain('aria-label="点赞消息"');
    expect(html).toContain('class="like-count"');
    expect(html).toContain('>12<');
  });
  it("keeps the original edited segment with a deletion and emphasizes replacement", () => {
    const html = render({ edit: { start: 3, end: 5, replacement: "面条" } });
    expect(html).toContain('<del>米饭</del><ins>面条</ins>');
    expect(html).not.toContain('class="message-actions"');
  });
  it("does not leak poll options into the sender bubble", () => {
    const html = render({ mine: true, message: { ...message, plaintext: encodeInteraction({ type: "poll.request", id: "poll-1", question: "午饭？", options: ["秘密选项"] }) } });
    expect(html).toContain("午饭？");
    expect(html).not.toContain("秘密选项");
    expect(html).toContain("等待回答");
  });
  it("keeps hidden text out of the initial DOM and offers a local reveal control", () => {
    const html = render({ message: { ...message, plaintext: encodeInteraction({ type: "hidden", id: "hidden-1", surface: "表面", hidden: "隐藏秘密" }) } });
    expect(html).toContain("表面");
    expect(html).not.toContain("隐藏秘密");
    expect(html).toContain('aria-label="显示隐藏文字"');
    expect(html).not.toContain('aria-label="点赞消息"');
  });
  it("renders a fixed dice result and confirmation on the original notice", () => {
    expect(render({ message: { ...message, plaintext: encodeInteraction({ type: "dice", id: "dice-1", value: 6 }) } })).toContain('data-value="6"');
    const html = render({ confirmed: true, message: { ...message, plaintext: encodeInteraction({ type: "notice.request", id: "notice-1", text: "提醒", color: "#ffffff" }) } });
    expect(html).toContain("notice confirmed");
    expect(html).toContain("已确认");
  });
});

describe('archived likes and image bubbles', () => {
  it('shows imported likes while keeping the bubble read-only', () => {
    const html = render({ message: { ...message, imported: true }, likes: 5 });
    expect(html).toContain('5 次点赞');
    expect(html).not.toContain('aria-label="点赞消息"');
  });
  it('shows an image thumbnail instead of raw encoded data and has an explicit preview control', () => {
    const plaintext = 'elm-image:v1:' + JSON.stringify({ name: 'tiny.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', width: 1, height: 1 });
    const html = render({ message: { ...message, plaintext } });
    expect(html).toContain('查看图片：tiny.png');
    expect(html).toContain('<img');
    expect(html).not.toContain('elm-image:v1:');
  });
});


describe("compact message rows", () => {
  it("places timestamp and pending state beside, not inside, the bubble", () => {
    const html = render({ mine: true, message: { ...message, delivery: "pending" } });
    expect(html).toContain('class="message-row message-row-mine"');
    expect(html).toContain('</article><footer class="message-meta">');
    expect(html).toContain('待发送');
    expect(html.slice(html.indexOf('<article'), html.indexOf('</article>'))).not.toContain('<footer');
  });
  it("keeps likes next to the metadata outside the message content", () => {
    const html = render({ likes: 3 });
    expect(html).toContain('class="message-row message-row-theirs"');
    expect(html.indexOf('class="bubble-likes"')).toBeGreaterThan(html.indexOf('</article>'));
  });
  it("marks valid image messages for a frameless presentation", () => {
    const plaintext = 'elm-image:v1:' + JSON.stringify({ name: 'tiny.png', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', width: 1, height: 1 });
    expect(render({ message: { ...message, plaintext } })).toMatch(/class="bubble [^"]*bubble-image/);
    expect(render({ message: { ...message, plaintext: 'elm-image:v1:broken' } })).not.toContain('bubble-image');
  });
});
