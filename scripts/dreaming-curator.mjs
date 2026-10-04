import fs from 'fs';
import path from 'path';
import { assessCandidate, cleanText, proposalFor } from './dreaming-quality.mjs';

const ROOT = process.cwd();
const MEMORY_DIR = path.join(ROOT, 'memory');
const DREAM_DIR = path.join(MEMORY_DIR, 'dreaming');
const OUT_DIR = path.join(DREAM_DIR, 'digests');
// Canonical machine-readable review queue. Delivery must read this JSON only;
// the Markdown digest remains advisory/report-only presentation.
const REVIEW_DIR = path.join(MEMORY_DIR, 'review-candidates');

const args = process.argv.slice(2);
const day = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) || new Date().toISOString().slice(0, 10);
const weekly = args.includes('--weekly') || new Date(day + 'T00:00:00Z').getUTCDay() === 1;
const candidateThreshold = 0.72;

const CATEGORY_RULES = [
  ['stable-preference', /\b(prefer|preference|likes?|dislikes?|always|never|default to|wants?|expects?)\b/i],
  ['lesson-or-failure', /\b(mistake|failed|failure|lesson learned|root cause|should not|do not repeat|missed|bug|fix)\b/i],
  ['active-project', /\b(todo|next|pending|carry.?over|project|plan|check|follow.?up|remind|blocked)\b/i],
  ['family-travel-health', /\b(family|kids?|vacation|holiday|travel|health|diagnosis|allergy|medication)\b/i],
  ['infrastructure-decision', /\b(gpu|ollama|mineru|secretref|backup|docker|gateway|cron|model|openrouter|openai|deepseek|qwen|config)\b/i],
  ['durable-fact', /\b(completed|done|decided|configured|enabled|disabled|installed|verified|confirmed|constraint)\b/i],
];

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function exists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function fileDate(text) {
  const match = String(text || '').match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function daysBetween(a, b) {
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
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
  if (/\bfood \/ health log\b/i.test(text) && /\b(kcal|carbs?|protein|fat|running total|breakfast|lunch|dinner|weight logged)\b/i.test(text)) {
    return !/\b(preference|always|never|rule|static health|should not ask)\b/i.test(text);
  }
  const looksLikeMealLedger = /\b(breakfast|lunch|dinner|running total|morning weight|logged)\b/i.test(text)
    && /\b(kcal|carbs?|protein|glass|toast|pasta|salad|wine|coffee)\b/i.test(text);
  const hasDurablePreference = /\bpreference|usual|always|never|rule|static health|should not ask\b/i.test(text);
  return looksLikeMealLedger && !hasDurablePreference;
}

const EXCLUDED_CONTENT_RE = /\b(?:news(?:letter| digest)?s?|newsletter|system report|health report|status report|daily report|config(?:uration)?(?: review| report)?|generic status|current status|what changed|system health|operational status)\b/i;
const EXPLICIT_DURABLE_RE = /\b(?:prefer(?:s|red)?|preference|want(?:s|ed)?|expect(?:s|ed)?|always|never|decid(?:e|ed|es)|decision|constraint|rule|lesson(?: learned)?|should(?: not)?|must|personal fact|birthday|height|diagnos(?:is|ed)|allerg(?:y|ic)|usually)\b/i;

function eligibility(candidate) {
  const text = cleanText(candidate?.text || candidate?.rawText);
  const evidence = cleanText(candidate?.evidence);
  const source = cleanText(candidate?.sourceFile);
  const reasons = [];
  if (!text) reasons.push('empty candidate');
  if (isNoise(text)) reasons.push('noise/ephemeral log');
  if (EXCLUDED_CONTENT_RE.test(text)) reasons.push('news/report/status/config blob');
  if (!EXPLICIT_DURABLE_RE.test(text)) reasons.push('no explicit preference, decision, constraint, lesson, or durable personal fact');
  if (!evidence && !source) reasons.push('missing concrete evidence reference');
  if (candidate?.rawText && candidate.rawText.length > 600) reasons.push('clipped candidate source');
  return { eligible: reasons.length === 0, reasons };
}

function extractCandidates(text, sourceFile) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^- Candidate:\s*(.*)/);
    if (!match) continue;
    const parts = [match[1].trim()];
    let confidence = null;
    let evidence = '';
    let status = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
      if (/^- Candidate:/.test(lines[j])) break;
      const conf = lines[j].match(/confidence:\s*([0-9.]+)/);
      if (conf) confidence = Number(conf[1]);
      const ev = lines[j].match(/evidence:\s*(.*)/);
      if (ev) evidence = ev[1].trim();
      const st = lines[j].match(/status:\s*(.*)/);
      if (st) status = st[1].trim();
      // Only indented continuation bullets belong to the candidate body;
      // confidence/evidence/status are metadata, not proposal text.
      if (/^\s{2,}- /.test(lines[j]) && !/^\s+-\s*(?:confidence|evidence|recalls|status):/i.test(lines[j])) {
        parts.push(lines[j].replace(/^\s+-\s*/, '').trim());
      }
    }
    const rawText = parts.join(' ').replace(/\s+/g, ' ').trim();
    const body = rawText.slice(0, 600);
    const categories = categoriesFor(body);
    const quality = assessCandidate({ text: body, rawText });
    const proposal = proposalFor({ text: body, categories });
    out.push({ text: body, rawText, categories, confidence, evidence, sourceFile, status, target: targetFor(categories), noise: isNoise(body), ...quality, ...proposal });
  }
  return out;
}

