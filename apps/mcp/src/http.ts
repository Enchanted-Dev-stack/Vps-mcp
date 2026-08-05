import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Database } from "@vps-mcp/db";
import { createAgentSession, type AgentSession, type ChatAgentService } from "./chat-service.js";
import { createToolServer } from "./mcp-tools.js";

interface AuthCode { clientId: string; redirectUri: string; challenge: string; expiresAt: number }
export interface McpHttpOptions {
  db: Database;
  agentService: ChatAgentService;
  publicBaseUrl: string;
  loginPassword: string;
  mcpPath?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
function sameSecret(a: string, b: string) {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function html(value: string) {
  return value.replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[c]!);
}

export function createMcpHttpServer(options: McpHttpOptions): Server {
  if (options.loginPassword.length < 32) throw new Error("loginPassword must be at least 32 characters");
  const path = options.mcpPath ?? "/mcp";
  const codes = new Map<string, AuthCode>();
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; agentSession: AgentSession }>();

  async function authorized(req: IncomingMessage) {
    const header = req.headers.authorization;
    return Boolean(header?.startsWith("Bearer ") && await options.db.isMcpAccessTokenValid(header.slice(7)));
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", options.publicBaseUrl);
    try {
      if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
        return sendJson(res, 200, { resource: `${options.publicBaseUrl}${path}`, authorization_servers: [options.publicBaseUrl], scopes_supported: ["chat:control"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        return sendJson(res, 200, {
          issuer: options.publicBaseUrl,
          authorization_endpoint: `${options.publicBaseUrl}/oauth/authorize`,
          token_endpoint: `${options.publicBaseUrl}/oauth/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["chat:control"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
        });
      }
      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        const fields = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];
        if (url.searchParams.get("response_type") !== "code" || !fields.slice(1, 5).every((field) => url.searchParams.get(field))) {
          res.writeHead(400).end("Invalid authorization request"); return;
        }
        const hidden = fields.map((field) => `<input type="hidden" name="${field}" value="${html(url.searchParams.get(field) ?? "")}">`).join("");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Authorize VPS MCP</title><style>body{font:15px system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0}main{width:min(420px,90vw);padding:28px;border:1px solid #30363d;border-radius:12px;background:#161b22}input{box-sizing:border-box;width:100%;margin:12px 0;padding:11px;border:1px solid #30363d;border-radius:7px;background:#0d1117;color:#fff}button{padding:10px 16px;border:0;border-radius:7px;background:#f0f6fc;color:#0d1117;font-weight:600}</style><main><h1>Authorize VPS MCP</h1><p>This grants ChatGPT access to the scoped VPS coding-agent portal.</p><form method="post" action="/oauth/authorize">${hidden}<label>Access password<input name="password" type="password" autofocus required></label><button>Authorize</button></form></main>`);
        return;
      }
      if (url.pathname === "/oauth/authorize" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const clientId = form.get("client_id") ?? "";
        const redirectUri = form.get("redirect_uri") ?? "";
        const challenge = form.get("code_challenge") ?? "";
        if (!sameSecret(form.get("password") ?? "", options.loginPassword) || !clientId.startsWith("https://chatgpt.com/") || !redirectUri.startsWith("https://chatgpt.com/connector/oauth/") || form.get("code_challenge_method") !== "S256") {
          res.writeHead(400).end("Authorization denied"); return;
        }
        const code = randomBytes(32).toString("base64url");
        codes.set(code, { clientId, redirectUri, challenge, expiresAt: Date.now() + 300_000 });
        const redirect = new URL(redirectUri); redirect.searchParams.set("code", code);
        const state = form.get("state"); if (state) redirect.searchParams.set("state", state);
        res.writeHead(302, { Location: redirect.toString(), "Cache-Control": "no-store" }).end(); return;
      }
      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const code = form.get("code") ?? "";
        const entry = codes.get(code); codes.delete(code);
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (form.get("grant_type") !== "authorization_code" || !entry || entry.expiresAt < Date.now() || entry.clientId !== form.get("client_id") || entry.redirectUri !== form.get("redirect_uri") || challenge !== entry.challenge) {
          return sendJson(res, 400, { error: "invalid_grant" });
        }
        const token = randomBytes(48).toString("base64url");
        const ttl = 30 * 24 * 60 * 60 * 1000;
        await options.db.storeMcpAccessToken(token, ttl);
        return sendJson(res, 200, { access_token: token, token_type: "Bearer", expires_in: ttl / 1000, scope: "chat:control" });
      }
      if (url.pathname !== path) { res.writeHead(404).end(); return; }
      if (!(await authorized(req))) {
        res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${options.publicBaseUrl}/.well-known/oauth-protected-resource"` }).end("Unauthorized");
        return;
      }

      const raw = req.method === "POST" ? await readBody(req) : "";
      const body = raw ? JSON.parse(raw) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      let entry = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!entry) {
        if (typeof sessionId === "string" || req.method !== "POST" || !body || typeof body !== "object" || (body as { method?: string }).method !== "initialize") {
          res.writeHead(400).end(JSON.stringify({ error: "Unknown session or initialize request required" }));
          return;
        }
        const agentSession = createAgentSession();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        entry = { transport, agentSession };
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          void options.agentService.disconnect(agentSession);
        };
        await createToolServer(agentSession, options.agentService).connect(transport);
        await transport.handleRequest(req, res, body);
        if (transport.sessionId) sessions.set(transport.sessionId, entry);
        return;
      }
      await entry.transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : "Bad request" });
      else res.end();
    }
  });
}
