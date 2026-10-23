// Video Downloader page checks.
//
// The page builds the yt-dlp options and the helper only accepts what is on its
// allowlist, so the two must agree. This runs the page's own script in Node, with
// VIDEO_DOWNLOADER_TEST set so it hands over its functions instead of starting,
// and sends every option it can build through the helper's checkArgs(). It also
// checks the yt-dlp facts in CLAUDE.md that the page is responsible for.
//
//     node tests/page.test.mjs
//
// Only Node's built-in modules are used.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkArgs, videoId } from '../helper.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const P = {};
// Just enough browser for the script's top level; the rest only runs once started.
vm.runInNewContext(script, { VIDEO_DOWNLOADER_TEST: P, URL, document: { title: '' }, navigator: { userAgent: '' } });
if (!P.buildArgs) {
    console.error('The page did not hand over its functions. Is the VIDEO_DOWNLOADER_TEST hook still just above init()?');
    process.exit(1);
}

const results = [];
const same = (a, b) => (a !== null && typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));
const expect = (name, got, want) => results.push({ name, pass: same(got, want), got, want });
const show = (v) => (Number.isNaN(v) ? 'NaN' : JSON.stringify(v));

// ------------------------------------------------------------------ a video to build for

const ID = 'aqz-KE-bpKQ';
const item = { id: ID, url: `https://www.youtube.com/watch?v=${ID}`, title: 'Big Buck Bunny' };
// Chapters, for splitting the video into one file per chapter.
const info = {
    id: ID, title: 'Big Buck Bunny', channel: 'Blender', uploadDate: '20140410', duration: 635, live: 'not_live', formats: [],
    chapters: [
        { start: 0, end: 60, title: 'Intro' },
        { start: 60, end: 300, title: 'Rigging & Animation' },
        { start: 300, end: 635, title: '(Part 1) [HD] $5? *' },
    ],
};
// What ctx() gives buildArgs() in each situation.
const CONTEXTS = {
    'command mode': { single: true, item, info: null, direct: false },
    'command mode, several videos': { single: false, item: null, info: null, direct: false },
    'direct mode': { single: true, item, info, direct: true },
    'direct mode, formats not read yet': { single: true, item, info: null, direct: true },
    'direct mode, several videos': { single: false, item: null, info: null, direct: true },
};

// ------------------------------------------------------------------ the helper accepts what the page builds

const PARTS = ['whole', 'range', 'split'];
// Values for the options typed as text. Choices and switches come from the page itself,
// so a new choice or switch is covered without touching this file.
const STRINGS = {
    part: PARTS,
    start: ['', '1:30', '90', '1h2m3s', 'abc'],
    end: ['', '2:45', '600', '1h2m3s', 'abc'],
    name: ['', 'My {title} 100% {res}', '{date} {channel} - {title} [{id}]', '../x', 'a/b\\c:d*e?f"g<h>i|j', 'ünï 🎬',
        '~/x', '~root', '${HOME}', '$HOME/x', '$$USER', 'Costs $ 5'],
    folder: ['~/Downloads', '~/My Videos'],
    sub: ['', 'Lectures', '../up', 'a/b', '.hidden', '~/x', '~root', '$HOME', '${HOME}'],
    rate: ['', '500K', '4.2M', 'fast'],
};
const values = (key) => P.ENUMS[key] || (typeof P.DEFAULTS[key] === 'boolean' ? [true, false] : STRINGS[key]);
const tryValues = (key) => values(key) || [P.DEFAULTS[key]];

expect('every text option has values to try here', Object.keys(P.DEFAULTS).filter((k) => !values(k)), []);

const refused = [];
let tried = 0;
function tryArgs(label, o, c) {
    tried++;
    const args = P.buildArgs(o, c);
    const problem = checkArgs(args);
    if (problem) refused.push({ label, problem, args });
}

// Every format and part in every situation, changing one option at a time through all its values.
for (const mode of P.ENUMS.mode) {
    const fmtKey = mode === 'audio' ? 'afmt' : 'vfmt';
    for (const fmt of P.ENUMS[fmtKey]) {
        for (const part of PARTS) {
            for (const [where, c] of Object.entries(CONTEXTS)) {
                const base = { ...P.DEFAULTS, mode, [fmtKey]: fmt, part, start: '1:30', end: '2:45' };
                for (const key of Object.keys(P.DEFAULTS)) {
                    for (const value of tryValues(key)) {
                        // A typed name only counts once it has been touched.
                        const o = { ...base, [key]: value, ...(key === 'name' ? { nameTouched: true } : {}) };
                        tryArgs(`${where}, ${mode} ${fmt}, ${part}, ${key} ${JSON.stringify(value)}`, o, c);
                    }
                }
            }
        }
    }
}

