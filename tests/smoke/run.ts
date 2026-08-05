import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.env.SMOKE_BASE_URL ?? "").replace(/\/$/, "");
const username = process.env.SMOKE_ADMIN_USERNAME ?? "admin";
const password = process.env.SMOKE_ADMIN_PASSWORD ?? "";
const oauthPassword = process.env.SMOKE_OAUTH_PASSWORD ?? "";
if (!base || !password || !oauthPassword) throw new Error("SMOKE_BASE_URL, SMOKE_ADMIN_PASSWORD and SMOKE_OAUTH_PASSWORD are required");

const cookies = new Map<string, string>();
let csrf = "";
function captureCookies(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
  for (const value of values) {
    const first = value.split(";", 1)[0]!;
    const index = first.indexOf("=");
    if (index > 0) cookies.set(first.slice(0, index), first.slice(index + 1));
  }
}
function cookieHeader() { return [...cookies].map(([key, value]) => `${key}=${value}`).join("; "); }
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (cookies.size) headers.set("cookie", cookieHeader());
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrf) headers.set("x-csrf-token", csrf);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
  captureCookies(response);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body as T;
}

async function readOneSse(chatId: string, after = 0): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${base}/api/chats/${chatId}/events/stream?after=${after}`, {
      headers: { cookie: cookieHeader() }, signal: controller.signal,
    });
    assert(response.ok, `SSE status ${response.status}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes("event:")) break;
    }
    await reader.cancel().catch(() => undefined);
    return text;
  } finally { clearTimeout(timer); controller.abort(); }
}

