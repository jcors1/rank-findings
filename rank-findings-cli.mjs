#!/usr/bin/env node
// Runs the ranker on one run's facts and prints the result as JSON.
// The rules are in agents/home-systems.md, "Ranking and caps" and "Repeats
// and changes"; the code is tools/rank-findings.mjs. This file only reads
// input and prints output.
//
// Usage:
//   node tools/rank-findings-cli.mjs facts.json
//   node tools/rank-findings-cli.mjs < facts.json     (or "-" for stdin)
// The live agent always writes the facts to a file and passes its path
// (news-watch step 7). Stdin stays for manual use: piped from another
// process, the read can fail with EAGAIN.
//
// Input: one JSON object, the same shape rankRun takes:
//   {
//     "findings": [ { "id", "tier", "exploitation", "reachability",
//                     "blastRadius", "fix", "dateSeen", "source",
//                     "fixSource": "vendor" (only on the vendor's own page),
//                     "severity" (optional), "verdict" (optional),
//                     "verdictReason" (optional) } ],
//     "carried": [ { the same fields, plus "carried": true,
//                    "reopenedFrom": "KAN-n" (only for an item reopened from
//                    a closed story), "runsCarried": n (optional) } ],
//     "existingStories": { "<finding id>": <a story key, or a story object> }
//   }
// One entry per source: the same finding ID from several sources is merged
// into one finding before ranking (mergeSources; agents/home-systems.md,
// "Ranking and caps", "One finding per ID"). "source" names where each entry
// came from. A duplicate ID within "carried" is still an error.
// "severity" is the severity as the source states it: critical, high,
// medium, low or unknown, in any case. Left out or blank means unknown. Any
// other value is an error naming the finding ID.
// "verdict" is the agent's verdict for the event (news-watch step 3): one of
// exactly "applies", "does not apply" or "cannot tell", in any case. Any other
// value is an error naming the finding ID, so the reason never goes in this
// field. "verdictReason" is the one-line reason, as free text: it is passed
// through untouched and never checked or compared.
// Severity, verdict and verdictReason are needed on Tier 4 entries
// (news-watch step 4) and allowed on any entry; none of them changes the
// ranking of Tiers 1 to 3. When one ID has several entries: the most severe
// known severity is used; entries that give different verdict values are an
// error naming the ID; entries whose reasons differ are not an error, and the
// one finding carries every distinct reason.
// A carried item is built from its entry on an open overflow story
// (news-watch step 5): the facts from its state line, its date seen, and
// "reopened from KAN-n" when the entry has it. Without reopenedFrom, an item
// reopened from a closed story is treated as a repeat of that story and can
// be dropped. runsCarried is not used for the digest: the digest counts how
// long an item has waited in whole days from its overflow story's creation
// date (agents/home-systems.md, "Past the cap"). The live agent leaves
// runsCarried out, and the item then counts as one run here.
// The live agent must give a story object, for a match or carried item whose
// story was read (news-watch step 6):
//   { "key": "KAN-n", "closed": true or false,
//     "seenAgainPosted": true or false,
//     "priorState": "<the latest state line, as written>" or "none" }
// seenAgainPosted is true when the story has a "Seen again" comment or a
// "Seen again, changed" comment: the second counts as the first
// (agents/home-systems.md, "Repeats and changes"). priorState is required.
// It is the text of the comment or description that holds the latest state
// line, or "none" only when the story has no state line. The state line read
// is the last line that begins exactly "State:"; text after it is ignored.
// A missing or null priorState is an error. Text with no line beginning
// "State:" in any case, or blank text, means no state recorded, like "none":
// the repeat has "stateRecorded": false and a "note". A malformed "State:"
// line, or one starting "state:" in another case, is not an error: that
// finding is not ranked, gets no comment, and is listed in "unreadable" with
// its story key and the reason.
// A story key alone ("KAN-n") still works as before, but it gives a plain
// "Seen again" comment on every sighting, so the CLI warns on stderr.
// All three top-level keys are optional. Allowed values are the ones
// rank-findings.mjs accepts. The cap is not an input: it comes from the spec.
//
// Output: rankRun's result as JSON on stdout, exit 0. Every entry in "ranked"
// (so every story and every overflow entry) has "stateLine", the state line
// to end its description or overflow entry with. If any existingStories
// value is a story key alone, one warning line goes to stderr; stdout and the
// exit code are unchanged. For each item in "unreadable", one line goes to
// stderr; stdout and the exit code are unchanged. For a story object,
// each entry in "repeats" has "action", "changes", "urgencyChanged",
// "urgencyRose", "impactChanged", "stateRecorded" (plus "note" when false)
// and the new "stateLine" to end the comment with; a closed story whose
// urgency rose is also ranked, with "reopenedFrom", and its action reads
// "Seen again, changed comment; reopened item ranked" ("stories" and
// "overflow" say where it landed). "merged" lists each ID merged from several
// sources, with its "sources" and the facts that "disagreed" (each with the
// value per source, the value "used" and the "rule" that chose it).
// "unmatchedLines" holds the Tier 4 findings as report lines
// (agents/home-systems.md, "Ranking and caps", "Unmatched events (Tier 4
// lines)"): { "shown": [...], "alsoSeen": [...], "total": n }. Each line is
// { "id", "exploitation", "severity", "dateSeen", "verdict" (only when
// given), "verdictReasons" (only when a reason was given) }, already in
// report order; "shown" holds the lines up to the cap, "alsoSeen" the rest,
// and "total" counts both. "ignored" still lists the same Tier 4 IDs, sorted
// by ID, as before.
// "verdictReasons" is a list of { "source", "reason" }: every distinct
// verdictReason given for that finding, each with the "source" of its entry
// ("source not given" when the entry had none), in the order of the sources.
// Every entry in "ranked" carries "verdict" and "verdictReasons" the same
// way, when given: an inventory-gap finding raised by two events has both
// reasons there.
// On any error: one line on stderr, nothing on stdout, exit 1. An error in a
// finding or its story entry names the finding ID.
//
// Plain Node, no dependencies, no network calls.

