#!/usr/bin/env node
// Video Downloader helper.
//
// The page can preview YouTube links and write yt-dlp commands, but a browser
// page cannot download from YouTube itself: YouTube refuses cross-origin
// requests. This helper runs on your own computer, serves that same page from
// http://127.0.0.1, and runs yt-dlp for it.
//
//     node helper.mjs                  start, and open the page
//     node helper.mjs --dir ~/Videos   save somewhere other than ~/Downloads
//     node helper.mjs --self-test      check the URL parser and option allowlist
//
// Only Node's built-in modules are used. Needs Node 18 or newer, plus yt-dlp and
// ffmpeg on your PATH (macOS: brew install yt-dlp ffmpeg).

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_PAGE = 'https://video-downloader.pages.dev/';
const DEFAULT_PORT = 38917;

const USAGE = `Usage: node helper.mjs [options]

  --dir <folder>     where files are saved (default: ~/Downloads)
  --port <number>    port on 127.0.0.1 (default: ${DEFAULT_PORT}, or the next free one)
  --yt-dlp <path>    the yt-dlp to run (default: yt-dlp on your PATH)
  --no-open          do not open the browser
  --self-test        check the URL parser and option allowlist, then exit
  -h, --help         show this help`;

const INSTALL = {
    darwin: 'brew install yt-dlp ffmpeg',
    win32: 'winget install yt-dlp.yt-dlp Gyan.FFmpeg DenoLand.Deno',
    linux: 'pipx install "yt-dlp[default]", then ffmpeg and deno from your package manager',
}[process.platform] || 'see https://github.com/yt-dlp/yt-dlp#installation';

// ------------------------------------------------------------------ YouTube links

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// The same parser as the page's. Anything that is not a single YouTube video is
// refused, so yt-dlp is never pointed at another site, a file or a playlist.
export function videoId(input) {
    const s = String(input ?? '').trim();
    if (ID_RE.test(s)) return s;
    let u;
    try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch' || u.pathname === '/watch/') id = u.searchParams.get('v');
        else id = (u.pathname.match(/^\/(?:shorts|live|embed|v|e)\/([^/]+)/) || [])[1];
    }
    return id && ID_RE.test(id) ? id : null;
}

// ------------------------------------------------------------------ option allowlist

// The page builds the yt-dlp options, so what it shows is what runs. This is the
// only set it can ask for: every flag must be listed and every value must match.
// Anything else (--exec, -P, --config-location, -a, --cookies <file>, plugins...)
// is refused because it is not here. When the page gains an option, add it here.
const SWITCH = null;

const CLOCK = String.raw`\d{1,6}(?::\d{1,2}){0,2}(?:\.\d{1,3})?`;
const RANGE_RE = new RegExp(String.raw`^\*${CLOCK}-(?:${CLOCK}|inf)$`);

function okSection(v) {
    if (RANGE_RE.test(v)) return true;
    // A chapter title as an anchored regex, escaped by the page.
    return v.length <= 300 && v.startsWith('^') && v.endsWith('$') && !/[\x00-\x1f\x7f]/.test(v);
}

const FIELD_RE = /%\((?:title|channel|uploader|id|height|ext|section_title|section_number(?:\+1)?|upload_date(?:>[%A-Za-z0-9 ._-]{1,20})?)\)(?:0?\d?d|s)/g;