// And whole random combinations, the same ones every run.
let seed = 11;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const any = (list) => list[Math.floor(random() * list.length)];
for (let n = 0; n < 3000; n++) {
    const o = Object.fromEntries(Object.keys(P.DEFAULTS).map((k) => [k, any(tryValues(k))]));
    const where = any(Object.keys(CONTEXTS));
    tryArgs(`${where}, ${JSON.stringify(o)}`, o, CONTEXTS[where]);
}
expect(`the helper accepts every option the page builds (${tried} tried)`, refused.length, 0);

// ------------------------------------------------------------------ yt-dlp facts from CLAUDE.md

const direct = CONTEXTS['direct mode'];
const build = (over) => P.buildArgs({ ...P.DEFAULTS, ...over }, direct);
const valuesOf = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

expect('a quality cap keeps H.264 first: -S vcodec:h264,res:720,acodec:aac',
    valuesOf(build({ mode: 'av', vfmt: 'mp4', compat: true, cap: '720' }), '-S'), ['vcodec:h264,res:720,acodec:aac']);

// res is the smaller side, so a vertical Short compares by its width.
expect('res of a 1080x1920 Short is 1080', P.resOf({ width: 1080, height: 1920 }), 1080);
const short = {
    duration: 30, chapters: [], formats: [
        { id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1080, height: 1920, fps: 30, tbr: 3000, proto: 'https' },
        { id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', width: 720, height: 1280, fps: 30, tbr: 1500, proto: 'https' },
        { id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, tbr: 129, proto: 'https' },
    ],
};
expect('a 1080p cap on a vertical Short takes its 1080x1920 file', P.pick(short, { ...P.DEFAULTS, cap: '1080' }).video.id, '137');
expect('a 720p cap on a vertical Short takes its 720x1280 file', P.pick(short, { ...P.DEFAULTS, cap: '720' }).video.id, '136');

// --split-chapters numbers the chapters from 1.
expect('every chapter goes into its own folder, numbered as yt-dlp splits them',
    valuesOf(build({ part: 'split' }), '-o'), ['%(title)s.%(ext)s', 'chapter:%(title)s - chapters/%(section_number)02d %(section_title)s.%(ext)s']);

// Splitting an Opus file into chapters fails with cover art embedded; every other format keeps it.
const embeds = (over) => build({ cover: true, ...over }).includes('--embed-thumbnail');
expect('Opus split into chapters leaves cover art out', embeds({ mode: 'audio', afmt: 'opus', part: 'split' }), false);
expect('Opus keeps cover art when not split', embeds({ mode: 'audio', afmt: 'opus' }), true);
for (const afmt of ['m4a', 'mp3', 'flac']) {
    expect(`${afmt.toUpperCase()} split into chapters keeps cover art`, embeds({ mode: 'audio', afmt, part: 'split' }), true);
}
for (const vfmt of ['mp4', 'mkv']) {
    expect(`${vfmt.toUpperCase()} split into chapters keeps cover art`, embeds({ mode: 'av', vfmt, part: 'split' }), true);
}
expect('WebM never embeds cover art', embeds({ mode: 'av', vfmt: 'webm' }), false);
expect('WAV never embeds cover art', embeds({ mode: 'audio', afmt: 'wav' }), false);
expect('WAV with tags leaves chapter markers out', build({ mode: 'audio', afmt: 'wav', tags: true }).includes('--no-embed-chapters'), true);

// SponsorBlock's times are for the whole video, and yt-dlp's cut leaves a FLAC file
// reporting its uncut length; every other format cuts cleanly.
const sponsorFlag = (over) => valuesOf(build({ sponsor: true, ...over }), '--sponsorblock-remove');
expect('SponsorBlock cuts sponsors, self-promotion and reminders', sponsorFlag({}), ['sponsor,selfpromo,interaction']);
expect('SponsorBlock is off for a time range', sponsorFlag({ part: 'range', start: '1:30', end: '2:45' }), []);
expect('SponsorBlock stays off while a time range is being typed', sponsorFlag({ part: 'range', start: '1:30', end: '0:45' }), []);
expect('SponsorBlock is off for FLAC', sponsorFlag({ mode: 'audio', afmt: 'flac' }), []);
expect('SponsorBlock works on WAV', sponsorFlag({ mode: 'audio', afmt: 'wav' }), ['sponsor,selfpromo,interaction']);
expect('SponsorBlock cuts before a split into chapters', sponsorFlag({ part: 'split' }), ['sponsor,selfpromo,interaction']);

// yt-dlp expands $NAME, ${NAME} and a leading ~ in the typed part of a template, and
// the result could point outside the folder. Fields such as the title are not expanded.
expect('a typed $NAME, ${NAME} or leading ~ never reaches yt-dlp',
    valuesOf(build({ name: '~/${HOME} $$USER x', nameTouched: true, sub: '~$TMPDIR' }), '-o'), ['TMPDIR/{HOME} USER x.%(ext)s']);

// ------------------------------------------------------------------ links, times and the command

for (const [text, want] of [['90', 90], ['90s', 90], ['1m30s', 90], ['1h2m3s', 3723], ['1:30', 90], ['1:02:03', 3723], ['', null], ['abc', NaN]]) {
    expect(`time ${JSON.stringify(text)}`, P.parseTime(text), want);
}
expect('a ?t= timestamp becomes the start', P.linkStart(`https://youtu.be/${ID}?t=90`), 90);
expect('a #t= timestamp becomes the start', P.linkStart(`https://www.youtube.com/watch?v=${ID}#t=1m30s`), 90);
expect('no timestamp, no start', P.linkStart(`https://www.youtube.com/watch?v=${ID}`), null);

const many = Array.from({ length: 60 }, (_, i) => `https://youtu.be/${String(i).padStart(11, 'x')}`);
const parsed = P.parseLinks([ID, `https://youtu.be/${ID}`, 'https://www.youtube.com/playlist?list=PL0123456789', 'hello', ...many].join('\n'));
expect('links: duplicates dropped, playlists counted, the first 50 kept',
    [parsed.items.length, parsed.items[0].id, parsed.extra, parsed.playlists, parsed.bad], [50, ID, 11, 1, ['hello']]);

// The page's copy of videoId() must read links as the helper does. The self-test
// compares the two sources; this compares what they return.
const LINKS = [
    ID, ` ${ID} `, `https://www.youtube.com/watch?v=${ID}`, `youtube.com/watch?v=${ID}&t=90`, `https://youtu.be/${ID}?si=x1`,
    `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}?feature=share`, `https://www.youtube.com/embed/${ID}`,
    `https://m.youtube.com/watch?v=${ID}`, `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`, `https://www.youtube-nocookie.com/embed/${ID}`,
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, `https://www.youtube.com/watch/?v=${ID}`, `https://www.youtube.com/v/${ID}`, `http://youtu.be/${ID}`,
    '', 'hello', 'aqz-KE-bpK', `https://vimeo.com/${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`,
    'https://www.youtube.com/playlist?list=PL0123456789', `ftp://youtube.com/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}x`,
    'file:///etc/passwd', `https://user@youtu.be/${ID}`, `//youtu.be/${ID}`, null, undefined, 42,
];
expect('the page and the helper read every link the same way', LINKS.filter((s) => P.videoId(s) !== videoId(s)).map(String), []);

expect('Terminal: ~/ stays outside the quotes', P.quote('~/My Videos', 'posix'), "~/'My Videos'");
expect("PowerShell: a ' is doubled", P.quote("It's", 'pwsh'), "'It''s'");
expect('the command has one option per line, then the folder and the links',
    P.commandText(['-f', 'ba', '-x'], [item.url], '~/Downloads', 'posix'),
    `yt-dlp \\\n  -f ba \\\n  -x \\\n  --no-playlist \\\n  -P ~/Downloads \\\n  '${item.url}'`);

// ------------------------------------------------------------------ report

const failed = results.filter((r) => !r.pass);
for (const f of failed) console.error(`FAIL ${f.name}\n     got ${show(f.got)}, want ${show(f.want)}`);
for (const r of refused.slice(0, 5)) console.error(`     refused (${r.problem}): ${r.label}\n       ${r.args.join(' ')}`);
if (refused.length > 5) console.error(`     and ${refused.length - 5} more refused`);
console.log(`[page-test] ${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
