import React, { useEffect } from "react";
import { _t } from "../lib/i18n";

/** A chapter's pages on the dark manga stage: the page at its own
 *  proportions, arrows (and ← → keys) between pages, Esc to close, and the
 *  caller's actions underneath. Shown when a photoshoot finishes and when a
 *  page is opened from the gallery. */
export default function MangaReader({ pages, index, onIndex, onClose, children }) {
    const page = pages[index];
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
            else if (e.key === "ArrowRight" && index < pages.length - 1) onIndex(index + 1);
            else if (e.key === "Escape") onClose?.();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [index, pages.length, onIndex, onClose]);
    if (!page) return null;
    const many = pages.length > 1;
    return (
        <div className="rx_manga_reveal" onClick={(e) => e.stopPropagation()}>
            <div className="rx_manga_reader_page">
                {many && (
                    <button className="rx_manga_reader_nav" disabled={index === 0} title={_t("Previous page")}
                            onClick={() => onIndex(index - 1)}>
                        <i className="fa fa-chevron-left" />
                    </button>
                )}
                <img src={page.image_url} alt={page.title} />
                {many && (
                    <button className="rx_manga_reader_nav" disabled={index === pages.length - 1} title={_t("Next page")}
                            onClick={() => onIndex(index + 1)}>
                        <i className="fa fa-chevron-right" />
                    </button>
                )}
            </div>
            <div className="rx_manga_reveal_actions">
                {many && <span className="rx_manga_reader_count">{_t("Page %s of %s", index + 1, pages.length)}</span>}
                {children}
            </div>
        </div>
    );
}
