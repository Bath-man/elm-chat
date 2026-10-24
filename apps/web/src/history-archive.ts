import type { HistoryMessage } from "./history";
import { deriveInteractionState } from "./interactions";
import { decodeImage } from "./image-messages";

const ITERATIONS = 210_000;
const INVALID_ARCHIVE = "密码错误或记录文件已损坏";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID_ARCHIVE);
  return value as Record<string, unknown>;
}

/** Pick only local message fields: imported data must never restore outbound delivery state. */
function messagesFrom(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) throw new Error(INVALID_ARCHIVE);
  return value.map((item) => {
    const message = object(item);
    if (typeof message.id !== "string" || !message.id ||
      typeof message.senderSessionId !== "string" || !message.senderSessionId ||
      typeof message.sentAt !== "number" || !Number.isFinite(message.sentAt) || message.sentAt < 0 || message.sentAt > 8.64e15 ||
      message.kind !== "text" || typeof message.plaintext !== "string" ||
      (message.transportId !== undefined && typeof message.transportId !== "string") ||
      (message.expiresAt !== undefined && (typeof message.expiresAt !== "number" || !Number.isFinite(message.expiresAt))) ||
      (message.imported !== undefined && typeof message.imported !== "boolean") ||
      (message.mine !== undefined && typeof message.mine !== "boolean") ||
      (message.likes !== undefined && (typeof message.likes !== "number" || !Number.isSafeInteger(message.likes) || message.likes < 0))) {
      throw new Error(INVALID_ARCHIVE);
    }
    // Reserved image payloads must satisfy the same validation as live messages.
    decodeImage(message.plaintext);
    return {
      id: message.id,
      senderSessionId: message.senderSessionId,
      sentAt: message.sentAt,
      kind: "text",
      plaintext: message.plaintext,
      ...(message.transportId === undefined ? {} : { transportId: message.transportId }),
      ...(message.expiresAt === undefined ? {} : { expiresAt: message.expiresAt }),
      ...(message.imported === undefined ? {} : { imported: message.imported }),
      ...(message.mine === undefined ? {} : { mine: message.mine }),
      ...(message.likes === undefined ? {} : { likes: message.likes })
    };
  });
}

function encode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}

function decode(value: unknown): Uint8Array<ArrayBuffer> {
  // Repeated groups overflow V8's regexp stack for multi-MiB image archives.
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(INVALID_ARCHIVE);
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function keyFrom(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

export function validateExportPasswords(password: string, confirmation: string): void {
  if (!password) throw new Error("请设置导出密码");
  if (password !== confirmation) throw new Error("两次输入的密码不一致");
}

export async function encryptHistory(messages: readonly HistoryMessage[], password: string, exporterSessionId?: string): Promise<string> {
  if (!password) throw new Error("请设置导出密码");
  const validated = messagesFrom(messages);
  const likes = exporterSessionId === undefined ? undefined
    : deriveInteractionState(validated.filter(message => !message.imported)).likes;
  const snapshot = exporterSessionId === undefined ? validated : validated.map(message => ({
    ...message,
    mine: message.imported && message.mine !== undefined ? message.mine : message.senderSessionId === exporterSessionId,
    likes: message.imported ? (message.likes ?? 0) : (likes!.get(message.id) ?? 0)
  }));
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return JSON.stringify({
    format: "achat", version: 1, algorithm: "AES-GCM", keyLength: 256,
    kdf: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS,
    salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext))
  });
}

export async function decryptHistory(content: string, password: string): Promise<HistoryMessage[]> {
  try {
    const archive = object(JSON.parse(content));
    if (!password || archive.format !== "achat" || archive.version !== 1 ||
      archive.algorithm !== "AES-GCM" || archive.keyLength !== 256 ||
      archive.kdf !== "PBKDF2" || archive.hash !== "SHA-256" || archive.iterations !== ITERATIONS) {
      throw new Error(INVALID_ARCHIVE);
    }
    const salt = decode(archive.salt);
    const iv = decode(archive.iv);
    const ciphertext = decode(archive.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) throw new Error(INVALID_ARCHIVE);
    const key = await keyFrom(password, salt);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return messagesFrom(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
  } catch {
    throw new Error(INVALID_ARCHIVE);
  }
}
