'use strict';
// The pattern ledger. Pure bookkeeping, no LLM: the model only says WHICH patterns it
// sees; everything that has to be exact (counts, dates, confidence, lifecycle, secret
// scrubbing, what gets injected) is decided here.
const fs = require('fs');
const path = require('path');

const DATA = process.env.SELF_LEARNING_DATA || path.join(__dirname, '..', 'data');
const LEDGER = path.join(DATA, 'patterns.json');
const FLOOR = 60;   // minimum confidence to inject: 60 = re-surfaced on 3 different days
const MAX = 20;     // most rules injected into one session

const DAY_MS = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) || 0;
const isDirective = p => p.source === 'directive';

// Confidence measures recurrence: +20 for each distinct day a run re-surfaced the pattern.
const confidence = obsCount => Math.min(95, obsCount * 20);

function statusFor(p, today) {
  if (isDirective(p)) return 'active';                          // you said it once; nothing to wait for
  if (daysBetween(p.lastSeen, today) > 90) return 'archived';   // stops injecting; revives if seen again
  if (p.obsCount >= 3) return 'active';
  if (p.obsCount < 2 && daysBetween(p.firstSeen, today) > 30) return 'expired';   // one-off noise
  return 'candidate';
}

// Defence in depth: the prompts forbid secrets, this makes sure none are ever stored.
const SECRETS = [
  /\bnpm_[A-Za-z0-9]{36}/g, /\bsk-[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{36}/g, /\bgithub_pat_\w{40,}/g,
  /\bAKIA[0-9A-Z]{16}/g, /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, /\bbearer\s+[\w.~+/-]{8,}=*/gi,
  /(?:password|passwd|pwd|secret|token|api[_-]?key|conn(?:ection)?[_-]?str(?:ing)?)\s*[:=]\s*\S+/gi,
  /[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
];
const scrub = text => SECRETS.reduce((out, re) => out.replace(re, '[REDACTED]'), String(text || ''));
const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Pull the JSON array out of a `claude -p --output-format json` reply (tolerates fences and prose around it).
function extractArray(raw) {
  let text = String(raw || '');
  try { const envelope = JSON.parse(text); if (typeof envelope.result === 'string') text = envelope.result; } catch (_) {}
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try { const arr = JSON.parse(text.slice(start, end + 1)); return Array.isArray(arr) ? arr : null; } catch (_) { return null; }
}

// Fold one run's observations into the ledger. Returns { added, updated }.
function merge(ledger, observations, today) {
  const byKey = new Map(ledger.patterns.map(p => [p.key, p]));
  const seenThisRun = new Set();
  let added = 0, updated = 0;
  for (const o of observations) {
    const rule = scrub(o && o.rule).trim().slice(0, 200);
    const key = slug((o && o.key) || rule);
    if (!rule || rule === '[REDACTED]' || !key || seenThisRun.has(key)) continue;   // a key repeated in one reply counts once
    seenThisRun.add(key);
    const evidence = scrub(o.evidence).trim().slice(0, 180);
    const p = byKey.get(key);
    if (!p) {
      const fresh = { key, rule, obsCount: 1, firstSeen: today, lastSeen: today, evidence: evidence ? [evidence] : [] };
      ledger.patterns.push(fresh);
      byKey.set(key, fresh);
      added++;
      continue;
    }
    if (isDirective(p)) continue;                                  // your own words are never overwritten
    if (p.lastSeen !== today) p.obsCount++;                         // one observation per day, however many runs
    p.lastSeen = today;
    if (p.recommend === undefined && !p.approved) p.rule = rule;    // wording freezes once reviewed
    if (evidence && !p.evidence.includes(evidence)) p.evidence = [evidence, ...p.evidence].slice(0, 4);
    updated++;
  }
  refresh(ledger, today);
  return { added, updated };
}

// Recompute confidence and status for every pattern; this is also what decays untouched ones.
function refresh(ledger, today) {
  for (const p of ledger.patterns) {
    p.confidence = confidence(p.obsCount);
    p.status = statusFor(p, today);
  }
  ledger.patterns = ledger.patterns
    .filter(p => p.status !== 'expired')
    .sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
  ledger.updated = today;
}

// Record the Evaluator's verdicts. It only RECOMMENDS unless shouldAutoApprove: you own `approved`.
function applyVerdicts(ledger, verdicts, shouldAutoApprove) {
  const byKey = new Map(ledger.patterns.map(p => [p.key, p]));
  let judged = 0;
  for (const v of verdicts) {
    const p = v && byKey.get(v.key);
    if (!p) continue;
    p.recommend = v.approve === true;
    p.evalReason = scrub(v.reason).slice(0, 200);
    const tokens = [].concat(v.scope || []).map(t => String(t).trim()).filter(t => t && t !== 'global');
    p.scope = tokens.length ? tokens : 'global';
    if (shouldAutoApprove) p.approved = p.recommend;
    judged++;
  }
  return judged;
}

// A scoped pattern injects only when one of its tokens is part of the session's folder path.
const isInScope = (scope, cwd) => !Array.isArray(scope)
  || scope.some(token => String(cwd).toLowerCase().includes(String(token).toLowerCase()));

// What one session gets: approved + active + in scope + confident enough; your own rules first.
function selectForSession(ledger, cwd) {
  return ledger.patterns
    .filter(p => p.approved === true && p.status === 'active' && isInScope(p.scope, cwd)
      && (isDirective(p) || p.confidence >= FLOOR))
    .sort((a, b) => isDirective(b) - isDirective(a) || b.confidence - a.confidence)
    .slice(0, MAX);
}

const describe = p => '- ' + p.rule
  + (isDirective(p) ? ' _(stated by you' : ` _(conf ${p.confidence}%, seen ${p.obsCount}x`)
  + (Array.isArray(p.scope) ? ', scope ' + p.scope.join('/') : '') + ')_';

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return { patterns: [] };
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));   // a corrupt ledger throws: never overwrite it
  if (!Array.isArray(ledger.patterns)) ledger.patterns = [];
  return ledger;
}

function saveLedger(ledger) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LEDGER + '.tmp', JSON.stringify(ledger, null, 2));
  fs.renameSync(LEDGER + '.tmp', LEDGER);                       // a session never reads half a file
}

module.exports = {
  DATA, FLOOR, MAX, isDirective, confidence, statusFor, scrub, slug, extractArray,
  merge, refresh, applyVerdicts, selectForSession, describe, loadLedger, saveLedger,
};
