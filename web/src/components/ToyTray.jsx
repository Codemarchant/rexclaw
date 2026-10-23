import React from "react";
import { _t } from "../lib/i18n";
import { useReactive } from "../lib/reactive";
import { TOY_CATEGORIES, trayToys } from "../models/toys/catalog";
import { toyIcon } from "../models/toys/art";

// A press that moves this far is a drag out of the tray; less is a click.
const DRAG_PX = 8;

/** The toy tray (models/toys/toybox.js): pick a toy and drag it out to put
 *  it down, or click it to toss it to the companion; drop one back on the
 *  tray (or right-click it) to put it away. `variant`: "full" (the Voice
 *  view), "roam" (the roaming desktop), "mascot" (the mascot's own window). */
export default function ToyTray({ box, variant = "full" }) {
    const st = useReactive(box.state);
    const toys = trayToys(st.cat);
    // One line per tab, about that tab's things (putting away is on the
    // bin's tooltip).
    const hint = {
        treats: _t("Hold a treat up to their mouth to feed them, or click to toss it over."),
        play: _t("Grab a ball and throw it, or leave it lying about for them."),
        gadgets: _t("Click a gadget to switch it on; scroll over it to turn it, Shift + scroll to raise or lower the fan."),
        lights: _t("Click a light to switch it on; scroll over it to change its shade."),
        crew: _t("Hand them something from the ship and see what they make of it."),
    }[st.cat];

    const press = (def) => (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const start = { x: ev.clientX, y: ev.clientY };
        let out = false;
        const done = () => {
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", cancel, true);
        };
        const move = (e) => {
            if (out || Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_PX) return;
            out = true;
            done();
            box.startDrag(def.id, e);
        };
        const up = () => { done(); if (!out) box.toss(def.id); };
        const cancel = () => done();
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", cancel, true);
    };

    return (
        <div className={`rx_toytray rx_toytray--${variant}`} onPointerDown={(e) => e.stopPropagation()}>
            <div className="rx_toytray_head">
                {TOY_CATEGORIES.map((c) => (
                    <button key={c.id} className={"rx_toytray_tab" + (st.cat === c.id ? " is-active" : "")}
                            onClick={() => box.setCat(c.id)} title={_t(c.label)}>
                        <i className={`fa ${c.icon}`} /><span>{_t(c.label)}</span>
                    </button>
                ))}
                <button className="rx_toytray_close" onClick={() => box.toggle(false)} title={_t("Close the toy box")}>
                    <i className="fa fa-times" />
                </button>
            </div>
            <div className="rx_toytray_grid">
                {toys.map((def) => (
                    <button key={def.id} className="rx_toytray_tile" onPointerDown={press(def)}
                            title={_t("Drag it out to put it down, or click to toss it over")}>
                        <img src={toyIcon(def.id)} alt="" draggable={false} />
                        <span>{_t(def.name)}</span>
                    </button>
                ))}
            </div>
            <div className="rx_toytray_foot">
                <span className="rx_toytray_hint">{hint}</span>
                <button className={st.idle ? "is-on" : ""} onClick={() => box.setIdlePlay(!st.idle)}
                        title={st.idle
                            ? _t("Keep playing with toys: on. They also go for toys lying about on their own. Click to have them only react to what you do.")
                            : _t("Keep playing with toys: off. They only react to what you do. Click to let them play on their own too.")}>
                    <i className={st.idle ? "fa fa-refresh" : "fa fa-hand-paper-o"} />
                </button>
                <button onClick={() => box.setSounds(!st.sounds)} title={st.sounds ? _t("Mute toy sounds") : _t("Toy sounds on")}>
                    <i className={st.sounds ? "fa fa-volume-up" : "fa fa-volume-off"} />
                </button>
                <button onClick={() => box.clear()} disabled={!st.count}
                        title={_t("Put all the toys away (right-click one, or drop it back here, to put just that one away)")}>
                    <i className="fa fa-trash-o" />
                </button>
            </div>
        </div>
    );
}
