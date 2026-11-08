/**
 * Neural body motion, browser side (server: routes/neural_motion.py).
 *
 * Every chunk of the companion's scheduled speech is copied to the server
 * with the playback time it will be heard at, and timed pose frames come
 * back on that same clock. The avatar renderer polls pose() once per
 * rendered frame, so motion stays on the voice whatever the main thread is
 * doing, and playback running ahead of real time is what gives the model
 * its head start. stats() shows how much of one there was.
 *
 * A test file takes the same path, so what the Settings panel plays is what
 * a call would get. One instance per body: the base avatar's singleton, and
 * one per group-call peer (peerNeuralMotion), each on its own stream.
 */

import { avatarRenderer } from "../avatar_renderer";
import { lipsync } from "../lipsync_service";
import { PoseTimeline } from "./pose_timeline";

// The weight eases in and out over 0.25 s, Unity's default transition
// (UnityCsReference StateMachine.cs: duration 0.25, fixed).
const EASE_RATE_PER_S = 4;
// After the voice stops the server sends two seconds of frames heading for
// the idle (a model without transitions: its own motion on silence). From
// BLEND_START_FRACTION of the way through they blend on a straight line into
// the live idle, which is where the body has to end up, so there's nothing
// left to settle after.
const BLEND_START_FRACTION = 0.4;
const WIND_DOWN_S = 2.0;
const MIN_WIND_DOWN_S = 0.5;  // shorter: those frames haven't arrived yet
// Chunks of a line are back to back; this has to clear their rounding.
const NEW_LINE_GAP_S = 0.05;
const TEST_LEAD_S = 1.0;      // lets the first batch land before the file plays
const TEST_CHUNK_S = 0.2;
const TEST_SETTLE_S = 0.4;    // past the fade, so stopping cuts nothing visible

export class NeuralMotion {
    /** `peerId` null drives the base avatar, else that peer's. */
    constructor(peerId = null) {
        this.peerId = peerId;
        this.timeline = new PoseTimeline();
        this.config = null;      // {model, style, parts}
        this.faceDirector = false;
        this.ctx = null;         // the clock frames are anchored to
        this.ws = null;
        this.rate = 24000;       // the voice's; the model reloads nothing if it differs
        this.bones = [];
        this.handRest = null;    // the model's rest hand, if it names one (hand_retarget.js)
        this.fps = 30;
        this.cancels = 0;        // matches the server's count, see _onFrames
        this.error = "";
        this._queue = [];        // sent once the socket opens
        this._started = "";      // what the server's stream was started with
        this._weight = 0;
        this._pose = null;       // last sampled pose, held while it fades
        this._speechEnd = 0;     // playback time the scheduled speech runs out
        this._lastPoll = 0;
        this._test = null;
        this._stats = { segments: 0, late: 0, minLead: Infinity };
        this._base = null;       // the avatar's pose under this layer, VRM axes
        this._starting = 0;      // starts the server hasn't answered yet
        this._whenReady = null;
        this.pose = this.pose.bind(this);
        this.root = this.root.bind(this);
    }

    get enabled() { return !!this.config; }

