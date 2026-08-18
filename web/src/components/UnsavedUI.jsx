import React from "react";
import { _t } from "../lib/i18n";

/** Sticky Save / Discard bar. A view renders it (always, cheaply) and it
 *  reveals itself only while there are unsaved edits — so Save is in reach
 *  without scrolling to the bottom of a long panel. */
export function UnsavedBar({ dirty, saving, onSave, onDiscard }) {
    if (!dirty) return null;
    return (
        <div className="rx_savebar is-pinned is-dirty" role="status">
            <span className="rx_savebar_msg">
                <span className="rx_dirty_dot" /> {_t("Unsaved changes")}
            </span>
            <div className="rx_savebar_actions">
                <button type="button" className="btn btn-light btn-sm"
                        disabled={saving} onClick={onDiscard}>
                    {_t("Discard")}
                </button>
                <button type="button" className="btn btn-primary btn-sm"
                        disabled={saving} onClick={onSave}>
                    <i className={saving ? "fa fa-spinner fa-spin" : "fa fa-save"} /> {_t("Save")}
                </button>
            </div>
        </div>
    );
}

/** Sticky action bar for full-page record editors (Companions, Memories,
 *  Avatars), which open as a sub-page replacing their list. Always visible so
 *  Save/Back are in reach; shows the same amber "unsaved" treatment as
 *  UnsavedBar when dirty. Save commits (the editor closes on success); the
 *  left button goes Back to the list (Discard when there are edits to drop). */
export function EditorBar({ dirty, saving, onSave, onCancel, saveLabel, saveDisabled, pinned = false }) {
    return (
        <div className={"rx_savebar" + (pinned ? " is-pinned" : "") + (dirty ? " is-dirty" : "")}>
            {dirty && (
                <span className="rx_savebar_msg">
                    <span className="rx_dirty_dot" /> {_t("Unsaved changes")}
                </span>
            )}
            <div className="rx_savebar_actions">
                <button type="button" className="btn btn-light btn-sm"
                        disabled={saving} onClick={onCancel}>
                    {dirty ? _t("Discard") : _t("Cancel")}
                </button>
                <button type="button" className="btn btn-primary btn-sm"
                        disabled={saving || saveDisabled} onClick={onSave}>
                    <i className={saving ? "fa fa-spinner fa-spin" : "fa fa-save"} /> {saveLabel || _t("Save")}
                </button>
            </div>
        </div>
    );
}

/** Odoo-style leave prompt: shown when the user navigates away from a panel
 *  with unsaved edits. Save persists then leaves; Discard drops the edits and
 *  leaves; Cancel stays put. */
export function UnsavedDialog({ open, saving, onSave, onDiscard, onCancel }) {
    if (!open) return null;
    return (
        <div className="rx_dialog_backdrop" onMouseDown={onCancel}>
            <div className="rx_dialog" role="dialog" aria-modal="true"
                 onMouseDown={(e) => e.stopPropagation()}>
                <h4>{_t("Unsaved changes")}</h4>
                <p>{_t("You have unsaved changes on this tab. Save them before leaving?")}</p>
                <div className="rx_dialog_actions">
                    <button type="button" className="btn btn-light btn-sm"
                            disabled={saving} onClick={onCancel}>
                        {_t("Cancel")}
                    </button>
                    <button type="button" className="btn btn-outline-danger btn-sm"
                            disabled={saving} onClick={onDiscard}>
                        {_t("Discard")}
                    </button>
                    <button type="button" className="btn btn-primary btn-sm"
                            disabled={saving} onClick={onSave}>
                        <i className={saving ? "fa fa-spinner fa-spin" : "fa fa-save"} /> {_t("Save")}
                    </button>
                </div>
            </div>
        </div>
    );
}
