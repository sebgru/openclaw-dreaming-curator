const CONTROL_MARKER_RE =
  /\b(?:ANNOUNCE_SKIP|NO_REPLY|HEARTBEAT_OK|SILENT_REPLY|DO_NOT_ANNOUNCE|CONTROL_MARKER|RUNTIME_CONTINUATION)\b/i;
const INTERNAL_LEAK_RE =
  /\binternal\s+(?:control[- ]?marker|runtime marker|orchestration marker)\b/i;
const FRAGMENT_END_RE =
  /(?:^|\s)(?:a|an|and|as|at|by|for|from|in|into|is|of|on|or|the|to|via|with|without|because|that|which)$/i;
const DURABLE_SIGNAL_RE =
  /\b(?:always|never|prefer(?:s|red)?|preference|want(?:s|ed)?|expect(?:s|ed)?|decid(?:e|ed|es)|configured|enabled|disabled|installed|verified|confirmed|constraint|rule|lesson(?: learned)?|should|must|fixed|completed|done|runs?\s+(?:on|through|via)|is\s+(?:the|a|an)|are\s+(?:the|a|an))\b/i;
const HISTORY_SIGNAL_RE =
  /\b(?:after restart|before restart|pending restart|running gateway|gateway healthy|cron alive|model-router|verification found|what changed|full model[- ]usage crawl|internal todo|pending actions?|status display|backup saved|reapplied .* patch|source audit|validation:|current model:)\b/i;
const STALE_LABEL_RE =
  /(?:\b(?:cron changes|internal todo|pending after this turn|pending restart|routing smoke tests|final model architecture|action item)\b|\bitem\s*\d+\s*[:—-])/i;
const TOPIC_SIGNAL_RES = [
  /\b(?:cron|gateway|model|openrouter|openai|deepseek|qwen|ollama|gpu|mineru|docker|config|memory)\b/i,
  /\b(?:telegram|email|calendar|exchange|news|report|communication|subagent|orchestration)\b/i,
  /\b(?:food|health|family|vacation|holiday|travel)\b/i,
  /\b(?:expense|tax|github|backup|certificate|course)\b/i,
];

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:[-*]\s+|#+\s*)+/, '')
    .trim();
}

