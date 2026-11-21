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
// Since handoff 2026-11-21-confidence-metrics-and-review it also computes the
// confidence scores, whose formulas have their one home in
// agents/home-systems.md, "Confidence scores". If this file and that section
// differ, the section wins.
//
// Usage:
//   node tools/scorecard-rollup.mjs --comments <comments.json>
//        [--stories <stories.json>] [--required <required.json>]
//        [--targets <targets.json>] [--audit-stories <keys.json>]
//        --days <n> [--now <ISO time>] --out <folder>
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
// A block whose "run" is "review" is the weekly review's block
// (agents/home-systems-weekly-review.md): it is read into "reviews", not into
// the run figures.
//
// Input 2, stories.json (optional). Two shapes are accepted, story by story.
// The full shape: every intake story created in the last 56 days, and every
// open one, each as read from Jira:
//   [ { "key": "KAN-1", "summary": "Intake: ...", "created": "<ISO time>",
//       "resolved": "<ISO time or null>", "status": "Done",
//       "labels": ["security-intake", "found-by-daily", ...],
//       "description": "<text>",
//       "comments": [ { "created": "<ISO time>", "body": "<text>" } ] } ]
// From each story the script reads: its found-by-*, proposed-* and verdict-*
// labels (any letter case); the description's "Available:" line, its Action
// line and its state line (the last line beginning "State:"); the newest
// comment that starts "Final:"; and the newest state line in any comment.
// An item a story does not carry is "not recorded", and the story is left out
// of every measure that needs it. "summary" is optional.
// The old shape, from before 2026-11-21: open stories only, with one label:
//   [ { "key": "KAN-1", "created": "<ISO time>", "status": "In Review",
//       "label": "agent-proposed" } ]
// It gives the open stories, taken as given, and nothing for the scores.
// "key" and "created" are required in both.
//
// Input 3, required.json (optional): a JSON list of the source names that
// KAN-118 marks required, as the scorecards' source lines name them:
//   [ "CISA Known Exploited Vulnerabilities", "npm registry" ]
// Input 4, targets.json (optional): the days to fix by tier, from KAN-118:
//   { "1": 3, "2": 14 }
// Input 5, keys.json (optional): the keys of the stories this run created for
// what the daily checks missed: [ "KAN-201" ]. Nothing is inferred.
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
//     "measuringFrom": the date of the first scorecard block in the comments
//                (the earliest "date:" line, a review block's included), or
//                null when there is none,
//     "days": [ { "date", "runs": [ <run> ] } ],     one per date in the window
//     "missingDaily": [ dates in the window with no daily scorecard ],
//     "duplicates": [ { "run", "date", "created": [...] } ],
//     "streaks": [ { "source", "run", "count", "newestResult", "newestDate",
//                    "since" } ],
//     "totals": <totals>,                             the window
//     "weeks": [ { "week": "2026-W47", "from", "to", "totals": <totals> } ],
//     "openStories": { "given", "count",
//                      "stories": [ { "key", "created", "status", "label", "ageDays" } ] },
//     "reviews": [ { "date", "week", "relevant", "covered", "securityEmails",
//                    "securityEmailsLogged", "storiesClosed", "problems",
//                    "created", "duplicate", "inScoreWindow", "percent" } ],
//     "storiesRead": { "given", "shape", "count", "problems", "twoFinals" },
//     "notRecorded": { "stories", "foundBy", "proposed", "available",
//                      "firstState", "action" },
//     "inputsGiven": { "required", "targets", "auditStories" },
//     "confidence": { "from", "to", "days", "found", "assessed", "actionable",
//                     "overall", "weeks": [ the same for four ISO weeks ] },
//     "reports": [ { "date", "run", "report", "beforeMeasuring", "found",
//                    "assessed", "actionable", "overall", "stories",
//                    "misses" } ],
//     "misses": [ { "key", "foundBy", "available", "chargedTo", "report",
//                   "inGrid" } ],
//       "report" is "daily", "no report", "not yet due", "not charged" (no
//       Available date) or "before measuring began" (available before
//       "measuringFrom"; charged to no report, still in the catch rate).
//     "changed": [ { "key", "changes": [ { "field", "first", "final" } ] } ],
//     "timeToSurface": [ { "how", "days", "median" } ],
//     "sourcesRead": [ { "source", "read", "failed", "unknown", "required" } ],
//     "audit": { "given", "cards": [ { "key", "summary", "tier", "chargedTo",
//                                      "report", "action", "problems" } ] },
//     "exposure": { "weeks", "open", "openByAge", "daysToClose",
//                   "closedWithoutDates", "patchClock" },
//     "glance": { "reportCard", "foundByAudit", "exposure", "weakest" }
//   }
// A principle ("found", "assessed", "actionable") is { "score", "band",
// "measuresWithData", "measuresTotal", "measures" }; each measure is
// { "hasData", "numerator", "denominator", "rest", "percent", "leftOut",
// "reason" when it has no data }. "score" is a whole number 0 to 100, or
// "not enough data"; "band" is High, Medium, Low or "not enough data".
// "overall" is the lowest principle with a score, and "from" names it.
// Since the amendment of 2026-11-21 (handoff
// 2026-11-21-confidence-metrics-and-review): "Required sources" counts only
// the dates on or after "measuringFrom" and also gives
// "daysBeforeMeasuring"; a grid date before it shows "before measuring", not
// "no report"; "Verdict agreement" scores only proposals of affected or
// not-affected, and gives "leftToOwner" (proposed needs-info or watch) out of
// "withBoth" (stories with both a proposed-* and a verdict-* label).
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
// file, drawn from metrics.json alone (renderDashboard), laid out for US
// Letter portrait. It computes no figure of its own. Tokens are in
// metrics.json only, never on the page.
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

// The labelled lines of the first block in one comment body, or null.
function readBlock(body) {
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
  return { values, sourceLines, problems, text };
}

// The weekly review's block (run: review), or null when the body holds no
// block or the block is another run's. Its labels are in
// agents/home-systems-weekly-review.md, "The review block".
export function parseReview(body) {
  const block = readBlock(body);
  if (block === null || block.text('run') !== 'review') return null;
  const { text, problems } = block;
  const count = (label) => {
    const value = text(label);
    if (/^\d+$/.test(value)) return Number(value);
    if (value !== 'unknown') problems.push(`${label}: not a whole number ("${value}")`);
    return 'unknown';
  };
  const date = (label) => {
    const value = text(label);
    if (isDate(value)) return value;
    problems.push(`${label}: not a YYYY-MM-DD date ("${value}")`);
    return 'unknown';
  };
  return {
    date: date('date'),
    week: date('week'),
    relevant: count('review relevant'),
    covered: count('review covered'),
    securityEmails: count('security emails'),
    securityEmailsLogged: count('security emails logged'),
    storiesClosed: count('stories closed'),
    problems,
  };
}

// The scorecard in one comment body, or null when the body holds none.
// `run` and `date` are returned as written; rollup() checks them.
export function parseScorecard(body) {
  const block = readBlock(body);
  if (block === null) return null;
  const { sourceLines, problems, text } = block;
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

// ---- the intake stories ----

const NR = 'not recorded';
const NED = 'not enough data';
const VERDICTS = ['affected', 'not-affected', 'watch', 'needs-info'];
const FOUND_BY = ['daily', 'audit', 'appscan', 'owner'];
const NEWS_WATCH = ['daily', 'audit', 'owner']; // the stories the scores cover
const HOWS = ['KEV added', 'CVE list added', 'vendor published', 'advisory published', 'news published', 'scan found'];
const READ = ['read in full', 'read in part'];
const FINAL_LINE = /^Final: verdict=(affected|not-affected|watch|needs-info); tier=([1-4]); blast radius=([^;]+?); fixed=(\d{4}-\d{2}-\d{2}|none); action as proposed=(yes|no|no action); extra research=(yes|no)\s*$/;

const linesOf = (text) => (typeof text === 'string' ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []);

// Tier and blast radius from the last line that begins exactly "State:", or
// null when there is none. `problems` gets a line when it cannot be read.
function stateIn(text, where, problems) {
  const line = linesOf(text).findLast((l) => l.startsWith('State:'));
  if (line === undefined) return null;
  const fields = new Map(line.slice('State:'.length).split(';').map((part) => {
    const cut = part.indexOf('=');
    return cut === -1 ? [part.trim(), ''] : [part.slice(0, cut).trim(), part.slice(cut + 1).trim()];
  }));
  const tier = Number(fields.get('tier'));
  const blastRadius = fields.get('blast radius');
  if (![1, 2, 3, 4].includes(tier) || !blastRadius) {
    problems.push(`${where}: state line cannot be read ("${line}")`);
    return 'malformed';
  }
  return { tier, blastRadius };
}

// One intake story as the scores need it. `raw` is one entry of the stories
// file; rollup() has checked its shape. Every item the story does not carry
// is "not recorded" (agents/home-systems.md, "Confidence scores").
export function parseStory(raw) {
  const problems = [];
  const oldShape = !Array.isArray(raw.labels);
  const labels = (oldShape ? (typeof raw.label === 'string' ? [raw.label] : []) : raw.labels).map((l) => String(l).trim().toLowerCase());
  const pick = (prefix, allowed) => {
    const values = [...new Set(labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)))];
    for (const v of values) if (!allowed.includes(v)) problems.push(`label ${prefix}${v} is not one of ${allowed.map((a) => prefix + a).join(', ')}`);
    const known = values.filter((v) => allowed.includes(v));
    if (known.length > 1) {
      problems.push(`more than one ${prefix} label (${known.map((v) => prefix + v).join(', ')}); none is used`);
      return NR;
    }
    return known[0] ?? NR;
  };
  const description = typeof raw.description === 'string' ? raw.description : '';
  const lines = linesOf(description);

  let available = NR;
  const availableLine = lines.find((l) => /^available\s*:/i.test(l));
  if (availableLine !== undefined) {
    const m = /^Available: (\d{4}-\d{2}-\d{2}) \((.+)\)$/.exec(availableLine);
    if (availableLine === 'Available: unknown') available = 'unknown';
    else if (m && isDate(m[1]) && HOWS.includes(m[2])) available = { date: m[1], how: m[2] };
    else problems.push(`Available line cannot be read ("${availableLine}")`);
  }

  const first = stateIn(description, 'description', problems);
  const firstState = first === null || first === 'malformed' ? NR : first;

  let action = NR;
  const actionLine = lines.find((l) => l.includes('Action for you:'));
  if (actionLine !== undefined) {
    const text = actionLine.slice(actionLine.indexOf('Action for you:'));
    action = { text, concrete: !/^Action for you:\s*unknown\b/i.test(text) && !/no step stated by the source/i.test(text) };
  }

  const comments = (Array.isArray(raw.comments) ? raw.comments : [])
    .map((c) => ({ ...c, ms: timeOf(c.created) }))
    .sort((a, b) => a.ms - b.ms);
  let latestState = firstState;
  for (const c of comments) {
    const s = stateIn(c.body, `comment of ${c.created}`, problems);
    if (s !== null && s !== 'malformed') latestState = s;
  }
  const finals = comments.filter((c) => (linesOf(c.body)[0] ?? '').startsWith('Final:'));
  let final = NR;
  if (finals.length > 0) {
    const newest = finals[finals.length - 1];
    const line = linesOf(newest.body)[0];
    const m = FINAL_LINE.exec(line);
    if (m) final = { verdict: m[1], tier: Number(m[2]), blastRadius: m[3].trim(), fixed: m[4], actionAsProposed: m[5], extraResearch: m[6], created: newest.created };
    else problems.push(`Final line cannot be read ("${line}")`);
  }
  if (finals.length > 1) problems.push(`${finals.length} Final comments; the newest is used`);

  const createdMs = timeOf(raw.created);
  const resolvedMs = timeOf(raw.resolved);
  const status = typeof raw.status === 'string' && raw.status.trim() !== '' ? raw.status.trim() : 'unknown';
  const closed = !oldShape && (!Number.isNaN(resolvedMs) || status.toLowerCase() === 'done');
  return {
    key: String(raw.key).trim(),
    summary: typeof raw.summary === 'string' && raw.summary.trim() !== '' ? raw.summary.trim() : 'unknown',
    created: raw.created,
    createdDate: Number.isNaN(createdMs) ? null : nyDate(createdMs),
    status,
    closed,
    resolvedDate: !closed || Number.isNaN(resolvedMs) ? null : nyDate(resolvedMs),
    oldShape,
    agentProposed: labels.includes('agent-proposed'),
    foundBy: pick('found-by-', FOUND_BY),
    proposed: pick('proposed-', VERDICTS),
    verdict: pick('verdict-', VERDICTS),
    available,
    firstState,
    latestState,
    action,
    final,
    finalCount: finals.length,
    problems,
  };
}

