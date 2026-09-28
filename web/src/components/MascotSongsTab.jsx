import React, { useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { notification } from "../lib/notification";
import { formatClock } from "../lib/format_clock";
import { stage } from "../models/stage";
import SongPicker from "./SongPicker.jsx";

/** Mascot settings → Songs: the karaoke stage on the desktop avatar.
 *
 *  The song plays in the overlay page (/#mascot), which owns the avatar and
 *  the audio; this tab picks the song (the shared SongPicker), teaches it
 *  (a server render, so it runs from here) and sends play / pause / stop
 *  over the mascot settings channel. The overlay's snapshot carries the
 *  stage's status back. No stage camera on the desktop: the mascot window
 *  frames the avatar itself. */
export default function MascotSongsTab({ mascot, alive, send }) {
    const local = useReactive(stage.state);             // this window's stage: only its teach progress is used
    const agentId = mascot?.selectedAgentId ?? null;
    const agentName = (mascot?.agents || []).find((a) => a.id === agentId)?.name || _t("They");
    const remote = mascot?.stage || {};
    const performing = remote.status === "playing" || remote.status === "paused";
    const [lib, setLib] = useState(null);
    const [lab, setLab] = useState(null);
    const [selected, setSelected] = useState(null);
    const [picking, setPicking] = useState(false);
    const [busy, setBusy] = useState("");
    const [mode, setMode] = useState("companion");
    const [opts, setOpts] = useState({ dance: true, lane: true, mic: true, difficulty: "medium", vocalDb: 0 });

    const refresh = async () => {
        const data = await rpc("/api/songs/bootstrap", { agent_id: agentId });
        setLib(data);
        return data;
    };
    useEffect(() => {
        if (agentId == null) return;
        refresh().catch((e) => notification.add(e.message, { type: "danger" }));
        rpc("/api/voicelab/status", {}).then(setLab).catch(() => setLab(null));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId]);
    // Follow a song started elsewhere (perform_song in a call).
    useEffect(() => { if (remote.songId) setSelected(remote.songId); }, [remote.songId]);

    const song = useMemo(() => lib?.songs.find((s) => s.id === selected) || null, [lib, selected]);
    const learned = !!song?.vocals.some((v) => v.voice === lib?.singer);
    const isCover = song?.source === "cover";
    const readyProfiles = (lab?.profiles || []).filter((p) => p.status === "ready");
    const render = local.render;

    const run = async (label, fn) => {
        setBusy(label);
        try { return await fn(); }
        catch (e) { notification.add(e.message || String(e), { type: "danger" }); return null; }
        finally { setBusy(""); }
    };
    const setOpt = (k, v) => {
        setOpts((o) => ({ ...o, [k]: v }));
        if (k === "lane") send({ type: "stage", action: "options", options: { lane: v } });   // live, even mid-song
    };
    const teach = () => run("teach", async () => {
        await stage.teach(selected, agentId);
        await refresh();
    });
    const assignProfile = (profileId) => run("assign", async () => {
        await rpc("/api/voicelab/profiles/assign", { agent_id: agentId, profile_id: profileId });
        await refresh();
    });
    const perform = () => send({ type: "stage", action: "play", songId: selected, mode, options: opts });

    const MODES = [
        ["companion", _t("%s sings", agentName), _t("They sing and dance on your desktop.")],
        ["duet", _t("Duet"), song?.duet ? _t("They sing part one, you sing part two.") : _t("You take turns: every other line is yours.")],
        ["solo", _t("You sing"), _t("Karaoke for you: the backing plays, they dance, your singing is scored.")],
    ];

    return (
        <>
            <section>
                <h3><i className="fa fa-music" /> {_t("Songs")}</h3>
                <p className="text-muted">{_t("Your companion sings and dances on the desktop, with the lyrics under them.")}</p>
                <fieldset disabled={!alive}>
                    {lab?.status?.installed && (
                        <>
                            <label>{_t("Singing voice")}</label>
                            <select value={lib?.profile?.id ?? ""} disabled={performing || !!busy}
                                    title={_t("A voice profile from the Voice Lab (Settings) makes them sing in that voice; the built-in engine re-sings their speaking voice.")}
                                    onChange={(e) => assignProfile(e.target.value ? Number(e.target.value) : null)}>
                                <option value="">{_t("Built-in")}</option>
                                {readyProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </>
                    )}
                    <div className="rx_mascot_song_card">
                        {song ? (
                            <span>
                                <strong>{song.title}</strong>
                                {learned && <i className="fa fa-microphone rx_songs_learned" title={_t("%s knows this one", agentName)} />}
                                <span className="text-muted">
                                    {" "}{[song.artist, song.duration_seconds ? formatClock(song.duration_seconds) : ""].filter(Boolean).join(" · ")}
                                </span>
                            </span>
                        ) : <span className="text-muted">{_t("No song chosen yet.")}</span>}
                        <button className="btn btn-sm btn-primary" disabled={performing || agentId == null} onClick={() => setPicking(true)}>
                            <i className="fa fa-list" /> {_t("Choose song…")}
                        </button>
                    </div>
                </fieldset>
            </section>
            {picking && (
                <SongPicker agentId={agentId} agentName={agentName} selectedId={selected}
                            onPick={(id) => { setSelected(id); setPicking(false); refresh().catch(() => {}); }}
                            onChanged={() => refresh().catch(() => {})}
                            onClose={() => setPicking(false)} />
            )}

            {song && (
                <section>
                    <fieldset disabled={!alive}>
                        <div className="rx_mascot_set_grid">
                            {MODES.map(([id, label, tip]) => (
                                <button key={id} disabled={performing} title={tip}
                                        className={"btn btn-sm " + (mode === id ? "btn-primary" : "btn-light")}
                                        onClick={() => setMode(id)}>{label}</button>
                            ))}
                        </div>
                        {mode !== "solo" && !learned && !render && isCover && !lib?.profile && (
                            <p className="rx_mascot_set_desc">
                                {_t("Songs from a link or video are sung through a voice profile: pick one under Singing voice (train one in Settings → Voice Lab). You can still sing it yourself.")}
                            </p>
                        )}
                        {mode !== "solo" && !learned && !render && !(isCover && !lib?.profile) && (
                            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={teach}
                                    title={isCover
                                        ? _t("Their voice profile re-sings the original singer's vocal. Takes about a minute.")
                                        : _t("Each lyric line is spoken in their voice (xAI text-to-speech, billed per character) and re-sung onto the melody. Takes a minute or two; done once per voice.")}>
                                <i className="fa fa-graduation-cap" /> {_t("Teach %s this song", agentName)}
                            </button>
                        )}
                        {render && (
                            <p className="rx_mascot_set_desc">
                                {render.error ? <span className="text-danger">{render.error}</span> : (
                                    <>
                                        <i className="fa fa-spinner fa-spin" />{" "}
                                        {render.stage === "sing" ? _t("Singing line %s of %s", render.done, render.total)
                                            : render.stage === "convert" ? _t("Re-singing in the profile voice (%s%)", render.done || 0)
                                            : _t("Speaking the lyrics: %s of %s lines", render.done || 0, render.total || "…")}
                                    </>
                                )}
                            </p>
                        )}
                        <div className="rx_mascot_set_grid">
                            {!performing && (
                                <button className="btn btn-sm btn-success" disabled={!!busy || (mode !== "solo" && !learned)} onClick={perform}>
                                    <i className="fa fa-play" /> {_t("Perform")}
                                </button>
                            )}
                            {remote.status === "playing" && (
                                <button className="btn btn-sm btn-light" onClick={() => send({ type: "stage", action: "pause" })}>
                                    <i className="fa fa-pause" /> {_t("Pause")}
                                </button>
                            )}
                            {remote.status === "paused" && (
                                <button className="btn btn-sm btn-light" onClick={() => send({ type: "stage", action: "resume" })}>
                                    <i className="fa fa-play" /> {_t("Resume")}
                                </button>
                            )}
                            {performing && (
                                <button className="btn btn-sm btn-light" onClick={() => send({ type: "stage", action: "stop" })}>
                                    <i className="fa fa-stop" /> {_t("Stop")}
                                </button>
                            )}
                        </div>
                        {remote.error && <p className="rx_mascot_set_desc text-danger">{remote.error}</p>}
                    </fieldset>
                </section>
            )}

            {song && (
                <section>
                    <h3><i className="fa fa-sliders" /> {_t("Options")}</h3>
                    <fieldset disabled={!alive}>
                        {[["rx_ms_dance", "dance", _t("Dance"), _t("Dance to the beat: the built-in dances and yours, warped onto the music's beats; quiet passages get a gentle groove instead.")],
                          ["rx_ms_lane", "lane", _t("Note bars"), _t("Show the melody as bars scrolling above the avatar, with your pitch when your singing is scored.")]]
                            .map(([id, key, label, tip]) => (
                                <div key={id} className="rx_check" title={tip}>
                                    <input id={id} type="checkbox" checked={opts[key]} disabled={key === "dance" && performing}
                                           onChange={(e) => setOpt(key, e.target.checked)} />
                                    <label htmlFor={id}>{label}</label>
                                </div>
                            ))}
                        {mode !== "companion" && (
                            <div className="rx_mascot_song_row">
                                <div className="rx_check">
                                    <input id="rx_ms_mic" type="checkbox" checked={opts.mic} disabled={performing}
                                           onChange={(e) => setOpt("mic", e.target.checked)} />
                                    <label htmlFor="rx_ms_mic" title={_t("Listen to your singing through the mic and score it like UltraStar: in tune within the difficulty's range, any octave. Headphones help: the speakers leak into the mic.")}>{_t("Score my singing")}</label>
                                </div>
                                <select value={opts.difficulty} disabled={performing || !opts.mic}
                                        title={_t("How close to the note counts: easy ±2 semitones, medium ±1, hard exact")}
                                        onChange={(e) => setOpt("difficulty", e.target.value)}>
                                    <option value="easy">{_t("Easy")}</option>
                                    <option value="medium">{_t("Medium")}</option>
                                    <option value="hard">{_t("Hard")}</option>
                                </select>
                            </div>
                        )}
                        {mode !== "solo" && (
                            <div className="rx_mascot_song_row">
                                <label htmlFor="rx_ms_vol">{_t("Their voice")}</label>
                                <input id="rx_ms_vol" type="range" min={-18} max={9} step={1} value={opts.vocalDb} disabled={performing}
                                       onChange={(e) => setOpt("vocalDb", Number(e.target.value))} />
                                <span>{opts.vocalDb > 0 ? "+" : ""}{opts.vocalDb} dB</span>
                            </div>
                        )}
                    </fieldset>
                </section>
            )}
        </>
    );
}
