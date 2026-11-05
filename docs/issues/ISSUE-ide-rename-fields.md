# ISSUE: a field of the class cannot be renamed

## What the application needed

Rename a class's field. The concrete gesture: the caret is on `this.total`
inside a method, F2 is pressed, the new name is typed, and the field's
declaration and every `this.total` in that class change and nothing else does.
A local and a parameter already work -- the caret says which binding a bare
`total` means -- but `this.total` is a member, and the receiver has to be
attributed to a class before a rename may touch it.

## What I wrote instead

The local and parameter rename, which is the common case: `Refactor.bindingAt`
reads the parser's `Scope`/`Variable` and moves only the uses that resolve to
the binding under the caret. A field is still refused -- not by a sentence that
says so, but because `Application.Symbols` does not report a class field at all:
`total = 0;` in a class body produces no symbol, so `this.total` has no
declaration to resolve against and `rename` answers *nothing declares it*.

## The code I wish I could have written

```js
// The parser already reports a method's class as `Parent`; a field wants the
// same two facts:
//
//   Application.Symbols(source) ->
//       [ { Kind: "Field", Name: "total", Parent: "Invoice", Line: 12 } ]
//
// and then a use `this.total` in a method of `Invoice` resolves to that field,
// while `other.total` does not.
```

## Why the existing words do not cover it

`Application.Symbols` reports `Class`, `Function`, `Method`, `Getter`, `Setter`,
`Static`, `StaticGetter`, `StaticSetter`, `Variable`, `Scope`, `Export` and
`Import`; a class field is none of them. `Refactor` can see the class a method
belongs to (`Parent`), so it could attribute `this.total` to the class, but
there is no declaration to start from and no field row to move. The parser patch
that reports a class's own names would be the twentieth on the fork.

## Prior art

Visual Studio, Delphi, Lazarus, Qt Creator and Eclipse all rename a field and
its `this.` uses; the class is the scope, and a receiver that is not `this` is
left alone.

## How much it mattered

It works for locals and parameters now, and a field is the one common member a
rename still cannot move: the declaration and its uses have to be changed by
hand, and the compiler does not exist to catch the ones that were missed.
