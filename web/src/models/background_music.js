/**
 * Background music in calls (server/call_music.py serves the tracks).
 *
 *   playing   one <audio> per track on its own AudioContext, levelled from
 *             the track's measured loudness to the server's idle level,
 *             crossfading on a change; a volume on top. A single track
 *             loops; a playlist crossfades into its next track a fade's
 *             length before the end, and starts over after the last
 *   ducking   dips under every voice in the call, the companions' (any leg
 *             with audio queued) and the user's (server VAD), with the
 *             audio studio's ducker timing; silent while a karaoke song
 *             plays (stage.js holds it)
 *   who       the companion (play_background_music), the user (the ♪
 *             panel, the mascot's Songs tab), a background that names a
 *             track or playlist (switched to in a call), or the call
 *             opening, when "Start music when a call starts" is on
 *             (config.music_on_call_start). The companion gets a hidden
 *             note when anyone but them changes it.
 *
 * Lives in whichever window holds the call (the main window or the mascot)
 * and stops with the call.
 */
import { reactive } from "../lib/reactive";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";

const VOLUME_KEY = "rexclaw.backgroundMusic.volume";
// Events that count as a tap for WebKit's audio unlock (see the constructor).
const UNLOCK_EVENTS = ["touchend", "pointerup", "click", "keydown"];
// WebKit (Safari, and every browser on iOS/iPadOS) wants the tap for each
// media element; Chromium (Electron, Chrome, Android) remembers any earlier
// tap on the page, so it needs no unlock ahead of time.
const NEEDS_TAP_UNLOCK = typeof navigator !== "undefined"
    && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Electron/.test(navigator.userAgent);
// A tenth of a second of silence (8 kHz, 8-bit mono WAV), played to unlock
// the layers' elements.
const SILENT_WAV = (() => {
    const n = 800;
    const bytes = new Uint8Array(44 + n);
    const view = new DataView(bytes.buffer);
    const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, 36 + n, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true);
    view.setUint16(34, 8, true); text(36, "data"); view.setUint32(40, n, true);
    bytes.fill(128, 44);
    return "data:audio/wav;base64," + btoa(String.fromCharCode(...bytes));
})();
const DEFAULT_VOLUME = 50;
// Design: volume 50 plays at the server's idle level; each step is 0.32 dB,
// so 100 lifts it 16 dB, to the voice's own level, and 1 drops it 16 dB.
const DB_PER_STEP = 0.32;
const TICK_MS = 50;
const PLAYLIST_REF = "playlist:";   // a background's music naming a playlist

const dbToGain = (db) => Math.pow(10, db / 20);
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function readVolume() {
    try {
        const v = Number(localStorage.getItem(VOLUME_KEY));
        return v >= 1 && v <= 100 ? v : DEFAULT_VOLUME;
    } catch (e) {
        return DEFAULT_VOLUME;
    }
}

class BackgroundMusic {
    constructor() {
        this.state = reactive({
            status: "idle",       // idle | loading | playing
            track: null,          // {name, url, credit, source}
            playlist: null,       // {name} while a playlist plays
            by: "",               // who started it: "you", "scene", "call" or a companion's name
            volume: readVolume(),
            error: "",
        });
        this._levels = null;
        this._ctx = null;
        this._layers = null;      // the two crossfade layers, {el, src, gain, …} (_graph)
        this._layer = null;       // the one playing
        this._queue = null;       // {name, tracks, index} while a playlist plays
        this._call = null;        // the VoiceService while a call holds the music
        this._agentId = null;
        this._token = 0;
        this._timer = null;
        this._ducked = null;
        this._held = false;
        this._retry = null;       // a start the browser blocked, run again after the next tap
        if (typeof window !== "undefined") {
            window.addEventListener("rexclaw:background-switched", (e) => this._onBackground(e.detail));
            // iOS/iPadOS WebKit lets audio start only inside a tap: an
            // AudioContext made outside one stays suspended, and a media
            // element's first play() outside one fails with NotAllowedError.
            // Music starts after server round-trips (the call opening, the
            // companion's tool, a background switch), never inside a tap. So
            // the first tap anywhere unlocks the context and both layers'
            // elements, which may then play at any time.
            for (const type of UNLOCK_EVENTS) document.addEventListener(type, () => this._unlock(), true);
        }
    }

