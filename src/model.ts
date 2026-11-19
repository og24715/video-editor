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

function clampOutputSize(value: number): number {
  if (!Number.isFinite(value)) return 16;
  const clamped = Math.max(16, Math.min(7680, Math.round(value)));
  return clamped - (clamped % 2);
}

function fitTileToCanvas(scaled: TileRect, aspect: number, outputWidth: number, outputHeight: number): TileRect {
  let width = Math.max(16, Math.round(scaled.width));
  let height = Math.max(16, Math.round(width / aspect));
  if (width > outputWidth) {
    width = outputWidth;
    height = Math.max(16, Math.round(width / aspect));
  }
  if (height > outputHeight) {
    height = outputHeight;
    width = Math.max(16, Math.round(height * aspect));
    if (width > outputWidth) width = outputWidth;
  }
  const centerX = scaled.x + scaled.width / 2;
  const centerY = scaled.y + scaled.height / 2;
  const x = Math.round(Math.max(0, Math.min(centerX - width / 2, Math.max(0, outputWidth - width))));
  const y = Math.round(Math.max(0, Math.min(centerY - height / 2, Math.max(0, outputHeight - height))));
  return { x, y, width, height };
}

export function resizedLayout(
  geometry: LayoutGeometry,
  newWidth: number,
  newHeight: number,
  mainAspect: number,
  secondAspect: number,
): LayoutGeometry {
  const outputWidth = clampOutputSize(newWidth);
  const outputHeight = clampOutputSize(newHeight);
  const scaleX = outputWidth / geometry.outputWidth;
  const scaleY = outputHeight / geometry.outputHeight;
  const scaleTile = (tile: TileRect): TileRect => ({
    x: tile.x * scaleX,
    y: tile.y * scaleY,
    width: tile.width * scaleX,
    height: tile.height * scaleY,
  });
  return {
    outputWidth,
    outputHeight,
    tileA: fitTileToCanvas(scaleTile(geometry.tileA), mainAspect > 0 ? mainAspect : 16 / 9, outputWidth, outputHeight),
    tileB: fitTileToCanvas(scaleTile(geometry.tileB), secondAspect > 0 ? secondAspect : 16 / 9, outputWidth, outputHeight),
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
