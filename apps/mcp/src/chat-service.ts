import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { estimateTextTokens, redactSecrets, selectHydration, type QuestionKind } from "@vps-mcp/core";
import type { Database, MessageRecord, QuestionRecord } from "@vps-mcp/db";
import { isPathWithin, WorkspaceManager } from "@vps-mcp/workspace";
import { executeCommand, type ExecuteResult } from "./executor.js";

const LEASE_TTL_MS = 120_000;

export interface AgentSession {
  agentSessionId: string;
  chatId: string | null;
  messageCursor: number;
  eventCursor: number;
  runId: string | null;
}

export function createAgentSession(): AgentSession {
  return { agentSessionId: `agent_${randomUUID()}`, chatId: null, messageCursor: 0, eventCursor: 0, runId: null };
}

const simpleReadCommands = new Set([
  "pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr",
  "stat", "file", "du", "df", "ps", "ss", "which", "whereis", "printenv", "env", "jq", "awk",
  "hostname", "uname", "id", "whoami", "date", "realpath", "readlink", "tree", "cd", "echo", "printf",
]);
const readOnlyGit = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep", "remote", "tag", "describe"]);
const readOnlyDocker = new Set(["ps", "logs", "inspect", "images", "stats", "version", "info"]);
const readOnlySystemctl = new Set(["status", "show", "cat", "list-units", "list-unit-files", "is-active", "is-enabled"]);

