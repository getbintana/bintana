# SpinBox

A number, typed or stepped.

A quantity, a size, a count: the field that cannot be given letters. It is the
control to reach for whenever a [`TextBox`](TextBox.md) would need a check that
what was typed is a number.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Decimals` | places shown and accepted: a whole number from `0` to `20`, refused otherwise | [the number](#the-number) |
| `Max` | the ceiling, likewise | [the range](#the-range) |
| `Min` | the floor | [the range](#the-range) |
| `Numeric` | refuse anything that is not a number | [the number](#the-number) |
| `Step` | what one press of an arrow, or one notch of the wheel, moves | [the range](#the-range) |
| `Value` | the number in it | [the number](#the-number) |
| `Wrap` | past `Max` comes back to `Min` — for the things that are circular, like an hour or a degree | [the range](#the-range) |
| **event** `Activate()` | Enter in the field, or a double click on a row | [the number](#the-number) |
| **event** `Change()` | the value changed — stepped, typed, or **assigned from code**: the round trip goes out to GTK and back | [the number](#the-number) |

## When it is not a `SpinBox`

- **The number is chosen by feel, not by digits** — a volume, a zoom, an opacity:
  [`Slider`](Slider.md), which is the same four words asked with the mouse.
- **It is a reading and not an input** — [`LevelBar`](LevelBar.md) or
  [`ProgressBar`](ProgressBar.md).
- **It is a date** — [`DatePicker`](DatePicker.md).
- **It is money, or anything the program totals** — [`DecimalBox`](DecimalBox.md),
  which holds a `Decimal` and shows this desktop's separators, a unit and a
  currency. A double is not money.

## The number

| | |
|---|---|
| `Value` | the number in it |
| `Decimals` | places shown and accepted: a whole number from `0` to `20`, refused otherwise. `0` is whole numbers |
| `Numeric` | refuse anything that is not a number. Default `true`, and there is rarely a reason to turn it off |
| **event** `Change()` | the value changed — stepped, typed, or **assigned from code**: the round trip goes out to GTK and back |
| **event** `Activate()` | Enter in the field, or a double click on a row |

**`Change` fires for an assignment**, the same as a [`TextBox`](TextBox.md)'s: a
form that fills its fields in raises its own handlers, which is what the
`loading` flag in every data form here is for.

## The range

| | |
|---|---|
| `Min` | the floor. **Declare it before `Value`**, or the value is clamped to the factory range first and the number you set is not the number you get. Default `-1000000` |
| `Max` | the ceiling, likewise. Default `1000000` |
| `Step` | what one press of an arrow, or one notch of the wheel, moves. Default `1` |
| `Wrap` | past `Max` comes back to `Min` — for the things that are circular, like an hour or a degree |

**The order matters and it is the one thing that bites**: in a `.form` the
properties are applied in the order they appear, and `Value: 2026` with a `Max`
of `1000000` declared afterwards is fine, while the same with the default range
is not. Declaring `Min` and `Max` first is the habit worth having.

## What goes wrong

- **The value came out clamped.** `Min`/`Max` were applied after `Value`.
- **The handler ran while the form was filling in.** `Change` fires for
  assignments.
- **Decimals are ignored when typing.** `Decimals` is what is accepted as well as
  what is shown; `0` refuses a comma.
- **The arrows move by the wrong amount.** `Step`, and Page moves ten of them.

## What it does not do

- **No formatting and no units.** [`DecimalBox`](DecimalBox.md) is this control
  over a `Decimal` with the separators, a unit and a currency; a `SpinBox` is for
  a measurement that is only compared with itself. A number that is shown with a
  unit but never totalled is still this one, with the unit in a `Label` beside
  it.

## See also

[`Slider`](Slider.md) · [`TextBox`](TextBox.md) · [`LevelBar`](LevelBar.md) ·
[`DatePicker`](DatePicker.md)
