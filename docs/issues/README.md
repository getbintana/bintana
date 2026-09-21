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
| [ISSUE-packaging.md](ISSUE-packaging.md) | No way to hand over an application without its project tree |
| [ISSUE-worker-locale-order.md](ISSUE-worker-locale-order.md) | A `Task` has no `Locale`, so a worker cannot order names |
| [ISSUE-form-keepalive.md](ISSUE-form-keepalive.md) | A shown `Form` has to be kept alive by hand — sixteen copies of one array |
| [ISSUE-laid-out.md](ISSUE-laid-out.md) | Nothing says *I have been laid out*, so five places retry on a timer |
| [ISSUE-editor-offset.md](ISSUE-editor-offset.md) | An editor cannot turn a character offset into a line |
| [ISSUE-file-relative.md](ISSUE-file-relative.md) | No `File.Relative`, and an extension has to be case-folded by hand |
| [ISSUE-class-introspection.md](ISSUE-class-introspection.md) | Asking what a type has means building one |
| [ISSUE-locale-write.md](ISSUE-locale-write.md) | A catalogue can be read and not written |

**A gap that is filled is deleted, not archived.** What the runtime can do is in
[`llm/`](../llm/README.md), which is where anybody looks for it; an issue kept
past its answer is a second description of the same feature, written by somebody
who did not have it yet, in the directory of things that are missing.

Twenty have gone that way — eighteen filled, one refused, and one that was
never missing. Filled: a drawing that could not carry an image, text that could not be measured outside a `Draw`, a
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
leave as a file and never reach a printer: `Printer.Send` puts it through the
print dialog, and `Printer.ToFile` writes the PDF the dialog would have made,
and a drop target that heard nothing until the drop: `DragEnter`/`DragOver`
carry the point while the drag travels, `DragLeave` says it went,
`DragBegin`/`DragEnd` mark the source's half, and answering `false` refuses.

Never missing: a container that fills the room it is given **and** scrolls when
it cannot. It was reported against a wall of cameras whose count is only known
at run time, and it is what a `Scroller` with an `Arrangement` has always done —
the slot is a box then, so an expanding child is stretched across the view and
free to outgrow it along the view. Nothing said so anywhere, which is the part
that was real: the reference now does, in
[`llm/controls.md`](../llm/controls.md#scroller) and
[`reference/widgets/Scroller.md`](../reference/widgets/Scroller.md), with the
measurements, and `tests/widgets`' `FillScroll` is what keeps it true.
**An issue answered by words that already existed is deleted like any other** —
what it leaves behind is the documentation that would have prevented it, not a
file describing a feature the runtime has.

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
