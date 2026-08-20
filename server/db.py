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
    xai_videos_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/videos/generations',
    xai_model TEXT NOT NULL DEFAULT 'grok-voice-latest',
    text_model TEXT NOT NULL DEFAULT 'grok-latest',
    summary_model TEXT NOT NULL DEFAULT 'grok-latest',
    -- Model for the group-call turn director (a one-token "who speaks next"
    -- classification on every group-call turn). Latency matters more than
    -- intelligence — use the fastest non-reasoning model available. Empty =
    -- fall back to the Text Model.
    director_model TEXT NOT NULL DEFAULT 'grok-4.20-non-reasoning',
    imagine_model TEXT NOT NULL DEFAULT 'grok-imagine-image-quality-latest',
    -- xAI multi-agent model used when delegate_task is called with
    -- multi_agent=true. Several agents collaborate and a leader synthesizes
    -- — every sub-agent bills tokens, so it is markedly more expensive than
    -- a standard call. Effort maps to agent count: low/medium = 4 agents,
    -- high/xhigh = 16.
    multi_agent_model TEXT NOT NULL DEFAULT 'grok-4.20-multi-agent',
    multi_agent_effort TEXT NOT NULL DEFAULT 'low',
    -- Grok Imagine video generation (animated backgrounds + create_video).
    -- -1.5 is the default: it carries the current feature set (reference-to-
    -- video with reference images and preset voices, native 1080p), and the
    -- plain grok-imagine-video model stopped accepting requests in practice.
    imagine_video_model TEXT NOT NULL DEFAULT 'grok-imagine-video-1.5',
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
    -- Cost optimisation. xAI bills history replay per conversation.item.create
    -- ($0.004 each, regardless of item size), so resuming a long conversation
    -- costs real money — a 253-message session measured $1.01 every time it was
    -- resumed. With this on, everything older than replay_rollup_keep_recent
    -- messages is folded into ONE verbatim item instead of one item per
    -- message. Nothing is summarised away, but the folded turns lose their
    -- per-message role tagging, which may cost some conversational nuance —
    -- hence opt-in, and hence a verbatim tail that keeps recent turns intact.
    replay_rollup_enabled INTEGER NOT NULL DEFAULT 0,
    replay_rollup_keep_recent INTEGER NOT NULL DEFAULT 20,
    -- Voice activation ("hey Eve"): with this on, the browser keeps the mic
    -- open while NO call is live and spots the agents' wake phrases with a
    -- local (offline, unbilled) Vosk model — a match starts the call. The
    -- language picks which Vosk model the server downloads and serves.
    wake_word_enabled INTEGER NOT NULL DEFAULT 0,
    wake_word_language TEXT NOT NULL DEFAULT 'en',
    -- Auto-end a voice call after this many minutes with nothing happening
    -- (nobody spoke or typed, no companion turn, no tool run). xAI bills a
    -- realtime call by connection time, so a forgotten call is a bill that
    -- keeps running. 0 disables it. xAI drops a realtime session at 15
    -- minutes regardless, which is why the UI caps the field there.
    call_inactivity_minutes INTEGER NOT NULL DEFAULT 5,
    -- Keyboard shortcuts, as a JSON object of {action_id: "Ctrl+Alt+M"}.
    -- Empty/NULL means "use the built-in defaults" (web/src/lib/hotkeys.js
    -- owns the catalog); stored entries override per action, and "" unbinds
    -- one. hotkeys_global_enabled registers them OS-wide in the desktop app
    -- (the mascot overlay is normally unfocused, so page-level key handling
    -- would never see them).
    hotkeys_json TEXT,
    hotkeys_global_enabled INTEGER NOT NULL DEFAULT 1,
    transcript_display_limit INTEGER NOT NULL DEFAULT 200,
    transcript_retention_days INTEGER NOT NULL DEFAULT 0,
    file_default_expiry_seconds INTEGER NOT NULL DEFAULT 2592000,
    -- local_task working directory — the Grok Build CLI's blast-radius
    -- boundary. Empty = <data>/workspace (created on demand).
    local_task_workdir TEXT NOT NULL DEFAULT '',
    -- Minecraft bot sidecar: the text model that plans the bot's actions
    -- (empty = grok-4.20-non-reasoning), the stronger model used for hard
    -- directives like building (empty = grok-latest), and the in-game
    -- username of the user, so the bot knows whose orders outrank
    -- everyone else's.
    minecraft_brain_model TEXT NOT NULL DEFAULT '',
    minecraft_brain_model_hard TEXT NOT NULL DEFAULT '',
    minecraft_master TEXT NOT NULL DEFAULT '',
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
    vrma_idle_path TEXT,
    -- Fade explicit emotions back toward neutral a few seconds after the
    -- model sets them (otherwise the blendshape holds until the next call).
    emotion_decay INTEGER NOT NULL DEFAULT 1
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
    -- LLM backend for this companion. Only 'grok' exists today; the column
    -- (and the provider-vs-general tool split in the editor) is groundwork
    -- for a future OpenAI provider.
    provider TEXT NOT NULL DEFAULT 'grok',
    voice TEXT NOT NULL DEFAULT 'ara',   -- built-in voice name OR custom xAI voice id
    system_prompt TEXT NOT NULL,
    avatar_id INTEGER REFERENCES avatars(id) ON DELETE SET NULL,
    chat_thumbnail_path TEXT,
    reasoning_effort TEXT NOT NULL DEFAULT 'low',
    -- Legacy, ignored since the per-mode toggles were retired (every
    -- companion serves both surfaces). Kept so existing DBs stay valid.
    enable_voice_mode INTEGER NOT NULL DEFAULT 1,
    enable_text_mode INTEGER NOT NULL DEFAULT 1,
    enable_code_execution INTEGER NOT NULL DEFAULT 1,
    enable_gesture_emotion_tools INTEGER NOT NULL DEFAULT 1,
    -- Gates the recall_stories tool + its prompt section (which also
    -- self-gate on the companion having tagged lore stories at all).
    enable_lore_tool INTEGER NOT NULL DEFAULT 1,
    -- Optional per-companion style guides appended to the centrally-injected
    -- expression ambles (session_service._expression_section). Empty means
    -- the generic guidance stands alone. expression_style shapes
    -- set_emotion/play_gesture usage (rendered when avatar control tools are
    -- on); speech_tag_style shapes speech-tag usage (rendered for
    -- grok-provider companions — the tags are a Grok voice-API feature).
    expression_style TEXT,
    speech_tag_style TEXT,
    enable_web_search INTEGER NOT NULL DEFAULT 1,
    enable_x_search INTEGER NOT NULL DEFAULT 1,
    enable_grok_imagine_tools INTEGER NOT NULL DEFAULT 1,
    enable_memory_tools INTEGER NOT NULL DEFAULT 1,
    core_memory_cap INTEGER NOT NULL DEFAULT 100,
    -- Affection meter: a persistent score the companion nudges in small
    -- steps via the adjust_affection tool as the friendship warms or cools.
    -- affection_rules describe, per level, how behaviour should change;
    -- injected into the session prompt with the current standing. The scale
    -- is per-companion: max_score split into level_count tiers, at most
    -- max_delta movement per everyday tool call (max_delta_major for rare
    -- severity='major' relationship-defining events). Opt-in per companion.
    -- Score starts mid-Guarded (150) so a fresh relationship has a buffer
    -- above the level-1 Cold zone in both directions.
    enable_affection_tool INTEGER NOT NULL DEFAULT 0,
    affection_animations INTEGER NOT NULL DEFAULT 1,
    affection_score INTEGER NOT NULL DEFAULT 150,
    affection_rules TEXT,
    affection_max_score INTEGER NOT NULL DEFAULT 1000,
    affection_level_count INTEGER NOT NULL DEFAULT 10,
    affection_max_delta INTEGER NOT NULL DEFAULT 5,
    affection_max_delta_major INTEGER NOT NULL DEFAULT 200,
    -- delegate_task: hand file/image analysis, coding and deep research to
    -- a background text-mode task session. The multi-agent flag additionally
    -- allows multi_agent=true calls on the (much pricier) xAI multi-agent
    -- model — off by default.
    enable_delegate_tool INTEGER NOT NULL DEFAULT 1,
    enable_multi_agent_delegation INTEGER NOT NULL DEFAULT 0,
    -- local_task: drive the Grok Build CLI headlessly on the user's machine
    -- (real files + shell in the workspace folder). Powerful → opt-in.
    enable_local_tasks INTEGER NOT NULL DEFAULT 0,
    -- Minecraft bot: direct the mineflayer sidecar
    -- (game_integrations/minecraft/ folder).
    -- Runs LLM-generated scripts against the user's world → opt-in.
    enable_minecraft INTEGER NOT NULL DEFAULT 0,
    -- Group voice calls: enable_call_agents_tool exposes the
    -- add_agent_to_call / remove_agent_from_call browser tools so this agent
    -- can manage the group call; when_to_call_description is shown to OTHER
    -- agents inside their add_agent_to_call tool so they know when to bring
    -- this companion into a live call.
    enable_call_agents_tool INTEGER NOT NULL DEFAULT 1,
    when_to_call_description TEXT,
    -- end_call: lets the companion hang up when the user asks it to
    -- ("end the call", "goodnight") — the browser drains the goodbye
    -- before disconnecting.
    enable_end_call_tool INTEGER NOT NULL DEFAULT 1,
    -- Voice activation: with standby listening on (config.wake_word_enabled),
    -- hearing this phrase while no call is live starts one with this
    -- companion. wake_action picks what "starts" means: 'resume_last'
    -- continues the latest conversation, 'start_new' begins fresh.
    wake_phrase TEXT,
    wake_action TEXT NOT NULL DEFAULT 'resume_last'
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
    -- 'manual' sessions are started interactively by the user; 'delegated'
    -- sessions are background task workspaces spawned by the delegate_task
    -- tool — hidden from the history/resume lists, continued across turns
    -- via the tool, and left active so follow-ups work without ceremony.
    origin TEXT NOT NULL DEFAULT 'manual',   -- manual | delegated
    -- For delegated task sessions: the interactive session whose
    -- delegate_task call spawned this workspace.
    delegate_parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
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
    uploaded_at TEXT,
    -- Library copy created at upload time for image attachments (kind
    -- 'upload'). Lets the model keep editing/animating the image via
    -- create_image/create_video source refs after the turn has passed —
    -- the xAI file id alone expires with the chain and is invisible to
    -- those tools.
    imagine_image_id INTEGER REFERENCES imagine_images(id) ON DELETE SET NULL
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

