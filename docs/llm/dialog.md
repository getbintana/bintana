# Dialog — the two questions every program asks

Two classes, both `Form` subclasses, and both are the answer to a gap the runtime
declines to close in C: **GTK4's dialogs are fire-and-forget, so there is no
blocking `MsgBox`**, and [`issues.md`](issues.md) records the answer as *"a
question is a form"*. These are those forms, shipped, so a project writes one call
instead of a window.

```json
{ "name": "Notes", "startup": "MainForm", "uses": ["dialog"] }
```

```js
Confirm.Ask("Delete this note?", () => { this.remove(); },
            { Title: "Notes", Accept: "Delete" });

AskText.Prompt("Name for the note", (name) => { this.rename(name); },
               { Title: "Notes", Initial: this.old });
```

**A new project already has `uses: ["dialog"]`** — the IDE's project wizard ticks
it, and a console project does not, because a console project has no display. It
is a default and not a requirement: the key can be dropped, and a project that
wants a different word for a button says so in the call.

**Both callbacks are last and both options come before them**, which is the shape
of every question in the runtime — `Dialog.OpenFile(title, options, callback)`,
`Printer.Send(area, options, callback)`. A question is the one place where
reading order matters: what is asked first, what happens next last.

**A callback runs on the answer and on nothing else.** Cancelling, and closing
the window with the X, both answer nothing — so no caller has to tell *no* from
*the window went away*, and neither class needs a flag of its own. The one
exception is deliberate and is `AskText`: cancelling a prompt answers nothing
rather than an empty string, so a mistyped Enter cannot throw the work away.

## Why two classes and not one with a flag

Because **Enter means opposite things in the two**, and it is two properties that
say it:

| | `Confirm` | `AskText` |
|---|---|---|
| Enter in the window | **cancels** | **accepts** |
| `BtnOk` / `BtnAccept` is `Default` | no | yes |
| the field is `ActivatesDefault` | — | yes |
| focus after `Show()` | the cancel button | the field, all selected |
| callback's second argument | — | the checkbox, when asked for |

`Confirm.Ask` sets the focus to **Cancel on purpose**: a question whose answer
destroys something must not let a reflexive Enter destroy it. `AskText.Prompt`
focuses the field and selects what is in it, because the offered value is what
typing is meant to replace. Neither is a flag, and neither could be: making one
button `Default` is a declaration in a `.form`, and a form cannot know which
question it is being asked.

**Enter and Escape are declared in the `.form` and not handled in code.** `Default`,
`Cancel` and `ActivatesDefault` are what make Enter in the *field* press the
button rather than raise `Activate`, and there is therefore no `Activate`
handler to forget. Three dialogs in this tree used to check for `"Escape"` in
`Form_KeyPress` character for character.

## Confirm

| Member | |
|---|---|
| `Ask(message, onConfirm, [options])` | builds the dialog, shows it, focuses the cancel button, and answers the shown window. **Returning it is what lets a caller keep a handle** — to move it, or to close it from somewhere else — and almost no caller needs to. `message` is the question; the callback takes no argument, because the only thing it can mean is yes |
| `Text` | the window title. **Translated**. `Caption` is an alias |
| `Modal` | blocks its parent. Made transient for the active window on `Show()` |

| Option | |
|---|---|
| `Title` | the window's title. **A modal with an empty title bar looks like a bug**, and there is no design-time default here |
| `Accept` | what the accepting button says — **the verb**, `"Delete"` `"Discard"` `"Overwrite"`, not `"OK"`. A destructive question asked with a neutral word is a question that was not believed. `"OK"` |
| `Cancel` | the other button's label, for the catalogue or for a program that words it. `"Cancel"` |

- `BtnAccept` carries `Style: "destructive-action"`, **declaratively**: the
  class declares the *kind* of question and the theme decides what that looks
  like. A caller that reassigns `BtnAccept.Style` gets an ordinary button.
- `Resizable: false`, and a fixed size. A question is not a window to arrange.

## AskText

| Member | |
|---|---|
| `Prompt(label, onAccept, [options])` | the whole dialog. The callback takes the trimmed text and, when a checkbox was asked for, whether it was ticked |
| `Text` | the window title. **Translated**. `Caption` is an alias |
| `Modal` | blocks its parent. Made transient for the active window on `Show()` |

| Option | |
|---|---|
| `Title` | the window's title |
| `Initial` | what the field starts with, selected. `""`. **It is an option and not a second positional because it has a default**, and a positional with a default is a positional somebody passes `undefined` to |
| `Option` | `{ Text, Checked }` — a checkbox under the field, hidden unless this is given. Its state arrives as the callback's **second** argument |

**One dialog and not two, for `Option`:** a question about *what is being
created* belongs beside the field that names it, and Cancel then means "not at
all" rather than "not that way". The checkbox is a `Visible: false` control in
the `.form` and is only shown when `Option` is given, so a project that does not
use it has no disabled control on screen to explain. Asking for it moves the two
buttons down and grows the window by the same 34 pixels — which is *before*
`Show()`, so it is the design size being decided rather than a resize reacted to.

## What this library does not do

- **It does not promise the message is prose the catalogue can translate.** A
  library's own `.form` is not in the project, and the extractor walks the
  project — so `"Cancel"` and `"OK"` have no msgid in any catalogue. Declaring
  `static TextProperties` puts them through the catalogue at load, which is half
  the promise, and a project that wants them translated **passes its own words**:
  `{ Accept: "Delete" }` at the call site is a literal in the project's `.js`,
  which is exactly where the extractor looks. The same is true of `message`,
  `label` and `Option.Text`, and it is not a gap in this library — a caller's
  prose is a caller's to translate.
- **It does not answer.** There is no `Confirm.Ask(...)` that gives back `true`.
  A callback that may not run is a promise about order, and a call that blocks
  for an answer is the thing GTK4 does not have.
- **It does not do a list.** A dialog with three or four buttons in a row is a
  `Popover` or a `ListBox` next to a button, and choosing one of four is not a
  question. `examples/composites/Choice.js` is the one that is written.
- **It is not a `Dialog` and does not touch one.** `Dialog.OpenFile` and
  `Dialog.Color` are the runtime's, and this library is beside them rather than
  over them.
