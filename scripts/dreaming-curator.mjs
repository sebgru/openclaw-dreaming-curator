import fs from 'fs';
import path from 'path';
import { assessCandidate, cleanText, proposalFor } from './dreaming-quality.mjs';

const ROOT = process.cwd();
const MEMORY_DIR = path.join(ROOT, 'memory');
const OUT_DIR = path.join(MEMORY_DIR, 'dreaming', 'digests');
// Canonical machine-readable review queue. Delivery must read this JSON only;
// the Markdown digest remains advisory/report-only presentation.
const REVIEW_DIR = path.join(MEMORY_DIR, 'review-candidates');
const INDEX_REL = path.join('outputs', 'INDEX.md');
const WINDOW_DAYS = 7;

const args = process.argv.slice(2);
const day =
  args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || new Date().toISOString().slice(0, 10);
const weekly = args.includes('--weekly') || new Date(day + 'T00:00:00Z').getUTCDay() === 1;
const candidateThreshold = 0.72;

const CATEGORY_RULES = [
  [
    'stable-preference',
    /\b(prefer|preference|likes?|dislikes?|always|never|default to|wants?|expects?)\b/i,
  ],
  [
    'lesson-or-failure',
    /\b(mistake|failed|failure|lesson learned|root cause|should not|do not repeat|missed|bug|fix)\b/i,
  ],
  [
    'active-project',
    /\b(todo|next|pending|carry.?over|project|plan|check|follow.?up|remind|blocked)\b/i,
  ],
  [
    'family-travel-health',
    /\b(family|kids?|vacation|holiday|travel|health|diagnosis|allergy|medication)\b/i,
  ],
  [
    'infrastructure-decision',
    /\b(gpu|ollama|mineru|secretref|backup|docker|gateway|cron|model|openrouter|openai|deepseek|qwen|config)\b/i,
  ],
  [
    'durable-fact',
    /\b(completed|done|decided|configured|enabled|disabled|installed|verified|confirmed|constraint)\b/i,
  ],
];

