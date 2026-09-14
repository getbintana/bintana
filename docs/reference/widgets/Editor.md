# Editor

A buffer of text with a cursor in it.

Abstract: the class [`TextEditor`](TextEditor.md) and
[`SourceEditor`](SourceEditor.md) share. It is written once because GTK's own
hierarchy is the same shape — a `GtkSourceView` **is** a `GtkTextView` — and
everything here works the same in both.

**You never make one.** Everything on [`Widget`](Widget.md) is here too.

## Every member

| | | |
|---|---|---|
| `CanRedo` (ro) | whether there is anything to redo | [undo](#undo) |
| `CanUndo` (ro) | whether there is anything to undo | [undo](#undo) |
| `Column` (ro) | the cursor's column | [the cursor](#the-cursor) |
| `Line` (ro) | the cursor's line, counting from 1 | [the cursor](#the-cursor) |
| `Modified` | the editing flag | [what is in it](#what-is-in-it) |
| `ReadOnly` | shown but not editable | [what is in it](#what-is-in-it) |
| `Selection` (ro) | the selected text | [the cursor](#the-cursor) |
| `Text` | everything in the buffer | [what is in it](#what-is-in-it) |
| `Wrap` | wrap long lines | [what is in it](#what-is-in-it) |
| `Append(text)` | at the end, scrolling there | [what is in it](#what-is-in-it) |
| `Clear()` | empties it | [what is in it](#what-is-in-it) |
| `GotoLine(line)` | puts the cursor there and scrolls to it | [the cursor](#the-cursor) |
| `Insert(text)` | at the cursor | [what is in it](#what-is-in-it) |
| `Redo()` | one step forward | [undo](#undo) |
| `Select(line, [column], [length])` | selects from there | [the cursor](#the-cursor) |
| `Undo()` | one step back | [undo](#undo) |
| **event** `Change()` | the value changed, **including from code** | [what is in it](#what-is-in-it) |
| **event** `Cursor()` | the cursor moved | [the cursor](#the-cursor) |

## What is in it

| | |
|---|---|
| `Text` | everything in the buffer. Assigning replaces it all and **raises `Change`** |
| `Append(text)` | at the end, **scrolling there**, whatever the cursor was doing — which is what a log pane wants and what makes a read-only editor the right control for one |
| `Insert(text)` | at the cursor. The selection is left alone, so on a selected word this lands after it rather than replacing it |
| `Clear()` | empties it |
| `Wrap` | wrap long lines. Default `true` on a [`TextEditor`](TextEditor.md), `false` on a [`SourceEditor`](SourceEditor.md), which is the right default for each |
| `ReadOnly` | shown but not editable. **The program can still write to it**, which is what a log pane needs |
| `Modified` | the editing flag. **Clear it after saving**: nothing else does, and it is what a window title's asterisk and a *save before closing?* are read from |
| **event** `Change()` | the text changed — typed, pasted, or assigned |

## The cursor

| | |
|---|---|
| `Line` (ro) | the line the cursor is on, **counting from 1** |
| `Column` (ro) | the column it is at |
| `Selection` (ro) | the selected text, `""` for none |
| `GotoLine(line)` | puts the cursor there and scrolls to it |
| `Select(line, [column], [length])` | selects from there. A column past the end of the line is the end of the line |
| **event** `Cursor()` | the cursor moved. `Line` and `Column` say where |

`Line`/`Column` in a status bar is `Cursor` plus two reads — and it is the one
event that fires often, so what hangs off it should be cheap.

**`GotoLine` and `Select` work in a view that has not been drawn yet**, which is
the case that matters: opening a file in a tab and jumping to a line in it happen
in the same breath, and the view has had no frame in which to be laid out. Both
reveal the place through a text *mark*, so the scroll is carried out on the frame
there is one. A jump that scrolled nowhere and left the cursor in the right place
is what that avoids.

## Undo

| | |
|---|---|
| `Undo()` | one step back |
| `Redo()` | one step forward |
| `CanUndo` (ro) | whether there is anything to go back to — what an *Undo* item's `Enabled` is read from |
| `CanRedo` (ro) | the same, forwards |

The history is the widget's, so it survives everything except the widget being
destroyed. That is why the IDE gives every open file **its own editor** rather
than swapping the text of one: with a shared editor, undo crosses files.

## See also

[`TextEditor`](TextEditor.md) · [`SourceEditor`](SourceEditor.md) ·
[`TextBox`](TextBox.md), for one line
