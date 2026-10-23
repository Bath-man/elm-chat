import { describe, expect, it } from "vitest";
import { decryptHistory, encryptHistory } from "../apps/web/src/history-archive";
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
});
