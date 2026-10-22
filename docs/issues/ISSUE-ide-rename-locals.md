# ISSUE: rename stops at top-level declarations

## What the application needed

Rename a local. The concrete gesture: the caret is on `total` inside a method,
F2 is pressed, the new name is typed, and the local's declaration and its
three uses in that method change and nothing else does. The same for a
parameter, and the same for a field of the class the method belongs to.

## What I wrote instead

The rename is refused. `ide/modules/Refactor.js:42-43` lists the declarations
a rename will move — `Class`, `Function`, `Method`, `Getter`, `Setter`,
`Static`, `StaticGetter`, `StaticSetter` — and `Variable` is not among them;
the comment at `:37-41` says why: *"a local belongs to a scope this cannot
see"*. A local is met only as a reason to refuse: `:340-341` says *"`word` is
a local in … too — this rename cannot tell a use from that binding"*, and the
detection is `shadowsIn()` (`:485-496`), which reads the parser's `Variable`
and `Scope.Params` kinds. So a rename of a top-level function whose name is
also a local elsewhere is refused for the local's sake, and the person renames
the local by hand. Statics are refused outright as well (`:265-266`,
`REFACTOR_STATICS` at `:49`): *"is a static of … — this cannot tell which
class a member access belongs to"*.

## The code I wish I could have written

```js
// The shape of the answer the IDE would need, in the runtime's own words:
// the scope a binding belongs to, and the scope every use resolves in.
//
//   Application.Symbols(source) ->
//       [ { Kind: "Variable", Name: "total", Scope: "addTotals", At: 12 } ]
//   Application.Resolve(source, "total", at) ->
//       { Scope: "addTotals", At: 12 }        // the binding this use means
//
// and the rename then moves what resolves to that binding, and nothing else.
```

## Why the existing words do not cover it

`REFACTOR_DECLS` (`ide/modules/Refactor.js:42-43`) is the whole of what a
rename will move, and `Variable` is not in it. `shadowsIn()` (`:485-496`) asks
only whether a name shadows somewhere — it never asks which binding a use
means, which is the question the refusal is about, and `REFACTOR_STATICS`
(`:49`) refuses a static because the receiver of a member access cannot be
attributed. The parser already scopes locals: the vendored QuickJS fork
carries a patch for it, and `docs/agents/quickjs.md` records the eighteen
patches the fork carries. The scope is therefore known; what the IDE asks for
is the resolution, not the scope.

## Prior art

Visual Studio's rename, over locals, parameters, fields and across files.
Delphi's refactoring, rename identifier, including locals and parameters.
Lazarus's "Rename identifier", over locals, parameters and fields. Qt
Creator's rename, over locals, parameters and members. Eclipse's rename, over
locals, fields and types. GTK4 has none.

## How much it mattered

It works, but a part of it is noticeably worse: the common case, renaming a
local, is the one case refused.
