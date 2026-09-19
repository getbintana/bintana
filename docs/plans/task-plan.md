# Task: a class that runs in a thread of its own

**Status: phase 1 is being built.** The surface is
[`docs/reference/globals/Task.md`](../reference/globals/Task.md), which was
written first and is the specification this follows. What is *not* built is
named at the end, with the trigger that builds it — because the one limitation
this ships with is a deferral and not a doctrine, and the difference has to be
readable from the error message.

## What it is

The third shape of long work. `Timer` slices a computation in-process and
`Exec` hands it to a child; a `Task` gives it a thread, for the program that
totals a hundred thousand rows while the window stays alive.

```js
class Sizer extends Task {
    Run(msg) { /* ... */ return { size, files }; }
}

const t = new Sizer();
t.Progress = (p) => status(p);
t.Done     = (r) => show(r);
t.Start({ roots: subs });
```

A class extended, instantiated to start, callbacks by property like
`Timer.Tick`. Gambas names it `Task` too, Qt watches a `QFuture`, .NET cancels
cooperatively. The shape is not the question; what a worker is *allowed to see*
is, and that is what the rest of this is about.

## The premise that had to be measured first

A first attempt was written and abandoned. It gave the worker a decimal of its
own — scaled integers, a private arith handler, a `{$decimal: "19.99"}` wire
tag, some seven hundred lines — on the grounds that a second runtime cannot
register the classes the process already has. That grounds is false, in both
halves, and the vendored engine says so:

```c
JSClassID JS_NewClassID(JSRuntime *rt, JSClassID *pclass_id) {
    if (*pclass_id == 0) class_id = rt->js_class_id_alloc++;   /* per runtime */
```
```c
static int JS_NewClass1(JSRuntime *rt, JSClassID class_id, ...) {
    if (class_id >= rt->class_count) { new_size = max(class_id + 1, ...); ... }
```

Ids are allocated **per runtime**, and `JS_NewClass1` accepts any id under
65536, growing the class array to fit. So an id the main runtime assigned
registers verbatim in a worker's. The module-level `static JSClassID`
variables are process-global C storage, but `install_globals` runs to
completion before any thread exists, which makes every one of them
write-once-at-boot and read-only forever after. No lock, no per-runtime table,
no second implementation of anything.

**So a worker runs the same `init` functions the main thread does**, and gets
the real `Decimal` out of `bta_decimal.c` — `Round`, `Trim`, `Abs`, `Split`,
its nine places and its thirds — rather than a lookalike that rounds
differently. The same for `Bytes`, `Day`/`Time`, `Hash`, `Sqlite`. One exact
type in one file was the rule before this plan and stays the rule after it.

It also unblocks `rad.js`, which could not run in a worker for a reason nobody
had noticed: its line 1523 is `const EMPTY_BYTES = new Bytes()`. Give the
worker `Bytes` and rad.js evaluates, and with it arrive `Dictionary`, `Regex`,
`Stopwatch`, `Record`, `Field` and `Table`. Without it the worker had no
`Dictionary` *and* no `Object.keys` — `bta_close_hatches` empties `Object`
and rad.js is what republishes the equivalent — so there was no way to walk
the keys of the plain object a message is defined to be.

## The frontier is callbacks, not writes

The abandoned version drew the line at writing: `File.Save`, `Directory.Make`
and eleven other names refused with *"a task reads the disk, it never writes
it"*. That line is in the wrong place and the message names the wrong reason.
`File.Save` is `g_file_set_contents` and `Directory.Make` is
`g_mkdir_with_parents`; neither is less safe from a thread than the `Exec`
that already writes files beside the window. Meanwhile `File.Watch` was on the
list as if it were a write, and it is the genuinely dangerous one: it hangs a
`GFileMonitor` off the default context, so the signal would arrive on the main
thread holding the worker's `JSContext` — the same defect as `setTimeout`,
which today is only covered because `bta_close_hatches` deletes it for an
unrelated reason.

**The rule is whether something leaves a callback hanging off an event loop.**
Measured against the tree, every piece of mutable process-global state in the
modules a worker would run is five variables, all in `bta_sys.c`:

