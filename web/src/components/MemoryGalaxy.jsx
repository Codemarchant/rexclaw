import React, { useEffect, useMemo, useRef, useState } from "react";
import { _t } from "../lib/i18n";
import { applyTopicTerms, buildGalaxy, NEIGHBOUR_COUNT } from "../lib/memory_galaxy";
import { rpc } from "../lib/rpc";
import { GalaxyRenderer } from "../services/galaxy_renderer";
import { fmtLocal } from "./HeartbeatsPanel.jsx";

/** Memory Galaxy: the Memories tab as a star map. Each memory is a star;
 *  memories about the same things gather into a spiral galaxy named after
 *  its topic, oldest at the core, newest on the rim. Replay rebuilds the
 *  whole relationship in the order it was remembered.
 *
 *  `memories` is the filtered set (companion/type/scope); `query` only
 *  highlights, so search doesn't reshuffle the sky. */

const hueCss = (c, l = 66) => (c ? `hsl(${Math.round(c.hue * 360)}, 75%, ${l}%)` : "hsl(216, 18%, 86%)");

function fmtDate(ms) {
    if (!ms) return "";
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function MemoryGalaxy({ memories, query, active, onEdit, onForget }) {
    const wrapRef = useRef(null);
    const hostRef = useRef(null);
    const rendererRef = useRef(null);
    const [selected, setSelected] = useState(-1);
    const [hover, setHover] = useState(null);         // {index, x, y}
    const [reveal, setReveal] = useState(null);       // rank while replaying/scrubbing, null = all
    const [playing, setPlaying] = useState(false);
    const [topicsOpen, setTopicsOpen] = useState(true);
    const [fullscreen, setFullscreen] = useState(false);

    // Re-lay out only when the set itself changes, not on every reload.
    const key = memories.map((m) => `${m.id}:${m.scope}:${(m.content || "").length}`).join(",");
    // The meaning-based graph for this set, then its re-ranked galaxy names;
    // either answering null (not embedded yet, or the request failed) keeps
    // the word-based version. Laid out once both answer, so the sky doesn't
    // reshuffle or rename itself a moment after opening.
    const [built, setBuilt] = useState({ key: null, layout: null });
    useEffect(() => {
        let live = true;
        const orNull = (p, pick) => p.then((r) => pick(r) ?? null, () => null);
        (async () => {
            if (!memories.length) return setBuilt({ key, layout: null });
            const neighbours = await orNull(
                rpc("/api/memories/neighbours", { ids: memories.map((m) => m.id), k: NEIGHBOUR_COUNT }),
                (r) => r?.neighbours);
            const galaxy = buildGalaxy(memories, neighbours);
            if (neighbours && galaxy.clusters.length) {
                applyTopicTerms(galaxy, await orNull(rpc("/api/memories/topic-terms", {
                    topics: galaxy.clusters.map((c) => ({ docs: c.representatives, words: c.candidates })),
                }), (r) => r?.terms));
            }
            if (live) setBuilt({ key, layout: galaxy });
        })();
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    const layout = built.key === key ? built.layout : null;

    const q = (query || "").trim().toLowerCase();
    const matches = useMemo(() => {
        if (!layout || !q) return null;
        const set = new Set();
        for (const s of layout.stars) {
            const m = s.mem;
            if ([m.content, m.keywords, m.tags, m.agent_name].some((f) => (f || "").toLowerCase().includes(q))) set.add(s.index);
        }
        return set;
    }, [layout, q]);

    useEffect(() => {
        const r = new GalaxyRenderer(hostRef.current, {
            onHover: (index, x, y) => setHover(index >= 0 ? { index, x, y } : null),
            onSelect: (index) => setSelected(index),
            onReveal: (rank, done) => {
                setReveal(done ? null : rank);
                if (done) setPlaying(false);
            },
            onLabelClick: (id) => {
                setSelected(-1);
                rendererRef.current?.flyToCluster(id);
            },
        });
        rendererRef.current = r;
        window.__galaxy = r; // console handle, like __voiceRenderer
        return () => {
            r.dispose();
            rendererRef.current = null;
            if (window.__galaxy === r) delete window.__galaxy;
        };
    }, []);

    useEffect(() => {
        const r = rendererRef.current;
        if (!r) return;
        if (layout) r.setData(layout);
        setSelected(-1);
        setReveal(null);
        setPlaying(false);
    }, [layout]);

    useEffect(() => { rendererRef.current?.setMatches(matches); }, [matches, layout]);
    useEffect(() => { rendererRef.current?.select(selected); }, [selected]);
    useEffect(() => { rendererRef.current?.setActive(!!active && !!layout); }, [active, layout]);

    useEffect(() => {
        const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current);
        document.addEventListener("fullscreenchange", onFs);
        return () => document.removeEventListener("fullscreenchange", onFs);
    }, []);

    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else wrapRef.current?.requestFullscreen?.();
    };

    const togglePlay = () => {
        const r = rendererRef.current;
        if (!r || !layout) return;
        if (playing) {
            r.pause();
            setPlaying(false);
            return;
        }
        setSelected(-1);
        r.play(reveal == null ? -1 : Math.floor(reveal));
        setPlaying(true);
    };

    const scrub = (value) => {
        const r = rendererRef.current;
        if (!r || !layout) return;
        const n = layout.stars.length;
        const rank = Number(value);
        setPlaying(false);
        if (rank >= n - 1) {
            r.setReveal(null);
            setReveal(null);
        } else {
            r.setReveal(rank);
            setReveal(rank);
        }
    };

    const edit = (m) => {
        if (document.fullscreenElement) document.exitFullscreen();
        onEdit(m);
    };

    if (!layout) {
        return (
            <div ref={wrapRef} className="rx_galaxy">
                <div ref={hostRef} className="rx_galaxy_host" />
                <div className="rx_galaxy_empty">
                    {memories.length ? _t("Loading…") : _t("No memories match your filters.")}
                </div>
            </div>
        );
    }

    const { stars, clusters, related } = layout;
    const n = stars.length;
    const shownRank = reveal == null ? n - 1 : Math.min(n - 1, Math.floor(reveal));
    const shownCount = reveal == null ? n : shownRank + 1;
    const sel = selected >= 0 ? stars[selected] : null;
    const selCluster = sel ? clusters[sel.cluster] : null;
    const hov = hover && hover.index !== selected ? stars[hover.index] : null;
    const stray = stars.filter((s) => s.cluster < 0).length;

    return (
        <div ref={wrapRef} className={"rx_galaxy" + (fullscreen ? " is-fullscreen" : "")}>
            <div ref={hostRef} className="rx_galaxy_host" />

            <div className="rx_galaxy_hud">
                <div className="rx_galaxy_title">
                    <i className="fa fa-star-o" /> {_t("Memory Galaxy")}
                </div>
                <div className="rx_galaxy_stats">
                    {_t("%s memories · %s topics", shownCount, clusters.filter((c) => c.firstRank <= shownRank).length)}
                    {stars[0]?.born ? ` · ${_t("since %s", fmtDate(stars[0].born))}` : ""}
                    {matches && ` · ${_t("%s matches", matches.size)}`}
                </div>
                {!!clusters.length && (
                    <div className="rx_galaxy_topics">
                        <button type="button" className="rx_galaxy_topics_toggle" onClick={() => setTopicsOpen(!topicsOpen)}>
                            <i className={"fa " + (topicsOpen ? "fa-caret-down" : "fa-caret-right")} /> {_t("Topics")}
                        </button>
                        {topicsOpen && clusters.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                className="rx_galaxy_topic"
                                title={c.terms.join(", ")}
                                disabled={c.firstRank > shownRank}
                                onClick={() => { setSelected(-1); rendererRef.current?.flyToCluster(c.id); }}
                            >
                                <span className="rx_galaxy_dot" style={{ background: hueCss(c) }} />
                                <span className="rx_galaxy_topic_name">{c.label}</span>
                                <span className="rx_galaxy_topic_n">{c.size}</span>
                            </button>
                        ))}
                        {topicsOpen && stray > 0 && (
                            <div className="rx_galaxy_topic rx_galaxy_topic--stray" title={_t("Memories with no close neighbours drift around the edge.")}>
                                <span className="rx_galaxy_dot" style={{ background: hueCss(null) }} />
                                <span className="rx_galaxy_topic_name">{_t("stray stars")}</span>
                                <span className="rx_galaxy_topic_n">{stray}</span>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="rx_galaxy_actions">
                <button type="button" className="rx_galaxy_btn" onClick={() => { setSelected(-1); rendererRef.current?.home(); }} title={_t("Back to the whole sky")}>
                    <i className="fa fa-home" />
                </button>
                <button type="button" className="rx_galaxy_btn" onClick={toggleFullscreen} title={fullscreen ? _t("Exit full screen") : _t("Full screen")}>
                    <i className={"fa " + (fullscreen ? "fa-compress" : "fa-expand")} />
                </button>
            </div>

            {hov && (
                <div className="rx_galaxy_tip" style={{ left: hover.x, top: hover.y }}>
                    <div className="rx_galaxy_tip_meta">
                        <span className="rx_galaxy_dot" style={{ background: hueCss(clusters[hov.cluster]) }} />
                        {hov.episode ? _t("episode") : _t("fact")}{hov.core ? ` · ${_t("core")}` : ""} · {fmtDate(hov.born)}
                    </div>
                    <div className="rx_galaxy_tip_text">
                        {(hov.mem.content || "").length > 160 ? hov.mem.content.slice(0, 160) + "…" : hov.mem.content}
                    </div>
                </div>
            )}

            {sel && (
                <div className="rx_galaxy_card" style={{ "--c": hueCss(selCluster) }}>
                    <button type="button" className="rx_galaxy_card_close" onClick={() => setSelected(-1)} title={_t("Close")}>
                        <i className="fa fa-times" />
                    </button>
                    <div className="rx_galaxy_card_topic">
                        <span className="rx_galaxy_dot" style={{ background: hueCss(selCluster) }} />
                        {selCluster ? selCluster.label : _t("stray stars")}
                    </div>
                    <div className="rx_galaxy_card_badges">
                        <span className={"rx_mem_badge" + (sel.episode ? " rx_mem_badge--episode" : "")}>
                            {sel.episode ? _t("episode") : _t("fact")}
                        </span>
                        <span className="rx_memory_scope">{sel.mem.scope}</span>
                        {sel.recent && <span className="rx_galaxy_recent">{_t("recently recalled")}</span>}
                    </div>
                    <div className="rx_galaxy_card_text">{sel.mem.content}</div>
                    {sel.episode && sel.mem.keywords && (
                        <div className="rx_galaxy_card_kw">{sel.mem.keywords}</div>
                    )}
                    <div className="rx_galaxy_card_meta">
                        {sel.mem.agent_name || _t("all companions")}
                        {sel.mem.tags ? ` · ${sel.mem.tags}` : ""}
                        <br />
                        {_t("Remembered %s", fmtLocal(sel.mem.created_at))}
                        {sel.mem.last_used_at ? <><br />{_t("Last recalled %s", fmtLocal(sel.mem.last_used_at))}</> : null}
                    </div>
                    {!!related[sel.index].length && (
                        <div className="rx_galaxy_related">
                            <div className="rx_galaxy_related_title">{_t("Connected memories")}</div>
                            {related[sel.index].map((r) => {
                                const o = stars[r.index];
                                return (
                                    <button key={r.index} type="button" className="rx_galaxy_related_item" onClick={() => setSelected(r.index)}>
                                        <span className="rx_galaxy_dot" style={{ background: hueCss(clusters[o.cluster]) }} />
                                        <span className="rx_galaxy_related_text">{o.mem.content}</span>
                                        <span className="rx_galaxy_related_sim">{Math.round(r.sim * 100)}%</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <div className="rx_galaxy_card_actions">
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => edit(sel.mem)}>
                            <i className="fa fa-pencil" /> {_t("Edit")}
                        </button>
                        <button type="button" className="btn btn-sm btn-link" onClick={() => onForget(sel.mem.id)}>
                            <i className="fa fa-trash-o" /> {_t("Forget")}
                        </button>
                    </div>
                </div>
            )}

            <div className="rx_galaxy_timeline">
                <button type="button" className="rx_galaxy_play" onClick={togglePlay} title={playing ? _t("Pause") : _t("Replay how these memories formed, oldest first")}>
                    <i className={"fa " + (playing ? "fa-pause" : "fa-play")} />
                    <span>{playing ? _t("Pause") : _t("Replay")}</span>
                </button>
                <input
                    type="range"
                    min={0}
                    max={n - 1}
                    step={0.01}
                    value={reveal == null ? n - 1 : reveal}
                    onChange={(e) => scrub(e.target.value)}
                    title={_t("Scrub through time")}
                />
                <span className="rx_galaxy_date">{fmtDate(stars[shownRank]?.born)}</span>
            </div>

            {!sel && (
                <div className="rx_galaxy_legend">
                    <span><i className="rx_glyph rx_glyph--fact" /> {_t("fact")}</span>
                    <span><i className="rx_glyph rx_glyph--episode" /> {_t("episode")}</span>
                    <span><i className="rx_glyph rx_glyph--core" /> {_t("core")}</span>
                    <span><i className="rx_glyph rx_glyph--recent" /> {_t("recently recalled")}</span>
                </div>
            )}
        </div>
    );
}
