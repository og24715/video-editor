# Video Editor

Browser-based video crop editor. All processing runs locally in the browser
with WebCodecs; Mediabunny handles MP4 demuxing and muxing. The server only
serves the static build.

- Dev: `npm run dev`
- Build: `npm run build`
- Start: `npm run start` (port 8199)
- Service: `video-editor.service` (systemd user unit)

v1 supports loading an MP4, cropping it with a draggable/resizable overlay
or numeric inputs (aspect presets included), and exporting a cropped MP4.
Video is re-encoded (H.264 preferred, VP9/AV1 fallback); the audio track is
copied through without re-encoding. Internal state is a clips array so a
timeline can be added later.
