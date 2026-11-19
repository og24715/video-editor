import { useCallback, useEffect, useRef, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { ttsTheme } from "./themes/tts/tts";
import { Heading } from "@astryxdesign/core/Heading";
import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { FolderOpen } from "lucide-react";
import type { ActiveTool, AspectPreset, Clip, CropRect, LayoutState, LayoutTile, TileRect, ToolId, TrimRange } from "./model";
import { droppedTileRect, evenRect, pipRects, resizedTiles, sideBySideRects } from "./model";
import { ExportCancelledError, exportCropped, openInput, readMeta, webCodecsSupported } from "./exporter";
import { exportComposite } from "./compositeExporter";
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

function clampTimeToTrim(t: number, trim: TrimRange): number {
  return Math.max(trim.startSec, Math.min(trim.endSec, t));
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
  const [playheadSec, setPlayheadSec] = useState(0);
  const [layout, setLayout] = useState<LayoutState | null>(null);
  const [layoutPlaying, setLayoutPlaying] = useState(false);
  const [outWText, setOutWText] = useState("");
  const [outHText, setOutHText] = useState("");
  const [thumbs, setThumbs] = useState<string[]>([]);
  const thumbsClipRef = useRef<string | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const tlDragRef = useRef<"start" | "end" | null>(null);
  const poolFileInputRef = useRef<HTMLInputElement | null>(null);
  const tileVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const layoutStageRef = useRef<HTMLDivElement | null>(null);
  const tileDragRef = useRef<TileDragState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cancelRef = useRef(false);
  const supported = webCodecsSupported();

  const clip = clips.find((c) => c.id === activeClipId) ?? clips[0] ?? null;
  const ratio = ASPECTS.find((a) => a.value === aspect)?.ratio ?? null;
  const cropActive = activeTool === "crop";
  const trimActive = activeTool === "trim";
  const layoutActive = activeTool === "layout";
  const compositing = layout !== null && layout.tiles.length >= 2;
  const trimRef = useRef<TrimRange>({ startSec: 0, endSec: 0 });
  const durationRef = useRef(0);
  const toolRef = useRef<ActiveTool>("none");
  const seekClampRef = useRef(false);
  const layoutRef = useRef<LayoutState | null>(null);
  const clipsRef = useRef<Clip[]>([]);
  toolRef.current = activeTool;
  layoutRef.current = layout;
  clipsRef.current = clips;
  if (clip) {
    trimRef.current = clip.trim;
    durationRef.current = clip.meta.durationSec;
  }

  useEffect(() => {
    if (layout) {
      setOutWText(String(layout.outputWidth));
      setOutHText(String(layout.outputHeight));
    }
  }, [layout?.outputWidth, layout?.outputHeight]);

  const setCrop = useCallback((crop: CropRect) => {
    setClips((prev) => {
      const targetId = prev.find((c) => c.id === activeClipId)?.id ?? prev[0]?.id;
      return prev.map((c) => (c.id === targetId ? { ...c, crop } : c));
    });
  }, [activeClipId]);

  const setTrim = useCallback((trim: TrimRange) => {
    setClips((prev) => {
      const targetId = prev.find((c) => c.id === activeClipId)?.id ?? prev[0]?.id;
      return prev.map((c) => (c.id === targetId ? { ...c, trim } : c));
    });
  }, [activeClipId]);

  const clampPlayheadToTrim = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = clampTimeToTrim(video.currentTime, trimRef.current);
    if (Math.abs(clamped - video.currentTime) > 0.001) {
      seekClampRef.current = true;
      video.currentTime = clamped;
      setPlayheadSec(clamped);
    }
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
          setPlayheadSec(0);
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
    setActiveClipId((prev) => {
      if (prev !== clipId) return prev;
      const remaining = clipsRef.current.filter((c) => c.id !== clipId);
      return remaining[0]?.id ?? null;
    });
    setLayoutPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const enforceTrimRange = () => {
      if (toolRef.current !== "trim") return;
      const clamped = clampTimeToTrim(video.currentTime, trimRef.current);
      if (Math.abs(clamped - video.currentTime) > 0.001) {
        seekClampRef.current = true;
        video.currentTime = clamped;
        setPlayheadSec(clamped);
      }
    };
    const onTimeUpdate = () => {
      setPlayheadSec(video.currentTime);
      const trim = trimRef.current;
      const duration = durationRef.current;
      if (toolRef.current === "trim") {
        if (video.currentTime < trim.startSec - 0.001) {
          enforceTrimRange();
          return;
        }
        if (video.currentTime >= trim.endSec) {
          video.pause();
          if (video.currentTime > trim.endSec) {
            seekClampRef.current = true;
            video.currentTime = trim.endSec;
            setPlayheadSec(trim.endSec);
          }
          return;
        }
      }
      if (duration > 0 && trim.endSec < duration - 0.01 && video.currentTime >= trim.endSec) {
        video.pause();
      }
    };
    const onSeeking = () => {
      if (seekClampRef.current) {
        seekClampRef.current = false;
        return;
      }
      enforceTrimRange();
    };
    const onSeeked = () => {
      enforceTrimRange();
      setPlayheadSec(video.currentTime);
    };
    const onPlay = () => {
      if (toolRef.current !== "trim") return;
      const trim = trimRef.current;
      if (video.currentTime < trim.startSec - 0.001 || video.currentTime >= trim.endSec - 0.001) {
        seekClampRef.current = true;
        video.currentTime = trim.startSec;
        setPlayheadSec(trim.startSec);
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("play", onPlay);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("play", onPlay);
    };
  }, [clip?.id, layoutActive]);

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
    return () => {
      master.removeEventListener("timeupdate", sync);
      master.removeEventListener("pause", pauseOthers);
      master.removeEventListener("play", onPlayMaster);
    };
  }, [layoutActive, layout?.tiles.map((t) => `${t.id}:${t.clipId}`).join("|")]);

  useEffect(() => {
    if (trimActive) clampPlayheadToTrim();
  }, [trimActive, clip?.trim, clampPlayheadToTrim]);

  useEffect(() => {
    if (!trimActive || !clip) return;
    if (!(clip.meta.durationSec > 0)) return;
    if (thumbsClipRef.current === clip.id) return;
    thumbsClipRef.current = clip.id;
    let cancelled = false;
    let completed = false;
    const duration = clip.meta.durationSec;
    const count = 10;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = clip.url;
    const canvas = document.createElement("canvas");
    const thumbHeight = 48;
    const thumbWidth = Math.max(24, Math.round((thumbHeight * clip.meta.width) / clip.meta.height));
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const seekTo = (t: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          resolve();
        };
        video.addEventListener("seeked", done);
        video.currentTime = t;
      });
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener("loadeddata", () => resolve(), { once: true });
          video.addEventListener("error", () => reject(new Error("thumbnail load failed")), { once: true });
        });
        const urls: string[] = [];
        for (let i = 0; i < count; i++) {
          if (cancelled) return;
          const t = Math.max(0, Math.min(duration - 0.05, ((i + 0.5) / count) * duration));
          await seekTo(t);
          if (cancelled) return;
          ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);
          urls.push(canvas.toDataURL("image/jpeg", 0.7));
          setThumbs([...urls]);
        }
        completed = true;
      } catch {
        if (!cancelled) setThumbs([]);
      }
    })();
    return () => {
      cancelled = true;
      if (!completed) thumbsClipRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [trimActive, clip?.id]);

  const beginDrag = (event: React.PointerEvent, mode: "move" | Handle) => {
    if (!clip || exporting || !cropActive) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCrop: { ...clip.crop },
    };
  };

  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || !clip || !stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = ((event.clientX - drag.startClientX) / rect.width) * clip.meta.width;
    const dy = ((event.clientY - drag.startClientY) / rect.height) * clip.meta.height;
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
    setCrop(clampCrop(next, clip.meta.width, clip.meta.height, ratio));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const toggleTool = (tool: ToolId) => {
    if (tool === "crop" || tool === "layout") videoRef.current?.pause();
    const next: ActiveTool = activeTool === tool ? "none" : tool;
    if (next !== "layout") setLayoutPlaying(false);
    setActiveTool(next);
    if (next === "trim") clampPlayheadToTrim();
  };

  const confirmCrop = () => {
    setActiveTool("none");
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
    setLayout(null);
    setLayoutPlaying(false);
    setResultUrl(null);
    setActiveTool("none");
    setError(null);
    setNotice(null);
    setThumbs([]);
    thumbsClipRef.current = null;
    setPlayheadSec(0);
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

  const changeAspect = (value: string) => {
    if (!cropActive) return;
    const preset = (ASPECTS.find((a) => a.value === value)?.value ?? "free") as AspectPreset;
    setAspect(preset);
    if (!clip) return;
    const r = ASPECTS.find((a) => a.value === preset)?.ratio ?? null;
    if (!r) return;
    const c = clip.crop;
    let width = c.width;
    let height = width / r;
    if (height > clip.meta.height) {
      height = clip.meta.height;
      width = height * r;
    }
    const x = Math.max(0, Math.min(c.x + (c.width - width) / 2, clip.meta.width - width));
    const y = Math.max(0, Math.min(c.y + (c.height - height) / 2, clip.meta.height - height));
    setCrop({ x, y, width, height });
  };

  const updateField = (field: keyof CropRect, raw: string) => {
    if (!clip || !cropActive) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setCrop(clampCrop({ ...clip.crop, [field]: value }, clip.meta.width, clip.meta.height, ratio));
  };

  const updateTrimField = (field: keyof TrimRange, raw: string) => {
    if (!clip || !trimActive) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setTrim(clampTrim({ ...clip.trim, [field]: value }, clip.meta.durationSec));
  };

  const setTrimStartToPlayhead = () => {
    if (!clip || !trimActive) return;
    const t = videoRef.current?.currentTime ?? clip.trim.startSec;
    setTrim(clampTrim({ ...clip.trim, startSec: t }, clip.meta.durationSec));
  };

  const setTrimEndToPlayhead = () => {
    if (!clip || !trimActive) return;
    const t = videoRef.current?.currentTime ?? clip.trim.endSec;
    setTrim(clampTrim({ ...clip.trim, endSec: t }, clip.meta.durationSec));
  };

  const timelineFraction = (clientX: number): number | null => {
    const el = timelineRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const seekFromTimeline = (clientX: number) => {
    if (!clip) return;
    const frac = timelineFraction(clientX);
    if (frac === null) return;
    const video = videoRef.current;
    if (!video) return;
    let target = frac * clip.meta.durationSec;
    if (trimActive) target = clampTimeToTrim(target, clip.trim);
    video.currentTime = target;
    setPlayheadSec(target);
  };

  const onTimelinePointerDown = (event: React.PointerEvent) => {
    if (!clip || !trimActive) return;
    seekFromTimeline(event.clientX);
  };

  const onTimelinePointerMove = (event: React.PointerEvent) => {
    if (event.buttons !== 1 || tlDragRef.current) return;
    seekFromTimeline(event.clientX);
  };

  const beginHandleDrag = (event: React.PointerEvent, which: "start" | "end") => {
    if (!clip || exporting || !trimActive) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    tlDragRef.current = which;
  };

  const onHandleDragMove = (event: React.PointerEvent) => {
    const which = tlDragRef.current;
    if (!which || !clip) return;
    const frac = timelineFraction(event.clientX);
    if (frac === null) return;
    const sec = frac * clip.meta.durationSec;
    const next = clampTrim(
      which === "start" ? { ...clip.trim, startSec: sec } : { ...clip.trim, endSec: sec },
      clip.meta.durationSec,
    );
    setTrim(next);
    const video = videoRef.current;
    if (video) {
      video.currentTime = which === "start" ? next.startSec : next.endSec;
      setPlayheadSec(video.currentTime);
    }
  };

  const endHandleDrag = () => {
    tlDragRef.current = null;
  };

  const previewTrimRange = () => {
    if (!clip || !trimActive) return;
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clip.trim.startSec;
    void video.play().catch(() => undefined);
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
      if (exportFormat === "gif" && !compositing) {
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
  const resultAudioText = compositing
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
                      setPlayheadSec(0);
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
                <Text type="supporting">Drag a video onto the canvas to place it as a tile.</Text>
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
                      label="Crop"
                      variant={cropActive ? "primary" : "secondary"}
                      aria-pressed={cropActive}
                      onClick={() => toggleTool("crop")}
                      isDisabled={exporting}
                    />
                    <Button
                      label="Trim"
                      variant={trimActive ? "primary" : "secondary"}
                      aria-pressed={trimActive}
                      onClick={() => toggleTool("trim")}
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
                    {cropActive && (
                      <Button label="Confirm crop" variant="primary" onClick={confirmCrop} isDisabled={exporting} />
                    )}
                    <SegmentedControl label="Aspect ratio" value={aspect} onChange={changeAspect} isDisabled={!cropActive}>
                      {ASPECTS.map((a) => (
                        <SegmentedControlItem key={a.value} value={a.value} label={a.label} />
                      ))}
                    </SegmentedControl>
                    <Text type="supporting">
                      {layout
                        ? `Output: ${layout.outputWidth} × ${layout.outputHeight}`
                        : `Output: ${outRect.width} × ${outRect.height}`}
                    </Text>
                    <div className="toolbar-spacer" />
                    <SegmentedControl
                      label="Export format"
                      value={compositing ? "mp4" : exportFormat}
                      onChange={(value) => {
                        if (compositing) {
                          setExportFormat("mp4");
                          return;
                        }
                        setExportFormat(value === "gif" ? "gif" : "mp4");
                      }}
                      isDisabled={exporting}
                    >
                      <SegmentedControlItem value="mp4" label="MP4" />
                      <SegmentedControlItem value="gif" label="GIF" isDisabled={compositing} />
                    </SegmentedControl>
                    {compositing && <Text type="supporting">Composite: MP4 only</Text>}
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
                        label={!compositing && exportFormat === "gif" ? "Export GIF" : "Export MP4"}
                        variant="primary"
                        onClick={() => void runExport()}
                        isDisabled={!supported}
                      />
                    )}
                  </div>
                  {exportFormat === "gif" && !compositing && (
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
                  {layoutActive && layout ? (
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
                            >
                              <video
                                ref={(el) => {
                                  if (el) tileVideoRefs.current.set(tile.id, el);
                                  else tileVideoRefs.current.delete(tile.id);
                                }}
                                src={tileClip.url}
                                playsInline
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
                    <video ref={videoRef} src={clip.url} controls={!cropActive} playsInline />
                    {cropActive && (
                    <div
                      className="crop-rect"
                      style={{
                        left: `${(clip.crop.x / clip.meta.width) * 100}%`,
                        top: `${(clip.crop.y / clip.meta.height) * 100}%`,
                        width: `${(clip.crop.width / clip.meta.width) * 100}%`,
                        height: `${(clip.crop.height / clip.meta.height) * 100}%`,
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
                    )}
                  </div>
                  )}
                </div>
                {trimActive && (
                  <div className="trim-timeline">
                    <div
                      className="tl-track"
                      ref={timelineRef}
                      onPointerDown={onTimelinePointerDown}
                      onPointerMove={onTimelinePointerMove}
                    >
                      <div className="tl-thumbs">
                        {thumbs.map((src, i) => (
                          <img key={i} src={src} alt="" draggable={false} />
                        ))}
                      </div>
                      <div
                        className="tl-dim"
                        style={{ left: 0, width: `${(clip.trim.startSec / clip.meta.durationSec) * 100}%` }}
                      />
                      <div
                        className="tl-dim"
                        style={{ left: `${(clip.trim.endSec / clip.meta.durationSec) * 100}%`, right: 0 }}
                      />
                      <div
                        className="tl-selection"
                        style={{
                          left: `${(clip.trim.startSec / clip.meta.durationSec) * 100}%`,
                          width: `${((clip.trim.endSec - clip.trim.startSec) / clip.meta.durationSec) * 100}%`,
                        }}
                      />
                      <div className="tl-playhead" style={{ left: `${(playheadSec / clip.meta.durationSec) * 100}%` }} />
                      <div
                        className="tl-handle"
                        style={{ left: `${(clip.trim.startSec / clip.meta.durationSec) * 100}%` }}
                        onPointerDown={(e) => beginHandleDrag(e, "start")}
                        onPointerMove={onHandleDragMove}
                        onPointerUp={endHandleDrag}
                        onPointerCancel={endHandleDrag}
                      />
                      <div
                        className="tl-handle"
                        style={{ left: `${(clip.trim.endSec / clip.meta.durationSec) * 100}%` }}
                        onPointerDown={(e) => beginHandleDrag(e, "end")}
                        onPointerMove={onHandleDragMove}
                        onPointerUp={endHandleDrag}
                        onPointerCancel={endHandleDrag}
                      />
                    </div>
                    <Text type="supporting">Drag the handles to set the range, or click the track to seek.</Text>
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
                  {cropActive && (
                    <>
                      <div className="field-row">
                        {(["x", "y", "width", "height"] as const).map((field) => (
                          <div className="field" key={field}>
                            <label htmlFor={`crop-${field}`}>{field === "width" ? "Width" : field === "height" ? "Height" : field.toUpperCase()}</label>
                            <input
                              id={`crop-${field}`}
                              type="number"
                              min={0}
                              value={Math.round(clip.crop[field])}
                              onChange={(e) => updateField(field, e.target.value)}
                            />
                          </div>
                        ))}
                      </div>
                      <Text type="supporting">
                        Editing crop. Drag the frame or use the fields above, then Confirm crop when done. Output size is adjusted to even numbers.
                      </Text>
                    </>
                  )}
                  {trimActive && (
                    <>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor="trim-start">Start (s)</label>
                          <input
                            id="trim-start"
                            type="number"
                            min={0}
                            max={clip.meta.durationSec}
                            step={0.1}
                            value={Math.round(clip.trim.startSec * 100) / 100}
                            onChange={(e) => updateTrimField("startSec", e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="trim-end">End (s)</label>
                          <input
                            id="trim-end"
                            type="number"
                            min={0}
                            max={clip.meta.durationSec}
                            step={0.1}
                            value={Math.round(clip.trim.endSec * 100) / 100}
                            onChange={(e) => updateTrimField("endSec", e.target.value)}
                          />
                        </div>
                      </div>
                      <HStack gap={3} vAlign="center">
                        <Button label="Set start to playhead" variant="secondary" onClick={setTrimStartToPlayhead} isDisabled={exporting} />
                        <Button label="Set end to playhead" variant="secondary" onClick={setTrimEndToPlayhead} isDisabled={exporting} />
                        <Button label="Preview range" variant="secondary" onClick={previewTrimRange} isDisabled={exporting} />
                      </HStack>
                      <Text type="supporting">
                        Selection: {fmtSec(selectionSec)} of {fmtSec(clip.meta.durationSec)}
                      </Text>
                      <Text type="supporting">
                        To trim another video, select it in the Media column first.
                      </Text>
                    </>
                  )}
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
                  {activeTool === "none" && (
                    <>
                      <Text type="supporting">
                        {isFullFrame
                          ? "Crop: full frame. Press Crop in the toolbar to edit it."
                          : `Crop: ${Math.round(clip.crop.x)}, ${Math.round(clip.crop.y)} · ${outRect.width} × ${outRect.height}. Press Crop in the toolbar to edit it.`}
                      </Text>
                      <Text type="supporting">
                        {trimIsFull
                          ? "Trim: full length. Press Trim in the toolbar to edit it."
                          : `Trim: ${fmtSec(clip.trim.startSec)} – ${fmtSec(clip.trim.endSec)} (${fmtSec(selectionSec)}). Press Trim in the toolbar to edit it.`}
                      </Text>
                      {layout && (
                        <Text type="supporting">
                          Layout: {layout.tiles.length} tile{layout.tiles.length === 1 ? "" : "s"} · {layout.outputWidth} ×{" "}
                          {layout.outputHeight} · Audio: {audioSourceName ?? "None"}. Press Layout in the toolbar to edit
                          it, or drag another video from Media onto the canvas.
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
    </Theme>
  );
}
