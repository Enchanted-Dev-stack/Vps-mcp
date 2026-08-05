import { describe, expect, it } from "vitest";
import {
  allowsWorkspaceMutation,
  createId,
  redactSecrets,
  selectHydration,
  type ChatMessage,
} from "./index.js";

describe("createId", () => {
  it("creates opaque prefixed identifiers", () => {
    expect(createId("ws")).toMatch(/^ws_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(createId("cht")).toMatch(/^cht_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("does not repeat ids in a practical sample", () => {
    const values = new Set(Array.from({ length: 2000 }, () => createId("evt")));
    expect(values.size).toBe(2000);
  });
});

describe("redactSecrets", () => {
  it("redacts bearer tokens, password assignments and common API keys", () => {
    const raw = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.super.secret",
      "password=hunter2-super-secret",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
      "normal=value",
    ].join("\n");
    const redacted = redactSecrets(raw);
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9.super.secret");
    expect(redacted).not.toContain("hunter2-super-secret");
    expect(redacted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toContain("normal=value");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts PEM private-key bodies", () => {
    const raw = "-----BEGIN PRIVATE KEY-----\nabc123\ndef456\n-----END PRIVATE KEY-----";
    expect(redactSecrets(raw)).toBe("-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----");
  });
});

describe("mode policy", () => {
  it("only permits intentional workspace mutation in build mode", () => {
    expect(allowsWorkspaceMutation("plan")).toBe(false);
    expect(allowsWorkspaceMutation("review")).toBe(false);
    expect(allowsWorkspaceMutation("build")).toBe(true);
  });
});

describe("selectHydration", () => {
  const message = (seq: number, estimatedTokens: number): ChatMessage => ({
    id: `msg_${seq}`,
    chatId: "cht_test",
    seq,
    role: seq % 2 ? "user" : "assistant",
    content: `message-${seq}`,
    estimatedTokens,
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  });

  it("keeps the entire verbatim chat while it comfortably fits", () => {
    const messages = [message(1, 100), message(2, 120), message(3, 150)];
    const result = selectHydration(messages, {
      maxContextTokens: 1000,
      reservedTokens: 300,
      compactionSummaryTokens: 120,
    });
    expect(result.mode).toBe("full");
    expect(result.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(result.compactedThroughSeq).toBeNull();
  });

  it("compacts only the oldest contiguous span once the verbatim thread exceeds budget", () => {
    const messages = Array.from({ length: 8 }, (_, index) => message(index + 1, 100));
    const result = selectHydration(messages, {
      maxContextTokens: 1000,
      reservedTokens: 300,
      compactionSummaryTokens: 100,
    });
    expect(result.mode).toBe("compacted");
    expect(result.compactedThroughSeq).toBe(2);
    expect(result.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("always keeps the newest message verbatim even if it alone is huge", () => {
    const messages = [message(1, 100), message(2, 5_000)];
    const result = selectHydration(messages, {
      maxContextTokens: 1000,
      reservedTokens: 300,
      compactionSummaryTokens: 100,
    });
    expect(result.mode).toBe("compacted");
    expect(result.messages.at(-1)?.seq).toBe(2);
  });
});
