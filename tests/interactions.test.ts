import { describe, expect, it } from "vitest";
import { decodeInteraction, encodeInteraction, interactionText, pendingInteractions, deriveInteractionState, isStateInteraction, type Interaction } from "../apps/web/src/interactions";

const notice: Interaction = { type: "notice.request", id: "request-1", text: "吃饭", color: "#ffcc00" };
const poll: Interaction = { type: "poll.request", id: "request-2", question: "吃什么？", options: ["米饭", "面条"] };
const msg = (value: Interaction, senderSessionId = "peer") => ({ id: crypto.randomUUID(), senderSessionId, plaintext: encodeInteraction(value) });

describe("encrypted-channel interaction payloads", () => {
  it("round-trips request and reply types and supplies readable bubble text", () => {
    const values: Interaction[] = [notice, poll, { type: "notice.ack", id: "ack:request-1", replyTo: notice.id }, { type: "poll.answer", id: "answer:request-2", replyTo: poll.id, answer: "米饭" }];
    for (const value of values) expect(decodeInteraction(encodeInteraction(value))).toEqual(value);
    expect(values.map(interactionText)).toEqual(["吃饭", "吃什么？", "", "米饭"]);
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
      { ...poll, options: [] }, { ...poll, options: Array(7).fill("a") },
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

describe("V1.1 shared interaction state", () => {
  it("round-trips new payloads and allows a single poll option", () => {
    const values: Interaction[] = [
      { ...poll, options: ["好的"] },
      { type: "message.like", id: "like-1", replyTo: "text-1" },
      { type: "pin.set", id: "pin-1", text: "置顶", color: "#ffeecc" },
      { type: "pin.delete", id: "pin-2" },
      { type: "dice", id: "dice-1", value: 6 },
      { type: "hidden", id: "hidden-1", surface: "表面", hidden: "秘密" },
      { type: "message.edit", id: "edit-1", replyTo: "text-1", start: 0, end: 2, replacement: "新" }
    ];
    for (const value of values) expect(decodeInteraction(encodeInteraction(value))).toEqual(value);
    expect(isStateInteraction(values[1])).toBe(true);
    expect(isStateInteraction(values[4])).toBe(false);
    expect(isStateInteraction({ type: "poll.answer", id: "answer", replyTo: poll.id, answer: "米饭" })).toBe(false);
  });

  it("rejects malformed new payloads", () => {
    const values = [
      { type: "dice", id: "d", value: 0 }, { type: "dice", id: "d", value: 7 }, { type: "dice", id: "d", value: 1.5 },
      { type: "hidden", id: "h", surface: "", hidden: "x" },
      { type: "pin.set", id: "p", text: "x", color: "red" },
      { type: "message.edit", id: "e", replyTo: "x", start: -1, end: 2, replacement: "x" },
      { type: "message.edit", id: "e", replyTo: "x", start: 1, end: 1, replacement: "x" },
      { type: "message.edit", id: "e", replyTo: "x", start: 0, end: 1.5, replacement: "x" }
    ];
    for (const value of values) expect(decodeInteraction(`elm-interaction:v1:${JSON.stringify(value)}`)).toBeNull();
  });

  it("derives peer confirmations and answers independently of message order", () => {
    const messages = [msg({ type: "notice.ack", id: "a", replyTo: notice.id }, "self"), msg(notice), msg(poll), msg({ type: "poll.answer", id: "b", replyTo: poll.id, answer: "面条" }, "self")];
    const state = deriveInteractionState(messages);
    expect([...state.acknowledged]).toEqual([notice.id]);
    expect(state.answers.get(poll.id)).toBe("面条");
    expect(deriveInteractionState([msg(notice), msg({ type: "notice.ack", id: "a", replyTo: notice.id })]).acknowledged.size).toBe(0);
  });

  it("counts repeated distinct likes but deduplicates sender event IDs and rejects non-text targets", () => {
    const like = { type: "message.like", id: "l1", replyTo: "text-1" } as const;
    const state = deriveInteractionState([
      msg(like), msg(like), msg(like, "self"), msg({ ...like, id: "l2" }),
      { id: "text-1", senderSessionId: "self", plaintext: "hello" },
      msg(notice), msg({ ...like, id: "l3", replyTo: notice.id }), msg({ ...like, id: "l4", replyTo: "missing" })
    ]);
    expect([...state.likes]).toEqual([["text-1", 3]]);
  });

  it("accepts only the first valid peer edit in timestamp/id order", () => {
    const edit = { type: "message.edit", id: "b", replyTo: "text-1", start: 1, end: 3, replacement: "NEW" } as const;
    const events = [
      { ...msg(edit), sentAt: 2 }, { ...msg({ ...edit, id: "a", replacement: "FIRST" }), sentAt: 2 },
      { ...msg({ ...edit, id: "own" }, "self"), sentAt: 0 },
      { ...msg({ ...edit, id: "invalid", end: 100 }), sentAt: 0 },
      { id: "text-1", senderSessionId: "self", plaintext: "hello", sentAt: 9 }
    ];
    expect(deriveInteractionState(events).edits.get("text-1")).toEqual({ start: 1, end: 3, replacement: "FIRST" });
    expect(deriveInteractionState([...events].reverse()).edits).toEqual(deriveInteractionState(events).edits);
  });

  it("retains the last pin update or deletion regardless of input ordering", () => {
    const set = { type: "pin.set", id: "a", text: "置顶", color: "#ffffff" } as const;
    const events = [{ ...msg(set), sentAt: 1 }, { ...msg({ type: "pin.delete", id: "b" }), sentAt: 2 }];
    expect(deriveInteractionState([...events].reverse()).pin).toBeNull();
    expect(deriveInteractionState([...events, { ...msg({ ...set, id: "c" }), sentAt: 3 }]).pin).toEqual({ id: "c", text: "置顶", color: "#ffffff" });
    expect(pendingInteractions([...events, msg({ type: "dice", id: "d", value: 3 })], "self")).toEqual([]);
  });
});
