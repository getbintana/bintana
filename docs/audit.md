# External audit

Findings from a code audit done outside the tree's own work, at `271eeb6` on
19 September 2026 — except four entries in §4, whose counts come from the
working tree and say so where they stand. Everything here was found by reading
the runtime and the prelude; where an entry says **measured**, a project was run
against the built binary and what it printed is quoted. The rest is confirmed in
the code and marked **read**, or comes from the audit's static pass and is
marked **noted** — kept because a thing dropped silently is a thing
rediscovered.

This is neither [`issues/`](issues/README.md) nor [`plans/`](plans/README.md).
An issue is a capability the runtime does not have; a plan is one it is going to
get; these are things it does **wrongly today**, in code that exists and is
documented to do otherwise. Each entry names the promise it breaks, so a fix has
something to be measured against.

**A fixed finding is deleted, not archived** — the same rule an answered issue
follows, and for the same reason: a defect kept past its fix is a second
description of code that no longer exists. The file goes when the last one does.

**Section 1 is gone: all thirteen correctness findings are fixed**, and 2.5 and
2.6 went with them. What each trap looked like is in `AGENTS.md`, which is where
a fact like that is read; the numbering below is the original one, so a gap
means a finding that no longer describes any code.

They were: the `async` declaration that left a process unable to close — now a
`SyntaxError` from a fifth vendor patch, which is what retired 2.6 — the adrift
`Task`'s proxy and its untracked idle sources, the four prototype lookups in
`rad.js`, `LineDash`'s use-after-free, `Split.Reorder`'s `g_object_ref(NULL)`,
the error `OnError` swallowed, the exception `print` and `Logger` left pending,
the two silent refusals (`delete_named` and the `Control` pipe),
`Bytes.Concat`'s `memcpy`, `app->libs`, the class-file cache that believed a
miss, and the false load-order rule in `forms.js`'s comment that was 2.5.

**Three of them were filed at the wrong weight, and that is the part worth
carrying forward.** 1.13 was *noted* — the tidiness drawer — and was a
use-after-free measured at a refcount of 2 in eight cases out of eight; its own
prescription was wrong besides, since tracking the source ids the way the
neighbouring fields are tracked adds a second one. 1.4's coverage claim was
backwards. And 1.12 asked for a decision it had already argued one side of.

**2.1 is gone too.** `localeCompare` is refused by name, in `rad.js` so that one
place covers the worker as well, and the refusal points at `Locale.Compare`.
What the measurement added to the argument: sorting with it returns *exactly*
what sorting with no comparator returns, so it was never an approximation of
anything. It also turned up a gap of its own — a worker has no `Locale` at all,
and so cannot order names — which is
[`issues/ISSUE-worker-locale-order.md`](issues/ISSUE-worker-locale-order.md)
rather than a line here, since it is a capability that is missing and not a
thing done wrongly.

**2.2 went with it**, as documentation and an assertion rather than a second
refusal: a bare `sort()` gives that same wrong order and *cannot* be taken away,
because all 26 of them in this tree order paths, extensions, class names and the
keys of a bag, and not one sorts text a person reads. No `Locale.Sort` — nothing
wants one yet. Its own example was the weak part: `language.md`'s
`Dictionary.Keys(bag).sort()` is a bag's keys, which are identifiers, so it is
the one place on that page where the bare sort is right.

**2.3 is gone, and it was two findings wearing one title.** The declarative half
— eight names installed and in neither of `language.md`'s lists — ended as three
removals (`queueMicrotask`, `escape`, `unescape`) and five documented
(`BigInt`, `WeakMap`, `WeakSet`, `Iterator`, `DisposableStack`). The other half
was a defect: `Application.CheckSource` read its line and column out of
`.stack`, so `Error.prepareStackTrace` **or** `Error.stackTraceLimit = 0` moved
the answer to `0, 0` with the message still right. The audit names only the
first; the second is likelier, being what somebody sets to quieten a log.
`CheckSource` takes its own reading now. There is nowhere else to read from — a
QuickJS error carries no `lineNumber`, `columnNumber` or `fileName`, measured —
so parsing the stack stays; what changed is that the program can no longer
corrupt it.

**What is left is decisions and costs**, which is what the rest of this file has
always been. The counts in §4 are the working tree's, not `271eeb6`'s.

## 2. The language's curation

### 2.4 "Nothing can put anything on a prototype any more" is false — *measured*

