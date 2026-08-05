import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  createId,
  estimateTextTokens,
  type EventType,
  type MessageRole,
  type QuestionKind,
  type RunStatus,
  type WorkspaceMode,
} from "@vps-mcp/core";

const here = dirname(fileURLToPath(import.meta.url));

export interface WorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRecord {
  id: string;
  workspaceId: string;
  title: string;
  mode: WorkspaceMode;
  status: "active" | "archived";
  branch: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  seq: number;
  role: MessageRole;
  source: "portal" | "agent" | "system";
  content: string;
  estimatedTokens: number | null;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  chatId: string;
  status: RunStatus;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  chatId: string;
  runId: string | null;
  seq: number;
  type: EventType | string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PortalUserRecord {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface PortalSessionRecord {
  id: string;
  userId: string;
  username: string;
  csrfHash: string;
  expiresAt: string;
}

export interface ThreadStateRecord {
  chatId: string;
  compactedThroughSeq: number | null;
  summary: string;
  structured: Record<string, unknown>;
  updatedAt: string;
}

export interface AttachmentRecord {
  id: string;
  chatId: string;
  messageId: string | null;
  originalName: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: string;
}

export interface QuestionRecord {
  id: string;
  chatId: string;
  runId: string | null;
  kind: QuestionKind;
  prompt: string;
  options: string[];
  allowMultiple: boolean;
  status: "open" | "answered" | "cancelled";
  answer: unknown;
  createdAt: string;
  answeredAt: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function mapWorkspace(row: any): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    defaultBranch: row.default_branch,
    instructions: row.instructions,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapChat(row: any): ChatRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    branch: row.branch,
    worktreePath: row.worktree_path,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapMessage(row: any): MessageRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: Number(row.seq),
    role: row.role,
    source: row.source,
    content: row.content,
    estimatedTokens: row.estimated_tokens === null ? null : Number(row.estimated_tokens),
    createdAt: iso(row.created_at)!,
  };
}

function mapRun(row: any): RunRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    status: row.status,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    error: row.error,
    createdAt: iso(row.created_at)!,
  };
}

function mapEvent(row: any): EventRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    runId: row.run_id,
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload ?? {},
    createdAt: iso(row.created_at)!,
  };
}

function mapQuestion(row: any): QuestionRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    runId: row.run_id,
    kind: row.kind,
    prompt: row.prompt,
    options: Array.isArray(row.options) ? row.options : [],
    allowMultiple: Boolean(row.allow_multiple),
    status: row.status,
    answer: row.answer,
    createdAt: iso(row.created_at)!,
    answeredAt: iso(row.answered_at),
  };
}