function score(candidate) {
  let value = candidate.confidence ?? 0.5;
  if (candidate.evidence) value += 0.1;
  if (candidate.noise) value -= 0.35;
  if (candidate.categories.includes('lesson-or-failure')) value += 0.08;
  if (candidate.categories.includes('stable-preference')) value += 0.08;
  if (candidate.categories.includes('family-travel-health')) value += 0.06;
  const evDate = fileDate(candidate.evidence || candidate.sourceFile);
  if (evDate) {
    const age = daysBetween(day, evDate);
    if (age <= 3) value += 0.06;
    else if (age > 21) value -= 0.08;
  }
  return value;
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name)).filter((file) => fs.statSync(file).isFile());
  } catch {
    return [];
  }
}

function recentDailyDocs() {
  return listFiles(MEMORY_DIR)
    .filter((file) => /\/\d{4}-\d{2}-\d{2}\.md$/.test(file))
    .sort()
    .slice(-14)
    .map((file) => ({ file, text: read(file) }));
}

function contradictionSignals(docs) {
  const all = docs.map((doc) => doc.text).join('\n').toLowerCase();
  const signals = [];
  if (/backup folder permissions.*done|permissions.*marked done|todo.*done/.test(all)) signals.push('Completed infrastructure todos should be suppressed from active todo lists.');
  return signals;
}

function todoSignals(docs) {
  const rows = [];
  for (const doc of docs) {
    for (const line of doc.text.split(/\r?\n/)) {
      if (/\b(todo|pending|carry.?over|blocked|remind|follow.?up|next)\b/i.test(line)) {
        rows.push({ file: path.relative(ROOT, doc.file), line: line.trim().slice(0, 220) });
      }
    }
  }
  return rows.slice(-12);
}

