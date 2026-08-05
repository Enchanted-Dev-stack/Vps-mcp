import { ulid } from "ulid";
import { z } from "zod";

export const workspaceModeSchema = z.enum(["plan", "build", "review"]);
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;

export const messageRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export interface ChatMessage {
  id: string;
  chatId: string;
  seq: number;
  role: MessageRole;
  content: string;
  estimatedTokens?: number;
  createdAt: string;
}

export type EntityPrefix =
  | "usr"
  | "ws"
  | "cht"
  | "msg"
  | "run"
  | "evt"
  | "qst"
  | "att"
  | "bind"
  | "lease"
  | "tok";

export function createId(prefix: EntityPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function allowsWorkspaceMutation(mode: WorkspaceMode): boolean {
  return mode === "build";
}

/**
 * Very small and intentionally conservative token estimator for context planning.
 * Exact model tokenization is provider-specific; this keeps enough safety margin
 * for hydration decisions without taking a tokenizer dependency.
 */
export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface HydrationPolicy {
  maxContextTokens: number;
  reservedTokens: number;
  compactionSummaryTokens: number;
}

export interface HydrationSelection {
  mode: "full" | "compacted";
  messages: ChatMessage[];
  compactedThroughSeq: number | null;
  estimatedTokens: number;
  availableTokens: number;
}

function tokensFor(message: ChatMessage): number {
  return (message.estimatedTokens ?? estimateTextTokens(message.content)) + 8;
}

/**
 * Keep the canonical thread verbatim while it fits. Once it does not, reserve
 * room for one structured summary and retain the newest contiguous message span
 * verbatim. The canonical older messages are never deleted; this only selects
 * what should hydrate a model session.
 */
export function selectHydration(
  inputMessages: readonly ChatMessage[],
  policy: HydrationPolicy,
): HydrationSelection {
  const messages = [...inputMessages].sort((a, b) => a.seq - b.seq);
  const availableTokens = Math.max(1, policy.maxContextTokens - policy.reservedTokens);
  const totalTokens = messages.reduce((sum, message) => sum + tokensFor(message), 0);

  if (totalTokens <= availableTokens || messages.length <= 1) {
    return {
      mode: "full",
      messages,
      compactedThroughSeq: null,
      estimatedTokens: totalTokens,
      availableTokens,
    };
  }

  const recentBudget = Math.max(1, availableTokens - policy.compactionSummaryTokens);
  const retained: ChatMessage[] = [];
  let retainedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]!;
    const cost = tokensFor(candidate);
    if (retained.length > 0 && retainedTokens + cost > recentBudget) break;
    retained.unshift(candidate);
    retainedTokens += cost;
    // Always retain the newest message even when it alone exceeds the budget.
    if (retained.length === 1 && retainedTokens > recentBudget) break;
  }

  // If the budget happened to keep everything, fall back to full. This can occur
  // only with unusual policies and avoids claiming a compaction boundary that
  // does not exist.
  if (retained.length >= messages.length) {
    return {
      mode: "full",
      messages,
      compactedThroughSeq: null,
      estimatedTokens: totalTokens,
      availableTokens,
    };
  }

  const firstRetained = retained[0]!;
  const compacted = messages.filter((message) => message.seq < firstRetained.seq);
  const compactedThroughSeq = compacted.at(-1)?.seq ?? null;

  return {
    mode: "compacted",
    messages: retained,
    compactedThroughSeq,
    estimatedTokens: retainedTokens + policy.compactionSummaryTokens,
    availableTokens,
  };
}

const bearerPattern = /(authorization\s*:\s*bearer\s+)([^\s"']+)/gi;
const assignmentPattern = /((?:password|passwd|pwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?key|secret|client[_-]?secret|openai_api_key|anthropic_api_key)\s*[:=]\s*)([^\s"']+)/gi;
const commonApiKeyPattern = /\b(sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,})\b/g;
const privateKeyPattern = /(-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----)/g;

export function redactSecrets(value: string): string {
  return value
    .replace(privateKeyPattern, "$1\n[REDACTED]\n$2")
    .replace(bearerPattern, "$1[REDACTED]")
    .replace(assignmentPattern, "$1[REDACTED]")
    .replace(commonApiKeyPattern, "[REDACTED]");
}

export const questionKindSchema = z.enum(["text", "single_choice", "multi_choice", "confirm"]);
export type QuestionKind = z.infer<typeof questionKindSchema>;

export const runStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const eventTypeSchema = z.enum([
  "agent.connected",
  "agent.disconnected",
  "activity",
  "command.started",
  "command.stdout",
  "command.stderr",
  "command.completed",
  "files.changed",
  "question.created",
  "question.answered",
  "run.completed",
  "run.failed",
  "run.interrupt.requested",
  "run.cancelled",
]);
export type EventType = z.infer<typeof eventTypeSchema>;
