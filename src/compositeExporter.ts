import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import type { Input, InputVideoTrack } from "mediabunny";
import type { CropRect, TileRect, TrimRange } from "./model";
import { ExportCancelledError, chooseCodec } from "./exporter";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FramePump {
  current: VideoFrame | null = null;
  private queue: VideoFrame[] = [];
  private iterator: AsyncIterableIterator<EncodedPacket> | null = null;
  private exhausted = false;
  private failure: Error | null = null;
  private feedEndSec: number;
  private decoder: VideoDecoder;
  private sink: EncodedPacketSink;
  private trimStartSec: number;
  private shouldStop: () => boolean;
  private noteFailure: (err: unknown) => void;

  constructor(
    sink: EncodedPacketSink,
    decoderConfig: VideoDecoderConfig,
    trimStartSec: number,
    trimEndSec: number,
    shouldStop: () => boolean,
    noteFailure: (err: unknown) => void,
  ) {
    this.sink = sink;
    this.trimStartSec = trimStartSec;
    this.shouldStop = shouldStop;
    this.noteFailure = noteFailure;
    this.feedEndSec = trimEndSec + 2;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push(frame);
      },
      error: (err) => {
        this.failure = err instanceof Error ? err : new Error(String(err));
        this.noteFailure(err);
      },
    });
    this.decoder.configure(decoderConfig);
  }

  async init(): Promise<void> {
    const startPacket = this.trimStartSec > 0 ? await this.sink.getKeyPacket(this.trimStartSec).catch(() => null) : null;
    this.iterator = (startPacket ? this.sink.packets(startPacket) : this.sink.packets())[Symbol.asyncIterator]();
  }

  private async feedStep(): Promise<void> {
    while (this.queue.length === 0 && !this.exhausted && !this.shouldStop() && !this.failure) {
      if (!this.iterator) {
        this.exhausted = true;
        break;
      }
      const next = await this.iterator.next();
      if (next.done) {
        await this.decoder.flush().catch(() => undefined);
        this.exhausted = true;
        break;
      }
      const packet = next.value;
      if (packet.timestamp >= this.feedEndSec) {
        await this.decoder.flush().catch(() => undefined);
        this.exhausted = true;
        break;
      }
      this.decoder.decode(packet.toEncodedVideoChunk());
      let spins = 0;
      while (this.queue.length === 0 && this.decoder.decodeQueueSize > 0 && spins < 400 && !this.shouldStop()) {
        await sleep(5);
        spins += 1;
      }
    }
  }

  async advanceTo(sourceTimeSec: number): Promise<void> {
    const epsilon = 0.0005;
    for (;;) {
      const head = this.queue[0];
      if (head && head.timestamp / 1_000_000 <= sourceTimeSec + epsilon) {
        this.queue.shift();
        if (this.current) this.current.close();
        this.current = head;
        continue;
      }
      if (head) return;
      if (this.exhausted || this.shouldStop() || this.failure) return;
      await this.feedStep();
      if (this.queue.length === 0 && (this.exhausted || this.failure)) return;
    }
  }

  close(): void {
    if (this.current) {
      this.current.close();
      this.current = null;
    }
    for (const frame of this.queue) frame.close();
    this.queue = [];
    try {
      this.decoder.close();
    } catch {
    }
  }
}

export interface CompositeTileSpec {
  input: Input;
  trim: TrimRange;
  crop: CropRect;
  rect: TileRect;
  offsetSec: number;
}

export interface CompositeAudioSpec {
  input: Input;
  trim: TrimRange;
  offsetSec: number;
}

