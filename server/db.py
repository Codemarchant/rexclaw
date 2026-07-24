# Copyright 2026 Codemarchant
"""SQLite layer. One connection per request (cheap for SQLite), WAL mode so the
UI's read traffic never blocks a write. Schema is created on first boot;
ALTER-style migrations can be appended to MIGRATIONS later.

Datetimes are stored as ISO-8601 UTC strings ("YYYY-MM-DDTHH:MM:SS") — the
same naive-UTC convention the Odoo module used, so the ported service logic
(30-day response chains, retention cutoffs) carries over unchanged.
"""
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# Data dir: ./data next to the project root by default, override with
# REXCLAW_DATA_DIR. Holds the sqlite db + generated/uploaded files.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("REXCLAW_DATA_DIR", PROJECT_ROOT / "data"))
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "rexclaw.sqlite3"

ASSETS_DIR = PROJECT_ROOT / "assets"


def utcnow():
    """Naive-UTC ISO string, second resolution — the storage format."""
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")


def parse_dt(value):
    """ISO string → datetime (naive UTC), or None."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).rstrip("Z"))
    except ValueError:
        return None


SCHEMA = """
CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    xai_api_key TEXT,
    xai_realtime_url TEXT NOT NULL DEFAULT 'wss://api.x.ai/v1/realtime',
    xai_client_secrets_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/realtime/client_secrets',
    xai_responses_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/responses',
    xai_files_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/files',
    xai_images_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/images/generations',
    xai_images_edits_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/images/edits',
    xai_model TEXT NOT NULL DEFAULT 'grok-voice-latest',
    text_model TEXT NOT NULL DEFAULT 'grok-latest',
    summary_model TEXT NOT NULL DEFAULT 'grok-latest',
    -- Model for the group-call turn director (a one-token "who speaks next"
    -- classification on every group-call turn). Latency matters more than
    -- intelligence — use the fastest non-reasoning model available. Empty =
    -- fall back to the Text Model.
    director_model TEXT NOT NULL DEFAULT 'grok-4.20-non-reasoning',
    imagine_model TEXT NOT NULL DEFAULT 'grok-imagine-image-quality-latest',
    default_agent_id INTEGER,
    user_display_name TEXT,
    include_user_name_in_prompt INTEGER NOT NULL DEFAULT 0,
    summary_threshold_tokens INTEGER NOT NULL DEFAULT 64000,
    summary_threshold_tokens_text INTEGER NOT NULL DEFAULT 1000000,
    summary_keep_recent_messages INTEGER NOT NULL DEFAULT 2,
    -- After each compaction, run a second pass that distils durable facts +
    -- one conversation episode from the rolled-up block. Off saves one model
    -- call per compaction (only `remember`-tool memories are kept then).
    enable_memory_extraction INTEGER NOT NULL DEFAULT 1,
    transcript_display_limit INTEGER NOT NULL DEFAULT 200,
    transcript_retention_days INTEGER NOT NULL DEFAULT 0,
    file_default_expiry_seconds INTEGER NOT NULL DEFAULT 2592000,
    -- Lifetime/today spend (USD) accrued from xAI's usage.cost_in_usd_ticks.
    -- Informational only in the standalone (it's the user's own key).
    spend_lifetime_usd REAL NOT NULL DEFAULT 0,
    spend_today_usd REAL NOT NULL DEFAULT 0,
    spend_today_date TEXT
);

CREATE TABLE IF NOT EXISTS avatars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Folder name of the avatar pack this row was loaded from (NULL for rows
    -- created by hand). The pack scanner upserts on this key every boot.
    pack_key TEXT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sequence INTEGER NOT NULL DEFAULT 10,
    description TEXT,
    vrm_path TEXT NOT NULL,            -- web path, e.g. /assets/vrm/eve.vrm or /files/...
    vrma_idle_path TEXT
);

CREATE TABLE IF NOT EXISTS avatar_outfits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 10,
    vrm_path TEXT NOT NULL,
    outfit_description TEXT
);

CREATE TABLE IF NOT EXISTS avatar_gestures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 10,
    gesture_enum TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    vrma_path TEXT NOT NULL,
    loop INTEGER NOT NULL DEFAULT 0,
    -- Combo (two-character) gestures: 'solo' plays vrma_path alone; 'combo'
    -- additionally loads a second VRM playing partner_vrma_path in sync.
    -- partner_avatar names an existing avatar (pack_key or display name,
    -- resolved at payload time so the renderer can borrow a live peer's
    -- model); partner_vrm_path is a dedicated model used when no avatar
    -- reference is set. Offsets are metres, rotations degrees applied
    -- yaw → pitch → roll on top of the face-the-camera orientation.
    gesture_type TEXT NOT NULL DEFAULT 'solo',
    partner_avatar TEXT,
    partner_vrm_path TEXT,
    partner_vrma_path TEXT,
    base_offset_x REAL NOT NULL DEFAULT 0,
    base_offset_y REAL NOT NULL DEFAULT 0,
    base_offset_z REAL NOT NULL DEFAULT 0,
    base_yaw REAL NOT NULL DEFAULT 0,
    base_pitch REAL NOT NULL DEFAULT 0,
    base_roll REAL NOT NULL DEFAULT 0,
    partner_offset_x REAL NOT NULL DEFAULT 0.6,
    partner_offset_y REAL NOT NULL DEFAULT 0,
    partner_offset_z REAL NOT NULL DEFAULT 0,
    partner_yaw REAL NOT NULL DEFAULT 0,
    partner_pitch REAL NOT NULL DEFAULT 0,
    partner_roll REAL NOT NULL DEFAULT 0,
    partner_scale REAL NOT NULL DEFAULT 1.0,
    UNIQUE (avatar_id, gesture_enum)
);

