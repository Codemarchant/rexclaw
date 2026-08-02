import { rpc } from "../lib/rpc";
import { _t } from "../lib/i18n";
import { makeConversationState } from "../models/conversation_state";
import { ToolDispatcher } from "../models/tool_dispatcher";

/**
 * Text companion service: HTTP-only sibling of voice_service.
 *
 * Flow:
 *   1. start(agentId, resumeSessionId?) → POST /text/session/start.
 *   2. sendText(text, fileIds?) → POST /text/session/<id>/send. Server runs
 *      a Responses API loop server-side, executing native tools inline.
 *   3. If the server returns {type:'browser_tools', tool_calls}: dispatch
 *      each via the shared ToolDispatcher, collect the results, then POST
 *      /text/session/<id>/tool_results. Repeat if the next leg returns
 *      more browser tools.
 *   4. If {type:'complete'}: append assistant text to state and check for
 *      compaction.
 *   5. uploadFile(file) → POST /text/session/<id>/upload (multipart). The
 *      returned file id is held in `pendingFiles` until the next sendText.
 */
class TextService {
    constructor(env) {
        this.env = env;
        this.state = makeConversationState();
        this.toolDispatcher = null;
        this.preferredAgentId = null;
        // Files uploaded but not yet attached to a sent message. Cleared after
        // sendText resolves so the next message starts with a clean chip set.
        this.pendingFiles = [];
        // Static thumbnail URL the UI renders next to assistant messages.
        this.agentThumbnailUrl = null;
        this._sending = false;
        // Once-per-session guard for the "MCP server unreachable" toast —
        // the server retries every turn without MCP tools while the server
        // is down, but the user only needs telling once.
        this._mcpNoticeShown = false;
    }

    /** Start (or resume) a text session. Returns true on success, false if a
     *  session is already running and the user must end it first. */
    async start(agentId = null, resumeSessionId = null) {
        if (this.state.status === "live" || this.state.status === "connecting") {
            this.env.services.notification?.add?.(
                _t("End the current chat before starting a new one."),
                { type: "warning" },
            );
            return false;
        }
        this.state.status = "connecting";
        this.state.errorMessage = null;
        this.state.messages = [];
        this.state.thinking = false;
        this.state.compacting = false;
        this.pendingFiles = [];
        this._mcpNoticeShown = false;

        let payload;
        try {
            payload = await rpc("/api/text/session/start", {
                agent_id: agentId,
                resume_session_id: resumeSessionId,
            });
        } catch (e) {
            const rawMsg = e?.data?.message || e?.message || _t("Failed to start chat session");
            this._fail(rawMsg);
            return false;
        }

        this.state.sessionId = payload.session_id;
        this.state.agentId = payload.agent?.id || agentId;
        this.state.agentName = payload.agent?.name || null;
        this.agentThumbnailUrl = payload.agent?.chat_thumbnail_url || null;
        this.state.tokenLimit = payload.summary_threshold_tokens || 0;
        this.state.tokenUsage = Math.max(
            0,
            (payload.total_input_tokens + payload.total_output_tokens) - (payload.tokens_at_last_summary || 0),
        );
        this.state.tokenCapWarningShown = false;

        // Hydrate transcript from the server's resume payload. Mode = 'text'
        // ensures transcript.js renders with the chat thumbnail beside
        // assistant messages and the markdown path on assistant content.
        for (const m of payload.transcript || []) {
            this.state.messages.push({
                role: m.role,
                content: m.content || "",
                sequence: m.sequence,
                replayed: true,
                tool_name: m.tool_name,
                tool_arguments_json: m.tool_arguments_json,
                tool_result_json: m.tool_result_json,
                is_summary_rollup: !!m.is_summary_rollup,
                attachments: m.attachments || [],
            });
        }

        // Browser-tool dispatcher. sendWs is a no-op in text mode — we don't
        // have a WebSocket. The dispatcher's return value is what we feed back
        // to /tool_results, so the no-op is harmless.
        this.toolDispatcher = new ToolDispatcher({
            actionService: this.env.services.action,
            avatarRenderer: null,
            sendWs: () => {},
            conversationState: this.state,
            sessionId: this.state.sessionId,
        });
        this.state.status = "live";
        return true;
    }

