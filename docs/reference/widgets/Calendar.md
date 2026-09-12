# Calendar

The month itself, with the days that matter marked on it.

Where a [`DatePicker`](DatePicker.md) is a date on one line, this is the page:
it takes the room of a month and gives back the ability to *show* things — the
days with appointments, the days already booked, the deadlines.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Marks` (ro) | the dates marked, earliest first | [marking days](#marking-days) |
| `ShowDayNames` | the row of weekday names. Default `true` | [how it is drawn](#how-it-is-drawn) |
| `ShowHeading` | the month and year above the grid. Default `true` | [how it is drawn](#how-it-is-drawn) |
| `ShowWeekNumbers` | the week number down the side. Default `false` | [how it is drawn](#how-it-is-drawn) |
| `Value` | `"YYYY-MM-DD"`. Default is today | [the date](#the-date) |
| `ClearMarks()` | takes every mark off | [marking days](#marking-days) |
| `Mark(date)` | marks that date | [marking days](#marking-days) |
| `Unmark(date)` | takes that one off | [marking days](#marking-days) |
| **event** `Change()` | the value changed, **including from code** | [the date](#the-date) |

## The date

| | |
|---|---|
| `Value` | the chosen day as `"YYYY-MM-DD"` — the same text a [`Day`](../../llm/library.md#day) works in |
| **event** `Change()` | the day changed — chosen, or **assigned from code** |

**A `Calendar` refuses `""`.** A month is drawn with a day on it and there is no
way to draw one without; the empty date belongs to
[`DatePicker`](DatePicker.md), which has a button that can read a dash.

## Marking days

| | |
|---|---|
| `Mark(date)` | marks that date. Marking one twice marks it once |
| `Unmark(date)` | takes that one off. One that was not marked is not an error |
| `ClearMarks()` | takes them all off |
| `Marks` (ro) | the dates marked, as `"YYYY-MM-DD"` strings, earliest first |

**A mark is a date, and only the ones in the month on screen are drawn.** Mark the
4th of April while March is showing and nothing appears until the page turns; the
list is what the calendar holds, and what is drawn is the part of it in view.
Turning the page draws the new month's marks with nothing to re-apply — which is
why marking every day that matters, once, is the right shape and re-marking on
every page turn is not.

`Marks` is read-only because the marks are what the **application** knows: which
days have appointments is a question about your data, and the control is the
drawing of the answer.

## How it is drawn

| | |
|---|---|
| `ShowHeading` | the month and year above the grid |
| `ShowDayNames` | the row of weekday names |
| `ShowWeekNumbers` | the week number down the side. Default `false`, and worth turning on where people plan in weeks |

The first day of the week, the names of the months and the order of the columns
are the desktop's, through the locale — there is nothing to set here and nothing
to translate.

## What goes wrong

- **A mark did not appear.** It is in another month; turn the page.
- **`Value = ""` threw.** Use a [`DatePicker`](DatePicker.md) for an optional
  date.
- **The marks were lost.** `Clear`ing or re-marking on a page turn: mark
  everything once instead.

## What it does not do

- **No range selection, no multiple days.** One `Value`; a range is two
  controls, and a set of days is what the marks draw.
- **No events, no entries, no times.** The calendar shows days; what is *on* a
  day is your list beside it — see
  [`examples/agenda`](../../../examples/agenda).

## See also

[`DatePicker`](DatePicker.md) · [`Day`](../../llm/library.md#day) ·
[`examples/agenda`](../../../examples/agenda)
