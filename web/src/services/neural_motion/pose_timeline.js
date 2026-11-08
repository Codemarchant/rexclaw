/**
 * Timed pose buffer for neural body motion.
 *
 * The server sends SEGMENTS: runs of pose frames at a fixed fps, anchored to
 * the playback AudioContext clock (the clock speech is scheduled on, so
 * sampling with ctx.currentTime stays on the voice actually heard). Frames
 * are a flat Float32Array of unit quaternions:
 *     quats[(frame * boneCount + bone) * 4 + {x,y,z,w}]
 * plus the pelvis offset, three floats per frame, and the feet and root.
 *
 * sample(t) nlerps the two bracketing frames (dense frames, so nlerp reads
 * the same as slerp) into a scratch Map that is reused across calls and
 * keeps its last values, as do this.hips, this.feet and this.root, so callers can
 * hold the last pose while it fades.
 */

const PRUNE_KEEP_S = 2.0;    // history kept behind the play head
const BRIDGE_MAX_S = 1.0;    // widest gap between segments interpolated across

const segmentEnd = (s) => s.t0 + (s.frameCount - 1) / s.fps;

export class PoseTimeline {
    constructor() {
        this._segments = [];    // sorted by t0: {t0, fps, boneNames, quats, frameCount}
        this._scratch = new Map();
        this.hips = new Float32Array(3);
        this.feet = new Float32Array(4);
        this.root = new Float32Array(3);     // survives the frames: see service
    }

    append(t0, fps, boneNames, quats, hips, feet, root) {
        const frameCount = quats.length / (boneNames.length * 4);
        if (!Number.isInteger(frameCount) || frameCount < 1) return;
        // A new line can start while the last one's wind-down is still
        // buffered: the newer frames win.
        this.truncateFrom(t0);
        this._segments.push({ t0, fps, boneNames, quats, hips, feet, root, frameCount });
    }

    /** Drop everything from `t` on (barge-in: the audio after t was cut). */
    truncateFrom(t) {
        this._segments = this._segments.filter((s) => s.t0 < t);
        for (const seg of this._segments) {
            if (segmentEnd(seg) > t) {
                seg.frameCount = Math.max(1, Math.floor((t - seg.t0) * seg.fps) + 1);
            }
        }
    }

    clear() { this._segments = []; }

    /** Playback time of the last buffered frame, -Infinity when empty. */
    get end() {
        return this._segments.length ? segmentEnd(this._segments[this._segments.length - 1]) : -Infinity;
    }

    prune(now) {
        this._segments = this._segments.filter((s) => segmentEnd(s) > now - PRUNE_KEEP_S);
    }

    /** The pose at `t`, or null outside the buffered data. A small gap
     *  between two segments interpolates, so a seam never freezes and snaps. */
    sample(t) {
        const seg = this._segments.find((s) => t >= s.t0 && t <= segmentEnd(s));
        if (seg) {
            const f = (t - seg.t0) * seg.fps;
            const i0 = Math.min(seg.frameCount - 1, Math.floor(f));
            const i1 = Math.min(seg.frameCount - 1, i0 + 1);
            return this._blend(seg, i0, seg, i1, f - i0);
        }
        const prev = this._segments.filter((s) => segmentEnd(s) < t).pop();
        const next = this._segments.find((s) => s.t0 > t);
        if (!prev || !next) return null;
        const prevEnd = segmentEnd(prev);
        if (next.t0 - prevEnd > BRIDGE_MAX_S) return null;
        return this._blend(prev, prev.frameCount - 1, next, 0, (t - prevEnd) / (next.t0 - prevEnd));
    }

    _blend(segA, iA, segB, iB, alpha) {
        const names = segA.boneNames;
        const count = names.length;
        const out = this._scratch;
        if (out.size !== count || !out.has(names[0])) {
            out.clear();
            for (const name of names) out.set(name, new Float32Array(4));
        }
        const qa = segA.quats;
        const qb = segB.quats;
        for (let b = 0; b < count; b++) {
            const q = out.get(names[b]);
            const a0 = (iA * count + b) * 4;
            const b0 = (iB * count + b) * 4;
            const dot = qa[a0] * qb[b0] + qa[a0 + 1] * qb[b0 + 1]
                      + qa[a0 + 2] * qb[b0 + 2] + qa[a0 + 3] * qb[b0 + 3];
            const s1 = dot < 0 ? -alpha : alpha;
            const s0 = 1 - alpha;
            const x = qa[a0] * s0 + qb[b0] * s1;
            const y = qa[a0 + 1] * s0 + qb[b0 + 1] * s1;
            const z = qa[a0 + 2] * s0 + qb[b0 + 2] * s1;
            const w = qa[a0 + 3] * s0 + qb[b0 + 3] * s1;
            const len = Math.hypot(x, y, z, w) || 1;
            q[0] = x / len; q[1] = y / len; q[2] = z / len; q[3] = w / len;
        }
        for (let axis = 0; axis < 3; axis++) {
            this.hips[axis] = segA.hips[iA * 3 + axis] * (1 - alpha) + segB.hips[iB * 3 + axis] * alpha;
        }
        for (let v = 0; v < 4 && segA.feet.length; v++) {
            this.feet[v] = segA.feet[iA * 4 + v] * (1 - alpha) + segB.feet[iB * 4 + v] * alpha;
        }
        for (let v = 0; v < 3 && segA.root.length; v++) {
            this.root[v] = segA.root[iA * 3 + v] * (1 - alpha) + segB.root[iB * 3 + v] * alpha;
        }
        return out;
    }
}
