import React from "react";

/** Round avatar portrait (see server/portraits.py) with a generic-icon
 *  fallback when the VRM carries no embedded thumbnail. Decorative — the
 *  name is always printed beside it, so the image has no alt text.
 *  size "tall" is the full-body portrait: portrait-ratio box, image
 *  contained rather than cover-cropped, so the whole figure shows. */
export default function Portrait({ url, size = "sm", title }) {
    const icon = size === "tall" ? "fa fa-male" : "fa fa-user";
    return (
        <span className={`rx_portrait rx_portrait--${size}`} title={title}>
            {url ? <img src={url} alt="" loading="lazy" /> : <i className={icon} />}
        </span>
    );
}
