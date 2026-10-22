# ISSUE: `Dialog.OpenFile` answers one path

## What the application needed

An import screen with one button: the user picks the three statements of a
month in one dialog and the application reads them all into one table. The
concrete case was a folder of spreadsheets a user chose together and expected
to see as a list before anything was read.

## What I wrote instead

A loop: `Dialog.OpenFile` once per file, each one its own dialog, with the
paths collected by hand. The user is asked the same question three times and
cannot see the other two choices while choosing the third, and a cancellation
in the middle leaves the files already picked in a variable and nothing else.

## The code I wish I could have written

```js
// one dialog, many answers, the callback last like every question here:
Dialog.OpenFiles("Open the statements", { Filters: filters }, paths => {
    for (const path of paths) Import.Read(path)
})
```

## Why the existing words do not cover it

`Dialog.OpenFile(title, [options], cb)` answers one path: the callback takes
one string (runtime/src/bta_sys.c:4426). `Dialog.SaveFile` is somewhere to
write and `Dialog.SelectFolder` is a directory; neither is several files that
exist. The runtime's own dialog library, `lib/dialog`, ships `Confirm` and
`AskText` — questions a person answers, not a file chooser. There is no way
to ask the question once and be told the whole list.

## Prior art

GTK4's `GtkFileDialog` has `gtk_file_dialog_open_multiple`, which answers a
`GListModel` of files; GTK4 replaced `GtkFileChooserDialog`, whose
`select_multiple` did this. VB6 `CommonDialog` with `MultiSelect = True`.
.NET `OpenFileDialog.Multiselect`. Delphi `TOpenDialog` with
`ofAllowMultiSelect`. Qt `QFileDialog::getOpenFileNames`.

## How much it mattered

It works, but a part of it is noticeably worse: "open these three spreadsheets"
is a loop, and a loop opens one dialog per file.
