/** Image metadata and original bytes live inside the encrypted text channel, never file_offer. */
export const IMAGE_PREFIX = 'elm-image:v1:';
export const IMAGE_CHUNK_PREFIX = 'elm-image-chunk:v1:';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CHUNK_CHARS = 48 * 1024;
const MAX_PAYLOAD_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 2048;
const MAX_CHUNKS = 160;
const INVALID_IMAGE = '图片数据无效，仅支持不超过 4 MiB 的 PNG、JPEG、GIF 或 WebP 图片';
export type ChatImage = { name: string; mimeType: string; data: string; width: number; height: number };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_IMAGE);
  return value as Record<string, unknown>;
}

function validate(value: unknown): ChatImage {
  const item = record(value);
  if (typeof item.name !== 'string' || item.name.length > 512 ||
      typeof item.mimeType !== 'string' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mimeType) ||
      typeof item.data !== 'string' || item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      (item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) ||
      !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height) ||
      (item.width as number) < 1 || (item.height as number) < 1 ||
      (item.width as number) * (item.height as number) > 32_000_000) throw new Error(INVALID_IMAGE);
  const image = { name: item.name, mimeType: item.mimeType, data: item.data, width: item.width as number, height: item.height as number };
  const bytes = imageBytes(image);
  if (bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES || detectImageType(bytes) !== image.mimeType) throw new Error(INVALID_IMAGE);
  const dimensions = imageDimensions(bytes);
  if (dimensions.width !== image.width || dimensions.height !== image.height) throw new Error(INVALID_IMAGE);
  return image;
}

