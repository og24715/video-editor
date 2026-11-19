import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import type { Input } from "mediabunny";
import type { CropRect, LayoutState, TrimRange } from "./model";
import { ExportCancelledError, chooseCodec } from "./exporter";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SourceSpec {
  input: Input;
  trim: TrimRange;
}

class FramePump {
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

export interface CompositeExportOptions {
  main: SourceSpec & { crop: CropRect };
  second: SourceSpec;
  layout: LayoutState;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface CompositeExportResult {
  blob: Blob;
  codecLabel: string;
  audioCopied: boolean;
  outputDurationSec: number;
}

export async function exportComposite(options: CompositeExportOptions): Promise<CompositeExportResult> {
  const { layout } = options;
  const mainTrack = await options.main.input.getPrimaryVideoTrack();
  if (!mainTrack) throw new Error("No video track was found in the main file.");
  const secondTrack = await options.second.input.getPrimaryVideoTrack();
  if (!secondTrack) throw new Error("No video track was found in the second file.");

  const mainDuration = await options.main.input.computeDuration();
  const secondDuration = await options.second.input.computeDuration();

  const clampRange = (trim: TrimRange, durationSec: number): TrimRange => {
    const start = Math.max(0, Math.min(trim.startSec, Math.max(0, durationSec - 0.1)));
    const end = Math.max(start + 0.1, Math.min(trim.endSec, durationSec > 0 ? durationSec : trim.endSec));
    return { startSec: start, endSec: end };
  };
  const mainTrim = clampRange(options.main.trim, mainDuration);
  const secondTrim = clampRange(options.second.trim, secondDuration);
  const mainRange = mainTrim.endSec - mainTrim.startSec;
  const secondRange = secondTrim.endSec - secondTrim.startSec;
  const offset = Math.max(-10, Math.min(10, layout.offsetSec));
  const outputDuration = Math.max(mainRange, offset + secondRange);
  if (!(outputDuration > 0)) throw new Error("Nothing to export: both ranges are empty.");

  const outWidth = Math.max(2, Math.round(layout.outputWidth) - (Math.round(layout.outputWidth) % 2));
  const outHeight = Math.max(2, Math.round(layout.outputHeight) - (Math.round(layout.outputHeight) % 2));
  const tileA = {
    x: Math.round(layout.tileA.x),
    y: Math.round(layout.tileA.y),
    width: Math.max(2, Math.round(layout.tileA.width)),
    height: Math.max(2, Math.round(layout.tileA.height)),
  };
  const tileB = {
    x: Math.round(layout.tileB.x),
    y: Math.round(layout.tileB.y),
    width: Math.max(2, Math.round(layout.tileB.width)),
    height: Math.max(2, Math.round(layout.tileB.height)),
  };
  const crop = options.main.crop;

  const stats = await mainTrack.computePacketStats(50).catch(() => null);
  const framerate = stats && stats.averagePacketRate > 0 ? Math.max(1, Math.min(120, Math.round(stats.averagePacketRate))) : 30;
  const frameDurUs = Math.round(1_000_000 / framerate);
  const totalFrames = Math.max(1, Math.ceil(outputDuration * framerate - 1e-6));
  const bitrate = Math.max(1_000_000, Math.min(25_000_000, Math.round(outWidth * outHeight * framerate * 0.15)));
  const choice = await chooseCodec(outWidth, outHeight, framerate, bitrate);

  const mainConfig = await mainTrack.getDecoderConfig();
  if (!mainConfig) throw new Error("Could not read the main video decoder configuration.");
  const secondConfig = await secondTrack.getDecoderConfig();
  if (!secondConfig) throw new Error("Could not read the second video decoder configuration.");
  for (const [config, which] of [
    [mainConfig, "main"],
    [secondConfig, "second"],
  ] as const) {
    const support = await VideoDecoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) {
      throw new Error(`This browser cannot decode the ${which} input codec (${config.codec}).`);
    }
  }

  let audioInput: Input | null = null;
  let audioTrim = mainTrim;
  let audioShift = 0;
  if (layout.audioSource === "main") {
    audioInput = options.main.input;
    audioTrim = mainTrim;
    audioShift = 0;
  } else if (layout.audioSource === "second") {
    audioInput = options.second.input;
    audioTrim = secondTrim;
    audioShift = offset;
  }
  const audioTrack = audioInput ? await audioInput.getPrimaryAudioTrack() : null;

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
    if (!audioTrack || !audioSource || !audioInput) return;
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

  const pumpA = new FramePump(new EncodedPacketSink(mainTrack), mainConfig, mainTrim.startSec, mainTrim.endSec, shouldStop, noteFailure);
  const pumpB = new FramePump(new EncodedPacketSink(secondTrack), secondConfig, secondTrim.startSec, secondTrim.endSec, shouldStop, noteFailure);
  await pumpA.init();
  await pumpB.init();

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (shouldStop()) break;
      const t = i / framerate;
      await pumpA.advanceTo(mainTrim.startSec + t);
      const secondLocal = t - offset;
      const secondActive = secondLocal >= -0.0005 && secondLocal <= secondRange + 0.0005;
      if (secondActive) {
        await pumpB.advanceTo(secondTrim.startSec + Math.max(0, secondLocal));
      }
      if (shouldStop()) break;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, outWidth, outHeight);
      if (pumpA.current) {
        ctx.drawImage(pumpA.current, crop.x, crop.y, crop.width, crop.height, tileA.x, tileA.y, tileA.width, tileA.height);
      }
      if (secondActive && pumpB.current) {
        ctx.drawImage(pumpB.current, tileB.x, tileB.y, tileB.width, tileB.height);
      }
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

  pumpA.close();
  pumpB.close();

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
