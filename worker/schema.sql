-- Mint Voicemail schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS voicemails (
  id                    TEXT PRIMARY KEY,
  call_sid              TEXT UNIQUE,
  recording_sid         TEXT,
  from_number           TEXT NOT NULL,
  from_name             TEXT,              -- CNAM caller ID, when Twilio has it
  from_city             TEXT,
  from_state            TEXT,
  to_number             TEXT,
  duration_sec          INTEGER DEFAULT 0,
  r2_key                TEXT,              -- object key in the AUDIO bucket
  transcript            TEXT,
  transcript_status     TEXT DEFAULT 'pending',  -- pending | done | failed | skipped
  transcript_provider   TEXT,
  transcript_confidence REAL,
  is_read               INTEGER DEFAULT 0,
  is_saved              INTEGER DEFAULT 0,  -- saved items are exempt from trash purge
  deleted_at            INTEGER,            -- soft delete; NULL means live
  created_at            INTEGER NOT NULL,
  -- Caller grouping: which entity this message belongs to, plus the
  -- per-message details extracted from the transcript.
  caller_id             TEXT,
  caller_person         TEXT,
  caller_callback       TEXT,
  summary               TEXT,
  identify_status       TEXT DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_vm_created  ON voicemails (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_deleted  ON voicemails (deleted_at);
CREATE INDEX IF NOT EXISTS idx_vm_unread   ON voicemails (is_read, deleted_at);
CREATE INDEX IF NOT EXISTS idx_vm_caller   ON voicemails (caller_id);

-- Smart caller groups. A caller is a real-world entity that may reach you from
-- many numbers — agencies rotate them constantly — so identity is extracted
-- from what the caller says, and numbers attach to it as they are seen.
CREATE TABLE IF NOT EXISTS callers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,   -- normalized key used for matching
  category    TEXT,
  note        TEXT,
  -- Set when the user renames or recategorizes by hand; extraction must never
  -- overwrite a human correction.
  pinned      INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS caller_numbers (
  number      TEXT PRIMARY KEY,
  caller_id   TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_caller_numbers_caller ON caller_numbers (caller_id);

-- WebAuthn passkeys. The primary way in: nothing to forget.
CREATE TABLE IF NOT EXISTS credentials (
  id            TEXT PRIMARY KEY,   -- credential ID, base64url
  public_key    TEXT NOT NULL,      -- COSE public key, base64url
  counter       INTEGER DEFAULT 0,
  transports    TEXT,
  label         TEXT,               -- e.g. "iPhone", "YubiKey"
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- Failsafe #1: single-use recovery codes, stored only as PBKDF2 hashes.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- Failsafe #2: magic links, and short-lived WebAuthn challenges.
CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- reg | auth | magic
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ch_expires ON challenges (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen_at INTEGER,
  user_agent  TEXT,
  ip          TEXT,
  method      TEXT                  -- how this session was obtained
);

CREATE INDEX IF NOT EXISTS idx_sess_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Every auth-relevant event. Visible in the app so you can spot anything odd.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);

-- Brute-force protection for auth endpoints.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket    TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL
);

-- Small key/value bag: enrollment lock flag, etc.
CREATE TABLE IF NOT EXISTS app_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