function okTemplate(v) {
    const t = v.startsWith('chapter:') ? v.slice('chapter:'.length) : v;
    if (!t || t.length > 400 || /[\x00-\x1f\x7f\\]/.test(t)) return false;
    // Relative only: the helper sets the folder itself with -P.
    if (/^(?:\/|~|[A-Za-z]:)/.test(t)) return false;
    if (t.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
    // Every % must be an escaped %% or one of the fields above.
    return !t.replace(/%%/g, '').replace(FIELD_RE, '').includes('%');
}

const FLAGS = new Map([
    ['-f', /^(?:bv|ba|ba\[ext=m4a\]\/ba|ba\[acodec=opus\]\/ba)$/],
    ['-S', /^[a-z0-9:,]{1,120}$/],
    ['--merge-output-format', /^(?:mp4|mkv|webm)$/],
    ['--remux-video', /^(?:mp4|mkv)$/],
    ['-x', SWITCH],
    ['--audio-format', /^(?:m4a|mp3|opus|flac|wav)$/],
    ['--audio-quality', /^(?:0|[1-9][0-9]{1,2}K)$/],
    ['--download-sections', okSection],
    ['--force-keyframes-at-cuts', SWITCH],
    ['--split-chapters', SWITCH],
    ['--embed-metadata', SWITCH],
    ['--embed-chapters', SWITCH],
    ['--no-embed-chapters', SWITCH],
    ['--embed-thumbnail', SWITCH],
    ['--convert-thumbnails', /^jpg$/],
    ['--write-thumbnail', SWITCH],
    ['--write-description', SWITCH],
    ['--cookies-from-browser', /^(?:chrome|safari|firefox|edge|brave)$/],
    ['-r', /^[0-9]{1,6}(?:\.[0-9]{1,3})?[KMG]?$/],
    ['--force-overwrites', SWITCH],
    ['--restrict-filenames', SWITCH],
    ['--windows-filenames', SWITCH],
    ['-o', okTemplate],
]);

// Returns null when every option is allowed, or the reason it is not.
export function checkArgs(args) {
    if (!Array.isArray(args) || args.length > 60) return 'Options must be a short list.';
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (typeof flag !== 'string' || !FLAGS.has(flag)) return `Option not allowed: ${String(flag).slice(0, 40)}`;
        const rule = FLAGS.get(flag);
        if (rule === SWITCH) continue;
        const v = args[++i];
        const ok = typeof v === 'string' && (typeof rule === 'function' ? rule(v) : rule.test(v));
        if (!ok) return `Value not allowed for ${flag}`;
    }
    return null;
}

// ------------------------------------------------------------------ errors in plain words

const cleanError = (line) => line.replace(/^ERROR:\s*/, '').replace(/^\[[\w:]+\]\s*[\w-]{11}:\s*/, '').trim();

export function hintFor(text) {
    const t = String(text).toLowerCase();
    if (/not a bot|sign in to confirm/.test(t)) return 'YouTube asked for proof that you are not a bot. Under Advanced, pick a browser where you are signed in to YouTube and try again. If it keeps happening, see the README on PO tokens.';
    if (/age[- ]restricted|confirm your age|inappropriate for some users/.test(t)) return 'This video is age-restricted. Under Advanced, pick a browser where you are signed in to YouTube.';
    if (/members[- ]only|join this channel/.test(t)) return 'This is a members-only video. It needs the browser sign-in under Advanced, on an account that has access.';
    if (/private video/.test(t)) return 'This video is private.';
    if (/requested format is not available/.test(t)) return 'That format or quality is not offered for this video. Pick another quality or format.';
    if (/ffmpeg|ffprobe/.test(t) && /not found|not installed|could not find/.test(t)) return `ffmpeg is missing. Install it (${INSTALL}) and restart the helper.`;
    if (/javascript runtime|js runtime|challenge solver/.test(t)) return 'yt-dlp needs a JavaScript runtime for YouTube. Install Deno (macOS: brew install deno) and restart the helper.';
    if (/could not copy .*cookie|cookie.*database|failed to decrypt|keyring/.test(t)) return "yt-dlp could not read that browser's sign-in. Quit the browser and try again, or pick another one under Advanced.";
    if (/operation not permitted/.test(t)) return "Reading Safari's sign-in needs Full Disk Access for the app running the helper (System Settings, Privacy & Security).";
    if (/recording is not available/.test(t)) return 'This live stream has no recording that can be saved.';
    if (/\blive event\b|premieres in|will begin in|\bis live\b/.test(t)) return 'Live streams and premieres can be saved once they have ended.';
    if (/video unavailable|has been removed|does not exist|not available in your country/.test(t)) return 'The video is unavailable: removed, blocked in your region, or the link is wrong.';
    if (/http error 403|unable to extract|signature|nsig|player response/.test(t)) return 'YouTube changed something yt-dlp has not caught up with yet. Update yt-dlp (macOS: brew upgrade yt-dlp) and try again.';
    if (/no space left/.test(t)) return 'The disk is full.';
    return '';
}

// ------------------------------------------------------------------ runtime state

const CLI = { dir: '~/Downloads', port: DEFAULT_PORT, open: true, selfTest: false, help: false, ytdlp: 'yt-dlp' };
const KEY = randomBytes(24).toString('hex');
const TMP_ROOT = path.join(os.tmpdir(), `video-downloader-${process.pid}`);
const CHILD_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
let SAVE_DIR = '';
let HOSTS = new Set();
let ORIGINS = new Set();
let tools = {};