[`llm/language.md:118`](llm/language.md) says `for...in` is safe because
*"nothing can put anything on a prototype any more"*. `Object.prototype.x = 1`
measured: `true, 1`. The curation emptied `Object`'s statics and took
`__proto__` and the `__defineGetter__` family; `Object.prototype` itself is
still extensible and reachable, and a plain object still inherits
`toString`/`constructor`/`valueOf`.

**And the program cannot lock it either**, which is the part that makes the
sentence not merely false but unfalsifiable from inside the language: `freeze`,
`seal`, `preventExtensions` and `isExtensible` are all on the deleted list
(`bta_runtime.c:1159-1160`). The only `JS_PreventExtensions` in the tree is the
one `--strict` puts on a widget (`bta_widget.c:3356`).

**And it is narrower than it reads, which is the other half of why it misleads.**
It is written about `for...in`, and `for...in` is in fact safe from the
builtins: `Object.prototype`'s members are non-enumerable and are never recited.
What the sentence does not cover is the `in` operator and a plain property read,
both of which **do** see non-enumerable inherited names — and that is where this
tree has already paid. `Settings.Has("toString")` answered `true`,
`Settings.Get("toString")` answered a function, and `Record.Load` dropped every
unknown key named after an `Object.prototype` member, breaking the documented
promise that a key the record does not describe survives the round trip. Those
four lines are fixed (`hasOwn.call` at each, and the trap is written up in
`AGENTS.md`), and the sentence that made them look safe is not.

So the manual owes two replacements, not one: a true statement about what
`for...in` recites, and the own-key doctrine stated where somebody writing `in`
would read it. The doctrine has exactly **one** implementation in the prelude
today — `hasOwn`, captured at `rad.js:64`, used by `Dictionary` and by the two
that had to be taught it.

### 2.7 What `Application.OnError` hands over

It receives `(message, stack)` as two strings, not the error: the name is gone
(`TypeError` and `RangeError` read the same), and nothing can be re-thrown. It
is enough to log and enough to show, which is what it was built for; it is worth
saying so in [`runtime-api.md`](runtime-api.md), which currently describes the
pair without saying it is not an `Error`.

### 2.8 Class names are ASCII-only, in three copies

Three independent copies of the same byte-at-a-time check, sharing no helper:
`is_identifier` in `bta_runtime.c:354-362` (the `g_ascii_isalpha` is on `356`,
and `is_class_path` that uses it at `365-378`), `is_identifier` in
`bta_form.c:36-44`, and `js_is_ident` in `bta_task.c:415-423`. The engine
accepts `Peón` as an identifier; these do not.

**They refuse three different things, with three different sentences**, which is
worth separating because a single fix will not cover all three:

- A `.form` declaring `"type": "Peón"` reaches `bta_lookup_global` and is
  refused as *"'%s' is not a valid class name"* — the one place that sentence
  exists, `bta_runtime.c:400`. A `startup` (`1991`) and an `entry` (`1902`) with
  an accent land on the same message.
- `bta_form.c:315-317` is about the control's **`name`**, not its `type`, and
  says something else: *"form: '%s' is not a usable control name"*.
- `bta_task.c:442` only decides whether a *folder* contributes a namespace
  prefix; a folder with an accent is walked silently without one
  (`446-448`). A file named `Peón.js` **is** indexed — there is no identifier
  check on the basename (`451-453`) — and is refused later, at lookup, by the
  first sentence above.

The limit is written down nowhere: no hit in `docs/llm/`, `docs/runtime-api.md`
or `docs/reference/`. Either document it, or read the identifier with `g_utf8_*`
the way the engine does.

## 3. Cost

None of these was timed by this audit; they are what the code does, with the
shape of the cost. The one number that comes from a measurement is 3.7's, and
it is from [`plans/debug-plan.md`](plans/debug-plan.md).

### 3.1 Every class lookup without a `.form` compiles an expression

`bta_lookup_global` falls back to `JS_Eval(ctx, name, ..., "<class-lookup>")`
when a bare name is not on `globalThis` (`bta_runtime.c:431`) — which is every
class declared with `class Foo {}`, since those live in the global **lexical**
scope. `bta_widget_new` reaches it per instance for any project class that is
not one of the runtime's (`bta_widget.c:4765`, `4803`). A form with fifty
components with no `.form` of their own is fifty compilations of the same
identifier. A one-entry cache of the successful lookups (misses cannot be
cached: a class may be declared later) removes it.

