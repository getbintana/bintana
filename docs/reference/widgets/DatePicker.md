# DatePicker

A date on one line, with a calendar in its popover.

The control for a date in a form: it takes the room a field takes, it answers the
ISO text the rest of this runtime works in, and it cannot be given the 31st of
February.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Format` | a strftime pattern for what the button reads. Default `"%Y-%m-%d"` | [what it reads](#what-it-reads) |
| `Placeholder` | what it reads while there is no date. **Translated** | [no date at all](#no-date-at-all) |
| `Value` | `"YYYY-MM-DD"`, or `""` for no date. Default is today | [the date](#the-date) |
| **event** `Change()` | the value changed, **including from code** | [the date](#the-date) |

## The date

| | |
|---|---|
| `Value` | the date as `"YYYY-MM-DD"` — the same text a [`Day`](../../llm/library.md#day) works in, which is what makes a date in this runtime comparable, sortable and storable without a timezone ever entering it |
| **event** `Change()` | the value changed — chosen, **assigned from code**, or the popover's page turned |

**Turning the page in the popover is a change of value.** GTK has one date and no
separate notion of *the month on screen*, so browsing from March to April moves
`Value` to a day in April. A form that saves on `Change` therefore saves while
somebody is still looking; saving on `LostFocus`, or on the form's own OK, is the
shape that does not.

## No date at all

| | |
|---|---|
| `Value = ""` | no date, which is what an optional one needs |
| `Placeholder` | what the button reads while it is empty. Default `"—"`; `""` restores the dash. **Translated** |

**This is the property that stops a program from inventing today.** Until the
empty date existed, a field nobody filled in answered with today's date, and that
date went into the record in silence — see
[`Field.Date`](../../llm/library.md#record-and-field), which spells the empty date
the same way. There is no *gesture* for emptying one again: a form that offers it
puts a button beside the field and writes `Value = ""`.

## What it reads

| | |
|---|---|
| `Format` | a strftime pattern — `"%d/%m/%Y"`, `"%e %B %Y"` — for what the **button** shows. It does not change `Value`, which is always ISO |

Prefer [`Locale`](../../llm/library.md#locale)'s own date for text you write
yourself; `Format` is for the control's own face, where the user's convention is
what should show.

## What goes wrong

- **A date nobody chose was saved.** The default is today: an optional date
  starts at `""`.
- **The value changed while the user was only browsing.** See
  [the date](#the-date).
- **A `Calendar` refused `""`.** It does: a month is drawn with a day on it, and
  there is no way to draw one without. The empty date is this control's.
- **The text is in the wrong order for the country.** `Format` is what the button
  reads; `Value` stays ISO.

## What it does not do

- **No time.** [`Time`](../../llm/library.md#time) is the other half, and there is
  no control for it: a [`SpinBox`](SpinBox.md) pair or a
  [`TextBox`](TextBox.md) with a `"HH:MM"` check.
- **No range.** Two pickers.

## See also

[`Calendar`](Calendar.md) · [`Day`](../../llm/library.md#day) ·
[`SpinBox`](SpinBox.md) · [`examples/agenda`](../../../examples/agenda)
