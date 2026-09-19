# Lock

Taking turns, by name.

```js
Lock.Hold("accounts", () => {
    const book = File.LoadJson(path);
    File.SaveJson(path, add(book, row));
});
```

One member, because a critical section is one idea.

## Every member

| | | |
|---|---|---|
| `Hold(name, fn)` | runs `fn` with the named lock held. Answers nothing | [holding](#holding) |

## What it is for

**Not for keeping a file whole.** `File.Save` is atomic — it writes a temporary
and renames it over the target — so two threads saving one path produce one of
the two whole files and never a mixture. `File.Delete` and `File.Rename` are a
syscall each.

What concurrency costs is the **lost update**:

```js
const book = File.LoadJson(path);      // two tasks read the same thing
File.SaveJson(path, add(book, row));   // the second wins, and the first row never happened
```

Every call there is atomic and the answer is still wrong, because the gap is
*between* two calls. Measured with four [tasks](Task.md) adding to one counter,
sixty rounds each: **68 of 240 without the hold, 240 of 240 with it.** Only the
program knows which two calls belong together, which is why the name is yours
to choose and why no lock the runtime could put on a call would reach this.

## Holding

| | |
|---|---|
| `Hold(name, fn)` | takes the lock called `name`, runs `fn`, releases it — whether `fn` returned, threw, or was interrupted |

**A name and not an object.** A `Task` runs in a runtime of its own and the two
share no heap, so no object can cross in a message — only text can. That is the
Win32 `CreateMutex(NULL, FALSE, "Global\\Accounts")` tradition rather than the
`lock (obj)` one, and it pays twice: what is behind the name can change without
a call site moving, and a stuck program can be told *waiting on "accounts"*
where an anonymous mutex can only say *waiting*.

**Recursive.** A nested `Hold` of the same name from the same thread is fine,
as `lock` is in .NET and `synchronized` is in Java. Without that, one function
calling another that saves something would be an instant and silent deadlock.

**It answers nothing.** `lock`, `synchronized`, `with`, `QMutexLocker`,
Delphi's `try`/`finally` and Go's `defer` are all statements: a critical section
is a block, not an expression. Read a value out the way a variable does:

```js
let book;
Lock.Hold("accounts", () => { book = File.LoadJson(path); });
```

**A callback and not `Enter`/`Leave`**, which here is correctness and not
taste: a forced [`Stop()`](Task.md#ending) ends a task at an arbitrary point,
so a `Leave` would never run and the lock would stay held for the life of the
program. The release is in C after the call, so it happens either way.

## The two rules that are not enforced

**On the main thread a `Hold` freezes the window** while it waits, exactly as
[`Exec.Wait`](Exec.md) does, and is honest for the same reason: no nested loop
runs, so nobody can close the form the caller is standing in. Keep it short, or
keep it off the main thread.

**Two locks taken in two orders deadlock**, here as everywhere: one thread
holding `"a"` and asking for `"b"` while another holds `"b"` and asks for `"a"`
waits forever. Take them in one order, or take one.

## What goes wrong

- **Nothing is ordered.** The two calls that belong together are not both
  inside the same `Hold` — the classic being a read at the top of a function
  and a write at the bottom, with the hold around only the write.
- **Everything is ordered.** The expensive work is inside the hold, so the
  threads take turns doing it and the program is slower than one thread. Hold
  it for the read and the write; do the computing outside.
- **A hold that never ends.** Something in `fn` waits for a second lock, or for
  a task that is itself waiting for this one.