    /** Next local sequence: one past the highest sequence in the transcript.
     *  NOT `messages.length + 1` — resumed sessions hydrate rows with their
     *  server sequences, which run higher than the array length (summary-
     *  absorbed rows leave gaps, the display cap trims older rows), so
     *  length-based numbering can re-mint an existing sequence and give the
     *  transcript duplicate `m-<seq>` row keys (React warns + misrenders). */
    _nextSeq() {
        let max = 0;
        for (const m of this.state.messages) {
            if (m.sequence > max) max = m.sequence;
        }
        return max + 1;
    }

    /** Upload a file. Returns the metadata dict the user can attach via
     *  sendText, or throws on failure. */
    async uploadFile(file) {
        if (!this.state.sessionId) {
            throw new Error("No active chat session.");
        }
        if (file.size > 48 * 1024 * 1024) {
            throw new Error("File too large (max 48 MB).");
        }
        const fd = new FormData();
        fd.append("file", file, file.name);
        const resp = await fetch(`/api/text/session/${this.state.sessionId}/upload`, {
            method: "POST",
            body: fd,
            credentials: "same-origin",
        });
        if (!resp.ok) {
            const errBody = await resp.json().catch(() => ({}));
            throw new Error(errBody.error || `Upload failed (${resp.status})`);
        }
        const meta = await resp.json();
        const entry = {
            xai_file_id: meta.file_id,
            filename: meta.filename,
            size_bytes: meta.size_bytes,
            mimetype: meta.mimetype,
            expires_at: meta.expires_at,
            // Present for image uploads ingested into the Imagine library —
            // round-tripped on /send so the turn can hand the model a
            // durable, editable reference (see upload_text_attachment).
            imagine_image_id: meta.imagine_image_id || null,
            image_url: meta.image_url || null,
        };
        this.pendingFiles.push(entry);
        return entry;
    }

    removePendingFile(fileId) {
        this.pendingFiles = this.pendingFiles.filter(f => f.xai_file_id !== fileId);
    }

    /** Send the user's typed message. Returns true once the assistant turn
     *  resolves (either via plain text or after a browser-tool round-trip). */
    async sendText(userText) {
        if (this._sending) return false;
        if (!this.state.sessionId) {
            this._fail(_t("No active chat session."));
            return false;
        }
        const trimmed = (userText || "").trim();
        if (!trimmed && !this.pendingFiles.length) return false;

        this._sending = true;
        this.state.thinking = true;
        // Optimistic local append so the user sees their message immediately.
        const localUserMsg = {
            role: "user",
            content: trimmed,
            sequence: this._nextSeq(),
            attachments: [...this.pendingFiles],
        };
        this.state.messages.push(localUserMsg);
        const fileIds = this.pendingFiles.map(f => ({
            xai_file_id: f.xai_file_id,
            filename: f.filename,
            size_bytes: f.size_bytes,
            mimetype: f.mimetype,
            expires_at: f.expires_at,
            imagine_image_id: f.imagine_image_id || null,
        }));
        this.pendingFiles = [];

        try {
            let resp = await rpc(`/api/text/session/${this.state.sessionId}/send`, {
                user_text: trimmed,
                attachment_file_ids: fileIds,
            });
            await this._processSendResponse(resp);
        } catch (e) {
            const rawMsg = e?.data?.message || e?.message || _t("Send failed");
            this._softFail(rawMsg);
            this._sending = false;
            this.state.thinking = false;
            return false;
        }
        this._sending = false;
        this.state.thinking = false;
        return true;
    }