    /** A companion's music: {tracks, playlists, levels, start_on_call}. */
    async library(agentId) {
        const r = await rpc("/api/music/tracks", { agent_id: agentId ?? null });
        this._levels = r.levels;
        return r;
    }

    // ------------------------------------------------------------------
    // Playback
    // ------------------------------------------------------------------

    /** One track, looping. True once it plays; false when a newer start
     *  or a stop took over meanwhile. */
    async play(track, { by = "you", note = true } = {}) {
        this._queue = null;
        const started = await this._start(track, { by, note, loop: true });
        if (started && note && by !== "companion") this._tellStarted(`"${track.name}"`, by);
        return started;
    }

    /** A playlist ({name, tracks}): each track in turn, round and round.
     *  True once it plays, like play(). */
    async playPlaylist(playlist, { by = "you", note = true, index = 0 } = {}) {
        const tracks = playlist.tracks || [];
        if (!tracks.length) return false;
        this._queue = { name: playlist.name, tracks, index: index % tracks.length };
        const started = await this._start(tracks[this._queue.index], { by, note, loop: tracks.length === 1 });
        if (started && note && by !== "companion") this._tellStarted(`the playlist "${playlist.name}"`, by);
        return started;
    }

    /** True once the track plays; false when a newer start or a stop took
     *  over meanwhile. Throws when it could not be played. */
    async _start(track, { by, loop }) {
        const token = ++this._token;
        this._retry = null;
        Object.assign(this.state, { status: "loading", error: "" });
        try {
            if (!this._levels) await this.library(this._agentId);
            let gainDb = 0;
            try {
                const { lufs } = await rpc("/api/music/loudness", { url: track.url });
                if (lufs != null) gainDb = this._levels.idle_lufs - lufs;
            } catch (e) { /* unmeasured: play as it is */ }
            if (token !== this._token) return false;
            const ctx = this._graph();
            // The layer not playing now; it may still be fading out a track
            // from a quick change before, which this cuts.
            const layer = this._layers.find((l) => l !== this._layer);
            clearTimeout(layer.quietTimer);
            layer.gain.gain.cancelScheduledValues(ctx.currentTime);
            layer.gain.gain.setValueAtTime(0, ctx.currentTime);
            layer.el.loop = loop;
            layer.el.src = track.url;
            layer.advanced = false;
            await layer.el.play();
            layer.unlocked = true;
            if (token !== this._token) {
                this._quiet(layer);
                return false;
            }
            const fade = this._levels.fade;
            layer.gain.gain.linearRampToValueAtTime(dbToGain(gainDb), ctx.currentTime + fade);
            if (this._layer) this._fadeOut(this._layer, fade);
            this._layer = layer;
            Object.assign(this.state, {
                status: "playing", by,
                track: { name: track.name, url: track.url, credit: track.credit || "", source: track.source || "" },
                playlist: this._queue ? { name: this._queue.name } : null,
            });
            this._startDucking();
            return true;
        } catch (e) {
            if (token !== this._token) return false;
            const blocked = e?.name === "NotAllowedError";
            // Blocked: this device wants a tap first; the next one unlocks
            // the layers and starts it (_unlock).
            if (blocked) this._retry = () => this._start(track, { by, loop }).catch(() => {});
            console.error("[music] play failed", e);
            Object.assign(this.state, {
                status: this._layer ? "playing" : "idle",
                error: blocked ? _t("This device lets music start only after a tap: tap anywhere and it begins.")
                    : e.message || String(e),
            });
            throw e;
        }
    }