import { readFileSync } from 'node:fs';
import { rankRun, compareIds } from './rank-findings.mjs';

const ALLOWED_KEYS = new Set(['findings', 'carried', 'existingStories']);

function fail(message) {
  process.stderr.write(`rank-findings-cli: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length > 1) fail('give one file path, "-" or nothing (stdin)');
const source = args[0] ?? '-';
if (source === '-' && process.stdin.isTTY) fail('no input: give a file path or pipe the facts on stdin');

let facts;
try {
  const text = readFileSync(source === '-' ? 0 : source, 'utf8');
  facts = JSON.parse(text);
} catch (e) {
  fail(`could not read the facts from ${source === '-' ? 'stdin' : source}: ${e.message}`);
}

if (!facts || typeof facts !== 'object' || Array.isArray(facts)) fail('the facts must be one JSON object');
for (const key of Object.keys(facts)) if (!ALLOWED_KEYS.has(key)) fail(`unknown key "${key}"`);
for (const key of ['findings', 'carried']) if (key in facts && !Array.isArray(facts[key])) fail(`"${key}" must be a list`);
if ('existingStories' in facts && (typeof facts.existingStories !== 'object' || Array.isArray(facts.existingStories) || facts.existingStories === null)) {
  fail('"existingStories" must be an object');
}

let result;
try {
  result = rankRun(facts);
} catch (e) {
  fail(e.message);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// One line per finding whose story text could not be read.
for (const u of result.unreadable) {
  process.stderr.write(`rank-findings-cli: unreadable: ${u.id} (${u.story}): ${u.reason}; not ranked, no comment\n`);
}

// A story key alone is accepted, but the live agent must not rely on it.
const keyOnly = Object.entries(facts.existingStories ?? {}).filter(([, v]) => typeof v === 'string').map(([id]) => id).sort(compareIds);
if (keyOnly.length) {
  process.stderr.write(`rank-findings-cli: warning: existingStories for ${keyOnly.join(', ')} is a story key alone; the live agent must supply the story object { key, closed, seenAgainPosted, priorState }, because a key alone posts "Seen again" on every sighting\n`);
}
