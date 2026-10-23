import { describe, expect, it } from "vitest";
import { encryptedChatIssue } from "../apps/web/src/browser-support";

describe("encrypted chat browser requirements", () => {
  const cryptoApi = { getRandomValues: () => undefined, subtle: {} };
  it("allows secure Web Crypto without requiring randomUUID", () => {
    expect(encryptedChatIssue(true, cryptoApi)).toBeNull();
  });
  it("explains the HTTPS requirement for phone LAN HTTP access", () => {
    expect(encryptedChatIssue(false, cryptoApi)).toContain("HTTPS");
  });
  it("does not start encrypted chat without Web Crypto or secure randomness", () => {
    expect(encryptedChatIssue(true, undefined)).not.toBeNull();
    expect(encryptedChatIssue(true, { getRandomValues: () => undefined })).not.toBeNull();
    expect(encryptedChatIssue(true, { subtle: {} })).not.toBeNull();
  });
});
