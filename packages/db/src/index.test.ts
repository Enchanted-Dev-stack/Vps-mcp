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