export async function migrate(pool: Pool): Promise<void> {
  // src/ during development => ../migrations; dist/ after build => ../migrations copied by package build/deploy.
  const candidates = [
    join(here, "../migrations/001_init.sql"),
    join(here, "../../migrations/001_init.sql"),
  ];
  let sql: string | undefined;
  for (const candidate of candidates) {
    try {
      sql = await readFile(candidate, "utf8");
      break;
    } catch {
      // Try the next location.
    }
  }
  if (!sql) throw new Error("Unable to locate DB migration 001_init.sql");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize schema bootstrap across API/MCP processes starting simultaneously.
    await client.query("SELECT pg_advisory_xact_lock($1)", [827_461_903]);
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function resetForTests(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      audit_log, mcp_access_tokens, attachments, thread_state, agent_leases,
      agent_bindings, questions, run_events, runs, messages, chats, workspaces,
      portal_sessions, users
    RESTART IDENTITY CASCADE
  `);
}

export class Database {
  readonly pool: Pool;

  constructor(connectionString: string | Pool) {
    this.pool = typeof connectionString === "string"
      ? new Pool({ connectionString, max: 20 })
      : connectionString;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createWorkspace(input: { name: string; rootPath: string; defaultBranch?: string; instructions?: string }): Promise<WorkspaceRecord> {
    const id = createId("ws");
    const result = await this.pool.query(
      `INSERT INTO workspaces (id,name,root_path,default_branch,instructions)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, input.name, input.rootPath, input.defaultBranch ?? "main", input.instructions ?? ""],
    );
    return mapWorkspace(result.rows[0]);
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const result = await this.pool.query("SELECT * FROM workspaces ORDER BY created_at ASC");
    return result.rows.map(mapWorkspace);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const result = await this.pool.query("SELECT * FROM workspaces WHERE id=$1", [id]);
    return result.rowCount ? mapWorkspace(result.rows[0]) : null;
  }

  async updateWorkspace(id: string, input: { name?: string; rootPath?: string; defaultBranch?: string; instructions?: string }): Promise<WorkspaceRecord | null> {
    const result = await this.pool.query(
      `UPDATE workspaces SET
         name=COALESCE($2,name),
         root_path=COALESCE($3,root_path),
         default_branch=COALESCE($4,default_branch),
         instructions=COALESCE($5,instructions),
         updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, input.name ?? null, input.rootPath ?? null, input.defaultBranch ?? null, input.instructions ?? null],
    );
    return result.rowCount ? mapWorkspace(result.rows[0]) : null;
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.pool.query("DELETE FROM workspaces WHERE id=$1", [id]);
  }

  async createChat(input: { workspaceId: string; title: string; mode?: WorkspaceMode }): Promise<ChatRecord> {
    const id = createId("cht");
    const result = await this.pool.query(
      `INSERT INTO chats (id,workspace_id,title,mode) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, input.workspaceId, input.title, input.mode ?? "plan"],
    );
    await this.pool.query("INSERT INTO thread_state (chat_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    return mapChat(result.rows[0]);
  }

  async listChats(workspaceId: string): Promise<ChatRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM chats WHERE workspace_id=$1 ORDER BY created_at DESC",
      [workspaceId],
    );
    return result.rows.map(mapChat);
  }

  async getChat(id: string): Promise<ChatRecord | null> {
    const result = await this.pool.query("SELECT * FROM chats WHERE id=$1", [id]);
    return result.rowCount ? mapChat(result.rows[0]) : null;
  }

  async updateChatMode(id: string, mode: WorkspaceMode): Promise<ChatRecord | null> {
    const result = await this.pool.query(
      "UPDATE chats SET mode=$2, updated_at=now() WHERE id=$1 RETURNING *",
      [id, mode],
    );
    return result.rowCount ? mapChat(result.rows[0]) : null;
  }

  async updateChat(id: string, input: { title?: string; mode?: WorkspaceMode; status?: "active" | "archived" }): Promise<ChatRecord | null> {
    const result = await this.pool.query(
      `UPDATE chats SET
         title=COALESCE($2,title),
         mode=COALESCE($3,mode),
         status=COALESCE($4,status),
         updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, input.title ?? null, input.mode ?? null, input.status ?? null],
    );
    return result.rowCount ? mapChat(result.rows[0]) : null;
  }

  async deleteChat(id: string): Promise<void> {
    await this.pool.query("DELETE FROM chats WHERE id=$1", [id]);
  }

  async updateChatWorktree(id: string, branch: string | null, worktreePath: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE chats SET branch=$2, worktree_path=$3, updated_at=now() WHERE id=$1",
      [id, branch, worktreePath],
    );
  }

  async appendMessage(input: {
    chatId: string;
    role: MessageRole;
    source: "portal" | "agent" | "system";
    content: string;
    estimatedTokens?: number;
  }): Promise<MessageRecord> {
    const id = createId("msg");
    const estimate = input.estimatedTokens ?? estimateTextTokens(input.content);
    const result = await this.pool.query(
      `WITH next AS (
         UPDATE chats
         SET next_message_seq = next_message_seq + 1, updated_at=now()
         WHERE id=$1
         RETURNING next_message_seq - 1 AS seq
       )
       INSERT INTO messages (id,chat_id,seq,role,source,content,estimated_tokens)
       SELECT $2,$1,next.seq,$3,$4,$5,$6 FROM next
       RETURNING *`,
      [input.chatId, id, input.role, input.source, input.content, estimate],
    );
    if (!result.rowCount) throw new Error(`Unknown chat ${input.chatId}`);
    return mapMessage(result.rows[0]);
  }

  async listMessages(chatId: string, afterSeq = 0): Promise<MessageRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM messages WHERE chat_id=$1 AND seq>$2 ORDER BY seq ASC",
      [chatId, afterSeq],
    );
    return result.rows.map(mapMessage);
  }

  async listMessagesRange(chatId: string, afterSeq = 0, beforeSeq: number | null = null, limit = 200): Promise<MessageRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM messages
       WHERE chat_id=$1 AND seq>$2 AND ($3::int IS NULL OR seq<=$3)
       ORDER BY seq ASC LIMIT $4`,
      [chatId, afterSeq, beforeSeq, limit],
    );
    return result.rows.map(mapMessage);
  }

  async searchMessages(chatId: string, query: string, limit = 20): Promise<MessageRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM messages
       WHERE chat_id=$1 AND position(lower($2) in lower(content))>0
       ORDER BY seq ASC LIMIT $3`,
      [chatId, query, limit],
    );
    return result.rows.map(mapMessage);
  }

  async createRun(chatId: string, status: RunStatus = "running"): Promise<RunRecord> {
    const id = createId("run");
    const startedAt = status === "running" ? new Date() : null;
    const result = await this.pool.query(
      `INSERT INTO runs (id,chat_id,status,started_at) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, chatId, status, startedAt],
    );
    return mapRun(result.rows[0]);
  }

  async updateRun(id: string, status: RunStatus, error?: string | null): Promise<RunRecord | null> {
    const completed = ["completed", "failed", "cancelled"].includes(status);
    const result = await this.pool.query(
      `UPDATE runs SET status=$2, error=$3,
       started_at=COALESCE(started_at, CASE WHEN $2='running' THEN now() ELSE NULL END),
       completed_at=CASE WHEN $4 THEN now() ELSE completed_at END
       WHERE id=$1 RETURNING *`,
      [id, status, error ?? null, completed],
    );
    return result.rowCount ? mapRun(result.rows[0]) : null;
  }

  async appendEvent(input: {
    chatId: string;
    runId?: string | null;
    type: EventType | string;
    payload?: Record<string, unknown>;
  }): Promise<EventRecord> {
    const id = createId("evt");
    const result = await this.pool.query(
      `WITH next AS (
         UPDATE chats
         SET next_event_seq = next_event_seq + 1, updated_at=now()
         WHERE id=$1
         RETURNING next_event_seq - 1 AS seq
       )
       INSERT INTO run_events (id,chat_id,run_id,seq,type,payload)
       SELECT $2,$1,$3,next.seq,$4,$5::jsonb FROM next
       RETURNING *`,
      [input.chatId, id, input.runId ?? null, input.type, JSON.stringify(input.payload ?? {})],
    );
    if (!result.rowCount) throw new Error(`Unknown chat ${input.chatId}`);
    return mapEvent(result.rows[0]);
  }

  async listEvents(chatId: string, afterSeq = 0, limit = 1000): Promise<EventRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM run_events WHERE chat_id=$1 AND seq>$2 ORDER BY seq ASC LIMIT $3",
      [chatId, afterSeq, limit],
    );
    return result.rows.map(mapEvent);
  }

  async issueBinding(chatId: string, ttlMs = 10 * 60_000): Promise<{ id: string; chatId: string; token: string; expiresAt: string }> {
    const id = createId("bind");
    const token = `bind_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      "INSERT INTO agent_bindings (id,chat_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)",
      [id, chatId, sha256(token), expiresAt],
    );
    return { id, chatId, token, expiresAt: expiresAt.toISOString() };
  }

  async consumeBinding(token: string): Promise<{ id: string; chatId: string } | null> {
    const result = await this.pool.query(
      `UPDATE agent_bindings
       SET consumed_at=now()
       WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()
       RETURNING id,chat_id`,
      [sha256(token)],
    );
    return result.rowCount ? { id: result.rows[0].id, chatId: result.rows[0].chat_id } : null;
  }

  async claimLease(chatId: string, agentSessionId: string, ttlMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO agent_leases (chat_id,agent_session_id,expires_at,last_heartbeat)
       VALUES ($1,$2,now()+($3 * interval '1 millisecond'),now())
       ON CONFLICT (chat_id) DO UPDATE
       SET agent_session_id=EXCLUDED.agent_session_id,
           expires_at=EXCLUDED.expires_at,
           last_heartbeat=now()
       WHERE agent_leases.agent_session_id=EXCLUDED.agent_session_id OR agent_leases.expires_at<now()
       RETURNING chat_id`,
      [chatId, agentSessionId, ttlMs],
    );
    return Boolean(result.rowCount);
  }

  async heartbeatLease(chatId: string, agentSessionId: string, ttlMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_leases SET expires_at=now()+($3 * interval '1 millisecond'), last_heartbeat=now()
       WHERE chat_id=$1 AND agent_session_id=$2 AND expires_at>now() RETURNING chat_id`,
      [chatId, agentSessionId, ttlMs],
    );
    return Boolean(result.rowCount);
  }

  async releaseLease(chatId: string, agentSessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_leases WHERE chat_id=$1 AND agent_session_id=$2", [chatId, agentSessionId]);
  }

  async createQuestion(input: {
    chatId: string;
    runId?: string | null;
    kind: QuestionKind;
    prompt: string;
    options?: string[];
    allowMultiple?: boolean;
  }): Promise<QuestionRecord> {
    const id = createId("qst");
    const result = await this.pool.query(
      `INSERT INTO questions (id,chat_id,run_id,kind,prompt,options,allow_multiple)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
      [id, input.chatId, input.runId ?? null, input.kind, input.prompt, JSON.stringify(input.options ?? []), input.allowMultiple ?? false],
    );
    return mapQuestion(result.rows[0]);
  }

  async answerQuestion(questionId: string, answer: unknown): Promise<QuestionRecord | null> {
    const result = await this.pool.query(
      `UPDATE questions SET status='answered',answer=$2::jsonb,answered_at=now()
       WHERE id=$1 AND status='open' RETURNING *`,
      [questionId, JSON.stringify(answer)],
    );
    return result.rowCount ? mapQuestion(result.rows[0]) : null;
  }

  async getQuestion(questionId: string): Promise<QuestionRecord | null> {
    const result = await this.pool.query("SELECT * FROM questions WHERE id=$1", [questionId]);
    return result.rowCount ? mapQuestion(result.rows[0]) : null;
  }

  async listOpenQuestions(chatId: string): Promise<QuestionRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM questions WHERE chat_id=$1 AND status='open' ORDER BY created_at ASC",
      [chatId],
    );
    return result.rows.map(mapQuestion);
  }

  async createPortalUser(username: string, passwordHash: string): Promise<PortalUserRecord> {
    const id = createId("usr");
    const result = await this.pool.query(
      `INSERT INTO users (id,username,password_hash) VALUES ($1,$2,$3) RETURNING *`,
      [id, username, passwordHash],
    );
    const row = result.rows[0];
    return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: iso(row.created_at)! };
  }

  async getPortalUserByUsername(username: string): Promise<PortalUserRecord | null> {
    const result = await this.pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { id: row.id, username: row.username, passwordHash: row.password_hash, createdAt: iso(row.created_at)! };
  }

  async createPortalSession(userId: string, ttlMs: number): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
    const id = createId("tok");
    const token = `ses_${randomBytes(32).toString("base64url")}`;
    const csrfToken = `csrf_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      `INSERT INTO portal_sessions (id,user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [id, userId, sha256(token), sha256(csrfToken), expiresAt],
    );
    return { token, csrfToken, expiresAt: expiresAt.toISOString() };
  }

  async resolvePortalSession(token: string): Promise<PortalSessionRecord | null> {
    const result = await this.pool.query(
      `SELECT s.id,s.user_id,u.username,s.csrf_hash,s.expires_at
       FROM portal_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [sha256(token)],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { id: row.id, userId: row.user_id, username: row.username, csrfHash: row.csrf_hash, expiresAt: iso(row.expires_at)! };
  }

  async deletePortalSession(token: string): Promise<void> {
    await this.pool.query("DELETE FROM portal_sessions WHERE token_hash=$1", [sha256(token)]);
  }

  async getThreadState(chatId: string): Promise<ThreadStateRecord | null> {
    const result = await this.pool.query("SELECT * FROM thread_state WHERE chat_id=$1", [chatId]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      chatId: row.chat_id,
      compactedThroughSeq: row.compacted_through_seq === null ? null : Number(row.compacted_through_seq),
      summary: row.summary,
      structured: row.structured ?? {},
      updatedAt: iso(row.updated_at)!,
    };
  }

  async updateThreadState(chatId: string, input: { compactedThroughSeq: number | null; summary: string; structured: Record<string, unknown> }): Promise<ThreadStateRecord> {
    const result = await this.pool.query(
      `INSERT INTO thread_state (chat_id,compacted_through_seq,summary,structured,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (chat_id) DO UPDATE SET compacted_through_seq=EXCLUDED.compacted_through_seq, summary=EXCLUDED.summary, structured=EXCLUDED.structured, updated_at=now()
       RETURNING *`,
      [chatId, input.compactedThroughSeq, input.summary, JSON.stringify(input.structured)],
    );
    const row = result.rows[0];
    return {
      chatId: row.chat_id,
      compactedThroughSeq: row.compacted_through_seq === null ? null : Number(row.compacted_through_seq),
      summary: row.summary,
      structured: row.structured ?? {},
      updatedAt: iso(row.updated_at)!,
    };
  }

  async createAttachment(input: { chatId: string; originalName: string; mimeType: string; sha256: string; sizeBytes: number; storagePath: string }): Promise<AttachmentRecord> {
    const id = createId("att");
    const result = await this.pool.query(
      `INSERT INTO attachments (id,chat_id,original_name,mime_type,sha256,size_bytes,storage_path)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, input.chatId, input.originalName, input.mimeType, input.sha256, input.sizeBytes, input.storagePath],
    );
    const row = result.rows[0];
    return { id: row.id, chatId: row.chat_id, messageId: row.message_id, originalName: row.original_name, mimeType: row.mime_type, sha256: row.sha256, sizeBytes: Number(row.size_bytes), storagePath: row.storage_path, createdAt: iso(row.created_at)! };
  }

  async linkAttachments(chatId: string, messageId: string, attachmentIds: string[]): Promise<void> {
    if (!attachmentIds.length) return;
    await this.pool.query(
      `UPDATE attachments SET message_id=$2 WHERE chat_id=$1 AND id = ANY($3::text[])`,
      [chatId, messageId, attachmentIds],
    );
  }

  async getAttachment(id: string): Promise<AttachmentRecord | null> {
    const result = await this.pool.query("SELECT * FROM attachments WHERE id=$1", [id]);
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { id: row.id, chatId: row.chat_id, messageId: row.message_id, originalName: row.original_name, mimeType: row.mime_type, sha256: row.sha256, sizeBytes: Number(row.size_bytes), storagePath: row.storage_path, createdAt: iso(row.created_at)! };
  }

  async listAttachments(chatId: string): Promise<AttachmentRecord[]> {
    const result = await this.pool.query("SELECT * FROM attachments WHERE chat_id=$1 ORDER BY created_at ASC", [chatId]);
    return result.rows.map((row) => ({ id: row.id, chatId: row.chat_id, messageId: row.message_id, originalName: row.original_name, mimeType: row.mime_type, sha256: row.sha256, sizeBytes: Number(row.size_bytes), storagePath: row.storage_path, createdAt: iso(row.created_at)! }));
  }

  async storeMcpAccessToken(token: string, ttlMs: number): Promise<{ id: string; expiresAt: string }> {
    const id = createId("tok");
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.pool.query(
      "INSERT INTO mcp_access_tokens (id,token_hash,expires_at) VALUES ($1,$2,$3)",
      [id, sha256(token), expiresAt],
    );
    return { id, expiresAt: expiresAt.toISOString() };
  }

  async isMcpAccessTokenValid(token: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM mcp_access_tokens WHERE token_hash=$1 AND expires_at>now()",
      [sha256(token)],
    );
    return Boolean(result.rowCount);
  }

  async connectBinding(token: string, agentSessionId: string, leaseTtlMs: number): Promise<{ bindingId: string; chatId: string } | null> {
    return this.withClient(async (client) => {
      const binding = await client.query(
        `SELECT id,chat_id FROM agent_bindings
         WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()
         FOR UPDATE`,
        [sha256(token)],
      );
      if (!binding.rowCount) return null;
      const row = binding.rows[0];
      const lease = await client.query(
        `INSERT INTO agent_leases (chat_id,agent_session_id,expires_at,last_heartbeat)
         VALUES ($1,$2,now()+($3 * interval '1 millisecond'),now())
         ON CONFLICT (chat_id) DO UPDATE
         SET agent_session_id=EXCLUDED.agent_session_id,
             expires_at=EXCLUDED.expires_at,
             last_heartbeat=now()
         WHERE agent_leases.agent_session_id=EXCLUDED.agent_session_id OR agent_leases.expires_at<now()
         RETURNING chat_id`,
        [row.chat_id, agentSessionId, leaseTtlMs],
      );
      if (!lease.rowCount) return null;
      await client.query("UPDATE agent_bindings SET consumed_at=now() WHERE id=$1", [row.id]);
      return { bindingId: row.id, chatId: row.chat_id };
    });
  }

  async appendAudit(input: { actorType: string; actorId?: string | null; action: string; targetType?: string | null; targetId?: string | null; metadata?: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (id,actor_type,actor_id,action,target_type,target_id,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [createId("evt"), input.actorType, input.actorId ?? null, input.action, input.targetType ?? null, input.targetId ?? null, JSON.stringify(input.metadata ?? {})],
    );
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