export function isPlanSafeCommand(command: string): boolean {
  if (/[><`]/.test(command) || command.includes("$(")) return false;
  const segments = command.split(/(?:&&|\|\||[;|\n])/).map((value) => value.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((segment) => {
    const words = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    while (words[0]?.includes("=") && !words[0]?.startsWith("=")) words.shift();
    const executable = words[0]?.replace(/^.*\//, "");
    if (!executable) return false;
    if (simpleReadCommands.has(executable)) return true;
    if (executable === "git") return Boolean(words[1] && readOnlyGit.has(words[1]));
    if (executable === "docker") return Boolean(words[1] && readOnlyDocker.has(words[1]));
    if (executable === "systemctl") return Boolean(words[1] && readOnlySystemctl.has(words[1]));
    return false;
  });
}

function toHydrationMessage(message: MessageRecord) {
  return {
    id: message.id,
    chatId: message.chatId,
    seq: message.seq,
    role: message.role,
    content: message.content,
    estimatedTokens: message.estimatedTokens ?? undefined,
    createdAt: message.createdAt,
  };
}

export class ChatAgentService {
  constructor(
    readonly db: Database,
    readonly workspaces: WorkspaceManager,
    readonly contextPolicy = { maxContextTokens: 120_000, reservedTokens: 24_000, compactionSummaryTokens: 6_000 },
  ) {}

  private requireConnected(session: AgentSession): string {
    if (!session.chatId) throw new Error("This MCP session is not connected to a portal chat. Call chat_connect first.");
    return session.chatId;
  }

  private async heartbeat(session: AgentSession) {
    const chatId = this.requireConnected(session);
    const ok = await this.db.heartbeatLease(chatId, session.agentSessionId, LEASE_TTL_MS);
    if (!ok) throw new Error("Portal chat lease expired or was claimed by another agent. Reconnect with a new binding code.");
  }

  private async ensureRun(session: AgentSession): Promise<string> {
    if (session.runId) return session.runId;
    const chatId = this.requireConnected(session);
    const run = await this.db.createRun(chatId, "running");
    session.runId = run.id;
    return run.id;
  }

  async connect(session: AgentSession, bindingCode: string) {
    if (session.chatId) throw new Error("This MCP session is already connected to a portal chat.");
    const claimed = await this.db.connectBinding(bindingCode, session.agentSessionId, LEASE_TTL_MS);
    if (!claimed) throw new Error("Binding code is invalid, expired, already used, or the chat is currently connected elsewhere.");
    session.chatId = claimed.chatId;

    let chat = await this.db.getChat(claimed.chatId);
    if (!chat) throw new Error("Bound chat no longer exists.");
    const workspace = await this.db.getWorkspace(chat.workspaceId);
    if (!workspace) throw new Error("Bound workspace no longer exists.");

    if (chat.mode === "build") {
      const wt = await this.workspaces.ensureWorktree({ repoPath: workspace.rootPath, chatId: chat.id, baseBranch: workspace.defaultBranch });
      await this.db.updateChatWorktree(chat.id, wt.branch, wt.path);
      chat = (await this.db.getChat(chat.id))!;
    }

    const [messages, events, questions, threadState, attachments] = await Promise.all([
      this.db.listMessages(chat.id),
      this.db.listEvents(chat.id, 0, 10_000),
      this.db.listOpenQuestions(chat.id),
      this.db.getThreadState(chat.id),
      this.db.listAttachments(chat.id),
    ]);
    const canonicalMessages = messages.map(toHydrationMessage);
    const selected = selectHydration(canonicalMessages, this.contextPolicy);
    let contextMessages = selected.messages;
    let contextSummary = "";
    let contextStructured: Record<string, unknown> = {};
    let contextCompactedThrough = selected.compactedThroughSeq;
    let contextEstimatedTokens = selected.estimatedTokens;
    let needsCompaction = false;

    if (selected.mode === "compacted") {
      if (threadState?.summary && threadState.compactedThroughSeq !== null) {
        contextSummary = threadState.summary;
        contextStructured = threadState.structured;
        contextCompactedThrough = threadState.compactedThroughSeq;
        contextMessages = canonicalMessages.filter((message) => message.seq > threadState.compactedThroughSeq!);
        contextEstimatedTokens = estimateTextTokens(contextSummary)
          + estimateTextTokens(JSON.stringify(contextStructured))
          + contextMessages.reduce((sum, message) => sum + (message.estimatedTokens ?? estimateTextTokens(message.content) + 8), 0);
        needsCompaction = contextEstimatedTokens > selected.availableTokens;
      } else {
        needsCompaction = true;
      }
    }
    session.messageCursor = messages.at(-1)?.seq ?? 0;
    session.eventCursor = events.at(-1)?.seq ?? 0;

    await this.db.appendEvent({ chatId: chat.id, type: "agent.connected", payload: { agentSessionId: session.agentSessionId } });
    session.eventCursor += 1;

    return {
      workspace,
      chat,
      context: {
        mode: selected.mode,
        compactedThroughSeq: contextCompactedThrough,
        summary: contextSummary,
        structured: contextStructured,
        messages: contextMessages,
        estimatedTokens: contextEstimatedTokens,
        availableTokens: selected.availableTokens,
        needsCompaction,
      },
      questions,
      attachments: attachments.map(({ storagePath: _storagePath, ...attachment }) => attachment),
      cursors: { message: session.messageCursor, event: session.eventCursor },
    };
  }

  async sync(session: AgentSession) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    const [messages, events, questions, allAttachments] = await Promise.all([
      this.db.listMessages(chatId, session.messageCursor),
      this.db.listEvents(chatId, session.eventCursor, 1000),
      this.db.listOpenQuestions(chatId),
      this.db.listAttachments(chatId),
    ]);
    session.messageCursor = messages.at(-1)?.seq ?? session.messageCursor;
    session.eventCursor = events.at(-1)?.seq ?? session.eventCursor;
    const messageIds = new Set(messages.map((message) => message.id));
    const attachments = allAttachments.filter((attachment) => attachment.messageId && messageIds.has(attachment.messageId)).map(({ storagePath: _storagePath, ...attachment }) => attachment);
    return { messages, events, questions, attachments, cursors: { message: session.messageCursor, event: session.eventCursor } };
  }

  async activity(session: AgentSession, stage: string, message: string) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    const runId = await this.ensureRun(session);
    return this.db.appendEvent({ chatId, runId, type: "activity", payload: { stage, message: redactSecrets(message) } });
  }

  async ask(session: AgentSession, input: { kind: QuestionKind; prompt: string; options?: string[]; allowMultiple?: boolean; waitMs?: number }): Promise<QuestionRecord> {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    const runId = await this.ensureRun(session);
    const question = await this.db.createQuestion({ chatId, runId, kind: input.kind, prompt: input.prompt, options: input.options, allowMultiple: input.allowMultiple });
    await this.db.appendEvent({ chatId, runId, type: "question.created", payload: { questionId: question.id, kind: question.kind, prompt: question.prompt, options: question.options, allowMultiple: question.allowMultiple } });
    const waitMs = Math.min(Math.max(input.waitMs ?? 0, 0), 300_000);
    if (!waitMs) return question;
    await this.db.updateRun(runId, "waiting");
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const current = await this.db.getQuestion(question.id);
      if (current?.status === "answered") {
        await this.db.updateRun(runId, "running");
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await this.db.updateRun(runId, "running");
    return (await this.db.getQuestion(question.id)) ?? question;
  }

  private async resolveExecutionScope(session: AgentSession, cwd?: string) {
    const chatId = this.requireConnected(session);
    let chat = await this.db.getChat(chatId);
    if (!chat) throw new Error("Chat no longer exists.");
    const workspace = await this.db.getWorkspace(chat.workspaceId);
    if (!workspace) throw new Error("Workspace no longer exists.");
    if (chat.mode === "build" && !chat.worktreePath) {
      const wt = await this.workspaces.ensureWorktree({ repoPath: workspace.rootPath, chatId: chat.id, baseBranch: workspace.defaultBranch });
      await this.db.updateChatWorktree(chat.id, wt.branch, wt.path);
      chat = (await this.db.getChat(chat.id))!;
    }
    const scope = chat.mode === "build" ? chat.worktreePath! : workspace.rootPath;
    const candidate = cwd ? (cwd.startsWith("/") ? cwd : resolve(scope, cwd)) : scope;
    const [realScope, realCwd] = await Promise.all([realpath(scope), realpath(candidate)]);
    if (!isPathWithin(realScope, realCwd)) throw new Error(`cwd must remain inside the chat workspace (${realScope})`);
    return { chat, workspace, scope: realScope, cwd: realCwd };
  }

  async terminal(session: AgentSession, command: string, cwd?: string, timeoutMs?: number): Promise<ExecuteResult> {
    await this.heartbeat(session);
    const context = await this.resolveExecutionScope(session, cwd);
    if (context.chat.mode === "plan" && !isPlanSafeCommand(command)) {
      throw new Error("Plan mode blocks commands that may mutate the workspace. Switch this portal chat to Build mode to make changes.");
    }
    if (context.chat.mode === "review" && !isPlanSafeCommand(command)) {
      throw new Error("Review mode permits inspection commands only. Switch to Build mode to make changes.");
    }
    const runId = await this.ensureRun(session);
    const chatId = context.chat.id;
    await this.db.appendEvent({ chatId, runId, type: "command.started", payload: { command: redactSecrets(command), cwd: context.cwd } });
    const result = await executeCommand(command, {
      cwd: context.cwd,
      timeoutMs,
      onStdout: async (chunk) => { await this.db.appendEvent({ chatId, runId, type: "command.stdout", payload: { chunk: redactSecrets(chunk) } }); },
      onStderr: async (chunk) => { await this.db.appendEvent({ chatId, runId, type: "command.stderr", payload: { chunk: redactSecrets(chunk) } }); },
    });
    await this.db.appendEvent({ chatId, runId, type: "command.completed", payload: { command: redactSecrets(command), exitCode: result.exitCode, timedOut: result.timedOut } });
    if (context.chat.mode === "build" && context.chat.worktreePath) {
      const status = await this.workspaces.status(context.chat.worktreePath);
      if (status.short) await this.db.appendEvent({ chatId, runId, type: "files.changed", payload: status });
    }
    return result;
  }

  async history(session: AgentSession, input: { afterSeq?: number; beforeSeq?: number | null; limit?: number }) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    return this.db.listMessagesRange(chatId, input.afterSeq ?? 0, input.beforeSeq ?? null, Math.min(Math.max(input.limit ?? 100, 1), 500));
  }

  async historySearch(session: AgentSession, query: string, limit = 20) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    return this.db.searchMessages(chatId, query, Math.min(Math.max(limit, 1), 100));
  }

  async compact(session: AgentSession, input: { throughSeq: number; summary: string; structured?: Record<string, unknown> }) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    const messages = await this.db.listMessages(chatId);
    const latest = messages.at(-1)?.seq ?? 0;
    if (input.throughSeq < 0 || input.throughSeq > latest) throw new Error(`throughSeq must be between 0 and ${latest}`);
    const previous = await this.db.getThreadState(chatId);
    return this.db.updateThreadState(chatId, {
      compactedThroughSeq: input.throughSeq,
      summary: input.summary,
      structured: { ...(previous?.structured ?? {}), ...(input.structured ?? {}) },
    });
  }

  async attachment(session: AgentSession, attachmentId: string) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    const record = await this.db.getAttachment(attachmentId);
    if (!record || record.chatId !== chatId) throw new Error("Attachment not found in this chat.");
    const data = await readFile(record.storagePath);
    return { record, data };
  }

  async complete(session: AgentSession, input: { answer: string; summary: string; structured?: Record<string, unknown>; compactedThroughSeq?: number | null }) {
    await this.heartbeat(session);
    const chatId = this.requireConnected(session);
    const runId = await this.ensureRun(session);
    const message = await this.db.appendMessage({ chatId, role: "assistant", source: "agent", content: input.answer });
    session.messageCursor = message.seq;
    {
      const previous = await this.db.getThreadState(chatId);
      await this.db.updateThreadState(chatId, {
        compactedThroughSeq: input.compactedThroughSeq ?? message.seq,
        summary: input.summary,
        structured: { ...(previous?.structured ?? {}), ...(input.structured ?? {}) },
      });
    }
    const event = await this.db.appendEvent({ chatId, runId, type: "run.completed", payload: { messageId: message.id, summary: input.summary } });
    session.eventCursor = event.seq;
    await this.db.updateRun(runId, "completed");
    session.runId = null;
    return { message, event };
  }

  async disconnect(session: AgentSession) {
    if (!session.chatId) return;
    const chatId = session.chatId;
    try { await this.db.appendEvent({ chatId, type: "agent.disconnected", payload: { agentSessionId: session.agentSessionId } }); } catch {}
    await this.db.releaseLease(chatId, session.agentSessionId);
    session.chatId = null;
    session.runId = null;
  }
}
