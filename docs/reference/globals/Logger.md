# Logger

What a program writes down for itself.

`Logger.Debug`, `Info`, `Warning`, `Error` — arguments joined with a space, like
`print`. **This is what `console` used to be**, and `console` is not part of this
language.

## Every member

| | | |
|---|---|---|
| `Debug(…)` | the detail nobody reads until something is wrong | [the four levels](#the-four-levels) |
| `Error(…)` | something failed | [the four levels](#the-four-levels) |
| `Handler` | assign a function and every line goes there instead | [where it goes](#where-it-goes) |
| `Info(…)` | what happened | [the four levels](#the-four-levels) |
| `Level` | the floor: anything below it is dropped | [the four levels](#the-four-levels) |
| `Target` | where the lines are written | [where it goes](#where-it-goes) |
| `Warning(…)` | something is not right | [the four levels](#the-four-levels) |

## The four levels

| | |
|---|---|
| `Debug(…)` | the detail that is only interesting when something is wrong |
| `Info(…)` | what the program did |
| `Warning(…)` | what it did not like but carried on through |
| `Error(…)` | what failed |
| `Level` | the floor — lines below it are dropped, which is how a program ships with its `Debug` lines still in it |

All four join their arguments with a space, like `print`.

## Where it goes

| | |
|---|---|
| `Target` | where the lines are written |
| `Handler` | assign `(level, text) => …` and every line arrives there instead — which is how a log pane inside the application is fed, and how a test captures what was logged |

## A log is not a message

This is for the program's own record: what it tried, what it found, what it gave
up on. What the **user** must be told is
[`Message`](Message.md), and what the user is *watching* belongs in a pane of the
window — a read-only [`TextEditor`](../widgets/TextEditor.md) fed from a
`Handler` is the shape, and it is what the IDE's own log is.

## What goes wrong

- **`console.log` is not a function.** It is not part of the language: `print`
  for a console tool, `Logger` for a program.
- **Nothing appeared.** `Level` is above the call being made.
- **A handler swallowed everything.** Assigning `Handler` replaces the
  destination; write to the old one too if both are wanted.

## See also

[`Message`](Message.md) · [`TextEditor`](../widgets/TextEditor.md) ·
[`Exec`](Exec.md)
