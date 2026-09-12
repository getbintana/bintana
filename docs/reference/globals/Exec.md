# Exec

Running another program, and reading what it prints.

```js
Exec(["git", "status", "--short"],
     (line) => this.Log.Append(line + "\n"),
     (code) => this.done(code));
```

`argv` is an **array, never a shell string**: there is no shell to quote for, so a
file name with spaces cannot turn into a command. stdout and stderr are merged,
read asynchronously and split into lines, and both callbacks are optional.

## Every member

`Exec` is a function, and what it hands back is a handle.

| | | |
|---|---|---|
| `Exec(argv, [options], [onLine], [onExit])` | starts a child and answers a handle | [running one](#running-one) |
| `Exec.Wait(argv, [options])` | runs it and **waits**, answering what it printed | [waiting for one](#waiting-for-one) |

**The handle**: `ProcessId`, `Running`, `ExitCode` (`null` while it runs, `-1`
for a child stopped by a signal), `TimedOut`, `Stop()` and `Kill()`.

**The options**:

| | |
|---|---|
| `Directory` | where to start the child |
| `Environment` | names to add or change; a `null` value **removes** one. A change, not a replacement |
| `Stderr` | `"separate"` keeps the streams apart — the line callback then gets `"out"`/`"err"` as its second argument. Merged is the default, and merging is what keeps the order |
| `Timeout` | milliseconds before the child is ended; absent waits forever |
| `KillAfter` | milliseconds between SIGTERM and SIGKILL, `5000` by default |

## Running one

The line callback arrives per line as the child prints, so a log fills in while
the work happens. **The exit callback runs only once both pipes have seen EOF**,
so everything the child printed is already in the buffer when it does — which is
what makes *read the last line in the exit handler* correct.

```js
const job = Exec(["make", "-j4"], { Directory: build, Timeout: 180000 },
                 (line) => print(line), (code) => print(`done ${code}`));
job.Stop();
```

`Stop()` sends SIGTERM and `Kill()` SIGKILL, **both to the child's whole process
group**, so a wrapper's own children go too — which is the difference between
stopping a build and orphaning four compilers.

## Waiting for one

```js
const r = Exec.Wait(["msgfmt", "--check", po]);
r.ExitCode      // the status
r.Output        // everything it printed
```

For the case that hurts otherwise: a check that decides what the next line of
code does. It blocks the main loop, so it is for programs that answer in
milliseconds — `msgfmt`, `git rev-parse`, `which` — and never for one that might
sit there.

## A log pane, not a terminal

**`Exec` plus a read-only [`TextEditor`](../widgets/TextEditor.md) is a log
pane**, and it is what to reach for rather than a
[`Terminal`](../widgets/Terminal.md): `Append` writes at the end and scrolls
there whatever the cursor was doing, and it works with `ReadOnly` on. A pty buys
typing, colour and `less`; if the program does none of those, it is a dependency
paid for nothing. The IDE's own output pane is exactly this.

## What goes wrong

- **A path with spaces broke the command.** It cannot here — unless the argv was
  built by splitting a string, which is the habit this signature exists to
  break.
- **The program was not there.** `Exec` throws; [`Application.HasCommand`](Application.md)
  is the question that does not need an exception.
- **The output arrived out of order.** The streams were separated: merged is
  what keeps the order.
- **The child outlived its window.** Keep the handle and `Stop()` it in
  `Form_Close`.
- **A `Wait` froze the window.** That is what waiting is; use the callback form.

## See also

[`Terminal`](../widgets/Terminal.md) · [`TextEditor`](../widgets/TextEditor.md) ·
[`Application`](Application.md) · [`examples/usage`](../../../examples/usage)
