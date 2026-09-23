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
for a child stopped by a signal), `TimedOut`, `Stop()`, `Kill()` and
`Write(text)`.

**The options**:

| | |
|---|---|
| `Directory` | where to start the child |
| `Environment` | names to add or change; a `null` value **removes** one. A change, not a replacement. A value that cannot become text — a `Symbol`, an object whose `toString` throws — is refused by the call and not skipped |
| `Stderr` | `"separate"` keeps the streams apart — the line callback then gets `"out"`/`"err"` as its second argument. Merged is the default, and merging is what keeps the order |
| `Timeout` | milliseconds before the child is ended; absent waits forever |
| `KillAfter` | milliseconds between SIGTERM and SIGKILL, `5000` by default |
| `Control` | a callback for a **third stream** — descriptor 3 in the child, one line at a time — for a child that speaks a protocol as well as printing |

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

**A run is not over when its leader is.** It ends when stdout is drained *and*
the child has exited, and `sh -c "server & echo up"` leaves a grandchild holding
the pipe after the shell is gone. `Stop()`, `Kill()` and `Timeout` still reach
that grandchild -- through the group, and never through the leader's pid, which
the system may have handed to somebody else by then. They used to answer false
and do nothing, and the exit callback never came.

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

**The output is captured as bytes and handed over whole**, so a NUL in it is a
character of the answer and not the end of it. That matters for exactly the
tools this is for: `git status -z`, `find -print0` and `xargs -0` separate their
records with a NUL *because* it is the one byte a file name cannot contain, and
a capture that stopped at the first one read one record and lost the rest --
silently, which is the worst shape a bug can have. A file name with a space in
it was readable; a list of them was not.

## Talking to one

`Stop` and `Kill` were the only two things that could be said to a child, and
both of them end it. What was missing was the ordinary thing: a child that reads
a line and answers.

| | |
|---|---|
| `Write(text)` | writes a line to the child's stdin. A newline is added when there is not one, because a line is what the other side is waiting on. **Queued, and never blocks**: lines go out in order while the program keeps running, so a child that writes while it reads cannot deadlock it. Answers whether there was still a child to write to, the way `Stop` does |
| `Control` | an option: a callback for the child's **descriptor 3**, called once per line — until the run is over (stdout drained, child exited); a line after that is dropped |

```js
const job = Exec(["some-tool", "--protocol"],
                 { Control: (line) => answer(JSON.parse(line)) },
                 (line) => log(line),
                 (code) => done(code));

job.Write('{"do":"begin"}');
```

**Why a third stream and not a marker on stdout.** stdout is what the child says
to a *person* — it is what a log pane shows — and marking the protocol lines
with a prefix means a child that prints the prefix breaks its own tooling,
silently and rarely. stderr is taken too, by whatever the language prints when
something goes wrong. A descriptor of its own is the only spelling with no
failure mode. It is what `bintana --debug` writes on, and the IDE's debugger is
its first caller.

**The control stream ending is not the child ending.** It closes when the child
stops speaking the protocol; what says the run is over is still stdout draining
and the process being reaped, which is what the exit callback waits for.

**A child's stdin is a pipe whether or not anything writes to it**, which is a
change from inheriting the parent's. A child that reads stdin and is written
nothing waits — as it did before — but it can no longer take the terminal the
application was started from.

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
