# Architecture

## Goal
A self-hosted Codex-like control plane that can bind individual portal chats to individual ChatGPT Web conversations through MCP, while retaining a future path to API-driven autonomous agents.

## Runtime boundaries
1. **portal-control** (non-privileged): HTTP API, auth, DB access, SSE, static web UI.
2. **mcp-gateway** (privileged): MCP OAuth + agent tools. Root-only execution stays here rather than in browser-facing code.
3. **PostgreSQL**: canonical durable state.
4. **Traefik (existing Coolify)**: public TLS/reverse proxy.

The existing `/opt/terminal-mcp` remains live until the v2 gateway is proven by tests.

## Identity hierarchy
`workspace -> chat -> run -> event`.

- Workspace: repository/project-level instructions and shared state.
- Chat: isolated conversation, mode, agent lease, worktree and full history.
- Run: one unit of agent execution.
- Event: durable activity stream item.

Browser-visible IDs are opaque prefixed IDs. One-time binding tokens are random, short-lived, stored hashed, and consumed atomically.

## Context policy
Canonical chat history is never discarded. A new agent connection receives the complete verbatim thread while it fits comfortably inside the configured hydration budget. Near the budget limit, only the oldest contiguous span is replaced in active context by structured compaction; all messages after the compaction boundary remain verbatim. Raw older history remains searchable/retrievable.

Continuous sync is cursor/delta based and does not resend already-hydrated history.

## Plan/Build/Review
- Plan: inspection/reasoning/questions; no intentional workspace writes.
- Build: modifications/tests/package operations allowed in a per-chat Git worktree.
- Review: primarily diff/status/tests/review; modifications are opt-in in later versions.

Plan mode includes structured Q&A. `chat_ask` creates a portal question card and may optionally long-poll briefly for an answer; otherwise `chat_sync` returns the answer later.

## Realtime model
All activity is persisted before broadcast. SSE replays events from a cursor after reconnect. Raw model chain-of-thought is never exposed; the portal displays observable activity: reading, commands, edits, tests, diffs, questions and completion.

## Concurrency
A chat has at most one active agent lease. Different chats can execute in parallel. Build chats use independent Git worktrees/branches so simultaneous agents cannot overwrite one another's files.

## Security
The public portal never receives root executor credentials, DB credentials or MCP secrets. MCP remains the privileged boundary. Browser auth is separate from MCP OAuth. Tool/UI output passes through secret redaction. Uploaded files are content-addressed and never auto-executed.
