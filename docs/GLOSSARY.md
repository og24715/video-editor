# Glossary — ubiquitous language

The shared vocabulary for this editor. UI text, code, and conversation use
these terms with these meanings.

| Term | Meaning |
| --- | --- |
| **Media** | A source in the Media pool. Umbrella term: every Media is a Video, an Image, or an Audio. Media itself is never edited; edits happen on Clips. |
| **Video** | A Media with a duration, a video track, and optionally audio (an MP4 file). |
| **Image** | A still Media (PNG, JPEG, or WebP). It has dimensions but no duration of its own; on the timeline it is shown for its Clip's Duration. |
| **Audio** | A Media with a duration and sound but no picture (for example WAV, MP3, M4A, OGG, or FLAC). It is decoded in the browser, shown with a Waveform, and placed on Audio tracks. |
| **Clip** | A copy of a Media placed on a Track. Each Clip has its own Crop plus a Trim (Video) or a Duration (Image), independent of the source Media and of other Clips of the same Media. Called a timeline item in code (`TimelineItem`). |
| **Text clip** | A Clip whose content is text rather than Media. It sits on an Overlay track and has a Duration and a text style (font size, color, outline, position) instead of a Crop and Trim. |
| **Track** | One lane of the Timeline holding Clips. The bottom track is the Base track; tracks above it are Overlay tracks. |
| **Base track** | The first track (V1). Its Clips play back-to-back in order and fill the Stage. Its audio is copied in a Timeline export when nothing needs mixing, and is mixed with the Audio clips and any audible Overlay clips when there are. |
| **Overlay track** | Any track above the Base track (V2, V3, …). Its Clips sit at an explicit start time and rectangle on top of the Base track, picture-in-picture style. An Overlay Clip's own audio plays in the preview and is mixed into a Timeline export at the Clip's Gain when its gain is above 0. |
| **Gain** | A Clip's audio volume multiplier (0–2, default 1). It applies to Audio clips and to Overlay Video clips in the preview (capped at 1×) and in mixed Timeline exports (full range). A gain of 0 keeps the Clip silent. |
| **Audio track** | A Track below the video Tracks (A1, A2, …) that holds Audio clips at explicit start times. Audio tracks are mixed together and with the Base track's audio in a Timeline export. |
| **Audio clip** | A Clip of an Audio Media on an Audio track. It has a Trim, a start time, a Gain, and a Waveform. |
| **Waveform** | The min/max peak picture of an Audio Media, drawn in its pool card and in each Audio clip; trimming a clip windows the Waveform to the trimmed range. |
| **Timeline** | All Tracks together, plus the Output size. The total duration is the longest track end. |
| **Stage** | The preview area that shows the Timeline (or the active Media) at the current playhead. |
| **Output** | The export frame size (width × height) of the Timeline. |
| **Crop** | The rectangular region of a frame that is used: of a Media (its default) or of a Clip (its own). |
| **Trim** | The start/end range of a Video that a Clip uses from its source. |
| **Duration** | How long an Image Clip is shown on the Timeline. Set in the panel or by dragging the Clip's right edge. |
| **Drawer** | The Edit drawer opened by double-clicking a Media or a Clip; it edits Crop and Trim (Video), Crop and Duration (Image Clip), or the text, style, and Duration (Text clip). |
| **Export** | Rendering the active Media (single export, MP4 or GIF) or the whole Timeline (MP4 only) to a file, entirely in the browser via WebCodecs. |

## Retired terms

| Term | Status |
| --- | --- |
| Block | Retired — a timeline item is a Clip. |
| Tile | Retired with Layout mode; overlay Clips are not tiles. |
| Layout | Retired — the Layout mode was removed; the editor is Timeline-only. |