// ---- the confidence scores (agents/home-systems.md, "Confidence scores") ----

const SCORE_DAYS = 28;
const GRID_DAYS = 8;
const FOUND_WEIGHTS = { catchRate: 0.4, coverage: 0.3, requiredSources: 0.15, onTime: 0.15 };

export function band(score) {
  if (typeof score !== 'number') return score;
  return score >= 90 ? 'High' : score >= 70 ? 'Medium' : 'Low';
}

const finalVerdict = (s) => (s.final !== NR ? s.final.verdict : s.verdict);
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// One measure: a count over a count. No data when the second count is 0.
function measure(numerator, denominator, extra = {}) {
  const hasData = denominator > 0;
  return { hasData, numerator, denominator, rest: denominator - numerator, percent: hasData ? Math.round((100 * numerator) / denominator) : null, ...extra };
}
const noData = (reason, extra = {}) => ({ hasData: false, numerator: 0, denominator: 0, rest: 0, percent: null, reason, ...extra });

// A principle from its measures: the (weighted) mean of those with data.
function principle(measures, weights) {
  const withData = Object.entries(measures).filter(([, m]) => m.hasData);
  const total = Object.keys(measures).length;
  if (withData.length === 0) return { score: NED, band: NED, measuresWithData: 0, measuresTotal: total, measures };
  const w = (name) => (weights ? weights[name] : 1);
  const sumW = withData.reduce((sum, [name]) => sum + w(name), 0);
  const value = withData.reduce((sum, [name, m]) => sum + w(name) * (m.numerator / m.denominator), 0) / sumW;
  const score = Math.round(100 * value);
  return { score, band: band(score), measuresWithData: withData.length, measuresTotal: total, measures };
}

function lowest(parts) {
  const scored = Object.entries(parts).filter(([, p]) => typeof p.score === 'number');
  if (scored.length === 0) return { score: NED, band: NED, from: null };
  const [from, p] = scored.reduce((low, next) => (next[1].score < low[1].score ? next : low));
  return { score: p.score, band: band(p.score), from };
}

// Only definite proposals are scored (amendment of 2026-11-21): a story
// proposed as needs-info or watch is counted in "leftToOwner", out of
// "withBoth", the stories with both labels.
const DEFINITE = ['affected', 'not-affected'];
function verdictAgreementOf(list) {
  const both = list.filter((s) => s.proposed !== NR && s.verdict !== NR);
  const definite = both.filter((s) => DEFINITE.includes(s.proposed));
  const disagree = definite.filter((s) => s.proposed !== s.verdict).map((s) => s.key);
  return measure(definite.length - disagree.length, definite.length, { leftOut: list.length - both.length, disagree, leftToOwner: both.length - definite.length, withBoth: both.length });
}

function heldUpOf(list) {
  const closed = list.filter((s) => s.closed);
  const both = closed.filter((s) => s.final !== NR && s.firstState !== NR);
  const held = both.filter((s) => s.firstState.tier === s.final.tier && same(s.firstState.blastRadius, s.final.blastRadius));
  return measure(held.length, both.length, { leftOut: closed.length - both.length });
}

function concreteStepOf(affected) {
  const withAction = affected.filter((s) => s.action !== NR);
  return measure(withAction.filter((s) => s.action.concrete).length, withAction.length, { leftOut: affected.length - withAction.length });
}

function noExtraResearchOf(affected) {
  const closed = affected.filter((s) => s.closed);
  const withFinal = closed.filter((s) => s.final !== NR);
  return measure(withFinal.filter((s) => s.final.extraResearch === 'no').length, withFinal.length, { leftOut: closed.length - withFinal.length });
}

function fixedInTimeOf(affected, targets) {
  if (targets === undefined) return noData('no target days given (--targets): KAN-118, "Alert tiers", does not state them yet');
  const withFinal = affected.filter((s) => s.closed && s.final !== NR);
  const eligible = withFinal.filter((s) => s.final.fixed !== 'none' && targets[String(s.final.tier)] !== undefined && s.createdDate !== null);
  const inTime = eligible.filter((s) => dayNumber(s.final.fixed) - dayNumber(s.createdDate) <= targets[String(s.final.tier)]);
  return measure(inTime.length, eligible.length, { leftOut: withFinal.length - eligible.length, reason: eligible.length === 0 ? 'no closed affected story with a fixed date and a tier that has a target' : undefined });
}

// The newest daily scorecard of a date, or undefined.
const dailyOn = (cards, date) => cards.filter((c) => c.run === 'daily' && c.date === date).at(-1);

const requiredRead = (card, required) => Array.isArray(card.sources)
  && required.every((name) => card.sources.some((s) => sourceKey(s.name) === sourceKey(name) && READ.includes(s.result)));

// Required sources over the dates on or after the start of measuring (the
// first scorecard in the run log): a date before it is not a failed day.
const measuring = (ctx, date) => ctx.measuringFrom !== null && date >= ctx.measuringFrom;
function requiredSourcesOf(ctx, dates) {
  if (ctx.required === undefined) return noData('no list of required sources given (--required)');
  const counted = dates.filter((date) => measuring(ctx, date));
  const daysBeforeMeasuring = dates.length - counted.length;
  if (counted.length === 0) {
    return noData(ctx.measuringFrom === null ? 'no scorecard in the run log yet, so measuring has not begun' : `every day of the window is before measuring began (${ctx.measuringFrom})`, { leftOut: 0, daysWithoutScorecard: 0, daysBeforeMeasuring });
  }
  const passed = counted.filter((date) => { const card = dailyOn(ctx.cards, date); return card !== undefined && requiredRead(card, ctx.required); });
  return measure(passed.length, counted.length, { leftOut: 0, daysWithoutScorecard: counted.filter((date) => dailyOn(ctx.cards, date) === undefined).length, daysBeforeMeasuring });
}

// The three principles and Overall over the SCORE_DAYS dates ending on `to`.
function scoresFor(ctx, to) {
  const from = dateOf(dayNumber(to) - (SCORE_DAYS - 1));
  const within = (date) => date !== null && date >= from && date <= to;
  const inWindow = ctx.stories.filter((s) => within(s.createdDate));
  const scoped = inWindow.filter((s) => NEWS_WATCH.includes(s.foundBy));
  const daily = scoped.filter((s) => s.foundBy === 'daily');
  const dates = Array.from({ length: SCORE_DAYS }, (_, i) => dateOf(dayNumber(from) + i));

  const reviews = ctx.reviews.filter((r) => within(r.date));
  const counted = reviews.filter((r) => typeof r.relevant === 'number' && typeof r.covered === 'number');
  const known = daily.filter((s) => s.available !== NR && s.available !== 'unknown');
  const found = principle({
    catchRate: measure(daily.length, scoped.length, { leftOut: inWindow.filter((s) => s.foundBy === NR).length }),
    coverage: measure(counted.reduce((n, r) => n + r.covered, 0), counted.reduce((n, r) => n + r.relevant, 0), { leftOut: reviews.length - counted.length, reviews: reviews.length }),
    requiredSources: requiredSourcesOf(ctx, dates),
    onTime: measure(known.filter((s) => dayNumber(s.createdDate) - dayNumber(s.available.date) <= 1).length, known.length, { leftOut: daily.length - known.length }),
  }, FOUND_WEIGHTS);

  const dailyCards = ctx.cards.filter((c) => c.run === 'daily' && within(c.date) && typeof c.events === 'number' && typeof c.cannotTell === 'number');
  const assessed = principle({ verdictAgreement: verdictAgreementOf(scoped), heldUp: heldUpOf(scoped) });
  assessed.cannotTell = measure(dailyCards.reduce((n, c) => n + c.cannotTell, 0), dailyCards.reduce((n, c) => n + c.events, 0), { scored: false });

  const affected = scoped.filter((s) => finalVerdict(s) === 'affected');
  const actionable = principle({ concreteStep: concreteStepOf(affected), noExtraResearch: noExtraResearchOf(affected), fixedInTime: fixedInTimeOf(affected, ctx.targets) });
  actionable.affectedStories = affected.length;

  return { from, to, days: SCORE_DAYS, scoped, inWindow, found, assessed, actionable, overall: lowest({ found, assessed, actionable }) };
}

// Each miss (a story found by the audit or the owner) is charged to the daily
// report due the day after it became available, unless it became available
// before measuring began: then it is charged to no report.
const BEFORE = 'before measuring';
const BEFORE_BEGAN = 'before measuring began';
function missesOf(ctx, to) {
  return ctx.stories
    .filter((s) => s.foundBy === 'audit' || s.foundBy === 'owner')
    .map((s) => {
      if (s.available === NR || s.available === 'unknown') return { key: s.key, foundBy: s.foundBy, available: s.available, chargedTo: null, report: 'not charged' };
      if (!measuring(ctx, s.available.date)) return { key: s.key, foundBy: s.foundBy, available: s.available.date, chargedTo: null, report: BEFORE_BEGAN };
      const chargedTo = dateOf(dayNumber(s.available.date) + 1);
      const report = chargedTo > to ? 'not yet due' : dailyOn(ctx.cards, chargedTo) ? 'daily' : 'no report';
      return { key: s.key, foundBy: s.foundBy, available: s.available.date, chargedTo, report };
    });
}

// One row of the per-report grid.
function reportRow(ctx, card, date, run, misses) {
  const charged = run === 'daily' ? misses.filter((m) => m.chargedTo === date).map((m) => m.key) : [];
  if (!card) {
    const word = measuring(ctx, date) ? 'no report' : BEFORE;
    const none = { score: word, band: word };
    return { date, run, report: false, beforeMeasuring: word === BEFORE, found: none, assessed: none, actionable: none, overall: none, stories: [], misses: charged };
  }
  const own = run === 'daily' ? ctx.stories.filter((s) => s.foundBy === 'daily' && s.createdDate === date) : [];
  let found;
  if (ctx.required === undefined) found = { score: NED, band: NED, reason: 'no list of required sources given (--required)' };
  else if (typeof card.sourcesListed !== 'number' || card.sourcesListed === 0 || typeof card.readInFull !== 'number' || typeof card.readInPart !== 'number') found = { score: NED, band: NED, reason: 'the scorecard does not give its source counts' };
  else {
    const required = requiredRead(card, ctx.required) ? 1 : 0;
    const read = card.readInFull + card.readInPart;
    const last = own.length + charged.length === 0 ? 1 : 1 - charged.length / (own.length + charged.length);
    const score = Math.round(100 * (0.4 * required + 0.2 * (read / card.sourcesListed) + 0.4 * last));
    found = { score, band: band(score), required, sourcesRead: read, sourcesListed: card.sourcesListed, own: own.length, missed: charged.length };
  }
  const part = (measures, provisional) => {
    if (own.length === 0) return { score: 'n/a', band: 'n/a', provisional: false };
    const p = principle(measures);
    return { score: p.score, band: p.band, provisional, measures: p.measures };
  };
  const assessed = part({ verdictAgreement: verdictAgreementOf(own), heldUp: heldUpOf(own) }, own.some((s) => s.verdict === NR));
  const affected = own.filter((s) => finalVerdict(s) === 'affected');
  const actionable = part({ concreteStep: concreteStepOf(affected), noExtraResearch: noExtraResearchOf(affected), fixedInTime: fixedInTimeOf(affected, ctx.targets) }, own.some((s) => !(s.closed && s.final !== NR)));
  const overall = lowest({ found, assessed, actionable });
  overall.provisional = assessed.provisional || actionable.provisional;
  return { date, run, report: true, beforeMeasuring: false, duplicate: card.duplicate, found, assessed, actionable, overall, stories: own.map((s) => s.key), misses: charged };
}

