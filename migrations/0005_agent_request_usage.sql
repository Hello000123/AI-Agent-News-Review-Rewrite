CREATE TABLE agent_request_usage (
  user_id TEXT PRIMARY KEY,
  review_request_count INTEGER NOT NULL DEFAULT 0
    CHECK (review_request_count >= 0),
  rewrite_request_count INTEGER NOT NULL DEFAULT 0
    CHECK (rewrite_request_count >= 0),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
