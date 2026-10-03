# ISSUE: a runtime global shadows a project's own class of the same name

Found by adding the global `Probe` — and it is not about that name. Every one of
the runtime's globals is this trap, and two fixtures in `tests/widgets` were
already living on it.

## What the application needs

A class it wrote. `Probe.java`... `Probe.js`:

```js
class Probe extends Form { Form_Open() { ... } }
```

with `project.json` saying `{"startup": "Probe"}`. It works until the runtime
installs a global called `Probe`, and then it does not start at all.

## What happens

```
$ bintana <project>
bintana: startup class 'Probe' not found
```

The class is there, loaded, and evaluated. The lookup never asks.

## Why

`bta_lookup_global` (`runtime/src/bta_runtime.c`) resolves a class name **from
the global object first** and only falls back to `JS_Eval` — the lexical scope
where a top-level `class` declaration actually lives — when the global has
nothing by that name:

```c
    if (!JS_IsUndefined(v) || qualified)
        return v;                 /* the global object won */
    JS_FreeValue(ctx, v);
    return JS_Eval(ctx, name, strlen(name), "<class-lookup>", JS_EVAL_TYPE_GLOBAL);
```

So any installed global beats the project's own declaration, which is the
**opposite** of what the rest of this runtime already does and says:

- `Widget.New` consults **the class table first**, and the project's own second
  ("The runtime's classes first, then the project's own, which live in the global
  lexical scope");
- the IDE's completion is built the other way on purpose — "**a class the sources
  declare wins over a class of the same name in the runtime**", because in a
  program that uses that library the library's is the class being written.

So two of the three places that answer "which class is this name" put the
project's own first and this one puts it last, and the third is the one a program
stops at.

The global object is also the wrong thing to ask first on its own terms: a
top-level `class` is a **lexical binding**, not a property of `globalThis`, so
the two are not two answers to one question — and plain JavaScript resolves them
the other way round, where a lexical declaration shadows a global.

## Which names

Every installed global: `Application`, `Bytes`, `Clipboard`, `Connection`,
`Database`, `Day`, `Decimal`, `Desktop`, `Dialog`, `Directory`, `Environment`,
`Exec`, `File`, `Gzip`, `Hash`, `Http`, `Locale`, `Lock`, `Logger`, `Message`,
`Multipart`, `Notification`, `Painter`, `Printer`, `Probe`, `Random`, `Screen`,
`Stat`, `Task`, `Text`, `Time`, `Xml`, `Zip` — and the ones the prelude adds.
`Timer` is the one a project is most likely to reach for, and it has been there
the longest.

Two `tests/widgets` fixtures had a class called `Probe` and both failed the
moment `Probe` was installed; they are `Showcase` and `Slab` now, which is the
half of the answer a test can give on its own. **The other half is a project
whose class is called `Timer`, `File`, `Text`, `Field`, `Record` or `Dialog`,
which stops starting and says nothing about why** — `startup class 'X' not found`
names the class and stops.

## What the fix looks like

Ask the lexical scope before the global object, or — the more careful half —
ask the class table, then the project's own declarations, then the global object,
and have all three places that resolve a class name share it. That last part is
the point: **three answers to "which class is this name" is the bug**, and the
one that is wrong is the one a program cannot work around.

## How much it mattered

Low for the two fixtures (a rename), high for the shape: it is a silent,
load-time failure with a message that points at the class rather than at the
collision, and it is triggered by the runtime growing — not by anything the
project did.