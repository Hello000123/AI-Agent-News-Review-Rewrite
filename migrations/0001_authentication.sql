PRAGMA foreign_keys = ON;

CREATE TABLE account_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  company TEXT NOT NULL,
  department TEXT NOT NULL,
  job_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by TEXT,
  decided_at INTEGER,
  rejection_reason TEXT,
  decision_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (decided_by) REFERENCES users(id)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  full_name TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  department TEXT,
  job_title TEXT,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('client', 'employee')),
  status TEXT NOT NULL CHECK (status IN ('setup_pending', 'active', 'disabled')),
  account_request_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  password_set_at INTEGER,
  FOREIGN KEY (account_request_id) REFERENCES account_requests(id)
);

CREATE UNIQUE INDEX account_requests_pending_email_unique
  ON account_requests(email)
  WHERE status = 'pending';

CREATE INDEX account_requests_status_created_index
  ON account_requests(status, created_at DESC);

CREATE TABLE password_setup_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  invalidated_at INTEGER,
  consumed_by_session_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX password_setup_tokens_user_index
  ON password_setup_tokens(user_id, created_at DESC);

CREATE INDEX password_setup_tokens_expiry_index
  ON password_setup_tokens(expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ip_hash TEXT,
  user_agent_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX sessions_user_index ON sessions(user_id, created_at DESC);
CREATE INDEX sessions_expiry_index ON sessions(expires_at);

CREATE TABLE approval_audit_records (
  id TEXT PRIMARY KEY,
  account_request_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL
    CHECK (action IN ('approved', 'rejected', 'setup_email_resent')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_request_id) REFERENCES account_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX approval_audit_request_index
  ON approval_audit_records(account_request_id, created_at DESC);

CREATE TABLE login_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('email_ip', 'ip')),
  attempt_count INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX login_rate_limits_cleanup_index
  ON login_rate_limits(updated_at);

CREATE TABLE email_delivery_records (
  id TEXT PRIMARY KEY,
  account_request_id TEXT,
  message_type TEXT NOT NULL
    CHECK (message_type IN ('new_request', 'approved_setup', 'rejected')),
  recipient TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL CHECK (status IN ('sent', 'preview', 'failed')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY (account_request_id) REFERENCES account_requests(id) ON DELETE SET NULL
);

CREATE INDEX email_delivery_request_index
  ON email_delivery_records(account_request_id, created_at DESC);
