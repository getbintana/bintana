# Completion: what was missing was a declaration, not an analyser

**Stages 0 and 1 are built. Stage 2 is not, and this document still recommends
not building it** -- which is the conclusion the measurements reached before any
of it was written, and nothing in the building overturned. What is in the tree:

```
tests/typings.sh              writes the declarations
tools/typings/bintana.d.ts    every class and global the runtime publishes
ide/forms.d.ts                every .form of a project, as its controls
ide/tsconfig.json             "lib": ["es2022"], and why it is not noLib
```

and, in the IDE, two more lookups and the closing of a hole three flatteners
shared. What was built is in [`ide.md`](../ide.md#what-the-editor-proposes); this is
the argument, the measurements, and **the seven things building it corrected**.

Before: four completions, all table lookups --

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
`this.<field>.`, and it proposed nothing at all:

| | |
|---|---|
| `this.<field>.` written -- a **lowercase** field, which is what the shape means here | **1410 times** |
| ...against every `this.<anything>.`, capitals included | 2285 |
| ...resolvable from a `new` in the same class | 314 (22 %) |
| ...**`this.ide.` alone** | **509** (36 % of all of them) |
| ...`this.designer.` | 103 |
| `this.<Control>.<Property>.` -- *"deeper than the .form can answer"* | 39, and nearly all of them `.Text.trim()` |

That last row is why the deep case was not built: it is 39 places.

## What an analyser would add, measured rather than assumed

TypeScript is the best JavaScript analyser there is, and it was run over this
tree to find out. Two results.

**It does not merely know nothing about Bintana; it knows something wrong.**
Over `ide/modules/Runner.js`, most of what it says is the honest *"Cannot find
name"* -- `Exec`, `Application`, `Locale`, `Namespace`, `Ide`. Some of it is not:

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
none of which the generator would ever produce, since it reads `Dictionary.Keys`
over Bintana's own globals and `Object` is empty here on purpose. **`lib`
narrowed to the language is the knob**; `noLib` is the one that looks like it and
leaves TypeScript unable to type a string literal.

**And with a complete `.d.ts`, it resolves exactly what a lookup resolves.**
Asked of the language service, at the position after the dot:

| | the type it infers | what it proposes |
|---|---|---|
| `const btn = new Button(); btn.` | `Button` | `Click, Enabled, Icon, Name, SetFocus, Text` |
| `this.LblStatus.` (a field with `new`) | `Label` | `Ellipsize, Enabled, Name, SetFocus, Text` |
| **`this.ide.`** (a constructor parameter) | **`any`** | **nothing** |
| the same, under `/** @param {MainForm} ide */` | `MainForm` | `BtnRun, Close, LblStatus, log, runner, …` |

**The 509-use case is `any` for TypeScript too**, and for the same reason it was
unknown here: nothing says what is passed to that constructor. One JSDoc line
fixes it -- and **30 lines covered the whole tree**, which is how many
constructors with parameters `ide/` has. (The number was written as 32 because it
counted two in an untracked working copy under `examples/`; the 30 are in.)

That is the second thing the measurement overturned. A JSDoc line is a
*declaration written in the file*, so reading it is the same lookup as reading
`new X()`. **Once the annotation exists, the native completion reads it as well
as TypeScript does** -- the analyser is not what unlocks that case; the
annotation is.

## Stage 0 -- the declarations, built

1. **`bintana.d.ts`, generated from the runtime's own introspection**:
   `tools/typings`, run by `tests/typings.sh`. 986 lines, 46 widget classes, the
   globals, `MenuItem` and `Action`. Generated and regenerated, never maintained.
2. **`tests/api.sh` guards it**, which is the check that makes a *generated* file
   worth having rather than a stale one nobody notices. It found sixteen real
   gaps the hour it was pointed at the file (below).
3. **`"lib": ["es2022"]`** -- see the table above. Not `noLib`, which is the knob
   that looks right and takes the language with it.
4. **A `.d.ts` per project, generated from the `.form` files**: each form is a
   class whose controls are typed fields, and **all three blocks that name
   something** -- `children`, `menus`, `actions` -- because a menu item is bound
   on the form like any control. `ide/forms.d.ts` is the one in the tree.
5. **The JSDoc lines**, one per constructor that takes a parameter.

**Stage 0 is what makes VS Code work on a Bintana project** -- completion, go to
definition and hover -- with no Bun, no Node and no change to this IDE.
`bintana.d.ts` is installed at `<prefix>/share/bintana/`, beside the libraries
rather than with the docs, because a `tsconfig.json` has to be able to name it:
a project outside this tree points at it the way it names a library with `uses`.

### Seven things building it corrected

**The generator cannot be a console project**, which is what this document said
it would be and what this tree's idiom for a desk tool is. Measured, on the first
run:

```
TypeError: Panel: a project with a `main` has no display, so it cannot make widgets
```

The whole method is to ask a real control what it has, so it is a **form project
run headless**, the way `tests/widgets` is: a window nobody sees, the work in
`Form_Open`, and `Application.Quit`.

**Introspection does not answer all of it**, which this document claimed it did
(*"`Widget.Types()`, `PropertyNames()`, `EventNames()` and `Dictionary.Keys` over
the globals already answer all of it"*). Measured, on a real `Button`:

| | |
|---|---|
| `PropertyNames()` | 40 names, its own and inherited -- exact |
| `EventNames()` | 14 -- exact |
| `Dictionary.Keys(button)` | **`[]`** -- a C method is not enumerable |
| `for (k in button)` | 9, and all nine are `rad.js`'s own |
| `Dictionary.Keys(Locale)` | **`[]`** -- a table-built global is not either |

So the generator reads **two** sources: introspection for the shape of every
class, which knows about inheritance and cannot be wrong, and the C tables for
the *names* of the methods -- with the same three patterns `tests/api` reads them
with. Which class has which method is settled by asking the sample,
`typeof control[name] === "function"`, so nothing in the generator knows that a
`TreeView` has `ExpandNode` and a `Button` does not. `Widget` itself is abstract
and cannot be asked: its surface is the **intersection** of every class that can
be built, which comes to 36 properties and is exactly right.

**`PropertyNames()` leaves out the read-only properties, and that is correct for
what it is for and wrong for a declaration file.** It answers *what can a
property grid set*. `tests/api.sh` found sixteen missing the hour it was written:
`Children`, `Focused`, `Line`, `Column`, `CanUndo`, `CanRedo`, `SelectedText`,
`Selection`, `ScrollMaxX`, `ScrollMaxY`, `SourceWidth`, `SourceHeight`,
`MatchIndex`, `DefaultButton`, `CancelButton`, `Placement` -- every one real, and
every one something an editor would have said does not exist. They come from the
C, where a NULL setter is what says read-only, and land as `readonly`.

**A `declare class` of a form is a duplicate, not a declaration.** The project's
own `.js` already says `class MainForm extends Form`, so a second declaration is
`Duplicate identifier` and TypeScript keeps the one **without** the controls:
measured, 19 forms and 922 errors. An `interface` of the same name *merges* into
the class instead, which is exactly what a `.form` is -- more members for a class
declared elsewhere. With that, 0.

**And `Record` is TypeScript's.** `Record<K, V>` is a type alias in
`lib.es5.d.ts`, so `declare class Record` writes a type of that name too and both
lose. A `const` with a construct signature declares the value alone: `new
Record()` is Bintana's and `Record<string, number>` stays TypeScript's.

**The two property lists overlap**, which the fix for the read-only ones
introduced: the candidate names come from every widget table at once, so `Text`
is read-only on a `TreeView` and settable on a `Label`, and a `Label` asked `in`
about it says yes twice. `Label` came out with `Text` and `readonly Text` on the
same class -- a duplicate identifier again. What the *class* can set wins.

**And a name can be a property of one class and a method of another.** `Marks`
is a read-only property on a `Calendar` and a method on a `SourceEditor`, so the
editor came out with `readonly Marks: any` and `Marks(...)` on the same class --
the same duplicate a third way. What the control really holds settles it, and
what found both was running `tsc` over the generated file, which is the cheapest
check this has and now the last step of writing it.

### What `checkJs` costs, measured

The generated `tsconfig.json` has it **off**, and the number is why: with it on,
the IDE's own sources give **387 errors over 41 files**, and **359 of them are
one thing** -- a field assigned to a form from outside its class body, which is
ordinary JavaScript and what every dialog here does (`dlg.onAccept = …`). Most of
the rest are `this[name]` indexing. With it off: **0**, and what is left is
completion, go to definition and hover, which is the whole of what the file was
generated for. Turning it on is one word, and worth it for a project that
declares its fields.

## Stage 1 -- the lookups this IDE does without any of it, built

6. **A field or a local assigned `new X()`**, and when `X` is a form or component
   of the project the answer is its controls and its methods -- read from its two
   files, which is the same pair `this.` reads about the file on screen.

   **Two numbers and not a total**, which is how this was first written down and
   it was wrong to add them: **157** is a count of *declarations*
   (`const x = new Foo()`), **314** is a count of *uses*
   (`this.<field>.` where that field has a `new` in the same file). A sum of the
   two counts nothing. The 314 reproduces -- 42 distinct names, led by
   `this.git.` 30, `this.chrome.` 26, `this.tabs.` 22, each declared
   `name = new Ide.Something` in the class that uses it -- and a review of this
   document measured 121–139 for the same idea under three narrower readings. The
   disagreement is about what counts as *the same class*, which is a reason to
   carry the reading with the number rather than the number alone.
7. **The JSDoc line from stage 0**, read the same way: the 509 case, as a lookup.
8. **And the menu gap, which lived in three places and not one.** Each flattened
   a form's `children`, and a menu is not among them, so `this.MnuSave.` proposed
   nothing and neither check looked at a menu item: `Completion.js`, `Names.js`
   and `Check.js` -- `Ide.Check` does not go through `Completion` at all, it had
   `Names.tableOf` *and* a walk of its own. Three, and the `.d.ts` of point 4 was
   a fourth reader of the same table.

   One walk now, `Ide.Names.tableOf`, over all three blocks; the other two read
   it. **And it took a runtime addition**: a `MenuItem` and an `Action` are not
   widgets, so `Widget.New` cannot make one to ask -- the only thing that builds
   one is a `.form` loader reading a `menus` block. Both answer `PropertyNames()`
   and `EventNames()` now, out of their own C tables rather than a second list,
   and the sample the IDE asks is borrowed from its own menu bar.

   **And it found the runtime doing the same thing twice more.** Once the checks
   started asking *what else does a form bind by name*, the obvious next question
   was whether the loader looks at the answer when it binds them -- and
   `bta_menu.c` had the unchecked `JS_SetPropertyStr` that `bta_form.c` had been
   fixed for, in two places. A menu item called `Actions` bound to nothing and
   nobody was told. Both refuse the form now; `strict-plan.md` has it, since
   that is where the first one was written down.

None of this stops being *a lookup and nothing else*, which is the rule that path
is held to.

## Stage 2 -- the analyser, and this is still only a plan

This is **LSP**, the Language Server Protocol: editing -- completion, go to
definition, find references, diagnostics. It is DAP's sibling and not DAP, which
is debugging and has [a plan of its own](debug-plan.md#dap-the-plan-to-evaluate).
The two are the same design and they do not cost the same here, which is the
whole reason this document recommends what it does:

- **For debugging, VS Code has nothing**: no Bintana debug adapter exists, so one
  must be written. DAP is a build.
- **For editing, VS Code already has a JavaScript language server running** --
  it is the same TypeScript measured above. It is not missing the server. It is
  missing the declarations, which is stage 0, and stage 0 is done.

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

**Let the analyser feed [Problems](../ide.md#problems-in-one-list) and never the
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
stage 0, which is now in the tree. That is the honest position, and building
stage 0 did not weaken it: **the foundations for the analyser were the
declarations, the declarations have paid for themselves elsewhere, and the
analyser waits for somebody who needs the two rows a lookup cannot answer.**

## Considered and rejected

- **Bun as the analyser.** Measured: it does not typecheck. It is a host for
  TypeScript, not a substitute, and it changes only how the thing is packaged.
- **Reading declarations as the general answer.** 12 % of them state a type. It
  is the right answer for the two shapes in stage 1 and it is not a strategy.
- **Completing `this.Control.Property.`** -- the case the current code calls
  *deeper than the .form can answer*. 39 places, nearly all `.Text.trim()`.
- **Inferring a constructor parameter from its call sites.** It is one
  cross-file fact -- who writes `new Ide.Runner(` -- and it is what F12 already
  reads 40 files and 20 000 lines per keypress to avoid keeping an index for.
  Completion runs on the keystroke, so it would need that index cached, with an
  invalidation story this tree refuses elsewhere
  ([`ide.md`](../ide.md#f12-and-where-a-name-is-declared)). The JSDoc lines are
  the same answer written down once, and they work in every editor.
- **An index signature on a generated form interface.** It would silence the
  `this[name]` errors `checkJs` reports, and it would make `this.Anything` valid
  -- which is the one thing the declaration exists to refuse.
