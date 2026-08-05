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

async function login(app: Awaited<ReturnType<typeof createApi>>) {
  const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  const cookies = response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return { cookies, csrf: body.csrfToken as string };
}

describe("portal API", () => {
  it("requires auth, CSRF, then supports workspace/chat/message/binding flow", async () => {
    const app = await createApi({ db, secureCookies: false });
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
    const app = await createApi({ db, secureCookies: false });
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
    const app = await createApi({ db, secureCookies: false });
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

describe("workspace/chat CRUD", () => {
  it("updates and deletes workspace/chat resources and records audit entries", async () => {
    const app = await createApi({ db, secureCookies: false });
    const auth = await login(app);
    const headers = { cookie: auth.cookies, "x-csrf-token": auth.csrf };
    const ws = (await app.inject({ method: "POST", url: "/api/workspaces", headers, payload: { name: "CRUD", rootPath: "/tmp/crud" } })).json();
    const updatedWs = await app.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}`, headers, payload: { name: "CRUD 2", instructions: "new rules" } });
    expect(updatedWs.statusCode).toBe(200);
    expect(updatedWs.json().name).toBe("CRUD 2");

    const chat = (await app.inject({ method: "POST", url: `/api/workspaces/${ws.id}/chats`, headers, payload: { title: "Old", mode: "plan" } })).json();
    const updatedChat = await app.inject({ method: "PATCH", url: `/api/chats/${chat.id}`, headers, payload: { title: "New", mode: "review", status: "archived" } });
    expect(updatedChat.statusCode).toBe(200);
    expect(updatedChat.json()).toMatchObject({ title: "New", mode: "review", status: "archived" });
    expect((await app.inject({ method: "DELETE", url: `/api/chats/${chat.id}`, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/api/workspaces/${ws.id}`, headers })).statusCode).toBe(204);
    const audit = await db.pool.query("select action from audit_log order by created_at asc");
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(["workspace.create", "workspace.update", "chat.create", "chat.update", "chat.delete", "workspace.delete"]));
    await app.close();
  });
});

describe("login rate limiting", () => {
  it("returns 429 after repeated failed login attempts from one client", async () => {
    const app = await createApi({ db, secureCookies: false });
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "203.0.113.77", payload: { username: "admin", password: "wrong" } });
      lastStatus = response.statusCode;
    }
    expect(lastStatus).toBe(429);
    await app.close();
  });
});

describe("repository browser", () => {
  it("lists only allowed VPS directories and marks Git repositories", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const root = await mkdtemp(join(tmpdir(), "vps-mcp-picker-"));
    const repo = join(root, "project-repo");
    const folder = join(root, "ordinary-folder");
    await mkdir(repo); await mkdir(folder);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    await writeFile(join(repo, "README.md"), "picker test\n");
    try {
      const app = await createApi({ db, secureCookies: false, repositoryBrowseRoots: [root] });
      expect((await app.inject({ method: "GET", url: "/api/repositories/browse" })).statusCode).toBe(401);
      const auth = await login(app);
      const headers = { cookie: auth.cookies };
      const roots = await app.inject({ method: "GET", url: "/api/repositories/browse", headers });
      expect(roots.statusCode).toBe(200);
      expect(roots.json().roots[0].path).toBe(root);
      const listing = await app.inject({ method: "GET", url: `/api/repositories/browse?path=${encodeURIComponent(root)}`, headers });
      expect(listing.statusCode).toBe(200);
      expect(listing.json().entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "project-repo", isGitRepository: true }),
        expect.objectContaining({ name: "ordinary-folder", isGitRepository: false }),
      ]));
      const blocked = await app.inject({ method: "GET", url: "/api/repositories/browse?path=/etc", headers });
      expect(blocked.statusCode).toBe(403);
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
