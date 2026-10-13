import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";

/** Background music in calls (models/background_music.js): pick a playlist
 *  or a track from the companion's music (playlists first, then their
 *  avatar's own tracks, then the music library), play or stop it, set the
 *  volume, play a link, and choose whether calls open with music. Shared by
 *  the voice view's Stage panel (the music plays in that window) and the
 *  mascot settings' Songs tab (it plays in the overlay, so the handlers send
 *  commands there). `music` is the player's state snapshot; onPlay gets a
 *  track, or a playlist ({name, tracks}). */
export default function BackgroundMusicControls({ agentId, music, onPlay, onStop, onVolume, disabled = false }) {
    const [lib, setLib] = useState({ tracks: [], playlists: [] });
    const [startOnCall, setStartOnCall] = useState(false);
    const [pick, setPick] = useState("");
    const [link, setLink] = useState("");
    const [fetching, setFetching] = useState(false);
    const playing = music?.status === "playing";
    const loading = music?.status === "loading" || fetching;

    useEffect(() => {
        rpc("/api/music/tracks", { agent_id: agentId ?? null })
            .then((r) => { setLib({ tracks: r.tracks || [], playlists: r.playlists || [] }); setStartOnCall(!!r.start_on_call); })
            .catch(() => setLib({ tracks: [], playlists: [] }));
    }, [agentId]);
    // Follow what is playing, whoever started it.
    useEffect(() => {
        if (music?.playlist?.name) setPick(`p:${music.playlist.name}`);
        else if (music?.track?.name) setPick(`t:${music.track.name}`);
    }, [music?.playlist?.name, music?.track?.name]);

    const own = lib.tracks.filter((t) => t.source === "avatar");
    const library = lib.tracks.filter((t) => t.source !== "avatar");
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
    const by = { you: _t("you"), scene: _t("this background"), call: _t("the call start") }[music?.by] ?? music?.by;

    return (
        <div className="rx_bgm">
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <select value={pick} disabled={disabled || !(lib.tracks.length || lib.playlists.length)}
                        style={{ flex: 1, minWidth: 0 }}
                        title={_t("Playlists, then your avatar's own tracks, then the music library (History → Recordings → Your sounds, music kind).")}
                        onChange={(e) => setPick(e.target.value)}>
                    <option value="">{lib.tracks.length ? _t("Choose music…") : _t("No music yet")}</option>
                    {lib.playlists.length > 0 && (
                        <optgroup label={_t("Playlists")}>
                            {lib.playlists.map((p) => (
                                <option key={p.name} value={`p:${p.name}`}>
                                    {p.source === "auto" ? _t(p.name) : p.name} ({p.tracks.length})
                                </option>
                            ))}
                        </optgroup>
                    )}
                    {own.length > 0 && (
                        <optgroup label={_t("This avatar")}>
                            {own.map((t) => <option key={t.url} value={`t:${t.name}`}>{t.name}</option>)}
                        </optgroup>
                    )}
                    {library.length > 0 && (
                        <optgroup label={_t("Music library")}>
                            {library.map((t) => <option key={t.url} value={`t:${t.name}`}>{t.name}</option>)}
                        </optgroup>
                    )}
                </select>
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
        </div>
    );
}