-- Lore stories: a shared archive of authored stories about the companions'
-- pasts, recalled on demand via the recall_stories tool. characters is a
-- JSON array of plain character NAMES on purpose (not agent FKs): an
-- imported story may name companions this install doesn't have, and the
-- tag simply stays in the array. A companion's archive = every entry whose
-- characters array contains their name.
CREATE TABLE IF NOT EXISTS lore_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',  -- one line: who, plot, roughly when
    characters TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',       -- JSON array, lowercase topic tags
    story TEXT NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS imagine_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
    -- background | image | edit | video | background_video | selfie |
    -- upload | screenshot | screen_clip ('upload' = any user-shared file —
    -- image, video or document — ingested at upload time from either
    -- mode's paperclip or drag-and-drop; 'screenshot'/'screen_clip' come
    -- from the take_screenshot / record_screen_clip tools over the user's
    -- armed screen share)
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    image_path TEXT NOT NULL,                -- web path under /files
    mimetype TEXT,
    xai_model TEXT,
    created_at TEXT,
    -- Last known /v1/files id for this file, cached from upload so tools
    -- can reuse it without re-uploading; may be expired — ensure_xai_file
    -- checks and refreshes from the local bytes.
    xai_file_id TEXT,
    xai_file_expires_at TEXT
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
    # Grok Imagine video (animated backgrounds + create_video).
    "ALTER TABLE config ADD COLUMN xai_videos_url TEXT NOT NULL DEFAULT 'https://api.x.ai/v1/videos/generations'",
    "ALTER TABLE config ADD COLUMN imagine_video_model TEXT NOT NULL DEFAULT 'grok-imagine-video-1.5'",
    # Text-mode image uploads ingested into the Imagine library at upload
    # time — the attachment row keeps a link to its library copy so the
    # refs resurface on replay/resume.
    "ALTER TABLE message_attachments ADD COLUMN imagine_image_id INTEGER REFERENCES imagine_images(id) ON DELETE SET NULL",
    # delegate_task background analyst: hidden 'delegated' task sessions
    # linked to the conversation that spawned them, per-agent enable flags,
    # and the configurable multi-agent model/effort.
    "ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE sessions ADD COLUMN delegate_parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL",
    "ALTER TABLE agents ADD COLUMN enable_delegate_tool INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE agents ADD COLUMN enable_multi_agent_delegation INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE config ADD COLUMN multi_agent_model TEXT NOT NULL DEFAULT 'grok-4.20-multi-agent'",
    "ALTER TABLE config ADD COLUMN multi_agent_effort TEXT NOT NULL DEFAULT 'low'",
    # Files library: every upload is ingested with a durable ref; the
    # upload's xAI file id + expiry are cached on the row so tools reuse a
    # still-valid id and re-upload from the local copy only when it lapsed.
    "ALTER TABLE imagine_images ADD COLUMN xai_file_id TEXT",
    "ALTER TABLE imagine_images ADD COLUMN xai_file_expires_at TEXT",
    # Resume rollup: fold old history into one replayed item to dodge xAI's
    # per-item replay charge. Off by default — it trades context fidelity for
    # cost, and existing conversations should not change behaviour on upgrade.
    "ALTER TABLE config ADD COLUMN replay_rollup_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE config ADD COLUMN replay_rollup_keep_recent INTEGER NOT NULL DEFAULT 20",
    # Idle-call auto-hangup + configurable keyboard shortcuts.
    "ALTER TABLE config ADD COLUMN call_inactivity_minutes INTEGER NOT NULL DEFAULT 5",
    "ALTER TABLE config ADD COLUMN hotkeys_json TEXT",
    "ALTER TABLE config ADD COLUMN hotkeys_global_enabled INTEGER NOT NULL DEFAULT 1",
    # Agent-initiated hangup + voice-activated call start (wake phrases).
    "ALTER TABLE agents ADD COLUMN enable_end_call_tool INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE agents ADD COLUMN wake_phrase TEXT",
    "ALTER TABLE agents ADD COLUMN wake_action TEXT NOT NULL DEFAULT 'resume_last'",
    "ALTER TABLE config ADD COLUMN wake_word_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE config ADD COLUMN wake_word_language TEXT NOT NULL DEFAULT 'en'",
    # Backfill default wake phrases on the preset companions of existing
    # installs. Effectively one-shot despite running every boot: the UI
    # stores a cleared phrase as '' (not NULL), so IS NULL only matches
    # rows the user has never touched.
    "UPDATE agents SET wake_phrase = 'hey ' || lower(name) "
    "WHERE wake_phrase IS NULL AND name IN ('Eve', 'Ara', 'Rex', 'Sal', 'Leo')",
    # local_task: headless Grok Build CLI runs on the user's machine.
    # Opt-in per agent; configurable working directory (empty = default).
    "ALTER TABLE agents ADD COLUMN enable_local_tasks INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE config ADD COLUMN local_task_workdir TEXT NOT NULL DEFAULT ''",
    # Per-avatar emotion decay (settle back toward neutral after the beat).
    # On by default — replaces the old hardcoded Eve/Leo/Ara-only softening.
    "ALTER TABLE avatars ADD COLUMN emotion_decay INTEGER NOT NULL DEFAULT 1",
    # Minecraft bot sidecar: per-agent opt-in + brain model + master player.
    "ALTER TABLE agents ADD COLUMN enable_minecraft INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE config ADD COLUMN minecraft_brain_model TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE config ADD COLUMN minecraft_master TEXT NOT NULL DEFAULT ''",
    # Minecraft bot: stronger planning model for hard directives (building,
    # long crafting chains) — the brain also escalates to it on retries.
    "ALTER TABLE config ADD COLUMN minecraft_brain_model_hard TEXT NOT NULL DEFAULT ''",
    # Affection meter (opt-in per companion): persistent score + per-level
    # behaviour rules injected into the session prompt, with a per-companion
    # scale (max score / level count / max delta per tool call).
    "ALTER TABLE agents ADD COLUMN enable_affection_tool INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN affection_score INTEGER NOT NULL DEFAULT 150",
    "ALTER TABLE agents ADD COLUMN affection_rules TEXT",
    "ALTER TABLE agents ADD COLUMN affection_max_score INTEGER NOT NULL DEFAULT 1000",
    "ALTER TABLE agents ADD COLUMN affection_level_count INTEGER NOT NULL DEFAULT 10",
    "ALTER TABLE agents ADD COLUMN affection_max_delta INTEGER NOT NULL DEFAULT 5",
    # Severity tier: much wider clamp for rare relationship-defining events.
    "ALTER TABLE agents ADD COLUMN affection_max_delta_major INTEGER NOT NULL DEFAULT 200",
    # Sub-setting: play the heart effect on score changes (meter works
    # invisibly with this off).
    "ALTER TABLE agents ADD COLUMN affection_animations INTEGER NOT NULL DEFAULT 1",
    # Start bump 100 -> 150 (mid-Guarded). One-shot in practice: only rows
    # whose meter was never enabled still sit at the old untouched default.
    "UPDATE agents SET affection_score = 150 "
    "WHERE affection_score = 100 AND enable_affection_tool = 0",
    # Per-companion LLM backend — groundwork for a future OpenAI provider.
    "ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'grok'",
    # Per-companion style guides for the centrally-injected expression ambles.
    "ALTER TABLE agents ADD COLUMN expression_style TEXT",
    "ALTER TABLE agents ADD COLUMN speech_tag_style TEXT",
    # Lore stories tool toggle + the description/tags columns (for DBs that
    # created the table before those columns existed).
    "ALTER TABLE agents ADD COLUMN enable_lore_tool INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE lore_entries ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE lore_entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
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


def shipped_column_defaults(table, fields):
    """Column defaults for `fields` of `table` as THIS version of the SCHEMA
    declares them, typed (INTEGER → int, quoted TEXT → str, no default →
    None). Read from a throwaway in-memory database, not the user's file:
    SQLite freezes a column's default at the moment the column was created,
    so an existing install's PRAGMA still reports whatever db.py said back
    then."""
    mem = sqlite3.connect(":memory:")
    try:
        mem.executescript(SCHEMA)
        out = {}
        for _cid, name, ctype, _notnull, dflt, _pk in mem.execute(f"PRAGMA table_info({table})"):
            if name not in fields:
                continue
            if dflt is None or dflt.upper() == "NULL":
                out[name] = None
            elif dflt.startswith("'"):
                out[name] = dflt.strip("'")
            elif ctype.upper().startswith("INT"):
                out[name] = int(dflt)
            else:
                out[name] = dflt
        return out
    finally:
        mem.close()


def get_config(con):
    return con.execute("SELECT * FROM config WHERE id = 1").fetchone()
