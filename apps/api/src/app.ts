import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AttachmentStore } from "@vps-mcp/attachments";
import type { WorkspaceManager } from "@vps-mcp/workspace";
import { verify } from "@node-rs/argon2";
import { z } from "zod";
import { workspaceModeSchema } from "@vps-mcp/core";
import type { Database, PortalSessionRecord } from "@vps-mcp/db";

const SESSION_COOKIE = "vpsmcp_session";
const CSRF_COOKIE = "vpsmcp_csrf";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    reply.code(400).send({ error: "invalid_request", issues: result.error.issues });
    return null;
  }
  return result.data;
}

export interface ApiOptions {
  db: Database;
  secureCookies?: boolean;
  attachmentStore?: AttachmentStore;
  workspaceManager?: WorkspaceManager;
  staticDir?: string;
  repositoryBrowseRoots?: string[];
}

export async function createApi(options: ApiOptions) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const secureCookies = options.secureCookies ?? true;
  const { db } = options;

  app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  app.register(multipart, { limits: { files: 1, fileSize: options.attachmentStore?.maxBytes ?? 25 * 1024 * 1024 } });
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
      },
    },
  });

  async function auth(request: FastifyRequest, reply: FastifyReply): Promise<PortalSessionRecord | null> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    const session = await db.resolvePortalSession(token);
    if (!session) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return session;
  }

  function csrf(request: FastifyRequest, reply: FastifyReply, session: PortalSessionRecord): boolean {
    const supplied = request.headers["x-csrf-token"];
    if (typeof supplied !== "string" || !safeEqualHex(sha256(supplied), session.csrfHash)) {
      reply.code(403).send({ error: "csrf" });
      return false;
    }
    return true;
  }

  async function audit(session: PortalSessionRecord, action: string, targetType?: string, targetId?: string, metadata?: Record<string, unknown>) {
    await db.appendAudit({ actorType: "user", actorId: session.userId, action, targetType, targetId, metadata });
  }

  async function cleanupChatWorktree(chat: { workspaceId: string; worktreePath: string | null; branch: string | null }) {
    if (!options.workspaceManager || !chat.worktreePath) return;
    const workspace = await db.getWorkspace(chat.workspaceId);
    if (!workspace) return;
    await options.workspaceManager.removeWorktree({ repoPath: workspace.rootPath, worktreePath: chat.worktreePath, branch: chat.branch });
  }

  app.get("/api/health", async () => {
    await db.pool.query("SELECT 1");
    return { ok: true };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(4096) }), request.body, reply);
    if (!body) return;
    const user = await db.getPortalUserByUsername(body.username);
    if (!user || !(await verify(user.passwordHash, body.password))) {
      await new Promise((resolve) => setTimeout(resolve, 80 + Math.floor(Math.random() * 80)));
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const session = await db.createPortalSession(user.id, SESSION_TTL_MS);
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    reply.setCookie(SESSION_COOKIE, session.token, {
      path: "/",
      httpOnly: true,
      secure: secureCookies,
      sameSite: "strict",
      maxAge,
    });
    reply.setCookie(CSRF_COOKIE, session.csrfToken, {
      path: "/",
      httpOnly: false,
      secure: secureCookies,
      sameSite: "strict",
      maxAge,
    });
    await db.appendAudit({ actorType: "user", actorId: user.id, action: "auth.login", targetType: "user", targetId: user.id });
    return { user: { id: user.id, username: user.username }, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  });

  app.get("/api/me", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session) return;
    const csrfToken = request.cookies[CSRF_COOKIE] ?? null;
    return { user: { id: session.userId, username: session.username }, csrfToken };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const token = request.cookies[SESSION_COOKIE]!;
    await audit(session, "auth.logout", "user", session.userId);
    await db.deletePortalSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/repositories/browse", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const query = parse(z.object({ path: z.string().max(4096).optional() }), request.query, reply);
    if (!query) return;

    const configuredRoots = options.repositoryBrowseRoots ?? ["/opt", "/data", "/home", "/root"];
    const roots = (await Promise.all(configuredRoots.map(async (root) => {
      try { return await realpath(root); } catch { return null; }
    }))).filter((root): root is string => Boolean(root));

    const withinRoot = (candidate: string, root: string) => {
      const rel = relative(root, candidate);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    const gitRepo = async (candidate: string) => {
      try { await stat(resolve(candidate, ".git")); return true; } catch { return false; }
    };

    if (!query.path) {
      return {
        currentPath: null,
        parentPath: null,
        isGitRepository: false,
        roots: await Promise.all(roots.map(async (path) => ({ path, name: path, isGitRepository: await gitRepo(path) }))),
        entries: [],
      };
    }

    let currentPath: string;
    try { currentPath = await realpath(query.path); }
    catch { return reply.code(404).send({ error: "path_not_found" }); }
    const allowedRoot = roots.find((root) => withinRoot(currentPath, root));
    if (!allowedRoot) return reply.code(403).send({ error: "path_not_allowed" });
    if (!(await stat(currentPath)).isDirectory()) return reply.code(400).send({ error: "path_not_directory" });

    const rawEntries = await readdir(currentPath, { withFileTypes: true });
    const entries = (await Promise.all(rawEntries
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map(async (entry) => {
        const rawPath = resolve(currentPath, entry.name);
        try {
          const path = await realpath(rawPath);
          if (!withinRoot(path, allowedRoot) || !(await stat(path)).isDirectory()) return null;
          return { name: entry.name, path, isGitRepository: await gitRepo(path) };
        } catch { return null; }
      }))).filter((entry): entry is { name: string; path: string; isGitRepository: boolean } => Boolean(entry))
      .sort((a, b) => Number(b.isGitRepository) - Number(a.isGitRepository) || a.name.localeCompare(b.name));

    const relToRoot = relative(allowedRoot, currentPath);
    const parentPath = relToRoot === "" ? null : resolve(currentPath, "..");
    return {
      currentPath,
      parentPath,
      isGitRepository: await gitRepo(currentPath),
      roots: roots.map((path) => ({ path, name: path })),
      entries,
    };
  });

  app.post("/api/repositories/folders", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const body = parse(z.object({ parentPath: z.string().min(1).max(4096), name: z.string().trim().min(1).max(120).regex(/^[^\/\0]+$/) }), request.body, reply);
    if (!body) return;
    const configuredRoots = options.repositoryBrowseRoots ?? ["/opt", "/data", "/home", "/root"];
    const roots = (await Promise.all(configuredRoots.map(async (root) => { try { return await realpath(root); } catch { return null; } }))).filter((root): root is string => Boolean(root));
    let parent: string;
    try { parent = await realpath(body.parentPath); } catch { return reply.code(404).send({ error: "path_not_found" }); }
    const allowedRoot = roots.find((root) => { const rel = relative(root, parent); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); });
    if (!allowedRoot) return reply.code(403).send({ error: "path_not_allowed" });
    const target = resolve(parent, body.name);
    const rel = relative(allowedRoot, target);
    if (rel.startsWith("..") || isAbsolute(rel)) return reply.code(403).send({ error: "path_not_allowed" });
    try { await mkdir(target); } catch (error: any) {
      if (error?.code === "EEXIST") return reply.code(409).send({ error: "folder_exists" });
      throw error;
    }
    const created = await realpath(target);
    await audit(session, "workspace.folder.create", "folder", created, { parent });
    return reply.code(201).send({ path: created, name: body.name, isGitRepository: false });
  });

  app.get("/api/workspaces", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    return db.listWorkspaces();
  });

  app.post("/api/workspaces", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120),
      rootPath: z.string().min(1).max(4096),
      defaultBranch: z.string().min(1).max(255).optional(),
      instructions: z.string().max(100_000).optional(),
    }), request.body, reply);
    if (!body) return;
    if (options.workspaceManager) {
      try { await options.workspaceManager.validateWorkspaceRoot(body.rootPath); }
      catch (error) { return reply.code(400).send({ error: "workspace_root_invalid", message: error instanceof Error ? error.message : String(error) }); }
    }
    const workspace = await db.createWorkspace(body);
    await audit(session, "workspace.create", "workspace", workspace.id, { name: workspace.name, rootPath: workspace.rootPath });
    return reply.code(201).send(workspace);
  });

  app.patch("/api/workspaces/:workspaceId", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ workspaceId: z.string().min(1) }), request.params, reply);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120).optional(),
      rootPath: z.string().min(1).max(4096).optional(),
      defaultBranch: z.string().min(1).max(255).optional(),
      instructions: z.string().max(100_000).optional(),
    }).refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" }), request.body, reply);
    if (!params || !body) return;
    if (body.rootPath && options.workspaceManager) {
      try { await options.workspaceManager.validateWorkspaceRoot(body.rootPath); }
      catch (error) { return reply.code(400).send({ error: "workspace_root_invalid", message: error instanceof Error ? error.message : String(error) }); }
    }
    const workspace = await db.updateWorkspace(params.workspaceId, body);
    if (!workspace) return reply.code(404).send({ error: "workspace_not_found" });
    await audit(session, "workspace.update", "workspace", workspace.id, body);
    return workspace;
  });

  app.delete("/api/workspaces/:workspaceId", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ workspaceId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    const workspace = await db.getWorkspace(params.workspaceId);
    if (!workspace) return reply.code(404).send({ error: "workspace_not_found" });
    const chats = await db.listChats(workspace.id);
    for (const chat of chats) await cleanupChatWorktree(chat);
    await audit(session, "workspace.delete", "workspace", workspace.id, { name: workspace.name });
    await db.deleteWorkspace(workspace.id);
    return reply.code(204).send();
  });

  app.get("/api/workspaces/:workspaceId/chats", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const params = parse(z.object({ workspaceId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    return db.listChats(params.workspaceId);
  });

  app.post("/api/workspaces/:workspaceId/chats", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ workspaceId: z.string().min(1) }), request.params, reply);
    const body = parse(z.object({ title: z.string().trim().min(1).max(200), mode: workspaceModeSchema.optional() }), request.body, reply);
    if (!params || !body) return;
    const workspace = await db.getWorkspace(params.workspaceId);
    if (!workspace) return reply.code(404).send({ error: "workspace_not_found" });
    const chat = await db.createChat({ workspaceId: params.workspaceId, title: body.title, mode: body.mode });
    await audit(session, "chat.create", "chat", chat.id, { workspaceId: chat.workspaceId, title: chat.title, mode: chat.mode });
    return reply.code(201).send(chat);
  });

  app.get("/api/chats/:chatId", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    const chat = await db.getChat(params.chatId);
    if (!chat) return reply.code(404).send({ error: "chat_not_found" });
    const [messages, questions, threadState, attachments, activeRun] = await Promise.all([
      db.listMessages(chat.id),
      db.listOpenQuestions(chat.id),
      db.getThreadState(chat.id),
      db.listAttachments(chat.id),
      db.getActiveRun(chat.id),
    ]);
    return { ...chat, messages, questions, threadState, activeRun, attachments: attachments.map(({ storagePath: _storagePath, ...attachment }) => attachment) };
  });

  app.get("/api/chats/:chatId/diff", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    if (!options.workspaceManager) return reply.code(503).send({ error: "workspace_manager_disabled" });
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    const chat = await db.getChat(params.chatId);
    if (!chat) return reply.code(404).send({ error: "chat_not_found" });
    if (!chat.worktreePath) return { short: "", diffStat: "", diff: "", worktreePath: null };
    const changes = await options.workspaceManager.diff(chat.worktreePath);
    return { ...changes, worktreePath: chat.worktreePath, branch: chat.branch };
  });

  app.patch("/api/chats/:chatId", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    const body = parse(z.object({
      title: z.string().trim().min(1).max(200).optional(),
      mode: workspaceModeSchema.optional(),
      status: z.enum(["active", "archived"]).optional(),
    }).refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" }), request.body, reply);
    if (!params || !body) return;
    const chat = await db.updateChat(params.chatId, body);
    if (!chat) return reply.code(404).send({ error: "chat_not_found" });
    await audit(session, "chat.update", "chat", chat.id, body);
    return chat;
  });

  app.delete("/api/chats/:chatId", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    const chat = await db.getChat(params.chatId);
    if (!chat) return reply.code(404).send({ error: "chat_not_found" });
    await cleanupChatWorktree(chat);
    await audit(session, "chat.delete", "chat", chat.id, { workspaceId: chat.workspaceId, title: chat.title });
    await db.deleteChat(chat.id);
    return reply.code(204).send();
  });

  app.post("/api/chats/:chatId/interrupt", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    const body = parse(z.object({ reason: z.string().trim().min(1).max(1000).optional() }), request.body ?? {}, reply);
    if (!params || !body) return;
    const requested = await db.requestInterrupt(params.chatId, body.reason ?? "User pressed Stop in the portal");
    if (!requested) return reply.code(409).send({ error: "no_active_run" });
    const event = await db.appendEvent({ chatId: params.chatId, runId: requested.runId, type: "run.interrupt.requested", payload: { reason: requested.reason } });
    await audit(session, "run.interrupt", "run", requested.runId, { chatId: params.chatId, reason: requested.reason });
    return reply.code(202).send({ ...requested, event });
  });

  app.post("/api/chats/:chatId/messages", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    const body = parse(z.object({ content: z.string().trim().min(1).max(500_000), attachmentIds: z.array(z.string()).max(20).optional() }), request.body, reply);
    if (!params || !body) return;
    if (!(await db.getChat(params.chatId))) return reply.code(404).send({ error: "chat_not_found" });
    const message = await db.appendMessage({ chatId: params.chatId, role: "user", source: "portal", content: body.content });
    if (body.attachmentIds?.length) await db.linkAttachments(params.chatId, message.id, body.attachmentIds);
    await audit(session, "message.create", "message", message.id, { chatId: params.chatId, attachmentCount: body.attachmentIds?.length ?? 0 });
    return reply.code(201).send(message);
  });

  app.post("/api/chats/:chatId/attachments", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    if (!options.attachmentStore) return reply.code(503).send({ error: "attachments_disabled" });
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    if (!(await db.getChat(params.chatId))) return reply.code(404).send({ error: "chat_not_found" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ error: "file_required" });
    const buffer = await part.toBuffer();
    const stored = await options.attachmentStore.put(buffer, part.filename, part.mimetype);
    const attachment = await db.createAttachment({ chatId: params.chatId, ...stored });
    await audit(session, "attachment.create", "attachment", attachment.id, { chatId: params.chatId, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes });
    const { storagePath: _storagePath, ...publicAttachment } = attachment;
    return reply.code(201).send(publicAttachment);
  });

  app.get("/api/attachments/:attachmentId", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const params = parse(z.object({ attachmentId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    const attachment = await db.getAttachment(params.attachmentId);
    if (!attachment) return reply.code(404).send({ error: "attachment_not_found" });
    const buffer = await readFile(attachment.storagePath);
    reply.type(attachment.mimeType);
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`);
    return reply.send(buffer);
  });

  app.post("/api/chats/:chatId/bindings", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    if (!(await db.getChat(params.chatId))) return reply.code(404).send({ error: "chat_not_found" });
    const binding = await db.issueBinding(params.chatId);
    await audit(session, "binding.create", "chat", params.chatId, { expiresAt: binding.expiresAt });
    return reply.code(201).send(binding);
  });

  app.get("/api/chats/:chatId/events", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    const query = parse(z.object({ after: z.coerce.number().int().min(0).default(0) }), request.query, reply);
    if (!params || !query) return;
    return db.listEvents(params.chatId, query.after);
  });

  app.get("/api/chats/:chatId/events/stream", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    const query = parse(z.object({ after: z.coerce.number().int().min(0).default(0) }), request.query, reply);
    if (!params || !query) return;
    if (!(await db.getChat(params.chatId))) return reply.code(404).send({ error: "chat_not_found" });

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    let cursor = Math.max(query.after, Number(request.headers["last-event-id"] ?? 0) || 0);
    let closed = false;
    request.raw.on("close", () => { closed = true; });

    while (!closed) {
      const events = await db.listEvents(params.chatId, cursor, 250);
      for (const event of events) {
        response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.seq;
      }
      if (!events.length) response.write(": keepalive\n\n");
      await new Promise((resolve) => setTimeout(resolve, events.length ? 50 : 800));
    }
    response.end();
  });

  app.get("/api/chats/:chatId/questions", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    const params = parse(z.object({ chatId: z.string().min(1) }), request.params, reply);
    if (!params) return;
    return db.listOpenQuestions(params.chatId);
  });

  app.post("/api/questions/:questionId/answer", async (request, reply) => {
    const session = await auth(request, reply);
    if (!session || !csrf(request, reply, session)) return;
    const params = parse(z.object({ questionId: z.string().min(1) }), request.params, reply);
    const body = parse(z.object({ answer: z.unknown() }), request.body, reply);
    if (!params || !body) return;
    const before = await db.getQuestion(params.questionId);
    if (!before) return reply.code(404).send({ error: "question_not_found" });
    const question = await db.answerQuestion(params.questionId, body.answer);
    if (!question) return reply.code(409).send({ error: "question_not_open" });
    await audit(session, "question.answer", "question", question.id, { chatId: question.chatId });
    await db.appendEvent({
      chatId: question.chatId,
      runId: question.runId,
      type: "question.answered",
      payload: { questionId: question.id, answer: question.answer },
    });
    return question;
  });

  app.get("/api/random-nonce", async (request, reply) => {
    if (!(await auth(request, reply))) return;
    return { nonce: randomBytes(16).toString("base64url") };
  });

  if (options.staticDir) {
    app.register(staticPlugin, { root: options.staticDir, prefix: "/", index: ["index.html"] });
  }

  return app;
}