const median = (sorted) => (sorted.length === 0 ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

// Everything the review page draws that is not in the older sections.
function reviewOf(ctx, to) {
  const now = scoresFor(ctx, to);
  const { from } = now;
  const currentMonday = dayNumber(isoWeek(to).from);
  const weeks = [4, 3, 2, 1].map((k) => {
    const friday = dateOf(currentMonday - 7 * k + 4);
    const s = scoresFor(ctx, friday);
    return { week: isoWeek(friday).week, from: s.from, to: friday, found: s.found, assessed: s.assessed, actionable: s.actionable, overall: s.overall };
  });

  // Catch rate by the ISO week each story was created in.
  const byWeek = new Map();
  for (const s of now.scoped) {
    const w = isoWeek(s.createdDate).week;
    if (!byWeek.has(w)) byWeek.set(w, { week: w, daily: 0, audit: 0, owner: 0 });
    byWeek.get(w)[s.foundBy] += 1;
  }
  now.found.measures.catchRate.byWeek = [...byWeek.values()].sort((a, b) => (a.week < b.week ? -1 : 1));

  // Held up, as one bar: each closed story with both lines in one group.
  const both = now.scoped.filter((s) => s.closed && s.final !== NR && s.firstState !== NR);
  const changed = [];
  const heldUpBar = { unchanged: 0, tierChanged: 0, blastRadiusChanged: 0, verdictChanged: 0 };
  for (const s of both) {
    const changes = [];
    if (s.firstState.tier !== s.final.tier) changes.push({ field: 'tier', first: String(s.firstState.tier), final: String(s.final.tier) });
    if (!same(s.firstState.blastRadius, s.final.blastRadius)) changes.push({ field: 'blast radius', first: s.firstState.blastRadius, final: s.final.blastRadius });
    if (s.proposed !== NR && s.proposed !== s.final.verdict) changes.push({ field: 'verdict', first: s.proposed, final: s.final.verdict });
    const fields = changes.map((c) => c.field);
    heldUpBar[fields.includes('tier') ? 'tierChanged' : fields.includes('blast radius') ? 'blastRadiusChanged' : fields.includes('verdict') ? 'verdictChanged' : 'unchanged'] += 1;
    if (changes.length > 0) changed.push({ key: s.key, changes });
  }
  now.assessed.heldUpBar = heldUpBar;

  // How long each news-watch story took to surface, by how it became available.
  const surface = new Map();
  for (const s of now.scoped) {
    if (s.available === NR || s.available === 'unknown') continue;
    if (!surface.has(s.available.how)) surface.set(s.available.how, []);
    surface.get(s.available.how).push(dayNumber(s.createdDate) - dayNumber(s.available.date));
  }
  const timeToSurface = HOWS.filter((how) => surface.has(how)).map((how) => {
    const days = surface.get(how).sort((a, b) => a - b);
    return { how, days, median: median(days) };
  });

  // Sources read by the daily runs in the window.
  const sources = new Map();
  for (const card of ctx.cards.filter((c) => c.run === 'daily' && c.date >= from && c.date <= to)) {
    for (const s of Array.isArray(card.sources) ? card.sources : []) {
      const key = sourceKey(s.name);
      if (!sources.has(key)) sources.set(key, { source: s.name, read: 0, failed: 0, unknown: 0, required: (ctx.required ?? []).some((n) => sourceKey(n) === key) });
      const row = sources.get(key);
      row.source = s.name;
      if (READ.includes(s.result)) row.read += 1;
      else if (FAILING.includes(s.result)) row.failed += 1;
      else row.unknown += 1;
    }
  }
  const sourcesRead = [...sources.values()].sort((a, b) => Number(b.required) - Number(a.required) || b.failed - a.failed || (sourceKey(a.source) < sourceKey(b.source) ? -1 : 1));

  // The per-report grid: every date of the last GRID_DAYS for the daily
  // check, and each digest scorecard in those dates.
  const misses = missesOf(ctx, to);
  const gridDates = Array.from({ length: GRID_DAYS }, (_, i) => dateOf(dayNumber(to) - (GRID_DAYS - 1) + i));
  for (const m of misses) m.inGrid = m.chargedTo !== null && gridDates.includes(m.chargedTo);
  const reports = [];
  for (const date of gridDates) {
    reports.push(reportRow(ctx, dailyOn(ctx.cards, date), date, 'daily', misses));
    for (const card of ctx.cards.filter((c) => c.run === 'digest' && c.date === date)) reports.push(reportRow(ctx, card, date, 'digest', misses));
  }

  // B: the stories this run created for what the daily checks missed.
  let audit = { given: false, cards: [] };
  if (ctx.auditStories !== undefined) {
    const byKey = new Map(ctx.stories.map((s) => [s.key, s]));
    audit = {
      given: true,
      cards: ctx.auditStories.map((key) => {
        const s = byKey.get(key);
        if (!s) return { key, summary: 'unknown', tier: 'unknown', chargedTo: null, report: 'not charged', action: 'unknown', problems: ['not in the stories file the run supplied'] };
        const problems = s.foundBy === 'audit' ? [] : [`its found-by label is ${s.foundBy === NR ? 'not recorded' : `found-by-${s.foundBy}`}, not found-by-audit`];
        const miss = misses.find((m) => m.key === key);
        return {
          key,
          summary: s.summary,
          tier: s.firstState === NR ? NR : s.firstState.tier,
          chargedTo: miss ? miss.chargedTo : null,
          report: miss ? miss.report : 'not charged',
          action: s.action === NR ? NR : s.action.text,
          problems,
        };
      }),
    };
  }

  // C: the owner's exposure, from every story in the file.
  const exposureWeeks = Array.from({ length: 8 }, (_, i) => {
    const monday = currentMonday - 7 * (7 - i);
    const w = isoWeek(dateOf(monday));
    return {
      week: w.week, from: w.from, to: w.to,
      logged: ctx.stories.filter((s) => s.createdDate !== null && s.createdDate >= w.from && s.createdDate <= w.to).length,
      resolved: ctx.stories.filter((s) => s.resolvedDate !== null && s.resolvedDate >= w.from && s.resolvedDate <= w.to).length,
    };
  });
  const BUCKETS = [['0-7', 0, 7], ['8-14', 8, 14], ['15-30', 15, 30], ['31+', 31, Infinity]];
  const open = ctx.stories.filter((s) => !s.closed && s.createdDate !== null);
  const age = (s) => dayNumber(to) - dayNumber(s.createdDate);
  const openVerdict = (s) => (finalVerdict(s) === NR ? 'no verdict yet' : finalVerdict(s));
  const openByAge = {
    buckets: BUCKETS.map(([name]) => name),
    rows: [...VERDICTS, 'no verdict yet'].map((verdict) => ({
      verdict,
      counts: BUCKETS.map(([, lo, hi]) => open.filter((s) => openVerdict(s) === verdict && age(s) >= lo && age(s) <= hi).length),
    })).filter((row) => row.counts.some((n) => n > 0)),
  };
  const closedTimed = ctx.stories.filter((s) => s.closed && s.resolvedDate !== null && s.createdDate !== null);
  const closeGroups = new Map();
  for (const s of closedTimed) {
    const v = finalVerdict(s) === NR ? 'no verdict' : finalVerdict(s);
    if (!closeGroups.has(v)) closeGroups.set(v, []);
    closeGroups.get(v).push(dayNumber(s.resolvedDate) - dayNumber(s.createdDate));
  }
  const daysToClose = [...VERDICTS, 'no verdict'].filter((v) => closeGroups.has(v)).map((verdict) => {
    const days = closeGroups.get(verdict).sort((a, b) => a - b);
    return { verdict, count: days.length, days, median: median(days) };
  });
  const patchClock = open
    .filter((s) => finalVerdict(s) === 'affected')
    .map((s) => {
      const tier = s.latestState === NR ? NR : s.latestState.tier;
      return { key: s.key, tier, ageDays: age(s), target: ctx.targets !== undefined && tier !== NR && ctx.targets[String(tier)] !== undefined ? ctx.targets[String(tier)] : null };
    })
    .sort((a, b) => b.ageDays - a.ageDays || (a.key < b.key ? -1 : 1));
  const exposure = {
    weeks: exposureWeeks,
    open: open.length,
    openByAge,
    daysToClose,
    closedWithoutDates: ctx.stories.filter((s) => s.closed).length - closedTimed.length,
    patchClock,
  };

  const strip = ({ scoped, inWindow, ...rest }) => rest;
  const dailyReports = reports.filter((r) => r.run === 'daily');
  const scoredReports = dailyReports.filter((r) => typeof r.found.score === 'number');
  const weakest = lowest({ found: now.found, assessed: now.assessed, actionable: now.actionable });
  return {
    confidence: { ...strip(now), weeks },
    reports,
    misses,
    changed,
    timeToSurface,
    sourcesRead,
    audit,
    exposure,
    glance: {
      reportCard: {
        dailyReports: dailyReports.filter((r) => r.report).length,
        noReport: dailyReports.filter((r) => !r.report && !r.beforeMeasuring).map((r) => r.date),
        beforeMeasuring: dailyReports.filter((r) => r.beforeMeasuring).map((r) => r.date),
        lowestFound: scoredReports.length === 0 ? null : (({ date, found }) => ({ date, score: found.score, band: found.band }))(scoredReports.reduce((low, r) => (r.found.score < low.found.score ? r : low))),
        missesInGrid: misses.filter((m) => m.inGrid).length,
      },
      foundByAudit: audit.given ? audit.cards.length : 'not given',
      exposure: { open: open.length, openAffected: patchClock.length },
      weakest,
    },
  };
}

function checkRequired(required) {
  if (required === undefined) return undefined;
  if (!Array.isArray(required) || required.length === 0 || required.some((n) => typeof n !== 'string' || n.trim() === '')) {
    throw new Error('--required must be a JSON list of one or more source names, as KAN-118 names them');
  }
  return required.map((n) => n.trim());
}

function checkTargets(targets) {
  if (targets === undefined) return undefined;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new Error('--targets must be a JSON object of tier to days, for example { "1": 3, "2": 14 }');
  const out = {};
  for (const [tier, days] of Object.entries(targets)) {
    if (!['1', '2', '3', '4'].includes(tier)) throw new Error(`--targets: "${tier}" is not a tier (1 to 4)`);
    if (!Number.isInteger(days) || days < 0) throw new Error(`--targets: the days for tier ${tier} must be a whole number, 0 or more`);
    out[tier] = days;
  }
  return out;
}

function checkAuditStories(keys) {
  if (keys === undefined) return undefined;
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || k.trim() === '')) throw new Error('--audit-stories must be a JSON list of story keys');
  return keys.map((k) => k.trim());
}

