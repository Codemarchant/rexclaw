// Shared list-order preference for the management list views (Companions,
// Avatars). Two modes: 'name' (A–Z, the default) and 'created' (row id =
// creation order, which for the seeded rows is also their deliberate crew
// arrangement). The choice is per-view and remembered in localStorage.
import { useState } from "react";

const MODES = ["name", "created"];

export function useListSort(storageKey, defaultMode = "name") {
    const [sortBy, setSortByState] = useState(() => {
        try {
            const stored = localStorage.getItem(storageKey);
            return MODES.includes(stored) ? stored : defaultMode;
        } catch (e) { return defaultMode; /* private mode */ }
    });
    const setSortBy = (mode) => {
        setSortByState(mode);
        try { localStorage.setItem(storageKey, mode); } catch (e) { /* private mode */ }
    };
    const apply = (rows) => sortBy === "created"
        ? [...rows].sort((a, b) => (a.id || 0) - (b.id || 0))
        : [...rows].sort((a, b) =>
            (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
    return { sortBy, setSortBy, apply };
}
