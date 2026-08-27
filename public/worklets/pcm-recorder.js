/**
 * Collects mono float samples from the microphone and posts fixed-size chunks of
 * 16-bit little-endian PCM back to the main thread — the format AssemblyAI's
 * streaming API expects.
 *
 * Chunk size in samples is passed in via `processorOptions.chunkSamples` —
 * see `ASSEMBLYAI_CHUNK_MS` / `audioChunkMs` in `src/lib/caption.ts`, which is
 * what `useCaptionHub.ts` converts into this before constructing the
 * `AudioWorkletNode`. Falling back to `DEFAULT_CHUNK_SAMPLES` here is only a
 * safety net for a caller that forgets to pass one; the app itself always
 * does.
 *
 * The AudioContext is created at 16 kHz, so 1600 samples is exactly 100 ms,
 * comfortably inside the 50–1000 ms chunk window the API asks for.
 */
const DEFAULT_CHUNK_SAMPLES = 1600;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options?.processorOptions?.chunkSamples;
    this.chunkSamples =
      typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? Math.round(requested)
        : DEFAULT_CHUNK_SAMPLES;

    this.buffer = new Float32Array(this.chunkSamples);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) {
      return true;
    }

    for (let index = 0; index < channel.length; index += 1) {
      this.buffer[this.offset] = channel[index];
      this.offset += 1;

      if (this.offset === this.chunkSamples) {
        this.flush();
      }
    }

    return true;
  }

  flush() {
    const pcm = new Int16Array(this.chunkSamples);
    let sumOfSquares = 0;

    for (let index = 0; index < this.chunkSamples; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.buffer[index]));
      sumOfSquares += sample * sample;
      pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    // The loudness rides along with the audio so the meter needs no second
    // microphone stream of its own.
    this.port.postMessage(
      { pcm: pcm.buffer, level: Math.sqrt(sumOfSquares / this.chunkSamples) },
      [pcm.buffer],
    );

    this.offset = 0;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
