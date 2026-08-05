import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database, migrate, resetForTests } from "@vps-mcp/db";
import { WorkspaceManager } from "@vps-mcp/workspace";
import { ChatAgentService, createAgentSession, isPlanSafeCommand } from "./chat-service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL required");
let db: Database;
let root: string;
let repo: string;
let service: ChatAgentService;

function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

beforeAll(async () => {
  db = new Database(url);
  await migrate(db.pool);
  root = await mkdtemp(join(tmpdir(), "vpsmcp-agent-"));
  repo = join(root, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "README.md"), "hello\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "init");
  service = new ChatAgentService(db, new WorkspaceManager(join(root, "worktrees")));
});
beforeEach(async () => resetForTests(db.pool));
afterAll(async () => db.close());

async function seed(mode: "plan" | "build" = "build") {
  const ws = await db.createWorkspace({ name: "Repo", rootPath: repo, defaultBranch: "main", instructions: "Keep tests green" });
  const chat = await db.createChat({ workspaceId: ws.id, title: "Task", mode });
  await db.appendMessage({ chatId: chat.id, role: "user", source: "portal", content: "First task" });
  const binding = await db.issueBinding(chat.id, 60_000);
  return { ws, chat, binding };
}

describe("plan command policy", () => {
  it("allows inspection and blocks mutation", () => {
    expect(isPlanSafeCommand("git status --short && rg TODO .")).toBe(true);
    expect(isPlanSafeCommand("cat README.md | head -20")).toBe(true);
    expect(isPlanSafeCommand("touch nope.txt")).toBe(false);
    expect(isPlanSafeCommand("echo x > nope.txt")).toBe(false);
    expect(isPlanSafeCommand("git checkout -b nope")).toBe(false);
    expect(isPlanSafeCommand("git branch new-branch")).toBe(false);
    expect(isPlanSafeCommand("find . -delete")).toBe(false);
    expect(isPlanSafeCommand("awk 'BEGIN{system(\"touch nope\")}'")).toBe(false);
    expect(isPlanSafeCommand("env touch nope")).toBe(false);
    expect(isPlanSafeCommand("rg --pre 'touch nope' needle .")).toBe(false);
    expect(isPlanSafeCommand("git diff --output=/tmp/nope")).toBe(false);
  });
});

describe("ChatAgentService", () => {
  it("hydrates full chat, syncs deltas, executes, asks, and mirrors completion", async () => {
    const seeded = await seed("build");
    const session = createAgentSession();
    const connected = await service.connect(session, seeded.binding.token);
    expect(connected.context.mode).toBe("full");
    expect(connected.context.messages.map((m) => m.content)).toEqual(["First task"]);
    expect(connected.chat.worktreePath).toContain(session.chatId!);

    await db.appendMessage({ chatId: seeded.chat.id, role: "user", source: "portal", content: "Second task" });
    const sync = await service.sync(session);
    expect(sync.messages.map((m) => m.content)).toEqual(["Second task"]);

    await service.activity(session, "inspection", "Checking repository");
    const terminal = await service.terminal(session, "printf 'hello-world'");
    expect(terminal.stdout).toBe("hello-world");
    expect(terminal.exitCode).toBe(0);

    const question = await service.ask(session, { kind: "single_choice", prompt: "Choose", options: ["A", "B"] });
    expect(question.status).toBe("open");
    expect((await db.listOpenQuestions(seeded.chat.id))).toHaveLength(1);

    const completion = await service.complete(session, { answer: "Done", summary: "Implemented task", structured: { goal: "Task", completed: ["work"] } });
    expect(completion.message.content).toBe("Done");
    const messages = await db.listMessages(seeded.chat.id);
    expect(messages.at(-1)?.role).toBe("assistant");
    expect((await db.listEvents(seeded.chat.id)).some((event) => event.type === "run.completed")).toBe(true);
  });

  it("enforces plan-mode non-mutation policy", async () => {
    const seeded = await seed("plan");
    const session = createAgentSession();
    await service.connect(session, seeded.binding.token);
    expect((await service.terminal(session, "git status --short")).exitCode).toBe(0);
    await expect(service.terminal(session, "touch forbidden.txt")).rejects.toThrow(/Plan mode/);
  });
});

describe("context checkpoint hydration", () => {
  it("ignores stored summary while full thread fits and uses it only under pressure", async () => {
    const ws = await db.createWorkspace({ name: "Context", rootPath: repo, defaultBranch: "main" });
    const chat = await db.createChat({ workspaceId: ws.id, title: "Context", mode: "plan" });
    for (let i = 1; i <= 5; i++) {
      await db.appendMessage({ chatId: chat.id, role: i % 2 ? "user" : "assistant", source: i % 2 ? "portal" : "agent", content: `message-${i} ` + "x".repeat(80) });
    }
    await db.updateThreadState(chat.id, { compactedThroughSeq: 3, summary: "SUMMARY THROUGH THREE", structured: { goal: "keep detail" } });

    const roomy = new ChatAgentService(db, new WorkspaceManager(join(root, "roomy")), { maxContextTokens: 10_000, reservedTokens: 100, compactionSummaryTokens: 50 });
    const roomyBinding = await db.issueBinding(chat.id, 60_000);
    const roomySession = createAgentSession();
    const full = await roomy.connect(roomySession, roomyBinding.token);
    expect(full.context.mode).toBe("full");
    expect(full.context.summary).toBe("");
    expect(full.context.messages).toHaveLength(5);
    await roomy.disconnect(roomySession);

    const tight = new ChatAgentService(db, new WorkspaceManager(join(root, "tight")), { maxContextTokens: 180, reservedTokens: 40, compactionSummaryTokens: 35 });
    const tightBinding = await db.issueBinding(chat.id, 60_000);
    const tightSession = createAgentSession();
    const compacted = await tight.connect(tightSession, tightBinding.token);
    expect(compacted.context.mode).toBe("compacted");
    expect(compacted.context.summary).toBe("SUMMARY THROUGH THREE");
    expect(compacted.context.messages.map(m => m.seq)).toEqual([4, 5]);
    await tight.disconnect(tightSession);
  });
});

