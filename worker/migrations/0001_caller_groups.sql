-- Smart caller groups.
--
-- A caller is a real-world entity — an agency, a clinic, a person — which may
-- reach you from many numbers. Debt collectors in particular rotate numbers
-- constantly, so grouping on the number would scatter one caller across a
-- dozen rows. Identity is extracted from what the caller says about themselves
-- in the transcript, and numbers are attached to it as they're seen.

CREATE TABLE IF NOT EXISTS callers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,          -- display name, e.g. "Meridian Recovery"
  slug         TEXT NOT NULL UNIQUE,   -- normalized key used for matching
  category     TEXT,                   -- debt_collection | sales | medical | ...
  note         TEXT,                   -- free text, user's own
  -- Set when the user renames or recategorizes a group by hand. Extraction
  -- must never overwrite a human correction — that's what makes it "learn".
  pinned       INTEGER DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS caller_numbers (
  number      TEXT PRIMARY KEY,        -- E.164
  caller_id   TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_caller_numbers_caller ON caller_numbers (caller_id);

ALTER TABLE voicemails ADD COLUMN caller_id TEXT;
ALTER TABLE voicemails ADD COLUMN caller_person TEXT;
ALTER TABLE voicemails ADD COLUMN caller_callback TEXT;
ALTER TABLE voicemails ADD COLUMN summary TEXT;
ALTER TABLE voicemails ADD COLUMN identify_status TEXT DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_vm_caller ON voicemails (caller_id);
