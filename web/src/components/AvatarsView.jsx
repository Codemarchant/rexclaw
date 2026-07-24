import React from "react";
import AvatarManager from "./AvatarManager.jsx";
import { _t } from "../lib/i18n";

/** Avatars tab — avatar pack management gets its own page instead of a
 *  section squeezed into Settings. */
export default function AvatarsView({ active }) {
    return (
        <div className="rx_settings">
            <div className="rx_settings_inner rx_settings_inner--wide">
                <section>
                    <h3><i className="fa fa-user-circle-o" /> {_t("Avatars")}</h3>
                    <AvatarManager active={active} />
                </section>
            </div>
        </div>
    );
}
