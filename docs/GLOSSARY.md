# Glossary — ubiquitous language

The shared vocabulary for this editor. UI text, code, and conversation use
these terms with these meanings.

| Term | Meaning |
| --- | --- |
| **Media** | A source in the Media pool. Umbrella term: every Media is either a Video or an Image. Media itself is never edited; edits happen on Clips. |
| **Video** | A Media with a duration, a video track, and optionally audio (an MP4 file). |
| **Image** | A still Media (PNG, JPEG, or WebP). It has dimensions but no duration of its own; on the timeline it is shown for its Clip's Duration. |
| **Clip** | A copy of a Media placed on a Track. Each Clip has its own Crop plus a Trim (Video) or a Duration (Image), independent of the source Media and of other Clips of the same Media. Called a timeline item in code (`TimelineItem`). |
| **Text clip** | A Clip whose content is text rather than Media. It sits on an Overlay track and has a Duration and a text style (font size, color, outline, position) instead of a Crop and Trim. |
| **Track** | One lane of the Timeline holding Clips. The bottom track is the Base track; tracks above it are Overlay tracks. |
| **Base track** | The first track (V1). Its Clips play back-to-back in order, fill the Stage, and are the only source of audio in a Timeline export. |
| **Overlay track** | Any track above the Base track (V2, V3, …). Its Clips sit at an explicit start time and rectangle on top of the Base track, picture-in-picture style, and are silent. |
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