    /** In a tap (UNLOCK_EVENTS): wake the AudioContext and play a moment of
     *  silence on each layer's element, which unlocks them for later
     *  play() calls; then start whatever was blocked. Cheap once done. */
    _unlock() {
        if (!this._retry && (this._unlockDone || !NEEDS_TAP_UNLOCK)) return;
        const ctx = this._graph();
        if (ctx.state !== "running") ctx.resume().catch(() => {});
        this._unlockDone = ctx.state === "running" && this._layers.every((l) => l.unlocked);
        for (const layer of this._layers) {
            if (layer.unlocked || layer.el.getAttribute("src")) continue;
            layer.el.src = SILENT_WAV;
            layer.el.play().then(() => {
                layer.unlocked = true;
                if (layer.el.getAttribute("src") === SILENT_WAV) this._quiet(layer);
            }).catch(() => {});
        }
        if (this._retry) {
            const retry = this._retry;
            this._retry = null;
            retry();
        }
    }

    /** The playlist's next track. One that won't play is skipped; when none
     *  of them will, the playlist stops (its error stays on show). */
    async _advance(tries = 1) {
        const q = this._queue;
        q.index = (q.index + 1) % q.tracks.length;
        try {
            await this._start(q.tracks[q.index], { by: this.state.by, loop: false });
        } catch (e) {
            if (this._queue !== q || e?.name === "NotAllowedError") return;   // taken over, or waits for a tap
            if (tries < q.tracks.length) return this._advance(tries + 1);
            const error = this.state.error;
            this.stop({ note: false });
            this.state.error = error;
        }
    }

    stop({ by = "you", note = true, fade = true } = {}) {
        this._token++;
        const was = this.state.track?.name;
        this._queue = null;
        if (this._layer) this._fadeOut(this._layer, fade ? (this._levels?.fade ?? 3) : 0.05);
        this._layer = null;
        Object.assign(this.state, { status: "idle", track: null, playlist: null, by: "", error: "" });
        this._stopDucking();
        if (was && note && by === "you") this._tell(`The user stopped the background music.`);
    }

    setVolume(v) {
        const volume = Math.max(1, Math.min(100, Math.round(Number(v) || DEFAULT_VOLUME)));
        this.state.volume = volume;
        try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch (e) { /* per-window only */ }
        this._applyVolume();
    }

    /** Silent while something else owns the speakers (a karaoke song). */
    hold(on) {
        this._held = !!on;
        this._ducked = null;
        this._tick();
    }

    /** The AudioContext and its fixed graph: two layers (an <audio> each,
     *  kept for good: iOS unlocks an element, not a URL) → duck → volume. */
    _graph() {
        if (!this._ctx) {
            const ctx = this._ctx = new AudioContext({ latencyHint: "playback" });
            this._duck = ctx.createGain();
            this._master = ctx.createGain();
            this._duck.connect(this._master);
            this._master.connect(ctx.destination);
            this._applyVolume();
            this._layers = [0, 1].map(() => {
                const el = new Audio();
                el.preload = "auto";
                const layer = { el, src: ctx.createMediaElementSource(el), gain: ctx.createGain(),
                                advanced: true, unlocked: false, quietTimer: null };
                layer.gain.gain.value = 0;
                layer.src.connect(layer.gain);
                layer.gain.connect(this._duck);
                // Playlist: crossfade into the next track a fade before the end.
                const next = () => {
                    if (layer.advanced || this._layer !== layer || !this._queue) return;
                    layer.advanced = true;
                    this._advance();
                };
                el.addEventListener("timeupdate", () => {
                    if (!el.loop && el.duration && el.duration - el.currentTime <= (this._levels?.fade ?? 3)) next();
                });
                el.addEventListener("ended", next);
                return layer;
            });
        }
        if (this._ctx.state === "suspended") this._ctx.resume().catch(() => {});
        return this._ctx;
    }

    _applyVolume() {
        if (!this._master) return;
        const g = dbToGain((this.state.volume - DEFAULT_VOLUME) * DB_PER_STEP);
        this._master.gain.setTargetAtTime(g, this._ctx.currentTime, 0.05);
    }

