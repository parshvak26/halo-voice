// Runs on the audio thread. Converts each block of Float32 samples coming from
// the microphone into 16-bit signed PCM (linear16), which is what Deepgram's
// streaming endpoint expects, and posts it back to the main thread.
class PCMWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const channel = input[0]; // Float32Array, values in [-1, 1]
      const pcm = new Int16Array(channel.length);
      for (let i = 0; i < channel.length; i++) {
        const s = Math.max(-1, Math.min(1, channel[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the buffer (zero-copy) to the main thread.
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true; // keep the processor alive
  }
}
registerProcessor("pcm-worklet", PCMWorklet);