function daysBetween(a, b) {
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function windowDates(endDay, length) {
  const out = [];
  for (let i = length - 1; i >= 0; i -= 1) out.push(addDays(endDay, -i));
  return out;
}

function categoriesFor(text) {
  const hits = CATEGORY_RULES.filter(([, re]) => re.test(text)).map(([name]) => name);
  return hits.length ? hits : ['uncategorized'];
}

function targetFor(categories) {
  if (categories.includes('stable-preference')) return 'USER.md or MEMORY.md';
  if (categories.includes('infrastructure-decision')) return 'TOOLS.md or MEMORY.md';
  if (categories.includes('lesson-or-failure')) return 'AGENTS.md, MEMORY.md, or relevant skill';
  if (categories.includes('active-project')) return 'daily note / HEARTBEAT.md / active todo list';
  return 'MEMORY.md if still relevant';
}

function isNoise(text) {
  const lower = text.toLowerCase();
  if (lower.includes('media attached:') || lower.includes('to send an image back')) return true;
  if (
    /\bfood \/ health log\b/i.test(text) &&
    /\b(kcal|carbs?|protein|fat|running total|breakfast|lunch|dinner|weight logged)\b/i.test(text)
  ) {
    return !/\b(preference|always|never|rule|static health|should not ask)\b/i.test(text);
  }
  const looksLikeMealLedger =
    /\b(breakfast|lunch|dinner|running total|morning weight|logged)\b/i.test(text) &&
    /\b(kcal|carbs?|protein|glass|toast|pasta|salad|wine|coffee)\b/i.test(text);
  const hasDurablePreference =
    /\bpreference|usual|always|never|rule|static health|should not ask\b/i.test(text);
  return looksLikeMealLedger && !hasDurablePreference;
}

const EXCLUDED_CONTENT_RE =
  /\b(?:news(?:letter| digest)?s?|newsletter|system report|health report|status report|daily report|config(?:uration)?(?: review| report)?|generic status|current status|what changed|system health|operational status)\b/i;
const EXPLICIT_DURABLE_RE =
  /\b(?:prefer(?:s|red)?|preference|want(?:s|ed)?|expect(?:s|ed)?|always|never|decid(?:e|ed|es)|decision|constraint|rule|lesson(?: learned)?|should(?: not)?|must|personal fact|birthday|height|diagnos(?:is|ed)|allerg(?:y|ic)|usually)\b/i;

function eligibility(candidate) {
  const text = cleanText(candidate?.text || candidate?.rawText);
  const evidence = cleanText(candidate?.evidence);
  const source = cleanText(candidate?.sourceFile);
  const reasons = [];
  if (!text) reasons.push('empty candidate');
  if (isNoise(text)) reasons.push('noise/ephemeral log');
  if (EXCLUDED_CONTENT_RE.test(text)) reasons.push('news/report/status/config blob');
  if (!EXPLICIT_DURABLE_RE.test(text))
    reasons.push('no explicit preference, decision, constraint, lesson, or durable personal fact');
  if (!evidence && !source) reasons.push('missing concrete evidence reference');
  if (candidate?.rawText && candidate.rawText.length > 600)
    reasons.push('clipped candidate source');
  return { eligible: reasons.length === 0, reasons };
}

// --- Approved source enumeration -------------------------------------------
// Decision 23 (superpowers-memory-adapter-orchestration-proposal.md §12):
// the only approved producer inputs are memory/YYYY-MM-DD.md files and files
// explicitly registered by outputs/INDEX.md, over a rolling 7-day lookback.
// Native memory/dreaming/{light,rem,deep}/, session databases, and any
// invented memory-service listing endpoint are out of scope.

function withinRoot(root, absPath) {
  const relative = path.relative(root, absPath);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function readFileState(absPath, allowedRoot = null) {
  try {
    const stat = fs.lstatSync(absPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'unreadable' };
    if (allowedRoot) {
      const realRoot = fs.realpathSync(allowedRoot);
      const realFile = fs.realpathSync(absPath);
      if (!withinRoot(realRoot, realFile)) return { state: 'outside-allowlist' };
    }
    return { state: 'found', text: fs.readFileSync(absPath, 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'missing' };
    return { state: 'unreadable' };
  }
}

function readDailyNotes(days) {
  let names;
  try {
    const stat = fs.lstatSync(MEMORY_DIR);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { directoryState: 'unreadable', entries: [] };
    }
    names = fs.readdirSync(MEMORY_DIR);
  } catch (error) {
    const directoryState = error.code === 'ENOENT' ? 'missing' : 'unreadable';
    return { directoryState, entries: [] };
  }

  const windowDatesSet = new Set(days);
  const dates = names
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.md$/)?.[1])
    .filter((date) => date && windowDatesSet.has(date))
    .sort();
  const entries = dates.map((date) => {
    const rel = path.join('memory', date + '.md');
    const result = readFileState(path.join(MEMORY_DIR, date + '.md'));
    return { date, file: rel, ...result };
  });
  return { directoryState: 'found', entries };
}

