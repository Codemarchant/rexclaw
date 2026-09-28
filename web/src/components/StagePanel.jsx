import React, { useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { notification } from "../lib/notification";
import { formatClock } from "../lib/format_clock";
import { stage } from "../models/stage";
import { avatarRenderer, voice } from "../services";
import SongPicker from "./SongPicker.jsx";

/** Voice view → Stage: the karaoke panel.
 *
 *  Choose a song in the song picker (the built-in ones and songs you
 *  import; imports and dances live there too), teach it to the companion once (their voice sings it:
 *  rendered on the server and cached per voice), and perform: they sing and
 *  dance while the lyrics and the melody roll over the stage. Duets and
 *  solo karaoke score your singing through the mic the way UltraStar
 *  does. */
export default function StagePanel({ agent }) {
    const st = useReactive(stage.state);
    const [lib, setLib] = useState({ songs: [], examples: [], dances: [], styles: {} });
    const [selected, setSelected] = useState(null);     // song id
    const [busy, setBusy] = useState("");
    const [picking, setPicking] = useState(false);
    const [lab, setLab] = useState(null);                // Voice Lab status + profiles
    const agentName = agent?.name || _t("They");
    const who = { agentId: agent?.id };
    // What this companion's vocals are filed under: its voice profile, or its xAI voice.
    const singer = lib.singer || agent?.voice || "eve";

    const refresh = async () => {
        const data = await rpc("/api/songs/bootstrap", { agent_id: agent?.id });
        setLib(data);
        return data;
    };
    const refreshLab = async () => {
        try { setLab(await rpc("/api/voicelab/status", {})); } catch (e) { setLab(null); }
    };
    useEffect(() => {
        stage.attach(avatarRenderer);
        refresh().catch((e) => notification.add(e.message, { type: "danger" }));
        refreshLab();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agent?.id]);

    const song = useMemo(() => lib.songs.find((s) => s.id === selected) || null, [lib, selected]);
    const learned = !!song?.vocals?.find((v) => v.voice === singer);
    const playing = st.status === "playing" || st.status === "paused";
    const isCover = song?.source === "cover";
    const readyProfiles = (lab?.profiles || []).filter((p) => p.status === "ready");

    useEffect(() => {
        if (selected && !playing) stage.load(selected, who);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, singer]);

    const assignProfile = (profileId) => run("assign", async () => {
        await rpc("/api/voicelab/profiles/assign", { agent_id: agent?.id, profile_id: profileId });
        await refresh();
    });

    const run = async (label, fn) => {
        setBusy(label);
        try { return await fn(); }
        catch (e) { notification.add(e.message || String(e), { type: "danger" }); return null; }
        finally { setBusy(""); }
    };

    const teach = () => run("teach", async () => {
        await stage.teach(selected, agent?.id);
        await refresh();
        await stage.load(selected, who);
    });

    const perform = () => run("play", async () => {
        if (!stage.state.song || stage.state.song.id !== selected) await stage.load(selected, who);
        await stage.play({ agentName, call: voice });
    });

    const restyle = (style) => run("style", async () => {
        setLib(await rpc("/api/songs/restyle", { id: song.id, style }));
        await stage.load(song.id, who);
    });

    const record = () => run("record", async () => {
        await rpc("/api/songs/record", { id: song.id, agent_id: agent?.id, vocal_db: st.options.vocalDb });
    });

    const renderInfo = st.render;
    const opts = st.options;
    const setOpt = (k, v) => { stage.state.options[k] = v; };

    return (
        <div className="o_voice_full_settings rx_stage_panel">
            <div className="o_voice_full_settings_section">
                <strong><i className="fa fa-music" /> {_t("Stage")}</strong>
                {lab?.status?.installed && (
                    <div className="o_voice_full_settings_row">
                        <label htmlFor="rx_stage_voice"
                               title={_t("A voice profile from the Voice Lab (Settings) makes them sing in that voice; the built-in engine re-sings their speaking voice.")}>
                            {_t("Singing voice")}
                        </label>
                        <select id="rx_stage_voice" value={agent?.singing_profile_id ?? lib.profile?.id ?? ""} disabled={playing || !!busy}
                                onChange={(e) => assignProfile(e.target.value ? Number(e.target.value) : null)}>
                            <option value="">{_t("Built-in")}</option>
                            {readyProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    </div>
                )}
                <div className="rx_stage_current">
                    {song ? (
                        <span className="rx_stage_song">
                            <span className="rx_stage_song_title">
                                {song.title}
                                {learned && <i className="fa fa-microphone rx_stage_ready" title={_t("%s knows this one", agentName)} />}
                            </span>
                            <span className="rx_stage_song_meta">
                                {[song.artist || (song.source === "companion" ? _t("Written by a companion") : song.source === "example" ? _t("Built-in") : ""),
                                  song.duration_seconds ? formatClock(song.duration_seconds) : "",
                                  song.duet ? _t("duet") : ""].filter(Boolean).join(" · ")}
                            </span>
                        </span>
                    ) : (
                        <span className="rx_stage_song_meta">{_t("No song chosen yet.")}</span>
                    )}
                    <button className="btn btn-sm btn-primary" disabled={playing} onClick={() => setPicking(true)}>
                        <i className="fa fa-list" /> {_t("Choose song…")}
                    </button>
                </div>
            </div>
            {picking && (
                <SongPicker agentId={agent?.id} agentName={agentName} selectedId={selected}
                            onPick={(id) => { setSelected(id); setPicking(false); refresh().catch(() => {}); }}
                            onChanged={() => refresh().catch(() => {})}
                            onClose={() => setPicking(false)} />
            )}

            {song && (
                <div className="o_voice_full_settings_section">
                    <div className="o_voice_full_settings_grid rx_stage_modes">
                        {[["companion", _t("%s sings", agentName), _t("They sing and dance; turn on scoring below to sing along.")],
                          ["duet", _t("Duet"), song.duet ? _t("They sing part one, you sing part two.") : _t("You take turns: every other line is yours.")],
                          ["solo", _t("You sing"), _t("Karaoke for you: the backing plays, they dance, your singing is scored.")]]
                            .map(([id, label, tip]) => (
                                <button key={id} disabled={playing}
                                        className={"btn btn-sm " + (st.mode === id ? "btn-primary" : "btn-outline-light")}
                                        onClick={() => { stage.state.mode = id; }} title={tip}>{label}</button>
                            ))}
                    </div>
                    {st.mode !== "solo" && !learned && !renderInfo && isCover && !lib.profile && (
                        <div className="rx_stage_hint">
                            {_t("Songs from a link or video are sung through a voice profile: pick one under Singing voice (train one in Settings → Voice Lab). You can still sing it yourself.")}
                        </div>
                    )}
                    {st.mode !== "solo" && !learned && !renderInfo && !(isCover && !lib.profile) && (
                        <div className="rx_stage_teach">
                            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={teach}
                                    title={isCover
                                        ? _t("Their voice profile re-sings the original singer's vocal. Takes about a minute.")
                                        : lib.profile
                                            ? _t("Each lyric line is spoken in their voice (xAI text-to-speech, billed per character), sung onto the melody and re-sung by their voice profile. Takes a minute or two.")
                                            : _t("Each lyric line is spoken in their voice (xAI text-to-speech, billed per character) and re-sung onto the melody. Takes a minute or two; done once per voice.")}>
                                <i className="fa fa-graduation-cap" /> {_t("Teach %s this song", agentName)}
                            </button>
                        </div>
                    )}
                    {renderInfo && (
                        <div className="rx_stage_progress">
                            {renderInfo.error ? <span className="text-danger">{renderInfo.error}</span> : (
                                <>
                                    <i className="fa fa-spinner fa-spin" />{" "}
                                    {renderInfo.stage === "sing" ? _t("Singing line %s of %s", renderInfo.done, renderInfo.total)
                                        : renderInfo.stage === "convert" ? _t("Re-singing in the profile voice (%s%)", renderInfo.done || 0)
                                        : _t("Speaking the lyrics: %s of %s lines", renderInfo.done || 0, renderInfo.total || "…")}
                                </>
                            )}
                        </div>
                    )}
                    <div className="o_voice_full_settings_grid rx_stage_transport">
                        {!playing && (
                            <button className="btn btn-sm btn-success" disabled={!!busy || st.loading || (st.mode !== "solo" && !learned)}
                                    onClick={perform}>
                                <i className={busy === "play" ? "fa fa-spinner fa-spin" : "fa fa-play"} /> {_t("Perform")}
                            </button>
                        )}
                        {st.status === "playing" && (
                            <button className="btn btn-sm btn-outline-light" onClick={() => stage.pause()}><i className="fa fa-pause" /> {_t("Pause")}</button>
                        )}
                        {st.status === "paused" && (
                            <button className="btn btn-sm btn-outline-light" onClick={() => stage.resume()}><i className="fa fa-play" /> {_t("Resume")}</button>
                        )}
                        {playing && (
                            <button className="btn btn-sm btn-outline-light" onClick={() => stage.stop({ byUser: true })}><i className="fa fa-stop" /> {_t("Stop")}</button>
                        )}
                    </div>
                    {st.error && <div className="text-danger small mt-1">{st.error}</div>}
                    <div className="o_voice_full_settings_row">
                        <input id="rx_stage_dance" type="checkbox" checked={opts.dance} disabled={playing}
                               onChange={(e) => setOpt("dance", e.target.checked)} />
                        <label htmlFor="rx_stage_dance" title={_t("Dance to the beat: the built-in dances and yours, warped onto the music's beats; quiet passages get a gentle groove instead.")}>{_t("Dance")}</label>
                        <input id="rx_stage_cam" type="checkbox" checked={opts.camera} disabled={playing}
                               onChange={(e) => setOpt("camera", e.target.checked)} />
                        <label htmlFor="rx_stage_cam" title={_t("Cut between close-ups, waist shots and wide shots on the bar lines, like a music show.")}>{_t("Stage camera")}</label>
                        <input id="rx_stage_lane" type="checkbox" checked={opts.lane}
                               onChange={(e) => setOpt("lane", e.target.checked)} />
                        <label htmlFor="rx_stage_lane" title={_t("Show the melody as bars scrolling above the avatar, with your pitch when your singing is scored.")}>{_t("Note bars")}</label>
                    </div>
                    {st.mode !== "companion" && (
                        <div className="o_voice_full_settings_row">
                            <input id="rx_stage_mic" type="checkbox" checked={opts.mic} disabled={playing}
                                   onChange={(e) => setOpt("mic", e.target.checked)} />
                            <label htmlFor="rx_stage_mic" title={_t("Listen to your singing through the mic and score it like UltraStar: in tune within the difficulty's range, any octave. Headphones help: the speakers leak into the mic.")}>{_t("Score my singing")}</label>
                            <select value={opts.difficulty} disabled={playing || !opts.mic} onChange={(e) => setOpt("difficulty", e.target.value)}
                                    title={_t("How close to the note counts: easy ±2 semitones, medium ±1, hard exact")}>
                                <option value="easy">{_t("Easy")}</option>
                                <option value="medium">{_t("Medium")}</option>
                                <option value="hard">{_t("Hard")}</option>
                            </select>
                        </div>
                    )}
                    {st.mode !== "solo" && (
                        <div className="o_voice_full_settings_row">
                            <label htmlFor="rx_stage_vol">{_t("Their voice")}</label>
                            <input id="rx_stage_vol" type="range" min={-18} max={9} step={1} value={opts.vocalDb} disabled={playing}
                                   onChange={(e) => setOpt("vocalDb", Number(e.target.value))} />
                            <span className="rx_stage_db">{opts.vocalDb > 0 ? "+" : ""}{opts.vocalDb} dB</span>
                        </div>
                    )}
                    <div className="o_voice_full_settings_grid rx_stage_actions">
                        {song.source !== "ultrastar" && song.backing_mode === "generated" && (
                            <select value={song.style || ""} disabled={playing || !!busy}
                                    onChange={(e) => e.target.value && restyle(e.target.value)}
                                    title={_t("Re-arrange the backing in another style (the singing stays)")}>
                                <option value="">{_t("Style…")}</option>
                                {Object.entries(lib.styles).map(([k, v]) => <option key={k} value={k} title={v}>{k}</option>)}
                            </select>
                        )}
                        {learned && (
                            <button className="btn btn-sm btn-outline-light" disabled={!!busy} onClick={record}
                                    title={_t("Mix their singing with the backing into one recording, listed under History → Recordings")}>
                                <i className={busy === "record" ? "fa fa-spinner fa-spin" : "fa fa-download"} /> {_t("Save recording")}
                            </button>
                        )}
                        {learned && st.mode !== "solo" && (
                            <button className="btn btn-sm btn-outline-light" disabled={!!busy || playing} onClick={teach}
                                    title={_t("Sing it again in their voice (the result differs a little every time)")}>
                                <i className="fa fa-refresh" />
                            </button>
                        )}
                    </div>
                    {song.credit && <div className="rx_stage_credit">{song.credit}</div>}
                </div>
            )}
        </div>
    );
}
