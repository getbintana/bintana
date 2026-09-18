# Dialog

Asking the user for a file, a folder or a colour — with the desktop's own
choosers.

## Every member

| | | |
|---|---|---|
| `Color(title, current, cb)` | the colour chooser | [a colour](#a-colour) |
| `OpenFile(title, [options], cb)` | choose an existing file | [a file or a folder](#a-file-or-a-folder) |
| `SaveFile(title, [options], cb)` | choose where to write one | [a file or a folder](#a-file-or-a-folder) |
| `SelectFolder(title, [options], cb)` | choose a directory | [a file or a folder](#a-file-or-a-folder) |

## A file or a folder

| | |
|---|---|
| `OpenFile(title, [options], cb)` | the file chooser, for something that exists |
| `SaveFile(title, [options], cb)` | the same, for somewhere to write |
| `SelectFolder(title, [options], cb)` | for a directory |

| Option | |
|---|---|
| `Folder` | where the chooser opens |
| `Name` | the name it starts on |
| `Filters` | `[label, patterns]` pairs, patterns space separated. The first is the one it opens on |

```js
Dialog.SaveFile(Locale.Text("Save as"),
    { Folder: Application.Directory, Name: "note.txt",
      Filters: [[Locale.Text("Text"), "*.txt"], [Locale.Text("All files"), "*"]] },
    (path) => File.Save(path, this.Editor.Text));
```

**The callback is required — passing none throws — and it is not called when the
user cancels.** That is the whole ergonomics of this object: no caller has to
tell *cancelled* from *chose nothing*, and there is no `if (!path) return;` to
forget. A filter's label is prose you own: wrap it in
[`Locale.Text`](Locale.md).

## A colour

| | |
|---|---|
| `Color(title, current, cb)` | the desktop's colour chooser, opening on `current`. Answers an `rgb(…)`/`rgba(…)` string — **exactly what [`Background`](../widgets/Widget.md#how-it-looks) and `Painter.Color` take** |

For a colour the user picks *often*, the control is
[`ColorButton`](../widgets/ColorButton.md), which is this chooser with a swatch
in front of it.

## What goes wrong

- **Nothing happened on cancel.** By design: the callback is not called.
- **The code after the call ran first.** It is a callback, not a return value —
  the chooser is a window, and the program keeps running while it is open.
- **The filter showed nothing.** The pattern is space separated inside one
  string: `"*.png *.jpg"`, not an array.
- **The label came out in English in a Spanish build.** It is prose: `Locale.Text`.

## What it does not do

- **No message boxes**, which are [`Message`](Message.md)'s, and no dialogs of
  your own — those are ordinary [`Form`](../widgets/Form.md)s with `Modal`, which
  is what `AskForm` and `ConfirmForm` in the IDE are.
- **No printer dialog**, because it is not asked for here: the print dialog
  belongs to what is being printed, and it is
  [`DrawingArea.Print`](../widgets/DrawingArea.md) that opens it — over the
  same `Draw` that paints the screen. `Report` and `Markdown` have their own
  `Print` over that.

## See also

[`File`](File.md) · [`Message`](Message.md) ·
[`ColorButton`](../widgets/ColorButton.md) · [`Form`](../widgets/Form.md)
