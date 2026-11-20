import { useCallback, useEffect, useRef, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { ttsTheme } from "./themes/tts/tts";
import { Heading } from "@astryxdesign/core/Heading";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Slider } from "@astryxdesign/core/Slider";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { FolderOpen, Type } from "lucide-react";
import type { AspectPreset, ChromaKeySettings, Clip, CropRect, LayoutTile, MediaMeta, TextPosition, TextStyle, TileRect, TimelineItem, TimelineState, TimelineTrack, TrimRange } from "./model";
import { DEFAULT_CHROMA_KEY, DEFAULT_IMAGE_DURATION_SEC, DEFAULT_TEXT_STYLE, WAVEFORM_PEAKS_PER_SEC, clampFadePair, clampOutputSize, clipFadeFactor, computeWaveformPeaks, containRect, evenRect, pipItemRect, refitRectToAspect, resizedTiles, timelineItemDurationSec } from "./model";
import { ChromaKeyer } from "./chromaKey";
import { ExportCancelledError, exportCropped, openInput, readMeta, webCodecsSupported } from "./exporter";
import { exportTimeline } from "./timelineExporter";
import { exportGif, gifOutputSize } from "./gifExporter";

const ASPECTS: { value: AspectPreset; label: string; ratio: number | null }[] = [
  { value: "free", label: "Free", ratio: null },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
];

type ExportFormat = "mp4" | "gif";

const GIF_WIDTHS: { value: string; label: string }[] = [
  { value: "240", label: "240" },
  { value: "360", label: "360" },
  { value: "480", label: "480" },
  { value: "original", label: "Original" },
];

const GIF_FPS_OPTIONS: { value: string; label: string }[] = [
  { value: "10", label: "10" },
  { value: "15", label: "15" },
  { value: "20", label: "20" },
  { value: "30", label: "30" },
];

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

const HANDLE_POS: Record<Handle, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  n: { left: "50%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  e: { left: "100%", top: "50%" },
  se: { left: "100%", top: "100%" },
  s: { left: "50%", top: "100%" },
  sw: { left: "0%", top: "100%" },
  w: { left: "0%", top: "50%" },
};

interface DragState {
  mode: "move" | Handle;
  startClientX: number;
  startClientY: number;
  startCrop: CropRect;
}

const POOL_DRAG_TYPE = "application/x-video-editor-clip";

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    name: string;
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

function clampCrop(next: CropRect, maxWidth: number, maxHeight: number, ratio: number | null): CropRect {
  const min = 16;
  let { x, y, width, height } = next;
  width = Math.max(min, Math.min(width, maxWidth));
  height = Math.max(min, Math.min(height, maxHeight));
  if (ratio) {
    height = width / ratio;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * ratio;
    }
    if (height < min) {
      height = min;
      width = height * ratio;
    }
  }
  x = Math.max(0, Math.min(x, maxWidth - width));
  y = Math.max(0, Math.min(y, maxHeight - height));
  return { x, y, width, height };
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function clampTrim(next: TrimRange, durationSec: number): TrimRange {
  const max = Math.max(0.1, durationSec);
  let start = Math.round(Math.max(0, Math.min(next.startSec, max - 0.1)) * 1000) / 1000;
  let end = Math.round(Math.max(start + 0.1, Math.min(next.endSec, max)) * 1000) / 1000;
  if (end - start < 0.1) {
    end = Math.round(Math.min(max, start + 0.1) * 1000) / 1000;
    if (end - start < 0.1) start = Math.round(Math.max(0, end - 0.1) * 1000) / 1000;
  }
  return { startSec: start, endSec: end };
}

