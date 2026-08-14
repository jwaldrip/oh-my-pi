/**
 * WAV framing and PCM16 wire helpers.
 *
 * The macOS `say` fallback speaks WAV on disk rather than raw PCM on a pipe,
 * and the wire protocol is base64 PCM16. This module is the only place those
 * conversions live, so the engines stay about synthesis and nothing else.
 *
 * Byte order is written and read explicitly rather than by reinterpreting the
 * `Int16Array` backing buffer. PCM16 is little-endian by definition, and a
 * typed-array view is host-endian, so the two agree only by accident of the
 * platforms in use. An explicit `DataView` costs a loop and removes the
 * accident.
 */

const RIFF_HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = 2;

export interface PcmAudio {
  pcm: Int16Array;
  sampleRate: number;
}

/** Raised when bytes claiming to be WAV cannot be decoded into mono PCM16. */
export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavFormatError";
  }
}

function ascii(view: DataView, offset: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/**
 * Base64 of little-endian PCM16, which is what `ClientFrame`/`ServerFrame`
 * carry on the wire.
 */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * BYTES_PER_SAMPLE, pcm[i] ?? 0, true);
  return Buffer.from(bytes).toString("base64");
}

/** Inverse of `pcmToBase64`. Rejects a truncated final sample rather than dropping it. */
export function base64ToPcm(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  if (buf.byteLength % BYTES_PER_SAMPLE !== 0) {
    throw new WavFormatError(`PCM16 payload has a trailing half sample (${buf.byteLength} bytes)`);
  }
  const pcm = new Int16Array(buf.byteLength / BYTES_PER_SAMPLE);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * BYTES_PER_SAMPLE, true);
  return pcm;
}

/** Mono 16-bit RIFF/WAVE bytes, ready to hand a subprocess. */
export function encodeWav(audio: PcmAudio): Uint8Array {
  const dataBytes = audio.pcm.length * BYTES_PER_SAMPLE;
  const out = new Uint8Array(RIFF_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  tag(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < audio.pcm.length; i++) {
    view.setInt16(RIFF_HEADER_BYTES + i * BYTES_PER_SAMPLE, audio.pcm[i] ?? 0, true);
  }
  return out;
}

/**
 * Decode RIFF/WAVE into mono PCM16.
 *
 * Chunks are walked rather than assuming the canonical 44-byte header: real
 * encoders emit `LIST`/`fact` chunks before `data`, and `omp say` is free to
 * change its writer between releases. Multi-channel input is downmixed,
 * because everything downstream of here is mono.
 */
export function decodeWav(bytes: Uint8Array): PcmAudio {
  if (bytes.byteLength < 12) throw new WavFormatError(`too short to be WAV (${bytes.byteLength} bytes)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") {
    throw new WavFormatError("missing RIFF/WAVE signature");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, bytes.byteLength - body);
    }
    // Chunks are word aligned; an odd size carries a pad byte.
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0) throw new WavFormatError("no data chunk");
  if (format !== PCM_FORMAT) throw new WavFormatError(`unsupported WAV format tag ${format}, want PCM`);
  if (bits !== BITS_PER_SAMPLE) throw new WavFormatError(`unsupported bit depth ${bits}, want 16`);
  if (channels < 1) throw new WavFormatError(`unsupported channel count ${channels}`);
  if (sampleRate < 1) throw new WavFormatError(`unsupported sample rate ${sampleRate}`);

  const total = Math.floor(dataBytes / BYTES_PER_SAMPLE);
  const frames = Math.floor(total / channels);
  const pcm = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += view.getInt16(dataOffset + (f * channels + c) * BYTES_PER_SAMPLE, true);
    }
    pcm[f] = Math.round(sum / channels);
  }
  return { pcm, sampleRate };
}

/**
 * Resample mono PCM16 to `target`.
 *
 * This exists because the wire format is 16kHz and the engines are not: macOS
 * `say` emits 22050, and `omp` returns whatever rate its WAV happens to carry.
 * Sending those bytes to a client that has been told they are 16kHz does not
 * fail, which is the problem: it plays, slowly and an octave down, and sounds
 * like a bad model rather than a bad conversion.
 *
 * Linear interpolation, deliberately. Speech at these rates does not justify a
 * windowed filter, and the alternative on offer was no conversion at all.
 */
export function resamplePcm(audio: PcmAudio, target: number): PcmAudio {
  if (target < 1) throw new WavFormatError(`unsupported target sample rate ${target}`);
  if (audio.sampleRate === target || audio.pcm.length === 0) {
    return { pcm: audio.pcm, sampleRate: target };
  }

  const ratio = audio.sampleRate / target;
  const length = Math.max(1, Math.round(audio.pcm.length / ratio));
  const out = new Int16Array(length);
  const last = audio.pcm.length - 1;

  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, last);
    const weight = position - left;
    const a = audio.pcm[left] ?? 0;
    const b = audio.pcm[right] ?? 0;
    out[i] = Math.round(a + (b - a) * weight);
  }
  return { pcm: out, sampleRate: target };
}

/**
 * PCM16 to the normalised float samples OMP's speech workers exchange.
 *
 * Divided by 32768 rather than 32767: the signed 16-bit range is asymmetric,
 * and scaling by the magnitude of the most negative value is what keeps -32768
 * at exactly -1.0 instead of just past it.
 */
export function pcmToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] ?? 0) / 32_768;
  return out;
}

/**
 * Inverse of `pcmToFloat32`, clamping rather than wrapping.
 *
 * Scaled by the same 32768, so the pair round-trips every Int16 value exactly.
 * Scaling back by 32767 instead would land full scale a fraction short and
 * make a round trip lossy at the one amplitude most likely to be tested.
 *
 * Clamped because a vocoder overshoots past full scale on transients. Wrapping
 * turns that into a click at maximum amplitude, far more audible than the
 * clipping it came from.
 */
export function float32ToPcm(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const scaled = Math.round((samples[i] ?? 0) * 32_768);
    out[i] = scaled > 32_767 ? 32_767 : scaled < -32_768 ? -32_768 : scaled;
  }
  return out;
}

/**
 * Resample normalised float samples, for the ASR path.
 *
 * Separate from `resamplePcm` rather than a conversion around it: quantising to
 * PCM16 in the middle of a float pipeline is a rounding loss taken for nothing,
 * and the interpolation is the only part worth sharing.
 */
export function resampleFloat32(samples: Float32Array, from: number, to: number): Float32Array {
  if (from < 1 || to < 1) throw new WavFormatError(`unsupported resample ${from} to ${to}`);
  if (from === to || samples.length === 0) return samples;

  const ratio = from / to;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  const last = samples.length - 1;

  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, last);
    const weight = position - left;
    const a = samples[left] ?? 0;
    const b = samples[right] ?? 0;
    out[i] = a + (b - a) * weight;
  }
  return out;
}
