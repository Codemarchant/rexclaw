import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";
import { formatClock } from "../lib/format_clock";

/** The karaoke stage's song library, as a popup: shared by the voice view's
 *  Stage panel and the mascot settings window's Songs tab.
 *
 *  Songs: search by title or artist, filter by where a song came from or
 *  whether this companion has learned it, sort A-Z or newest first; pick
 *  one (a built-in song's backing is arranged the first time it's picked).
 *  Add songs: from a link or a video (through the Voice Lab) or an
 *  UltraStar chart. Dances: MMD (.vmd) and VRMA files, optionally linked to
 *  the song they were made for.
 *
 *  onPick(songId) selects a song and closes; onChanged() tells the host the
 *  library changed (an import, a delete, a dance edit). A link import keeps
 *  running if the popup closes, and still picks its song when it finishes. */
export default function SongPicker({ agentId, agentName, selectedId, onPick, onChanged, onClose }) {
    const [tab, setTab] = useState("songs");
    const [lib, setLib] = useState(null);
    const [lab, setLab] = useState(null);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState("all");
    const [sort, setSort] = useState("title");
    const [busy, setBusy] = useState("");
    const [link, setLink] = useState("");
    const [importMode, setImportMode] = useState("auto");
    const [importJob, setImportJob] = useState(null);
    const fileRef = useRef(null);
    const mediaRef = useRef(null);
    const danceRef = useRef(null);
    const searchRef = useRef(null);
    const mounted = useRef(true);
    useEffect(() => () => { mounted.current = false; }, []);
    const who = agentName || _t("They");

    const load = async () => {
        const data = await rpc("/api/songs/bootstrap", { agent_id: agentId });
        if (mounted.current) setLib(data);
        return data;
    };
    useEffect(() => {
        load().catch((e) => notification.add(e.message, { type: "danger" }));
        rpc("/api/voicelab/status", {}).then((d) => mounted.current && setLab(d)).catch(() => {});
        searchRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId]);

    useEffect(() => {
        const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    const run = async (label, fn) => {
        setBusy(label);
        try { return await fn(); }
        catch (e) { notification.add(e.message || String(e), { type: "danger" }); return null; }
        finally { if (mounted.current) setBusy(""); }
    };
    const changed = (data) => {
        if (data && mounted.current) setLib(data);
        onChanged?.();
    };

    // One list: the songs in the library plus built-in songs not arranged yet.
    const rows = useMemo(() => {
        if (!lib) return [];
        const singer = lib.singer;
        const kindOf = (source) => (source === "example" ? "builtin" : source === "companion" ? "companion" : "imported");
        const out = lib.songs.map((s) => ({
            id: s.id, title: s.title, artist: s.artist || "", kind: kindOf(s.source), source: s.source,
            duration: s.duration_seconds, duet: s.duet, created: s.created_at || "",
            learned: s.vocals.some((v) => v.voice === singer),
        }));
        for (const e of lib.examples) {
            if (!e.id) out.push({ key: e.key, title: e.title, artist: "", kind: "builtin", summary: e.summary, created: "" });
        }
        return out;
    }, [lib]);

    const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const shown = useMemo(() => {
        const q = fold(query.trim());
        const list = rows.filter((r) => (filter === "all" || (filter === "learned" ? r.learned : r.kind === filter))
            && (!q || fold(`${r.title} ${r.artist}`).includes(q)));
        list.sort((a, b) => (sort === "recent" && a.created !== b.created
            ? b.created.localeCompare(a.created)
            : a.title.localeCompare(b.title, undefined, { sensitivity: "base" })));
        return list;
    }, [rows, query, filter, sort]);

    const count = (f) => rows.filter((r) => (f === "all" || (f === "learned" ? r.learned : r.kind === f))).length;
    const FILTERS = [
        ["all", _t("All")],
        ["learned", _t("%s knows", who)],
        ["builtin", _t("Built-in")],
        ["companion", _t("By companions")],
        ["imported", _t("Imported")],
    ];

    const pick = (r) => run("pick", async () => {
        let id = r.id;
        if (!id) {
            const data = await rpc("/api/songs/example", { key: r.key });
            changed(data);
            id = data.id;
        }
        onPick(id);
    });

    const remove = async (r) => {
        if (!(await confirmAsk(_t("Delete the song '%s'? Every voice that learned it forgets it too; recordings are kept.", r.title)))) return;
        await run("delete", async () => changed(await rpc("/api/songs/delete", { id: r.id })));
    };

    const upload = async (url, form, label) => {
        const resp = await fetch(url, { method: "POST", body: form });
        const body = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(body?.error?.message || body?.error || body?.detail || label);
        return body;
    };

    /** A song from a link or a video, through the Voice Lab. */
    const importCover = (start) => run("cover", async () => {
        const { job } = await start();
        if (mounted.current) setImportJob({ stage: _t("Starting"), progress: 0 });
        for (;;) {
            await new Promise((r) => setTimeout(r, 1500));
            const s = await rpc("/api/voicelab/import/status", { job });
            if (mounted.current) setImportJob(s.state === "running" ? s : null);
            if (s.state === "done") {
                changed(mounted.current ? await load() : null);
                onPick(s.song_id);
                return;
            }
            if (s.state === "error") throw new Error(s.error);
        }
    });
    const importLink = () => importCover(() => rpc("/api/voicelab/import/link", { url: link.trim() }))
        .then(() => mounted.current && setLink(""));
    const importMedia = (file) => {
        if (!file) return;
        importCover(() => {
            const form = new FormData();
            form.append("file", file);
            return upload("/api/voicelab/import/file", form, _t("Import failed."));
        });
        if (mediaRef.current) mediaRef.current.value = "";
    };

    const importUltrastar = async (files) => {
        if (!files?.length) return;
        await run("import", async () => {
            const form = new FormData();
            for (const f of files) form.append("files", f);
            form.append("vocals", importMode);
            const body = await upload("/api/songs/import", form, _t("Import failed."));
            changed(body);
            onPick(body.id);
        });
        if (fileRef.current) fileRef.current.value = "";
    };

    const uploadDance = async (file) => {
        if (!file) return;
        await run("dance", async () => {
            const form = new FormData();
            form.append("file", file);
            form.append("name", file.name.replace(/\.[^.]+$/, ""));
            changed(await upload("/api/songs/dances/upload", form, _t("Upload failed.")));
        });
        if (danceRef.current) danceRef.current.value = "";
    };
    const saveDance = (d, patch) => run("dance", async () => changed(await rpc("/api/songs/dances/save", { ...d, ...patch })));

    const meta = (r) => [
        r.artist || (r.kind === "companion" ? _t("Written by a companion") : r.kind === "builtin" ? _t("Built-in") : ""),
        r.source === "cover" ? _t("from a link or video") : r.source === "ultrastar" ? "UltraStar" : "",
        r.duration ? formatClock(r.duration) : "",
        r.duet ? _t("duet") : "",
        r.summary || "",
    ].filter(Boolean).join(" · ");

    // Portalled to <body>: the Stage panel's backdrop blur makes it the
    // containing block for fixed children, which trapped the popup inside it.
    return createPortal((
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className="rx_dialog rx_dialog--songs" role="dialog" aria-modal="true"
                 onMouseDown={(ev) => ev.stopPropagation()}>
                <div className="rx_songs_head">
                    <h4><i className="fa fa-music" /> {_t("Songs")}</h4>
                    <div className="rx_songs_tabs">
                        {[["songs", _t("Choose")], ["add", _t("Add songs")], ["dances", _t("Dances")]].map(([id, label]) => (
                            <button key={id} className={"btn btn-sm " + (tab === id ? "btn-primary" : "btn-light")}
                                    onClick={() => setTab(id)}>{label}</button>
                        ))}
                    </div>
                </div>
                {importJob && (
                    <div className="rx_songs_progress">
                        <i className="fa fa-spinner fa-spin" /> {importJob.stage} ({Math.round((importJob.progress || 0) * 100)}%)
                    </div>
                )}

                {tab === "songs" && (
                    <>
                        <div className="rx_songs_search">
                            <input ref={searchRef} type="search" value={query} placeholder={_t("Search by title or artist")}
                                   onChange={(e) => setQuery(e.target.value)}
                                   onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) pick(shown[0]); }} />
                            <select value={sort} onChange={(e) => setSort(e.target.value)} title={_t("Sort")}>
                                <option value="title">{_t("A to Z")}</option>
                                <option value="recent">{_t("Newest first")}</option>
                            </select>
                        </div>
                        <div className="rx_songs_filters">
                            {/* "By companions": songs from the retired create_song tool, if any are left */}
                            {FILTERS.filter(([id]) => id !== "companion" || count(id)).map(([id, label]) => (
                                <button key={id} className={"rx_songs_chip" + (filter === id ? " is-active" : "")}
                                        onClick={() => setFilter(id)}>
                                    {label} <span>{count(id)}</span>
                                </button>
                            ))}
                        </div>
                        <div className="rx_songs_list">
                            {!lib && <div className="rx_songs_empty"><i className="fa fa-spinner fa-spin" /></div>}
                            {lib && !shown.length && (
                                <div className="rx_songs_empty">
                                    {rows.length ? _t("No songs match.") : _t("No songs yet: add one on the Add songs tab.")}
                                </div>
                            )}
                            {shown.map((r) => (
                                <div key={r.id || r.key} className={"rx_songs_row" + (r.id && r.id === selectedId ? " is-selected" : "")}>
                                    <button className="rx_songs_pick" disabled={!!busy} onClick={() => pick(r)}>
                                        <span className="rx_songs_title">
                                            {r.title}
                                            {r.learned && <i className="fa fa-microphone rx_songs_learned" title={_t("%s knows this one", who)} />}
                                        </span>
                                        <span className="rx_songs_meta">{meta(r)}</span>
                                    </button>
                                    {r.id && (
                                        <button className="btn btn-sm btn-light" disabled={!!busy} onClick={() => remove(r)}
                                                title={_t("Delete song")}>
                                            <i className="fa fa-trash" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {tab === "add" && (
                    <div className="rx_songs_body">
                        <h5>{_t("From a link or a video")}</h5>
                        {lab?.status?.installed ? (
                            <>
                                <p>{_t("Paste a link to a song (YouTube and most video or music sites) or pick a video or audio file. The Voice Lab separates the music from the singer, finds the lyrics (LRCLIB, or by listening) and charts the melody; a voice profile then sings it in place of the original singer. Only use songs you have the right to use: downloading from YouTube is against its Terms of Service unless the video allows it.")}</p>
                                <div className="rx_songs_inline">
                                    <input type="text" value={link} placeholder="https://…" disabled={busy === "cover"}
                                           onChange={(e) => setLink(e.target.value)}
                                           onKeyDown={(e) => { if (e.key === "Enter" && link.trim()) importLink(); }} />
                                    <button className="btn btn-sm btn-primary" disabled={busy === "cover" || !link.trim()} onClick={importLink}>
                                        <i className="fa fa-link" /> {_t("Import")}
                                    </button>
                                </div>
                                <button className="btn btn-sm btn-light" disabled={busy === "cover"} onClick={() => mediaRef.current?.click()}>
                                    <i className="fa fa-film" /> {_t("Video or audio file…")}
                                </button>
                                <input ref={mediaRef} type="file" hidden accept="audio/*,video/*"
                                       onChange={(e) => importMedia(e.target.files?.[0])} />
                            </>
                        ) : (
                            <p>{_t("Needs the Voice Lab: install it in Settings → Voice Lab.")}</p>
                        )}
                        <h5>{_t("UltraStar songs")}</h5>
                        <p>{_t("UltraStar songs: pick the .txt together with its audio (and its instrumental, if the song has one). Charts for thousands of songs are shared by the UltraStar community; the audio is your own.")}</p>
                        <div className="rx_songs_inline">
                            <select value={importMode} onChange={(e) => setImportMode(e.target.value)}
                                    title={_t("What to do with the original singer on a full mix")}>
                                <option value="auto">{_t("Use the instrumental if included")}</option>
                                <option value="reduce">{_t("Reduce the original vocals (centre cut)")}</option>
                                <option value="keep">{_t("Keep the audio as it is")}</option>
                            </select>
                            <button className="btn btn-sm btn-light" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                                <i className={busy === "import" ? "fa fa-spinner fa-spin" : "fa fa-upload"} /> {_t("Import UltraStar song…")}
                            </button>
                        </div>
                        <input ref={fileRef} type="file" multiple hidden accept=".txt,.mp3,.ogg,.wav,.flac,.opus"
                               onChange={(e) => importUltrastar([...e.target.files])} />
                    </div>
                )}

                {tab === "dances" && (
                    <div className="rx_songs_body">
                        <p>{_t("MMD motions (.vmd) and VRM animations (.vrma). Link an MMD dance to the song it was made for and it plays in sync, start to finish; unlinked dances join the mix for every song.")}</p>
                        <div className="rx_songs_list is-short">
                            {(lib?.dances || []).map((d) => (
                                <div key={d.id} className="rx_songs_dance">
                                    <div className="rx_songs_dance_head">
                                        <strong>{d.name}</strong> <span className="text-muted">.{d.kind}</span>
                                        <button className="btn btn-sm btn-light" disabled={!!busy}
                                                onClick={() => run("dance", async () => changed(await rpc("/api/songs/dances/delete", { id: d.id })))}
                                                title={_t("Delete dance")}><i className="fa fa-trash" /></button>
                                    </div>
                                    <div className="rx_songs_inline">
                                        <select value={d.song_id || ""} onChange={(e) => saveDance(d, { song_id: e.target.value ? Number(e.target.value) : null })}
                                                title={_t("The song this dance was made for")}>
                                            <option value="">{_t("Any song")}</option>
                                            {(lib?.songs || []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                                        </select>
                                        {d.song_id && (
                                            <label title={_t("Where the dance's first frame falls on the song, in milliseconds (MMD dances often start a few seconds in)")}>
                                                {_t("Offset ms")}
                                                <input type="number" defaultValue={d.offset_ms} step={10}
                                                       onBlur={(e) => saveDance(d, { offset_ms: Number(e.target.value) || 0 })} />
                                            </label>
                                        )}
                                        {d.kind === "vmd" && (
                                            <label title={_t("How far below horizontal the MMD model's arms rest (the standard Miku model: 30°). Raise it if the arms float, lower it if they cross the body.")}>
                                                {_t("Arm angle")}
                                                <input type="number" defaultValue={d.arm_angle} min={0} max={60} step={1}
                                                       onBlur={(e) => saveDance(d, { arm_angle: Number(e.target.value) })} />
                                            </label>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {lib && !lib.dances.length && <div className="rx_songs_empty">{_t("No dances of your own yet; the built-in ones always join in.")}</div>}
                        </div>
                        <button className="btn btn-sm btn-light" disabled={!!busy} onClick={() => danceRef.current?.click()}>
                            <i className={busy === "dance" ? "fa fa-spinner fa-spin" : "fa fa-upload"} /> {_t("Add dance…")}
                        </button>
                        <input ref={danceRef} type="file" hidden accept=".vmd,.vrma" onChange={(e) => uploadDance(e.target.files?.[0])} />
                    </div>
                )}

                <div className="rx_dialog_actions">
                    <button className="btn btn-secondary" onClick={onClose}>{_t("Close")}</button>
                </div>
            </div>
        </div>
    ), document.body);
}
