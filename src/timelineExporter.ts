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
import type { CropRect, MediaKind, TileRect, TrimRange } from "./model";
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
}

export interface TimelineExportOptions {
  base: TimelineBaseItemSpec[];
  overlays: TimelineOverlayItemSpec[];
  outputWidth: number;
  outputHeight: number;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface TimelineExportResult {
  blob: Blob;
  codecLabel: string;
  audioCopied: boolean;
  outputDurationSec: number;
}

interface ResolvedItem {
  kind: MediaKind;
  input: Input | null;
  track: InputVideoTrack | null;
  bitmap: ImageBitmap | null;
  trim: TrimRange;
  crop: CropRect;
  startSec: number;
  durationSec: number;
  rect: TileRect;
  isBase: boolean;
}

export async function exportTimeline(options: TimelineExportOptions): Promise<TimelineExportResult> {
  if (options.base.length === 0 && options.overlays.length === 0) throw new Error("No timeline items to export.");

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
        track: null,
        bitmap,
        trim: { startSec: 0, endSec: durationSec },
        crop: spec.crop,
        startSec,
        durationSec,
        rect: resolvedRect,
        isBase,
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
    const resolved: ResolvedItem = {
      kind: "video",
      input: spec.input,
      track,
      bitmap: null,
      trim,
      crop: spec.crop,
      startSec,
      durationSec,
      rect: resolvedRect,
      isBase,
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

  interface AudioPlanItem {
    item: ResolvedItem;
    track: NonNullable<Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>>;
  }
  const audioPlan: AudioPlanItem[] = [];
  let audioCodec: AudioCodec | null = null;
  for (const item of items) {
    if (!item.isBase || !item.input) continue;
    const audioTrack = await item.input.getPrimaryAudioTrack();
    if (!audioTrack || !audioTrack.codec) continue;
    if (audioCodec === null) audioCodec = audioTrack.codec;
    if (audioTrack.codec === audioCodec) audioPlan.push({ item, track: audioTrack });
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
  const audioTask = (async () => {
    if (!audioSource || audioPlan.length === 0) return;
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
  return { blob: new Blob([buffer], { type: "video/mp4" }), codecLabel: choice.label, audioCopied, outputDurationSec: outputDuration };
}
