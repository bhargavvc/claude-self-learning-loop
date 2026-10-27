#!/usr/bin/env node
// The Teacher: once a day, turn new session signals and ratings into behavioural patterns.
//
//   node teacher.js run [--dry-run]                  gather -> mine -> merge -> evaluate (dry run: print the prompt only)
//   node teacher.js list                             active patterns, numbered, with the Evaluator's verdict
//   node teacher.js approve 1 3 | approve recommended | hold 2
//   node teacher.js add "<rule>" [--scope web,api]   a rule you state outright: skips the recurrence gate
//   node teacher.js rate good|bad [note]             what /good and /bad call
//
// Both model calls run `claude -p --tools ""`: text in, JSON out, no file access.
// This script does every write, and a bad reply leaves the ledger untouched.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const L = require('./ledger');

const MODEL = process.env.TEACHER_MODEL || 'sonnet';
const CLAUDE = process.env.CLAUDE_CMD || 'claude';
const AUTO_APPROVE = false;     // true = the Evaluator's verdict injects without your review
const MINE_BUDGET_USD = 0.60;   // hard cap per model call (--max-budget-usd)
const EVAL_BUDGET_USD = 0.40;
const EVAL_PER_RUN = 2;         // judge at most this many newly-active patterns per run
const MAX_INPUT = 120000;       // bytes of new log entries per run; the rest waits for the next run

const dataFile = name => path.join(L.DATA, name);
const readPrompt = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const today = () => new Date().toLocaleDateString('en-CA');   // local YYYY-MM-DD
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.mkdirSync(L.DATA, { recursive: true });
  fs.appendFileSync(dataFile('runs.log'), line + '\n');
  console.log(line);
}