### 3.2 `form_path` reindexes project and libraries on every miss

`runtime/src/bta_form.c:618-641` throws the whole index away and walks the
project plus every library on a miss. The comment argues the trade: *"Walking a
project costs far less than a form that does not load"*, and the miss is how a
`.form` the IDE just wrote is found. The other half is that a class built
entirely in code — legal and documented — misses on every instantiation. A
timestamp or generation mark on the index keeps the IDE's case and drops the
repeated walk.

**`task_class_file` now rebuilds on a miss too** (that was 1.12, whose comment
had claimed it for a long time), so whatever is decided here should be decided
for both. The costs are not the same, which is why one was a defect and this is
a cost: a miss in the task index means `Task.Start` is about to throw, so the
walk is on a path that fails anyway, while a miss in `form_path` is an ordinary
instantiation that is about to succeed.

### 3.3 Every appearance property reparses the whole stylesheet

`widget_styles_apply` inserts the rule and then
`gtk_css_provider_load_from_string(style_provider, css->str)`
(`bta_widget.c:1156`, `styles_rebuild` at `1146`). A `.form` with three
appearance properties on each of N controls reparses the accumulated sheet O(N)
times. A dirty flag and one rebuild on idle — or one rebuild at the end of
`apply_properties` — changes no semantics.

### 3.4 Removing a child is O(n) in JavaScript

`bta_widget_release` calls `Array.prototype.indexOf` and `splice` through the
interpreter on the parent's `__children` (`bta_widget.c:148-178`). Emptying a
container of N children is N² array steps in JS plus N property lookups by
name. It is the designer's ordinary gesture (`Clear`/`Delete`/rebuild). An index
kept on the wrapper side, or the parent's wrapper found through
`bta_widget_of` instead of the `__children` accessor, would make it O(n).

### 3.5 Every event names its handler with a fresh string

`emit_on` builds `g_strdup_printf("%s_%s", name, event)` per dispatch
(`bta_widget.c:286`) — **before** the `JS_IsFunction` test at `291`, so it
happens for every `MouseMove` over a widget with no handler, on every ancestor,
since `attach_mouse` (`3682`) installs its controllers at `GTK_PHASE_BUBBLE` for
every widget the common constructor builds (`4658`). The `JS_GetPropertyStr` on
the next line interns an atom from that string and drops it again, so the cost
per dispatch is an allocation *and* an atom round trip.

The other `"%s_%s"` in the tree is `bta_has_handler` (`bta_widget.c:367-377`),
which is **not** a hot path: its only callers are `Paginate`/`DrawPage`
(`bta_printer.c:313`, `504`, `bta_paint.c:1838`).

An atom cache per (name, event), dropped when a name changes, takes both off the
hot path.

### 3.6 Loading a `.form` asks each property's prose membership afresh

`bta_widget_text_prop_field` is called once per property per node
(`bta_form.c:259`) and walks the prototype chain with `class_list_of` and
`g_strsplit` every time (`bta_widget.c:2158`, `2224`). The answer is a fact
about a class: caching "the prose set of this prototype" would remove hundreds
of allocations per load.

### 3.7 The debugger's hook is always on

`BTA_DEBUG_STEP` is a branch in the interpreter's dispatch, both spellings of
it, and with no handler installed it is +12.5 % on tight arithmetic and +16.4 %
on property reads — measured, both off against the same tree without it
(`plans/debug-plan.md`, stage 5). The plan's technique 2 (the bytecode patch
that makes this scaffolding and removes the branch) is still the open stage;
until it lands, every program pays for the debugger.

### 3.8 `bta_sys_pending` counts by walking

`g_list_length` **twice** — not three times — every time the loop asks whether
anything is owed (`bta_sys.c:3325-3328`); the third term is `g_hash_table_size`,
which is O(1):

```c
return g_list_length(exec_jobs) + g_list_length(watch_jobs)
       + (timers ? g_hash_table_size(timers) : 0);
```

And only a **console** project asks: `run_console` arms
`g_timeout_add(20, console_idle, app)` (`bta_runtime.c:1929`), so the ~50 times
a second is right but belongs to tools and tests, not to an application with a
window, which never polls this. Counters, or a short-circuit "is any
non-empty", for lists that are expected to be empty almost always — but this is
the smallest item in this section, and it is listed for completeness rather than
for action.

