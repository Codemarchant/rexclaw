import React, { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { notification } from "../lib/notification";
import { downscaleImageFile } from "../lib/attachments";
import { useFileDrop } from "../lib/use_file_drop";
import { TRANSCRIPT_CHANNEL } from "../services/transcript_sync";
import Transcript from "./Transcript.jsx";

/** Standalone transcript window (/#transcript) — a live mirror of whichever
 *  window owns the current call (main view or desktop mascot), fed over a
 *  BroadcastChannel by transcript_sync. Typing here relays into the call.
 *  Attachments upload straight to the server (same origin, session id from
 *  the snapshot — no call socket needed); only the hidden context note goes
 *  through the owner. Works anywhere same-origin: the Electron tray opens
 *  one, and browser users can open /#transcript in a second tab. */
export default function TranscriptWindowView() {
    const [snap, setSnap] = useState(null);
    const [stale, setStale] = useState(true);
    const [draft, setDraft] = useState("");
    const [pendingImages, setPendingImages] = useState([]);
    const [pendingDocs, setPendingDocs] = useState([]);
    const [uploading, setUploading] = useState(false);
    const chRef = useRef(null);
    const fileInputRef = useRef(null);
    const rootRef = useRef(null);

    useEffect(() => {
        const ch = new BroadcastChannel(TRANSCRIPT_CHANNEL);
        chRef.current = ch;
        let lastAt = 0;
        ch.onmessage = (ev) => {
            if (ev.data?.type !== "transcript") return;
            lastAt = Date.now();
            setSnap(ev.data);
            setStale(false);
        };
        ch.postMessage({ type: "request" });
        // The owner may not exist yet (call not started, mascot closed) or
        // may die mid-call — keep asking quietly and flag the mirror stale
        // after 5 s of silence so a dead feed can't impersonate a live one.
        const timer = setInterval(() => {
            if (Date.now() - lastAt > 5000) {
                setStale(true);
                ch.postMessage({ type: "request" });
            }
        }, 2500);
        return () => {
            clearInterval(timer);
            ch.close();
        };
    }, []);

    // Pending chips belong to one session — drop them if the call moves on.
    const sessionId = snap?.sessionId || null;
    useEffect(() => {
        setPendingImages([]);
        setPendingDocs([]);
    }, [sessionId]);

    const isLive = !stale && snap?.status === "live";
    const isConnecting = !stale && snap?.status === "connecting";
    const statusLabel = (() => {
        if (stale || !snap) return _t("Waiting for an active call…");
        switch (snap.status) {
            case "idle": return _t("Ready");
            case "connecting": return _t("Connecting…");
            case "live": return _t("Live");
            case "ending": return _t("Ending…");
            case "ended": return _t("Ended");
            case "error": return _t("Error");
            default: return snap.status;
        }
    })();

    // Same upload split as VoiceView: images downscale and land in the
    // Imagine library; anything else streams to xAI files.
    const addFiles = async (picked) => {
        const files = (picked || []).slice(0, 6);
        if (!files.length || !isLive || !sessionId) return;
        setUploading(true);
        try {
            for (const file of files) {
                if ((file.type || "").startsWith("image/")) {
                    const dataUrl = await downscaleImageFile(file);
                    const result = await rpc(`/api/voice/session/${sessionId}/upload_image`, {
                        image_data_url: dataUrl,
                        name: file.name,
                    });
                    setPendingImages((prev) => [...prev, result]);
                } else {
                    if (file.size > 48 * 1024 * 1024) {
                        throw new Error(_t('"%s" is too large (max 48 MB).', file.name));
                    }
                    const fd = new FormData();
                    fd.append("file", file, file.name);
                    const resp = await fetch(`/api/voice/session/${sessionId}/upload_file`, {
                        method: "POST",
                        body: fd,
                        credentials: "same-origin",
                    });
                    if (!resp.ok) {
                        const errBody = await resp.json().catch(() => ({}));
                        throw new Error(errBody.error || `Upload failed (${resp.status})`);
                    }
                    const meta = await resp.json();
                    setPendingDocs((prev) => [...prev, {
                        xai_file_id: meta.file_id,
                        name: meta.filename || file.name,
                        // Library ref — every upload is ingested server-side
                        // now; the main window's attachmentNote advertises it
                        // (delegate_task any file, edit/extend for videos).
                        imagine_image_id: meta.imagine_image_id || null,
                        mimetype: meta.mimetype || file.type || "",
                    }]);
                }
            }
        } catch (e) {
            notification.add(_t("Upload failed: %s", e?.data?.message || e?.message || e), { type: "danger" });
        } finally {
            setUploading(false);
        }
    };
    const onFilesChosen = (ev) => {
        const files = [...(ev.target.files || [])];
        ev.target.value = "";
        addFiles(files);
    };
    useFileDrop(rootRef, addFiles, isLive && !!sessionId);

    const send = () => {
        const text = draft.trim();
        if ((!text && !pendingImages.length && !pendingDocs.length) || !isLive) return;
        chRef.current?.postMessage({
            type: "send_text",
            text,
            images: pendingImages,
            docs: pendingDocs,
        });
        setDraft("");
        setPendingImages([]);
        setPendingDocs([]);
    };

    return (
        <div className="rx_transcript_win rx_dropzone" ref={rootRef}
             data-drop-hint={_t("Drop files to attach")}>
            <div className="rx_transcript_win_header">
                <span
                    className={
                        "rx_mascot_status"
                        + (isLive ? " is-live" : "")
                        + (isConnecting ? " is-connecting" : "")
                    }
                />
                <strong>{snap?.agentName || _t("Transcript")}</strong>
                <span className="rx_transcript_win_state">{statusLabel}</span>
            </div>
            <div className="rx_transcript_win_body">
                {snap
                    ? <Transcript messages={snap.messages} isLive={isLive}
                                  thinking={!stale && !!snap.thinking} truncated={!!snap.truncated} />
                    : <div className="rx_transcript_win_waiting">
                          {_t("Start or resume a call in the app (or the desktop avatar) and the conversation appears here.")}
                      </div>}
            </div>
            {(pendingImages.length > 0 || pendingDocs.length > 0) && (
                <div className="rx_transcript_win_attachments">
                    {pendingImages.map((p) => (
                        <span key={p.imagine_image_id} className="rx_transcript_win_chip" title={p.name}>
                            <img src={p.image_url} alt={p.name} />
                            <span className="rx_transcript_win_chip_name">{p.name}</span>
                            <button className="btn btn-link p-0"
                                    onClick={() => setPendingImages((prev) =>
                                        prev.filter((x) => x.imagine_image_id !== p.imagine_image_id))}
                                    title={_t("Remove")}>
                                <i className="fa fa-times" />
                            </button>
                        </span>
                    ))}
                    {pendingDocs.map((d, dIdx) => (
                        <span key={`${d.xai_file_id}-${dIdx}`} className="rx_transcript_win_chip" title={d.name}>
                            <i className="fa fa-file-o" />
                            <span className="rx_transcript_win_chip_name">{d.name}</span>
                            <button className="btn btn-link p-0"
                                    onClick={() => setPendingDocs((prev) =>
                                        prev.filter((x) => x.xai_file_id !== d.xai_file_id))}
                                    title={_t("Remove")}>
                                <i className="fa fa-times" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            <div className="rx_transcript_win_input">
                <button className="btn btn-sm btn-secondary"
                        disabled={!isLive || uploading}
                        onClick={() => fileInputRef.current?.click()}
                        title={_t("Attach files")}>
                    <i className={uploading ? "fa fa-spinner fa-spin" : "fa fa-paperclip"} />
                </button>
                <input ref={fileInputRef} type="file" multiple
                       style={{ display: "none" }} onChange={onFilesChosen} />
                <textarea rows={1}
                          placeholder={isLive ? _t("Type a message…") : _t("Waiting for an active call…")}
                          value={draft}
                          disabled={!isLive}
                          onChange={(ev) => setDraft(ev.target.value)}
                          onKeyDown={(ev) => {
                              if (ev.key === "Enter" && !ev.shiftKey) {
                                  ev.preventDefault();
                                  send();
                              }
                          }} />
                <button className="btn btn-sm btn-primary"
                        disabled={(!draft.trim() && !pendingImages.length && !pendingDocs.length) || !isLive}
                        onClick={send}
                        title={_t("Send")}>
                    <i className="fa fa-paper-plane" />
                </button>
            </div>
        </div>
    );
}
