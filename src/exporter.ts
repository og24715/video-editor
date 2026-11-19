import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import type { VideoCodec } from "mediabunny";
import type { CropRect, MediaMeta } from "./model";

export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelledError";
  }
}

export function webCodecsSupported(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined";
}

export async function openInput(file: File): Promise<Input> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    input.dispose();
    throw new Error("No video track was found in this file.");
  }
  return input;
}

export async function readMeta(input: Input): Promise<MediaMeta> {
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track was found in this file.");
  const audioTrack = await input.getPrimaryAudioTrack();
  const durationSec = await input.computeDuration();
  const videoParam = await videoTrack.getCodecParameterString().catch(() => null);
  const audioParam = audioTrack ? await audioTrack.getCodecParameterString().catch(() => null) : null;
  return {
    width: videoTrack.codedWidth,
    height: videoTrack.codedHeight,
    durationSec,
    videoCodec: videoParam ?? videoTrack.codec,
    audioCodec: audioTrack ? (audioParam ?? audioTrack.codec) : null,
    hasAudio: Boolean(audioTrack),
  };
}

interface CodecChoice {
  config: VideoEncoderConfig;
  mediabunnyCodec: VideoCodec;
  label: string;
}

async function chooseCodec(width: number, height: number, framerate: number, bitrate: number): Promise<CodecChoice> {
  const candidates: { encoderCodec: string; mediabunnyCodec: VideoCodec; label: string }[] = [
    { encoderCodec: "avc1.640034", mediabunnyCodec: "avc", label: "H.264 (AVC)" },
    { encoderCodec: "avc1.640028", mediabunnyCodec: "avc", label: "H.264 (AVC)" },
    { encoderCodec: "avc1.42001f", mediabunnyCodec: "avc", label: "H.264 (AVC)" },
    { encoderCodec: "vp09.00.31.08", mediabunnyCodec: "vp9", label: "VP9" },
    { encoderCodec: "av01.0.08M.08", mediabunnyCodec: "av1", label: "AV1" },
  ];
  for (const candidate of candidates) {
    for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"] as const) {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.encoderCodec,
        width,
        height,
        framerate,
        bitrate,
        hardwareAcceleration,
      }).catch(() => null);
      if (support && support.supported && support.config) {
        return { config: support.config, mediabunnyCodec: candidate.mediabunnyCodec, label: candidate.label };
      }
    }
  }
  throw new Error("This browser has no supported encoder for the cropped size. Try a smaller crop or a different browser.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExportOptions {
  input: Input;
  crop: CropRect;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface ExportResult {
  blob: Blob;
  codecLabel: string;
  audioCopied: boolean;
}

export async function exportCropped(options: ExportOptions): Promise<ExportResult> {
  const { input, crop } = options;
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track was found in this file.");
  const audioTrack = await input.getPrimaryAudioTrack();
  const durationSec = await input.computeDuration();
  const stats = await videoTrack.computePacketStats(50).catch(() => null);
  const framerate = stats && stats.averagePacketRate > 0 ? Math.max(1, Math.min(120, Math.round(stats.averagePacketRate))) : 30;
  const bitrate = Math.max(1_000_000, Math.min(25_000_000, Math.round(crop.width * crop.height * framerate * 0.15)));
  const choice = await chooseCodec(crop.width, crop.height, framerate, bitrate);

  const decoderConfig = await videoTrack.getDecoderConfig();
  if (!decoderConfig) {
    throw new Error("Could not read the video decoder configuration. The input codec may not be supported.");
  }
  const decoderSupport = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => null);
  if (!decoderSupport || !decoderSupport.supported) {
    throw new Error(
      `This browser cannot decode the input codec (${decoderConfig.codec}). Try Chrome or Edge with an H.264, VP9 or AV1 file.`,
    );
  }

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const videoSource = new EncodedVideoPacketSource(choice.mediabunnyCodec);
  output.addVideoTrack(videoSource, { rotation: videoTrack.rotation });
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

  let audioCopied = false;
  const audioTask = (async () => {
    if (!audioTrack || !audioSource) return;
    try {
      const sink = new EncodedPacketSink(audioTrack);
      const config = await audioTrack.getDecoderConfig().catch(() => null);
      let first = true;
      for await (const packet of sink.packets()) {
        if (options.isCancelled() || failure) break;
        if (first && config) {
          await audioSource.add(packet, { decoderConfig: config });
          first = false;
        } else {
          await audioSource.add(packet);
        }
      }
      if (!options.isCancelled() && !failure) audioCopied = true;
    } catch (err) {
      noteFailure(err);
    }
  })();

  const canvas = new OffscreenCanvas(crop.width, crop.height);
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

  let lastKeyFrameAt = -10_000_000;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (options.isCancelled() || failure) {
          frame.close();
          return;
        }
        ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
        const cropped = new VideoFrame(canvas, {
          timestamp: frame.timestamp,
          ...(frame.duration != null ? { duration: frame.duration } : {}),
        });
        const keyFrame = frame.timestamp - lastKeyFrameAt >= 2_000_000;
        if (keyFrame) lastKeyFrameAt = frame.timestamp;
        encoder.encode(cropped, { keyFrame });
        cropped.close();
        if (durationSec > 0) {
          options.onProgress(Math.min(1, frame.timestamp / 1_000_000 / durationSec));
        }
      } catch (err) {
        noteFailure(err);
      } finally {
        frame.close();
      }
    },
    error: (err) => noteFailure(err),
  });
  decoder.configure(decoderConfig);

  const sink = new EncodedPacketSink(videoTrack);
  try {
    for await (const packet of sink.packets()) {
      if (options.isCancelled() || failure) break;
      decoder.decode(packet.toEncodedVideoChunk());
      while ((decoder.decodeQueueSize > 8 || encoder.encodeQueueSize > 8) && !options.isCancelled() && !failure) {
        await sleep(10);
      }
    }
  } catch (err) {
    noteFailure(err);
  }

  if (options.isCancelled()) {
    try {
      decoder.close();
    } catch {
    }
    try {
      encoder.close();
    } catch {
    }
    await audioTask.catch(() => undefined);
    await output.cancel().catch(() => undefined);
    throw new ExportCancelledError();
  }

  if (!failure) {
    await decoder.flush().catch((err) => {
      if (!options.isCancelled()) noteFailure(err);
    });
    if (encoder.state === "configured") {
      await encoder.flush().catch(noteFailure);
    }
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
  return { blob: new Blob([buffer], { type: "video/mp4" }), codecLabel: choice.label, audioCopied };
}
