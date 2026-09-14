# Debugging: what was built, and the plan for the rest

**Stages 1 and 2 are built** (2026-09-13): breakpoints, stopping, the call
stack, standing in a frame further up, its arguments and variables by name, and
step into / over / out. What is left is listed under [staging](#staging) and the
one thing deliberately not built first is [at the end](#dap-the-plan-to-evaluate).

This document is the design as well as the record: what *is* settled is recorded
as settled, with the number or the prior art that settled it, so that whoever
picks up the rest does not have to have the argument again.

## Why this is the gap that matters

Put the IDE beside the environments the [README](../README.md) names — Visual
Basic and Gambas — and beside Delphi and Lazarus, and four things are missing:
a debugger, packaging, a form bound to a table, and printing. Three of the four
have a substitute today. Exporting hands over the project tree; `SavePdf` writes
the page a printer would; a screen over a table is written by hand, twice, in
[`examples/quote`](../examples/quote) and [`examples/clients`](../examples/clients).

**Debugging has none.** It is `Logger.Debug`, save, run, read the pane. Every
other environment in this family has had breakpoints since the nineties.

## What *complete* means

The list a design here is judged against. It is what Visual Basic, Gambas and
Delphi all have, and none of the eleven is optional:

1. a breakpoint on **any** executable line, set and cleared without restarting
2. a conditional breakpoint, and one that only counts or logs
3. stopping on an **uncaught exception**, with the locals still alive
4. pausing a program that is running
5. step over, into, out, and run to the cursor
6. a call stack, and **standing in a frame further up** to see *its* locals
7. locals, arguments, `this` and closure variables **by name**, expanding
   objects and arrays
8. watches, re-evaluated at every stop
9. an immediate window: evaluating an expression in the **selected** frame
10. changing a value and carrying on
11. the gutter showing the breakpoints, and the stopped line highlighted

## The four ways in, and why only one of them arrives

**A. Instrument the source** — rewrite each `.js` as it loads, putting a call at
the head of every line. Touches no engine.

It gives 1 (partly), 8, 9 (partly) and 11, and **fails at 5, 6, 7 and 10**,
which is most of what a debugger is. It cannot stop inside an expression or in a
one-line arrow; the locals are reachable only through a direct `eval`, which
means reopening the hatch `close_hatches` shuts
(`runtime/src/bta_runtime.c`); there is no way to stand in a frame further up;
and **the program being debugged is not the program that runs**. *Prior art:*
this is how coverage meters work (istanbul, nyc), not debuggers. **Refused.**

**B. Patch the interpreter.** Gives all eleven. What is striking is how much is
already there and merely private:

| in `vendor/quickjs/quickjs.c` | what it is |
|---|---|
| `JSStackFrame` — `prev_frame`, `cur_func`, `arg_buf`, `var_buf`, `var_refs`, `cur_pc` | the whole stack, with each frame's arguments and locals: points 6 and 7 |
| `JSFunctionBytecode.vardefs`, and `JSVarDef.var_name` | their **names** |
| `pc2line_buf`, and `find_line_num(ctx, b, pc, &col)` | pc → line and column: point 1 |

*Prior art:* quickjs-debugger, txiki.js and Frida all do exactly this. None of
the three found another way. **Chosen.**

**C. Change engines** for one that ships a debugger — JerryScript has a remote
one, V8 has the whole Inspector. Gives all eleven without writing a debugger,
and costs the engine the rest of the project is built on: the closed hatches,
the `Decimal` operator patch, the binary size, and the reason QuickJS was picked.
**Refused, written down so it is not proposed twice.**

**D. Record and step backwards** (rr, Replay.io, VS Code's time travel). Not an
alternative: on its own it gives none of the eleven. It is a companion that would
be worth a great deal in an event-driven environment, and not before this.

## Patching the vendor is what this tree already does

`AGENTS.md` has a section called *The two patches in vendor/*:

- **Operators on a `Decimal`** — `quickjs.h` gains `JS_SetArithHandler`, and four
  of the arithmetic slow paths consult it before `ToPrimitive`. It is what makes
  `price * quantity + tax` exact.
- **JSON numbers and the decimal comma** — `json_parse_number` calls `js_atod`
  rather than `strtod`, because on a Spanish desktop `JSON.parse("0.05")`
  answered 0, silently.

With them comes the discipline this third one inherits whole: the marker
`Bintana patch` in the source, a section in `AGENTS.md`, an assertion in
`tests/widgets` that fails if an upgrade drops it, and the written rule to grep
for the marker after every QuickJS upgrade. **Dropping a patch here does not fail
to build** — that is the property all three share and the reason the assertion is
the part that matters.

The design pattern is settled too, by patch 1: a handler on the runtime, a public
typedef, and **an enum of our own so an embedder never depends on quickjs's
opcode numbering** (`js_arith_hook`). `JS_SetDebugHandler` is written the same
way, in the same file, beside it.

**And the split is the one patch 1 demonstrates: the least possible inside
`quickjs.c`, everything else in `runtime/src/bta_debug.c`**, which is the
project's own code and is documented and tested like the rest. Inside the vendor
go only the hook, the accessors to a frame and its variables, and the typedef in
`quickjs.h`.

## How it stops: measured, 2026-09-13

Three techniques, and the choice between them is a number and not an opinion.

1. **A branch per opcode** in the dispatch macro.
2. **Patching the bytecode** — the software breakpoint of every native debugger,
   gdb's `0xCC`: when a breakpoint is armed, the pc for that line is worked out
   from pc2line and the opcode there is replaced, the original kept. Stepping is
   temporary breakpoints on the lines of the function in flight and on its
   return, which is how debuggers without hardware support have always done it.
3. **A slot emitted by the compiler** at every line change, like V8's debug break
   slots. Costs always, a little.

Technique 1 was written, compiled and measured **with the debugger off** against
the unpatched binary, then reverted. A console project, three loops of 3 000 000
turns each, best of five within a run and the lowest of four runs:

| | no hook | hook compiled in, off | |
|---|---|---|---|
| arithmetic in a loop | 474.7 ms | 534.0 ms | **+12.5 %** |
| a call per turn | 746.7 ms | 848.4 ms | **+13.6 %** |
| property reads | 813.8 ms | 947.5 ms | **+16.4 %** |

**Between 12 % and 16 % for a branch that is never taken.** Measured twice, and
the second time is the one above: the first pass compared against a binary built
an hour earlier and came out 11–23 %, a spread that was the machine and not the
patch. Both binaries here were built from the same tree minutes apart, differing
only in whether `BTA_DEBUG_STEP` is in the two dispatch macros, and measured
back to back. It is not the load
from `rt` — that field is in cache — it is the conditional branch sitting in
front of the computed goto's indirect jump, which is the thing the processor's
predictor was getting right.

So **technique 1 is scaffolding and cannot stay**, and technique 2 is what gets
built: zero cost while nothing is armed, because bytecode with no breakpoints in
it is byte for byte today's. Technique 1 is still worth writing first — it is an
afternoon, and it is what technique 2 is then compared against for correctness.

## Where the program runs, and how it stops

**In another process**, as in Gambas, Delphi and Lazarus. Running it inside the
IDE — which is what Visual Basic did, and what gave it *edit and continue* —
**cannot work here**: stopping means blocking the interpreter without blocking
the interface, and with one GTK main loop that forces a nested one, which
re-enters the very program that is stopped. So *edit and continue* is out, and
neither Delphi nor Gambas nor Lazarus has it either.

Stopping is therefore **blocking the child**, reading commands where it stands.
Its window freezes, which is what every one of them does. Point 4 — pause — falls
out of the same hook: it looks at the channel as the line changes, with no extra
thread.

## The channel: ours, and minimal

**Decided.** A line-oriented protocol of our own, understood by this IDE, the way
Gambas talks to its own. The alternative is [below](#dap-the-plan-to-evaluate)
and is deliberately not what gets built first.

### What it asks of the runtime — **built**

**One method and one option on `Exec`**, and both are general rather than the
IDE's:

| | |
|---|---|
| `job.Write(text)` | say something to a child. The handle has `ProcessId`, `Running`, `ExitCode`, `TimedOut`, `Stop()` and `Kill()`, and no way to talk to it at all |
| `Exec(argv, { Control: (line) => … }, …)` | a **third stream**, on descriptor 3, for a child that speaks a protocol as well as printing |

The third stream is the part worth arguing. stdout is taken: the program being
debugged prints, and that is what the output pane shows. Marking protocol lines
with a prefix would mean a program that prints the prefix breaks the debugger —
rare, silent, and impossible to explain. stderr is taken too, by tracebacks. A
descriptor of its own is the only answer with no failure mode, and `Exec` already
knows how to hand a stream to a callback (`Stderr: "separate"` is the precedent).

*Prior art:* the Language Server Protocol owns a process's stdin and stdout
because its servers print nothing else; gdb/MI the same. Neither is our case.

### The messages

One JSON object per line — the runtime has `JSON`, the IDE parses it with what it
already uses, and a person can read a session out of a log.

From the child, on descriptor 3:

```
{"event":"ready"}
{"event":"stopped","reason":"breakpoint"|"step"|"exception"|"pause",
 "frames":[{"name":"Btn_Click","file":"Form1.js","line":42}, …]}
{"event":"resumed"}
{"event":"exited","code":0}
```

From the IDE, on stdin:

```
{"do":"break","file":"Form1.js","line":42,"id":7}     ← built
{"do":"clear","id":7}                                 ← built
{"do":"continue"}  {"do":"pause"}                     ← built
{"do":"step","kind":"over"|"into"|"out"}              ← built
{"do":"locals","frame":0}                             ← built
   → {"reply":"locals","frame":0,"items":[{"Name":"n","Value":"3","Argument":true}, …]}

{"do":"break", … ,"when":"n > 3"}                      stage 4
{"do":"runto","file":"Form1.js","line":88}            stage 2's other half
{"do":"eval","frame":0,"text":"this.Ok.Text"}         stage 3
{"do":"set","frame":0,"name":"n","text":"4"}          stage 3
{"do":"stopOnThrow","value":true}                     stage 6
```

**A verb this build does not have is ignored and not refused**, which is what
lets a newer IDE talk to an older runtime at all. What it must never do is
*accept* one and do nothing: `stopOnThrow` was written that way for an hour --
the field was set and nothing ever read it -- and taking it back out was the
fix. A verb appears in `bta_debug.c` when it works and not before.

Two rules that keep it honest. **The frames are the child's own numbering**, so
`frame` means the same thing in every message about one stop. And **a value is
sent as text the child rendered**, never as JSON of the object: a live object is
not serialisable in general, and a debugger that could not show one would be
useless exactly where it matters. Expanding is a second `locals` against a path.

## Staging

| | what lands | of the eleven | |
|---|---|---|---|
| **1** | `JS_SetDebugHandler` in the vendor (technique 1), `bta_debug.c` with the channel and the stack, `bintana --debug`, breakpoints in the gutter through `SourceEditor.Mark(line, "Bookmark")`, a *Debug* page on `ConsoleBox`, Continue, Pause and Stop | 1, 4, 6, 11 | **built** |
| **2** | step over / into / out, standing in a frame, and locals/arguments/`this` by name off `vardefs` | 5, 6, 7 | **built** |
| **3** | expanding an object, watches, the immediate window, changing a value | 8–10 | |
| **4** | conditional and logging breakpoints — with stage 3 done, the condition is evaluated in the frame before the stop is reported | 2 | |
| **5** | technique 2, the bytecode patch, measured against the same benchmark | — | |
| **6** | stopping on an uncaught exception, with the locals still alive | 3 | |

Two things stage 1 needed that this document did not foresee, both found by
running it:

- **A line with no pc2line entry of its own cannot stop.** QuickJS emits one
  where the line *changes*, so two statements it runs together share one and
  `let total = 0;` right under `function Main() {` has none. A breakpoint there
  armed and never fired, silently. `JS_DebugLines` reads the whole map out of a
  compiled file, the breakpoint is **moved to the next line that exists**, and
  the IDE is told where it went — which is what every editor does with a click
  on a blank line, and it is why a file is compiled and run in two steps under
  `--debug`.
- **Moving a breakpoint is per *file*, and should be per *function*.** The set
  of lines is the whole file's, so a breakpoint past the last statement of a
  method moves into the next one. Visible rather than silent -- the mark moves
  and the log says so -- and the fix wants the line ranges per function, which
  is the same table stage 5 needs to patch a pc.
- **"Have we left this line?" is a question about a frame, not about the
  program.** A single "last line seen" stopped a breakpoint inside a function
  called three times from firing more than once, and then made a line that
  contained a call stop twice — once going in and again coming back.
  `JSStackFrame` grew a `debug_line` of its own; the memory belongs to the frame
  because the question does.

## What it costs outside the code

Documentation is part of the change here, not after it. A third entry in
*The two patches in vendor/* in `AGENTS.md` — which becomes *three* — saying what
breaks if an upgrade drops it. A row for `Write` and for `Control` in
[`runtime-api.md`](runtime-api.md), [`llm/library.md`](llm/library.md) and
[`reference/globals/Exec.md`](reference/globals/Exec.md), which `tests/api.sh`
demands. A *Debugging* section in [`ide.md`](ide.md), and a paragraph in the
README. And an assertion in `tests/widgets` that fails when the patch is gone,
alongside the two that already do.

## DAP: the plan to evaluate

The Debug Adapter Protocol is what VS Code speaks and what quickjs-debugger
implements. It is **not** what gets built first, and it is written down here so
that picking it up is a decision rather than a rewrite.

**What it would buy.** VS Code, and every editor that speaks DAP, would debug
Bintana with nobody writing an editor plugin. If *competitive* includes the
person who is not going to leave their editor, that is the whole of the point —
and it is the one thing our own protocol can never grow into by accident.

**What it would cost.** DAP is JSON-RPC with a header framing, a capabilities
handshake, and a wide surface: `initialize`, `launch`/`attach`,
`setBreakpoints`, `setExceptionBreakpoints`, `stackTrace`, `scopes`,
`variables`, `evaluate`, `continue`, `next`, `stepIn`, `stepOut`,
`setVariable`, plus the `stopped`/`continued`/`terminated` events. Most of it
maps onto the messages above almost one to one, which is the observation that
makes this cheap to evaluate later and expensive to guess at now.

**The three things to decide when it is evaluated**, none of which needs
deciding today:

1. **Where the adapter lives.** Outside, as a small translator process speaking
   DAP on one side and our lines on the other — which keeps the runtime's
   surface unchanged and is how most languages ship one. Or inside, as a second
   dialect of `bta_debug.c`, which is less to install and more to maintain.
   *The translator is the likely answer*, and the reason to keep our protocol
   close to DAP's shape is precisely that it makes one thin.
2. **`variables` and its reference handles.** DAP addresses a nested value by an
   integer handle the adapter hands out and the client asks back. Ours addresses
   it by a path. Whichever this ends up doing, **the child must not hold handles
   across a resume** — they are meaningless once the program has moved, and a
   debugger that shows a stale object is worse than one that shows nothing.
3. **`attach`, which we do not have.** Everything above is `launch`: the IDE
   starts the program. Attaching to one already running needs a channel that
   exists before the debugger does — a socket, or a signal that opens one — and
   that is a runtime capability of its own, not a protocol question.

**What would make it worth doing.** Not this document's argument; a caller. The
same test every other deferral in this tree is held to: somebody who wants to
debug a Bintana program from an editor that is not this one. Until then it is a
plan with its foundations poured, which is a better position than a half-built
adapter waiting for a plan.