const expandHome = (p) => (p === '~' ? os.homedir() : /^~[/\\]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p);
function tildify(p) {
    const h = os.homedir();
    return p === h ? '~' : p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p;
}

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

// ------------------------------------------------------------------ tools

function firstLine(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
            resolve(err ? null : String(stdout || stderr).split(/\r?\n/)[0].trim());
        });
    });
}

async function detectTools() {
    const [ytdlp, ffmpeg, deno] = await Promise.all([
        firstLine(CLI.ytdlp, ['--version']),
        firstLine('ffmpeg', ['-version']),
        firstLine('deno', ['--version']),
    ]);
    const t = {
        ytdlp: ytdlp ? { version: ytdlp } : null,
        ffmpeg: ffmpeg ? { version: (ffmpeg.match(/version\s+(\S+)/) || [])[1] || ffmpeg } : null,
        deno: deno ? { version: (deno.match(/deno\s+(\S+)/) || [])[1] || deno } : null,
    };
    // yt-dlp versions are release dates, so its age says when it was last updated.
    const m = ytdlp && ytdlp.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if (m) t.ytdlp.ageDays = Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
    return t;
}

// ------------------------------------------------------------------ format info

let infoRunning = 0;
const infoWaiting = [];

async function withInfoSlot(fn) {
    if (infoRunning >= 3) await new Promise((resolve) => infoWaiting.push(resolve));
    infoRunning++;
    try { return await fn(); } finally {
        infoRunning--;
        const next = infoWaiting.shift();
        if (next) next();
    }
}

// Only what the page uses: yt-dlp's full JSON runs to megabytes.
function trimInfo(j) {
    return {
        id: j.id,
        title: j.title || '',
        channel: j.channel || j.uploader || '',
        uploadDate: j.upload_date || '',
        duration: j.duration ?? null,
        live: j.live_status || 'not_live',
        chapters: (j.chapters || []).map((c) => ({ start: c.start_time, end: c.end_time, title: c.title })),
        formats: (j.formats || [])
            .filter((f) => f.protocol !== 'mhtml' && !String(f.format_id).endsWith('-drc'))
            .map((f) => ({
                id: f.format_id,
                ext: f.ext,
                vcodec: f.vcodec || 'none',
                acodec: f.acodec || 'none',
                width: f.width || null,
                height: f.height || null,
                fps: f.fps || null,
                tbr: f.tbr || null,
                abr: f.abr || null,
                size: f.filesize || f.filesize_approx || null,
                proto: f.protocol || '',
            })),
    };
}

function readInfo(url, cookies) {
    return withInfoSlot(() => new Promise((resolve) => {
        const args = ['-J', '--no-playlist', ...(cookies ? ['--cookies-from-browser', cookies] : []), '--', url];
        execFile(CLI.ytdlp, args, { maxBuffer: 64 << 20, timeout: 90000, windowsHide: true, env: CHILD_ENV }, (err, stdout, stderr) => {
            if (!err) {
                try { return resolve({ ok: true, info: trimInfo(JSON.parse(stdout)) }); } catch { /* reported below */ }
            }
            const errors = String(stderr).split(/\r?\n/).filter((l) => l.startsWith('ERROR:')).map(cleanError);
            const error = errors.at(-1)
                || (err && err.code === 'ENOENT' ? 'yt-dlp was not found on your PATH.'
                    : err && err.killed ? 'yt-dlp took too long to answer.' : 'yt-dlp could not read this video.');
            resolve({ ok: false, error, hint: hintFor(errors.join('\n') || error) });
        });
    }));
}

// ------------------------------------------------------------------ downloads

const jobs = [];
const byId = new Map();
let active = null;

// One line per progress update, easy to split. Values yt-dlp does not know print as NA.
const PROGRESS = 'download:VGP %(progress.status)s %(progress.downloaded_bytes)s '
    + '%(progress.total_bytes,progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.vcodec)s';

function publicJob(j) {
    return {
        id: j.id, label: j.label, videoId: j.videoId, status: j.status, stage: j.stage,
        percent: j.percent, downloaded: j.downloaded, total: j.total, speed: j.speed, eta: j.eta,
        files: j.files.map(({ name, folder, size }) => ({ name, folder, size })),
        error: j.error, hint: j.hint, warning: j.warning, created: j.created, finished: j.finished,
    };
}

