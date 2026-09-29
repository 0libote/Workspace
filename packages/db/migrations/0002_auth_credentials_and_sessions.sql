CREATE TABLE user_credentials (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_token TEXT NOT NULL CHECK (length(csrf_token) >= 32),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_active_user_idx ON auth_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;