export interface CompositeExportOptions {
  tiles: CompositeTileSpec[];
  outputWidth: number;
  outputHeight: number;
  audio: CompositeAudioSpec | null;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface CompositeExportResult {
  blob: Blob;
  codecLabel: string;
  audioCopied: boolean;
  outputDurationSec: number;
}

export function clampRange(trim: TrimRange, durationSec: number): TrimRange {
  const start = Math.max(0, Math.min(trim.startSec, Math.max(0, durationSec - 0.1)));
  const end = Math.max(start + 0.1, Math.min(trim.endSec, durationSec > 0 ? durationSec : trim.endSec));
  return { startSec: start, endSec: end };
}

export async function exportComposite(options: CompositeExportOptions): Promise<CompositeExportResult> {
  if (options.tiles.length === 0) throw new Error("No tiles to export.");

  const tracks: InputVideoTrack[] = [];
  for (const tile of options.tiles) {
    const track = await tile.input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track was found in one of the tile files.");
    tracks.push(track);
  }

  const trims: TrimRange[] = [];
  const ranges: number[] = [];
  let outputDuration = 0;
  for (let i = 0; i < options.tiles.length; i++) {
    const duration = await options.tiles[i].input.computeDuration();
    const trim = clampRange(options.tiles[i].trim, duration);
    trims.push(trim);
    const range = trim.endSec - trim.startSec;
    ranges.push(range);
    outputDuration = Math.max(outputDuration, options.tiles[i].offsetSec + range);
  }
  if (!(outputDuration > 0)) throw new Error("Nothing to export: all tile ranges are empty.");

  const outWidth = Math.max(2, Math.round(options.outputWidth) - (Math.round(options.outputWidth) % 2));
  const outHeight = Math.max(2, Math.round(options.outputHeight) - (Math.round(options.outputHeight) % 2));
  const rects = options.tiles.map((tile) => ({
    x: Math.round(tile.rect.x),
    y: Math.round(tile.rect.y),
    width: Math.max(2, Math.round(tile.rect.width)),
    height: Math.max(2, Math.round(tile.rect.height)),
  }));

  const stats = await tracks[0].computePacketStats(50).catch(() => null);
  const framerate = stats && stats.averagePacketRate > 0 ? Math.max(1, Math.min(120, Math.round(stats.averagePacketRate))) : 30;
  const frameDurUs = Math.round(1_000_000 / framerate);
  const totalFrames = Math.max(1, Math.ceil(outputDuration * framerate - 1e-6));
  const bitrate = Math.max(1_000_000, Math.min(25_000_000, Math.round(outWidth * outHeight * framerate * 0.15)));
  const choice = await chooseCodec(outWidth, outHeight, framerate, bitrate);

  const configs: VideoDecoderConfig[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const config = await tracks[i].getDecoderConfig();
    if (!config) throw new Error("Could not read a tile video decoder configuration.");
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) {
      throw new Error(`This browser cannot decode an input codec (${config.codec}).`);
    }
    configs.push(config);
  }

  const audioTrack = options.audio ? await options.audio.input.getPrimaryAudioTrack() : null;
  const audioTrim = options.audio ? clampRange(options.audio.trim, await options.audio.input.computeDuration()) : null;
  const audioShift = options.audio ? options.audio.offsetSec : 0;

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new EncodedVideoPacketSource(choice.mediabunnyCodec);
  output.addVideoTrack(videoSource);
  let audioSource: EncodedAudioPacketSource | null = null;
  if (audioTrack && audioTrack.codec) {
    audioSource = new EncodedAudioPacketSource(audioTrack.codec);
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
    if (!audioTrack || !audioSource || !options.audio || !audioTrim) return;
    try {
      const sink = new EncodedPacketSink(audioTrack);
      const config = await audioTrack.getDecoderConfig().catch(() => null);
      let first = true;
      for await (const packet of sink.packets()) {
        if (shouldStop()) break;
        if (packet.timestamp >= audioTrim.endSec) break;
        if (packet.timestamp < audioTrim.startSec) continue;
        const outTimestamp = packet.timestamp - audioTrim.startSec + audioShift;
        if (outTimestamp < 0) continue;
        const outPacket = packet.clone({ timestamp: outTimestamp });
        if (first && config) {
          await audioSource.add(outPacket, { decoderConfig: config });
          first = false;
        } else {
          await audioSource.add(outPacket);
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

  const pumps = options.tiles.map(
    (_tile, i) =>
      new FramePump(new EncodedPacketSink(tracks[i]), configs[i], trims[i].startSec, trims[i].endSec, shouldStop, noteFailure),
  );
  for (const pump of pumps) await pump.init();

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (shouldStop()) break;
      const t = i / framerate;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, outWidth, outHeight);
      for (let k = 0; k < options.tiles.length; k++) {
        const tile = options.tiles[k];
        const local = t - tile.offsetSec;
        if (local < -0.0005) continue;
        const sourceTime = trims[k].startSec + Math.min(Math.max(0, local), ranges[k]);
        await pumps[k].advanceTo(sourceTime);
        if (shouldStop()) break;
        const frame = pumps[k].current;
        if (frame) {
          const crop = tile.crop;
          ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, rects[k].x, rects[k].y, rects[k].width, rects[k].height);
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

  for (const pump of pumps) pump.close();

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