    /** Walk the server response, dispatching browser tools as needed and
     *  appending assistant content. Loops until a 'complete' or 'cap_exceeded'. */
    async _processSendResponse(resp) {
        let current = resp;
        // Bound the round-trip loop so a misbehaving model can't hang the UI.
        let safetyHops = 8;
        while (current && safetyHops-- > 0) {
            // Update the compact-budget counter from the per-leg usage. Spec:
            // usage.total_tokens includes input + output + reasoning, so this
            // mirrors what the server's _accrue_text_usage charges to the
            // session. Without this the header counter only reflected the
            // initial baseline at session start.
            if (current.usage && typeof current.usage.total_tokens === "number") {
                this.state.tokenUsage = (this.state.tokenUsage || 0) + current.usage.total_tokens;
            }
            if (current.type === "cap_exceeded") {
                this.env.services.notification?.add?.(
                    current.message || _t("Daily token allowance reached."),
                    { type: "danger" },
                );
                return;
            }
            if (current.type === "error") {
                this._softFail(current.message || _t("Chat request failed."));
                return;
            }
            // The server dropped unreachable MCP tools for this turn. Tell
            // the user once per session — not once per message.
            if (current.mcp_unavailable && !this._mcpNoticeShown) {
                this._mcpNoticeShown = true;
                this.env.services.notification?.add?.(
                    _t("Remote MCP server unreachable — continuing without MCP tools."),
                    { type: "warning" },
                );
            }
            // Server-side MCP + native tool calls happen during xAI response
            // generation, before the assistant text is finalized. Push them
            // first so the transcript reflects that order — they were
            // already persisted server-side by text_send_turn. Both arrive
            // on every response type now (complete + browser_tools), so we
            // surface them here once rather than splitting the handling.
            const mcpResults = current.mcp_results || [];
            for (const mr of mcpResults) {
                this.state.messages.push({
                    role: "tool_call",
                    content: `${mr.name}(${mr.arguments || ""})`,
                    tool_name: mr.name,
                    tool_arguments_json: mr.arguments || "",
                    sequence: this._nextSeq(),
                });
                this.state.messages.push({
                    role: "tool_result",
                    content: mr.output || "",
                    tool_name: mr.name,
                    tool_result_json: mr.output || "",
                    sequence: this._nextSeq(),
                });
            }
            const nativeResultsTop = current.native_results || [];
            for (const nr of nativeResultsTop) {
                this.state.messages.push({
                    role: "tool_call",
                    content: `${nr.name}(${nr.arguments || ""})`,
                    tool_name: nr.name,
                    tool_arguments_json: nr.arguments || "",
                    sequence: this._nextSeq(),
                });
                this.state.messages.push({
                    role: "tool_result",
                    content: nr.output || "",
                    tool_name: nr.name,
                    tool_result_json: nr.output || "",
                    sequence: this._nextSeq(),
                });
            }
            // Append any assistant text the server already streamed back.
            const assistantText = current.assistant_text || "";
            if (assistantText) {
                this.state.messages.push({
                    role: "assistant",
                    content: assistantText,
                    sequence: this._nextSeq(),
                    incomplete_reason: current.incomplete_reason || null,
                });
            }
            // Persist tool_call rows + results for visibility, even though
            // they were already created server-side. We re-add them locally
            // so the transcript shows them in arrival order without a
            // refresh — replays come from the server only on resume.
            if (current.type === "browser_tools") {
                if (!this.toolDispatcher) {
                    this._fail(_t("Tool dispatcher missing."));
                    return;
                }
                // native_results and mcp_results were already pushed at the
                // top of the loop — they arrive on every response type now
                // (server accumulates them across iterations). Only the
                // pending browser-tool calls remain to handle here.
                const calls = current.tool_calls || [];
                for (const call of calls) {
                    this.state.messages.push({
                        role: "tool_call",
                        content: `${call.name}(${call.arguments || ""})`,
                        tool_name: call.name,
                        tool_arguments_json: call.arguments || "",
                        sequence: this._nextSeq(),
                    });
                }
                const results = [];
                for (const call of calls) {
                    let output;
                    try {
                        output = await this.toolDispatcher.dispatch({
                            callId: call.call_id,
                            name: call.name,
                            argumentsJson: call.arguments || "{}",
                        });
                    } catch (e) {
                        output = { error: String(e?.message || e) };
                    }
                    const outputStr = typeof output === "string" ? output : JSON.stringify(output ?? { ok: true });
                    this.state.messages.push({
                        role: "tool_result",
                        content: outputStr,
                        tool_name: call.name,
                        tool_result_json: outputStr,
                        sequence: this._nextSeq(),
                    });
                    results.push({ call_id: call.call_id, name: call.name, output: outputStr });
                }
                current = await rpc(`/api/text/session/${this.state.sessionId}/tool_results`, { results });
                continue;
            }
            if (current.type === "complete") {
                if (current.cap_warning && !this.state.tokenCapWarningShown) {
                    this.state.tokenCapWarningShown = true;
                    this.env.services.notification?.add?.(
                        _t("Approaching your daily text-chat token cap."),
                        { type: "warning" },
                    );
                }
                if (current.cap_exceeded) {
                    this.env.services.notification?.add?.(
                        _t("Daily text-chat token allowance reached."),
                        { type: "danger" },
                    );
                }
                if (current.needs_compaction) {
                    console.info("[text-companion] server flagged needs_compaction=true; firing background compact");
                    // Best-effort background compact — never blocks the UI.
                    this._compactInBackground();
                } else {
                    console.debug("[text-companion] server flagged needs_compaction=false");
                }
                return;
            }
            // Unknown shape — bail rather than spin.
            this._softFail(_t("Unknown server response."));
            return;
        }
        if (safetyHops <= 0) {
            this._softFail(_t("Tool round-trip cap reached."));
        }
    }

