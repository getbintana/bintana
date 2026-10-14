# The IDE completes a name, and it asked nobody

**`Timer.` offered zero entries, and `Timer` was in the IDE's table of
globals.** That is the whole bug in one line, and both halves of it are a design
mistake the same repository had already written down twice.

The engine was **dot-driven**: it answered `this.`, `X.` and `Btn1_`, and a
**bare name not at all** -- which is the ordinary case, because the language is
bare calls to `File`, `Locale` and `Message` beside the `Control_Event` methods.
And what it *did* answer for `X.` was `Dictionary.Keys(X)`, which is **empty on
a class**: a static is a property of the class and not of an object, so the one
verb that could see a name could not see a single member of it.

So there were two fixes, and **only one of them is in the IDE**:
- **A bare name** is now answered by asking. `Application.Globals()` is what the
  runtime installed and `Widget.Types()` is its classes -- and a **library's**
  classes come out of that library's sources, because **a top-level `class` is a
  lexical binding and not a property of the global object**, so no list of
  globals could ever contain `Confirm`. **Only the libraries the project declares
  in `uses`,** and the walk is `Classes`' own cached `libraries`: the first
  version asked `Application.Libraries()` and offered the classes of all seven on
  a project naming one -- `QrView` in a program with no `qr` anywhere in it, which
  is not a completion list but a list of what somebody else has on their disk. A
  completion entry is a claim that the name **resolves in this program**, so a
  second copy of the library search in JavaScript was both wrong and the copy
  that drifts.