// Checks one entry of the stories file; throws naming what is wrong.
function checkStory(raw, n) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`story ${n} must be an object with "key" and "created"`);
  if (typeof raw.key !== 'string' || raw.key.trim() === '') throw new Error(`story ${n} has no "key"`);
  const where = `story ${n} (${raw.key})`;
  if (raw.labels !== undefined && (!Array.isArray(raw.labels) || raw.labels.some((l) => typeof l !== 'string'))) throw new Error(`${where}: "labels" must be a list of label names`);
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') throw new Error(`${where}: "description" must be text`);
  if (raw.resolved !== undefined && raw.resolved !== null && Number.isNaN(timeOf(raw.resolved))) throw new Error(`${where} has a "resolved" that is not a time that can be read: ${raw.resolved}`);
  if (raw.comments !== undefined) {
    if (!Array.isArray(raw.comments)) throw new Error(`${where}: "comments" must be a list`);
    raw.comments.forEach((c, i) => {
      if (!c || typeof c !== 'object' || Number.isNaN(timeOf(c.created)) || typeof c.body !== 'string') throw new Error(`${where}: comment ${i + 1} must have a readable "created" time and a "body"`);
    });
  }
}

// Everything in metrics.json. `comments` and `stories` are the two input
// lists as read; `days` is the window in days; `now` is an ISO time.
// `required`, `targets` and `auditStories` are the three optional inputs of
// the review page (--required, --targets, --audit-stories).
export function rollup({ comments, stories, days, now, required, targets, auditStories }) {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days, 1 or more');
  const nowMs = timeOf(now);
  if (Number.isNaN(nowMs)) throw new Error(`--now is not a time that can be read: ${now}`);
  if (!Array.isArray(comments)) throw new Error('the comments file must be a JSON list of comments');
  const requiredList = checkRequired(required);
  const targetDays = checkTargets(targets);
  const auditKeys = checkAuditStories(auditStories);

  const cards = [];
  const reviews = [];
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
    if (card.run === 'review') {
      const review = parseReview(raw.body);
      if (review.date === 'unknown') unreadable.push({ created: raw.created, reason: `review block: date is not a YYYY-MM-DD date ("${card.date}")` });
      else reviews.push({ ...review, created: raw.created, createdMs });
      return;
    }
    const reason = !RUNS.includes(card.run)
      ? `run is not one of ${RUNS.join(', ')}, review ("${card.run}")`
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
  let parsed = [];
  if (stories !== undefined) {
    if (!Array.isArray(stories)) throw new Error('the stories file must be a JSON list of stories');
    const list = stories.map((raw, i) => {
      const n = i + 1;
      checkStory(raw, n);
      const createdMs = timeOf(raw.created);
      if (Number.isNaN(createdMs)) throw new Error(`story ${n} (${raw.key}) has a "created" that is not a time that can be read: ${raw.created}`);
      if (createdMs > nowMs) throw new Error(`story ${n} (${raw.key}) was created after --now`);
      const word = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown');
      const s = parseStory(raw);
      // The old shape is a list of open stories, taken as given; in the new
      // shape a closed story is not open, and the label shown is the verdict.
      const label = s.oldShape ? word(raw.label) : s.verdict !== NR ? `verdict-${s.verdict}` : s.agentProposed ? 'agent-proposed' : 'unknown';
      return { s, open: !s.closed, story: { key: raw.key.trim(), created: raw.created, status: word(raw.status), label, ageDays: dayNumber(to) - dayNumber(nyDate(createdMs)) }, createdMs };
    });
    list.sort((a, b) => a.createdMs - b.createdMs);
    parsed = list.map(({ s }) => s);
    const openList = list.filter(({ open }) => open);
    openStories = { given: true, count: openList.length, stories: openList.map(({ story }) => story) };
  }
  reviews.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdMs - b.createdMs));
  const reviewWeeks = new Map();
  for (const r of reviews) reviewWeeks.set(r.week, (reviewWeeks.get(r.week) ?? 0) + 1);
  // Measuring starts on the date of the first scorecard in the run log: the
  // earliest "date:" of every readable block, the review's included.
  const blockDates = [...ordered.map((card) => card.date), ...reviews.map((r) => r.date)].sort();
  const measuringFrom = blockDates[0] ?? null;
  const review = reviewOf({ cards: ordered, stories: parsed, reviews, required: requiredList, targets: targetDays, auditStories: auditKeys, measuringFrom }, to);
  const shapes = new Set(parsed.map((s) => (s.oldShape ? 'open stories only' : 'full')));

  return {
    generatedBy: NAME,
    window: { from: dates[0], to, days, now: new Date(nowMs).toISOString(), timeZone: TIME_ZONE, dates },
    input: { comments: comments.length, scorecards: ordered.length, withoutScorecard, unreadable },
    measuringFrom,
    days: byDay,
    missingDaily: byDay.filter((day) => !day.runs.some((card) => card.run === 'daily')).map((day) => day.date),
    duplicates,
    streaks: streaksOf(ordered),
    totals: totalsOf(inWindow),
    weeks: [...weeks.values()].sort((a, b) => (a.from < b.from ? -1 : 1)).map(({ week, from, to: end, cards: inWeek }) => ({ week, from, to: end, totals: totalsOf(inWeek) })),
    openStories,
    reviews: reviews.map(({ createdMs, ...r }) => ({
      ...r,
      duplicate: reviewWeeks.get(r.week) > 1,
      inScoreWindow: r.date >= review.confidence.from && r.date <= review.confidence.to,
      percent: typeof r.relevant === 'number' && typeof r.covered === 'number' && r.relevant > 0 ? Math.round((100 * r.covered) / r.relevant) : null,
    })),
    storiesRead: {
      given: stories !== undefined,
      shape: stories === undefined ? null : shapes.size === 0 ? 'none' : shapes.size === 1 ? [...shapes][0] : 'mixed',
      count: stories === undefined ? 'unknown' : parsed.length,
      problems: parsed.flatMap((s) => s.problems.map((problem) => ({ key: s.key, problem }))),
      twoFinals: parsed.filter((s) => s.finalCount > 1).map((s) => s.key),
    },
    notRecorded: {
      stories: parsed.length,
      foundBy: parsed.filter((s) => s.foundBy === NR).length,
      proposed: parsed.filter((s) => s.proposed === NR).length,
      available: parsed.filter((s) => s.available === NR).length,
      firstState: parsed.filter((s) => s.firstState === NR).length,
      action: parsed.filter((s) => s.action === NR).length,
    },
    inputsGiven: { required: requiredList ?? null, targets: targetDays ?? null, auditStories: auditKeys ?? null },
    ...review,
  };
}

// ---- the page: drawn from the metrics alone ----

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : esc(value));
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

// Laid out for US Letter portrait: 8.5 in less two 0.5 in margins is 7.5 in,
// 720 CSS pixels. Nothing on the page is wider, and nothing scrolls sideways.
const STYLE = `
@page{size:letter portrait;margin:0.5in}
:root{color-scheme:light;--page:#f4f3ef;--surface:#fcfcfb;--line:#dddcd6;--ink:#0b0b0b;--ink2:#52514e;--ink3:#7b7a75;
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--none:#b9b8b2;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--a:#2a78d6;--a-bg:#eaf2fc;--b:#c98a00;--b-bg:#fdf5e1;--c:#7b4fc9;--c-bg:#f2ecfb}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#111110;--surface:#1a1a19;--line:#383835;--ink:#f0efec;--ink2:#c3c2b7;--ink3:#96958d;
--none:#5c5b56;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--a-bg:#16222f;--b-bg:#2a2210;--c-bg:#221a30}}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--page);color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 0 48px}
@media print{body{background:#fff}main{padding:0;max-width:none}}
header h1{font-size:20px;margin:0 0 4px}
header p{margin:2px 0;color:var(--ink2)}
section{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-top:12px;break-inside:avoid}
h2{font-size:15px;margin:0 0 2px}
h3{font-size:13px;margin:10px 0 4px}
.sub{color:var(--ink2);margin:0 0 10px;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px;word-break:break-word}
th,td{text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--ink2);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
tr{break-inside:avoid}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.tile{border:1px solid var(--line);border-radius:6px;padding:8px 10px}
.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.tile span{color:var(--ink2);font-size:11px}
.chip{display:inline-flex;align-items:center;gap:6px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none}
.sq{display:inline-block;width:10px;height:10px;border-radius:2px;flex:none}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0 0 8px;color:var(--ink2);font-size:11px}
.muted{color:var(--ink3)}
.small{font-size:11px;color:var(--ink2)}
.warn{border-left:4px solid var(--critical)}
ul{margin:6px 0 0;padding-left:18px}
svg{display:block;max-width:100%;height:auto}
svg text{font:11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink2)}
svg text.v{fill:var(--ink);font-variant-numeric:tabular-nums}
svg text.big{fill:var(--ink);font-size:26px;font-weight:650}
svg text.mid{fill:var(--ink);font-size:13px;font-weight:600}
.axis{stroke:var(--line);stroke-width:1}
.guide{stroke:var(--line);stroke-width:1;stroke-dasharray:3 3}
.f-good{fill:var(--good)}.f-warning{fill:var(--warning)}.f-serious{fill:var(--serious)}.f-critical{fill:var(--critical)}.f-none{fill:var(--none)}
.f-s1{fill:var(--s1)}.f-s2{fill:var(--s2)}.f-s3{fill:var(--s3)}.f-a{fill:var(--a)}.f-b{fill:var(--b)}.f-c{fill:var(--c)}
.k-good{stroke:var(--good)}.k-warning{stroke:var(--warning)}.k-critical{stroke:var(--critical)}.k-none{stroke:var(--none)}.k-line{stroke:var(--line)}
.k-s1{stroke:var(--s1)}.k-s2{stroke:var(--s2)}.k-s3{stroke:var(--s3)}.k-c{stroke:var(--c)}.k-ink{stroke:var(--ink)}
.b-good{background:var(--good)}.b-warning{background:var(--warning)}.b-serious{background:var(--serious)}.b-critical{background:var(--critical)}.b-none{background:var(--none)}
.b-s1{background:var(--s1)}.b-s2{background:var(--s2)}.b-s3{background:var(--s3)}.b-c{background:var(--c)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 18px}
.grid h3{margin-top:0}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 14px}
.grid3 h3{margin:0;font-size:12px}
.page{break-before:page}
.part{border-left:8px solid;border-radius:6px;padding:10px 14px;margin-top:14px}
.part h2{font-size:17px;margin:0}
.part p{margin:2px 0 0;color:var(--ink2)}
.part-a{border-color:var(--a);background:var(--a-bg)}.part-b{border-color:var(--b);background:var(--b-bg)}.part-c{border-color:var(--c);background:var(--c-bg)}
.dials{display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr;gap:8px;align-items:end}
.dial{text-align:center}
.dial p{margin:2px 0;font-size:11px;color:var(--ink2)}
.measures{margin:4px 0 0;padding-left:16px;font-size:11px;line-height:1.35;color:var(--ink2)}
td.nw,th.nw{white-space:nowrap}
.glance{margin:0;padding-left:18px}
.glance li{margin:3px 0}
.card{border:1px solid var(--line);border-left:5px solid var(--b);border-radius:6px;padding:8px 12px;margin:8px 0;break-inside:avoid}
.card b{font-size:13px}
`;

