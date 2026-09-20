# Asynchrony: the question this language has not answered

**One question, deliberately deferred**: *does this language want a word for
"do this, then that"?* The options, the measurements and the reasons are here
so that picking it up does not mean having the argument again.

What was **built** along the way -- `Exec.Wait` and the `Timeout` guard, and
later `Task` -- is described where it lives
([runtime-api.md](../runtime-api.md#exec), [Task.md](../reference/globals/Task.md),
[task-plan.md](task-plan.md)) and named here only where it changed the
argument. This document used to carry that reference half as well, and it was
a second description of a built feature sitting in the directory for things
that are not.

`Exec.Wait` is the one part worth a sentence here, because the reference says
what it does and not why it exists: running `msgmerge` over N catalogues one
after another had to be a recursion carrying its own index, and waiting turns it
into a `for` loop with no new concept in it -- no keyword, no protocol, no
object to learn -- which is the bar anything proposed below has to clear.

**In a tool. The IDE's own copy still carries the recursion**, because
`Exec.Wait` blocks the loop and that code runs with a window up: see the
chaining trigger below, where it counts for more than this example does.

## What the language does today

Events dispatched by name, and a callback where an answer arrives later:
`Exec`'s line and exit callbacks, `Dialog`'s answer, `Clipboard.Paste`,
`File.Watch`, `Timer`, `Http`'s replies, and a
[`Task`](../reference/globals/Task.md)'s `Progress`/`Done`/`Error`. No
`Promise`, no `async` / `await` — never installed, and
[runtime-api.md](../runtime-api.md#the-language-underneath) says why.

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

## The half a thread answered

**`async`/`await` is for waiting on I/O. What this runtime had to wait for was
work** -- and [`Task`](task-plan.md) moves work to a thread, where the sequence
is ordinary straight-line code inside `Run`: a `for` with an `if` in it, and no
new word anywhere.

That is worth stating plainly because it cuts the deferred question in half.
*Do this, then that* has two populations behind it. Where the middle is
**computation**, the answer is now a `Task` and there is nothing left to
design. Where the middle is **waiting for I/O**, the evidence below still
stands: `Http` speaks both ways, `Dialog` asks, `Exec` runs children, and every
one of those is a single callback rather than a chain.

So what would reopen this is narrower than it was when the list further down
was written: not *a long operation followed by another*, which has an answer,
but **a chain of waits** -- and nothing in this tree has produced one outside
its own test harness.

## Considered and rejected

### `Promise` and `async` / `await`

Never installed, and the reason in `build_context()` stands: this is a language
of events rather than of continuations. The measurement above adds a second
reason — microtasks, thenables, unhandled rejections and coloured functions are
four concepts for eleven call sites, ten of which are one callback.

### A generator driver

*(Called "`Task` over generators" while this was written, which is a name the
runtime has since taken for something else entirely — a class that runs in a
thread. Nothing below is about that `Task`.)*

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
  pattern. **Fired, and in the harness rather than in an application**:
  `tests/widgets`' `testTask` is eight asynchronous steps in order -- a round
  trip, the decimals, the prelude, the writes, the reports, a throw, a timeout,
  a stop. Written first as a six-level pyramid, and the defect that shape has
  is not the indentation: **every branch out of it is one more place to forget
  to close**. Only the happy path decremented the suite's outstanding count, so
  any assertion that failed hung the run instead of reddening it. Rewritten as
  an array of functions with a three-line `next()` and an idempotent `finish()`
  the mistake is not available to make. So the trigger is met and the answer
  was still a list rather than a keyword -- with the caveat this document
  already draws: a harness is allowed machinery that the front page is not.

  **And it has since fired in an application too, which the caveat does not
  cover.** `Ide.Translations.update()` still chains `msgmerge` over N
  catalogues through a `next(i + 1)` closure carrying its own index -- the very
  shape the opening of this document says waiting retired. It was not retired
  and **could not be**: that code runs with the IDE's window up, and `Exec.Wait`
  blocks the loop, so waiting N times would freeze the application for the
  length of the whole pass. The opening's `for` loop is the right answer for a
  console tool and unavailable here. So the chaining case the trigger asks for
  exists on the application side, and what distinguishes it is not *how many
  waits* but **whether the thread may stop** -- which is the question a word for
  sequencing would have to answer and `Exec.Wait` cannot.

  A second, much smaller one beside it: `tests/ide/Driver.js:11324` writes
  `Timer.After(0, …)` to mean *the next turn of the loop*, and says so in its
  comment -- *"one turn, not a delay"*. `Timer.After(0)` is documented as *let
  GTK draw a frame*, which is a different claim spelled the same way. If
  deferring is a thing a program can want, it wants a name of its own; one
  harness line is not enough to give it one.
- **Two children at once.** Asked at last, in worker form rather than child
  form: [`examples/usage`](../../examples/usage) fans out to one `Task` per
  handful of folders, and retiring a run (a generation counter dropping stale
  answers) is the same shape as cancelling one child, generalised. `Exec.Wait`
  in a loop stays the wrong shape for it, and the word for *both* is now a
  barrier both sides count to rather than syntax.
- **Progress *and* sequencing** — something long that must report while it runs
  and be followed by something else. `Exec.Wait` gives up the line callback, so
  that combination has no answer today. **Tried, in
  [`examples/usage`](../../examples/usage), and it did not reopen anything**: see
  below.
- **A seam that hurts.** If a dialog sequence appears where splitting at the
  callback makes the code worse rather than testable, the argument above loses
  its load-bearing fact.

### The one that was tried: progress and sequencing

[`examples/usage`](../../examples/usage) was written against that trigger on
purpose. It ran `du` on a folder — seconds on a real one, minutes on a home
directory — reported a growing count while the lines arrived, and when the
child was gone sorted what it found and built the rows. A long child reporting
while it runs, followed by work that needs its result: the combination the
line above says has no answer.

It came out as **two callbacks, side by side, and no nesting**, because *the
second step is not another child.* It is `sort` and a loop. The nesting the plan
is worried about needs a chain of asynchronous steps, and a window that measures
something and then draws it has exactly one.

The window has since moved off the child: it fans out to one `Task` per
handful of folders, reports finished roots through `Progress`, and sorts when
the last `Done` lands. The shape survived the move untouched -- two callbacks,
no nesting, cancel-first -- which is the evidence that the shape was the
finding and the child was only the vehicle.

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

So *two children at once* stayed unasked until the same window started N tasks
at once -- one per handful of folders -- and answered it with a barrier and a
generation counter rather than with syntax. The program on record still says
why *two children* never asked: opening another folder wants the old run
retired, not both running. The eleven call sites are twelve, and
the twelfth is a single callback like ten of the others.

### Where to start if it is reopened

The generator prototype is the closest thing that worked, and its two open
decisions are:

- **What the protocol method is called.** `Done(cb)` was the proposal. Not
  `Then`: that is Promise's word, and promising a resemblance that is not there
  is worse than a new name.
- **What a cancelled dialog does**, which is now the *only* half of this
  question left open. `Task` answered the other half in the opposite
  direction: cancelling **calls**, with `Cancelled` set on the handle beside
  `TimedOut`, and whatever the worker managed to `Report` on its way out has
  already arrived. So a sequence waiting on a task cannot hang, and one waiting
  on `Exec` or `Http` cannot either -- all three report their own cancellation.
  Only the dialogs stay silent.

  **And the two conventions do not contradict each other, which is what makes
  the rule findable**: a cancelled dialog *produced nothing*, and not calling
  is exactly what spares every caller from telling *cancelled* apart from
  *chose nothing*; a cancelled job produced something -- time, partial work, a
  thread to join -- so it has to report. The rule is **whether anything
  happened**, not who did the cancelling. If this is reopened, the dialogs are
  the one place to decide, and the two candidates are unchanged: resume with
  `null` the way this runtime says *there is none* everywhere else, or throw in
  and let the `try` catch it, which is .NET's `OperationCanceledException`.

And the constraint that killed it is about the surface: **whatever is chosen must
not put a new keyword in a beginner's event handler.** A mechanism used only by
tools and by the test harness is a much lower bar than one on the language's
front page, and that distinction is the thing to design against.

## Where generators live today

`tests/ide/Driver.js`, and only there: `drive()` is the trampoline, `until` and
`settled` are the waits, and every `yield` in the file hands GTK a frame. That is
a **harness technique and not a language feature** — a test harness is allowed
machinery that the language a VB programmer writes in is not. Do not promote it,
and do not remove it; [testing.md](../testing.md) explains what it buys.
