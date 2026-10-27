#!/usr/bin/env node
// SessionStart hook.
//  1. Inject the approved, active, in-scope patterns as context for this session.
//  2. If the Teacher hasn't been woken in 20 hours, start a run in the background.
//     A session starting means the machine is on and online, which a fixed clock time can't promise.
// No LLM in this process; it never blocks or fails a session (always exits 0).
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const L = require('../teacher/ledger');

const WAKE_EVERY_HOURS = 20;

function wakeTeacher() {
  const stamp = path.join(L.DATA, '.last-wake');
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < WAKE_EVERY_HOURS * 3600e3) return; } catch (_) {}
  fs.mkdirSync(L.DATA, { recursive: true });
  fs.writeFileSync(stamp, new Date().toISOString());   // stamp BEFORE spawning: a failing run can't respawn every session
  const runLog = fs.openSync(path.join(L.DATA, 'runs.log'), 'a');
  cp.spawn(process.execPath, [path.join(__dirname, '..', 'teacher', 'teacher.js'), 'run'], {
    stdio: ['ignore', 'ignore', runLog],   // the run logs for itself; stderr catches a crash it couldn't log
    windowsHide: true,
    // Windows: a detached child gets no console and can exit 0 having done nothing. unref() alone outlives the hook.
    detached: process.platform !== 'win32',
  }).unref();
}

try {
  if (process.env.CLAUDE_TEACHER_ACTIVE !== '1') {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) {}
    try { wakeTeacher(); } catch (_) {}
    const picked = L.selectForSession(L.loadLedger(), input.cwd || process.cwd());
    if (picked.length) {
      const additionalContext = '[learned-patterns] Behavioural preferences mined from your past sessions and vetted '
        + 'before use. Treat them as observed defaults: apply where relevant, defer to explicit instructions.\n'
        + picked.map(L.describe).join('\n');
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
    }
  }
} catch (_) {}
process.exit(0);
