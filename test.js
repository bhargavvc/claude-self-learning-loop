// Self-check for the whole loop. Run: node test.js   (Node 18+, no dependencies, never calls the real Claude)
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'self-learning-loop-'));
process.env.SELF_LEARNING_DATA = DATA;   // must be set before the modules below load
const L = require('./teacher/ledger');
const { gather } = require('./teacher/teacher');

const node = (script, args, options) =>
  cp.spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8', ...options });
const hook = (name, input, env) => node(path.join('hooks', name), [], { input: JSON.stringify(input), env });
const teacher = (...args) => node(path.join('teacher', 'teacher.js'), args);
const read = name => fs.readFileSync(path.join(DATA, name), 'utf8');
const write = (name, text) => fs.writeFileSync(path.join(DATA, name), text);
const reset = () => { for (const f of fs.readdirSync(DATA)) fs.rmSync(path.join(DATA, f), { recursive: true, force: true }); };

after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('capture keeps tool names and counts, never your words', () => {
  reset();
  const toolUse = (name, file) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { file_path: path.join('src', file) } }] } });
  const say = content => ({ type: 'user', message: { role: 'user', content } });
  const transcript = [
    say('refund totals are off by one cent'),
    toolUse('Read', 'money.ts'), toolUse('Edit', 'refund.ts'), toolUse('Edit', 'refund.ts'), toolUse('Edit', 'refund.ts'),
    say([{ type: 'tool_result', is_error: true, content: 'test run failed' }]),
    say("no, that's wrong, it still rounds down"),
    say('perfect, thanks'),
    { type: 'user', isMeta: true, message: { role: 'user', content: 'injected by the harness: no no no' } },
  ];
  write('t.jsonl', transcript.map(t => JSON.stringify(t)).join('\n'));
  const input = { session_id: 'a1b2c3d4e5f6', transcript_path: path.join(DATA, 't.jsonl'), cwd: '/work/payments-api' };
  assert.equal(hook('capture.js', input).status, 0);
  const log = read('session-log.md');
  assert.match(log, /— session a1b2c3d4\n- cwd: \/work\/payments-api\n/);
  assert.match(log, /tools\[Edit:3 Read:1\] edited\[refund\.ts\] read\[money\.ts\] msgs:8/);
  assert.match(log, /corrections:1 approvals:1 toolErrors:1 rework\[refund\.ts:3\]/);
  assert.doesNotMatch(log, /cent|rounds|perfect|test run failed/);
  hook('capture.js', input, { ...process.env, CLAUDE_TEACHER_ACTIVE: '1' });
  assert.equal(read('session-log.md'), log);   // the Teacher's own sessions are never captured
});

test('gather reads only new entries, oldest first, and the watermark never skips unread ones', () => {
  reset();
  write('session-log.md', '# Session log\n\n## 2026-03-01T10:00:00.000Z — session old\n- cwd: /a\n\n## 2026-03-03T10:00:00.000Z — session newer\n- cwd: /b\n');
  write('feedback-log.md', '# Feedback log\n\n## 2026-03-02T10:00:00.000Z — BAD\n- note: said it was fixed, tests failed\n');
  const batch = gather(Date.parse('2026-03-01T12:00:00Z'));
  assert.equal(batch.count, 2);
  assert.ok(batch.text.indexOf('— BAD') < batch.text.indexOf('session newer'));   // a rating sits next to the session it rates
  assert.equal(batch.last, '2026-03-03T10:00:00.000Z');
  const capped = gather(0, 10);   // the input cap is reached after one entry
  assert.deepEqual([capped.count, capped.left, capped.last], [1, 2, '2026-03-01T10:00:00.000Z']);
});

test('a pattern turns active only after showing up on 3 different days', () => {
  const ledger = { patterns: [] };
  const seen = [{ key: 'run-tests-first', rule: 'Run the tests before saying a fix works.', evidence: 'BAD: said fixed, tests failed' }];
  const state = () => [ledger.patterns[0].obsCount, ledger.patterns[0].status, ledger.patterns[0].confidence];
  L.merge(ledger, seen, '2026-03-01');
  L.merge(ledger, [...seen, ...seen], '2026-03-01');   // same day again, plus a duplicate key in one reply
  assert.deepEqual(state(), [1, 'candidate', 20]);
  L.merge(ledger, seen, '2026-03-02');
  assert.deepEqual(state(), [2, 'candidate', 40]);
  L.merge(ledger, seen, '2026-03-03');
  assert.deepEqual(state(), [3, 'active', 60]);
});

test('unseen habits archive, one-offs expire, rules you stated stay', () => {
  const p = (key, extra) => ({ key, rule: key, evidence: [], ...extra });
  const ledger = { patterns: [
    p('old-habit', { obsCount: 5, firstSeen: '2025-06-01', lastSeen: '2026-01-01' }),
    p('one-off', { obsCount: 1, firstSeen: '2026-03-01', lastSeen: '2026-03-01' }),
    p('stated', { source: 'directive', obsCount: 1, firstSeen: '2025-06-01', lastSeen: '2025-06-01' }),
  ] };
  L.merge(ledger, [], '2026-04-15');
  assert.deepEqual(Object.fromEntries(ledger.patterns.map(x => [x.key, x.status])), { 'old-habit': 'archived', stated: 'active' });
});

