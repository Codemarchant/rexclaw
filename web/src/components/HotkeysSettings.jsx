import React, { useEffect, useState } from "react";
import { _t } from "../lib/i18n";
import {
    HOTKEY_ACTIONS,
    HOTKEY_GROUPS,
    comboFromEvent,
    comboNeedsModifier,
    conflictingActions,
    effectiveBindings,
    formatCombo,
    hotkeyState,
    pauseGlobalHotkeys,
    resumeGlobalHotkeys,
} from "../lib/hotkeys";
import { useReactive } from "../lib/reactive";

/** Hotkey editor for the Settings page.
 *
 *  `value` is the stored override map (action id → combo); actions missing
 *  from it use the catalog default, and an empty string is a deliberate
 *  unbind. The parent serialises the whole map into config.hotkeys_json on
 *  save — nothing here takes effect until then.
 */
export default function HotkeysSettings({ value, globalEnabled, onChange, onGlobalChange }) {
    const [capturing, setCapturing] = useState(null);   // action id being recorded
    const hk = useReactive(hotkeyState);
    const bindings = effectiveBindings(value);
    const clashing = conflictingActions(value);
    const isDesktop = !!window.rexclawDesktop;

    const setCombo = (actionId, combo) => {
        const next = { ...value };
        const action = HOTKEY_ACTIONS.find((a) => a.id === actionId);
        // Re-selecting the default drops the override instead of storing a
        // copy of it, so a future change of default still reaches the user.
        if (combo === action?.combo) delete next[actionId];
        else next[actionId] = combo;
        onChange(next);
    };

    // Recording a combo. The OS-wide registration is handed back for the
    // duration — otherwise pressing a shortcut to REBIND it would also fire
    // the action it is currently bound to.
    useEffect(() => {
        if (!capturing) return;
        pauseGlobalHotkeys();
        const onKey = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.key === "Escape") { setCapturing(null); return; }
            if (ev.key === "Backspace" || ev.key === "Delete") {
                setCombo(capturing, "");
                setCapturing(null);
                return;
            }
            const combo = comboFromEvent(ev);
            if (!combo) return;   // still only modifiers held — keep listening
            setCombo(capturing, combo);
            setCapturing(null);
        };
        // Recording swallows every keystroke, so it must never outlive the
        // moment: clicking anywhere else (including another tab in the app,
        // which keeps this view mounted) or leaving the window cancels it.
        const cancel = () => setCapturing(null);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("mousedown", cancel, true);
        window.addEventListener("blur", cancel);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            window.removeEventListener("mousedown", cancel, true);
            window.removeEventListener("blur", cancel);
            resumeGlobalHotkeys();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [capturing]);

    const rowsFor = (groupId) => HOTKEY_ACTIONS.filter((a) => a.group === groupId);

    return (
        <>
            <p className="text-muted">
                {_t("Click a shortcut to record a new one, then press the keys you "
                    + "want. Backspace clears it, Escape keeps what was there. "
                    + "Shortcuts apply once you save.")}
            </p>
            <div className="rx_check">
                <input id="rx_hotkeys_global" type="checkbox"
                       checked={!!globalEnabled}
                       onChange={(ev) => onGlobalChange(ev.target.checked ? 1 : 0)} />
                <label htmlFor="rx_hotkeys_global">
                    {_t("Use these shortcuts system-wide (desktop app)")}
                </label>
            </div>
            <p className="text-muted">
                {_t("System-wide shortcuts work while you are in another "
                    + "application — which is the point of the desktop avatar: it "
                    + "floats on top unfocused, so shortcuts it can only see when "
                    + "focused would rarely fire. The cost is that these key "
                    + "combinations stop reaching every other program while "
                    + "Rexclaw runs. Turn this off to have them work only while a "
                    + "Rexclaw window has focus. On some keyboard layouts Ctrl+Alt "
                    + "is how AltGr characters are typed — pick different keys if "
                    + "typing breaks elsewhere.")}
            </p>
            {isDesktop && !!globalEnabled && hk.globalFailures.length > 0 && (
                <p className="text-danger">
                    {_t("Another application already owns these shortcuts, so they "
                        + "do nothing here: %s", hk.globalFailures.join(", "))}
                </p>
            )}
            {!isDesktop && (
                <p className="text-muted">
                    {_t("This is a browser tab, so shortcuts only work while it has "
                        + "focus, and the avatar-window ones do nothing — they need "
                        + "the desktop app.")}
                </p>
            )}

            {HOTKEY_GROUPS.map((group) => (
                <div key={group.id} className="rx_hotkey_group">
                    <h4>{_t(group.label)}</h4>
                    {rowsFor(group.id).map((action) => {
                        const combo = bindings[action.id];
                        const isDefault = combo === action.combo;
                        const bare = !!combo && comboNeedsModifier(combo);
                        return (
                            <div key={action.id} className="rx_hotkey_row">
                                <div className="rx_hotkey_label">
                                    <span>{_t(action.label)}</span>
                                    {action.desktop && (
                                        <span className="rx_hotkey_tag">{_t("desktop app")}</span>
                                    )}
                                    {action.hint && (
                                        <small className="text-muted">{_t(action.hint)}</small>
                                    )}
                                    {clashing.has(action.id) && (
                                        <small className="text-danger">
                                            {_t("Another action uses this shortcut — only one of them will run.")}
                                        </small>
                                    )}
                                    {bare && !!globalEnabled && (
                                        <small className="text-danger">
                                            {_t("Without a modifier key this swallows the key in every other application.")}
                                        </small>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    className={"btn btn-light rx_hotkey_key"
                                        + (capturing === action.id ? " is-capturing" : "")
                                        + (clashing.has(action.id) ? " is-clashing" : "")}
                                    onClick={() => setCapturing(capturing === action.id ? null : action.id)}
                                    title={_t("Click, then press the keys to use")}>
                                    {capturing === action.id
                                        ? _t("Press keys…")
                                        : (formatCombo(combo) || _t("Not set"))}
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-link btn-sm rx_hotkey_reset"
                                    disabled={isDefault}
                                    onClick={() => setCombo(action.id, action.combo)}
                                    title={_t("Back to the default (%s)", formatCombo(action.combo))}>
                                    <i className="fa fa-undo" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            ))}
            <button type="button" className="btn btn-light btn-sm"
                    onClick={() => { setCapturing(null); onChange({}); }}>
                <i className="fa fa-refresh" /> {_t("Restore default shortcuts")}
            </button>
        </>
    );
}
