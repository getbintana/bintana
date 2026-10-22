# ISSUE: no formatter and no multiple cursors in the source editor

## What the application needed

The IDE is a Bintana project, and the first thing a person does in it is edit
code. Two gestures every code editor has and this one does not: select a block
and press a key, and the block is brought to the file's own indentation rule;
and put the caret on a word, and every other occurrence of that word becomes a
caret too. The concrete case was 400-line files written by three people.

## What I wrote instead

Nothing — this part is not implemented. The formatting of a file is whatever
the author typed, and a file with mixed indentation stays mixed. A project
that wants one rule runs an external tool over its files by hand, and the IDE
knows nothing about it.

## The code I wish I could have written

```js
// The IDE has no privileged API, so the gesture is a verb the runtime's
// editor would carry and the editor tab would call:
//   Editor.Format(Indent: 4, Wrap: 80)    // the file, brought to the rule
//   Editor.Cursors(Editor.Matches(word))  // every other occurrence a caret
```

## Why the existing words do not cover it

`SourceEditor`'s members include `InsertSnippet`, `ShowMap`, `Fold`, `FoldAll`,
`Unfold`, `UnfoldAll`, `FoldRanges`, `Folds` and `Folded`, and `api.json` lists
the whole of them: there is no `Format` and no `Cursors`.
`runtime/src/bta_editor.c:65` sets `gtk_source_view_set_auto_indent(sv, TRUE)`
and leaves it there — GtkSourceView 5 offers `GtkSourceFormatter`, which
indents and does not reflow, and `GtkSourceBuffer`'s `change-case`. The IDE's
"Tidy" command (`ide/forms/MainForm.form:589`, *"Tidy files into folders..."*)
sorts files into folders; it does not format them. A web formatter is out of
reach: the runtime has no web view, and there is no WebKit under `runtime/`.

## Prior art

VS Code's format-on-save. Lazarus's `Ctrl+Shift+F` through `fpCodeFormatter`
and `SynFPC`. Delphi's `Ctrl+Shift+F` through a third-party formatter such as
Delphi Code Formatter. .NET's `dotnet format` and ReSharper. Qt Creator's
clang-format integration. GTK4 itself: `GtkSourceView` has `GtkSourceFormatter`
(indent only, no reflow) and `GtkSourceBuffer` has `change-case`.

## How much it mattered

It works, but a part of it is noticeably worse: the formatting of a file is
whatever the author typed, so every file in a project is read in the habit of
whoever typed it.
