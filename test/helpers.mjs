import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS_DIR = path.join(ROOT, 'scripts');
export const CURATOR = path.join(SCRIPTS_DIR, 'dreaming-curator.mjs');
export const DELIVERY = path.join(SCRIPTS_DIR, 'dreaming-review-delivery.mjs');

/**
 * Run `fn` with a fresh, disposable workspace root that mimics the OpenClaw
 * workspace layout (the scripts treat `process.cwd()` as the data root).
 */
export function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dreaming-test-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Execute one of the scripts against a temp root and return trimmed stdout. */
export function runNode(script, args, cwd) {
  return execFileSync('node', [script, ...args], { cwd, encoding: 'utf8' });
}

export function candidatesFile(root, day) {
  return path.join(root, 'memory', 'review-candidates', `${day}-promotion-candidates.json`);
}

export function digestFile(root, day) {
  return path.join(root, 'memory', 'dreaming', 'digests', `${day}.md`);
}

/** Write one dreaming phase file (`light`, `rem`, or `deep`) for a day. */
export function writePhase(root, day, phase, content) {
  const dir = path.join(root, 'memory', 'dreaming', phase);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${day}.md`), content);
}

/** Write the canonical review-candidates JSON consumed by the renderer. */
export function writeCanonical(root, day, report) {
  const file = candidatesFile(root, day);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

/** Build a canonical envelope with sensible defaults. */
export function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'report-only',
    status: 'ok',
    missingInput: null,
    note: 'test fixture',
    candidates: [],
    ...overrides,
  };
}

/** Build one canonical review candidate with sensible defaults. */
export function candidate(overrides = {}) {
  return {
    text: 'The user prefers tea over coffee in the evening.',
    title: 'Evening beverage preference',
    proposal: 'The user prefers tea over coffee in the evening.',
    why: 'Stated preference.',
    target: 'USER.md',
    evidence: 'memory/2026-01-01.md:1-1',
    sourceFile: 'memory/2026-01-01.md',
    score: 0.9,
    confidence: 0.8,
    ...overrides,
  };
}