### 3.9 Nine hand-rolled async job shapes — *noted*

`WatchJob` (`bta_sys.c:469`), `ExecJob` (`1043`), `TimerJob` (`2089`),
`PasteJob` (`2449`), `DialogJob` (`2539`), `HttpJob` (`bta_http.c:61`),
`BtaTaskJob` (`bta_task.c:159`), `PrintRun` (`bta_printer.c`), `BtaMedia`
(`bta_media.c:62`) each carry a `JSContext`, one or more `JSValue`s, a list of
live jobs, and a free path that must release on every exit. `bta_widget_watch`
and `http_job_alive` exist because two of these forgot; a shared base for
"a job with values and a dead flag" would shrink the surface where forgetting
one is possible. Not a bug today.

## 4. Friction the IDE and the examples pay for

These are not defects; they are places where the language's own vocabulary is
missing and the biggest program written in it pays.

**The counts here are from the working tree, not from `271eeb6`**, and the
difference matters for four of them. `examples/assistant` and `examples/kanban`
are not in that commit — they are uncommitted work in progress. §4.7 and §4.8
rest on `examples/assistant` entirely, and §4.6 and §4.12 rest on
`examples/kanban` in part. Those four report the state of a draft, which is not
the same claim as the rest of this section makes; the `// TEMP` lines in §4.12
in particular are scaffolding in something still being written. Everything else
below is at `271eeb6`.

### 4.1 A shown `Form` has to be kept alive by hand — 16 copies

Every dialog opens with a module-level array and closes with a `splice`:

```js
/* While it is open nothing else references it: without this the collector takes
 * it away and the window is left without its handlers. */
const openPrompts = [];
/* ide/forms/AskForm.js:12, under the comment at :10 */
```

The same block is in `AboutForm`, `AppForm`, `ClassForm`, `ColumnForm`,
`ConfirmForm`, `IconForm`, `ImageForm`, `LaunchForm`, `MenuForm`,
`NewProjectForm`, `ProjectForm`, `QuickForm`, `StyleForm` and `SymbolForm` —
fifteen arrays. `PoForm` is the sixteenth and carries the identical comment
(`PoForm.js:23-26`) over a different container: `const openCatalogues = new Map()`
(`:27`), `set` at `:66`, `delete` at `:401`. Sixteen forms, then, doing one
thing two ways — which is itself a small argument for the primitive.

It is the shape `AudioPlayer.Play` already solves for
itself: a shown form is doing something the collector must not undo, and the
runtime could take that reference in `Show` and drop it in `Close`, rather than
sixteen applications remembering.

### 4.2 There is no "I have been laid out" — 5 sites plus the harness

`Bounds()` reads zero until GTK has allocated, and `Form_Open` runs before the
window is presented, so five places retry on a timer:
`Ide.Chrome.position(tries)`, `ImageForm.fit(tries = 25)`,
`examples/viewer/Viewer.js`'s copy, `examples/i18n/Anchors.js`'s `whenLaidOut`
and `Layouts.js`'s copy of it — each bounded, each asking again. The suite's
`until`/`settled` is the same idea and is *not* the thing to promote
(`plans/async-plan.md` says so). An `Allocated` event, or
`Widget.WhenLaidOut(fn)`, would replace the five application copies with one
frame the runtime knows it has taken.

### 4.3 Line ↔ offset conversions, rebuilt four times and inlined six more

`TextEditor`/`SourceEditor` publish `Line`, `Column` and `Select`, and nothing
turns a character offset into a line. So: `Live.js:162` (`lineAt`, with a
comment at `158` explaining it cannot be shared because `Navigator` already
declares the same name at top level), `Navigator.js:237`, `Names.js:259`
(`lineOfIndex`), `FormFiles.js:26` (`lineOf`), plus five inline
`src.slice(0, m.index).split("\n").length` in `Strings.js` — at `260`, `308`,
`331`, `350` and `371` — and the inverse shape at `MainForm.js:1963`
(`editor.Text.split("\n")[editor.Line - 1]`, line → text rather than offset →
line). `Editor.Offset` (the cursor as a character) and `Editor.LineAt(offset)` —
or a `Text.LineAt(text, offset)` — close all ten.

### 4.4 Paths relative to a root, and extensions

