# Button

A press.

The control a form is built around: it says what it does, it is pressed, and a
method on the form runs. Everything else about it — how it looks, whether Enter
reaches it, whether it is available — is a property, and three of those four are
the theme's or the form's rather than this control's.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Cancel` | Escape on this form presses it | [Enter and Escape](#enter-and-escape) |
| `Default` | Enter on this form presses it | [Enter and Escape](#enter-and-escape) |
| `Icon` | an icon name from the theme | [what it says](#what-it-says) |
| `Text` | the caption. **Translated** | [what it says](#what-it-says) |
| `Click()` | presses it from code, handler and all | [pressing it](#pressing-it) |
| **event** `Click()` | it was pressed | [pressing it](#pressing-it) |

`Caption` is an alias of `Text`, so a form may declare either.

## When it is not a `Button`

- **It stays in** — a setting that is on or off: a
  [`ToggleButton`](ToggleButton.md) if it should look like a button, a
  [`CheckButton`](CheckButton.md) if it should look like a box to tick, a
  [`Switch`](Switch.md) if it takes effect at once.
- **It is an address** — [`LinkButton`](LinkButton.md), which hands the URI to the
  desktop and looks like a link.
- **The same command is in three places** — still buttons, all naming one
  [`Action`](Widget.md#commands-menus-and-keys): the toolbar, the menu and the
  context menu then share one answer about whether it is available.
- **It drops a menu** — a button with a `Menu` and `PopupMenu(x, y)` in its
  `Click`; see [Widget](Widget.md#commands-menus-and-keys).

## On a form

```json
{ "type": "Button", "name": "BtnSave",
  "properties": { "X": 8, "Y": 8, "Width": 90, "Height": 32,
                  "Text": "Save", "Icon": "document-save-symbolic",
                  "Default": true, "Style": "suggested-action" } }
```

```js
BtnSave_Click() { this.save(); }
```

**The handler is found by name**: `BtnSave` raises `Click` at `BtnSave_Click` on
the form that owns it. Nothing is connected; renaming the control renames the
handler.

## What it says

| | |
|---|---|
| `Text` | the caption. **Translated** — a button declared in a `.form` goes through the catalogue |
| `Icon` | an icon name from the theme. With `Text` it builds the box itself — icon, then caption; alone it gets the icon-button treatment, which is the square toolbar shape. **A name the theme cannot draw is dropped in silence**, so a button that came out bare is usually a misspelt icon |

`Application.HasIcon(name)` is how to ask before trusting a name, and the pattern
this tree uses everywhere is a list of candidates, the desktop's own first and a
shipped one last.

**The looks are `Style`, not a property here.** `"suggested-action"` is the
accented one, `"destructive-action"` the dangerous one, `"flat"` the toolbar one,
`"circular"` a round one, `"pill"` a rounded one — see
[Widget](Widget.md#how-it-looks). A button that is merely *the default* is a
keyboard fact, and dressing it as the suggested action is a separate decision you
also have to make.

## Enter and Escape

| | |
|---|---|
| `Default` | Enter anywhere on this form presses it — the keyboard only, with no effect on how it looks |
| `Cancel` | Escape on this form presses it. **Without one, Escape does nothing at all**: a dialog that cannot be dismissed with Escape is a dialog somebody will complain about |

A form has one of each. **Declaring two is one claim**: the form settles on a
single button and the other reads its `Default` back as `false` — measured with
two, where the first one on the form kept it. The form publishes what it settled
on as `DefaultButton` and `CancelButton`, and both are `null` inside `Form_Open`,
because they are resolved after it.

**A field that should press it on Enter says so itself**: `ActivatesDefault` on a
[`TextBox`](TextBox.md) sends Enter to the default button *instead of* raising its
own `Activate`. That is the pair to reach for in a dialog — a name field and an
OK button — and it is why `AskForm` in the IDE has no `TxtValue_Activate`.

## Pressing it

| | |
|---|---|
| `Click()` | presses it from code: the handler runs exactly as if the user had, once per call |
| **event** `Click()` | it was pressed — by the mouse, by the keyboard, by its `Shortcut`, by an `Action`, or by `Click()` |

**One place decides what a press does.** A button's handler is the method the
menu item, the shortcut and the toolbar button should all end up in — through an
`Action` when the command is in several places, or by calling the same method
when it is not. Two copies of the work is how a menu comes to do slightly less
than the button beside it.

## What goes wrong

- **Nothing happens when it is pressed.** The handler's prefix is not the
  control's `Name`, or the button is inside a component and the handler was
  written on the wrong form.
- **It is greyed out and `Enabled = true` does not help.** It has an `Action`,
  and the command decides; see
  [Widget](Widget.md#commands-menus-and-keys).
- **The icon is missing.** The theme does not have that name, and a name it
  cannot draw is dropped without a word. Ask `Application.HasIcon`.
- **Enter does nothing in a dialog.** No button declares `Default`, or the field
  with the focus is claiming Enter — `ActivatesDefault` on it is the fix.
- **Escape does nothing.** No button declares `Cancel`.
- **Both buttons wanted to be the default.** Only one gets it; the other reads
  back `false`.

## What it does not do

- **It does not stay in.** [`ToggleButton`](ToggleButton.md).
- **No repeat while held**, no long press, no double click of its own — a
  `DblClick` is [`Widget`](Widget.md#the-mouse-and-the-keyboard)'s and arrives on
  top of the ordinary `Click`.
- **No menu of its own.** `Menu` plus `PopupMenu` is the shape, and it is
  `Widget`'s.

## See also

[`ToggleButton`](ToggleButton.md) · [`CheckButton`](CheckButton.md) ·
[`Switch`](Switch.md) · [`LinkButton`](LinkButton.md) ·
[Widget](Widget.md#commands-menus-and-keys), for `Action`, `Shortcut` and `Menu`
