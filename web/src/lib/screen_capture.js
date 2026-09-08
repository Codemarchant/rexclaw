// Share-capture singleton (screen AND camera), shared by the voice/text/
// mascot views and the tool dispatcher (module import — same pattern as
// the avatar renderer).
//
// Two independent sources, each a MediaStream feeding a detached <video>:
//   screen — getDisplayMedia. Requires a user gesture and shows the
//            browser's share picker, so the model can never capture
//            unprompted: the user "arms" sharing once via the share
//            popover, the stream stays open (the browser shows its own
//            sharing indicator the whole time), and from then on the
//            capture tools grab frames on demand.
//   camera — getUserMedia({video}). The universal one: works on iPad/
//            iPhone Safari, Android, headset browsers and the desktop app
//            where getDisplayMedia doesn't exist. Same arming contract —
//            the user starts it from the popover, the browser/OS shows the
//            camera-in-use indicator, tools read frames on demand.
// Stopping a share — our button or the browser's own "Stop sharing" bar /
// the OS ending the camera track — disarms that source. Permission does
// not persist across page loads.
import { reactive } from "./reactive";

// Longest clip record_screen_clip will capture. Mirrored in the tool
// description server-side (browser_tools.RECORD_SCREEN_CLIP_TOOL).
export const MAX_CLIP_SECONDS = 90;

export const SOURCES = ["screen", "camera"];

const PREFERRED_KEY = "rexclaw.share_source";
// The camera the user picked, shared by every window of this browser —
// each page instance (main window, mascot) would otherwise start from
// "whatever Chromium enumerates first", which on a desktop with an IR or
// virtual camera is the wrong one. Safari re-randomises deviceIds per
// load, so it is only ever an `ideal` hint.
const CAMERA_DEVICE_KEY = "rexclaw.camera_device";
// Cross-window flag for the desktop pop-out/in handoff (localStorage is
// shared between the main and mascot windows; a camera stream can't
// migrate, but the arriving page can silently re-open the same device —
// getUserMedia needs no gesture once the shell has granted "media").
const CAMERA_HANDOFF_KEY = "rexclaw.camera_handoff";

class ScreenCapture {
    constructor() {
        this.state = reactive({
            // `armed` = any source live — the pre-camera consumers (button
            // highlight, handoffs) key off it unchanged.
            armed: false,
            screen: false,
            camera: false,
            recording: false,
            // Which source the header button / hotkey toggles. Sticky per
            // browser so a tablet user who picked Camera once keeps it.
            preferred: this._loadPreferred(),
            facing: "user",
            cameraDeviceId: this._loadCameraDevice(),
            cameras: [],
        });
        this._slots = { screen: null, camera: null };
    }

    _loadCameraDevice() {
        try { return localStorage.getItem(CAMERA_DEVICE_KEY) || null; } catch (e) { return null; }
    }

    /** Remember the camera to use (null = browser default). Applies to the
     *  next start; a live camera is re-opened on the new device. */
    setCameraDevice(deviceId) {
        this.state.cameraDeviceId = deviceId || null;
        try {
            if (deviceId) localStorage.setItem(CAMERA_DEVICE_KEY, deviceId);
            else localStorage.removeItem(CAMERA_DEVICE_KEY);
        } catch (e) { /* ignore */ }
    }

    _loadPreferred() {
        try {
            const v = localStorage.getItem(PREFERRED_KEY);
            if (SOURCES.includes(v)) return v;
        } catch (e) { /* storage blocked */ }
        // No Screen Capture API (phones, tablets, headsets) → camera is the
        // only thing the button can do.
        return this.isSupported ? "screen" : "camera";
    }

    setPreferred(source) {
        if (!SOURCES.includes(source)) return;
        this.state.preferred = source;
        try { localStorage.setItem(PREFERRED_KEY, source); } catch (e) { /* ignore */ }
    }

    /** Screen Capture API availability. Mobile browsers (Android Chrome,
     *  iOS Safari, headset browsers) don't implement getDisplayMedia at
     *  all — the UI hides the Screen option and the tools return a "use
     *  the camera or the paperclip instead" error rather than a raw
     *  TypeError. */
    get isSupported() {
        return typeof navigator.mediaDevices?.getDisplayMedia === "function";
    }