`File.Join/Absolute/Name/BaseName/Directory/Extension` exist and
`File.Relative`/`File.Within` do not, so about ten sites spell
`startsWith(root + "/") ? slice(...)` themselves: `Runner.js:221` and `:321`,
`Debugger.js:438`, `Git.js:149` (a whole boundary class,
with the `rev-parse --show-prefix` trap in `AGENTS.md` behind it),
`Classes.js:769`, `Document.js:169`, `Exporter.js:93`, `examples/assistant`,
and `examples/serve/Main.js:40` (which slices without even asking
`startsWith`). The same `File.Extension(f).toLowerCase()` appears **43** times
across `ide/`, `examples/` and `lib/` — 46 counting `tests/`, with
`Classes.js` alone holding twelve; an `IsExtension(f, "js")`
or a case-folding option on `Extension` would make the idiom one call and
impossible to forget half of.

### 4.5 Asking what a type has means building one

`Widget.Types()` exists; a class-level `PropertyNames(type)`/`EventNames(type)`
does not, so the IDE builds disposable probes and deletes them:
`PropertyGrid.baseProperties()` constructs every type to intersect them
(`PropertyGrid.js:200-229`), `Names.sampleFor`, `Strings.textPropertiesOf`,
`Completion`, `Classes.componentProbe`, `Check` (`new Form()` as a probe). A
class can answer about its own prototype without an instance — the serialiser
already reads it that way — and the runtime could publish it.

### 4.6 A control built from code has no `On(event, fn)`

Handlers are properties named `<name>_<Event>` on the form, so dynamic controls
assign and delete them by hand: `PropertyGrid.js:707-710`, `MenuBar.js:309-328`,
`Palette.js:415`, `IconForm.js:71-89`, `kanban/Board.js:285-299`. The sharp edge
is the component: a `Component` added from code keeps itself as its event target
(`AGENTS.md` documents it; `kanban/Board.js:431-440` is the example that gave up
its `TaskCard` and wrote panels by hand, and says so in the comment at `440`).
A `Widget.On(event, fn)` — and an
`Add` that rebinds a component to its host the way the loader does — is the
primitive all six are reaching for.

### 4.7 `Stop()` is idempotent and nobody believes it

Eleven `try { ….Stop(); } catch (e) {}` in `examples/assistant` alone. `Exec`'s
`Stop()` answers `false` for a child already reaped and `Timer.Stop()` answers
`false` for one already stopped; neither throws. The contract is fine and
undocumented, so every caller defends against an error that cannot come.

### 4.8 `Timer.After(0)` used as "defer this"

`examples/assistant/OpencodeClient.js:61,84,193` uses it to turn a synchronous
throw into an asynchronous callback, which is a *statement about when code
runs* and not a timeout. The manual explains `Timer.After(0)` as "let GTK draw
a frame". If deferring is a thing a program can want, it wants a name.

### 4.9 Writing a `.po` has no runtime verb

`Locale.Read` reads a catalogue (`bta_locale.c:1691`) and `Locale.Write` does
not exist, so `Translations.js:88-175` writes the format by hand — `poQuote` at
`89`, header, plural forms, wrapping, `File.Save` at `174`: some eighty-seven
lines. One consumer, but it is the only implementation, and the reader already
exists to be its other half.

### 4.10 `Text.Escape` exists and is reimplemented

`Debugger.js:528-532`'s `escapeMarkup` is `&`, `<`, `>` by hand; `Text.Escape`
(`js_text_escape` at `bta_paint.c:1353`, registered at `1385`, documented in
[`reference/globals/Text.md:16`](reference/globals/Text.md)) is the runtime's
own. It reimplements it with the spelling the manual also argues against: the
three lines are `.replace(/&/g, …)` and its siblings, where
[`llm/language.md:101-102`](llm/language.md) asks for
`new Regex("x").Replace(s, y)`. One call replaces both.

### 4.11 `Translations.update` is the recursion the async plan retired

`Translations.js:429-444` — `update()` at `380`, the closure at `430-443`,
`next(i + 1)` at `441`, `next(0)` at `444` — chains `msgmerge` calls through a
closure that carries its own index, the exact shape `plans/async-plan.md` opens
with as the thing `Exec.Wait` was supposed to replace. The plan names it
`Translations.mergeAll`, and nothing in the tree is called that any more; the
recursion it was written about is still here under another name.

### 4.12 Leftovers