function mdList(items, formatter) {
  return items.length ? items.map(formatter).join('\n') : '- None surfaced.';
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// The built-in dreaming plugin runs one scheduled sweep per day producing all
// three phases together, in order light -> REM -> deep (docs/concepts/dreaming.md:
// "Dreaming runs three cooperative phases per sweep"; phase policy is internal,
// not independently user-configured — docs/reference/memory-config.md: "Dreaming
// runs as one scheduled sweep and uses internal light/deep/REM phases as an
// implementation detail"). A partial set cannot establish that the producer
// sweep completed, so treat it as unavailable rather than a healthy result.
const phaseNames = ['light', 'rem', 'deep'];
const phaseStatus = phaseNames.map((phase) => ({ phase, file: path.join(DREAM_DIR, phase, day + '.md') }));
const presentPhases = phaseStatus.filter((entry) => exists(entry.file));
const missingPhases = phaseStatus.filter((entry) => !exists(entry.file)).map((entry) => entry.phase);
const phaseFiles = presentPhases.map((entry) => entry.file);

// Fail-safe for §5B: an empty candidate list must never be presented as a
// healthy "nothing worth retaining" result. If any phase input file is
// missing for this day, the producer's sweep did not complete, so the digest
// and canonical JSON must say so explicitly instead of silently reporting
// candidates: [] (full miss) or a partial result as if it were whole.
const expectedPhasePaths = phaseNames.map((phase) => path.join('memory', 'dreaming', phase, day + '.md'));
const inputAvailable = missingPhases.length === 0;
const latestAnyPhaseFile = phaseNames
  .flatMap((phase) => listFiles(path.join(DREAM_DIR, phase)))
  .map((file) => path.basename(file))
  .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
  .sort()
  .pop();
const missingInputReason = inputAvailable
  ? null
  : missingPhases.length === phaseNames.length
    ? 'No dreaming phase input found for ' + day + ' (expected all of: ' + expectedPhasePaths.join(', ') + ').'
      + (latestAnyPhaseFile ? ' Newest available phase file is ' + latestAnyPhaseFile + '.' : ' No phase files exist at all.')
    : 'Incomplete dreaming phase input for ' + day + ': missing ' + missingPhases.join(', ') + ' (present: ' + presentPhases.map((entry) => entry.phase).join(', ') + '). '
      + 'The sweep writes light, REM, and deep together; a partial set means the producer run did not complete.';

const candidates = inputAvailable
  ? phaseFiles.flatMap((file) => extractCandidates(read(file), path.relative(ROOT, file)))
  : [];
const ranked = candidates.map((candidate) => ({ ...candidate, score: score(candidate) })).sort((a, b) => b.score - a.score);
const reviewed = ranked.map((candidate) => ({ ...candidate, eligibility: eligibility(candidate) }));
const reviewCandidates = reviewed.filter((candidate) => candidate.score >= candidateThreshold && candidate.accepted && candidate.eligibility.eligible).slice(0, 12);
const lowConfidenceReview = reviewed.filter((candidate) => candidate.accepted && (candidate.score < candidateThreshold || !candidate.eligibility.eligible)).slice(0, 8);
const rejectedCandidates = reviewed.filter((candidate) => !candidate.accepted || !candidate.eligibility.eligible).slice(0, 12);
const docs = recentDailyDocs();
const contradictions = contradictionSignals(docs);
const todos = todoSignals(docs);

const digest = [
  '# Dream Curation Digest - ' + day,
  '',
  '## Status',
  '',
  inputAvailable
    ? '- OK: phase input found for ' + day + '.'
    : '- INCOMPLETE/UNAVAILABLE: ' + missingInputReason + ' This digest is a missing-input report, not proof that no candidates exist.',
  '',
  '## Inputs',
  '',
  '- Phase files found: ' + (phaseFiles.length ? phaseFiles.map((file) => path.relative(ROOT, file)).join(', ') : 'none'),
  '- Candidates parsed: ' + candidates.length,
  '- Review threshold: score >= ' + candidateThreshold.toFixed(2),
  '- Promotion mode: disabled. This digest is advisory only and must not write to startup files automatically.',
  '',
  '## Candidate Review Queue',
  '',
  mdList(reviewCandidates, (candidate, index) => (index + 1) + '. **' + candidate.title + '** -> possible target: ' + candidate.target + ' (score ' + candidate.score.toFixed(2) + ', confidence ' + (candidate.confidence ?? 'n/a') + ')\n   - Proposal: ' + candidate.proposal + '\n   - Why it matters: ' + candidate.why + '\n   - Evidence: ' + (candidate.evidence || candidate.sourceFile)),
  '',
  '## Low-Confidence / Noise Review',
  '',
  mdList(lowConfidenceReview, (candidate, index) => (index + 1) + '. **' + candidate.categories.join(', ') + '** (score ' + candidate.score.toFixed(2) + (candidate.noise ? ', noise' : '') + ')\n   - ' + candidate.text + '\n   - Evidence: ' + (candidate.evidence || candidate.sourceFile)),
  '',
  '## Rejected by Quality Gate',
  '',
  mdList(rejectedCandidates, (candidate) => '- ' + (candidate.title || 'Untitled candidate') + ': ' + candidate.reasons.join('; ') + ' (' + (candidate.evidence || candidate.sourceFile) + ')'),
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
  weekly ? '- Weekly pass is due: review candidates manually, compact stale MEMORY.md sections, and remove completed active todos.' : '- Not due today. Weekly curation runs on Mondays or with --weekly.',
  '',
].join('\n');

const outFile = path.join(OUT_DIR, day + '.md');
fs.writeFileSync(outFile, digest);
fs.writeFileSync(path.join(OUT_DIR, 'latest.md'), digest);
fs.mkdirSync(REVIEW_DIR, { recursive: true });
const canonicalFile = path.join(REVIEW_DIR, day + '-promotion-candidates.json');
fs.writeFileSync(canonicalFile, JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: 'report-only',
  // §5B fail-safe: status/missingInput must be checked by any consumer before
  // treating an empty candidates array as a healthy "nothing to review" result.
  status: inputAvailable ? 'ok' : 'unavailable',
  missingInput: missingInputReason,
  note: inputAvailable
    ? 'Canonical review candidates. Manual approval is required; this file never promotes into startup memory.'
    : 'INCOMPLETE/UNAVAILABLE: ' + missingInputReason + ' Candidates below are not a complete or reliable result and must not be treated as "nothing worth retaining".',
  candidates: reviewCandidates.map(({ text, categories, confidence, evidence, sourceFile, status, target, score, title, proposal, why }) => ({
    text, categories, confidence, evidence, sourceFile, status: status || 'pending', target, score, title, proposal, why,
  })),
}, null, 2) + '\n');
console.log('Wrote ' + path.relative(ROOT, outFile));
console.log('Wrote ' + path.relative(ROOT, canonicalFile));
console.log('Input status: ' + (inputAvailable ? 'ok' : 'UNAVAILABLE - ' + missingInputReason));
console.log('Review candidates: ' + reviewCandidates.length);
console.log('Contradiction signals: ' + contradictions.length);
console.log('Todo hygiene signals: ' + todos.length);
