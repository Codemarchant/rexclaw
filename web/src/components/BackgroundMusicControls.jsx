import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";

/** A search box over `groups` ([{ label, items: [{ key, label, search }] }])
 *  showing the chosen item's label; while it has focus a grouped list opens
 *  under it, filtered by each item's `search` text. Picking one calls
 *  `onPick(key)`; Enter picks the first match, Escape closes. */
function MusicPicker({ groups, value, placeholder, title, disabled, onPick }) {
    const [q, setQ] = useState("");
    const [open, setOpen] = useState(false);
    const box = useRef(null);
    const needle = q.trim().toLowerCase();
    const shown = groups
        .map((g) => ({ ...g, items: needle ? g.items.filter((i) => i.search.includes(needle)) : g.items }))
        .filter((g) => g.items.length);
    const current = groups.flatMap((g) => g.items).find((i) => i.key === value);
    const pick = (key) => {
        onPick(key);
        setQ("");
        setOpen(false);
        box.current?.blur();
    };
    return (
        <div className="rx_bgm_pick">
            <input ref={box} type="text" value={open ? q : current?.label ?? ""} disabled={disabled}
                   placeholder={open && current ? current.label : placeholder} title={title}
                   onFocus={() => { setQ(""); setOpen(true); }}
                   onBlur={() => setTimeout(() => setOpen(false), 150)}
                   onChange={(ev) => setQ(ev.target.value)}
                   onKeyDown={(ev) => {
                       if (ev.key === "Escape") box.current?.blur();
                       else if (ev.key === "Enter" && shown.length) pick(shown[0].items[0].key);
                   }} />
            {open && (
                <div className="rx_bgm_list">
                    {shown.length ? shown.map((g) => (
                        <div key={g.label}>
                            <div className="rx_bgm_group">{g.label}</div>
                            {g.items.map((i) => (
                                <button key={i.key} type="button"
                                        className={"rx_bgm_item" + (i.key === value ? " is-chosen" : "")}
                                        onMouseDown={(ev) => ev.preventDefault()}
                                        onClick={() => pick(i.key)}>
                                    {i.label}
                                </button>
                            ))}
                        </div>
                    )) : <div className="rx_bgm_group">{_t("No match")}</div>}
                </div>
            )}
        </div>
    );
}

/** Background music in calls (models/background_music.js): pick a playlist
 *  or a track (playlists first, then the companion's avatar's own tracks,
 *  then the whole music library, even when the avatar keeps the companion
 *  to its own), play or stop it, set the volume, play a link, and choose
 *  whether calls open with music and whether links are kept. Shared by
 *  the voice view's Stage panel (the music plays in that window) and the
 *  mascot settings' Songs tab (it plays in the overlay, so the handlers send
 *  commands there). `music` is the player's state snapshot; onPlay gets a
 *  track, or a playlist ({name, tracks}). */
