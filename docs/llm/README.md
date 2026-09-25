# Writing a Bintana application

This directory is the **public contract**: everything needed to write a complete,
working Bintana application, and nothing about how the runtime is built.

It is addressed to whoever is writing the application **without the IDE** — a
language model, or a person writing every file by hand. If you are a model and
someone has asked you for a Bintana application, these eleven files are what you
need and the only thing you should be reading. If you are a person at the IDE,
start at [first-app.md](../first-app.md) instead.

| Read | For |
|---|---|
| [language.md](language.md) | What the language is, what is not in it, and the idiom to write instead |
| [forms.md](forms.md) | The project, the `.form` file, events, layout, menus, components |
| [controls.md](controls.md) | **The complete reference**: every class, and every property, method and event it has — with signatures, defaults and accepted values. Checked by `tests/api.sh`, so it cannot fall behind the runtime |
| [library.md](library.md) | **Every global**: files, processes, dialogs, settings, dates, money, text. Checked by `tests/api.sh` as well, so it cannot fall behind either |
| [validation.md](validation.md) | How to prove what you wrote works, without a screen and without asking |
| [charts.md](charts.md) | **One of the five libraries that ship with the runtime**: `uses: ["charts"]`, and everything the `Chart` component takes |
| [report.md](report.md) | **The second**: `uses: ["report"]`, and everything the banded `Report` component takes — bands, groups, totals, pages |
| [markdown.md](markdown.md) | **The third**: `uses: ["markdown"]`, and everything the `Markdown` viewer takes — what it reads, how it scrolls, and the document out as a PDF |
| [qr.md](qr.md) | **The fourth**: `uses: ["qr"]`, the QR encoder and the component that shows one — any text, as modules; a PNG, an SVG or a page |
| [package.md](package.md) | **The fifth**: `uses: ["package"]`, for an application that is installed — its metainfo, its menu entry and the Flatpak manifest |
| [issues.md](issues.md) | What to do when the runtime is missing something you need |

The technical documentation — the C/JS split, per-widget internals, how to add a
widget — is one level up in [`docs/`](../README.md) and is **not** part of this
contract. You do not need it and should not write against it.

## The shape of the thing

A Bintana application is a directory. Nothing is compiled, nothing is
generated, there is no build step, no package manager and no imports.

```
myapp/
  project.json      what to run, and in which order to load the code
  MainForm.form     the window: a widget tree, in JSON
  MainForm.js       its behaviour: one class, methods named <Control>_<Event>
  app.css           optional: the application's own look
  icons/            optional: the application's own icons
  po/               optional: es.po, pt_BR.po — the translations
```

```sh
./build/bintana myapp                  # run it
tests/try.sh myapp                 # run it without putting a window on anyone's screen
```

## The five rules

**1. The layout is declared, not built.** Position, size, caption, alignment and
style belong in the `.form`. A `.js` file that creates controls, sets `X`/`Y` or
assigns captions is doing the `.form`'s job. Build from code only what is not
known until it runs — the rows of a table, the entries of a list.

**2. A handler is a method named after what raises it.** `Button1_Click`,
`TextBox1_Change`, `Form_Open`. Nothing is registered, nothing is connected,
there is no `addEventListener`. The name *is* the wiring.

**3. Nothing blocks.** There is no `Promise`, no `await`, no modal `MsgBox` that
returns an answer. A question is a form; an answer arrives in a callback. Write
sequences as callbacks and you are writing idiomatic Bintana; reach for
`async` and nothing will run.

**4. Where the runtime has a word, use it.** `File.LoadJson`, not
`JSON.parse(File.Load(…))`. `Timer.After`, not `setTimeout` (which is not
there). `Dictionary.Keys`, not `Object.keys` (which is not there either). The
list is in [language.md](language.md#instead-of-write) and it is short.

**5. Text a person reads goes through the catalogue.** Captions declared in a
`.form` are translated with nothing asked. Text built while the program runs
goes through `Locale.Text("Hello {0}", name)` — **never** a template literal in
that position, because a filled-in string can never match a catalogue entry.

## Before you hand the work over

Run the checklist in [validation.md](validation.md). It is short, it needs no
screen, and it catches the whole class of mistake that otherwise reaches the
person who asked: a `.form` that does not parse, a handler wired to a control
that was renamed, an icon this desktop does not have, a style class no theme
defines, a caption that can never be translated.

Report what you actually ran and what it said. "It should work" is not a result.

## If something is missing

Do not invent it, and do not build a scaffold around its absence. Write an
ISSUE: what the application needed, what you tried, and the code you wish you
could have written. [issues.md](issues.md) has the form and the rules — the most
important of which is that you describe **what is missing, never how to add
it**. How is not yours to decide and a guess at it makes the issue harder to
answer, not easier.
