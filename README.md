# Vps-mcp Agent Portal

A self-hosted Codex-style coding control plane for a VPS. It combines a clean browser portal with an MCP gateway so an individual ChatGPT Web conversation can bind to an individual project chat, work in an isolated Git worktree, stream observable activity, ask structured questions, receive files/images, and mirror its final answer back into the portal.

## What is implemented

- Workspaces mapped to Git repositories on the VPS.
- Independent chats with **Plan / Build / Review** modes.
- One-time `bind_...` codes that bind one MCP session to one portal chat.
- One active agent lease per chat; different chats can run in parallel.
- Build-mode Git worktree + `agent/<chat-id>` branch isolation.
- Full canonical chat history with context-pressure compaction only when needed.
- Search/retrieval of older raw messages after compaction.
- Structured portal questions: text, confirm, single-choice, multi-choice.
- Live durable SSE activity: status, commands, stdout/stderr, file changes, questions, completion.
- Image/file attachments, content-addressed storage, MIME sniffing, dedupe and MCP delivery.
- Changes/diff and rolling run-summary surfaces in the web UI.
- OAuth authorization-code + PKCE for MCP; access tokens are stored hashed in Postgres.
- Browser auth with Argon2, HttpOnly/Secure/SameSite cookies, CSRF and rate limiting.
- Legacy unrestricted `terminal` remains available when the MCP session is not portal-bound. Once bound, it is disabled and the agent must use `chat_terminal`, so chat mode policy is applied.
- Unit, integration, official MCP-client, public smoke, restart and Playwright browser tests.

## Important ChatGPT Web limitation

MCP does **not** provide a mechanism for a server to create a new ChatGPT Web model turn. A message submitted in the portal is durably queued and returned by `chat_sync`, but it cannot wake an idle ChatGPT tab by itself.

For truly unattended portal-initiated runs, the planned V2 `AgentDriver`/OpenAI Responses API worker is the right path. The existing architecture deliberately keeps that future driver separate from the chat/workspace/event model.

## Context behavior

The portal stores the complete canonical thread permanently.

1. While the thread fits the configured budget, `chat_connect` hydrates the **entire chat verbatim**. A saved rolling summary is ignored.
2. Near context pressure, an older checkpoint summary replaces only the messages it covers; every message after that checkpoint stays verbatim.
3. `chat_history` and `chat_history_search` can retrieve compacted-out raw history at any time.
4. `chat_sync` is cursor-based and returns only new messages/events/answers after connection.

This matches the coding-agent pattern discussed for Codex/OpenCode: full detail first, compaction only when the context window requires it.

## MCP tools

- `terminal` — broad VPS terminal when the MCP session is **not** bound to a portal chat.
- `chat_connect(binding_code)`
- `chat_sync()`
- `chat_activity(stage, message)`
- `chat_ask(...)`
- `chat_terminal(command, cwd?, timeout?)`
- `chat_history(...)`
- `chat_history_search(query, limit?)`
- `chat_compact(...)`
- `chat_attachment(attachment_id)`
- `chat_complete(answer, summary, structured?, compacted_through_seq?)`
- `chat_disconnect()`

## Repository layout

```text
apps/
  api/        Fastify control API + auth + SSE + portal static hosting
  mcp/        Streamable HTTP MCP/OAuth gateway + chat agent service
  portal/     React/Vite Codex-style UI
packages/
  core/       IDs, modes, context policy, redaction
  db/         PostgreSQL migration/repository layer
  workspace/  Git repository/worktree/diff lifecycle
  attachments/content-addressed upload storage
tests/
  e2e/        Playwright browser happy path
  smoke/      public HTTPS portal → OAuth → MCP end-to-end smoke
docs/
  ARCHITECTURE.md
deploy/
  systemd/
  traefik/
TODO.md       canonical implementation tracker
```

## Development

Requirements: Node 22+, Docker, Git.

```bash
npm install
docker compose up -d postgres
```

On a fresh Docker volume, create/use a test database and set `TEST_DATABASE_URL`, then run:

```bash
TEST_DATABASE_URL=postgresql://... npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

Browser E2E:

```bash
E2E_BASE_URL=https://your-host \
E2E_ADMIN_PASSWORD='...' \
npm run e2e
```

Public smoke:

```bash
SMOKE_BASE_URL=https://your-host \
SMOKE_ADMIN_PASSWORD='...' \
SMOKE_OAUTH_PASSWORD='...' \
npm run smoke
```

The smoke runner creates a temporary Git repository, exercises Plan/Q&A/attachments/Build/worktree/completion, then deletes its chat/workspace/worktree.

## Deployment

The production deployment on the test VPS uses separate systemd services and the existing Coolify Traefik instance. Templates are under `deploy/`.

The original `/opt/terminal-mcp` is intentionally kept as a rollback/control MCP until the new connector is added in ChatGPT and explicitly cut over.

## Security notes

- Browser responses never include DB credentials, MCP OAuth password, executor credentials, or attachment storage paths.
- MCP access/session/binding tokens are stored hashed where persistence is required.
- Observable activity is secret-redacted; private model chain-of-thought is never sent to the portal.
- Plan/Review shell commands use a conservative inspection allowlist and reject redirections/subshells/mutating command families.
- Uploaded files are not auto-executed.
- The current disposable-VPS deployment runs the control API as root so it can validate arbitrary host repositories and clean Git worktrees; it exposes no generic shell route. For a multi-tenant/non-disposable server, split repository lifecycle into a narrow privileged helper and run the browser-facing API unprivileged.
