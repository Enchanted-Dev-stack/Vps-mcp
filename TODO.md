# Vps-mcp Agent Portal — Implementation Tracker

This file is the canonical implementation checklist. Update it as work is completed or scope changes.

## Non-negotiable invariants
- [ ] Keep `/opt/terminal-mcp` operational until replacement passes smoke tests.
- [ ] Never expose root executor credentials or DB credentials to the browser.
- [ ] One ChatGPT/MCP lease per chat; different chats may run concurrently.
- [ ] Separate Git worktree per Build-mode chat to prevent edit collisions.
- [ ] Full canonical chat history is retained; compact only under context pressure.
- [ ] Plan mode must not intentionally modify workspace files.
- [ ] Portal can surface structured questions/answers to an agent.
- [ ] Persist events before broadcasting them to the UI.
- [ ] Redact likely secrets from activity/output shown in the portal.
- [ ] Unit/integration/smoke tests must pass before live MCP cutover.

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
- [ ] Fastify API and health/readiness endpoints.
- [ ] Admin authentication (Argon2 hash, HttpOnly Secure SameSite cookie, CSRF protection).
- [ ] Workspace CRUD.
- [ ] Chat CRUD / Plan-Build-Review mode.
- [ ] Message append/history APIs.
- [ ] One-time ChatGPT binding code issuance.
- [ ] Structured question create/answer APIs.
- [ ] Validation and authorization tests.

## Phase 4 — realtime event system
- [ ] Durable run/event persistence.
- [ ] SSE endpoint with replay from `Last-Event-ID`/sequence cursor.
- [ ] Run activity, command, file change, question, completion events.
- [ ] SSE disconnect/reconnect/no-duplicate integration tests.

## Phase 5 — clean Codex-like portal UI
- [ ] React/Vite app with compact sidebar and chat workspace.
- [ ] Workspace selector + chats.
- [ ] New workspace / new chat dialogs.
- [ ] Plan / Build / Review segmented mode switch.
- [ ] Chat history + composer.
- [ ] Agent connection badge + one-time binding-code dialog.
- [ ] Collapsible activity/tool cards.
- [ ] Structured question cards (single choice, multi choice, free text).
- [ ] Diff/run summary surfaces.
- [ ] Responsive/mobile basics.
- [ ] Playwright happy-path tests.

## Phase 6 — MCP gateway v2 (TDD)
- [ ] Preserve original `terminal(command,cwd?,timeout?)` behavior.
- [ ] OAuth/PKCE flow with persistent hashed access tokens.
- [ ] `chat_connect(binding_code)` — claim chat lease + hydration bundle.
- [ ] `chat_sync(cursor?)` — delta messages/events/answers.
- [ ] `chat_activity(stage,message)`.
- [ ] `chat_ask(question, options?, allow_multiple?, wait_ms?)`.
- [ ] `chat_terminal(command,cwd?,timeout?)` — chat-aware execution + event capture.
- [ ] `chat_complete(answer,summary?,todos?)`.
- [ ] Attachment metadata/fetch tool(s).
- [ ] MCP protocol integration tests with simulated client.

## Phase 7 — Git/worktree isolation
- [ ] Workspace repository registration/validation.
- [ ] Build-mode per-chat branch + worktree creation.
- [ ] Plan-mode read-only policy.
- [ ] Git status/diff capture into events.
- [ ] Concurrent same-file test proves Chat A/B isolation and unchanged base checkout.

## Phase 8 — attachments
- [ ] Content-addressed upload storage.
- [ ] MIME sniffing, name normalization, size limits, SHA-256 dedupe.
- [ ] Images/text/PDF/source/ZIP metadata flow.
- [ ] Path traversal and malicious filename tests.
- [ ] MCP attachment delivery.

## Phase 9 — context + compaction
- [ ] Canonical full chat retained permanently.
- [ ] Hydration sends full verbatim thread while safely within configured context budget.
- [ ] When threshold is reached, compact oldest span and keep all newer messages verbatim.
- [ ] Structured compaction state: goal, requirements, decisions, architecture, completed, in-progress, TODOs, known issues, important files/tests.
- [ ] Tool-output pruning/summaries while retaining raw persisted output.
- [ ] Older-history retrieval/search.
- [ ] 500-message reconnect/context-bound integration test.

## Phase 10 — production hardening
- [ ] Rate limits, CSP/security headers, XSS/HTML escaping.
- [ ] Secret redaction before UI persistence/broadcast.
- [ ] Path/symlink protections for workspace operations.
- [ ] Audit log.
- [ ] Crash/restart DB recovery tests.
- [ ] Large-output/hung-command tests.
- [ ] Dependency audit.

## Phase 11 — deployment + smoke tests
- [ ] Build production bundles.
- [ ] Install systemd units without replacing v1 first.
- [ ] Add Traefik portal/staging routes.
- [ ] `npm run smoke` validates portal, DB, auth, SSE, binding, MCP, terminal, questions, persistence.
- [ ] Restart candidate services and rerun smoke.
- [ ] Cut live MCP only after candidate passes.
- [ ] Verify rollback path.
- [ ] Final Git commit and push to origin.

## Later / V2
- [ ] AgentDriver abstraction.
- [ ] OpenAI Responses API worker for true portal-initiated autonomous runs.
- [ ] Background execution, retries/resume, notifications, scheduled runs.
- [ ] Interactive xterm/WebSocket terminal.
- [ ] TOTP/WebAuthn.
- [ ] Chat fork/merge/review UX.