describe("large canonical history", () => {
  it("reconnects to a 500-message chat with bounded hydration while old raw history stays searchable", async () => {
    const ws = await db.createWorkspace({ name: "Long", rootPath: repo, defaultBranch: "main" });
    const chat = await db.createChat({ workspaceId: ws.id, title: "Long thread", mode: "plan" });
    for (let i = 1; i <= 500; i++) {
      await db.appendMessage({
        chatId: chat.id,
        role: i % 2 ? "user" : "assistant",
        source: i % 2 ? "portal" : "agent",
        content: `canonical-message-${i} ` + "detail ".repeat(18),
      });
    }
    await db.updateThreadState(chat.id, {
      compactedThroughSeq: 480,
      summary: "Messages 1-480: long-running implementation decisions and completed work.",
      structured: { goal: "Long project", completedThrough: 480 },
    });

    const bounded = new ChatAgentService(db, new WorkspaceManager(join(root, "long-history")), {
      maxContextTokens: 2200,
      reservedTokens: 600,
      compactionSummaryTokens: 250,
    });
    const binding = await db.issueBinding(chat.id, 60_000);
    const session = createAgentSession();
    const connected = await bounded.connect(session, binding.token);
    expect(connected.context.mode).toBe("compacted");
    expect(connected.context.compactedThroughSeq).toBe(480);
    expect(connected.context.messages.map((m) => m.seq)).toEqual(Array.from({ length: 20 }, (_, index) => 481 + index));
    expect(connected.context.estimatedTokens).toBeLessThanOrEqual(connected.context.availableTokens);
    expect((await bounded.historySearch(session, "canonical-message-7 ", 5)).map((m) => m.seq)).toEqual([7]);
    expect(await db.listMessages(chat.id)).toHaveLength(500);
    await bounded.disconnect(session);

    const secondBinding = await db.issueBinding(chat.id, 60_000);
    const secondSession = createAgentSession();
    const reconnected = await bounded.connect(secondSession, secondBinding.token);
    expect(reconnected.context.messages.at(-1)?.seq).toBe(500);
    expect(reconnected.context.summary).toContain("Messages 1-480");
    await bounded.disconnect(secondSession);
  });
});

describe("live wait and interruption", () => {
  it("waits for a portal message and returns it without reconnecting", async () => {
    const seeded = await seed("plan");
    const session = createAgentSession();
    await service.connect(session, seeded.binding.token);
    const waiting = service.wait(session, 5_000);
    setTimeout(() => { void db.appendMessage({ chatId: seeded.chat.id, role: "user", source: "portal", content: "arrived while waiting" }); }, 250);
    const result = await waiting;
    expect(result.status).toBe("update");
    if (result.status === "update") expect(result.messages.map((m) => m.content)).toContain("arrived while waiting");
    expect(session.chatId).toBe(seeded.chat.id);
  });

  it("stops an active terminal promptly and keeps the chat connected", async () => {
    const seeded = await seed("build");
    const session = createAgentSession();
    await service.connect(session, seeded.binding.token);
    const command = service.terminal(session, "sleep 30", undefined, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const interrupt = await db.requestInterrupt(seeded.chat.id, "user changed direction");
    expect(interrupt).toBeTruthy();
    const result = await command;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(session.chatId).toBe(seeded.chat.id);
    expect(session.runId).toBeNull();
    expect((await db.listEvents(seeded.chat.id)).some((event) => event.type === "run.cancelled")).toBe(true);
  });

  it("uses a non-Git workspace folder directly in Build mode", async () => {
    const folder = join(root, `plain-${Date.now()}`);
    execFileSync("mkdir", ["-p", folder]);
    const ws = await db.createWorkspace({ name: "Plain", rootPath: folder, defaultBranch: "main" });
    const chat = await db.createChat({ workspaceId: ws.id, title: "Create project", mode: "build" });
    const binding = await db.issueBinding(chat.id, 60_000);
    const session = createAgentSession();
    const connected = await service.connect(session, binding.token);
    expect(connected.chat.worktreePath).toBeNull();
    const result = await service.terminal(session, "pwd && printf 'created' > hello.txt");
    expect(result.stdout.trim()).toBe(folder);
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(join(folder, "hello.txt"), "utf8"))).toBe("created");
  });
});
