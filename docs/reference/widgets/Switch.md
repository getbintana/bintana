# Switch

A setting that takes effect at once.

The control for *this is so now*: a mode, a preference, something the program
acts on the moment it is moved. It has **no caption** — the words beside it are a
[`Label`](Label.md), which is how every settings page here is built.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Active` | whether it is on | [on or off](#on-or-off) |
| **event** `Click()` | it was moved | [on or off](#on-or-off) |

## When it is not a `Switch`

- **The dialog has an OK button** — then the setting is not taking effect at
  once, and it is a [`CheckButton`](CheckButton.md).
- **It belongs in a toolbar** — [`ToggleButton`](ToggleButton.md).
- **There are five of them and only one may be on** — a `Group` of check
  buttons, or a [`ComboBox`](ComboBox.md).

## On or off

| | |
|---|---|
| `Active` | whether it is on. Assigning it **raises `Click`**, the same as the user moving it |
| **event** `Click()` | it was moved — or assigned |

```json
{ "type": "Label",  "name": "LblDark", "properties": { "Text": "Dark theme" } },
{ "type": "Switch", "name": "SwDark" }
```

```js
SwDark_Click() { this.applyTheme(this.SwDark.Active); }
```

**The label is the control's name to the user**, so it is the one that carries
the prose and the one a translator sees. A switch with nothing beside it is a
switch nobody can read.

## What goes wrong

- **Setting `Active` from code ran the handler.** It does; guard while filling a
  form in.
- **The user pressed it and nothing happened until OK.** Then it should have been
  a check button.
- **It has no caption.** By design; put a `Label` beside it.

## What it does not do

- **No text, no icon, no third state.**

## See also

[`CheckButton`](CheckButton.md) · [`ToggleButton`](ToggleButton.md) ·
[`Label`](Label.md)
