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
| [ISSUE-fixed-fill-child.md](ISSUE-fixed-fill-child.md) | A `Fixed` container does not stretch a `Fill` child when it grows |
| [ISSUE-fill-and-scroll.md](ISSUE-fill-and-scroll.md) | No container that fills the room it is given and scrolls when it cannot |
| [ISSUE-packaging.md](ISSUE-packaging.md) | No way to hand over an application without its project tree |

**A gap that is filled is deleted, not archived.** What the runtime can do is in
[`llm/`](../llm/README.md), which is where anybody looks for it; an issue kept
past its answer is a second description of the same feature, written by somebody
who did not have it yet, in the directory of things that are missing.

Eighteen have gone that way — seventeen filled and one refused. Filled: a drawing that
could not carry an image, text that could not be measured outside a `Draw`, a
document that could only leave as one PNG per page, a program that had to run
`sha256sum` to hash anything, an application that could not ask how big the
screen was, a `Scroller` that could not say where it was scrolled to, an editor
that could not say the same — reported by a diff viewer that had to follow the
cursor because two panes could not be locked —, a window that ignored a file
dropped on it, a schedule with nowhere to keep `"10:00"`, a
language with no value for the bytes of a file, a hierarchy that could not
carry a column, a program with no word for sound or motion, a stack that could be
written by hand and not built with the mouse, a picture whose rectangle
nothing else could be put on, an answer that could only be read once all of
it had arrived, a control whose engine could be missing on a machine the
build knew nothing about — `Video`, whose `Available` is now asked of the
registry rather than declared at build time —, and a document that could only
leave as a file and never reach a printer: `Print` sends it through the print
dialog, and `ToFile` writes the PDF the dialog would have made.

Refused: a list of check boxes. A tick the *list* keeps is state in the view,
which is the wrong place for it — the argument is with the other things that are
not coming, in
[`llm/controls.md`](../llm/controls.md#what-is-deliberately-not-here). **A
refusal is deleted too**: an issue whose answer is *no* is not a gap either, and
leaving it here would have it re-argued.

Git has all of them if anybody wants to read what the asking looked like.

The gaps that predate this directory — records over a database and
asynchrony — are already written down and are **not** re-reported here; see
[`llm/issues.md`](../llm/issues.md#what-is-known-to-be-missing). (Network was
one of them until `Http` arrived; a gap kept past its answer is a second
description of the same feature.)