// New log entries (sessions and ratings, interleaved by time), oldest first, up to maxBytes.
// `last` is the newest entry actually taken, so the watermark never skips past unread entries.
function gather(since, maxBytes = MAX_INPUT) {
  const entries = [];
  for (const name of ['session-log.md', 'feedback-log.md']) {
    let text = '';
    try { text = fs.readFileSync(dataFile(name), 'utf8'); } catch (_) { continue; }
    for (const chunk of text.split(/\n(?=## )/)) {
      const m = chunk.match(/^## (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      if (m && Date.parse(m[1]) > since) entries.push({ at: m[1], text: chunk.trim() });
    }
  }
  entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const taken = [];
  let bytes = 0;
  for (const e of entries) {
    if (taken.length && bytes + e.text.length > maxBytes) break;
    taken.push(e);
    bytes += e.text.length + 2;
  }
  return {
    text: taken.map(e => e.text).join('\n\n'),
    last: taken.length ? taken[taken.length - 1].at : null,
    count: taken.length,
    left: entries.length - taken.length,
  };
}

// One read-only model call. Returns { text, cost } or throws with the real reason.
function ask(input, budgetUsd, { isHeadless = false } = {}) {
  const flags = ['-p', '--model', MODEL, '--tools', '""', '--output-format', 'json',
    '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', budgetUsd];
  // Headless runs inherit your interactive settings. Always-on thinking + max effort blew the
  // budget cap on every run; the miner doesn't need them. The Evaluator keeps them: it's the judgement call.
  if (isHeadless) flags.push('--effort', 'medium', '--settings', `"${path.join(__dirname, 'headless-settings.json')}"`);
  for (let attempt = 1; ; attempt++) {
    const r = cp.spawnSync(`${CLAUDE} ${flags.join(' ')}`, {
      shell: true, input, encoding: 'utf8', timeout: 10 * 60e3, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, CLAUDE_TEACHER_ACTIVE: '1' },   // the hooks see this and stay out of the Teacher's own session
    });
    let reply = {};
    try { reply = JSON.parse(r.stdout); } catch (_) {}
    if (r.status === 0 && !reply.is_error && typeof reply.result === 'string') return { text: reply.result, cost: reply.total_cost_usd };
    // The real reason sits in the JSON result on stdout; stderr is often empty.
    const why = [reply.subtype, reply.result, ...(reply.errors || []), r.error && r.error.message, (r.stderr || '').trim()]
      .filter(Boolean).join(' | ').slice(0, 500) || `exit ${r.status}`;
    // Started beside a fresh session, this run can lose the race to refresh the login token. Transient: retry once.
    if (attempt === 1 && /OAuth|Failed to authenticate|refreshing/i.test(why)) {
      log('login token race, retrying in 75s: ' + why);
      sleep(75e3);
      continue;
    }
    throw new Error('claude failed: ' + why);
  }
}

function run(isDryRun) {
  fs.mkdirSync(L.DATA, { recursive: true });
  const lock = dataFile('.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 2 * 3600e3) fs.rmSync(lock); } catch (_) {}   // stale lock from a crashed run
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (_) { return log('another run is in progress; exiting'); }
  try {
    const watermarkFile = dataFile('watermark');
    const since = fs.existsSync(watermarkFile) ? Date.parse(fs.readFileSync(watermarkFile, 'utf8')) || 0 : 0;
    const batch = gather(since);
    if (!batch.count) return log('nothing new since the last run');

    // Show the model the keys it already used, so a re-seen habit accumulates evidence instead of becoming a near-duplicate.
    const known = L.loadLedger().patterns.map(p => `- key="${p.key}": ${p.rule}`).join('\n');
    const input = readPrompt('teacher-prompt.md')
      + (known ? '\n\n===EXISTING PATTERNS (reuse the exact key when you see one again)===\n' + known : '')
      + '\n\n===DATA===\n' + batch.text;
    if (isDryRun) return console.log(input);

    log(`mining ${batch.count} new entries (${batch.left} left for the next run) with ${MODEL}`);
    const reply = ask(input, MINE_BUDGET_USD, { isHeadless: true });
    const observations = L.extractArray(reply.text);
    if (!observations) throw new Error('reply held no JSON array; ledger untouched, watermark held');
    const ledger = L.loadLedger();
    const { added, updated } = L.merge(ledger, observations, today());
    L.saveLedger(ledger);
    fs.writeFileSync(watermarkFile, batch.last);   // advance only after a successful merge
    const count = status => ledger.patterns.filter(p => p.status === status).length;
    log(`merged: ${added} new, ${updated} re-seen; active ${count('active')}, candidates ${count('candidate')}; cost $${reply.cost}`);
    evaluate();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// The sceptical gate. Each newly-active mined pattern is judged once; the verdict is kept across runs.
function evaluate() {
  const pending = L.loadLedger().patterns
    .filter(p => p.status === 'active' && !L.isDirective(p) && p.recommend === undefined)
    .slice(0, EVAL_PER_RUN);
  if (!pending.length) return;
  const list = pending.map(p => `- key="${p.key}"\n  rule: ${p.rule}\n  evidence: ${p.evidence.join(' | ')}`).join('\n\n');
  const reply = ask(readPrompt('evaluator-prompt.md') + '\n\n===PATTERNS TO EVALUATE===\n' + list, EVAL_BUDGET_USD);
  const verdicts = L.extractArray(reply.text);
  if (!verdicts) throw new Error('Evaluator reply held no JSON array; ledger untouched');
  const ledger = L.loadLedger();   // re-read: you may have approved something while the model was thinking
  const judged = L.applyVerdicts(ledger, verdicts, AUTO_APPROVE);
  L.saveLedger(ledger);
  log(`evaluated ${judged} pattern(s)${AUTO_APPROVE ? ', verdicts applied' : '; review them with /patterns'}; cost $${reply.cost}`);
}

// Active patterns in one fixed order, so the numbers `list` prints are the numbers `approve` uses.
const numberedActive = ledger => ledger.patterns
  .filter(p => p.status === 'active')
  .sort((a, b) => L.isDirective(b) - L.isDirective(a) || (b.recommend === true) - (a.recommend === true)
    || b.confidence - a.confidence || a.key.localeCompare(b.key));

function list() {
  const ledger = L.loadLedger();
  const cell = text => String(text).replace(/\|/g, '\\|');
  const rows = numberedActive(ledger).map((p, i) => {
    const verdict = L.isDirective(p) ? 'stated by you'
      : p.recommend === undefined ? 'not judged yet'
      : (p.recommend ? 'approve' : 'hold') + (p.evalReason ? ': ' + p.evalReason : '');
    const scope = Array.isArray(p.scope) ? p.scope.join('/') : 'global';
    const conf = L.isDirective(p) ? '-' : p.confidence + '%';
    return `| ${i + 1} | ${p.approved ? 'yes' : 'no'} | ${cell(p.rule)} | ${conf} | ${scope} | ${cell(verdict)} |`;
  });
  console.log(rows.length
    ? '| # | Injecting | Rule | Conf | Scope | Evaluator |\n|---|---|---|---|---|---|\n' + rows.join('\n')
    : 'No active patterns yet.');
  const candidates = ledger.patterns.filter(p => p.status === 'candidate');
  if (candidates.length) {
    console.log(`\nStill building evidence (${candidates.length}):\n`
      + candidates.map(p => `- ${p.rule} (${p.confidence}%, seen ${p.obsCount}x)`).join('\n'));
  }
}

function setApproval(args, isApproved) {
  const ledger = L.loadLedger();
  const rows = numberedActive(ledger);
  const picked = args[0] === 'recommended'
    ? rows.filter(p => p.recommend === true && p.approved === undefined)
    : args.map(n => rows[Number(n) - 1]).filter(Boolean);
  for (const p of picked) p.approved = isApproved;
  L.saveLedger(ledger);
  console.log(`${isApproved ? 'approved' : 'held'} ${picked.length}; injecting from the next session: ${rows.filter(p => p.approved).length}`);
}

function add(args) {
  const at = args.indexOf('--scope');
  const scope = at >= 0 ? args.splice(at, 2)[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  const rule = L.scrub(args.join(' ').trim()).slice(0, 200);
  if (!rule) throw new Error('usage: teacher.js add "<rule>" [--scope token,token]');
  const ledger = L.loadLedger();
  const key = L.slug(rule);
  ledger.patterns = ledger.patterns.filter(p => p.key !== key);
  ledger.patterns.push({
    key, rule, source: 'directive', obsCount: 1, firstSeen: today(), lastSeen: today(),
    evidence: ['stated by you'], scope: scope.length ? scope : 'global', approved: true,
  });
  L.refresh(ledger, today());
  L.saveLedger(ledger);
  console.log('Added. It injects from the next session.');
}

function rate([verdict, ...note]) {
  if (!/^(good|bad)$/i.test(verdict || '')) throw new Error('usage: teacher.js rate good|bad [note]');
  const feedbackLog = dataFile('feedback-log.md');
  fs.mkdirSync(L.DATA, { recursive: true });
  if (!fs.existsSync(feedbackLog)) fs.writeFileSync(feedbackLog, '# Feedback log\n\n> Written by /good and /bad. Read by the Teacher.\n');
  const label = verdict.toUpperCase();
  fs.appendFileSync(feedbackLog,
    `\n## ${new Date().toISOString()} — ${label}\n- cwd: ${process.cwd()}\n- note: ${L.scrub(note.join(' ').trim()) || '(none)'}\n`);
  console.log('Feedback recorded: ' + label);
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'run') run(args.includes('--dry-run'));
    else if (command === 'list') list();
    else if (command === 'approve' || command === 'hold') setApproval(args, command === 'approve');
    else if (command === 'add') add(args);
    else if (command === 'rate') rate(args);
    else console.log('usage: teacher.js run [--dry-run] | list | approve <n...>|recommended | hold <n...> | add "<rule>" [--scope a,b] | rate good|bad [note]');
  } catch (e) {
    (command === 'run' ? log : console.error)('ERROR ' + e.message);
    process.exitCode = 1;
  }
}

module.exports = { gather };
