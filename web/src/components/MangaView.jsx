import React, { useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";
import { useReactive } from "../lib/reactive";
import { uiState } from "../lib/ui_state";
import Pager, { usePager } from "./Pager.jsx";
import MangaReader from "./MangaReader.jsx";

const LAYOUTS = [
    { id: "page", label: "Full page (4–6 panels)" },
    { id: "yonkoma", label: "4-koma strip" },
];
const STYLES = [
    { id: "mono", label: "Black & white screentone" },
    { id: "color", label: "Colour" },
];
const ARTS = [
    { id: "photo", label: "Live photoshoot" },
    { id: "scenes", label: "Photoshoot in Imagine-painted scenes" },
    { id: "illustrated", label: "Imagine-illustrated panels" },
];
const ART_HINTS = {
    photo: "Your companion poses in their current scene. No extra cost.",
    scenes: "Grok Imagine paints each panel's setting and your companion poses in it: one image per panel, billed to your xAI account.",
    illustrated: "Grok Imagine draws every panel from the outfit's portrait: one image per panel, billed to your xAI account. A panel it can't draw is photographed instead.",
};

const MAX_LINES = 3;               // balloons per panel (server/manga.py MAX_LINES)
const PAGE_PANELS = [3, 6];        // a full page's panel range (the server keeps 3 at least)
const MAX_PAGES = 20;              // pages storyboarded in one go (server/manga.py MAX_PAGES)
const MAX_CAST = 5;                // other companions on a page (server/manga.py MAX_CAST)
const MAX_WITH = 3;                // of them in one panel

function blankPanel() {
    return {
        beat: "", shot: "bust", angle: "front", emotion: "neutral", pose: "none", mark: "none",
        effect: "none", sfx: "", caption: "", size: "medium", outfit: "", scene: "", action: "",
        art_url: "", with_user: false, user_emotion: "neutral", with: [],
        lines: [{ who: "companion", text: "", style: "speech" }],
    };
}

const label = (value) => String(value).replace(/_/g, " ");

function fmtDay(iso) {
    if (!iso) return "";
    const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/** History → Manga: turn one episode of a conversation into a manga
 *  chapter of one or more pages. The source is an episode memory (the
 *  stretch a compaction rolled up) or the latest stretch no episode covers
 *  yet — never a whole months-long conversation — or nothing at all, when
 *  the user writes the page themselves. The model writes a storyboard
 *  (editable here, outfit included), then the Voice tab runs the
 *  photoshoot (MangaStudio) and the finished chapters collect in the
 *  gallery below, where an episode's chapter can be continued. */
export default function MangaView({ active }) {
    const ui = useReactive(uiState);
    const [pages, setPages] = useState(null);
    const [sources, setSources] = useState({ episodes: [], recent: [] });
    const [agents, setAgents] = useState([]);
    const [form, setForm] = useState({
        agentId: "", source: "", layout: "page", style: "mono", art: "photo", focus: "", pages: 1,
        continueFrom: null,   // { chapterId, title, lastPage } — "Next page" on a chapter
        cast: [],             // [{ id, outfit }] other companions who may appear ('' = what they wear)
        mode: "pick",         // pick (one episode) | combine (several episodes) | script (the user's own)
        combine: [],          // episode ids ticked in combine mode
        scriptText: "",
    });
    const [query, setQuery] = useState("");
    // { agentId, sessionId, episodeId, trimmed, own, pages: [script], cur }
    const [board, setBoard] = useState(null);
    const [busy, setBusy] = useState(false);
    const [viewing, setViewing] = useState(null);   // { chapterId, index }

    const load = async () => {
        try {
            const [p, s, a] = await Promise.all([
                rpc("/api/manga/list", {}), rpc("/api/manga/sources", {}), rpc("/api/voice/agents", {}),
            ]);
            setPages(p);
            setSources(s);
            setAgents(a.agents || []);
            setForm((f) => {
                if (f.agentId) return f;
                const first = s.recent[0] || s.episodes[0];
                const id = first?.agent_id ?? (a.agents || [])[0]?.id;
                return id ? { ...f, agentId: String(id) } : f;
            });
        } catch (e) {
            notification.add(e?.message || _t("Could not load the manga pages"), { type: "danger" });
        }
    };
    useEffect(() => { if (active) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [active]);

    // Chapters: pages stacked by chapter, in page order. Newest first, by
    // when the story happened ("story": the episode's date) or by when the
    // chapter was last drawn to ("drawn").
    const [galleryOrder, setGalleryOrder] = useState("story");
    const [galleryAgent, setGalleryAgent] = useState("");   // "" = every companion
    const galleryAgents = useMemo(() => {
        const seen = new Map();
        for (const p of pages || []) seen.set(p.agent_id, p.agent_name);
        return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    }, [pages]);
    const chapters = useMemo(() => {
        const byId = new Map();
        for (const p of pages || []) {
            if (!byId.has(p.chapter_id)) byId.set(p.chapter_id, []);
            byId.get(p.chapter_id).push(p);
        }
        return [...byId.entries()]
            .map(([id, list]) => ({
                id, pages: list.sort((a, b) => a.page_no - b.page_no || a.id - b.id),
                newest: Math.max(...list.map((p) => p.id)),
                storyAt: list.map((p) => p.story_at || p.created_at || "").sort().pop(),
            }))
            .sort((a, b) => (galleryOrder === "story" && a.storyAt !== b.storyAt
                ? (a.storyAt < b.storyAt ? 1 : -1)
                : b.newest - a.newest));
    }, [pages, galleryOrder]);
    const shownChapters = galleryAgent
        ? chapters.filter((c) => String(c.pages[0].agent_id) === galleryAgent) : chapters;
    const galleryPager = usePager(shownChapters.length);
    const openPage = (page) => {
        const ch = chapters.find((c) => c.id === page.chapter_id);
        setViewing({ chapterId: page.chapter_id, index: Math.max(0, ch ? ch.pages.findIndex((p) => p.id === page.id) : 0) });
    };
    const viewed = viewing && chapters.find((c) => c.id === viewing.chapterId);

    // A finished photoshoot asks for its page.
    useEffect(() => {
        const id = ui.openMangaPage;
        if (!id || !pages) return;
        const page = pages.find((p) => p.id === id);
        if (page) {
            uiState.openMangaPage = null;
            openPage(page);
            setBoard(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ui.openMangaPage, pages]);

    // Every companion with an avatar to pose (a page can be written by hand
    // without any conversation), plus any with episodes but no avatar now.
    const companions = useMemo(() => {
        const seen = new Map(agents.filter((a) => a.avatar?.vrm_url).map((a) => [a.id, a.name]));
        for (const x of [...sources.recent, ...sources.episodes]) seen.set(x.agent_id, x.agent_name);
        return [...seen].map(([id, name]) => ({ id, name }));
    }, [sources, agents]);
    const recent = sources.recent.filter((r) => String(r.agent_id) === form.agentId);
    const episodes = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sources.episodes.filter((e) => String(e.agent_id) === form.agentId
            && (!q || e.summary.toLowerCase().includes(q)));
    }, [sources, form.agentId, query]);
    const pager = usePager(episodes.length);
    const agentOf = (id) => agents.find((a) => Number(a.id) === Number(id));

    // The cast: other companions who may appear on the page, up to five,
    // each in an outfit picked here. The roster is every companion with an
    // avatar but the page's own.
    const roster = agents.filter((a) => a.avatar?.vrm_url && String(a.id) !== form.agentId);
    const castMembers = (list) => list
        .map((c) => ({ id: c.id, name: agentOf(c.id)?.name || "", outfit: c.outfit || "" }))
        .filter((m) => m.name);
    const setCast = (list) => {
        setForm((f) => ({ ...f, cast: list }));
        // An open storyboard follows: members join the cast, and anyone
        // dropped leaves every panel they stood in.
        if (board) {
            const members = castMembers(list);
            const names = new Set(members.map((m) => m.name));
            setBoard((b) => ({
                ...b, pages: b.pages.map((s) => ({
                    ...s, cast: members,
                    panels: s.panels.map((p) => ({ ...p, with: (p.with || []).filter((w) => names.has(w.name)) })),
                })),
            }));
        }
    };
    const toggleCast = (id) => setCast(form.cast.some((c) => c.id === id)
        ? form.cast.filter((c) => c.id !== id)
        : form.cast.length < MAX_CAST ? [...form.cast, { id, outfit: "" }] : form.cast);
    const setCastOutfit = (id, outfit) => setCast(form.cast.map((c) => (c.id === id ? { ...c, outfit } : c)));
    const wardrobe = board ? (agentOf(board.agentId)?.avatar?.outfits || []) : [];

    // What the storyboard is written from, by mode: one episode (or the
    // latest stretch), several episodes read together, or the user's own
    // script for the chosen companion.
    const [kind, rawId] = form.source.split(":");
    const sourceId = form.mode === "pick" ? Number(rawId) || null : null;
    const combineIds = [...form.combine].sort((a, b) => a - b);
    const sourceKey = form.mode === "script" ? "script"
        : form.mode === "combine" ? `episodes:${combineIds.join(",")}` : form.source;
    const sourceReady = form.mode === "script" ? !!form.scriptText.trim()
        : form.mode === "combine" ? combineIds.length > 0 : !!sourceId;
    const episodeDay = (id) => sources.episodes.find((e) => e.id === id)?.created_at;
    const sourceDate = form.mode === "script" ? fmtDay(new Date().toISOString())
        : form.mode === "combine"
            ? [...new Set([combineIds[0], combineIds[combineIds.length - 1]].map((id) => fmtDay(episodeDay(id))))]
                .filter(Boolean).join(" – ")
            : kind === "episode" ? fmtDay(episodeDay(sourceId))
                : fmtDay(sources.recent.find((r) => r.session_id === sourceId)?.last_at);
    const toggleCombine = (id) => setForm((f) => ({
        ...f, continueFrom: null,
        combine: f.combine.includes(id) ? f.combine.filter((x) => x !== id) : [...f.combine, id],
    }));

    const writeStoryboard = async () => {
        if (!sourceReady) return;
        setBusy(true);
        try {
            const cont = form.continueFrom;
            const from = form.mode === "script"
                ? { source: "script", text: form.scriptText, agent_id: Number(form.agentId) }
                : form.mode === "combine" ? { source: "episodes", source_ids: combineIds }
                    : { source: kind, source_id: sourceId };
            const r = await rpc("/api/manga/script", {
                ...from, layout: form.layout, focus: form.focus, art: form.art,
                pages: form.pages, chapter_id: cont?.chapterId || null, cast: form.cast,
            });
            setBoard({
                agentId: r.agent_id, sessionId: r.session_id, episodeId: r.episode_id, trimmed: r.trimmed,
                source: sourceKey,   // what it was written from — "Rewrite" only applies to that
                cur: 0, pages: r.scripts.map((s) => ({ ...s, style: form.style, art: form.art, date: sourceDate })),
            });
        } catch (e) {
            notification.add(e?.message || _t("Could not write the storyboard"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };

    /** A blank page for the chosen companion, no conversation behind it:
     *  the user writes every panel. Dated today, in the outfit the
     *  companion has on. */
    const blankPage = (from = null) => {
        const agent = agentOf(form.agentId);
        const outfits = agent?.avatar?.outfits || [];
        const wearing = outfits.find((o) => Number(o.id) === Number(agent?.current_outfit_id)) || outfits[0];
        return {
            title: from?.title || "", subtitle: "", chapter_id: from?.chapter_id || null,
            page_no: from ? from.page_no + 1 : 1, layout: from?.layout || form.layout,
            outfit: from?.outfit || wearing?.name || "", style: form.style, art: form.art,
            date: from?.date || fmtDay(new Date().toISOString()),
            cast: from?.cast || castMembers(form.cast),
            panels: Array.from({ length: 4 }, blankPanel),
        };
    };
    const writeOwn = () => setBoard({
        agentId: Number(form.agentId), sessionId: null, episodeId: null, trimmed: false, own: true,
        cur: 0, pages: [blankPage()],
    });

    const startShoot = (scripts, { agentId, sessionId, episodeId = null, pageId = null }) => {
        // Balloons left empty in the editor are not lettered.
        scripts = scripts.map((s) => ({
            ...s, title: s.title.trim() || _t("Untitled"),
            panels: s.panels.map((p) => ({ ...p, lines: p.lines.filter((l) => l.text.trim()) })),
        }));
        // The cast members' models, each in the outfit picked for them
        // (else what they have on now).
        const cast = (scripts[0].cast || []).map((m) => {
            const outfits = agentOf(m.id)?.avatar?.outfits || [];
            const other = agentOf(m.id);
            const chosen = outfits.find((o) => sameName(o.name, m.outfit))
                || outfits.find((o) => Number(o.id) === Number(other?.current_outfit_id)) || outfits[0];
            return { name: m.name, avatar: other?.avatar && chosen ? { ...other.avatar, vrm_url: chosen.vrm_url } : null };
        }).filter((m) => m.avatar);
        uiState.pendingManga = {
            agentId, sessionId, episodeId, pageId, scripts, cast,
            userAvatar: sources.user_avatar || null, userHasPhoto: !!sources.user_has_photo,
        };
        uiState.requestedTab = "voice";
    };
    // Whether "you" can be in a panel: an avatar can be posed; a photo only
    // feeds Imagine-drawn panels.
    const userCanAppear = (art) => !!sources.user_avatar || (!!sources.user_has_photo && art === "illustrated");

    // The storyboard editor works on the page tab that's open.
    const script = board ? board.pages[board.cur] : null;
    const mapCur = (fn) => setBoard((b) => ({ ...b, pages: b.pages.map((s, k) => (k === b.cur ? fn(s) : s)) }));
    const setScript = (patch) => mapCur((s) => ({ ...s, ...patch }));
    const setAllPages = (patch) => setBoard((b) => ({ ...b, pages: b.pages.map((s) => ({ ...s, ...patch })) }));
    const editPanel = (i, patch) => mapCur((s) => ({
        ...s, panels: s.panels.map((p, k) => (k === i ? { ...p, ...patch } : p)),
    }));
    const editLine = (i, j, patch) => editPanel(i, {
        lines: script.panels[i].lines.map((l, k) => (k === j ? { ...l, ...patch } : l)),
    });
    const addLine = (i) => editPanel(i, {
        lines: [...script.panels[i].lines, { who: "companion", text: "", style: "speech" }],
    });
    const removeLine = (i, j) => editPanel(i, { lines: script.panels[i].lines.filter((l, k) => k !== j) });
    const setPanels = (panels) => setScript({ panels });
    const addPage = () => setBoard((b) => ({
        ...b, cur: b.pages.length, pages: [...b.pages, blankPage(b.pages[b.pages.length - 1])],
    }));
    const removePage = (k) => setBoard((b) => {
        const first = b.pages[0].page_no;
        const kept = b.pages.filter((s, x) => x !== k).map((s, x) => ({ ...s, page_no: first + x }));
        return { ...b, pages: kept, cur: Math.min(b.cur, kept.length - 1) };
    });
    const setFormAndBoard = (key, value) => {
        setForm((f) => ({ ...f, [key]: value }));
        if (board && (key === "style" || key === "art")) setAllPages({ [key]: value });
    };

    /** "Next page" on a chapter drawn from an episode: back to the form with
     *  that episode picked, set to continue after the chapter's last page. */
    const continueChapter = (chapter) => {
        const last = chapter.pages[chapter.pages.length - 1];
        // A chapter drawn from combined episodes continues from all of them.
        const ids = last.script?.episode_ids?.length > 1 ? last.script.episode_ids : null;
        setForm((f) => ({
            ...f, agentId: String(last.agent_id), layout: last.layout, pages: 1,
            mode: ids ? "combine" : "pick", combine: ids || [], source: `episode:${last.episode_id}`,
            continueFrom: { chapterId: chapter.id, title: last.title, lastPage: last.page_no },
        }));
        setViewing(null);
        setBoard(null);
    };

    const remove = async (page) => {
        if (!await confirmAsk(_t("Delete the manga page \"%s\"?", page.title))) return;
        try {
            await rpc("/api/manga/delete", { id: page.id });
            setViewing(null);
            load();
        } catch (e) {
            notification.add(e?.message || _t("Could not delete the page"), { type: "danger" });
        }
    };

    const sameName = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
    const companionName = agentOf(board?.agentId)?.name || "";
    const imagine = script && script.art !== "photo";
    const yonkoma = script?.layout === "yonkoma";
    const vocab = sources.vocab || {};
    const userOutfits = sources.user_avatar?.outfits || [];

    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <section>
                    <h3><i className="fa fa-book" /> {_t("Manga Diary")}</h3>
                    <p className="text-muted small" style={{ margin: "0 0 0.85rem" }}>
                        {_t("Turn an episode of a conversation into a manga page starring your companion. Episodes are the chapters your companions' memory already keeps: each compaction rolls a stretch of conversation into one. The storyboard is written from that stretch alone, then your companion poses for every panel and the photos are inked into screentone art and lettered.")}
                    </p>
                    {!companions.length ? (
                        <p className="text-muted small">{_t("No conversations yet. Talk or chat with a companion first.")}</p>
                    ) : (
                        <>
                            <div className="rx_manga_source_head">
                                <select value={form.agentId}
                                        onChange={(e) => {
                                            // The page's own companion can't also be in its cast.
                                            setForm({ ...form, agentId: e.target.value, source: "", combine: [],
                                                      continueFrom: null,
                                                      cast: form.cast.filter((c) => String(c.id) !== e.target.value) });
                                            pager.setPage(0);
                                        }}>
                                    {companions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                </select>
                                {form.mode !== "script" && (
                                    <input type="text" value={query} placeholder={_t("Search episodes…")}
                                           onChange={(e) => { setQuery(e.target.value); pager.setPage(0); }} />
                                )}
                            </div>
                            <div className="rx_manga_modes">
                                {[["pick", "fa-bookmark-o", "One episode"], ["combine", "fa-clone", "Combine episodes"],
                                  ["script", "fa-file-text-o", "Your own script"]].map(([id, icon, text]) => (
                                    <button key={id} type="button" className={"btn btn-sm" + (form.mode === id ? " btn-primary" : "")}
                                            onClick={() => setForm({ ...form, mode: id, continueFrom: null })}>
                                        <i className={"fa " + icon} /> {_t(text)}
                                    </button>
                                ))}
                                {form.mode === "combine" && (
                                    <span className="text-muted small">
                                        {combineIds.length
                                            ? _t("%s episodes ticked, read together oldest first", combineIds.length)
                                            : _t("Tick the episodes to read together.")}
                                    </span>
                                )}
                            </div>
                            {form.mode === "script" ? (
                                <textarea className="rx_manga_script" rows={10} value={form.scriptText}
                                          placeholder={_t("Write or paste the story you want drawn: who says what, what happens, where. Name the speakers, e.g.\nEve: You made pancakes? From scratch?\nYou: Every single one.")}
                                          onChange={(e) => setForm({ ...form, scriptText: e.target.value, continueFrom: null })} />
                            ) : (<>
                            <div className="rx_manga_sources">
                                {form.mode === "pick" && recent.map((r) => {
                                    const key = `recent:${r.session_id}`;
                                    return (
                                        <button key={key} className={"rx_manga_source" + (form.source === key ? " is-active" : "")}
                                                onClick={() => setForm({ ...form, source: key, continueFrom: null })}>
                                            <span className="rx_manga_source_meta">
                                                <i className="fa fa-clock-o" /> {r.has_episodes ? _t("Since the last episode") : _t("Latest conversation")}
                                                {" · "}{fmtDay(r.last_at)}{" · "}{_t("%s messages", r.messages)}
                                            </span>
                                            <span className="rx_manga_source_text">{r.session_name}</span>
                                        </button>
                                    );
                                })}
                                {pager.slice(episodes).map((e) => {
                                    const key = `episode:${e.id}`;
                                    const combining = form.mode === "combine";
                                    const on = combining ? form.combine.includes(e.id) : form.source === key;
                                    return (
                                        <button key={key} className={"rx_manga_source" + (on ? " is-active" : "")}
                                                onClick={() => (combining ? toggleCombine(e.id)
                                                    : setForm({ ...form, source: key, continueFrom: null }))}>
                                            <span className="rx_manga_source_meta">
                                                <i className={"fa " + (combining ? (on ? "fa-check-square-o" : "fa-square-o") : "fa-bookmark-o")} />{" "}
                                                {_t("Episode")} · {fmtDay(e.created_at)}
                                                {e.drawn > 0 && <span className="rx_manga_badge"><i className="fa fa-check" /> {e.drawn === 1 ? _t("1 page drawn") : _t("%s pages drawn", e.drawn)}</span>}
                                            </span>
                                            <span className="rx_manga_source_text">{e.summary}</span>
                                        </button>
                                    );
                                })}
                                {!(form.mode === "pick" && recent.length) && !episodes.length && (
                                    <p className="text-muted small">{_t("Nothing matches.")}</p>
                                )}
                            </div>
                            <Pager pager={pager} />
                            </>)}
                            <div className="rx_manga_form">
                                <label>
                                    <span>{_t("Format")}</span>
                                    <select value={form.layout} onChange={(e) => setForm({ ...form, layout: e.target.value })}>
                                        {LAYOUTS.map((l) => <option key={l.id} value={l.id}>{_t(l.label)}</option>)}
                                    </select>
                                </label>
                                <label>
                                    <span>{_t("Style")}</span>
                                    <select value={form.style} onChange={(e) => setFormAndBoard("style", e.target.value)}>
                                        {STYLES.map((s) => <option key={s.id} value={s.id}>{_t(s.label)}</option>)}
                                    </select>
                                </label>
                                <label>
                                    <span>{_t("Art")}</span>
                                    <select value={form.art} onChange={(e) => setFormAndBoard("art", e.target.value)}>
                                        {ARTS.map((s) => <option key={s.id} value={s.id}>{_t(s.label)}</option>)}
                                    </select>
                                </label>
                                <label>
                                    <span>{_t("Pages")}</span>
                                    <select value={form.pages} onChange={(e) => setForm({ ...form, pages: Number(e.target.value) })}>
                                        {Array.from({ length: MAX_PAGES }, (x, k) => k + 1).map((n) => (
                                            <option key={n} value={n}>{n}</option>
                                        ))}
                                    </select>
                                </label>
                                <p className="text-muted small rx_manga_form_wide" style={{ margin: 0 }}>{_t(ART_HINTS[form.art])}</p>
                                {form.pages > 4 && (
                                    <p className="text-muted small rx_manga_form_wide" style={{ margin: 0 }}>
                                        {/* ~5 panels a page (4 for a strip) at the studio's ~2.5 s a panel. */}
                                        {_t("Up to %s pages: the storyboard stops sooner if the episode runs out of moments. The photoshoot takes about %s minutes; each page is saved as soon as it's done.",
                                            form.pages, Math.max(1, Math.round((form.pages * (form.layout === "yonkoma" ? 4 : 5) * 2.5) / 60)))}
                                    </p>
                                )}
                                {roster.length > 0 && (
                                    <div className="rx_manga_form_wide">
                                        <span className="rx_manga_form_label">
                                            {_t("Cast (optional): other companions who took part, up to %s", MAX_CAST)}
                                        </span>
                                        <div className="rx_manga_wardrobe">
                                            {roster.map((a) => {
                                                const picked = form.cast.find((c) => c.id === a.id);
                                                const outfits = a.avatar?.outfits || [];
                                                const shown = (picked && outfits.find((o) => sameName(o.name, picked.outfit)))
                                                    || outfits.find((o) => Number(o.id) === Number(a.current_outfit_id)) || outfits[0];
                                                return (
                                                    <div key={a.id} className="rx_manga_cast">
                                                        <button type="button" title={a.name}
                                                                className={"rx_manga_outfit" + (picked ? " is-active" : "")}
                                                                disabled={!picked && form.cast.length >= MAX_CAST}
                                                                onClick={() => toggleCast(a.id)}>
                                                            {shown?.portrait_url ? <img src={shown.portrait_url} alt="" /> : <i className="fa fa-user" />}
                                                            <span>{a.name}</span>
                                                        </button>
                                                        {picked && outfits.length > 1 && (
                                                            <select value={picked.outfit} title={_t("Outfit")}
                                                                    onChange={(e) => setCastOutfit(a.id, e.target.value)}>
                                                                <option value="">{_t("What they wear now")}</option>
                                                                {outfits.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                                                            </select>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                                {form.continueFrom && (
                                    <p className="rx_manga_continue rx_manga_form_wide">
                                        <i className="fa fa-forward" />{" "}
                                        {_t("Continuing \"%s\" after page %s: the storyboard picks up where it left off.", form.continueFrom.title, form.continueFrom.lastPage)}
                                        <button type="button" className="btn btn-sm btn-link" title={_t("Start a new chapter instead")}
                                                onClick={() => setForm({ ...form, continueFrom: null })}>
                                            <i className="fa fa-times" />
                                        </button>
                                    </p>
                                )}
                                <label className="rx_manga_form_wide">
                                    <span>{_t("Focus (optional)")}</span>
                                    <input type="text" value={form.focus} maxLength={300}
                                           placeholder={_t("e.g. the part where we planned the trip")}
                                           onChange={(e) => setForm({ ...form, focus: e.target.value })} />
                                </label>
                                <div className="rx_manga_form_wide">
                                    <button className="btn btn-primary" disabled={busy || !sourceReady} onClick={writeStoryboard}>
                                        {busy
                                            ? <><i className="fa fa-spinner fa-spin" /> {_t("Writing the storyboard…")}</>
                                            : <><i className="fa fa-pencil" /> {board?.source === sourceKey ? _t("Rewrite storyboard") : _t("Write storyboard")}</>}
                                    </button>
                                    <button className="btn" style={{ marginLeft: "0.5rem" }} disabled={busy || !form.agentId}
                                            title={_t("Start from a blank storyboard and write every panel yourself: no episode, no model call")}
                                            onClick={writeOwn}>
                                        <i className="fa fa-pencil-square-o" /> {_t("Write it yourself")}
                                    </button>
                                    {!sourceReady && form.mode !== "script" && <span className="text-muted small" style={{ marginLeft: "0.6rem" }}>{_t("Pick an episode above, or write the page yourself.")}</span>}
                                </div>
                            </div>
                        </>
                    )}
                </section>

                {board && (
                    <section>
                        <div className="rx_manga_board_head">
                            <input type="text" className="rx_manga_board_title" value={script.title} maxLength={80}
                                   placeholder={_t("Chapter title")}
                                   onChange={(e) => setAllPages({ title: e.target.value })} />
                            <button className="btn btn-primary"
                                    onClick={() => startShoot(board.pages, board)}>
                                <i className="fa fa-camera" /> {_t("Start the photoshoot")}
                            </button>
                        </div>
                        {/* Page tabs: the editor below works on the open one. */}
                        <div className="rx_manga_page_tabs">
                            {board.pages.map((s, k) => (
                                <span key={k} className={"rx_manga_page_tab" + (k === board.cur ? " is-active" : "")}>
                                    <button type="button" onClick={() => setBoard({ ...board, cur: k })}>
                                        {_t("Page %s", s.page_no)}
                                    </button>
                                    {board.pages.length > 1 && (
                                        <button type="button" title={_t("Remove this page")} onClick={() => removePage(k)}>
                                            <i className="fa fa-times" />
                                        </button>
                                    )}
                                </span>
                            ))}
                            {board.pages.length < MAX_PAGES && (
                                <button type="button" className="btn btn-sm btn-link" onClick={addPage}>
                                    <i className="fa fa-plus" /> {_t("Page")}
                                </button>
                            )}
                            <input type="text" className="rx_manga_subtitle" value={script.subtitle || ""} maxLength={80}
                                   placeholder={_t("Page subtitle (optional)")}
                                   onChange={(e) => setScript({ subtitle: e.target.value })} />
                        </div>
                        <p className="text-muted small" style={{ margin: "0.3rem 0 0.8rem" }}>
                            {_t("Edit any line before the shoot. %s will pose on the Voice tab; it takes about two seconds a panel.", companionName)}
                            {board.trimmed && <> {_t("This conversation was long, so only its most recent part was read.")}</>}
                        </p>
                        {wardrobe.length > 0 && (
                            <div className="rx_manga_wardrobe">
                                {wardrobe.map((o) => (
                                    <button key={o.id} title={o.name}
                                            className={"rx_manga_outfit" + (sameName(o.name, script.outfit) ? " is-active" : "")}
                                            onClick={() => setScript({ outfit: o.name })}>
                                        {o.portrait_url ? <img src={o.portrait_url} alt="" /> : <i className="fa fa-user" />}
                                        <span>{o.name}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <ol className="rx_manga_board">
                            {script.panels.map((p, i) => {
                                // Direction dropdowns, values straight from the server's vocabulary.
                                const pick = (key, field = key, title = key) => (
                                    <label className="rx_manga_pick" title={_t(title)}>
                                        <span>{_t(title)}</span>
                                        <select value={p[field]} onChange={(e) => editPanel(i, { [field]: e.target.value, art_url: "" })}>
                                            {(vocab[key] || [p[field]]).map((v) => <option key={v} value={v}>{label(v)}</option>)}
                                        </select>
                                    </label>
                                );
                                return (
                                    <li key={i}>
                                        <div className="rx_manga_panel_head">
                                            <span className="rx_manga_board_beat">{p.beat || _t("Panel %s", i + 1)}</span>
                                            {!yonkoma && script.panels.length > PAGE_PANELS[0] && (
                                                <button type="button" className="btn btn-sm btn-link" title={_t("Remove this panel")}
                                                        onClick={() => setPanels(script.panels.filter((x, k) => k !== i))}>
                                                    <i className="fa fa-trash" />
                                                </button>
                                            )}
                                        </div>
                                        <div className="rx_manga_picks">
                                            {pick("shot", "shot", "Shot")}
                                            {pick("angle", "angle", "Angle")}
                                            {pick("emotion", "emotion", "Face")}
                                            {pick("pose", "pose", "Pose")}
                                            {pick("mark", "mark", "Symbol")}
                                            {pick("effect", "effect", "Effect")}
                                            {!yonkoma && pick("size", "size", "Size")}
                                            {wardrobe.length > 1 && (
                                                <label className="rx_manga_pick" title={_t("Outfit")}>
                                                    <span>{_t("Outfit")}</span>
                                                    <select value={p.outfit || ""}
                                                            onChange={(e) => editPanel(i, { outfit: e.target.value, art_url: "" })}>
                                                        <option value="">{_t("Page outfit")}</option>
                                                        {wardrobe.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                                                    </select>
                                                </label>
                                            )}
                                            {userCanAppear(script.art) && (
                                                <button type="button" title={_t("Show you in this panel beside %s", companionName)}
                                                        className={"rx_manga_with_user" + (p.with_user ? " is-active" : "")}
                                                        onClick={() => editPanel(i, {
                                                            with_user: !p.with_user, art_url: "",
                                                            shot: !p.with_user && p.shot === "closeup" ? "bust" : p.shot,
                                                        })}>
                                                    <i className="fa fa-user-plus" /> {_t("with you")}
                                                </button>
                                            )}
                                            {p.with_user && userCanAppear(script.art) && pick("emotion", "user_emotion", "Your face")}
                                            {p.with_user && userOutfits.length > 1 && (
                                                <label className="rx_manga_pick" title={_t("Your outfit")}>
                                                    <span>{_t("Your outfit")}</span>
                                                    <select value={p.user_outfit || ""}
                                                            onChange={(e) => editPanel(i, { user_outfit: e.target.value, art_url: "" })}>
                                                        <option value="">{_t("Usual")}</option>
                                                        {userOutfits.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                                                    </select>
                                                </label>
                                            )}
                                            {(script.cast || []).map((m) => {
                                                const w = (p.with || []).find((x) => x.name === m.name);
                                                const memberOutfits = agentOf(m.id)?.avatar?.outfits || [];
                                                const full = !w && (p.with || []).length >= MAX_WITH;
                                                const setWith = (list) => editPanel(i, {
                                                    with: list, art_url: "",
                                                    shot: list.length && p.shot === "closeup" ? "bust" : p.shot,
                                                });
                                                return (
                                                    <React.Fragment key={m.id}>
                                                        <button type="button" disabled={full}
                                                                title={_t("Show %s in this panel", m.name)}
                                                                className={"rx_manga_with_user" + (w ? " is-active" : "")}
                                                                onClick={() => setWith(w
                                                                    ? p.with.filter((x) => x.name !== m.name)
                                                                    : [...(p.with || []), { name: m.name, emotion: "neutral" }])}>
                                                            <i className="fa fa-user-plus" /> {m.name}
                                                        </button>
                                                        {w && (
                                                            <label className="rx_manga_pick" title={_t("%s's face", m.name)}>
                                                                <span>{_t("%s's face", m.name)}</span>
                                                                <select value={w.emotion}
                                                                        onChange={(e) => setWith(p.with.map((x) => (x.name === m.name
                                                                            ? { ...x, emotion: e.target.value } : x)))}>
                                                                    {(vocab.emotion || [w.emotion]).map((v) => <option key={v} value={v}>{label(v)}</option>)}
                                                                </select>
                                                            </label>
                                                        )}
                                                        {w && memberOutfits.length > 1 && (
                                                            <label className="rx_manga_pick" title={_t("%s's outfit", m.name)}>
                                                                <span>{_t("%s's outfit", m.name)}</span>
                                                                <select value={w.outfit || ""}
                                                                        onChange={(e) => setWith(p.with.map((x) => (x.name === m.name
                                                                            ? { ...x, outfit: e.target.value } : x)))}>
                                                                    <option value="">{_t("Cast outfit")}</option>
                                                                    {memberOutfits.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                                                                </select>
                                                            </label>
                                                        )}
                                                    </React.Fragment>
                                                );
                                            })}
                                        </div>
                                        {imagine && (
                                            <div className="rx_manga_scene">
                                                <input type="text" value={p.scene} title={_t("Scene")} placeholder={_t("Scene")}
                                                       onChange={(e) => editPanel(i, { scene: e.target.value, art_url: "" })} />
                                                {script.art === "illustrated" && (
                                                    <input type="text" value={p.action} title={_t("Action")} placeholder={_t("Action")}
                                                           onChange={(e) => editPanel(i, { action: e.target.value, art_url: "" })} />
                                                )}
                                            </div>
                                        )}
                                        <input type="text" className="rx_manga_caption" value={p.caption} maxLength={120}
                                               placeholder={_t("Caption (optional)")}
                                               onChange={(e) => editPanel(i, { caption: e.target.value })} />
                                        {p.lines.map((l, j) => (
                                            <div key={j} className={"rx_manga_line rx_manga_line--" + l.who}>
                                                <select value={l.who} onChange={(e) => editLine(i, j, { who: e.target.value })}>
                                                    <option value="companion">{companionName}</option>
                                                    <option value="user">{_t("You")}</option>
                                                    {(script.cast || []).map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
                                                </select>
                                                <select value={l.style} onChange={(e) => editLine(i, j, { style: e.target.value })}>
                                                    {(vocab.style || [l.style]).map((v) => <option key={v} value={v}>{_t(label(v))}</option>)}
                                                </select>
                                                <input type="text" value={l.text} maxLength={160} placeholder={_t("What they say")}
                                                       onChange={(e) => editLine(i, j, { text: e.target.value })} />
                                                <button type="button" className="btn btn-sm btn-link" title={_t("Remove this balloon")}
                                                        onClick={() => removeLine(i, j)}>
                                                    <i className="fa fa-times" />
                                                </button>
                                            </div>
                                        ))}
                                        <div className="rx_manga_panel_foot">
                                            {p.lines.length < MAX_LINES && (
                                                <button type="button" className="btn btn-sm btn-link" onClick={() => addLine(i)}>
                                                    <i className="fa fa-plus" /> {_t("Balloon")}
                                                </button>
                                            )}
                                            <input type="text" className="rx_manga_sfx" value={p.sfx} maxLength={16}
                                                   placeholder={_t("Sound effect (optional)")}
                                                   onChange={(e) => editPanel(i, { sfx: e.target.value })} />
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                        {!yonkoma && script.panels.length < PAGE_PANELS[1] && (
                            <button type="button" className="btn btn-sm" style={{ marginTop: "0.6rem" }}
                                    onClick={() => setPanels([...script.panels, blankPanel()])}>
                                <i className="fa fa-plus" /> {_t("Add a panel")}
                            </button>
                        )}
                    </section>
                )}

                <section>
                    <div className="rx_manga_gallery_head">
                        <h3><i className="fa fa-th" /> {_t("Pages")}</h3>
                        <span style={{ flex: 1 }} />
                        {galleryAgents.length > 1 && (
                            <select value={galleryAgent} title={_t("Companion")}
                                    onChange={(e) => { setGalleryAgent(e.target.value); galleryPager.setPage(0); }}>
                                <option value="">{_t("All companions")}</option>
                                {galleryAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                        )}
                        {chapters.length > 1 && (
                            <select value={galleryOrder} title={_t("Order")}
                                    onChange={(e) => { setGalleryOrder(e.target.value); galleryPager.setPage(0); }}>
                                <option value="story">{_t("Newest conversation first")}</option>
                                <option value="drawn">{_t("Recently drawn first")}</option>
                            </select>
                        )}
                    </div>
                    {!pages ? (
                        <p className="text-muted small">{_t("Loading…")}</p>
                    ) : !pages.length ? (
                        <p className="text-muted small">{_t("No pages yet. Your first one is a storyboard away.")}</p>
                    ) : (<>
                        <Pager pager={galleryPager} />
                        <div className="rx_manga_gallery">
                            {galleryPager.slice(shownChapters).map((c) => {
                                const first = c.pages[0];
                                return (
                                    <button key={c.id} className={"rx_manga_card" + (c.pages.length > 1 ? " is-stack" : "")}
                                            onClick={() => setViewing({ chapterId: c.id, index: 0 })}>
                                        <img src={first.image_url} alt="" loading="lazy" />
                                        <span className="rx_manga_card_title">
                                            {first.title}
                                            {c.pages.length > 1 && <span className="rx_manga_card_pages">{_t("%s pages", c.pages.length)}</span>}
                                        </span>
                                        <span className="rx_manga_card_meta">{first.agent_name} · {first.script?.date || (first.created_at || "").slice(0, 10)}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <Pager pager={galleryPager} />
                    </>)}
                </section>
            </div>

            {/* The same full-screen stage the photoshoot reveals its pages on. */}
            {viewed && (() => {
                const page = viewed.pages[Math.min(viewing.index, viewed.pages.length - 1)];
                return (
                    <div className="rx_manga_studio" onClick={() => setViewing(null)}>
                        <MangaReader pages={viewed.pages} index={viewed.pages.indexOf(page)}
                                     onIndex={(index) => setViewing({ ...viewing, index })}
                                     onClose={() => setViewing(null)}>
                            <a className="btn btn-sm" href={page.image_url} download={`${page.title} ${page.page_no}.png`}>
                                <i className="fa fa-download" /> {_t("Download")}
                            </a>
                            <button className="btn btn-sm" title={_t("Pose this page's storyboard again, in today's scene (painted art is reused)")}
                                    onClick={() => startShoot([page.script], {
                                        agentId: page.agent_id, sessionId: page.session_id,
                                        episodeId: page.episode_id, pageId: page.id,
                                    })}>
                                <i className="fa fa-camera" /> {_t("Re-shoot")}
                            </button>
                            {page.episode_id && (
                                <button className="btn btn-sm" title={_t("Storyboard more pages of this episode, picking up after the last one")}
                                        onClick={() => continueChapter(viewed)}>
                                    <i className="fa fa-pencil" /> {_t("Continue the chapter")}
                                </button>
                            )}
                            <button className="btn btn-sm" onClick={() => remove(page)}>
                                <i className="fa fa-trash" /> {_t("Delete")}
                            </button>
                            <button className="btn btn-sm" onClick={() => setViewing(null)}>
                                <i className="fa fa-times" /> {_t("Close")}
                            </button>
                        </MangaReader>
                    </div>
                );
            })()}
        </div>
    );
}