| | |
|---|---|
| `watch_jobs` | `File.Watch` |
| `exec_jobs` | `Exec` |
| `timers` | `setTimeout` |
| `paste_jobs` | `Clipboard` |
| `dialog_jobs` | `Dialog` |

Five for five, the rule already takes them. That is not luck: what keeps a
global list is what has work in flight, and what has work in flight is what
has callbacks. `File` and `Directory` keep no state at all — they are glib
calls that enter and leave. `bta_decimal.c`, `bta_bytes.c`, `bta_day.c`,
`bta_sqlite.c` and `bta_database.c` keep only class ids and class defs, written
at boot. A database connection is a class instance, which does not cross, so
each side opens its own and sqlite is serialized by default.

### What a worker sees in phase 1

Built the way the main context is — `bta_new_context`, the `init` functions,
`rad.js`, then `bta_close_hatches` — minus what the rule takes:

- **Gone, because GTK off the main thread is a crash:** every widget,
  `Dialog`, `Message`, `Clipboard`, `Screen`, menus, the printer, the desktop.
- **Gone, because it hangs a callback off the loop:** `Exec`, `File.Watch`,
  `Timer` (rad.js builds it on the captured `setTimeout`, so it is deleted
  *after* rad.js runs, not before), the asynchronous half of `Http`.
- **Gone, because it is process state the main thread owns:** `Settings`,
  and `Locale` — see below.
- **There:** the language and `rad.js` entire, `print`, `Logger`, `Decimal`,
  `Bytes`, `Day`/`Time`, `Hash`, `Dictionary`, `Regex`, `Stopwatch`, `Record`,
  `Field`, `Table`, `Sqlite`, an `Application` that answers facts, and
  `File`/`Directory` for reading.

### The catalogue, which is the one place a lock is coming

`bta_locale.c` holds the catalogue in a `static struct` with a `GHashTable`.
It is filled once by `bta_locale_init` during boot and read afterwards, so a
worker could read it with no lock at all — provided nothing reloads it while
the program runs. Phase 1 leaves `Locale` out of the worker rather than lean
on that, because a worker computes and the prose is assembled where it is
shown. **The day a language can be changed without restarting, that hash table
is the runtime's first real mutex**, and it is named here so it is not
discovered then.

## What is deferred, and what builds it

**A worker cannot write in phase 1.** `File.Save`, `File.Delete`,
`File.Rename`, `File.Copy`, `File.Trash`, `File.SaveBytes`, `Directory.Make`,
`Directory.Copy`, `Directory.Delete` and `Directory.DeleteTree` are refused —
and the refusal says why, in the words that are actually true:

> `File.Save: a task cannot write yet — two writers need a lock to order
> them, and there is none. See docs/plans/task-plan.md.`

Not *"a task reads the disk, it never writes it"*. The first sentence is a
deadline; the second is a philosophy, and this is not one. The correct answer
to two threads writing one file is to order them, and ordering them is what
the language is missing.

### `Lock`, the piece that lifts it

The trigger is nothing more than `Lock` existing. What forces its shape is
that the two runtimes share no JS heap: **a mutex here cannot be an object
passed in a message**, because no object crosses. `TCriticalSection`,
`QMutex` and .NET's `lock (obj)` are all shared instances and all assume a
common heap. The prior art that applies is the other tradition — **named**
synchronisation: Win32's `CreateMutex(NULL, FALSE, "Global\\Accounts")` and
POSIX's `sem_open("/accounts")`. The name is the only thing that crosses, as
text, and a table in C under one process mutex resolves it.

Once it is named rather than held, the verb should be a `Hold` with a callback
rather than `Enter`/`Leave`:

```js
Lock.Hold("accounts", () => {
    const book = File.Load(path);
    File.Save(path, add(book, row));
});
```

A `Leave` that a `throw` skips is a deadlock, and this language has settled
that shape twice already: `paint_frame` opens and closes around the drawing,
and `Exec.Wait` blocks to your face and says so. `Hold` on the main thread
freezes the window exactly as `Exec.Wait` does, and is honest for the same
reason — no nested loop runs, so nobody can close the form the caller is
standing in.