function fmtSec(sec: number): string {
  return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, "0")}`;
}

function SeekBar(props: {
  value: number;
  total: number;
  onSeek: (sec: number) => void;
  isDisabled?: boolean;
}) {
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  const total = Math.max(0, props.total);
  const shown = scrubSec ?? Math.max(0, Math.min(total, props.value));
  return (
    <div className="seekbar">
      <Slider
        data-testid="composite-seek"
        label="Seek"
        isLabelHidden
        valueDisplay="none"
        min={0}
        max={total}
        step={0.1}
        value={shown}
        isDisabled={props.isDisabled || total <= 0}
        onChange={(value: number) => {
          setScrubSec(value);
          props.onSeek(value);
        }}
        onChangeEnd={(value: number) => {
          props.onSeek(value);
          setScrubSec(null);
        }}
      />
      <Text type="supporting">
        {fmtClock(shown)} / {fmtClock(total)}
      </Text>
    </div>
  );
}

function subRectVideoStyle(meta: MediaMeta, rawCrop: CropRect): React.CSSProperties {
  const crop = evenRect(rawCrop, meta.width, meta.height);
  if (!(meta.width > 0) || !(meta.height > 0) || !(crop.width > 0) || !(crop.height > 0)) {
    return { left: "0%", top: "0%", width: "100%", height: "100%" };
  }
  return {
    width: `${(meta.width / crop.width) * 100}%`,
    height: `${(meta.height / crop.height) * 100}%`,
    left: `${(-crop.x / crop.width) * 100}%`,
    top: `${(-crop.y / crop.height) * 100}%`,
    maxWidth: "none",
    maxHeight: "none",
  };
}

function baseVideoBoxStyle(meta: MediaMeta, rawCrop: CropRect, outputWidth: number, outputHeight: number): React.CSSProperties {
  if (!(outputWidth > 0) || !(outputHeight > 0)) return { inset: 0 };
  const crop = evenRect(rawCrop, meta.width, meta.height);
  const fit = containRect(crop.width, crop.height, outputWidth, outputHeight);
  return {
    left: `${(fit.x / outputWidth) * 100}%`,
    top: `${(fit.y / outputHeight) * 100}%`,
    width: `${(fit.width / outputWidth) * 100}%`,
    height: `${(fit.height / outputHeight) * 100}%`,
  };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

let clipIdCounter = 0;
function nextClipId(): string {
  clipIdCounter += 1;
  return `clip-${Date.now()}-${clipIdCounter}`;
}

let tlIdCounter = 0;
function nextTlId(prefix: string): string {
  tlIdCounter += 1;
  return `${prefix}-${Date.now()}-${tlIdCounter}`;
}

const TL_ITEM_DRAG_TYPE = "application/x-video-editor-tl-item";

interface TlItemLayout {
  item: TimelineItem;
  clip: Clip | null;
  startSec: number;
  durationSec: number;
}

interface TlTrackLayout {
  track: TimelineTrack;
  items: TlItemLayout[];
}

function layoutTimeline(
  tl: TimelineState,
  clips: Clip[],
): { tracks: TlTrackLayout[]; totalSec: number; baseEndSec: number } {
  let totalSec = 0;
  let baseEndSec = 0;
  const tracks = tl.tracks.map((track, trackIndex) => {
    let cursor = 0;
    const items: TlItemLayout[] = [];
    for (const item of track.items) {
      if (item.kind === "text") {
        const durationSec = timelineItemDurationSec(item, null);
        const startSec = trackIndex === 0 ? cursor : Math.max(0, item.startSec);
        cursor += durationSec;
        const endSec = startSec + durationSec;
        if (trackIndex === 0) baseEndSec = Math.max(baseEndSec, endSec);
        totalSec = Math.max(totalSec, endSec);
        items.push({ item, clip: null, startSec, durationSec });
        continue;
      }
      const itemClip = clips.find((c) => c.id === item.clipId);
      if (!itemClip) continue;
      const durationSec = timelineItemDurationSec(item, itemClip);
      const startSec = trackIndex === 0 ? cursor : Math.max(0, item.startSec);
      cursor += durationSec;
      const endSec = startSec + durationSec;
      if (trackIndex === 0) baseEndSec = Math.max(baseEndSec, endSec);
      totalSec = Math.max(totalSec, endSec);
      items.push({ item, clip: itemClip, startSec, durationSec });
    }
    return { track, items };
  });
  return { tracks, totalSec, baseEndSec };
}

function layoutAudioTimeline(
  tl: TimelineState,
  clips: Clip[],
): { tracks: TlTrackLayout[]; totalSec: number } {
  let totalSec = 0;
  const tracks = tl.audioTracks.map((track) => {
    const items: TlItemLayout[] = [];
    for (const item of track.items) {
      const itemClip = clips.find((c) => c.id === item.clipId);
      if (!itemClip || itemClip.kind !== "audio") continue;
      const durationSec = timelineItemDurationSec(item, itemClip);
      const startSec = Math.max(0, item.startSec);
      totalSec = Math.max(totalSec, startSec + durationSec);
      items.push({ item, clip: itemClip, startSec, durationSec });
    }
    return { track, items };
  });
  return { tracks, totalSec };
}

function WaveformCanvas(props: {
  peaks: Float32Array | null;
  durationSec: number;
  trim: TrimRange;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { peaks, durationSec, trim } = props;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(10, 18, 16, 0.88)";
    ctx.fillRect(0, 0, width, height);
    const mid = height / 2;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();
    if (!peaks || peaks.length < 2 || durationSec <= 0) return;
    const startBucket = Math.max(0, Math.floor(trim.startSec * WAVEFORM_PEAKS_PER_SEC));
    const endBucket = Math.min(
      peaks.length / 2,
      Math.max(startBucket + 1, Math.ceil(trim.endSec * WAVEFORM_PEAKS_PER_SEC)),
    );
    ctx.strokeStyle = "#5eead4";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const bucket = startBucket + Math.floor((x / Math.max(1, width)) * (endBucket - startBucket));
      const min = peaks[bucket * 2] ?? 0;
      const max = peaks[bucket * 2 + 1] ?? 0;
      const y1 = mid - Math.max(0, max) * (height * 0.46);
      const y2 = mid - Math.min(0, min) * (height * 0.46);
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, Math.max(y1 + 1, y2));
    }
    ctx.stroke();
  }, [peaks, durationSec, trim.startSec, trim.endSec]);
  return <canvas ref={canvasRef} className={props.className ?? "waveform-canvas"} aria-hidden="true" />;
}

function KeyedTileContent(props: {
  clip: Clip;
  item: TimelineItem;
  registerVideo: (el: HTMLVideoElement | null) => void;
}) {
  const { clip, item } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const keyerRef = useRef<ChromaKeyer | null>(null);
  const settings: ChromaKeySettings = item.chromaKey ?? DEFAULT_CHROMA_KEY;
  const crop = item.crop;
  useEffect(() => {
    let raf = 0;
    let lastStamp = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!canvasRef.current) return;
      if (!keyerRef.current) keyerRef.current = new ChromaKeyer(canvasRef.current);
      const keyer = keyerRef.current;
      if (!keyer.ok) return;
      const settingsStamp = `${settings.color}|${settings.tolerance}|${settings.softness}`;
      const cropStamp = `${crop.x},${crop.y},${crop.width},${crop.height}`;
      if (clip.kind === "video") {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || video.videoWidth === 0) return;
        const stamp = `${video.currentTime.toFixed(3)}|${cropStamp}|${settingsStamp}`;
        if (stamp === lastStamp) return;
        lastStamp = stamp;
        keyer.render(video, video.videoWidth, video.videoHeight, crop, settings);
      } else {
        const img = imgRef.current;
        if (!img || !img.complete || img.naturalWidth === 0) return;
        const stamp = `img|${cropStamp}|${settingsStamp}`;
        if (stamp === lastStamp) return;
        lastStamp = stamp;
        keyer.render(img, img.naturalWidth, img.naturalHeight, crop, settings);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [clip, crop, settings]);
  return (
    <>
      {clip.kind === "video" ? (
        <video
          ref={(el) => {
            videoRef.current = el;
            props.registerVideo(el);
          }}
          src={clip.url}
          playsInline
          muted={!clip.meta.hasAudio || (item.gain ?? 1) <= 0}
          style={{ display: "none" }}
        />
      ) : (
        <img ref={imgRef} src={clip.url} alt="" draggable={false} style={{ display: "none" }} />
      )}
      <canvas ref={canvasRef} className="tl-keyed-canvas" />
    </>
  );
}

async function captureThumbs(
  url: string,
  metaWidth: number,
  metaHeight: number,
  startSec: number,
  endSec: number,
  count: number,
): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  const canvas = document.createElement("canvas");
  const thumbHeight = 48;
  const thumbWidth = Math.max(24, Math.round((thumbHeight * metaWidth) / Math.max(1, metaHeight)));
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const seekTo = (t: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        video.removeEventListener("seeked", done);
        resolve();
      };
      video.addEventListener("seeked", done);
      video.currentTime = t;
    });
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("thumbnail load failed")), { once: true });
    });
    const urls: string[] = [];
    const span = Math.max(0.05, endSec - startSec);
    for (let i = 0; i < count; i++) {
      const t = startSec + ((i + 0.5) / count) * span;
      await seekTo(t);
      ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);
      urls.push(canvas.toDataURL("image/jpeg", 0.7));
    }
    return urls;
  } catch {
    return [];
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [aspect, setAspect] = useState<AspectPreset>("free");
  const [dragging, setDragging] = useState(false);
  const [poolDragging, setPoolDragging] = useState(false);
  const [stageDragOver, setStageDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState("");
  const [resultSize, setResultSize] = useState(0);
  const [usedCodec, setUsedCodec] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("mp4");
  const [gifWidth, setGifWidth] = useState("480");
  const [gifFps, setGifFps] = useState("15");
  const [resultFormat, setResultFormat] = useState<ExportFormat>("mp4");
  const [audioCopied, setAudioCopied] = useState<boolean | null>(null);
  const [audioMixed, setAudioMixed] = useState(false);
  const [audioMixedCodec, setAudioMixedCodec] = useState<string | null>(null);
  const [audioMixParts, setAudioMixParts] = useState<string | null>(null);
  const [cropClipId, setCropClipId] = useState<string | null>(null);
  const [drawerItemId, setDrawerItemId] = useState<string | null>(null);
  const [drawerTextItemId, setDrawerTextItemId] = useState<string | null>(null);
  const [tlStageSize, setTlStageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [timeline, setTimeline] = useState<TimelineState>(() => ({
    outputWidth: 0,
    outputHeight: 0,
    tracks: [{ id: nextTlId("track"), kind: "video", items: [] }],
    audioTracks: [],
    baseAudioGain: 1,
  }));
  const [selectedTlItemId, setSelectedTlItemId] = useState<string | null>(null);
  const [tlGhostVisible, setTlGhostVisible] = useState(false);
  const [tlGhostHot, setTlGhostHot] = useState(false);
  const [tlDropTarget, setTlDropTarget] = useState<number | "ghost" | null>(null);
  const [tlAudioDropTarget, setTlAudioDropTarget] = useState<number | "ghost" | null>(null);
  const [tlPlaying, setTlPlaying] = useState(false);
  const [tlPlayheadSec, setTlPlayheadSec] = useState(0);
  const [tlThumbs, setTlThumbs] = useState<Record<string, string[]>>({});
  const [resultTimeline, setResultTimeline] = useState(false);
  const poolFileInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const drawerStageRef = useRef<HTMLDivElement | null>(null);
  const drawerVideoRef = useRef<HTMLVideoElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cancelRef = useRef(false);
  const tlStateRef = useRef<TimelineState | null>(null);
  const placeClipOnBaseRef = useRef<(target: Clip, index?: number) => void>(() => undefined);
  const tlPlayingRef = useRef(false);
  const tlGlobalRef = useRef(0);
  const tlVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const tlAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const tlStageRef = useRef<HTMLDivElement | null>(null);
  const tlTileDragRef = useRef<{
    itemId: string;
    trackIndex: number;
    mode: "move" | "resize";
    startClientX: number;
    startClientY: number;
    startRect: TileRect;
  } | null>(null);
  const tlBlockDragRef = useRef<{
    itemId: string;
    trackIndex: number;
    section: "video" | "audio";
    startClientX: number;
    startClientY: number;
    startSec: number;
    rowWidth: number;
    totalSec: number;
    activated: boolean;
    isText: boolean;
  } | null>(null);
  const tlEdgeDragRef = useRef<{
    itemId: string;
    trackIndex: number;
    section: "video" | "audio";
    edge: "start" | "end";
    startClientX: number;
    rowWidth: number;
    totalSec: number;
    origTrim: TrimRange;
    origStartSec: number;
    clipDurationSec: number;
    isDuration: boolean;
    origDurationSec: number;
  } | null>(null);
  const tlClockRef = useRef<number | null>(null);
  const tlThumbsPendingRef = useRef<Set<string>>(new Set());
  const supported = webCodecsSupported();

  const clip = clips.find((c) => c.id === activeClipId) ?? clips[0] ?? null;
  const cropClip = clips.find((c) => c.id === cropClipId) ?? null;
  const ratio = ASPECTS.find((a) => a.value === aspect)?.ratio ?? null;
  const tlHasItems =
    timeline.tracks.some((t) => t.items.length > 0) || timeline.audioTracks.some((t) => t.items.length > 0);
  const clipsRef = useRef<Clip[]>([]);
  clipsRef.current = clips;
  tlStateRef.current = timeline;

  const setCrop = useCallback((crop: CropRect) => {
    setClips((prev) => prev.map((c) => (c.id === cropClipId ? { ...c, crop } : c)));
  }, [cropClipId]);

  const drawerItemCrop: CropRect | null = (() => {
    if (!drawerItemId || !timeline) return null;
    for (const t of timeline.tracks) {
      const it = t.items.find((i) => i.id === drawerItemId);
      if (it) return it.crop;
    }
    return null;
  })();

  const applyDrawerCrop = (crop: CropRect) => {
    if (drawerItemId && drawerItemCrop) {
      let nextRect: TileRect | null = null;
      for (const t of timeline.tracks) {
        const it = t.items.find((i) => i.id === drawerItemId);
        if (!it) continue;
        if (it.rect) {
          const target = clips.find((c) => c.id === it.clipId);
          if (target) {
            const out = evenRect(crop, target.meta.width, target.meta.height);
            const aspect = out.height > 0 ? out.width / out.height : target.meta.width / target.meta.height;
            nextRect = refitRectToAspect(it.rect, aspect, timeline.outputWidth, timeline.outputHeight);
          }
        }
        break;
      }
      setTimeline((prev) =>
        prev
          ? {
              ...prev,
              tracks: prev.tracks.map((t) => ({
                ...t,
                items: t.items.map((it) =>
                  it.id === drawerItemId ? (nextRect ? { ...it, crop, rect: nextRect } : { ...it, crop }) : it,
                ),
              })),
            }
          : prev,
      );
      return;
    }
    setCrop(crop);
  };

  const itemCropAspect = useCallback((item: TimelineItem, target: Clip): number => {
    const out = evenRect(item.crop, target.meta.width, target.meta.height);
    return out.height > 0 ? out.width / out.height : target.meta.width / target.meta.height;
  }, []);

  const setClipTrim = useCallback((clipId: string, trim: TrimRange) => {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, trim } : c)));
  }, []);

  const createClip = useCallback(async (file: File): Promise<Clip> => {
    const isAudio =
      file.type.startsWith("audio/") || /\.(wav|mp3|m4a|aac|ogg|oga|flac|opus|weba)$/i.test(file.name);
    if (isAudio) {
      let audioBuffer: AudioBuffer;
      try {
        const context = new OfflineAudioContext(2, 1, 48000);
        audioBuffer = await context.decodeAudioData(await file.arrayBuffer());
      } catch {
        throw new Error(`"${file.name}" could not be decoded as audio.`);
      }
      const url = URL.createObjectURL(file);
      return {
        id: nextClipId(),
        kind: "audio",
        file,
        url,
        input: null,
        meta: {
          width: 0,
          height: 0,
          durationSec: audioBuffer.duration,
          videoCodec: null,
          audioCodec: file.type || file.name.split(".").pop()?.toLowerCase() || "audio",
          hasAudio: true,
        },
        crop: { x: 0, y: 0, width: 0, height: 0 },
        trim: { startSec: 0, endSec: audioBuffer.duration },
        audioBuffer,
        waveformPeaks: computeWaveformPeaks(audioBuffer),
      };
    }
    const isImage =
      /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name);
    if (isImage) {
      const bitmap = await createImageBitmap(file).catch(() => null);
      if (!bitmap) throw new Error(`"${file.name}" could not be read as an image.`);
      const width = bitmap.width;
      const height = bitmap.height;
      bitmap.close();
      const url = URL.createObjectURL(file);
      return {
        id: nextClipId(),
        kind: "image",
        file,
        url,
        input: null,
        meta: { width, height, durationSec: 0, videoCodec: null, audioCodec: null, hasAudio: false },
        crop: { x: 0, y: 0, width, height },
        trim: { startSec: 0, endSec: 0 },
        audioBuffer: null,
        waveformPeaks: null,
      };
    }
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      throw new Error(`"${file.name}" is not an MP4 video, a PNG/JPEG/WebP image, or a supported audio file.`);
    }
    const input = await openInput(file);
    const meta = await readMeta(input);
    const url = URL.createObjectURL(file);
    return {
      id: nextClipId(),
      kind: "video",
      file,
      url,
      input,
      meta,
      crop: { x: 0, y: 0, width: meta.width, height: meta.height },
      trim: { startSec: 0, endSec: meta.durationSec },
      audioBuffer: null,
      waveformPeaks: null,
    };
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError(null);
      setNotice(null);
      setLoading(true);
      try {
        const created: Clip[] = [];
        const failures: string[] = [];
        for (const file of files) {
          try {
            created.push(await createClip(file));
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err));
          }
        }
        if (created.length > 0) {
          setClips((prev) => [...prev, ...created]);
          setActiveClipId((prev) => prev ?? created[0].id);
          if (clipsRef.current.length === 0) {
            setAspect("free");
          }
          const firstVisual = created.find((c) => c.kind === "video" || c.kind === "image");
          if (firstVisual && (tlStateRef.current?.tracks[0]?.items.length ?? 0) === 0) {
            placeClipOnBaseRef.current(firstVisual);
          }
        }
        if (failures.length > 0) setError(failures.join(" "));
      } finally {
        setLoading(false);
      }
    },
    [createClip],
  );

  const removeClip = useCallback((clipId: string) => {
    const target = clipsRef.current.find((c) => c.id === clipId);
    if (target) {
      target.input?.dispose();
      URL.revokeObjectURL(target.url);
    }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setTimeline((prev) => {
      if (!prev) return prev;
      let changed = false;
      const tracks = prev.tracks.map((t) => {
        const items = t.items.filter((it) => it.clipId !== clipId);
        if (items.length !== t.items.length) changed = true;
        return { ...t, items };
      });
      const audioTracks = prev.audioTracks.map((t) => {
        const items = t.items.filter((it) => it.clipId !== clipId);
        if (items.length !== t.items.length) changed = true;
        return { ...t, items };
      });
      return changed ? { ...prev, tracks, audioTracks } : prev;
    });
    setActiveClipId((prev) => {
      if (prev !== clipId) return prev;
      const remaining = clipsRef.current.filter((c) => c.id !== clipId);
      return remaining[0]?.id ?? null;
    });
    setCropClipId((prev) => (prev === clipId ? null : prev));
  }, []);

  const tlEntries = useCallback((): {
    tracks: TlTrackLayout[];
    audioTracks: TlTrackLayout[];
    totalSec: number;
    baseEndSec: number;
  } | null => {
    const tl = tlStateRef.current;
    if (!tl) return null;
    const video = layoutTimeline(tl, clipsRef.current);
    const audio = layoutAudioTimeline(tl, clipsRef.current);
    return {
      tracks: video.tracks,
      audioTracks: audio.tracks,
      totalSec: Math.max(video.totalSec, audio.totalSec),
      baseEndSec: video.baseEndSec,
    };
  }, []);

  const syncTlVideos = useCallback(
    (globalSec: number, playing: boolean) => {
      const data = tlEntries();
      if (!data) return;
      for (const entry of data.tracks[0]?.items ?? []) {
        const el = tlVideoRefs.current.get(entry.item.id);
        if (!el) continue;
        const local = globalSec - entry.startSec;
        if (local < 0 || local > entry.durationSec) continue;
        el.volume = clipFadeFactor(entry.item.fadeInSec, entry.item.fadeOutSec, local, entry.durationSec);
      }
      data.tracks.forEach((trackLayout, trackIndex) => {
        if (trackIndex === 0) return;
        for (const entry of trackLayout.items) {
          const el = tlVideoRefs.current.get(entry.item.id);
          if (!el) continue;
          const overlayGain = entry.item.gain ?? 1;
          el.muted = !(entry.clip?.meta.hasAudio ?? false) || overlayGain <= 0;
          el.volume =
            Math.max(0, Math.min(1, overlayGain)) *
            clipFadeFactor(entry.item.fadeInSec, entry.item.fadeOutSec, globalSec - entry.startSec, entry.durationSec);
          const local = globalSec - entry.startSec;
          if (local < 0 || local > entry.durationSec) {
            if (!el.paused) el.pause();
            if (local < 0 && Math.abs(el.currentTime - entry.item.trim.startSec) > 0.05) {
              el.currentTime = entry.item.trim.startSec;
            }
            continue;
          }
          const target = entry.item.trim.startSec + local;
          if (playing) {
            if (el.paused) {
              void el.play().catch(() => undefined);
            } else if (Math.abs(el.currentTime - target) > 0.3) {
              el.currentTime = target;
            }
          } else if (Math.abs(el.currentTime - target) > 0.05) {
            el.currentTime = target;
          }
        }
      });
      for (const trackLayout of data.audioTracks) {
        for (const entry of trackLayout.items) {
          const el = tlAudioRefs.current.get(entry.item.id);
          if (!el) continue;
          el.volume =
            Math.max(0, Math.min(1, entry.item.gain ?? 1)) *
            clipFadeFactor(entry.item.fadeInSec, entry.item.fadeOutSec, globalSec - entry.startSec, entry.durationSec);
          const local = globalSec - entry.startSec;
          if (local < 0 || local > entry.durationSec) {
            if (!el.paused) el.pause();
            if (local < 0 && Math.abs(el.currentTime - entry.item.trim.startSec) > 0.05) {
              el.currentTime = entry.item.trim.startSec;
            }
            continue;
          }
          const target = entry.item.trim.startSec + local;
          if (playing) {
            if (el.paused) {
              if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
              void el.play().catch(() => undefined);
            } else if (Math.abs(el.currentTime - target) > 0.3) {
              el.currentTime = target;
            }
          } else if (Math.abs(el.currentTime - target) > 0.05) {
            el.currentTime = target;
          }
        }
      }
    },
    [tlEntries],
  );

  const stopTlClock = useCallback(() => {
    if (tlClockRef.current !== null) {
      window.clearInterval(tlClockRef.current);
      tlClockRef.current = null;
    }
  }, []);

  const startTlClock = useCallback(() => {
    stopTlClock();
    let last = performance.now();
    tlClockRef.current = window.setInterval(() => {
      const data = tlEntries();
      if (!data) {
        stopTlClock();
        return;
      }
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const baseEntry = data.tracks[0]?.items.find(
        (e) => tlGlobalRef.current >= e.startSec && tlGlobalRef.current < e.startSec + e.durationSec,
      );
      if (baseEntry && baseEntry.clip?.kind === "video") {
        const el = tlVideoRefs.current.get(baseEntry.item.id);
        if (el && !el.paused) return;
      }
      let global = tlGlobalRef.current + dt;
      if (global >= data.totalSec) {
        global = data.totalSec;
        tlGlobalRef.current = global;
        setTlPlayheadSec(global);
        syncTlVideos(global, false);
        for (const el of tlVideoRefs.current.values()) el.pause();
        for (const el of tlAudioRefs.current.values()) el.pause();
        tlPlayingRef.current = false;
        setTlPlaying(false);
        stopTlClock();
        return;
      }
      tlGlobalRef.current = global;
      setTlPlayheadSec(global);
      syncTlVideos(global, true);
    }, 100);
  }, [stopTlClock, tlEntries, syncTlVideos]);

  const seekTlTo = useCallback(
    (globalSec: number) => {
      const data = tlEntries();
      if (!data) return;
      const global = Math.max(0, Math.min(data.totalSec, globalSec));
      tlGlobalRef.current = global;
      setTlPlayheadSec(global);
      const baseEntry = data.tracks[0]?.items.find((e) => global >= e.startSec && global < e.startSec + e.durationSec);
      if (baseEntry) {
        const el = tlVideoRefs.current.get(baseEntry.item.id);
        if (el) el.currentTime = baseEntry.item.trim.startSec + (global - baseEntry.startSec);
      }
      syncTlVideos(global, tlPlayingRef.current);
    },
    [tlEntries, syncTlVideos],
  );

  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!timeline) return;
    const needed = new Map<string, { itemClip: Clip; trim: TrimRange }>();
    for (const track of timeline.tracks) {
      for (const item of track.items) {
        const itemClip = clips.find((c) => c.id === item.clipId);
        if (!itemClip || itemClip.kind !== "video") continue;
        const key = `${itemClip.id}|${item.trim.startSec}|${item.trim.endSec}`;
        if (!tlThumbs[key] && !tlThumbsPendingRef.current.has(key)) needed.set(key, { itemClip, trim: item.trim });
      }
    }
    if (needed.size === 0) return;
    let cancelled = false;
    void (async () => {
      for (const [key, { itemClip, trim }] of needed) {
        if (cancelled) return;
        tlThumbsPendingRef.current.add(key);
        const urls = await captureThumbs(
          itemClip.url,
          itemClip.meta.width,
          itemClip.meta.height,
          trim.startSec,
          Math.max(trim.startSec + 0.05, trim.endSec - 0.02),
          6,
        );
        tlThumbsPendingRef.current.delete(key);
        if (!cancelled && urls.length > 0) {
          setTlThumbs((prev) => ({ ...prev, [key]: urls }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [timeline, clips, tlThumbs]);

  const beginDrag = (event: React.PointerEvent, mode: "move" | Handle) => {
    if (!cropClip || exporting) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: { ...(drawerItemCrop ?? cropClip.crop) },
    };
  };

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const stage = drawerStageRef.current;
    if (!drag || !cropClip || !stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = ((event.clientX - drag.startClientX) / rect.width) * cropClip.meta.width;
    const dy = ((event.clientY - drag.startClientY) / rect.height) * cropClip.meta.height;
    const s = drag.startCrop;
    let next: CropRect = { ...s };
    if (drag.mode === "move") {
      next = { ...s, x: s.x + dx, y: s.y + dy };
    } else {
      const mode = drag.mode;
      let { x, y, width, height } = s;
      if (mode.includes("e")) width = s.width + dx;
      if (mode.includes("s")) height = s.height + dy;
      if (mode.includes("w")) {
        x = s.x + dx;
        width = s.width - dx;
      }
      if (mode.includes("n")) {
        y = s.y + dy;
        height = s.height - dy;
      }
      if (ratio) {
        if (mode === "n" || mode === "s") {
          width = height * ratio;
          if (mode.includes("w")) x = s.x + s.width - width;
        } else {
          const newHeight = width / ratio;
          if (mode.includes("n")) y = s.y + s.height - newHeight;
          height = newHeight;
        }
      } else {
        if (width < 16 && mode.includes("w")) x = s.x + s.width - 16;
        if (height < 16 && mode.includes("n")) y = s.y + s.height - 16;
      }
      next = { x, y, width, height };
    }
    applyDrawerCrop(clampCrop(next, cropClip.meta.width, cropClip.meta.height, ratio));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const onStageDragOver = (event: React.DragEvent) => {
    if (Array.from(event.dataTransfer.types).includes(POOL_DRAG_TYPE)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setStageDragOver(true);
    }
  };

  const onStageDrop = (event: React.DragEvent) => {
    const droppedId = event.dataTransfer.getData(POOL_DRAG_TYPE) || event.dataTransfer.getData("text/plain");
    setStageDragOver(false);
    if (!droppedId || !clipsRef.current.some((c) => c.id === droppedId)) return;
    event.preventDefault();
    addClipToBase(droppedId);
  };

  const updateTlItem = useCallback((trackIndex: number, itemId: string, patch: Partial<TimelineItem>) => {
    setTimeline((prev) =>
      prev
        ? {
            ...prev,
            tracks: prev.tracks.map((t, i) =>
              i === trackIndex
                ? {
                    ...t,
                    items: t.items.map((it) => {
                      if (it.id !== itemId) return it;
                      const merged = { ...it, ...patch };
                      const itemClip = clipsRef.current.find((c) => c.id === merged.clipId) ?? null;
                      const fades = clampFadePair(
                        merged.fadeInSec ?? 0,
                        merged.fadeOutSec ?? 0,
                        timelineItemDurationSec(merged, itemClip),
                      );
                      return { ...merged, fadeInSec: fades.fadeInSec, fadeOutSec: fades.fadeOutSec };
                    }),
                  }
                : t,
            ),
          }
        : prev,
    );
  }, []);

  const removeTlItem = useCallback(
    (trackIndex: number, itemId: string) => {
      setTimeline((prev) =>
        prev
          ? { ...prev, tracks: prev.tracks.map((t, i) => (i === trackIndex ? { ...t, items: t.items.filter((it) => it.id !== itemId) } : t)) }
          : prev,
      );
      setSelectedTlItemId((prev) => (prev === itemId ? null : prev));
      setDrawerTextItemId((prev) => (prev === itemId ? null : prev));
    },
    [],
  );

  const updateAudioItem = (trackIndex: number, itemId: string, patch: Partial<TimelineItem>) => {
    setTimeline((prev) =>
      prev
        ? {
            ...prev,
            audioTracks: prev.audioTracks.map((t, i) =>
              i === trackIndex
                ? {
                    ...t,
                    items: t.items.map((it) => {
                      if (it.id !== itemId) return it;
                      const merged = { ...it, ...patch };
                      const itemClip = clipsRef.current.find((c) => c.id === merged.clipId) ?? null;
                      const fades = clampFadePair(
                        merged.fadeInSec ?? 0,
                        merged.fadeOutSec ?? 0,
                        timelineItemDurationSec(merged, itemClip),
                      );
                      return { ...merged, fadeInSec: fades.fadeInSec, fadeOutSec: fades.fadeOutSec };
                    }),
                  }
                : t,
            ),
          }
        : prev,
    );
  };

  const removeAudioItem = (trackIndex: number, itemId: string) => {
    setTimeline((prev) =>
      prev
        ? {
            ...prev,
            audioTracks: prev.audioTracks.map((t, i) =>
              i === trackIndex ? { ...t, items: t.items.filter((it) => it.id !== itemId) } : t,
            ),
          }
        : prev,
    );
    setSelectedTlItemId((prev) => (prev === itemId ? null : prev));
  };

  const addAudioTrack = () => {
    setTimeline((prev) =>
      prev ? { ...prev, audioTracks: [...prev.audioTracks, { id: nextTlId("track"), kind: "audio", items: [] }] } : prev,
    );
  };

  const removeAudioTrack = (trackIndex: number) => {
    const current = tlStateRef.current;
    if (!current || !current.audioTracks[trackIndex]) return;
    const removedIds = new Set(current.audioTracks[trackIndex].items.map((it) => it.id));
    setSelectedTlItemId((selected) => (selected && removedIds.has(selected) ? null : selected));
    setTimeline({ ...current, audioTracks: current.audioTracks.filter((_, i) => i !== trackIndex) });
  };

  const makeAudioItem = (clipId: string, startSec: number): TimelineItem | null => {
    const target = clipsRef.current.find((c) => c.id === clipId);
    if (!target || target.kind !== "audio") return null;
    return {
      id: nextTlId("tlitem"),
      clipId,
      kind: "media",
      startSec: Math.max(0, Math.round(startSec * 10) / 10),
      rect: null,
      trim: { ...target.trim },
      crop: { x: 0, y: 0, width: 0, height: 0 },
      durationSec: null,
      gain: 1,
    };
  };

  const addAudioClipToTrack = (clipId: string, trackIndex: number, startSec: number) => {
      const item = makeAudioItem(clipId, startSec);
      if (!item) return;
      setTimeline((prev) => {
        if (!prev || !prev.audioTracks[trackIndex]) return prev;
        const withSize =
          prev.outputWidth > 0 && prev.outputHeight > 0 ? prev : { ...prev, outputWidth: 1280, outputHeight: 720 };
        return {
          ...withSize,
          audioTracks: withSize.audioTracks.map((t, i) =>
            i === trackIndex ? { ...t, items: [...t.items, item] } : t,
          ),
        };
      });
      setSelectedTlItemId(item.id);
  };

  const addAudioClipToNewTrack = (clipId: string, startSec: number) => {
      const item = makeAudioItem(clipId, startSec);
      if (!item) return;
      setTimeline((prev) => {
        if (!prev) return prev;
        const withSize =
          prev.outputWidth > 0 && prev.outputHeight > 0 ? prev : { ...prev, outputWidth: 1280, outputHeight: 720 };
        return {
          ...withSize,
          audioTracks: [...withSize.audioTracks, { id: nextTlId("track"), kind: "audio", items: [item] }],
        };
      });
      setSelectedTlItemId(item.id);
  };

  const applyAudioItemTrim = (trackIndex: number, entry: TlItemLayout, nextRaw: TrimRange) => {
      if (!entry.clip) return;
      const clamped = clampTrim(nextRaw, entry.clip.meta.durationSec);
      const delta = clamped.startSec - entry.item.trim.startSec;
      updateAudioItem(trackIndex, entry.item.id, {
        trim: clamped,
        startSec: Math.max(0, Math.round((entry.item.startSec + delta) * 1000) / 1000),
      });
  };

  const addTrack = useCallback(() => {
    setTimeline((prev) =>
      prev ? { ...prev, tracks: [...prev.tracks, { id: nextTlId("track"), kind: "video", items: [] }] } : prev,
    );
  }, []);

  const removeTrack = useCallback((trackIndex: number) => {
    if (trackIndex <= 0) return;
    const current = tlStateRef.current;
    if (!current || !current.tracks[trackIndex]) return;
    const removedIds = new Set(current.tracks[trackIndex].items.map((it) => it.id));
    setSelectedTlItemId((selected) => (selected && removedIds.has(selected) ? null : selected));
    setTimeline({ ...current, tracks: current.tracks.filter((_, i) => i !== trackIndex) });
  }, []);

  const placeClipOnBase = useCallback((target: Clip, index?: number) => {
    if (target.kind === "audio") return;
    const itemCrop: CropRect = { x: 0, y: 0, width: target.meta.width, height: target.meta.height };
    const sized = evenRect(itemCrop, target.meta.width, target.meta.height);
    const item: TimelineItem = {
      id: nextTlId("tlitem"),
      clipId: target.id,
      kind: "media",
      startSec: 0,
      rect: null,
      trim: { ...target.trim },
      crop: itemCrop,
      durationSec: target.kind === "image" ? DEFAULT_IMAGE_DURATION_SEC : null,
    };
    setTimeline((prev) => {
      const base: TimelineState =
        prev ?? { outputWidth: 0, outputHeight: 0, tracks: [{ id: nextTlId("track"), kind: "video", items: [] }], audioTracks: [], baseAudioGain: 1 };
      const withSize =
        base.outputWidth > 0 && base.outputHeight > 0
          ? base
          : { ...base, outputWidth: sized.width, outputHeight: sized.height };
      const tracks = withSize.tracks.map((t, i) => {
        if (i !== 0) return t;
        const items = [...t.items];
        if (index === undefined || index < 0 || index > items.length) items.push(item);
        else items.splice(index, 0, item);
        return { ...t, items };
      });
      return { ...withSize, tracks };
    });
  }, []);

  useEffect(() => {
    placeClipOnBaseRef.current = placeClipOnBase;
  }, [placeClipOnBase]);

  const addClipToBase = useCallback(
    (clipId: string, index?: number) => {
      const target = clipsRef.current.find((c) => c.id === clipId);
      if (!target) return;
      placeClipOnBase(target, index);
    },
    [placeClipOnBase],
  );

  const addClipToOverlay = useCallback(
    (clipId: string, trackIndex: number, startSec: number) => {
      const target = clipsRef.current.find((c) => c.id === clipId);
      if (!target || target.kind === "audio" || trackIndex <= 0) return;
      const itemCrop: CropRect = { x: 0, y: 0, width: target.meta.width, height: target.meta.height };
      const sized = evenRect(itemCrop, target.meta.width, target.meta.height);
      const itemId = nextTlId("tlitem");
      setTimeline((prev) => {
        if (!prev || !prev.tracks[trackIndex]) return prev;
        const withSize =
          prev.outputWidth > 0 && prev.outputHeight > 0
            ? prev
            : { ...prev, outputWidth: sized.width, outputHeight: sized.height };
        const rect = pipItemRect(withSize.outputWidth, withSize.outputHeight, sized.height > 0 ? sized.width / sized.height : 16 / 9);
        const item: TimelineItem = {
          id: itemId,
          clipId,
          kind: "media",
          startSec: Math.max(0, Math.round(startSec * 10) / 10),
          rect,
          trim: { ...target.trim },
          crop: itemCrop,
          durationSec: target.kind === "image" ? DEFAULT_IMAGE_DURATION_SEC : null,
        };
        return {
          ...withSize,
          tracks: withSize.tracks.map((t, i) => (i === trackIndex ? { ...t, items: [...t.items, item] } : t)),
        };
      });
      setSelectedTlItemId(itemId);
    },
    [],
  );

  const addClipToNewTrack = useCallback(
    (clipId: string, startSec: number) => {
      const target = clipsRef.current.find((c) => c.id === clipId);
      if (!target || target.kind === "audio") return;
      const itemCrop: CropRect = { x: 0, y: 0, width: target.meta.width, height: target.meta.height };
      const sized = evenRect(itemCrop, target.meta.width, target.meta.height);
      const itemId = nextTlId("tlitem");
      setTimeline((prev) => {
        const base: TimelineState =
          prev ?? { outputWidth: 0, outputHeight: 0, tracks: [{ id: nextTlId("track"), kind: "video", items: [] }], audioTracks: [], baseAudioGain: 1 };
        const withSize =
          base.outputWidth > 0 && base.outputHeight > 0
            ? base
            : { ...base, outputWidth: sized.width, outputHeight: sized.height };
        const rect = pipItemRect(withSize.outputWidth, withSize.outputHeight, sized.height > 0 ? sized.width / sized.height : 16 / 9);
        const item: TimelineItem = {
          id: itemId,
          clipId,
          kind: "media",
          startSec: Math.max(0, Math.round(startSec * 10) / 10),
          rect,
          trim: { ...target.trim },
          crop: itemCrop,
          durationSec: target.kind === "image" ? DEFAULT_IMAGE_DURATION_SEC : null,
        };
        return { ...withSize, tracks: [...withSize.tracks, { id: nextTlId("track"), kind: "video", items: [item] }] };
      });
      setSelectedTlItemId(itemId);
    },
    [],
  );

  const addTextClip = useCallback(() => {
    const itemId = nextTlId("tlitem");
    const total = tlEntries()?.totalSec ?? 0;
    const playhead = tlGlobalRef.current;
    const startSec = playhead > total ? 0 : Math.max(0, Math.round(playhead * 10) / 10);
    const item: TimelineItem = {
      id: itemId,
      clipId: "",
      kind: "text",
      startSec,
      rect: null,
      trim: { startSec: 0, endSec: 0 },
      crop: { x: 0, y: 0, width: 0, height: 0 },
      durationSec: DEFAULT_IMAGE_DURATION_SEC,
      text: "Text",
      textStyle: { ...DEFAULT_TEXT_STYLE },
    };
    setTimeline((prev) => {
      const base: TimelineState =
        prev ?? { outputWidth: 0, outputHeight: 0, tracks: [{ id: nextTlId("track"), kind: "video", items: [] }], audioTracks: [], baseAudioGain: 1 };
      const withSize =
        base.outputWidth > 0 && base.outputHeight > 0 ? base : { ...base, outputWidth: 1280, outputHeight: 720 };
      return { ...withSize, tracks: [...withSize.tracks, { id: nextTlId("track"), kind: "video", items: [item] }] };
    });
    setSelectedTlItemId(itemId);
    setCropClipId(null);
    setDrawerItemId(null);
    setDrawerTextItemId(itemId);
  }, [tlEntries]);

  const reorderBaseItem = useCallback((itemId: string, rawTargetIndex: number) => {
    setTimeline((prev) => {
      if (!prev) return prev;
      const items = [...prev.tracks[0].items];
      const from = items.findIndex((it) => it.id === itemId);
      if (from < 0) return prev;
      let to = Math.max(0, Math.min(items.length, rawTargetIndex));
      const [moved] = items.splice(from, 1);
      if (to > from) to -= 1;
      items.splice(to, 0, moved);
      return { ...prev, tracks: prev.tracks.map((t, i) => (i === 0 ? { ...t, items } : t)) };
    });
  }, []);

  const applyTlOutputSize = (newWidth: number, newHeight: number) => {
    if (!timeline) return;
    const overlayTiles: LayoutTile[] = [];
    const aspects: number[] = [];
    timeline.tracks.forEach((track, trackIndex) => {
      if (trackIndex === 0) return;
      for (const item of track.items) {
        if (!item.rect) continue;
        overlayTiles.push({ id: item.id, clipId: item.clipId, rect: item.rect, offsetSec: 0 });
        const target = clips.find((c) => c.id === item.clipId);
        aspects.push(target ? itemCropAspect(item, target) : 16 / 9);
      }
    });
    if (overlayTiles.length === 0) {
      setTimeline({ ...timeline, outputWidth: clampOutputSize(newWidth), outputHeight: clampOutputSize(newHeight) });
      return;
    }
    const resized = resizedTiles(overlayTiles, aspects, newWidth, newHeight, timeline.outputWidth, timeline.outputHeight);
    const rectById = new Map(resized.tiles.map((t) => [t.id, t.rect]));
    setTimeline({
      ...timeline,
      outputWidth: resized.outputWidth,
      outputHeight: resized.outputHeight,
      tracks: timeline.tracks.map((track, trackIndex) =>
        trackIndex === 0
          ? track
          : {
              ...track,
              items: track.items.map((item) =>
                item.rect && rectById.has(item.id) ? { ...item, rect: rectById.get(item.id) ?? item.rect } : item,
              ),
            },
      ),
    });
  };

  const baseInsertIndex = (rowEl: HTMLElement, clientX: number): number => {
    const blocks = Array.from(rowEl.querySelectorAll("[data-tl-block]"));
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return blocks.length;
  };

  type TlDropTarget = { kind: "track"; index: number } | { kind: "ghost" };

  const findTlDropTarget = (clientY: number): TlDropTarget | null => {
    const rows = Array.from(document.querySelectorAll("[data-tl-row]"));
    if (rows.length > 0) {
      const firstTop = rows[0].getBoundingClientRect().top;
      if (clientY < firstTop - 2) return { kind: "ghost" };
    }
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return { kind: "track", index: Number(row.getAttribute("data-tl-row")) };
      }
    }
    return null;
  };

  const moveItemAcrossTracks = (fromTrack: number, itemId: string, target: TlDropTarget, clientX: number) => {
    const current = tlStateRef.current;
    if (!current) return;
    const item = current.tracks[fromTrack]?.items.find((it) => it.id === itemId);
    if (!item) return;
    if (target.kind === "track" && target.index === fromTrack) return;
    if (item.kind === "text" && target.kind === "track" && target.index === 0) return;
    const without = current.tracks.map((t, i) =>
      i === fromTrack ? { ...t, items: t.items.filter((it) => it.id !== itemId) } : t,
    );
    if (target.kind === "ghost") {
      setTimeline({ ...current, tracks: [...without, { id: nextTlId("track"), kind: "video", items: [item] }] });
      return;
    }
    if (target.index === 0) {
      const rowEl = document.querySelector('[data-tl-row="0"]') as HTMLElement | null;
      const index = rowEl ? baseInsertIndex(rowEl, clientX) : current.tracks[0].items.length;
      const baseItem: TimelineItem = { ...item, rect: null, startSec: 0 };
      setTimeline({
        ...current,
        tracks: without.map((t, i) => {
          if (i !== 0) return t;
          const items = [...t.items];
          items.splice(Math.max(0, Math.min(index, items.length)), 0, baseItem);
          return { ...t, items };
        }),
      });
      return;
    }
    setTimeline({
      ...current,
      tracks: without.map((t, i) => (i === target.index ? { ...t, items: [...t.items, item] } : t)),
    });
  };

  const convertBaseItemToOverlay = (itemId: string): TimelineItem | null => {
    const current = tlStateRef.current;
    if (!current) return null;
    const item = current.tracks[0]?.items.find((it) => it.id === itemId);
    if (!item) return null;
    const target = clipsRef.current.find((c) => c.id === item.clipId);
    if (!target) return null;
    const layout = layoutTimeline(current, clipsRef.current);
    const entry = layout.tracks[0]?.items.find((e) => e.item.id === itemId);
    const startSec = entry ? entry.startSec : 0;
    const sized = evenRect(item.crop, target.meta.width, target.meta.height);
    const outW = current.outputWidth > 0 ? current.outputWidth : sized.width;
    const outH = current.outputHeight > 0 ? current.outputHeight : sized.height;
    const rect = pipItemRect(outW, outH, sized.height > 0 ? sized.width / sized.height : 16 / 9);
    return { ...item, startSec, rect };
  };

  const moveBaseItemToTrack = (itemId: string, toTrack: number) => {
    const current = tlStateRef.current;
    const converted = convertBaseItemToOverlay(itemId);
    if (!current || !converted || !current.tracks[toTrack]) return;
    setTimeline({
      ...current,
      tracks: current.tracks.map((t, i) => {
        if (i === 0) return { ...t, items: t.items.filter((it) => it.id !== itemId) };
        if (i === toTrack) return { ...t, items: [...t.items, converted] };
        return t;
      }),
    });
  };

  const moveBaseItemToNewTrack = (itemId: string) => {
    const current = tlStateRef.current;
    const converted = convertBaseItemToOverlay(itemId);
    if (!current || !converted) return;
    setTimeline({
      ...current,
      tracks: [
        ...current.tracks.map((t, i) => (i === 0 ? { ...t, items: t.items.filter((it) => it.id !== itemId) } : t)),
        { id: nextTlId("track"), kind: "video", items: [converted] },
      ],
    });
  };

  type AudioDropTarget = { kind: "track"; index: number } | { kind: "ghost" };

  const findAudioDropTarget = (clientY: number): AudioDropTarget | null => {
    const ghost = document.querySelector("[data-tl-audio-ghost]");
    if (ghost) {
      const r = ghost.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return { kind: "ghost" };
    }
    const rows = Array.from(document.querySelectorAll("[data-tl-audio-row]"));
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        return { kind: "track", index: Number(row.getAttribute("data-tl-audio-row")) };
      }
    }
    if (rows.length > 0) {
      const last = rows[rows.length - 1].getBoundingClientRect();
      if (clientY > last.bottom) return { kind: "ghost" };
    }
    return null;
  };

  const moveAudioItemAcrossTracks = (fromTrack: number, itemId: string, target: AudioDropTarget) => {
    const current = tlStateRef.current;
    if (!current) return;
    const item = current.audioTracks[fromTrack]?.items.find((it) => it.id === itemId);
    if (!item) return;
    if (target.kind === "track" && target.index === fromTrack) return;
    const without = current.audioTracks.map((t, i) =>
      i === fromTrack ? { ...t, items: t.items.filter((it) => it.id !== itemId) } : t,
    );
    if (target.kind === "ghost") {
      setTimeline({
        ...current,
        audioTracks: [...without, { id: nextTlId("track"), kind: "audio", items: [item] }],
      });
      return;
    }
    setTimeline({
      ...current,
      audioTracks: without.map((t, i) => (i === target.index ? { ...t, items: [...t.items, item] } : t)),
    });
  };

  const beginTlBlockDrag = (
    event: React.PointerEvent,
    trackIndex: number,
    entry: TlItemLayout,
    section: "video" | "audio" = "video",
  ) => {
    if (exporting) return;
    event.stopPropagation();
    setSelectedTlItemId(entry.item.id);
    const rowEl = (event.currentTarget as HTMLElement).closest(".tl-row-track") as HTMLElement | null;
    tlBlockDragRef.current = {
      itemId: entry.item.id,
      trackIndex,
      section,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startSec: entry.item.startSec,
      rowWidth: rowEl?.getBoundingClientRect().width ?? 0,
      totalSec: tlTotalSec,
      activated: false,
      isText: entry.item.kind === "text",
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onTlBlockDragMove = (event: React.PointerEvent) => {
    const drag = tlBlockDragRef.current;
    if (!drag) return;
    if (!drag.activated) {
      const moved = Math.abs(event.clientX - drag.startClientX) + Math.abs(event.clientY - drag.startClientY);
      if (moved > 6) drag.activated = true;
    }
    if (drag.rowWidth > 0 && drag.totalSec > 0) {
      const dxSec = ((event.clientX - drag.startClientX) / drag.rowWidth) * drag.totalSec;
      const next = Math.max(0, Math.round((drag.startSec + dxSec) * 10) / 10);
      if (drag.section === "audio") updateAudioItem(drag.trackIndex, drag.itemId, { startSec: next });
      else updateTlItem(drag.trackIndex, drag.itemId, { startSec: next });
    }
    if (drag.activated) {
      if (drag.section === "audio") {
        const target = findAudioDropTarget(event.clientY);
        const nextTarget: number | "ghost" | null =
          target === null ? null : target.kind === "ghost" ? "ghost" : target.index;
        setTlAudioDropTarget((prev) => (prev === nextTarget ? prev : nextTarget));
      } else {
        const target = findTlDropTarget(event.clientY);
        const nextTarget: number | "ghost" | null =
          target === null ? null : target.kind === "ghost" ? "ghost" : target.index;
        const shown = drag.isText && nextTarget === 0 ? null : nextTarget;
        setTlDropTarget((prev) => (prev === shown ? prev : shown));
      }
    }
  };

  const endTlBlockDrag = (event?: React.PointerEvent) => {
    const drag = tlBlockDragRef.current;
    tlBlockDragRef.current = null;
    setTlDropTarget(null);
    setTlAudioDropTarget(null);
    setTlGhostVisible(false);
    setTlGhostHot(false);
    if (!drag || !event || !drag.activated) return;
    if (drag.section === "audio") {
      const target = findAudioDropTarget(event.clientY);
      if (!target) return;
      if (target.kind === "track" && target.index === drag.trackIndex) return;
      moveAudioItemAcrossTracks(drag.trackIndex, drag.itemId, target);
      return;
    }
    const target = findTlDropTarget(event.clientY);
    if (!target) return;
    if (target.kind === "track" && target.index === drag.trackIndex) return;
    moveItemAcrossTracks(drag.trackIndex, drag.itemId, target, event.clientX);
  };

  const applyItemTrim = useCallback(
    (trackIndex: number, entry: TlItemLayout, nextRaw: TrimRange) => {
      if (!entry.clip) return;
      const clamped = clampTrim(nextRaw, entry.clip.meta.durationSec);
      if (trackIndex === 0) {
        updateTlItem(0, entry.item.id, { trim: clamped });
        return;
      }
      const delta = clamped.startSec - entry.item.trim.startSec;
      updateTlItem(trackIndex, entry.item.id, {
        trim: clamped,
        startSec: Math.max(0, Math.round((entry.item.startSec + delta) * 1000) / 1000),
      });
    },
    [updateTlItem],
  );

  const beginTlEdgeDrag = (
    event: React.PointerEvent,
    trackIndex: number,
    entry: TlItemLayout,
    edge: "start" | "end",
    section: "video" | "audio" = "video",
  ) => {
    if (exporting) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedTlItemId(entry.item.id);
    const rowEl = (event.currentTarget as HTMLElement).closest(".tl-row-track") as HTMLElement | null;
    tlEdgeDragRef.current = {
      itemId: entry.item.id,
      trackIndex,
      section,
      edge,
      startClientX: event.clientX,
      rowWidth: rowEl?.getBoundingClientRect().width ?? 0,
      totalSec: tlTotalSec,
      origTrim: { ...entry.item.trim },
      origStartSec: entry.item.startSec,
      clipDurationSec: entry.clip?.meta.durationSec ?? 0,
      isDuration: entry.item.kind === "text" || entry.clip?.kind === "image",
      origDurationSec: entry.durationSec,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onTlEdgeDragMove = (event: React.PointerEvent) => {
    const drag = tlEdgeDragRef.current;
    if (!drag || drag.rowWidth <= 0 || drag.totalSec <= 0) return;
    const dxSec = ((event.clientX - drag.startClientX) / drag.rowWidth) * drag.totalSec;
    if (drag.isDuration) {
      if (drag.edge === "end") {
        const next = Math.round(Math.max(0.1, drag.origDurationSec + dxSec) * 1000) / 1000;
        updateTlItem(drag.trackIndex, drag.itemId, { durationSec: next });
      } else if (drag.trackIndex > 0) {
        const next = Math.max(0, Math.round((drag.origStartSec + dxSec) * 10) / 10);
        updateTlItem(drag.trackIndex, drag.itemId, { startSec: next });
      }
      return;
    }
    const nextRaw =
      drag.edge === "start"
        ? { ...drag.origTrim, startSec: drag.origTrim.startSec + dxSec }
        : { ...drag.origTrim, endSec: drag.origTrim.endSec + dxSec };
    const clamped = clampTrim(nextRaw, drag.clipDurationSec);
    if (drag.section === "audio") {
      if (drag.edge === "end") {
        updateAudioItem(drag.trackIndex, drag.itemId, { trim: clamped });
        return;
      }
      const delta = clamped.startSec - drag.origTrim.startSec;
      updateAudioItem(drag.trackIndex, drag.itemId, {
        trim: clamped,
        startSec: Math.max(0, Math.round((drag.origStartSec + delta) * 1000) / 1000),
      });
      return;
    }
    if (drag.trackIndex === 0 || drag.edge === "end") {
      updateTlItem(drag.trackIndex, drag.itemId, { trim: clamped });
      return;
    }
    const delta = clamped.startSec - drag.origTrim.startSec;
    updateTlItem(drag.trackIndex, drag.itemId, {
      trim: clamped,
      startSec: Math.max(0, Math.round((drag.origStartSec + delta) * 1000) / 1000),
    });
  };

  const endTlEdgeDrag = () => {
    tlEdgeDragRef.current = null;
  };

  const toggleTlPlayback = () => {
    const data = tlEntries();
    if (!data || data.totalSec <= 0) return;
    if (tlPlayingRef.current) {
      tlPlayingRef.current = false;
      setTlPlaying(false);
      stopTlClock();
      for (const el of tlVideoRefs.current.values()) el.pause();
      for (const el of tlAudioRefs.current.values()) el.pause();
      return;
    }
    let global = tlGlobalRef.current;
    if (global >= data.totalSec - 0.05) {
      global = 0;
      tlGlobalRef.current = 0;
      setTlPlayheadSec(0);
    }
    tlPlayingRef.current = true;
    setTlPlaying(true);
    const baseEntry = data.tracks[0]?.items.find((e) => global >= e.startSec && global < e.startSec + e.durationSec);
    if (baseEntry && baseEntry.clip?.kind === "video") {
      const el = tlVideoRefs.current.get(baseEntry.item.id);
      if (el) {
        const target = baseEntry.item.trim.startSec + (global - baseEntry.startSec);
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
        void el.play().catch(() => undefined);
      }
      syncTlVideos(global, true);
    } else {
      syncTlVideos(global, true);
      startTlClock();
    }
  };

  const beginTlTileDrag = (event: React.PointerEvent, trackIndex: number, entry: TlItemLayout, mode: "move" | "resize") => {
    if (!timeline || exporting || !entry.item.rect) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    tlTileDragRef.current = {
      itemId: entry.item.id,
      trackIndex,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: { ...entry.item.rect },
    };
  };

  const onTlTileDragMove = (event: React.PointerEvent) => {
    const drag = tlTileDragRef.current;
    const stage = tlStageRef.current;
    if (!drag || !timeline || !stage) return;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width === 0) return;
    const scale = timeline.outputWidth / bounds.width;
    const dx = (event.clientX - drag.startClientX) * scale;
    const dy = (event.clientY - drag.startClientY) * scale;
    const s = drag.startRect;
    let next: TileRect;
    if (drag.mode === "move") {
      next = {
        ...s,
        x: Math.max(0, Math.min(s.x + dx, timeline.outputWidth - s.width)),
        y: Math.max(0, Math.min(s.y + dy, timeline.outputHeight - s.height)),
      };
    } else {
      const data = tlEntries();
      const entry = data?.tracks[drag.trackIndex]?.items.find((e) => e.item.id === drag.itemId);
      const aspect = entry && entry.clip ? itemCropAspect(entry.item, entry.clip) : 16 / 9;
      let width = Math.max(32, Math.min(s.width + dx, timeline.outputWidth - s.x));
      let height = width / aspect;
      if (s.y + height > timeline.outputHeight) {
        height = Math.max(16, timeline.outputHeight - s.y);
        width = height * aspect;
      }
      next = { ...s, width, height };
    }
    updateTlItem(drag.trackIndex, drag.itemId, { rect: next });
  };

  const endTlTileDrag = () => {
    tlTileDragRef.current = null;
  };

  const changeAspect = (value: string) => {
    const preset = (ASPECTS.find((a) => a.value === value)?.value ?? "free") as AspectPreset;
    setAspect(preset);
    if (!cropClip) return;
    const r = ASPECTS.find((a) => a.value === preset)?.ratio ?? null;
    if (!r) return;
    const c = drawerItemCrop ?? cropClip.crop;
    let width = c.width;
    let height = width / r;
    if (height > cropClip.meta.height) {
      height = cropClip.meta.height;
      width = height * r;
    }
    const x = Math.max(0, Math.min(c.x + (c.width - width) / 2, cropClip.meta.width - width));
    const y = Math.max(0, Math.min(c.y + (c.height - height) / 2, cropClip.meta.height - height));
    applyDrawerCrop({ x, y, width, height });
  };

  const updateField = (field: keyof CropRect, value: number) => {
    if (!cropClip) return;
    if (!Number.isFinite(value)) return;
    applyDrawerCrop(clampCrop({ ...(drawerItemCrop ?? cropClip.crop), [field]: value }, cropClip.meta.width, cropClip.meta.height, ratio));
  };

  const runExport = async () => {
    if (exporting) return;
    if (!supported) {
      setError("WebCodecs is not available in this context. Open this page via localhost or HTTPS in Chrome or Edge.");
      return;
    }
    setError(null);
    setNotice(null);
    setResultUrl(null);
    setUsedCodec(null);
    setAudioCopied(null);
    setAudioMixed(false);
    setAudioMixedCodec(null);
    setAudioMixParts(null);
    cancelRef.current = false;
    setProgress(0);
    setExporting(true);
    try {
      let blob: Blob;
      let suggested: string;
      let pickerType: { description: string; accept: Record<string, string[]> };
      const tlData = timeline ? layoutTimeline(timeline, clips) : null;
      const tlAudioData = timeline ? layoutAudioTimeline(timeline, clips) : null;
      const tlExportReady =
        tlData !== null &&
        (tlData.tracks.some((t) => t.items.length > 0) ||
          (tlAudioData?.tracks.some((t) => t.items.length > 0) ?? false)) &&
        timeline.outputWidth > 0;
      if (tlExportReady && timeline && tlData) {
        const baseSpecs = tlData.tracks[0].items.flatMap((entry) => {
          if (!entry.clip || entry.clip.kind === "audio") return [];
          return [
            {
              kind: entry.clip.kind,
              input: entry.clip.input,
              file: entry.clip.file,
              trim: entry.item.trim,
              crop: evenRect(entry.item.crop, entry.clip.meta.width, entry.clip.meta.height),
              durationSec: entry.clip.kind === "image" ? entry.durationSec : undefined,
              hasAudio: entry.clip.meta.hasAudio,
              fadeInSec: entry.item.fadeInSec ?? 0,
              fadeOutSec: entry.item.fadeOutSec ?? 0,
            },
          ];
        });
        const overlaySpecs = [];
        const textSpecs = [];
        for (let ti = 1; ti < tlData.tracks.length; ti++) {
          for (const entry of tlData.tracks[ti].items) {
            if (entry.item.kind === "text") {
              textSpecs.push({
                text: entry.item.text ?? "",
                startSec: entry.startSec,
                durationSec: entry.durationSec,
                style: entry.item.textStyle ?? DEFAULT_TEXT_STYLE,
                fadeInSec: entry.item.fadeInSec ?? 0,
                fadeOutSec: entry.item.fadeOutSec ?? 0,
              });
              continue;
            }
            if (!entry.clip || entry.clip.kind === "audio" || !entry.item.rect) continue;
            overlaySpecs.push({
              kind: entry.clip.kind,
              input: entry.clip.input,
              file: entry.clip.file,
              trim: entry.item.trim,
              crop: evenRect(entry.item.crop, entry.clip.meta.width, entry.clip.meta.height),
              durationSec: entry.clip.kind === "image" ? entry.durationSec : undefined,
              startSec: entry.startSec,
              rect: entry.item.rect,
              gain: entry.item.gain ?? 1,
              hasAudio: entry.clip.meta.hasAudio,
              chromaKey: entry.item.chromaKey ?? null,
              fadeInSec: entry.item.fadeInSec ?? 0,
              fadeOutSec: entry.item.fadeOutSec ?? 0,
            });
          }
        }
        const audioSpecs = (tlAudioData?.tracks ?? []).flatMap((trackLayout) =>
          trackLayout.items.flatMap((entry) => {
            if (!entry.clip) return [];
            return [
              {
                file: entry.clip.file,
                buffer: entry.clip.audioBuffer,
                trim: entry.item.trim,
                startSec: entry.startSec,
                gain: entry.item.gain ?? 1,
                fadeInSec: entry.item.fadeInSec ?? 0,
                fadeOutSec: entry.item.fadeOutSec ?? 0,
              },
            ];
          }),
        );
        const res = await exportTimeline({
          base: baseSpecs,
          overlays: overlaySpecs,
          texts: textSpecs,
          audioClips: audioSpecs,
          baseAudioGain: timeline.baseAudioGain,
          outputWidth: timeline.outputWidth,
          outputHeight: timeline.outputHeight,
          onProgress: (value) => setProgress(value),
          isCancelled: () => cancelRef.current,
        });
        blob = res.blob;
        const totalTrackCount = timeline.tracks.length + timeline.audioTracks.length;
        setUsedCodec(
          `${res.codecLabel} · timeline ${timeline.outputWidth} × ${timeline.outputHeight} · ${totalTrackCount} track${totalTrackCount === 1 ? "" : "s"} · ${fmtSec(res.outputDurationSec)}`,
        );
        setAudioCopied(res.audioCopied);
        setAudioMixed(res.audioMixed);
        setAudioMixedCodec(res.audioCodecLabel);
        setAudioMixParts(res.audioMixParts);
        setResultFormat("mp4");
        setResultTimeline(true);
        suggested = clip
          ? `${clip.file.name.replace(/\.(mp4|wav|mp3|m4a|aac|ogg|flac)$/i, "")}-timeline.mp4`
          : "timeline.mp4";
        pickerType = { description: "MP4 video", accept: { "video/mp4": [".mp4"] } };
      } else if (!clip) {
        setError("Add media or timeline clips first.");
        setExporting(false);
        return;
      } else if (clip.kind === "image" || clip.kind === "audio" || !clip.input) {
        setError(
          clip.kind === "audio"
            ? "Audio is used on the timeline. Add this audio to an audio track, then export the timeline as MP4."
            : "Images are used on the timeline. Add this image to the timeline, then export the timeline as MP4.",
        );
        setExporting(false);
        return;
      } else if (exportFormat === "gif") {
        const res = await exportGif({
          input: clip.input,
          crop: evenRect(clip.crop, clip.meta.width, clip.meta.height),
          trim: clip.trim,
          width: gifWidth === "original" ? 0 : Number(gifWidth),
          fps: Number(gifFps),
          onProgress: (value) => setProgress(value),
          isCancelled: () => cancelRef.current,
        });
        blob = res.blob;
        setUsedCodec(`GIF ${res.width} × ${res.height} · ${res.frameCount} frames · looping`);
        setResultFormat("gif");
        setResultTimeline(false);
        suggested = `${clip.file.name.replace(/\.mp4$/i, "")}-loop.gif`;
        pickerType = { description: "GIF image", accept: { "image/gif": [".gif"] } };
      } else {
        const res = await exportCropped({
          input: clip.input,
          crop: evenRect(clip.crop, clip.meta.width, clip.meta.height),
          trim: clip.trim,
          onProgress: (value) => setProgress(value),
          isCancelled: () => cancelRef.current,
        });
        blob = res.blob;
        setUsedCodec(res.codecLabel);
        setAudioCopied(res.audioCopied);
        setResultFormat("mp4");
        setResultTimeline(false);
        suggested = `${clip.file.name.replace(/\.mp4$/i, "")}-edited.mp4`;
        pickerType = { description: "MP4 video", accept: { "video/mp4": [".mp4"] } };
      }
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setResultName(suggested);
      setResultSize(blob.size);
      const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: suggested,
            types: [pickerType],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          setResultName(handle.name);
          setNotice(`Saved to ${handle.name}`);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            setNotice("Save dialog was closed. Use the download button below to save the file.");
          } else {
            throw err;
          }
        }
      } else {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = suggested;
        anchor.click();
        setNotice("Download started.");
      }
    } catch (err) {
      if (err instanceof ExportCancelledError) {
        setNotice("Export cancelled.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setExporting(false);
    }
  };

  const outRect = clip ? evenRect(clip.crop, clip.meta.width, clip.meta.height) : null;
  const cropOutRect = cropClip ? evenRect(drawerItemCrop ?? cropClip.crop, cropClip.meta.width, cropClip.meta.height) : null;
  const drawerCropRect: CropRect | null = cropClip ? (drawerItemCrop ?? cropClip.crop) : null;
  const trimIsFull =
    clip !== null && clip.trim.startSec <= 0.01 && clip.trim.endSec >= clip.meta.durationSec - 0.01;
  const selectionSec = clip ? Math.max(0, clip.trim.endSec - clip.trim.startSec) : 0;
  const resultAudioText = resultTimeline
    ? audioMixed
      ? `Audio mixed (${audioMixParts ?? "base track + audio clips"}, ${audioMixedCodec ?? "encoded"})`
      : audioCopied
        ? "Audio copied without re-encoding (base track)"
        : "No audio track"
    : clip && clip.meta.hasAudio
      ? audioCopied
        ? "Audio copied without re-encoding"
        : "Audio could not be copied"
      : "No audio track";
  const isFullFrame =
    clip !== null &&
    Math.round(clip.crop.x) === 0 &&
    Math.round(clip.crop.y) === 0 &&
    Math.round(clip.crop.width) === clip.meta.width &&
    Math.round(clip.crop.height) === clip.meta.height;
  const tlLayout = layoutTimeline(timeline, clips);
  const tlAudioLayout = layoutAudioTimeline(timeline, clips);
  const tlTotalSec = Math.max(tlLayout.totalSec, tlAudioLayout.totalSec);
  const timelineExporting =
    (tlLayout.tracks.some((t) => t.items.length > 0) ||
      tlAudioLayout.tracks.some((t) => t.items.length > 0)) &&
    timeline.outputWidth > 0;
  const singleImageActive = !timelineExporting && clip !== null && clip.kind === "image";
  const singleAudioActive = !timelineExporting && clip !== null && clip.kind === "audio";
  const activeBaseEntry = (() => {
    if (!tlLayout || tlLayout.tracks.length === 0) return null;
    const baseItems = tlLayout.tracks[0].items;
    const found = baseItems.find((e) => tlPlayheadSec >= e.startSec && tlPlayheadSec < e.startSec + e.durationSec);
    if (found) return found;
    if (baseItems.length > 0 && tlPlayheadSec >= tlLayout.baseEndSec) return baseItems[baseItems.length - 1];
    return null;
  })();
  const activeBaseId = activeBaseEntry?.item.id ?? null;
  const activeBaseClip = activeBaseEntry?.clip ?? null;
  const selectedTl = (() => {
    if (!tlLayout || !selectedTlItemId) return null;
    for (let ti = 0; ti < tlLayout.tracks.length; ti++) {
      const found = tlLayout.tracks[ti].items.find((e) => e.item.id === selectedTlItemId);
      if (found) return { entry: found, trackIndex: ti };
    }
    return null;
  })();
  const selectedAudio = (() => {
    if (!selectedTlItemId) return null;
    for (let ti = 0; ti < tlAudioLayout.tracks.length; ti++) {
      const found = tlAudioLayout.tracks[ti].items.find((e) => e.item.id === selectedTlItemId);
      if (found) return { entry: found, trackIndex: ti };
    }
    return null;
  })();
  const selectedChromaKey: ChromaKeySettings = selectedTl?.entry.item.chromaKey ?? DEFAULT_CHROMA_KEY;
  const updateSelectedChromaKey = (patch: Partial<ChromaKeySettings>) => {
    if (!selectedTl) return;
    updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
      chromaKey: { ...selectedChromaKey, ...patch },
    });
  };
  const drawerItem = (() => {
    if (!drawerItemId || !timeline) return null;
    for (let ti = 0; ti < timeline.tracks.length; ti++) {
      const found = timeline.tracks[ti].items.find((it) => it.id === drawerItemId);
      if (found) return { item: found, trackIndex: ti };
    }
    return null;
  })();
  const drawerTextItem = (() => {
    if (!drawerTextItemId || !timeline) return null;
    for (let ti = 0; ti < timeline.tracks.length; ti++) {
      const found = timeline.tracks[ti].items.find((it) => it.id === drawerTextItemId);
      if (found) return { item: found, trackIndex: ti };
    }
    return null;
  })();
  const drawerTextStyle: TextStyle = drawerTextItem?.item.textStyle ?? DEFAULT_TEXT_STYLE;
  const updateDrawerTextStyle = (patch: Partial<TextStyle>) => {
    if (!drawerTextItem) return;
    updateTlItem(drawerTextItem.trackIndex, drawerTextItem.item.id, {
      textStyle: { ...drawerTextStyle, ...patch },
    });
  };
  const drawerTrim: TrimRange = drawerItem ? drawerItem.item.trim : (cropClip?.trim ?? { startSec: 0, endSec: 0 });
  const applyDrawerTrim = (nextRaw: TrimRange) => {
    if (!cropClip) return;
    const clamped = clampTrim(nextRaw, cropClip.meta.durationSec);
    if (!drawerItem) {
      setClipTrim(cropClip.id, clamped);
      return;
    }
    if (drawerItem.trackIndex === 0) {
      updateTlItem(0, drawerItem.item.id, { trim: clamped });
      return;
    }
    const delta = clamped.startSec - drawerItem.item.trim.startSec;
    updateTlItem(drawerItem.trackIndex, drawerItem.item.id, {
      trim: clamped,
      startSec: Math.max(0, Math.round((drawerItem.item.startSec + delta) * 1000) / 1000),
    });
  };
  const updateDrawerTrimField = (field: keyof TrimRange, value: number) => {
    if (!Number.isFinite(value)) return;
    applyDrawerTrim({ ...drawerTrim, [field]: value });
  };
  const setDrawerTrimToPlayhead = (field: keyof TrimRange) => {
    const t = drawerVideoRef.current?.currentTime ?? drawerTrim.startSec;
    applyDrawerTrim({ ...drawerTrim, [field]: t });
  };
  const closeDrawer = () => {
    setCropClipId(null);
    setDrawerItemId(null);
    setDrawerTextItemId(null);
  };
  const isLargeTlCanvas =
    timeline.outputWidth > 0 && (timeline.outputWidth > 3840 || timeline.outputWidth * timeline.outputHeight > 8_300_000);
  const tlPct = (rect: TileRect): React.CSSProperties =>
    timeline
      ? {
          left: `${(rect.x / timeline.outputWidth) * 100}%`,
          top: `${(rect.y / timeline.outputHeight) * 100}%`,
          width: `${(rect.width / timeline.outputWidth) * 100}%`,
          height: `${(rect.height / timeline.outputHeight) * 100}%`,
        }
      : {};

  useEffect(() => {
    const el = tlStageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setTlStageSize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tlHasItems, timeline.outputWidth, timeline.outputHeight]);

  useEffect(() => {
    if (!activeBaseId) return;
    const data = tlEntries();
    if (!data) return;
    const entry = data.tracks[0]?.items.find((e) => e.item.id === activeBaseId);
    if (!entry) return;
    const el = tlVideoRefs.current.get(activeBaseId);
    if (!el) return;
    const global = tlGlobalRef.current;
    const target =
      entry.item.trim.startSec + Math.max(0, Math.min(entry.durationSec, global - entry.startSec));
    const apply = () => {
      if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
      if (tlPlayingRef.current) void el.play().catch(() => undefined);
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener("loadedmetadata", apply, { once: true });
  }, [activeBaseId, tlEntries]);

  useEffect(() => {
    if (!activeBaseId) return;
    const el = tlVideoRefs.current.get(activeBaseId);
    if (!el) return;
    const onTime = () => {
      const data = tlEntries();
      if (!data) return;
      const entry = data.tracks[0]?.items.find((e) => e.item.id === activeBaseId);
      if (!entry) return;
      const global = entry.startSec + Math.max(0, el.currentTime - entry.item.trim.startSec);
      tlGlobalRef.current = global;
      setTlPlayheadSec(global);
      syncTlVideos(global, tlPlayingRef.current);
      const isLastBase = data.tracks[0].items[data.tracks[0].items.length - 1]?.item.id === activeBaseId;
      if (isLastBase && el.currentTime >= entry.item.trim.endSec - 0.02 && tlPlayingRef.current) {
        el.pause();
        if (data.totalSec > global + 0.05) {
          startTlClock();
        } else {
          tlPlayingRef.current = false;
          setTlPlaying(false);
          syncTlVideos(global, false);
        }
      }
    };
    const onEnded = () => {
      const data = tlEntries();
      if (!data) return;
      const entry = data.tracks[0]?.items.find((e) => e.item.id === activeBaseId);
      if (!entry) return;
      const global = entry.startSec + entry.durationSec;
      tlGlobalRef.current = global;
      setTlPlayheadSec(global);
      syncTlVideos(global, tlPlayingRef.current);
      const isLastBase = data.tracks[0].items[data.tracks[0].items.length - 1]?.item.id === activeBaseId;
      if (isLastBase && tlPlayingRef.current) {
        if (data.totalSec > global + 0.05) {
          startTlClock();
        } else {
          tlPlayingRef.current = false;
          setTlPlaying(false);
        }
      }
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
    };
  }, [activeBaseId, tlEntries, syncTlVideos, startTlClock]);

  return (
    <Theme theme={ttsTheme} mode="dark">
      <div className="shell">
        <main className="shell-main">
          <div className="workspace">
            <aside
              className={`pool${poolDragging ? " dragging" : ""}`}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.types).includes("Files")) {
                  e.preventDefault();
                  setPoolDragging(true);
                }
              }}
              onDragLeave={() => setPoolDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setPoolDragging(false);
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) void addFiles(files);
              }}
            >
              <div className="pool-header">
                <Heading level={4}>Media</Heading>
                <Text type="supporting">{clips.length} item{clips.length === 1 ? "" : "s"}</Text>
              </div>
              <Button
                label="Add media"
                variant="primary"
                onClick={() => poolFileInputRef.current?.click()}
                isDisabled={loading}
              />
              <input
                ref={poolFileInputRef}
                type="file"
                accept="video/mp4,.mp4,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.flac,.opus"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) void addFiles(files);
                  e.target.value = "";
                }}
              />
              {clips.length === 0 && (
                <Text type="supporting">No media yet. Add MP4 videos, PNG/JPEG/WebP images, or audio files here, or drop files onto this column.</Text>
              )}
              <div className="pool-items">
                {clips.map((item) => (
                  <Card
                    key={item.id}
                    className={`pool-item${item.id === clip?.id ? " active" : ""}`}
                    data-pool-clip={item.id}
                    draggable={!exporting}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(POOL_DRAG_TYPE, item.id);
                      e.dataTransfer.setData("text/plain", item.id);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => {
                      setActiveClipId(item.id);
                    }}
                    onDoubleClick={() => {
                      if (item.kind !== "video") return;
                      setCropClipId(item.id);
                      setDrawerItemId(null);
                    }}
                  >
                    {item.kind === "image" ? (
                      <img className="pool-thumb" src={item.url} alt="" draggable={false} />
                    ) : item.kind === "audio" ? (
                      <WaveformCanvas
                        peaks={item.waveformPeaks}
                        durationSec={item.meta.durationSec}
                        trim={item.trim}
                        className="pool-waveform"
                      />
                    ) : (
                      <video className="pool-thumb" src={item.url} preload="metadata" muted playsInline />
                    )}
                    <div className="pool-item-name">{item.file.name}</div>
                    <div className="pool-item-meta">
                      {item.kind === "image" ? (
                        <>
                          <span className="pool-tag">Image</span>
                          <span>
                            {item.meta.width} × {item.meta.height}
                          </span>
                        </>
                      ) : item.kind === "audio" ? (
                        <>
                          <span className="pool-tag">Audio</span>
                          <span>{fmtDuration(item.meta.durationSec)}</span>
                        </>
                      ) : (
                        <>
                          <span>{fmtDuration(item.meta.durationSec)}</span>
                          <span>
                            {item.meta.width} × {item.meta.height}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="pool-item-actions">
                      <Button
                        label="Remove"
                        variant="secondary"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeClip(item.id);
                        }}
                        isDisabled={exporting}
                      />
                    </div>
                  </Card>
                ))}
              </div>
              {clips.length > 0 && (
                <Text type="supporting">Drag video or image media onto the preview, and audio onto an audio track. Double-click a video to edit its crop and trim; an image is edited on its timeline clip.</Text>
              )}
            </aside>
            <div className="editor-column">
          <VStack gap={6}>
            {!supported && (
              <div className="error-box">
                <Text>WebCodecs is not available in this context, so exporting is disabled. It requires a secure context — open this page via localhost or HTTPS in Chrome or Edge.</Text>
              </div>
            )}
            {error && (
              <div className="error-box">
                <Text>{error}</Text>
              </div>
            )}
            {notice && <Text type="supporting">{notice}</Text>}
            {!clip && (
              <div
                className={`drop-zone${dragging ? " dragging" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const files = Array.from(e.dataTransfer.files);
                  if (files.length > 0) void addFiles(files);
                }}
              >
                <VStack gap={3}>
                  {loading ? <Spinner /> : <FolderOpen size={36} />}
                  <Heading level={3}>Drop media files here</Heading>
                  <Text type="supporting">MP4 videos, PNG/JPEG/WebP images, or audio files. Or click to choose files. Everything is processed locally in your browser.</Text>
                </VStack>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,.mp4,image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.flac,.opus"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) void addFiles(files);
                e.target.value = "";
              }}
            />

            {clip && outRect && (
              <div className="editor-grid">
                <div
                  className={`stage-wrap${stageDragOver ? " drag-over" : ""}`}
                  ref={stageWrapRef}
                  onDragOver={onStageDragOver}
                  onDragLeave={() => setStageDragOver(false)}
                  onDrop={onStageDrop}
                >
                  {tlHasItems && timeline.outputWidth > 0 ? (
                    <div className="composite-wrap">
                      <div
                        className="composite-stage"
                        ref={tlStageRef}
                        style={{ aspectRatio: `${timeline.outputWidth} / ${timeline.outputHeight}` }}
                      >
                        {activeBaseEntry && activeBaseClip && (
                          <div
                            className="tl-base-video"
                            key={activeBaseEntry.item.id}
                            style={{
                              ...baseVideoBoxStyle(activeBaseClip.meta, activeBaseEntry.item.crop, timeline.outputWidth, timeline.outputHeight),
                              opacity: clipFadeFactor(
                                activeBaseEntry.item.fadeInSec,
                                activeBaseEntry.item.fadeOutSec,
                                tlPlayheadSec - activeBaseEntry.startSec,
                                activeBaseEntry.durationSec,
                              ),
                            }}
                          >
                            {activeBaseClip.kind === "image" ? (
                              <img
                                src={activeBaseClip.url}
                                alt=""
                                draggable={false}
                                style={subRectVideoStyle(activeBaseClip.meta, activeBaseEntry.item.crop)}
                              />
                            ) : (
                              <video
                                ref={(el) => {
                                  if (el) tlVideoRefs.current.set(activeBaseEntry.item.id, el);
                                  else tlVideoRefs.current.delete(activeBaseEntry.item.id);
                                }}
                                src={activeBaseClip.url}
                                playsInline
                                style={subRectVideoStyle(activeBaseClip.meta, activeBaseEntry.item.crop)}
                              />
                            )}
                          </div>
                        )}
                        {tlLayout.tracks.slice(1).flatMap((trackLayout, ti) =>
                          trackLayout.items.map((entry, ii) => {
                            const entryClip = entry.clip;
                            if (!entry.item.rect || !entryClip) return null;
                            const trackIndex = ti + 1;
                            const isActive =
                              tlPlayheadSec >= entry.startSec && tlPlayheadSec < entry.startSec + entry.durationSec;
                            const isSelected = entry.item.id === selectedTlItemId;
                            return (
                              <div
                                key={entry.item.id}
                                className={`composite-tile tl-overlay-tile${isSelected ? " selected" : ""}`}
                                data-tl-stage-item={entry.item.id}
                                style={{
                                  ...tlPct(entry.item.rect),
                                  visibility: isActive ? "visible" : "hidden",
                                  opacity: clipFadeFactor(
                                    entry.item.fadeInSec,
                                    entry.item.fadeOutSec,
                                    tlPlayheadSec - entry.startSec,
                                    entry.durationSec,
                                  ),
                                  zIndex: trackIndex * 100 + ii,
                                }}
                                onPointerDown={(e) => {
                                  if (exporting) return;
                                  if (isSelected) {
                                    beginTlTileDrag(e, trackIndex, entry, "move");
                                  } else {
                                    setSelectedTlItemId(entry.item.id);
                                  }
                                }}
                                onPointerMove={onTlTileDragMove}
                                onPointerUp={endTlTileDrag}
                                onPointerCancel={endTlTileDrag}
                              >
                                {(entry.item.chromaKey ?? DEFAULT_CHROMA_KEY).enabled ? (
                                  <KeyedTileContent
                                    clip={entryClip}
                                    item={entry.item}
                                    registerVideo={(el) => {
                                      if (el) tlVideoRefs.current.set(entry.item.id, el);
                                      else tlVideoRefs.current.delete(entry.item.id);
                                    }}
                                  />
                                ) : entryClip.kind === "image" ? (
                                  <img
                                    src={entryClip.url}
                                    alt=""
                                    draggable={false}
                                    style={subRectVideoStyle(entryClip.meta, entry.item.crop)}
                                  />
                                ) : (
                                  <video
                                    ref={(el) => {
                                      if (el) tlVideoRefs.current.set(entry.item.id, el);
                                      else tlVideoRefs.current.delete(entry.item.id);
                                    }}
                                    src={entryClip.url}
                                    playsInline
                                    muted={!entryClip.meta.hasAudio || (entry.item.gain ?? 1) <= 0}
                                    style={subRectVideoStyle(entryClip.meta, entry.item.crop)}
                                  />
                                )}
                                {isSelected && (
                                  <div
                                    className="composite-tile-handle"
                                    onPointerDown={(e) => beginTlTileDrag(e, trackIndex, entry, "resize")}
                                    onPointerMove={onTlTileDragMove}
                                    onPointerUp={endTlTileDrag}
                                    onPointerCancel={endTlTileDrag}
                                  />
                                )}
                              </div>
                            );
                          }),
                        )}
                        {tlLayout.tracks.slice(1).flatMap((trackLayout, ti) =>
                          trackLayout.items.map((entry) => {
                            if (entry.item.kind !== "text") return null;
                            const trackIndex = ti + 1;
                            const isActive =
                              tlPlayheadSec >= entry.startSec && tlPlayheadSec < entry.startSec + entry.durationSec;
                            if (!isActive) return null;
                            const style = entry.item.textStyle ?? DEFAULT_TEXT_STYLE;
                            const stageH =
                              tlStageSize.h > 0
                                ? tlStageSize.h
                                : tlStageSize.w > 0
                                  ? (tlStageSize.w * timeline.outputHeight) / Math.max(1, timeline.outputWidth)
                                  : 0;
                            const fontPx = Math.max(4, (style.fontSizePct / 100) * stageH);
                            const outlinePx = Math.max(1, fontPx / 10);
                            const shadow = style.outline
                              ? `${outlinePx}px 0 0 #000, ${-outlinePx}px 0 0 #000, 0 ${outlinePx}px 0 #000, 0 ${-outlinePx}px 0 #000, ${outlinePx}px ${outlinePx}px 0 #000, ${-outlinePx}px ${-outlinePx}px 0 #000, ${outlinePx}px ${-outlinePx}px 0 #000, ${-outlinePx}px ${outlinePx}px 0 #000`
                              : undefined;
                            const posStyle: React.CSSProperties =
                              style.position === "top"
                                ? { top: "5%" }
                                : style.position === "center"
                                  ? { top: "50%", transform: "translateY(-50%)" }
                                  : { bottom: "5%" };
                            return (
                              <div
                                key={entry.item.id}
                                className="tl-stage-text"
                                data-tl-stage-text={entry.item.id}
                                style={{
                                  ...posStyle,
                                  fontSize: fontPx,
                                  color: style.color,
                                  textShadow: shadow,
                                  opacity: clipFadeFactor(
                                    entry.item.fadeInSec,
                                    entry.item.fadeOutSec,
                                    tlPlayheadSec - entry.startSec,
                                    entry.durationSec,
                                  ),
                                  zIndex: trackIndex * 100 + 99,
                                }}
                              >
                                {entry.item.text ?? ""}
                              </div>
                            );
                          }),
                        )}
                      </div>
                    </div>
                  ) : (
                  <div className="stage">
                    {clip.kind === "audio" ? (
                      <audio src={clip.url} controls preload="auto" />
                    ) : clip.kind === "image" ? (
                      <img src={clip.url} alt="" draggable={false} />
                    ) : (
                      <video ref={videoRef} src={clip.url} controls playsInline />
                    )}
                  </div>
                  )}
                </div>
                {tlHasItems && (
                  <div className="transport-row">
                    <Button
                      label={tlPlaying ? "Pause all" : "Play all"}
                      variant="primary"
                      onClick={toggleTlPlayback}
                      isDisabled={exporting || tlTotalSec <= 0}
                    />
                    <div className="transport-seek">
                      <SeekBar value={tlPlayheadSec} total={tlTotalSec} onSeek={seekTlTo} isDisabled={exporting} />
                    </div>
                  </div>
                )}
              </div>
            )}
              <div
                className="tl-strip"
                onDragEnter={(e) => {
                  const types = Array.from(e.dataTransfer.types);
                  if (types.includes(POOL_DRAG_TYPE) || types.includes(TL_ITEM_DRAG_TYPE)) setTlGhostVisible(true);
                }}
                onDragOver={(e) => {
                  const types = Array.from(e.dataTransfer.types);
                  if (types.includes(POOL_DRAG_TYPE) || types.includes(TL_ITEM_DRAG_TYPE)) setTlGhostVisible(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setTlGhostVisible(false);
                    setTlGhostHot(false);
                    setTlDropTarget(null);
                  }
                }}
                onDrop={() => {
                  setTlGhostVisible(false);
                  setTlGhostHot(false);
                  setTlDropTarget(null);
                }}
              >
                {tlAudioLayout.tracks.flatMap((trackLayout) =>
                  trackLayout.items.map((entry) =>
                    entry.clip ? (
                      <audio
                        key={entry.item.id}
                        ref={(el) => {
                          if (el) tlAudioRefs.current.set(entry.item.id, el);
                          else tlAudioRefs.current.delete(entry.item.id);
                        }}
                        src={entry.clip.url}
                        preload="auto"
                        data-tl-audio-element={entry.item.id}
                        style={{ display: "none" }}
                      />
                    ) : null,
                  ),
                )}
                {tlDropTarget === "ghost" && (
                  <div className="tl-ghost-pill">Drop here to start a new track</div>
                )}
                {tlGhostVisible && (
                  <div className="tl-row">
                    <div className="tl-row-label">New</div>
                    <div
                      className={`tl-row-track tl-ghost-track${tlGhostHot || tlDropTarget === "ghost" ? " hot" : ""}`}
                      data-tl-ghost="true"
                      onDragOver={(e) => {
                        const types = Array.from(e.dataTransfer.types);
                        if (types.includes(POOL_DRAG_TYPE) || types.includes(TL_ITEM_DRAG_TYPE)) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = types.includes(POOL_DRAG_TYPE) ? "copy" : "move";
                          setTlGhostHot(true);
                        }
                      }}
                      onDragLeave={() => setTlGhostHot(false)}
                      onDrop={(e) => {
                        const types = Array.from(e.dataTransfer.types);
                        if (types.includes(TL_ITEM_DRAG_TYPE)) {
                          const itemId = e.dataTransfer.getData(TL_ITEM_DRAG_TYPE);
                          if (!itemId) return;
                          e.preventDefault();
                          moveBaseItemToNewTrack(itemId);
                          return;
                        }
                        const droppedClipId =
                          e.dataTransfer.getData(POOL_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
                        if (!droppedClipId || !clipsRef.current.some((c) => c.id === droppedClipId)) return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const frac =
                          rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
                        addClipToNewTrack(droppedClipId, frac * tlTotalSec);
                      }}
                    >
                      <div className="tl-ghost-hint">Drop here to start a new track</div>
                    </div>
                  </div>
                )}
                {tlLayout.tracks
                  .slice()
                  .reverse()
                  .map((trackLayout) => {
                    const trackIndex = tlLayout.tracks.findIndex((t) => t.track.id === trackLayout.track.id);
                    return (
                      <div className="tl-row" key={trackLayout.track.id}>
                        <div className="tl-row-label">{trackIndex === 0 ? "V1 · Base" : `V${trackIndex + 1}`}</div>
                        <div
                          className={`tl-row-track${tlDropTarget === trackIndex ? " drop-target" : ""}`}
                          data-tl-row={trackIndex}
                          onPointerDown={(e) => {
                            if (exporting || tlTotalSec <= 0) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            if (rect.width === 0) return;
                            seekTlTo(((e.clientX - rect.left) / rect.width) * tlTotalSec);
                          }}
                          onDragOver={(e) => {
                            const types = Array.from(e.dataTransfer.types);
                            if (types.includes(POOL_DRAG_TYPE) || types.includes(TL_ITEM_DRAG_TYPE)) {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = types.includes(POOL_DRAG_TYPE) ? "copy" : "move";
                              if (types.includes(TL_ITEM_DRAG_TYPE)) setTlDropTarget(trackIndex);
                            }
                          }}
                          onDrop={(e) => {
                            const types = Array.from(e.dataTransfer.types);
                            const rowEl = e.currentTarget;
                            setTlDropTarget(null);
                            if (trackIndex === 0 && types.includes(TL_ITEM_DRAG_TYPE)) {
                              const itemId = e.dataTransfer.getData(TL_ITEM_DRAG_TYPE);
                              if (!itemId) return;
                              e.preventDefault();
                              reorderBaseItem(itemId, baseInsertIndex(rowEl, e.clientX));
                              return;
                            }
                            if (trackIndex > 0 && types.includes(TL_ITEM_DRAG_TYPE)) {
                              const itemId = e.dataTransfer.getData(TL_ITEM_DRAG_TYPE);
                              if (!itemId) return;
                              e.preventDefault();
                              moveBaseItemToTrack(itemId, trackIndex);
                              return;
                            }
                            if (types.includes(POOL_DRAG_TYPE)) {
                              const droppedClipId =
                                e.dataTransfer.getData(POOL_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
                              if (!droppedClipId || !clipsRef.current.some((c) => c.id === droppedClipId)) return;
                              e.preventDefault();
                              if (trackIndex === 0) {
                                addClipToBase(droppedClipId, baseInsertIndex(rowEl, e.clientX));
                              } else {
                                const rect = rowEl.getBoundingClientRect();
                                const frac =
                                  rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
                                addClipToOverlay(droppedClipId, trackIndex, frac * tlTotalSec);
                              }
                            }
                          }}
                        >
                          {trackIndex === 0 &&
                            trackLayout.items.map((entry) => {
                              const entryClip = entry.clip;
                              if (!entryClip) return null;
                              return (
                              <div
                                key={entry.item.id}
                                className={`tl-block${entry.item.id === selectedTlItemId ? " selected" : ""}`}
                                data-tl-block={entry.item.id}
                                data-tl-item={entry.item.id}
                                style={{ flexGrow: Math.max(entry.durationSec, 0.1), flexBasis: 0 }}
                                draggable={!exporting}
                                onDragStart={(e) => {
                                  e.dataTransfer.setData(TL_ITEM_DRAG_TYPE, entry.item.id);
                                  e.dataTransfer.effectAllowed = "move";
                                }}
                                onDragEnd={() => {
                                  setTlGhostVisible(false);
                                  setTlGhostHot(false);
                                  setTlDropTarget(null);
                                }}
                                onPointerDown={() => setSelectedTlItemId(entry.item.id)}
                                onClick={() => setSelectedTlItemId(entry.item.id)}
                                onDoubleClick={() => {
                                  setCropClipId(entryClip.id);
                                  setDrawerItemId(entry.item.id);
                                }}
                              >
                                <div className="tl-thumbs">
                                  {entryClip.kind === "image" ? (
                                    <img className="tl-block-img" src={entryClip.url} alt="" draggable={false} />
                                  ) : (
                                    (
                                      tlThumbs[`${entryClip.id}|${entry.item.trim.startSec}|${entry.item.trim.endSec}`] ??
                                      []
                                    ).map((src, i) => (
                                      <img key={i} src={src} alt="" draggable={false} />
                                    ))
                                  )}
                                </div>
                                <div className="tl-block-label">
                                  {entryClip.file.name} · {fmtSec(entry.durationSec)}
                                </div>
                                {(entry.item.fadeInSec ?? 0) > 0 && (
                                  <div
                                    className="tl-block-fade in"
                                    style={{ width: `${Math.min(100, ((entry.item.fadeInSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                                  />
                                )}
                                {(entry.item.fadeOutSec ?? 0) > 0 && (
                                  <div
                                    className="tl-block-fade out"
                                    style={{ width: `${Math.min(100, ((entry.item.fadeOutSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                                  />
                                )}
                                {entryClip.kind === "video" && (
                                  <div
                                    className="tl-block-edge left"
                                    data-tl-edge="start"
                                    onPointerDown={(e) => beginTlEdgeDrag(e, 0, entry, "start")}
                                    onPointerMove={onTlEdgeDragMove}
                                    onPointerUp={endTlEdgeDrag}
                                    onPointerCancel={endTlEdgeDrag}
                                  />
                                )}
                                <div
                                  className="tl-block-edge right"
                                  data-tl-edge="end"
                                  onPointerDown={(e) => beginTlEdgeDrag(e, 0, entry, "end")}
                                  onPointerMove={onTlEdgeDragMove}
                                  onPointerUp={endTlEdgeDrag}
                                  onPointerCancel={endTlEdgeDrag}
                                />
                                <button
                                  type="button"
                                  className="tl-block-remove"
                                  aria-label="Remove from timeline"
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeTlItem(0, entry.item.id);
                                  }}
                                >
                                  ×
                                </button>
                              </div>
                              );
                            })}
                          {trackIndex > 0 &&
                            trackLayout.items.map((entry) => {
                              const isSelected = entry.item.id === selectedTlItemId;
                              const blockStyle = {
                                left: `${tlTotalSec > 0 ? (entry.startSec / tlTotalSec) * 100 : 0}%`,
                                width: `${tlTotalSec > 0 ? (entry.durationSec / tlTotalSec) * 100 : 0}%`,
                              };
                              if (entry.item.kind === "text") {
                                const firstLine = (entry.item.text ?? "").split("\n")[0] || "Text";
                                return (
                                  <div
                                    key={entry.item.id}
                                    className={`tl-block tl-block-overlay tl-block-text${isSelected ? " selected" : ""}`}
                                    data-tl-block={entry.item.id}
                                    data-tl-item={entry.item.id}
                                    style={blockStyle}
                                    onPointerDown={(e) => beginTlBlockDrag(e, trackIndex, entry)}
                                    onClick={() => setSelectedTlItemId(entry.item.id)}
                                    onDoubleClick={() => {
                                      setCropClipId(null);
                                      setDrawerItemId(null);
                                      setDrawerTextItemId(entry.item.id);
                                    }}
                                    onPointerMove={onTlBlockDragMove}
                                    onPointerUp={endTlBlockDrag}
                                    onPointerCancel={endTlBlockDrag}
                                  >
                                    <div className="tl-thumbs">
                                      <span className="tl-text-glyph">
                                        <Type size={20} />
                                      </span>
                                    </div>
                                    <div className="tl-block-label">
                                      {firstLine} · {fmtSec(entry.durationSec)}
                                    </div>
                                    {(entry.item.fadeInSec ?? 0) > 0 && (
                                      <div
                                        className="tl-block-fade in"
                                        style={{ width: `${Math.min(100, ((entry.item.fadeInSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                                      />
                                    )}
                                    {(entry.item.fadeOutSec ?? 0) > 0 && (
                                      <div
                                        className="tl-block-fade out"
                                        style={{ width: `${Math.min(100, ((entry.item.fadeOutSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                                      />
                                    )}
                                    <div
                                      className="tl-block-edge left"
                                      data-tl-edge="start"
                                      onPointerDown={(e) => beginTlEdgeDrag(e, trackIndex, entry, "start")}
                                      onPointerMove={onTlEdgeDragMove}
                                      onPointerUp={endTlEdgeDrag}
                                      onPointerCancel={endTlEdgeDrag}
                                    />
                                    <div
                                      className="tl-block-edge right"
                                      data-tl-edge="end"
                                      onPointerDown={(e) => beginTlEdgeDrag(e, trackIndex, entry, "end")}
                                      onPointerMove={onTlEdgeDragMove}
                                      onPointerUp={endTlEdgeDrag}
                                      onPointerCancel={endTlEdgeDrag}
                                    />
                                    <button
                                      type="button"
                                      className="tl-block-remove"
                                      aria-label="Remove from timeline"
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        removeTlItem(trackIndex, entry.item.id);
                                      }}
                                    >
                                      ×
                                    </button>
                                  </div>
                                );
                              }
                              const entryClip = entry.clip;
                              if (!entryClip) return null;
                              return (
                                <div
                                  key={entry.item.id}
                                  className={`tl-block tl-block-overlay${isSelected ? " selected" : ""}`}
                                  data-tl-block={entry.item.id}
                                  data-tl-item={entry.item.id}
                                  style={blockStyle}
                                  onPointerDown={(e) => beginTlBlockDrag(e, trackIndex, entry)}
                                  onClick={() => setSelectedTlItemId(entry.item.id)}
                                  onDoubleClick={() => {
                                    setCropClipId(entryClip.id);
                                    setDrawerItemId(entry.item.id);
                                  }}
                                  onPointerMove={onTlBlockDragMove}
                                  onPointerUp={endTlBlockDrag}
                                  onPointerCancel={endTlBlockDrag}
                                >
                                  <div className="tl-thumbs">
                                    {entryClip.kind === "image" ? (
                                      <img className="tl-block-img" src={entryClip.url} alt="" draggable={false} />
                                    ) : (
                                      (
                                        tlThumbs[
                                          `${entryClip.id}|${entry.item.trim.startSec}|${entry.item.trim.endSec}`
                                        ] ?? []
                                      ).map((src, i) => (
                                        <img key={i} src={src} alt="" draggable={false} />
                                      ))
                                    )}
                                  </div>
                                  <div className="tl-block-label">
                                    {entryClip.file.name} · {fmtSec(entry.durationSec)}
                                  </div>
                                  {(entry.item.fadeInSec ?? 0) > 0 && (
                                    <div
                                      className="tl-block-fade in"
                                      style={{ width: `${Math.min(100, ((entry.item.fadeInSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                                    />
                                  )}
                                  {(entry.item.fadeOutSec ?? 0) > 0 && (
                                    <div
                                      className="tl-block-fade out"
                                      style={{ width: `${Math.min(100, ((entry.item.fadeOutSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                                    />
                                  )}
                                  <div
                                    className="tl-block-edge left"
                                    data-tl-edge="start"
                                    onPointerDown={(e) => beginTlEdgeDrag(e, trackIndex, entry, "start")}
                                    onPointerMove={onTlEdgeDragMove}
                                    onPointerUp={endTlEdgeDrag}
                                    onPointerCancel={endTlEdgeDrag}
                                  />
                                  <div
                                    className="tl-block-edge right"
                                    data-tl-edge="end"
                                    onPointerDown={(e) => beginTlEdgeDrag(e, trackIndex, entry, "end")}
                                    onPointerMove={onTlEdgeDragMove}
                                    onPointerUp={endTlEdgeDrag}
                                    onPointerCancel={endTlEdgeDrag}
                                  />
                                  <button
                                    type="button"
                                    className="tl-block-remove"
                                    aria-label="Remove from timeline"
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeTlItem(trackIndex, entry.item.id);
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                          {trackLayout.items.length === 0 && (
                            <div className="tl-row-empty">
                              {trackIndex === 0
                                ? "Drop media here."
                                : "Drop media here to overlay it."}
                            </div>
                          )}
                          {tlTotalSec > 0 && (
                            <div
                              className="tl-playhead"
                              style={{ left: `${(tlPlayheadSec / tlTotalSec) * 100}%` }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                {tlAudioLayout.tracks.map((trackLayout, trackIndex) => (
                  <div className="tl-row" key={trackLayout.track.id}>
                    <div className="tl-row-label">A{trackIndex + 1}</div>
                    <div
                      className={`tl-row-track tl-audio-row${tlAudioDropTarget === trackIndex ? " drop-target" : ""}`}
                      data-tl-audio-row={trackIndex}
                      onPointerDown={(e) => {
                        if (exporting || tlTotalSec <= 0) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        if (rect.width === 0) return;
                        seekTlTo(((e.clientX - rect.left) / rect.width) * tlTotalSec);
                      }}
                      onDragOver={(e) => {
                        const types = Array.from(e.dataTransfer.types);
                        if (types.includes(POOL_DRAG_TYPE)) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "copy";
                        }
                      }}
                      onDrop={(e) => {
                        const types = Array.from(e.dataTransfer.types);
                        if (!types.includes(POOL_DRAG_TYPE)) return;
                        const droppedClipId =
                          e.dataTransfer.getData(POOL_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
                        const dropped = clipsRef.current.find((c) => c.id === droppedClipId);
                        if (!dropped || dropped.kind !== "audio") return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const frac =
                          rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
                        addAudioClipToTrack(dropped.id, trackIndex, frac * tlTotalSec);
                      }}
                    >
                      {trackLayout.items.map((entry) => {
                        const entryClip = entry.clip;
                        if (!entryClip) return null;
                        const isSelected = entry.item.id === selectedTlItemId;
                        const blockStyle = {
                          left: `${tlTotalSec > 0 ? (entry.startSec / tlTotalSec) * 100 : 0}%`,
                          width: `${tlTotalSec > 0 ? (entry.durationSec / tlTotalSec) * 100 : 0}%`,
                        };
                        return (
                          <div
                            key={entry.item.id}
                            className={`tl-block tl-block-overlay tl-block-audio${isSelected ? " selected" : ""}`}
                            data-tl-block={entry.item.id}
                            data-tl-item={entry.item.id}
                            data-tl-audio-item={entry.item.id}
                            style={blockStyle}
                            onPointerDown={(e) => beginTlBlockDrag(e, trackIndex, entry, "audio")}
                            onClick={() => setSelectedTlItemId(entry.item.id)}
                            onPointerMove={onTlBlockDragMove}
                            onPointerUp={endTlBlockDrag}
                            onPointerCancel={endTlBlockDrag}
                          >
                            <WaveformCanvas
                              peaks={entryClip.waveformPeaks}
                              durationSec={entryClip.meta.durationSec}
                              trim={entry.item.trim}
                              className="tl-waveform"
                            />
                            <div className="tl-block-label">
                              {entryClip.file.name} · {fmtSec(entry.durationSec)} · {(entry.item.gain ?? 1).toFixed(2)}×
                            </div>
                            {(entry.item.fadeInSec ?? 0) > 0 && (
                              <div
                                className="tl-block-fade in"
                                style={{ width: `${Math.min(100, ((entry.item.fadeInSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                              />
                            )}
                            {(entry.item.fadeOutSec ?? 0) > 0 && (
                              <div
                                className="tl-block-fade out"
                                style={{ width: `${Math.min(100, ((entry.item.fadeOutSec ?? 0) / Math.max(entry.durationSec, 0.0001)) * 100)}%` }}
                              />
                            )}
                            <div
                              className="tl-block-edge left"
                              data-tl-edge="start"
                              onPointerDown={(e) => beginTlEdgeDrag(e, trackIndex, entry, "start", "audio")}
                              onPointerMove={onTlEdgeDragMove}
                              onPointerUp={endTlEdgeDrag}
                              onPointerCancel={endTlEdgeDrag}
                            />
                            <div
                              className="tl-block-edge right"
                              data-tl-edge="end"
                              onPointerDown={(e) => beginTlEdgeDrag(e, trackIndex, entry, "end", "audio")}
                              onPointerMove={onTlEdgeDragMove}
                              onPointerUp={endTlEdgeDrag}
                              onPointerCancel={endTlEdgeDrag}
                            />
                            <button
                              type="button"
                              className="tl-block-remove"
                              aria-label="Remove from timeline"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeAudioItem(trackIndex, entry.item.id);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      {trackLayout.items.length === 0 && (
                        <div className="tl-row-empty">Drop audio here.</div>
                      )}
                      {tlTotalSec > 0 && (
                        <div
                          className="tl-playhead"
                          style={{ left: `${(tlPlayheadSec / tlTotalSec) * 100}%` }}
                        />
                      )}
                    </div>
                  </div>
                ))}
                {(tlGhostVisible || tlAudioDropTarget === "ghost") && (
                  <div className="tl-row">
                    <div className="tl-row-label">New A</div>
                    <div
                      className={`tl-row-track tl-ghost-track tl-audio-ghost${tlAudioDropTarget === "ghost" ? " hot" : ""}`}
                      data-tl-audio-ghost="true"
                      onDragOver={(e) => {
                        const types = Array.from(e.dataTransfer.types);
                        if (types.includes(POOL_DRAG_TYPE)) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "copy";
                          setTlAudioDropTarget("ghost");
                        }
                      }}
                      onDragLeave={() => setTlAudioDropTarget(null)}
                      onDrop={(e) => {
                        const types = Array.from(e.dataTransfer.types);
                        if (!types.includes(POOL_DRAG_TYPE)) return;
                        const droppedClipId =
                          e.dataTransfer.getData(POOL_DRAG_TYPE) || e.dataTransfer.getData("text/plain");
                        const dropped = clipsRef.current.find((c) => c.id === droppedClipId);
                        if (!dropped || dropped.kind !== "audio") return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const frac =
                          rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
                        addAudioClipToNewTrack(dropped.id, frac * tlTotalSec);
                        setTlAudioDropTarget(null);
                      }}
                    >
                      <div className="tl-ghost-hint">Drop here to start a new audio track</div>
                    </div>
                  </div>
                )}
                {tlHasItems && (
                  <Text type="supporting">
                  {fmtSec(tlPlayheadSec)} / {fmtSec(tlTotalSec)} · Click a clip to select it; click a track to
                  seek. Drag base clips to reorder them; drag overlay clips sideways to move them in time, or
                  drag a video or image clip up or down to move it to another video track, and drag an audio
                  clip up or down between audio tracks. Drag a clip's edges to trim it (an
                  image or text clip's right edge sets its duration); double-click a clip to edit it.
                </Text>
                )}
              </div>
            {((clip && outRect) || tlHasItems) && (
              <div className="panel">
                {clip && (
                <div className="meta-row">
                  <Text type="supporting">File: {clip.file.name}</Text>
                  {clip.kind !== "audio" && (
                    <Text type="supporting">
                      Source: {clip.meta.width} × {clip.meta.height}
                    </Text>
                  )}
                  {clip.kind === "audio" ? (
                    <>
                      <Text type="supporting">Type: Audio</Text>
                      <Text type="supporting">Duration: {fmtDuration(clip.meta.durationSec)}</Text>
                      <Text type="supporting">Audio codec: {clip.meta.audioCodec ?? "unknown"}</Text>
                    </>
                  ) : clip.kind === "image" ? (
                    <Text type="supporting">Type: Image</Text>
                  ) : (
                    <>
                      <Text type="supporting">Duration: {fmtDuration(clip.meta.durationSec)}</Text>
                      <Text type="supporting">Video codec: {clip.meta.videoCodec ?? "unknown"}</Text>
                      <Text type="supporting">Audio: {clip.meta.hasAudio ? (clip.meta.audioCodec ?? "yes") : "none"}</Text>
                    </>
                  )}
                </div>
                )}
                <div className="export-section">
                  <Heading level={4}>Export</Heading>
                  <div className="export-controls">
                    <SegmentedControl
                      label="Export format"
                      value={timelineExporting ? "mp4" : exportFormat}
                      onChange={(value) => {
                        if (timelineExporting) {
                          setExportFormat("mp4");
                          return;
                        }
                        setExportFormat(value === "gif" ? "gif" : "mp4");
                      }}
                      isDisabled={exporting}
                    >
                      <SegmentedControlItem value="mp4" label="MP4" />
                      <SegmentedControlItem value="gif" label="GIF" isDisabled={timelineExporting || singleImageActive || singleAudioActive} />
                    </SegmentedControl>
                    {timelineExporting && <Text type="supporting">Timeline: MP4 only</Text>}
                    {singleImageActive && <Text type="supporting">Images are used on the timeline</Text>}
                    {singleAudioActive && <Text type="supporting">Audio is used on the timeline</Text>}
                    {exporting ? (
                      <Button
                        label="Cancel"
                        variant="secondary"
                        onClick={() => {
                          cancelRef.current = true;
                        }}
                      />
                    ) : (
                      <Button
                        label={!timelineExporting && exportFormat === "gif" ? "Export GIF" : "Export MP4"}
                        variant="primary"
                        onClick={() => void runExport()}
                        isDisabled={!supported || singleImageActive || singleAudioActive}
                      />
                    )}
                  </div>
                  {exportFormat === "gif" && !timelineExporting && outRect && (
                    <div className="gif-settings">
                      <Text type="supporting">Width</Text>
                      <SegmentedControl label="GIF width" value={gifWidth} onChange={setGifWidth} isDisabled={exporting}>
                        {GIF_WIDTHS.map((w) => (
                          <SegmentedControlItem key={w.value} value={w.value} label={w.label} />
                        ))}
                      </SegmentedControl>
                      <Text type="supporting">FPS</Text>
                      <SegmentedControl label="GIF frame rate" value={gifFps} onChange={setGifFps} isDisabled={exporting}>
                        {GIF_FPS_OPTIONS.map((f) => (
                          <SegmentedControlItem key={f.value} value={f.value} label={f.label} />
                        ))}
                      </SegmentedControl>
                      <Text type="supporting">
                        GIF: {gifOutputSize(outRect.width, outRect.height, gifWidth === "original" ? 0 : Number(gifWidth)).width} ×{" "}
                        {gifOutputSize(outRect.width, outRect.height, gifWidth === "original" ? 0 : Number(gifWidth)).height} · no
                        audio
                      </Text>
                      {selectionSec > 10 && (
                        <span className="gif-warning">
                          Selection is {fmtSec(selectionSec)} — longer than 10 seconds, so the GIF may get large.
                        </span>
                      )}
                    </div>
                  )}
                  {exporting && (
                    <div className="export-progress">
                      <ProgressBar
                        label="Export progress"
                        isLabelHidden
                        value={Math.round(progress * 100)}
                        max={100}
                        className="export-progress-bar"
                      />
                      <Text type="supporting">Exporting… {Math.round(progress * 100)}%</Text>
                    </div>
                  )}
                  {resultUrl && !exporting && (
                    <VStack gap={2}>
                      {resultFormat === "gif" ? (
                        <Text type="supporting">
                          Done. {usedCodec ?? "GIF"}
                          {" · "}
                          {fmtSize(resultSize)}
                        </Text>
                      ) : (
                        <Text type="supporting">
                          Done. Codec: {usedCodec ?? "unknown"}
                          {` · ${resultAudioText} · `}
                          {fmtSize(resultSize)}
                        </Text>
                      )}
                      <HStack gap={3}>
                        <a href={resultUrl} download={resultName}>
                          <Button label={`Download ${resultName}`} variant="secondary" />
                        </a>
                      </HStack>
                    </VStack>
                  )}
                </div>
                {timeline && (
                  <>
                    <HStack gap={3} vAlign="center">
                      {clip?.kind === "audio" ? (
                        <Button
                          label="Add to audio track"
                          variant="primary"
                          onClick={() => {
                            if (!clip) return;
                            if (timeline.audioTracks.length > 0) {
                              addAudioClipToTrack(clip.id, 0, tlGlobalRef.current);
                            } else {
                              addAudioClipToNewTrack(clip.id, tlGlobalRef.current);
                            }
                          }}
                          isDisabled={exporting || !clip}
                        />
                      ) : (
                        <Button
                          label="Add to timeline"
                          variant="primary"
                          onClick={() => clip && addClipToBase(clip.id)}
                          isDisabled={exporting || !clip}
                        />
                      )}
                      <Button label="Add track" variant="secondary" onClick={addTrack} isDisabled={exporting} />
                      <Button label="Add audio track" variant="secondary" onClick={addAudioTrack} isDisabled={exporting} />
                      <Button label="Add text" variant="secondary" onClick={addTextClip} isDisabled={exporting} />
                    </HStack>
                    <Text type="supporting">
                      Total duration: {fmtSec(tlTotalSec)} · {timeline.tracks.length + timeline.audioTracks.length} track
                      {timeline.tracks.length + timeline.audioTracks.length === 1 ? "" : "s"} · Export MP4 exports the whole
                      timeline. Base-track audio is copied as-is when nothing needs mixing; when audio clips
                      are present or overlay clips have audible audio, the base audio, overlay audio, and audio
                      clips are mixed at their gains.
                    </Text>
                    {(tlLayout.tracks[0]?.items.some((entry) => entry.clip?.meta.hasAudio) ||
                      tlLayout.tracks.slice(1).some((track) => track.items.some((entry) => entry.clip?.meta.hasAudio)) ||
                      tlAudioLayout.tracks.some((track) => track.items.length > 0)) && (
                      <div className="base-gain-row">
                        <Text type="supporting">Base audio gain</Text>
                        <div className="base-gain-slider">
                          <Slider
                            data-testid="base-audio-gain"
                            label="Base audio gain"
                            isLabelHidden
                            valueDisplay="none"
                            min={0}
                            max={2}
                            step={0.05}
                            value={timeline.baseAudioGain}
                            isDisabled={exporting}
                            onChange={(value: number) =>
                              setTimeline((prev) => (prev ? { ...prev, baseAudioGain: value } : prev))
                            }
                          />
                        </div>
                        <Text type="supporting">{timeline.baseAudioGain.toFixed(2)}×</Text>
                      </div>
                    )}
                    <div className="field-row">
                      <div className="field">
                        <NumberInput
                          id="timeline-output-width"
                          label="Output width"
                          min={16}
                          max={7680}
                          step={2}
                          value={timeline.outputWidth > 0 ? timeline.outputWidth : null}
                          isDisabled={exporting}
                          hasNumberSteppers
                          onChange={(value) => {
                            if (timeline.outputHeight > 0) applyTlOutputSize(value, timeline.outputHeight);
                          }}
                        />
                      </div>
                      <div className="field">
                        <NumberInput
                          id="timeline-output-height"
                          label="Output height"
                          min={16}
                          max={7680}
                          step={2}
                          value={timeline.outputHeight > 0 ? timeline.outputHeight : null}
                          isDisabled={exporting}
                          hasNumberSteppers
                          onChange={(value) => {
                            if (timeline.outputWidth > 0) applyTlOutputSize(timeline.outputWidth, value);
                          }}
                        />
                      </div>
                    </div>
                    <HStack gap={3} vAlign="center">
                      <Button label="1920 × 1080" variant="secondary" onClick={() => applyTlOutputSize(1920, 1080)} isDisabled={exporting} />
                      <Button label="1280 × 720" variant="secondary" onClick={() => applyTlOutputSize(1280, 720)} isDisabled={exporting} />
                      <Button label="854 × 480" variant="secondary" onClick={() => applyTlOutputSize(854, 480)} isDisabled={exporting} />
                      <Button
                        label="50%"
                        variant="secondary"
                        onClick={() => applyTlOutputSize(timeline.outputWidth / 2, timeline.outputHeight / 2)}
                        isDisabled={exporting || timeline.outputWidth <= 0}
                      />
                      <Button
                        label="25%"
                        variant="secondary"
                        onClick={() => applyTlOutputSize(timeline.outputWidth / 4, timeline.outputHeight / 4)}
                        isDisabled={exporting || timeline.outputWidth <= 0}
                      />
                    </HStack>
                    {isLargeTlCanvas && (
                      <Text type="supporting">
                        <span className="canvas-warning">Large canvas: encoding will be heavy and the file big.</span>
                      </Text>
                    )}
                    {tlLayout.tracks.map((trackLayout, trackIndex) => (
                      <div key={trackLayout.track.id} className="tl-track-group">
                        <HStack gap={3} vAlign="center">
                          <Text type="supporting">
                            {trackIndex === 0 ? "V1 · Base track" : `V${trackIndex + 1} · Overlay track`}
                          </Text>
                          {trackIndex > 0 && (
                            <Button
                              label="Remove track"
                              variant="secondary"
                              onClick={() => removeTrack(trackIndex)}
                              isDisabled={exporting}
                            />
                          )}
                        </HStack>
                        <div className="tile-list">
                          {trackLayout.items.map((entry) => (
                            <div className="tile-row" key={entry.item.id} data-tl-row-item={entry.item.id}>
                              <div className="tile-row-main">
                                <Text type="supporting">
                                  {entry.clip
                                    ? entry.clip.file.name
                                    : `${(entry.item.text ?? "").split("\n")[0] || "Text"} (text)`}
                                </Text>
                                <Text type="supporting">
                                  {trackIndex === 0
                                    ? `${fmtSec(entry.startSec)} – ${fmtSec(entry.startSec + entry.durationSec)} · ${fmtSec(entry.durationSec)}`
                                    : `Start ${fmtSec(entry.startSec)} · ${fmtSec(entry.durationSec)}`}
                                </Text>
                              </div>
                              <HStack gap={2} vAlign="center">
                                <Button
                                  label="Select"
                                  variant={entry.item.id === selectedTlItemId ? "primary" : "secondary"}
                                  onClick={() => setSelectedTlItemId(entry.item.id)}
                                  isDisabled={exporting}
                                />
                                <Button
                                  label="Remove"
                                  variant="secondary"
                                  onClick={() => removeTlItem(trackIndex, entry.item.id)}
                                  isDisabled={exporting}
                                />
                              </HStack>
                            </div>
                          ))}
                          {trackLayout.items.length === 0 && (
                            <Text type="supporting">No clips on this track yet.</Text>
                          )}
                        </div>
                      </div>
                    ))}
                    {tlAudioLayout.tracks.map((trackLayout, trackIndex) => (
                      <div key={trackLayout.track.id} className="tl-track-group">
                        <HStack gap={3} vAlign="center">
                          <Text type="supporting">A{trackIndex + 1} · Audio track</Text>
                          <Button
                            label="Remove track"
                            variant="secondary"
                            onClick={() => removeAudioTrack(trackIndex)}
                            isDisabled={exporting}
                          />
                        </HStack>
                        <div className="tile-list">
                          {trackLayout.items.map((entry) => (
                            <div className="tile-row" key={entry.item.id} data-audio-row-item={entry.item.id}>
                              <div className="tile-row-main">
                                <Text type="supporting">{entry.clip ? entry.clip.file.name : "Audio"}</Text>
                                <Text type="supporting">
                                  Start {fmtSec(entry.startSec)} · {fmtSec(entry.durationSec)} · Gain {(entry.item.gain ?? 1).toFixed(2)}×
                                </Text>
                              </div>
                              <HStack gap={2} vAlign="center">
                                <Button
                                  label="Select"
                                  variant={entry.item.id === selectedTlItemId ? "primary" : "secondary"}
                                  onClick={() => setSelectedTlItemId(entry.item.id)}
                                  isDisabled={exporting}
                                />
                                <Button
                                  label="Remove"
                                  variant="secondary"
                                  onClick={() => removeAudioItem(trackIndex, entry.item.id)}
                                  isDisabled={exporting}
                                />
                              </HStack>
                            </div>
                          ))}
                          {trackLayout.items.length === 0 && (
                            <Text type="supporting">No audio clips on this track yet.</Text>
                          )}
                        </div>
                      </div>
                    ))}
                    {selectedAudio && selectedAudio.entry.clip && (
                      <>
                        <Text type="supporting">
                          Selected audio clip: {selectedAudio.entry.clip.file.name} (A{selectedAudio.trackIndex + 1}) · Waveform trims with the clip
                        </Text>
                        <div className="field-row">
                          <div className="field">
                            <NumberInput
                              key={`${selectedAudio.entry.item.id}-start`}
                              id="audio-item-start"
                              label="Start (s)"
                              min={0}
                              step={0.1}
                              value={Math.round(selectedAudio.entry.startSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateAudioItem(selectedAudio.trackIndex, selectedAudio.entry.item.id, {
                                  startSec: Math.max(0, Math.round(value * 1000) / 1000),
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedAudio.entry.item.id}-trim-start`}
                              id="audio-item-trim-start"
                              label="Trim in (s)"
                              min={0}
                              max={selectedAudio.entry.clip.meta.durationSec}
                              step={0.1}
                              value={Math.round(selectedAudio.entry.item.trim.startSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                applyAudioItemTrim(selectedAudio.trackIndex, selectedAudio.entry, {
                                  ...selectedAudio.entry.item.trim,
                                  startSec: value,
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedAudio.entry.item.id}-trim-end`}
                              id="audio-item-trim-end"
                              label="Trim out (s)"
                              min={0}
                              max={selectedAudio.entry.clip.meta.durationSec}
                              step={0.1}
                              value={Math.round(selectedAudio.entry.item.trim.endSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                applyAudioItemTrim(selectedAudio.trackIndex, selectedAudio.entry, {
                                  ...selectedAudio.entry.item.trim,
                                  endSec: value,
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedAudio.entry.item.id}-gain`}
                              id="audio-item-gain"
                              label="Gain (0–2)"
                              min={0}
                              max={2}
                              step={0.05}
                              value={Math.round((selectedAudio.entry.item.gain ?? 1) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateAudioItem(selectedAudio.trackIndex, selectedAudio.entry.item.id, {
                                  gain: Math.max(0, Math.min(2, value)),
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedAudio.entry.item.id}-fade-in`}
                              id="audio-item-fade-in"
                              label="Fade in (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedAudio.entry.item.fadeInSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateAudioItem(selectedAudio.trackIndex, selectedAudio.entry.item.id, {
                                  fadeInSec: value,
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedAudio.entry.item.id}-fade-out`}
                              id="audio-item-fade-out"
                              label="Fade out (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedAudio.entry.item.fadeOutSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateAudioItem(selectedAudio.trackIndex, selectedAudio.entry.item.id, {
                                  fadeOutSec: value,
                                });
                              }}
                            />
                          </div>
                        </div>
                        <div className="base-gain-row">
                          <Text type="supporting">Clip gain</Text>
                          <div className="base-gain-slider">
                            <Slider
                              data-testid="audio-clip-gain"
                              label="Audio clip gain"
                              isLabelHidden
                              valueDisplay="none"
                              min={0}
                              max={2}
                              step={0.05}
                              value={selectedAudio.entry.item.gain ?? 1}
                              isDisabled={exporting}
                              onChange={(value: number) =>
                                updateAudioItem(selectedAudio.trackIndex, selectedAudio.entry.item.id, { gain: value })
                              }
                            />
                          </div>
                          <Text type="supporting">{(selectedAudio.entry.item.gain ?? 1).toFixed(2)}×</Text>
                        </div>
                        <Text type="supporting">
                          Drag the clip to move it, drag its edges to trim it, or drag it up or down to move it
                          to another audio track. Preview volume is capped at 1×; export uses the full gain.
                        </Text>
                      </>
                    )}
                    {selectedTl && selectedTl.entry.item.kind === "text" && (
                      <>
                        <Text type="supporting">
                          Selected text clip (V{selectedTl.trackIndex + 1}) · "
                          {(selectedTl.entry.item.text ?? "").split("\n")[0] || "Text"}"
                        </Text>
                        <div className="field-row">
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-duration`}
                              id="tl-text-duration"
                              label="Duration (s)"
                              min={0.1}
                              step={0.1}
                              value={Math.round(selectedTl.entry.durationSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                  durationSec: Math.max(0.1, Math.round(value * 1000) / 1000),
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-fade-in`}
                              id="tl-text-fade-in"
                              label="Fade in (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedTl.entry.item.fadeInSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { fadeInSec: value });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-fade-out`}
                              id="tl-text-fade-out"
                              label="Fade out (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedTl.entry.item.fadeOutSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { fadeOutSec: value });
                              }}
                            />
                          </div>
                        </div>
                        <HStack gap={3} vAlign="center">
                          <Button
                            label="Edit text"
                            variant="secondary"
                            onClick={() => {
                              setCropClipId(null);
                              setDrawerItemId(null);
                              setDrawerTextItemId(selectedTl.entry.item.id);
                            }}
                            isDisabled={exporting}
                          />
                        </HStack>
                        <Text type="supporting">
                          The text is shown while the playhead is inside this clip. Drag the clip to move it in
                          time, or drag its right edge to change its duration.
                        </Text>
                      </>
                    )}
                    {selectedTl && selectedTl.entry.clip?.kind === "image" && (
                      <>
                        <Text type="supporting">
                          Selected clip: {selectedTl.entry.clip.file.name} (V{selectedTl.trackIndex + 1}
                          {selectedTl.trackIndex === 0 ? " · Base" : ""}) · image
                        </Text>
                        <div className="field-row">
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-duration`}
                              id="tl-item-duration"
                              label="Duration (s)"
                              min={0.1}
                              step={0.1}
                              value={Math.round(selectedTl.entry.durationSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                  durationSec: Math.max(0.1, Math.round(value * 1000) / 1000),
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-fade-in`}
                              id="tl-item-fade-in"
                              label="Fade in (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedTl.entry.item.fadeInSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { fadeInSec: value });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-fade-out`}
                              id="tl-item-fade-out"
                              label="Fade out (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedTl.entry.item.fadeOutSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { fadeOutSec: value });
                              }}
                            />
                          </div>
                        </div>
                        <Text type="supporting">
                          The image is shown for this long. Drag the clip's right edge on the timeline to change
                          it, or double-click the clip to edit its crop.
                        </Text>
                      </>
                    )}
                    {selectedTl && selectedTl.entry.clip?.kind === "video" && (
                      <>
                        <Text type="supporting">
                          Selected clip: {selectedTl.entry.clip.file.name} (V{selectedTl.trackIndex + 1}
                          {selectedTl.trackIndex === 0 ? " · Base" : ""}) · item trim (source)
                        </Text>
                        <div className="field-row">
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-trim-start`}
                              id="tl-item-trim-start"
                              label="Start (s)"
                              min={0}
                              max={selectedTl.entry.clip.meta.durationSec}
                              step={0.1}
                              value={Math.round(selectedTl.entry.item.trim.startSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                applyItemTrim(selectedTl.trackIndex, selectedTl.entry, {
                                  ...selectedTl.entry.item.trim,
                                  startSec: value,
                                });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-trim-end`}
                              id="tl-item-trim-end"
                              label="End (s)"
                              min={0}
                              max={selectedTl.entry.clip.meta.durationSec}
                              step={0.1}
                              value={Math.round(selectedTl.entry.item.trim.endSec * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                applyItemTrim(selectedTl.trackIndex, selectedTl.entry, {
                                  ...selectedTl.entry.item.trim,
                                  endSec: value,
                                });
                              }}
                            />
                          </div>
                        </div>
                        <div className="field-row">
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-fade-in`}
                              id="tl-item-fade-in"
                              label="Fade in (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedTl.entry.item.fadeInSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { fadeInSec: value });
                              }}
                            />
                          </div>
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-fade-out`}
                              id="tl-item-fade-out"
                              label="Fade out (s)"
                              min={0}
                              step={0.1}
                              value={Math.round((selectedTl.entry.item.fadeOutSec ?? 0) * 100) / 100}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { fadeOutSec: value });
                              }}
                            />
                          </div>
                        </div>
                        <Text type="supporting">
                          Item duration: {fmtSec(selectedTl.entry.durationSec)} · Trimming an overlay's head
                          shifts it so the remaining content stays in place.
                        </Text>
                      </>
                    )}
                    {selectedTl && selectedTl.trackIndex > 0 && selectedTl.entry.item.rect && selectedTl.entry.clip && (
                      <>
                        <Text type="supporting">
                          Selected overlay: {selectedTl.entry.clip.file.name} (V{selectedTl.trackIndex + 1})
                        </Text>
                        <div className="field-row">
                          <div className="field">
                            <NumberInput
                              key={`${selectedTl.entry.item.id}-start`}
                              id="tl-item-start"
                              label="Start (s)"
                              min={0}
                              step={0.1}
                              value={Math.round(selectedTl.entry.item.startSec * 10) / 10}
                              isDisabled={exporting}
                              hasNumberSteppers
                              onChange={(value) => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                  startSec: Math.max(0, value),
                                });
                              }}
                            />
                          </div>
                          {(["x", "y", "width", "height"] as const).map((field) => (
                            <div className="field" key={field}>
                              <NumberInput
                                key={`${selectedTl.entry.item.id}-rect-${field}`}
                                id={`tl-rect-${field}`}
                                label={field === "width" ? "Width" : field === "height" ? "Height" : field.toUpperCase()}
                                min={0}
                                value={Math.round(selectedTl.entry.item.rect?.[field] ?? 0)}
                                isDisabled={exporting}
                                hasNumberSteppers
                                isIntegerOnly
                                onChange={(value) => {
                                  const rect = selectedTl.entry.item.rect;
                                  if (!rect) return;
                                  const nextRect = { ...rect, [field]: value };
                                  nextRect.width = Math.max(16, nextRect.width);
                                  nextRect.height = Math.max(16, nextRect.height);
                                  nextRect.x = Math.max(0, Math.min(nextRect.x, Math.max(0, timeline.outputWidth - 16)));
                                  nextRect.y = Math.max(0, Math.min(nextRect.y, Math.max(0, timeline.outputHeight - 16)));
                                  updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { rect: nextRect });
                                }}
                              />
                            </div>
                          ))}
                        </div>
                        {selectedTl.entry.clip.kind === "video" && selectedTl.entry.clip.meta.hasAudio && (
                          <>
                            <div className="field-row">
                              <div className="field">
                                <NumberInput
                                  key={`${selectedTl.entry.item.id}-gain`}
                                  id="overlay-item-gain"
                                  label="Gain (0–2)"
                                  min={0}
                                  max={2}
                                  step={0.05}
                                  value={Math.round((selectedTl.entry.item.gain ?? 1) * 100) / 100}
                                  isDisabled={exporting}
                                  hasNumberSteppers
                                  onChange={(value) => {
                                    updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                      gain: Math.max(0, Math.min(2, value)),
                                    });
                                  }}
                                />
                              </div>
                            </div>
                            <div className="base-gain-row">
                              <Text type="supporting">Clip gain</Text>
                              <div className="base-gain-slider">
                                <Slider
                                  data-testid="overlay-clip-gain"
                                  label="Overlay clip gain"
                                  isLabelHidden
                                  valueDisplay="none"
                                  min={0}
                                  max={2}
                                  step={0.05}
                                  value={selectedTl.entry.item.gain ?? 1}
                                  isDisabled={exporting}
                                  onChange={(value: number) =>
                                    updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, { gain: value })
                                  }
                                />
                              </div>
                              <Text type="supporting">{(selectedTl.entry.item.gain ?? 1).toFixed(2)}×</Text>
                            </div>
                            <Text type="supporting">
                              This clip's audio plays in the preview and is mixed into timeline exports at this
                              gain. Set it to 0 to keep the clip silent.
                            </Text>
                          </>
                        )}
                        {(selectedTl.entry.clip.kind === "video" || selectedTl.entry.clip.kind === "image") && (
                          <>
                            <HStack gap={3} vAlign="center">
                              <Switch
                                label="Chroma key"
                                value={selectedChromaKey.enabled}
                                onChange={(checked) => updateSelectedChromaKey({ enabled: checked })}
                              />
                              <input
                                id="chroma-color"
                                type="color"
                                aria-label="Chroma key color"
                                value={selectedChromaKey.color}
                                disabled={exporting}
                                onChange={(e) => updateSelectedChromaKey({ color: e.target.value })}
                              />
                            </HStack>
                            {selectedChromaKey.enabled && (
                              <>
                                <div className="field-row">
                                  <div className="field">
                                    <NumberInput
                                      key={`${selectedTl.entry.item.id}-chroma-tolerance`}
                                      id="chroma-tolerance"
                                      label="Tolerance (0–1)"
                                      min={0}
                                      max={1}
                                      step={0.05}
                                      value={Math.round(selectedChromaKey.tolerance * 100) / 100}
                                      isDisabled={exporting}
                                      hasNumberSteppers
                                      onChange={(value) => {
                                        updateSelectedChromaKey({
                                          tolerance: Math.max(0, Math.min(1, value)),
                                        });
                                      }}
                                    />
                                  </div>
                                  <div className="field">
                                    <NumberInput
                                      key={`${selectedTl.entry.item.id}-chroma-softness`}
                                      id="chroma-softness"
                                      label="Softness (0–1)"
                                      min={0}
                                      max={1}
                                      step={0.05}
                                      value={Math.round(selectedChromaKey.softness * 100) / 100}
                                      isDisabled={exporting}
                                      hasNumberSteppers
                                      onChange={(value) => {
                                        updateSelectedChromaKey({
                                          softness: Math.max(0, Math.min(1, value)),
                                        });
                                      }}
                                    />
                                  </div>
                                </div>
                                <div className="base-gain-row">
                                  <Text type="supporting">Tolerance</Text>
                                  <div className="base-gain-slider">
                                    <Slider
                                      data-testid="chroma-tolerance-slider"
                                      label="Chroma key tolerance"
                                      isLabelHidden
                                      valueDisplay="none"
                                      min={0}
                                      max={1}
                                      step={0.01}
                                      value={selectedChromaKey.tolerance}
                                      isDisabled={exporting}
                                      onChange={(value: number) => updateSelectedChromaKey({ tolerance: value })}
                                    />
                                  </div>
                                  <Text type="supporting">{selectedChromaKey.tolerance.toFixed(2)}</Text>
                                </div>
                                <div className="base-gain-row">
                                  <Text type="supporting">Softness</Text>
                                  <div className="base-gain-slider">
                                    <Slider
                                      data-testid="chroma-softness-slider"
                                      label="Chroma key softness"
                                      isLabelHidden
                                      valueDisplay="none"
                                      min={0}
                                      max={1}
                                      step={0.01}
                                      value={selectedChromaKey.softness}
                                      isDisabled={exporting}
                                      onChange={(value: number) => updateSelectedChromaKey({ softness: value })}
                                    />
                                  </div>
                                  <Text type="supporting">{selectedChromaKey.softness.toFixed(2)}</Text>
                                </div>
                                <Text type="supporting">
                                  Parts of this clip close to the key color become transparent, so the tracks
                                  below show through. Tolerance sets how close a color must be; softness feathers
                                  the edge.
                                </Text>
                              </>
                            )}
                          </>
                        )}
                        <HStack gap={3} vAlign="center">
                          <Button
                            label="Picture in picture"
                            variant="secondary"
                            onClick={() => {
                              const selClip = selectedTl.entry.clip;
                              if (!selClip) return;
                              updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                rect: pipItemRect(timeline.outputWidth, timeline.outputHeight, itemCropAspect(selectedTl.entry.item, selClip)),
                              });
                            }}
                            isDisabled={exporting}
                          />
                        </HStack>
                        <Text type="supporting">
                          Drag the selected overlay on the preview to move it, and use the corner handle to resize
                          it. Its size follows the item's crop aspect while dragging on the preview.
                        </Text>
                      </>
                    )}
                  </>
                )}
                {clip && !tlHasItems && clip.kind === "image" && (
                  <Text type="supporting">
                    This is an image. Images are used on the timeline: add it to the timeline, where each image
                    clip has its own crop and duration, then export the timeline as MP4.
                  </Text>
                )}
                {clip && outRect && !tlHasItems && clip.kind === "video" && (
                  <>
                    <Text type="supporting">
                      {isFullFrame
                        ? "Crop: full frame. Double-click the video in Media to edit its crop and trim."
                        : `Crop: ${Math.round(clip.crop.x)}, ${Math.round(clip.crop.y)} · ${outRect.width} × ${outRect.height}. Double-click the video in Media to edit its crop and trim.`}
                    </Text>
                    <Text type="supporting">
                      {trimIsFull
                        ? "Trim: full length."
                        : `Trim: ${fmtSec(clip.trim.startSec)} – ${fmtSec(clip.trim.endSec)} (${fmtSec(selectionSec)}). Timeline items keep their own trim.`}
                    </Text>
                    <Text type="supporting">
                      {`Output: ${outRect.width} × ${outRect.height} (adjusted to even numbers)`}
                    </Text>
                  </>
                )}
              </div>
            )}
          </VStack>
            </div>
          </div>
        </main>
      </div>
      <Drawer
        isOpen={cropClip !== null || drawerTextItem !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        label={cropClip ? `Edit ${cropClip.file.name}` : drawerTextItem ? "Edit text clip" : "Edit clip"}
        side="end"
        width={520}
        data-testid="crop-drawer"
      >
        {cropClip && cropOutRect && (
          <VStack gap={4}>
            <DrawerHeader
              title={cropClip.file.name}
              subtitle={cropClip.kind === "image" ? "Crop" : "Crop & trim"}
              onOpenChange={(open) => {
                if (!open) closeDrawer();
              }}
            />
            <div className="drawer-stage" ref={drawerStageRef}>
              {cropClip.kind === "image" ? (
                <img src={cropClip.url} alt="" draggable={false} />
              ) : (
                <video ref={drawerVideoRef} src={cropClip.url} controls playsInline />
              )}
              <div
                className="crop-rect"
                style={{
                  left: `${((drawerCropRect?.x ?? 0) / cropClip.meta.width) * 100}%`,
                  top: `${((drawerCropRect?.y ?? 0) / cropClip.meta.height) * 100}%`,
                  width: `${((drawerCropRect?.width ?? 0) / cropClip.meta.width) * 100}%`,
                  height: `${((drawerCropRect?.height ?? 0) / cropClip.meta.height) * 100}%`,
                }}
                onPointerDown={(e) => beginDrag(e, "move")}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {HANDLES.map((handle) => (
                  <div
                    key={handle}
                    className="crop-handle"
                    style={{ ...HANDLE_POS[handle], cursor: HANDLE_CURSOR[handle] }}
                    onPointerDown={(e) => beginDrag(e, handle)}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  />
                ))}
              </div>
            </div>
            <Text type="supporting">
              Crop — {drawerItem ? `timeline item (V${drawerItem.trackIndex + 1})` : "this video"}
            </Text>
            <SegmentedControl label="Aspect ratio" value={aspect} onChange={changeAspect} isDisabled={exporting}>
              {ASPECTS.map((a) => (
                <SegmentedControlItem key={a.value} value={a.value} label={a.label} />
              ))}
            </SegmentedControl>
            <div className="field-row">
              {(["x", "y", "width", "height"] as const).map((field) => (
                <div className="field" key={field}>
                  <NumberInput
                    key={`${drawerItem?.item.id ?? cropClip.id}-crop-${field}`}
                    id={`crop-${field}`}
                    label={field === "width" ? "Width" : field === "height" ? "Height" : field.toUpperCase()}
                    min={0}
                    value={Math.round(drawerCropRect?.[field] ?? 0)}
                    hasNumberSteppers
                    isIntegerOnly
                    onChange={(value) => updateField(field, value)}
                  />
                </div>
              ))}
            </div>
            <Text type="supporting">
              Output: {cropOutRect.width} × {cropOutRect.height} · Output size is adjusted to even numbers.
            </Text>
            <Text type="supporting">
              {drawerItem
                ? `This crop belongs to this timeline item only; the source ${cropClip.kind === "image" ? "image" : "video"}'s crop is unchanged.`
                : "Crop applies to all uses of this video."}
            </Text>
            {cropClip.kind === "image" && drawerItem && (
              <>
                <Text type="supporting">Duration — timeline item (V{drawerItem.trackIndex + 1})</Text>
                <div className="field-row">
                  <div className="field">
                    <NumberInput
                      key={`${drawerItem.item.id}-duration`}
                      id="drawer-item-duration"
                      label="Duration (s)"
                      min={0.1}
                      step={0.1}
                      value={Math.round((drawerItem.item.durationSec ?? DEFAULT_IMAGE_DURATION_SEC) * 100) / 100}
                      hasNumberSteppers
                      onChange={(value) => {
                        updateTlItem(drawerItem.trackIndex, drawerItem.item.id, {
                          durationSec: Math.max(0.1, Math.round(value * 1000) / 1000),
                        });
                      }}
                    />
                  </div>
                </div>
                <Text type="supporting">The image is shown for this long on the timeline.</Text>
              </>
            )}
            {cropClip.kind === "video" && (
              <>
            <Text type="supporting">
              Trim — {drawerItem ? `timeline item (V${drawerItem.trackIndex + 1})` : "this video"}
            </Text>
            <div className="field-row">
              <div className="field">
                <NumberInput
                  key={`${drawerItem?.item.id ?? cropClip.id}-trim-start`}
                  id="drawer-trim-start"
                  label="Start (s)"
                  min={0}
                  max={cropClip.meta.durationSec}
                  step={0.1}
                  value={Math.round(drawerTrim.startSec * 100) / 100}
                  hasNumberSteppers
                  onChange={(value) => updateDrawerTrimField("startSec", value)}
                />
              </div>
              <div className="field">
                <NumberInput
                  key={`${drawerItem?.item.id ?? cropClip.id}-trim-end`}
                  id="drawer-trim-end"
                  label="End (s)"
                  min={0}
                  max={cropClip.meta.durationSec}
                  step={0.1}
                  value={Math.round(drawerTrim.endSec * 100) / 100}
                  hasNumberSteppers
                  onChange={(value) => updateDrawerTrimField("endSec", value)}
                />
              </div>
            </div>
            <HStack gap={3} vAlign="center">
              <Button label="Set start to playhead" variant="secondary" onClick={() => setDrawerTrimToPlayhead("startSec")} isDisabled={exporting} />
              <Button label="Set end to playhead" variant="secondary" onClick={() => setDrawerTrimToPlayhead("endSec")} isDisabled={exporting} />
            </HStack>
            <Text type="supporting">
              Selection: {fmtSec(Math.max(0, drawerTrim.endSec - drawerTrim.startSec))} of{" "}
              {fmtSec(cropClip.meta.durationSec)}
            </Text>
            <Text type="supporting">
              {drawerItem
                ? "This trim belongs to this timeline item only; the source video's trim is unchanged. Trimming an overlay item's head shifts it so the remaining content stays in place."
                : "This is the video's default trim: used by single-clip export, and copied into new timeline items."}
            </Text>
              </>
            )}
          </VStack>
        )}
        {drawerTextItem && (
          <VStack gap={4}>
            <DrawerHeader
              title="Text clip"
              subtitle={`Timeline item (V${drawerTextItem.trackIndex + 1})`}
              onOpenChange={(open) => {
                if (!open) closeDrawer();
              }}
            />
            <TextArea
              label="Text"
              rows={3}
              value={drawerTextItem.item.text ?? ""}
              onChange={(value) => {
                updateTlItem(drawerTextItem.trackIndex, drawerTextItem.item.id, { text: value });
              }}
            />
            <div className="field-row">
              <div className="field">
                <NumberInput
                  key={`${drawerTextItem.item.id}-font-size`}
                  id="text-font-size"
                  label="Font size (% of height)"
                  min={2}
                  max={20}
                  step={0.5}
                  value={drawerTextStyle.fontSizePct}
                  hasNumberSteppers
                  onChange={(value) => {
                    updateDrawerTextStyle({ fontSizePct: Math.max(2, Math.min(20, value)) });
                  }}
                />
              </div>
              <div className="field">
                <label htmlFor="text-color">Color</label>
                <input
                  id="text-color"
                  type="color"
                  value={drawerTextStyle.color}
                  onChange={(e) => updateDrawerTextStyle({ color: e.target.value })}
                />
              </div>
              <div className="field">
                <NumberInput
                  key={`${drawerTextItem.item.id}-duration`}
                  id="text-duration"
                  label="Duration (s)"
                  min={0.1}
                  step={0.1}
                  value={Math.round((drawerTextItem.item.durationSec ?? DEFAULT_IMAGE_DURATION_SEC) * 100) / 100}
                  hasNumberSteppers
                  onChange={(value) => {
                    updateTlItem(drawerTextItem.trackIndex, drawerTextItem.item.id, {
                      durationSec: Math.max(0.1, Math.round(value * 1000) / 1000),
                    });
                  }}
                />
              </div>
            </div>
            <Switch
              label="Outline"
              value={drawerTextStyle.outline}
              onChange={(checked) => updateDrawerTextStyle({ outline: checked })}
            />
            <SegmentedControl
              label="Position"
              value={drawerTextStyle.position}
              onChange={(value) => updateDrawerTextStyle({ position: value as TextPosition })}
            >
              <SegmentedControlItem value="top" label="Top" />
              <SegmentedControlItem value="center" label="Center" />
              <SegmentedControlItem value="bottom" label="Bottom" />
            </SegmentedControl>
            <Text type="supporting">
              The text is drawn over the timeline while the playhead is inside this clip. Font size is relative
              to the output height.
            </Text>
          </VStack>
        )}
      </Drawer>
    </Theme>
  );
}
