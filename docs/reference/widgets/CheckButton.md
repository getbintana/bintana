# CheckButton

A box one ticks — or, with a `Group`, one of an exclusive set.

**There is no `RadioButton`**, and that is not an omission: GTK4 removed it,
because belonging to a group is the whole of what makes a control round, makes
the set exclusive and makes a second click leave it on. A check button with a
`Group` *is* a radio.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Active` | whether it is ticked | [on or off](#on-or-off) |
| `Group` | empty is a check box; a name makes it a radio | [one of a set](#one-of-a-set) |
| `Text` | the caption. **Translated** | [on or off](#on-or-off) |
| **event** `Click()` | it was pressed | [on or off](#on-or-off) |

## Which of the three is this one

| | reach for it when |
|---|---|
| **`CheckButton`** | **an option in a dialog the user confirms with OK, or one of an exclusive set** |
| [`Switch`](Switch.md) | the setting takes effect **at once** — a preference, a mode |
| [`ToggleButton`](ToggleButton.md) | it belongs in a toolbar and should look like a button that stays in |

The line between the first two is the one people get wrong: a check box says
*this will be so when you press OK*, a switch says *this is so now*. A dialog full
of switches has nothing for its OK button to do.

## On or off

| | |
|---|---|
| `Active` | whether it is ticked. Assigning it **raises `Click`**, the same as the user ticking it |
| `Text` | the caption beside the box. **Translated** |
| **event** `Click()` | it was pressed — or assigned |

```js
ChkHidden_Click() { this.hidden = this.ChkHidden.Active; this.List.Refilter(); }
```

## One of a set

| | |
|---|---|
| `Group` | empty is a check box. A name makes it one of that exclusive set: ticking one unticks the rest. **The container scopes the name**, so two groups called `kind` in two panels are two sets |

```json
{ "type": "CheckButton", "name": "OptAll",  "properties": { "Text": "All",  "Group": "kind", "Active": true } },
{ "type": "CheckButton", "name": "OptCode", "properties": { "Text": "Code", "Group": "kind" } }
```

**Ask the group which one is on by asking each**, or keep the answer in the
handler: there is no `Group.Value`, because a group is not a control — it is a
word two controls happen to share.

## What goes wrong

- **Setting `Active` from code ran the handler.** It does; guard with a flag
  while a form fills itself in, the way every data form here does.
- **The radios are not exclusive.** They are in different containers, which scope
  the name, or one of them spells the group differently.
- **Nothing is ticked at the start.** A group with no member declaring `Active`
  starts with none on, which GTK allows and users read as broken.
- **A dialog of switches has nothing to cancel.** See above: those want check
  buttons.

## What it does not do

- **No third state.** Ticked or not.
- **No `Icon`.** [`ToggleButton`](ToggleButton.md) has one.

## See also

[`Switch`](Switch.md) · [`ToggleButton`](ToggleButton.md) ·
[`ComboBox`](ComboBox.md), when the set is longer than four
