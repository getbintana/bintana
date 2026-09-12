# TextEditor

The plain multi-line field.

Observations, a note, a description, a log pane: the text a
[`TextBox`](TextBox.md) cannot hold, since a `GtkEntry` has no notion of a
newline at all.

It is an [`Editor`](Editor.md), and everything it can do is there. What is its
own is what it **arrives as**: wrapping, in the theme's font, with no gutter and
nothing highlighted.

## Every member

| | | |
|---|---|---|
| `Text` | the text. **Translated** | [the one thing that is its own](#the-one-thing-that-is-its-own) |

Everything else is [`Editor`](Editor.md)'s — `Append`, `Insert`, `Clear`,
`Modified`, `ReadOnly`, `Wrap`, `Line`, `Column`, `Selection`, `GotoLine`,
`Select`, `Undo`, `Redo`, `CanUndo`, `CanRedo`, and the `Change` and `Cursor`
events — and everything above that is [`Widget`](Widget.md)'s.

## The one thing that is its own

`Text` is listed here, and **not** on [`SourceEditor`](SourceEditor.md), because
it is **prose**: a form may declare a starting note, and that goes through the
catalogue like any caption.

That is the whole reason the two editors are siblings under an abstract class
rather than one extending the other: the declaration of which properties hold
prose accumulates down a class chain, so a source editor inheriting this row
would put a line of somebody's code in a `.po` file.

## What it is good for

- **A note, a description, an address**: a field with more than a line in it.
- **A log pane**: `ReadOnly` plus [`Append`](Editor.md#what-is-in-it), which
  scrolls to the end by itself. That is the control to show what a child process
  printed — see [`Exec`](../../llm/library.md#exec) — rather than a
  [`Terminal`](Terminal.md), which is for something interactive.

## What goes wrong

- **A starting text came back translated oddly.** `Text` is prose: text that is
  *data* is assigned from code.
- **The log jumps to the end while somebody is reading it.** `Append` scrolls;
  a pane that should stay put appends with `Insert` at a mark of your own, or
  simply stops appending while the user has scrolled up.

## See also

[`Editor`](Editor.md) · [`SourceEditor`](SourceEditor.md) ·
[`TextBox`](TextBox.md) · [`Terminal`](Terminal.md)
