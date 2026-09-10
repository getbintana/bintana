# Reported issues

Gaps in the runtime, each written in the form [`llm/issues.md`](../llm/issues.md)
asks for: what the application needed, what was written instead, the code the
author wished existed, why the current words do not cover it, prior art, and how
much it mattered.

Each file is **what is missing, never how to add it** — the implementation is
someone else's call. If a gap here blocks the application you were asked for,
refer to the file rather than re-reporting it; if you found a new one, write it
in the same form.

| Issue | The missing capability |
|---|---|
| [ISSUE-editable-combo.md](ISSUE-editable-combo.md) | No editable / autocompleting combo |
| [ISSUE-printing.md](ISSUE-printing.md) | No printer — no dialog, no copies, no preview, and no way to lay a control onto a page |
| [ISSUE-video-availability.md](ISSUE-video-availability.md) | A control whose engine is missing is still offered — `Video` cannot say whether it can play |

**A gap that is filled is deleted, not archived.** What the runtime can do is in
[`llm/`](../llm/README.md), which is where anybody looks for it; an issue kept
past its answer is a second description of the same feature, written by somebody
who did not have it yet, in the directory of things that are missing.

Twelve have gone that way — eleven filled and one refused. Filled: a drawing that
could not carry an image, text that could not be measured outside a `Draw`, a
document that could only leave as one PNG per page, a program that had to run
`sha256sum` to hash anything, an application that could not ask how big the
screen was, a `Scroller` that could not say where it was scrolled to, a window
that ignored a file dropped on it, a schedule with nowhere to keep `"10:00"`, a
language with no value for the bytes of a file, a hierarchy that could not
carry a column, and a program with no word for sound or motion.

Refused: a list of check boxes. A tick the *list* keeps is state in the view,
which is the wrong place for it — the argument is with the other things that are
not coming, in
[`llm/controls.md`](../llm/controls.md#what-is-deliberately-not-here). **A
refusal is deleted too**: an issue whose answer is *no* is not a gap either, and
leaving it here would have it re-argued.

Git has all of them if anybody wants to read what the asking looked like.

The gaps that predate this directory — records over a database, packaging,
asynchrony — are already written down and are **not** re-reported here; see
[`llm/issues.md`](../llm/issues.md#what-is-known-to-be-missing). (Network was
one of them until `Http` arrived; a gap kept past its answer is a second
description of the same feature.)