- **A class's members** are asked with `Widget.Members(type, [options])`, which
  answers for anything a name resolves to: a widget, a class of rad.js, a class of
  a library. It reads statics off the constructor and instance members off the
  prototype because that is where each of them lives. **And for a library class
  that verb could not answer at all, which took a second pass to see.** The IDE
  never *runs* an opened project's libraries -- it reads them -- so `Confirm` is a
  lexical binding with no class behind it in that process, `Widget.Members`
  refused, and the list after the dot was empty. **No runtime verb fixes that on
  its own**, because what is missing is a *class*, not a lookup: the answer is the
  parser, through the same `Application.Symbols` the outline already asks.

  **Which is why the option is `Sources` and the answer is in the runtime.** The
  first version did the reading in the IDE, and the general rule this file keeps
  re-learning is that a second reader is a second answer: it offered `Dial.turn`,
  which the runtime hides, so the same class had a different surface depending on
  which reader found it, and the test had to be corrected from asserting the
  inconsistency to asserting its absence. The runtime reads the sources with the
  parser, follows the `extends` chain, and **hands the walk back to its own class
  table at the first base the sources do not declare** -- which is `Form`, and a
  hundred names. That hand-off is the whole thing: the supertype is what turns "2 of
  the 68 names this class has" into the class, and the two readers meet exactly
  there.

  **Two things that are the shape of the answer and not tidiness.** A **class the
  sources declare wins over a class of the same name in the runtime** -- `Dialog` is
  a real global full of static functions, and asking the class table first described
  a different class than the one being written; the project's shadowing the runtime
  is the same rule the runtime's own library search follows. And **a source entry
  that is not a string is refused**: `JS_ToCString` converts anything, so `5` would
  have become the source `"5"` and answered "this class declares nothing" as though
  the caller had said so.

  **And a form's children, which is the last name that was missing everywhere.**
  `Confirm.BtnAccept` exists -- the library's own code does
  `dlg.BtnAccept.Text = ...` -- and was in no list: the loader assigns each node by
  name onto the form it builds, so a child is an **own property of the instance**
  and every one of these walks is over the **prototype chain**. It is one bug and
  not two, and the condition that hid it said so: the first version read the forms
  only when `Sources` was also given, so it answered a class read from its source
  and *not* one that is loaded, which gets the class-table walk instead. **`Forms` therefore applies to a class that is loaded as well as one only
  declared**, and the assertion for the loaded half is the one that was silently
  passing before it existed. Reading a `.form` needs no display -- `JS_ParseJSON`
  and a walk of `children` -- and the pairing is the form's own `class` key and
  **not the file's name**, because a component declared in `Widgets.js` has
  `Widgets.form`.

  **And the popup asks for the signature rather than writing one.** `Detail` used
  to be a `()` typed here, which reads as *takes no arguments* when all it meant
  was *nobody declared a signature*. What was not honest was asking nobody:
  `Widget.Signature` answers for every method of the runtime from the comment
  beside its C entry, and `Container.Add` was shown the same as a member that
  takes nothing. A property says nothing, which is what separates it from a
  method, and that is a question worth asking rather than a blank to leave.

  **And then the count, discovered, which removed the reason to declare
  anything.** The first version of this asked the runtime for a signature and got
  nothing for a library, and the obvious next move -- a `static Signatures` in
  each of the six libraries -- was the wrong one, and the objection to it is the
  right one: **nobody should have to write the arity of fifty methods for an
  editor to catch `Ask()`.** `Function.length` is the engine's own answer and it
  is right for every declaration without a default, so `Widget.Members` grew a
  `Params` field read off the function value:
  `QrCode.Encode(text, opts)` is two arguments, `Nsis.Stage` three, `Chart.Save`
  three, `Widget.On` two, and `Widget.Width` is `-1` because it is a property.
  **Three tiers, and the order is the design**: a declared `static Signatures`
  wins because it has the parameter *names*; the discovered count is next and
  needs nothing written; the rest form is what nobody knows, and it is now the
  exception rather than the rule.

  **And what made the tier a truth is a rule the specification states, which is
  worth keeping rather than rediscovering**: `length` is the number of parameters
  *before the first default or rest*, so `(a, b = 1, c)` is 1 and `(a, ...rest)`
  is 1. `Params` is therefore a lower bound -- an answer built from it is
  *weaker* than one built from names and not a wrong one, which is the difference
  that matters.

  **And then the check that makes all of it hold**: `tests/ide`'s `completion`
  asks the editor for the same members the runtime describes, over every widget
  class and the test project's own library, so a name that exists and is not
  offered is red with the class named. **It was proved by breaking it** --
  `Delete` filtered out of the popup -- rather than by reading it green: an oracle
  nobody has watched fail is a claim, and this file has been wrong about one
  before.

  **And then the names, which are the one answer nobody has to write.** The
  eighth fork patch has the parser report them, so a class in a file the host
  does not run gets `Ask(message, onConfirm, options)` with the real names.
  `static Signatures` stays as decoration: a class that wants to say something
  the parser cannot, which is now nothing.

  **The count does not belong in the popup**, and the first version had it
  there. It built `(a1, a2, a3)` from the count, so `File.Load` came out
  `Load(a1)` -- a name that is not the parameter's, on a verb that reads as though
  it were. What a popup can honestly say is **`(...)`**: there are arguments and this
  does not say which. **`()` claims the member takes none**, which for
  `File.Load(path)` is false and was once *asserted*; `(...)` is a gap that reads
  as one. The two are told apart by whether a signature was **declared**, not by
  the count: `FocusNext` carries a declared `()` in the table beside its C entry
  and that is a fact, and `File.Load` is registered with `JS_SetPropertyStr` with
  no comment anywhere, so its parameter name exists nowhere at all. `tests/ide`
  asserts that **no** member of either list is annotated with an invented name,
  which is a property of the whole list and so holds for a class nobody thought to
  test.

  **And the gap it left, closed: a global's verbs and a class's statics.**
  `File.Load`, `Locale.Text`, `Widget.New` and 160 more showed `(...)`,
  because they are registered with `JS_SetPropertyStr` (or in a table no class
  row owns) and the extractor only read comments above a class table's
  entries. It reads the comment above a `JS_SetPropertyStr` now and **names the
  owner by following the variable**: `JS_SetPropertyStr(ctx, global, "File",
  file)` makes `file`'s members `File`'s, `JS_SetConstructor` makes a
  prototype's table its constructor's (`Bytes.Slice`), a variable hung off
  another is a dotted owner (`Desktop.Entries`), and variables are scoped per C
  function because every file reuses `proto` and `ctor`. The root widget
  constructor is the one no line names -- the class-table loop computes it --
  and `VAR_ALIASES` in the script is that one line. **Two registrations were a
  loop over a table of names** (`Message`'s three, `File`'s four path parts)
  and were unrolled, since a loop has nowhere to write four comments; a
  database driver is installed by `bta_database_driver`, which the script
  reads as `Database`'s member line. `tests/api` asks `Widget.Members` of every
  global the C installs and fails on a `Method`/`Static` with no `Signature` --
  proved by deleting `/* Load(path) */` and watching it name `File.Load`.
  **A verb written in JavaScript needs nothing written**: the engine keeps the
  source of every function it compiled, so `source_signature` takes the text
  between the first bracket and its partner (or the name before `=>`),
  compiles `function __p(<that>) {}` and lets `bta_symbols` spell it --
  `Timer.After` answers `(delay, tick)` and `File.LoadJson` `(path)` with no
  declaration anywhere. The order is declared first (C comment, then a class's
  `static Signatures`, through the same `signature_at` `Widget.Signature`
  uses), then the source. The popup no longer asks `Widget.Signature` itself:
  `Widget.Members` carries the answer, and `(...)` is what is left for a native
  function in a shape the script does not read -- none, today.

  **The kinds are the eighth patch's**, and `Widget.Members` answers a class
  read out of a source in the same words it answers a loaded one: `Static`,
  `ReadOnly` for a getter alone (the loaded walk called that `Property` for a
  while, disagreeing with `Widget.Member` about the same name), one `Property`
  for a getter and a setter, and no `Signature` on a property. `Params` counted
  from a signature follows `Function.length`'s rule -- the names before the first
  `[x]` or `...x` -- or `(a, [b], ...c)` answered 3 read and 1 built.

