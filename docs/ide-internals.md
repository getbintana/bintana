# How the IDE is built

The other half of [the IDE](https://github.com/getbintana/bintana-docs/blob/main/docs/ide.md): the parsers it reads with, the caches
it keeps, how a form is built and drawn, the shape of the tree -- the
machinery, written down where somebody changing it will look rather than
where somebody using it does.

### The hierarchy is the namespaces

A namespace is a node, nested for `A.B`, and the classes in it hang under it
wherever their files are. `Widgets.Stepper` is what a `.form` writes, what
`startup` names and what the runtime resolves — it is what that class *is*, and
this is the view that groups by that. The directory it sits in is the other
view's subject.

It buys three things a folder tree cannot say:

- **One namespace declared in two folders is one node.** That is the case the
  directory can only show twice, and the reason this is the hierarchy rather
  than a decoration on it.
- **A folder that only fed a namespace stops being drawn** — the same rule as
  `forms/` and `po/`, for the same reason: `widgets` holding one `Widgets` says
  it twice. A folder holding anything else — an image, a class in no namespace —
  is still a folder, with what is left in it.
- **A class in no namespace is at the top**, which is exactly what the runtime
  says of a bare name when it resolves one.

`Classes.namespaceOf(file)` is the answer, read out of the code — the
`Namespace(...)` call plus an assignment that really puts *this* file's class
there — because that is what the runtime will act on. The scan is kept from one
listing to the next by each file's timestamp and length: reading every source on
every save cost 38 ms on the IDE's own project against 11 ms for the whole of
`rescan`, and a `stat` for a file nobody touched brings it back to 1 ms. It is
`make`'s bargain one notch finer, and the notch is why `File.Info().Modified`
now carries milliseconds instead of whole seconds.

The IDE's own project is the demonstration, and `tests/ide` opens it to check:
`Ide` with twenty classes under a *Modules* category, the forms at the top
level in no namespace at all, and neither `modules/` nor `forms/` drawn as a
folder.

**Files is the directory as it is**: folders first, then files, everything shown
— including what the project does not recognise. A `README`, a `.tar` an export
left behind, an `.svg` in `icons/`: those were invisible in this IDE until this
view existed, because `Classes.scan` collects only the extensions it can edit.

Three things it leans on, all of them recent:

- **The icons are the desktop's**, asked per file through `File.Info`. A `.tar`,
  a `.md` and a font come out looking like what they are without this file
  keeping a table of guesses — which is half of why `Info` was added.
- **What opens in a tab is decided by content type, not by extension.**
  `File.Info().Type` starting with `text/` is what a file has when a person can
  read it; a list of extensions here would be wrong the first time somebody used
  one nobody thought of. (`notes.bin` being a PNG under another name is the case
  the suite pins.)
- **And what is not text goes to the desktop** on a double click, through
  `File.Open` — which is the honest answer for a `.tar`, and better than either
  refusing or opening it as text it is not.

Both views fill the same `byKey`, so selecting, renaming and deleting work the
same in either and nothing downstream has to know which is up. The choice is
kept in `Settings`, because it is a way of working and not something one
re-chooses every morning.

The names in the chooser are prose and go through the catalogue, so what is
stored and compared is the **index**: comparing the text would mean comparing a
translation, which is the trap a `ComboBox` of keywords already taught this
project once.


### What a name is, when the file says so

Two more lookups, and they are lookups: what is read is a `new` written in the
file, or a JSDoc line. Both were measured before either was written, and the
measurement is why there are two and not a general answer -- of 1916
`const`/`let`/`var` declarations in `ide/` and `examples/`, **12 % state a type
at all**. The largest bucket is the return of a call, 38 %, and nothing in the
project writes that down.

The JSDoc one is why it is worth having. `this.<field>.` is written 1410 times
here and `this.ide.` is **509 of them** -- a constructor parameter, so no `new`
names it, and TypeScript infers `any` for it too. One line fixes it for both, and
30 lines cover the tree. They are in now, one per constructor that takes a
parameter, and an editor outside this one reads the same lines.

The last one is the one the project cannot be *asked*. A namespace is an
ordinary object built at load time, and it belongs to the project — which runs in
another process the IDE does not load — so `namespaceMembers` reads the two
halves the runtime itself will act on: the `Namespace("Ide")` declaration, and an
assignment that really puts a class there. Declaring it is not being in it. It
reads loose `.js` files and not only forms, because that is what a namespace is
mostly made of: eighteen of the IDE's own classes have no `.form` at all, and
this arrived the day they became `Ide.something` and completion went quiet on the
prefix its own authors type most.

Nothing is inferred, which is why the answers can be exact. A completion engine
for JavaScript normally needs a parser and a type inferencer because nothing in
the language says what `x` is; here the runtime publishes what it knows about
itself and the `.form` says what every control is.

**And where it stops is stated rather than papered over.** `const x =
makeThing(); x.` proposes something only when what is called declares what it
answers -- the arrow in a native member's signature comment, or `@returns {T}`
in a JSDoc comment -- and nothing when it does not; nothing is inferred from a
function's body. A parameter has no type either: `(ev) => ev.` inside a callback
and `p.` inside `Canvas_Draw(p)` propose nothing yet. The words provider still offers the *spelling* of anything
in the file, which is most of what one wants from a local. Going further needs a
*resolver* rather than an evaluator, and what shape that may take -- and may not
-- is in
[runtime-api.md](https://github.com/getbintana/bintana-docs/blob/main/docs/runtime-api.md#the-one-thing-eval-is-still-missing-from-and-the-shape-its-answer-has-to-take).

**How far that limit could be pushed, and whether pushing it needs an analyser,
is measured in [plans/completion-plan.md](plans/completion-plan.md)** -- and the measurement
says the blocker is a *declaration* and not an analyser. TypeScript, handed a
complete `.d.ts`, resolves **exactly** what a table lookup resolves: `this.ide.`
is `any` for it too, because a constructor parameter is not written down
anywhere. **The completion is the IDE's own and nobody else's**: a generator of
`.d.ts` declarations for outside editors existed for a while and was removed,
because nothing here consumed it and every name it declared was a name the
runtime already answers through `Widget.Members` -- the analyser is still
waiting for somebody who needs the two rows a lookup cannot answer.

Two things it has to be careful about, both because the handler runs on the
keystroke:

- **The `.form` is read once and kept.** So whoever changes the project's files
  says so -- `listFiles()` and a save both drop it -- or a control added in the
  designer would be missing from `this.` until the IDE was restarted.
- **The file's own methods are scanned from the text**, since the IDE edits the
  project's code rather than loading it, and the scan is redone only when the
  text is not the one it was taken from.
- **The chosen row says what the member is for**, under the list: the first
  sentence of the description written beside the member -- in the C, or in the
  JSDoc comment above a member written in JavaScript, a library's or the
  project's own -- the same text the documentation's rows are written from, in
  plain text.
- **A bare name offers what is in scope first.** The parameters of every
  function around the cursor and the variables declared in them above it, then
  what the file declares at its top level, then the globals -- among them every
  other project file's top-level names, since they share one scope. Out of the
  parser's `Scope` and `Variable` report, so a word in a comment is not a local
  and another function's local is not in scope; a block's `let` is offered
  after its block has closed, which is the only way this is wrong.
- **Inside a call, which argument.** `File.Save(p, |` puts `Save(path, **text**)`
  above the cursor (`Ide.CallTip`): `Completion.callAt` reads the text before
  the cursor forwards -- a comma separates arguments only outside a string, a
  comment and a nested bracket -- finds the innermost open call, and asks its
  signature the way a dot asks a member; `this.go(` is a method of the file on
  screen, read by the parser. The popover does not hide itself, so the keyboard
  stays in the editor; Escape puts it away for that call, and moving into
  another brings it back.
- **Past a call, what the call declares it answers.** `File.Info(p).` offers
  `Size` and `IsDir`, `File.Load(p).` a string's methods, `Directory.Files(d)[0].`
  the element's, `this.Btn.Bounds().` the rectangle, and a local assigned from a
  call (`const info = File.Info(p);`) is that call's answer. Each step asks the
  `Returns` of the member before it -- the arrow in its signature comment -- and
  a step nothing declares ends the chain with nothing offered, not a guess.
- **The classes a name can be are the open tabs' first, then the disk's.** The
  project's and its libraries' `.js` and `.form` files are walked once per
  project; every open tab is read live over them -- the editor's text, or a
  designer's tree -- so a class typed and not saved is offered as a bare name
  and after its dot, and an edit to it is what the next popup says. Each file is
  parsed again only when its text changed.

The heading is `CompletionTitle`, set per tab and translated like any caption.


### A source replaces its own rows and nobody else's

That is the one rule that makes a collector work rather than a second log.

```js
ide.problems.report("strings", ide.strings.found);   // everything the lint says now
ide.problems.clear("run");                           // and nothing from the last run
```

`report(source, list)` is the whole interface: a list is everything that source
currently has to say, and an empty one is how it says it is happy. A lint that
now finds nothing clears its own rows without touching the syntax error in the
file next door.

Which is why the syntax source is **`syntax:<file>`**, one per file. Saving
`A.js` says nothing whatever about whether `B.js` still compiles, and a collector
that let one save clear the other would be throwing away a complaint nobody
answered.

A problem is `{ kind, file, line, text }` — `kind` one of `Error`, `Warning`,
`Info`, `file` relative to the project the way a tab is keyed, `line` 1-based or
`0` for a problem about the whole file. **The three severities are
`SourceEditor.Mark`'s three words and not three of our own**: a problem and the
mark in the gutter beside it are the same fact twice, and spelling them
differently is how the two drift apart.


### The two sources that are not collections

Everything above already ran somewhere else. Two do not:
[the names a file uses](#the-names-a-file-uses-checked-while-it-is-written),
checked while it is being written, and
[the pass over the whole project](#checking-the-whole-project), which is the
half the first one cannot be.


### What the caret is inside is never reported

That is the whole answer to the objection above, and it generalises past this
class: **a diagnostic about the token the cursor is inside is a diagnostic about
something still being typed.** `this.Lbl.Te` with the caret at the end is a word
half written; the same text with the caret on another line is a mistake. One past
the end counts as inside, because that is where the caret sits when the last
character of a word is the one just pressed.


### The two checks, and why they are lookups

```
this.Btn.Txt       Btn is a Button, and a Button has no Txt
Btn_Clik()         Btn is a Button, and a Button does not raise Clik
```

Both go through **`Completion`**'s lookups — `controls()`, `typeOf()`,
`sample()` — which is already the class that answers *what is this control and
what does it really have*, once per form and cached. A second copy of that would
be a second answer to drift from the first.

The member test is **the `in` operator on a real control of that type**, and not
a list from `PropertyNames()`: `Click` and `SetFocus` are methods, they live on
the prototype, and a name list would report every method call in the project as a
mistake.

What it deliberately does *not* report:

- **A control whose class this process does not have** — a component of the
  project, which the IDE never loads. Skipped rather than guessed at.
- **`Btnn_Click`, the control misspelled rather than the event.** `Btnn` is not a
  control, so this is a method with an underscore in it and nothing here can tell
  it from any other. Warning about those is how a check gets switched off.
- **A menu item's members.** `Completion.controls()` flattens a form's
  `children`, and a menu is not among them — so `this.MnuSave.Enabled` is not
  checked rather than wrongly flagged. Teaching that lookup about menus would fix
  it here and in the completion popup at once, which is where it belongs.
- **A file with no `.form` beside it.** A module has no control to check a name
  against.


### No index, for the reason F12 gives

`Navigator.symbols` reads the text on screen. An index would have to be thrown
away whenever a method is renamed or a tab is edited, and getting that wrong
points at a line that no longer declares anything — [the same bargain and the
same argument](#f12-and-where-a-name-is-declared). What it costs is one parse of
one file, and it is cheaper than the pattern it replaced: **3.4 ms against
6.9 ms** on this IDE's own 110 KB `MainForm.js`, measured.

It runs on the pause after typing, and **`Ide.Live` owns that timer**: one pause
should mean one pass over the file however many readers it has. A pass that found
the same methods compares a signature and stops there, which is what keeps the
list from being rebuilt under somebody's cursor.


### Both directions, which is the half that is easy to forget

`Select` and not `Activate` — the opposite of what the
[Problems panel](#problems-in-one-list) does, and for its own reason. A problem
is a place in *another* file, so walking that list with the arrow keys must not
open one per row. An outline is a list of places in the file already open, and
moving through it *is* the gesture.

And the cursor moves the list back: `Editor_Cursor` marks the method the caret is
now inside, which is the last one declared at or above its line. That is most of
what Visual Basic's dropdown was actually for — it did not only take you
somewhere, it told you where you *were*.

**Two guards, because the pair would otherwise eat the cursor.** Marking a row
fires `Select`, which jumps to that row's declaration; so standing on line 40
inside a method declared at line 30 would drag the caret ten lines back up the
file while one was reading. `syncing` says *this class is the one moving the
selection* and `moving` says *this class is the one moving the cursor*, and each
is checked by the other's handler.


### It shares its two hardest checks rather than copying them

The sixth row above is `Ide.Names`, which is `Ide.Live`'s member and handler
checks moved somewhere both can reach. *Does this control have this member* has
to have one answer; a second copy is a second answer to drift from the first,
which is the argument this project already made about `Ide.Git`'s commands, about
`SOURCE_LINK` and about `Navigator.symbols`.

What each caller keeps is its own half. `Ide.Live` owns the *moment* — the pause,
and the rule that what the caret is inside is never reported. `Ide.Check` passes
a caret of `-1`, because nobody is typing in a file it is reading.

That is the check that found two real ones in the IDE's own dialogs: a
`ComboBox`'s handler written `_Change` where a `ComboBox` raises `Select`,
loaded, never called, and saying nothing about it.


### What the class declares

A property is discoverable because it is *there*: an accessor is a thing in the
text, and on a control written in C it is a thing on the prototype. The other
three questions the runtime answers about a control are not like that. Which
events it raises, which values a property accepts, and which of its strings a
person reads are **declarations** — a C class states them next to its properties
(`BtaClass.events`, `.options`, `.texts`) and `EventNames()`,
`PropertyOptions()` and `TextProperties()` publish them.

Those three walk the *class table*, and a class of the project is not in it. So
a component could not state any of them, and the IDE answered accordingly: a
double click wrote `Step_MouseDown` for every component ever written, a property
with three legal values got a text field, and a caption the component exposed to
the form holding it reached no catalogue. The stand-in made the first one look
deliberate — it is a `Label`, and a `Label` was answering; it happens to declare
no events of its own, so the answer fell through to Widget's and looked like a
considered default rather than the wrong class replying.

The class says it, where `Record` already says its `Fields`:

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];
}
```

Named after the methods that publish them, so a declaration and its answer read
as one thing said on two sides of the process line — and it really is two sides.
At run time the walks in `bta_widget.c` read the static off the prototype's own
`constructor` at each step, which is what `EventNames()` on a live component
answers. The IDE has no live component and never will, so it reads the same
declaration the only way it can: out of the text.

`Ide.Classes` reads them from the source in the same pass that finds the
accessors — once per listing,
so the designer, the grid, the completion and the extractor all ask a lookup and
none of them can be reading an older file than the others — and hands back the
runtime's own shape of answer: **declared first, then inherited**, which is what
makes `componentEvents()[0]` the event a double click should write, exactly as
`EventNames()[0]` is.

Only literals are read. A list built at run time is not something text can
answer for, and half a list is worse than none.

**A class that declares nothing is not a class saying "none".** It is one that
has not been asked, and both callers that care kept an answer for that long
before this existed: the extractor collects nothing rather than guess, and design
mode offers every property rather than hide one. Answering with an empty list
would turn silence into a claim the source never made, and would quietly drop
the captions of every component written before today.


### When a node cannot be built

`buildNode` stands in for whatever it could not make — a component of the
project, or a control carrying a value the runtime refuses (`Style: ".danger"`,
a colour that is not one). The stand-in carries the whole node, so the file
round-trips.

**The stand-in is scoped to the node that needed one, and that is why `buildNode`
builds one level at a time.** `Container.AddNode` builds a node *and its whole
subtree* in one call, so a descendant the IDE cannot instantiate threw out of
the container being built — and the container became the stand-in with every
sibling deleted. A form whose component sat two levels down opened as a board
with one grey `[Panel]` on it. `buildNode` now calls
`parent.AddNode({ ...node, children: [] }, true)` and recurses over the node's
own children, so the throw is caught where it happened and the rest of the tree
is built beside it.

What that costs, and what has to be paid before the stand-in goes in:
`Container.AddNode` parents a control **before** it applies its properties, so a
throw leaves a half-built subtree in the container. A stand-in beside it means
the next save writes the node twice — the controls that did get built, and the
whole node again. The IDE's own `MainForm`, 38 controls, came back from one save
with 44. So `buildNode` deletes whatever the failed attempt added before
standing in, and `tests/ide` opens a form built to fail that way and checks the
save writes it once.


## Folders, and namespaces, which are not the same thing

A project outgrows one flat directory, so the IDE works in paths. **A folder's
name is never a namespace.** What makes a class answer to `Widgets.Stepper` is its
own code:

```js
Namespace("Widgets");

Widgets.Stepper = class Stepper extends Component {
};
```

the declaration and not the directory — which is what the runtime resolves, and
therefore the only thing the IDE may read.

**This replaced a rule where a folder did spell one**, and the replacement is
smaller in every direction, so the old rule is worth recording rather than
forgetting:

- It needed an **exception per folder a tool had named** — `forms/`,
  `components/`, `modules/`, `po/`, and `lib/` the moment libraries arrived —
  because otherwise tidying a project renamed somebody's class: moving `Chip`
  into `components/` made it `components.Chip`, folder case and all, and rewrote
  every `.form` that placed one. Five exceptions is the rule telling you it is
  wrong.
- It made a **file move a semantic change**. Dragging a file in the tree renamed
  a class and every reference to it. Now a move moves a file; the class keeps the
  namespace its code declares, wherever the file lands.
- It could not express **two folders feeding one namespace**, which is what a
  namespace is *for* and what the project view is built to draw.

What the IDE offers instead, when you create a class in a folder, is **the
namespace the classes already there are in** — `namespaceHere(folder)`, read from
their code through `namespaceOf`. So a batch written in one place stays
consistent, and the checkbox names the namespace it would join: *Put the class in
`Widgets`, like the others here*. Where no class in the folder is in a namespace
there is **no checkbox at all**, because there is nothing to join: the first class
of a namespace is told which one, and `createForm(path, kind, "Widgets")` is how a
caller says it. A namespace is a decision, not a side effect of `mkdir`.

The option rides in the same dialog as the name rather than a second one, because
the name may grow a folder while it is being typed, and because *Cancel* should
mean "not at all" rather than "not that way". `AskForm.prompt` takes an optional
`{text, checked}` and hands the state back as a second argument; it makes room by
moving the buttons down and growing the window by the same amount.

The IDE is the demonstration of the rule it now follows: the classes in
`ide/modules/` are `Ide.Designer` and `Ide.TabSet` because their code says
`Namespace("Ide")` — never `Modules.Designer`, because no folder names anything.

- *New form...* and *New component...* accept a folder in the name, create it,
  and register `Widgets/Stepper.js` in `sources`. The suggested name is offered
  in the folder of the file being worked on, and is free as a *class*.
- **Identity is the qualified name.** `qualifiedName(file)` reads it out of the
  `.js` — the `Namespace(...)` call plus an assignment that actually puts *this*
  class there — because that is what the runtime will act on. Deducing it from
  the folder would let the two disagree, and the IDE would then write types
  naming a class nobody declared. `classNames()` caches the answers per listing.
- `Widgets.Stepper` and `Parts.Stepper` may both exist; two bare `Stepper` may
  not, and `warnDuplicateClasses()` says so in the console for the ones that
  arrived some other way.
- *Rename*: a bare name renames in place, a name with a folder moves the pair —
  and **a move changes no namespace**, so nothing in the class's own source is
  rewritten. `retargetNamespace()` is still there for the case that does change a
  class's namespace deliberately, and makes two precise edits rather than a global
  replace: a namespace is a common enough word to appear elsewhere in the file.
- **Renaming a class changes the name every `.form` uses for it**, so
  `retypeForms()` rewrites those nodes. They are JSON and the IDE owns their
  shape; the `.js` of *other* classes is only warned about, which is the honest
  limit. A *move* needs none of this, which is the point of it.
- The class being renamed is identified by its qualified name: two namespaces may
  hold the same short name, and only the open file says which one is meant.
- Control names use the **last segment**. A control's handlers are `Name_Event`
  methods, and `Partes.Chip1` is not an identifier.
- A folder with nothing editable in it is not shown: the tree is built from the
  files, so an emptied folder disappears on its own.
