# CLAUDE.md

Guidance for Claude Code working in this repo.

## What this is

A YouTube downloader in two files, listed on vinothhaldorai.com/apps. `index.html` is the
whole UI (inline CSS and JS, no libraries, no build step). Opened from the web or as a file
it writes yt-dlp commands; served by `helper.mjs` from 127.0.0.1 it also reads real formats
and downloads. `helper.mjs` is Node 18+ with built-in modules only. README.md covers setup.

It lives here, not on the Tools shelf (my-ai-tools), because it needs installs and the
internet; every tool there runs entirely in the browser.

## Invariants

- **One source of truth for flags.** `buildArgs()` in index.html is the only place options
  become yt-dlp flags. The helper validates them against `FLAGS` in helper.mjs; add any new
  flag to both or the helper refuses it. `node tests/page.test.mjs` runs `buildArgs()` for
  every option value and fails if the helper would refuse any of it.
- **Two copies of `videoId()`**, page and helper, must stay identical.
  `node helper.mjs --self-test` fails if they drift.
- **The page script ends with a test hook.** The page test runs the last inline script in
  Node with `VIDEO_DOWNLOADER_TEST` set, and the script hands over its functions instead of
  starting. Keep its top level free of DOM calls (wire things up in `bind()` and `init()`),
  keep the hook just above `init()`, and give a new text option some values in the test's
  `STRINGS`. New choices (`ENUMS`) and switches are swept without that.
- **Files beside the helper are served only from a git clone** (`.git` present). A
  downloaded helper usually sits in Downloads, where any site can drop a file, so it fetches
  the page from the live site and serves nothing local. Every response but the page carries
  a sandboxing CSP.
- **No em dashes** in UI copy or docs, matching the other sites.

## Look

Each colour is a CSS variable on `:root`, written once as `light-dark(light, dark)`;
`color-scheme` picks the side (the device's, or `data-theme` from the ribbon's switch). That
needs Chrome or Edge 123, Firefox 120 or Safari 17.5. The switch saves a choice in
`video-downloader-theme` only while it differs from the device, and a script in `<head>`
applies it before first paint. Fonts are the system stack, so no font host is contacted and
the CSP names none. No text is smaller than 13px, except monospace at 12.8px, and text
contrast meets WCAG AA (4.5:1, or 3:1 for large text) in both themes. That is why the ribbon
starts at `#e11d48`: from a lighter red its small white text drops below 4.5:1.

Layout: presets, what to save, format and quality stay open; the other options fold into
`details.opt` sections whose closed summary (`renderSummaries()`) shows the current choice,
or the problem in the warning colour. Which are open is kept in `video-downloader-open`. The
download button and summary sit in a bar that sticks to the bottom of the container, which
is why `.container` uses `overflow: clip`, not `hidden`. A download's progress shows on its
video's card (`cardJob()`); the Downloads list below is the history.

## yt-dlp facts learned the hard way (checked against 2026.08.19)

`tests/page.test.mjs` checks the ones the page is responsible for.

- With a quality cap, `-S` must be `vcodec:h264,res:720,acodec:aac`. yt-dlp's own `-t mp4`
  order puts `quality` before `res`, and YouTube's quality ranking then ignores the cap.
- `res` is the smaller side, so vertical Shorts compare by width. The page's `resOf()` mirrors it.
- `--print` implies quiet mode and hides the stage lines the helper parses; use `--print-to-file`.
- `--split-chapters` numbers chapters from 1, so the chapter files use `%(section_number)02d`.
- A time-range clip goes through ffmpeg and reports no progress until it is done.
- `--sponsorblock-remove` cuts after the audio is converted and before tagging and chapter
  splitting. Its times are for the whole video, so it cannot cut a time-range clip. It cuts
  by copying frames, and a FLAC file keeps its uncut length in the header and frame numbers,
  so the page offers it for neither. WAV, Opus, M4A, MP3, MP4, MKV and WebM cut cleanly.
- `--remove-chapters` with a time range crashes (`TypeError: unhashable type: 'list'`), and a
  time range alone never adds the cutting step. The page does not use it.
- Splitting an Opus file into chapters fails if cover art is embedded, so the page drops
  cover art for that one case. M4A, MP3, FLAC, MP4 and MKV keep it.
- A file that already exists is not downloaded again, but yt-dlp still re-runs tagging on it.
- yt-dlp expands `$NAME`, `${NAME}` and a leading `~` in the typed part of an output
  template (not in fields such as the title), which can point outside the save folder. The
  page drops them from typed names and subfolders, and the helper refuses them. `$$` does
  not escape a `$`.

## Checks

    node helper.mjs --self-test     # link parser, allowlist, parser parity
    node tests/page.test.mjs        # buildArgs() for every option value against FLAGS, yt-dlp facts

CI runs both and a syntax check of the page's scripts. For UI changes, test both modes in a
browser: open index.html directly, and run `node helper.mjs --dir <scratch folder>`.
