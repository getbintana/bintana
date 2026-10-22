# ISSUE: the debugger's values are flat lines, and it cannot break on data

## What the application needed

Stop at a line, see what a variable holds, and open it. The concrete gesture:
the value panel shows `client` as a row, and clicking it opens the client's
fields — name, code, balance — each of which opens in turn. And a breakpoint
that says "stop when `client.balance` changes", so the line that mutates a
field is found without scattering prints through the program.

## What I wrote instead

The runtime flattens first. `runtime/src/bta_debug.c:330-436` (`render()`)
renders an object as one flat string, one level deep, nested values as `{…}`
and `[…]`, truncated at `RENDER_WIDTH 120` (`:330`, `:416-428`); the comment
at `:336-340` says it outright: *"the panel has a line and not a tree"*. The
IDE then shows each value as an ellipsised label: `ide/modules/Debugger.js:518-530`
(`fillValues()`), `:532-573` (`addValue()`) — a `Panel` row of two `Label`s,
the value one with `shown.Ellipsize = true` (`:562-566`). A client is one
line of text that stops at 120 characters, and the way to see a field is to
type `client.name` into a watch.

There is no data breakpoint either. A breakpoint carries a condition and a
message (`ide/modules/Debugger.js:49-50`, `:220-221`, `:101-110`), the runtime
reads only `"when"` and `"log"` (`bta_debug.c:641-652`), and the dialog
(`ide/forms/BreakpointForm.js`) offers a condition and a message only. The
protocol's verbs — `break`, `runto`, `clear`, `continue`, `step`, `locals`,
`eval`, `set`, `stopOnThrow`, `pause` (`bta_debug.c:747-853`) — say nothing
about a thread, a task, or a value.

## The code I wish I could have written

```js
// The reply the runtime would send, in the protocol's own shape: the value
// as a tree rather than as a line.
//
//   { "reply": "locals", "frame": 0,
//     "values": [ { "name": "client", "value": "{ … }", "children": [
//                    { "name": "name", "value": "\"Ana\"" } ] } ] }
//
// and the breakpoint's third setting, beside the condition and the message:
//   { "reply": "break", "id": 3, "watch": "client.balance" }
```

## Why the existing words do not cover it

`render()` is the only way a value reaches the IDE, and it answers with a
string, so the tree would have to be built somewhere else — and the panel that
would hold it is a `RowList` of rows (`ide/forms/MainForm.form:2171`), not a
tree. `Debugger.poke()` (`:683-686`) can change a variable's value at run
time, but that is the `set` verb (`bta_debug.c:811-841`) writing a local; the
source is not patched into the running program, so nothing watches a field.

## Prior art

Visual Studio's watch and DataTips, with expandable trees and data
breakpoints. Delphi's watch window with "evaluate on change". GDB's `watch`
and `rwatch` and its expression evaluator. LLDB. Eclipse's Variables view.
GTK4 has no debugger.

## How much it mattered

It works, but a part of it is noticeably worse: a value that is an object is
one ellipsised line, and a breakpoint cannot say "when this field changes".
