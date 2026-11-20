// Ranks the home agent's findings by the written rule, so the order is
// computed here and the model only explains it.
//
// The rule (order, cap, overflow, alerts, repeats, and the order and cap of
// the Tier 4 lines) is in agents/home-systems.md, "Ranking and caps"; what to
// post for a repeat is in its "Repeats and changes". This file implements them and does not restate
// them. If the two disagree, the spec wins: fix this file. The text format of
// the state line is set here (formatStateLine), as the spec says.
//
// Plain Node, no dependencies. No network calls. Reads nothing except the
// text it is given.

// Limits from agents/home-systems.md, "Ranking and caps".
export const STORY_CAP = 10;
export const TIER1_PUSH_LIMIT = 3;
// Tier 4 lines shown per report: "Unmatched events (Tier 4 lines)".
export const UNMATCHED_LINE_CAP = 8;

// Value scales, highest rank first. Anything not listed is an error, not a guess.
const SCALES = {
  // "unknown" is a value here, not a skipped comparison: it ranks after proof
  // of concept and before theory only (owner decision 2026-11-06).
  exploitation: ['exploited', 'proof of concept', 'unknown', 'theory only'],
  reachability: [['internet-facing', 'cannot be ruled out'], 'one machine I use'],
  blastRadius: ['broad', 'narrow'],
  fix: ['none', 'available'],
};

// Unknown or blank fix: agents/home-systems.md, "Ranking and caps", step 6.
const UNKNOWN_FIX_RANKS_AS = 'none';

// Attributes that may be missing; missing means "unknown".
const MAY_BE_UNKNOWN = new Set(['reachability', 'blastRadius']);

// The value as the scale spells it ("one machine I use"), matched in any case.
function canonical(attr, value) {
  const v = String(value).trim().toLowerCase();
  for (const s of SCALES[attr]) for (const x of (Array.isArray(s) ? s : [s])) if (x.toLowerCase() === v) return x;
  throw new Error(`Unrecognised ${attr} value: "${value}"`);
}

function scaleIndex(attr, value) {
  const scale = SCALES[attr];
  const v = String(value).trim().toLowerCase();
  const i = scale.findIndex((s) => (Array.isArray(s) ? s : [s]).some((x) => x.toLowerCase() === v));
  if (i === -1) throw new Error(`Unrecognised ${attr} value: "${value}"`);
  return i;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isUnknown(value) {
  return isBlank(value) || String(value).trim().toLowerCase() === 'unknown';
}

// Severity, as the source states it; most severe first. Optional on every
// finding: blank or missing means "unknown". It orders the Tier 4 lines only
// ("Unmatched events (Tier 4 lines)") and is not one of the rank steps.
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'];

function severityOf(f) {
  if (isBlank(f.severity)) return 'unknown';
  const v = String(f.severity).trim().toLowerCase();
  if (!SEVERITIES.includes(v)) throw new Error(`${f.id}: Unrecognised severity value: "${f.severity}"`);
  return v;
}

// Verdict: the agent's verdict for an event (news-watch step 3). Optional on
// every finding; when given it is one of these three values, in any case.
// The one-line reason is a separate field, verdictReason: free text, never
// checked and never compared.
const VERDICTS = ['applies', 'does not apply', 'cannot tell'];
const NO_SOURCE = 'source not given';

function verdictOf(f) {
  if (isBlank(f.verdict)) return undefined;
  const v = String(f.verdict).trim().toLowerCase();
  if (!VERDICTS.includes(v)) {
    throw new Error(`${f.id}: Unrecognised verdict value: "${f.verdict}" (give "applies", "does not apply" or "cannot tell"; the reason goes in verdictReason)`);
  }
  return v;
}

// The reasons a finding carries, each with the source of its entry. A merged
// finding already has the list (mergeSources); a finding with one entry has
// at most one reason.
function reasonsOf(f) {
  if (Array.isArray(f.verdictReasons)) return f.verdictReasons;
  if (isBlank(f.verdictReason)) return [];
  return [{ source: isBlank(f.source) ? NO_SOURCE : String(f.source).trim(), reason: f.verdictReason }];
}

// `verdict` and `verdictReasons` for an output entry, each only when given.
function verdictFields(f) {
  const verdict = verdictOf(f);
  const verdictReasons = reasonsOf(f);
  return { ...(verdict ? { verdict } : {}), ...(verdictReasons.length ? { verdictReasons } : {}) };
}

function fixIndex(f) {
  return scaleIndex('fix', isUnknown(f.fix) ? UNKNOWN_FIX_RANKS_AS : f.fix);
}

// "F2" before "F10": compare the number inside the ID when the prefixes match.
export function compareIds(a, b) {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

function validate(f) {
  if (!f.id) throw new Error('A finding has no ID');
  if (![1, 2, 3, 4].includes(f.tier)) throw new Error(`${f.id}: tier must be 1 to 4, got ${f.tier}`);
  // Exploitation must be given; "unknown" must be said, not left blank.
  if (isBlank(f.exploitation)) throw new Error(`${f.id}: exploitation is missing (give "unknown" if it cannot be established)`);
  const check = (attr) => {
    try { scaleIndex(attr, f[attr]); } catch (e) { throw new Error(`${f.id}: ${e.message}`); }
  };
  check('exploitation');
  if (!isUnknown(f.fix)) check('fix');
  for (const attr of MAY_BE_UNKNOWN) if (!isUnknown(f[attr])) check(attr);
  severityOf(f);
  verdictOf(f);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dateSeen ?? '')) throw new Error(`${f.id}: date seen must be YYYY-MM-DD`);
}

