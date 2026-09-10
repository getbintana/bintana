# Asynchrony: one decision, and one deferral

**Two things are written down here.** The first is small and **built**:
`Exec.Wait`, plus the `Timeout` guard, which between them cover the only place in
this repository where callbacks actually hurt. The second is the general question
— *does this language want a word for "do this, then that"?* — which is
**deliberately deferred**, with the options and the reasons recorded so that
picking it up does not mean having the argument again.

So this is half a reference and half a plan, and it says which is which as it
goes. The reference half is also in
[runtime-api.md](runtime-api.md#exec); what is here and not there is *why*.

## What the language does today

Events dispatched by name, and a callback where an answer arrives later:
`Exec`'s line and exit callbacks, `Dialog`'s answer, `Clipboard.Paste`,
`File.Watch`, `Timer`. No `Promise`, no `async` / `await` — never installed, and
[runtime-api.md](runtime-api.md#the-language-underneath) says why.

## What the problem actually measures

Every asynchronous call site in the IDE, which is the largest Bintana program
there is:

| | |
|---|---|
| `Dialog.*` with one callback | 3 — `MainForm`, `NewProjectForm`, `Exporter` |
| `Clipboard.Paste` | 1 |
| `File.Watch` | 1 — an event that repeats, not a sequence |
| `Exec` with nothing waiting on it | 1 — `Translations` opening an editor |
| `Exec` with something after it | 2 — `Exporter`, `Translations` |

**Eight call sites, and six of them are a single callback** -- the two that are
not are an `Exec` with one step after it. A single callback is not a pyramid, and
two steps are not one either: there is nothing to flatten. *(Re-counted against
the tree as it stands, since a number in a document is part of it.)*

### The seam is a feature, which is the fact that decides this

`Exporter` reads as a sequence broken into three methods — `export` asks,
`write` does the work, `finished` reports — and it is tempting to call that
damage done by callbacks. It is not. Its own comment says what the break is for:

> *The half that does the work, and the half a test can reach: the chooser is a
> separate modal surface nothing can close from JS, so everything worth
> asserting lives on this side of it.*

A file chooser cannot be dismissed from JavaScript, so the callback boundary is
exactly where the line between *asking* and *doing* has to fall. Any construct
that folded this into one straight-line sequence would put the chooser in the
middle of it and leave everything after it unreachable by `tests/ide`. **The
seam is what makes the code testable**, and a design that removes seams is a
regression here rather than a simplification.

## Built: `Exec.Wait`

One real pain was left: `Translations.mergeAll` runs `msgmerge` over N
catalogues, one after another, and with no way to wait it had to be written as a
recursion carrying its own index.

```js
const r = Exec.Wait(["msgmerge", "--update", "--backup=none", "--quiet", po, pot]);
r.ExitCode      // the status
r.Output        // what it wrote, as text
r.Errors        // separate, and only with { Stderr: "separate" }
```

A record, like `File.Info` and `Application.CheckSource`. The options are the
async `Exec`'s — `Directory`, `Environment`, `Stderr` — because it is the same
child started the same way. That turns the recursion into a `for` loop with **no
new concept in it at all**: no keyword, no protocol, no object to learn. It is
Gambas's `EXEC … WAIT` and .NET's `Process.WaitForExit()`.

Hung off `Exec` rather than named as a pair (`Exec.Async` / `Exec.Wait`),
because asynchronous is this language's default and the three callers that
already read `Exec(...)` are right as they stand — the same shape as
`Timer.After` on `Timer` and `Regex.Escape` on `Regex`.

It is the launcher `bta_sys.c` already had — `exec_build_argv` and
`exec_launcher` are shared by both spellings — with
`g_subprocess_communicate_utf8_async()` where the callback spelling has
`g_subprocess_wait_async()`, driven on a context of its own.

### Its limits, and the rule that follows

**It freezes the window.** Nothing paints and nothing responds until the child
exits. That is a *feature* next to `DoEvents`: there is no nested main loop, so
no handler runs inside the wait and nobody can close the form whose `this` the
caller is standing in. A frozen window is honest; a live window that is lying is
where the lifetime crashes come from.

**The output arrives at the end**, not line by line. Progress while it runs is
the asynchronous `Exec`.

**Without a `Timeout` there is no ending the caller controls**, so a command that
never exits hangs the program — exactly as in a shell script, and exactly as
Gambas's `EXEC WAIT` does. **With one there is**, and the first version of this
document said that was impossible: the reasoning was that with no loop running
there is nowhere to arm a timer, and the way out is a private `GMainContext`
(below).

| Use | For |
|---|---|
| `Exec.Wait` | a command you know ends, and ends quickly: `msgmerge`, `msgfmt`, `tar`, `git status`. Tools. |
| `Exec` | anything long or of unknown length, and anything that must show progress: `make`, running a project, the suite's own hang guard |
| `Terminal` | anything interactive |

## `Exec`'s surface, against what GIO offers

`Exec` is a thin face on `GSubprocess`, and the question of whether it should be
a complete one was asked and answered **no**. Seven of the eight things GIO offers
beyond it have no caller in this repository, and one of them cannot have one.

| GIO offers | It would give | Callers today |
|---|---|---|
| `STDIN_PIPE`, `get_stdin_pipe` | **writing to the child**: `gpg`, `sort`, `msgfmt -o - -` | none — but see below |
| `GCancellable` on wait/communicate | a timeout | **had one — built, see below** |
| `set_stdout_file_path`, `take_stdout_fd` | redirect without going through memory | none |
| `communicate` (not `_utf8`) → `GBytes` | binary output | none, and nowhere to put it |
| `get_if_signaled`, `get_term_sig` | *which* signal killed it | none |
| `wait_check` | a nonzero status as an exception | none — `ExitCode` is better for a RAD |
| `STDOUT_SILENCE` / `STDERR_SILENCE` | discard without reading | none |
| `set_environ` | replace the environment rather than edit it | none, and **deliberately refused** |

And two things it cannot do at all: a **pty** — that is VTE, which is `Terminal`
— and a **pipeline between two children**, which has no API and would be fds
passed by hand.

**Bytes are a boundary of the language, not of `Exec`.** `communicate` hands back
a `GBytes` and this language has no byte type: `ArrayBuffer` and the typed arrays
are not installed. A complete GSubprocess surface runs into a decision far larger
than this one.

### What the tradition converged on

| | How it models a child |
|---|---|
| **VB6** | `Shell(cmd)` returns an id and nothing else — no output, no wait. Capturing meant redirecting to a temporary file. The oldest and the poorest. |
| **WSH** | `.Run(cmd, style, bWait)` with a **wait flag** and an exit code; `.Exec(cmd)` gives `.StdIn`/`.StdOut`/`.StdErr` as streams, `.Status`, `.ExitCode`, `.Terminate()` |
| **Gambas** | `EXEC [...] FOR READ WRITE AS "proc"` makes a **`Process` object** raising `Read`/`Error`/`Kill`; `PRINT #proc` writes to its stdin; `WAIT` makes it synchronous; `SHELL "cmd" TO result` captures into a variable |
| **Delphi/Lazarus** | `TProcess` with `Input`/`Output`/`Stderr` as **streams**, `WaitOnExit`, `Terminate`, `ExitStatus` |
| **.NET** | `Process` + `ProcessStartInfo`: `Redirect*`, the `OutputDataReceived` **event**, `StandardInput.WriteLine`, **`WaitForExit(ms)`**, `Kill(entireProcessTree)` |

Four agreements, and all four say the same thing: a child is an **object**; its
output is a stream to read or an **event** that arrives; its stdin is **written
to**; and **waiting is a first-class verb that takes a timeout**.

**`Exec`'s handle is already that object.** `ProcessId`, `Running`, `ExitCode`,
`Stop`, `Kill` is Gambas's `Id`, `State`, `Value`, `Term`, `Kill` almost name for
name, and signalling the whole process group is what .NET spells
`Kill(entireProcessTree)` — done here always. What it lacks is streams and
events, and how its output arrives is the one thing off-idiom: this runtime
assigns handlers by name (`Btn1_Click`) or as a property (`Timer.Tick`), while
`Exec` takes functions as arguments.

### The `Process` class this would become, and what would trigger it

```js
const p = new Process(["make", "-j4"]);
p.Directory = build;
p.Timeout   = 180000;
p.Read      = (line) => this.log(line);
p.Ended     = (code) => this.done(code);
p.Start();
p.Write("something for its stdin\n");
```

Following `Timer` rather than the widgets — a handler property and a class, with
`Exec(...)` staying as the one-line shorthand exactly as `Timer.After` stands
beside `new Timer`.

**Not built, because it buys coherence and not capability**, and it costs a
second way to say the same thing plus every call site. **The trigger is stdin:** a
stream is written to, and writing to something wants an object with state rather
than a function with callbacks. The day anything needs to feed a child, `Process`
arrives with it — and not before. Today feeding a child means writing a temporary
file, which is the trade `tests/styles/Main.js` already describes on the *output*
side: *"the shell version extracted it to a temporary file and set a trap to
remove it; here the lines are the answer, so there is no file to clean up and no
trap to get wrong."*

### `Timeout` — the one gap that had a caller, and is now built

`tests/runner/Main.js` used to write it by hand, and not a simple one: two
stages, `Stop()` and then `Kill()` after a grace period, with a `killed` flag in
a closure and two timers to cancel in the exit callback. Fifteen lines of
bookkeeping for what coreutils spells `timeout --kill-after` — and the flag was
the part that could not be avoided, because a child a guard ended is a child
stopped by a signal and nothing else distinguished it.

`{ Timeout, KillAfter }` and `TimedOut` are in both spellings now; see
[runtime-api.md](runtime-api.md#exec). The runner reads `job.TimedOut` and keeps
neither timer nor flag.

Two things it settled that are worth keeping written down:

- **`Exec.Wait`'s child leads a process group of its own**, where the first
  version left it in the caller's so a Ctrl-C would reach it. That breaks the
  guard into a *hang*: signalling only the direct child leaves a wrapper's
  grandchild holding the write end of the pipe, the read never sees EOF, and the
  wait never returns. A guard that does not guarantee an ending is worth less
  than an interrupt. Asserted in the suite rather than reasoned about, because
  the failure shape is a hang.
- **A blocking timeout needs no nested event loop.** A private `GMainContext`
  runs the guard and nothing else, because GTK's sources, our own `Timer`s and
  every pending asynchronous `Exec` are all on the default one. Pushing it
  *before* the spawn is load-bearing: GSubprocess takes the thread-default
  context when it is constructed.

## Considered and rejected

### `Promise` and `async` / `await`

Never installed, and the reason in `build_context()` stands: this is a language
of events rather than of continuations. The measurement above adds a second
reason — microtasks, thenables, unhandled rejections and coloured functions are
four concepts for eleven call sites, ten of which are one callback.

### `Task` over generators

A driver that runs a `function*`, resuming it whenever something it `yield`s
reports done. **It works**: a 30-line prototype sequenced real children, a
delay, a `for` loop over N commands and a `try`/`catch`, all verified against
this runtime. `yield` can receive the value the wait produced, `yield*`
composes, and `.throw()` puts an exception back at the pause point so
`try`/`catch` reads normally. The protocol was one method: anything with
`Done(cb)` can be waited on, and `Exec`'s handle nearly is one already.

Rejected on the **surface**, not the mechanism:

- `function*` and `yield` would be the first construct in this language with no
  analogue in Basic, for an audience that comes from VB and Gambas.
- It fails silently. Forget the `*`, or forget `yield*` on a helper, and you get
  a generator object nobody drives — no error, the code simply does nothing.
- A generator cannot be an arrow, so `this` becomes an argument. Every callback
  in the IDE is an arrow precisely so it does not have to be.
- Its best example was `Exporter`, and `Exporter` turned out to be the case
  where the seam is a virtue.

### `DoEvents` / Gambas's `WAIT`

A call that looks blocking and pumps the event loop from inside, which would let
`Dialog.SelectFolder()` return the path directly and needs no new syntax at all
— the most Basic-shaped answer there is. Rejected because it is a nested main
loop: every handler can run inside the wait, including one that closes the form
the caller is standing in, and the crash then lands nowhere near its cause. This
project has already chosen against it twice — `Message.Info` shows and returns
instead of blocking like VB's `MsgBox`, and the `choose()` guard on the error
dialog exists to stop reentrant dialogs from stacking.

## What would reopen this

Named because a deferral without triggers is a punt:

- **Network.** There is no `fetch`, no socket, nothing that talks to a server.
  The day there is, every request is an asynchronous operation and the count of
  eight stops meaning anything. This is by far the most likely trigger, and it is the one
  that has forced the question in every other language. **Tried, since this
  was written, and it did not reopen anything**: `Http` speaks both ways now
  (a client and a server, dozens of asynchronous operations), and every one
  of them is one callback -- a sequence that hurts has still not shown up.
  The trigger stands for whatever arrives with one.
- **A second real case of chaining.** One site is a call site; three are a
  pattern.
- **Two children at once.** Nothing has ever asked. `Exec.Wait` in a loop is the
  wrong shape for it and there is no word for *both*.
- **Progress *and* sequencing** — something long that must report while it runs
  and be followed by something else. `Exec.Wait` gives up the line callback, so
  that combination has no answer today. **Tried, in
  [`examples/usage`](../examples/usage), and it did not reopen anything**: see
  below.
- **A seam that hurts.** If a dialog sequence appears where splitting at the
  callback makes the code worse rather than testable, the argument above loses
  its load-bearing fact.

### The one that was tried: progress and sequencing

[`examples/usage`](../examples/usage) was written against that trigger on
purpose. It runs `du` on a folder — seconds on a real one, minutes on a home
directory — reports a growing count while the lines arrive, and when the child is
gone sorts what it found and builds the rows. A long child reporting while it
runs, followed by work that needs its result: the combination the line above says
has no answer.

It came out as **two callbacks, side by side, and no nesting**, because *the
second step is not another child.* It is `sort` and a loop. The nesting the plan
is worried about needs a chain of asynchronous steps, and a window that measures
something and then draws it has exactly one.

What it did find is a shape that is not in the list above and is worth adding to
it, because it is the answer to a different trigger:

> **The natural thing to do while a child is running is not to start a second
> one, it is to cancel the first.**

Opening a folder while a `du` is still going does not want *both*: it wants
`Stop()` and a new child. `open()` in that example begins by ending whatever was
running, and every question that follows is about **one** child at a time — which
of three endings this was, and whether the exit code can tell them apart. It
cannot: a child that was stopped and a child that failed both exit non-zero, and
so does one that worked but could not read a folder. The application has to
remember that it was the one asking.

So *two children at once* stays unasked, and now there is a program on record
saying why rather than merely not doing it. The eleven call sites are twelve, and
the twelfth is a single callback like ten of the others.

### Where to start if it is reopened

The generator prototype is the closest thing that worked, and its two open
decisions are:

- **What the protocol method is called.** `Done(cb)` was the proposal. Not
  `Then`: that is Promise's word, and promising a resemblance that is not there
  is worse than a new name.
- **What a cancelled dialog does.** Today the callback is simply not called, so
  a sequence waiting on one would never resume and the generator would hang
  forever. Either it resumes with `null` and the sequence tests for it — the way
  this runtime says *there is none* everywhere else — or an exception is thrown
  in and the `try` catches it, which is .NET's `OperationCanceledException`.

And the constraint that killed it is about the surface: **whatever is chosen must
not put a new keyword in a beginner's event handler.** A mechanism used only by
tools and by the test harness is a much lower bar than one on the language's
front page, and that distinction is the thing to design against.

## Where generators live today

`tests/ide/Driver.js`, and only there: `drive()` is the trampoline, `until` and
`settled` are the waits, and every `yield` in the file hands GTK a frame. That is
a **harness technique and not a language feature** — a test harness is allowed
machinery that the language a VB programmer writes in is not. Do not promote it,
and do not remove it; [testing.md](testing.md) explains what it buys.