**And past a call, what the call declares it answers.** `File.Info(p).`
offered nothing -- and worse, a dot after a bracket fell through to the
bare-name case and offered every global. The signature comment carries the
answer now, after an arrow (`/* Info(path) -> { Size, Modified, Type, Icon,
IsDir } */`, `-> Bytes`, `-> string[]`, and `/* Children -> XmlNode[] */` for a
property), the extractor keeps it beside the parameters, and `Widget.Members`
publishes it as `Returns`. The IDE reads the expression before the dot
backwards over names and balanced calls and indexes (`completionChain`), and
each step asks the `Returns` of the member before it -- a local assigned from a
call is that call's answer, `this.X` is the control's class or the field's
`new`. Four things the building of it settled:
- **What a verb hands back is usually a prototype no global holds** -- a client,
  a connection, a node -- so nothing could be asked about it and its verbs had
  no signatures either (39 of them). `/* type HttpClient */` above the
  prototype's table names it, the extractor lists *every* entry of a named
  table, properties included, and `Widget.Members("HttpClient")` answers from
  the generated table alone (`take_catalog`); a global class (`Connection`)
  gains what its driver's table adds. `api.sh` holds a named type's methods to
  the signature rule like a global's.
- **A builtin is lower case**, so the capital convention hid everything a string
  or an array has. `Widget.Members(name, { All: true })` lists the lower-case
  names; the IDE asks it only for `string`, `number` and a list.
- **A shape in braces is its field names and nothing more** -- no types inside,
  because nothing here would read them, and a list of names is what a popup
  offers.
- **`Widget.Members("Array")` aborted the process at exit, and it was the
  language's fault.** Reading the constructor's own properties read
  `Array.fromAsync`, an async function the engine builds on first read -- and
  with no async classes registered (patch 5) that object is never collected.
  `typeof Array.fromAsync` alone was enough: it answered `"object"` and the
  program died with 134 after `Application.Quit(0)`. `close_hatches` deletes it
  now. **A walk that reads every own property of a builtin reads the lazy
  ones**, so `take_members_of_resolved` also consumes an exception from
  `JS_GetOwnProperty` instead of `continue`-ing past it with one pending.
`tests/ide`'s `completion` chains past a call, into a string, through an index,
from a field and from a local, and through a named type; with `stepType`
returning nothing six of those go red.

**And inside a call, which argument -- `CallTip`.** `File.Save(p, |` shows
`Save(path, <b>text</b>)` above the cursor. The IDE needed two runtime verbs
for it and got them as ordinary API: `Editor.CursorBounds()` (where the cursor
is drawn, in the control's coordinates: `get_iter_location`, then
`buffer_to_window_coords`, then `compute_point` from the view to the scroller)
and `Popover.Show(content, anchor, { Rect })`, which points at a rectangle
inside the anchor instead of at the whole of it. Three things measured on the way:
- **An `Autohide` popover takes the keyboard; one without it does not.** The
  hint is `Autohide: false`, and `tests/ide` asserts the editor still has the
  focus with it open -- after asserting it had the focus first, because a check
  that the focus *stayed* passes trivially when nothing had it.
- **`CursorBounds()` before the window is up is garbage, not an error.** The
  first test read `{ X: -3, Y: -17 }` in a full run -- where `tests/widgets`'
  synchronous half runs inside `Form_Open`, before anything is allocated --
  and passed alone, where the timing differed. It waits for `Bounds().Width >
  0` now; the number means nothing until the control has a rectangle. **And
  in a test of its own, with its own editor**: it first borrowed
  `testEditorScroll`'s, whose own chain of waits deletes it when done, so one
  run in several the wait here had not come true by then and never would --
  *never became true* on a check that was right. A wait on a control another
  test owns is a race with that test's teardown.
- **A comma is an argument separator only outside a string, a comment and a
  nested bracket**, so `callAt` reads the text forwards (forty lines back is
  enough, and keeps a long file off the keystroke), not backwards: only a
  forward read knows which of those it is in. The innermost open `(` is the
  call; an `{` or `[` inside it is still its argument.
