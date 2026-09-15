// Background picker model shared by the full-screen view and the desktop
// mascot (whose settings window shows the same list): which backgrounds a
// companion can switch to, which one is showing, and the one to start on.
// One place so both surfaces list and resolve identically.
import { _t } from "./i18n";

// Newest Imagine background of one kind ('still' | 'video'): the active one
// if it is of that kind (unless `includeActive` is off — hydration must not
// inherit the previous companion's), else this page's latest for the agent,
// else the server's.
function latestImagine(agent, state, kind, includeActive) {
    const type = kind === "video" ? "imagine_video" : "imagine";
    const active = state.activeBackground;
    if (includeActive && active && active.type === type) return active;
    const byAgent = kind === "video"
        ? state.latestImagineVideoBackgroundByAgent : state.latestImagineBackgroundByAgent;
    const inSession = byAgent?.[agent?.id];
    if (inSession) return inSession;
    return (kind === "video" ? agent?.latest_imagine_video_background : agent?.latest_imagine_background) || null;
}

/** Initial background for a freshly hydrated avatar — the SAME precedence
 *  the server uses at session start: tagged default → newest Imagine (still
 *  and animated are parallel "latest" tracks; most recent wins) → first. */
export function resolveDefaultBackground(agent, state) {
    const bgs = agent?.avatar?.backgrounds || [];
    const imagine = [latestImagine(agent, state, "still", false), latestImagine(agent, state, "video", false)]
        .filter(Boolean)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0] || null;
    return bgs.find((b) => b.is_default) || imagine || bgs[0] || null;
}

/** Picker entries: [{key, label, bg}], bg null = the avatar's own default.
 *  Still and animated Imagine backgrounds coexist as separate entries. */
export function backgroundPickerEntries(agent, state) {
    const backgrounds = agent?.avatar?.backgrounds || [];
    const imagine = latestImagine(agent, state, "still", true);
    const imagineVideo = latestImagine(agent, state, "video", true);
    const entries = [];
    if ((imagine || imagineVideo) && !backgrounds.length) {
        entries.push({ key: "default", label: _t("Default Background"), bg: null });
    }
    if (imagine) {
        const label = imagine.name ? `Imagine — ${imagine.name}` : _t("Imagine background");
        entries.push({ key: "imagine", label, bg: imagine });
    }
    if (imagineVideo) {
        const label = imagineVideo.name ? `Imagine ▶ ${imagineVideo.name}` : _t("Animated background");
        entries.push({ key: "imagine-video", label, bg: imagineVideo });
    }
    for (const bg of backgrounds) {
        entries.push({ key: `bg-${bg.id}`, label: bg.name, bg });
    }
    return entries;
}

/** Key of the entry that is showing ('' when the list is empty). */
export function currentBackgroundKey(agent, state, entries) {
    const active = state.activeBackground;
    if (active && active.type === "imagine") return "imagine";
    if (active && active.type === "imagine_video") return "imagine-video";
    if (active && active.id) return `bg-${active.id}`;
    const backgrounds = agent?.avatar?.backgrounds || [];
    const defaultBg = backgrounds.find((b) => b.is_default) || backgrounds[0];
    if (defaultBg) return `bg-${defaultBg.id}`;
    return entries.some((e) => e.key === "default") ? "default" : "";
}
