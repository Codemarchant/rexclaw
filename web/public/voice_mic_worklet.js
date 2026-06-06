// AudioWorklet replacement for the deprecated ScriptProcessorNode mic capture.
// Runs in the AudioWorkletGlobalScope (a separate thread); communicates with
// the main thread via this.port.postMessage.
//
// This file is loaded by audioContext.audioWorklet.addModule() at its public
// /odoo_rexclaw_companions/static/src/services/voice_mic_worklet.js URL — so it
// is NOT included in the backend asset bundle (would be wrapped in module
// boilerplate the worklet runtime doesn't speak).
//
// Buffers incoming Float32 samples (delivered in 128-sample render quanta by
// default) into a frame of `frameSize` samples and posts each completed frame
// to the main thread, where voice_service converts to PCM16 + base64 and
// streams over the xAI realtime WebSocket. Default frame size matches the
// 2048-sample buffer the old ScriptProcessor used so per-WS-message rate /
// upstream latency stay equivalent.

class MicCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.frameSize = opts.frameSize || 2048;
        this.scratch = new Float32Array(this.frameSize);
        this.scratchOffset = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) {
            // No mic input on this render quantum — just keep alive.
            return true;
        }
        const channel = input[0];  // typically 128 samples
        let inOffset = 0;
        while (inOffset < channel.length) {
            const remainingIn = channel.length - inOffset;
            const remainingOut = this.frameSize - this.scratchOffset;
            const copyLen = remainingIn < remainingOut ? remainingIn : remainingOut;
            this.scratch.set(
                channel.subarray(inOffset, inOffset + copyLen),
                this.scratchOffset,
            );
            this.scratchOffset += copyLen;
            inOffset += copyLen;
            if (this.scratchOffset >= this.frameSize) {
                // Send a copy — the underlying scratch buffer is reused on
                // the next render quantum and would clobber in-flight data.
                this.port.postMessage(this.scratch.slice());
                this.scratchOffset = 0;
            }
        }
        return true;
    }
}

registerProcessor("mic-capture", MicCaptureProcessor);