CREATE TABLE IF NOT EXISTS avatar_backgrounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    avatar_id INTEGER NOT NULL REFERENCES avatars(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 10,
    type TEXT NOT NULL DEFAULT 'static',   -- image | static | scene
    preset_style TEXT,
    image_path TEXT,
    scene_path TEXT,
    scene_scale REAL NOT NULL DEFAULT 1.0,
    scene_offset_x REAL NOT NULL DEFAULT 0,
    scene_offset_y REAL NOT NULL DEFAULT 0,
    scene_offset_z REAL NOT NULL DEFAULT 0,
    scene_rotation_y REAL NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sequence INTEGER NOT NULL DEFAULT 10,
    voice TEXT NOT NULL DEFAULT 'ara',   -- built-in voice name OR custom xAI voice id
    system_prompt TEXT NOT NULL,
    avatar_id INTEGER REFERENCES avatars(id) ON DELETE SET NULL,
    chat_thumbnail_path TEXT,
    reasoning_effort TEXT NOT NULL DEFAULT 'low',
    enable_voice_mode INTEGER NOT NULL DEFAULT 1,
    enable_text_mode INTEGER NOT NULL DEFAULT 1,
    enable_code_execution INTEGER NOT NULL DEFAULT 1,
    enable_gesture_emotion_tools INTEGER NOT NULL DEFAULT 1,
    enable_web_search INTEGER NOT NULL DEFAULT 1,
    enable_x_search INTEGER NOT NULL DEFAULT 1,
    enable_grok_imagine_tools INTEGER NOT NULL DEFAULT 1,
    enable_memory_tools INTEGER NOT NULL DEFAULT 1,
    core_memory_cap INTEGER NOT NULL DEFAULT 100,
    -- Group voice calls: enable_call_agents_tool exposes the
    -- add_agent_to_call / remove_agent_from_call browser tools so this agent
    -- can manage the group call; when_to_call_description is shown to OTHER
    -- agents inside their add_agent_to_call tool so they know when to bring
    -- this companion into a live call.
    enable_call_agents_tool INTEGER NOT NULL DEFAULT 1,
    when_to_call_description TEXT
);

CREATE TABLE IF NOT EXISTS mcp_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT,
    sequence INTEGER NOT NULL DEFAULT 10,
    active INTEGER NOT NULL DEFAULT 1,
    enable_for_voice INTEGER NOT NULL DEFAULT 1,
    enable_for_text INTEGER NOT NULL DEFAULT 1,
    server_url TEXT NOT NULL,
    server_label TEXT NOT NULL,
    server_description TEXT,
    allowed_tools TEXT,                -- newline-separated
    authorization TEXT,                -- bearer token
    headers TEXT                       -- JSON object
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    state TEXT NOT NULL DEFAULT 'draft',     -- draft | active | ended | errored
    -- The surface this session is CURRENTLY on: one conversation can move
    -- between voice and text (cross-mode resume flips this), so it tracks
    -- the latest surface, not where the session was born.
    mode TEXT NOT NULL DEFAULT 'voice',      -- voice | text
    started_at TEXT,
    ended_at TEXT,
    last_active_at TEXT,
    previous_response_id TEXT,
    last_response_at TEXT,
    -- Sequence high-water mark of the last message row already carried by the
    -- server-side response chain (previous_response_id). Rows above it (e.g.
    -- voice-surface turns after the last text response) are injected as input
    -- on the next chained text turn. 0 = no known baseline: chain without
    -- injection or replay the full local history.
    chain_tail_sequence INTEGER NOT NULL DEFAULT 0,
    pending_native_outputs_json TEXT,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    title_generated INTEGER NOT NULL DEFAULT 0,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_at_last_summary INTEGER NOT NULL DEFAULT 0,
    needs_summary INTEGER NOT NULL DEFAULT 0,
    -- Multi-agent voice calls: set on the sessions of agents added to an
    -- existing call, pointing at the primary session the call was started
    -- with (one primary session + N linked peer sessions).
    call_parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_recent ON sessions (mode, last_active_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL,                      -- system | user | assistant | tool_call | tool_result
    content TEXT,
    -- Agent name that spoke this line, for multi-agent group calls. Set on
    -- assistant rows: the session's own agent for its lines, another agent's
    -- name for lines mirrored in from other call legs. Empty in solo sessions.
    speaker TEXT,
    tool_name TEXT,
    tool_arguments_json TEXT,
    tool_result_json TEXT,
    xai_item_id TEXT,
    xai_call_id TEXT,
    xai_previous_item_id TEXT,
    is_summarized_into INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    is_summary_rollup INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, sequence, id);
