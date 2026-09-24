// Background work only; a spoken reply never waits for retrieval.
function enoughText(text) {
    // Three Unicode letters can already be a complete shared name in CJK.
    const letters = text.match(/[\p{L}\p{N}]/gu) || [];
    if (letters.length >= 3 && letters.some(c => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(c))) {
        return true;
    }
    // Spaced scripts: a sentence opener ("It was", "I was uh") names
    // nothing yet. Three words besides fillers is the least that can.
    const words = (text.match(/[\p{L}\p{M}\p{N}']+/gu) || [])
        .filter(w => !/^(?:u+h+|u+m+|e+r+m*|a+h+|h*m+|hmm+)$/i.test(w));
    return text.length >= 8 && words.length >= 3;
}

function extendsTranscript(previous, current) {
    const words = text => text.toLowerCase().replaceAll('’', "'")
        .match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu) || [];
    const before = words(previous), after = words(current);
    return before.length > 0 && before.length <= after.length &&
        before.every((word, i) => word === after[i] || (
            // Streaming ASR can finish the last word in the next hypothesis.
            // Earlier words and completed punctuation boundaries stay strict.
            i === before.length - 1 && /[\p{L}\p{M}\p{N}-]$/u.test(previous) &&
            after[i].startsWith(word) && !/(?:n't|cannot)$/.test(after[i])
        ));
}

export class LiveMemory {
    constructor({ mode, request, cooldownSeconds = 60, context = () => [], diagnostic = () => {} }) {
        Object.assign(this, { mode: mode === "on" ? "on" : "off", request, context, diagnostic });
        this.cooldownMs = cooldownSeconds * 1000;
        this.generation = 0;
        this.active = false;
        this.ready = null;
        this.seen = new Set();
        this.lastDelivered = null;
    }
    begin() {
        this.cancel('new_turn');
        this.active = true;
        this.text = "";
        this.revision = 0;
        this.lastRequestAt = 0;
        this.updates = 0;
        this.attempts = 0;
        if (this.mode !== 'off' && this.cooldownRemaining() > 0) {
            this.diagnostic({ reason: 'cooldown', remaining_ms: this.cooldownRemaining(), mode: this.mode });
        }
    }
    cooldownRemaining() {
        return this.lastDelivered === null ? 0 : Math.max(0, this.cooldownMs - (Date.now() - this.lastDelivered));
    }
    update(text) {
        if (!this.active || this.mode === "off") return;
        text = String(text || "").trim().slice(-1200);
        if (text === this.text) return;
        // Continuing a sentence does not erase already approved evidence.
        // Recheck against the growing context; corrections clear immediately.
        // Pending results still require the exact current revision.
        if (!extendsTranscript(this.text, text)) {
            this.clearReady('transcript_corrected');
        } else if (this.ready) {
            // An approved cue stays usable while the same utterance grows.
            // This is an inactivity timeout, not three seconds from admission.
            this.expireReadyAfter(3000, 'no_partial_updates');
        }
        this.text = text;
        this.revision++;
        this.updates++;
        this.schedule();
    }
    schedule() {
        if (!this.active || this.timer || this.pending || !enoughText(this.text)) return;
        // Throttle, not debounce: continuous speech must get searched.
        this.timer = setTimeout(() => { this.timer = null; void this.lookup(); },
            Math.max(250, 1000 - (Date.now() - this.lastRequestAt)));
    }
    async lookup() {
        if (this.mode !== "on" || !this.active || this.pending || this.cooldownRemaining() > 0) return;
        const generation = this.generation, revision = this.revision;
        const abort = new AbortController();
        this.pending = abort;
        const started = Date.now();
        this.lastRequestAt = started;
        this.attempts++;
        this.diagnostic({ reason: 'lookup_started', revision, text: this.text,
            characters: this.text.length, mode: this.mode });
        const timeout = setTimeout(() => abort.abort(), 900);
        try {
            const result = await this.request({ text: this.text, context: this.context() }, abort.signal);
            if (!this.active || generation !== this.generation || revision !== this.revision ||
                abort.signal.aborted || Date.now() - started >= 900) {
                const cause = generation !== this.generation ? 'turn_changed' :
                    !this.active ? 'input_closed' :
                    abort.signal.aborted || Date.now() - started >= 900 ? 'deadline' : 'transcript_changed';
                this.diagnostic({ reason: 'discarded', cause, revision, judgment: result.reason,
                    candidates: result.candidates,
                    elapsed_ms: Date.now() - started, mode: this.mode });
                return;
            }
            this.diagnostic({ reason: result.reason, revision, memory_id: result.memory_id,
                candidates: result.candidates,
                retrieval_ms: result.retrieval_ms, elapsed_ms: result.elapsed_ms, mode: this.mode });
            if (this.mode === "on" && result.mode === "on" && result.note &&
                Number.isInteger(result.memory_id) && !this.seen.has(result.memory_id)) {
                this.ready = { note: result.note, memory_id: result.memory_id };
                this.expireReadyAfter(3000, 'no_partial_updates');
            } else {
                // A fresh judgment can withdraw a previously approved note
                // when later words change the meaning or settings change.
                this.clearReady(result.reason || 'not_eligible');
            }
        } catch {
            // Optional evidence never blocks a reply. Keep observe mode
            // useful for timing failures too.
            this.diagnostic({ reason: abort.signal.aborted ? 'cancelled_or_expired' : 'unavailable',
                cause: generation !== this.generation ? 'turn_changed' : !this.active ? 'input_closed' :
                    abort.signal.aborted ? 'deadline' : 'request_failed', revision,
                elapsed_ms: Date.now() - started, mode: this.mode });
        }
        finally {
            clearTimeout(timeout);
            if (this.pending === abort) this.pending = null;
            if (generation === this.generation && revision !== this.revision) this.schedule();
        }
    }
    expireReadyAfter(ms, cause) {
        clearTimeout(this.expiryTimer);
        // Expiring evidence must not end the utterance or cancel fresh work.
        this.expiryTimer = setTimeout(() => this.clearReady(cause), ms);
    }
    clearReady(cause) {
        clearTimeout(this.expiryTimer);
        if (this.ready) this.diagnostic({ reason: 'note_cleared', cause,
            memory_id: this.ready.memory_id, mode: this.mode });
        this.ready = null;
    }
    stopInput() {
        if (this.active && this.mode !== 'off') {
            const remaining = this.cooldownRemaining();
            const cause = remaining > 0 ? 'cooldown' :
                !this.updates ? 'no_partial_transcripts' : !enoughText(this.text) ? 'short_transcript' :
                !this.attempts ? 'closed_before_lookup' : this.pending ? 'lookup_pending' : 'lookups_finished';
            this.diagnostic({ reason: 'input_closed', cause, updates: this.updates, attempts: this.attempts,
                ...(remaining > 0 ? { remaining_ms: remaining } : {}),
                ready_memory_id: this.ready?.memory_id, mode: this.mode });
        }
        if (this.active && this.ready) this.expireReadyAfter(5000, 'response_timeout');
        this.active = false;
        clearTimeout(this.timer);
        this.timer = null;
        this.pending?.abort();
        this.pending = null;
    }
    take() {
        this.stopInput();
        clearTimeout(this.expiryTimer);
        const ready = this.ready;
        this.ready = null;
        if (ready) {
            this.seen.add(ready.memory_id);
            this.lastDelivered = Date.now();
            if (this.cooldownMs > 0) {
                this.diagnostic({ reason: 'cooldown_started', remaining_ms: this.cooldownMs, mode: this.mode });
            }
        }
        return ready;
    }
    cancel(cause = 'cancelled') {
        this.stopInput();
        this.generation++;
        this.clearReady(cause);
    }
}