// Parses `## YYYY-MM-DD — Title` entries and their `- **File:** \`path\`` line
// out of outputs/INDEX.md. The sample entry in the "Entry format" section uses
// the literal placeholder "YYYY-MM-DD", which does not match the date regex
// and is therefore skipped automatically.
function parseIndexEntries(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+—/);
    if (heading) {
      if (current) entries.push(current);
      current = { date: heading[1], file: null };
      continue;
    }
    if (current && current.file === null) {
      const fileMatch = line.match(/^- \*\*File:\*\*\s+`([^`]+)`/);
      if (fileMatch) current.file = fileMatch[1];
    }
  }
  if (current) entries.push(current);
  return entries.filter((entry) => entry.file);
}

function readRegisteredOutputs(windowSet) {
  const indexAbsPath = path.join(ROOT, INDEX_REL);
  const outputRoot = path.join(ROOT, 'outputs');
  let outputRootState = 'found';
  try {
    const stat = fs.lstatSync(outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) outputRootState = 'unreadable';
  } catch (error) {
    outputRootState = error.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (outputRootState !== 'found') return { indexState: outputRootState, entries: [] };

  let outputRootRealPath;
  try {
    outputRootRealPath = fs.realpathSync(outputRoot);
  } catch {
    return { indexState: 'unreadable', entries: [] };
  }
  const indexResult = readFileState(indexAbsPath, outputRoot);
  if (indexResult.state !== 'found') {
    return { indexState: indexResult.state, entries: [] };
  }
  const entriesInWindow = parseIndexEntries(indexResult.text).filter((entry) =>
    windowSet.has(entry.date),
  );
  const entries = entriesInWindow.map((entry) => {
    const resolved = path.resolve(ROOT, entry.file);
    const normalizedRelative = path.relative(outputRoot, resolved);
    if (
      !entry.file.startsWith('outputs' + path.sep) ||
      !withinRoot(outputRoot, resolved) ||
      !withinRoot(outputRootRealPath, path.resolve(outputRootRealPath, normalizedRelative))
    ) {
      return { ...entry, state: 'outside-allowlist' };
    }
    const result = readFileState(resolved, outputRoot);
    return { ...entry, ...result };
  });
  return { indexState: 'found', entries };
}

function extractLineCandidates(text, sourceFile, sourceDate) {
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((line, idx) => {
    const match = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!match) return;
    const raw = match[1];
    const body = cleanText(raw).slice(0, 600);
    if (body.length < 15) return;
    const categories = categoriesFor(body);
    const quality = assessCandidate({ text: body, rawText: raw });
    const proposal = proposalFor({ text: body, categories });
    out.push({
      text: body,
      rawText: raw,
      categories,
      confidence: null,
      evidence: sourceFile + ':' + (idx + 1),
      sourceFile,
      sourceDate,
      status: '',
      target: targetFor(categories),
      noise: isNoise(body),
      ...quality,
      ...proposal,
    });
  });
  return out;
}

function score(candidate) {
  let value = candidate.confidence ?? 0.5;
  if (candidate.evidence) value += 0.1;
  if (candidate.noise) value -= 0.35;
  if (candidate.categories.includes('lesson-or-failure')) value += 0.08;
  if (candidate.categories.includes('stable-preference')) value += 0.08;
  if (candidate.categories.includes('family-travel-health')) value += 0.06;
  if (candidate.sourceDate) {
    const age = daysBetween(day, candidate.sourceDate);
    if (age <= 3) value += 0.06;
    else if (age > 21) value -= 0.08;
  }
  return value;
}

function mdList(items, formatter) {
  return items.length ? items.map(formatter).join('\n') : '- None surfaced.';
}

function contradictionSignals(docs) {
  const all = docs
    .map((doc) => doc.text)
    .join('\n')
    .toLowerCase();
  const signals = [];
  if (/backup folder permissions.*done|permissions.*marked done|todo.*done/.test(all))
    signals.push('Completed infrastructure todos should be suppressed from active todo lists.');
  return signals;
}

function todoSignals(docs) {
  const rows = [];
  for (const doc of docs) {
    for (const line of doc.text.split(/\r?\n/)) {
      if (/\b(todo|pending|carry.?over|blocked|remind|follow.?up|next)\b/i.test(line)) {
        rows.push({ file: doc.file, line: line.trim().slice(0, 220) });
      }
    }
  }
  return rows.slice(-12);
}

const days = windowDates(day, WINDOW_DAYS);
const windowSet = new Set(days);

const dailyNotes = readDailyNotes(days);
const dailyNoteResults = dailyNotes.entries;
const dailyNotesFound = dailyNoteResults.filter((r) => r.state === 'found');
const foundDailyDates = new Set(dailyNotesFound.map((r) => r.date));
const dailyNotesMissing = days
  .filter((date) => !foundDailyDates.has(date) && !dailyNoteResults.some((r) => r.date === date))
  .map((date) => ({ date, file: path.join('memory', date + '.md'), state: 'missing' }));
const dailyNotesUnreadable = dailyNoteResults.filter((r) => r.state === 'unreadable');

const registered = readRegisteredOutputs(windowSet);
const registeredEntries = registered.entries;
const registeredFound = registeredEntries.filter((r) => r.state === 'found');
const registeredMissing = registeredEntries.filter((r) => r.state === 'missing');
const registeredUnreadable = registeredEntries.filter((r) => r.state === 'unreadable');
const registeredOutsideAllowlist = registeredEntries.filter((r) => r.state === 'outside-allowlist');
const indexUnavailable = registered.indexState !== 'found';

const coverageReasons = [];
if (dailyNotes.directoryState !== 'found')
  coverageReasons.push(
    'memory/ directory is ' + dailyNotes.directoryState + ' (cannot enumerate daily notes)',
  );
if (indexUnavailable)
  coverageReasons.push(
    INDEX_REL + ' is ' + registered.indexState + ' (cannot enumerate registered outputs)',
  );
if (registeredMissing.length)
  coverageReasons.push(
    registeredMissing.length +
      ' registered output file(s) listed in ' +
      INDEX_REL +
      ' are missing on disk: ' +
      registeredMissing.map((r) => r.file).join(', '),
  );
if (registeredUnreadable.length)
  coverageReasons.push(
    registeredUnreadable.length +
      ' registered output file(s) could not be read: ' +
      registeredUnreadable.map((r) => r.file).join(', '),
  );
if (registeredOutsideAllowlist.length)
  coverageReasons.push(
    registeredOutsideAllowlist.length +
      ' registered output path(s) resolve outside outputs/: ' +
      registeredOutsideAllowlist.map((r) => r.file).join(', '),
  );
if (dailyNotesUnreadable.length)
  coverageReasons.push(
    dailyNotesUnreadable.length +
      ' daily note(s) exist but could not be read: ' +
      dailyNotesUnreadable.map((r) => r.file).join(', '),
  );

const inputAvailable = coverageReasons.length === 0;
const missingInputReason = inputAvailable ? null : coverageReasons.join('; ') + '.';

// Fail-safe for §5B: an empty candidate list must never be presented as a
// healthy "nothing worth retaining" result when an approved source could not
// be enumerated or read. Missing daily notes are tolerated (the rolling
// 7-day window exists to absorb a missed run); unreadable files and an
// unreadable/missing index are not.
const sourceDocs = inputAvailable
  ? [
      ...dailyNotesFound.map((r) => ({ file: r.file, date: r.date, text: r.text })),
      ...registeredFound.map((r) => ({ file: r.file, date: r.date, text: r.text })),
    ]
  : [];

const candidates = sourceDocs.flatMap((doc) => extractLineCandidates(doc.text, doc.file, doc.date));
const ranked = candidates
  .map((candidate) => ({ ...candidate, score: score(candidate) }))
  .sort((a, b) => b.score - a.score);
const reviewed = ranked.map((candidate) => ({ ...candidate, eligibility: eligibility(candidate) }));
const reviewCandidates = reviewed
  .filter(
    (candidate) =>
      candidate.score >= candidateThreshold && candidate.accepted && candidate.eligibility.eligible,
  )
  .slice(0, 12);
const lowConfidenceReview = reviewed
  .filter(
    (candidate) =>
      candidate.accepted &&
      (candidate.score < candidateThreshold || !candidate.eligibility.eligible),
  )
  .slice(0, 8);
const rejectedCandidates = reviewed
  .filter((candidate) => !candidate.accepted || !candidate.eligibility.eligible)
  .slice(0, 12);

const todoDocs = inputAvailable ? dailyNotesFound.map((r) => ({ file: r.file, text: r.text })) : [];
const contradictions = contradictionSignals(todoDocs);
const todos = todoSignals(todoDocs);

const digest = [
  '# Dream Curation Digest - ' + day,
  '',
  '## Status',
  '',
  inputAvailable
    ? '- OK: approved sources enumerated and read successfully for ' + days[0] + '..' + day + '.'
    : '- INCOMPLETE/UNAVAILABLE: ' +
      missingInputReason +
      ' This digest is a missing-input report, not proof that no candidates exist.',
  '',
  '## Source Coverage',
  '',
  '- Window: ' + days[0] + ' to ' + day + ' (rolling ' + WINDOW_DAYS + '-day lookback).',
  '- Daily notes found: ' +
    dailyNotesFound.length +
    '/' +
    days.length +
    (dailyNotesFound.length ? ' (' + dailyNotesFound.map((r) => r.file).join(', ') + ')' : ''),
  '- Daily notes missing (tolerated, no note written that day): ' +
    (dailyNotesMissing.length ? dailyNotesMissing.map((r) => r.file).join(', ') : 'none'),
  '- Daily notes unreadable (read error, NOT tolerated): ' +
    (dailyNotesUnreadable.length ? dailyNotesUnreadable.map((r) => r.file).join(', ') : 'none'),
  '- ' + INDEX_REL + ': ' + registered.indexState,
  '- Registered outputs in window: ' +
    registeredEntries.length +
    ' entries; found ' +
    registeredFound.length +
    ', missing ' +
    registeredMissing.length +
    ', unreadable ' +
    registeredUnreadable.length +
    ', outside allowlist ' +
    registeredOutsideAllowlist.length,
  '',
  '## Inputs',
  '',
  '- Source documents read: ' + sourceDocs.length,
  '- Candidates parsed: ' + candidates.length,
  '- Review threshold: score >= ' + candidateThreshold.toFixed(2),
  '- Promotion mode: disabled. This digest is advisory only and must not write to startup files automatically.',
  '',
  '## Candidate Review Queue',
  '',
  mdList(
    reviewCandidates,
    (candidate, index) =>
      index +
      1 +
      '. **' +
      candidate.title +
      '** -> possible target: ' +
      candidate.target +
      ' (score ' +
      candidate.score.toFixed(2) +
      ', confidence ' +
      (candidate.confidence ?? 'n/a') +
      ')\n   - Proposal: ' +
      candidate.proposal +
      '\n   - Why it matters: ' +
      candidate.why +
      '\n   - Evidence: ' +
      (candidate.evidence || candidate.sourceFile),
  ),
  '',
  '## Low-Confidence / Noise Review',
  '',
  mdList(
    lowConfidenceReview,
    (candidate, index) =>
      index +
      1 +
      '. **' +
      candidate.categories.join(', ') +
      '** (score ' +
      candidate.score.toFixed(2) +
      (candidate.noise ? ', noise' : '') +
      ')\n   - ' +
      candidate.text +
      '\n   - Evidence: ' +
      (candidate.evidence || candidate.sourceFile),
  ),
  '',
  '## Rejected by Quality Gate',
  '',
  mdList(
    rejectedCandidates,
    (candidate) =>
      '- ' +
      (candidate.title || 'Untitled candidate') +
      ': ' +
      candidate.reasons.join('; ') +
      ' (' +
      (candidate.evidence || candidate.sourceFile) +
      ')',
  ),
  '',
  '## Contradictions / Superseded Context',
  '',
  mdList(contradictions, (signal) => '- ' + signal),
  '',
  '## Todo Hygiene Signals',
  '',
  mdList(todos, (todo) => '- ' + todo.file + ': ' + todo.line),
  '',
  '## Weekly Curation',
  '',
  weekly
    ? '- Weekly pass is due: review candidates manually, compact stale MEMORY.md sections, and remove completed active todos.'
    : '- Not due today. Weekly curation runs on Mondays or with --weekly.',
  '',
].join('\n');

const outFile = path.join(OUT_DIR, day + '.md');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(outFile, digest);
fs.writeFileSync(path.join(OUT_DIR, 'latest.md'), digest);
fs.mkdirSync(REVIEW_DIR, { recursive: true });
const canonicalFile = path.join(REVIEW_DIR, day + '-promotion-candidates.json');
fs.writeFileSync(
  canonicalFile,
  JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: 'report-only',
      // §5B fail-safe: status/missingInput must be checked by any consumer before
      // treating an empty candidates array as a healthy "nothing to review" result.
      status: inputAvailable ? 'ok' : 'unavailable',
      missingInput: missingInputReason,
      note: inputAvailable
        ? 'Canonical review candidates. Manual approval is required; this file never promotes into startup memory.'
        : 'INCOMPLETE/UNAVAILABLE: ' +
          missingInputReason +
          ' Candidates below are not a complete or reliable result and must not be treated as "nothing worth retaining".',
      sources: {
        window: { start: days[0], end: day, days: WINDOW_DAYS },
        dailyNotes: {
          found: dailyNotesFound.map((r) => r.file),
          missing: dailyNotesMissing.map((r) => r.file),
          unreadable: dailyNotesUnreadable.map((r) => r.file),
          directoryState: dailyNotes.directoryState,
        },
        registeredOutputs: {
          indexFile: INDEX_REL,
          indexState: registered.indexState,
          found: registeredFound.map((r) => r.file),
          missing: registeredMissing.map((r) => r.file),
          unreadable: registeredUnreadable.map((r) => r.file),
          outsideAllowlist: registeredOutsideAllowlist.map((r) => r.file),
        },
      },
      candidates: reviewCandidates.map(
        ({
          text,
          categories,
          confidence,
          evidence,
          sourceFile,
          status,
          target,
          score,
          title,
          proposal,
          why,
        }) => ({
          text,
          categories,
          confidence,
          evidence,
          sourceFile,
          status: status || 'pending',
          target,
          score,
          title,
          proposal,
          why,
        }),
      ),
    },
    null,
    2,
  ) + '\n',
);
console.log('Wrote ' + path.relative(ROOT, outFile));
console.log('Wrote ' + path.relative(ROOT, canonicalFile));
console.log('Input status: ' + (inputAvailable ? 'ok' : 'UNAVAILABLE - ' + missingInputReason));
console.log('Review candidates: ' + reviewCandidates.length);
console.log('Contradiction signals: ' + contradictions.length);
console.log('Todo hygiene signals: ' + todos.length);
