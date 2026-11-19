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

export type MediaKind = "video" | "image";

export interface Clip {
  id: string;
  kind: MediaKind;
  file: File;
  url: string;
  input: Input | null;
  meta: MediaMeta;
  crop: CropRect;
  trim: TrimRange;
}

export const DEFAULT_IMAGE_DURATION_SEC = 5;

export type TextPosition = "bottom" | "center" | "top";

export interface TextStyle {
  fontSizePct: number;
  color: string;
  outline: boolean;
  position: TextPosition;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSizePct: 6,
  color: "#ffffff",
  outline: true,
  position: "bottom",
};

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

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutTile {
  id: string;
  clipId: string;
  rect: TileRect;
  offsetSec: number;
}

export interface TimelineItem {
  id: string;
  clipId: string;
  kind: "media" | "text";
  startSec: number;
  rect: TileRect | null;
  trim: TrimRange;
  crop: CropRect;
  durationSec: number | null;
  text?: string;
  textStyle?: TextStyle;
}

export function timelineItemDurationSec(item: TimelineItem, clip: Clip | null): number {
  if (item.kind === "text") return Math.max(0, item.durationSec ?? DEFAULT_IMAGE_DURATION_SEC);
  if (!clip) return 0;
  if (clip.kind === "image") return Math.max(0, item.durationSec ?? DEFAULT_IMAGE_DURATION_SEC);
  return Math.max(0, item.trim.endSec - item.trim.startSec);
}

export interface TimelineTrack {
  id: string;
  items: TimelineItem[];
}

export interface TimelineState {
  outputWidth: number;
  outputHeight: number;
  tracks: TimelineTrack[];
}

function evenDown(value: number, min = 2): number {
  const rounded = Math.floor(value);
  const even = rounded - (rounded % 2);
  return Math.max(min, even);
}

export function pipItemRect(outputWidth: number, outputHeight: number, aspect: number): TileRect {
  const safeAspect = aspect > 0 ? aspect : 16 / 9;
  let width = evenDown(outputWidth * 0.3);
  let height = Math.round(width / safeAspect);
  if (height > outputHeight - 32) {
    height = Math.max(16, outputHeight - 32);
    width = Math.round(height * safeAspect);
  }
  if (width > outputWidth) {
    width = outputWidth;
    height = Math.round(width / safeAspect);
  }
  const x = Math.max(0, outputWidth - width - 16);
  const y = Math.max(0, outputHeight - height - 16);
  return { x, y, width, height };
}

export function refitRectToAspect(rect: TileRect, aspect: number, outputWidth: number, outputHeight: number): TileRect {
  const safeAspect = aspect > 0 ? aspect : 16 / 9;
  let width = rect.width;
  let height = width / safeAspect;
  if (height > outputHeight) {
    height = outputHeight;
    width = height * safeAspect;
  }
  if (width > outputWidth) {
    width = outputWidth;
    height = width / safeAspect;
  }
  const x = Math.max(0, Math.min(rect.x, Math.max(0, outputWidth - width)));
  const y = Math.max(0, Math.min(rect.y, Math.max(0, outputHeight - height)));
  return { x, y, width, height };
}

export function containRect(sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number): TileRect {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    return { x: 0, y: 0, width: outputWidth, height: outputHeight };
  }
  const scale = Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  return { x: Math.round((outputWidth - width) / 2), y: Math.round((outputHeight - height) / 2), width, height };
}

export function clampOutputSize(value: number): number {
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

export function resizedTiles(
  tiles: LayoutTile[],
  aspects: number[],
  newWidth: number,
  newHeight: number,
  oldWidth: number,
  oldHeight: number,
): { outputWidth: number; outputHeight: number; tiles: LayoutTile[] } {
  const outputWidth = clampOutputSize(newWidth);
  const outputHeight = clampOutputSize(newHeight);
  const scaleX = oldWidth > 0 ? outputWidth / oldWidth : 1;
  const scaleY = oldHeight > 0 ? outputHeight / oldHeight : 1;
  const nextTiles = tiles.map((tile, i) => {
    const scaled: TileRect = {
      x: tile.rect.x * scaleX,
      y: tile.rect.y * scaleY,
      width: tile.rect.width * scaleX,
      height: tile.rect.height * scaleY,
    };
    const aspect = aspects[i] && aspects[i] > 0 ? aspects[i] : 16 / 9;
    return { ...tile, rect: fitTileToCanvas(scaled, aspect, outputWidth, outputHeight) };
  });
  return { outputWidth, outputHeight, tiles: nextTiles };
}