CREATE INDEX IF NOT EXISTS idx_messages_call ON messages (session_id, xai_call_id);

CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    xai_file_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    mimetype TEXT,
    expires_at TEXT,
    uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,  -- NULL = global
    scope TEXT NOT NULL DEFAULT 'recall',    -- core | recall
    memory_type TEXT NOT NULL DEFAULT 'fact',-- fact | episode
    content TEXT NOT NULL,
    keywords TEXT,                           -- episode-only retrieval index (recall matches this, not the narrative)
    transcript TEXT,                         -- episode-only verbatim turns, stored inline so they survive message pruning
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,  -- episode-only provenance backlink
    tags TEXT,                               -- comma-separated, normalised lowercase
    source TEXT NOT NULL DEFAULT 'user_explicit',
    last_used_at TEXT,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope, agent_id);

CREATE TABLE IF NOT EXISTS imagine_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,                      -- background | image | edit
    prompt TEXT NOT NULL,
    image_path TEXT NOT NULL,                -- web path under /files
    mimetype TEXT,
    xai_model TEXT,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_imagine_agent ON imagine_images (agent_id, kind, created_at DESC);
"""


def connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False: FastAPI runs a sync dependency's setup, the
    # endpoint body, and the dependency's cleanup on (potentially) different
    # threadpool threads. Access is still strictly sequential within one
    # request — never concurrent — so disabling the guard is safe here.
    # timeout=30: how long a writer waits on a locked database before raising
    # "database is locked". The default 5s has been hit in the wild when one
    # request held the write lock across a slow operation while another wrote.
    con = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


# Idempotent ALTERs for databases created before a column existed. SQLite has
# no IF NOT EXISTS for columns, so each is try/except'd on the duplicate error.
MIGRATIONS = (
    "ALTER TABLE avatars ADD COLUMN pack_key TEXT",
    # Memory extraction (facts + episode rollups). Added columns default to the
    # pre-feature behaviour: existing rows become plain 'fact' memories.
    "ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'fact'",
    "ALTER TABLE memories ADD COLUMN keywords TEXT",
    "ALTER TABLE memories ADD COLUMN transcript TEXT",
    "ALTER TABLE memories ADD COLUMN session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL",
    "ALTER TABLE config ADD COLUMN enable_memory_extraction INTEGER NOT NULL DEFAULT 1",
    # Multi-agent group calls + turn director.
    "ALTER TABLE config ADD COLUMN director_model TEXT NOT NULL DEFAULT 'grok-4.20-non-reasoning'",
    "ALTER TABLE agents ADD COLUMN enable_call_agents_tool INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE agents ADD COLUMN when_to_call_description TEXT",
    "ALTER TABLE sessions ADD COLUMN call_parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL",
    "ALTER TABLE messages ADD COLUMN speaker TEXT",
    # Combo (two-character) gestures.
    "ALTER TABLE avatar_gestures ADD COLUMN gesture_type TEXT NOT NULL DEFAULT 'solo'",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_avatar TEXT",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_vrm_path TEXT",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_vrma_path TEXT",
    "ALTER TABLE avatar_gestures ADD COLUMN base_offset_x REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN base_offset_y REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN base_offset_z REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN base_yaw REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN base_pitch REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN base_roll REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_offset_x REAL NOT NULL DEFAULT 0.6",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_offset_y REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_offset_z REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_yaw REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_pitch REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_roll REAL NOT NULL DEFAULT 0",
    "ALTER TABLE avatar_gestures ADD COLUMN partner_scale REAL NOT NULL DEFAULT 1.0",
    # Unified voice/text conversations — cross-mode resume + chain-preserving
    # catch-up injection on the text Responses chain.
    "ALTER TABLE sessions ADD COLUMN chain_tail_sequence INTEGER NOT NULL DEFAULT 0",
)


def init_db():
    con = connect()
    try:
        con.executescript(SCHEMA)
        for stmt in MIGRATIONS:
            try:
                con.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists
        # Created here (not in SCHEMA) so it runs AFTER the pack_key migration
        # on pre-existing databases.
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_avatars_pack ON avatars (pack_key)")
        con.execute("INSERT OR IGNORE INTO config (id) VALUES (1)")
        con.commit()
    finally:
        con.close()


def get_config(con):
    return con.execute("SELECT * FROM config WHERE id = 1").fetchone()
