# The language

Modern JavaScript, with a curated set of intrinsics. Classes, template
literals, destructuring, spread, generators, `for...of`, arrow functions,
optional chaining, getters and setters, `Map`, `Set`, `Date`, `Math`, `JSON`,
`RegExp` and every ordinary object and array are all there and mean what they
mean everywhere.

What follows is the whole of the difference. Read it once; the rest of your
JavaScript knowledge transfers unchanged.

## There are no imports

Every class and function declared at the top level of any `.js` in the project
is visible from every other one. No `import`, no `export`, no `require`, no
module system, no bundler.

```js
/* Util.js */
function money(n) { return Locale.Currency(n, 2); }

/* MainForm.js — no import of any kind */
class MainForm extends Form {
    Form_Open() { this.Lbl.Text = money(19.9); }
}
```

Order matters in exactly one case: when a class extends another class of the
same project, the parent must be evaluated first. `sources` in `project.json`
fixes the order. See [forms.md](forms.md#projectjson).

A folder of classes can share a namespace, which is what lets two folders each
have a `Stepper`:

```js
/* widgets/Stepper.js */
Namespace("Widgets");
Widgets.Stepper = class Stepper extends Component { … };
```

A namespace is an ordinary object. `Namespace("A.B")` creates both levels.

## What is not installed

Not present at all, and referencing one is a `ReferenceError`:

`Promise`, `async`/`await` (they parse, but nothing runs them), `Proxy`,
`Reflect`, `ArrayBuffer` and the typed arrays, `WeakRef`, `atob`/`btoa`,
`performance`, `window`, `document`, `fetch`, `require`, `console`, `process`.

Two of those have a word here instead: bytes are
[`Bytes`](library.md#bytes) — one class, immutable, with `Slice`, `Concat` and
`Equals` — and base64 is `Bytes.FromBase64` / `ToBase64`, which is `atob`/`btoa`
without the string that is secretly bytes.

Removed once the runtime has booted, so they are gone before your code runs:

`eval`, `Function` (and `Function.prototype.constructor`, and the generator
function constructor), `globalThis`, `Symbol`, `setTimeout`, `setInterval`,
`clearTimeout`, `clearInterval`.

**`Object` is empty.** Every static is gone: `keys`, `values`, `entries`,
`assign`, `create`, `freeze`, `defineProperty`, `getPrototypeOf`, `hasOwn`,
`fromEntries`, `is`, `groupBy` — all of them. So is `__proto__` and the four
`__defineGetter__`-family hatches. `Object.prototype` stays, and the members
that *ask* about an object rather than rewrite it: `hasOwnProperty`,
`isPrototypeOf`, `propertyIsEnumerable`, `toString`, `valueOf`.

`String.prototype.localeCompare` **is** installed and is a trap: there is no
`Intl`, so it compares code units and puts `Álvarez` after `Zapata`. Use
`Locale.Compare`.

This is curation, not a sandbox: the application still holds every capability
the runtime gave it. It is a smaller language to learn, and a smaller one to
get wrong.

## Instead of, write

| instead of | write |
|---|---|
| `JSON.parse(File.Load(p))` | `File.LoadJson(p)` |
| `File.Save(p, JSON.stringify(v, null, 2))` | `File.SaveJson(p, v)` |
| `setTimeout(fn, ms)` | `Timer.After(ms, fn)` |
| `setInterval(fn, ms)` | `Timer.Every(ms, fn)` |
| `Object.keys(o)` | `Dictionary.Keys(o)` |
| `Object.keys(o).length` | `Dictionary.Count(o)` |
| `Object.entries(o)` | `Dictionary.Entries(o)` |
| `Object.values(o)` | `Dictionary.Values(o)` |
| `Object.assign(a, b)` | `{ ...a, ...b }` |
| `console.log` / `console.error` | `Logger.Info` / `Logger.Error`, or `print` |
| `new RegExp(p, "gi")` | `new Regex(p, { IgnoreCase: true })` |
| `s.replace(/x/g, y)` | `new Regex("x").Replace(s, y)` |
| `[...s.matchAll(re)]` | `re.Matches(s)` |
| `new Function(src)` | `Application.CheckSource(src)` |
| `Date.now()` deltas | `new Stopwatch()` |
| a date with no time | `Day` and `"YYYY-MM-DD"` — see [library.md](library.md#day) |
| a time with no date | `Time` and `"HH:MM"` — see [library.md](library.md#time) |
| `new Uint8Array(...)` | `Bytes`, and `File.LoadBytes` — see [library.md](library.md#bytes) |
| `atob` / `btoa` | `Bytes.FromBase64(t)` / `bytes.ToBase64()` |
| `a.localeCompare(b)` | `Locale.Compare(a, b)` |
| money in a `Number` | `new Decimal("19.99")` — see [library.md](library.md#decimal) |
| a bag of unchecked keys | a `Record` — see [library.md](library.md#record-and-field) |
| `element.style.color = …` | `Style`, and `app.css` — see [forms.md](forms.md#styles) |

`print(...)` writes a line to stdout, joining its arguments with a space. It is
what a console tool writes and what a test reports with.

## Reading a bag of properties

`for...in` recites, `Dictionary` counts:

```js
for (const key in settings) applyOne(key, settings[key]);
Dictionary.Keys(bag).sort()
Dictionary.Count(bag)
```

`for...in` is safe here — nothing can put anything on a prototype any more — and
it forgives an absent bag: reciting `undefined` is zero turns.

When the bag is going onto a control, do not write the loop at all:

```js
this.Btn.Apply({ Text: "Save", Width: 90, Enabled: false });
```

## There is no `await`, and what to write instead

This is a language of events. Every asynchronous thing in the runtime takes a
callback, and the callback runs on the main loop with the application fully
alive.

```js
/* wrong — nothing runs this */
async Btn_Click() { const path = await Dialog.OpenFile("Open"); }

/* right */
Btn_Click() {
    Dialog.OpenFile("Open", { Filters: [["Notes", "*.txt"]] },
        (path) => { this.Editor.Text = File.Load(path); this.path = path; });
}
```

A sequence is a chain, and the state it carries lives on the form:

```js
BtnBuild_Click() {
    this.BtnBuild.Enabled = false;
    Exec(["make", "-j4"], { Directory: this.dir },
         (line) => this.Log.Append(line + "\n"),
         (code) => {
             this.BtnBuild.Enabled = true;
             if (code === 0) this.deploy();          /* then this */
             else Message.Error("Build failed ({0})", code);
         });
}
```

Two exceptions worth knowing, both in [library.md](library.md):

- `Exec.Wait(argv)` runs a child to the end and returns a record. **It freezes
  the window.** Use it only for a tool you know ends quickly.
- A question that needs an answer is a form you write, with a static `ask`
  method taking a callback. See [forms.md](forms.md#a-dialog-that-asks-something).

## Uncaught errors are shown

A handler that throws does not stop the application: the error goes to stderr
*and* to a dialog with the stack. `Application.OnError = (message, stack) => …`
takes that over.

This means a throw is a legitimate way to refuse a bad value, and it is what
every setter in the runtime does. It also means you should not wrap every
handler in a `try` that swallows: a swallowed error is a button that silently
stopped working.

The one place to catch on purpose is a `Form_Open` in a **test** project: an
uncaught throw there aborts before `Application.Quit` is reached and the run
hangs instead of failing. See [validation.md](validation.md).

## Strict mode

`"use strict";` at the top of a `.js` is the habit in this repository, and it is
**redundant**: the runtime evaluates every source with `JS_EVAL_FLAG_STRICT`, so
your code is strict whether it says so or not. Measured with a file that carries
no pragma and assigns to an undeclared name -- it throws
`noDeclarada is not defined` rather than making a global. The habit is worth
keeping anyway, because it says out loud what the file is and it survives being
read outside this runtime.
