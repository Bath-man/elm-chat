import { describe, expect, it } from "vitest";
import { decodeInteraction, encodeInteraction, interactionText, pendingInteractions, type Interaction } from "../apps/web/src/interactions";

const notice: Interaction = { type: "notice.request", id: "request-1", text: "吃饭", color: "#ffcc00" };
const poll: Interaction = { type: "poll.request", id: "request-2", question: "吃什么？", options: ["米饭", "面条"] };
const msg = (value: Interaction, senderSessionId = "peer") => ({ id: crypto.randomUUID(), senderSessionId, plaintext: encodeInteraction(value) });

describe("encrypted-channel interaction payloads", () => {
  it("round-trips all four types and supplies readable bubble text", () => {
    const values: Interaction[] = [notice, poll, { type: "notice.ack", id: "ack:request-1", replyTo: notice.id }, { type: "poll.answer", id: "answer:request-2", replyTo: poll.id, answer: "米饭" }];
    for (const value of values) expect(decodeInteraction(encodeInteraction(value))).toEqual(value);
    expect(values.map(interactionText)).toEqual(["吃饭", "吃什么？\n1. 米饭\n2. 面条", "√", "米饭"]);
    expect(decodeInteraction("普通消息")).toBeNull();
    expect(decodeInteraction("elm-interaction:v1:{broken")).toBeNull();
  });

  it("round-trips allowed text even when JSON escaping expands its size", () => {
    const expanded: Interaction = { ...poll, question: "\u0001".repeat(499) + "?", options: Array.from({ length: 6 }, (_, index) => "\u0001".repeat(119) + index) };
    expect(decodeInteraction(encodeInteraction(expanded))).toEqual(expanded);
  });

  it("rejects malformed IDs, colors, text and poll options", () => {
    const invalid = [
      { ...notice, id: "" }, { ...notice, id: "bad id" }, { ...notice, color: "red" },
      { ...notice, color: "#fff" }, { ...notice, text: " " }, { ...notice, text: "a".repeat(501) },
      { ...poll, options: ["one"] }, { ...poll, options: Array(7).fill("a") },
      { ...poll, options: ["", "b"] }, { ...poll, options: ["米饭", "米饭"] }, { ...poll, options: ["米饭", " 米饭 "] }, { ...poll, options: ["a".repeat(121), "b"] },
      { type: "poll.answer", id: "answer:1", replyTo: "bad id", answer: "a" }
    ];
    for (const value of invalid) {
      expect(decodeInteraction(`elm-interaction:v1:${JSON.stringify(value)}`)).toBeNull();
      expect(() => encodeInteraction(value as Interaction)).toThrow();
    }
  });

  it("queues incoming requests in order, deduplicates, and ignores own requests", () => {
    expect(pendingInteractions([{ id: "encrypted", senderSessionId: "peer" }, msg(notice), msg(notice), msg(poll), msg({ ...notice, id: "own" }, "self")], "self")).toEqual([notice, poll]);
  });

  it("does not reopen answered prompts when peer clock skew sorts requests after replies", () => {
    const replies: Interaction[] = [
      { type: "notice.ack", id: "ack:request-1", replyTo: notice.id },
      { type: "poll.answer", id: "answer:request-2", replyTo: poll.id, answer: "面条" }
    ];
    const sortedMessages = [...replies.map(reply => msg(reply, "self")), msg(notice), msg(poll), msg(notice)];
    expect(pendingInteractions(sortedMessages, "self")).toEqual([]);
  });

  it("only accepts matching replies from the receiving participant regardless of order", () => {
    const ack: Interaction = { type: "notice.ack", id: "ack:request-1", replyTo: notice.id };
    const answer: Interaction = { type: "poll.answer", id: "answer:request-2", replyTo: poll.id, answer: "面条" };
    expect(pendingInteractions([msg(notice), msg(ack, "self"), msg(poll), msg(answer, "self")], "self")).toEqual([]);
    expect(pendingInteractions([msg(notice), msg(ack)], "self")).toEqual([notice]);
    expect(pendingInteractions([msg({ ...ack, replyTo: "missing" }, "self"), msg(notice)], "self")).toEqual([notice]);
    expect(pendingInteractions([msg(ack, "self"), msg(notice), msg(ack), msg(poll), msg({ ...answer, answer: "不存在" }, "self")], "self")).toEqual([poll]);
    expect(pendingInteractions([msg(notice), msg({ ...answer, replyTo: notice.id }, "self")], "self")).toEqual([notice]);
  });
});
