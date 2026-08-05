import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChatAgentService, AgentSession } from "./chat-service.js";

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
function fail(error: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
}

export function createToolServer(session: AgentSession, agent: ChatAgentService): McpServer {
  const server = new McpServer({ name: "vps-agent", version: "2.1.0" });

  server.tool("chat_connect", "Connect this MCP session to a portal chat with a one-time binding code and hydrate its context. Stay attached: after handling available work, call chat_wait instead of ending the turn when possible.", {
    binding_code: z.string().min(1),
  }, async ({ binding_code }) => {
    try { return ok(await agent.connect(session, binding_code)); } catch (error) { return fail(error); }
  });

  server.tool("chat_sync", "Fetch new portal messages, events and open questions since the last cursor.", {}, async () => {
    try { return ok(await agent.sync(session)); } catch (error) { return fail(error); }
  });

  server.tool("chat_wait", "Wait for new portal messages, attachments, answers, or interruption without disconnecting. After a timeout, call chat_wait again to remain available.", {
    timeout_ms: z.number().int().min(1000).max(55000).optional(),
  }, async ({ timeout_ms }) => {
    try { return ok(await agent.wait(session, timeout_ms)); } catch (error) { return fail(error); }
  });

  server.tool("chat_activity", "Publish concise observable activity to the portal. Do not publish private chain-of-thought.", {
    stage: z.string().min(1).max(80), message: z.string().min(1).max(1000),
  }, async ({ stage, message }) => {
    try { return ok(await agent.activity(session, stage, message)); } catch (error) { return fail(error); }
  });

  server.tool("chat_ask", "Ask the portal user a structured question; optionally wait for an answer.", {
    kind: z.enum(["text", "single_choice", "multi_choice", "confirm"]),
    prompt: z.string().min(1).max(4000),
    options: z.array(z.string().max(1000)).max(50).optional(),
    allow_multiple: z.boolean().optional(),
    wait_ms: z.number().int().min(0).max(300000).optional(),
  }, async ({ kind, prompt, options, allow_multiple, wait_ms }) => {
    try { return ok(await agent.ask(session, { kind, prompt, options, allowMultiple: allow_multiple, waitMs: wait_ms })); } catch (error) { return fail(error); }
  });

  server.tool("chat_terminal", "Execute inside the connected chat workspace. Build uses an isolated worktree; Plan/Review are inspection-only.", {
    command: z.string().min(1), cwd: z.string().optional(), timeout: z.number().finite().optional(),
  }, async ({ command, cwd, timeout }) => {
    try { return ok(await agent.terminal(session, command, cwd, timeout)); } catch (error) { return fail(error); }
  });

  server.tool("chat_history", "Retrieve canonical raw messages from the connected portal chat by sequence range. History is never deleted by compaction.", {
    after_seq: z.number().int().min(0).optional(),
    before_seq: z.number().int().min(0).nullable().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }, async ({ after_seq, before_seq, limit }) => {
    try { return ok(await agent.history(session, { afterSeq: after_seq, beforeSeq: before_seq, limit })); } catch (error) { return fail(error); }
  });

  server.tool("chat_history_search", "Search the canonical full portal chat history for older details that may have been compacted out of active context.", {
    query: z.string().min(1).max(1000), limit: z.number().int().min(1).max(100).optional(),
  }, async ({ query, limit }) => {
    try { return ok(await agent.historySearch(session, query, limit)); } catch (error) { return fail(error); }
  });

  server.tool("chat_compact", "Store a rolling checkpoint summary through a message sequence. Raw messages remain permanently stored. Usually chat_complete maintains this automatically.", {
    through_seq: z.number().int().min(0),
    summary: z.string().min(1).max(100000),
    structured: z.record(z.string(), z.unknown()).optional(),
  }, async ({ through_seq, summary, structured }) => {
    try { return ok(await agent.compact(session, { throughSeq: through_seq, summary, structured })); } catch (error) { return fail(error); }
  });

  server.tool("chat_attachment", "Fetch an attachment from the connected portal chat. Images are returned as image content; text files as text; other files as embedded resources.", {
    attachment_id: z.string().min(1),
  }, async ({ attachment_id }) => {
    try {
      const { record, data } = await agent.attachment(session, attachment_id);
      if (record.mimeType.startsWith("image/")) return { content: [{ type: "image" as const, data: data.toString("base64"), mimeType: record.mimeType }] };
      if (record.mimeType.startsWith("text/") || ["application/json", "application/javascript", "application/xml"].includes(record.mimeType)) {
        return { content: [{ type: "text" as const, text: data.toString("utf8") }] };
      }
      return { content: [{ type: "resource", resource: { uri: `attachment://${record.id}/${encodeURIComponent(record.originalName)}`, mimeType: record.mimeType, blob: data.toString("base64") } }] } as any;
    } catch (error) { return fail(error); }
  });

  server.tool("chat_complete", "Mirror the final answer into the portal and complete the current run. After completion, call chat_wait to remain available for the next portal message when possible.", {
    answer: z.string().min(1).max(500000),
    summary: z.string().min(1).max(100000),
    structured: z.record(z.string(), z.unknown()).optional(),
    compacted_through_seq: z.number().int().min(0).nullable().optional(),
  }, async ({ answer, summary, structured, compacted_through_seq }) => {
    try { return ok(await agent.complete(session, { answer, summary, structured, compactedThroughSeq: compacted_through_seq })); } catch (error) { return fail(error); }
  });

  server.tool("chat_disconnect", "Release this MCP session's portal chat lease.", {}, async () => {
    try { await agent.disconnect(session); return ok({ ok: true }); } catch (error) { return fail(error); }
  });

  return server;
}
