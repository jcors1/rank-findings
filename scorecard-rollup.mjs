#!/usr/bin/env node
// Reads the scorecard blocks the home agent's runs post to the run-log
// stories, and computes the week's figures and a dashboard page from them.
// The rule for when and how a run uses it is in
// agents/home-systems-news-watch.md, "Friday catch-up and audit"; the run log
// is defined in agents/home-systems.md, "Jira rules", "The run log"; the
// scorecard's labels are in agents/home-systems-news-watch.md, "Scorecard
// block". This file only reads, counts and draws. It gives no verdict, tier
// or rank, makes no network call, and reads no Jira, inventory or secrets:
// the run supplies the comments and stories as files.
//
// Usage:
//   node tools/scorecard-rollup.mjs --comments <comments.json>
//        [--stories <stories.json>] --days <n> [--now <ISO time>] --out <folder>
//
// Input 1, comments.json: one JSON list, every comment of the run-log
// stories read, in any order:
//   [ { "created": "2026-11-27T06:50:12.123-0500", "body": "<comment text>" } ]
// "created" is the comment's creation time; "body" is its text. A body holds
// one scorecard block: a line that says only "Scorecard", then one
// "label: value" line per label, with or without a code fence around it.
// A body with no block is skipped and counted. A block whose "run" is not
// daily, digest, audit or sweep, or whose "date" is not a real YYYY-MM-DD
// date, cannot be placed: it is listed under "unreadable" with the reason and
// is in no figure. A block written before 2026-11-21 has no "status", no
// "caught by audit" and no "source:" lines: those values are "unknown".
//
// Input 2, stories.json (optional): one JSON list of the open intake stories:
//   [ { "key": "KAN-1", "created": "<ISO time>", "status": "In Review",
//       "label": "agent-proposed" } ]
// "key" and "created" are required. The script does not decide which stories
// are open: it takes the list as given.
//
// THE WINDOW IS IN CALENDAR DATES, America/New_York: the last n dates ending
// on the date of --now (default: the time of the run). A scorecard belongs to
// the date its own "date:" line gives, not to the time its comment was posted.
//
// Output: two files in the folder (made if it is missing), and their two
// paths on stdout, one per line, exit 0.
//
// metrics.json:
//   {
//     "generatedBy": "tools/scorecard-rollup.mjs",
//     "window": { "from", "to", "days", "now", "timeZone", "dates": [...] },
//     "input": { "comments", "scorecards", "withoutScorecard",
//                "unreadable": [ { "created", "reason" } ] },
//     "days": [ { "date", "runs": [ <run> ] } ],     one per date in the window
//     "missingDaily": [ dates in the window with no daily scorecard ],
//     "duplicates": [ { "run", "date", "created": [...] } ],
//     "streaks": [ { "source", "run", "count", "newestResult", "newestDate",
//                    "since" } ],
//     "totals": <totals>,                             the window
//     "weeks": [ { "week": "2026-W47", "from", "to", "totals": <totals> } ],
//     "openStories": { "given", "count",
//                      "stories": [ { "key", "created", "status", "label", "ageDays" } ] }
//   }
// <run> is one scorecard: "run", "date", "created", "procedureCommit",
// "status" (VALID, FAILED or "unknown"), "sourcesListed", "readInFull",
// "readInPart", "searchedOnly", "couldNotCheck", "inventoryRead", "events",
// "applies", "cannotTell", "doesNotApply", "alsoSeen", "storiesCreated",
// "commentsPosted", "caughtByAudit", "tokens", "sources" (a list of
// { "name", "result" }, or "unknown"), "sourceLinesAgree" (whether the source
// lines add up to the four source counts: true, false or "unknown"),
// "problems" (what in the block could not be read as written) and
// "duplicate". A count is a number, or "unknown" when the line is missing or
// does not hold a whole number; "caughtByAudit" may also be "not applicable".
// "tokens" is a number when the line holds one, else the text as written.
// "duplicates": two or more scorecards with the same run type and date. Each
// is kept, marked "duplicate": true, and counted in the totals; none is
// merged or dropped.
// "streaks": for each source name and run type, "count" is the number of runs
// of that type in a row, ending at the newest one, whose result for that
// source was "could not check" or "searched only". A run that does not list
// the source, or has no source lines, ends the count: its result is not
// known. Source names are compared in any letter case. All scorecards in the
// input are used, not only the window's. Longest first.
// <totals>: { "scorecards", "runs": { "daily", "digest", "audit", "sweep" },
// "status": { "VALID", "FAILED", "unknown" }, "sums": { one per count above,
// and "tokens" }, "unknown": { the same keys: how many scorecards gave no
// number for it, "not applicable" not counted } }. A value that is not a
// number is left out of its sum and counted under "unknown", never as 0.
// "weeks": the same totals for each ISO week (Monday to Sunday) in the input
// that is before the ISO week the window ends in, oldest first. The window
// can reach back into the newest of them, so the two overlap.
// "openStories": "ageDays" is whole calendar days from the story's creation
// date to the date of --now, in New York. Oldest first. With no stories file,
// "given" is false and "count" is "unknown".
//
// dashboard.html: one self-contained page, with no script and no outside
// file, drawn from metrics.json alone (renderDashboard). It computes no
// figure of its own.
//
// On any error (bad options, a file that cannot be read, or input in the
// wrong shape): one line on stderr naming what was wrong, nothing on stdout,
// nothing written, exit 1.
//
// Plain Node (22 or 24), no dependencies, no network.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'tools/scorecard-rollup.mjs';
const TIME_ZONE = 'America/New_York';
const DAY_MS = 24 * 60 * 60 * 1000;
const RUNS = ['daily', 'digest', 'audit', 'sweep'];
const RESULTS = ['read in full', 'read in part', 'searched only', 'could not check'];
const FAILING = ['could not check', 'searched only'];

