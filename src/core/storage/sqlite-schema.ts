export const SQLITE_SCHEMA_VERSION = 4;

export const REMINDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reminders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    due_local    TEXT NOT NULL,
    text         TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'firing', 'delivered', 'cancelled')),
    source_kind  TEXT NOT NULL DEFAULT 'local' CHECK (source_kind IN ('local')),
    origin_mode  TEXT NOT NULL DEFAULT 'chat' CHECK (origin_mode IN ('chat', 'voice')),
    private_context INTEGER NOT NULL DEFAULT 1 CHECK (private_context IN (0, 1)),
    external_id  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    firing_at    TEXT,
    delivered_at TEXT,
    cancelled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_state ON reminders(state);
`;

export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS absolute_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS persistent_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '',
    rule       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule       TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at   TEXT,
    mode       TEXT NOT NULL DEFAULT 'ambient',
    summary    TEXT DEFAULT '',
    close_status TEXT NOT NULL DEFAULT 'open' CHECK (close_status IN ('open', 'completed', 'interrupted'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    turn_id         TEXT NOT NULL DEFAULT 'legacy',
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    timestamp       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_quarantine (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id     INTEGER,
    conversation_id INTEGER,
    turn_id         TEXT,
    role            TEXT,
    content         TEXT,
    timestamp       TEXT,
    reason          TEXT NOT NULL,
    quarantined_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS storage_quarantine (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table    TEXT NOT NULL,
    source_row_id   INTEGER,
    column_name     TEXT NOT NULL,
    ciphertext      TEXT NOT NULL,
    row_data        TEXT NOT NULL DEFAULT '{}',
    reason          TEXT NOT NULL,
    quarantined_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory_staging (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  INTEGER NOT NULL,
    turn_id          TEXT NOT NULL UNIQUE,
    source_content   TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
    attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_started_at TEXT,
    policy_terms     TEXT NOT NULL DEFAULT '',
    decision         TEXT CHECK (decision IN ('add', 'update', 'merge', 'supersede', 'ignore')),
    decision_topic_id INTEGER,
    result_memory_id INTEGER,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_topics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT,
    version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS curated_memories (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    source_staging_id      INTEGER UNIQUE,
    kind                   TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'episode', 'explicit')),
    content                TEXT NOT NULL,
    source_conversation_id INTEGER,
    source_turn_id         TEXT NOT NULL,
    confidence             REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    topic_id               INTEGER NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
    revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    superseded_by_id       INTEGER,
    created_by_action      TEXT NOT NULL DEFAULT 'legacy_import' CHECK (created_by_action IN ('legacy_import', 'add', 'update', 'merge', 'supersede', 'explicit', 'manual')),
    evidence               TEXT NOT NULL DEFAULT '',
    confirmation_count     INTEGER NOT NULL DEFAULT 1 CHECK (confirmation_count > 0),
    last_confirmed_at      TEXT,
    created_at             TEXT DEFAULT (datetime('now')),
    updated_at             TEXT DEFAULT (datetime('now')),
    deleted_at             TEXT,
    FOREIGN KEY (source_staging_id) REFERENCES memory_staging(id) ON DELETE SET NULL,
    FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
    FOREIGN KEY (topic_id) REFERENCES memory_topics(id) ON DELETE CASCADE,
    FOREIGN KEY (superseded_by_id) REFERENCES curated_memories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS memory_sources (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id              INTEGER NOT NULL,
    source_key             TEXT NOT NULL,
    source_type            TEXT NOT NULL CHECK (source_type IN ('turn', 'explicit', 'manual', 'legacy')),
    source_staging_id      INTEGER,
    source_conversation_id INTEGER,
    source_turn_id         TEXT,
    observed_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (memory_id, source_key),
    FOREIGN KEY (memory_id) REFERENCES curated_memories(id) ON DELETE CASCADE,
    FOREIGN KEY (source_staging_id) REFERENCES memory_staging(id) ON DELETE SET NULL,
    FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_curated_memories_topic_status
    ON curated_memories(topic_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_memory_sources_staging ON memory_sources(source_staging_id);
  CREATE INDEX IF NOT EXISTS idx_memory_sources_turn
    ON memory_sources(source_conversation_id, source_turn_id);

  CREATE TABLE IF NOT EXISTS learned_facts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL DEFAULT '',
    fact       TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source     TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT DEFAULT (datetime('now'))
  );
`;
