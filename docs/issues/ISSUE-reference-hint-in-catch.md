# ISSUE: the "did you mean" sentence is lost inside a `catch`

## What the application needed

An error panel: the application catches what a module throws and shows the
message in a status bar, so the person reading it is the one who can fix it.
The concrete case was an import routine that catches everything and shows the
text to the operator — and the text said only `setTimeout is not defined`.

## What I wrote instead

The program joins the error to the table itself: `Application.Replacements()`
publishes every name that was taken and what to write instead, so the handler
matches the name out of `e.message` and builds the sentence itself.

## The code I wish I could have written

```js
try {
    Import.Read(path)
} catch (e) {
    this.Status.Text = e.message   // "...: use Timer.After(delay, tick)"
}
```

## Why the existing words do not cover it

`reference_hint` (runtime/src/bta_runtime.c:728) reads the same table and adds
the sentence when the error is *reported* — on the way out to the terminal and
the dialog (:805) — because nothing is installed on the global object, so
`Application.Globals()` and the IDE's completion stay true. A caught error
never reaches that road, so `e.message` is the engine's sentence alone.
`Application.Replacements()` is a list of names and not the answer to it, and
carrying the sentence in `e.message` means the engine's own
`JS_ThrowReferenceErrorNotDefined` appends it: a nineteenth patch on the
vendored fork, which carries eighteen today, and the fork's push is the owner's.

## Prior art

TypeScript's "Property 'x' does not exist on type 'Y'. Did you mean 'z'?".
ESLint's `no-undef` reports a `suggestions` array; V8's own `ReferenceError`
carries no suggestion at all.

## How much it mattered

It works, but a part of it is noticeably worse: the hint that would have saved
the afternoon arrives exactly when it is not read.
