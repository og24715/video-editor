import type { Input } from "mediabunny";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MediaMeta {
  width: number;
  height: number;
  durationSec: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

export interface Clip {
  id: string;
  file: File;
  url: string;
  input: Input;
  meta: MediaMeta;
  crop: CropRect;
}

export type AspectPreset = "free" | "16:9" | "9:16" | "1:1" | "4:3";

export function evenRect(crop: CropRect, maxWidth: number, maxHeight: number): CropRect {
  const x = Math.max(0, Math.min(Math.round(crop.x), maxWidth - 2));
  const y = Math.max(0, Math.min(Math.round(crop.y), maxHeight - 2));
  let width = Math.max(2, Math.min(Math.round(crop.width), maxWidth - x));
  let height = Math.max(2, Math.min(Math.round(crop.height), maxHeight - y));
  width -= width % 2;
  height -= height % 2;
  return { x, y, width, height };
}