const STATUS = { VALID: ['good', '✓ VALID'], FAILED: ['critical', '✕ FAILED'], unknown: ['none', '? status unknown'] };
const SOURCE_PARTS = [['readInFull', 'good', 'read in full'], ['readInPart', 'warning', 'read in part'], ['searchedOnly', 'serious', 'searched only'], ['couldNotCheck', 'critical', 'could not check']];
const VERDICT_PARTS = [['applies', 's1', 'applies'], ['cannotTell', 's2', 'cannot tell'], ['doesNotApply', 's3', 'does not apply']];
const BAND_COLOR = { High: 'good', Medium: 'warning', Low: 'critical' };
const PRINCIPLES = [['found', 'Found', 'did it find everything, in time'], ['assessed', 'Assessed', 'were the impacts right'], ['actionable', 'Actionable', 'could you act on it']];
const MEASURE_NAMES = {
  catchRate: 'Catch rate', coverage: 'Coverage', requiredSources: 'Required sources', onTime: 'On time',
  verdictAgreement: 'Verdict agreement', heldUp: 'Held up',
  concreteStep: 'Concrete step', noExtraResearch: 'No extra research', fixedInTime: 'Fixed in time',
};

const legend = (parts) => `<p class="legend">${parts.map(([, color, label]) => `<span class="chip"><i class="sq b-${color}"></i>${esc(label)}</span>`).join('')}</p>`;

// "64 Low", or the words when there is no number.
function scoreWords(p) {
  if (typeof p.score !== 'number') return esc(p.score);
  return `${num(p.score)} ${esc(p.band)}${p.provisional ? ' (provisional)' : ''}`;
}
// "60% (3 of 5)", with what was left out, or why there is no data.
function countsWords(m) {
  const left = m.leftOut > 0 ? `; ${plural(m.leftOut, 'story', 'stories')} left out, not recorded` : '';
  if (!m.hasData) return `no data${m.reason ? `: ${esc(m.reason)}` : ''}${left}`;
  return `${num(m.percent)}% (${num(m.numerator)} of ${num(m.denominator)})${left}`;
}