export default function BackgroundMusicControls({ agentId, music, onPlay, onStop, onVolume, disabled = false }) {
    const [lib, setLib] = useState({ tracks: [], playlists: [] });
    const [startOnCall, setStartOnCall] = useState(false);
    const [keepDownloads, setKeepDownloads] = useState(false);
    const [pick, setPick] = useState("");
    const [link, setLink] = useState("");
    const [fetching, setFetching] = useState(false);
    const playing = music?.status === "playing";
    const loading = music?.status === "loading" || fetching;

    useEffect(() => {
        rpc("/api/music/tracks", { agent_id: agentId ?? null, whole_library: true })
            .then((r) => {
                setLib({ tracks: r.tracks || [], playlists: r.playlists || [] });
                setStartOnCall(!!r.start_on_call);
                setKeepDownloads(!!r.keep_downloads);
            })
            .catch(() => setLib({ tracks: [], playlists: [] }));
    }, [agentId]);
    // Follow what is playing, whoever started it.
    useEffect(() => {
        if (music?.playlist?.name) setPick(`p:${music.playlist.name}`);
        else if (music?.track?.name) setPick(`t:${music.track.name}`);
    }, [music?.playlist?.name, music?.track?.name]);

    const asItem = (t) => ({ key: `t:${t.name}`, label: t.name,
                             search: `${t.name} ${t.description || ""} ${t.credit || ""}`.toLowerCase() });
    const groups = [
        { label: _t("Playlists"), items: lib.playlists.map((p) => {
            const name = p.source === "auto" ? _t(p.name) : p.name;
            return { key: `p:${p.name}`, label: `${name} (${p.tracks.length})`, search: name.toLowerCase() };
        }) },
        { label: _t("This avatar"), items: lib.tracks.filter((t) => t.source === "avatar").map(asItem) },
        { label: _t("Music library"), items: lib.tracks.filter((t) => t.source !== "avatar").map(asItem) },
    ];
    const chosen = pick.startsWith("p:") ? lib.playlists.find((p) => p.name === pick.slice(2))
        : lib.tracks.find((t) => t.name === pick.slice(2));

    const playLink = async () => {
        setFetching(true);
        try {
            const { track } = await rpc("/api/music/fetch", { url: link.trim(), agent_id: agentId ?? null });
            onPlay(track);
            setLink("");
        } catch (e) {
            notification.add(e.message || String(e), { type: "danger" });
        } finally {
            setFetching(false);
        }
    };
    const saveStartOnCall = async (on) => {
        setStartOnCall(on);
        try {
            await rpc("/api/music/settings", { start_on_call: on });
        } catch (e) {
            setStartOnCall(!on);
            notification.add(e.message || _t("Could not save the setting"), { type: "danger" });
        }
    };
    // The same setting as History → Recordings → Your sounds.
    const saveKeepDownloads = async (keep) => {
        setKeepDownloads(keep);
        try {
            await rpc("/api/audio/sounds/keep_downloads", { keep });
        } catch (e) {
            setKeepDownloads(!keep);
            notification.add(e.message || _t("Could not save the setting"), { type: "danger" });
        }
    };
    const by = { you: _t("you"), scene: _t("this background"), call: _t("the call start") }[music?.by] ?? music?.by;

    return (
        <div className="rx_bgm">
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-start" }}>
                <MusicPicker groups={groups} value={pick} onPick={setPick}
                             disabled={disabled || !(lib.tracks.length || lib.playlists.length)}
                             placeholder={lib.tracks.length ? _t("Choose music…") : _t("No music yet")}
                             title={_t("Playlists, then your avatar's own tracks, then the music library (History → Recordings → Your sounds, music kind).")} />
                <button className="btn btn-sm btn-primary" disabled={disabled || !chosen || loading}
                        title={_t("Play")} onClick={() => onPlay(chosen)}>
                    <i className={loading ? "fa fa-spinner fa-spin" : "fa fa-play"} />
                </button>
                <button className="btn btn-sm" disabled={disabled || !playing} title={_t("Stop")} onClick={onStop}>
                    <i className="fa fa-stop" />
                </button>
            </div>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.35rem" }}>
                <i className="fa fa-volume-down text-muted" title={_t("Volume")} />
                <input type="range" min="1" max="100" step="1" value={music?.volume ?? 50} disabled={disabled}
                       style={{ flex: 1 }} title={_t("Volume: 50 is the usual background level")}
                       onChange={(e) => onVolume(Number(e.target.value))} />
            </div>
            {playing && music.track && (
                <div className="text-muted small" style={{ marginTop: "0.3rem" }}>
                    <i className="fa fa-music" /> {music.playlist ? `${music.playlist.name}: ` : ""}{music.track.name}
                    {by ? ` · ${_t("started by %s", by)}` : ""}
                    {music.track.credit ? <> · <em>{music.track.credit}</em></> : null}
                </div>
            )}
            {music?.error && <div className="text-danger small" style={{ marginTop: "0.3rem" }}>{music.error}</div>}
            <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                <input type="text" value={link} disabled={disabled || fetching} style={{ flex: 1, minWidth: 0 }}
                       placeholder={_t("Or paste a YouTube or music link…")}
                       onChange={(e) => setLink(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter" && link.trim()) playLink(); }} />
                <button className="btn btn-sm" disabled={disabled || fetching || !link.trim()} onClick={playLink}
                        title={_t("Download it (the first 30 minutes) and play it")}>
                    {fetching ? <i className="fa fa-spinner fa-spin" /> : <i className="fa fa-link" />}
                </button>
            </div>
            <label className="rx_check" style={{ marginTop: "0.4rem" }}
                   title={_t("Calls open with music: the background's track or playlist if it names one, otherwise the avatar's default playlist (or its own tracks). Applies to every companion.")}>
                <input type="checkbox" checked={startOnCall} disabled={disabled}
                       onChange={(e) => saveStartOnCall(e.target.checked)} />
                <span>{_t("Start music when a call starts")}</span>
            </label>
            <label className="rx_check" style={{ marginTop: "0.2rem" }}
                   title={_t("When this is on, music from links (pasted here or found by a companion) and sounds companions download for voice messages are saved to your music library (History → Recordings → Your sounds) with a credit to their source, so you can pick them again. When off, each download is used once and then deleted. The same setting as in Recordings.")}>
                <input type="checkbox" checked={keepDownloads} disabled={disabled}
                       onChange={(e) => saveKeepDownloads(e.target.checked)} />
                <span>{_t("Keep sounds companions download")}</span>
            </label>
        </div>
    );
}