    _fadeOut(layer, seconds) {
        layer.advanced = true;
        const t = this._ctx.currentTime;
        layer.gain.gain.cancelScheduledValues(t);
        layer.gain.gain.setValueAtTime(layer.gain.gain.value, t);
        layer.gain.gain.linearRampToValueAtTime(0, t + seconds);
        clearTimeout(layer.quietTimer);
        layer.quietTimer = setTimeout(() => this._quiet(layer), seconds * 1000 + 100);
    }

    /** Stop a layer's element and let go of its file; the element and its
     *  graph stay for the next track. */
    _quiet(layer) {
        try { layer.el.pause(); layer.el.removeAttribute("src"); layer.el.load(); } catch (e) { /* gone */ }
    }

    // ------------------------------------------------------------------
    // Ducking
    // ------------------------------------------------------------------

    _startDucking() {
        if (!this._timer) this._timer = setInterval(() => this._tick(), TICK_MS);
    }

    _stopDucking() {
        clearInterval(this._timer);
        this._timer = null;
        this._ducked = null;
    }

    _tick() {
        if (!this._duck || !this._levels) return;
        const level = this._held ? "held" : this._voiceActive() ? "ducked" : "open";
        if (level === this._ducked) return;
        this._ducked = level;
        const { duck_db: duckDb, attack, release } = this._levels;
        const target = level === "held" ? 0 : level === "ducked" ? dbToGain(-duckDb) : 1;
        // setTargetAtTime reaches ~95 % after three time constants.
        const tau = (level === "open" ? release : attack) / 3;
        this._duck.gain.setTargetAtTime(target, this._ctx.currentTime, tau);
    }

    _voiceActive() {
        const call = this._call;
        if (!call?.primary) return false;
        const legs = [call.primary, ...(call.activePeers?.() || [])];
        return !!call.primary._userSpeaking || legs.some((c) => c?._assistantAudioActive?.());
    }

    // ------------------------------------------------------------------
    // Calls
    // ------------------------------------------------------------------

    /** The call opened (voice_service.configureAvatarForConnection): the
     *  music now follows it. With "Start music when a call starts" on, it
     *  opens with the background's track or playlist, else the avatar's
     *  default playlist, else its one own track. */
    async callStarted(call, agentId, background) {
        // The same call opening again (a compaction restart, a reconnect
        // after a drop): the music carries on as the user left it.
        if (this._call === call) return;
        this._call = call;
        this._agentId = agentId ?? null;
        this._ducked = null;
        if (this._layer) this._startDucking();
        let lib;
        try { lib = await this.library(this._agentId); } catch (e) { return; }
        if (!lib.start_on_call || this._call !== call || this._layer) return;
        const own = lib.tracks.filter((t) => t.source === "avatar");
        const pick = this._resolve(lib, background?.music)
            || lib.playlists.find((p) => p.default)
            || (own.length === 1 ? own[0] : null);
        if (!pick) return;
        try {
            const started = pick.tracks ? await this.playPlaylist(pick, { by: "call", note: false })
                : await this.play(pick, { by: "call", note: false });
            if (!started) return;
        } catch (e) { return; }
        call.primary?.queueDeferredContext?.(
            `[System] (call context) ${pick.tracks ? `The playlist "${pick.name}"` : `"${pick.name}"`} is playing `
            + `quietly under the call as background music. No need to mention it unless it comes up.`);
    }

    /** The call is over, however it ended (voice_service.onConnectionEnded). */
    callEnded() {
        this._call = null;
        this.stop({ note: false });
    }

    async _onBackground(bg) {
        if (!this._call || !bg?.music) return;
        try {
            const pick = this._resolve(await this.library(this._agentId), bg.music);
            if (!pick) return;
            if (pick.tracks) {
                if (this.state.playlist?.name !== pick.name) await this.playPlaylist(pick, { by: "scene" });
            } else if (this.state.track?.name !== pick.name) {
                await this.play(pick, { by: "scene" });
            }
        } catch (e) { /* the user can pick music by hand */ }
    }