function addJob(body) {
    const id = videoId(body && body.url);
    if (!id) throw httpError(400, 'Only YouTube video links are accepted.');
    const problem = checkArgs(body.args);
    if (problem) throw httpError(400, problem);
    const job = {
        id: randomBytes(8).toString('hex'),
        videoId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        args: body.args,
        keepFull: body.keepFull !== false,
        splitting: body.args.includes('--split-chapters'),
        label: String(body.label || id).slice(0, 200),
        status: 'queued', stage: 'Waiting', percent: null, downloaded: 0, total: null, speed: null, eta: null,
        files: [], chapterFiles: [], existing: null, sections: 0, sectionIndex: 0,
        error: '', hint: '', warning: '', created: Date.now(), finished: null,
    };
    jobs.push(job);
    byId.set(job.id, job);
    pump();
    return job;
}

// One download at a time: predictable for the connection, and for YouTube.
function pump() {
    if (active) return;
    const next = jobs.find((j) => j.status === 'queued');
    if (next) start(next);
}

function eachLine(stream, fn) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        const parts = (buf + chunk).split(/\r\n|\n|\r/);
        buf = parts.pop();
        parts.forEach(fn);
    });
    stream.on('end', () => { if (buf) fn(buf); });
}

function start(job) {
    active = job;
    job.status = 'running';
    job.stage = 'Starting';
    job.tmp = path.join(TMP_ROOT, job.id);
    mkdirSync(job.tmp, { recursive: true });
    job.pathsFile = path.join(job.tmp, 'paths.txt');
    // Partial files live in the temp path, so the save folder only ever gets
    // finished ones. --print-to-file rather than --print, which would switch on
    // quiet mode and hide the stage lines parsed below.
    const argv = [
        ...job.args,
        '-P', `home:${SAVE_DIR}`, '-P', `temp:${job.tmp}`,
        '--newline', '--progress-template', PROGRESS,
        '--print-to-file', 'after_move:filepath', job.pathsFile,
        '--no-playlist', '--', job.url,
    ];
    console.log(`> ${job.label}`);
    // Its own process group, so cancelling also stops the ffmpeg it starts.
    const child = spawn(CLI.ytdlp, argv, { windowsHide: true, env: CHILD_ENV, detached: process.platform !== 'win32' });
    job.child = child;
    const errors = [];
    eachLine(child.stdout, (line) => onLine(job, line));
    eachLine(child.stderr, (line) => {
        if (line.startsWith('ERROR:')) errors.push(cleanError(line));
        else if (line.startsWith('WARNING:')) job.warning = line.replace(/^WARNING:\s*/, '').slice(0, 300);
    });
    child.on('error', (e) => errors.push(e.code === 'ENOENT' ? 'yt-dlp was not found on your PATH.' : e.message));
    child.on('close', (code) => finish(job, code, errors));
}

function onLine(job, line) {
    if (line.startsWith('VGP ')) {
        const [, , dl, total, speed, eta, vcodec] = line.split(' ');
        const num = (s) => (s === undefined || s === 'NA' ? null : Number(s));
        job.downloaded = num(dl) ?? job.downloaded;
        job.total = num(total);
        job.speed = num(speed);
        job.eta = num(eta);
        job.percent = job.total ? Math.min(100, (job.downloaded / job.total) * 100) : null;
        // Sections go through ffmpeg, which only reports when each one is done.
        if (!job.sections) {
            job.stage = vcodec === 'none' ? 'Downloading audio'
                : vcodec && vcodec !== 'NA' ? 'Downloading video' : 'Downloading';
        }
        return;
    }
    let m;
    if ((m = line.match(/^\[info\] [\w-]+: Downloading (\d+) time ranges?/))) job.sections = Number(m[1]);
    else if (line.startsWith('[download] Destination:')) {
        if (job.sections) {
            job.sectionIndex += 1;
            job.stage = `Downloading part ${job.sectionIndex} of ${job.sections}`;
            job.percent = null;
            job.total = null;
        }
    } else if ((m = line.match(/^\[download\] (.+) has already been downloaded$/))) job.existing = m[1];
    else if (line.startsWith('[youtube]')) job.stage = 'Reading the video page';
    else if (line.startsWith('[Merger]')) { job.stage = 'Merging video and audio'; job.percent = null; }
    else if (line.startsWith('[ExtractAudio]')) { job.stage = 'Converting the audio'; job.percent = null; }
    else if (line.startsWith('[VideoRemuxer]')) job.stage = 'Finishing the file';
    else if (line.startsWith('[ThumbnailsConvertor]') || line.startsWith('[EmbedThumbnail]')) job.stage = 'Adding cover art';
    else if (line.startsWith('[Metadata]')) job.stage = 'Writing tags and chapters';
    else if ((m = line.match(/^\[SplitChapters\] Chapter (\d+); Destination: (.+)$/))) {
        job.stage = `Splitting chapter ${Number(m[1])}`;
        job.chapterFiles.push(m[2]);
    } else if (line.startsWith('[SplitChapters]')) job.stage = 'Splitting into chapters';
    else if (line.startsWith('[MoveFiles]')) job.stage = 'Saving';
}

