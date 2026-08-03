# Why `AskUserQuestion` is denied here

`settings.json` blocks the `AskUserQuestion` tool. This is a workaround for an
open Claude Code bug, not a preference about how questions should be asked.

**The bug** — [anthropics/claude-code#72704][issue], open, no fix as of
2026-08-03:

A Claude Code web session left idle with a pending interactive prompt gets
periodically re-woken on the backend. Each wake **re-executes the pending
turn**, which re-runs inference and emits a *newly generated* question card.
Those stack up, and answers to superseded instances are dropped.

**Why it is worse than it sounds.** The loss is silent and partial. Observed on
2026-08-03 in this repo: a call containing 2 questions was rendered client-side
as a 3-question card. The answer payload came back carrying 2 answers — matching
the original call's arity, and internally consistent — with the third silently
absent. Nothing in the response distinguishes it from a complete one, so the
model proceeds confidently on a truncated answer set. In that session it built
~1000 lines against a destination the user had explicitly not chosen.

Denying the tool removes the trigger. Questions get asked in plain prose and
answered as ordinary messages, which goes through a path the bug does not touch.

**Reverting.** Delete this directory, or drop `"AskUserQuestion"` from the deny
list. Worth doing once #72704 closes — structured multiple-choice questions are
genuinely better than prose for branching decisions, and this is only a
workaround.

[issue]: https://github.com/anthropics/claude-code/issues/72704