    /** {model, style, parts: ["torso", ...]}, or null for off. */
    configure(config) {
        // Turning shuffling on or off by hand starts it again from home: off eases the body home,
        // and on must not bring back where it had wandered to before.
        const shuffling = (c) => !!c?.parts?.has("shuffle");
        const next = config && { ...config, parts: new Set(config.parts) };
        if (shuffling(this.config) !== shuffling(next)) this.resetRoot();
        this.config = next;
        // No restart here: _ensureStream restarts the server's stream only when what it was
        // started with (model, style, shuffling, rate) changed, so a part ticked mid-line
        // doesn't pop the body.
        if (config) {
            // Loads the model now: on the first line of speech it would
            // cost that line its opening.
            this._ensureStream(this.rate);
        } else if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /** With the face director on, the head is its: nods and shakes land on
     *  the words that mean them, which the voice alone can't know. */
    setFaceDirector(on) { this.faceDirector = !!on; }

    // ── From the speech scheduler ─────────────────────────────────────────

    ingest(pcm, rate, startAt, ctx) {
        if (!this.config) return;
        if (ctx !== this.ctx) {
            this.timeline.clear();
            this.ctx = ctx;
            this._speechEnd = 0;
        }
        this._ensureStream(rate);
        if (startAt > this._speechEnd + NEW_LINE_GAP_S) this._seed(startAt);
        const message = new ArrayBuffer(8 + pcm.byteLength);
        new DataView(message).setFloat64(0, startAt, true);
        new Float32Array(message, 8).set(pcm);
        this._send(message);
        this._speechEnd = startAt + pcm.length / rate;
    }

    /** The model carries on from what will be on screen when this line is
     *  heard: the last line's frames if they run that far (a line can land
     *  mid-transition, whose frames end on the idle), else the idle. */
    _seed(startAt) {
        const playing = this.timeline.sample(startAt);
        const base = this._base;
        const w = this._handover(startAt);
        // Mid-handover what shows is the frames blended into the idle.
        const pose = playing ? this.bones.flatMap((name, i) => {
            const q = playing.get(name);
            if (!base) return Array.from(q);
            const b = base.subarray(i * 4, i * 4 + 4);
            const s = q[0] * b[0] + q[1] * b[1] + q[2] * b[2] + q[3] * b[3] < 0 ? -1 : 1;
            const mixed = [0, 1, 2, 3].map((k) => q[k] * w + s * b[k] * (1 - w));
            const len = Math.hypot(...mixed) || 1;
            return mixed.map((v) => v / len);
        }) : base && Array.from(base);
        if (!pose) return;
        this._releaseHeldArm(pose);
        // The transition's frames are cut here too, and the root with them.
        this._send(JSON.stringify({ type: "seed", pose, root: Array.from(this.timeline.root) }));
    }

    /** An arm held in a gesture stays out of the seed. Told it starts there,
     *  the model keeps holding it, for up to about 5 s on the styles tried.
     *  It gets the other arm's hang, mirrored, as a starting point; the blend
     *  still carries the real arm away from the gesture. */
    _releaseHeldArm(pose) {
        const held = avatarRenderer.neuralTakeArms(this.peerId);
        if (held.length !== 1) return;
        const [side] = held;
        const other = side === "left" ? "right" : "left";
        this.bones.forEach((name, i) => {
            if (!name.startsWith(side) || !/Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(name)) return;
            const j = this.bones.indexOf(other + name.slice(side.length)) * 4;
            pose[i * 4] = pose[j];
            pose[i * 4 + 1] = -pose[j + 1];
            pose[i * 4 + 2] = -pose[j + 2];
            pose[i * 4 + 3] = pose[j + 3];
        });
    }

    finish() {
        if (!this.config || !this.ws) return;
        // The idle underneath is where the transition has to land, without
        // any gesture this line ended: the arm won't be there by then.
        const idle = this._base ? Array.from(this._base) : null;
        if (idle) this._releaseHeldArm(idle);
        this._send(JSON.stringify({ type: "finish", idle }));
    }

    /** Barge-in: speech from now on was cut. */
    cancel() {
        if (!this.ws) return;
        this.cancels += 1;
        this._send(JSON.stringify({ type: "cancel" }));
        if (this.ctx) this.timeline.truncateFrom(this.ctx.currentTime);
        this._speechEnd = 0;
    }

    // ── Socket ────────────────────────────────────────────────────────────

    _ensureStream(rate) {
        const { model, style } = this.config;
        const shuffle = this.config.parts.has("shuffle");
        const key = `${model}|${style}|${shuffle}|${rate}`;
        if (!this.ws || this.ws.readyState > WebSocket.OPEN) this._open();
        if (key === this._started) return;
        this._started = key;
        this.rate = rate;
        this._starting += 1;
        this._send(JSON.stringify({
            type: "start", model, style, shuffle, rate,
        }));
    }

    _open() {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${scheme}://${location.host}/api/neural_motion/stream`);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
            for (const message of this._queue) ws.send(message);
            this._queue = [];
        };
        ws.onmessage = (ev) => {
            if (typeof ev.data === "string") this._onText(JSON.parse(ev.data));
            else this._onFrames(ev.data);
        };
        ws.onclose = () => {
            if (this.ws !== ws) return;
            this.ws = null;
            this._started = "";
            this.cancels = 0;     // the server's count starts over too
        };
        this.ws = ws;
        this.cancels = 0;
        this._started = "";
        this._starting = 0;
        this._queue = [];
    }