export function detectImageType(bytes: Uint8Array): string | null {
  if ([137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const head = String.fromCharCode(...bytes.subarray(0, 12));
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'image/webp';
  return null;
}

/** Read dimensions before asking the browser to allocate decoded pixels. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  const type = detectImageType(bytes);
  if (type === 'image/png' && bytes.length >= 24 && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (type === 'image/gif') {
    width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (type === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += length;
    }
  } else if (type === 'image/webp') {
    const u24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      const length = view.getUint32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) break;
      if (tag === 'VP8X' && length >= 10) { width = 1 + u24(data + 4); height = 1 + u24(data + 7); break; }
      if (tag === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
        width = 1 + (bytes[data + 1] | (bytes[data + 2] & 0x3f) << 8);
        height = 1 + ((bytes[data + 2] >> 6) | bytes[data + 3] << 2 | (bytes[data + 4] & 0x0f) << 10); break;
      }
      if (tag === 'VP8 ' && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 1 && bytes[data + 5] === 0x2a) {
        width = view.getUint16(data + 6, true) & 0x3fff; height = view.getUint16(data + 8, true) & 0x3fff; break;
      }
      offset = data + length + (length % 2);
    }
  }
  if (width < 1 || height < 1 || width * height > 32_000_000) throw new Error(INVALID_IMAGE);
  return { width, height };
}

export function imageBytes(image: ChatImage): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(image.data), character => character.charCodeAt(0));
}

export function encodeImage(image: ChatImage): string { return IMAGE_PREFIX + JSON.stringify(validate(image)); }

/** Invalid reserved payloads fail closed, rather than becoming enormous text bubbles. */
export function decodeImage(plaintext: string): ChatImage | null {
  if (!plaintext.startsWith(IMAGE_PREFIX)) return null;
  if (plaintext.length > MAX_PAYLOAD_CHARS) throw new Error(INVALID_IMAGE);
  return validate(JSON.parse(plaintext.slice(IMAGE_PREFIX.length)));
}

export async function readChatImage(file: File): Promise<ChatImage> {
  if (file.size > MAX_IMAGE_BYTES || file.size === 0) throw new Error(INVALID_IMAGE);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = detectImageType(bytes);
  if (!mimeType) throw new Error(INVALID_IMAGE);
  const dimensions = imageDimensions(bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  let width: number, height: number;
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    if (element.naturalWidth * element.naturalHeight > 32_000_000) throw new Error(INVALID_IMAGE);
    // Browser natural dimensions may be EXIF-oriented; retain raw header dimensions
    // for byte validation while the browser displays the original orientation.
    width = dimensions.width; height = dimensions.height;
  } catch { throw new Error(INVALID_IMAGE); }
  finally { URL.revokeObjectURL(url); }
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return validate({ name: file.name, mimeType, data: btoa(parts.join('')), width, height });
}

export function splitImageMessage(plaintext: string, id: string, chunkChars = CHUNK_CHARS): string[] {
  if (!decodeImage(plaintext) || !/^[0-9a-f-]{36}$/i.test(id) || chunkChars < 1 || chunkChars > CHUNK_CHARS) throw new Error(INVALID_IMAGE);
  const total = Math.ceil(plaintext.length / chunkChars);
  if (total > MAX_CHUNKS) throw new Error(INVALID_IMAGE);
  return Array.from({ length: total }, (_, index) => IMAGE_CHUNK_PREFIX + JSON.stringify({ id, index, total, data: plaintext.slice(index * chunkChars, (index + 1) * chunkChars) }));
}

type Assembly = { chunks: Map<number, string>; total: number; chars: number; sentAt: number; updatedAt: number };
export type ImagePartResult = { type: 'text'; plaintext: string } | { type: 'pending' } | { type: 'image'; id: string; plaintext: string };

/** Bound incomplete work by bytes, count and lifetime; transport signature binds each part to its sender. */
export class ImageMessageAssembler {
  private pending = new Map<string, Assembly>();
  clear() { this.pending.clear(); }
  accept(plaintext: string, sender: string, sentAt: number, now = Date.now()): ImagePartResult {
    if (!plaintext.startsWith(IMAGE_CHUNK_PREFIX)) return { type: 'text', plaintext };
    for (const [key, assembly] of this.pending) if (now - assembly.updatedAt > 120_000) this.pending.delete(key);
    if (plaintext.length > CHUNK_CHARS + 1024) throw new Error(INVALID_IMAGE);
    const item = record(JSON.parse(plaintext.slice(IMAGE_CHUNK_PREFIX.length)));
    if (typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id) ||
        !Number.isInteger(item.total) || (item.total as number) < 1 || (item.total as number) > MAX_CHUNKS ||
        !Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= (item.total as number) ||
        typeof item.data !== 'string' || !item.data.length || item.data.length > CHUNK_CHARS) throw new Error(INVALID_IMAGE);
    const { id, data } = item as { id: string; data: string };
    const total = item.total as number, index = item.index as number;
    const key = JSON.stringify([sender, id]);
    let assembly = this.pending.get(key);
    if (!assembly) {
      if (this.pending.size >= 8) throw new Error('同时接收的图片过多，请稍后重试');
      assembly = { chunks: new Map(), total, chars: 0, sentAt, updatedAt: now };
      this.pending.set(key, assembly);
    }
    if (assembly.total !== total || assembly.sentAt !== sentAt) throw new Error(INVALID_IMAGE);
    const previous = assembly.chunks.get(index);
    if (previous !== undefined && previous !== data) throw new Error(INVALID_IMAGE);
    if (previous === undefined) { assembly.chunks.set(index, data); assembly.chars += data.length; }
    if (assembly.chars > MAX_PAYLOAD_CHARS) { this.pending.delete(key); throw new Error(INVALID_IMAGE); }
    assembly.updatedAt = now;
    if (assembly.chunks.size !== total) return { type: 'pending' };
    this.pending.delete(key);
    const full = Array.from({ length: total }, (_, i) => assembly!.chunks.get(i)!).join('');
    if (!decodeImage(full)) throw new Error(INVALID_IMAGE);
    return { type: 'image', id, plaintext: full };
  }
}
