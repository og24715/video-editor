import { useCallback, useEffect, useRef, useState } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { ttsTheme } from "./themes/tts/tts";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Clapperboard, FolderOpen } from "lucide-react";
import type { ActiveTool, AspectPreset, Clip, CropRect, ToolId, TrimRange } from "./model";
import { evenRect } from "./model";
import { ExportCancelledError, exportCropped, openInput, readMeta, webCodecsSupported } from "./exporter";

const ASPECTS: { value: AspectPreset; label: string; ratio: number | null }[] = [
  { value: "free", label: "Free", ratio: null },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
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

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [aspect, setAspect] = useState<AspectPreset>("free");
  const [activeTool, setActiveTool] = useState<ActiveTool>("none");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultName, setResultName] = useState("");
  const [resultSize, setResultSize] = useState(0);
  const [usedCodec, setUsedCodec] = useState<string | null>(null);
  const [audioCopied, setAudioCopied] = useState<boolean | null>(null);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const thumbsClipRef = useRef<string | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const tlDragRef = useRef<"start" | "end" | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const cancelRef = useRef(false);
  const supported = webCodecsSupported();

  const clip = clips[0] ?? null;
  const ratio = ASPECTS.find((a) => a.value === aspect)?.ratio ?? null;
  const cropActive = activeTool === "crop";
  const trimActive = activeTool === "trim";
  const trimRef = useRef<TrimRange>({ startSec: 0, endSec: 0 });
  const durationRef = useRef(0);
  if (clip) {
    trimRef.current = clip.trim;
    durationRef.current = clip.meta.durationSec;
  }

  const setCrop = useCallback(
    (crop: CropRect) => {
      setClips((prev) => prev.map((c, i) => (i === 0 ? { ...c, crop } : c)));
    },
    [],
  );

  const setTrim = useCallback(
    (trim: TrimRange) => {
      setClips((prev) => prev.map((c, i) => (i === 0 ? { ...c, trim } : c)));
    },
    [],
  );

  const loadFile = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    setActiveTool("none");
    setResultUrl(null);
    setUsedCodec(null);
    setAudioCopied(null);
    setThumbs([]);
    thumbsClipRef.current = null;
    setPlayheadSec(0);
    if (!/\.mp4$/i.test(file.name) && file.type !== "video/mp4") {
      setError("Please choose an MP4 file.");
      return;
    }
    setLoading(true);
    try {
      const input = await openInput(file);
      const meta = await readMeta(input);
      const url = URL.createObjectURL(file);
      const next: Clip = {
        id: `${Date.now()}`,
        file,
        url,
        input,
        meta,
        crop: { x: 0, y: 0, width: meta.width, height: meta.height },
        trim: { startSec: 0, endSec: meta.durationSec },
      };
      setClips((prev) => {
        for (const old of prev) {
          old.input.dispose();
          URL.revokeObjectURL(old.url);
        }
        return [next];
      });
      setAspect("free");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      setPlayheadSec(video.currentTime);
      const trim = trimRef.current;
      const duration = durationRef.current;
      if (duration > 0 && trim.endSec < duration - 0.01 && video.currentTime >= trim.endSec) {
        video.pause();
      }
    };
    const onSeeked = () => setPlayheadSec(video.currentTime);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [clip?.id]);

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
    if (tool === "crop") videoRef.current?.pause();
    setActiveTool((prev) => (prev === tool ? "none" : tool));
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
    setResultUrl(null);
    setActiveTool("none");
    setError(null);
    setNotice(null);
    setThumbs([]);
    thumbsClipRef.current = null;
    setPlayheadSec(0);
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
    video.currentTime = frac * clip.meta.durationSec;
    setPlayheadSec(video.currentTime);
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
      const res = await exportCropped({
        input: clip.input,
        crop: out,
        trim: clip.trim,
        onProgress: (value) => setProgress(value),
        isCancelled: () => cancelRef.current,
      });
      setUsedCodec(res.codecLabel);
      setAudioCopied(res.audioCopied);
      const suggested = `${clip.file.name.replace(/\.mp4$/i, "")}-edited.mp4`;
      const url = URL.createObjectURL(res.blob);
      setResultUrl(url);
      setResultName(suggested);
      setResultSize(res.blob.size);
      const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
      if (picker) {
        try {
          const handle = await picker({
            suggestedName: suggested,
            types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(res.blob);
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
  const isFullFrame =
    clip !== null &&
    Math.round(clip.crop.x) === 0 &&
    Math.round(clip.crop.y) === 0 &&
    Math.round(clip.crop.width) === clip.meta.width &&
    Math.round(clip.crop.height) === clip.meta.height;

  return (
    <Theme theme={ttsTheme} mode="dark">
      <div className="shell">
        <header className="shell-header">
          <HStack gap={3} vAlign="center">
            <Clapperboard size={26} />
            <StackItem size="fill">
              <Heading level={2}>Video Editor</Heading>
            </StackItem>
            <Text type="supporting">Crop · Trim · WebCodecs</Text>
          </HStack>
        </header>
        <main className="shell-main">
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
                  const file = e.dataTransfer.files[0];
                  if (file) void loadFile(file);
                }}
              >
                <VStack gap={3}>
                  {loading ? <Spinner /> : <FolderOpen size={36} />}
                  <Heading level={3}>Drop an MP4 file here</Heading>
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
                    {cropActive && (
                      <Button label="Confirm crop" variant="primary" onClick={confirmCrop} isDisabled={exporting} />
                    )}
                    <SegmentedControl label="Aspect ratio" value={aspect} onChange={changeAspect} isDisabled={!cropActive}>
                      {ASPECTS.map((a) => (
                        <SegmentedControlItem key={a.value} value={a.value} label={a.label} />
                      ))}
                    </SegmentedControl>
                    <Text type="supporting">
                      Output: {outRect.width} × {outRect.height}
                    </Text>
                    <div className="toolbar-spacer" />
                    {exporting ? (
                      <Button
                        label="Cancel"
                        variant="secondary"
                        onClick={() => {
                          cancelRef.current = true;
                        }}
                      />
                    ) : (
                      <Button label="Export MP4" variant="primary" onClick={() => void runExport()} isDisabled={!supported} />
                    )}
                  </div>
                  {exporting && (
                    <div className="toolbar-progress">
                      <div className="progress-track">
                        <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
                      </div>
                      <Text type="supporting">Exporting… {Math.round(progress * 100)}%</Text>
                    </div>
                  )}
                </div>
                <div className="stage-wrap">
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
                  <div className="field-row">
                    {(["x", "y", "width", "height"] as const).map((field) => (
                      <div className="field" key={field}>
                        <label htmlFor={`crop-${field}`}>{field === "width" ? "Width" : field === "height" ? "Height" : field.toUpperCase()}</label>
                        <input
                          id={`crop-${field}`}
                          type="number"
                          min={0}
                          disabled={!cropActive}
                          value={Math.round(clip.crop[field])}
                          onChange={(e) => updateField(field, e.target.value)}
                        />
                      </div>
                    ))}
                  </div>
                  <Text type="supporting">
                    {cropActive
                      ? "Editing crop. Drag the frame or use the fields above, then Confirm crop when done. Output size is adjusted to even numbers."
                      : isFullFrame
                        ? "Crop: full frame. Press Crop in the toolbar to edit it. Output size is adjusted to even numbers."
                        : `Crop: ${Math.round(clip.crop.x)}, ${Math.round(clip.crop.y)} · ${outRect.width} × ${outRect.height}. Press Crop in the toolbar to edit it. Output size is adjusted to even numbers.`}
                  </Text>
                  {trimActive ? (
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
                    </>
                  ) : (
                    <Text type="supporting">
                      {trimIsFull
                        ? "Trim: full length. Press Trim in the toolbar to edit it."
                        : `Trim: ${fmtSec(clip.trim.startSec)} – ${fmtSec(clip.trim.endSec)} (${fmtSec(selectionSec)}). Press Trim in the toolbar to edit it.`}
                    </Text>
                  )}
                  {resultUrl && !exporting && (
                    <VStack gap={2}>
                      <Text type="supporting">
                        Done. Codec: {usedCodec ?? "unknown"}
                        {clip.meta.hasAudio ? (audioCopied ? " · Audio copied without re-encoding" : " · Audio could not be copied") : " · No audio track"}
                        {" · "}
                        {fmtSize(resultSize)}
                      </Text>
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
        </main>
      </div>
    </Theme>
  );
}
