---
description: Rate this session BAD for the self-learning loop (optional note on what went wrong)
argument-hint: [what went wrong]
allowed-tools: Bash(node ~/.claude/self-learning-loop/teacher/teacher.js:*)
---
Run this exact command with the Bash tool, then reply with its one-line output and nothing else.
Don't apologise and don't summarise the session.

node ~/.claude/self-learning-loop/teacher/teacher.js rate bad "$ARGUMENTS"
