// Screen-share capture singleton, shared by the voice view and the tool
// dispatcher (module import — same pattern as the avatar renderer).
//
// getDisplayMedia requires a user gesture and shows the browser's share
// picker, so the model can never capture unprompted: the user "arms"
// sharing once via the Share-screen button, the stream stays open (the
// browser shows its own sharing indicator the whole time), and from then
// on take_screenshot / record_screen_clip capture on demand. Stopping the
// share — our button or the browser's own "Stop sharing" bar — disarms
// it. Permission does not persist across page loads.
import { reactive } from "./reactive";

// Longest clip record_screen_clip will capture. Mirrored in the tool
// description server-side (browser_tools.RECORD_SCREEN_CLIP_TOOL).
export const MAX_CLIP_SECONDS = 90;

class ScreenCapture {
    constructor() {
        this.state = reactive({ armed: false, recording: false });
        this._stream = null;
        this._video = null;
    }

    /** Screen Capture API availability. Mobile browsers (Android Chrome,
     *  iOS Safari, headset browsers) don't implement getDisplayMedia at
     *  all — the UI hides the share button and the tools return a "use
     *  the paperclip instead" error rather than a raw TypeError. */
    get isSupported() {
        return typeof navigator.mediaDevices?.getDisplayMedia === "function";
    }

    get isArmed() {
        return this.state.armed && !!this._stream;
    }

    /** Start screen sharing. Must run in a user-gesture handler (a click)
     *  or the browser rejects the request outright. Returns true when
     *  armed, false when the user dismissed the picker. */
    async arm() {
        if (this.isArmed) return true;
        if (!this.isSupported) {
            throw new Error("Screen sharing is not supported by this browser (mobile browsers don't allow screen capture).");
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                // Hint the picker toward whole-monitor capture — that's what
                // "look at my screen" means. The user can still pick a
                // window or tab; whatever they choose is what gets grabbed.
                video: { displaySurface: "monitor" },
                // Adds the "share audio" checkbox to the picker — no extra
                // permission prompt, the user decides per share. Whether a
                // track actually arrives is platform-dependent: tab shares
                // carry audio everywhere, whole-monitor audio is
                // Windows-only. Recordings include the track when present;
                // screenshots ignore it.
                audio: true,
            });
        } catch (e) {
            // NotAllowedError = the user dismissed the picker — a choice,
            // not a failure. Everything else surfaces to the caller.
            if (e?.name !== "NotAllowedError") throw e;
            return false;
        }
        await this._adopt(stream);
        return true;
    }

    /** Wire an acquired display stream into the service (shared by arm()
     *  and the Electron handoff's armSilent()). */
    async _adopt(stream) {
        this._stream = stream;
        // The browser's "Stop sharing" bar ends the track without touching
        // our UI — mirror it into our state so the button un-lights.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => this.disarm());
        // A detached <video> is the simplest way to get decodable frames
        // out of the stream; it never needs to enter the DOM. muted so an
        // audio track never plays back (echo).
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        this._video = video;
        this.state.armed = true;
    }

    /** Electron-only: silently re-arm a specific desktop-capturer source —
     *  used when a share follows the call across the mascot pop-out/in
     *  handoff (a MediaStream is per-document and can't migrate, but the
     *  shell remembers which source the user picked). Legacy
     *  chromeMediaSource constraints need no user gesture. Returns true on
     *  success, false when the source is gone or capture fails — the user
     *  just re-arms manually then. */
    async armSilent(source) {
        if (this.isArmed) return true;
        if (!source?.id || typeof navigator.mediaDevices?.getUserMedia !== "function") {
            return false;
        }
        const video = {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: source.id,
            },
        };
        let stream = null;
        if (source.audio) {
            // The original share had loopback audio — try to keep it.
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: { mandatory: { chromeMediaSource: "desktop" } },
                    video,
                });
            } catch (e) { /* fall through to video-only */ }
        }
        if (!stream) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
            } catch (e) {
                console.warn("[screen_capture] silent re-arm failed", e);
                return false;
            }
        }
        await this._adopt(stream);
        return true;
    }

    disarm() {
        for (const track of this._stream?.getTracks() || []) track.stop();
        if (this._video) {
            this._video.srcObject = null;
            this._video = null;
        }
        this._stream = null;
        this.state.armed = false;
    }

    /** Grab the current frame as a JPEG data URL (long edge ≤ maxSize).
     *  Returns null when not armed or before the stream's first frame. */
    grabFrame(maxSize = 2048) {
        const video = this._video;
        if (!this.isArmed || !video || !video.videoWidth) return null;
        const scale = Math.min(1, maxSize / Math.max(video.videoWidth, video.videoHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        // JPEG, not PNG: a 2048-wide PNG of a busy desktop can brush the
        // server's 10 MB upload cap; 0.9-quality JPEG keeps UI text
        // readable at a fraction of the bytes.
        return canvas.toDataURL("image/jpeg", 0.9);
    }

    /** Record the armed stream for `seconds` (clamped to 1-90) and return
     *  {blob, hasAudio} — mp4 when the browser can mux it (better odds
     *  with xAI's video endpoints), else webm. Audio rides along whenever
     *  the user's share carries a track. Returns null when not armed. If
     *  the user stops sharing mid-recording the recorder stops early and
     *  the partial clip is returned. */
    async recordClip(seconds) {
        if (!this.isArmed) return null;
        if (this.state.recording) {
            throw new Error("A screen recording is already in progress.");
        }
        const dur = Math.max(1, Math.min(MAX_CLIP_SECONDS, Math.round(seconds || 10)));
        const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"]
            .find((m) => window.MediaRecorder?.isTypeSupported?.(m));
        if (!mime) {
            throw new Error("This browser cannot record video (no MediaRecorder support).");
        }
        const hasAudio = this._stream.getAudioTracks().length > 0;
        const recorder = new MediaRecorder(this._stream, { mimeType: mime });
        const chunks = [];
        this.state.recording = true;
        let stopTimer = null;
        try {
            const done = new Promise((resolve, reject) => {
                recorder.ondataavailable = (ev) => {
                    if (ev.data?.size) chunks.push(ev.data);
                };
                recorder.onstop = resolve;
                recorder.onerror = (ev) => reject(ev.error || new Error("Recording failed."));
            });
            recorder.start();
            stopTimer = setTimeout(() => {
                if (recorder.state !== "inactive") recorder.stop();
            }, dur * 1000);
            await done;
            if (!chunks.length) {
                throw new Error("Recording produced no data.");
            }
            return {
                blob: new Blob(chunks, { type: recorder.mimeType || mime }),
                hasAudio,
            };
        } finally {
            clearTimeout(stopTimer);
            if (recorder.state !== "inactive") {
                try { recorder.stop(); } catch (e) { /* already stopping */ }
            }
            this.state.recording = false;
        }
    }
}

export const screenCapture = new ScreenCapture();
