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
import { FolderOpen } from "lucide-react";
import type { ActiveTool, AspectPreset, Clip, CropRect, LayoutState, LayoutTile, TileRect, TimelineItem, TimelineState, TimelineTrack, ToolId, TrimRange } from "./model";
import { clampOutputSize, containRect, droppedTileRect, evenRect, pipItemRect, pipRects, resizedTiles, sideBySideRects } from "./model";
import { ExportCancelledError, exportCropped, openInput, readMeta, webCodecsSupported } from "./exporter";
import { exportComposite } from "./compositeExporter";
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

interface TileDragState {
  tileId: string;
  mode: "move" | "resize";
  startClientX: number;
  startClientY: number;
  startRect: TileRect;
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

function subRectVideoStyle(clip: Clip): React.CSSProperties {
  const { meta } = clip;
  const crop = evenRect(clip.crop, meta.width, meta.height);
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

function baseVideoBoxStyle(clip: Clip, outputWidth: number, outputHeight: number): React.CSSProperties {
  if (!(outputWidth > 0) || !(outputHeight > 0)) return { inset: 0 };
  const crop = evenRect(clip.crop, clip.meta.width, clip.meta.height);
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

let tileIdCounter = 0;
function nextTileId(): string {
  tileIdCounter += 1;
  return `tile-${Date.now()}-${tileIdCounter}`;
}

let tlIdCounter = 0;
function nextTlId(prefix: string): string {
  tlIdCounter += 1;
  return `${prefix}-${Date.now()}-${tlIdCounter}`;
}

const TL_ITEM_DRAG_TYPE = "application/x-video-editor-tl-item";

interface TlItemLayout {
  item: TimelineItem;
  clip: Clip;
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
      const itemClip = clips.find((c) => c.id === item.clipId);
      if (!itemClip) continue;
      const durationSec = Math.max(0, item.trim.endSec - item.trim.startSec);
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
  const [activeTool, setActiveTool] = useState<ActiveTool>("none");
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
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [layoutPlaying, setLayoutPlaying] = useState(false);
  const [layoutPlayheadSec, setLayoutPlayheadSec] = useState(0);
  const [cropClipId, setCropClipId] = useState<string | null>(null);
  const [drawerItemId, setDrawerItemId] = useState<string | null>(null);
  const [outWText, setOutWText] = useState("");
  const [outHText, setOutHText] = useState("");
  const [timeline, setTimeline] = useState<TimelineState | null>(null);
  const [tlOutWText, setTlOutWText] = useState("");
  const [tlOutHText, setTlOutHText] = useState("");
  const [selectedTlItemId, setSelectedTlItemId] = useState<string | null>(null);
  const [tlGhostVisible, setTlGhostVisible] = useState(false);
  const [tlGhostHot, setTlGhostHot] = useState(false);
  const [tlPlaying, setTlPlaying] = useState(false);
  const [tlPlayheadSec, setTlPlayheadSec] = useState(0);
  const [tlThumbs, setTlThumbs] = useState<Record<string, string[]>>({});
  const [resultTimeline, setResultTimeline] = useState(false);
  const poolFileInputRef = useRef<HTMLInputElement | null>(null);
  const tileVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const layoutStageRef = useRef<HTMLDivElement | null>(null);
  const tileDragRef = useRef<TileDragState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const drawerStageRef = useRef<HTMLDivElement | null>(null);
  const drawerVideoRef = useRef<HTMLVideoElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cancelRef = useRef(false);
  const tlStateRef = useRef<TimelineState | null>(null);
  const tlPlayingRef = useRef(false);
  const tlGlobalRef = useRef(0);
  const tlVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
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
    startClientX: number;
    startSec: number;
    rowWidth: number;
    totalSec: number;
  } | null>(null);
  const tlEdgeDragRef = useRef<{
    itemId: string;
    trackIndex: number;
    edge: "start" | "end";
    startClientX: number;
    rowWidth: number;
    totalSec: number;
    origTrim: TrimRange;
    origStartSec: number;
    clipDurationSec: number;
  } | null>(null);
  const tlClockRef = useRef<number | null>(null);
  const tlThumbsPendingRef = useRef<Set<string>>(new Set());
  const supported = webCodecsSupported();

  const clip = clips.find((c) => c.id === activeClipId) ?? clips[0] ?? null;
  const cropClip = clips.find((c) => c.id === cropClipId) ?? null;
  const ratio = ASPECTS.find((a) => a.value === aspect)?.ratio ?? null;
  const layoutActive = activeTool === "layout";
  const timelineActive = activeTool === "timeline";
  const compositing = layout !== null && layout.tiles.length >= 2;
  const layoutRef = useRef<LayoutState | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  layoutRef.current = layout;
  clipsRef.current = clips;
  tlStateRef.current = timeline;

  useEffect(() => {
    if (layout) {
      setOutWText(String(layout.outputWidth));
      setOutHText(String(layout.outputHeight));
    }
  }, [layout?.outputWidth, layout?.outputHeight]);

  useEffect(() => {
    if (timeline) {
      setTlOutWText(timeline.outputWidth > 0 ? String(timeline.outputWidth) : "");
      setTlOutHText(timeline.outputHeight > 0 ? String(timeline.outputHeight) : "");
    }
  }, [timeline?.outputWidth, timeline?.outputHeight]);

  const setCrop = useCallback((crop: CropRect) => {
    setClips((prev) => prev.map((c) => (c.id === cropClipId ? { ...c, crop } : c)));
  }, [cropClipId]);

  const setClipTrim = useCallback((clipId: string, trim: TrimRange) => {
    setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, trim } : c)));
  }, []);

  const createClip = useCallback(async (file: File): Promise<Clip> => {
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      throw new Error(`"${file.name}" is not an MP4 file.`);
    }
    const input = await openInput(file);
    const meta = await readMeta(input);
    const url = URL.createObjectURL(file);
    return {
      id: nextClipId(),
      file,
      url,
      input,
      meta,
      crop: { x: 0, y: 0, width: meta.width, height: meta.height },
      trim: { startSec: 0, endSec: meta.durationSec },
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
        for (const file of files) {
          created.push(await createClip(file));
        }
        setClips((prev) => [...prev, ...created]);
        setActiveClipId((prev) => prev ?? created[0].id);
        if (clipsRef.current.length === 0) {
          setActiveTool("none");
          setAspect("free");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [createClip],
  );

  const loadFile = useCallback(
    async (file: File) => {
      await addFiles([file]);
    },
    [addFiles],
  );

  const removeClip = useCallback((clipId: string) => {
    const target = clipsRef.current.find((c) => c.id === clipId);
    if (target) {
      target.input.dispose();
      URL.revokeObjectURL(target.url);
    }
    setClips((prev) => prev.filter((c) => c.id !== clipId));
    setLayout((prev) => {
      if (!prev) return prev;
      const tiles = prev.tiles.filter((t) => t.clipId !== clipId);
      if (tiles.length === prev.tiles.length) return prev;
      if (tiles.length === 0) return null;
      const audioSourceClipId =
        prev.audioSourceClipId && tiles.some((t) => t.clipId === prev.audioSourceClipId)
          ? prev.audioSourceClipId
          : tiles[0].clipId;
      return { ...prev, tiles, audioSourceClipId };
    });
    setTimeline((prev) => {
      if (!prev) return prev;
      let changed = false;
      const tracks = prev.tracks.map((t) => {
        const items = t.items.filter((it) => it.clipId !== clipId);
        if (items.length !== t.items.length) changed = true;
        return { ...t, items };
      });
      return changed ? { ...prev, tracks } : prev;
    });
    setActiveClipId((prev) => {
      if (prev !== clipId) return prev;
      const remaining = clipsRef.current.filter((c) => c.id !== clipId);
      return remaining[0]?.id ?? null;
    });
    setCropClipId((prev) => (prev === clipId ? null : prev));
    setLayoutPlaying(false);
  }, []);

  const tlEntries = useCallback((): { tracks: TlTrackLayout[]; totalSec: number; baseEndSec: number } | null => {
    const tl = tlStateRef.current;
    if (!tl) return null;
    return layoutTimeline(tl, clipsRef.current);
  }, []);

  const syncTlVideos = useCallback(
    (globalSec: number, playing: boolean) => {
      const data = tlEntries();
      if (!data) return;
      data.tracks.forEach((trackLayout, trackIndex) => {
        if (trackIndex === 0) return;
        for (const entry of trackLayout.items) {
          const el = tlVideoRefs.current.get(entry.item.id);
          if (!el) continue;
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
      let global = tlGlobalRef.current + dt;
      if (global >= data.totalSec) {
        global = data.totalSec;
        tlGlobalRef.current = global;
        setTlPlayheadSec(global);
        syncTlVideos(global, false);
        for (const el of tlVideoRefs.current.values()) el.pause();
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
    if (!layoutActive) return;
    const lay = layoutRef.current;
    if (!lay || lay.tiles.length === 0) return;
    const masterTile = lay.tiles[0];
    const master = tileVideoRefs.current.get(masterTile.id);
    if (!master) return;
    const masterClip = clipsRef.current.find((c) => c.id === masterTile.clipId);
    if (!masterClip) return;
    const sync = () => {
      const currentLayout = layoutRef.current;
      if (!currentLayout) return;
      const masterOut = master.currentTime - masterClip.trim.startSec;
      setLayoutPlayheadSec(Math.max(0, masterOut));
      for (let i = 1; i < currentLayout.tiles.length; i++) {
        const tile = currentLayout.tiles[i];
        const el = tileVideoRefs.current.get(tile.id);
        const tileClip = clipsRef.current.find((c) => c.id === tile.clipId);
        if (!el || !tileClip) continue;
        const target = tileClip.trim.startSec + masterOut - tile.offsetSec;
        if (target < tileClip.trim.startSec) {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - tileClip.trim.startSec) > 0.05) el.currentTime = tileClip.trim.startSec;
          continue;
        }
        if (target > tileClip.trim.endSec) {
          if (!el.paused) el.pause();
          continue;
        }
        if (!master.paused) {
          if (el.paused) {
            void el.play().catch(() => undefined);
          } else if (Math.abs(el.currentTime - target) > 0.3) {
            el.currentTime = target;
          }
        }
      }
    };
    const pauseOthers = () => {
      const currentLayout = layoutRef.current;
      if (!currentLayout) return;
      for (let i = 1; i < currentLayout.tiles.length; i++) {
        const el = tileVideoRefs.current.get(currentLayout.tiles[i].id);
        if (el && !el.paused) el.pause();
      }
      setLayoutPlaying(false);
    };
    const onPlayMaster = () => setLayoutPlaying(true);
    master.addEventListener("timeupdate", sync);
    master.addEventListener("pause", pauseOthers);
    master.addEventListener("play", onPlayMaster);
    sync();
    return () => {
      master.removeEventListener("timeupdate", sync);
      master.removeEventListener("pause", pauseOthers);
      master.removeEventListener("play", onPlayMaster);
    };
  }, [layoutActive, layout?.tiles.map((t) => `${t.id}:${t.clipId}`).join("|")]);

  useEffect(() => {
    if (timelineActive) return;
    stopTlClock();
    tlPlayingRef.current = false;
    setTlPlaying(false);
    for (const el of tlVideoRefs.current.values()) el.pause();
  }, [timelineActive, stopTlClock]);

  useEffect(() => {
    if (!timelineActive || !timeline) return;
    const needed = new Map<string, { itemClip: Clip; trim: TrimRange }>();
    for (const track of timeline.tracks) {
      for (const item of track.items) {
        const itemClip = clips.find((c) => c.id === item.clipId);
        if (!itemClip) continue;
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
  }, [timelineActive, timeline, clips, tlThumbs]);

  const beginDrag = (event: React.PointerEvent, mode: "move" | Handle) => {
    if (!cropClip || exporting) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: { ...cropClip.crop },
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
    setCrop(clampCrop(next, cropClip.meta.width, cropClip.meta.height, ratio));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const toggleTool = (tool: ToolId) => {
    if (tool === "layout" || tool === "timeline") videoRef.current?.pause();
    const next: ActiveTool = activeTool === tool ? "none" : tool;
    if (next !== "layout") setLayoutPlaying(false);
    if (next === "timeline") {
      setTimeline((prev) => prev ?? { outputWidth: 0, outputHeight: 0, tracks: [{ id: nextTlId("track"), items: [] }] });
      tlGlobalRef.current = 0;
      setTlPlayheadSec(0);
    }
    setActiveTool(next);
  };

  const openDifferentFile = () => {
    setClips((prev) => {
      for (const old of prev) {
        old.input.dispose();
        URL.revokeObjectURL(old.url);
      }
      return [];
    });
    setActiveClipId(null);
    setCropClipId(null);
    setLayout(null);
    setLayoutPlaying(false);
    setTimeline(null);
    setSelectedTlItemId(null);
    setTlPlayheadSec(0);
    tlGlobalRef.current = 0;
    setTlThumbs({});
    setResultTimeline(false);
    setResultUrl(null);
    setActiveTool("none");
    setError(null);
    setNotice(null);
  };

  const clipCropAspect = useCallback((target: Clip): number => {
    const out = evenRect(target.crop, target.meta.width, target.meta.height);
    return out.height > 0 ? out.width / out.height : target.meta.width / target.meta.height;
  }, []);

  const placeClipOnCanvas = useCallback(
    (droppedClipId: string, clientX: number, clientY: number) => {
      const dropped = clipsRef.current.find((c) => c.id === droppedClipId);
      const active = clipsRef.current.find((c) => c.id === activeClipId) ?? clipsRef.current[0] ?? null;
      if (!dropped || !active) return;
      const stageEl = layoutStageRef.current ?? stageRef.current ?? stageWrapRef.current;
      const bounds = stageEl?.getBoundingClientRect();
      setLayout((prev) => {
        if (!prev) {
          const baseOut = evenRect(active.crop, active.meta.width, active.meta.height);
          const outputWidth = baseOut.width;
          const outputHeight = baseOut.height;
          const baseTile: LayoutTile = {
            id: nextTileId(),
            clipId: active.id,
            rect: { x: 0, y: 0, width: outputWidth, height: outputHeight },
            offsetSec: 0,
          };
          const tiles: LayoutTile[] = [baseTile];
          if (dropped.id !== active.id) {
            let centerX = outputWidth / 2;
            let centerY = outputHeight / 2;
            if (bounds && bounds.width > 0 && bounds.height > 0) {
              centerX = ((clientX - bounds.left) / bounds.width) * outputWidth;
              centerY = ((clientY - bounds.top) / bounds.height) * outputHeight;
            }
            const aspect = clipCropAspect(dropped);
            tiles.push({
              id: nextTileId(),
              clipId: dropped.id,
              rect: droppedTileRect(outputWidth, outputHeight, aspect, centerX, centerY),
              offsetSec: 0,
            });
          }
          return { outputWidth, outputHeight, tiles, audioSourceClipId: active.id };
        }
        let centerX = prev.outputWidth / 2;
        let centerY = prev.outputHeight / 2;
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          centerX = ((clientX - bounds.left) / bounds.width) * prev.outputWidth;
          centerY = ((clientY - bounds.top) / bounds.height) * prev.outputHeight;
        }
        const aspect = clipCropAspect(dropped);
        const tile: LayoutTile = {
          id: nextTileId(),
          clipId: dropped.id,
          rect: droppedTileRect(prev.outputWidth, prev.outputHeight, aspect, centerX, centerY),
          offsetSec: 0,
        };
        return { ...prev, tiles: [...prev.tiles, tile] };
      });
      setExportFormat("mp4");
      setActiveTool("layout");
      setLayoutPlaying(false);
    },
    [activeClipId, clipCropAspect],
  );

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
    placeClipOnCanvas(droppedId, event.clientX, event.clientY);
  };

  const updateTile = useCallback((tileId: string, patch: Partial<LayoutTile>) => {
    setLayout((prev) =>
      prev ? { ...prev, tiles: prev.tiles.map((t) => (t.id === tileId ? { ...t, ...patch } : t)) } : prev,
    );
  }, []);

  const removeTile = useCallback((tileId: string) => {
    setLayout((prev) => {
      if (!prev) return prev;
      const tiles = prev.tiles.filter((t) => t.id !== tileId);
      if (tiles.length === 0) return null;
      const audioSourceClipId =
        prev.audioSourceClipId && tiles.some((t) => t.clipId === prev.audioSourceClipId)
          ? prev.audioSourceClipId
          : tiles[0].clipId;
      return { ...prev, tiles, audioSourceClipId };
    });
    setLayoutPlaying(false);
  }, []);

  const moveTileOrder = useCallback((tileId: string, direction: 1 | -1) => {
    setLayout((prev) => {
      if (!prev) return prev;
      const index = prev.tiles.findIndex((t) => t.id === tileId);
      const swapWith = index + direction;
      if (index < 0 || swapWith < 0 || swapWith >= prev.tiles.length) return prev;
      const tiles = [...prev.tiles];
      const [moved] = tiles.splice(index, 1);
      tiles.splice(swapWith, 0, moved);
      return { ...prev, tiles };
    });
  }, []);

  const applyPreset = (preset: "side" | "pip") => {
    if (!layout || layout.tiles.length < 2) return;
    const first = clips.find((c) => c.id === layout.tiles[0].clipId);
    const second = clips.find((c) => c.id === layout.tiles[1].clipId);
    if (!first || !second) return;
    const firstOut = evenRect(first.crop, first.meta.width, first.meta.height);
    const secondOut = evenRect(second.crop, second.meta.width, second.meta.height);
    const pair =
      preset === "side"
        ? sideBySideRects(firstOut.width, firstOut.height, secondOut.width, secondOut.height)
        : pipRects(firstOut.width, firstOut.height, secondOut.width, secondOut.height);
    setLayout({
      ...layout,
      outputWidth: pair.outputWidth,
      outputHeight: pair.outputHeight,
      tiles: layout.tiles.map((tile, i) =>
        i === 0 ? { ...tile, rect: pair.rectA } : i === 1 ? { ...tile, rect: pair.rectB } : tile,
      ),
    });
  };

  const applyOutputSize = (newWidth: number, newHeight: number) => {
    if (!layout) return;
    const aspects = layout.tiles.map((tile) => {
      const target = clips.find((c) => c.id === tile.clipId);
      return target ? clipCropAspect(target) : 16 / 9;
    });
    const resized = resizedTiles(layout.tiles, aspects, newWidth, newHeight, layout.outputWidth, layout.outputHeight);
    setLayout({ ...layout, outputWidth: resized.outputWidth, outputHeight: resized.outputHeight, tiles: resized.tiles });
  };

  const commitOutputSize = (event?: React.FocusEvent<HTMLInputElement>) => {
    const next = event?.relatedTarget as HTMLElement | null;
    if (next && (next.id === "layout-output-width" || next.id === "layout-output-height")) return;
    if (!layout) return;
    const width = Number(outWText);
    const height = Number(outHText);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      applyOutputSize(width, height);
    } else {
      setOutWText(String(layout.outputWidth));
      setOutHText(String(layout.outputHeight));
    }
  };

  const updateTlItem = useCallback((trackIndex: number, itemId: string, patch: Partial<TimelineItem>) => {
    setTimeline((prev) =>
      prev
        ? {
            ...prev,
            tracks: prev.tracks.map((t, i) =>
              i === trackIndex ? { ...t, items: t.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) } : t,
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
    },
    [],
  );

  const addTrack = useCallback(() => {
    setTimeline((prev) =>
      prev ? { ...prev, tracks: [...prev.tracks, { id: nextTlId("track"), items: [] }] } : prev,
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

  const addClipToBase = useCallback((clipId: string, index?: number) => {
    const target = clipsRef.current.find((c) => c.id === clipId);
    if (!target) return;
    const sized = evenRect(target.crop, target.meta.width, target.meta.height);
    const item: TimelineItem = { id: nextTlId("tlitem"), clipId, startSec: 0, rect: null, trim: { ...target.trim } };
    setTimeline((prev) => {
      const base: TimelineState =
        prev ?? { outputWidth: 0, outputHeight: 0, tracks: [{ id: nextTlId("track"), items: [] }] };
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

  const addClipToOverlay = useCallback(
    (clipId: string, trackIndex: number, startSec: number) => {
      const target = clipsRef.current.find((c) => c.id === clipId);
      if (!target || trackIndex <= 0) return;
      const sized = evenRect(target.crop, target.meta.width, target.meta.height);
      const itemId = nextTlId("tlitem");
      setTimeline((prev) => {
        if (!prev || !prev.tracks[trackIndex]) return prev;
        const withSize =
          prev.outputWidth > 0 && prev.outputHeight > 0
            ? prev
            : { ...prev, outputWidth: sized.width, outputHeight: sized.height };
        const rect = pipItemRect(withSize.outputWidth, withSize.outputHeight, clipCropAspect(target));
        const item: TimelineItem = {
          id: itemId,
          clipId,
          startSec: Math.max(0, Math.round(startSec * 10) / 10),
          rect,
          trim: { ...target.trim },
        };
        return {
          ...withSize,
          tracks: withSize.tracks.map((t, i) => (i === trackIndex ? { ...t, items: [...t.items, item] } : t)),
        };
      });
      setSelectedTlItemId(itemId);
    },
    [clipCropAspect],
  );

  const addClipToNewTrack = useCallback(
    (clipId: string, startSec: number) => {
      const target = clipsRef.current.find((c) => c.id === clipId);
      if (!target) return;
      const sized = evenRect(target.crop, target.meta.width, target.meta.height);
      const itemId = nextTlId("tlitem");
      setTimeline((prev) => {
        const base: TimelineState =
          prev ?? { outputWidth: 0, outputHeight: 0, tracks: [{ id: nextTlId("track"), items: [] }] };
        const withSize =
          base.outputWidth > 0 && base.outputHeight > 0
            ? base
            : { ...base, outputWidth: sized.width, outputHeight: sized.height };
        const rect = pipItemRect(withSize.outputWidth, withSize.outputHeight, clipCropAspect(target));
        const item: TimelineItem = {
          id: itemId,
          clipId,
          startSec: Math.max(0, Math.round(startSec * 10) / 10),
          rect,
          trim: { ...target.trim },
        };
        return { ...withSize, tracks: [...withSize.tracks, { id: nextTlId("track"), items: [item] }] };
      });
      setSelectedTlItemId(itemId);
    },
    [clipCropAspect],
  );

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
        aspects.push(target ? clipCropAspect(target) : 16 / 9);
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

  const commitTlOutputSize = (event?: React.FocusEvent<HTMLInputElement>) => {
    const next = event?.relatedTarget as HTMLElement | null;
    if (next && (next.id === "timeline-output-width" || next.id === "timeline-output-height")) return;
    if (!timeline) return;
    const width = Number(tlOutWText);
    const height = Number(tlOutHText);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      applyTlOutputSize(width, height);
    } else {
      setTlOutWText(timeline.outputWidth > 0 ? String(timeline.outputWidth) : "");
      setTlOutHText(timeline.outputHeight > 0 ? String(timeline.outputHeight) : "");
    }
  };

  const baseInsertIndex = (rowEl: HTMLElement, clientX: number): number => {
    const blocks = Array.from(rowEl.querySelectorAll("[data-tl-block]"));
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return blocks.length;
  };

  const beginTlBlockDrag = (event: React.PointerEvent, trackIndex: number, entry: TlItemLayout) => {
    if (exporting) return;
    event.stopPropagation();
    setSelectedTlItemId(entry.item.id);
    const rowEl = (event.currentTarget as HTMLElement).closest(".tl-row-track") as HTMLElement | null;
    tlBlockDragRef.current = {
      itemId: entry.item.id,
      trackIndex,
      startClientX: event.clientX,
      startSec: entry.item.startSec,
      rowWidth: rowEl?.getBoundingClientRect().width ?? 0,
      totalSec: tlTotalSec,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onTlBlockDragMove = (event: React.PointerEvent) => {
    const drag = tlBlockDragRef.current;
    if (!drag || drag.rowWidth <= 0 || drag.totalSec <= 0) return;
    const dxSec = ((event.clientX - drag.startClientX) / drag.rowWidth) * drag.totalSec;
    const next = Math.max(0, Math.round((drag.startSec + dxSec) * 10) / 10);
    updateTlItem(drag.trackIndex, drag.itemId, { startSec: next });
  };

  const endTlBlockDrag = () => {
    tlBlockDragRef.current = null;
  };

  const applyItemTrim = useCallback(
    (trackIndex: number, entry: TlItemLayout, nextRaw: TrimRange) => {
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

  const beginTlEdgeDrag = (event: React.PointerEvent, trackIndex: number, entry: TlItemLayout, edge: "start" | "end") => {
    if (exporting) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedTlItemId(entry.item.id);
    const rowEl = (event.currentTarget as HTMLElement).closest(".tl-row-track") as HTMLElement | null;
    tlEdgeDragRef.current = {
      itemId: entry.item.id,
      trackIndex,
      edge,
      startClientX: event.clientX,
      rowWidth: rowEl?.getBoundingClientRect().width ?? 0,
      totalSec: tlTotalSec,
      origTrim: { ...entry.item.trim },
      origStartSec: entry.item.startSec,
      clipDurationSec: entry.clip.meta.durationSec,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onTlEdgeDragMove = (event: React.PointerEvent) => {
    const drag = tlEdgeDragRef.current;
    if (!drag || drag.rowWidth <= 0 || drag.totalSec <= 0) return;
    const dxSec = ((event.clientX - drag.startClientX) / drag.rowWidth) * drag.totalSec;
    const nextRaw =
      drag.edge === "start"
        ? { ...drag.origTrim, startSec: drag.origTrim.startSec + dxSec }
        : { ...drag.origTrim, endSec: drag.origTrim.endSec + dxSec };
    const clamped = clampTrim(nextRaw, drag.clipDurationSec);
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
    if (baseEntry) {
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
    if (!timeline || exporting || !timelineActive || !entry.item.rect) return;
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
      const aspect = entry ? clipCropAspect(entry.clip) : 16 / 9;
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

  const beginTileDrag = (event: React.PointerEvent, tileId: string, mode: "move" | "resize") => {
    if (!layout || exporting || !layoutActive) return;
    const tile = layout.tiles.find((t) => t.id === tileId);
    if (!tile) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    tileDragRef.current = {
      tileId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: { ...tile.rect },
    };
  };

  const onTileDragMove = (event: React.PointerEvent) => {
    const drag = tileDragRef.current;
    const stage = layoutStageRef.current;
    if (!drag || !layout || !stage) return;
    const tile = layout.tiles.find((t) => t.id === drag.tileId);
    if (!tile) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0) return;
    const scale = layout.outputWidth / rect.width;
    const dx = (event.clientX - drag.startClientX) * scale;
    const dy = (event.clientY - drag.startClientY) * scale;
    const s = drag.startRect;
    let next: TileRect;
    if (drag.mode === "move") {
      next = {
        ...s,
        x: Math.max(0, Math.min(s.x + dx, layout.outputWidth - s.width)),
        y: Math.max(0, Math.min(s.y + dy, layout.outputHeight - s.height)),
      };
    } else {
      const tileClip = clips.find((c) => c.id === tile.clipId);
      const aspect = tileClip ? clipCropAspect(tileClip) : 16 / 9;
      let width = Math.max(32, Math.min(s.width + dx, layout.outputWidth - s.x));
      let height = width / aspect;
      if (s.y + height > layout.outputHeight) {
        height = Math.max(16, layout.outputHeight - s.y);
        width = height * aspect;
      }
      next = { ...s, width, height };
    }
    updateTile(drag.tileId, { rect: next });
  };

  const endTileDrag = () => {
    tileDragRef.current = null;
  };

  const toggleLayoutPlayback = () => {
    if (!layout || layout.tiles.length === 0) return;
    const masterTile = layout.tiles[0];
    const master = tileVideoRefs.current.get(masterTile.id);
    const masterClip = clips.find((c) => c.id === masterTile.clipId);
    if (!master || !masterClip) return;
    if (layoutPlaying) {
      for (const tile of layout.tiles) {
        tileVideoRefs.current.get(tile.id)?.pause();
      }
      setLayoutPlaying(false);
      return;
    }
    const masterOut = master.currentTime - masterClip.trim.startSec;
    for (let i = 1; i < layout.tiles.length; i++) {
      const tile = layout.tiles[i];
      const el = tileVideoRefs.current.get(tile.id);
      const tileClip = clips.find((c) => c.id === tile.clipId);
      if (!el || !tileClip) continue;
      const target = tileClip.trim.startSec + masterOut - tile.offsetSec;
      el.currentTime = Math.max(tileClip.trim.startSec, Math.min(tileClip.trim.endSec, target));
      if (target >= tileClip.trim.startSec && target <= tileClip.trim.endSec) {
        void el.play().catch(() => undefined);
      }
    }
    void master.play().catch(() => undefined);
    setLayoutPlaying(true);
  };

  const seekLayoutTo = useCallback((globalSec: number) => {
    const lay = layoutRef.current;
    if (!lay || lay.tiles.length === 0) return;
    const clipsNow = clipsRef.current;
    const total = lay.tiles.reduce((max, tile) => {
      const tileClip = clipsNow.find((c) => c.id === tile.clipId);
      if (!tileClip) return max;
      return Math.max(max, tile.offsetSec + Math.max(0, tileClip.trim.endSec - tileClip.trim.startSec));
    }, 0);
    const g = Math.max(0, Math.min(total, globalSec));
    setLayoutPlayheadSec(g);
    const masterTile = lay.tiles[0];
    const masterClip = clipsNow.find((c) => c.id === masterTile.clipId);
    const master = tileVideoRefs.current.get(masterTile.id);
    const playing = master ? !master.paused : false;
    if (master && masterClip) {
      const target = Math.max(
        masterClip.trim.startSec,
        Math.min(masterClip.trim.endSec, masterClip.trim.startSec + g),
      );
      if (Math.abs(master.currentTime - target) > 0.02) master.currentTime = target;
      if (playing && master.paused) void master.play().catch(() => undefined);
    }
    for (let i = 1; i < lay.tiles.length; i++) {
      const tile = lay.tiles[i];
      const el = tileVideoRefs.current.get(tile.id);
      const tileClip = clipsNow.find((c) => c.id === tile.clipId);
      if (!el || !tileClip) continue;
      const local = g - tile.offsetSec;
      if (local < 0) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - tileClip.trim.startSec) > 0.02) el.currentTime = tileClip.trim.startSec;
        continue;
      }
      if (local > tileClip.trim.endSec - tileClip.trim.startSec) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - tileClip.trim.endSec) > 0.02) el.currentTime = tileClip.trim.endSec;
        continue;
      }
      const target = tileClip.trim.startSec + local;
      if (Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
      if (playing && el.paused) void el.play().catch(() => undefined);
    }
  }, []);

  const changeAspect = (value: string) => {
    const preset = (ASPECTS.find((a) => a.value === value)?.value ?? "free") as AspectPreset;
    setAspect(preset);
    if (!cropClip) return;
    const r = ASPECTS.find((a) => a.value === preset)?.ratio ?? null;
    if (!r) return;
    const c = cropClip.crop;
    let width = c.width;
    let height = width / r;
    if (height > cropClip.meta.height) {
      height = cropClip.meta.height;
      width = height * r;
    }
    const x = Math.max(0, Math.min(c.x + (c.width - width) / 2, cropClip.meta.width - width));
    const y = Math.max(0, Math.min(c.y + (c.height - height) / 2, cropClip.meta.height - height));
    setCrop({ x, y, width, height });
  };

  const updateField = (field: keyof CropRect, raw: string) => {
    if (!cropClip) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setCrop(clampCrop({ ...cropClip.crop, [field]: value }, cropClip.meta.width, cropClip.meta.height, ratio));
  };

  const runExport = async () => {
    if (!clip || exporting) return;
    if (!supported) {
      setError("WebCodecs is not available in this context. Open this page via localhost or HTTPS in Chrome or Edge.");
      return;
    }
    setError(null);
    setNotice(null);
    setResultUrl(null);
    setUsedCodec(null);
    setAudioCopied(null);
    cancelRef.current = false;
    setProgress(0);
    setExporting(true);
    try {
      const out = evenRect(clip.crop, clip.meta.width, clip.meta.height);
      let blob: Blob;
      let suggested: string;
      let pickerType: { description: string; accept: Record<string, string[]> };
      const tlData = timeline ? layoutTimeline(timeline, clips) : null;
      const tlExportReady =
        timelineActive &&
        timeline !== null &&
        tlData !== null &&
        tlData.tracks.some((t) => t.items.length > 0) &&
        timeline.outputWidth > 0;
      if (tlExportReady && timeline && tlData) {
        const baseSpecs = tlData.tracks[0].items.map((entry) => ({
          input: entry.clip.input,
          trim: entry.item.trim,
          crop: evenRect(entry.clip.crop, entry.clip.meta.width, entry.clip.meta.height),
        }));
        const overlaySpecs = [];
        for (let ti = 1; ti < tlData.tracks.length; ti++) {
          for (const entry of tlData.tracks[ti].items) {
            if (!entry.item.rect) continue;
            overlaySpecs.push({
              input: entry.clip.input,
              trim: entry.item.trim,
              crop: evenRect(entry.clip.crop, entry.clip.meta.width, entry.clip.meta.height),
              startSec: entry.startSec,
              rect: entry.item.rect,
            });
          }
        }
        const res = await exportTimeline({
          base: baseSpecs,
          overlays: overlaySpecs,
          outputWidth: timeline.outputWidth,
          outputHeight: timeline.outputHeight,
          onProgress: (value) => setProgress(value),
          isCancelled: () => cancelRef.current,
        });
        blob = res.blob;
        setUsedCodec(
          `${res.codecLabel} · timeline ${timeline.outputWidth} × ${timeline.outputHeight} · ${timeline.tracks.length} track${timeline.tracks.length === 1 ? "" : "s"} · ${fmtSec(res.outputDurationSec)}`,
        );
        setAudioCopied(res.audioCopied);
        setResultFormat("mp4");
        setResultTimeline(true);
        suggested = `${clip.file.name.replace(/\.mp4$/i, "")}-timeline.mp4`;
        pickerType = { description: "MP4 video", accept: { "video/mp4": [".mp4"] } };
      } else if (exportFormat === "gif" && !compositing) {
        const res = await exportGif({
          input: clip.input,
          crop: out,
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
      } else if (compositing && layout) {
        const tileSpecs = [];
        for (const tile of layout.tiles) {
          const tileClip = clips.find((c) => c.id === tile.clipId);
          if (!tileClip) throw new Error("A tile's video is missing from the media pool.");
          tileSpecs.push({
            input: tileClip.input,
            trim: tileClip.trim,
            crop: evenRect(tileClip.crop, tileClip.meta.width, tileClip.meta.height),
            rect: tile.rect,
            offsetSec: tile.offsetSec,
          });
        }
        let audio = null;
        if (layout.audioSourceClipId) {
          const audioTileIndex = layout.tiles.findIndex((t) => t.clipId === layout.audioSourceClipId);
          const audioClip = clips.find((c) => c.id === layout.audioSourceClipId);
          if (audioTileIndex >= 0 && audioClip) {
            audio = {
              input: audioClip.input,
              trim: audioClip.trim,
              offsetSec: layout.tiles[audioTileIndex].offsetSec,
            };
          }
        }
        const res = await exportComposite({
          tiles: tileSpecs,
          outputWidth: layout.outputWidth,
          outputHeight: layout.outputHeight,
          audio,
          onProgress: (value) => setProgress(value),
          isCancelled: () => cancelRef.current,
        });
        blob = res.blob;
        setUsedCodec(`${res.codecLabel} · composite ${layout.outputWidth} × ${layout.outputHeight} · ${layout.tiles.length} tiles`);
        setAudioCopied(res.audioCopied);
        setResultFormat("mp4");
        setResultTimeline(false);
        suggested = `${clip.file.name.replace(/\.mp4$/i, "")}-edited.mp4`;
        pickerType = { description: "MP4 video", accept: { "video/mp4": [".mp4"] } };
      } else {
        const res = await exportCropped({
          input: clip.input,
          crop: out,
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
  const cropOutRect = cropClip ? evenRect(cropClip.crop, cropClip.meta.width, cropClip.meta.height) : null;
  const trimIsFull =
    clip !== null && clip.trim.startSec <= 0.01 && clip.trim.endSec >= clip.meta.durationSec - 0.01;
  const selectionSec = clip ? Math.max(0, clip.trim.endSec - clip.trim.startSec) : 0;
  const layoutDurationSec = layout
    ? layout.tiles.reduce((max, tile) => {
        const tileClip = clips.find((c) => c.id === tile.clipId);
        if (!tileClip) return max;
        return Math.max(max, tile.offsetSec + Math.max(0, tileClip.trim.endSec - tileClip.trim.startSec));
      }, 0)
    : 0;
  const outputDurationSec = compositing ? layoutDurationSec : selectionSec;
  const tileCss = (rect: TileRect): React.CSSProperties =>
    layout
      ? {
          left: `${(rect.x / layout.outputWidth) * 100}%`,
          top: `${(rect.y / layout.outputHeight) * 100}%`,
          width: `${(rect.width / layout.outputWidth) * 100}%`,
          height: `${(rect.height / layout.outputHeight) * 100}%`,
        }
      : {};
  const audioSourceName = layout?.audioSourceClipId
    ? (clips.find((c) => c.id === layout.audioSourceClipId)?.file.name ?? null)
    : null;
  const resultAudioText = resultTimeline
    ? audioCopied
      ? "Audio copied without re-encoding (base track)"
      : "No audio track"
    : compositing
      ? audioCopied
        ? "Audio copied without re-encoding"
        : !audioSourceName
          ? "No audio track (source: None)"
          : "Audio could not be copied"
      : clip && clip.meta.hasAudio
        ? audioCopied
          ? "Audio copied without re-encoding"
          : "Audio could not be copied"
        : "No audio track";
  const isLargeCanvas =
    layout !== null && (layout.outputWidth > 3840 || layout.outputWidth * layout.outputHeight > 8_300_000);
  const isFullFrame =
    clip !== null &&
    Math.round(clip.crop.x) === 0 &&
    Math.round(clip.crop.y) === 0 &&
    Math.round(clip.crop.width) === clip.meta.width &&
    Math.round(clip.crop.height) === clip.meta.height;
  const tlLayout = timeline ? layoutTimeline(timeline, clips) : null;
  const tlTotalSec = tlLayout?.totalSec ?? 0;
  const timelineExporting =
    timelineActive &&
    timeline !== null &&
    tlLayout !== null &&
    tlLayout.tracks.some((t) => t.items.length > 0) &&
    timeline.outputWidth > 0;
  const activeBaseEntry = (() => {
    if (!tlLayout || tlLayout.tracks.length === 0) return null;
    const baseItems = tlLayout.tracks[0].items;
    const found = baseItems.find((e) => tlPlayheadSec >= e.startSec && tlPlayheadSec < e.startSec + e.durationSec);
    if (found) return found;
    if (baseItems.length > 0 && tlPlayheadSec >= tlLayout.baseEndSec) return baseItems[baseItems.length - 1];
    return null;
  })();
  const activeBaseId = activeBaseEntry?.item.id ?? null;
  const selectedTl = (() => {
    if (!tlLayout || !selectedTlItemId) return null;
    for (let ti = 0; ti < tlLayout.tracks.length; ti++) {
      const found = tlLayout.tracks[ti].items.find((e) => e.item.id === selectedTlItemId);
      if (found) return { entry: found, trackIndex: ti };
    }
    return null;
  })();
  const drawerItem = (() => {
    if (!drawerItemId || !timeline) return null;
    for (let ti = 0; ti < timeline.tracks.length; ti++) {
      const found = timeline.tracks[ti].items.find((it) => it.id === drawerItemId);
      if (found) return { item: found, trackIndex: ti };
    }
    return null;
  })();
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
  const updateDrawerTrimField = (field: keyof TrimRange, raw: string) => {
    const value = Number(raw);
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
  };
  const isLargeTlCanvas =
    timeline !== null && timeline.outputWidth > 0 && (timeline.outputWidth > 3840 || timeline.outputWidth * timeline.outputHeight > 8_300_000);
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
    if (!timelineActive || !activeBaseId) return;
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
  }, [timelineActive, activeBaseId, tlEntries]);

  useEffect(() => {
    if (!timelineActive || !activeBaseId) return;
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
  }, [timelineActive, activeBaseId, tlEntries, syncTlVideos, startTlClock]);

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
                <Text type="supporting">{clips.length} video{clips.length === 1 ? "" : "s"}</Text>
              </div>
              <Button
                label="Add videos"
                variant="primary"
                onClick={() => poolFileInputRef.current?.click()}
                isDisabled={loading}
              />
              <input
                ref={poolFileInputRef}
                type="file"
                accept="video/mp4,.mp4"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) void addFiles(files);
                  e.target.value = "";
                }}
              />
              {clips.length === 0 && (
                <Text type="supporting">No videos yet. Add videos here, or drop MP4 files onto this column.</Text>
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
                      setCropClipId(item.id);
                      setDrawerItemId(null);
                    }}
                  >
                    <video className="pool-thumb" src={item.url} preload="metadata" muted playsInline />
                    <div className="pool-item-name">{item.file.name}</div>
                    <div className="pool-item-meta">
                      <span>{fmtDuration(item.meta.durationSec)}</span>
                      <span>
                        {item.meta.width} × {item.meta.height}
                      </span>
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
                <Text type="supporting">Drag a video onto the canvas to place it as a tile. Double-click a video to edit its crop and trim.</Text>
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
                  <Heading level={3}>Drop MP4 files here</Heading>
                  <Text type="supporting">or click to choose a file. Everything is processed locally in your browser.</Text>
                </VStack>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,.mp4"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = "";
              }}
            />

            {clip && outRect && (
              <div className="editor-grid">
                <div className="toolbar-sticky">
                  <div className="toolbar">
                    <Button label="Open a different file" variant="secondary" onClick={openDifferentFile} isDisabled={exporting} />
                    <Button
                      label="Timeline"
                      variant={timelineActive ? "primary" : "secondary"}
                      aria-pressed={timelineActive}
                      onClick={() => toggleTool("timeline")}
                      isDisabled={exporting}
                    />
                    {layout && (
                      <Button
                        label="Layout"
                        variant={layoutActive ? "primary" : "secondary"}
                        aria-pressed={layoutActive}
                        onClick={() => toggleTool("layout")}
                        isDisabled={exporting}
                      />
                    )}
                    <Text type="supporting">
                      {timelineActive && timeline && timeline.outputWidth > 0
                        ? `Output: ${timeline.outputWidth} × ${timeline.outputHeight}`
                        : layout
                          ? `Output: ${layout.outputWidth} × ${layout.outputHeight}`
                          : `Output: ${outRect.width} × ${outRect.height}`}
                    </Text>
                    <div className="toolbar-spacer" />
                    <SegmentedControl
                      label="Export format"
                      value={compositing || timelineExporting ? "mp4" : exportFormat}
                      onChange={(value) => {
                        if (compositing || timelineExporting) {
                          setExportFormat("mp4");
                          return;
                        }
                        setExportFormat(value === "gif" ? "gif" : "mp4");
                      }}
                      isDisabled={exporting}
                    >
                      <SegmentedControlItem value="mp4" label="MP4" />
                      <SegmentedControlItem value="gif" label="GIF" isDisabled={compositing || timelineExporting} />
                    </SegmentedControl>
                    {compositing && <Text type="supporting">Composite: MP4 only</Text>}
                    {timelineExporting && !compositing && <Text type="supporting">Timeline: MP4 only</Text>}
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
                        label={!compositing && !timelineExporting && exportFormat === "gif" ? "Export GIF" : "Export MP4"}
                        variant="primary"
                        onClick={() => void runExport()}
                        isDisabled={!supported}
                      />
                    )}
                  </div>
                  {exportFormat === "gif" && !compositing && !timelineExporting && (
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
                    <div className="toolbar-progress">
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                      </div>
                      <Text type="supporting">Exporting… {Math.round(progress * 100)}%</Text>
                    </div>
                  )}
                </div>
                <div
                  className={`stage-wrap${stageDragOver ? " drag-over" : ""}`}
                  ref={stageWrapRef}
                  onDragOver={onStageDragOver}
                  onDragLeave={() => setStageDragOver(false)}
                  onDrop={onStageDrop}
                >
                  {timelineActive && timeline && timeline.outputWidth > 0 && tlLayout ? (
                    <div className="layout-wrap">
                      <div
                        className="layout-stage"
                        ref={tlStageRef}
                        style={{ aspectRatio: `${timeline.outputWidth} / ${timeline.outputHeight}` }}
                      >
                        {activeBaseEntry && (
                          <div
                            className="tl-base-video"
                            key={activeBaseEntry.item.id}
                            style={baseVideoBoxStyle(activeBaseEntry.clip, timeline.outputWidth, timeline.outputHeight)}
                          >
                            <video
                              ref={(el) => {
                                if (el) tlVideoRefs.current.set(activeBaseEntry.item.id, el);
                                else tlVideoRefs.current.delete(activeBaseEntry.item.id);
                              }}
                              src={activeBaseEntry.clip.url}
                              playsInline
                              style={subRectVideoStyle(activeBaseEntry.clip)}
                            />
                          </div>
                        )}
                        {tlLayout.tracks.slice(1).flatMap((trackLayout, ti) =>
                          trackLayout.items.map((entry, ii) => {
                            if (!entry.item.rect) return null;
                            const trackIndex = ti + 1;
                            const isActive =
                              tlPlayheadSec >= entry.startSec && tlPlayheadSec < entry.startSec + entry.durationSec;
                            const isSelected = entry.item.id === selectedTlItemId;
                            return (
                              <div
                                key={entry.item.id}
                                className={`layout-tile tl-overlay-tile${isSelected ? " selected" : ""}`}
                                data-tl-stage-item={entry.item.id}
                                style={{
                                  ...tlPct(entry.item.rect),
                                  visibility: isActive ? "visible" : "hidden",
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
                                <video
                                  ref={(el) => {
                                    if (el) tlVideoRefs.current.set(entry.item.id, el);
                                    else tlVideoRefs.current.delete(entry.item.id);
                                  }}
                                  src={entry.clip.url}
                                  playsInline
                                  muted
                                  style={subRectVideoStyle(entry.clip)}
                                />
                                {isSelected && (
                                  <div
                                    className="layout-tile-handle"
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
                      </div>
                      <div className="layout-controls">
                        <Button
                          label={tlPlaying ? "Pause all" : "Play all"}
                          variant="primary"
                          onClick={toggleTlPlayback}
                          isDisabled={exporting || tlTotalSec <= 0}
                        />
                        <Text type="supporting">
                          {fmtSec(tlPlayheadSec)} / {fmtSec(tlTotalSec)} · Output {timeline.outputWidth} ×{" "}
                          {timeline.outputHeight} · {timeline.tracks.length} track{timeline.tracks.length === 1 ? "" : "s"}
                        </Text>
                      </div>
                    </div>
                  ) : layoutActive && layout ? (
                    <div className="layout-wrap">
                      <div
                        className="layout-stage"
                        ref={layoutStageRef}
                        style={{ aspectRatio: `${layout.outputWidth} / ${layout.outputHeight}` }}
                      >
                        {layout.tiles.map((tile) => {
                          const tileClip = clips.find((c) => c.id === tile.clipId);
                          if (!tileClip) return null;
                          return (
                            <div
                              key={tile.id}
                              className="layout-tile"
                              data-tile-id={tile.id}
                              data-clip-id={tile.clipId}
                              style={tileCss(tile.rect)}
                              onPointerDown={(e) => beginTileDrag(e, tile.id, "move")}
                              onPointerMove={onTileDragMove}
                              onPointerUp={endTileDrag}
                              onPointerCancel={endTileDrag}
                              onDoubleClick={() => {
                                setCropClipId(tile.clipId);
                                setDrawerItemId(null);
                              }}
                            >
                              <video
                                ref={(el) => {
                                  if (el) tileVideoRefs.current.set(tile.id, el);
                                  else tileVideoRefs.current.delete(tile.id);
                                }}
                                src={tileClip.url}
                                playsInline
                                style={subRectVideoStyle(tileClip)}
                              />
                              <div
                                className="layout-tile-handle"
                                onPointerDown={(e) => beginTileDrag(e, tile.id, "resize")}
                                onPointerMove={onTileDragMove}
                                onPointerUp={endTileDrag}
                                onPointerCancel={endTileDrag}
                              />
                            </div>
                          );
                        })}
                      </div>
                      <SeekBar
                        value={layoutPlayheadSec}
                        total={layoutDurationSec}
                        onSeek={seekLayoutTo}
                        isDisabled={exporting}
                      />
                      <div className="layout-controls">
                        <Button
                          label={layoutPlaying ? "Pause all" : "Play all"}
                          variant="primary"
                          onClick={toggleLayoutPlayback}
                          isDisabled={exporting}
                        />
                        <Text type="supporting">
                          Output {layout.outputWidth} × {layout.outputHeight} · Duration {fmtSec(outputDurationSec)} ·{" "}
                          {layout.tiles.length} tile{layout.tiles.length === 1 ? "" : "s"}
                        </Text>
                      </div>
                    </div>
                  ) : (
                  <div className="stage" ref={stageRef} data-active-tool={activeTool}>
                    <video ref={videoRef} src={clip.url} controls playsInline />
                  </div>
                  )}
                </div>
                {timelineActive && timeline && tlLayout && (
                  <SeekBar value={tlPlayheadSec} total={tlTotalSec} onSeek={seekTlTo} isDisabled={exporting} />
                )}
                {timelineActive && timeline && tlLayout && (
                  <div
                    className="tl-strip"
                    onDragEnter={(e) => {
                      if (Array.from(e.dataTransfer.types).includes(POOL_DRAG_TYPE)) setTlGhostVisible(true);
                    }}
                    onDragOver={(e) => {
                      if (Array.from(e.dataTransfer.types).includes(POOL_DRAG_TYPE)) setTlGhostVisible(true);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                        setTlGhostVisible(false);
                        setTlGhostHot(false);
                      }
                    }}
                    onDrop={() => {
                      setTlGhostVisible(false);
                      setTlGhostHot(false);
                    }}
                  >
                    {tlGhostVisible && (
                      <div className="tl-row">
                        <div className="tl-row-label">New</div>
                        <div
                          className={`tl-row-track tl-ghost-track${tlGhostHot ? " hot" : ""}`}
                          data-tl-ghost="true"
                          onDragOver={(e) => {
                            if (Array.from(e.dataTransfer.types).includes(POOL_DRAG_TYPE)) {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "copy";
                              setTlGhostHot(true);
                            }
                          }}
                          onDragLeave={() => setTlGhostHot(false)}
                          onDrop={(e) => {
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
                              className="tl-row-track"
                              data-tl-row={trackIndex}
                              onPointerDown={(e) => {
                                if (exporting || tlTotalSec <= 0) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                if (rect.width === 0) return;
                                seekTlTo(((e.clientX - rect.left) / rect.width) * tlTotalSec);
                              }}
                              onDragOver={(e) => {
                                const types = Array.from(e.dataTransfer.types);
                                if (types.includes(POOL_DRAG_TYPE) || (trackIndex === 0 && types.includes(TL_ITEM_DRAG_TYPE))) {
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = types.includes(POOL_DRAG_TYPE) ? "copy" : "move";
                                }
                              }}
                              onDrop={(e) => {
                                const types = Array.from(e.dataTransfer.types);
                                const rowEl = e.currentTarget;
                                if (trackIndex === 0 && types.includes(TL_ITEM_DRAG_TYPE)) {
                                  const itemId = e.dataTransfer.getData(TL_ITEM_DRAG_TYPE);
                                  if (!itemId) return;
                                  e.preventDefault();
                                  reorderBaseItem(itemId, baseInsertIndex(rowEl, e.clientX));
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
                                trackLayout.items.map((entry) => (
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
                                    onPointerDown={() => setSelectedTlItemId(entry.item.id)}
                                    onDoubleClick={() => {
                                      setCropClipId(entry.clip.id);
                                      setDrawerItemId(entry.item.id);
                                    }}
                                  >
                                    <div className="tl-thumbs">
                                      {(
                                        tlThumbs[`${entry.clip.id}|${entry.item.trim.startSec}|${entry.item.trim.endSec}`] ??
                                        []
                                      ).map((src, i) => (
                                        <img key={i} src={src} alt="" draggable={false} />
                                      ))}
                                    </div>
                                    <div className="tl-block-label">
                                      {entry.clip.file.name} · {fmtSec(entry.durationSec)}
                                    </div>
                                    <div
                                      className="tl-block-edge left"
                                      data-tl-edge="start"
                                      onPointerDown={(e) => beginTlEdgeDrag(e, 0, entry, "start")}
                                      onPointerMove={onTlEdgeDragMove}
                                      onPointerUp={endTlEdgeDrag}
                                      onPointerCancel={endTlEdgeDrag}
                                    />
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
                                ))}
                              {trackIndex > 0 &&
                                trackLayout.items.map((entry) => {
                                  const isSelected = entry.item.id === selectedTlItemId;
                                  return (
                                    <div
                                      key={entry.item.id}
                                      className={`tl-block tl-block-overlay${isSelected ? " selected" : ""}`}
                                      data-tl-block={entry.item.id}
                                      data-tl-item={entry.item.id}
                                      style={{
                                        left: `${tlTotalSec > 0 ? (entry.startSec / tlTotalSec) * 100 : 0}%`,
                                        width: `${tlTotalSec > 0 ? (entry.durationSec / tlTotalSec) * 100 : 0}%`,
                                      }}
                                      onPointerDown={(e) => beginTlBlockDrag(e, trackIndex, entry)}
                                      onDoubleClick={() => {
                                        setCropClipId(entry.clip.id);
                                        setDrawerItemId(entry.item.id);
                                      }}
                                      onPointerMove={onTlBlockDragMove}
                                      onPointerUp={endTlBlockDrag}
                                      onPointerCancel={endTlBlockDrag}
                                    >
                                      <div className="tl-thumbs">
                                        {(
                                          tlThumbs[
                                            `${entry.clip.id}|${entry.item.trim.startSec}|${entry.item.trim.endSec}`
                                          ] ?? []
                                        ).map((src, i) => (
                                          <img key={i} src={src} alt="" draggable={false} />
                                        ))}
                                      </div>
                                      <div className="tl-block-label">
                                        {entry.clip.file.name} · {fmtSec(entry.durationSec)}
                                      </div>
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
                                    ? "Drop videos here, or use Add to timeline in the panel."
                                    : "Drop videos here to overlay them."}
                                </div>
                              )}
                              <div
                                className="tl-playhead"
                                style={{ left: `${tlTotalSec > 0 ? (tlPlayheadSec / tlTotalSec) * 100 : 0}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    <Text type="supporting">
                      {fmtSec(tlPlayheadSec)} / {fmtSec(tlTotalSec)} · Click a track to seek. Drag base clips to
                      reorder them; drag overlay clips sideways to move them in time. Drag a block's edges to trim
                      it; double-click a block to edit its crop and trim.
                    </Text>
                  </div>
                )}
                <div className="panel">
                  <div className="meta-row">
                    <Text type="supporting">File: {clip.file.name}</Text>
                    <Text type="supporting">
                      Source: {clip.meta.width} × {clip.meta.height}
                    </Text>
                    <Text type="supporting">Duration: {fmtDuration(clip.meta.durationSec)}</Text>
                    <Text type="supporting">Video codec: {clip.meta.videoCodec ?? "unknown"}</Text>
                    <Text type="supporting">Audio: {clip.meta.hasAudio ? (clip.meta.audioCodec ?? "yes") : "none"}</Text>
                  </div>
                  {layoutActive && layout && (
                    <>
                      <HStack gap={3} vAlign="center">
                        <Button label="Side by side" variant="secondary" onClick={() => applyPreset("side")} isDisabled={exporting || layout.tiles.length < 2} />
                        <Button label="Picture in picture" variant="secondary" onClick={() => applyPreset("pip")} isDisabled={exporting || layout.tiles.length < 2} />
                      </HStack>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="layout-output-width">Output width</label>
                          <input
                            id="layout-output-width"
                            type="number"
                            min={16}
                            max={7680}
                            step={2}
                            value={outWText}
                            disabled={exporting}
                            onChange={(e) => setOutWText(e.target.value)}
                            onBlur={(e) => commitOutputSize(e)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="layout-output-height">Output height</label>
                          <input
                            id="layout-output-height"
                            type="number"
                            min={16}
                            max={7680}
                            step={2}
                            value={outHText}
                            disabled={exporting}
                            onChange={(e) => setOutHText(e.target.value)}
                            onBlur={(e) => commitOutputSize(e)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                        </div>
                      </div>
                      <HStack gap={3} vAlign="center">
                        <Button label="1920 × 1080" variant="secondary" onClick={() => applyOutputSize(1920, 1080)} isDisabled={exporting} />
                        <Button label="1280 × 720" variant="secondary" onClick={() => applyOutputSize(1280, 720)} isDisabled={exporting} />
                        <Button label="854 × 480" variant="secondary" onClick={() => applyOutputSize(854, 480)} isDisabled={exporting} />
                        <Button label="50%" variant="secondary" onClick={() => applyOutputSize(layout.outputWidth / 2, layout.outputHeight / 2)} isDisabled={exporting} />
                        <Button label="25%" variant="secondary" onClick={() => applyOutputSize(layout.outputWidth / 4, layout.outputHeight / 4)} isDisabled={exporting} />
                      </HStack>
                      {isLargeCanvas && (
                        <Text type="supporting">
                          <span className="layout-warning">Large canvas: encoding will be heavy and the file big.</span>
                        </Text>
                      )}
                      <div className="tile-list">
                        {layout.tiles.map((tile, index) => {
                          const tileClip = clips.find((c) => c.id === tile.clipId);
                          return (
                            <div className="tile-row" key={tile.id} data-tile-row={tile.id}>
                              <div className="tile-row-main">
                                <Text type="supporting">
                                  {index + 1}. {tileClip ? tileClip.file.name : "(missing video)"}
                                </Text>
                                <Text type="supporting">
                                  {Math.round(tile.rect.width)} × {Math.round(tile.rect.height)} at {Math.round(tile.rect.x)},{" "}
                                  {Math.round(tile.rect.y)}
                                </Text>
                              </div>
                              <div className="field tile-offset-field">
                                <label htmlFor={`tile-offset-${tile.id}`}>Offset (s)</label>
                                <input
                                  id={`tile-offset-${tile.id}`}
                                  type="number"
                                  min={-10}
                                  max={10}
                                  step={0.1}
                                  value={tile.offsetSec}
                                  disabled={index === 0 || exporting}
                                  onChange={(e) => {
                                    const value = Number(e.target.value);
                                    if (Number.isFinite(value)) {
                                      updateTile(tile.id, { offsetSec: Math.max(-10, Math.min(10, value)) });
                                    }
                                  }}
                                />
                              </div>
                              <HStack gap={2} vAlign="center">
                                <Button
                                  label="Forward"
                                  variant="secondary"
                                  onClick={() => moveTileOrder(tile.id, 1)}
                                  isDisabled={exporting || index === layout.tiles.length - 1}
                                />
                                <Button
                                  label="Backward"
                                  variant="secondary"
                                  onClick={() => moveTileOrder(tile.id, -1)}
                                  isDisabled={exporting || index === 0}
                                />
                                <Button
                                  label="Remove tile"
                                  variant="secondary"
                                  onClick={() => removeTile(tile.id)}
                                  isDisabled={exporting}
                                />
                              </HStack>
                            </div>
                          );
                        })}
                      </div>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="layout-audio-source">Audio source</label>
                          <select
                            id="layout-audio-source"
                            value={layout.audioSourceClipId ?? "none"}
                            disabled={exporting}
                            onChange={(e) =>
                              setLayout({
                                ...layout,
                                audioSourceClipId: e.target.value === "none" ? null : e.target.value,
                              })
                            }
                          >
                            <option value="none">None</option>
                            {Array.from(new Map(layout.tiles.map((t) => [t.clipId, t])).values()).map((tile) => {
                              const sourceClip = clips.find((c) => c.id === tile.clipId);
                              return (
                                <option key={tile.clipId} value={tile.clipId}>
                                  {sourceClip ? sourceClip.file.name : tile.clipId}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                      </div>
                      <Text type="supporting">
                        Output: {layout.outputWidth} × {layout.outputHeight} · Duration: {fmtSec(outputDurationSec)} ·{" "}
                        {layout.tiles.length} tile{layout.tiles.length === 1 ? "" : "s"}
                      </Text>
                      <Text type="supporting">
                        Drag the tiles on the preview to move them, and use the corner handle to resize. Tiles are drawn
                        in list order, later tiles on top. Positive offset starts that tile later.
                      </Text>
                    </>
                  )}
                  {timelineActive && timeline && tlLayout && (
                    <>
                      <HStack gap={3} vAlign="center">
                        <Button
                          label="Add to timeline"
                          variant="primary"
                          onClick={() => clip && addClipToBase(clip.id)}
                          isDisabled={exporting || !clip}
                        />
                        <Button label="Add track" variant="secondary" onClick={addTrack} isDisabled={exporting} />
                      </HStack>
                      <Text type="supporting">
                        Total duration: {fmtSec(tlTotalSec)} · {timeline.tracks.length} track
                        {timeline.tracks.length === 1 ? "" : "s"} · Export MP4 in Timeline mode exports the whole
                        timeline. Audio comes from the base track only; overlay clips are silent.
                      </Text>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="timeline-output-width">Output width</label>
                          <input
                            id="timeline-output-width"
                            type="number"
                            min={16}
                            max={7680}
                            step={2}
                            value={tlOutWText}
                            disabled={exporting}
                            onChange={(e) => setTlOutWText(e.target.value)}
                            onBlur={(e) => commitTlOutputSize(e)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            }}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="timeline-output-height">Output height</label>
                          <input
                            id="timeline-output-height"
                            type="number"
                            min={16}
                            max={7680}
                            step={2}
                            value={tlOutHText}
                            disabled={exporting}
                            onChange={(e) => setTlOutHText(e.target.value)}
                            onBlur={(e) => commitTlOutputSize(e)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
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
                          <span className="layout-warning">Large canvas: encoding will be heavy and the file big.</span>
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
                                  <Text type="supporting">{entry.clip.file.name}</Text>
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
                      {selectedTl && (
                        <>
                          <Text type="supporting">
                            Selected clip: {selectedTl.entry.clip.file.name} (V{selectedTl.trackIndex + 1}
                            {selectedTl.trackIndex === 0 ? " · Base" : ""}) · item trim (source)
                          </Text>
                          <div className="field-row">
                            <div className="field">
                              <label htmlFor="tl-item-trim-start">Start (s)</label>
                              <input
                                id="tl-item-trim-start"
                                type="number"
                                min={0}
                                max={selectedTl.entry.clip.meta.durationSec}
                                step={0.1}
                                value={Math.round(selectedTl.entry.item.trim.startSec * 100) / 100}
                                disabled={exporting}
                                onChange={(e) => {
                                  const value = Number(e.target.value);
                                  if (Number.isFinite(value)) {
                                    applyItemTrim(selectedTl.trackIndex, selectedTl.entry, {
                                      ...selectedTl.entry.item.trim,
                                      startSec: value,
                                    });
                                  }
                                }}
                              />
                            </div>
                            <div className="field">
                              <label htmlFor="tl-item-trim-end">End (s)</label>
                              <input
                                id="tl-item-trim-end"
                                type="number"
                                min={0}
                                max={selectedTl.entry.clip.meta.durationSec}
                                step={0.1}
                                value={Math.round(selectedTl.entry.item.trim.endSec * 100) / 100}
                                disabled={exporting}
                                onChange={(e) => {
                                  const value = Number(e.target.value);
                                  if (Number.isFinite(value)) {
                                    applyItemTrim(selectedTl.trackIndex, selectedTl.entry, {
                                      ...selectedTl.entry.item.trim,
                                      endSec: value,
                                    });
                                  }
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
                      {selectedTl && selectedTl.trackIndex > 0 && selectedTl.entry.item.rect && (
                        <>
                          <Text type="supporting">
                            Selected overlay: {selectedTl.entry.clip.file.name} (V{selectedTl.trackIndex + 1})
                          </Text>
                          <div className="field-row">
                            <div className="field">
                              <label htmlFor="tl-item-start">Start (s)</label>
                              <input
                                id="tl-item-start"
                                type="number"
                                min={0}
                                step={0.1}
                                value={Math.round(selectedTl.entry.item.startSec * 10) / 10}
                                disabled={exporting}
                                onChange={(e) => {
                                  const value = Number(e.target.value);
                                  if (Number.isFinite(value)) {
                                    updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                      startSec: Math.max(0, value),
                                    });
                                  }
                                }}
                              />
                            </div>
                            {(["x", "y", "width", "height"] as const).map((field) => (
                              <div className="field" key={field}>
                                <label htmlFor={`tl-rect-${field}`}>
                                  {field === "width" ? "Width" : field === "height" ? "Height" : field.toUpperCase()}
                                </label>
                                <input
                                  id={`tl-rect-${field}`}
                                  type="number"
                                  min={0}
                                  value={Math.round(selectedTl.entry.item.rect?.[field] ?? 0)}
                                  disabled={exporting}
                                  onChange={(e) => {
                                    const value = Number(e.target.value);
                                    const rect = selectedTl.entry.item.rect;
                                    if (!Number.isFinite(value) || !rect) return;
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
                          <HStack gap={3} vAlign="center">
                            <Button
                              label="Picture in picture"
                              variant="secondary"
                              onClick={() => {
                                updateTlItem(selectedTl.trackIndex, selectedTl.entry.item.id, {
                                  rect: pipItemRect(timeline.outputWidth, timeline.outputHeight, clipCropAspect(selectedTl.entry.clip)),
                                });
                              }}
                              isDisabled={exporting}
                            />
                          </HStack>
                          <Text type="supporting">
                            Drag the selected overlay on the preview to move it, and use the corner handle to resize
                            it. Its size follows the clip's crop aspect while dragging on the preview.
                          </Text>
                        </>
                      )}
                    </>
                  )}
                  {activeTool === "none" && (
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
                      {layout && (
                        <Text type="supporting">
                          Layout: {layout.tiles.length} tile{layout.tiles.length === 1 ? "" : "s"} · {layout.outputWidth} ×{" "}
                          {layout.outputHeight} · Audio: {audioSourceName ?? "None"}. Press Layout in the toolbar to edit
                          it, or drag another video from Media onto the canvas.
                        </Text>
                      )}
                      {timeline && tlLayout && tlLayout.tracks.some((t) => t.items.length > 0) && (
                        <Text type="supporting">
                          Timeline: {timeline.tracks.length} track{timeline.tracks.length === 1 ? "" : "s"} ·{" "}
                          {fmtSec(tlTotalSec)} · {timeline.outputWidth} × {timeline.outputHeight}. Press Timeline in the
                          toolbar to edit it.
                        </Text>
                      )}
                      <Text type="supporting">
                        {compositing
                          ? `Output: ${layout.outputWidth} × ${layout.outputHeight} (composite of ${layout.tiles.length} tiles)`
                          : `Output: ${outRect.width} × ${outRect.height} (adjusted to even numbers)`}
                      </Text>
                    </>
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
              </div>
            )}
          </VStack>
            </div>
          </div>
        </main>
      </div>
      <Drawer
        isOpen={cropClip !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        label={cropClip ? `Edit ${cropClip.file.name}` : "Edit clip"}
        side="end"
        width={520}
        data-testid="crop-drawer"
      >
        {cropClip && cropOutRect && (
          <VStack gap={4}>
            <DrawerHeader
              title={cropClip.file.name}
              subtitle="Crop & trim"
              onOpenChange={(open) => {
                if (!open) closeDrawer();
              }}
            />
            <div className="drawer-stage" ref={drawerStageRef}>
              <video ref={drawerVideoRef} src={cropClip.url} controls playsInline />
              <div
                className="crop-rect"
                style={{
                  left: `${(cropClip.crop.x / cropClip.meta.width) * 100}%`,
                  top: `${(cropClip.crop.y / cropClip.meta.height) * 100}%`,
                  width: `${(cropClip.crop.width / cropClip.meta.width) * 100}%`,
                  height: `${(cropClip.crop.height / cropClip.meta.height) * 100}%`,
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
            <SegmentedControl label="Aspect ratio" value={aspect} onChange={changeAspect} isDisabled={exporting}>
              {ASPECTS.map((a) => (
                <SegmentedControlItem key={a.value} value={a.value} label={a.label} />
              ))}
            </SegmentedControl>
            <div className="field-row">
              {(["x", "y", "width", "height"] as const).map((field) => (
                <div className="field" key={field}>
                  <label htmlFor={`crop-${field}`}>{field === "width" ? "Width" : field === "height" ? "Height" : field.toUpperCase()}</label>
                  <input
                    id={`crop-${field}`}
                    type="number"
                    min={0}
                    value={Math.round(cropClip.crop[field])}
                    onChange={(e) => updateField(field, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <Text type="supporting">
              Output: {cropOutRect.width} × {cropOutRect.height} · Output size is adjusted to even numbers.
            </Text>
            <Text type="supporting">Crop applies to all uses of this clip.</Text>
            <Text type="supporting">
              Trim — {drawerItem ? `timeline item (V${drawerItem.trackIndex + 1})` : "this clip"}
            </Text>
            <div className="field-row">
              <div className="field">
                <label htmlFor="drawer-trim-start">Start (s)</label>
                <input
                  id="drawer-trim-start"
                  type="number"
                  min={0}
                  max={cropClip.meta.durationSec}
                  step={0.1}
                  value={Math.round(drawerTrim.startSec * 100) / 100}
                  onChange={(e) => updateDrawerTrimField("startSec", e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="drawer-trim-end">End (s)</label>
                <input
                  id="drawer-trim-end"
                  type="number"
                  min={0}
                  max={cropClip.meta.durationSec}
                  step={0.1}
                  value={Math.round(drawerTrim.endSec * 100) / 100}
                  onChange={(e) => updateDrawerTrimField("endSec", e.target.value)}
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
                ? "This trim belongs to this timeline item only; the clip's own trim is unchanged. Trimming an overlay item's head shifts it so the remaining content stays in place."
                : "This is the clip's default trim: used by single-clip export and Layout tiles, and copied into new timeline items."}
            </Text>
          </VStack>
        )}
      </Drawer>
    </Theme>
  );
}
