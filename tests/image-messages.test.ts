import { describe, expect, it } from 'vitest';
import { deriveRoomKey, encryptMessage, decryptMessage, generateRoomSecret } from '@elm-chat/crypto';
import { encryptHistory, decryptHistory } from '../apps/web/src/history-archive';
import { encodeImage, decodeImage, imageBytes, splitImageMessage, ImageMessageAssembler, IMAGE_CHUNK_PREFIX, MAX_IMAGE_BYTES } from '../apps/web/src/image-messages';

// A real 1×1 PNG. Validation must not allow SVG or remote resource URLs.
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
const image = { name: 'private.png', mimeType: 'image/png', data, width: 1, height: 1 };
const id = '11111111-1111-4111-8111-111111111111';

describe('encrypted image messages', () => {
  it('round-trips original image bytes and rejects unsafe or malformed media', () => {
    expect(decodeImage(encodeImage(image))).toEqual(image);
    expect(imageBytes(image)).toEqual(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    expect(decodeImage('ordinary text')).toBeNull();
    for (const patch of [{ mimeType: 'image/svg+xml' }, { data: 'https://tracker.example/image' }, { data: 'AAAA' }, { width: 0 }, { height: 1e9 }, { name: 'x'.repeat(513) }]) {
      expect(() => encodeImage({ ...image, ...patch })).toThrow();
    }
    expect(() => encodeImage({ ...image, data: data + 'A'.repeat(MAX_IMAGE_BYTES * 2) })).toThrow();
  });

  it('checks intrinsic pixel dimensions instead of trusting claimed image metadata', () => {
    expect(() => encodeImage({ ...image, width: 2 })).toThrow();
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(16, 100000);
    new DataView(bytes.buffer).setUint32(20, 100000);
    const spoofed = btoa(String.fromCharCode(...bytes));
    expect(() => encodeImage({ ...image, data: spoofed })).toThrow();
  });

  it('assembles out-of-order chunks once, tolerates identical retry parts and separates senders', () => {
    const text = encodeImage(image);
    const chunks = splitImageMessage(text, id, 40);
    expect(chunks.length).toBeGreaterThan(1);
    const assembler = new ImageMessageAssembler();
    expect(assembler.accept('hello', 'sender', 123)).toEqual({ type: 'text', plaintext: 'hello' });
    expect(assembler.accept(chunks[1]!, 'sender', 123).type).toBe('pending');
    expect(assembler.accept(chunks[1]!, 'sender', 123).type).toBe('pending');
    expect(assembler.accept(chunks[0]!, 'other', 123).type).toBe('pending');
    let result;
    for (const chunk of [chunks[0]!, ...chunks.slice(2)]) result = assembler.accept(chunk, 'sender', 123);
    expect(result).toEqual({ type: 'image', id, plaintext: text });
    expect(assembler.accept(chunks[0]!, 'sender', 123).type).toBe('pending');
  });

  it('rejects chunk bounds, inconsistent metadata, conflicting duplicates and malformed final images', () => {
    const chunks = splitImageMessage(encodeImage(image), id, 100);
    const assembler = new ImageMessageAssembler();
    assembler.accept(chunks[0]!, 'sender', 123);
    const part = JSON.parse(chunks[0]!.slice(IMAGE_CHUNK_PREFIX.length));
    const changed = (patch: object) => IMAGE_CHUNK_PREFIX + JSON.stringify({ ...part, ...patch });
    for (const patch of [{ index: -1 }, { total: 100000 }, { data: 'A'.repeat(65537) }, { id: '../bad' }]) {
      expect(() => assembler.accept(changed(patch), 'sender', 123)).toThrow();
    }
    expect(() => assembler.accept(changed({ data: 'different' }), 'sender', 123)).toThrow();
    expect(() => new ImageMessageAssembler().accept(IMAGE_CHUNK_PREFIX + JSON.stringify({ id, index: 0, total: 1, data: 'not image' }), 'sender', 123)).toThrow();
  });

  it('encrypts every wire chunk, authenticates tampering and encrypts image data in backups', async () => {
    const key = await deriveRoomKey(generateRoomSecret());
    const text = encodeImage(image);
    const assembler = new ImageMessageAssembler();
    let result;
    for (const [i, chunk] of splitImageMessage(text, id, 100).entries()) {
      const context = { protocolVersion: 3 as const, messageId: crypto.randomUUID(), senderSessionId: '22222222-2222-4222-8222-222222222222', sentAt: 123, expiresAfterReadSeconds: null, keyEpoch: 1 };
      const envelope = { ...context, ...await encryptMessage(key, 'room', context, chunk) };
      expect(JSON.stringify(envelope)).not.toContain('private.png');
      expect(JSON.stringify(envelope)).not.toContain('image/png');
      result = assembler.accept(await decryptMessage(key, 'room', envelope), 'sender', 123);
      if (i === 0) await expect(decryptMessage(key, 'different-room', envelope)).rejects.toThrow();
    }
    expect(result).toEqual({ type: 'image', id, plaintext: text });
    const messages = [{ id, senderSessionId: '22222222-2222-4222-8222-222222222222', sentAt: 123, kind: 'text' as const, plaintext: text }];
    const archive = await encryptHistory(messages, 'password');
    expect(archive).not.toContain(data);
    expect((await decryptHistory(archive, 'password'))[0]?.plaintext).toBe(text);
  });
});

describe('image retransmission transport identities', () => {
  it('uses fresh IDs for every part on retry while text transport IDs stay stable', async () => {
    const { createMessageTransmissions } = await import('../apps/web/src/message-send');
    const message = { id, senderSessionId: '22222222-2222-4222-8222-222222222222', sentAt: 123, plaintext: encodeImage(image) };
    const first = createMessageTransmissions(message, 1);
    const second = createMessageTransmissions(message, 1);
    expect(first[0]!.envelope.messageId).not.toBe(second[0]!.envelope.messageId);
    const old = new Set(first.map(part => part.envelope.messageId));
    expect(second.every(part => !old.has(part.envelope.messageId))).toBe(true);
    const text = { ...message, plaintext: 'ordinary text' };
    expect(createMessageTransmissions(text, 1)[0]!.envelope.messageId).toBe(createMessageTransmissions(text, 1)[0]!.envelope.messageId);
  });
  it('reconstructs an image from retried parts after the incomplete assembly expired', () => {
    const text = encodeImage(image), assembler = new ImageMessageAssembler();
    const parts = splitImageMessage(text, id, 100);
    assembler.accept(parts[0]!, 'sender', 123, 0);
    // The first retry part must not be omitted by transport replay protection.
    let result;
    for (const part of parts) result = assembler.accept(part, 'sender', 123, 121000);
    expect(result).toEqual({ type: 'image', id, plaintext: text });
  });
});