- **`PositionAt` is the same trip the other way, and the two spaces are not the
  widget's.** `CursorBounds` answers in the control's coordinates by converting
  the buffer's rectangle (`get_iter_location`, then `buffer_to_window_coords`)
  and carrying it from the view to the scroller; `PositionAt` comes in through
  `window_to_buffer_coords` and `get_iter_at_location` reads the **buffer's**
  own, which is where `get_iter_location` already answers. Validating the point
  against the rectangle converted back into the widget's disagreed by the
  gutter -- 34 pixels of a `SourceEditor` -- so the plain editor answered
  everywhere and the source editor answered `null` everywhere. Both sides in
  buffer coordinates; do not convert one half. `tests/widgets`' `PositionAt`
  has one of each editor for exactly that reason.
Placement was checked by eye once, on an `Xvfb` with a root capture (a
popover is its own surface and does not show in a window capture): the hint
sits directly above the cursor with the argument in bold.

**And the pointer resting on a name is `Tooltip`**, which answers the same
`Completion.topic` F1 does, with `Editor.PositionAt` saying which character
is under the point. **`MouseLeave` is not what closes it, and finding that out
cost a real pointer.** A popover maps under the pointer for the instant GTK
places it, the editor is sent a `leave` for that instant, and a handler that
closed on it killed the tooltip in its own frame: `Popover.IsOpen` true, 168
characters of label, **nothing on screen** -- and every assertion green, because
the suite calls `Editor_MouseMove` by name and never produces a surface.
`Tooltip.left()` ignores a leave while the popover is up (the mapping one) and
closes on the real one, which is what cancels the dwell a quick exit leaves
armed; without that half, hovering a word, walking out and waiting made a
tooltip appear at the edge for a pointer that was somewhere else. Measured with
a real pointer on an `Xvfb`: resting over `File.Load` shows the popover, and
crossing a word and leaving inside the 400 ms leaves nothing. **A test that
calls a handler instead of producing the event it is about cannot see this
class of bug** -- and **`IsOpen` says the program opened it and nothing has
closed it, not that a surface is drawn**: a popover is its own surface and
does not show in a window capture, so a root capture is the one that answers.

**And the classes are the open tabs' before they are the disk's.**
`declaredClasses` used to walk the project once and keep what the files said,
so a class written in a tab and not saved was no class at all -- no bare name,
nothing after its dot -- and a method added in another tab waited for a save.
The disk is walked once per project now (`diskFiles`) and every open tab is laid
over it live through `TabSet.contentOf`, keyed by the project-relative name a
tab uses; each file keeps the text its classes were parsed from and is parsed
again only when that text moved, and a `generation` counter is what the
member and bare-name caches key on -- a cache keyed on the *name* alone was the
reason an edit could not reach the popup. `tests/ide`'s `completion` types a
class into a tab, asserts the file on disk lacks it, and edits it once more;
with the tab layer switched off three assertions go red.

**And the hand-written table went, and that is the part worth keeping.** It held
fourteen global names and was missing about eighteen -- `Printer.` and `Http.`
completed nothing and nothing said so. `Widget.Members` **takes a global object as
readily as a class**, because the runtime's own lookup does not tell them apart,
so there is one verb for `File` and for `Confirm` and no third place where a name
becomes something to walk. **A first version of this wrote a `switch` of twenty-
seven global names** -- the hand-written list again, in a worse shape, since it
could not answer a name it did not know out of a hundred and sixty-four.

**And the test that said the bare name worked was calling the provider with an
empty `before`, which is the mistake this file has now paid for twice in this
one module.** `Editor_Complete` runs from inside GTK, and `before` is the line
*up to where the word starts* -- so `const t = Tim` sends `"    const t = "`, and
a guard that read `before` refused the most ordinary line in the language. **The
suite was green the whole time**, because the test invented its arguments. The
case is now asked four ways, and putting the old guard back makes three of them
fail -- which is the only half of "this is a test" that is not a claim, and the
rule generalises past completion: **a provider's arguments are the editor's, so a
test that supplies its own is testing the test.** The correction also broke an
assertion that had been true for years -- `my_thing` proposes nothing, and making
the no-dot case answer everything offered it 287 globals -- so the two shapes are
told apart on the one piece of evidence that separates them, an underscore in the
word, which is what a half-typed handler looks like.

**`Widget.Members` is a *fifth* verb and the other three keep refusing**, which is
the load-bearing half: a property grid, a palette and the serialiser all need
`Widget.PropertyNames("Util")` on an ordinary class to refuse, or the grid offers a
shape it cannot read. What the refusal left with **no way to be asked** was a
different question -- *what does this name have* -- and the answer is the
runtime's, so the IDE holds no second reader of what a class has.
