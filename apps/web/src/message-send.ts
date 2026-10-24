import { decodeImage, splitImageMessage } from "./image-messages";
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

/** Stable logical image ID, fresh per-attempt part IDs: retries rebuild expired assemblies. */
export function createMessageTransmissions(message: {
  id: string; transportId?: string; senderSessionId: string; sentAt: number; plaintext: string;
}, keyEpoch: number): { envelope: EncryptedMessageEnvelope; plaintext: string }[] {
  if (!decodeImage(message.plaintext)) return [{ envelope: createTextEnvelope(message, keyEpoch), plaintext: message.plaintext }];
  return splitImageMessage(message.plaintext, message.id).map(plaintext => ({
    envelope: createTextEnvelope({ ...message, transportId: generateMessageId() }, keyEpoch), plaintext
  }));
}