    _send(message) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(message);
        else this._queue.push(message);
    }

    /** Resolves once the server has answered every start: it names the
     *  bones the pose is sent in, and the model is loaded. */
    _ready() {
        if (!this._starting) return Promise.resolve();
        return new Promise((resolve) => { this._whenReady = resolve; });
    }

    _capturePose() {
        if (!this.bones.length) return;
        const base = this._base?.length === this.bones.length * 4 ? this._base : new Float32Array(this.bones.length * 4);
        // A peer's model can still be loading: no pose then, not a zero one.
        this._base = avatarRenderer.neuralBasePose(this.bones, base, this.peerId, this.handRest) ? base : null;
    }

    _onText(message) {
        // Only a start's answer: a seed or finish can fail and say so too.
        if (message.type === "ready" || message.of === "start") {
            this._starting = Math.max(0, this._starting - 1);
            if (!this._starting) this._whenReady?.();
        }
        if (message.type === "ready") {
            this.bones = message.bones;
            this.fps = message.fps;
            this.hasFeet = message.feet;
            this.handRest = message.hand_rest || null;
            this.error = "";
        } else if (message.type === "error") {
            this.error = message.message;
            console.warn("[neural motion]", message.message);
        }
    }

    _onFrames(buffer) {
        const head = new DataView(buffer);
        const t0 = head.getFloat64(0, true);
        const frames = head.getUint32(8, true);
        const cancels = head.getUint32(12, true);
        if (cancels !== this.cancels || !this.ctx) return;
        const quatFloats = frames * this.bones.length * 4;
        const quats = new Float32Array(buffer, 16, quatFloats);
        const hips = new Float32Array(buffer, 16 + quatFloats * 4, frames * 3);
        const feetAt = 16 + (quatFloats + frames * 3) * 4;
        const feet = new Float32Array(buffer, feetAt, this.hasFeet ? frames * 4 : 0);
        const root = new Float32Array(buffer, feetAt + feet.byteLength, this.hasFeet ? frames * 3 : 0);
        this.timeline.append(t0, this.fps, this.bones, quats, hips, feet, root);
        const lead = t0 - this.ctx.currentTime;
        this._stats.segments += 1;
        this._stats.minLead = Math.min(this._stats.minLead, lead);
        if (lead < 0) this._stats.late += 1;
    }

    // ── From the render loop ──────────────────────────────────────────────

    /** {weight, bones: Map name -> [x,y,z,w], hips, feet, parts, keepHead,
     *  handRest}, or null while idle. */
    pose() {
        if (this.config) this._capturePose();
        if (!this.ctx || !this.config) return null;
        const now = this.ctx.currentTime;
        const dt = Math.min(0.1, Math.max(0, performance.now() - this._lastPoll) / 1000);
        this._lastPoll = performance.now();
        this.timeline.prune(now);
        const sampled = this.timeline.sample(now);
        if (sampled) this._pose = sampled;
        // Starved mid-reply: hold, don't pump back toward the idle.
        const speaking = sampled || (this._pose && now < this._speechEnd);
        const target = speaking ? this._handover(now) : 0;
        const eased = this._weight + (target - this._weight) * (1 - Math.exp(-EASE_RATE_PER_S * dt));
        // The wind-down's frames are still playing, so it goes down the
        // straight line; a cut line has nothing left to play and eases.
        // Past the handover's last frame the body is on the idle: done, not
        // eased (a frame landing just short of it would leave a tail).
        const handedOver = !sampled && this._speechEnd > 0 && this._handover(now) === 0;
        this._weight = (sampled && target < this._weight) || handedOver ? target : eased;
        if (!this._pose) return null;
        if (!speaking && this._weight < 0.002) {
            this._pose = null;
            this._weight = 0;
            return null;
        }
        return {
            weight: this._weight,
            bones: this._pose,
            hips: this.timeline.hips,
            feet: this.hasFeet ? this.timeline.feet : null,
            parts: this.config.parts,
            keepHead: this.faceDirector && !this._test,
            handRest: this.handRest,
        };
    }

    /** The layer's weight at playback time `t`: 1 through the line, then
     *  down a straight line from BLEND_START_FRACTION of the frames after
     *  the voice to 0 on their last one. */
    _handover(t) {
        const end = this.timeline.end;
        const span = end - this._speechEnd;
        if (span < MIN_WIND_DOWN_S) return 1;
        const start = this._speechEnd + span * BLEND_START_FRACTION;
        return Math.max(0, Math.min(1, 1 - (t - start) / (end - start)));
    }

    /** Back to the home spot (a manual reset: the view or shuffling toggled). The renderer
     *  eases the body there; the next line's seed tells the model it is home. */
    resetRoot() {
        this.timeline.root.fill(0);
    }

    /** Where the character has shuffled to ([x, z, turn]); stays after the
     *  frames end, so the idle carries on from there. Null when not in use. */
    root() {
        return this.config?.parts.has("shuffle") && this.config.parts.has("legs") ? this.timeline.root : null;
    }

    // ── Test file ─────────────────────────────────────────────────────────

    /** Plays a speech file with motion, down the same path as a call. */
    async testFile(file) {
        this.stopTest();
        this._stats = { segments: 0, late: 0, minLead: Infinity };
        const ctx = new AudioContext();
        const audio = await ctx.decodeAudioData(await file.arrayBuffer());
        const pcm = audio.getChannelData(0);
        // The pose goes in the bone order the server names, and the model
        // must be loaded: without them the line can't start from the avatar
        // or end on its idle.
        this._ensureStream(audio.sampleRate);
        await this._ready();
        this._capturePose();
        const source = ctx.createBufferSource();
        source.buffer = audio;
        // Through the lipsync, as a call's voice is: with the Face part off
        // the mouth should do what it normally does, for a fair comparison.
        const output = ctx.createGain();
        source.connect(output);
        output.connect(ctx.destination);
        const mouth = lipsync.createChannel();
        mouth.attach(output);
        const stopMouth = mouth.addListener((vowels, intensity) => {
            avatarRenderer.setVowels(vowels);
            avatarRenderer.setSpeakingIntensity(intensity);
        });
        const startAt = ctx.currentTime + TEST_LEAD_S;
        const step = Math.round(TEST_CHUNK_S * audio.sampleRate);
        for (let i = 0; i < pcm.length; i += step) {
            const chunk = pcm.subarray(i, i + step);
            this.ingest(chunk, audio.sampleRate, startAt + i / audio.sampleRate, ctx);
        }
        this.finish();
        source.start(startAt);
        return new Promise((resolve) => {
            // stopTest() settles this too, so a Stop press ends the caller's wait.
            this._test = { ctx, source, mouth, stopMouth, resolve };
            // Past the end of the voice, for the wind-down a call would get.
            source.onended = () => setTimeout(() => {
                if (this._test?.source === source) this.stopTest();
            }, (WIND_DOWN_S + TEST_SETTLE_S) * 1000);
        });
    }

    stopTest() {
        if (!this._test) return;
        const { ctx, source, mouth, stopMouth, resolve } = this._test;
        this._test = null;
        resolve();
        source.onended = null;
        try { source.stop(); } catch (e) { /* not started yet */ }
        lipsync.removeChannel(mouth);   // leaves the mouth closed
        stopMouth();
        this.cancel();
        ctx.close().catch(() => {});
        this.ctx = null;
    }

    /** How far ahead of the voice frames landed (seconds); negative = late. */
    stats() {
        const s = this._stats;
        return { ...s, minLead: s.segments ? +s.minLead.toFixed(3) : null, error: this.error };
    }
}

export const neuralMotion = new NeuralMotion();
if (typeof window !== "undefined") window.__neuralMotion = neuralMotion;

// Group-call peers, by connection id. For now each takes the call's
// settings as they are, the same as the base avatar's.
const peerStreams = new Map();

/** A peer leg's stream: made and configured as the leg joins, or null
 *  for none (with `config` null it is closed and dropped). */
export function peerNeuralMotion(peerId, config) {
    let motion = peerStreams.get(peerId) || null;
    if (config === undefined) return motion;
    if (!config) {
        if (motion) {
            motion.configure(null);
            peerStreams.delete(peerId);
            avatarRenderer.setNeuralMotionProvider(null, null, peerId);
        }
        return null;
    }
    if (!motion) {
        motion = new NeuralMotion(peerId);
        peerStreams.set(peerId, motion);
        avatarRenderer.setNeuralMotionProvider(motion.pose, motion.root, peerId);
    }
    motion.configure(config);
    return motion;
}