function toolJson(result: any) {
  const first = result?.content?.find((item: any) => item.type === "text");
  if (!first) throw new Error("Expected MCP text result");
  return JSON.parse(first.text);
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function step(message: string) { console.log(`✓ ${message}`); }

let client: Client | null = null;
let workspaceId = "";
let chatId = "";
let worktreePath = "";
const smokeRoot = process.env.SMOKE_REPO_ROOT ?? tmpdir();
await mkdir(smokeRoot, { recursive: true });
const repoParent = await mkdtemp(join(smokeRoot, "vps-mcp-smoke-"));
const repo = join(repoParent, "repo");
execFileSync("mkdir", ["-p", repo]);
git(repo, "init", "-b", "main");
git(repo, "config", "user.email", "smoke@example.com");
git(repo, "config", "user.name", "Smoke Test");
await writeFile(join(repo, "README.md"), "smoke base\n");
git(repo, "add", "."); git(repo, "commit", "-m", "base");

try {
  const health = await api<{ ok: boolean }>("/api/health");
  assert(health.ok, "API health check failed"); step("portal API + database health");

  const login = await api<{ csrfToken: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  csrf = login.csrfToken; assert(Boolean(csrf), "login did not return CSRF token"); step("portal authentication + CSRF");

  const workspace = await api<any>("/api/workspaces", { method: "POST", body: JSON.stringify({ name: `Smoke ${Date.now()}`, rootPath: repo, defaultBranch: "main", instructions: "Smoke workspace; preserve base checkout." }) });
  workspaceId = workspace.id; step("Git workspace registration/validation");

  const chat = await api<any>(`/api/workspaces/${workspaceId}/chats`, { method: "POST", body: JSON.stringify({ title: "End-to-end smoke", mode: "plan" }) });
  chatId = chat.id;
  await api(`/api/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content: "Inspect this repository first, then wait for the smoke flow." }) });
  step("Plan chat + canonical message history");

  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLsAAAAASUVORK5CYII=", "base64");
  const form = new FormData(); form.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
  const attachment = await api<any>(`/api/chats/${chatId}/attachments`, { method: "POST", body: form });
  await api(`/api/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content: "Attached smoke image.", attachmentIds: [attachment.id] }) });
  step("image upload, hashing, metadata + message linkage");

  const binding = await api<any>(`/api/chats/${chatId}/bindings`, { method: "POST" });
  assert(/^bind-(?:[a-z]+-){4}\d{6}$/.test(binding.token ?? ""), "binding token missing"); step("one-time chat binding issued");

  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const clientId = "https://chatgpt.com/vps-mcp-smoke";
  const redirectUri = "https://chatgpt.com/connector/oauth/vps-mcp-smoke";
  const authParams = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "smoke", resource: `${base}/mcp`, scope: "terminal:execute chat:control" });
  const authPage = await fetch(`${base}/oauth/authorize?${authParams}`); assert(authPage.status === 200, `OAuth authorize page status ${authPage.status}`);
  const authorize = await fetch(`${base}/oauth/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(authParams), password: oauthPassword }), redirect: "manual" });
  assert(authorize.status === 302, `OAuth approval status ${authorize.status}`);
  const location = authorize.headers.get("location"); assert(location, "OAuth approval missing redirect");
  const code = new URL(location).searchParams.get("code"); assert(code, "OAuth redirect missing code");
  const tokenResponse = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }) });
  assert(tokenResponse.ok, `OAuth token exchange status ${tokenResponse.status}`);
  const oauth = await tokenResponse.json() as any; assert(oauth.access_token, "OAuth access token missing"); step("OAuth/PKCE + persistent MCP bearer token");

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${oauth.access_token}` } } });
  client = new Client({ name: "vps-mcp-smoke", version: "1.0.0" }); await client.connect(transport);
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  for (const required of ["terminal", "chat_connect", "chat_sync", "chat_wait", "chat_ask", "chat_terminal", "chat_attachment", "chat_complete"]) assert(toolNames.includes(required), `missing MCP tool ${required}`);
  step("official MCP client connection + tool discovery");

  const connected = await client.callTool({ name: "chat_connect", arguments: { binding_code: binding.token } }); assert(!connected.isError, "chat_connect failed");
  const connectedBody = toolJson(connected); assert(connectedBody.context.messages.length === 2, "chat hydration did not include full verbatim history"); step("chat binding + full context hydration");
  const sse = await readOneSse(chatId, 0); assert(sse.includes("event: agent.connected"), "public SSE did not replay agent.connected"); step("public SSE event replay");

  const waiting = client.callTool({ name: "chat_wait", arguments: { timeout_ms: 5_000 } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await api(`/api/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content: "Message delivered while chat_wait was parked." }) });
  const waited = toolJson(await waiting);
  assert(waited.status === "update" && waited.messages.some((message: any) => message.content.includes("delivered while chat_wait")), "chat_wait did not wake for portal message");
  step("chat_wait wakes on portal message without reconnecting");

  const image = await client.callTool({ name: "chat_attachment", arguments: { attachment_id: attachment.id } });
  assert(!image.isError && (image.content as any[])[0]?.type === "image", "MCP image attachment delivery failed"); step("MCP image attachment delivery");

  const safe = await client.callTool({ name: "chat_terminal", arguments: { command: "git status --short" } }); assert(!safe.isError, "Plan read command failed");
  const blocked = await client.callTool({ name: "chat_terminal", arguments: { command: "touch forbidden.txt" } }); assert(blocked.isError, "Plan mutation was not blocked"); step("Plan-mode read-only enforcement");

  const asked = await client.callTool({ name: "chat_ask", arguments: { kind: "single_choice", prompt: "Smoke choice?", options: ["A", "B"] } }); assert(!asked.isError, "chat_ask failed");
  const question = toolJson(asked); await api(`/api/questions/${question.id}/answer`, { method: "POST", body: JSON.stringify({ answer: ["B"] }) });
  const sync = toolJson(await client.callTool({ name: "chat_sync", arguments: {} })); assert(sync.events.some((event: any) => event.type === "question.answered"), "question answer not visible to agent sync"); step("structured portal Q&A round trip");

  await api(`/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ mode: "build" }) });
  const longCommand = client.callTool({ name: "chat_terminal", arguments: { command: "sleep 30", timeout: 30_000 } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await api(`/api/chats/${chatId}/interrupt`, { method: "POST", body: JSON.stringify({ reason: "smoke stop" }) });
  const stopped = toolJson(await longCommand);
  assert(stopped.cancelled === true && stopped.exitCode === 130, "portal Stop did not cancel the active command");
  const waitAfterStop = client.callTool({ name: "chat_wait", arguments: { timeout_ms: 5_000 } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await api(`/api/chats/${chatId}/messages`, { method: "POST", body: JSON.stringify({ content: "Continue after stop." }) });
  const resumed = toolJson(await waitAfterStop);
  assert(resumed.status === "update", "chat did not remain connected after Stop");
  step("portal Stop cancels active process while chat remains connected");

  const build = await client.callTool({ name: "chat_terminal", arguments: { command: "printf 'smoke-build\\n' > smoke.txt && git status --short" } }); assert(!build.isError, "Build command failed");
  const detail = await api<any>(`/api/chats/${chatId}`); worktreePath = detail.worktreePath; assert(worktreePath, "Build chat did not receive a worktree");
  await access(join(worktreePath, "smoke.txt"));
  const changes = await api<any>(`/api/chats/${chatId}/diff`);
  assert(changes.short.includes("smoke.txt"), "portal diff/status surface did not see Build changes");
  let baseChanged = true; try { await access(join(repo, "smoke.txt")); } catch { baseChanged = false; }
  assert(!baseChanged, "Build chat modified base checkout"); step("Build-mode isolated Git worktree + file activity");

  const complete = await client.callTool({ name: "chat_complete", arguments: { answer: "Smoke run completed successfully.", summary: "End-to-end smoke passed through Plan, Q&A, Build, attachment and completion flows.", structured: { goal: "smoke", status: "complete" } } }); assert(!complete.isError, "chat_complete failed");
  const completedDetail = await api<any>(`/api/chats/${chatId}`); assert(completedDetail.messages.at(-1)?.content === "Smoke run completed successfully.", "assistant completion not mirrored into portal");
  assert(completedDetail.threadState?.summary?.includes("smoke passed"), "rolling context checkpoint missing"); step("completion mirroring + rolling context checkpoint");

  await client.callTool({ name: "chat_disconnect", arguments: {} }); await client.close(); client = null;
  await api(`/api/chats/${chatId}`, { method: "DELETE" }); chatId = "";
  if (worktreePath) { let exists = true; try { await stat(worktreePath); } catch { exists = false; } assert(!exists, "deleted chat worktree still exists"); }
  await api(`/api/workspaces/${workspaceId}`, { method: "DELETE" }); workspaceId = "";
  step("chat/worktree/workspace cleanup");

  console.log("\nSMOKE PASS");
} finally {
  if (client) { try { await client.callTool({ name: "chat_disconnect", arguments: {} }); } catch {} try { await client.close(); } catch {} }
  if (chatId) { try { await api(`/api/chats/${chatId}`, { method: "DELETE" }); } catch {} }
  if (workspaceId) { try { await api(`/api/workspaces/${workspaceId}`, { method: "DELETE" }); } catch {} }
}
