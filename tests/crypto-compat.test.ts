import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMessageId, generateSessionId } from "../packages/crypto/src/index";

const nativeCrypto = globalThis.crypto;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
afterEach(() => vi.unstubAllGlobals());

describe("mobile UUID compatibility", () => {
  it("generates secure UUIDs when randomUUID is absent", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => nativeCrypto.getRandomValues(bytes));
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = Array.from({ length: 100 }, (_, index) => index % 2 ? generateMessageId() : generateSessionId());
    for (const id of ids) expect(id).toMatch(uuidV4);
    expect(new Set(ids).size).toBe(100);
    expect(getRandomValues).toHaveBeenCalledTimes(100);
  });
  it("keeps using the native implementation when available", () => {
    const randomUUID = vi.fn(() => "12345678-1234-4234-8234-123456789abc");
    vi.stubGlobal("crypto", { randomUUID });
    expect(generateSessionId()).toBe("12345678-1234-4234-8234-123456789abc");
    expect(generateMessageId()).toBe("12345678-1234-4234-8234-123456789abc");
    expect(randomUUID).toHaveBeenCalledTimes(2);
  });
  it("fails closed when secure randomness is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(() => generateSessionId()).toThrow();
  });
});