// State line: agents/home-systems.md, "Repeats and changes". Five facts in a
// fixed order. The format, for example:
//   State: tier=2; exploitation=proof of concept; reachability=internet-facing; blast radius=broad; fix=unknown
const STATE_FIELDS = [
  ['tier', 'tier'],
  ['exploitation', 'exploitation'],
  ['reachability', 'reachability'],
  ['blastRadius', 'blast radius'],
  ['fix', 'fix'],
];
const STATE_PREFIX = 'State:';
// Urgency is tier and exploitation; impact is the other three.
const URGENCY = new Set(['tier', 'exploitation']);

// One fact as a state line writes it. Blank means "unknown", except
// exploitation, which must be given.
function stateValue(attr, value) {
  if (attr === 'tier') {
    const t = Number(value);
    if (![1, 2, 3, 4].includes(t)) throw new Error(`tier must be 1 to 4, got "${value}"`);
    return t;
  }
  if (attr === 'exploitation' && isBlank(value)) throw new Error('exploitation is empty (give "unknown" if it cannot be established)');
  if (attr !== 'exploitation' && isUnknown(value)) return 'unknown';
  return canonical(attr, value);
}

function stateOf(facts) {
  return Object.fromEntries(STATE_FIELDS.map(([attr]) => [attr, stateValue(attr, facts[attr])]));
}

// The state line for a finding's facts, as one line of plain text.
export function formatStateLine(finding) {
  const s = stateOf(finding);
  return `${STATE_PREFIX} ${STATE_FIELDS.map(([attr, name]) => `${name}=${s[attr]}`).join('; ')}`;
}

// Reads the state line from a description, a comment or the line alone. The
// state line is the last line anywhere in the text that begins exactly
// "State:"; any text after it (an owner's note, say) is ignored. Returns null
// if no line begins "State:" (or the text is "none"). Throws, naming the
// problem, if that line is malformed, or if there is no such line but one
// starts "state:" in another case or spacing.
export function parseStateLine(text) {
  if (isBlank(text)) return null;
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const fail = (message) => { throw new Error(`State line: ${message}`); };
  const last = lines.findLast((l) => l.startsWith(STATE_PREFIX));
  if (last === undefined) {
    const wrongCase = lines.findLast((l) => /^state\s*:/i.test(l));
    if (wrongCase) fail(`must start with exactly "${STATE_PREFIX}", got "${wrongCase}"`);
    return null;
  }
  const parts = last.slice(STATE_PREFIX.length).split(';').map((p) => p.trim());
  if (parts.length !== STATE_FIELDS.length) {
    fail(`expected ${STATE_FIELDS.length} fields (${STATE_FIELDS.map(([, n]) => n).join(', ')}), got ${parts.length}: "${last}"`);
  }
  const state = {};
  STATE_FIELDS.forEach(([attr, name], i) => {
    const eq = parts[i].indexOf('=');
    if (eq === -1) fail(`field ${i + 1} should be "${name}=<value>", got "${parts[i]}"`);
    const field = parts[i].slice(0, eq).trim();
    if (field !== name) fail(`field ${i + 1} should be "${name}", got "${field}"`);
    let value;
    try { value = stateValue(attr, parts[i].slice(eq + 1)); } catch (e) { fail(e.message); }
    state[attr] = value;
  });
  return state;
}

