# Form

The window.

Every form in a project is a class that extends `Form` and a `.form` file beside
it; the runtime builds the controls, binds them to the class by name and
dispatches every event to a method. A form is also a
[`Container`](Container.md), so everything there is here too.

## Every member

| | | |
|---|---|---|
| `CancelButton` (ro) | the button Escape presses | [the keyboard](#the-keyboard) |
| `DefaultButton` (ro) | the button Enter presses | [the keyboard](#the-keyboard) |
| `FullScreen` | the window fills the screen | [how it appears](#how-it-appears) |
| `HideOnClose` | put away instead of taken apart | [showing and closing](#showing-and-closing) |
| `Icon` | the window's icon, for a task list or a dock | [how it appears](#how-it-appears) |
| `Maximized` | a **state**: reads `false` until there is a window | [how it appears](#how-it-appears) |
| `Modal` | blocks its parent | [showing and closing](#showing-and-closing) |
| `Resizable` | bounds the **user**, not the layout. Default `true` | [how it appears](#how-it-appears) |
| `Text` | the window title. **Translated** | [how it appears](#how-it-appears) |
| `Center()` | a no-op on Wayland: the compositor places windows | [how it appears](#how-it-appears) |
| `Close()` | closes it, through `Form_Close`, which may refuse | [showing and closing](#showing-and-closing) |
| `Minimize()` | a verb, because there is nothing to read back | [how it appears](#how-it-appears) |
| `Show()` | presents the window | [showing and closing](#showing-and-closing) |
| **event** `Close()` | it is closing. **Returning `true` keeps it open** | [showing and closing](#showing-and-closing) |
| **event** `Open()` | the first time it is shown | [showing and closing](#showing-and-closing) |
| **event** `Resize(width, height)` | the size GTK settled on | [how it appears](#how-it-appears) |
| **event** `ThemeChange()` | the desktop changed the theme | [how it appears](#how-it-appears) |

**And on a form**, from `rad.js`: `Controls` (ro) — every child bound to the form
by name, in creation order — `Menus` (ro), `Serialize()` for the whole file, and
`SaveForm(path)`.

## Showing and closing

| | |
|---|---|
| `Show()` | presents the window, and fires `Open` **before returning** the first time |
| `Close()` | closes it, through `Form_Close`, which may refuse |
| `Modal` | blocks its parent. Made transient for the active window on `Show()` |
| `HideOnClose` | put away instead of taken apart. **A closed form's window is destroyed**, so `Show()` on it is not a window either — it stays 0×0. Declare this, or construct the form again |
| **event** `Open()` | the first time it is shown, **before `Show()` returns**. Where a form fills itself in |
| **event** `Close()` | it is closing. **Returning `true` keeps it open** — which is where *save before closing?* lives |

**A dialog is an ordinary form.** `AskForm`, `ConfirmForm` and the IDE's other
dialogs are Bintana forms with `Modal` set, not runtime primitives — which is the
rule this whole tree is built on and the reason there is nothing to learn here
beyond what a form already is.

**Nothing has a size inside `Open`.** The window has not been laid out yet, so
measuring there measures nothing: `Timer.After(0, …)` is where a measurement
belongs, and `DefaultButton`/`CancelButton` are `null` until after that handler
for the same reason.

## The keyboard

| | |
|---|---|
| `DefaultButton` (ro) | the button Enter presses, resolved from whichever declared [`Default`](Button.md#enter-and-escape). **`null` inside `Form_Open`** |
| `CancelButton` (ro) | the button Escape presses, likewise |

A field that should press the default button on Enter says so itself with
[`ActivatesDefault`](TextBox.md#enter).

## How it appears

| | |
|---|---|
| `Text` | the window title. **Translated**. `Caption` is an alias |
| `Icon` | the window's icon, for a task list or a dock. A name the theme lacks is not shown but **is kept**, so a `.form` round-trips |
| `Resizable` | bounds the **user**, not the layout: the contents still drive the size, so a longer translation still opens it wider. Default `true` |
| `Maximized` | a **state**: reads `false` until there is a window; set before `Show()` it applies when the window appears. **Keep it out of the `.form`** |
| `FullScreen` | the same, for the whole screen |
| `Minimize()` | a verb, because GTK reports nothing about a minimised window |
| `Center()` | **a no-op on Wayland**: the compositor places windows. [`Screen`](../../llm/library.md#screen) answers how big the desktop is, which is a different question from where a window goes |
| **event** `Resize(width, height)` | the size GTK settled on — the same numbers `Bounds()` gives. Fires when the window is first given a size too |
| **event** `ThemeChange()` | the desktop changed the theme. [`Dark`](Widget.md#how-it-looks) read inside the handler is already the new answer; **it may fire twice for one change**, so a handler re-reads and restyles rather than counting |

## Menus

A form's menus are declared in its `.form` under `menus`, and every item is
reached the way a control is — `this.MnuSave` — with `Name`, `Enabled`, `Value`
and `Click([index])`. A command in several places is one
[`Action`](Widget.md#commands-menus-and-keys), named by the menu item and by the
toolbar button alike.

## What goes wrong

- **A second `Show()` opened nothing.** The window was destroyed by the close;
  declare `HideOnClose`, or build the form again.
- **A measurement inside `Form_Open` answered zero.** Nothing is laid out yet.
- **`DefaultButton` was `null`.** Same reason: it is settled after `Open`.
- **The window would not shrink.** Something in it has a floor — see
  [Widget](Widget.md#how-it-is-placed).
- **`Maximized` in the `.form` did nothing sensible.** It is a state, not a
  declaration.
- **A theme handler ran twice.** It may; re-read rather than toggling.

## See also

[`Container`](Container.md) · [`Component`](Component.md) ·
[forms.md](../../llm/forms.md), for the `.form` file and events ·
[`Widget`](Widget.md)
