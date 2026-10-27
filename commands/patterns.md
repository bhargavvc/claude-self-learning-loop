---
description: Review the learned patterns and choose which ones get injected into sessions
allowed-tools: Bash(node ~/.claude/self-learning-loop/teacher/teacher.js:*)
---
1. Run `node ~/.claude/self-learning-loop/teacher/teacher.js list` and show the output exactly as printed.
2. Then tell the user they can reply `approve 1 3`, `approve recommended` or `hold 2`, and that changes apply from the next session.
3. When the user replies with one of those, run `node ~/.claude/self-learning-loop/teacher/teacher.js <their reply>` and show the output.

The Evaluator's verdict is advice; only the user's approval makes a pattern inject. If asked why a pattern was recommended or held, quote the reason from the list rather than inventing one.
