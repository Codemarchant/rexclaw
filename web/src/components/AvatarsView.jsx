import React from "react";
import AvatarManager from "./AvatarManager.jsx";
import { _t } from "../lib/i18n";

/** Avatars tab — avatar pack management gets its own page instead of a
 *  section squeezed into Settings. AvatarManager renders the Settings-style
 *  white section boxes itself (one for the list, several in the editor). */
export default function AvatarsView({ active }) {
    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <AvatarManager active={active} />
            </div>
        </div>
    );
}
