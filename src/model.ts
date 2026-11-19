import type { Input } from "mediabunny";

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrimRange {
  startSec: number;
  endSec: number;
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
  trim: TrimRange;
}

export type AspectPreset = "free" | "16:9" | "9:16" | "1:1" | "4:3";

export type ToolId = "crop" | "trim" | "layout";

export type ActiveTool = "none" | ToolId;

export function evenRect(crop: CropRect, maxWidth: number, maxHeight: number): CropRect {
  const x = Math.max(0, Math.min(Math.round(crop.x), maxWidth - 2));
  const y = Math.max(0, Math.min(Math.round(crop.y), maxHeight - 2));
  let width = Math.max(2, Math.min(Math.round(crop.width), maxWidth - x));
  let height = Math.max(2, Math.min(Math.round(crop.height), maxHeight - y));
  width -= width % 2;
  height -= height % 2;
  return { x, y, width, height };
}

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AudioSourceChoice = "main" | "second" | "none";

export interface LayoutGeometry {
  outputWidth: number;
  outputHeight: number;
  tileA: TileRect;
  tileB: TileRect;
}

export interface LayoutState extends LayoutGeometry {
  offsetSec: number;
  audioSource: AudioSourceChoice;
}

function evenDown(value: number, min = 2): number {
  const rounded = Math.floor(value);
  const even = rounded - (rounded % 2);
  return Math.max(min, even);
}

export function sideBySideLayout(
  mainWidth: number,
  mainHeight: number,
  secondWidth: number,
  secondHeight: number,
): LayoutGeometry {
  const height = evenDown(Math.min(mainHeight, secondHeight));
  const tileA: TileRect = {
    x: 0,
    y: 0,
    width: evenDown((mainWidth * height) / mainHeight),
    height,
  };
  const tileB: TileRect = {
    x: tileA.width,
    y: 0,
    width: evenDown((secondWidth * height) / secondHeight),
    height,
  };
  return {
    outputWidth: tileA.width + tileB.width,
    outputHeight: height,
    tileA,
    tileB,
  };
}

export function pipLayout(mainWidth: number, mainHeight: number, secondWidth: number, secondHeight: number): LayoutGeometry {
  const outputWidth = evenDown(mainWidth);
  const outputHeight = evenDown(mainHeight);
  let tileBWidth = evenDown(outputWidth * 0.3);
  let tileBHeight = evenDown((tileBWidth * secondHeight) / secondWidth);
  if (tileBHeight > outputHeight - 32) {
    tileBHeight = evenDown(outputHeight - 32);
    tileBWidth = evenDown((tileBHeight * secondWidth) / secondHeight);
  }
  const tileB: TileRect = {
    x: Math.max(0, outputWidth - tileBWidth - 16),
    y: Math.max(0, outputHeight - tileBHeight - 16),
    width: tileBWidth,
    height: tileBHeight,
  };
  return {
    outputWidth,
    outputHeight,
    tileA: { x: 0, y: 0, width: outputWidth, height: outputHeight },
    tileB,
  };
}
