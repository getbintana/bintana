# AskText

A prompt for one line of text — the "what should it be called?" dialog. Part of
[`lib/dialog`](../../llm/dialog.md); read that for the two classes together and
for why they are two.

```js
AskText.Prompt("Name for the note", (name) => { this.rename(name); },
               { Title: "Notes", Initial: this.old });
```

## Every member

| Member | What it is | More |
|---|---|---|
| `Prompt(label, onAccept, [options])` | the whole dialog. The callback takes the trimmed text and, when a checkbox was asked for, whether it was ticked | [asking](#asking) |
| `Text` | the window's title, a string. `""` from `prompt` unless `Title` says otherwise | [asking](#asking) |
| `Modal` | `true` while the dialog is up | [asking](#asking) |

Everything on `Widget` and on `Form` is on it too.

## Asking

| Member | |
|---|---|
| `Prompt(label, onAccept, [options])` | builds the dialog, shows it, focuses the field and selects what is in it, and answers the shown window |
| `Text` | the window's title. **`""` from `prompt` when no `Title` is given** |
| `Modal` | `true` from `Show()` |

`prompt`'s options:

| Option | |
|---|---|
| `Title` | the window's title |
| `Initial` | what the field starts with, **selected**. `""`. It is an option and not a second positional because it has a default, and a positional with a default is a positional somebody passes `undefined` to |
| `Option` | `{ Text, Checked }` — a checkbox under the field, hidden unless this is given. Its state arrives as the callback's **second** argument |

**The callback is last and the options come before it**, as with every question
in the runtime: `Dialog.OpenFile(title, options, callback)` and
`Printer.Send(area, options, callback)`.

## What it will not do for you

- **`AskText.Prompt(...)` does not answer.** Nothing comes back; the answer is a
  call. A caller that needs the value in a `return` has to block, and nothing in
  this runtime can without freezing the window.
- **Cancelling answers nothing rather than an empty string**, and a dialog that
  closes itself on an empty field is a dialog a mistyped Enter throws away. The
  window stays up with the field empty.
- **One line.** A paragraph is `TextEditor` in a form of your own; a file is
  `Dialog.OpenFile`, which is the runtime's.

## Enter, Escape, and the two properties that say it

**They are declared in the `.form`, not handled in code.** `BtnOk` is `Default`,
`BtnCancel` is `Cancel` and `TxtValue` is `ActivatesDefault` — which is what makes
Enter **in the field** press the button rather than raise `Activate`, and it is
why there is no `Activate` handler here to forget. Three dialogs in this tree
used to check for `"Escape"` in `Form_KeyPress` character for character.

This is the opposite of [`Confirm`](Confirm.md) on purpose, and the difference is
the design: a question that finishes typing should let Enter finish it, and a
question that destroys something must not let Enter do that. **Neither is a
flag**, because `Default` is a declaration in a `.form` and a form cannot know
which question it is being asked.

**The offered value is selected, and the selection is the point**: a caret at the
end of it makes the first keystroke an edit rather than a replacement, and a
rename dialog that appends to the old name is a rename dialog nobody trusts.
Focus first, then the selection — selecting is a call that needs the field to be
focused to mean anything — and both **after** `Show()`.

## `Option`: one dialog and not two

A question about *what is being created* belongs beside the field that names it,
and Cancel then means "not at all" rather than "not that way". The checkbox is a
`Visible: false` control in the `.form` and is shown only when `Option` is given,
so a project that does not use it has **no disabled control on screen to
explain**.

Asking for it moves the two buttons down and grows the window by the same 34
pixels. That is *before* `Show()`, so it is the design size being decided rather
than a resize being reacted to — and the buttons' `VAlign: "End"` is not what
does it and is not redundant with it: what the anchor covers is the layout
passing over afterwards. The dialog is `Resizable: false`, so there is no resize
to cover, and the anchor is still what holds them at the bottom.

## The labels are prose, and who translates them

`static TextProperties = ["BtnOk", "BtnCancel"]` — the two labels this class
owns, and deliberately **not** the prompt or the checkbox text: those are the
caller's, a literal at the call site in the project's own `.js`, which is where
the extractor looks.

**The declaration puts the two through the catalogue when the `.form` loads, and
that is half the promise.** The other half does not reach a library: the
extractor walks the *project*, and this `.form` is in `lib/`, so `"OK"` and
`"Cancel"` have no msgid in any catalogue. A project that wants them translated
**passes its own words**, which are a literal in the project's `.js`. That is
where a caller's prose lives, and it is not a workaround.

## What it does not do

- **No validation.** The callback receives whatever is in the field, trimmed, and
  an empty field answers nothing. Whether a name is *good* is a `Field` in a
  `Record` or a check in the caller — see
  [`llm/library.md`](../../llm/library.md#record).
- **Not resizable, and a fixed size.** A prompt is not a window to arrange.
