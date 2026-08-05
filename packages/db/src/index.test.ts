import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  Database,
  migrate,
  resetForTests,
} from "./index.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for DB integration tests");

let admin: Pool;
let db: Database;

beforeAll(async () => {
  const parsed = new URL(url);
  const testDbName = parsed.pathname.slice(1);
  parsed.pathname = "/postgres";
  admin = new Pool({ connectionString: parsed.toString() });
  const exists = await admin.query("select 1 from pg_database where datname=$1", [testDbName]);
  if (!exists.rowCount) await admin.query(`create database "${testDbName.replaceAll('"', '""')}"`);
  db = new Database(url);
  await migrate(db.pool);
});

beforeEach(async () => {
  await resetForTests(db.pool);
});

afterAll(async () => {
  await db?.close();
  await admin?.end();
});

async function seedChat() {
  const workspace = await db.createWorkspace({ name: "Test", rootPath: "/tmp/test", defaultBranch: "main", instructions: "" });
  return db.createChat({ workspaceId: workspace.id, title: "Parallel chat", mode: "build" });
}

describe("database ordering", () => {
  it("assigns gap-free unique message sequence numbers under concurrency", async () => {
    const chat = await seedChat();
    await Promise.all(Array.from({ length: 50 }, (_, index) => db.appendMessage({
      chatId: chat.id,
      role: "user",
      source: "portal",
      content: `message ${index}`,
    })));
    const messages = await db.listMessages(chat.id);
    expect(messages).toHaveLength(50);
    expect(messages.map((message) => message.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it("assigns gap-free unique event sequence numbers under concurrency", async () => {
    const chat = await seedChat();
    const run = await db.createRun(chat.id);
    await Promise.all(Array.from({ length: 50 }, (_, index) => db.appendEvent({
      chatId: chat.id,
      runId: run.id,
      type: "activity",
      payload: { index },
    })));
    const events = await db.listEvents(chat.id, 0);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });
});

describe("binding tokens", () => {
  it("can be consumed exactly once", async () => {
    const chat = await seedChat();
    const binding = await db.issueBinding(chat.id, 60_000);
    const first = await db.consumeBinding(binding.token);
    const replay = await db.consumeBinding(binding.token);
    expect(first?.chatId).toBe(chat.id);
    expect(replay).toBeNull();
  });
});

describe("agent leases", () => {
  it("allows one agent per chat while allowing reclaim after release", async () => {
    const chat = await seedChat();
    expect(await db.claimLease(chat.id, "agent-a", 30_000)).toBe(true);
    expect(await db.claimLease(chat.id, "agent-b", 30_000)).toBe(false);
    expect(await db.claimLease(chat.id, "agent-a", 30_000)).toBe(true);
    await db.releaseLease(chat.id, "agent-a");
    expect(await db.claimLease(chat.id, "agent-b", 30_000)).toBe(true);
  });
});

describe("questions", () => {
  it("round-trips a structured portal answer", async () => {
    const chat = await seedChat();
    const run = await db.createRun(chat.id);
    const question = await db.createQuestion({
      chatId: chat.id,
      runId: run.id,
      kind: "single_choice",
      prompt: "Which implementation?",
      options: ["A", "B"],
      allowMultiple: false,
    });
    expect(question.status).toBe("open");
    const answered = await db.answerQuestion(question.id, ["B"]);
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toEqual(["B"]);
  });
});

describe("portal sessions", () => {
  it("resolves a hashed session token and rejects it after deletion", async () => {
    const user = await db.createPortalUser("admin", "argon-hash");
    const session = await db.createPortalSession(user.id, 60_000);
    const resolved = await db.resolvePortalSession(session.token);
    expect(resolved?.userId).toBe(user.id);
    expect(resolved?.username).toBe("admin");
    expect(resolved?.csrfHash).toMatch(/^[a-f0-9]{64}$/);
    await db.deletePortalSession(session.token);
    expect(await db.resolvePortalSession(session.token)).toBeNull();
  });
});

describe("thread state", () => {
  it("persists structured compaction state without deleting messages", async () => {
    const chat = await seedChat();
    await db.appendMessage({ chatId: chat.id, role: "user", source: "portal", content: "old message" });
    await db.updateThreadState(chat.id, {
      compactedThroughSeq: 1,
      summary: "Earlier work summarized",
      structured: { goal: "Ship portal", todos: ["tests"] },
    });
    const state = await db.getThreadState(chat.id);
    expect(state?.compactedThroughSeq).toBe(1);
    expect(state?.structured).toEqual({ goal: "Ship portal", todos: ["tests"] });
    expect(await db.listMessages(chat.id)).toHaveLength(1);
  });
});

describe("MCP persistence", () => {
  it("stores only hashed access tokens and validates expiry", async () => {
    await db.storeMcpAccessToken("access-secret", 60_000);
    expect(await db.isMcpAccessTokenValid("access-secret")).toBe(true);
    expect(await db.isMcpAccessTokenValid("wrong-secret")).toBe(false);
    const raw = await db.pool.query("select token_hash from mcp_access_tokens limit 1");
    expect(raw.rows[0].token_hash).not.toContain("access-secret");
  });

  it("atomically consumes a binding while claiming the chat lease", async () => {
    const chat = await seedChat();
    const a = await db.issueBinding(chat.id, 60_000);
    const first = await db.connectBinding(a.token, "agent-a", 30_000);
    expect(first?.chatId).toBe(chat.id);
    expect(await db.connectBinding(a.token, "agent-a", 30_000)).toBeNull();

    const b = await db.issueBinding(chat.id, 60_000);
    expect(await db.connectBinding(b.token, "agent-b", 30_000)).toBeNull();
    // Busy attempts do not burn the token.
    await db.releaseLease(chat.id, "agent-a");
    expect((await db.connectBinding(b.token, "agent-b", 30_000))?.chatId).toBe(chat.id);
  });
});

describe("attachments metadata", () => {
  it("links uploaded attachment metadata to a chat message", async () => {
    const chat = await seedChat();
    const attachment = await db.createAttachment({
      chatId: chat.id,
      originalName: "shot.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      sizeBytes: 123,
      storagePath: "/tmp/hash",
    });
    const message = await db.appendMessage({ chatId: chat.id, role: "user", source: "portal", content: "See screenshot" });
    await db.linkAttachments(chat.id, message.id, [attachment.id]);
    const listed = await db.listAttachments(chat.id);
    expect(listed).toHaveLength(1);
    expect(listed[0].messageId).toBe(message.id);
    expect((await db.getAttachment(attachment.id))?.originalName).toBe("shot.png");
  });
});

describe("history retrieval", () => {
  it("searches canonical older messages without changing stored history", async () => {
    const chat = await seedChat();
    await db.appendMessage({ chatId: chat.id, role: "user", source: "portal", content: "We chose iframe isolation for previews" });
    await db.appendMessage({ chatId: chat.id, role: "assistant", source: "agent", content: "Acknowledged" });
    await db.appendMessage({ chatId: chat.id, role: "user", source: "portal", content: "Now work on toolbar" });
    expect((await db.searchMessages(chat.id, "iframe", 10)).map(m => m.seq)).toEqual([1]);
    expect((await db.listMessagesRange(chat.id, 1, 2, 20)).map(m => m.seq)).toEqual([2]);
    expect(await db.listMessages(chat.id)).toHaveLength(3);
  });
});

describe("CRUD and audit", () => {
  it("updates and deletes workspaces/chats and persists audit entries", async () => {
    const ws = await db.createWorkspace({ name: "Before", rootPath: "/tmp/before" });
    const updatedWs = await db.updateWorkspace(ws.id, { name: "After", instructions: "rules" });
    expect(updatedWs?.name).toBe("After");
    const chat = await db.createChat({ workspaceId: ws.id, title: "Old", mode: "plan" });
    const updatedChat = await db.updateChat(chat.id, { title: "New", mode: "review" });
    expect(updatedChat?.title).toBe("New");
    expect(updatedChat?.mode).toBe("review");
    await db.appendAudit({ actorType: "user", actorId: "usr_test", action: "chat.update", targetType: "chat", targetId: chat.id, metadata: { mode: "review" } });
    const audit = await db.pool.query("select * from audit_log where target_id=$1", [chat.id]);
    expect(audit.rowCount).toBe(1);
    await db.deleteChat(chat.id);
    expect(await db.getChat(chat.id)).toBeNull();
    await db.deleteWorkspace(ws.id);
    expect(await db.getWorkspace(ws.id)).toBeNull();
  });
});

describe("migration startup concurrency", () => {
  it("serializes multiple processes bootstrapping a fresh database", async () => {
    const source = new URL(url);
    const name = `vps_mcp_migrate_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const quoted = `"${name.replaceAll('"', '""')}"`;
    await db.pool.query(`CREATE DATABASE ${quoted}`);
    const target = new URL(source); target.pathname = `/${name}`;
    const pools = Array.from({ length: 4 }, () => new Pool({ connectionString: target.toString(), max: 2 }));
    try {
      await Promise.all(pools.map((pool) => migrate(pool)));
      const check = await pools[0].query("select to_regclass('public.users') as users, to_regclass('public.chats') as chats");
      expect(check.rows[0]).toMatchObject({ users: "users", chats: "chats" });
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await db.pool.query(`DROP DATABASE ${quoted}`);
    }
  });
});
