# ISSUE: a worker cannot order names

## What the application needed

To sort a long list of people by surname **inside a `Task`**, which is the whole
reason the list went to a worker: ten thousand rows out of a query, collated and
handed back as one answer, with the window still drawing while it happens.
Sorting is exactly the shape `Task` exists for -- work rather than I/O, and
straight-line code in the worker instead of a chain of callbacks.

## What I wrote instead

The worker returns the rows unsorted and the **main thread** sorts them with
`Locale.Compare` after they arrive, which puts the one expensive loop back on
the thread that draws -- and is the thing the worker was reached for to avoid.
The alternative written twice is worse: sort in the worker with `<` or a bare
`sort()`, and every accented surname files after Z.

## The code I wish I could have written

```js
class Roster extends Task {
    Run(msg) {
        return msg.rows.sort((a, b) => Locale.Compare(a.Surname, b.Surname));
    }
}
```

## Why the existing words do not cover it

`Locale` is not installed in a worker at all. The reason is written down and is
a good one for most of it (`bta_task.c`, and `docs/plans/task-plan.md`): the
catalogue behind `Locale.Text` and `Locale.Plural` is a process-global hash
table the main thread filled, and prose belongs where it is shown, not where it
is computed.

But that argument covers the **translation** half and was applied to the whole
global. `Locale.Compare` and `Locale.Matches` need no catalogue -- they are
`g_utf8_collate` and an accent fold over the C library's collation, and both
answer from the process locale that `setlocale` already set for every thread.
`Locale.Number`, `Locale.Date` and `Locale.Currency` are in the same position.

The result is that a worker has the **wrong** tool and not the right one:
`"Álvarez".localeCompare("Zapata")` was answering `1` in there until it was
refused, and now it refuses with a message that has to send the caller back to
the main thread, because the name it would otherwise recommend is absent.

## Prior art

.NET `CultureInfo` is per-thread and a background thread inherits the culture of
the one that started it. Java's `Collator` is an ordinary object usable from any
thread. Qt's `QCollator` likewise. Nothing makes collation a main-thread
privilege, because it is a property of the process's locale rather than of its
event loop.

## How much it mattered

One application so far, and the workaround is real rather than fatal -- the sort
happens, it happens on the wrong thread. What makes it worth reporting is the
asymmetry rather than the cost: a worker that can use `Decimal`, `Record`,
`Database.Sqlite` and the whole of `rad.js` cannot put two names in order, and
the one word it reaches for instead is the one the language refuses everywhere
else.
