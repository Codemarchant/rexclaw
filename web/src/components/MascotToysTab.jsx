import React from "react";
import { _t } from "../lib/i18n";
import { TOY_CATEGORIES, trayToys } from "../models/toys/catalog";
import { toyIcon } from "../models/toys/art";

/** Mascot settings window → Toys: the whole toy box, picked from here
 *  (the overlay has no tray of its own). A pick is tossed over to the
 *  companion, in the window's own scene or on the desktop while they roam;
 *  everything after (throwing, switching on, putting away) is done on the
 *  toy itself. `send` rides the settings channel to MascotView. */
export default function MascotToysTab({ mascot, alive, send }) {
    const toys = alive ? mascot?.toys : null;
    const check = (id, label, desc, checked, onChange) => (
        <div className="rx_mascot_set_item">
            <div className="rx_check">
                <input id={id} type="checkbox" checked={!!checked}
                       onChange={(ev) => onChange(ev.target.checked)} />
                <label htmlFor={id}>{label}</label>
            </div>
            {desc && <p className="rx_mascot_set_desc">{desc}</p>}
        </div>
    );
    return <>
        <section>
            <h3><i className="fa fa-gift" /> {_t("Toy box")}</h3>
            <p className="text-muted">
                {_t("Click one to toss it over. On the avatar: grab toys to throw them, click bubbles to pop them, click a gadget or light to switch it on and scroll over it to turn it or change its shade (Shift + scroll raises or lowers the fan). Right-click a toy to put it away.")}
            </p>
            <fieldset disabled={!alive}>
                {check("rx_ms_toy_idle", _t("Keep playing with toys"),
                    _t("They also go for toys lying about on their own. Off, they only react to what you do."),
                    toys?.idle, (v) => send({ type: "toys", action: "idle", value: v }))}
                {check("rx_ms_toy_sounds", _t("Toy sounds"), null,
                    toys?.sounds, (v) => send({ type: "toys", action: "sounds", value: v }))}
                <button className="btn btn-sm btn-light" disabled={!toys?.count}
                        onClick={() => send({ type: "toys", action: "clear" })}>
                    <i className="fa fa-trash-o" /> {_t("Put all the toys away")}
                </button>
            </fieldset>
        </section>
        {TOY_CATEGORIES.map((c) => (
            <section key={c.id}>
                <h3><i className={"fa " + c.icon} /> {_t(c.label)}</h3>
                <fieldset disabled={!alive}>
                    <div className="rx_mascot_set_grid">
                        {trayToys(c.id).map((def) => (
                            <button key={def.id} className="btn btn-sm btn-light rx_mascot_set_toy"
                                    onClick={() => send({ type: "toy", id: def.id })}>
                                <img src={toyIcon(def.id)} alt="" draggable={false} /> {_t(def.name)}
                            </button>
                        ))}
                    </div>
                </fieldset>
            </section>
        ))}
    </>;
}
