# Task

A class that runs in a thread of its own: the third shape of long work, after
`Timer` slices in-process and a child through [`Exec`](Exec.md).

```js
class Sizer extends Task {
    Run(msg) {
        let size = 0, files = 0;
        // ... walk msg.roots with Directory/File ...
        return { size, files };
    }
}

const t = new Sizer();
t.Progress = (p) => status(p);
t.Done     = (r) => show(r);
t.Error    = (m, stack) => complain(m);
t.Start({ roots: subs });
```

One shot: a `Task` runs once and answers exactly once — `Done` xor `Error` —
and work that repeats is a new `Task`.

## Every member

| | | |
|---|---|---|
| `Start(data, [options])` | sends the message, starts the thread. Once | [starting](#starting) |
| `Stop([options])` | asks it to end; answers whether there was one to ask | [ending](#ending) |
| `Report(value)` | the worker's voice, from inside `Run` | [reporting](#reporting) |
| `Stopping` | inside `Run`: whether it has been asked to end | [ending](#ending) |
| `Done` | assign `(result) => …` | [answering](#answering) |
| `Error` | assign `(message, stack) => …` | [answering](#answering) |
| `Progress` | assign `(partial) => …` | [reporting](#reporting) |
| `Running` | `false` once it has ended | [answering](#answering) |
| `Cancelled` | whether `Stop()` is what ended it | [ending](#ending) |
| `TimedOut` | whether the guard is what ended it | [ending](#ending) |

`Task` itself is abstract — `new Task()` throws, and `Start` throws for a
class the project has no file for, for a class with no `Run(msg)`, and for a
second `Start` on the same task.

## Starting

| | |
|---|---|
| `Start(data, [options])` | serialises the message, loads the class's file in a fresh runtime on a fresh thread, builds the class, and calls `Run(msg)` |
The file is found the way a form is: `<ClassName>.js` anywhere in the project
or its libraries, the project shadowing a library. Two files claiming one
name is refused naming the name; the class must be self-contained in its file.

`Timeout` is milliseconds before the run is aborted, absent waits forever.
Whatever `data` holds must be plain — see below.

## Answering

Exactly once, however the job went:

- `Run` returned → `Done(result)`.
- `Run` threw → `Error(message, stack)`, the two halves
  `Application.OnError` takes.
- `Stop()` was called → `Error("Task: cancelled")` and `Cancelled` reads
  `true`.
- the `Timeout` fired → `Error("Task: timed out after N ms")` and
  `TimedOut` reads `true`.

**Which ending it was, read as a flag and not out of the sentence.**
`Cancelled` and `TimedOut` are there so nothing has to match on the message —
a program that has to do `String(m).includes("cancelled")` is one the API did
not answer.

`Running` is written `false` before either callback runs, because the ordinary
place to read it is after the job is gone — the same reason `Exec` writes its
`ExitCode` first. An exception thrown *inside* `Done`/`Error`/`Progress` is
reported where it was raised and the run goes on, the way `Exec` treats a
throwing line callback.

A stopped or stale answer still arrives, so the application tells live answers
from dead ones where they land — a generation counter, as in
[`examples/usage`](../../../examples/usage). A handler may be assigned any
time before the job ends.

## Reporting

| | |
|---|---|
| `Report(value)` | called as `this.Report(partial)` inside `Run`; arrives as `Progress(partial)` — zero or more calls, in order, every one before `Done` | For a progress bar, a live
count, a batch of paths already walked. Report in batches (every N roots, not
every file); one message per row of a hundred thousand is a hundred thousand
wakeups of the main thread.

A report with no `Progress` handler is dropped in silence — an event nobody
handles never happened, which is also what the main side does with a `Click`
nobody wrote. `Report` on the proxy (outside `Run`) is refused.

## Ending

| | |
|---|---|
| `Stop([{ KillAfter }])` | asks the run to end; answers whether there was a live one to ask |
| `Stopping` | read as `this.Stopping` inside `Run`: `true` once it has been asked |

**Asked first, and only then enforced.** `Stop()` raises a flag and lets the
run keep going, so a `Run` that watches `this.Stopping` can hand back what it
has:

```js
Run(msg) {
    const found = [];
    for (const root of msg.roots) {
        found.push(this.measure(root));
        if (this.Stopping) {
            this.Report(found);      // arrives as Progress, before the ending
            return { partial: true };
        }
    }
    return { found };
}
```

Without that flag the engine's interrupt ends the run at the next opcode and
everything it had measured is lost. Every environment with threads has the
same one and makes it the central idiom — Delphi's `while not Terminated`,
`BackgroundWorker`'s `CancellationPending`, Qt's `isCanceled()` — because a
thread cannot be signalled the way a child can.

`KillAfter` milliseconds later (**5000** by default, `0` for at once), a run
that never looked is ended where it stands. Two stages and the same two names
as [`Exec`](Exec.md)'s guard, because it is the same bargain: ask, then
insist. `Timeout` is the same enforcement on a clock rather than on request,
and it answers `TimedOut` instead of `Cancelled`.

A run that saw the flag and returned politely is **still a cancelled run** —
the caller asked and it stopped, so the ending is `Error` with `Cancelled`
set. What changes is how much of the work survives.

The one case no flag reaches is a worker blocked in native code, since the
interrupt only fires between opcodes. Teardown waits **two seconds** for each
live task and then closes anyway, saying so on stderr: the program exits, and
the thread is left adrift rather than joined, because freeing memory a live
thread still writes to is worse than leaking it on the last line.

## Messages

A message — the argument, each report, the answer — is a tree of **plain
data**: objects, arrays, strings, numbers, booleans, null. Plus `Decimal`,
which crosses as its own digits (`{$decimal: "19.99"}`) and arrives as a real
`Decimal` on the far side, because both sides have the same class out of the
same file. `(10/3)*3` is `10` in a worker exactly as it is outside one, and
`Round`, `Trim`, `Abs` and `Split` are all there.

Refused out loud, because `JSON.stringify` would silently drop or null them:
functions, class instances, cycles, `undefined`, non-finite numbers, `Bytes`.
A `Record` crosses as what `Serialize` writes and comes back through `Load`.
Integers past 2⁵³ lose precision in transit — cross those as text or as
`Decimal`.

## What a worker sees

**This language, not a subset of it.** The worker builds its context the way
the main thread does — the same `init` functions, then the same `rad.js` — so
the classes are the same classes: `Decimal` and `Bytes` out of their own
files, and `Dictionary`, `Regex`, `Stopwatch`, `Record`, `Field`, `Table` and
`Namespace` out of the prelude. Plus `print`, `Logger`, `Day`/`Time`, `Hash`,
`File` and `Directory` for reading, `Database`/`Sqlite`, and an `Application`
that answers facts (`Name`, `Version`, `Directory`, `ConfigDirectory`,
`Executable`, `Arguments`).

**What is missing is what would leave a callback hanging off the main loop**,
and that is the whole rule — not reading against writing:

| Not there | Because |
|---|---|
| every widget, `Dialog`, `Message`, `Clipboard`, `Screen`, menus, printing | GTK off the main thread is a crash, not an error |
| `Exec`, `File.Watch`, `Timer`, the asynchronous half of `Http` | the source would fire on the main thread holding this context |
| `Settings`, `Locale` | process state the main thread owns |

A task computes and reports; what is drawn happens where the answer arrives.

### Writing, which is deferred and not forbidden

`File.Save`, `File.SaveJson`, `File.SaveBytes`, `File.Delete`, `File.Copy`,
`File.Trash`, `File.Rename`, `Directory.Make`, `Directory.Copy`,
`Directory.Delete` and `Directory.DeleteTree` throw in a worker today, and the
message says why:

> `File.Save: a task cannot write yet — two writers need a lock to order them,
> and there is none. See docs/plans/task-plan.md.`

**A deadline, not a doctrine.** A thread writing a file is not unsafe in
itself — `Exec` already writes beside the window — what is missing is the word
for *take turns*. [`task-plan.md`](../../plans/task-plan.md) phase 2 is `Lock`,
and when it lands these eleven stop being refused and nothing else here
changes. Until then a worker proposes (paths, counts, plans, streamed through
`Report`) and the main thread writes.

## What goes wrong

- **`cannot find task class 'X'`.** No `<X>.js` in the project or its
  libraries. A class declared inside another file is not findable — the file
  is the unit, and it is named after the class.
- **The answer never arrives.** The handler was assigned to a different
  object, or the run belongs to a retired generation. `Done` xor `Error`
  always fires while the loop runs.
- **A `Timeout` that never fires.** It travels per `Start`, not per task —
  `t.Start(data, { Timeout: 5000 })`.
- **Teardown hangs.** A worker blocked in native code (not JS) cannot be
  interrupted; the join waits for the filesystem, not for us.
