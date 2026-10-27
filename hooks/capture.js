#!/usr/bin/env node
// SessionEnd hook: append one entry per session to data/session-log.md.
// Stores tool names, file NAMES and counts. Your messages are read in memory to count
// corrections and approvals; the words themselves are never written. No LLM; always exits 0.
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = process.env.SELF_LEARNING_DATA || path.join(__dirname, '..', 'data');
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
// Crude on purpose: a weak signal that the Teacher weighs below an explicit /good or /bad.
const CORRECTION = /\b(no|nope|wrong|not right|don'?t|undo|revert|stop|actually|instead|that'?s not|isn'?t|broke|broken|still|again|i said|you missed|incorrect|mistake)\b/i;
const APPROVAL = /\b(thanks|thank you|perfect|great|works|working|correct|exactly|nice|good job|ship it|lgtm|awesome)\b/i;

function readSignals(transcriptPath) {
  const tools = {}, edits = {}, reads = new Set();
  let msgs = 0, corrections = 0, approvals = 0, toolErrors = 0;
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || entry.isMeta || !entry.message) continue;   // skip turns the harness injected
    const { role, content } = entry.message;
    msgs++;
    for (const block of Array.isArray(content) ? content : [{ type: 'text', text: content }]) {
      if (role === 'user' && block.type === 'text' && typeof block.text === 'string' && block.text.length <= 1500) {
        if (CORRECTION.test(block.text)) corrections++;      // longer texts are pastes or injected context, not replies
        if (APPROVAL.test(block.text)) approvals++;
      } else if (role === 'user' && block.type === 'tool_result' && block.is_error) {
        toolErrors++;
      } else if (role === 'assistant' && block.type === 'tool_use') {
        tools[block.name] = (tools[block.name] || 0) + 1;
        const file = block.input && block.input.file_path && path.basename(String(block.input.file_path));
        if (file && WRITE_TOOLS.has(block.name)) edits[file] = (edits[file] || 0) + 1;
        else if (file && READ_TOOLS.has(block.name)) reads.add(file);
      }
    }
  }
  const top = (counts, n, min = 1) => Object.entries(counts).filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, c]) => `${name}:${c}`).join(' ');
  return {
    msgs, corrections, approvals, toolErrors,
    tools: top(tools, 6),
    edited: Object.keys(edits).slice(0, 5).join(' '),
    read: [...reads].slice(0, 5).join(' '),
    rework: top(edits, 4, 3),   // a file edited 3+ times: the session struggled with it
  };
}

try {
  if (process.env.CLAUDE_TEACHER_ACTIVE !== '1') {   // never learn from the Teacher's own sessions
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const s = readSignals(input.transcript_path);
    if (s.msgs) {
      const entry = [
        `## ${new Date().toISOString()} — session ${String(input.session_id || 'unknown').slice(0, 8)}`,
        `- cwd: ${input.cwd || process.cwd()}`,
        `- signals: tools[${s.tools}] edited[${s.edited}] read[${s.read}] msgs:${s.msgs}`,
        `- feedback: corrections:${s.corrections} approvals:${s.approvals} toolErrors:${s.toolErrors}`
          + (s.rework ? ` rework[${s.rework}]` : ''),
      ];
      const sessionLog = path.join(DATA, 'session-log.md');
      fs.mkdirSync(DATA, { recursive: true });
      if (!fs.existsSync(sessionLog)) {
        fs.writeFileSync(sessionLog, '# Session log\n\n> One entry per session, appended by hooks/capture.js. No message text.\n');
      }
      fs.appendFileSync(sessionLog, '\n' + entry.join('\n') + '\n');
    }
  }
} catch (_) {}
process.exit(0);
