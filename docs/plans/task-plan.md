# Task: a class that runs in a thread of its own

**Status: built, all six phases.** The surface is
[`docs/reference/globals/Task.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/reference/globals/Task.md), which was
written first and is the specification this follows. Two things were named
while writing it and are deliberately not rows of this plan: markdown's parser,
which waits for a use case, and a debugger in a worker, which is a design of its
own. Neither is a limitation this plan ships with.

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

### What a worker sees

Built the way the main context is — `bta_new_context`, the `init` functions,
`rad.js`, then `bta_close_hatches` — minus what the rule takes:

- **Gone, because GTK off the main thread is a crash:** every widget,
  `Dialog`, `Message`, `Clipboard`, `Screen`, menus, the printer, the desktop.
- **Gone, because it hangs a callback off the loop:** `File.Watch`, `Timer`
  (rad.js builds it on the captured `setTimeout`, so it is deleted *after*
  rad.js runs, not before), and the callback spelling of `Exec` and `Http`.
- **There:** the language and `rad.js` entire, `print`, `Logger`, `Decimal`,
  `Bytes`, `Day`/`Time`, `Hash`, `Dictionary`, `Regex`, `Stopwatch`, `Record`,
  `Field`, `Table`, `Sqlite`, an `Application` that answers facts,
  `File`/`Directory` for reading, **`Locale` whole** — its catalogue is this
  worker's own, pinned to the language at `Start` (see below) — the blocking
  `Exec.Wait` and `Http.*Wait`, `Environment` read-only, and `Settings` with
  its setter refused.
- **Libraries a pure module can import:** `xlsx` and `qr`'s encoder are
  modules with no widget in them, so a task's `import { Xlsx } from "xlsx"` /
  `import { QrCode } from "qr"` works. A script beside the module (`QrView.js`)
  is skipped. A library of several modules declares the safe subset in
  `project.json`'s `worker` list: `load_library1` evaluates only those files in
  a worker, refuses a script named there, and refuses an empty list instead of
  falling back to `sources`. Without the key the old answer stands, which is
  what makes a one-module library cross with no manifest at all.
- **`markdown` is not split, and deliberately so:** no consumer in the tree
  parses Markdown off the main thread. Its `project.json` declares an **empty**
  `worker` list, so importing it in a task refuses with "declares no worker
  files" instead of failing inside the module on `Component`; when a consumer
  appears, the parser becomes a module and that list gains its name. The split
  waits for that, rather than inventing an API nobody asked for.

### The catalogue, which is per thread and not behind a lock

`bta_locale.c` holds the catalogue in a `GHashTable` inside a `GPrivate`, so
**every thread has its own**. The main thread fills its own from `po/` and can
reload it with `Locale.Current`; a `Task` worker builds its own from the same
directories, pinned to the language the application had at `Start`
(`bta_locale_init_for`). The two never read or free each other's table, which is
what makes `Locale.Text` in a worker safe without a lock.

A lock was the other answer, and it is not enough by itself. `bta_locale_lookup`
returns a **borrowed** pointer into the table, and `bta_locale_format` converts
its arguments with `JS_ToCString` before it walks the template; a `toString`
there can assign `Locale.Current`, and the reload frees the entry the template
points into. That is a same-thread use-after-free, not a cross-thread race: a
lock around the lookup does not reach it, and one held across the conversion
would deadlock the reload. **`bta_locale_format` copies the template before it
runs any JavaScript**, which is what makes one call see one catalogue from the
first hole to the last.

A per-worker snapshot also gives a task the semantics a form already has: the
words it started with do not change underneath it. A shared table behind a
per-call lock would let a report translate page one in `es` and page two in
`en`. If the cost of parsing the `.po` per task ever matters, the storage can
become a refcounted immutable catalogue without changing the `Locale` surface;
it is not a reason to start with a lock.

`Locale.Read` and `Locale.Write` are the catalogue editor's pair and touch no
catalogue at all — list mode never reaches `po_header` — so a worker gets them
with the rest.

## Writing, and the lock that is not its condition

**Phase 1 refused the eleven verbs that change the disk**, with a message that
named a real gap and aimed it at the wrong danger:

> *a task cannot write yet — two writers need a lock to order them*

Measured, that danger does not exist. `File.Save` is `g_file_set_contents`,
which GLib documents as atomic: it writes a temporary and renames over the
target, so two threads saving one path produce **one of the two whole files**
and never a mixture. `File.Delete` is `unlink` and `File.Rename` is `rename`,
a syscall each. The three that do leave a visible intermediate state —
`File.Copy`, `Directory.Copy`, `DeleteTree` — leave exactly the one that
`Exec(["cp", …])` leaves, and nobody proposed refusing that.

So the refusal is lifted, and it is lifted *before* `Lock` rather than by it.
A worker writes.

### What a lock is actually for

The cost of concurrency here is the **lost update**, and it is a different
shape entirely:

```js
const book = File.LoadJson(path);      // two tasks read the same thing
File.SaveJson(path, add(book, row));   // the second wins, and the first row never happened
```

Every call is atomic and the result is still wrong, because the gap is
*between* two calls. **Measured** with four tasks adding to one counter, sixty
rounds each: **68 of 240** without the hold and **240 of 240** with it. **No automatic lock can close it**: a lock inside
`File.Save` would guard a call that needs no guarding, and only the program
knows which two calls belong together. That is what makes the name the
program's to choose, and it is why a `Hold` deduced from the path would be
theatre.

## `Lock`, for the sequence — built

```js
Lock.Hold("accounts", () => {
    const book = File.LoadJson(path);
    File.SaveJson(path, add(book, row));
});
```

**Static, and the name is the lock.** Not `new Lock("accounts")`: an instance
suggests the instance is the thing being held, and it is not — two tasks that
each build one still take the same lock, which is the whole point, and an
object would make that look like a bug. Nothing crosses in the message but
text.

**Named rather than held**, because the two runtimes share no JS heap and no
object can cross one. `TCriticalSection`, `QMutex` and .NET's `lock (obj)` are
all shared instances assuming a common heap; the tradition that applies is the
other one — Win32's `CreateMutex(NULL, FALSE, "Global\\Accounts")` and POSIX's
`sem_open("/accounts")`. And it pays twice: a name is the indirection that
lets the mechanism behind it change without a single call site moving, and it
is what lets a stuck program say *waiting on "accounts", held by `Hasher` for
twelve seconds* where an anonymous mutex can only say *waiting*.

**A callback and not `Enter`/`Leave`, which the interrupt handler made
compulsory.** A forced `Stop()` ends a worker at an arbitrary opcode. With
`Enter`/`Leave` the `Leave` would never run, the mutex would stay held
forever, every other thread asking for that name would block, and teardown
would cast them all adrift. With `Hold` the unlock is in C after the
`JS_Call`, so it runs whether the function returned or was interrupted. What
was a preference in every other language is a correctness requirement here.

**It returns nothing.** `lock` in .NET, `synchronized` in Java, `with` in
Python, `QMutexLocker`, Delphi's `try`/`finally` and Go's `defer` are all
**statements**: the critical section is a block, not an expression. That this
one is a function is an accident of having no block syntax, not an invitation.
A value read under the lock comes out the way `Hasher.read()` does it, and a
`Lock.Try(name, fn)` that may not run is left free to answer a plain boolean.

**Recursive.** `lock` is reentrant in .NET because `Monitor` is, `synchronized`
is in Java, and Delphi's `TCriticalSection` is because Win32's
`CRITICAL_SECTION` is. Qt and pthreads are not by default and both offer the
variant, because people deadlock. A nested `Hold` of one name in a language
where a function calls a function that saves something would be an instant and
**silent** deadlock, and silent is what this project spends its comments
avoiding. `GRecMutex`, kept in a `GHashTable` under one process mutex, created
on demand and never destroyed — freeing one while somebody waits on it is the
bug not worth writing.

**No timeout in v1.** `GRecMutex` has no bounded wait, so one would mean
`trylock` in a sleep loop, which lies about its latency. On the main thread a
`Hold` freezes the window exactly as `Exec.Wait` does and is honest for the
same reason: no nested loop runs, so nobody can close the form the caller is
standing in. The documented rule is that a `Hold` on the main thread is short
or it does not belong there.

### How it grows, and what it will not

Named with triggers, so the deferral is not a punt:

- **`Hold(name, { Timeout }, fn)`**, when somebody has to take a lock in a
  handler without risking the window. Options in the middle, as `Exec` and
  `Dialog` already take them. The cost is known: `GRecMutex` has no timed
  wait, so the inside becomes a `GMutex` plus a `GCond` with owner and count
  kept by hand — some thirty lines, and no call site changes, because the name
  is the indirection.
- **`Lock.Read` / `Lock.Write`**, with `Hold` meaning `Write`, when read
  contention shows up in a measured program. `GRWLock`,
  `ReaderWriterLockSlim`, `QReadWriteLock` and Delphi's
  `TMultiReadExclusiveWriteSynchronizer` are the four names for it. One name
  cannot have two mechanisms behind it, so this is promised now.
- **Diagnosis**, the first time somebody hangs: who holds a name and since
  when, said out loud after a few seconds rather than asked for by a call.
- **`Lock.File(path, fn)`** over `flock`, when the other writer is an `Exec`
  rather than a task. A separate verb and never a flag on `Hold`, because the
  two are **separate namespaces that do not guard each other**, and hiding
  that behind an option is the kind of trap paid for at night.

Not coming, and named so it is not re-argued: **condition variables**
(`Wait`/`Signal`), because the channel between threads already exists and is
`Report`/`Progress` — without shared memory to watch, a condition is a second
channel competing with the first. And **`Lock.Held(name)`**, a question that
lies, since by the time it answers it has changed; Java has `holdsLock` and it
lives inside `assert`.

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

### Where it reaches: the job's `GCancellable`, built

The interrupt only fires between opcodes, so a worker inside a native call
cannot be reached by a flag. GIO's answer is `GCancellable`: not a way to kill
a thread — nobody has one, and everybody who offered withdrew it (`Thread.Abort`,
`Thread.stop`, `pthread_cancel`) — but cooperation inside the library, so a
blocked call returns `G_IO_ERROR_CANCELLED` instead of not returning.

Each `BtaTaskJob` owns one, and `Stop`, `Timeout` and `KillAfter` cancel it.
A program can also start a task with its own [`Cancellable`](https://github.com/getbintana/bintana-docs/blob/main/docs/reference/globals/Cancellable.md):
the job holds that signal instead of a fresh one, `this.Cancellable` inside
`Run` wraps the same object, and `Cancel()` asks the task to stop exactly as
`Stop()` does -- cooperative, without a `KillAfter` of its own.
The calls that take it now:

| Verb | What it calls | |
|---|---|---|
| `Exec.Wait` | `g_subprocess_communicate_async`, then SIGKILL on cancel | yes |
| `Http.*Wait` | `soup_session_send_and_read_async`, linked to the job | yes |
| `File.Load` / `LoadBytes` | `g_file_load_contents` | yes |
| `File.Info` | `g_file_query_info` | yes |
| `File.Copy` / `File.Trash` | `g_file_copy` / `g_file_trash` | yes |
| `Directory.List` / `Files` / `Folders` | `g_file_enumerate_children`, checked between entries | yes |
| `Directory.Copy` / `DeleteTree` | the same walk, with `g_file_copy` / `g_file_delete` | yes |

`File.Load` moved from `g_file_get_contents` to `g_file_load_contents` for
this; the main thread gets the same `GFile` read with a NULL cancellable. The
**directory walk** moved from `g_dir_open`/`readdir` to
`g_file_enumerate_children` for the same reason, so `List`, `Files`, `Folders`,
`Copy` and `DeleteTree` stop where they are, including part-way down a
recursive walk. `File.Hash` and the compressors still take no signal and wait
for the flag or `KillAfter` between opcodes.

Teardown still has the bounded two-second wait and casts an unresponsive worker
adrift: `File.Hash` and the compressors have no signal to take, so the bound is
still the only backstop for them.

## Phases

1. **`Task` itself**, as `Task.md` specifies it — **built**: the class, the
   thread, the message, `Progress`/`Done`/`Error`, `Stop`/`Stopping` with
   `KillAfter`, `Timeout`, `Cancelled`, teardown that joins with a bound.
   Worker built from the real `init` functions with the real classes, and
   `rad.js` split from `forms.js` so it can be. Suite coverage in
   `tests/widgets`, `examples/usage` as the program on record.
2. **The writes, unrefused** — **built**, and *not* by phase 3: the danger
   they were refused for is one GLib already handles, and the danger that is
   real is a sequence no runtime-level lock can see.
3. **`Lock.Hold(name, fn)`** — **built**: static, recursive, answering
   nothing, releasing whether the function returned, threw or was interrupted.
   `runtime/src/bta_lock.c`, 150 lines including why.
4. **The catalogue per worker** — **built**: `Locale` is thread-local, the
   worker builds its own with the language at `Start` (`bta_locale_init_for`),
   and `bta_locale_format` copies the template before it runs JavaScript. A
   lock is not needed; the argument is above.
5. **`Task.Max`** — **built**: a live-task ceiling, `0` for no limit, refused
   rather than queued. The count is a thread and a runtime each, which is what
   makes a ceiling worth having.
6. **`GCancellable`** — **built where it pays**: a job owns one, `Stop`,
   `Timeout` and `KillAfter` cancel it, and `Exec.Wait`, `Http.*Wait`, the GIO
   file verbs and the directory walk take it. `File.Hash` and the compressors
   do not, and are not on this plan's path.

The order matters, and it is the one thing this plan got wrong the first time:
**phase 2 was written as if phase 3 were its condition.** It was not. A
refusal justified by a missing feature is only honest while the feature is
what is missing — and here it was a measurement, not a feature. Stating the
trigger is what made that findable.

### Beyond this plan

Two things were named while writing it and are not rows left to build:

| | why it is not here |
|---|---|
| `markdown`'s parser as a worker module | It waits for a task that parses a `.md` — an index of notes, a table of contents, a document exported off the main thread. The viewer and the IDE help run on the page, so they do not. |
| a debugger in a worker | A second debug session, because the protocol is one control descriptor and `dbg` is process state. That is a design of its own, not a flag on this one. |