The scope when it lands is the ten verbs above, unrefused, and nothing else
about `Task` changes.

## What this explicitly is not

- **Not shared memory.** The message, every report and the answer cross as
  text. `Serialize`/`Load` is what a `Record` crosses as; a function, a widget
  or a cycle is refused out loud, because `JSON.stringify` would drop or null
  it in silence and a total that is wrong on one machine is worse than a
  refusal.
- **Not a pool, and not a future.** One `Task` runs once and answers once.
  Work that repeats is a new `Task`; the queue of stale jobs is exactly the
  thing a generation counter exists to drop.
- **Not preemptible.** `Stop()` and `Timeout` set a flag the engine's
  interrupt handler reads at an opcode boundary. A worker blocked in native
  code — a filesystem that never answers — is the one case no flag reaches,
  and teardown joins it rather than shooting it, because a thread cannot be
  signalled the way a child can.

## Cancelling, and how far it reaches

`Stop()` asks and `KillAfter` insists — two stages, the same two `Exec`'s
guard has. The flag the worker reads (`this.Stopping`) exists because the
first cut had only the enforcement: the interrupt handler ended the run at the
next opcode, so a job that had measured nine subtrees out of ten lost all
nine. Adding the flag alone was not enough either, and that is the part worth
writing down: **the interrupt and the flag were reading the same number**, so
the hard stop always won the race and `Run` never got to look. They had to
become separate states (`1` asked, `2` timed out, `3` forced) before the
cooperative half could exist at all.

### Where it stops reaching, and what `GCancellable` would buy

The interrupt only fires between opcodes, so a worker inside a native call
cannot be reached by any flag. GIO's answer to that is `GCancellable`: not a
way to kill a thread — nobody has one, and everybody who offered withdrew it
(`Thread.Abort`, `Thread.stop`, `pthread_cancel`) — but cooperation moved
inside the library, so a blocked call returns `G_IO_ERROR_CANCELLED` instead
of not returning.

**Measured, and it does not pay yet.** Of the six verbs a worker can call that
could block, exactly one takes a `GCancellable`:

| Verb | What it calls | Takes one |
|---|---|---|
| `File.Load` | `g_file_get_contents` | no — glib |
| `Directory.List` | `g_dir_open` / `g_dir_read_name` | no — glib |
| `Directory.Files` / `Folders` | `g_file_test` | no — glib |
| `File.Hash` | `g_fopen` / `fread` | no — libc |
| `File.Exists` | `g_file_test` | no |
| `File.Info` | `g_file_query_info` | **yes** |

And the one that takes it is the one that almost never blocks: what hangs on a
dead sshfs is the directory walk, and the walk is glib. Making it pay means
moving `Directory.*` to `g_file_enumerate_children` and `File.Load` to
`g_file_load_contents` — functions the **main thread** runs too, and a `GFile`
plus a `GFileInfo` per entry where there is a `readdir` today, which
`examples/usage` would feel on a hundred thousand files.

So teardown solves the symptom instead: a bounded wait of two seconds per live
task, and a thread still running when it passes is cast adrift rather than
joined, with its job deliberately left unfreed. The program closes and says
why. **The trigger for `GCancellable` is named rather than argued: the day
`Directory` and `File` move to GIO for some other reason, the cancellable is
nearly free and it goes in then.**

## Phases

1. **`Task` itself**, as `Task.md` specifies it: the class, the thread, the
   message, `Progress`/`Done`/`Error`, `Stop`, `Timeout`, teardown that joins.
   Worker built from the real `init` functions with the real classes. Writes
   refused with the deadline wording. Suite coverage in `tests/widgets`, and
   `examples/usage` as the program on record.
2. **`Lock`**, named, with `Hold`. The ten verbs stop being refused.
3. **The catalogue's mutex**, if and when a language can change at runtime.
4. **`GCancellable`**, if and when `File` and `Directory` move to GIO. Not
   before: one verb in six would take it, and the one that would is not the
   one that hangs.

Nothing in phase 2 or 3 changes phase 1's surface — which is the point of
writing them down now rather than defending the refusal later.
