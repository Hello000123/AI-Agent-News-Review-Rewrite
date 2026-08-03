-- Client accounts are deactivated rather than deleted so existing request and
-- editorial records keep their references. The removed-client id is deliberately
-- not a foreign key: an audit record must survive any later retention cleanup.
CREATE TABLE client_removal_audit_records (
  id TEXT PRIMARY KEY,
  removed_client_user_id TEXT NOT NULL,
  client_email TEXT NOT NULL COLLATE NOCASE,
  actor_user_id TEXT NOT NULL,
  removal_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (email_status IN ('pending', 'sent', 'preview', 'failed')),
  provider_message_id TEXT,
  email_error_code TEXT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id)
);

CREATE INDEX client_removal_client_index
  ON client_removal_audit_records(removed_client_user_id, created_at DESC);

CREATE INDEX client_removal_actor_index
  ON client_removal_audit_records(actor_user_id, created_at DESC);