function describe(file) {
    let size = null;
    try { size = statSync(file).size; } catch { /* gone */ }
    return { name: path.basename(file), folder: tildify(path.dirname(file)), size, path: file };
}

function finish(job, code, errors) {
    active = null;
    job.child = null;
    job.finished = Date.now();
    let saved = [];
    try { saved = readFileSync(job.pathsFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* none */ }
    if (job.status === 'cancelled') {
        console.log(`  cancelled`);
    } else if (code === 0) {
        let files = [...new Set(saved.length ? saved : job.existing ? [job.existing] : [])];
        if (job.splitting && job.chapterFiles.length) {
            if (!job.keepFull) {
                for (const f of files) rmSync(f, { force: true });
                files = [];
            }
            files = [...files, ...job.chapterFiles];
        }
        job.files = files.filter((f) => existsSync(f)).map(describe);
        job.status = 'done';
        // yt-dlp still re-runs tagging on a file it finds already there, so the
        // stage lines after "already downloaded" cannot be trusted for this.
        job.stage = job.existing ? 'Already in the folder' : 'Saved';
        job.percent = 100;
        for (const f of job.files) console.log(`  saved ${f.folder}${path.sep}${f.name}`);
    } else {
        job.status = 'error';
        job.stage = 'Failed';
        job.error = errors.at(-1) || `yt-dlp stopped with exit code ${code}.`;
        job.hint = hintFor(errors.join('\n') || job.error);
        console.log(`  failed: ${job.error}`);
    }
    rmSync(job.tmp, { recursive: true, force: true });
    pump();
}

function kill(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    }
}

function cancel(job) {
    if (job.status === 'queued') {
        job.status = 'cancelled';
        job.stage = 'Cancelled';
        job.finished = Date.now();
    } else if (job.status === 'running') {
        job.status = 'cancelled';
        job.stage = 'Cancelled';
        kill(job.child);
    }
}

function quiet(cmd, args) {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

// Only ever a file that this job produced.
function reveal(job) {
    const file = job.files[0] && job.files[0].path;
    if (!file) throw httpError(404, 'There is no file to show yet.');
    const target = existsSync(file) ? file : path.dirname(file);
    if (process.platform === 'darwin') quiet('open', ['-R', target]);
    else if (process.platform === 'win32') quiet('explorer.exe', [`/select,${target}`]);
    else quiet('xdg-open', [path.dirname(target)]);
}

function clearFinished() {
    for (let i = jobs.length - 1; i >= 0; i--) {
        if (['done', 'error', 'cancelled'].includes(jobs[i].status)) {
            byId.delete(jobs[i].id);
            jobs.splice(i, 1);
        }
    }
}

// ------------------------------------------------------------------ HTTP

const ICONS = { '/favicon.svg': 'image/svg+xml', '/favicon.ico': 'image/x-icon', '/apple-touch-icon.png': 'image/png' };
// The page may only be framed by itself, so no other site can overlay it and steer clicks.
const PAGE_HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', ...extra,
    });
    res.end(data);
}

let cachedPage = null;