    /** Camera availability: getUserMedia exists on every secure origin
     *  (the app's HTTPS mode covers LAN devices); plain http over LAN has
     *  no mediaDevices at all. */
    get isCameraSupported() {
        return typeof navigator.mediaDevices?.getUserMedia === "function";
    }

    /** Either source live. */
    get isArmed() {
        return this.isSourceArmed("screen") || this.isSourceArmed("camera");
    }

    isSourceArmed(source) {
        return !!this._slots[source]?.stream && !!this.state[source];
    }

    /** The source a capture tool should read: the one it asked for when
     *  that is live, else whichever single source is live, else null.
     *  Screen wins when both are up and the model didn't say — "look at
     *  my screen" is the older, more common request. */
    resolveSource(requested) {
        if (requested && SOURCES.includes(requested)) {
            return this.isSourceArmed(requested) ? requested : null;
        }
        if (this.isSourceArmed("screen")) return "screen";
        if (this.isSourceArmed("camera")) return "camera";
        return null;
    }

    /** The live camera <video> (for on-device analysis), or null. */
    get cameraVideo() {
        return this.isSourceArmed("camera") ? this._slots.camera.video : null;
    }

    /** The live camera MediaStream (for an in-DOM preview), or null. */
    get cameraStream() {
        return this.isSourceArmed("camera") ? this._slots.camera.stream : null;
    }

    /** Header button / hotkey: stop everything when anything is live,
     *  else start the preferred source. */
    async toggle() {
        if (this.isArmed) {
            this.disarm();
            return false;
        }
        return this.state.preferred === "camera" ? this.armCamera() : this.arm();
    }

    /** Start screen sharing. Must run in a user-gesture handler (a click)
     *  or the browser rejects the request outright. Returns true when
     *  armed, false when the user dismissed the picker. */
    async arm() {
        if (this.isSourceArmed("screen")) return true;
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
        await this._adopt("screen", stream);
        return true;
    }

