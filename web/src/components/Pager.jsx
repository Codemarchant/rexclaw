import React, { useState } from "react";
import { _t } from "../lib/i18n";

/** Odoo-style list pagination, shared by every list view: a "1-100 / 243"
 *  range, prev/next arrows, and a records-per-page select. The chosen page
 *  size persists app-wide (localStorage), defaulting to 100. The pager
 *  hides itself while the list fits the smallest size, so short lists stay
 *  clean. Usage:
 *      const pager = usePager(filtered.length);
 *      <Pager pager={pager} />
 *      {pager.slice(filtered).map(...)}
 */
const SIZES = [25, 50, 100, 250, 500];
const STORAGE_KEY = "rexclaw.page_size";

export function usePager(total) {
    const [size, setSizeState] = useState(() => {
        try {
            const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
            return SIZES.includes(v) ? v : 100;
        } catch (e) {
            return 100;
        }
    });
    const [page, setPage] = useState(0);
    const pages = Math.max(1, Math.ceil((total || 0) / size));
    const cur = Math.min(page, pages - 1); // clamps when filters shrink the list
    const start = cur * size;
    const end = Math.min(total || 0, start + size);
    const setSize = (v) => {
        try { localStorage.setItem(STORAGE_KEY, String(v)); } catch (e) { /* private mode */ }
        setSizeState(v);
        setPage(0);
    };
    return {
        total: total || 0, size, setSize, page: cur, setPage, pages, start, end,
        slice: (arr) => (arr || []).slice(start, end),
    };
}

export default function Pager({ pager }) {
    if (pager.total <= SIZES[0]) return null;
    return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end",
                      gap: "0.4rem", margin: "0.25rem 0" }}>
            <span className="text-muted small">{`${pager.start + 1}-${pager.end} / ${pager.total}`}</span>
            <button className="btn btn-sm" disabled={pager.page === 0}
                    title={_t("Previous page")}
                    onClick={() => pager.setPage(pager.page - 1)}>
                <i className="fa fa-chevron-left" />
            </button>
            <button className="btn btn-sm" disabled={pager.page >= pager.pages - 1}
                    title={_t("Next page")}
                    onClick={() => pager.setPage(pager.page + 1)}>
                <i className="fa fa-chevron-right" />
            </button>
            <select value={pager.size} style={{ width: "auto" }}
                    title={_t("Records per page")}
                    onChange={(ev) => pager.setSize(Number(ev.target.value))}>
                {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
        </div>
    );
}