// A half-circle dial with the score, its band word and the band marks.
function dial(p, width) {
  const r = width * 0.38;
  const cx = width / 2;
  const cy = width * 0.46;
  const sw = width * 0.09;
  const height = cy + width * 0.2;
  const at = (v) => {
    const a = Math.PI * (1 - v / 100);
    return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  };
  const arc = (v0, v1, cls) => {
    const [x0, y0] = at(v0);
    const [x1, y1] = at(v1);
    return `<path class="${cls}" d="M${x0.toFixed(1)},${y0.toFixed(1)}A${r.toFixed(1)},${r.toFixed(1)} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}" fill="none" stroke-width="${sw.toFixed(1)}"/>`;
  };
  const scored = typeof p.score === 'number';
  const marks = [70, 90].map((v) => {
    const [x0, y0] = at(v);
    const [x1, y1] = [cx + (r + sw * 0.9) * Math.cos(Math.PI * (1 - v / 100)), cy - (r + sw * 0.9) * Math.sin(Math.PI * (1 - v / 100))];
    return `<line class="k-ink" x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke-width="1"/><text x="${x1.toFixed(1)}" y="${(y1 - 3).toFixed(1)}" text-anchor="middle">${v}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height.toFixed(0)}" width="${width}" height="${height.toFixed(0)}" role="img" aria-label="${esc(scored ? `${p.score} ${p.band}` : p.score)}">
${arc(0, 100, 'k-line')}${scored && p.score > 0 ? arc(0, Math.min(100, p.score), `k-${BAND_COLOR[p.band]}`) : ''}${marks.join('')}
<text class="${scored ? 'big' : 'mid'}" x="${cx}" y="${(cy - 4).toFixed(1)}" text-anchor="middle">${scored ? num(p.score) : 'no score'}</text>
<text class="mid" x="${cx}" y="${(cy + 16).toFixed(1)}" text-anchor="middle">${esc(p.band)}</text></svg>`;
}

// One horizontal stacked bar of [value, colour, label] parts, numbers printed.
function hbar(parts, scale, width = 300) {
  let x = 0;
  const out = [];
  for (const [value, color, label] of parts) {
    if (typeof value !== 'number' || value === 0) continue;
    const w = Math.max(2, (value / Math.max(1, scale)) * width);
    out.push(`<rect class="f-${color}" x="${x.toFixed(1)}" y="2" width="${w.toFixed(1)}" height="14" rx="2"><title>${esc(label)}: ${num(value)}</title></rect>`);
    if (w >= 16) out.push(`<text class="v" x="${(x + w / 2).toFixed(1)}" y="13" text-anchor="middle" style="fill:#fff">${num(value)}</text>`);
    x += w + 2;
  }
  return `<svg viewBox="0 0 ${width + 10} 18" width="${width + 10}" height="18" role="img" aria-label="${esc(parts.map(([v, , l]) => `${l} ${v}`).join(', '))}">${out.join('')}</svg>`;
}
const partsWords = (parts) => parts.map(([value, , label]) => `${esc(label)} ${num(value)}`).join(' · ');

// One horizontal stacked bar. `scale` is the largest row total in the chart,
// so rows can be compared; the gaps between segments are 2px of surface.
function stackedBar(run, parts, scale) {
  const width = 180;
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
  return `<section><h2>${title}</h2><p class="sub">${sub}</p>${legend(parts)}<table><thead><tr><th>Date</th><th>Run</th><th></th>${parts.map(([, , label]) => `<th class="n">${esc(label)}</th>`).join('')}<th class="n">${totalKey === 'events' ? 'events' : 'listed'}</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`;
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

// The three principles week by week, then this run's window. Each series has
// its own marker and line pattern, and every point has its number.
function trendChart(weeks, current) {
  const cols = [...weeks.map((w) => ({ label: w.week.slice(5), p: w })), { label: 'now', p: current }];
  const width = 680;
  const left = 56;
  const top = 10;
  const plot = 90;
  const step = (width - left - 60) / Math.max(1, cols.length - 1);
  const y = (v) => top + plot - (v / 100) * plot;
  const series = [['found', 'k-s1', 'f-s1', 'circle', ''], ['assessed', 'k-s2', 'f-s2', 'square', '5 3'], ['actionable', 'k-s3', 'f-s3', 'triangle', '2 3']];
  const marker = (shape, cls, x, yy) => (shape === 'circle' ? `<circle class="${cls}" cx="${x}" cy="${yy}" r="4"/>`
    : shape === 'square' ? `<rect class="${cls}" x="${x - 4}" y="${yy - 4}" width="8" height="8"/>`
      : `<path class="${cls}" d="M${x},${yy - 5}l5,9h-10z"/>`);
  const out = [];
  for (const v of [0, 70, 90, 100]) out.push(`<line class="${v === 0 ? 'axis' : 'guide'}" x1="${left}" x2="${width - 20}" y1="${y(v)}" y2="${y(v)}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
  cols.forEach((c, i) => {
    out.push(`<text x="${left + i * step}" y="${top + plot + 16}" text-anchor="middle">${esc(c.label)}</text>`);
    series.forEach(([key], s) => out.push(`<text class="v" x="${left + i * step}" y="${top + plot + 31 + s * 13}" text-anchor="middle">${esc(PRINCIPLES[s][1])} ${typeof c.p[key].score === 'number' ? num(c.p[key].score) : '–'}</text>`));
  });
  series.forEach(([key, line, fill, shape, dash], s) => {
    const pts = cols.map((c, i) => ({ x: left + i * step + (s - 1) * 3, v: c.p[key].score })).filter((pt) => typeof pt.v === 'number');
    if (pts.length > 1) out.push(`<polyline class="${line}" fill="none" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ''} points="${pts.map((pt) => `${pt.x.toFixed(1)},${y(pt.v).toFixed(1)}`).join(' ')}"/>`);
    for (const pt of pts) out.push(marker(shape, fill, pt.x.toFixed(1), y(pt.v).toFixed(1)));
  });
  const legendItems = series.map(([key, , fill, shape], i) => `<svg viewBox="0 0 14 14" width="14" height="14" style="display:inline-block;vertical-align:middle">${marker(shape, fill, 7, 7)}</svg> ${esc(PRINCIPLES[i][1])}${key === 'assessed' ? ' (dashed)' : key === 'actionable' ? ' (dotted)' : ' (solid)'}`);
  const missing = cols.filter((c) => series.some(([key]) => typeof c.p[key].score !== 'number')).map((c) => c.label);
  return `<p class="legend">${legendItems.map((l) => `<span class="chip">${l}</span>`).join('')}</p><svg viewBox="0 0 ${width} ${top + plot + 64}" width="${width}" height="${top + plot + 64}" role="img" aria-label="The three principles by week">${out.join('')}</svg>${missing.length ? `<p class="small">A point is missing, and its number is "–", where a principle had not enough data (${missing.map(esc).join(', ')}).</p>` : ''}`;
}

function principleBlock(title, question, p) {
  return `<div class="dial">${dial(p, 130)}<b>${esc(title)}</b><p>${esc(question)}</p><p>Based on ${num(p.measuresWithData)} of ${num(p.measuresTotal)} measures</p></div>`;
}

function measureList(name, p) {
  const items = Object.entries(p.measures).map(([key, m]) => `<li><b>${esc(MEASURE_NAMES[key])}</b>${name === 'found' ? ` (weight ${num(FOUND_WEIGHTS[key])})` : ''}: ${countsWords(m)}</li>`);
  if (name === 'assessed' && p.cannotTell) items.push(`<li>Not scored: "cannot tell" verdicts in the daily scorecards, ${countsWords(p.cannotTell)}</li>`);
  return `<div><h3>${esc(PRINCIPLES.find(([n]) => n === name)[1])}: ${scoreWords(p)}, based on ${num(p.measuresWithData)} of ${num(p.measuresTotal)} measures</h3><ul class="measures">${items.join('')}</ul></div>`;
}

// A per-report cell: the score and band, or the words.
function reportCell(p, detail = '') {
  return `${scoreWords(p)}${detail ? `<br><span class="small">${detail}</span>` : ''}`;
}

function confidencePage(metrics) {
  const c = metrics.confidence;
  const g = metrics.glance;
  const o = c.overall;
  const fromName = o.from ? PRINCIPLES.find(([n]) => n === o.from)[1] : null;
  const out = [];
  out.push(`<section><h2>Overall confidence</h2><p class="sub">The lowest of the three principles, never an average. Scores ${esc(c.from)} to ${esc(c.to)} (${num(c.days)} days). High is 90 and above, Medium 70 to 89, Low below 70.</p>
<div class="dials"><div class="dial">${dial(o, 180)}<b>Overall</b><p>${typeof o.score === 'number' ? `the lowest of the three: ${esc(fromName)}` : 'no principle has enough data'}</p></div>
${PRINCIPLES.map(([name, title, question]) => principleBlock(title, question, c[name])).join('\n')}</div>
<div class="grid3" style="margin-top:6px">${PRINCIPLES.map(([name]) => measureList(name, c[name])).join('')}</div></section>`);

  const rc = g.reportCard;
  const weakest = g.weakest;
  out.push(`<section><h2>At a glance</h2><ul class="glance">
<li><b>Report card:</b> ${plural(rc.dailyReports, 'daily report', 'daily reports')} in the last 8 days${rc.noReport.length ? `; no report on ${rc.noReport.map(esc).join(', ')}` : '; none missing'}${rc.beforeMeasuring.length ? `; ${plural(rc.beforeMeasuring.length, 'day was', 'days were')} before measuring began` : ''}. ${rc.lowestFound ? `Lowest Found for one report: ${num(rc.lowestFound.score)} ${esc(rc.lowestFound.band)} (${esc(rc.lowestFound.date)}).` : 'No report has a Found score.'} ${plural(rc.missesInGrid, 'miss is', 'misses are')} charged to these days.</li>
<li><b>Found by the audit:</b> ${g.foundByAudit === 'not given' ? 'not given: the run passed no list of its new stories.' : `${plural(g.foundByAudit, 'story', 'stories')} this run.`}</li>
<li><b>Your exposure:</b> ${plural(g.exposure.open, 'open story', 'open stories')}; ${plural(g.exposure.openAffected, 'is', 'are')} affected and not yet closed.</li>
<li><b>Weakest principle:</b> ${weakest.from ? `${esc(PRINCIPLES.find(([n]) => n === weakest.from)[1])}, ${num(weakest.score)} ${esc(weakest.band)}.` : 'not enough data.'}</li>
</ul></section>`);
  out.push(`<section><h2>Week by week</h2><p class="sub">Each of the four ISO weeks before this one, scored over its own ${num(c.days)} days ending on its Friday, then this run's window ("now"). Past weeks are scored with the stories' labels and lines as they are today.</p>${trendChart(c.weeks, c)}</section>`);
  return out.join('\n');
}

function reportCardPart(metrics) {
  const c = metrics.confidence;
  const out = [`<div class="part part-a page"><h2>A. Report card</h2><p>Feedback on the other reports. Nothing new is reported here.</p></div>`];

  const rows = metrics.reports.map((r) => {
    const f = r.found;
    const detail = typeof f.score === 'number' ? `required ${f.required ? 'all read' : 'not all read'}; ${num(f.sourcesRead)} of ${num(f.sourcesListed)} sources; ${plural(f.own, 'story', 'stories')}, ${plural(f.missed, 'miss', 'misses')}` : f.reason ? esc(f.reason) : '';
    return `<tr><td class="nw">${esc(r.date)}</td><td class="nw">${esc(r.run)}${r.duplicate ? ' (two scorecards: newest used)' : ''}</td><td>${reportCell(f, detail)}</td><td>${reportCell(r.assessed)}</td><td>${reportCell(r.actionable)}</td><td>${reportCell(r.overall)}</td><td>${r.stories.length ? `stories: ${r.stories.map(esc).join(', ')}` : ''}${r.misses.length ? `${r.stories.length ? '<br>' : ''}missed: ${r.misses.map(esc).join(', ')}` : ''}</td></tr>`;
  });
  const uncharged = metrics.misses.filter((m) => !m.inGrid);
  out.push(`<section><h2>Each report, last 8 days</h2><p class="sub">The daily light check on every date, and each digest. "n/a": the report created no story. "provisional": the owner has not finished with its stories yet. "before measuring": a day before the run log's first scorecard${metrics.measuringFrom ? ` (${esc(metrics.measuringFrom)})` : ''}; it is not a missing report.</p>
<table><thead><tr><th class="nw">Date</th><th class="nw">Run</th><th>Found</th><th>Assessed</th><th>Actionable</th><th>Overall</th><th>Stories and misses</th></tr></thead><tbody>${rows.join('\n')}</tbody></table>
${uncharged.length ? `<p class="small">Misses not charged to these 8 days: ${uncharged.map((m) => `${esc(m.key)} (${m.chargedTo ? `charged to ${esc(m.chargedTo)}, ${esc(m.report)}` : esc(m.report)})`).join('; ')}.</p>` : ''}</section>`);

  const catchRate = c.found.measures.catchRate;
  const weekScale = Math.max(1, ...catchRate.byWeek.map((w) => w.daily + w.audit + w.owner));
  const catchRows = catchRate.byWeek.map((w) => {
    const parts = [[w.daily, 's1', 'daily'], [w.audit, 's2', 'audit'], [w.owner, 's3', 'owner']];
    return `<tr><td>${esc(w.week)}</td><td>${hbar(parts, weekScale, 260)}</td><td>${partsWords(parts)}</td></tr>`;
  });
  out.push(`<section><h2>Catch rate: who found each issue</h2><p class="sub">${countsWords(catchRate)} found by the daily light check. Stories by the ISO week they were logged in; the app scan is not counted.</p>
${legend([[0, 's1', 'daily light check'], [0, 's2', 'Friday audit'], [0, 's3', 'owner']])}${catchRows.length ? `<table><tbody>${catchRows.join('')}</tbody></table>` : '<p class="muted">No news-watch story with a found-by label in the window.</p>'}</section>`);

  const srcScale = Math.max(1, ...metrics.sourcesRead.map((s) => s.read + s.failed + s.unknown));
  const req = c.found.measures.requiredSources;
  out.push(`<section><h2>Sources read by the daily check</h2><p class="sub">Runs in the scoring window in which each source was read (in full or in part) or failed (searched only, or could not check). Required sources: ${countsWords(req)} of days with every required source read${req.daysWithoutScorecard ? `; ${plural(req.daysWithoutScorecard, 'day has', 'days have')} no daily scorecard and count as failed` : ''}${req.daysBeforeMeasuring ? `; ${plural(req.daysBeforeMeasuring, 'day is', 'days are')} before measuring began and not counted` : ''}.</p>
${legend([[0, 'good', 'read'], [0, 'critical', 'failed'], [0, 'none', 'result unknown']])}
${metrics.sourcesRead.length ? `<table><tbody>${metrics.sourcesRead.map((s) => { const parts = [[s.read, 'good', 'read'], [s.failed, 'critical', 'failed'], [s.unknown, 'none', 'unknown']]; return `<tr><td>${esc(s.source)}${s.required ? ' <b>(required)</b>' : ''}</td><td>${hbar(parts, srcScale, 220)}</td><td>${partsWords(parts.filter(([v]) => v > 0))}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">No daily scorecard with source lines in the window.</p>'}</section>`);

  const reviews = metrics.reviews.filter((r) => r.percent !== null);
  const cov = c.found.measures.coverage;
  let covChart = '<p class="muted">No review block with counts yet.</p>';
  if (reviews.length > 0) {
    const width = 680;
    const left = 34;
    const plot = 110;
    const y = (v) => 22 + plot - (v / 100) * plot;
    const x = (i) => left + 70 + (reviews.length === 1 ? (width - left - 140) / 2 : i * ((width - left - 160) / Math.max(1, reviews.length - 1)));
    const parts = [0, 50, 100].map((v) => `<line class="${v === 0 ? 'axis' : 'guide'}" x1="${left}" x2="${width - 20}" y1="${y(v)}" y2="${y(v)}"/><text x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`);
    if (reviews.length > 1) parts.push(`<polyline class="k-s1" fill="none" stroke-width="2" points="${reviews.map((r, i) => `${x(i).toFixed(1)},${y(r.percent).toFixed(1)}`).join(' ')}"/>`);
    reviews.forEach((r, i) => parts.push(`<circle class="f-s1" cx="${x(i).toFixed(1)}" cy="${y(r.percent).toFixed(1)}" r="4"/><text class="v" x="${x(i).toFixed(1)}" y="${(y(r.percent) - 8).toFixed(1)}" text-anchor="middle">${num(r.percent)}% (${num(r.covered)} of ${num(r.relevant)})</text><text x="${x(i).toFixed(1)}" y="${22 + plot + 16}" text-anchor="middle">week of ${esc(r.week)}${r.inScoreWindow ? '' : ' (not scored)'}</text>`));
    covChart = `<svg viewBox="0 0 ${width} ${plot + 44}" width="${width}" height="${plot + 44}" role="img" aria-label="Coverage by review">${parts.join('')}</svg>`;
  }
  out.push(`<section><h2>Coverage against the independent list</h2><p class="sub">From the weekly review's blocks: relevant items in SANS NewsBites and the week's CISA exploited-list additions that a brief mentioned. In the scoring window: ${countsWords(cov)}.</p>${covChart}</section>`);

  const tts = metrics.timeToSurface;
  let ttsChart = '<p class="muted">No news-watch story in the window has an Available date.</p>';
  if (tts.length > 0) {
    const maxDay = Math.max(7, ...tts.flatMap((t) => t.days));
    const width = 680;
    const left = 130;
    const right = 120;
    const rowH = 34;
    const xs = (d) => left + (d / maxDay) * (width - left - right - 24);
    const parts = [];
    tts.forEach((t, i) => {
      const yy = 14 + i * rowH;
      parts.push(`<text x="0" y="${yy + 4}">${esc(t.how)}</text><line class="axis" x1="${left}" x2="${width - right}" y1="${yy + 8}" y2="${yy + 8}"/>`);
      const stack = new Map();
      for (const d of t.days) {
        const k = stack.get(d) ?? 0;
        stack.set(d, k + 1);
        parts.push(`<circle class="f-s1" cx="${xs(d).toFixed(1)}" cy="${(yy + 4 - k * 7).toFixed(1)}" r="3.5"/>`);
      }
      for (const [d, k] of stack) parts.push(`<text class="v" x="${xs(d).toFixed(1)}" y="${yy + 20}" text-anchor="middle">${num(d)}${k > 1 ? ` ×${num(k)}` : ''}</text>`);
      parts.push(`<text x="${width - right + 8}" y="${yy + 6}">${plural(t.days.length, 'story', 'stories')}, median ${num(t.median)}</text>`);
    });
    ttsChart = `<svg viewBox="0 0 ${width} ${tts.length * rowH + 10}" width="${width}" height="${tts.length * rowH + 10}" role="img" aria-label="Days from available to logged">${parts.join('')}</svg>`;
  }
  const onTime = c.found.measures.onTime;
  out.push(`<section><h2>Time to surface</h2><p class="sub">Days from the story's Available date to the day it was logged, one dot per news-watch story, by how the item became available. On time (daily check, 1 day or less): ${countsWords(onTime)}.</p>${ttsChart}</section>`);

  const va = c.assessed.measures.verdictAgreement;
  let ring = `<p class="muted">No story has both a definite proposed verdict (affected or not affected) and a confirmed one yet.</p>`;
  if (va.hasData) {
    const r = 44;
    const circ = 2 * Math.PI * r;
    const agreeLen = (va.numerator / va.denominator) * circ;
    ring = `<svg viewBox="0 0 300 110" width="300" height="110" role="img" aria-label="${num(va.numerator)} of ${num(va.denominator)} verdicts agree">
<circle cx="55" cy="55" r="${r}" fill="none" class="k-critical" stroke-width="14"/>
<circle cx="55" cy="55" r="${r}" fill="none" class="k-good" stroke-width="14" stroke-dasharray="${agreeLen.toFixed(1)} ${(circ - agreeLen).toFixed(1)}" transform="rotate(-90 55 55)"/>
<text class="mid" x="55" y="60" text-anchor="middle">${num(va.percent)}%</text>
<text class="v" x="118" y="44">agree: ${num(va.numerator)}</text><text class="v" x="118" y="64">disagree: ${num(va.rest)}</text><text x="118" y="84">of ${plural(va.denominator, 'story', 'stories')}</text></svg>
${va.disagree.length ? `<p class="small">Disagree: ${va.disagree.map(esc).join(', ')}.</p>` : ''}`;
  }
  ring += `<p class="small">Proposed as needs-info or watch, not scored: left for you to decide: ${num(va.leftToOwner ?? 0)} of ${plural(va.withBoth ?? 0, 'story', 'stories')}.</p>`;
  const hu = c.assessed.heldUpBar;
  const huParts = [[hu.unchanged, 'good', 'unchanged'], [hu.tierChanged, 'critical', 'tier changed'], [hu.blastRadiusChanged, 'serious', 'blast radius changed'], [hu.verdictChanged, 'warning', 'verdict changed']];
  const huTotal = hu.unchanged + hu.tierChanged + hu.blastRadiusChanged + hu.verdictChanged;
  out.push(`<section><h2>Was the assessment right?</h2><div class="grid"><div><h3>Verdict agreement</h3><p class="small">The agent's proposed verdict against the owner's, for proposals of affected or not affected: ${countsWords(va)}.</p>${ring}</div>
<div><h3>Did the first assessment hold up</h3><p class="small">Closed stories with a Final line and a first state line: ${countsWords(c.assessed.measures.heldUp)} kept tier and blast radius. Each story is in one group, tier first.</p>
${huTotal ? `${legend(huParts.map(([, col, l]) => [0, col, l]))}${hbar(huParts, huTotal, 300)}<p class="small">${partsWords(huParts)}</p>` : '<p class="muted">No closed story has both lines yet.</p>'}
${metrics.changed.length ? `<ul class="measures">${metrics.changed.map((ch) => `<li>${esc(ch.key)}: ${ch.changes.map((x) => `${esc(x.field)} ${esc(x.first)} → ${esc(x.final)}`).join('; ')}</li>`).join('')}</ul>` : ''}</div></div></section>`);

  const a = c.actionable.measures;
  const twoBars = [['Concrete step', a.concreteStep, [[a.concreteStep.numerator, 'good', 'a concrete step'], [a.concreteStep.rest, 'critical', 'unknown or none stated']]],
    ['Extra research', a.noExtraResearch, [[a.noExtraResearch.numerator, 'good', 'none needed'], [a.noExtraResearch.rest, 'critical', 'needed']]]];
  out.push(`<section><h2>Were the fixes usable</h2><p class="sub">Over the ${plural(c.actionable.affectedStories, 'story', 'stories')} whose final verdict is affected.</p>
${twoBars.map(([title, m, parts]) => `<h3>${esc(title)}: ${countsWords(m)}</h3>${m.hasData ? `${hbar(parts, m.denominator, 300)}<p class="small">${partsWords(parts)}</p>` : ''}`).join('')}
<h3>Fixed in time: ${countsWords(a.fixedInTime)}</h3></section>`);
  return out.join('\n');
}

function auditPart(metrics) {
  const out = [`<div class="part part-b page"><h2>B. Found by the audit</h2><p>What the Friday audit caught that the daily checks did not, with the action.</p></div>`];
  const a = metrics.audit;
  let body;
  if (!a.given) body = '<p class="muted">Not given: the run passed no list of the stories it created (--audit-stories).</p>';
  else if (a.cards.length === 0) body = '<p><b>Nothing missed this week.</b></p>';
  else {
    body = a.cards.map((card) => {
      const why = card.report === 'daily' ? `the daily report of ${esc(card.chargedTo)} could have found it and did not`
        : card.report === 'no report' ? `no report that day (${esc(card.chargedTo)})`
          : card.report === 'not yet due' ? `became available too late for a daily report yet (${esc(card.chargedTo)})`
            : card.report === BEFORE_BEGAN ? 'before measuring began: it became available before the run log\'s first scorecard, so it is charged to no report'
            : 'not charged to a report: its Available date is not recorded';
      return `<div class="card"><b>${esc(card.key)}: ${esc(card.summary)}</b><br>Tier ${esc(card.tier)}. Why it was missed: ${why}.<br>${esc(card.action)}${card.problems.length ? `<br><span class="small">${card.problems.map(esc).join('; ')}</span>` : ''}</div>`;
    }).join('');
  }
  out.push(`<section>${body}</section>`);
  return out.join('\n');
}

function exposurePart(metrics) {
  const e = metrics.exposure;
  const out = [`<div class="part part-c"><h2>C. Your exposure</h2><p>The issues that affect you: open, resolved, and how long they take. Every intake story in the file, the app scan's included.</p></div>`];

  const width = 680;
  const slot = (width - 20) / e.weeks.length;
  const plot = 90;
  const scale = Math.max(1, ...e.weeks.flatMap((w) => [w.logged, w.resolved]));
  const bars = e.weeks.map((w, i) => {
    const x0 = 20 + i * slot + slot / 2 - 26;
    const col = (v, x, cls, letter) => {
      const h = (v / scale) * plot;
      return `${h > 0 ? `<rect class="${cls}" x="${x}" y="${(14 + plot - h).toFixed(1)}" width="24" height="${h.toFixed(1)}" rx="2"/>` : ''}<text class="v" x="${x + 12}" y="${(10 + plot - h).toFixed(1)}" text-anchor="middle">${num(v)}</text><text x="${x + 12}" y="${plot + 26}" text-anchor="middle">${letter}</text>`;
    };
    return `${col(w.logged, x0, 'f-c', 'L')}${col(w.resolved, x0 + 28, 'f-s3', 'R')}<text x="${x0 + 26}" y="${plot + 40}" text-anchor="middle">${esc(w.week.slice(5))}</text>`;
  });
  out.push(`<section><h2>Logged and resolved, by week</h2><p class="sub">L: stories logged that ISO week. R: stories resolved that week.</p>${legend([[0, 'c', 'L, logged'], [0, 's3', 'R, resolved']])}
<svg viewBox="0 0 ${width} ${plot + 48}" width="${width}" height="${plot + 48}" role="img" aria-label="Logged and resolved by week"><line class="axis" x1="10" x2="${width - 10}" y1="${14 + plot + 0.5}" y2="${14 + plot + 0.5}"/>${bars.join('')}</svg></section>`);

  const VCOL = { affected: 'critical', 'not-affected': 'good', watch: 'warning', 'needs-info': 'serious', 'no verdict yet': 'none' };
  const ageScale = Math.max(1, ...e.openByAge.buckets.map((_, b) => e.openByAge.rows.reduce((n, r) => n + r.counts[b], 0)));
  out.push(`<section><h2>Open issues by age and verdict</h2><p class="sub">${plural(e.open, 'open story', 'open stories')}, by whole days since it was logged.</p>
${legend(e.openByAge.rows.map((r) => [0, VCOL[r.verdict], r.verdict]))}
${e.openByAge.rows.length ? `<table><tbody>${e.openByAge.buckets.map((bucket, b) => { const parts = e.openByAge.rows.map((r) => [r.counts[b], VCOL[r.verdict], r.verdict]); return `<tr><td>${esc(bucket)} days</td><td>${hbar(parts, ageScale, 260)}</td><td>${partsWords(parts.filter(([v]) => v > 0)) || '<span class="muted">none</span>'}</td></tr>`; }).join('')}</tbody></table>` : '<p class="muted">No open story.</p>'}</section>`);

  let closeChart = '<p class="muted">No closed story with both dates in the file.</p>';
  if (e.daysToClose.length) {
    const maxDay = Math.max(7, ...e.daysToClose.flatMap((d) => d.days));
    const left = 110;
    const right = 150;
    const rowH = 30;
    const xs = (d) => left + (d / maxDay) * (width - left - right - 24);
    const parts = [];
    e.daysToClose.forEach((d, i) => {
      const yy = 12 + i * rowH;
      parts.push(`<text x="0" y="${yy + 4}">${esc(d.verdict)}</text><line class="axis" x1="${left}" x2="${width - right}" y1="${yy + 8}" y2="${yy + 8}"/>`);
      const stack = new Map();
      for (const v of d.days) { const k = stack.get(v) ?? 0; stack.set(v, k + 1); parts.push(`<circle class="f-c" cx="${xs(v).toFixed(1)}" cy="${(yy + 4 - k * 7).toFixed(1)}" r="3.5"/>`); }
      parts.push(`<line class="k-ink" x1="${xs(d.median).toFixed(1)}" x2="${xs(d.median).toFixed(1)}" y1="${yy - 6}" y2="${yy + 12}" stroke-width="2"/>`);
      for (const [v, k] of stack) parts.push(`<text class="v" x="${xs(v).toFixed(1)}" y="${yy + 21}" text-anchor="middle">${num(v)}${k > 1 ? ` ×${num(k)}` : ''}</text>`);
      parts.push(`<text x="${width - right + 8}" y="${yy + 6}">${plural(d.count, 'story', 'stories')}, median ${num(d.median)} days</text>`);
    });
    closeChart = `<svg viewBox="0 0 ${width} ${e.daysToClose.length * rowH + 10}" width="${width}" height="${e.daysToClose.length * rowH + 10}" role="img" aria-label="Days from logged to Done">${parts.join('')}</svg>`;
  }
  out.push(`<section><h2>Days from logged to Done, by verdict</h2><p class="sub">One dot per closed story; the dark line is the median.${e.closedWithoutDates ? ` ${plural(e.closedWithoutDates, 'closed story has', 'closed stories have')} no resolved date and ${e.closedWithoutDates === 1 ? 'is' : 'are'} not shown.` : ''}</p>${closeChart}</section>`);

  let clock = '<p class="muted">No open story whose verdict is affected.</p>';
  if (e.patchClock.length) {
    const maxDay = Math.max(7, ...e.patchClock.flatMap((p) => [p.ageDays, p.target ?? 0]));
    const left = 70;
    const right = 290;
    const rowH = 26;
    const xs = (d) => left + (d / maxDay) * (width - left - right - 24);
    const parts = e.patchClock.map((p, i) => {
      const yy = 6 + i * rowH;
      const over = p.target !== null && p.ageDays > p.target;
      return `<text x="0" y="${yy + 12}">${esc(p.key)}</text><rect class="${over ? 'f-critical' : 'f-c'}" x="${left}" y="${yy}" width="${Math.max(2, xs(p.ageDays) - left).toFixed(1)}" height="16" rx="2"/>`
        + `${p.target !== null ? `<line class="k-ink" x1="${xs(p.target).toFixed(1)}" x2="${xs(p.target).toFixed(1)}" y1="${yy - 3}" y2="${yy + 19}" stroke-width="2" stroke-dasharray="3 2"/>` : ''}`
        + `<text x="${width - right + 8}" y="${yy + 12}">tier ${esc(p.tier)}: ${plural(p.ageDays, 'day', 'days')} open; ${p.target === null ? 'no target set' : `target ${plural(p.target, 'day', 'days')}${over ? ', past it' : ''}`}</text>`;
    });
    clock = `<svg viewBox="0 0 ${width} ${e.patchClock.length * rowH + 8}" width="${width}" height="${e.patchClock.length * rowH + 8}" role="img" aria-label="Patch clock">${parts.join('')}</svg><p class="small">The dashed line is the tier's target from KAN-118, passed in by the run. A bar past its target is drawn in red and says "past it".</p>`;
  }
  out.push(`<section><h2>Patch clock</h2><p class="sub">Each open story whose verdict is affected: days since it was logged, against its tier's target. The tier is the newest state line on the story.</p>${clock}</section>`);
  return out.join('\n');
}

// The page. `metrics` is metrics.json as read back: nothing else is used.
export function renderDashboard(metrics) {
  const { window: win, input, totals } = metrics;
  const sumCell = (t, key) => `${num(t.sums[key])}${t.unknown[key] > 0 ? ` <span class="muted">(+${num(t.unknown[key])} unknown)</span>` : ''}`;
  const out = [];

  out.push(`<header><h1>Home agent: the week in review, ${esc(win.from)} to ${esc(win.to)}</h1>
<p>Window: ${esc(win.from)} to ${esc(win.to)}, ${plural(win.days, 'day', 'days')}, calendar dates in ${esc(win.timeZone)}, up to ${esc(win.now)}.</p>
<p>${plural(input.scorecards, 'scorecard', 'scorecards')} read from ${plural(input.comments, 'comment', 'comments')}; ${plural(input.withoutScorecard, 'comment', 'comments')} held none; ${plural(input.unreadable.length, 'block', 'blocks')} could not be placed. ${plural(totals.scorecards, 'scorecard is', 'scorecards are')} in the window. ${plural(metrics.reviews.length, 'review block', 'review blocks')} read. Stories: ${metrics.storiesRead.given ? `${plural(metrics.storiesRead.count, 'story', 'stories')} given (${esc(metrics.storiesRead.shape)}); ${plural(metrics.notRecorded.foundBy, 'has', 'have')} no found-by label and ${metrics.notRecorded.foundBy === 1 ? 'is' : 'are'} left out of the scores.` : 'not given.'}</p>
<p>All figures computed by ${esc(metrics.generatedBy)}; none is added, counted or averaged by the model.</p></header>`);

  const notes = [];
  for (const d of metrics.duplicates) notes.push(`Duplicate: ${plural(d.created.length, 'scorecard', 'scorecards')} for the ${esc(d.run)} run of ${esc(d.date)} (posted ${d.created.map(esc).join(', ')}). Each is kept and counted in the totals; the per-report grid uses the newest.`);
  for (const u of input.unreadable) notes.push(`A scorecard block posted ${esc(u.created)} could not be placed and is in no figure: ${esc(u.reason)}.`);
  const allRuns = metrics.days.flatMap((day) => day.runs);
  for (const run of allRuns) for (const problem of run.problems) notes.push(`${esc(run.date)} ${esc(run.run)}: ${esc(problem)}.`);
  for (const r of metrics.reviews) {
    if (r.duplicate) notes.push(`Two or more review blocks for the week of ${esc(r.week)}: each is kept and counted.`);
    for (const problem of r.problems) notes.push(`Review of ${esc(r.date)}: ${esc(problem)}.`);
  }
  for (const p of metrics.storiesRead.problems) notes.push(`${esc(p.key)}: ${esc(p.problem)}.`);
  out.push(confidencePage(metrics));
  if (notes.length > 0) out.push(`<section class="warn"><h2>Read this first</h2><p class="sub">What in the log or the stories could not be taken as written.</p><ul>${notes.map((n) => `<li>${n}</li>`).join('')}</ul></section>`);
  out.push(reportCardPart(metrics));
  out.push(auditPart(metrics));
  out.push(exposurePart(metrics));

  out.push(`<div class="part page" style="border-color:var(--ink3)"><h2>Evidence: the week's runs</h2><p>The run log's scorecards for the window, as the runs posted them.</p></div>`);
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
<table><thead><tr><th>Date</th>${runTypes.map((run) => `<th>${esc(run)}</th>`).join('')}</tr></thead><tbody>
${metrics.days.map((day) => `<tr><td>${esc(day.date)}</td>${runTypes.map((run) => `<td>${statusCell(day, run)}</td>`).join('')}</tr>`).join('\n')}
</tbody></table>
<p><strong>No daily scorecard:</strong> ${metrics.missingDaily.length === 0 ? '<span>none in the window</span>' : metrics.missingDaily.map((date) => `<span>${esc(date)}</span>`).join(', ')}</p></section>`);

  out.push(stackedSection(metrics, 'Sources read by day', 'The four source counts of each scorecard in the window. Bars share one scale.', SOURCE_PARTS, 'sourcesListed'));

  const failing = metrics.streaks.filter((s) => s.count > 0);
  const longest = Math.max(1, ...failing.map((s) => s.count));
  out.push(`<section><h2>Sources failing in a row</h2><p class="sub">Runs in a row, ending at the newest run of that type, in which the source was "could not check" or "searched only". ${plural(metrics.streaks.length, 'source and run type', 'sources and run types')} tracked, from every scorecard read.</p>
${failing.length === 0 ? '<p class="muted">No source failed on its newest run.</p>' : `<table><thead><tr><th>Source</th><th>Run</th><th></th><th class="n">Runs in a row</th><th>Since</th><th>Newest result</th></tr></thead><tbody>
${failing.map((s) => `<tr><td>${esc(s.source)}</td><td>${esc(s.run)}</td><td><svg viewBox="0 0 128 16" width="128" height="16" role="img" aria-label="${num(s.count)} in a row"><rect class="f-critical" x="0" y="2" width="${((s.count / longest) * 120).toFixed(1)}" height="12" rx="2"/></svg></td><td class="n">${num(s.count)}</td><td>${esc(s.since)}</td><td>${esc(s.newestResult)} (${esc(s.newestDate)})</td></tr>`).join('\n')}
</tbody></table>`}</section>`);

  out.push(stackedSection(metrics, 'Events by verdict', 'The three verdict counts of each scorecard in the window. Bars share one scale.', VERDICT_PARTS, 'events'));

  out.push(`<section><h2>Stories created and caught by audit</h2><p class="sub">Jira writes each run reported. "Caught by audit" is given by the Friday audit only.</p>
${allRuns.length === 0 ? '<p class="muted">No scorecard in the window.</p>' : `<table><thead><tr><th>Date</th><th>Run</th><th class="n">Stories created</th><th class="n">Comments posted</th><th class="n">Caught by audit</th></tr></thead><tbody>
${allRuns.map((run) => `<tr><td>${esc(run.date)}</td><td>${esc(run.run)}</td><td class="n">${num(run.storiesCreated)}</td><td class="n">${num(run.commentsPosted)}</td><td class="n">${num(run.caughtByAudit)}</td></tr>`).join('\n')}
<tr><th>Window</th><th></th><th class="n">${sumCell(totals, 'storiesCreated')}</th><th class="n">${sumCell(totals, 'commentsPosted')}</th><th class="n">${sumCell(totals, 'caughtByAudit')}</th></tr>
</tbody></table>`}</section>`);

  const open = metrics.openStories;
  const oldest = Math.max(1, ...open.stories.map((s) => s.ageDays));
  out.push(`<section><h2>Open stories by age</h2><p class="sub">${open.given ? `${plural(open.count, 'open story', 'open stories')} in the list the run supplied, oldest first. Age in whole days since the story was created.` : 'Open stories: not given. No stories file was supplied to the script, so the count is unknown.'}</p>
${open.stories.length === 0 ? '' : `<table><thead><tr><th>Story</th><th>Status</th><th>Label</th><th></th><th class="n">Days open</th></tr></thead><tbody>
${open.stories.map((s) => `<tr><td>${esc(s.key)}</td><td>${esc(s.status)}</td><td>${esc(s.label)}</td><td><svg viewBox="0 0 168 16" width="168" height="16" role="img" aria-label="${num(s.ageDays)} days"><rect class="f-s1" x="0" y="2" width="${Math.max(2, (s.ageDays / oldest) * 160).toFixed(1)}" height="12" rx="2"/></svg></td><td class="n">${num(s.ageDays)}</td></tr>`).join('\n')}
</tbody></table>`}</section>`);

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
  const weekRows = [...shown.map((w) => [w.week, `${w.from} to ${w.to}`, w.totals]), ['Window', `${win.from} to ${win.to}`, totals]];
  // Two narrow tables in place of one wide one, so neither can be cut off in print.
  out.push(`<section><h2>Weekly totals over time</h2><p class="sub">One bar per ISO week (Monday to Sunday) before the week the window ends in, oldest first, then the window. The window can reach back into the newest week, so the two overlap. ${metrics.weeks.length > shown.length ? `The newest ${num(shown.length)} of ${num(metrics.weeks.length)} earlier weeks are shown; metrics.json has all of them.` : `${plural(metrics.weeks.length, 'earlier week', 'earlier weeks')} in the log.`} History starts with the first scorecard posted to the run log.</p>
<p class="legend"><span class="chip"><i class="sq b-s1"></i>an earlier ISO week</span><span class="chip"><i class="sq b-s2"></i>the window</span></p>
<div class="grid">${charts.map(([title, pick]) => `<div><h3>${esc(title)}</h3>${columnChart(columns.map((c) => ({ label: c.label, short: c.short, value: pick(c.totals), window: c.window })))}</div>`).join('')}</div>
<h3>Runs</h3><table><thead><tr><th>Week</th><th>Dates</th><th class="n">Scorecards</th><th class="n">Daily</th><th class="n">Digest</th><th class="n">Audit</th><th class="n">VALID</th><th class="n">FAILED</th></tr></thead><tbody>
${weekRows.map(([name, range, t]) => `<tr><td>${esc(name)}</td><td>${esc(range)}</td><td class="n">${num(t.scorecards)}</td><td class="n">${num(t.runs.daily)}</td><td class="n">${num(t.runs.digest)}</td><td class="n">${num(t.runs.audit)}</td><td class="n">${num(t.status.VALID)}</td><td class="n">${num(t.status.FAILED)}</td></tr>`).join('\n')}
</tbody></table>
<h3>Counts</h3><table><thead><tr><th>Week</th><th class="n">Events</th><th class="n">Applies</th><th class="n">Stories</th><th class="n">Caught by audit</th><th class="n">Could not check</th></tr></thead><tbody>
${weekRows.map(([name, , t]) => `<tr><td>${esc(name)}</td><td class="n">${sumCell(t, 'events')}</td><td class="n">${sumCell(t, 'applies')}</td><td class="n">${sumCell(t, 'storiesCreated')}</td><td class="n">${sumCell(t, 'caughtByAudit')}</td><td class="n">${sumCell(t, 'couldNotCheck')}</td></tr>`).join('\n')}
</tbody></table></section>`);

  out.push(`<section><h2>What this page cannot show</h2><ul>
<li>A run that posted no scorecard is seen only as a missing day; why it is missing is not known here.</li>
<li>The weekly app scan has no scorecard, so it is not in the run figures.</li>
<li>Time from a story to its verdict is not shown: it needs each story's history.</li>
<li>A quiet week means nothing found by these sources, not that nothing happened.</li>
<li>Scores cover the news watch only: the daily light check, the Friday audit and the digest. The app scan's stories are in part C only.</li>
<li>${esc("Stories logged before 2026-11-21 were labelled afterwards from their own text, by a chat session with the owner's OK. 14 early stories that were not news-watch findings (repo reviews, dry runs, a test example and a laptop-scan finding) have no found-by label and are left out.")}</li>
<li>Small counts swing scores, which is why counts are shown beside every score.</li>
<li>Past weeks are scored from the stories as they are today, not as they were that week.</li>
</ul></section>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Home agent: the week in review, ${esc(win.from)} to ${esc(win.to)}</title>
<style>${STYLE}</style></head>
<body><main>
${out.join('\n')}
</main></body></html>
`;
}

// ---- the command line ----

function parseArgs(args) {
  const usage = 'usage: --comments <comments.json> [--stories <stories.json>] [--required <required.json>] [--targets <targets.json>] [--audit-stories <keys.json>] --days <n> [--now <ISO time>] --out <folder>';
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!['--comments', '--stories', '--required', '--targets', '--audit-stories', '--days', '--now', '--out'].includes(name)) throw new Error(`unknown option "${name}"; ${usage}`);
    if (args[i + 1] === undefined) throw new Error(`${name} needs a value`);
    options[name.slice(2).replace('audit-stories', 'auditStories')] = args[i + 1];
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
  const required = options.required === undefined ? undefined : readJson(options.required, 'required sources');
  const targets = options.targets === undefined ? undefined : readJson(options.targets, 'targets');
  const auditStories = options.auditStories === undefined ? undefined : readJson(options.auditStories, 'audit stories');
  const metricsText = `${JSON.stringify(rollup({ comments, stories, days: options.days, now: options.now, required, targets, auditStories }), null, 2)}\n`;
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