// Scorecard label -> the name the value has in the output. All are counts.
const COUNTS = {
  'sources listed': 'sourcesListed',
  'sources read in full': 'readInFull',
  'read in part': 'readInPart',
  'searched only': 'searchedOnly',
  'could not check': 'couldNotCheck',
  'events collected': 'events',
  applies: 'applies',
  'cannot tell': 'cannotTell',
  'does not apply': 'doesNotApply',
  'also seen': 'alsoSeen',
  'stories created': 'storiesCreated',
  'comments posted': 'commentsPosted',
  'caught by audit': 'caughtByAudit',
};
const SUMMED = [...Object.values(COUNTS), 'tokens'];

// ---- dates: calendar dates as "YYYY-MM-DD" ----

const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;
const dateOf = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const isDate = (text) => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) && dateOf(dayNumber(text)) === text;

// Jira writes a time zone as "-0500"; make it "-05:00" so every Node reads it.
function timeOf(text) {
  if (typeof text !== 'string') return NaN;
  return Date.parse(text.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

const nyFormat = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
function nyDate(ms) {
  const parts = Object.fromEntries(nyFormat.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The ISO week a date is in: its name, its Monday and its Sunday.
function isoWeek(date) {
  const mondayOf = (n) => n - ((new Date(n * DAY_MS).getUTCDay() + 6) % 7);
  const monday = mondayOf(dayNumber(date));
  const year = new Date((monday + 3) * DAY_MS).getUTCFullYear();
  const week = (monday - mondayOf(dayNumber(`${year}-01-04`))) / 7 + 1;
  return { week: `${year}-W${String(week).padStart(2, '0')}`, from: dateOf(monday), to: dateOf(monday + 6) };
}

// ---- reading one scorecard block ----

const LABEL_LINE = /^([a-z][a-z ]*?)\s*:\s*(.*)$/;

// The scorecard in one comment body, or null when the body holds none.
// `run` and `date` are returned as written; rollup() checks them.
export function parseScorecard(body) {
  if (typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line, i) => line === 'Scorecard' && LABEL_LINE.test(lines[i + 1] ?? ''));
  if (start === -1) return null;
  const problems = [];
  const values = new Map();
  const sourceLines = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = LABEL_LINE.exec(lines[i]);
    if (!m) break;
    const [, label, value] = m;
    if (label === 'source') sourceLines.push(value);
    else if (values.has(label)) problems.push(`${label}: given twice; the first is used`);
    else values.set(label, value);
  }
  if (lines.slice(start + 1).includes('Scorecard')) problems.push('more than one scorecard block in the comment; the first is used');

  const text = (label) => (values.has(label) && values.get(label) !== '' ? values.get(label) : 'unknown');
  const count = (label) => {
    const value = text(label);
    if (/^\d+$/.test(value)) return Number(value);
    if (value === 'unknown') return 'unknown';
    if (label === 'caught by audit' && value.toLowerCase() === 'not applicable') return 'not applicable';
    problems.push(`${label}: not a whole number ("${value}")`);
    return 'unknown';
  };

  const card = { run: text('run'), date: text('date'), procedureCommit: text('procedure commit') };
  const status = text('status');
  if (['VALID', 'FAILED'].includes(status.toUpperCase())) card.status = status.toUpperCase();
  else {
    if (status !== 'unknown') problems.push(`status: neither VALID nor FAILED ("${status}")`);
    card.status = 'unknown';
  }
  for (const label of ['sources listed', 'sources read in full', 'read in part', 'searched only', 'could not check']) card[COUNTS[label]] = count(label);
  card.inventoryRead = text('inventory read');
  for (const label of ['events collected', 'applies', 'cannot tell', 'does not apply', 'also seen', 'stories created', 'comments posted', 'caught by audit']) card[COUNTS[label]] = count(label);

  const tokens = text('tokens');
  const number = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/i.exec(tokens);
  card.tokens = number ? Math.round(Number(number[1].replace(/,/g, '')) * (number[2] ? 1000 : 1)) : tokens;

  if (sourceLines.length === 0) {
    card.sources = 'unknown';
    card.sourceLinesAgree = 'unknown';
  } else {
    card.sources = sourceLines.map((line) => {
      const cut = line.lastIndexOf('=');
      const name = (cut === -1 ? line : line.slice(0, cut)).trim();
      const written = cut === -1 ? '' : line.slice(cut + 1).trim();
      const result = RESULTS.find((r) => new RegExp(`^${r}(?![a-z])`, 'i').test(written));
      if (!result) problems.push(`source "${name}": result is not one of the four ("${written}")`);
      return { name, result: result ?? 'unknown' };
    });
    const stated = [card.sourcesListed, card.readInFull, card.readInPart, card.searchedOnly, card.couldNotCheck];
    if (stated.some((n) => typeof n !== 'number')) card.sourceLinesAgree = 'unknown';
    else {
      const counted = [card.sources.length, ...RESULTS.map((r) => card.sources.filter((s) => s.result === r).length)];
      card.sourceLinesAgree = counted.every((n, i) => n === stated[i]);
      if (!card.sourceLinesAgree) problems.push(`source lines do not agree with the source counts: the lines give ${counted.join(', ')} (listed, in full, in part, searched only, could not check) and the counts give ${stated.join(', ')}`);
    }
  }
  card.problems = problems;
  return card;
}

// ---- the figures ----

function totalsOf(cards) {
  const totals = {
    scorecards: cards.length,
    runs: Object.fromEntries(RUNS.map((run) => [run, 0])),
    status: { VALID: 0, FAILED: 0, unknown: 0 },
    sums: Object.fromEntries(SUMMED.map((key) => [key, 0])),
    unknown: Object.fromEntries(SUMMED.map((key) => [key, 0])),
  };
  for (const card of cards) {
    totals.runs[card.run] += 1;
    totals.status[card.status] += 1;
    for (const key of SUMMED) {
      if (typeof card[key] === 'number') totals.sums[key] += card[key];
      else if (card[key] !== 'not applicable') totals.unknown[key] += 1;
    }
  }
  return totals;
}

const sourceKey = (name) => name.toLowerCase().replace(/\s+/g, ' ').trim();

// `cards` are in order, oldest first.
function streaksOf(cards) {
  const streaks = [];
  for (const run of RUNS) {
    const runs = cards.filter((card) => card.run === run);
    const names = new Map(); // key -> the newest spelling
    for (const card of runs) for (const source of Array.isArray(card.sources) ? card.sources : []) names.set(sourceKey(source.name), source.name);
    for (const [key, name] of names) {
      const resultIn = (card) => (Array.isArray(card.sources) ? card.sources.find((s) => sourceKey(s.name) === key)?.result : undefined) ?? 'unknown';
      const newest = runs[runs.length - 1];
      let count = 0;
      while (count < runs.length && FAILING.includes(resultIn(runs[runs.length - 1 - count]))) count += 1;
      streaks.push({
        source: name,
        run,
        count,
        newestResult: resultIn(newest),
        newestDate: newest.date,
        since: count === 0 ? null : runs[runs.length - count].date,
      });
    }
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return streaks.sort((a, b) => b.count - a.count || order(sourceKey(a.source), sourceKey(b.source)) || RUNS.indexOf(a.run) - RUNS.indexOf(b.run));
}

// Everything in metrics.json. `comments` and `stories` are the two input
// lists as read; `days` is the window in days; `now` is an ISO time.
export function rollup({ comments, stories, days, now }) {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days, 1 or more');
  const nowMs = timeOf(now);
  if (Number.isNaN(nowMs)) throw new Error(`--now is not a time that can be read: ${now}`);
  if (!Array.isArray(comments)) throw new Error('the comments file must be a JSON list of comments');

  const cards = [];
  const unreadable = [];
  let withoutScorecard = 0;
  comments.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`comment ${n} must be an object with "created" and "body"`);
    if (typeof raw.created !== 'string') throw new Error(`comment ${n} has no "created" time`);
    const createdMs = timeOf(raw.created);
    if (Number.isNaN(createdMs)) throw new Error(`comment ${n} has a "created" that is not a time that can be read: ${raw.created}`);
    if (typeof raw.body !== 'string') throw new Error(`comment ${n} has a "body" that is not text`);
    const card = parseScorecard(raw.body);
    if (card === null) {
      withoutScorecard += 1;
      return;
    }
    const reason = !RUNS.includes(card.run)
      ? `run is not one of ${RUNS.join(', ')} ("${card.run}")`
      : !isDate(card.date)
        ? `date is not a YYYY-MM-DD date ("${card.date}")`
        : null;
    if (reason !== null) {
      unreadable.push({ created: raw.created, reason });
      return;
    }
    cards.push({ card: { run: card.run, date: card.date, created: raw.created, ...card }, createdMs });
  });
  cards.sort((a, b) => dayNumber(a.card.date) - dayNumber(b.card.date) || a.createdMs - b.createdMs || RUNS.indexOf(a.card.run) - RUNS.indexOf(b.card.run));
  const ordered = cards.map(({ card }) => card);

  const groups = new Map();
  for (const card of ordered) {
    const key = `${card.run} ${card.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const duplicates = [];
  for (const group of groups.values()) {
    for (const card of group) card.duplicate = group.length > 1;
    if (group.length > 1) duplicates.push({ run: group[0].run, date: group[0].date, created: group.map((card) => card.created) });
  }

  const to = nyDate(nowMs);
  const dates = Array.from({ length: days }, (_, i) => dateOf(dayNumber(to) - (days - 1) + i));
  const inWindow = ordered.filter((card) => dates.includes(card.date));
  const byDay = dates.map((date) => ({ date, runs: inWindow.filter((card) => card.date === date) }));

  const currentWeek = isoWeek(to);
  const weeks = new Map();
  for (const card of ordered) {
    const week = isoWeek(card.date);
    if (week.from >= currentWeek.from) continue;
    if (!weeks.has(week.week)) weeks.set(week.week, { ...week, cards: [] });
    weeks.get(week.week).cards.push(card);
  }

  let openStories = { given: false, count: 'unknown', stories: [] };
  if (stories !== undefined) {
    if (!Array.isArray(stories)) throw new Error('the stories file must be a JSON list of stories');
    const list = stories.map((raw, i) => {
      const n = i + 1;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`story ${n} must be an object with "key" and "created"`);
      if (typeof raw.key !== 'string' || raw.key.trim() === '') throw new Error(`story ${n} has no "key"`);
      const createdMs = timeOf(raw.created);
      if (Number.isNaN(createdMs)) throw new Error(`story ${n} (${raw.key}) has a "created" that is not a time that can be read: ${raw.created}`);
      if (createdMs > nowMs) throw new Error(`story ${n} (${raw.key}) was created after --now`);
      const word = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown');
      return { story: { key: raw.key.trim(), created: raw.created, status: word(raw.status), label: word(raw.label), ageDays: dayNumber(to) - dayNumber(nyDate(createdMs)) }, createdMs };
    });
    list.sort((a, b) => a.createdMs - b.createdMs);
    openStories = { given: true, count: list.length, stories: list.map(({ story }) => story) };
  }

  return {
    generatedBy: NAME,
    window: { from: dates[0], to, days, now: new Date(nowMs).toISOString(), timeZone: TIME_ZONE, dates },
    input: { comments: comments.length, scorecards: ordered.length, withoutScorecard, unreadable },
    days: byDay,
    missingDaily: byDay.filter((day) => !day.runs.some((card) => card.run === 'daily')).map((day) => day.date),
    duplicates,
    streaks: streaksOf(ordered),
    totals: totalsOf(inWindow),
    weeks: [...weeks.values()].sort((a, b) => (a.from < b.from ? -1 : 1)).map(({ week, from, to: end, cards: inWeek }) => ({ week, from, to: end, totals: totalsOf(inWeek) })),
    openStories,
  };
}

// ---- the page: drawn from the metrics alone ----

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : esc(value));
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

const STYLE = `
:root{color-scheme:light;--page:#f4f3ef;--surface:#fcfcfb;--line:#dddcd6;--ink:#0b0b0b;--ink2:#52514e;--ink3:#7b7a75;
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--none:#b9b8b2;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#111110;--surface:#1a1a19;--line:#383835;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#96958d;
--none:#5c5b56;--s1:#3987e5;--s2:#d95926;--s3:#199e70}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
header h1{font-size:22px;margin:0 0 4px}
header p{margin:2px 0;color:var(--ink2)}
section{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-top:16px;break-inside:avoid}
h2{font-size:15px;margin:0 0 2px}
.sub{color:var(--ink2);margin:0 0 12px;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:5px 10px 5px 0;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--ink2);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.scroll{overflow-x:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.tile span{color:var(--ink2);font-size:12px}
.chip{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none}
.sq{display:inline-block;width:10px;height:10px;border-radius:2px;flex:none}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 10px;color:var(--ink2);font-size:12px}
.muted{color:var(--ink3)}
.warn{border-left:4px solid var(--critical)}
ul{margin:6px 0 0;padding-left:18px}
svg{display:block;max-width:100%;height:auto}
svg text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink2)}
svg text.v{fill:var(--ink);font-variant-numeric:tabular-nums}
.axis{stroke:var(--line);stroke-width:1}
.f-good{fill:var(--good)}.f-warning{fill:var(--warning)}.f-serious{fill:var(--serious)}.f-critical{fill:var(--critical)}.f-none{fill:var(--none)}
.f-s1{fill:var(--s1)}.f-s2{fill:var(--s2)}.f-s3{fill:var(--s3)}
.b-good{background:var(--good)}.b-warning{background:var(--warning)}.b-serious{background:var(--serious)}.b-critical{background:var(--critical)}.b-none{background:var(--none)}
.b-s1{background:var(--s1)}.b-s2{background:var(--s2)}.b-s3{background:var(--s3)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px 24px}
.grid h3{font-size:13px;margin:0 0 4px;font-weight:600}
`;

const STATUS = { VALID: ['good', '✓ VALID'], FAILED: ['critical', '✕ FAILED'], unknown: ['none', '? status unknown'] };
const SOURCE_PARTS = [['readInFull', 'good', 'read in full'], ['readInPart', 'warning', 'read in part'], ['searchedOnly', 'serious', 'searched only'], ['couldNotCheck', 'critical', 'could not check']];
const VERDICT_PARTS = [['applies', 's1', 'applies'], ['cannotTell', 's2', 'cannot tell'], ['doesNotApply', 's3', 'does not apply']];

const legend = (parts) => `<p class="legend">${parts.map(([, color, label]) => `<span class="chip"><i class="sq b-${color}"></i>${esc(label)}</span>`).join('')}</p>`;

// One horizontal stacked bar. `scale` is the largest row total in the chart,
// so rows can be compared; the gaps between segments are 2px of surface.
function stackedBar(run, parts, scale) {
  const width = 260;
  let x = 0;
  const rects = [];
  for (const [key, color, label] of parts) {
    const value = run[key];
    if (typeof value !== 'number' || value === 0) continue;
    const w = Math.max(2, (value / scale) * width);
    rects.push(`<rect class="f-${color}" x="${x.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="12" rx="2"><title>${esc(label)}: ${num(value)}</title></rect>`);
    x += w + 2;
  }
  return `<svg viewBox="0 0 ${width + 8} 16" width="${width + 8}" height="16" role="img" aria-label="${esc(parts.map(([key, , label]) => `${label} ${run[key]}`).join(', '))}">${rects.join('')}</svg>`;
}

