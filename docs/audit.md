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

**Section 4 is gone as well**, and mostly by moving rather than by fixing: seven
of its thirteen were words the language has not got and are `issues/` files now,
two went to [`plans/async-plan.md`](plans/async-plan.md), and one lost its
evidence with the work in progress it was drawn from. The three that were
**defects after all** are fixed — `Debugger.js` reimplemented `Text.Escape` by
hand, `NAMESPACE_PART` and a second spelling of `CLASS_NAME` were dead, and
`print`, `BTA_VERSION` and four more globals were installed and named in no list
`tests/api/Check.js` keeps.

That last one turned out bigger than filed. The audit said two globals; measured
at the time of the fix it was **six**, and the reason is structural rather than
an oversight: the check asked whether what is *declared* is documented and could
not ask whether what is *installed* is declared. It can now, reading the
installed set from the C, the prelude and `close_hatches`' own list of
removals — so a global added without a home fails the suite instead of being
invisible to it.

**So only §3 is left, and it is down to seven.** 3.7 went because it was the one
entry with real numbers and they are not this document's: the debugger's branch
costs +12.5 % and +16.4 % *measured*, and the bytecode patch that removes it is
stage 5 of [`plans/debug-plan.md`](plans/debug-plan.md) — a second description of
a planned change, sitting in the file for things that are wrong today. 3.9 went
because it said of itself *"not a bug today"*: nine hand-rolled job shapes is a
refactor somebody may want, and the fact worth keeping out of it — that two of
the nine forgot to release, which is why `bta_widget_watch` and `http_job_alive`
exist — is in `AGENTS.md`, where a trap is read.

## 3. Cost

**None of these was timed by the audit**; they are what the code does, with the
shape of the cost and no number under it. That is the difference between this
section and every other one in the file: the rest named a promise and could be
checked against it, while these name a shape and can only be checked against a
clock.

**They have been now, and five of the seven left on the strength of it.** One
was much worse than filed and is fixed; four were fine and their numbers are in
`AGENTS.md`, where somebody about to optimise something will look.

The one that was real: a `.form` of `Label`s with two appearance properties
each, built twelve times, median —

| controls | before | after |
|---|---|---|
| 50 | 112 ms | 4.2 ms |
| 100 | 667 ms | 7.6 ms |
| 200 | **2392 ms** | 14.8 ms |

— against 5 ms for the same form with no appearance at all. That is 3.3, and the
measurement is the whole point of it: *reparses the sheet O(N) times* reads like
something to get to eventually, and *a window takes two and a half seconds to
open* does not, and they are the same sentence.

The four that were fine: a class looked up without a `.form` is **2 ms** for two
hundred components; the prose-membership walk is inside a **5 ms** floor;
dispatching an event with no handler is **580 ns** and 2.2 ms per three seconds
of continuous mouse movement, though it does scale with tree *depth* rather than
with handlers; and emptying a container is superlinear but **1.4 ms at a hundred
children**, with `Clear()` twice as fast as deleting them one by one.

**What that leaves is two**, and neither is a thing done wrongly: 3.2 is a trade
somebody argued for in a comment, and 3.8 is small and known.

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