test('secrets and emails never reach the ledger', () => {
  const ledger = { patterns: [] };
  const fakeToken = 'ghp_' + 'x'.repeat(36);   // built at runtime so secret scanners don't flag this file
  L.merge(ledger, [{ key: 'k', rule: 'Use token=abc123 and mail dev@example.com', evidence: fakeToken }], '2026-03-01');
  assert.equal(ledger.patterns[0].rule, 'Use [REDACTED] and mail [REDACTED]');
  assert.deepEqual(ledger.patterns[0].evidence, ['[REDACTED]']);
  assert.equal(L.scrub('Split each task-description-into-smaller-steps'), 'Split each task-description-into-smaller-steps');
});

test('replies are read through the JSON envelope and any code fences', () => {
  const envelope = JSON.stringify({ type: 'result', result: 'Here you go:\n```json\n[{"key":"a","rule":"b"}]\n```' });
  assert.deepEqual(L.extractArray(envelope), [{ key: 'a', rule: 'b' }]);
  assert.equal(L.extractArray(JSON.stringify({ result: 'Sorry, not enough data.' })), null);
});

test('the Evaluator only recommends unless auto-approve is on, and reviewed wording is frozen', () => {
  const fresh = () => ({ patterns: [{ key: 'k', rule: 'original wording', obsCount: 3, firstSeen: '2026-03-01', lastSeen: '2026-03-03', evidence: [] }] });
  const manual = fresh();
  L.applyVerdicts(manual, [{ key: 'k', approve: true, scope: ['payments-api'], reason: 'causal and safe' }], false);
  const [p] = manual.patterns;
  assert.deepEqual([p.recommend, p.approved, p.scope], [true, undefined, ['payments-api']]);
  L.merge(manual, [{ key: 'k', rule: 'quietly different wording' }], '2026-03-04');
  assert.equal(manual.patterns[0].rule, 'original wording');
  const auto = fresh();
  L.applyVerdicts(auto, [{ key: 'k', approve: true, scope: 'global', reason: 'ok' }], true);
  assert.deepEqual([auto.patterns[0].approved, auto.patterns[0].scope], [true, 'global']);
});

test('inject: only approved, active, in-scope patterns, with your own rules first', () => {
  reset();
  const p = (key, extra) => ({ key, rule: 'rule-' + key, obsCount: 3, confidence: 60, status: 'active', approved: true, scope: 'global', evidence: [], ...extra });
  L.saveLedger({ patterns: [
    p('global'),
    p('scoped', { scope: ['payments-api'], obsCount: 4, confidence: 80 }),
    p('unapproved', { approved: false }),
    p('candidate', { status: 'candidate', obsCount: 2, confidence: 40 }),
    p('stated', { source: 'directive', obsCount: 1, confidence: 20 }),
  ] });
  write('.last-wake', 'now');   // keeps the hook from starting a real Teacher run
  const contextFor = cwd => JSON.parse(hook('inject.js', { cwd }).stdout).hookSpecificOutput.additionalContext;
  assert.match(contextFor('/work/payments-api'),
    /\n- rule-stated _\(stated by you\)_\n- rule-scoped _\(conf 80%, seen 4x, scope payments-api\)_\n- rule-global _\(conf 60%, seen 3x\)_$/);
  assert.doesNotMatch(contextFor('/work/docs-site'), /rule-scoped/);
});

test('run: one read-only model call, then merge and watermark; nothing new means no call', () => {
  reset();
  write('session-log.md', '# Session log\n\n## 2026-03-05T09:00:00.000Z — session s1\n- cwd: /work/payments-api\n- feedback: corrections:4 approvals:0\n');
  const reply = JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01,
    result: '```json\n' + JSON.stringify([{ key: 'run-tests-first', rule: 'Run the tests before saying a fix works.', evidence: '4 corrections, 0 approvals' }]) + '\n```' });
  write('fake claude.js', [   // stands in for the claude CLI; the space in the name tests the shell quoting
    "const fs = require('fs');",
    'fs.readFileSync(0);',
    "fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    `process.stdout.write(${JSON.stringify(reply)});`,
  ].join('\n'));
  const env = { ...process.env, CLAUDE_CMD: `"${process.execPath}" "${path.join(DATA, 'fake claude.js')}"`, FAKE_CALLS: path.join(DATA, 'calls.log') };
  const runTeacher = () => node(path.join('teacher', 'teacher.js'), ['run'], { env });
  assert.equal(runTeacher().status, 0);
  const args = JSON.parse(read('calls.log'));
  assert.equal(args[args.indexOf('--tools') + 1], '');   // "no tools" reaches claude as an empty argument
  assert.match(args[args.indexOf('--settings') + 1], /headless-settings\.json$/);
  assert.equal(L.loadLedger().patterns[0].key, 'run-tests-first');
  assert.equal(read('watermark'), '2026-03-05T09:00:00.000Z');
  assert.equal(runTeacher().status, 0);   // nothing new since the watermark
  assert.equal(read('calls.log').trim().split('\n').length, 1);
});

test('rate and add write what /good, /bad and stated rules need', () => {
  reset();
  assert.match(teacher('rate', 'bad', 'said it was fixed').stdout, /Feedback recorded: BAD/);
  assert.match(read('feedback-log.md'), /— BAD\n- cwd: .+\n- note: said it was fixed\n/);
  assert.equal(teacher('add', 'Ask before adding a dependency', '--scope', 'web').status, 0);
  const stated = L.loadLedger().patterns.find(p => p.source === 'directive');
  assert.deepEqual([stated.status, stated.approved, stated.scope], ['active', true, ['web']]);
});
