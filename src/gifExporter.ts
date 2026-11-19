import { EncodedPacketSink } from "mediabunny";
import type { Input } from "mediabunny";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { CropRect, TrimRange } from "./model";
import { ExportCancelledError } from "./exporter";

export interface GifExportOptions {
  input: Input;
  crop: CropRect;
  trim: TrimRange;
  width: number;
  fps: number;
  onProgress: (ratio: number) => void;
  isCancelled: () => boolean;
}

export interface GifExportResult {
  blob: Blob;
  width: number;
  height: number;
  frameCount: number;
}

export function gifOutputSize(
  cropWidth: number,
  cropHeight: number,
  chosenWidth: number,
): { width: number; height: number } {
  const width = chosenWidth > 0 ? Math.min(chosenWidth, cropWidth) : cropWidth;
  let height = Math.max(2, Math.round((cropHeight * width) / cropWidth));
  height -= height % 2;
  return { width, height: Math.max(2, height) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function exportGif(options: GifExportOptions): Promise<GifExportResult> {
  const { input, crop } = options;
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("No video track was found in this file.");
  const durationSec = await input.computeDuration();
  const trimStart = Math.max(0, Math.min(options.trim.startSec, Math.max(0, durationSec - 0.1)));
  const trimEnd = Math.max(
    trimStart + 0.1,
    Math.min(options.trim.endSec, durationSec > 0 ? durationSec : options.trim.endSec),
  );
  const rangeSec = trimEnd - trimStart;
  const startUs = Math.round(trimStart * 1_000_000);
  const endUs = Math.round(trimEnd * 1_000_000);
  const fps = Math.max(1, Math.min(60, Math.round(options.fps)));
  const intervalUs = Math.round(1_000_000 / fps);
  const delayMs = 1000 / fps;
  const size = gifOutputSize(crop.width, crop.height, options.width);

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

  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create a 2D canvas context.");

  const gif = GIFEncoder();
  let frameCount = 0;
  let failure: Error | null = null;
  const noteFailure = (err: unknown) => {
    if (!failure) failure = err instanceof Error ? err : new Error(String(err));
  };

  let nextEmitUs = startUs;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (options.isCancelled() || failure) {
          return;
        }
        if (frame.timestamp < startUs || frame.timestamp >= endUs) {
          return;
        }
        if (frame.timestamp < nextEmitUs) {
          return;
        }
        ctx.drawImage(frame, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
        const imageData = ctx.getImageData(0, 0, size.width, size.height);
        const palette = quantize(imageData.data, 256, { format: "rgb565" });
        const index = applyPalette(imageData.data, palette, "rgb565");
        gif.writeFrame(index, size.width, size.height, { palette, delay: delayMs, repeat: 0 });
        frameCount += 1;
        const rebased = frame.timestamp - startUs;
        do {
          nextEmitUs += intervalUs;
        } while (nextEmitUs <= frame.timestamp);
        if (rangeSec > 0) {
          options.onProgress(Math.max(0, Math.min(1, rebased / 1_000_000 / rangeSec)));
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
    const startPacket = trimStart > 0 ? await sink.getKeyPacket(trimStart).catch(() => null) : null;
    const feedMarginSec = 2;
    for await (const packet of startPacket ? sink.packets(startPacket) : sink.packets()) {
      if (options.isCancelled() || failure) break;
      if (packet.timestamp >= trimEnd + feedMarginSec) break;
      decoder.decode(packet.toEncodedVideoChunk());
      while (decoder.decodeQueueSize > 8 && !options.isCancelled() && !failure) {
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
    throw new ExportCancelledError();
  }

  if (!failure) {
    await decoder.flush().catch((err) => {
      if (!options.isCancelled()) noteFailure(err);
    });
  }

  if (options.isCancelled()) {
    try {
      decoder.close();
    } catch {
    }
    throw new ExportCancelledError();
  }

  if (failure) {
    throw failure;
  }
  if (frameCount === 0) {
    throw new Error("No frames were found in the selected range.");
  }

  gif.finish();
  const bytes = gif.bytes();
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  options.onProgress(1);
  return {
    blob: new Blob([copy.buffer], { type: "image/gif" }),
    width: size.width,
    height: size.height,
    frameCount,
  };
}