    /** A background's music value → a track, or a playlist ({tracks}). */
    _resolve(lib, ref) {
        if (!ref) return null;
        if (String(ref).startsWith(PLAYLIST_REF)) {
            return lib.playlists.find((p) => sameName(p.name, ref.slice(PLAYLIST_REF.length))) || null;
        }
        return lib.tracks.find((t) => sameName(t.name, ref)) || null;
    }

    _tellStarted(what, by) {
        this._tell(`${what} is now playing as background music`
            + (by === "you" ? " (the user put it on)." : " (this scene's music)."));
    }

    _tell(text) {
        this._call?.queueSilentContext?.(`[System] (call context) ${text}`);
    }

    // ------------------------------------------------------------------
    // play_background_music (tool_dispatcher.js)
    // ------------------------------------------------------------------

    /** play_background_music. Every result ends on `now_playing`: one plain
     *  sentence of what the user hears at this moment, so the companion
     *  never has to infer it from what it asked for. */
    async runTool({ track, playlist, url, title, volume }, { agentId, agentName, call }) {
        if (call && !this._call) this._call = call;
        if (volume != null) this.setVolume(volume);
        const by = agentName || "companion";
        const result = (fields) => ({ ...fields, now_playing: this._nowPlaying() });
        const start = async (fn) => {
            try {
                await fn();
                return null;
            } catch (e) {
                return e?.name === "NotAllowedError"
                    ? "The user's device blocked the sound until they tap the screen; it starts on their next tap."
                    : `It could not be played: ${e.message || e}`;
            }
        };
        if (track === "off") {
            this.stop({ by: "companion", note: false });
            return result({ ok: true });
        }
        if (url) {
            // The call stays open until the music plays (or fails): the
            // companion's replies meanwhile carry the "still running" note
            // (agent_connection._runningCallsNote). Answering at once let it
            // think nothing was happening: it put on other music, and the
            // download then overrode that when it landed.
            Object.assign(this.state, { status: "loading", error: "" });
            const asked = this._token;   // anything started or stopped after this wins
            let t;
            try {
                ({ track: t } = await rpc("/api/music/fetch",
                    { url, title: title || "", agent_id: agentId, from_companion: true }));
            } catch (e) {
                if (this._token === asked) {
                    Object.assign(this.state, { status: this._layer ? "playing" : "idle", error: e.message || String(e) });
                }
                return result({ ok: false, error: `The link could not be downloaded: ${e.message || e}` });
            }
            if (this._token !== asked) {
                return result({ ok: false, error: `"${t.name}" downloaded, but it was not started: other music `
                    + `was put on (or the music stopped) while it downloaded.` });
            }
            const failed = await start(() => this.play(t, { by, note: false }));
            return result(failed ? { ok: false, error: failed } : { ok: true });
        }
        if (playlist) {
            const lib = await this.library(agentId);
            const p = lib.playlists.find((x) => sameName(x.name, playlist));
            if (!p) return result({ ok: false, error: `No playlist called "${playlist}".` });
            const failed = await start(() => this.playPlaylist(p, { by, note: false }));
            return result(failed ? { ok: false, error: failed } : { ok: true });
        }
        if (track) {
            const lib = await this.library(agentId);
            const t = lib.tracks.find((x) => sameName(x.name, track));
            if (!t) return result({ ok: false, error: `No track called "${track}".` });
            const failed = await start(() => this.play(t, { by, note: false }));
            return result(failed ? { ok: false, error: failed } : { ok: true });
        }
        if (volume != null) return result({ ok: true, volume: this.state.volume });
        return result({ ok: false, error: "Pass `track` (or \"off\"), `playlist`, `url`, or `volume`." });
    }

    /** What the user hears right now, as one sentence. */
    _nowPlaying() {
        const s = this.state;
        if (s.status !== "playing" || !s.track) return "No music is playing.";
        if (s.playlist) {
            return `The playlist "${s.playlist.name}" is playing, now on "${s.track.name}"; its tracks play in turn.`;
        }
        return `"${s.track.name}" is playing, on a loop until it is changed or stopped.`;
    }
}

export const backgroundMusic = new BackgroundMusic();
