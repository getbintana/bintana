# Completion: what is missing is a declaration, not an analyser

**Nothing in stage 2 of this document is implemented, and stages 0 and 1 are
written here so that doing them is a decision rather than a drift.** What is
built is in [`ide.md`](ide.md#what-the-editor-proposes): four completions, all
table lookups, and a limit stated out loud --

```
this.            the controls on this form, and the methods in this file
this.Btn1.       what a Button really has -- PropertyNames() on one
Btn1_            what a Button raises  -- EventNames(), most derived first
File.            Dictionary.Keys(File)
```

-- with `const x = makeThing(); x.` proposing nothing, *because nothing in the
project says what `makeThing` returns*.

The question this document answers is the one that follows: **can that limit be
lifted, and does lifting it need a JavaScript analyser.** It was answered by
measuring rather than by arguing, and the measurements changed the conclusion
twice.

## What was measured

Over `ide/` and `examples/` -- 91 files, 1916 `const`/`let`/`var` declarations --
**where the type of a name actually comes from**:

| what is to the right of the `=` | count | |
|---|---|---|
| `new Foo()` | 157 | 8 % |
| `this.SomeControl` | 79 | 4 % |
| a literal | 416 | 22 % |
| **a call** | **734** | **38 %** |
| another expression | 530 | 28 % |

**Reading declarations covers 12 %.** That is the first thing the measurement
overturned: this language *looks* like one where the type is written down, and
for locals it is not. The largest bucket is calls, whose return types are
written in `llm/library.md` in prose and nowhere a machine can read.

But locals are not where the gap is. The shape that is actually written is
`this.<field>.`, and today it proposes nothing at all:

| | |
|---|---|
| `this.<field>.` written -- a **lowercase** field, which is what the shape means here | **1410 times** |
| ...against every `this.<anything>.`, capitals included | 2285 |
| ...resolvable from a `new` in the same class | 314 (22 %) |
| ...**`this.ide.` alone** | **509** (36 % of all of them) |
| ...`this.designer.` | 103 |
| `this.<Control>.<Property>.` -- *"deeper than the .form can answer"* | 39, and nearly all of them `.Text.trim()` |

That last row is why the deep case is not worth building: it is 39 places.

## What an analyser would add, measured rather than assumed

TypeScript is the best JavaScript analyser there is, and it was run over this
tree to find out. Two results.

**It does not merely know nothing about Bintana; it knows something wrong.**
Over `ide/modules/Runner.js`, most of what it says is the honest *"Cannot find
name"* -- `Exec`, `Application`, `Locale`, `Namespace`, `Ide`. Two of them are
not:

```
Property 'Exists' does not exist on type
  '{ new (fileBits: BlobPart[], fileName: string, ...): File; prototype: File; }'
```

It resolved `File` against **the DOM's `File`**. The globals of this language
collide with the web platform's -- `File`, `Screen`, `Image`, `Text`, `Message`
-- so the surface has to be declared *and* the web platform taken out of the
picture, or the difference is not silence against knowledge but silence against a
confident wrong answer.

**Which knob does that was measured, because the obvious one is wrong.** Over the
same file:

| | errors | of them about the DOM |
|---|---|---|
| the default, with `lib.dom` | 9 | **2**, the `BlobPart` above |
| `"lib": ["es2022"]` | 9 | **0** |
| `noLib: true` | 8 | **8**, every one `TS2318` |

`noLib` throws away the *language*, not the web: those eight are
`Cannot find global type` for `Array`, `Boolean`, `Function`, `IArguments`,
`Number`, `Object`, `RegExp` and `String` -- all of which this runtime has, and
none of which the generator below would ever produce, since it reads
`Dictionary.Keys` over Bintana's own globals and `Object` is empty here on
purpose. **`lib` narrowed to the language is the knob**; `noLib` is the one that
looks like it and leaves TypeScript unable to type a string literal.

**And with a complete `.d.ts`, it resolves exactly what a lookup resolves.**
Asked of the language service, at the position after the dot:

| | the type it infers | what it proposes |
|---|---|---|
| `const btn = new Button(); btn.` | `Button` | `Click, Enabled, Icon, Name, SetFocus, Text` |
| `this.LblStatus.` (a field with `new`) | `Label` | `Ellipsize, Enabled, Name, SetFocus, Text` |
| **`this.ide.`** (a constructor parameter) | **`any`** | **nothing** |
| the same, under `/** @param {MainForm} ide */` | `MainForm` | `BtnRun, Close, LblStatus, log, runner, …` |

**The 509-use case is `any` for TypeScript too**, and for the same reason it is
unknown here: nothing says what is passed to that constructor. One JSDoc line
fixes it -- and **32 lines covers the whole tree**, which is how many
constructors with parameters there are in `ide/` and `examples/` together.

That is the second thing the measurement overturned. A JSDoc line is a
*declaration written in the file*, so reading it is the same lookup as reading
`new X()`. **Once the annotation exists, the native completion can read it as
well as TypeScript can** -- the analyser is not what unlocks that case; the
annotation is.

## Stage 0 -- the declarations, which are needed either way

1. **Generate `bintana.d.ts` from the runtime's own introspection.**
   `Widget.Types()`, `PropertyNames()`, `EventNames()` and `Dictionary.Keys` over
   the globals already answer all of it: 263 widget members, 35 events, 194
   globals, 58 published by `lib/`. The generator is a Bintana console project,
   which is this tree's idiom for a desk tool -- it is generated and regenerated,
   never maintained.
2. **Let `tests/api.sh` guard it.** That check already counts exactly that
   surface; comparing it against the generated file is what stops the two
   drifting, the same bargain `docs/llm/` already has.
3. **`"lib": ["es2022"]`, and it is not optional** -- see the table above. Not
   `noLib`, which is the knob that looks right and takes the language with it.
4. **A `.d.ts` per project, generated from the `.form` files**: each form is a
   class whose controls are typed fields. It comes out of the same table
   `Ide.Names.tableOf` already builds -- **and inherits that table's blind spot**:
   it flattens `children`, a menu is not among them, so the generated class would
   have no `MnuSave` either. Point 8 below is the same hole and has to be closed
   first, in all three places it lives.
5. **The 32 JSDoc lines**, one per constructor that takes a parameter.

**When stage 0 is done, VS Code works on a Bintana project** -- completion, go to
definition and type checking -- with no Bun, no Node and no change to this IDE.

## Stage 1 -- the lookups this IDE can do without any of it

6. **A field or a local assigned `new X()`**, and when `X` is a form or component
   of the project the answer is its controls and its methods, which is machinery
   `Ide.Check` already exercises over arbitrary files.

   **Two numbers and not a total**, which is how this was first written down and
   it was wrong to add them: **157** is a count of *declarations*
   (`const x = new Foo()`), **314** is a count of *uses*
   (`this.<field>.` where that field has a `new` in the same file). A sum of the
   two counts nothing. The 314 reproduces -- 42 distinct names, led by
   `this.git.` 30, `this.chrome.` 26, `this.tabs.` 22, each declared
   `name = new Ide.Something` in the class that uses it -- and a review of this
   document measured 121–139 for the same idea under three narrower readings. The
   disagreement is about what counts as *the same class*, which is exactly the
   thing to settle before sizing this, and is a reason to carry the reading with
   the number rather than the number alone.
7. **The JSDoc line from stage 0**, read the same way: the 509 case, as a lookup.
8. **And the menu gap, which lives in three places and not one.** Each flattens a
   form's `children`, and a menu is not among them, so `this.MnuSave.` proposes
   nothing and neither check looks at a menu item:
   `Completion.js:153`, `Names.js:176` and `Check.js:197` -- `Ide.Check` does not
   go through `Completion` at all, it has `Names.tableOf` *and* a walk of its
   own. Three, and the `.d.ts` of point 4 is a fourth reader of the same table.

None of this stops being *a lookup and nothing else*, which is the rule that path
is held to.

## Stage 2 -- the analyser, and this is the part that is only a plan

This is **LSP**, the Language Server Protocol: editing -- completion, go to
definition, find references, diagnostics. It is DAP's sibling and not DAP, which
is debugging and has [a plan of its own](debug-plan.md#dap-the-plan-to-evaluate).
The two are the same design and they do not cost the same here, which is the
whole reason this document recommends what it does:

- **For debugging, VS Code has nothing**: no Bintana debug adapter exists, so one
  must be written. DAP is a build.
- **For editing, VS Code already has a JavaScript language server running** --
  it is the same TypeScript measured above. It is not missing the server. It is
  missing the declarations, which is stage 0.

**What it would buy** that stage 1 does not: the return type of a call (38 % of
declarations) and arbitrary expressions (28 %). Nothing else. Those are the two
rows a lookup can never answer.

**What it would cost**, measured: Bun is a single 76 MB binary and **does not
typecheck at all** -- `const n: number = "text"` runs under it and `bun build`
passes it -- so the `typescript` package rides along either way, 23 MB, 99 MB
together. Bun against Node is a packaging choice and nothing else: the same
language-service probe cold-starts in 0.31 s under Node and 0.18–0.37 s under
Bun, because what costs is loading TypeScript and not booting the runtime.

**Three things to decide when it is evaluated**, none of which needs deciding
today:

1. **Where the analyser lives.** A child process speaking LSP on stdio, or the
   `Control` channel on descriptor 3 that `Exec` already has for a child that
   speaks a protocol. The seam exists; the dependency is the decision.
2. **Which host.** One binary that needs no system package, against a package
   most machines already have. Measured: it changes nothing else.
3. **And first, because it governs the other two: `Complete` is synchronous.**
   *Answer with a list, or nothing* -- dispatched inside GTK's completion
   machinery, on the keystroke. A process outside cannot answer that way, and the
   language has no word for *do this, then that*
   ([`async-plan.md`](async-plan.md)). Either the event learns to be answered
   late, which is a change to the contract and not a feature, or **the analyser
   does not feed the popup**.

### The way in that avoids the third one entirely

**Let the analyser feed [Problems](ide.md#problems-in-one-list) and never the
completion.** It runs on the pause `Ide.Live` already times, it answers when it
answers -- which a docked panel tolerates and a popup does not -- and what it
delivers is exactly what no lookup will ever give: real type errors over the
734 declarations that are calls. The panel is built, its rule that *a source
replaces its own rows and nobody else's* already admits one more source, and no
contract changes.

## What would make it worth doing

Not this document's argument; a caller -- the same test every other deferral in
this tree is held to. And the caller LSP would have is *somebody who wants to
edit a Bintana project in an editor that is not this one* -- who is served by
stage 0 without any of stage 2. That is the honest position: **the foundations
for the analyser are the declarations, the declarations pay for themselves
elsewhere, and the analyser waits for somebody who needs the two rows a lookup
cannot answer.**

## Considered and rejected

- **Bun as the analyser.** Measured: it does not typecheck. It is a host for
  TypeScript, not a substitute, and it changes only how the thing is packaged.
- **Reading declarations as the general answer.** 12 % of them state a type. It
  is the right answer for the 471 places in stage 1 and it is not a strategy.
- **Completing `this.Control.Property.`** -- the case the current code calls
  *deeper than the .form can answer*. 39 places, nearly all `.Text.trim()`.
- **Inferring a constructor parameter from its call sites.** It is one
  cross-file fact -- who writes `new Ide.Runner(` -- and it is what F12 already
  reads 40 files and 20 000 lines per keypress to avoid keeping an index for.
  Completion runs on the keystroke, so it would need that index cached, with an
  invalidation story this tree refuses elsewhere
  ([`ide.md`](ide.md#f12-and-where-a-name-is-declared)). The 32 JSDoc lines are
  the same answer written down once, and they work in every editor.
