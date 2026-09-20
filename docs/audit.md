# External audit

Findings from a code audit done outside the tree's own work, at `271eeb6` on
19 September 2026. Everything here was found by reading
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

**2.4 went as well, and it was right for a reason it did not give.** The manual
justified `for...in` with *"nothing can put anything on a prototype any more"*,
which is three claims stacked. Measured: `for...in` over `{a:1}` answers `[a]`,
so it really is safe from the builtins — but because they are **non-enumerable**,
which is the engine's doing and would survive any amount of further curation.
`Object.prototype.x = 1` still works and *is* recited, and the program cannot
defend itself, since `freeze`, `seal`, `preventExtensions` and `isExtensible`
went with `Object`'s statics. And `Dictionary.Keys` is immune to both, which is
the strongest argument for it and was written down nowhere. The audit filed this
as the bill for 1.3; it is not, and the difference is load-bearing — 1.3 was the
`in` operator and a bracket read, which see non-enumerable inherited names,
while this sentence is about `for...in`, which never does.

**2.7 and 2.8 close the section**, both as sentences the documents owed rather
than as code. `Application.OnError` receives two strings and not the `Error`, so
a `TypeError` and a `RangeError` arrive indistinguishable and nothing can be
re-thrown — enough to log and enough to show, which is what it was built for,
and now said where the signature is. And every name the runtime looks something
up by is **ASCII**, which is narrower than the engine underneath: measured,
`CheckSource("class Peón {}")` answers `null` and `Widget.New("Peón")` refuses.
Documented in `formats.md` and `llm/forms.md` rather than widened, because
reading UTF-8 means unifying three copies first to enable something nobody has
asked for, and a class name is also a file name. One correction to the finding:
its third copy, in `bta_task.c`, is **not** a refusal — a folder it cannot spell
contributes no namespace prefix and what is under it stays findable by its bare
name, which is deliberate and says so in a comment.

**So sections 1 and 2 are both gone, and most of §4 has moved** to the places
that own its kind of claim: seven `issues/` files for the words the language has
not got, and two lines in `plans/async-plan.md`. What remains is §3's costs —
none of which this audit timed — and three small defects §4 had miscategorised.

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

## 4. What the IDE does the long way

**Seven of this section's thirteen became `issues/` files**, which is where a
missing capability belongs: this document is for things the runtime does
*wrongly*, and *a word it has not got* is a different claim with a different
form and a different rule for being deleted. They are the shown `Form` kept
alive by hand, the missing *I have been laid out*, an editor that cannot cross
from an offset to a line, `File.Relative` and a case-folded `Extension`, asking
a class what it has without building one, `Widget.On(event, fn)`, and
`Locale.Write`. Each is now argued in the form
[`llm/issues.md`](llm/issues.md) asks for, with the counts it had here.

**Two went to a plan.** `Timer.After(0)` used to mean *the next turn* and
`Translations.update`'s `next(i + 1)` recursion are both about a word for
sequencing, and [`plans/async-plan.md`](plans/async-plan.md) is the document
that owns that question — it opens on that very recursion.

**One went nowhere, because its evidence did.** `Stop()` defended against an
error that cannot come was eleven `try`s in work in progress; in the committed
tree the only `try` around a `Stop()` is a test asserting the refusal, not a
caller fearing it.

What is left below are three the audit filed here and which are **defects after
all** — a verb reimplemented, dead code, and documentation that nothing holds to
its word.

### 4.10 `Text.Escape` exists and is reimplemented

`Debugger.js:528-532`'s `escapeMarkup` is `&`, `<`, `>` by hand; `Text.Escape`
(`js_text_escape` at `bta_paint.c:1353`, registered at `1385`, documented in
[`reference/globals/Text.md:16`](reference/globals/Text.md)) is the runtime's
own. It reimplements it with the spelling the manual also argues against: the
three lines are `.replace(/&/g, …)` and its siblings, where
[`llm/language.md:101-102`](llm/language.md) asks for
`new Regex("x").Replace(s, y)`. One call replaces both.

### 4.12 Leftovers

`NAMESPACE_PART` (`Classes.js:75`) is declared and never used; `IDENT`
(`Designer.js:29`) is `CLASS_NAME` (`Classes.js:67`) written a second time;
and `JSON.parse(JSON.stringify(x))` appears twice (`LaunchForm.js:41`,
`MenuForm.js:43`) where `Record.Clone()` exists (`rad.js:1517`).

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
