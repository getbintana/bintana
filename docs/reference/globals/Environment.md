# Environment

The context the program was started in.

The variables it inherited, the directory it was started from, and the handful of
facts about the machine and the person running it.

## Every member

| | | |
|---|---|---|
| `CurrentDirectory` | where the process is; **assigning enters** | [where it is running](#where-it-is-running) |
| `Get(name)` | → a variable, or `null` | [the variables](#the-variables) |
| `HasDisplay` | → whether there is a screen at all | [the machine](#the-machine) |
| `HomeDirectory` | the user's home | [where it is running](#where-it-is-running) |
| `HostName` | this machine's name | [the machine](#the-machine) |
| `OS` | which operating system | [the machine](#the-machine) |
| `OSVersion` | and which version of it | [the machine](#the-machine) |
| `ProcessId` | this process's id | [the machine](#the-machine) |
| `ProcessorCount` | how many cores | [the machine](#the-machine) |
| `Set(name, value)` | sets one; `null` removes it | [the variables](#the-variables) |
| `TempDirectory` | where temporary files belong | [where it is running](#where-it-is-running) |
| `UserName` | who is running it | [the machine](#the-machine) |
| `Variables` | all of them | [the variables](#the-variables) |

## The variables

| | |
|---|---|
| `Get(name)` | the variable, or `null` — which is the difference between *empty* and *not set*, and both happen |
| `Set(name, value)` | sets one; `null` **removes** it. It is `export`, so it affects everything started **afterwards** and nothing already running |
| `Variables` | all of them at once, as an object |

Setting one before an [`Exec`](Exec.md) is rarely what is wanted: that call takes
an `Environment` option of its own, which changes the child's without touching
this process's.

## Where it is running

| | |
|---|---|
| `CurrentDirectory` | where the process is. **Assigning enters it, and throws if there is no such directory** — a failure worth hearing about, since everything relative afterwards would otherwise be wrong |
| `HomeDirectory` | the user's home |
| `TempDirectory` | where a temporary file belongs |

**A project's own files are not here**: that is
[`Application.Directory`](Application.md), and what a program remembers is
[`Application.ConfigDirectory`](Application.md). The current directory is where
the program was *started from*, which is the user's business and not the
application's.

## The machine

| | |
|---|---|
| `HasDisplay` | whether there is a screen at all — what a tool that may run over ssh asks before opening a window |
| `UserName` | who is running it |
| `HostName` | and on which machine |
| `OS` | which operating system |
| `OSVersion` | and which version of it |
| `ProcessorCount` | how many cores — for the `-j` of a build, and little else |
| `ProcessId` | this process's id, for a scratch name that two runs will not share |

## What is not here

The **command line** is [`Application.Arguments`](Application.md) and quitting is
`Application.Quit`: those belong to the application and not to the system it was
started in.

## What goes wrong

- **`Set` did not reach a running child.** It is `export`: it affects what starts
  afterwards.
- **A relative path resolved somewhere unexpected.** It resolved against
  `CurrentDirectory`, which is where the user started the program;
  `File.Join(Application.Directory, …)` is what a project's own file wants.
- **A window opened over ssh and failed.** `HasDisplay`.

## See also

[`Application`](Application.md) · [`Exec`](Exec.md) · [`File`](File.md)
