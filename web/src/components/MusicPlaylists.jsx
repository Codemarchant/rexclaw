import React, { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { confirmAsk } from "../lib/confirm";

/** History → Recordings → Your sounds → Playlists: named groups of the music
 *  library's tracks (your music sounds plus the built-in music), offered as
 *  background music in calls to every companion whose avatar uses the
 *  library (server/call_music.py). Avatars have playlists of their own in
 *  the avatar editor. `sounds` re-reads the tracks when the library changes. */
export default function MusicPlaylists({ sounds }) {
    const [lists, setLists] = useState([]);
    const [tracks, setTracks] = useState([]);
    const [editing, setEditing] = useState(null);   // {id?, name, tracks}
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        rpc("/api/music/playlists", {}).then((r) => setLists(r.playlists || [])).catch(() => {});
    }, []);
    useEffect(() => {
        // No companion: the library's tracks only.
        rpc("/api/music/tracks", {}).then((r) => setTracks((r.tracks || []).map((t) => t.name))).catch(() => {});
    }, [sounds]);

    const toggle = (name, on) => {
        const picked = editing.tracks.filter((t) => t !== name);
        setEditing({ ...editing, tracks: on ? [...picked, name] : picked });
    };
    const save = async () => {
        setBusy(true);
        try {
            setLists((await rpc("/api/music/playlists/save", editing)).playlists);
            setEditing(null);
        } catch (e) {
            notification.add(e.message || _t("Could not save the playlist"), { type: "danger" });
        } finally {
            setBusy(false);
        }
    };
    const remove = async (p) => {
        if (!(await confirmAsk(_t("Delete the playlist '%s'? The tracks stay in your sounds.", p.name)))) return;
        try {
            setLists((await rpc("/api/music/playlists/delete", { id: p.id })).playlists);
        } catch (e) {
            notification.add(e.message || _t("Delete failed"), { type: "danger" });
        }
    };

    return (
        <div style={{ marginTop: "1rem" }}>
            <div className="rx_mem_toolbar">
                <strong><i className="fa fa-list-ol" /> {_t("Music playlists")}</strong>
                {!editing && (
                    <button className="btn btn-sm" style={{ marginLeft: "auto" }} disabled={!tracks.length}
                            onClick={() => setEditing({ name: "", tracks: [] })}>
                        <i className="fa fa-plus" /> {_t("New playlist")}
                    </button>
                )}
            </div>
            <p className="text-muted small" style={{ margin: "0.2rem 0 0.4rem" }}>
                {_t("Library tracks played in turn as background music in calls, for every companion whose avatar uses the music library. Only sounds of the Music kind (and the built-in music) can go in.")}
            </p>
            {editing && (
                <div className="rx_agent_editor rx_studio_sound_form">
                    <label>{_t("Name")}</label>
                    <input type="text" value={editing.name} placeholder={_t("e.g. Rainy day")}
                           onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                    <label>{_t("Tracks (played in the order you tick them)")}</label>
                    {tracks.map((n) => {
                        const at = editing.tracks.indexOf(n);
                        return (
                            <label key={n} className="rx_check" style={{ margin: "0.1rem 0" }}>
                                <input type="checkbox" checked={at >= 0} onChange={(e) => toggle(n, e.target.checked)} />
                                <span>{at >= 0 ? `${at + 1}. ` : ""}{n}</span>
                            </label>
                        );
                    })}
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.6rem" }}>
                        <button className="btn btn-sm btn-primary" disabled={busy || !editing.name.trim() || !editing.tracks.length}
                                onClick={save}>{_t("Save")}</button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(null)}>{_t("Cancel")}</button>
                    </div>
                </div>
            )}
            {!lists.length && !editing && <p className="text-muted small">{_t("No playlists yet.")}</p>}
            {lists.map((p) => (
                <div key={p.id} className="rx_memory_row">
                    <strong>{p.name}</strong>
                    <span className="rx_memory_content text-muted small">{p.tracks.join(", ")}</span>
                    <button className="btn btn-sm btn-link p-0" title={_t("Edit")}
                            onClick={() => setEditing({ id: p.id, name: p.name, tracks: [...p.tracks] })}>
                        <i className="fa fa-pencil" />
                    </button>
                    <button className="btn btn-sm btn-link p-0" title={_t("Delete")} onClick={() => remove(p)}>
                        <i className="fa fa-trash-o" />
                    </button>
                </div>
            ))}
        </div>
    );
}
