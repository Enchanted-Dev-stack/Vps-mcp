import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import { Database, migrate, resetForTests } from "@vps-mcp/db";
import { createApi } from "./app.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
let db: Database;

beforeAll(async () => {
  db = new Database(url);
  await migrate(db.pool);
});
beforeEach(async () => {
  await resetForTests(db.pool);
  await db.createPortalUser("admin", await hash("correct horse battery staple"));
});
afterAll(async () => db.close());

async function login(app: ReturnType<typeof createApi>) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  const cookies = response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return { cookies, csrf: body.csrfToken as string };
}

describe("portal API", () => {
  it("requires auth, CSRF, then supports workspace/chat/message/binding flow", async () => {
    const app = createApi({ db, secureCookies: false });
    expect((await app.inject({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(401);
    const auth = await login(app);
    expect((await app.inject({ method: "POST", url: "/api/workspaces", headers: { cookie: auth.cookies }, payload: { name: "No CSRF", rootPath: "/tmp/nope" } })).statusCode).toBe(403);
    const wsRes = await app.inject({ method: "POST", url: "/api/workspaces", headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf }, payload: { name: "Portal", rootPath: "/opt/vps-mcp", defaultBranch: "main", instructions: "Use tests" } });
    expect(wsRes.statusCode).toBe(201);
    const ws = wsRes.json();
    const chatRes = await app.inject({ method: "POST", url: `/api/workspaces/${ws.id}/chats`, headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf }, payload: { title: "Build UI", mode: "plan" } });
    expect(chatRes.statusCode).toBe(201);
    const chat = chatRes.json();
    const msgRes = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/messages`, headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf }, payload: { content: "Please inspect first" } });
    expect(msgRes.statusCode).toBe(201);
    const bindingRes = await app.inject({ method: "POST", url: `/api/chats/${chat.id}/bindings`, headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf } });
    expect(bindingRes.statusCode).toBe(201);
    expect(bindingRes.json().token).toMatch(/^bind_/);
    const detail = await app.inject({ method: "GET", url: `/api/chats/${chat.id}`, headers: { cookie: auth.cookies } });
    expect(detail.json().messages).toHaveLength(1);
    await app.close();
  });

  it("answers a structured question and emits a durable event", async () => {
    const ws = await db.createWorkspace({ name: "W", rootPath: "/tmp/w" });
    const chat = await db.createChat({ workspaceId: ws.id, title: "Plan", mode: "plan" });
    const run = await db.createRun(chat.id);
    const question = await db.createQuestion({ chatId: chat.id, runId: run.id, kind: "single_choice", prompt: "Use A or B?", options: ["A", "B"] });
    const app = createApi({ db, secureCookies: false });
    const auth = await login(app);
    const answer = await app.inject({ method: "POST", url: `/api/questions/${question.id}/answer`, headers: { cookie: auth.cookies, "x-csrf-token": auth.csrf }, payload: { answer: ["B"] } });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().answer).toEqual(["B"]);
    const events = await db.listEvents(chat.id);
    expect(events.at(-1)?.type).toBe("question.answered");
    await app.close();
  });
});

describe("SSE replay", () => {
  it("replays only events after the requested cursor", async () => {
    const ws = await db.createWorkspace({ name: "SSE", rootPath: "/tmp/sse" });
    const chat = await db.createChat({ workspaceId: ws.id, title: "Stream", mode: "plan" });
    const first = await db.appendEvent({ chatId: chat.id, type: "activity", payload: { message: "one" } });
    const app = createApi({ db, secureCookies: false });
    const auth = await login(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("bad listen address");
    const port = address.port;

    async function readOne(after: number) {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/chats/${chat.id}/events/stream?after=${after}`, {
        headers: { cookie: auth.cookies }, signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!text.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
          if (text.includes("id:")) break;
        }
      } finally {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      }
      return text;
    }

    const replay = await readOne(0);
    expect(replay).toContain(`id: ${first.seq}`);
    const second = await db.appendEvent({ chatId: chat.id, type: "activity", payload: { message: "two" } });
    const resumed = await readOne(first.seq);
    expect(resumed).toContain(`id: ${second.seq}`);
    expect(resumed).not.toContain(`id: ${first.seq}\n`);
    await app.close();
  });
});
