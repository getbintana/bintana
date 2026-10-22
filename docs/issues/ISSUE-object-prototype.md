# ISSUE: nothing stops a library from adding to `Object.prototype`

## What the application needed

A host that loads a plugin somebody else wrote, and a screen that reads a
client's record field by field. The concrete case was an invoicing application
that loads a PDF-import plugin: the plugin does `Object.prototype.currency = …`
the way polyfills do, and from then on the host's own `for (const key in row)`
recites `currency` beside the record's fields, so the total is wrong.

## What I wrote instead

Every enumeration in the application is written the careful way —
`for (const key of Dictionary.Keys(row))` — because `Dictionary` counts only
what an object holds and `for...in` recites. The protection is per-loop, so a
plugin that adds a property still breaks the one loop written the other way.

## The code I wish I could have written

```js
// the host, before it loads anything it did not write:
Application.ProtectPrototype()     // Object.prototype accepts no new name
```

## Why the existing words do not cover it

`Object.freeze` and `Object.seal` went with `Object` — the decided table in
docs/llm/issues.md lists "the rest of `Object`" as not coming, and with them
went `Object.preventExtensions`, which is the tool that was wanted: its own row
in the replacements table says there is no word for that thing in this
language. The answer written down says the tool belongs in C
(docs/plans/strict-plan.md): `bintana --strict` makes a control refuse a
property its class does not have — a widget, and only under a flag of the run.

## Prior art

`Object.freeze(Object.prototype)`, and `Object.preventExtensions(Object.prototype)`
where it is only that one call. ESLint's `no-extend-native` rule refuses the
write at lint time; TypeScript's `noImplicitAny` does not cover it. Gambas and
VB6 have no `Object.prototype` at all.

## How much it mattered

It works and this would only have been tidier — and then a plugin that adds a
property to the prototype breaks every `for...in` in the host.
