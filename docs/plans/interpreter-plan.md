# The interpreter: what is left to make faster, and in what order

**Not started** (2026-10-10). The cheap half is done: the GCC 14+ fix
(`2f0aa72`, two to three times faster), the release builds optimised
(`RelWithDebInfo`), and the eleventh and twelfth fork patches (`string2`
34.8 -> 3.9 s, `string1` 10.3 -> 5.5 s). `tests/bench` went **65.5 -> 30.0 s**
over Gambas's eight programs. What is left is not a function to fix: `perf`
says it is the interpreter loop, the size of a value and property lookup with
no inline caches (`AGENTS.md`, *Profiling the interpreter*). This plan is the
order to attack that in, and -- first -- the measurement that decides whether
to attack it at all.

## Where the numbers stand

`RelWithDebInfo`, best of three, this machine, after patch 12:

| program | what it is | ms | what `perf` says |
|---|---|---|---|
| `btree` | allocation, `this.left` | -- | `find_own_property`, `JS_SetPropertyInternal2`, the arena |
| `mandelbrot` | floating point | -- | beats CPython |
| `nbody` | objects of numbers | -- | beats CPython |
| `polynom` | an array of doubles | -- | 90 % `JS_CallInternal`, spread over every opcode |
| `primes` | an 80 MB array | -- | 27 % `set_value`: cache misses on 16-byte values |
| `sort` | compares and swaps | -- | 90 % `JS_CallInternal` |
| `string1` | `replaceAll` on a growing string | 5505 | copying, which `memcpy` already does |
| `string2` | 26 million appends | 3938 | linear since patch 11 |

**Stage 0 fills the dashes** -- the per-program column was never written down
in one place, and every stage below is judged against it.

## Stage 0: is the interpreter what a Bintana program waits for?

The bench is Gambas's programs, and none of them is a Bintana program. What
this runtime runs is forms: a `.form` loaded, handlers dispatched, a property
grid rebuilt, the IDE's own 110 KB `MainForm.js`. **If that time is in GTK,
no interpreter work below is worth its risk**, and the plan ends here with the
number that ended it.

1. Fill the table above (`BINTANA=build-rwd/bintana ./tests/bench.sh`, with
   `uptime` checked first -- a browser tab at 99 % moved the whole bench from
   30 to 39 s once).
2. `perf record -e cpu_core/cycles/u` over three real workloads, each against a
   `RelWithDebInfo` build: the IDE starting on `examples/clients`, the
   `tests/ide` prefix up to `designer`, and `tests/widgets`. Report the share
   of `JS_CallInternal` and its callees against GTK, Pango and cairo.
3. Write the split here. **The gate**: stage 2 goes ahead only if property
   access (`find_own_property` and the `JS_*PropertyInternal*` family) is a
   visible share of a real workload, not only of `btree`.

Stage 1 does not wait for the gate: it is small, measured already, and costs
nothing a program can see.

## Stage 1: the debugger's check out of the loop

Patch 4 puts `if (unlikely(rt->debug_handler))` before every opcode
(`BTA_DEBUG_STEP` in the `SWITCH` macro). Measured after the GCC fix: **0 % on
arithmetic, about 10 % on property reads** (507-510 against 565-570 ms), with
no debugger attached.

**The shape**: with `DIRECT_DISPATCH` the loop jumps through
`dispatch_table[256]`. A second table whose every entry is one trampoline
label -- call the hook, then `goto *dispatch_table[opcode]` -- and a local
`const void * const *table` chosen once at the top of `JS_CallInternal` from
`rt->debug_handler`. The plain road then has no check at all; the debug road
pays one extra indirect jump, which next to a hook that runs C per opcode is
nothing.

**Why choosing at entry is enough**: `bta_debug.c` installs the handler once,
before the first line runs, and never removes it (detaching disarms the
breakpoints, not the handler). So the handler is a constant of the process,
and a frame cannot start under one table and need the other. **That is the
invariant to write beside the code**, because a future *attach to a running
program* breaks it -- and then the table has to be re-read on a backward jump
and at a call, which is where the check would go.

Things to settle while doing it:

- The `switch` spelling (`!DIRECT_DISPATCH`, which is MSVC's) keeps the branch
  as it is. Windows builds with MinGW, which has computed goto, so no platform
  this tree ships loses anything.
- **How to assert it without a clock**, which the patch rule demands (*dropping
  it does not fail to build*). The ratio trick of patch 12 needs two roads of
  one machine; here the two roads are *with a debugger* and *without*, and both
  exist before the patch too. Candidate: a child under `--debug` with no
  breakpoint against the same loop without, where the patch should widen the
  ratio. If no ratio is stable enough, say so in `AGENTS.md` and let the bench
  be the record -- an assertion that flakes is worse than none.
- Re-measure with `tests/bench`, and the property-read microbenchmark from
  patch 4's note, back to back.

Expected: a few points on property-heavy code (`btree`, `nbody`, the IDE),
nothing on arithmetic. It becomes patch 13, and stage 5 of
`debug-plan.md` (the bytecode patch) is retired by it.

## Stage 2: inline caches for `get_field` and `put_field` -- only past the gate

QuickJS looks a property up through the object's shape: a hash of the atom,
then a chain (`find_own_property1`, `quickjs.c` ~6904). There is no cache per
call site, so `this.left` in a loop hashes every time, and `new TreeNode(l, r)`
walks two shape transitions per object.

**Upstream already tried this and took it out, which is the first thing to
read.** quickjs-ng carried *polymorphic* inline caches from v0.9.0
(`6b78c7f`, 2023-11) and removed them before v0.17.0 (`7de6d46`, 2025-02,
486 lines): *"a mixed bag: sometimes faster, sometimes slower, always more
memory hungry ... better to remove the current implementation and start
afresh"* (quickjs-ng#876). `763076d` says the original had what its author
"strongly suspects are bugs". So this stage starts with:

1. `git show 7de6d46` in the fork, and #876 read whole: which benchmarks got
   slower, why, and what the suspected bugs were.
2. A design that answers each of them. What the removed one did and this one
   should not: a ring of four entries plus a hash per function (the memory),
   and three new opcodes that had to be kept out of serialised bytecode
   (`c7ca3fe`) -- which matters here because `bundle-plan.md` serialises
   bytecode.

**The candidate shape**, to be argued against what step 1 finds:

- **Monomorphic only**: one `{shape, index}` per site. A site that sees a
  second shape goes back to the hash lookup and stays there (*megamorphic*);
  no ring. Most sites in form code see one class.
- **The cache holds a reference on the shape** (or is cleared when the shape
  is freed). A raw shape pointer is an ABA bug: the shape is freed, another is
  allocated at the same address, and the cache answers an index from a
  different layout -- a wrong property read, not a crash, and ASan will not see
  it, because shapes come from the arena (the `JSValue` note in `AGENTS.md`).
- **`put_field` caches the transition**: `{old shape, new shape, index}`, so a
  constructor that adds `left` then `right` reuses both transitions. This is
  the half `btree` is made of.
- **Own properties first.** A method found on the prototype (`this.check()`)
  needs the holder's shape *and* every shape between to be unchanged; that is
  a second step, taken only if the first pays.
- Where the slots live: an array on the `JSFunctionBytecode`, indexed by an
  operand the compiler assigns -- not new opcodes, so serialised bytecode does
  not change shape.

**What decides it**, written before the code so the code cannot move it:

- `btree` and a property-read microbenchmark faster by a margin well past the
  spread; **no program in the bench slower than its spread**;
- the IDE's resident memory after opening `examples/clients` not up by more
  than a few percent (measured with `/proc/<pid>/status`);
- the fork's own tests and `tests/run.sh` green, `tests/asan.sh` clean, and a
  test in the fork that reads a property through a shape that was freed and
  reallocated -- the ABA case, which no ordinary test will hit;
- a clock-free assertion in `tests/widgets` on the ratio trick: the same read
  at a site that sees one shape against a site that sees many. Without caches
  they cost the same; with them the first is faster.

If it fails any of those, it is written down here as measured and dropped, as
upstream did. **It is days of work in the part of the engine where a mistake
answers the wrong value**, which is why it comes last and behind a gate.

## Measured and not worth doing

Recorded so they are not tried again:

- **Globals into locals.** Every Bintana program is globals; a global costs
  5-10 % over a local (a call 514 against 477 ms over 1e7, a `const` 292
  against 271, `new` no difference).
- **`-O3`.** Moves `string1` 24 % one way and `nbody` 12 % the other, nothing
  else. The packages stay `RelWithDebInfo`.
- **Raising `JS_STRING_ROPE_SHORT_LEN`.** Divides the quadratic term of the old
  append by sixteen and keeps it; patch 11 is the fix.

## Not on the table

- **A smaller `JSValue` (NaN-boxing on 64-bit).** It is what `primes` wants,
  and QuickJS only boxes that way on 32-bit; every line of the engine and
  every rebase would carry it. `BtaValue` already has room for either size
  (`G_STATIC_ASSERT` in the plugin loader), so the runtime is not what stops it.
- **A JIT, or another engine.** Out of proportion to an interpreter that already
  beats CPython on floating point and is within a small factor elsewhere.

## Order, and what each stage costs

| stage | what | size | risk | waits for |
|---|---|---|---|---|
| 0 | the table, and `perf` over real workloads | an afternoon | none | nothing |
| 1 | a second dispatch table for the debugger | a day | low: one macro, and the debugger's tests | nothing |
| 2 | monomorphic inline caches, own properties | days | high: wrong values, not crashes | the gate in stage 0 |
| 2b | the prototype half | days | high | stage 2 paying |

Each fork change follows the rule the twelve patches follow: one commit in
`../bintana-quickjs` on `bintana`, a row in its `BINTANA.md`, a section in
`AGENTS.md`'s *The patches in vendor/*, an assertion in `tests/widgets` that
goes red without it, and the rebase past v0.17.0 (`876442b`, `c359cac`) kept
in mind -- **doing that rebase before stage 2 is worth considering**, since a
cache written against v0.17.0's property code is the patch most likely to
conflict.
