// Selected-outfit preference, keyed per avatar in localStorage so it
// survives page instances and reloads — the mascot pop-out is a fresh page
// whose hydration would otherwise snap back to the avatar's default outfit.
// Written by the outfit dropdown and the change_outfit tool; read wherever
// an avatar is hydrated from scratch.

export function storeOutfitPref(avatarId, outfitId) {
    if (!avatarId) return;
    try {
        const key = `rexclaw.outfit.${avatarId}`;
        if (Number(outfitId)) localStorage.setItem(key, String(outfitId));
        else localStorage.removeItem(key);  // 0 = default outfit → base VRM
    } catch (e) { /* private mode — selection stays per-page */ }
}

/** The stored outfit entry for this avatar payload, or null when the
 *  default is selected / the stored id no longer exists. */
export function storedOutfit(avatar) {
    if (!avatar?.id) return null;
    try {
        const id = Number(localStorage.getItem(`rexclaw.outfit.${avatar.id}`));
        if (!id) return null;
        return (avatar.outfits || []).find((o) => Number(o.id) === id) || null;
    } catch (e) {
        return null;
    }
}
