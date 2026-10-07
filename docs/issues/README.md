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
| [ISSUE-popover-designer.md](ISSUE-popover-designer.md) | A `Popover` cannot be seen or picked on the design canvas |


**A gap that is filled is deleted, not archived.** What the runtime can do is in
[`llm/`](https://github.com/getbintana/bintana-llm/blob/main/docs/llm/README.md), which is where anybody looks for it; an issue kept
past its answer is a second description of the same feature, written by somebody
who did not have it yet, in the directory of things that are missing.

Forty have gone that way — thirty-seven filled, one refused, and two that
were never missing. Filled: a drawing that could not carry an image, text that could not be measured outside a `Draw`, a
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
`DragBegin`/`DragEnd` mark the source's half, and answering `false` refuses,
and a shown `Form` that had to be kept alive by hand in sixteen dialogs:
`Show()` holds it now and the allowed close lets it go, and a `File` that could
take a path apart and not relate two: `Within` is the question, `Relative` the
spelling, and `IsExtension` the case-folded question that was written 43 times,
and an editor that could not turn a character offset into a line: `LineOf` is the
crossing — it converts the index a search gives, exactly, and the same pair is on
`Text` — while `Offset` and `OffsetAt` publish the cursor's position in
characters, the unit `Column` and `Select` count, and nothing that said *I have
been laid out*: `Allocated(box)` is raised once, on the frame GTK gives a control
a real rectangle, so the five bounded retries — the selection chrome, the image
viewer twice and both `i18n` examples — stopped guessing, and a class that could
only be asked what it has by building one: `Widget.PropertyNames(type)`,
`Methods`, `EventNames`, `TextProperties`, `PropertyOptions` and `Member` answer
by name, abstract classes included, so a palette, a property grid and the
extractor stop making disposable controls — the grid's base-properties pass used
to construct every widget type there is, and a column heading that could offer
nothing: `HeaderMenu` declares its menu and `HeaderClick(column, button, ctrl,
shift)` is the press — the one surface of a column view GTK reports nothing
for — with every item told the column it was opened over.
And four more in one sitting, all of them "the runtime has no word for this":
`Probe.Image(path)` measures a picture from its header with no widget and no
display, so a report can lay a logo out before anything is drawn and a console
project can ask at all; `Http.Client`'s `Tls: { Ca, Cert }` trusts a certificate
the program's own — the internal server on a company's CA, or self-signed, which
is the installation the system-wide store cannot be talked into — through
`SoupMessage::accept-certificate` and GLib's own chain check, measured before it
was written; a drawing's ink resolves through the application's first window when
the control is in none, so a `Chart` saved for a document has a title instead of
white words on transparent paper; and a `lib/report` element can say `When` and
read its `Color` off its row, which is what a stripe, a severity colour and a
badge are. And a project's own class named like a runtime global — a form called
`Timer`, `File` or `Probe` — is the project's again: a bare class name resolves
the way JavaScript resolves it, the lexical declaration before the global
property, where it used to stop the program with `startup class 'File' not found`.
And a pie that could not say what colour a slice is: `Series[].Colors` is a
colour per value, read by a pie's and a doughnut's slices, by a bar chart's bars
and by the legend, so a chart of severities can be in their colours beside a
table that already was.
And a list in a document that cost its square to write: `Record.SaveXml` on
8000 tasks was 151 s and is 0.4 s -- keys are matched through a map, an item
already in place is a position and not a move, and a text the element already
holds is not written, which was also growing the tree's orphan list and making
every save slower than the one before,
and a worker that could not put two names in order: `Locale` is installed in a
`Task` now with the half that needs no catalogue -- `Compare`, `Matches`,
`Number`, `Date`, `Currency`, `Parse`, `DecimalPoint` -- because the split is
the process boundary and not the global,
and two element verbs that could not refuse a surplus argument:
`parent.Remove(child)` took the **parent** out -- on a document's root the file
was emptied -- and `Add(name, text)` dropped the value. Both say no now, and
the message names the call that was meant,
and an element holding only a comment that read as an empty one: `IsEmpty`
counts every kind of child and `Comments` reads the text `Text` cannot carry,
so the walk that reported what a save changed can see the comment and does not
delete it,
and a `Fill` child of a `Fixed` container that a box stretched: the declared
size is the anchor origin on **every** surface now and not only on a form, so a
component drawn at 180x130 hands the room its host gives it down to its `Fill`
child -- which used to keep the drawn size, because the panel latched the cell
as its design,
and a control's `Menu`/`HeaderMenu` labels, which no class can declare as
prose: `Ide.Strings` walks the two keys by name, the same way it walks a form's
own `menus` block, and the reference names the control and the menu. The IDE's
own four context menus were English under a Spanish window until the template
knew their 13 labels.
And a new element in an `xsd:sequence` document that landed past the unmodelled
siblings the schema puts after it: `static Xml.Order` declares the type's whole
sequence, so a `<PredecessorLink>` goes before `IsPublished` even though the
shape never reads it, and `ToXml` writes in that order.
And one that was never missing, as a gap: *a second TLS handshake corrupts the
heap* was one `g_uri_unref` of a borrowed URI in `Tls`'s own check, and its
"connection refused" was a server collected because nothing held it.

Never missing: a container that fills the room it is given **and** scrolls when
it cannot. It was reported against a wall of cameras whose count is only known
at run time, and it is what a `Scroller` with an `Arrangement` has always done —
the slot is a box then, so an expanding child is stretched across the view and
free to outgrow it along the view. Nothing said so anywhere, which is the part
that was real: the reference now does, in
[`llm/controls.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/controls.md#scroller) and
[`reference/widgets/Scroller.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/reference/widgets/Scroller.md), with the
measurements, and `tests/widgets`' `FillScroll` is what keeps it true.
**An issue answered by words that already existed is deleted like any other** —
what it leaves behind is the documentation that would have prevented it, not a
file describing a feature the runtime has.

Refused: a list of check boxes. A tick the *list* keeps is state in the view,
which is the wrong place for it — the argument is with the other things that are
not coming, in
[`llm/controls.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/controls.md#what-is-deliberately-not-here). **A
refusal is deleted too**: an issue whose answer is *no* is not a gap either, and
leaving it here would have it re-argued.

Git has all of them if anybody wants to read what the asking looked like.

The gaps that predate this directory — records over a database and
asynchrony — are already written down and are **not** re-reported here; see
[`llm/issues.md`](../llm/issues.md#what-is-known-to-be-missing). (Network was
one of them until `Http` arrived; a gap kept past its answer is a second
description of the same feature.)