function hasFragmentaryShape(text, rawText = text) {
  const value = cleanText(text);
  if (!value) return true;
  if (String(rawText).length > 600) return true;
  if (/[:;,…—-]$/.test(value)) return true;
  if (!/[.!?`)\]}]$/.test(value) && (FRAGMENT_END_RE.test(value) || /\s[a-z]$/.test(value)))
    return true;
  if (/^otherwise\b|^and\b|^but\b|^or\b|^because\b/i.test(value)) return true;
  if (/\b(?:assistant|user):\s|```|\|\s*[-:]+\s*\|/.test(value)) return true;
  return false;
}

function isStaleOperationalBlob(text) {
  const raw = String(text || '').trim();
  const value = cleanText(text);
  if (/^#{1,3}\s*\d{4}-\d{2}-\d{2}\b/.test(raw)) return true;
  const historySignals = (value.match(new RegExp(HISTORY_SIGNAL_RE.source, 'gi')) || []).length;
  const headings = (
    value.match(
      /(?:^|\s)#{1,3}\s|\b(?:Explicit change requests|Key distinction|What changed|What to watch)\b/gi,
    ) || []
  ).length;
  const semicolonClauses = (value.match(/;\s+(?=[A-Z#*`])/g) || []).length;
  return (
    STALE_LABEL_RE.test(value) ||
    headings >= 2 ||
    historySignals >= 2 ||
    (historySignals >= 1 && (value.length > 420 || semicolonClauses >= 3))
  );
}

function isMultiTopic(text) {
  const value = cleanText(text);
  const topicCount = TOPIC_SIGNAL_RES.filter((re) => re.test(value)).length;
  const clauses = (value.match(/;\s+(?=[A-Z#*`])/g) || []).length;
  const headings = (value.match(/(?:^|\s)#{1,3}\s/g) || []).length;
  return headings >= 2 || topicCount >= 2 || clauses >= 4;
}

function assessCandidate(candidate) {
  const text = cleanText(candidate?.text);
  const reasons = [];
  if (CONTROL_MARKER_RE.test(text) || INTERNAL_LEAK_RE.test(text))
    reasons.push('internal control-marker leak');
  if (hasFragmentaryShape(text, candidate?.rawText || text))
    reasons.push('clipped or fragmentary source text');
  if (isStaleOperationalBlob(text)) reasons.push('stale operational/config-history blob');
  if (isMultiTopic(text) && !isCoherentDurableFact(text))
    reasons.push('multi-topic candidate without one coherent durable fact/decision');
  if (
    /\b(?:action item|pending after this turn|next step|follow[- ]?up)\b/i.test(text) &&
    !/\b(?:decision|preference|constraint|rule)\b/i.test(text)
  )
    reasons.push('active task rather than durable fact/decision');
  if (!DURABLE_SIGNAL_RE.test(text)) reasons.push('no clear durable fact or decision');
  return { accepted: reasons.length === 0, reasons };
}

function isCoherentDurableFact(text) {
  const value = cleanText(text);
  const title = value.split(/\s*:\s*/, 1)[0];
  const hasSingleLabel = title.length >= 3 && title.length <= 90 && !/[.;]/.test(title);
  const explicitDecision =
    /\b(?:decision|decided|rule|preference|constraint|lesson|confirmed|verified|configured|enabled|disabled)\b/i.test(
      value,
    );
  return hasSingleLabel && explicitDecision && !isStaleOperationalBlob(value);
}

function splitLabel(text) {
  const value = cleanText(text);
  const match = value.match(/^([^:]{3,90}):\s*(.+)$/);
  if (!match) return { label: '', statement: value };
  return { label: match[1].trim(), statement: match[2].trim() };
}

function humanizeLabel(label, statement) {
  if (!label) {
    const first = statement.split(/(?<=[.!?])\s+/)[0];
    return first.length <= 90 ? first : `${first.slice(0, 87).trimEnd()}…`;
  }
  const normalized = label
    .replace(/\bConfirmation\b/i, 'confirmed')
    .replace(/\bPreference\b/i, 'preferences');
  if (normalized.includes('—')) return normalized;
  const firstClause = statement
    .split(/;\s+/)[0]
    .replace(/^(?:the user|user)\s+(?:requested|prefers|wants)\s+(?:that\s+)?/i, '')
    .trim();
  const detail = firstClause.length > 48 ? `${firstClause.slice(0, 45).trimEnd()}…` : firstClause;
  return detail ? `${normalized} — ${detail}` : normalized;
}

function conciseProposal(text) {
  const { statement } = splitLabel(text);
  const first = statement.split(/;\s+(?=[A-Z#*`])|(?<=[.!?])\s+/)[0].trim();
  return first.length <= 300 ? first : `${first.slice(0, 297).trimEnd()}…`;
}

function whyItMatters(text, categories = []) {
  if (categories.includes('stable-preference'))
    return 'Records a standing preference so future replies and reports follow it consistently.';
  if (categories.includes('lesson-or-failure'))
    return 'Preserves a lesson so the same failure is less likely to recur.';
  if (categories.includes('family-travel-health'))
    return 'Keeps a relevant personal fact available for future planning and advice.';
  if (categories.includes('infrastructure-decision'))
    return 'Keeps an operational decision or constraint documented for future maintenance.';
  return 'Preserves a durable fact that may be useful in future conversations.';
}

function proposalFor(candidate) {
  const text = cleanText(candidate?.text);
  const { label } = splitLabel(text);
  return {
    title: humanizeLabel(label, splitLabel(text).statement),
    proposal: conciseProposal(text),
    why: whyItMatters(text, candidate?.categories || []),
  };
}

export {
  assessCandidate,
  cleanText,
  hasFragmentaryShape,
  isMultiTopic,
  isStaleOperationalBlob,
  proposalFor,
};