async function pageHtml() {
    // From a clone, the page beside this file, read fresh so edits show on reload.
    // The marker stops an unrelated index.html in, say, Downloads being served.
    const local = path.join(HERE, 'index.html');
    if (existsSync(local)) {
        const html = readFileSync(local, 'utf8');
        if (html.includes('<meta name="app" content="video-downloader">')) return html;
    }
    if (cachedPage) return cachedPage;
    try {
        const r = await fetch(LIVE_PAGE, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (cachedPage = await r.text());
    } catch (e) {
        return `<!doctype html><meta charset="utf-8"><title>Video Downloader</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>The page could not be loaded</h1>
<p>The helper is running, but it could not fetch the page from ${LIVE_PAGE} (${String(e.message).replace(/[<>&]/g, '')}).</p>
<p>Check your connection and reload, or save <code>index.html</code> from the project next to this helper and restart it.</p>`;
    }
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        // Past the limit the rest is read and dropped, so the 413 still reaches the client.
        req.on('data', (c) => {
            size += c.length;
            if (size <= 65536) chunks.push(c);
        });
        req.on('end', () => {
            if (size > 65536) return reject(httpError(413, 'That request is too large.'));
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpError(400, 'That request is not valid JSON.')); }
        });
        req.on('error', reject);
    });
}

function keyOk(k) {
    if (typeof k !== 'string' || k.length !== KEY.length) return false;
    return timingSafeEqual(Buffer.from(k), Buffer.from(KEY));
}

async function session() {
    if (!tools.ytdlp || !tools.ffmpeg || !tools.deno) tools = await detectTools();
    return { key: KEY, version: VERSION, dir: tildify(SAVE_DIR), platform: process.platform, install: INSTALL, tools };
}

const FORBIDDEN = { error: 'Requests from other sites are not allowed.' };

async function handle(req, res) {
    // DNS rebinding: a hostile name pointed at 127.0.0.1 still arrives with its own Host.
    const host = String(req.headers.host || '').toLowerCase();
    if (!HOSTS.has(host)) return send(res, 403, { error: 'Unknown host.' });
    const { pathname } = new URL(req.url, `http://${host}`);

    if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
        if (pathname === '/' || pathname === '/index.html') return send(res, 200, await pageHtml(), 'text/html; charset=utf-8', PAGE_HEADERS);
        const icon = ICONS[pathname] && path.join(HERE, pathname.slice(1));
        if (icon && existsSync(icon)) return send(res, 200, readFileSync(icon), ICONS[pathname], { 'Cache-Control': 'max-age=3600' });
        return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }

    // Never approve a preflight: a cross-origin request carrying the key header
    // therefore never gets sent, and the same-origin page never needs one.
    if (req.method === 'OPTIONS') return send(res, 403, FORBIDDEN);
    if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return send(res, 403, FORBIDDEN);

    if (pathname === '/api/session') {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, FORBIDDEN);
        if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
        return send(res, 200, await session());
    }

    if (!keyOk(req.headers['x-helper-key'])) return send(res, 403, { error: 'The page and the helper are out of step. Reload the page.' });

    try {
        if (req.method === 'GET' && pathname === '/api/jobs') return send(res, 200, { jobs: jobs.map(publicJob) });
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Send JSON.' });
        const body = await readJson(req);

        if (pathname === '/api/info') {
            const id = videoId(body.url);
            if (!id) return send(res, 400, { error: 'Only YouTube video links are accepted.' });
            if (body.cookies && !FLAGS.get('--cookies-from-browser').test(body.cookies)) return send(res, 400, { error: 'Unknown browser.' });
            const r = await readInfo(`https://www.youtube.com/watch?v=${id}`, body.cookies);
            return send(res, r.ok ? 200 : 422, r);
        }
        if (pathname === '/api/jobs') return send(res, 201, publicJob(addJob(body)));
        if (pathname === '/api/jobs/clear') { clearFinished(); return send(res, 200, { ok: true }); }

        const m = pathname.match(/^\/api\/jobs\/([0-9a-f]{16})\/(cancel|reveal)$/);
        if (m) {
            const job = byId.get(m[1]);
            if (!job) return send(res, 404, { error: 'No such download.' });
            if (m[2] === 'cancel') cancel(job); else reveal(job);
            return send(res, 200, publicJob(job));
        }
        return send(res, 404, { error: 'Not found.' });
    } catch (e) {
        return send(res, e.status || 500, { error: e.message || 'Something went wrong.' });
    }
}

