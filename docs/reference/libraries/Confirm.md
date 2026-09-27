# Confirm

A yes/no for the one thing in a program that cannot be undone. Part of
[`lib/dialog`](../../llm/dialog.md); read that for the two classes together and
for why they are two.

```js
Confirm.Ask("Delete this client?", () => { this.remove(); },
            { Title: "Clients", Accept: "Delete" });
```

## Every member

| Member | What it is | More |
|---|---|---|
| `Ask(message, onConfirm, [options])` | the whole dialog. `message` is the question; `onConfirm` takes no argument, because the only thing it can mean is yes | [asking](#asking) |
| `Text` | the window's title, a string. `""` from `ask` unless `Title` says otherwise | [asking](#asking) |
| `Modal` | `true` while the dialog is up, and it never answers otherwise | [asking](#asking) |

Everything on `Widget` and on `Form` is on it too, and the rest of this page is
about the three above.

## Asking

| Member | |
|---|---|
| `Ask(message, onConfirm, [options])` | builds the dialog, shows it, focuses the cancel button, and answers the shown window. **Returning it is what lets a caller keep a handle** — to move it, or to close it from somewhere else — and almost no caller needs to |
| `Text` | the window's title. **`""` from `ask` when no `Title` is given**, because a modal with an empty title bar looks like a bug and there is no design-time default to fall back on |
| `Modal` | `true` from `Show()`. A question asked over a window somebody is still typing in is a question about the wrong thing |

`ask`'s options:

| Option | |
|---|---|
| `Title` | the window's title |
| `Accept` | what the accepting button says, and it should be **the verb** — `"Delete"`, `"Discard"`, `"Overwrite"` — rather than `"OK"`. A destructive question wearing a neutral word is a question that was not believed the first time. `"OK"` |
| `Cancel` | the other button's label, when a project words it differently or has it in a catalogue. `"Cancel"` |

**The callback is last and the options come before it**, as with every question
in the runtime: `Dialog.OpenFile(title, options, callback)` and
`Printer.Send(area, options, callback)`. What is asked first and what happens
next last is the reading order a question needs.

## What it will not do for you

- **`Confirm.Ask(...)` does not answer.** There is no `true` coming back, because
  a callback that may not run is a promise about order and a call that blocks for
  an answer is the thing GTK4 does not have. Wrap the body, or offer the action
  somewhere that does not need a question.
- **The callback runs on the accepting button and on nothing else.** Cancelling
  and closing the window with the X both answer nothing, so no caller has to tell
  *no* from *the window went away*.
- **It does not ask anything that is not a yes/no.** Three or four answers is a
  `ListBox` beside a button.

## Two properties, and they are the design

**Nothing here is `Default`.** Enter must not be able to destroy something, so
`ask` puts the focus on `BtnCancel` after `Show()` and `Cancel: true` on that same
button is what makes Escape mean no. `AskText` beside it is the other way round —
there Enter is the answer — and the two cannot be one class with a flag, because
`Default` is a declaration in a `.form` and a form cannot know which question it
is being asked.

`SetFocus` is called **after** `Show()`, not before: focus before a window is on
screen is the `Form_Open` trap, and the dialog's own window is what takes it.

## The label is prose, and who translates it

`static TextProperties = ["BtnAccept", "BtnCancel"]` — the two labels this class
owns, and deliberately **not** the message: a caller's message is a literal at
the call site in the project's own `.js`, which is where the extractor looks, and
declaring it here as well would be two msgids for one string.

**The declaration puts the two through the catalogue when the `.form` loads, and
that is half the promise.** The other half does not reach a library: the
extractor walks the *project*, and this `.form` is in `lib/`, so `"Cancel"` and
`"OK"` have no msgid in any catalogue. A project that wants them translated
**passes its own words** — `{ Accept: "Delete" }` at the call site is a literal
in the project's `.js`. That is not a workaround; it is where a caller's prose
lives.

## What it does not do

- **No `Style` of its own beyond `destructive-action`**, which is declarative:
  the class declares the *kind* of question and the theme decides what it looks
  like. A caller that assigns `BtnAccept.Style` gets an ordinary button.
- **Not resizable, and a fixed size.** A question is not a window to arrange.
- **Not a `Dialog` and does not touch one.** `Dialog.OpenFile` and
  `Dialog.Color` are the runtime's, and this is beside them.
