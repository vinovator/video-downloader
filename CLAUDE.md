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
  flag to both or the helper refuses it.
- **Two copies of `videoId()`**, page and helper, must stay identical.
  `node helper.mjs --self-test` fails if they drift.
- **No em dashes** in UI copy or docs, matching the other sites.

## yt-dlp facts learned the hard way (checked against 2026.08.19)

- With a quality cap, `-S` must be `vcodec:h264,res:720,acodec:aac`. yt-dlp's own `-t mp4`
  order puts `quality` before `res`, and YouTube's quality ranking then ignores the cap.
- `res` is the smaller side, so vertical Shorts compare by width. The page's `resOf()` mirrors it.
- `--print` implies quiet mode and hides the stage lines the helper parses; use `--print-to-file`.
- `--download-sections` numbers chapters from 0 and `--split-chapters` from 1, hence
  `%(section_number+1)02d` for chosen chapters.
- Section downloads go through ffmpeg and report progress only when each part finishes.
- Splitting an Opus file into chapters fails if cover art is embedded, so the page drops
  cover art for that one case. M4A, MP3, FLAC, MP4 and MKV keep it.
- A file that already exists is not downloaded again, but yt-dlp still re-runs tagging on it.

## Checks

    node helper.mjs --self-test     # link parser, allowlist, parser parity

CI runs that and a syntax check of the page script. For UI changes, test both modes in a
browser: open index.html directly, and run `node helper.mjs --dir <scratch folder>`.