function stackedSection(metrics, title, sub, parts, totalKey) {
  const runs = metrics.days.flatMap((day) => day.runs);
  if (runs.length === 0) return `<section><h2>${title}</h2><p class="sub">${sub}</p><p class="muted">No scorecard in the window.</p></section>`;
  const rowTotal = (run) => parts.reduce((sum, [key]) => sum + (typeof run[key] === 'number' ? run[key] : 0), 0);
  const scale = Math.max(1, ...runs.map(rowTotal));
  const rows = runs.map((run) => `<tr><td>${esc(run.date)}</td><td>${esc(run.run)}</td><td>${stackedBar(run, parts, scale)}</td>${parts.map(([key]) => `<td class="n">${num(run[key])}</td>`).join('')}<td class="n">${num(run[totalKey])}</td></tr>`);
  return `<section><h2>${title}</h2><p class="sub">${sub}</p>${legend(parts)}<div class="scroll"><table><thead><tr><th>Date</th><th>Run</th><th></th>${parts.map(([, , label]) => `<th class="n">${esc(label)}</th>`).join('')}<th class="n">${totalKey === 'events' ? 'events' : 'listed'}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></section>`;
}

// One small bar chart: one bar per column, the number printed above each.
function columnChart(columns) {
  const slot = 44;
  const width = Math.max(120, columns.length * slot);
  const top = 16;
  const height = 70;
  const scale = Math.max(1, ...columns.map((c) => (typeof c.value === 'number' ? c.value : 0)));
  const bars = columns.map((c, i) => {
    const x = i * slot + 8;
    const known = typeof c.value === 'number';
    const h = known ? (c.value / scale) * height : 0;
    const y = top + height - h;
    const bar = h > 0 ? `<path class="${c.window ? 'f-s2' : 'f-s1'}" d="M${x},${top + height}V${(y + Math.min(3, h)).toFixed(1)}q0,-${Math.min(3, h)} ${Math.min(3, h)},-${Math.min(3, h)}h${28 - 2 * Math.min(3, h)}q${Math.min(3, h)},0 ${Math.min(3, h)},${Math.min(3, h)}V${top + height}z"><title>${esc(c.label)}: ${num(c.value)}</title></path>` : '';
    return `${bar}<text class="v" x="${x + 14}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${known ? num(c.value) : '?'}</text><text x="${x + 14}" y="${top + height + 14}" text-anchor="middle">${esc(c.short)}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${top + height + 20}" width="${width}" height="${top + height + 20}" role="img" aria-label="${esc(columns.map((c) => `${c.label} ${c.value}`).join(', '))}"><line class="axis" x1="0" x2="${width}" y1="${top + height + 0.5}" y2="${top + height + 0.5}"/>${bars.join('')}</svg>`;
}

// The page. `metrics` is metrics.json as read back: nothing else is used.
export function renderDashboard(metrics) {
  const { window: win, input, totals } = metrics;
  const sumCell = (t, key) => `${num(t.sums[key])}${t.unknown[key] > 0 ? ` <span class="muted">(+${num(t.unknown[key])} unknown)</span>` : ''}`;
  const out = [];

  out.push(`<header><h1>Home agent runs: ${esc(win.from)} to ${esc(win.to)}</h1>
<p>Window: ${esc(win.from)} to ${esc(win.to)}, ${plural(win.days, 'day', 'days')}, calendar dates in ${esc(win.timeZone)}, up to ${esc(win.now)}.</p>
<p>${plural(input.scorecards, 'scorecard', 'scorecards')} read from ${plural(input.comments, 'comment', 'comments')}; ${plural(input.withoutScorecard, 'comment', 'comments')} held none; ${plural(input.unreadable.length, 'block', 'blocks')} could not be placed. ${plural(totals.scorecards, 'scorecard is', 'scorecards are')} in the window.</p>
<p>All figures computed by ${esc(metrics.generatedBy)}; none is added, counted or averaged by the model.</p></header>`);

  const notes = [];
  for (const d of metrics.duplicates) notes.push(`Duplicate: ${plural(d.created.length, 'scorecard', 'scorecards')} for the ${esc(d.run)} run of ${esc(d.date)} (posted ${d.created.map(esc).join(', ')}). Each is kept and counted in the totals.`);
  for (const u of input.unreadable) notes.push(`A scorecard block posted ${esc(u.created)} could not be placed and is in no figure: ${esc(u.reason)}.`);
  const allRuns = metrics.days.flatMap((day) => day.runs);
  for (const run of allRuns) for (const problem of run.problems) notes.push(`${esc(run.date)} ${esc(run.run)}: ${esc(problem)}.`);
  if (notes.length > 0) out.push(`<section class="warn"><h2>Read this first</h2><p class="sub">What in the log could not be taken as written.</p><ul>${notes.map((n) => `<li>${n}</li>`).join('')}</ul></section>`);

  const tile = (value, label) => `<div class="tile"><b>${value}</b><span>${esc(label)}</span></div>`;
  out.push(`<section><h2>The window in numbers</h2><p class="sub">Totals of the scorecards dated in the window.</p><div class="tiles">
${tile(num(totals.scorecards), 'scorecards')}${tile(num(totals.status.VALID), 'runs VALID')}${tile(num(totals.status.FAILED), 'runs FAILED')}${tile(num(totals.status.unknown), 'status unknown')}
${tile(num(metrics.missingDaily.length), 'days with no daily scorecard')}${tile(sumCell(totals, 'events'), 'events collected')}${tile(sumCell(totals, 'storiesCreated'), 'stories created')}${tile(sumCell(totals, 'caughtByAudit'), 'caught by audit')}
</div></section>`);

  const runTypes = RUNS.filter((run) => run !== 'sweep' || totals.runs.sweep > 0);
  const statusCell = (day, run) => {
    const cards = day.runs.filter((card) => card.run === run);
    if (cards.length === 0) return run === 'daily' ? '<span class="chip"><i class="dot b-critical"></i><strong>no scorecard</strong></span>' : '<span class="muted">none</span>';
    return cards.map((card) => `<span class="chip"><i class="dot b-${STATUS[card.status][0]}"></i>${STATUS[card.status][1]}${card.duplicate ? ' (duplicate)' : ''}</span>`).join('<br>');
  };
  out.push(`<section><h2>Status by day</h2><p class="sub">Each run's own status line, as its scorecard gives it. A day with no daily scorecard counts as a failed run.</p>
<div class="scroll"><table><thead><tr><th>Date</th>${runTypes.map((run) => `<th>${esc(run)}</th>`).join('')}</tr></thead><tbody>
${metrics.days.map((day) => `<tr><td>${esc(day.date)}</td>${runTypes.map((run) => `<td>${statusCell(day, run)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table></div>
<p><strong>No daily scorecard:</strong> ${metrics.missingDaily.length === 0 ? '<span>none in the window</span>' : metrics.missingDaily.map((date) => `<span>${esc(date)}</span>`).join(', ')}</p></section>`);

  out.push(stackedSection(metrics, 'Sources read by day', 'The four source counts of each scorecard in the window. Bars share one scale.', SOURCE_PARTS, 'sourcesListed'));

  const failing = metrics.streaks.filter((s) => s.count > 0);
  const longest = Math.max(1, ...failing.map((s) => s.count));
  out.push(`<section><h2>Sources failing in a row</h2><p class="sub">Runs in a row, ending at the newest run of that type, in which the source was "could not check" or "searched only". ${plural(metrics.streaks.length, 'source and run type', 'sources and run types')} tracked, from every scorecard read.</p>
${failing.length === 0 ? '<p class="muted">No source failed on its newest run.</p>' : `<div class="scroll"><table><thead><tr><th>Source</th><th>Run</th><th></th><th class="n">Runs in a row</th><th>Since</th><th>Newest result</th></tr></thead><tbody>
${failing.map((s) => `<tr><td>${esc(s.source)}</td><td>${esc(s.run)}</td><td><svg viewBox="0 0 128 16" width="128" height="16" role="img" aria-label="${num(s.count)} in a row"><rect class="f-critical" x="0" y="2" width="${((s.count / longest) * 120).toFixed(1)}" height="12" rx="2"/></svg></td><td class="n">${num(s.count)}</td><td>${esc(s.since)}</td><td>${esc(s.newestResult)} (${esc(s.newestDate)})</td></tr>`).join('\n')}
</tbody></table></div>`}</section>`);

  out.push(stackedSection(metrics, 'Events by verdict', 'The three verdict counts of each scorecard in the window. Bars share one scale.', VERDICT_PARTS, 'events'));

  out.push(`<section><h2>Stories created and caught by audit</h2><p class="sub">Jira writes each run reported. "Caught by audit" is given by the Friday audit only.</p>
${allRuns.length === 0 ? '<p class="muted">No scorecard in the window.</p>' : `<div class="scroll"><table><thead><tr><th>Date</th><th>Run</th><th class="n">Stories created</th><th class="n">Comments posted</th><th class="n">Caught by audit</th><th class="n">Tokens</th></tr></thead><tbody>
${allRuns.map((run) => `<tr><td>${esc(run.date)}</td><td>${esc(run.run)}</td><td class="n">${num(run.storiesCreated)}</td><td class="n">${num(run.commentsPosted)}</td><td class="n">${num(run.caughtByAudit)}</td><td class="n">${num(run.tokens)}</td></tr>`).join('\n')}
<tr><th>Window</th><th></th><th class="n">${sumCell(totals, 'storiesCreated')}</th><th class="n">${sumCell(totals, 'commentsPosted')}</th><th class="n">${sumCell(totals, 'caughtByAudit')}</th><th class="n">${sumCell(totals, 'tokens')}</th></tr>
</tbody></table></div>`}</section>`);

  const open = metrics.openStories;
  const oldest = Math.max(1, ...open.stories.map((s) => s.ageDays));
  out.push(`<section><h2>Open stories by age</h2><p class="sub">${open.given ? `${plural(open.count, 'open story', 'open stories')} in the list the run supplied, oldest first. Age in whole days since the story was created.` : 'Open stories: not given. No stories file was supplied to the script, so the count is unknown.'}</p>
${open.stories.length === 0 ? '' : `<div class="scroll"><table><thead><tr><th>Story</th><th>Status</th><th>Label</th><th></th><th class="n">Days open</th></tr></thead><tbody>
${open.stories.map((s) => `<tr><td>${esc(s.key)}</td><td>${esc(s.status)}</td><td>${esc(s.label)}</td><td><svg viewBox="0 0 208 16" width="208" height="16" role="img" aria-label="${num(s.ageDays)} days"><rect class="f-s1" x="0" y="2" width="${Math.max(2, (s.ageDays / oldest) * 200).toFixed(1)}" height="12" rx="2"/></svg></td><td class="n">${num(s.ageDays)}</td></tr>`).join('\n')}
</tbody></table></div>`}</section>`);

  const shown = metrics.weeks.slice(-12);
  const columns = [...shown.map((w) => ({ label: w.week, short: w.week.slice(5), totals: w.totals, window: false })), { label: 'the window', short: 'window', totals, window: true }];
  const charts = [
    ['Scorecards', (t) => t.scorecards],
    ['Runs FAILED', (t) => t.status.FAILED],
    ['Events collected', (t) => t.sums.events],
    ['Events that apply', (t) => t.sums.applies],
    ['Stories created', (t) => t.sums.storiesCreated],
    ['Caught by audit', (t) => t.sums.caughtByAudit],
    ['Sources: could not check', (t) => t.sums.couldNotCheck],
    ['Sources: searched only', (t) => t.sums.searchedOnly],
  ];
  out.push(`<section><h2>Weekly totals over time</h2><p class="sub">One bar per ISO week (Monday to Sunday) before the week the window ends in, oldest first, then the window. The window can reach back into the newest week, so the two overlap. ${metrics.weeks.length > shown.length ? `The newest ${num(shown.length)} of ${num(metrics.weeks.length)} earlier weeks are shown; metrics.json has all of them.` : `${plural(metrics.weeks.length, 'earlier week', 'earlier weeks')} in the log.`} History starts with the first scorecard posted to the run log.</p>
<p class="legend"><span class="chip"><i class="sq b-s1"></i>an earlier ISO week</span><span class="chip"><i class="sq b-s2"></i>the window</span></p>
<div class="grid">${charts.map(([title, pick]) => `<div><h3>${esc(title)}</h3>${columnChart(columns.map((c) => ({ label: c.label, short: c.short, value: pick(c.totals), window: c.window })))}</div>`).join('')}</div>
<div class="scroll"><table><thead><tr><th>Week</th><th>Dates</th><th class="n">Scorecards</th><th class="n">Daily</th><th class="n">Digest</th><th class="n">Audit</th><th class="n">VALID</th><th class="n">FAILED</th><th class="n">Events</th><th class="n">Applies</th><th class="n">Stories</th><th class="n">Caught by audit</th><th class="n">Could not check</th><th class="n">Tokens</th></tr></thead><tbody>
${[...shown.map((w) => [w.week, `${w.from} to ${w.to}`, w.totals]), ['Window', `${win.from} to ${win.to}`, totals]].map(([name, range, t]) => `<tr><td>${esc(name)}</td><td>${esc(range)}</td><td class="n">${num(t.scorecards)}</td><td class="n">${num(t.runs.daily)}</td><td class="n">${num(t.runs.digest)}</td><td class="n">${num(t.runs.audit)}</td><td class="n">${num(t.status.VALID)}</td><td class="n">${num(t.status.FAILED)}</td><td class="n">${sumCell(t, 'events')}</td><td class="n">${sumCell(t, 'applies')}</td><td class="n">${sumCell(t, 'storiesCreated')}</td><td class="n">${sumCell(t, 'caughtByAudit')}</td><td class="n">${sumCell(t, 'couldNotCheck')}</td><td class="n">${sumCell(t, 'tokens')}</td></tr>`).join('\n')}
</tbody></table></div></section>`);

  out.push('<section><h2>What this page cannot show</h2><ul><li>A run that posted no scorecard is seen only as a missing day; why it is missing is not known here.</li><li>The weekly app scan has no scorecard, so it is not on this page.</li><li>Time from a story to its verdict is not shown: it needs each story\'s history.</li><li>A quiet week means nothing found by these sources, not that nothing happened.</li></ul></section>');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home agent runs: ${esc(win.from)} to ${esc(win.to)}</title>
<style>${STYLE}</style></head>
<body><main>
${out.join('\n')}
</main></body></html>
`;
}

// ---- the command line ----

function parseArgs(args) {
  const usage = 'usage: --comments <comments.json> [--stories <stories.json>] --days <n> [--now <ISO time>] --out <folder>';
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--comments', '--stories', '--days', '--now', '--out'].includes(name)) throw new Error(`unknown option "${name}"; ${usage}`);
    if (args[i + 1] === undefined) throw new Error(`${name} needs a value`);
    options[name.slice(2)] = args[i + 1];
  }
  if (options.comments === undefined) throw new Error(`--comments <comments.json> is required; ${usage}`);
  if (options.days === undefined) throw new Error(`--days <n> is required; ${usage}`);
  if (options.out === undefined) throw new Error(`--out <folder> is required; ${usage}`);
  if (!/^\d+$/.test(options.days)) throw new Error('--days must be a whole number of days, 1 or more');
  return { ...options, days: Number(options.days), now: options.now ?? new Date().toISOString() };
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`could not read the ${what} from ${path}: ${e.message}`);
  }
}

function main(args) {
  const options = parseArgs(args);
  const comments = readJson(options.comments, 'comments');
  const stories = options.stories === undefined ? undefined : readJson(options.stories, 'stories');
  const metricsText = `${JSON.stringify(rollup({ comments, stories, days: options.days, now: options.now }), null, 2)}\n`;
  // The page is drawn from the text that is written, so the two cannot differ.
  const html = renderDashboard(JSON.parse(metricsText));
  mkdirSync(options.out, { recursive: true });
  const metricsPath = join(options.out, 'metrics.json');
  const pagePath = join(options.out, 'dashboard.html');
  writeFileSync(metricsPath, metricsText);
  writeFileSync(pagePath, html);
  process.stdout.write(`${metricsPath}\n${pagePath}\n`);
}

const runDirectly = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (runDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`scorecard-rollup: ${String(e.message).replace(/\s*\n\s*/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
