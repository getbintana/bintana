# ISSUE: an editor cannot turn a character offset into a line

## What the application needed

To take the position a `Regex` match reports -- which is a character offset into
the text -- and put the cursor there, or draw a mark beside it. Every search
result, every compiler complaint routed back to a file, every *go to this
declaration*.

## What I wrote instead

The conversion, ten times, in four shapes:

```js
lineOf(text, index) { return text.slice(0, index).split("\n").length; }
```

`Live.js:162` (`lineAt` -- with a comment at `158` explaining it cannot be
shared because `Navigator` already declares the same name at top level),
`Navigator.js:237` (`lineAt` again), `Names.js:259` (`lineOfIndex`),
`FormFiles.js:26` (`lineOf`), and five inline
`src.slice(0, m.index).split("\n").length` in `Strings.js` at `260`, `308`,
`331`, `350` and `371`. `MainForm.js:1963` is the inverse --
`editor.Text.split("\n")[editor.Line - 1]` -- for want of *the text of line n*.

Each of them copies the whole prefix of the file to count newlines in it.

## The code I wish I could have written

```js
this.Editor.GotoLine(this.Editor.LineAt(m.index));
const here = this.Editor.Offset;          // the cursor, as a character
```

## Why the existing words do not cover it

`TextEditor` and `SourceEditor` publish `Line`, `Column`, `Select` and
`GotoLine`, all of which speak in **lines**, while everything that *finds*
something in text -- `Regex.Matches`, `indexOf`, `Bytes` -- speaks in
**offsets**. There is no verb that crosses, so every caller crosses it by hand
with the one expression JavaScript makes available, which allocates a copy of
the file to count separators in it.

The editor knows the answer without counting: a `GtkTextBuffer` has an iter at
an offset and that iter carries its line.

## Prior art

`GtkTextBuffer.get_iter_at_offset` is the call this is asking to publish.
Scintilla has `LineFromPosition` / `PositionFromLine`. .NET's `RichTextBox` has
`GetLineFromCharIndex`. VS Code's document API converts both ways. It is one of
the few things every editor component agrees on.

## How much it mattered

Ten sites and four spellings of one function, one of which carries a comment
about why it could not be shared -- which is the sentence that says a runtime
verb was wanted. Nothing is broken today; what it costs is a copy of the file
per search hit, and four places to fix when somebody notices that `\r\n` counts
differently.
