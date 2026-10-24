import { describe, expect, it } from "vitest";
import { decryptHistory, encryptHistory, validateExportPasswords } from "../apps/web/src/history-archive";
import type { HistoryMessage } from "../apps/web/src/history";

const messages: HistoryMessage[] = [{
  id: "one", senderSessionId: "sender", sentAt: 123, kind: "text", plaintext: "你好 🌱",
  transportId: "transport", expiresAt: 456, delivery: "pending"
}];

describe("encrypted chat archive", () => {
  it("round-trips original message data without delivery state, using fresh salt and IV", async () => {
    const first = await encryptHistory(messages, "密码123");
    const second = await encryptHistory(messages, "密码123");
    const { delivery: _, ...message } = messages[0]!;
    expect(await decryptHistory(first, "密码123")).toEqual([message]);
    expect(first).not.toContain("你好");
    expect(JSON.parse(first).salt).not.toBe(JSON.parse(second).salt);
    expect(JSON.parse(first).iv).not.toBe(JSON.parse(second).iv);
  });

  it("rejects incorrect passwords, corrupted files and unsupported parameters", async () => {
    const content = await encryptHistory(messages, "correct");
    await expect(decryptHistory(content, "wrong")).rejects.toThrow("密码错误或记录文件已损坏");
    await expect(decryptHistory("not json", "correct")).rejects.toThrow("密码错误或记录文件已损坏");
    const data = JSON.parse(content);
    await expect(decryptHistory(JSON.stringify({ ...data, iterations: 1 }), "correct")).rejects.toThrow();
    await expect(decryptHistory(JSON.stringify({ ...data, ciphertext: "AAAA" }), "correct")).rejects.toThrow();
  });

  it("rejects invalid message fields and an empty export password", async () => {
    await expect(encryptHistory([{ ...messages[0]!, sentAt: NaN }], "password")).rejects.toThrow();
    await expect(encryptHistory([{ ...messages[0]!, sentAt: 1e20 }], "password")).rejects.toThrow();
    await expect(encryptHistory(messages, "")).rejects.toThrow();
  });

  it("round-trips image-sized archives without overflowing base64 validation", async () => {
    const message = { ...messages[0]!, plaintext: "a".repeat(4 * 1024 * 1024) };
    const archive = await encryptHistory([message], "password");
    expect((await decryptHistory(archive, "password"))[0]!.plaintext).toBe(message.plaintext);
  });

  it("rejects invalid reserved image data instead of importing it as text", async () => {
    const invalidMessages = [{ ...messages[0]!, plaintext: 'elm-image:v1:{"data":"invalid"}' }];
    await expect(encryptHistory(invalidMessages, "password")).rejects.toThrow();
    // Simulate an older exporter that encrypted invalid reserved image data.
    const archive = JSON.parse(await encryptHistory(messages, "password"));
    const salt = Uint8Array.from(atob(archive.salt), character => character.charCodeAt(0));
    const iv = Uint8Array.from(atob(archive.iv), character => character.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode("password"), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: archive.iterations },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
    );
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(invalidMessages)));
    archive.ciphertext = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
    await expect(decryptHistory(JSON.stringify(archive), "password")).rejects.toThrow("密码错误或记录文件已损坏");
  });
});


describe("archive identity and likes", () => {
  it("captures exporter-relative ownership and deduplicated live likes", async () => {
    const like = { id: "like", senderSessionId: "peer", sentAt: 124, kind: "text" as const,
      plaintext: 'elm-interaction:v1:{"type":"message.like","id":"like-event","replyTo":"one"}' };
    const archive = await encryptHistory([...messages, like, { ...like, id: "duplicate" }], "password", "sender");
    const restored = await decryptHistory(archive, "password");
    expect(restored[0]).toMatchObject({ mine: true, likes: 1 });
    expect(restored[1]).toMatchObject({ mine: false, likes: 0 });
    expect(restored[0]).not.toHaveProperty("delivery");
  });

  it("preserves imported snapshots on repeated export without replaying imported likes", async () => {
    const imported = { ...messages[0]!, imported: true, mine: false, likes: 3 };
    const like = { id: "old-like", senderSessionId: "peer", sentAt: 124, kind: "text" as const, imported: true,
      plaintext: 'elm-interaction:v1:{"type":"message.like","id":"like-event","replyTo":"one"}' };
    const archive = await encryptHistory([imported, like], "password", "sender");
    const restored = await decryptHistory(archive, "password");
    expect(restored[0]).toMatchObject({ mine: false, likes: 3 });
    expect(await decryptHistory(await encryptHistory(restored, "password", "another-session"), "password"))
      .toEqual(restored);
  });

  it("encrypts opaque image payloads without losing their bytes", async () => {
    const image = { ...messages[0]!, plaintext: 'elm-image:v1:{"name":"pixel.png","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=","width":1,"height":1}' };
    const archive = await encryptHistory([image], "password", "sender");
    expect(archive).not.toContain("aGVsbG8=");
    expect((await decryptHistory(archive, "password"))[0]!.plaintext).toBe(image.plaintext);
  });

  it("does not apply imported like events to a live message sharing the same ID", async () => {
    const importedLike: HistoryMessage = { id: "old-like", senderSessionId: "peer", sentAt: 124, kind: "text", imported: true,
      plaintext: 'elm-interaction:v1:{"type":"message.like","id":"old-event","replyTo":"one"}' };
    const archive = await encryptHistory([...messages, importedLike], "password", "sender");
    expect((await decryptHistory(archive, "password"))[0]).toMatchObject({ mine: true, likes: 0 });
  });

  it.each([{ mine: "yes" }, { likes: -1 }, { likes: 0.5 }, { likes: Infinity }, { likes: Number.MAX_SAFE_INTEGER + 1 }])(
    "rejects malformed snapshot metadata %j", async (metadata) => {
      await expect(encryptHistory([{ ...messages[0]!, ...metadata } as HistoryMessage], "password")).rejects.toThrow();
    }
  );
});

describe("export password confirmation", () => {
  it("accepts matching nonempty passwords without trimming", () => {
    expect(() => validateExportPasswords(" password ", " password ")).not.toThrow();
  });
  it("rejects empty passwords and mismatches", () => {
    expect(() => validateExportPasswords("", "")).toThrow("请设置导出密码");
    expect(() => validateExportPasswords("password", "password ")).toThrow("两次输入的密码不一致");
  });
});