    /** Start camera sharing. `facing` = "user" (front, default) or
     *  "environment" (back); `deviceId` pins a specific camera (desktop
     *  with several webcams). Returns true when armed, false when the
     *  user denied the permission prompt. Other failures throw with a
     *  message the UI can show:
     *    NotReadableError → camera in use / OS privacy toggle off (Windows:
     *      "Let desktop apps access your camera" must be on for the
     *      desktop app);
     *    NotFoundError   → no camera on this device. */
    async armCamera({ facing, deviceId } = {}) {
        if (!this.isCameraSupported) {
            throw new Error(window.isSecureContext
                ? "Camera capture is not supported by this browser."
                : "Camera capture needs a secure (HTTPS) connection — turn on HTTPS mode in Settings and open the https:// address.");
        }
        if (facing) this.state.facing = facing;
        if (deviceId !== undefined) this.setCameraDevice(deviceId);
        // iOS keeps one live camera stream per page: a second getUserMedia
        // silently mutes the first with no way back — always drop the old
        // one before asking for another (also how facing switches work).
        if (this.isSourceArmed("camera")) this.disarm("camera");
        const video = {
            // Landscape "ideal" numbers make Android/iOS pick a real preset
            // and hand back upright frames; no `exact` so any webcam fits.
            width: { ideal: 1280 },
            height: { ideal: 720 },
        };
        if (this.state.cameraDeviceId) {
            video.deviceId = { ideal: this.state.cameraDeviceId };
        } else {
            video.facingMode = this.state.facing;
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        } catch (e) {
            if (e?.name === "NotAllowedError") return false;
            if (e?.name === "NotReadableError" || /could not start video source/i.test(e?.message || "")) {
                throw new Error("The camera could not be started — it may be in use by another app, "
                    + "or camera access is switched off in the system privacy settings "
                    + "(Windows: Settings → Privacy → Camera → allow desktop apps).");
            }
            if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
                throw new Error("No usable camera was found on this device.");
            }
            throw e;
        }
        await this._adopt("camera", stream);
        // Labels only exist after a grant — refresh the picker list now, and
        // record which device actually opened so every window agrees on it
        // (a "default" start resolves to a concrete camera here).
        this.refreshCameras();
        const opened = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
        if (opened && opened !== this.state.cameraDeviceId) this.setCameraDevice(opened);
        return true;
    }

    /** Flip between front and back camera (phones/tablets). */
    async switchCamera() {
        const facing = this.state.facing === "user" ? "environment" : "user";
        return this.armCamera({ facing, deviceId: null });
    }

    /** Populate state.cameras from enumerateDevices (labels are blank until
     *  a camera permission exists in this page; Safari also re-randomises
     *  deviceIds per load, so the list is for picking, not persisting). */
    async refreshCameras() {
        if (typeof navigator.mediaDevices?.enumerateDevices !== "function") return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.state.cameras = devices
                .filter((d) => d.kind === "videoinput")
                .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
        } catch (e) { /* enumeration is best-effort */ }
    }

    /** Wire an acquired stream into a source slot (shared by arm(),
     *  armCamera() and the Electron handoff's armSilent()). */
    async _adopt(source, stream) {
        // The browser's "Stop sharing" bar / the OS ending the camera track
        // (iOS backgrounding, screen lock) ends the track without touching
        // our UI — mirror it into our state so the button un-lights.
        stream.getVideoTracks()[0]?.addEventListener("ended", () => this.disarm(source));
        // A detached <video> is the simplest way to get decodable frames
        // out of the stream; it never needs to enter the DOM. muted so an
        // audio track never plays back (echo); playsInline so iOS doesn't
        // try to go fullscreen with it.
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.autoplay = true;
        video.srcObject = stream;
        await video.play();
        this._slots[source] = { stream, video };
        this.state[source] = true;
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
        if (this.isSourceArmed("screen")) return true;
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
        await this._adopt("screen", stream);
        return true;
    }

    /** Desktop pop-out/in handoff for the camera half: the leaving window
     *  notes the device it had open, the arriving window re-opens it
     *  without a gesture (the shell's permission handler already grants
     *  "media"). Mirrors the shell's screen-source handoff, but needs no
     *  IPC — a camera is addressed by deviceId/facing, not a capturer id. */
    cameraHandoffSet() {
        if (!this.isSourceArmed("camera")) return false;
        try {
            localStorage.setItem(CAMERA_HANDOFF_KEY, JSON.stringify({
                deviceId: this.state.cameraDeviceId || null,
                facing: this.state.facing,
            }));
        } catch (e) { return false; }
        return true;
    }

    async cameraHandoffTake() {
        let opts = null;
        try {
            const raw = localStorage.getItem(CAMERA_HANDOFF_KEY);
            if (!raw) return false;
            localStorage.removeItem(CAMERA_HANDOFF_KEY);
            opts = JSON.parse(raw);
        } catch (e) { return false; }
        try {
            return await this.armCamera(opts || {});
        } catch (e) {
            console.warn("[screen_capture] camera handoff failed", e);
            return false;
        }
    }

    /** Stop one source, or everything when called without one. */
    disarm(source) {
        const list = source ? [source] : SOURCES;
        for (const s of list) {
            const slot = this._slots[s];
            if (slot) {
                for (const track of slot.stream.getTracks()) track.stop();
                slot.video.srcObject = null;
            }
            this._slots[s] = null;
            this.state[s] = false;
        }
        this.state.armed = this.isArmed;
    }

    /** Grab the current frame as a JPEG data URL (long edge ≤ maxSize).
     *  Returns null when the source isn't armed or before its first
     *  frame. `source` follows resolveSource(). */
    grabFrame(maxSize = 2048, source) {
        const s = this.resolveSource(source);
        const video = s && this._slots[s]?.video;
        if (!video || !video.videoWidth) return null;
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
     *  {blob, hasAudio, source} — mp4 when the browser can mux it (better
     *  odds with xAI's video endpoints; the only container iOS Safari
     *  records), else webm. Audio rides along whenever the user's share
     *  carries a track (camera shares never do). Returns null when not
     *  armed. If the user stops sharing mid-recording the recorder stops
     *  early and the partial clip is returned. */
    async recordClip(seconds, source) {
        const s = this.resolveSource(source);
        if (!s) return null;
        if (this.state.recording) {
            throw new Error("A recording is already in progress.");
        }
        const stream = this._slots[s].stream;
        const dur = Math.max(1, Math.min(MAX_CLIP_SECONDS, Math.round(seconds || 10)));
        const mime = ["video/mp4", "video/webm;codecs=vp9", "video/webm"]
            .find((m) => window.MediaRecorder?.isTypeSupported?.(m));
        if (!mime) {
            throw new Error("This browser cannot record video (no MediaRecorder support).");
        }
        const hasAudio = stream.getAudioTracks().length > 0;
        const recorder = new MediaRecorder(stream, { mimeType: mime });
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
                source: s,
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
