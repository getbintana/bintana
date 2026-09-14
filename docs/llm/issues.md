# When the runtime is missing something

You were asked for an application. If the runtime cannot express part of it, the
useful thing you can do is say so precisely. The useless things are inventing an
API that does not exist, and building a large workaround around a small gap
without mentioning it.

## The rule

**Describe what is missing. Never how to add it.**

You do not have the technical documentation, you have not read the C, and you do
not know what the gap costs to fill or what else it touches. A guess at the
implementation makes the issue harder to answer, not easier: whoever reads it now
has to work out what is a requirement and what is your speculation, and the two
look the same on the page.

What you *do* know, and nobody else does, is what the application needed. That is
the whole value of the report.

## Before writing one

Three checks, in this order. Most candidate issues die here.

**1. Is it already there under another name?** The vocabulary is deliberately
small and words are reused. A row is a `Panel` with `Arrangement: "Horizontal"`.
A radio is a `CheckButton` with a `Group`. A toolbar is a `Style`. A menu button
is `PopupMenu`. A modal question is a form. Check
[controls.md](controls.md#what-is-deliberately-not-here) and
[language.md](language.md#instead-of-write).

**2. Is it already decided?** See [below](#already-decided). Those arguments are
written down so they are not had twice.

**3. Can the application be written without it?** If the answer is *yes, less
well*, that is still an issue worth filing — but say so, and **deliver the
working version anyway**. An issue is not a reason to hand back nothing.

## The form

Write it as `ISSUE.md` beside the project, or in your reply — whichever the
person asked for. Keep it to one page.

```markdown
# ISSUE: <one line, naming the missing capability>

## What the application needed
The concrete thing, in the application's own terms. Not "a way to do X in
general" — the screen, the field, the interaction that could not be built.

## What I wrote instead
The workaround, if there is one, and what it costs: the lines it took, what it
gets wrong, what the user sees that they should not. "Nothing — this part is not
implemented" is an answer.

## The code I wish I could have written
A `.form` fragment or a handler, in the vocabulary of this runtime, that would
have expressed it. This is a specification, not a proposal: it says what the
declaration should look like from the outside and nothing about what happens
underneath.

## Why the existing words do not cover it
Name the ones you tried and say what each one could not do. This is the part
that gets an issue taken seriously, and the part that most often ends with the
issue being withdrawn.

## Prior art
What VB, Delphi, Gambas, .NET, Qt or GTK4 itself call this, if they do. One line
each. If GTK4 removed it, say so — that is usually the answer.

## How much it mattered
One of: the application cannot be written; it works but a part of it is
noticeably worse; it works and this would only have been tidier.
```

## An example, filled in

**This one was written, filed, and granted** — a record holds a list of records
now, and the declaration under *the code I wish I could have written* is the API
that exists ([`Field.List(Line)`](library.md#a-record-inside-a-record)). It is
quoted here because it is what a good issue looks like, and because what it asked
for is what arrived: **do not file this one again.**

**A granted issue is deleted, not archived.** Its file goes; what the runtime can
do is documented where every other capability is, and a gap kept past its answer
is a second description of the same feature written by somebody who did not have
it yet. This one survives as an example inside this page and not as an issue.
Before filing anything, check [controls.md](controls.md),
[library.md](library.md) and [report.md](report.md) for what is *there*: several
of the gaps this page used to list are ordinary API now, and an issue against one
of them is an afternoon of somebody's time answering a question that has an
answer.

```markdown
# ISSUE: a Record cannot hold a list of Records

## What the application needed
An invoice with its lines. One header — customer, date, total — and N lines,
each a description, a quantity and a price. The header is a `Record`; the lines
have exactly the shape a `Record` is for.

## What I wrote instead
Two records and a parallel array: `Invoice` holds `LineIds:
Field.List(Field.Text())`, and the lines live in a second file keyed by id.
Saving is two writes that must both succeed, and nothing enforces that they do.
`Problems` on the header says nothing about a bad line.

## The code I wish I could have written
    class Line extends Record {
        static Fields = { Description: Field.Text(), Qty: Field.Int(),
                          Price: Field.Decimal({ decimals: 2 }) };
    }
    class Invoice extends Record {
        static Fields = { Customer: Field.Text({ required: true }),
                          Lines:    Field.List(Line) };
    }
Then `File.SaveJson(path, invoice)` is one write and `Invoice.Load(json)`
reports a bad line the way it reports a bad field.

## Why the existing words do not cover it
`Field.List(item)` takes a field, not a record: `Field.List(Line)` throws
`Field.List: expected a Field for its entries` while the class is being
declared. `Field.Text()` holding stringified JSON gives up
every check a `Record` exists for. A hand-written accessor can hold the array,
but then `Serialize`, `Load` and `Problems` do not know about it, which is the
whole of what `Record` was for.

## Prior art
Gambas has no equivalent. .NET's `System.ComponentModel.DataAnnotations`
validates nested objects with `[ValidateComplexType]`. JSON Schema nests by
construction.

## How much it mattered
It works, and one part of it is noticeably worse: master-detail is the shape most
business forms have, and this is the one place the application keeps two files
in step by hand.
```

Notice what that example does not say: which C file to change, what the property
should be called internally, how validation should recurse, or whether it is
easy. It says what could not be written and what the declaration should look
like. That is enough to decide, and deciding is somebody else's job.

And notice which part of it did the work. The *shape of the declaration* is what
was granted verbatim; the workaround, the prior art and the one-line measure of
how much it mattered are what made it worth granting. None of it guessed at an
implementation, and the implementation is not what it got right.

## Already decided

These have been argued and answered. Do not file them again; the reasoning is in
the root [`README`](../../README.md#three-things-that-were-considered-and-are-not-coming)
and in [controls.md](controls.md#what-is-deliberately-not-here).

| Not coming | Because |
|---|---|
| `RadioButton` | GTK4 removed it. A radio is a `CheckButton` with a `Group` |
| `ToolBar` | GTK4 removed `GtkToolbar`. A toolbar is a `Panel` with `Style: "toolbar"` |
| `ToolButton` | A `Button` with `Icon` and `Style: "flat"` |
| `MenuButton` | A `Button` with a `Menu` and one `PopupMenu` call |
| a mnemonic on a control | The marker lives inside translated prose and collisions are silent. Controls have `Shortcut`; menus have mnemonics |
| a blocking `MsgBox` | GTK4's dialogs are asynchronous. A question is a form |
| `Promise` / `async` | This is a language of events. Sequences are callbacks |
| `setTimeout` | `Timer.After` |
| `Object.keys` and the rest of `Object` | `Dictionary`, and `get`/`set` in a class |
| a box container class | A container with `Arrangement: "Horizontal"` *is* one |
| `TabStop` | `Focusable: false` is the same sentence said once |

## What is known to be missing

Written down already, with the design where there is one. Referring to one of
these is more useful than re-reporting it — say which part your application
needed and what it did instead.

| Gap | Where it is written down |
|---|---|
| A **form** bound to a table — a control that names a field and fills itself | [`docs/data-plan.md`](../data-plan.md). The records-over-a-table half exists: [`Database.Sqlite` and `Table`](library.md#database-and-table) |
| No watch, no immediate window, and no changing a value while stopped — the debugger stops, steps and **shows** what a frame holds, and that is where it ends | [`docs/debug-plan.md`](../debug-plan.md), stages 3 to 6. A loop written entirely on one line also stops only once |
| No git in the IDE — no status, no diff before committing, no stage or push | [`docs/git-plan.md`](../git-plan.md). What there is instead: the `Terminal` tab, a real shell in the project directory. The plan's core is a side-by-side diff viewer; its one open gap is below |
| A word for *do this, then that* | [`docs/async-plan.md`](../async-plan.md) |
| Packaging an application without the project tree | root [`README`](../../README.md#what-is-next) |
| No editable / autocompleting combo | [ISSUE-editable-combo](../issues/ISSUE-editable-combo.md) |
| No printer — no dialog, no copies, no preview, no control laid onto a page (a PDF **is** written: `SavePdf`) | [ISSUE-printing](../issues/ISSUE-printing.md) |
| A control that cannot say whether it can run on this build — `Video` without GStreamer (or without the GTK4 sink) is still offered by the palette | [ISSUE-video-availability](../issues/ISSUE-video-availability.md) |
| A `Fixed` container that does not stretch a `Fill` child when it itself grows — a reusable component that wants to fill its cell has to change its `Arrangement` | [ISSUE-fixed-fill-child](../issues/ISSUE-fixed-fill-child.md) |
| No container that fills the room it is given **and** scrolls once it cannot — `Grid` fills without scrolling, `Flow` scrolls without filling | [ISSUE-fill-and-scroll](../issues/ISSUE-fill-and-scroll.md) |

## One more thing

If what you are missing is not a runtime capability but a *sentence in this
documentation* — something you had to find out by trial, or that these nine files
say wrongly — that is worth reporting too, and it is cheaper to fix. Say which
file, what you expected it to tell you, and what you had to do instead.
