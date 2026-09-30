import React, { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { layoutPage, composePage } from "../lib/manga_page";
import {
    artShot, beginShoot, clearLineup, currentVrmUrl, endShoot, lineupSig, loadArt, panelLineup, restoreOutfit,
    setLineup, shootPanel, sizeHost, waitForAvatar, wearOutfit,
} from "../lib/manga_shoot";
import MangaReader from "./MangaReader.jsx";

const VIEWFINDER_MAX_W = 0.72;   // × window width
const VIEWFINDER_MAX_H = 0.58;   // × window height
const BEAT_PAUSE_MS = 420;       // after each shot, so the flash reads
const PAINT_PARALLEL = 3;        // Imagine requests in flight at once

const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A camera shutter: a short band-passed noise burst, synthesized. */
function shutter() {
    try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const len = Math.round(ac.sampleRate * 0.09);
        const buf = ac.createBuffer(1, len, ac.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
        const src = ac.createBufferSource();
        src.buffer = buf;
        const band = ac.createBiquadFilter();
        band.type = "bandpass";
        band.frequency.value = 2400;
        band.Q.value = 0.8;
        const gain = ac.createGain();
        gain.gain.value = 0.35;
        src.connect(band).connect(gain).connect(ac.destination);
        src.onended = () => ac.close();
        src.start();
    } catch (e) { /* no audio, no click */ }
}

function thumbnail(shot) {
    const h = 96;
    const w = Math.max(1, Math.round((shot.figure.width / shot.figure.height) * h));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(0, 0, w, h);
    if (shot.backdrop) ctx.drawImage(shot.backdrop, 0, 0, w, h);
    ctx.drawImage(shot.figure, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.8);
}

const SHOT_LABEL = {
    closeup: "Close-up", bust: "Bust shot", waist: "Waist shot", full: "Full body", wide: "Wide shot",
};
const ANGLE_LABEL = {
    front: "front", left: "three-quarter left", right: "three-quarter right",
    low: "low angle", high: "high angle", dutch: "dutch angle",
};

/** Manga Diary photoshoot, over the Voice tab, for one page or a chapter
 *  of several: with the Imagine extra on, every panel is painted first;
 *  then the companion poses for each panel that needs a photo — changing
 *  outfits where the storyboard says, with the user's avatar stepping in
 *  for two-shots — while a film strip fills; then each page is inked,
 *  lettered and saved. `job` comes from History → Manga: { agentId,
 *  avatarId, avatar, agentName, sessionId, episodeId, pageId?, scripts,
 *  cast: [{name, avatar}], userAvatar, userHasPhoto } (pageId: a re-shoot
 *  of that one page). */
export default function MangaStudio({ job, onClose }) {
    const hostRef = useRef(null);
    const cancelled = useRef(false);
    const savedRef = useRef([]);   // page rows saved so far, in order
    const pages = job.scripts;
    const layouts = useMemo(() => pages.map((s) => layoutPage(s)), [pages]);
    // Every panel of every page, in shooting order.
    const cells = useMemo(() => pages.flatMap((s, pi) => s.panels.map((p, i) => ({ pi, i }))), [pages]);
    const [phase, setPhase] = useState("loading");   // painting|loading|shooting|done|error
    const [at, setAt] = useState(0);                 // index into cells
    const [painted, setPainted] = useState(0);
    const [note, setNote] = useState("");
    const [thumbs, setThumbs] = useState([]);        // by cell index
    const [flashKey, setFlashKey] = useState(0);
    const [saved, setSaved] = useState([]);
    const [inking, setInking] = useState(false);   // a finished page is being inked and saved
    const [reading, setReading] = useState(0);
    const [error, setError] = useState("");
    const [fit, setFit] = useState(1);

    const cur = cells[at] || cells[0];
    const current = layouts[cur.pi].panels[cur.i];

    useEffect(() => {
        const host = hostRef.current;
        let shooting = false;
        const fitTo = (panel) => {
            const dpr = window.devicePixelRatio || 1;
            setFit(Math.min(1,
                (window.innerWidth * VIEWFINDER_MAX_W) / (panel.shotW / dpr),
                (window.innerHeight * VIEWFINDER_MAX_H) / (panel.shotH / dpr)));
        };
        const setThumb = (k, src) => setThumbs((t) => { const n = [...t]; n[k] = src; return n; });
        // Working copies: they collect the painted art (the saved script
        // carries it, so a re-shoot reuses it) and the chapter id.
        const scripts = pages.map((s) => ({ ...s, panels: s.panels.map((p) => ({ ...p })) }));
        const spec = (c) => scripts[c.pi].panels[c.i];
        const layoutOf = (c) => layouts[c.pi].panels[c.i];
        const art = scripts[0].art || "photo";
        (async () => {
            // 1. Imagine art for the panels that don't have it yet. A panel
            //    it can't paint (a refusal, an error) falls back to the photo.
            let failed = 0;
            if (art !== "photo") {
                setPhase("painting");
                const todo = cells.map((c, k) => k).filter((k) => !spec(cells[k]).art_url);
                setPainted(cells.length - todo.length);
                cells.forEach((c, k) => spec(c).art_url && setThumb(k, spec(c).art_url));
                const worker = async () => {
                    while (todo.length && !cancelled.current) {
                        const k = todo.shift();
                        const c = cells[k];
                        const lp = layoutOf(c);
                        try {
                            const r = await rpc("/api/manga/paint", {
                                agent_id: job.agentId, script: scripts[c.pi], index: c.i, mode: art,
                                aspect: lp.shotW / lp.shotH,
                            });
                            spec(c).art_url = r.art_url;
                            setThumb(k, r.art_url);
                        } catch (e) {
                            failed++;
                            console.warn("[manga] panel art failed", c, e);
                        }
                        setPainted((n) => n + 1);
                    }
                };
                await Promise.all(Array.from({ length: PAINT_PARALLEL }, worker));
                if (cancelled.current) return;
                if (failed) {
                    setNote(art === "illustrated"
                        ? _t("%s panel(s) couldn't be painted, so they're photographed instead.", failed)
                        : _t("%s scene(s) couldn't be painted and keep the usual backdrop.", failed));
                }
            }

            // 2. The photoshoot, for every panel without a painted whole.
            const shots = scripts.map(() => []);
            const needsPhoto = (p) => art !== "illustrated" || !p.art_url;
            if (cells.some((c) => needsPhoto(spec(c)))) {
                setPhase("loading");
                fitTo(layoutOf(cells[0]));
                sizeHost(host, layoutOf(cells[0]));
                if (!await waitForAvatar(job.avatarId)) throw new Error(_t("The companion's avatar did not load."));
                if (cancelled.current) return;
                shooting = beginShoot(host);
                if (!shooting) throw new Error(_t("The avatar is busy (walking, dancing or in VR). Try again in a moment."));
            }
            const wornBefore = currentVrmUrl();
            // Cast members and the user's avatar (Settings → "Your avatar")
            // stand beside the companion in group shots; a painted group
            // shot was drawn from their likenesses, left to right.
            let lineup = [];
            const userLikeness = !!(job.userAvatar || job.userHasPhoto);
            const drawnKeys = (p) => [
                ...(p.with || []).map((w) => w.name).filter((n) => (job.cast || []).some((c) => c.name === n)),
                ...(p.with_user && userLikeness ? ["user"] : []),
            ];
            // 3. Each page is inked, lettered and saved as soon as its last
            //    panel is in, and its photos let go: a twenty-page chapter
            //    never holds more than one page of full-size photos, and a
            //    failure late on keeps the pages already done. The first
            //    page of a new chapter opens it; the rest are saved under
            //    its id.
            const inkPage = async (pi) => {
                setInking(true);
                setNote(_t("Inking page %s…", pi + 1));
                // Let the note paint before the (synchronous) compose.
                await frame();
                await frame();
                const script = scripts[pi];
                if (!script.chapter_id && savedRef.current[0]) script.chapter_id = savedRef.current[0].chapter_id;
                const page = composePage({
                    script, layout: layouts[pi], shots: shots[pi],
                    agentName: job.agentName, dateText: script.date || "",
                });
                shots[pi] = null;
                savedRef.current.push(await rpc("/api/manga/save", {
                    agent_id: job.agentId,
                    session_id: job.sessionId || null,
                    episode_id: job.episodeId || null,
                    page_id: job.pageId || null,
                    script,
                    image_data_url: page.toDataURL("image/png"),
                }));
                setNote("");
                setInking(false);
            };
            setPhase("shooting");
            try {
                for (let k = 0; k < cells.length; k++) {
                    if (cancelled.current) return;
                    const c = cells[k];
                    const lp = layoutOf(c);
                    const p = spec(c);
                    const pageDone = k === cells.length - 1 || cells[k + 1].pi !== c.pi;
                    setAt(k);
                    if (!needsPhoto(p)) {
                        shots[c.pi].push(artShot(await loadArt(p.art_url, lp), lp, p, drawnKeys(p)));
                        if (pageDone) await inkPage(c.pi);
                        continue;
                    }
                    fitTo(lp);
                    sizeHost(host, lp);
                    const outfit = p.outfit || scripts[c.pi].outfit;
                    if (outfit) {
                        setNote(_t("Changing into %s…", outfit));
                        await wearOutfit(job.avatar, outfit);
                        setNote("");
                    }
                    const wanted = panelLineup(p, job.cast || [], job.userAvatar);
                    if (lineupSig(wanted) !== lineupSig(lineup)) {
                        if (wanted.length) setNote(_t("Setting up the group shot…"));
                        lineup = await setLineup(lineup, wanted);
                        setNote("");
                    }
                    const shot = await shootPanel(lp, p, lineup);
                    if (!shot) throw new Error(_t("Could not photograph the avatar."));
                    if (art === "scenes" && p.art_url && !shot.room) shot.backdrop = await loadArt(p.art_url, lp);
                    shots[c.pi].push(shot);
                    shutter();
                    setFlashKey((n) => n + 1);
                    setThumb(k, thumbnail(shot));
                    await sleep(BEAT_PAUSE_MS);
                    if (pageDone) await inkPage(c.pi);
                }
            } finally {
                clearLineup(lineup);
                if (shooting) {
                    endShoot(host);
                    shooting = false;
                    await restoreOutfit(job.avatar, wornBefore);
                }
            }
            if (cancelled.current) return;
            setSaved([...savedRef.current]);
            setPhase("done");
        })().catch((e) => {
            if (cancelled.current) return;
            setError(e?.message || String(e));
            setSaved([...savedRef.current]);
            setPhase("error");
        });
        return () => {
            cancelled.current = true;
            if (shooting) endShoot(host);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const dpr = window.devicePixelRatio || 1;
    const cssW = current ? current.shotW / dpr : 0;
    const cssH = current ? current.shotH / dpr : 0;
    const spec = pages[cur.pi].panels[cur.i];
    const pagePanels = cells.map((c, k) => ({ ...c, k })).filter((c) => c.pi === cur.pi);

    return (
        <div className="rx_manga_studio" role="dialog" aria-label={_t("Manga photoshoot")}>
            {phase !== "done" && (
                <div className="rx_manga_studio_head">
                    <span className="rx_manga_studio_title">
                        <i className="fa fa-camera" /> {pages[0].title}
                    </span>
                    <span className="rx_manga_studio_status">
                        {phase === "painting" && _t("Painting with Grok Imagine… %s of %s", painted, cells.length)}
                        {phase === "loading" && _t("Getting %s ready…", job.agentName)}
                        {phase === "shooting" && (pages.length > 1
                            ? _t("Page %s of %s · panel %s of %s", cur.pi + 1, pages.length, cur.i + 1, pages[cur.pi].panels.length)
                            : _t("Panel %s of %s", cur.i + 1, pages[0].panels.length))}
                    </span>
                    {note && <span className="rx_manga_studio_note">{note}</span>}
                </div>
            )}

            {phase === "painting" && (
                <div className="rx_manga_painting"><i className="fa fa-paint-brush" /></div>
            )}
            <div className="rx_manga_viewfinder_wrap"
                 style={{ display: ["done", "error", "painting"].includes(phase) ? "none" : "",
                          width: cssW * fit, height: cssH * fit }}>
                <div ref={hostRef} className="o_voice_avatar_canvas rx_manga_viewfinder"
                     style={{ transform: `scale(${fit})` }} />
                <div className="rx_manga_viewfinder_marks" />
                {phase === "shooting" && spec && (
                    <div className="rx_manga_viewfinder_caption">
                        <b>{_t(SHOT_LABEL[spec.shot])}</b> · {_t(ANGLE_LABEL[spec.angle])}
                        {spec.beat ? <span> — {spec.beat}</span> : null}
                    </div>
                )}
                <div key={flashKey} className={flashKey ? "rx_manga_flash" : ""} />
                {inking && <div className="rx_manga_inking"><i className="fa fa-pencil" /></div>}
            </div>

            {phase !== "done" && phase !== "error" && (
                <div className="rx_manga_filmstrip">
                    {(phase === "painting" ? cells.map((c, k) => ({ ...c, k })) : pagePanels).map((c) => (
                        <div key={c.k} className={"rx_manga_film" + (c.k === at && phase === "shooting" ? " is-current" : "")}>
                            {thumbs[c.k] ? <img src={thumbs[c.k]} alt="" /> : <span>{c.i + 1}</span>}
                        </div>
                    ))}
                </div>
            )}

            {phase === "done" && saved.length > 0 && (
                <MangaReader pages={saved} index={reading} onIndex={setReading} onClose={() => onClose(null)}>
                    <a className="btn btn-sm" href={saved[reading].image_url} download={`${saved[reading].title}.png`}>
                        <i className="fa fa-download" /> {_t("Download")}
                    </a>
                    <button className="btn btn-sm btn-primary" onClick={() => onClose(saved[reading].id)}>
                        <i className="fa fa-book" /> {_t("Open in the gallery")}
                    </button>
                    <button className="btn btn-sm" onClick={() => onClose(null)}>
                        <i className="fa fa-times" /> {_t("Close")}
                    </button>
                </MangaReader>
            )}

            {phase === "error" && (
                <div className="rx_manga_error">
                    <p><i className="fa fa-exclamation-triangle" /> {error}</p>
                    {saved.length > 0 && (
                        <p>{_t("The %s page(s) finished before this were saved.", saved.length)}</p>
                    )}
                    {saved.length > 0 && (
                        <button className="btn btn-sm btn-primary" style={{ marginRight: "0.5rem" }}
                                onClick={() => setPhase("done")}>
                            {_t("See the saved pages")}
                        </button>
                    )}
                    <button className="btn btn-sm" onClick={() => onClose(null)}>{_t("Close")}</button>
                </div>
            )}

            {(phase === "painting" || phase === "loading" || phase === "shooting") && (
                <button className="btn btn-sm rx_manga_cancel" onClick={() => { cancelled.current = true; onClose(null); }}>
                    <i className="fa fa-times" /> {_t("Cancel")}
                </button>
            )}
        </div>
    );
}
