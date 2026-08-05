import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Database, migrate, resetForTests } from "@vps-mcp/db";
import { WorkspaceManager } from "@vps-mcp/workspace";
import { ChatAgentService } from "./chat-service.js";
import { createMcpHttpServer } from "./http.js";

const dbUrl = process.env.TEST_DATABASE_URL!;
let db: Database;
let repo = "";
let worktrees = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeAll(async () => {
  db = new Database(dbUrl);
  await migrate(db.pool);
  const root = await mkdtemp(join(tmpdir(), "vpsmcp-http-"));
  repo = join(root, "repo"); worktrees = join(root, "worktrees");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "x@y.z"); git(repo, "config", "user.name", "T");
  await writeFile(join(repo, "README.md"), "hello\n"); git(repo, "add", "."); git(repo, "commit", "-m", "init");
});
beforeEach(async () => resetForTests(db.pool));
afterAll(async () => db.close());

describe("MCP HTTP", () => {
  it("provides authenticated protocol tools and chat policy", async () => {
    const token = "protocol-test-token";
    await db.storeMcpAccessToken(token, 60_000);
    const agent = new ChatAgentService(db, new WorkspaceManager(worktrees));
    const http = createMcpHttpServer({ db, agentService: agent, publicBaseUrl: "http://127.0.0.1", loginPassword: "x".repeat(40) });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address(); if (!address || typeof address === "string") throw new Error("bad address");
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
    expect((await fetch(endpoint)).status).toBe(401);

    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(["terminal", "chat_connect", "chat_sync", "chat_ask", "chat_terminal", "chat_complete"]));

    const ws = await db.createWorkspace({ name: "W", rootPath: repo });
    const chat = await db.createChat({ workspaceId: ws.id, title: "P", mode: "plan" });
    await db.appendMessage({ chatId: chat.id, role: "user", source: "portal", content: "Inspect" });
    const binding = await db.issueBinding(chat.id, 60_000);
    expect((await client.callTool({ name: "chat_connect", arguments: { binding_code: binding.token } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "chat_terminal", arguments: { command: "git status --short" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "chat_terminal", arguments: { command: "touch blocked" } })).isError).toBe(true);
    await client.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
});
