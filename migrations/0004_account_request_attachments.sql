CREATE TABLE account_request_attachments (
  id TEXT PRIMARY KEY,
  account_request_id TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (account_request_id) REFERENCES account_requests(id) ON DELETE CASCADE
);

CREATE INDEX account_request_attachments_request_index
  ON account_request_attachments(account_request_id);
