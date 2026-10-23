import { generateMessageId } from "@elm-chat/crypto";
import { MESSAGE_PROTOCOL_VERSION, type EncryptedMessageEnvelope } from "@elm-chat/shared";

/** Logical control IDs (ack:/answer:/edit:) remain inside ciphertext; v3 envelopes require UUIDs. */
export function createTextEnvelope(message: { id: string; transportId?: string; senderSessionId: string; sentAt: number }, keyEpoch: number): EncryptedMessageEnvelope {
  return {
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    messageId: message.transportId ?? (/^[0-9a-f-]{36}$/i.test(message.id) ? message.id : generateMessageId()),
    senderSessionId: message.senderSessionId,
    ciphertext: "", nonce: "", sentAt: message.sentAt,
    expiresAfterReadSeconds: null, keyEpoch
  };
}