// What changed between the latest state line and this run's facts.
function compareStates(prior, now) {
  const changes = STATE_FIELDS
    .filter(([attr]) => prior[attr] !== now[attr])
    .map(([attr, name]) => ({ attribute: name, from: prior[attr], to: now[attr] }));
  return {
    changes,
    urgencyChanged: changes.some((c) => URGENCY.has(c.attribute)),
    // Tier 1 is above Tier 2; exploitation uses the scale above, where unknown
    // is above theory only.
    urgencyRose: now.tier < prior.tier || scaleIndex('exploitation', now.exploitation) < scaleIndex('exploitation', prior.exploitation),
    impactChanged: changes.some((c) => !URGENCY.has(c.attribute)),
  };
}

// The story key of an existingStories entry in either form, or undefined.
function entryKey(entry) {
  if (typeof entry === 'string') return entry;
  return entry && typeof entry === 'object' ? entry.key : undefined;
}

// A carried item reopened from a closed story is not a repeat of that story:
// it has no story of its own yet, so it stays in the ranking (handoff
// 2026-11-07-review-fixes, A1; "Nothing is dropped silently").
function isReopenedFromStory(f, entry) {
  return !!(f.carried && f.reopenedFrom && entryKey(entry) === f.reopenedFrom);
}

// One existingStories entry. A string is a story key (the original form). An
// object is { key, closed, seenAgainPosted, priorState }. priorState is
// required: the text holding the latest state line, already parsed, or the
// literal "none" when the story has no state line. A missing or null
// priorState, or one of another type, is an error (a procedure mistake). Text
// with no line beginning "State:" in any case, and blank text, mean no state
// recorded, the same as "none" (an owner-logged story, or one created before
// state lines). A malformed "State:" line, or one in the wrong case, is not an
// error either: the entry comes back with `unreadable` set to the reason, so
// one bad story does not stop the run. Returns null when the finding has no
// story.
function storyEntry(id, entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { key: entry, keyOnly: true };
  const where = `${id}: existingStories entry`;
  if (typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be a story key or { key, closed, seenAgainPosted, priorState }`);
  if (typeof entry.key !== 'string' || entry.key.trim() === '') throw new Error(`${where} has no story key`);
  for (const k of ['closed', 'seenAgainPosted']) if (typeof entry[k] !== 'boolean') throw new Error(`${where}: ${k} must be true or false`);
  if (entry.priorState === undefined || entry.priorState === null) throw new Error(`${where}: priorState is missing (give the latest state line, or "none" if the story has none)`);
  const story = { key: entry.key, closed: entry.closed, seenAgainPosted: entry.seenAgainPosted };
  let priorState = null;
  if (typeof entry.priorState === 'string') {
    if (entry.priorState.trim() !== 'none') {
      try { priorState = parseStateLine(entry.priorState); } catch (e) { return { ...story, unreadable: e.message }; }
    }
  } else if (entry.priorState && typeof entry.priorState === 'object' && !Array.isArray(entry.priorState)) {
    try { priorState = stateOf(entry.priorState); } catch (e) { throw new Error(`${id}: prior state: ${e.message}`); }
  } else {
    throw new Error(`${where}: priorState must be the latest state line as text, a parsed state, or "none"`);
  }
  return { ...story, priorState };
}

// Said on every repeat whose story has no state recorded.
const STATE_NOT_RECORDED = 'state not recorded: urgency change cannot be judged';

// The action for a repeat with a story object ("Repeats and changes", "What
// to post"). With no prior state line, no change is claimed, and the repeat
// says so (`stateRecorded` false and `note`). A closed story
// whose urgency rose also gets a new story, ranked like any other; that needs
// Tier 1 or 2, because Tier 3 is never a story.
function repeatDecision(f, story) {
  const now = stateOf(f);
  const cmp = story.priorState
    ? compareStates(story.priorState, now)
    : { changes: [], urgencyChanged: false, urgencyRose: false, impactChanged: false };
  const reopen = story.closed && cmp.urgencyRose && (now.tier === 1 || now.tier === 2);
  let action;
  // Where the reopened item lands (a story, or the overflow story past the
  // cap) is in `stories` and `overflow`, not in this text.
  if (reopen) action = 'Seen again, changed comment; reopened item ranked';
  else if (cmp.changes.length) action = 'Seen again, changed comment';
  else if (story.closed) action = 'No comment';
  else if (story.priorState && story.seenAgainPosted) action = 'No comment';
  else action = 'Seen again comment';
  const recorded = story.priorState ? { stateRecorded: true } : { stateRecorded: false, note: STATE_NOT_RECORDED };
  return { reopen, repeat: { id: f.id, story: story.key, closed: story.closed, action, ...cmp, ...recorded, stateLine: formatStateLine(f) } };
}

// The comparisons, in the spec's order. Each returns <0 when a ranks above b.
function comparisons(skip) {
  const steps = [
    ['tier', (a, b) => a.tier - b.tier],
    ['carried over', (a, b) => Number(!!b.carried) - Number(!!a.carried)],
    ['exploitation', (a, b) => scaleIndex('exploitation', a.exploitation) - scaleIndex('exploitation', b.exploitation)],
    ['reachability', (a, b) => scaleIndex('reachability', a.reachability) - scaleIndex('reachability', b.reachability)],
    ['blast radius', (a, b) => scaleIndex('blastRadius', a.blastRadius) - scaleIndex('blastRadius', b.blastRadius)],
    ['fix', (a, b) => fixIndex(a) - fixIndex(b)],
    ['newest first', (a, b) => (a.dateSeen < b.dateSeen ? 1 : a.dateSeen > b.dateSeen ? -1 : 0)],
    ['finding ID', (a, b) => compareIds(a.id, b.id)],
  ];
  return steps.filter(([name]) => !skip.has(name));
}

function describe(name, f) {
  switch (name) {
    case 'tier': return `Tier ${f.tier}`;
    case 'carried over': return f.carried ? 'carried over' : 'new';
    case 'exploitation': return isUnknown(f.exploitation) ? 'exploitation unknown' : f.exploitation;
    case 'reachability': return f.reachability;
    case 'blast radius': return f.blastRadius;
    case 'fix': return isUnknown(f.fix) ? 'fix unknown (ranked as no fix)' : fixIndex(f) === 0 ? 'no fix' : 'fix available';
    case 'newest first': return f.dateSeen;
    case 'finding ID': return f.id;
    default: return '';
  }
}

// Moves repeats out before ranking. `existingStories` maps finding ID to the
// story that already exists for it: its key alone, or a story object (see
// storyEntry). A key alone gives a "Seen again" comment, as before. A story
// object gives the action from "Repeats and changes", what changed, and the
// new state line. Repeats use no story slot, except a closed story whose
// urgency rose: that finding also stays in the ranking with `reopenedFrom`.
// A carried item whose story entry is the story it was reopened from is not
// a repeat (see isReopenedFromStory): it is ranked. A finding whose story
// text cannot be read is neither ranked nor a repeat: it goes to
// `unreadable` with its story key and the reason.
export function separateRepeats(findings, existingStories = {}) {
  const repeats = [];
  const fresh = [];
  const unreadable = [];
  for (const f of findings) {
    const story = storyEntry(f.id, existingStories[f.id]);
    if (!story || isReopenedFromStory(f, existingStories[f.id])) { fresh.push(f); continue; }
    if (story.keyOnly) { repeats.push({ id: f.id, story: story.key, action: 'Seen again comment' }); continue; }
    validate(f);
    if (story.unreadable) { unreadable.push({ id: f.id, story: story.key, reason: story.unreadable }); continue; }
    const { reopen, repeat } = repeatDecision(f, story);
    repeats.push(repeat);
    if (reopen) fresh.push({ ...f, reopenedFrom: story.key });
  }
  return { repeats, fresh, unreadable };
}

// Turns a previous run's overflow list into carried findings for the next run.
export function carryOver(overflow) {
  return overflow.map(({ finding }) => ({ ...finding, carried: true, runsCarried: (finding.runsCarried ?? 0) + 1 }));
}

// One finding per ID: agents/home-systems.md, "Ranking and caps", "One
// finding per ID". New findings that share an ID (one per source that
// reported it) are merged into one before ranking. Per fact: a known value
// beats "unknown"; of two known values the more urgent wins for tier,
// exploitation, reachability and blast radius; for fix the value from an
// entry with fixSource "vendor" wins, else the more cautious ("none"). Date
// seen is the earliest. "internet-facing" and "cannot be ruled out" rank the
// same; when both are given, "internet-facing" is kept, the first in the
// scale. A finding with one entry is returned unchanged. Severity and
// verdict are kept only when an entry gives one: the most severe known
// severity is used; entries that give different verdict values are a
// procedure mistake and stop the input. Differently worded reasons are not a
// mistake (two events waiting on one inventory row, or two sources describing
// one event): the merged finding carries every distinct verdictReason in
// `verdictReasons`, each with the source of its entry, in the order of the
// sources.
// Returns { findings, merged }: `merged` lists each merged ID with its
// sources and the facts that disagreed, sorted by ID.
const MERGE_FACTS = STATE_FIELDS;

function mergeValue(attr, entries) {
  const by = entries.map((e) => ({
    source: e.source,
    vendor: e.vendor,
    value: attr === 'tier' ? e.f.tier : (isUnknown(e.f[attr]) ? 'unknown' : canonical(attr, e.f[attr])),
  }));
  const distinct = [...new Set(by.map((b) => b.value))];
  const known = by.filter((b) => b.value !== 'unknown');
  let used;
  let rule;
  if (!known.length) { used = 'unknown'; rule = null; }
  else {
    const knownValues = [...new Set(known.map((b) => b.value))];
    if (knownValues.length === 1) { used = knownValues[0]; rule = 'known beats unknown'; }
    else if (attr === 'tier') { used = Math.min(...knownValues); rule = 'more urgent'; }
    else if (attr === 'fix') {
      const vendor = [...new Set(known.filter((b) => b.vendor).map((b) => b.value))];
      const pool = vendor.length ? vendor : knownValues;
      used = pool.reduce((a, b) => (scaleIndex('fix', b) < scaleIndex('fix', a) ? b : a));
      rule = vendor.length === 1 ? 'vendor' : 'more cautious';
    } else {
      // Most urgent; on equal rank, the value first in the scale.
      const flat = SCALES[attr].flat();
      used = knownValues.reduce((a, b) => {
        const d = scaleIndex(attr, b) - scaleIndex(attr, a);
        return d < 0 || (d === 0 && flat.indexOf(b) < flat.indexOf(a)) ? b : a;
      });
      rule = 'more urgent';
    }
  }
  const disagreed = distinct.length > 1 ? { values: by.map(({ source, value }) => ({ source, value })), used, rule } : null;
  return { used, disagreed };
}

// fixSource "vendor" in any case ("Vendor", "VENDOR"), like the other values.
function isVendor(f) {
  return !isBlank(f.fixSource) && String(f.fixSource).trim().toLowerCase() === 'vendor';
}

export function mergeSources(findings = []) {
  const groups = new Map();
  for (const f of findings) {
    if (!f || !f.id) throw new Error('A finding has no ID');
    if (!groups.has(f.id)) groups.set(f.id, []);
    groups.get(f.id).push(f);
  }
  const out = [];
  const merged = [];
  for (const [id, list] of groups) {
    if (list.length === 1) { out.push(list[0]); continue; }
    for (const f of list) {
      validate(f);
      if (!isBlank(f.fixSource) && !isVendor(f)) throw new Error(`${id}: fixSource must be "vendor" or left out, got "${f.fixSource}"`);
      if (f.carried) throw new Error(`${id}: a new finding must not be marked carried`);
    }
    // Sorted by source, so the result does not depend on the input order.
    const entries = list
      .map((f) => ({ f, source: isBlank(f.source) ? NO_SOURCE : String(f.source).trim(), vendor: isVendor(f) }))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || (a.f.dateSeen < b.f.dateSeen ? -1 : a.f.dateSeen > b.f.dateSeen ? 1 : 0));
    const finding = { id };
    const disagreed = [];
    for (const [attr, name] of MERGE_FACTS) {
      const { used, disagreed: d } = mergeValue(attr, entries);
      finding[attr] = used;
      if (d) disagreed.push({ attribute: name, ...d });
    }
    finding.dateSeen = entries.map((e) => e.f.dateSeen).sort()[0];
    if (list.some((f) => !isBlank(f.severity))) {
      finding.severity = SEVERITIES[Math.min(...list.map((f) => SEVERITIES.indexOf(severityOf(f))))];
    }
    const verdicts = [...new Set(entries.map((e) => verdictOf(e.f)).filter(Boolean))];
    if (verdicts.length > 1) throw new Error(`${id}: the entries for one finding give different verdicts (${verdicts.map((v) => `"${v}"`).join(', ')})`);
    if (verdicts.length) finding.verdict = verdicts[0];
    const reasons = [];
    for (const e of entries) {
      if (!isBlank(e.f.verdictReason) && !reasons.some((r) => r.reason === e.f.verdictReason)) reasons.push({ source: e.source, reason: e.f.verdictReason });
    }
    if (reasons.length) finding.verdictReasons = reasons;
    finding.sources = [...new Set(entries.map((e) => e.source))];
    out.push(finding);
    merged.push({ id, sources: finding.sources, disagreed });
  }
  merged.sort((a, b) => compareIds(a.id, b.id));
  return { findings: out, merged };
}

// Throws if two items in one list share an ID.
function checkUnique(list, what) {
  const seen = new Set();
  for (const f of list) {
    if (seen.has(f.id)) throw new Error(`Duplicate ${what} finding ID ${f.id}`);
    seen.add(f.id);
  }
  return seen;
}

// Ranks one run. `findings` are the new matches, one entry per source (see
// mergeSources, which runs first); `carried` are items from open overflow
// stories (see carryOver), where a duplicate ID is still an error.
// `existingStories` is used by separateRepeats.
// A new finding with the ID of a carried item is merged into it: the new
// copy's facts replace the carried facts, and the item keeps its carried flag
// and run count (agents/home-systems.md, "Past the cap"). Its ID is listed in
// `carriedSeenAgain`, unless it is moved out as a repeat: then it is listed in
// `repeats` only, so one story gets one "seen again" note. A carried item
// reopened from a closed story keeps `reopenedFrom` when merged. Every ranked
// entry has `stateLine`. A finding whose story text cannot be read is listed
// in `unreadable` and is neither ranked nor a repeat (see separateRepeats).
// The Tier 4 findings are never ranked: their IDs are in `ignored`, as
// before, and `unmatchedLines` gives them as report lines, in the order and
// with the cap of "Unmatched events (Tier 4 lines)".
export function rankRun({ findings: given = [], carried = [], existingStories = {}, cap = STORY_CAP } = {}) {
  const { findings, merged } = mergeSources(given);
  checkUnique(carried, 'carried');
  const newById = new Map(findings.map((f) => [f.id, f]));
  const carriedById = new Map(carried.map((c) => [c.id, c]));
  // Same test as separateRepeats: a carried item is a repeat only if its story
  // entry is not the story it was reopened from.
  const carriedSeenAgain = findings
    .filter((f) => carriedById.has(f.id) && (!existingStories[f.id] || isReopenedFromStory(carriedById.get(f.id), existingStories[f.id])))
    .map((f) => f.id)
    .sort(compareIds);
  const mergedCarried = carried.map((c) => {
    const again = newById.get(c.id);
    if (!again) return c;
    const reopened = c.reopenedFrom ? { reopenedFrom: c.reopenedFrom } : {};
    return { ...again, carried: true, runsCarried: c.runsCarried, ...reopened };
  });
  const newOnly = findings.filter((f) => !carriedById.has(f.id));

  const { repeats, fresh, unreadable } = separateRepeats([...mergedCarried, ...newOnly], existingStories);
  repeats.sort((a, b) => compareIds(a.id, b.id));
  unreadable.sort((a, b) => compareIds(a.id, b.id));
  for (const f of fresh) validate(f);

  const ignored = fresh.filter((f) => f.tier === 4).map((f) => f.id).sort(compareIds);
  const pool = fresh.filter((f) => f.tier !== 4);

  // Tier 4 lines: exploitation (the rank step's order), then severity, then
  // newest first, then finding ID. Each line carries its verdict and reasons.
  const unmatched = fresh
    .filter((f) => f.tier === 4)
    .map((f) => ({ f, exploitation: scaleIndex('exploitation', f.exploitation), severity: SEVERITIES.indexOf(severityOf(f)) }))
    .sort((a, b) => a.exploitation - b.exploitation
      || a.severity - b.severity
      || (a.f.dateSeen < b.f.dateSeen ? 1 : a.f.dateSeen > b.f.dateSeen ? -1 : 0)
      || compareIds(a.f.id, b.f.id))
    .map(({ f }) => ({
      id: f.id,
      exploitation: canonical('exploitation', f.exploitation),
      severity: severityOf(f),
      dateSeen: f.dateSeen,
      ...verdictFields(f),
    }));

  // Unknown for any finding means that comparison is skipped for the whole
  // run. Skipping it only for some pairs could make the order depend on the
  // input order.
  const skip = new Set();
  const unknown = {};
  for (const [attr, name] of [['reachability', 'reachability'], ['blastRadius', 'blast radius']]) {
    const missing = pool.filter((f) => isUnknown(f[attr])).map((f) => f.id).sort(compareIds);
    if (missing.length) { skip.add(name); unknown[name] = missing; }
  }
  // An unknown fix is not skipped: it is ranked as "none" and only listed here.
  const fixUnknown = pool.filter((f) => isUnknown(f.fix)).map((f) => f.id).sort(compareIds);
  if (fixUnknown.length) unknown.fix = fixUnknown;

  const steps = comparisons(skip);
  const sorted = [...pool].sort((a, b) => {
    for (const [, cmp] of steps) { const c = cmp(a, b); if (c !== 0) return c; }
    return 0;
  });

  const N = sorted.length;
  const ranked = sorted.map((f, i) => {
    const below = sorted[i + 1];
    let aheadBecause = null;
    if (below) {
      for (const [name, cmp] of steps) {
        if (cmp(f, below) !== 0) {
          aheadBecause = { attribute: name, this: describe(name, f), next: describe(name, below), next_id: below.id };
          break;
        }
      }
    }
    const reopened = f.reopenedFrom ? { reopenedFrom: f.reopenedFrom } : {};
    // The state line ends every story's description and every overflow entry
    // (agents/home-systems.md, "Repeats and changes"), so it is set here.
    return { id: f.id, tier: f.tier, carried: !!f.carried, ...reopened, rank: i + 1, of: N, rankLine: `Rank this run: ${i + 1} of ${N}`, aheadBecause, stateLine: formatStateLine(f), ...verdictFields(f), finding: f };
  });

  const storyEligible = ranked.filter((r) => r.tier === 1 || r.tier === 2);
  const stories = storyEligible.slice(0, cap);
  const overflow = storyEligible.slice(cap);
  const tier3 = ranked.filter((r) => r.tier === 3);
  const tier1 = ranked.filter((r) => r.tier === 1).map((r) => r.id);

  return {
    order: ranked.map((r) => r.id),
    ranked,
    stories: stories.map((r) => r.id),
    overflowStory: overflow.length ? { items: overflow.map((r) => r.id) } : null,
    overflow,
    carriedNowLogged: stories.filter((r) => r.carried).map((r) => r.id),
    digest: {
      tier3Rows: tier3.map((r) => r.id),
      overflowCount: overflow.length,
      carried: {
        // Items carried into this run, and those still waiting after it.
        count: carried.length,
        oldestRuns: carried.reduce((m, f) => Math.max(m, f.runsCarried ?? 1), 0),
        stillWaiting: overflow.filter((r) => r.carried).length,
      },
    },
    alert: {
      tier1,
      grouped: tier1.length > TIER1_PUSH_LIMIT,
    },
    repeats,
    carriedSeenAgain,
    ignored,
    unmatchedLines: {
      shown: unmatched.slice(0, UNMATCHED_LINE_CAP),
      alsoSeen: unmatched.slice(UNMATCHED_LINE_CAP),
      total: unmatched.length,
    },
    unknown,
    unreadable,
    merged,
  };
}

// Reads every "## Run X: ..." section of a markdown file and the findings
// table under it, if any. Returns { X: { title, text, findings,
// existingStories } }. The story columns (Story, Closed, Seen again posted,
// Prior state) go to existingStories as story objects, not onto the finding.
const STORY_COLUMNS = new Set(['story', 'closed', 'seenAgainPosted', 'priorState']);
const COLUMNS = {
  'story': 'story',
  'closed': 'closed',
  'seen again posted': 'seenAgainPosted',
  'prior state': 'priorState',
  'id': 'id',
  'source': 'source',
  'fix source': 'fixSource',
  'severity': 'severity',
  'verdict': 'verdict',
  'verdict reason': 'verdictReason',
  'tier': 'tier',
  'exploitation': 'exploitation',
  'reachability': 'reachability',
  'blast radius': 'blastRadius',
  'fix': 'fix',
  'date seen': 'dateSeen',
};

export function parseRuns(markdown) {
  const runs = {};
  const sections = markdown.split(/^## /m).slice(1);
  for (const section of sections) {
    const m = /^Run ([A-Z]):\s*(.*)$/m.exec(section.split('\n')[0]);
    if (!m) continue;
    const [, key, title] = m;
    const lines = section.split('\n');
    const tableLines = lines.filter((l) => l.trim().startsWith('|'));
    let findings = [];
    const existingStories = {};
    if (tableLines.length >= 2) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cells(tableLines[0]).map((h) => {
        const k = COLUMNS[h.toLowerCase()];
        if (!k) throw new Error(`Run ${key}: unknown column "${h}"`);
        return k;
      });
      findings = tableLines.slice(2).map((l) => {
        const row = cells(l);
        const f = {};
        const s = {};
        header.forEach((k, i) => {
          // A blank source, fix source, severity, verdict or verdict reason
          // cell means the field is left out.
          if (['source', 'fixSource', 'severity', 'verdict', 'verdictReason'].includes(k) && row[i] === '') return;
          (STORY_COLUMNS.has(k) ? s : f)[k] = row[i];
        });
        f.tier = Number(f.tier);
        if (s.story) {
          const yesNo = (k, label) => {
            const v = String(s[k] ?? '').trim().toLowerCase();
            if (v !== 'yes' && v !== 'no') throw new Error(`Run ${key}, ${f.id}: ${label} must be yes or no, got "${s[k] ?? ''}"`);
            return v === 'yes';
          };
          existingStories[f.id] = {
            key: s.story,
            closed: yesNo('closed', 'Closed'),
            seenAgainPosted: yesNo('seenAgainPosted', 'Seen again posted'),
            priorState: s.priorState ?? 'none',
          };
        }
        return f;
      });
    }
    runs[key] = { title, text: lines.slice(1).join('\n').trim(), findings, existingStories };
  }
  return runs;
}
