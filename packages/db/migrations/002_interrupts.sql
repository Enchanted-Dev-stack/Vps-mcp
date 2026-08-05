CREATE TABLE IF NOT EXISTS run_interrupts (
  run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT 'User requested stop',
  requested_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS run_interrupts_chat_pending_idx ON run_interrupts(chat_id, requested_at DESC) WHERE acknowledged_at IS NULL;
