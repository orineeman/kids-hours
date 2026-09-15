-- Adds brute-force lockout tracking to the single parent account.
-- See auth logic in src/index.js's /api/login handler.
ALTER TABLE parent_users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parent_users ADD COLUMN locked_until INTEGER;
