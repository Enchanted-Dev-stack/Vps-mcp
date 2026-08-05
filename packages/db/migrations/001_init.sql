CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON portal_sessions(expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  root_path text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  instructions text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('plan','build','review')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  branch text,
  worktree_path text,
  next_message_seq integer NOT NULL DEFAULT 1,
  next_event_seq integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chats_workspace_idx ON chats(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  role text NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  source text NOT NULL CHECK (source IN ('portal','agent','system')),
  content text NOT NULL,
  estimated_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_chat_seq_idx ON messages(chat_id, seq);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued','running','waiting','completed','failed','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_chat_created_idx ON runs(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id text REFERENCES runs(id) ON DELETE SET NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id, seq)
);
CREATE INDEX IF NOT EXISTS run_events_chat_seq_idx ON run_events(chat_id, seq);
CREATE INDEX IF NOT EXISTS run_events_run_idx ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS questions (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id text REFERENCES runs(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('text','single_choice','multi_choice','confirm')),
  prompt text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  allow_multiple boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','cancelled')),
  answer jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);
CREATE INDEX IF NOT EXISTS questions_chat_status_idx ON questions(chat_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_bindings (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_bindings_expiry_idx ON agent_bindings(expires_at);

CREATE TABLE IF NOT EXISTS agent_leases (
  chat_id text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_heartbeat timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_leases_expiry_idx ON agent_leases(expires_at);

CREATE TABLE IF NOT EXISTS thread_state (
  chat_id text PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  compacted_through_seq integer,
  summary text NOT NULL DEFAULT '',
  structured jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_chat_idx ON attachments(chat_id, created_at);
CREATE INDEX IF NOT EXISTS attachments_sha_idx ON attachments(sha256);

CREATE TABLE IF NOT EXISTS mcp_access_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_access_tokens_expiry_idx ON mcp_access_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
