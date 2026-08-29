-- Move internal state and secret keys out of the generic settings KV table
-- into a dedicated table so `SELECT * FROM settings` can never leak them.

CREATE TABLE IF NOT EXISTS internal_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO internal_state (key, value)
  SELECT key, value FROM settings
  WHERE key IN ('_admin_tokens', '_logo_filename', 'adminPassword', 'gmailTokens', 'gmailToken');

DELETE FROM settings WHERE key IN ('_admin_tokens', '_logo_filename', 'adminPassword', 'gmailTokens', 'gmailToken');
