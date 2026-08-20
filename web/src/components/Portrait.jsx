import React from "react";

/** Round avatar portrait (see server/portraits.py) with a generic-icon
 *  fallback when the VRM carries no embedded thumbnail. Decorative — the
 *  name is always printed beside it, so the image has no alt text. */
export default function Portrait({ url, size = "sm", title }) {
    return (
        <span className={`rx_portrait rx_portrait--${size}`} title={title}>
            {url ? <img src={url} alt="" loading="lazy" /> : <i className="fa fa-user" />}
        </span>
    );
}
