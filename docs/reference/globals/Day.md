# Day

The calendar date, which is the value JavaScript does not have.

**A date is the text `"YYYY-MM-DD"`** — what a
[`DatePicker`](../widgets/DatePicker.md) answers with, what a `Field.Date`
holds, what goes into JSON as itself, what a database stores, and what `a < b`
already orders correctly. `Day` is the handful of operations on that text.

## Every member

| | | |
|---|---|---|
| `Add(date, days)` | → the date `days` later; `days` may be negative | [arithmetic](#arithmetic) |
| `Between(from, to)` | → whole days, signed | [arithmetic](#arithmetic) |
| `Today` | today's date, at local midnight | [today](#today) |
| `Weekday(date)` | → `"Monday"` … `"Sunday"` | [which day it is](#which-day-it-is) |

## Today

| | |
|---|---|
| `Today` | today's date as `"YYYY-MM-DD"`, at **local** midnight |

**Never `new Date().toISOString().slice(0, 10)`**, which is yesterday all morning
in Lima and tomorrow in the evening in Auckland: it converts to UTC first, which
is exactly what a calendar date must not do.

## Arithmetic

| | |
|---|---|
| `Add(date, days)` | the date `days` later. `days` may be negative, and it **refuses to leave the calendar** rather than answering something impossible |
| `Between(from, to)` | whole days from one to the other, signed |

```js
const due = Day.Add(invoice.Date, 30);
const late = Day.Between(due, Day.Today) > 0;
```

There is no month or year arithmetic here on purpose: *a month later* is a
question with several right answers (the 31st of which month?), and a program
that needs one should say which rule it means.

## Which day it is

| | |
|---|---|
| `Weekday(date)` | `"Monday"` … `"Sunday"` — **a key to test against, never text to show** |

The words a user reads come from [`Locale.Date(date, "Weekday")`](Locale.md),
which answers in their language. This one is for `if (Day.Weekday(d) ===
"Sunday")`.

## Why not a `Date`

A `Date` is an **instant** — a moment on a timeline — and a calendar date is not.
Borrowing one introduces a time zone that was never in the value:
`new Date("2026-03-08").getDate()` is 7 in Buenos Aires and 8 in Berlin. The text
has no zone to get wrong, sorts correctly as a string, survives JSON, and is what
every other part of this runtime already speaks.

For a **time of day** there is [`Time`](Time.md), which is `"HH:MM"` by the same
argument.

## What goes wrong

- **The date is a day off for some users.** A `Date` got in somewhere.
- **Sorting dates needed a comparator.** It does not: `"YYYY-MM-DD"` sorts as
  text.
- **A weekday came out in English.** `Weekday` is a key; `Locale.Date(d,
  "Weekday")` is the word.
- **`Add` threw.** It refuses to answer a date that is not on the calendar.

## See also

[`Time`](Time.md) · [`Locale`](Locale.md) ·
[`DatePicker`](../widgets/DatePicker.md) · [`Calendar`](../widgets/Calendar.md) ·
[`examples/agenda`](../../../examples/agenda)
