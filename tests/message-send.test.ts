import { describe, expect, it } from "vitest";
import { decryptMessage, deriveRoomKey, encryptMessage, generateRoomSecret } from "../packages/crypto/src/index";
import { createTextEnvelope } from "../apps/web/src/message-send";

describe("stable outgoing encrypted message identity", () => {
  const senderSessionId = "22222222-2222-4222-8222-222222222222";
  const message = { id: "11111111-1111-4111-8111-111111111111", senderSessionId, sentAt: 1730000000000 };
  it("keeps normal message IDs and creation timestamps identical across both participants and retries", () => {
    expect(createTextEnvelope(message, 1)).toMatchObject({ messageId: message.id, senderSessionId, sentAt: message.sentAt });
    expect(createTextEnvelope(message, 2)).toMatchObject({ messageId: message.id, keyEpoch: 2, sentAt: message.sentAt });
  });
  it("reuses a persisted transport UUID when resending a control after reconnect", () => {
    const control = { ...message, id: "ack:" + message.id, transportId: "33333333-3333-4333-8333-333333333333" };
    expect(createTextEnvelope(control, 1).messageId).toBe(control.transportId);
    expect(createTextEnvelope(control, 2).messageId).toBe(control.transportId);
  });
  it.each(["ack:", "answer:", "edit:"])("sends deterministic %s control IDs inside UUID-compatible encrypted envelopes", async prefix => {
    const envelope = createTextEnvelope({ ...message, id: prefix + message.id }, 1);
    expect(envelope.messageId).toMatch(/^[0-9a-f-]{36}$/i);
    const key = await deriveRoomKey(generateRoomSecret());
    const plaintext = `elm-interaction:v1:${JSON.stringify({ type: "notice.ack", id: prefix + message.id, replyTo: message.id })}`;
    const encrypted = { ...envelope, ...await encryptMessage(key, "room", envelope, plaintext) };
    expect(await decryptMessage(key, "room", encrypted)).toBe(plaintext);
  });
});
