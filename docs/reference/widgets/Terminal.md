# Terminal

VTE with a real pty: colours, prompts and interactive input all work.

For anything **interactive** — a shell, an installer that asks, a program with a
prompt. For a command whose output you capture, use
[`Exec`](../../llm/library.md#exec); for *showing* what it printed, a read-only
[`TextEditor`](TextEditor.md), whose `Append` is what a log pane wants.

**VTE is optional at build time**, so this is the one control that may not be
able to do its job. See [when this build has no VTE](#when-this-build-has-no-vte).

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Available` (ro) | whether this build can run a child in one | [when this build has no VTE](#when-this-build-has-no-vte) |
| `FontScale` | a multiplier on the terminal's own font. Default `1` | [how it looks](#how-it-looks) |
| `LinkPattern` | a regex; clicking text that matches raises `Link` | [links](#links) |
| `Running` (ro) | whether a child is alive | [running a child](#running-a-child) |
| `ScrollbackLines` | how much history it keeps. Default `10000` | [how it looks](#how-it-looks) |
| `Text` (ro) | everything on screen and in the scrollback | [what is in it](#what-is-in-it) |
| `Clear()` | resets it | [what is in it](#what-is-in-it) |
| `Feed(text)` | writes to the display without a child | [what is in it](#what-is-in-it) |
| `Kill()` | SIGKILL | [running a child](#running-a-child) |
| `Run(argv, [workdir])` | starts a child on a real pty | [running a child](#running-a-child) |
| `Stop()` | SIGTERM to the child's process group | [running a child](#running-a-child) |
| **event** `Exit(code)` | the child ended | [running a child](#running-a-child) |
| **event** `Link(text)` | text matching `LinkPattern` was clicked | [links](#links) |

## Running a child

| | |
|---|---|
| `Run(argv, [workdir])` | starts a child on a real pty, so colours, prompts and input all work. `argv` is the program and its arguments as an array — no shell, so nothing is word-split or globbed behind your back |
| `Running` (ro) | whether a child is alive |
| `Stop()` | SIGTERM to the child's **process group**, which is what reaches a shell's own children |
| `Kill()` | SIGKILL, for the one that did not answer |
| **event** `Exit(code)` | the child ended, with the status a shell would report |

## What is in it

| | |
|---|---|
| `Text` (ro) | everything on screen and in the scrollback — what a *copy all* or a bug report wants |
| `Feed(text)` | writes to the display **without a child**: a banner, a note about what is about to run, the reason something was refused |
| `Clear()` | resets it |

## Links

| | |
|---|---|
| `LinkPattern` | a regular expression; text matching it is drawn as a link and clicking it raises `Link` |
| **event** `Link(text)` | that text was clicked. **What it means is yours** |

The IDE's own terminal matches `file.js:120` and opens that file at that line,
which is the shape: the control finds the text, the application knows what it
stands for.

## How it looks

| | |
|---|---|
| `FontScale` | a multiplier on the terminal's own font. Default `1` — the Ctrl+`+` of a terminal, which is a property here rather than a gesture |
| `ScrollbackLines` | how much history it keeps. Default `10000` |

## When this build has no VTE

| | |
|---|---|
| `Available` (ro) | whether this build can run a child. `Widget.Available("Terminal")` is [the same question asked of the class](../../llm/controls.md#what-there-is-and-what-this-build-can-run), which is what a palette wants |

Where it is false **the class is still all here**: one constructs, a `.form`
naming one loads, every property answers, and `Feed`, `Text` and `Clear` work.
`Run`, `Stop` and `Kill` refuse, naming the package that is missing, and `Link`
never fires because nothing is highlighting anything.

That is the rule for every optional dependency in this runtime: the *verbs*
refuse and the *state* answers, so a designer can still draw and save a form that
has one in it.

## What goes wrong

- **`Run` refused.** No VTE in this build — the message names the package.
- **`Stop()` did not stop it.** SIGTERM was ignored; `Kill()` is the next step.
- **Nothing appears.** The child writes to a buffer it has not flushed, which is
  what a pty is for — but a program that checks whether it is on a terminal will
  behave differently here than under `Exec`, and that is the point of using this
  control.
- **The scrollback is gone.** `ScrollbackLines`.

## See also

[`Exec`](../../llm/library.md#exec) · [`TextEditor`](TextEditor.md) ·
[ide.md](../../ide.md), whose log pane and terminal are both here