    async _compactInBackground() {
        if (this.state.compacting) {
            console.warn("[text-companion] compact already in progress, skipping");
            return;
        }
        this.state.compacting = true;
        try {
            console.info("[text-companion] auto-compact triggered");
            const result = await rpc(`/api/text/session/${this.state.sessionId}/compact`, {});
            console.info("[text-companion] compact result", result);
            // Server bumps tokens_at_last_summary to the current running total
            // when a rollup is created, so the user-facing budget restarts at 0.
            if (result?.compacted) {
                this.state.tokenUsage = 0;
                // Keep the local transcript untouched — same as voice mode's
                // compaction restart. Compaction changes what replays to the
                // MODEL (absorbed rows → one rollup); the user keeps seeing
                // the full conversation. Replacing state.messages with the
                // compacted replay here used to make earlier messages vanish
                // from the chat after every compact.
            } else {
                // Surface the reason so a stuck compaction loop is visible.
                this.env.services.notification?.add?.(
                    _t("Compact skipped: ") + (result?.reason || _t("unknown")),
                    { type: "info" },
                );
            }
        } catch (e) {
            // Surface the failure rather than swallowing — the alternative is
            // a counter that climbs forever with no UI signal.
            console.error("[text-companion] compact failed", e);
            this.env.services.notification?.add?.(
                _t("Auto-compact failed: ") + (e?.data?.message || e?.message || String(e)),
                { type: "warning" },
            );
        } finally {
            this.state.compacting = false;
        }
    }

    async end(reason = "client") {
        if (!this.state.sessionId) return;
        const sid = this.state.sessionId;
        this.state.status = "ending";
        try {
            await rpc(`/api/text/session/${sid}/end`, { reason });
        } catch (e) {
            // Non-fatal — leave the local state in 'ended' anyway.
        }
        this.state.status = "ended";
    }

    _fail(msg) {
        this.state.status = "error";
        this.state.errorMessage = msg;
    }

    /** Non-fatal turn failure: show the dismissible error banner but KEEP the
     *  session live so the user can simply try again. A failed send (network
     *  blip, MCP outage, xAI 4xx) does not invalidate the session server-side
     *  — flipping status to "error" here used to hide the input bar and wedge
     *  the chat. _fail() stays reserved for start()-time failures where there
     *  is no live session to return to. */
    _softFail(msg) {
        this.state.errorMessage = msg;
    }
}

export { TextService };
