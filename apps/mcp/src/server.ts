import { Database, migrate } from "@vps-mcp/db";
import { WorkspaceManager } from "@vps-mcp/workspace";
import { ChatAgentService } from "./chat-service.js";
import { createMcpHttpServer } from "./http.js";

const databaseUrl = process.env.DATABASE_URL;
const loginPassword = process.env.OAUTH_LOGIN_PASSWORD;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!loginPassword) throw new Error("OAUTH_LOGIN_PASSWORD is required");
if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required");

const db = new Database(databaseUrl);
await migrate(db.pool);
const service = new ChatAgentService(db, new WorkspaceManager(process.env.WORKTREE_ROOT ?? "/data/vps-mcp/worktrees"));
const server = createMcpHttpServer({ db, agentService: service, publicBaseUrl, loginPassword, mcpPath: process.env.MCP_PATH ?? "/mcp" });
const host = process.env.HOST ?? "10.0.0.1";
const port = Number(process.env.PORT ?? "3201");
server.listen(port, host, () => console.log(`vps-mcp v2 listening on ${host}:${port}`));
const stop = () => server.close(() => void db.close().finally(() => process.exit(0)));
process.on("SIGTERM", stop); process.on("SIGINT", stop);
