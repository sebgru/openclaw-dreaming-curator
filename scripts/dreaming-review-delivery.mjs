import fs from 'fs';
import path from 'path';
import { assessCandidate, cleanText } from './dreaming-quality.mjs';

const ROOT = process.cwd();
const day =
  process.argv.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)) ||
  new Date().toISOString().slice(0, 10);
const slot = Number(process.argv.find((arg) => /^\d+$/.test(arg)) || '1');
// Canonical source contract: only this report-only JSON file is deliverable;
// presentation artifacts are never used as a fallback.
const canonicalFile = path.join(
  ROOT,
  'memory',
  'review-candidates',
  `${day}-promotion-candidates.json`,
);

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isCanonicalReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (report.schemaVersion !== 1 || report.mode !== 'report-only') return false;
  if (typeof report.generatedAt !== 'string' || !Number.isFinite(Date.parse(report.generatedAt)))
    return false;
  if (!Array.isArray(report.candidates)) return false;
  if (report.status === 'ok') return report.missingInput === null;
  if (report.status === 'unavailable')
    return typeof report.missingInput === 'string' && report.missingInput.trim().length > 0;
  return false;
}

const EXCLUDED_CONTENT_RE =
  /\b(?:news(?:letter| digest)?s?|newsletter|system report|health report|status report|daily report|config(?:uration)?(?: review| report)?|generic status|current status|what changed|system health|operational status)\b/i;
const EXPLICIT_DURABLE_RE =
  /\b(?:prefer(?:s|red)?|preference|want(?:s|ed)?|expect(?:s|ed)?|always|never|decid(?:e|ed|es)|decision|constraint|rule|lesson(?: learned)?|should(?: not)?|must|personal fact|birthday|height|diagnos(?:is|ed)|allerg(?:y|ic)|usually)\b/i;

function parseCandidates(report) {
  if (!isCanonicalReport(report)) return [];
  // §5B fail-safe: an unavailable/incomplete producer run must never be
  // delivered as if it were a normal (possibly empty) review result.
  if (report.status === 'unavailable') return [];
  return report.candidates
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const text = cleanText(raw.text || raw.snippet);
      const evidence = cleanText(raw.evidence || raw.path);
      const source = cleanText(raw.sourceFile || raw.path);
      const candidate = {
        ...raw,
        title: cleanText(raw.title || raw.key || text),
        target: cleanText(raw.target || 'MEMORY.md if still relevant'),
        proposal: cleanText(raw.proposal || text),
        why: cleanText(raw.why),
        evidence,
        sourceFile: source,
      };
      const reasons = [];
      if (!text || !candidate.title || !candidate.proposal) reasons.push('missing candidate text');
      if (String(raw.text || raw.snippet || '').length > 600)
        reasons.push('clipped candidate source');
      if (/[:;,…—-]$/.test(text) || /^(?:and|but|or|because)\b/i.test(text))
        reasons.push('clipped or fragmentary source text');
      if (EXCLUDED_CONTENT_RE.test(text)) reasons.push('news/report/status/config blob');
      if (!EXPLICIT_DURABLE_RE.test(text))
        reasons.push(
          'no explicit preference, decision, constraint, lesson, or durable personal fact',
        );
      if (!evidence || !source) reasons.push('missing concrete evidence reference');
      const quality = assessCandidate({ text, rawText: raw.text || text });
      if (!quality.accepted) reasons.push(...quality.reasons);
      return reasons.length === 0 ? { ...candidate, text, ...quality } : null;
    })
    .filter(Boolean);
}

if (!fs.existsSync(canonicalFile)) {
  console.log('NO_REPLY');
  process.exit(0);
}

let report;
try {
  report = JSON.parse(read(canonicalFile));
} catch {
  report = null;
}
const candidates = parseCandidates(report).slice(0, 2);
const candidate = candidates[slot - 1];
if (!candidate) {
  console.log('NO_REPLY');
  process.exit(0);
}

const message = [
  `🌙 Dreaming review proposal ${slot}/${candidates.length}`,
  '',
  `Topic: ${candidate.title}`,
  `Proposal: ${candidate.proposal}`,
  `Why it matters: ${candidate.why || 'This may be a durable fact worth preserving.'}`,
  `Suggested destination: ${candidate.target}`,
  `Evidence: ${candidate.evidence}`,
  '',
  'Review action: approve, reject, or leave pending. Any approval requires an explicit manual change.',
  'No automatic change will be made.',
  '',
].join('\n');

// Final defense: never deliver an internal orchestration marker even if a
// malformed/stale digest bypassed the parser's candidate gate.
if (
  /\b(?:ANNOUNCE_SKIP|NO_REPLY|HEARTBEAT_OK|SILENT_REPLY|DO_NOT_ANNOUNCE|CONTROL_MARKER|RUNTIME_CONTINUATION)\b/i.test(
    message,
  )
) {
  console.log('NO_REPLY');
  process.exit(0);
}

// Rendering is stateless: stdout is not a delivery confirmation. The caller
// owns transport, retries, and scheduling exactly one invocation per slot.
console.log(message);
