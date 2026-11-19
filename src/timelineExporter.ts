import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import type { AudioCodec, Input, InputVideoTrack } from "mediabunny";
import type { CropRect, MediaKind, TextStyle, TileRect, TrimRange } from "./model";
import { containRect } from "./model";
import { ExportCancelledError, chooseCodec } from "./exporter";
import { FramePump, clampRange } from "./compositeExporter";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TimelineBaseItemSpec {
  kind: MediaKind;
  input: Input | null;
  file: File | null;
  trim: TrimRange;
  crop: CropRect;
  durationSec?: number;
}

export interface TimelineOverlayItemSpec {
  kind: MediaKind;
  input: Input | null;
  file: File | null;
  trim: TrimRange;
  crop: CropRect;
  durationSec?: number;
  startSec: number;
  rect: TileRect;
  gain?: number;
  hasAudio?: boolean;
}

export interface TimelineTextItemSpec {
  text: string;
  startSec: number;
  durationSec: number;
  style: TextStyle;
}

export interface TimelineAudioClipSpec {
  file: File;
  buffer: AudioBuffer | null;
  trim: TrimRange;
  startSec: number;
  gain: number;
}

export interface TimelineExportOptions {
  base: TimelineBaseItemSpec[];
  overlays: TimelineOverlayItemSpec[];
  texts: TimelineTextItemSpec[];
  audioClips: TimelineAudioClipSpec[];
  baseAudioGain: number;
  outputWidth: number;
  outputHeight: number;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface TimelineExportResult {
  blob: Blob;
  codecLabel: string;
  audioCopied: boolean;
  audioMixed: boolean;
  audioCodecLabel: string | null;
  audioMixParts: string | null;
  outputDurationSec: number;
}

interface ResolvedItem {
  kind: MediaKind | "text";
  input: Input | null;
  file: File | null;
  track: InputVideoTrack | null;
  bitmap: ImageBitmap | null;
  trim: TrimRange;
  crop: CropRect;
  startSec: number;
  durationSec: number;
  rect: TileRect;
  isBase: boolean;
  gain: number;
  hasAudio: boolean;
  text?: string;
  style?: TextStyle;
}

function drawTextItem(
  ctx: OffscreenCanvasRenderingContext2D,
  text: string,
  style: TextStyle,
  outWidth: number,
  outHeight: number,
): void {
  const fontPx = Math.max(4, (style.fontSizePct / 100) * outHeight);
  const lines = text.split("\n");
  const lineHeight = fontPx * 1.25;
  const blockHeight = lineHeight * lines.length;
  const margin = outHeight * 0.05;
  let blockTop: number;
  if (style.position === "top") blockTop = margin;
  else if (style.position === "center") blockTop = (outHeight - blockHeight) / 2;
  else blockTop = outHeight - margin - blockHeight;
  ctx.font = `700 ${fontPx}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < lines.length; i++) {
    const baseline = blockTop + fontPx + i * lineHeight;
    if (style.outline) {
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = Math.max(1, fontPx / 10);
      ctx.lineJoin = "round";
      ctx.strokeText(lines[i], outWidth / 2, baseline);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(lines[i], outWidth / 2, baseline);
  }
}

const MIX_SAMPLE_RATE = 48000;
const MIX_BITRATE = 160000;

interface MixPlacement {
  buffer: AudioBuffer;
  whenSec: number;
  offsetSec: number;
  durationSec: number;
  gain: number;
}

async function decodeAudioFile(
  file: File,
  cache: Map<File, AudioBuffer | null>,
): Promise<AudioBuffer | null> {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let decoded: AudioBuffer | null = null;
  try {
    const context = new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE);
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    decoded = null;
  }
  cache.set(file, decoded);
  return decoded;
}

interface MixedAudioResult {
  buffer: AudioBuffer;
  parts: string[];
}

async function buildMixedAudio(
  baseItems: ResolvedItem[],
  overlayItems: ResolvedItem[],
  audioClips: TimelineAudioClipSpec[],
  baseAudioGain: number,
  totalDurationSec: number,
): Promise<MixedAudioResult> {
  const cache = new Map<File, AudioBuffer | null>();
  const placements: MixPlacement[] = [];
  let usedBase = false;
  let usedOverlay = false;
  let usedAudioClips = false;
  for (const item of baseItems) {
    if (item.kind !== "video" || !item.file) continue;
    const buffer = await decodeAudioFile(item.file, cache);
    if (!buffer) continue;
    const offsetSec = Math.max(0, Math.min(item.trim.startSec, buffer.duration));
    const durationSec = Math.min(item.durationSec, Math.max(0, buffer.duration - offsetSec));
    if (durationSec <= 0) continue;
    placements.push({
      buffer,
      whenSec: item.startSec,
      offsetSec,
      durationSec,
      gain: Math.max(0, Math.min(2, baseAudioGain)),
    });
    usedBase = true;
  }
  for (const item of overlayItems) {
    if (item.kind !== "video" || !item.file || !item.hasAudio) continue;
    const gain = Math.max(0, Math.min(2, item.gain));
    if (gain <= 0) continue;
    const buffer = await decodeAudioFile(item.file, cache);
    if (!buffer) continue;
    const offsetSec = Math.max(0, Math.min(item.trim.startSec, buffer.duration));
    const durationSec = Math.min(item.durationSec, Math.max(0, buffer.duration - offsetSec));
    if (durationSec <= 0) continue;
    placements.push({
      buffer,
      whenSec: Math.max(0, item.startSec),
      offsetSec,
      durationSec,
      gain,
    });
    usedOverlay = true;
  }
  for (const spec of audioClips) {
    const buffer = spec.buffer ?? (await decodeAudioFile(spec.file, cache));
    if (!buffer) continue;
    const offsetSec = Math.max(0, Math.min(spec.trim.startSec, buffer.duration));
    const durationSec = Math.min(
      Math.max(0, spec.trim.endSec - spec.trim.startSec),
      Math.max(0, buffer.duration - offsetSec),
    );
    if (durationSec <= 0) continue;
    placements.push({
      buffer,
      whenSec: Math.max(0, spec.startSec),
      offsetSec,
      durationSec,
      gain: Math.max(0, Math.min(2, spec.gain)),
    });
    usedAudioClips = true;
  }
  const frameCount = Math.max(1, Math.ceil(totalDurationSec * MIX_SAMPLE_RATE));
  const offline = new OfflineAudioContext(2, frameCount, MIX_SAMPLE_RATE);
  const compressor = offline.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  compressor.connect(offline.destination);
  for (const placement of placements) {
    if (placement.whenSec >= totalDurationSec) continue;
    const source = offline.createBufferSource();
    source.buffer = placement.buffer;
    const gainNode = offline.createGain();
    gainNode.gain.value = placement.gain;
    source.connect(gainNode);
    gainNode.connect(compressor);
    const durationSec = Math.min(placement.durationSec, totalDurationSec - placement.whenSec);
    if (durationSec > 0) source.start(placement.whenSec, placement.offsetSec, durationSec);
  }
  const buffer = await offline.startRendering();
  const parts: string[] = [];
  if (usedBase) parts.push("base track");
  if (usedOverlay) parts.push("overlay clips");
  if (usedAudioClips) parts.push("audio clips");
  return { buffer, parts };
}

interface MixedAudioEncoding {
  config: AudioEncoderConfig;
  mediabunnyCodec: AudioCodec;
  label: string;
}

async function chooseMixedAudioEncoding(): Promise<MixedAudioEncoding> {
  if (typeof AudioEncoder === "undefined") {
    throw new Error("This browser cannot encode audio for the mixed export.");
  }
  const candidates: MixedAudioEncoding[] = [
    {
      config: { codec: "mp4a.40.2", sampleRate: MIX_SAMPLE_RATE, numberOfChannels: 2, bitrate: MIX_BITRATE },
      mediabunnyCodec: "aac",
      label: "AAC",
    },
    {
      config: { codec: "opus", sampleRate: MIX_SAMPLE_RATE, numberOfChannels: 2, bitrate: MIX_BITRATE },
      mediabunnyCodec: "opus",
      label: "Opus",
    },
    {
      config: { codec: "flac", sampleRate: MIX_SAMPLE_RATE, numberOfChannels: 2 },
      mediabunnyCodec: "flac",
      label: "FLAC",
    },
  ];
  for (const candidate of candidates) {
    const support = await AudioEncoder.isConfigSupported(candidate.config).catch(() => null);
    if (support && support.supported && support.config) {
      return { ...candidate, config: support.config };
    }
  }
  throw new Error("This browser does not support AAC, Opus, or FLAC audio encoding for the mixed export.");
}

async function encodeMixedAudio(
  buffer: AudioBuffer,
  audioSource: EncodedAudioPacketSource,
  encoding: MixedAudioEncoding,
  shouldStop: () => boolean,
  noteFailure: (err: unknown) => void,
): Promise<void> {
  let muxChain: Promise<void> = Promise.resolve();
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      muxChain = muxChain
        .then(() => audioSource.add(EncodedPacket.fromEncodedChunk(chunk), meta))
        .catch(noteFailure);
    },
    error: (err) => noteFailure(err),
  });
  encoder.configure(encoding.config);
  const chunkFrames = 4096;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  try {
    for (let frame = 0; frame < buffer.length; frame += chunkFrames) {
      if (shouldStop()) break;
      const frames = Math.min(chunkFrames, buffer.length - frame);
      const data = new ArrayBuffer(frames * 4 * 2);
      const view = new DataView(data);
      for (let i = 0; i < frames; i++) {
        view.setFloat32(i * 4, left[frame + i], true);
        view.setFloat32((frames + i) * 4, right[frame + i], true);
      }
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: MIX_SAMPLE_RATE,
        numberOfFrames: frames,
        numberOfChannels: 2,
        timestamp: Math.round((frame / MIX_SAMPLE_RATE) * 1_000_000),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
      while (encoder.encodeQueueSize > 8 && !shouldStop()) await sleep(5);
    }
    if (!shouldStop() && encoder.state === "configured") await encoder.flush();
  } catch (err) {
    noteFailure(err);
  } finally {
    try {
      encoder.close();
    } catch {
    }
  }
  await muxChain;
}

export async function exportTimeline(options: TimelineExportOptions): Promise<TimelineExportResult> {
  if (
    options.base.length === 0 &&
    options.overlays.length === 0 &&
    options.texts.length === 0 &&
    options.audioClips.length === 0
  )
    throw new Error("No timeline items to export.");

  const outWidth = Math.max(2, Math.round(options.outputWidth) - (Math.round(options.outputWidth) % 2));
  const outHeight = Math.max(2, Math.round(options.outputHeight) - (Math.round(options.outputHeight) % 2));

  const items: ResolvedItem[] = [];
  let baseCursor = 0;
  let outputDuration = 0;
  const resolveItem = async (
    spec: TimelineBaseItemSpec | TimelineOverlayItemSpec,
    startSec: number,
    rect: TileRect | null,
    isBase: boolean,
  ): Promise<ResolvedItem> => {
    const resolvedRect = rect ?? containRect(spec.crop.width, spec.crop.height, outWidth, outHeight);
    if (spec.kind === "image") {
      if (!spec.file) throw new Error("An image timeline item is missing its file.");
      const bitmap = await createImageBitmap(spec.file);
      const durationSec = Math.max(0.1, spec.durationSec ?? 0);
      const resolved: ResolvedItem = {
        kind: "image",
        input: null,
        file: spec.file,
        track: null,
        bitmap,
        trim: { startSec: 0, endSec: durationSec },
        crop: spec.crop,
        startSec,
        durationSec,
        rect: resolvedRect,
        isBase,
        gain: 1,
        hasAudio: false,
      };
      outputDuration = Math.max(outputDuration, startSec + durationSec);
      return resolved;
    }
    if (!spec.input) throw new Error("A video timeline item is missing its input.");
    const track = await spec.input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track was found in one of the timeline files.");
    const duration = await spec.input.computeDuration();
    const trim = clampRange(spec.trim, duration);
    const durationSec = trim.endSec - trim.startSec;
    const overlaySpec = isBase ? null : (spec as TimelineOverlayItemSpec);
    const resolved: ResolvedItem = {
      kind: "video",
      input: spec.input,
      file: spec.file,
      track,
      bitmap: null,
      trim,
      crop: spec.crop,
      startSec,
      durationSec,
      rect: resolvedRect,
      isBase,
      gain: overlaySpec ? (overlaySpec.gain ?? 1) : 1,
      hasAudio: overlaySpec ? (overlaySpec.hasAudio ?? false) : false,
    };
    outputDuration = Math.max(outputDuration, startSec + durationSec);
    return resolved;
  };
  for (const spec of options.base) {
    const item = await resolveItem(spec, baseCursor, null, true);
    baseCursor += item.durationSec;
    items.push(item);
  }
  for (const spec of options.overlays) {
    const rect: TileRect = {
      x: Math.round(spec.rect.x),
      y: Math.round(spec.rect.y),
      width: Math.max(2, Math.round(spec.rect.width)),
      height: Math.max(2, Math.round(spec.rect.height)),
    };
    items.push(await resolveItem(spec, Math.max(0, spec.startSec), rect, false));
  }
  for (const spec of options.texts) {
    const startSec = Math.max(0, spec.startSec);
    const durationSec = Math.max(0.1, spec.durationSec);
    items.push({
      kind: "text",
      input: null,
      file: null,
      track: null,
      bitmap: null,
      trim: { startSec: 0, endSec: durationSec },
      crop: { x: 0, y: 0, width: 0, height: 0 },
      startSec,
      durationSec,
      rect: { x: 0, y: 0, width: outWidth, height: outHeight },
      isBase: false,
      gain: 1,
      hasAudio: false,
      text: spec.text,
      style: spec.style,
    });
    outputDuration = Math.max(outputDuration, startSec + durationSec);
  }
  for (const spec of options.audioClips) {
    const durationSec = Math.max(0, spec.trim.endSec - spec.trim.startSec);
    outputDuration = Math.max(outputDuration, Math.max(0, spec.startSec) + durationSec);
  }
  if (!(outputDuration > 0)) throw new Error("Nothing to export: all timeline ranges are empty.");

  const clockItem = items.find((item) => item.isBase && item.track) ?? items.find((item) => item.track) ?? null;
  const stats = clockItem && clockItem.track ? await clockItem.track.computePacketStats(50).catch(() => null) : null;
  const framerate = stats && stats.averagePacketRate > 0 ? Math.max(1, Math.min(120, Math.round(stats.averagePacketRate))) : 30;
  const frameDurUs = Math.round(1_000_000 / framerate);
  const totalFrames = Math.max(1, Math.ceil(outputDuration * framerate - 1e-6));
  const bitrate = Math.max(1_000_000, Math.min(25_000_000, Math.round(outWidth * outHeight * framerate * 0.15)));
  const choice = await chooseCodec(outWidth, outHeight, framerate, bitrate);

  const configs: (VideoDecoderConfig | null)[] = [];
  for (const item of items) {
    if (!item.track) {
      configs.push(null);
      continue;
    }
    const config = await item.track.getDecoderConfig();
    if (!config) throw new Error("Could not read a timeline video decoder configuration.");
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) {
      throw new Error(`This browser cannot decode an input codec (${config.codec}).`);
    }
    configs.push(config);
  }

  const mixAudio =
    options.audioClips.length > 0 ||
    options.overlays.some((o) => o.kind === "video" && (o.hasAudio ?? false) && (o.gain ?? 1) > 0);
  const mixed = mixAudio
    ? await buildMixedAudio(
        items.filter((item) => item.isBase),
        items.filter((item) => !item.isBase),
        options.audioClips,
        options.baseAudioGain,
        outputDuration,
      )
    : null;
  const mixedBuffer = mixed ? mixed.buffer : null;
  const mixedEncoding = mixAudio ? await chooseMixedAudioEncoding() : null;

  interface AudioPlanItem {
    item: ResolvedItem;
    track: NonNullable<Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>>;
  }
  const audioPlan: AudioPlanItem[] = [];
  let audioCodec: AudioCodec | null = mixedEncoding ? mixedEncoding.mediabunnyCodec : null;
  if (!mixAudio) {
    for (const item of items) {
      if (!item.isBase || !item.input) continue;
      const audioTrack = await item.input.getPrimaryAudioTrack();
      if (!audioTrack || !audioTrack.codec) continue;
      if (audioCodec === null) audioCodec = audioTrack.codec;
      if (audioTrack.codec === audioCodec) audioPlan.push({ item, track: audioTrack });
    }
  }

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new EncodedVideoPacketSource(choice.mediabunnyCodec);
  output.addVideoTrack(videoSource);
  let audioSource: EncodedAudioPacketSource | null = null;
  if (audioCodec) {
    audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addAudioTrack(audioSource);
  }
  await output.start();

  let failure: Error | null = null;
  const noteFailure = (err: unknown) => {
    if (!failure) failure = err instanceof Error ? err : new Error(String(err));
  };
  const shouldStop = () => options.isCancelled() || failure !== null;

  let audioCopied = false;
  let audioMixed = false;
  const audioTask = (async () => {
    if (!audioSource) return;
    if (mixAudio) {
      if (!mixedBuffer || !mixedEncoding) return;
      try {
        await encodeMixedAudio(mixedBuffer, audioSource, mixedEncoding, shouldStop, noteFailure);
        if (!shouldStop()) audioMixed = true;
      } catch (err) {
        noteFailure(err);
      }
      return;
    }
    if (audioPlan.length === 0) return;
    try {
      let first = true;
      for (const plan of audioPlan) {
        if (shouldStop()) break;
        const sink = new EncodedPacketSink(plan.track);
        const config = first ? await plan.track.getDecoderConfig().catch(() => null) : null;
        for await (const packet of sink.packets()) {
          if (shouldStop()) break;
          if (packet.timestamp >= plan.item.trim.endSec) break;
          if (packet.timestamp < plan.item.trim.startSec) continue;
          const outTimestamp = packet.timestamp - plan.item.trim.startSec + plan.item.startSec;
          if (outTimestamp < 0) continue;
          const outPacket = packet.clone({ timestamp: outTimestamp });
          if (first && config) {
            await audioSource.add(outPacket, { decoderConfig: config });
          } else {
            await audioSource.add(outPacket);
          }
          first = false;
        }
      }
      if (!shouldStop() && !first) audioCopied = true;
    } catch (err) {
      noteFailure(err);
    }
  })();

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D canvas context.");

  let muxChain: Promise<void> = Promise.resolve();
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxChain = muxChain.then(() => videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta)).catch(noteFailure);
    },
    error: (err) => noteFailure(err),
  });
  encoder.configure(choice.config);

  const pumps = items.map((item, i) => {
    const config = configs[i];
    if (!item.track || !config) return null;
    return new FramePump(new EncodedPacketSink(item.track), config, item.trim.startSec, item.trim.endSec, shouldStop, noteFailure);
  });
  for (const pump of pumps) if (pump) await pump.init();

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (shouldStop()) break;
      const t = i / framerate;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, outWidth, outHeight);
      for (let k = 0; k < items.length; k++) {
        const item = items[k];
        const local = t - item.startSec;
        if (local < -0.0005 || local >= item.durationSec) continue;
        if (item.kind === "text") {
          if (item.text && item.style) drawTextItem(ctx, item.text, item.style, outWidth, outHeight);
          continue;
        }
        const crop = item.crop;
        if (item.bitmap) {
          ctx.drawImage(item.bitmap, crop.x, crop.y, crop.width, crop.height, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
          continue;
        }
        const pump = pumps[k];
        if (!pump) continue;
        const sourceTime = item.trim.startSec + Math.max(0, local);
        await pump.advanceTo(sourceTime);
        if (shouldStop()) break;
        const frame = pump.current;
        if (frame) {
          ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
        }
      }
      if (shouldStop()) break;
      const outFrame = new VideoFrame(canvas, { timestamp: i * frameDurUs, duration: frameDurUs });
      encoder.encode(outFrame, { keyFrame: i % (framerate * 2) === 0 });
      outFrame.close();
      while (encoder.encodeQueueSize > 8 && !shouldStop()) {
        await sleep(5);
      }
      options.onProgress(Math.min(1, (i + 1) / totalFrames));
    }
  } catch (err) {
    noteFailure(err);
  }

  for (const pump of pumps) if (pump) pump.close();
  for (const item of items) if (item.bitmap) item.bitmap.close();

  if (options.isCancelled()) {
    try {
      encoder.close();
    } catch {
    }
    await audioTask.catch(() => undefined);
    await output.cancel().catch(() => undefined);
    throw new ExportCancelledError();
  }

  if (!failure && encoder.state === "configured") {
    await encoder.flush().catch(noteFailure);
  }
  await muxChain;
  await audioTask;

  if (failure) {
    await output.cancel().catch(() => undefined);
    throw failure;
  }

  videoSource.close();
  if (audioSource) audioSource.close();
  await output.finalize();
  const buffer = target.buffer;
  if (!buffer) throw new Error("Export finished without producing data.");
  options.onProgress(1);
  return {
    blob: new Blob([buffer], { type: "video/mp4" }),
    codecLabel: choice.label,
    audioCopied,
    audioMixed,
    audioCodecLabel: mixedEncoding ? mixedEncoding.label : null,
    audioMixParts: mixed && mixed.parts.length > 0 ? mixed.parts.join(" + ") : null,
    outputDurationSec: outputDuration,
  };
}
