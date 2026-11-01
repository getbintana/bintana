# Fuzzing the other half of `.form`: a plan, not a feature

**Pending for 1.0.** The loader and the check have a fuzz pass
([`tests/formfuzz`](../../tests/formfuzz/Main.js), driven by
[`tests/formfuzz.sh`](../../tests/formfuzz.sh)): a deterministic mutation per case,
one child per case, both the loader and `bintana check`, and it runs under
`build-asan` too. What it found is in
[`docs/agents/testing.md`](../agents/testing.md) and
[`docs/agents/widgets.md`](../agents/widgets.md).

**What is not fuzzed is the other direction.** `Serialize` in
`runtime/js/rad.js` writes a live tree back as a `.form`, and
`Container.BuildChildren`/`AddNode` in `runtime/js/forms.js` build a tree from a
node -- the designer's path, undo, and every `BuildChildren` in the suite. Today
both are covered by round trips over trees the tests build by hand.

**Why it matters.** The serialiser is the inverse of the loader: a property it
writes in the wrong shape is a `.form` the next open refuses, or a form that
looks right until the first save. `BuildChildren` clears the container before it
builds anything, and it trusts `node`: a malformed snapshot leaves the designer's
panel cleared or half-built, and the assertion that would say so is the one that
never ran. Neither path has the shape rules the C loader now has.

**The shape of the work.** A deterministic generator of widget trees (a few
containers, every property kind, a deferred property, a table, a menu), and a
corpus of nodes that are almost one (`children` as an object or `null`, a
`properties` array, a numeric `name`, a node that is the form itself). For each:
`Serialize` then load it back through `BuildChildren`, under `tests/widgets` and
`build-asan`, and assert the tree that comes out is the tree that went in -- and
that a malformed node throws a sentence rather than clearing the panel and
carrying on. The first half is in-process: GTK is the point, so `tests/widgets`
is where it belongs, not a console child.

**Out of scope.** Random property values (the columns of a `TableView`, the
paths of a `Picture`): those are the property grid's and the format's, and a
fuzzer there would spend its time on the catalogue and the filesystem rather
than on the tree.
