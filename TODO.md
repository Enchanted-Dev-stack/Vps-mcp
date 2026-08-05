# Vps-mcp Agent Portal — Implementation Tracker

This file is the canonical implementation checklist. Update it as work is completed or scope changes.

## Non-negotiable invariants
- [x] Keep `/opt/terminal-mcp` operational until replacement passes smoke tests.
- [x] Never expose root executor credentials or DB credentials to the browser.
- [x] One ChatGPT/MCP lease per chat; different chats may run concurrently.
- [x] Separate Git worktree per Build-mode chat to prevent edit collisions.
- [x] Full canonical chat history is retained; compact only under context pressure.
- [x] Plan mode must not intentionally modify workspace files.
- [x] Portal can surface structured questions/answers to an agent.
- [x] Persist events before broadcasting them to the UI.
- [x] Redact likely secrets from activity/output shown in the portal.
- [x] Unit/integration/smoke tests must pass before live MCP cutover.

## Phase 0 — bootstrap / safety
- [x] Clone `Enchanted-Dev-stack/Vps-mcp` into `/opt/vps-mcp`.
- [x] Configure repository Git identity.
- [x] Preserve existing `/opt/terminal-mcp` as untouched rollback/control MCP.
- [x] Create this tracker and architecture document.
- [x] Commit bootstrap.

## Phase 1 — monorepo + core domain (TDD)
- [x] npm workspaces and TypeScript configs.
- [x] Shared schemas/types for workspace/chat/message/run/event/question/binding.
- [x] ULID/UUID identifiers with typed prefixes (`ws_`, `cht_`, `run_`, etc.).
- [x] Context policy: full chat until threshold; oldest-span compaction metadata thereafter.
- [x] Secret redaction utility.
- [x] Tests for ID generation, redaction, context-window selection, mode policies.

## Phase 2 — PostgreSQL persistence (TDD + integration)
- [x] Postgres dev/prod container config.
- [x] SQL migrations for users/workspaces/chats/messages/attachments/runs/events/questions/bindings/leases/thread_state.
- [x] Repository layer with transactions and monotonic per-chat/per-run sequence numbers.
- [x] Tests for concurrent event ordering and binding token replay protection.
- [x] Lease claim/heartbeat/expiry tests.

## Phase 3 — Control API + authentication
- [x] Fastify API and health/readiness endpoints.
- [x] Admin authentication (Argon2 hash, HttpOnly Secure SameSite cookie, CSRF protection).
- [x] Workspace CRUD.
- [x] Chat CRUD / Plan-Build-Review mode.
- [x] Message append/history APIs.
- [x] One-time ChatGPT binding code issuance.
- [x] Structured question create/answer APIs.
- [x] Validation and authorization tests.

## Phase 4 — realtime event system
- [x] Durable run/event persistence.
- [x] SSE endpoint with replay from `Last-Event-ID`/sequence cursor.
- [x] Run activity, command, file change, question, completion events.
- [x] SSE disconnect/reconnect/no-duplicate integration tests.

## Phase 5 — clean Codex-like portal UI
- [x] React/Vite app with compact sidebar and chat workspace.
- [x] Workspace selector + chats.
- [x] Server-side VPS Git repository picker with approved-root containment.
- [x] New workspace / new chat dialogs.
- [x] Plan / Build / Review segmented mode switch.
- [x] Chat history + composer.
- [x] Agent connection badge + one-time binding-code dialog.
- [x] Collapsible activity/tool cards.
- [x] Structured question cards (single choice, multi choice, free text).
- [x] Diff/run summary surfaces.
- [x] Responsive/mobile basics.
- [x] Playwright happy-path tests.

## Phase 6 — MCP gateway v2 (TDD)
- [x] Preserve original `terminal(command,cwd?,timeout?)` behavior.
- [x] OAuth/PKCE flow with persistent hashed access tokens.
- [x] `chat_connect(binding_code)` — claim chat lease + hydration bundle.
- [x] `chat_sync(cursor?)` — delta messages/events/answers.
- [x] `chat_activity(stage,message)`.
- [x] `chat_ask(question, options?, allow_multiple?, wait_ms?)`.
- [x] `chat_terminal(command,cwd?,timeout?)` — chat-aware execution + event capture.
- [x] `chat_complete(answer,summary?,todos?)`.
- [x] Attachment metadata/fetch tool(s).
- [x] MCP protocol integration tests with simulated client.

## Phase 7 — Git/worktree isolation
- [x] Workspace repository registration/validation.
- [x] Build-mode per-chat branch + worktree creation.
- [x] Plan-mode read-only policy.
- [x] Git status/diff capture into events.
- [x] Concurrent same-file test proves Chat A/B isolation and unchanged base checkout.

## Phase 8 — attachments
- [x] Content-addressed upload storage.
- [x] MIME sniffing, name normalization, size limits, SHA-256 dedupe.
- [x] Images/text/PDF/source/ZIP metadata flow.
- [x] Path traversal and malicious filename tests.
- [x] MCP attachment delivery.

## Phase 9 — context + compaction
- [x] Canonical full chat retained permanently.
- [x] Hydration sends full verbatim thread while safely within configured context budget.
- [x] When threshold is reached, compact oldest span and keep all newer messages verbatim.
- [x] Structured compaction state: goal, requirements, decisions, architecture, completed, in-progress, TODOs, known issues, important files/tests.
- [x] Tool-output caps plus durable redacted event chunks; avoid persisting unbounded/secret-bearing raw output.
- [x] Older-history retrieval/search.
- [x] 500-message reconnect/context-bound integration test.

## Phase 10 — production hardening
- [x] Rate limits, CSP/security headers, XSS/HTML escaping.
- [x] Secret redaction before UI persistence/broadcast.
- [x] Path/symlink protections for workspace operations.
- [x] Audit log.
- [x] Crash/restart DB recovery tests.
- [x] Large-output/hung-command tests.
- [x] Dependency audit.

## Phase 11 — deployment + smoke tests
- [x] Candidate deployed at `https://agent.156.67.111.59.nip.io` with valid Let’s Encrypt TLS; v1 remains active separately.
- [x] End-to-end smoke runner implemented (portal → OAuth/PKCE → MCP → Plan/Q&A/Build/attachment/completion/cleanup).
- [x] Build production bundles.
- [x] Install systemd units without replacing v1 first.
- [x] Add Traefik portal/staging routes.
- [x] `npm run smoke` validates portal, DB, auth, SSE, binding, MCP, terminal, questions, persistence.
- [x] Restart candidate services and rerun smoke.
- [ ] User connects ChatGPT to the v2 MCP, then optionally retire/cut v1 (intentionally pending user-side connector switch).
- [x] Verify rollback path.
- [x] Final Git commit and push to origin.

## Later / V2
- [ ] AgentDriver abstraction.
- [ ] OpenAI Responses API worker for true portal-initiated autonomous runs.
- [ ] Background execution, retries/resume, notifications, scheduled runs.
- [ ] Interactive xterm/WebSocket terminal.
- [ ] TOTP/WebAuthn.
- [ ] Chat fork/merge/review UX.
