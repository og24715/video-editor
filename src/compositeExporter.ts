import { EncodedPacket, EncodedPacketSink } from "mediabunny";
import type { TrimRange } from "./model";

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

export function clampRange(trim: TrimRange, durationSec: number): TrimRange {
  const start = Math.max(0, Math.min(trim.startSec, Math.max(0, durationSec - 0.1)));
  const end = Math.max(start + 0.1, Math.min(trim.endSec, durationSec > 0 ? durationSec : trim.endSec));
  return { startSec: start, endSec: end };
}