function listen(server, port, tries = 10) {
    return new Promise((resolve, reject) => {
        const attempt = (p, left) => {
            const onError = (e) => {
                if (e.code === 'EADDRINUSE' && left > 0) attempt(p + 1, left - 1);
                else reject(e);
            };
            server.once('error', onError);
            server.listen(p, '127.0.0.1', () => {
                server.off('error', onError);
                resolve(p);
            });
        };
        attempt(port, tries);
    });
}

function openBrowser(url) {
    if (process.platform === 'darwin') quiet('open', [url]);
    else if (process.platform === 'win32') quiet('cmd', ['/c', 'start', '', url]);
    else quiet('xdg-open', [url]);
}

// ------------------------------------------------------------------ self-test

function selfTest() {
    const results = [];
    const expect = (name, got, want) => results.push({ name, pass: got === want, got, want });
    const ID = 'aqz-KE-bpKQ';

    for (const s of [
        ID, `https://www.youtube.com/watch?v=${ID}`, `youtube.com/watch?v=${ID}&t=90`, `https://youtu.be/${ID}?si=x1`,
        `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}?feature=share`,
        `https://www.youtube.com/embed/${ID}`, `https://m.youtube.com/watch?v=${ID}`,
        `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`, `https://www.youtube-nocookie.com/embed/${ID}`,
    ]) expect(`link accepted: ${s}`, videoId(s), ID);
    for (const s of [
        '', 'hello', 'aqz-KE-bpK', `https://vimeo.com/${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`,
        'https://www.youtube.com/playlist?list=PL0123456789', `ftp://youtube.com/watch?v=${ID}`,
        `https://www.youtube.com/watch?v=${ID}x`, `file:///etc/passwd`,
    ]) expect(`link refused: ${s || '(empty)'}`, videoId(s), null);

    const allowed = [
        ['-S', 'vcodec:h264,res:1080,acodec:aac', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '-o', 'My video.%(ext)s'],
        ['-S', 'res,ext:webm:webm', '--merge-output-format', 'webm', '-o', '%(title)s.%(ext)s'],
        ['-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a', '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg'],
        ['-f', 'ba[acodec=opus]/ba', '-x', '--audio-format', 'opus', '--no-embed-chapters'],
        ['-f', 'ba', '-x', '--audio-format', 'mp3', '--audio-quality', '320K'],
        ['-f', 'ba', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
        ['-f', 'bv', '-S', 'res:720', '--remux-video', 'mkv'],
        ['--download-sections', '*1:30-2:45', '--force-keyframes-at-cuts', '-o', 'Clip (1m30s-2m45s).%(ext)s'],
        ['--download-sections', '*1:02:03-inf'],
        ['--download-sections', '^Rigging & Animation$', '-o', 'Talk - %(section_number+1)02d %(section_title)s.%(ext)s'],
        ['--split-chapters', '-o', '%(title)s.%(ext)s', '-o', 'chapter:%(title)s - chapters/%(section_number)02d %(section_title)s.%(ext)s'],
        ['-o', 'Lectures/%(upload_date>%Y-%m-%d)s %(channel)s - %(title)s [%(id)s] %(height)sp.%(ext)s'],
        ['-o', '100%% honest.%(ext)s', '--cookies-from-browser', 'chrome', '-r', '4.2M', '--force-overwrites', '--restrict-filenames'],
        ['--write-thumbnail', '--write-description', '--windows-filenames', '--embed-chapters'],
    ];
    for (const a of allowed) expect(`options allowed: ${a.join(' ')}`, checkArgs(a), null);

    const refused = [
        ['--exec', 'rm -rf ~'], ['-P', '/tmp'], ['--config-location', '/tmp/x'], ['-a', 'list.txt'],
        ['--cookies', 'cookies.txt'], ['--ppa', 'x'], ['--plugin-dirs', '.'], ['--load-info-json', 'x.json'],
        ['-o', '/etc/passwd'], ['-o', '~/x.%(ext)s'], ['-o', '../x.%(ext)s'], ['-o', 'a/../../x'], ['-o', 'a//b'],
        ['-o', 'C:x'], ['-o', 'a\\b'], ['-o', '50% off.%(ext)s'], ['-o', '%(filepath)s'], ['-o', '%(title)r'],
        ['-o', 'x\nnext'], ['-o'], ['-o', 'chapter:'], ['-f', 'bv*;ls'], ['-f', 'best'], ['-S', 'res:1080;id'],
        ['--cookies-from-browser', 'chrome:../../x'], ['--download-sections', 'intro'], ['--download-sections', '*1:00'],
        ['--audio-format', 'exe'], ['--audio-quality', '-1'], ['-r', '1e9'], ['--split-chapters', 'yes'],
        [42], 'not a list', new Array(61).fill('-x'),
    ];
    for (const a of refused) expect(`options refused: ${JSON.stringify(a).slice(0, 80)}`, checkArgs(a) === null, false);

    expect('hint: bot check', /not a bot/.test(hintFor("Sign in to confirm you're not a bot")), true);
    expect('hint: format', /another quality/.test(hintFor('Requested format is not available')), true);
    expect('hint: unknown', hintFor('something odd'), '');
    // "this live" must not read as "is live".
    expect('hint: ended stream without a recording', /no recording/.test(hintFor('This live stream recording is not available.')), true);
    expect('hint: live now', /once they have ended/.test(hintFor('This video is live now')), true);

    // The page carries its own copy of videoId(). From a clone, check they match.
    const pagePath = path.join(HERE, 'index.html');
    if (existsSync(pagePath)) {
        const copy = readFileSync(pagePath, 'utf8').match(/function videoId\(input\) \{[\s\S]*?\n {8}\}/);
        const norm = (s) => s.replace(/\s+/g, ' ').trim();
        expect('page and helper parse links the same way', !!copy && norm(copy[0]) === norm(videoId.toString()), true);
    }

    const failed = results.filter((r) => !r.pass);
    for (const f of failed) console.error(`FAIL ${f.name}\n     got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`);
    console.log(`[self-test] ${results.length - failed.length} of ${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

// ------------------------------------------------------------------ main

function parseCli(argv) {
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`${a} needs a value`);
            return v;
        };
        if (a === '--dir') CLI.dir = value();
        else if (a === '--port') CLI.port = Number(value());
        else if (a === '--yt-dlp') CLI.ytdlp = value();
        else if (a === '--no-open') CLI.open = false;
        else if (a === '--self-test') CLI.selfTest = true;
        else if (a === '-h' || a === '--help') CLI.help = true;
        else throw new Error(`Unknown option: ${a}`);
    }
    if (!Number.isInteger(CLI.port) || CLI.port < 1024 || CLI.port > 65535) throw new Error('--port must be between 1024 and 65535');
}

async function main() {
    try { parseCli(process.argv.slice(2)); } catch (e) {
        console.error(`${e.message}\n\n${USAGE}`);
        process.exit(2);
    }
    if (CLI.help) return console.log(USAGE);
    if (CLI.selfTest) return selfTest();

    SAVE_DIR = path.resolve(expandHome(CLI.dir));
    mkdirSync(SAVE_DIR, { recursive: true });
    tools = await detectTools();

    const server = http.createServer((req, res) => {
        handle(req, res).catch((e) => send(res, 500, { error: e.message }));
    });
    let port;
    try { port = await listen(server, CLI.port); } catch (e) {
        console.error(`Could not start the helper: ${e.message}`);
        process.exit(1);
    }
    HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

    const url = `http://127.0.0.1:${port}/`;
    const have = (t, name) => (t ? `${name} ${t.version}` : `${name} missing`);
    console.log(`Video Downloader helper ${VERSION}`);
    console.log(`  Page:    ${url}`);
    console.log(`  Saving:  ${tildify(SAVE_DIR)}`);
    console.log(`  Tools:   ${have(tools.ytdlp, 'yt-dlp')}, ${have(tools.ffmpeg, 'ffmpeg')}, ${have(tools.deno, 'deno')}`);
    if (!tools.ytdlp || !tools.ffmpeg) console.log(`  Install what is missing with: ${INSTALL}`);
    else if (!tools.deno) console.log('  yt-dlp needs Deno for YouTube. Install it (macOS: brew install deno).');
    if (tools.ytdlp && tools.ytdlp.ageDays > 90) console.log(`  yt-dlp is ${tools.ytdlp.ageDays} days old. YouTube changes often, so update it.`);
    console.log('Leave this window open while you download. Press Ctrl+C to stop.\n');

    if (CLI.open) openBrowser(url);

    const shutdown = () => {
        for (const j of jobs) if (j.status === 'running') { j.status = 'cancelled'; kill(j.child); }
        rmSync(TMP_ROOT, { recursive: true, force: true });
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// Run only when started directly, so the parser and allowlist can be imported.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
