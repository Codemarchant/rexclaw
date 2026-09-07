import React, { useEffect } from "react";
import { _t } from "../lib/i18n";

/** Credits: the third-party work Rexclaw is built on or ships alongside.
 *
 *  Deliberately terse — one line each, enough to know what a thing is and
 *  to find it again. This is the running record: anything borrowed, ported
 *  or bundled gets a line here when it lands, so the list never has to be
 *  reconstructed later. Kept in step with the Credits section of README.md
 *  (and its Japanese translation) and, for the Minecraft entries,
 *  game_integrations/minecraft/README.md, which carries the full licence
 *  text and per-file provenance.
 */
const CREDITS = [
    {
        title: "Avatars & animation",
        items: [
            ["VRoid Project Motion Pack",
             "https://vroid.pixiv.help/hc/en-us/articles/4402394424089",
             "pixiv Inc. The built-in gesture clips. Commercial use permitted with credit."],
            ["@pixiv/three-vrm",
             "https://github.com/pixiv/three-vrm",
             "MIT. Plays the avatars and their animations."],
            ["three.js",
             "https://threejs.org",
             "MIT. The 3D renderer behind every avatar view."],
        ],
    },
    {
        title: "Motion library",
        items: [
            ["Digital Life Project (dlp3d.ai)",
             "https://github.com/dlp3d-ai/dlp3d.ai",
             "MIT, S-Lab, Nanyang Technological University. Source of the speaking "
             + "gestures and idle fidgets, converted to VRMA by the tool in "
             + "tools/motion."],
        ],
    },
    {
        title: "Voice activation",
        items: [
            ["Vosk",
             "https://alphacephei.com/vosk/",
             "Apache-2.0. The offline speech models that listen for wake phrases."],
        ],
    },
    {
        title: "Minecraft sidecar",
        items: [
            ["Project AIRI",
             "https://github.com/moeru-ai/airi",
             "MIT, Neko Ayaka and contributors. The bot's brain architecture and its "
             + "pathfinder patches are ported from their Minecraft integration."],
            ["Mindcraft",
             "https://github.com/kolbytn/mindcraft",
             "MIT, Kolby Nottingham. Where those pathfinder patches came from, plus "
             + "the building designs the bot can construct."],
            ["PrismarineJS",
             "https://github.com/PrismarineJS",
             "MIT. mineflayer and friends, the bot's connection to the game."],
        ],
    },
];

export default function CreditsDialog({ onClose }) {
    useEffect(() => {
        const onKey = (ev) => { if (ev.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <div className="rx_dialog_backdrop" onMouseDown={onClose}>
            <div className="rx_dialog rx_dialog--credits" role="dialog" aria-modal="true"
                 onMouseDown={(ev) => ev.stopPropagation()}>
                <h4>{_t("Credits")}</h4>
                <p>
                    {_t("Rexclaw stands on a lot of other people's work. Licences are as "
                        + "stated by each project; the full text ships with the "
                        + "dependencies themselves.")}
                </p>
                <div className="rx_credits_body">
                    {CREDITS.map((group) => (
                        <div key={group.title} className="rx_credits_group">
                            <h5>{_t(group.title)}</h5>
                            <ul>
                                {group.items.map(([name, url, note]) => (
                                    <li key={name}>
                                        <a href={url} target="_blank" rel="noreferrer noopener">{name}</a>
                                        <span className="rx_credits_note">{_t(note)}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
                <div className="rx_dialog_actions">
                    <button className="btn btn-secondary" onClick={onClose}>{_t("Close")}</button>
                </div>
            </div>
        </div>
    );
}