`NAMESPACE_PART` (`Classes.js:75`) is declared and never used; `IDENT`
(`Designer.js:29`) is `CLASS_NAME` (`Classes.js:67`) written a second time;
`JSON.parse(JSON.stringify(x))` appears twice (`LaunchForm.js:41`,
`MenuForm.js:43`) where `Record.Clone()` exists (`rad.js:1517`); and
`kanban/Board.js:163,523` still print `// TEMP` on every selection and after a
second.

### 4.13 The reference's blind spots

`print` and `BTA_VERSION` are the two globals with a row in neither
`GLOBAL_TABLES`/`GLOBAL_VARS` (`tests/api/Check.js:73-138`) nor a page under
`docs/reference/globals/`, so nothing demands their documentation stay true.
(`Connection`, `Database.Sqlite` and `Multipart` *are* covered — `conn_props`
at `Check.js:84` and `multipart_props` at `:87` — and `Message`'s page is
hand-written by design, which the file says at `Check.js:576-580`.)

**"The two" is the count of globals with *neither*, and one more deserves a
look.** `Painter` is installed on the global object (`bta_paint.c:1728`) and has
no page under `docs/reference/globals/` either; it is not unchecked, because
`painter_props` is reached by the non-global table scan at `Check.js:961`, but
it is undocumented in the place a reader looks. Worth deciding whether the page
rule is about globals or about surfaces.

## 5. Checked and discarded

What the audit looked at that did **not** become a finding, so it is not looked
at twice.

**False positives from the static analyser**, each read and dismissed:
`bta_widget.c:1124` `p` is freed by `g_clear_pointer`; `bta_controls.c:3196`
`strv` by `g_strfreev`; `bta_controls.c:4778` a `NULL` widget cannot reach
`cal_marks`; `bta_http.c:3583` the list and its elements are freed; and
`bta_notebook.c:161`'s output is assigned on every path that returns success.

**Claims corrected while verifying.** `Connection`/`Multipart` are in
`Check.js` (above); `Message` needs no source to read by design; and one early
probe reported `Task is not defined` because the binary was older than the
sources — after `cmake --build build`, it is there. `AGENTS.md` warns about
exactly that, and this is what it looks like from the other side.

**Deliberate decisions, already written down and not re-argued here.** No
`Promise`/`async`/`await`, no imports, `Object` emptied, no `Intl`, no typed
arrays, `DatePicker` with no empty date, `ComboBox` with no empty text,
`localeCompare` as a known trap (the *decision to leave it* is §2.1's, which is
that nobody has made it), and the three things
[`widgets.md`](widgets.md#three-things-that-were-considered-and-are-not-coming)
refuses. The pointers are [`llm/issues.md`](llm/issues.md) and
[`llm/language.md`](llm/language.md).

**Already planned, with a trigger.** The debugger's bytecode patch
(`plans/debug-plan.md`, stage 5), `Exec.Wait` and genera/barriers
(`plans/async-plan.md`), forms over records (`plans/data-plan.md`), the analyser
(`plans/completion-plan.md`), the remotes half of git
(`plans/git-plan.md`), and the four reported gaps under
[`issues/`](issues/README.md). The §2.1 `localeCompare` decision and the §4
primitives are *not* on those lists; this is where they are written down.

**Known and open already.** The two `GLib-GObject-CRITICAL: instance has no
handler with id` at teardown, reproducible after `testTabAction` and not
explained yet, are in `AGENTS.md`; `tests/run.sh`'s runner does not count
criticals at all (`tests/runner/Main.js`'s `NOISE` at `:59` filters warnings
only, so a critical is *printed* at `:190` and pass/fail is decided solely by
the child's exit code at `:191-199`, and no script sets
`G_DEBUG=fatal-criticals`). That blindness is how `Split.Reorder`'s unguarded
`g_object_ref(NULL)` survived: the criticals printed on every green run and
nothing read them. The ref is guarded now and the suite reorders a one-child
split, but **the runner still cannot fail on a critical**, which is worth a line
in `testing.md` rather than a finding here.

**One observation that is not a defect.** `GTK_IS_BOX(slot)` and
`GTK_IS_FRAME(slot)` branches in attach/detach (`bta_widget.c:3785`, `3906`,
`3988`) have no container assigning such a slot today: a `Panel`/`Form`/
`Frame`/`Expander`/`Scroller` slot is a `BtaFixed`, and everything else is its
own GTK type. Left as-is — the day one is used, the branch is already correct —
but a reader should know the code is ahead of the program.
