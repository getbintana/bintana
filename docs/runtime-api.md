# Runtime API

Everything here is a global, ambient and always present — the Gambas bargain: no
imports, no module system, no `require`.

## The language underneath

A project does not get all of JavaScript. The context is built from chosen
intrinsics (`build_context()`), and the ways back into the raw language are shut
once `rad.js` has run (`close_hatches()`).

**Never installed**, because no Bintana code has ever used them: `Promise`,
`Proxy`, `Reflect`, the typed arrays and `ArrayBuffer`, `WeakRef`, `atob`/`btoa`,
`performance`. `Promise` is the deliberate one — this is a language of events, not
of continuations, and leaving it out makes that a fact instead of advice.
`async` and `await` are therefore **refused by the compiler**, with a
`SyntaxError` on the word itself: the engine registers its async classes only
alongside `Promise`, so one that merely parsed left an object nothing could
collect and a process that could not close. What a sequence is written with
instead, and what would make that answer change, is
[plans/async-plan.md](plans/async-plan.md).

**Removed after boot**: `eval`, `Function`, `globalThis`, `Symbol`, the
scheduling primitives `setTimeout` / `setInterval` / their `clear` pair, and the
forward-only clock they are scheduled on — which is published as
[`Stopwatch`](#stopwatch), because a single reading of it counts from the
machine's boot and means nothing on its own. **`queueMicrotask` goes with
them**, for the sentence the pair went for: scheduling with no name of ours, no
switch and no handle. It worked — `bta_drain_jobs` pumps the job queue after
every event handler — and that is why it was worth removing rather than
leaving, since a second undocumented way to defer is the thing `Timer` exists to
prevent. `escape` / `unescape` go too: an Annex B URL encoding no standard
recommends, with no caller here. And with
them the roads that need no name: `Function.prototype.constructor` and the
generator function constructor both compiled strings, so both are unhooked. What
is left in their place is `Application.CheckSource`, which answers the one honest
question — *would this text compile?* — without running it.

**`Object` is empty.** Every static it carries in JavaScript is gone —
`create`, `getPrototypeOf`, `setPrototypeOf`, `defineProperty`,
`defineProperties`, `getOwnPropertyNames`, `getOwnPropertyDescriptor`,
`getOwnPropertyDescriptors`, `getOwnPropertySymbols`, `keys`, `values`,
`entries`, `hasOwn`, `fromEntries`, `assign`, `groupBy`, `is`, `freeze`,
`isFrozen`, `seal`, `isSealed`, `preventExtensions`, `isExtensible` — and with
them `__proto__` and the four accessor hatches every object carried on the
prototype: `__defineGetter__`, `__defineSetter__`, `__lookupGetter__`,
`__lookupSetter__`. `Object.prototype` itself stays, because it cannot be taken
and `rad.js` walks the chain up to it, and so do the members that *ask* about an
object rather than rewrite it: `hasOwnProperty`, `isPrototypeOf`,
`propertyIsEnumerable`, `toString` and `valueOf`.

What answers instead: what a control can be asked for is
`Widget.PropertyNames()`; what a plain object holds is
[`Dictionary`](#dictionary); a property is declared with `get` / `set` in a
class, which is also how the designer finds it; an object is made with `{}` or
`new`, its class saying what it inherits; and two bags are merged with
`{ ...a, ...b }`, which is syntax and was never `Object.assign`'s to lend.

**Emptied rather than trimmed, because trimming it was wrong twice.** The first
pass took the singulars and left the *plurals*: `defineProperties` went on
writing the accessors `defineProperty` had been removed to withhold, and
`getOwnPropertyDescriptors` read what its singular no longer could — between them
enough to replace the setter on a `Record`'s field with one that validates
nothing, which [architecture.md](architecture.md) said an application could not
do. The same capability was also spelled on the prototype, in the four `__*__`
names, where every object in the program carried it.

A list of what to keep is a list somebody has to get right again every time the
engine grows a member, and quickjs-ng grew `groupBy` and `hasOwn` after the first
list was written. So the rule runs the other way: **nothing is there, and an
equivalent is published when something actually needs one.** Nothing in this
repository called any of these but `keys`.

### Reading a dictionary

`for...in` to recite one, and nothing around it:

```js
for (const key in settings) applyOne(key, settings[key]);
```

In JavaScript this is a footgun, because an object can inherit enumerable
properties from its prototype. Here it cannot: `Object.create`,
`setPrototypeOf` and `__proto__` are all gone, so a plain object holds what was
put in it and nothing else. Reciting also forgives an absent bag — `for...in`
over nothing is zero turns — so no guard is needed for a dictionary that is not
there yet.

`Dictionary` is the other half, for when an *array* of names is what comes next:

```js
Dictionary.Keys(bag).sort()          // an order somebody chose
Dictionary.Count(bag)                // how many
new Set(Dictionary.Keys(node.properties))
```

That is the whole rule: **`for...in` recites, `Dictionary` counts.** Writing
`for (const key of Dictionary.Keys(o))` says the same thing twice.

Better still, when the bag is going onto a control, do not write the loop at
all:

```js
button.Apply({ Text: "Save", Width: 90, Enabled: false });
```

`Apply` is the inverse of `Serialize`, which is how a `.form` round-trips; it
returns the control, and a missing dictionary applies nothing, so a caller never
has to check.

Deleting a global takes away the *name*, not what it reached: `rad.js` captured
the global object before it went, which is how `Namespace()` still publishes.
That is also the pattern for anything else that needs a captured reference.

**Still there**, because the language is made of them: `JSON` (a `.form` is
JSON), `Map`/`Set`, `Date`, `Math`, generators, and every ordinary object and
array.

**`RegExp` is not.** `/x/g` is syntax and still produces one whatever the global
is called — `.test`, `.exec` and `String.replace` all work, and a fixed pattern
is well written as a literal — so what was removed is `new RegExp(p, flags)`: the
engine reached from a string. A pattern built at run time has one spelling, and
it is [`Regex`](#regex), which captured the constructor before the name went.
`RegExp.prototype.constructor` went with it, or `(/(?:)/).constructor` would hand
the function straight back; that read now falls through to `Object`, which cannot
make a pattern. The `u` that `new RegExp(p, "u")` used to reach is
`{ Unicode: true }` here, and the other flag only this word has is
`{ IgnorePatternWhitespace: true }`.

**One that was installed and is now refused: `String.prototype.localeCompare`.**
There is no `Intl` — QuickJS is built without ICU — so a comparison with no
collator fell back to comparing code units, and `"Álvarez".localeCompare("Zapata")`
was `1`. It read like the thing that puts a list of names in order and was a
codepoint sort wearing the name, **answering exactly what no comparator at all
answers** — which is worse than not having it, so it is not had. `rad.js`
replaces it with a refusal that names the alternative, on both sides, since a
worker evaluates that file too.
[`Locale.Compare`](#ordering-names-and-finding-one) is the one that asks the
desktop, and `Locale.Matches` is its half for a search field.

`Symbol` is **not** among them: it went with the reflection above, in the same
list. Generators are unaffected, since iterating one never needed the name.

This is **curation, not a sandbox**. A project still holds every capability the
runtime handed it, and `Terminal.Run` is `Exec` by another name. What it buys is
a smaller language to learn and to keep promises about. For real confinement the
boundary is the process: the IDE already runs a project as a child.

## Application

| Member | |
|---|---|
| `Name` | from `project.json` |
| `Version` | what the project calls its own release, from `project.json`; `""` when it declares none. **Not the runtime's**, which is `BTA_VERSION` |
| `Directory` | the project directory, absolute |
| `ConfigDirectory` | `~/.config/bintana/<name>`, **created at startup** |
| `Executable` | the `bintana` binary, from `/proc/self/exe`, so a project can re-invoke it |
| `Arguments` | whatever followed the project directory on the command line |
| `HasIcon(name)` | whether that icon will actually draw something |
| `HasCommand(name)` | whether that program is on the PATH — `Exec` throws when it is not, so this is the question that does not need an exception |
| `Icons([contains])` | every icon name the search path offers, sorted; narrowed by substring |
| `DecorationLayout` | how this desktop arranges a window's title bar — `"icon,menu:minimize,maximize,close"` |
| `CheckSource(text)` | `null` if the text is valid JavaScript, otherwise `{ Message, Line, Column }` |
| `LibraryPath(name, [project])` | where a library by that name is, or `""`. The same six-place search `uses` does — published so a tool that opens *other* projects asks about theirs instead of keeping a second copy of the path, since two implementations of one lookup drift and the one that drifts is the one nobody runs from a shell |
| `Libraries([project])` | the names of every library those six places offer, sorted and deduplicated — a name found twice is the one nearest the project, which is the one `uses` would load. The other direction of the same lookup: one resolves a name, the other says which names there are, which is what an IDE offering them to tick had no way to ask |
| `OnError` | assign `(message, stack) => …` to take over uncaught errors — **two strings, not the `Error`**: see below |
| `Quit(code)` | quits the main loop with that exit status |

**Two versions, and they are two questions.** `Application.Version` is the
application's, out of its own `project.json`; `BTA_VERSION` is the runtime's, out
of the one place it is declared — `project()` in `CMakeLists.txt`. Every program
that shows a version had nowhere to read its own from and had to write it down a
second time in its own source, which is the copy that goes stale; the IDE's own
About box printed the runtime's number in both roles until there was a field to
read. `BTA_VERSION` was itself a literal in `rad.js` while `project()` carried no
version at all, so the two could differ and nothing would ever say so.

A project that declares none answers `""`. Absent is an ordinary state, not a
fault — every project written before the key existed is in it.

**`HasIcon`** is not "does the theme list it" but "will it draw", and there are
two ways an icon name can fail that. It can be missing, and come back as the
theme's own `image-missing`. Or it can resolve to an SVG that renders to nothing
— art placed outside the frame with no `viewBox` to bring it back — which is why
the answer is decided by drawing the icon on a 16×16 square and looking for ink.
`Button.Icon`, `Image.Icon` and a `TreeView` node's icon all drop what `HasIcon`
refuses, so an icon-only control comes out empty rather than showing the
broken-image glyph.

**The runtime resolves an icon itself rather than handing GTK a name**, and the
reason is a crash. `gtk_image_set_from_icon_name` looks the icon up with
`GTK_ICON_LOOKUP_PRELOAD`, which puts the SVG's rasterisation on a thread pool; an
SVG containing `<text>` is laid out there with pango, which builds its per-font
caches lazily and unlocked; and two such icons rasterised at the same time race,
one thread finding the other's half-built cache. A SIGSEGV in
`_pango_cairo_font_private_get_scaled_font`, under a stack that is entirely GTK's
(`load_icon_thread` → `svg_to_texture` → `fill_text`), on GTK 4.22.4 with pango
1.57.1. Forty lines of plain GTK, with no Bintana in the process, reproduce it:
nine such icons shown at once crash every run.

That shape of file is not rare — `elementary-xfce` ships `window-minimize-symbolic`
and `window-maximize-symbolic` with an editor's leftovers inside, empty `<text>`
nodes holding a single space at coordinates far outside the frame. They draw
nothing, the icons are perfectly good, and the IDE puts them on the title bar over
the form being designed.

So `bta_image_set_icon` looks every icon up with `gtk_icon_theme_lookup_icon` and
no `PRELOAD`, and hands the widget the paintable: the SVG is rasterised where it
is drawn, on the main thread, with nothing to race against. The same nine icons
survive every run. There is no list of bad names and nothing sniffs the file —
one road for every icon, which is the only kind that cannot be got wrong. What a
paintable does not do for free is follow the desktop, so the name is kept on the
widget and asked for again when the scale factor moves or the icon theme changes.

**`CheckSource`** answers with a record and not a string, and the caller that
settles it is an editor: an editor wants to put the complaint *on the line it is
about*. The position is the compiler's own, picked out of the frame this call
named (`<check>`) in the exception's stack -- not parsed back out of English
prose, which would be a small language inside a value and is the shape this
project refuses everywhere else. A text with no position leaves both at `0`, which
is an honest *it does not say* rather than a line 1 nobody chose. `null` is as
falsy as the `""` it replaces, so `if (bad)` reads the same as it always did.

**`DecorationLayout`** is the desktop's `gtk-decoration-layout`: what goes at the
start of a title bar, a colon, what goes at the end. The window manager reads the
same setting, so it is the one place that says where *this* desktop puts the close
button — and a guess would be wrong on half the desktops there are. It is for
anything drawing a title bar of its own; the IDE's preview of the form being
designed is the case that asked for it, and [`ide.md`](ide.md) has what it does
with the answer. Read once at startup, since a desktop that rearranges its buttons
mid-session is not worth a signal.

**`ConfigDirectory`** exists so saving a setting is one `File.Save` and no
ceremony. Being named after the project, two projects never read each other's
settings — which is also why the test projects cannot touch the IDE's recent
list. What everybody was going to write in it has a name of its own:
[`Settings`](#settings).

**`Executable` plus `Arguments`** is how the IDE runs a project: it spawns itself
with the project directory as the argument, through
[`Exec`](llm/library.md#exec), and shows what it printed in a read-only
`TextEditor`. It ran in a `Terminal` until that was measured: nothing on the way
used the pty — no typing, no colour, no `less` — and the pane was a *log*, not a
console. The terminal is still there, in a tab of its own, for the things that
really are interactive.

**Uncaught errors.** A handler that throws does not stop the application, and
until it was reported that meant a button that silently stopped working. Every
uncaught error now goes to stderr *and* to the user: `Application.OnError` if the
application set one, otherwise a dialog with the message and the stack.

One at a time: the dialog is raised with `choose()` so the runtime is told when it
is dismissed, which is what keeps a handler that throws on every timer tick from
stacking dialogs forever. An error raised *inside* `OnError` only reaches the
terminal — the guard is still up, so it cannot come back around.

**What the handler gets is two strings, and not the `Error`.** That is worth
saying because the obvious guess is the other one: the name is gone, so a
`TypeError` and a `RangeError` arrive indistinguishable, and there is no object
to re-throw. It is enough to log and enough to show, which is what it was built
for — a handler that wanted to branch on the kind of failure would have to match
on the message, which is the shape this language refuses everywhere else. If you
need the kind, catch it where it is raised.

**`Bintana error:` is red only on a terminal.** It was red unconditionally, which
was true and invisible for as long as the only thing reading it down a pipe was a
VTE that ate the escapes. The IDE's output pane stopped being one, and six
characters appeared in front of every traceback — and the same six are in a
redirected log, in a CI capture and in anything that runs a project with `Exec`,
which is where most tracebacks are actually read. `isatty(stderr)` is asked once
and the sequences are empty strings when the answer is no; `tests/widgets` runs a
child that throws and asserts its output carries none.

### Simplified over raw

Where a low-level primitive and a Bintana way of doing the same thing both
exist, the Bintana one is the published API and the primitive is the thing it
was built to replace. Some of the left column is no longer installed at all —
`setTimeout`, `Function` and the `Object` statics are gone, and the row is there
because it names the idiom somebody arrives with:

| instead of | write |
|---|---|
| `JSON.parse(File.Load(p))` | `File.LoadJson(p)` |
| `File.Save(p, JSON.stringify(v, null, 2) + "\n")` | `File.SaveJson(p, v)` |
| `setTimeout(fn, ms)` | `Timer.After(ms, fn)` |
| `setInterval(fn, ms)` | `Timer.Every(ms, fn)` |
| `new RegExp(p, "gi")` | `new Regex(p, { IgnoreCase: true })` |
| `new RegExp(p, "u")` | `new Regex(p, { Unicode: true })` |
| `[...s.matchAll(re)]` | `re.Matches(s)` |
| `s.replace(/x/g, y)` | `re.Replace(s, y)` |
| `Object.keys(o)` | `Dictionary.Keys(o)` |
| `Object.keys(o \|\| {}).length` | `Dictionary.Count(o)` |
| `Object.entries(o)` | `Dictionary.Entries(o)` |
| `console.log` / `console.error` | `Logger.Info` / `Logger.Error` |
| `new Function(src)` | `Application.CheckSource(src)` |

`File.SaveJson` writes one canonical shape — indented by two, one trailing
newline — so the choice never comes up and every file the runtime writes reads
the same. `File.LoadJson` names the file in its error, which a bare
`SyntaxError` never did.

`Timer.After` and `Timer.Every` hand the `Timer` back, so what was started can
still be stopped; a bare timer id could not be without keeping it somewhere. The
IDE and the tests use these throughout, which is how we know they are enough.

### The one thing `eval` is still missing from, and the shape its answer has to take

Everything the IDE's completion offers is a lookup against something already
known -- a `.form` says what `Btn1` is, `PropertyNames()` says what a `Button`
has. The moment a completion wants to answer *what is this expression?* --
`const x = makeThing(); x.` -- it needs something that can evaluate, and that is
the one capability this language removed on purpose.

**The decision on record: something eval-like is acceptable, but only as part of
the language** -- with names and functions that belong to it -- **and not as a
JavaScript interpreter handed to the caller.** Which rules out the easy answer
(`eval` under another name) and points at a narrower one:

- **A resolver, not an evaluator.** The question actually being asked is *what
  class is this thing?*, not *what does this code do*. A named function that
  answers only that -- walking a path of identifiers against the form and the
  runtime's own tables -- evaluates nothing: it cannot call, cannot assign, cannot
  loop, and reaches nothing the caller did not already have.
- **Where it stops is where the language stops.** A path of identifiers and
  property names resolves; a call does not. `Application.CheckSource` is the
  precedent for the shape -- it answers one honest question about text (*would
  this compile?*) without running it, and it exists precisely so that
  `new Function` did not have to.
- **What it must not become** is a way to run project code from a keystroke. A
  completion popover fires while the user types, so anything reachable from it
  runs on every character. That rules out evaluation however it is spelled.

It is not built, and nothing in the tree waits on it: the four completions worth
having need none of it (see [ide.md](ide.md#what-the-editor-proposes)).
## Environment

The context a program was started in: its environment, its directory, and the few
facts about the machine that a program *acts on* rather than displays.

| Member | |
|---|---|
| `Get(name)` | what the environment says, or `null` |
| `Set(name, value)` | set it for this process **and everything it starts afterwards**; `null` removes |
| `Variables` | every name at once, as a plain object — a fresh copy, since `Set` moves underneath it |
| `CurrentDirectory` | where the process is; assigning enters, and a directory that is not there **throws** |
| `HasDisplay` | whether this *environment* offers one — `DISPLAY` or `WAYLAND_DISPLAY`, and always `true` on Windows, where a session has one and no variable says so |
| `ProcessId` | the pid |
| `ProcessorCount` | how wide to build; the one number `-j` wants |
| `HomeDirectory`, `TempDirectory` | named like `CurrentDirectory`, and unlike it they do not move |
| `UserName`, `HostName` | who and where |
| `OS`, `OSVersion` | `"Linux"` and the kernel release |

One object and not a member here and a member there, because they are one subject
and they are asked together: a runner reads `DISPLAY`, decides on `HasDisplay`,
names a scratch directory after `ProcessId` and builds with `ProcessorCount`.
Those were four different shell builtins and are one class.

What is deliberately **not** here: the command line, which is `Application.Arguments`
because it belongs to the application rather than to the system, and quitting,
which is `Application.Quit` for the same reason.

**`HasDisplay` is about the environment, not about this process.** A console
project has no display of its own by construction, and the child it is about to
start may have a perfectly good one — so the question it answers is *would
something started from here find a screen*, which is the only version of it worth
asking. A runner that finds neither variable is the runner that reaches for Xvfb.

**`Set` is `export`, and `Exec`'s `Environment` is usually what you want instead.** This
changes the environment of everything started from here on, which is right for a
setting that belongs to the whole run — `GSK_RENDERER` for a suite, say. For one
child, `Exec(argv, { Environment: { ... } })` says what it changes and for whom.

**Assigning `CurrentDirectory` refuses rather than ignores.** A directory that was
never entered leaves every relative path after it pointing somewhere else, and
that shows up three calls later in whatever tried to read a file.

## Desktop

The session a program is running in — the XDG directories — and
`Desktop.Entries`, the module that reads and writes the `.desktop` files of the
user's own applications directory. It is in `bta_desktop.c`.

| Member | |
|---|---|
| `DataDirectory` | `$XDG_DATA_HOME`, or `~/.local/share` |
| `ConfigDirectory` | `$XDG_CONFIG_HOME`, or `~/.config` |
| `CacheDirectory` | `$XDG_CACHE_HOME`, or `~/.cache` |
| `Entries` | the module below |

```js
Desktop.Entries.Directory              // <DataDirectory>/applications, created
Desktop.Entries.Installed()            // ids, sorted
Desktop.Entries.Read(id)               // the entry as data, or null
Desktop.Entries.Install(id, entry)     // writes Directory/<id>.desktop, atomically
Desktop.Entries.Uninstall(id)          // removes it; false when it was not there
Desktop.Entries.Exec(argv)             // the Exec= value for that command
```

**The directories are GLib's answer and not a guess**: `g_get_user_data_dir` and
its two siblings read the XDG variables and fall back to the home directory, so a
machine that moved its data home is followed rather than ignored. `Desktop`
answers them; it creates none of them but `Entries.Directory`, which is made on
first use because an entry has to go somewhere.

**The entry format is `GKeyFile`'s**, which is the platform's implementation of
the Desktop Entry Specification and the same reader the desktop's own menu is
built on. `Read` answers `{ group: { key: value } }` with the values unescaped,
localized keys (`Name[es]`) included as the ordinary keys they are; comments and
blank lines are not modelled and do not survive a rewrite, because this is for
the entries a program installs and removes and not for editing a packager's file.
An id is the file's name without `.desktop`, restricted to letters, digits, `-`,
`_` and `.`: a separator would be a path out of the directory this owns.

**`Install` refuses what the desktop would ignore in silence.** No
`[Desktop Entry]` group, no `Type` or no `Name`, or an `Application` with no
`Exec`, and the call throws naming what is missing rather than writing a file
that would leave the user with a menu item that is not there and nothing to read.
The write goes through `g_file_set_contents`, the same temporary-and-rename
promise `File.Save` makes.

**`Exec(argv)` is a verb because the string is three escaping rules deep.** The
desktop entry's own quoting (double quotes; `"`, `` ` ``, `$`, `\` escaped inside
them; `%` doubled as the field-code marker) sits on top of the key file's
escaping, which doubles the backslashes again in the file. Measured against
`gio launch` and `desktop-file-validate`: an argument carrying a space, a quote,
a dollar, a backslash, a percent or an accent comes back out exactly as it went
in. `docs/installing.md` has the system install this is the per-user half of.

## Locale

Translation from the project's own `po/<lang>.po`, and how the desktop spells a
value. See [resources.md](resources.md) for the whole design; this is the
surface.

```js
Locale.Text("Saved in {0}", this.path)
Locale.Plural("{0} file", "{0} files", n)      /* n also fills {0} */
Locale.Context("verb", "Open")                 /* the word that has two senses */
Locale.Current = "es"                          /* read and write; "" for none */
Locale.Available                               /* every po/*.po the project ships */
```

| | |
|---|---|
| `Text(msgid, ...args)` | the catalogue's version, `{0}` filled in; the msgid itself when there is no entry |
| `Plural(one, many, n, ...args)` | the form `n` takes by the catalogue's own `Plural-Forms` rule |
| `Context(ctxt, msgid, ...args)` | gettext's `msgctxt`: the context is part of the key and is never shown |
| `Read(path)` | a catalogue as data, **losing nothing** — every comment, flag and `#~` block, so it can be written back |
| `Current` | the catalogue in use, `""` for none. Assigning reloads and **only affects what is built afterwards** |
| `Available` | the catalogue names, sorted |
| `Number(value, [decimals])` | grouped, with the desktop's separators |
| `Date(when, [format])` | the desktop's date — `"Date"`, `"Time"`, `"DateTime"`, `"ISO"`, `"Weekday"`, `"Month"` |
| `Currency(value, [decimals])` | money, with the symbol on the side this desktop puts it |
| `Compare(a, b)` | `-1`, `0` or `1`, in the order this desktop puts names in |
| `Matches(text, needle)` | whether a search for `needle` should find `text`, accents folded |
| `DecimalPoint` | the character this desktop writes a decimal with |

**The msgid is the text itself**, in whatever language the project is written in,
so an application with no catalogue is a working one. `{0}` is positional because
a translator has to be able to reorder the holes.

**Most text needs none of this.** A `.form`'s prose goes through the catalogue on
the way in, and the first argument of `Message.Info`/`Warning`/`Error` is a
declared position too — so a message takes its own arguments and needs no helper:

```js
Message.Error("Cannot open {0}: {1}", path, e.message);
```

A template literal in any of those positions is the one mistake worth knowing
about: the msgid arrives already filled in, so no catalogue can match it and
nothing says so at runtime. The IDE's extractor reports it.

### Writing a number and a date

```js
Locale.Number(1234567.891)        // 1.234.567,891   — as many decimals as it has
Locale.Number(1234567.891, 2)     // 1.234.567,89
Locale.Number(3)                  // 3               — never "3,00"
Locale.Date(new Date())           // 31/08/26
Locale.Date(customer.Since)       // a Field.Date holds "YYYY-MM-DD"
Locale.Date(when, "DateTime")     // lun 31 ago 2026 14:05:09
Locale.Date(when, "ISO")          // 2026-08-31T14:05:09-03
```

**`Locale.Current` and these two are different settings, deliberately.**
`Current` picks which `.po` the project's prose comes from; `Number` and `Date`
follow the C locale, which is the desktop's own `LANG`. A Spanish speaker on a
German desktop wants Spanish words and German numbers — two decisions, so two
settings. It is the same reason `Application.DecorationLayout` reads the
desktop's answer instead of one of ours, and the same reason `File.Info`'s `Type`
is a content type rather than GIO's description: what the desktop translates is
not this runtime's to overrule.

The runtime calls `setlocale(LC_ALL, "")` at startup so both kinds of project
agree. GTK does it too, which is why nothing needed it until now — and why a
**console** project used to get the C locale and spell a date `08/31/26` with
English month names on a Spanish desktop.

**Numbers.** With no `decimals`, as many as the value actually has, up to six: `3`
is `"3"` and not `"3,00"`, and `19.99` is `"19,99"` and not `"19,990000"`. The
grouping is POSIX's `%'`, which reads the locale's own grouping rule rather than
assuming three — some locales group by four, and India groups the first three and
then by twos. `NaN`, an infinity, and more than twenty decimals are **refused**:
`Locale.Number(0/0)` is a bug in the caller, and `"nan"` in a label says nothing
to whoever reads it. That is the bargain `Field.Number` already makes.

**Dates take three shapes**, and the middle one is the reason: a `Date`, a count
of milliseconds, or `"YYYY-MM-DD"` — which is what a `Field.Date` *holds*, so
`Locale.Date(customer.Since)` is the call this exists for and a version taking
only a `Date` would miss its own customer. A date with no time is read as local
midnight, which is what a date written without one means.

**Six formats, and they are the ones the locale itself defines**: `"Date"`
(the default), `"Time"`, `"DateTime"`, and `"ISO"` — which is the one that is
*not* the desktop's, because a date going into a file is not prose — plus
`"Weekday"` and `"Month"`, which are single fields rather than whole spellings. A
name that is not one of them is refused with the list, as every enum here is.

**There is still no `"Long"`, and the two fields are why.** glibc carries no
long-date pattern, and assembling `%A %d %B %Y` reads *"lunes 31 agosto 2026"* in
Spanish — missing the connector words a person writes, which differ per language
and are a **catalogue** and not a format. So the two fields the locale does define
are handed out, and the sentence is a msgid:

```js
Locale.Text("{0}, {1} {2} {3}", Locale.Date(d, "Weekday"),
            Number(d.slice(8, 10)), Locale.Date(d, "Month"), d.slice(0, 4))
```

whose msgid reads *Sunday, 8 March 2026* and whose `es.po` says
`"{0} {1} de {2} de {3}"` — reordering it and putting in the two *de* that only a
translator knows about. That is the bargain `{0}` makes everywhere else here, and
it is why these are fields and not a fifth whole spelling.
[`examples/agenda`](../examples/agenda) is that one line of catalogue, running.

Slicing the ISO text for the day number and the year is reading a field of a
fixed format, not parsing a date: those two are digits, and the parts that differ
per desktop — the names — are the ones that went through `Locale`.

**Currency puts the symbol where this desktop puts it**, which is the part
nobody guesses right: Argentina writes `$ 1.234,56`, Germany `1.234,56 €`, the
United States `$1,234.56`. `localeconv` knows the symbol, how many places the
currency uses, which side it goes on and whether a space separates them, and a
program that concatenated a symbol would be wrong in two of those three.

```js
Locale.Currency(new Decimal("1234567.891"))     // $ 1.234.567,89
Locale.Currency(total, 0)                       // $ 1.234.568
```

The places default to the currency's own — two nearly everywhere, zero for yen —
and a `Decimal` goes through its digits rather than through a double. Which is
the point of the pair: [`Decimal`](#decimal) keeps the arithmetic exact and this
keeps the showing exact.

**`DecimalPoint` is for a field somebody is typing into.** An entry being built
up — `3,` on its way to `3,5` — is not a number yet and cannot be formatted, so
the field has to write the separator itself. Grouping is deliberately not offered
beside it: assembling a number by hand is how India's grouping gets got wrong,
and `Locale.Number` already knows the rule.

### Ordering names, and finding one

```js
contacts.sort((a, b) => Locale.Compare(a.Name, b.Name));   // acosta, Álvarez, …, Zapata
names.sort(Locale.Compare);                                // shaped for it directly

Locale.Matches("Echeverría, Nahuel", "ver")     // true — anywhere in the name
Locale.Matches("García, Andrés", "garcia")      // true — the accent need not be typed
Locale.Matches("Álvarez, María", "maria alv")   // true — every word, in any order
Locale.Matches(anything, "")                    // true — an empty search finds everything
```

**`localeCompare` is not this, and is refused rather than left to mislead.** It
is a method of `String` and nothing had taken it away, but QuickJS is built
without ICU, so with no `Intl` a comparison with no collator falls back to
comparing code units — which is not an approximation of alphabetical order, it
is a different order:

```js
["Zapata", "Álvarez", "acosta"].sort()               // Zapata, acosta, Álvarez
["Zapata", "Álvarez", "acosta"].sort(Locale.Compare) // acosta, Álvarez, Zapata
```

`Á` is 193 and `Z` is 90, so **every accented name files after Z**, and so does
every surname written with a lowercase particle — *van der Berg*, *de la Fuente*.
That is the whole of the reason this exists: the fallback reads like the fix and
changes nothing, which is worse than not having one.

**Note which line above is the silent one.** `localeCompare` is refused now and
says what to use; a bare `sort()` and a plain `a < b` give that same wrong order
and say nothing, because neither ever claimed to know about language. They are
right for what most lists in a program hold — paths, extensions, class names,
the keys of a bag — and wrong the moment the list is text a person reads. There
is no `Locale.Sort`: `sort(Locale.Compare)` is the whole of it, and a name will
be published when something needs more than that.

`Compare` is `strcoll` under the C locale the runtime set at startup, the same one
`Locale.Number` writes a comma with. So a Spanish desktop files *Ñanculeo* between
*Nadal* and *Núñez* rather than after *Zapata*, and none of those rules is
something an application could carry. It is normalised to `-1`/`0`/`1` rather than
passing `strcoll`'s number through: `sort` reads only the sign, but a comparison
also lands in an `if`, and a function answering 2 on one machine and 34 on another
invites a test that pins the wrong one.

**`Matches` is the search field's half: `includes`, plus what `includes` cannot
do.** A word of `needle` is found anywhere in `text`, so `ver` turns up
*Echeverría* the way anyone typing expects. What it adds is that both sides are
**folded** first — decomposed, stripped of their combining marks and case-folded
— so `garcia` finds *García*, `strasse` finds *Straße*, `izmir` finds *İzmir*.
That is not something a caller can do for itself: `"Á".toLowerCase()` is `"á"`
and never `"a"`, because the question is about the alphabet and not about the
character. Marks are dropped rather than transliterated to ASCII, so a name in
Greek or Cyrillic stays searchable instead of folding to `?`.

And the needle is split on its spaces, every word of which has to be somewhere in
the text — which is the half a plain `includes` cannot do: `maria alv` finds
*Álvarez, María* whichever way round the list writes the two halves.

**It was GTK's rule first**, `g_str_match_string`: a word of the text *starting
with* a word of what was typed, which is what a `GtkSearchEntry` matches with. It
is defensible — `ana` does not drag in *Santana* — and it lasted until the first
person searched a list of names for `ver`. What a search box means is not a thing
to be argued from first principles when somebody is standing in front of one.

**What gets collated is what a person reads.** A list of file names in a tree, the
rows of a phone book, a chooser. What must *not* is an identifier or anything on
its way into a file: `PropertyNames()` and the source list in a `project.json` are
sorted plainly, because a file in version control that reordered itself when the
desktop's language changed would be a diff nobody asked for.

`TableView.SortBy` has collated since it was written — it is `g_utf8_collate`, in
C — which is exactly what kept the gap invisible: the widget that sorts its own
rows was right, and every list an application sorted by hand was wrong, including
the IDE's own project tree. [`examples/contacts`](../examples/contacts) is the
whole of it running — a phone book that argues nothing and is simply in order,
with *Ñanculeo* between *Núñez* and *Ortiz* where somebody would look for it.

## Message

`Message.Info(text, ...args)`, `Message.Warning(...)`, `Message.Error(...)`.

GTK4 alert dialogs are fire-and-forget, so these **show and return** rather than
blocking like VB's `MsgBox`. A question that needs an answer is a form: see
`ide/forms/ConfirmForm.js`, which is 39 lines and no runtime primitive at all,
or [`examples/notes`](../examples/notes), which has one of each — a prompt whose
`Default` is OK, and a confirmation where nothing is `Default` because Enter must
not be able to delete anything.

With no display (or before the application is up) they print to stderr.

## File

| | |
|---|---|
| `Load(path)` | the whole file as a string; throws if unreadable |
| `Save(path, text)` | writes it — **atomically**: a temporary beside it, renamed over |
| `Exists(path)`, `IsDir(path)` | |
| `Delete(path)` | `g_remove`: a file, or an **empty** directory. Throws if it fails |
| `Trash(path)` | to the desktop's trash, whole for a folder. Throws where there is no trash |
| `Rename(from, to)` | also moves; refuses to clobber |
| `Copy(from, to)` | **byte for byte**, so it works on images; refuses to clobber |
| `Info(path)` | `{ Size, Modified, Type, Icon, IsDir }`, or `null` when there is no such file |
| `Watch(path, cb)` | `cb(event, path)` when it changes underneath; answers something with `Stop()` |
| `Open(path)` | hands it to whatever the desktop opens that kind of file with |
| `Join(a, b, ...)` | builds a path with the platform separator |
| `Absolute(path)` | resolves against the current directory |
| `Within(path, root)` | whether `path` is `root` or under it, by whole components |
| `Relative(path, root)` | `path` with `root` taken off, or the path unchanged when there is no relative spelling |
| `Name(path)` | the basename: `/a/b/c.js` → `c.js` |
| `Directory(path)` | the dirname: `/a/b/c.js` → `/a/b` |
| `Extension(path)` | `js`, without the dot, `""` if none |
| `IsExtension(path, ext)` | whether the name ends in that extension, case-insensitively |
| `BaseName(path)` | the basename without the extension: `c` |

**`Info` is one `g_file_query_info` for five answers**, and the two that are not
obvious are the ones worth having. `Type` is the content type — `"image/png"`,
`"text/javascript"` — a *value* one can test against, and not GIO's
human-readable description, which GIO translates into the desktop's language and
no catalogue of ours could reach. `Icon` is the name the desktop draws for that
kind of file, resolved to the first one this theme really has: it is what a file
tree wants, and what one otherwise writes a table of guesses for. Resolving it
means asking the icon theme, so it is the one field of the five that needs a
display: in a console project (`main`, no GTK) it answers `""` while `Type`,
`Size`, `Modified` and `IsDir` all still work — the same fact about the display
that makes `Application.HasIcon` answer `false` there, and not a fact about the
file. `Modified` is
a real `Date`, because it is a moment and every question one asks of it is a
comparison `Date` already does — **to the millisecond, which is what a `Date`
is.** Truncated to the second, which is all `G_FILE_ATTRIBUTE_TIME_MODIFIED`
alone carries, every save inside one second is the same instant and a caller
comparing a file against what it read a moment ago sees no change; the
microseconds cost one more attribute in the query.

**`Trash` is what *Delete* should usually mean.** Deleting is the one operation
with no way back, and every file manager on every desktop answers that the same
way: the file goes to the trash and the person decides later. A program that
offers *Delete* and means `unlink` is offering something harsher than the desktop
it runs on — and one that offers the trash needs no confirmation dialog, because
the answer is recoverable.

A trash lives on the filesystem the file is on, so a folder on a stick, on tmpfs
or on a share may have none, and this **throws** rather than quietly unlinking:
that would be the one thing it exists for, gone. What to do about it is the
caller's — the IDE deletes and says which of the two happened, and
[`examples/notes`](../examples/notes) puts up the confirmation it otherwise never
needs.

**`Open` is the answer to "this program cannot edit that"** that is not "then
you cannot look at it": a `README`, a `.tar` an export left behind, an `.svg`
somebody dropped in `icons/`. What opens each of those is a choice the user made
once, in their desktop, and the desktop is the program that remembers it.

It goes through `GtkFileLauncher` rather than the older
`g_app_info_launch_default_for_uri`, so it works inside a sandbox — the launcher
asks the desktop's portal where there is one, which is the same reason the file
choosers here are `GtkFileDialog`.

**And it answers before the file is open.** Launching is asynchronous and the
program that opens it is somebody else's; what this promises is that the request
was made. A file that is not there is refused *here*, because that is the failure
a caller can do something about; anything after it is logged, named. A web
address is not this — handing a URI to the desktop is what a `LinkButton` does,
and giving a *file* verb two meanings would be the wrong place for it.

**`Watch` reports only settled events.** A save is a burst — the bytes go out,
then the writer is done — and something reacting to each would act on a file
that is briefly half there. Many editors do not write in place at all: they
write a temporary file and rename it over the target, which arrives as a move
rather than as a change. Both roads end in one `"Changed"`; the other words are
`"Created"` and `"Deleted"`.

```js
const watch = File.Watch(path, (event) => { if (event === "Changed") reload(); });
watch.Stop();
```

It hands back something that can be stopped rather than an id, the same bargain
`Timer.After` makes: an id would have to be kept somewhere by every caller. The
callback is a strong reference held from C, so a watch left running at teardown
is dropped with the rest.

**A watch may be stopped from inside its own callback**, which is not an exotic
thing to do: an editor told that its file changed underneath reloads it, and
reloading means watching the new file instead — so `Stop()` runs one frame below
the callback, inside the monitor's own signal emission. It is said here because
it *was* a segfault, found by [`examples/notes`](../examples/notes) doing the
obvious thing; stopping in that position now marks the watch and the frame that
owns it does the freeing.

**`Save` cannot leave half a file behind.** It is `g_file_set_contents`, which
writes a temporary beside the target and renames it over, so a write that fails —
a full disk, a machine that loses power mid-save — leaves the *old* file intact
rather than a truncated new one. The spelling that truncates first and then
writes is why *"it crashed and my file is now empty"* is a sentence people have
said about real editors. Nothing a caller does is required for this, which is the
point of saying it.

Text is UTF-8 throughout — which is why `Copy` exists rather than being
`Save(to, Load(from))`. That round trip is right for source and wrong for a PNG:
the bytes go through a text decoding that does not survive them, and until there
was a copy a project could read its own image and had nowhere to put one.

**`LoadXml` and `SaveXml` are the same pair one medium over**, and they are not
the same kind of thing as `LoadJson`/`SaveJson`: JSON is a *value* model —
object, list, scalar — and JavaScript has the same one, which is why a `Record`
survives it; XML is a **document** model, and attributes, element order,
namespaces and mixed content have nowhere to go in a plain object. So `Xml`
answers a tree, and a `Record` maps onto one by **declaring** it: `static Xml`
names the element and `LoadXml`/`ToXml`/`SaveXml` are `Load`/`Serialize` one
medium over, with `SaveXml` the road an interchange needs — writing into the
element it is handed and touching only what the shape models.
[`Xml`](reference/globals/Xml.md) is the page, and
[`Record`](reference/globals/Record.md) has the mapping; the argument, and what
is deliberately not there, is [`plans/xml-plan.md`](plans/xml-plan.md).

```js
const doc   = File.LoadXml("plan.xml");     // reads bytes: the declaration says the encoding
const tasks = doc.Root.Find("Tasks").FindAll("Task");

tasks[0].Find("Name").Text = "Analyse";     // or .SetAttr("Kind", "planned")
doc.Root.Find("Tasks").Add(Xml.Element("Task"));   // from another tree, so copied in

File.SaveXml("plan.xml", doc);              // canonical: declaration, indent 2, trailing newline
```

`Xml.Parse(text)` / `Xml.ParseBytes(bytes)` / `Xml.Stringify(node)` /
`Xml.Element(name)` are the in-memory four, and `Xml.Available` says whether
this build carries libxml2 — it is optional, the `Database.Sqlite` mould, and
without it every verb refuses with a sentence. An element answers `Name`,
`Prefix`, `Namespace`, `Text`, `Attr`/`SetAttr`/`RemoveAttr`/`AttributeNames`,
`Children`, `Find`/`FindAll`, `Add`/`Insert`/`Remove`, `Parent`, `Copy` and
`SetNamespace`; a document answers `Root`.

**Parsed with no DTD, no entities, no schema and no network** — `XML_PARSE_NONET`
and not `NOENT`/`DTDLOAD`/`HUGE` — so an external entity and a billion laughs
are negatives rather than configurations, and a malformed document throws with
its line and column instead of printing to stderr. HTML is not XML and is not
this. XPath, XSD validation and streaming are deferred with their triggers
named in the plan.

## Directory

| | |
|---|---|
| `List(path, pattern?)` | the **names** in one directory, sorted, no `.` or `..`; the optional pattern is a glob |
| `Files(path, pattern-or-options?)` | the **full paths** of the files, sorted |
| `Folders(path, pattern-or-options?)` | the same for directories |
| `Make(path)` | creates it and any missing parent |
| `Copy(from, to)`, `Delete(path)`, `DeleteTree(path)` | |

`Files` and `Folders` take either a glob or an options object, because the short
form is what most calls are and it should not have to carry a key to say so:

```js
Directory.Files(dir)                                   // every file in it
Directory.Files(dir, "*.form")                         // filtered by name
Directory.Files(dir, { Pattern: "*.c", Recursive: true })
Directory.Folders(dir, { Recursive: true })
```

**Full paths, and `List` keeps the names.** They are different questions: showing
a directory wants the names, walking one wants the paths — and a recursive walk
has no use for a bare name at all, since two directories deep it no longer says
where the file is.

They exist because the walk did not. `List` answered one level as names, so every
caller that wanted more built the rest itself: join, ask whether it is a
directory, recurse. That walk was hand-written three times in this repository's
own tools — sources newer than the binary, every `.form` in a tree, every icon of
a theme — which is three chances to get the symlink case wrong.

Sorted at each level and depth-first, so two runs list the same tree in the same
order; a walk whose order depends on the filesystem makes a diff of its output
useless. A directory that cannot be read is skipped rather than ending the walk:
one unreadable corner of `/usr` must not sink a question about somewhere else.

**That forgiveness is for the directories the walk *finds*, not for the one it was
handed.** All three throw when the path is not a directory — `cannot list
<path>` — rather than answering an empty list, because those are two different
answers and a caller that cannot tell them apart shows an empty folder where it
should have shown a mistake. The one to reach for beforehand is `File.IsDir`,
which is a question and not an exception. `for...in` over a missing dictionary
being zero turns is the opposite bargain, and deliberately: there, absent is an
ordinary state.

**A symlinked directory is listed and not entered**, which is what `find` and
Python's `os.walk` both default to and for the same reason — a link pointing at a
parent is a loop. A symlink to a *file* is an ordinary file: icon themes are
largely built out of those, and skipping them would answer a question nobody
asked.

## Exec

```js
Exec(["git", "status", "--short"],
     (line) => print(line),        // one call per line of output
     (code) => print(`done ${code}`));
```

`argv` is an array, never a shell string: there is no shell to quote for, so a
file name with spaces or quotes cannot turn into a command. stdout and stderr are
merged, read asynchronously, and split into lines. Both callbacks are optional.

An options object may come between the argv and the callbacks — it is told from a
callback by being one, so both spellings stay right and neither needs a
placeholder:

```js
const job = Exec(["make", "-j4"], { Directory: build, Environment: { CC: "clang", MAKEFLAGS: null } },
                 (line) => print(line),
                 (code) => print(`done ${code}`));
```

| Option | |
|---|---|
| `Directory` | the directory to start the child in |
| `Environment` | names to add to or change in the environment it inherits; a `null` value **removes** one |
| `Stderr` | `"separate"` keeps the two output streams apart; merged is the default |
| `Timeout` | milliseconds to wait before ending the child; absent means wait forever |
| `KillAfter` | milliseconds between the guard's two signals, `5000` by default; `0` sends both at once |

`Environment` is a change and not a replacement, deliberately: what a caller has is the
environment it got plus an edit to it, and spelling that as a whole environment
means writing out `PATH`, `HOME` and `DISPLAY` by hand in order to keep them.
Taking a name away is what runs a child blind — `{ Environment: { DISPLAY: null } }` is
how the suite proves a console project needs no display.

**Merged is the default because merging is what keeps the order**: one pipe, one
sequence, exactly what the child wrote. Asking for `Stderr: "separate"` buys the
line's origin and gives up any promise about how the two interleave — each stream
keeps its own order and that is all. The origin arrives as the line callback's
second argument, `"out"` or `"err"`:

```js
Exec(["make"], { Stderr: "separate" },
     (line, from) => (from === "err" ? complain(line) : print(line)));
```

Merged, that second argument is `undefined` rather than `"out"`: with one stream
there is no honest answer to which of the two a line came from, and inventing one
would make the argument a lie exactly where it is read. A wrapper can take the
choice away — `xvfb-run` runs its command as `"$@" 2>&1`, so under it everything
arrives as `out` however this is asked for.

`Exec` hands back a handle:

| | |
|---|---|
| `ProcessId` | the child's process id, as a number — `0` for a child already gone (below) |
| `Running` | `false` once it has ended — and it says so *before* the exit callback runs |
| `ExitCode` | `null` while it runs, then the status; `-1` for a child stopped by a signal |
| `Stop()` | ask it to end (SIGTERM) |
| `Kill()` | make it end (SIGKILL) |
| `TimedOut` | whether the guard is what ended it, rather than the child itself |
| `Write(text)` | a line to the child's stdin. A newline is added when there is not one, because a line is what the other side is blocked on; answers whether there was still a child to write to |

`Running` and `ExitCode` are written onto the handle rather than asked of the
child, because the question outlives the child: the ordinary place to read an exit
code is after it is gone.

**A child can be gone before the handle exists.** GSubprocess reaps on GLib's own
worker thread, so something like `/bin/true` may be finished between the spawn and
the next line — `ProcessId` is `0` then, and `Stop`/`Kill` answer `false` because
there was never anything left to signal. Reading the pid a moment later instead of
at once was a NULL dereference: a crash that appears about once in two hundred
spawns under a sanitizer, and that a plain build had waiting for a slow enough
machine.

**A third stream, for a child that speaks a protocol.** `Control` in the options
is a callback for the child's **descriptor 3**, called once per line, and
`Write` is the way back on its stdin. stdout is what a child says to a *person*
-- it is what a log pane shows -- so a protocol cannot share it: marking its
lines with a prefix means a child that prints the prefix breaks its own tooling,
silently and rarely. stderr is taken as well. A descriptor of its own is the one
spelling with no failure mode, and `bintana --debug` is what writes on it.

The control stream ending is **not** the child ending: it closes when the child
stops speaking, and what says the run is over is still stdout draining and the
process being reaped.

And **stdin is a pipe whether or not anything writes to it**, which is a change
from inheriting the parent's: a child of `Exec` can no longer take the terminal
the application was started from, and one that reads stdin and is written
nothing waits exactly as it did before.

**Two verbs and no flag.** `Stop` is a request a well-behaved program answers by
exiting and `Kill` is one nothing can decline — and `Stop` is what `Timer` already
calls ending a timer, so the word means the same in both places. A boolean would
have been worse than verbose: .NET spells the same handle's `Kill(true)` as *and
everything it started*, and ours would have meant *and harder* — one call, read by
one person, meaning two different things. Both answer whether there was still
something to signal, so a guard that fires after the child already exited gets
`false` rather than an error, and nothing is ever signalled after the pid has been
handed back to the system.

**`Timeout` is the guard, in two stages.** After it, the child is asked to end
(SIGTERM); after `KillAfter` more, it is made to (SIGKILL). Two stages because a
well-behaved program answers the first by cleaning up after itself, and that is
worth waiting for: `xvfb-run` is a shell script that takes its X server down when
asked, and killing it outright leaves the server orphaned to init. It is what
coreutils spells `timeout --kill-after`, and what the test runner wrote by hand —
two `Timer`s and a flag in a closure — before this existed.

```js
Exec(argv, { Timeout: 180000, KillAfter: 5000 }, onLine, onExit);
```

Milliseconds, because `Timer` counts in milliseconds. `KillAfter` defaults to
five seconds, and `0` sends both signals at once.

**`TimedOut` on the handle is the half that cannot be written from outside.** A
child the guard ended was stopped by a signal, so its status is `-1` — which on
its own is indistinguishable from any other signal, and a caller wanting to say
*timed out* had to keep a flag of its own. It is `false` until the guard fires,
never absent, so it reads as a boolean rather than as a key that may not be
there.

**Both stop what the child started, too.** Every child leads a process group of
its own and the signal goes to the group, because a child is usually a wrapper —
`xvfb-run`, `make`, a shell one-liner — and signalling only the wrapper leaves its
own children running. The test runner's hang guard killed `xvfb-run` and left the
X server behind, orphaned to init, once per timeout; it also never saw the end of
the output, since the survivor still held the pipe. What .NET puts behind `Kill(true)` is done here always. A group of its own also
stops a signal travelling the other way: a child does not get the Ctrl-C meant for
the program that started it. The cost is a child with no controlling terminal, which
matters only to something interactive — and interactive is `Terminal`.

For anything interactive use a `Terminal` instead: it has a real pty, so colours,
prompts and input work, and nothing has to be captured or forwarded. Note that
**VTE is optional at build time**, so a program that needs one should ask
[`Widget.Available("Terminal")`](llm/controls.md#what-there-is-and-what-this-build-can-run)
first; showing what a child printed needs no pty and is `Exec` plus a read-only
`TextEditor`, whose `Append` is what a log pane wants.

### `Exec.Wait` — the same child, run to the end

```js
const r = Exec.Wait(["msgmerge", "--update", "--quiet", po, pot]);
r.ExitCode      // the status; -1 for a child stopped by a signal
r.Output        // everything it wrote, as text
r.Errors        // only with { Stderr: "separate" }
```

The blocking spelling, for the case the callback makes worse rather than better:
a tool that runs a command it knows ends, looks at what happened, and goes on. It
takes the same options — `Directory`, `Environment`, `Stderr` — because it is the
same child started the same way, and it takes **no callbacks**: passing one is
refused rather than ignored, since it answers with a record instead.

That turns N children in a row into a `for` loop with nothing new in it:

```js
for (const cat of catalogues) {
    const r = Exec.Wait(["msgmerge", "--update", "--quiet", File.Join(dir, cat), pot]);
    if (r.ExitCode === 0) done.push(cat);
}
```

Written with a callback the same loop is a recursion carrying its own index.
Gambas spells this `EXEC … WAIT` and .NET calls it `WaitForExit`.

**`Errors` is absent when the streams are merged**, rather than empty: `""` there
would read as *it wrote nothing to stderr*, which is a different claim — the same
reason the callback spelling passes `undefined` for a merged line's origin.

**It freezes the window.** Nothing paints and nothing responds until the child
exits, and that is also what makes it safe: there is no nested main loop, so no
handler runs inside the wait and nothing can close the form the caller is
standing in. A frozen window is visible; a live window that is lying is where
lifetime crashes come from.

**The output is captured as bytes and handed over whole**, so a NUL in it is a
character of the answer and not the end of it. That matters for exactly the
tools this is for: `git status -z`, `find -print0` and `xargs -0` separate their
records with a NUL *because* it is the one byte a file name cannot contain, and
a capture that stopped at the first one read one record and lost the rest --
silently, which is the worst shape a bug can have. A file name with a space in
it was readable; a list of them was not.

**`Timeout` works here too**, and answers `TimedOut` on the record. That takes a
main context of the call's own: GTK's sources, our own `Timer`s and every pending
asynchronous `Exec` all live on the *default* context, so iterating a private one
runs the guard and nothing else. The window stays exactly as frozen as it would
be without a timeout — no handler of the application's can fire inside the wait,
which is the whole difference between this and `DoEvents`.

```js
const r = Exec.Wait(["make"], { Timeout: 60000 });
if (r.TimedOut) Message.Error("make did not finish in a minute");
```

**Without a `Timeout` there is no ending the caller controls**, so a command that
never ends hangs the program — exactly as in a shell script. Use it for a command
you know ends and ends quickly: `msgmerge`, `msgfmt`, `tar`, `git status`. Tools.
For anything long, of unknown length, or that has to show progress, the callback
spelling is the right one, and interactive is `Terminal` (which the build may
not have — `Widget.Available("Terminal")` says).

**Its child leads a process group of its own**, exactly as an asynchronous one
does, and that took a second look. A blocked caller cannot answer a Ctrl-C, so
leaving the child in the caller's group is tempting — the interrupt would reach
both, and no escape hatch would orphan anything. But it breaks the guard into a
*hang*: a timeout that can only signal the direct child leaves a wrapper's
grandchild holding the write end of the pipe, the read never sees EOF, and the
wait that was supposed to end never does. A guard that does not guarantee an
ending is worth less than an interrupt.

## Task

A class that runs in a thread of its own — the third shape of long work, after
`Timer` slices in-process and a child through `Exec`. For a computation too
long for the loop and too fine-grained for a pipe: totals over a hundred
thousand rows while the window stays alive.

```js
class Sizer extends Task {
    Run(msg) {
        // ... walk msg.roots with Directory/File ...
        return { size, files };
    }
}

const t = new Sizer();
t.Progress = (p) => status(p);
t.Done     = (r) => show(r);
t.Error    = (m, stack) => complain(m);
t.Start({ roots: subs });
```

`Task` itself is abstract: extend it, and `new Sizer()` is the handle.
`Start(data, [{ Timeout }])` sends the message and starts the thread — once; a
second `Start` is refused, and work that repeats is a new `Task`. `Stop()`
asks it to end and answers whether there was still a live job to ask. The
answer arrives exactly once, however the job went: `Done(result)` when `Run`
returned, `Error(message, stack)` when it threw, when `Stop()` asked
(`Cancelled`), or when the `Timeout` fired (`TimedOut` reads `true` then).
`Running` is written `false` before either callback runs. `this.Report(v)`
inside `Run` arrives as `Progress(v)`: zero or more calls, in order, every one
before `Done` — and dropped in silence when nobody handles it.

**Two runtimes, and the same language in both.** QuickJS runtimes are not
thread-safe, so each task gets a runtime and a context of its own — but it is
built the way the main one is: the same `init` functions, then the same
`rad.js`, so `Decimal` is `Decimal` and `Dictionary`, `Regex`, `Record` and
`Table` are all there. A class id registers into a second runtime verbatim,
which is what makes that possible and what a first attempt at this wrongly
assumed it could not do. Nothing is shared: the argument, the reports and the
answer cross as serialised text, so no JS value is ever touched from two
threads. A message is plain data — objects, arrays, strings, numbers,
booleans, null — plus `Decimal`, which crosses as its own digits and comes
back as a real one, thirds and all. Functions, class instances, cycles,
`undefined`, non-finite numbers and `Bytes` are refused out loud, because
`JSON.stringify` would drop or null them in silence; a `Record` crosses as
what `Serialize` writes and comes back through `Load`.

**What a worker does not get is what would leave a callback on the main
loop.** Not reading against writing — that is the wrong axis. GTK is gone
because GTK off the main thread is a crash (refused where widgets are built);
`Exec`, `File.Watch`, `Timer` and the asynchronous half of `Http` are gone
because the source would fire on the main thread holding the worker's
context; `Settings` and `Locale` are gone because they are process state the
main thread owns. Every handler runs on the main loop, where touching the
interface is legal; the worker never waits for it (`Queue`, not
`Synchronize`, in Delphi's words).

**A worker writes, and the cost is not the one it looks like.** The eleven
verbs that change the disk were refused once for want of a lock; they are not,
because `g_file_set_contents` renames a temporary over the target and two
threads saving one path produce one whole file rather than a torn one. What
concurrency costs is the **lost update** — read, change, write from two
threads and the first change never happened — and no automatic lock reaches
it, because the gap is between two calls and only the program knows which two.
`Lock.Hold(name, fn)` is what orders those, named rather than held because the
two runtimes share no heap; see [`docs/plans/task-plan.md`](plans/task-plan.md).
[`examples/usage`](../examples/usage) is the shape running today: N tasks
sizing N subtrees, one window adding up.

Teardown stops and joins every live task before the context goes away: a
program that quits with work still running exits, but answers that had nowhere
to arrive never do. A worker blocked in native code (a filesystem that never
answers, not JS) is the one case no flag reaches — the join waits for the
disk, and that is said here rather than discovered at midnight.

## Lock

`Lock.Hold(name, fn)` runs `fn` with the named lock held and releases it —
whether `fn` returned, threw, or was interrupted.

```js
Lock.Hold("accounts", () => {
    const book = File.LoadJson(path);
    File.SaveJson(path, add(book, row));
});
```

**It is for the lost update and nothing else.** `File.Save` writes a temporary
and renames it over the target, so two threads saving one path produce one of
the two whole files rather than a torn one; what breaks is read-change-write
across two calls, where the second thread's write throws away the first
thread's change. Measured with four `Task`s adding to one counter, sixty rounds
each: 68 of 240 unlocked, 240 of 240 held. Only the program knows which two
calls belong together, so the name is the program's and no automatic lock could
have helped.

**Named rather than held.** A `Task` runs in a runtime of its own and the two
share no JS heap, so no object can cross in a message — this is Win32's
`CreateMutex(NULL, FALSE, "Global\Accounts")` and POSIX's `sem_open`, not
.NET's `lock (obj)`. The table is process-global, which is exactly the scope
the main thread and its workers share.

**Recursive**, as `lock` is in .NET and `synchronized` in Java: a nested hold
of one name from one thread is not a deadlock. **It answers nothing**, because
a critical section is a statement in every other language and leaving the value
unspoken keeps it free for a future `Try`. **A callback and not
`Enter`/`Leave`**, which here is correctness rather than taste: a forced
`Stop()` ends a task at an arbitrary opcode, so a `Leave` would never run and
the lock would stay held for the life of the program.

Two rules that are documented rather than enforced. On the main thread a `Hold`
freezes the window while it waits, exactly as `Exec.Wait` does and for the same
honest reason — keep it short. And two locks taken in two orders deadlock here
as everywhere.

## Dialog

- `Dialog.SelectFolder(title, [options], cb)`
- `Dialog.OpenFile(title, [options], cb)`
- `Dialog.SaveFile(title, [options], cb)`
- `Dialog.Color(title, current, cb)`

GTK4 dialogs are asynchronous, so a callback is required — passing none throws
rather than silently doing nothing. The callback is not called if the user
cancels, so the caller never has to tell "cancelled" from "chose nothing".

`SaveFile` is the one that asks for a name that does not exist yet, and GTK
confirms an overwrite on its own. The three file dialogs are one function with
three magics, so whatever is true of one is true of all of them.

### The options

| | |
|---|---|
| `Folder` | where the chooser opens |
| `Name` | the name it starts on: the save field's, or the file an open dialog preselects |
| `Filters` | what the drop-down offers, as `[label, patterns]` pairs |

```js
Dialog.SaveFile(Locale.Text("Save the form as"),
    { Folder: Application.Directory,
      Name:   "Form2.form",
      Filters: [[Locale.Text("Forms"), "*.form"],
                [Locale.Text("All files"), "*"]] },
    (path) => File.Save(path, text));
```

Which one is the callback is decided by type and not by counting — it is the
argument that is a function — so the options stay optional without an overload
per shape.

**Patterns are space separated, and `*.ext` becomes a suffix rather than a
glob.** GTK's pattern matching is case sensitive, so `*.png` would not match
`PHOTO.PNG`, which is not what anyone writing `*.png` means. The first filter is
the one the dialog opens on: a list whose head is not the filter you meant is a
list in the wrong order.

**A filter's label is prose the caller owns**, wrapped in `Locale.Text` like any
other string built at the moment — the runtime does not look it up. That is also
why `Filters` is a list of pairs and not `{ "Forms": "*.form" }`: a literal
heading a `Locale.Text` call is what the IDE's extractor collects, and an object
key would have been invisible to it. The convenient spelling is the one that
quietly cannot be translated.

Everything the runtime refuses throws with the offending value, as every setter
does, and it throws **before** the dialog is shown: a shape it does not accept
fails while there is still a caller to fail at, rather than leaving a chooser
open on half-applied options. A filter with no patterns is one of them — it
matches nothing, so it hides every file and reads as an empty directory. An
empty `Filters` list is not: it means the same as no `Filters` at all, the rule
`sources` in a `project.json` already follows.

`Color` opens the desktop's colour chooser at `current` (a colour that does not
parse simply means there is nothing to start from) and answers with an `rgb(...)`
or `rgba(...)` string — which is exactly what `Background` and `Foreground` take,
so the chooser hands over what the property was going to be assigned anyway.

It is a primitive rather than a form of its own, unlike `AskForm` or the IDE's
icon chooser, and the line is worth stating: **a list of names is widgets, a
colour wheel is not.** What the widget set can be talked into being belongs in
Bintana; what it cannot belongs here.

## Settings

| | |
|---|---|
| `Get(key, fallback)` | the value, or the fallback when there is none |
| `Set(key, value)` | anything JSON carries; written immediately |
| `Has(key)`, `Delete(key)`, `Keys()`, `Clear()` | |
| `Path` | the file, under `Application.ConfigDirectory` |

`Application.ConfigDirectory` is a directory; this is the file everybody was going to
write in it. Read once and cached, written on every `Set`: a setting lost because
the application died before some flush would be a poor trade for the writes it
saves. A file that cannot be read counts as empty — settings are the last thing
that should stop an application from starting.

The fallback matters more than it looks: `Get("on", true)` tells a missing
setting from one that is `false`, which a bare read cannot.

## Timer

```js
const clock = new Timer(1000, () => this.Lbl.Text = new Date().toString());
clock.Start();
clock.Enabled = false;        // the same switch, read or written
new Timer(200, fn).Once();    // fires once and is done
```

`Delay`, `Tick`, `Enabled`, `Start([delay])`, `Stop()`, `Once([delay])`, plus the
two shorthands that cover almost every use:

```js
Timer.After(250, () => this.Lbl.Text = "done");   // once
const clock = Timer.Every(1000, () => this.tick());
clock.Stop();
```

Both hand the `Timer` back, so what was started can still be stopped. This *is*
scheduling here: the raw `setTimeout`/`setInterval` are not part of the language
(see [the language underneath](#the-language-underneath)). What they used to
carry — a bare id you had to keep somewhere to cancel — is the bookkeeping Timer
was written to end.

## Stopwatch

How long something took, which is the one question a `Date` cannot answer.

```js
const watch = new Stopwatch();

watch.Start();                 // and Start() again on a running one changes nothing
watch.Elapsed                  // milliseconds, with the fraction, running or not
watch.Stop();                  // Start() after this picks up where it left off
watch.Reset();                 // back to zero, and stopped
```

| | |
|---|---|
| `Elapsed` | milliseconds measured so far, whether it is running or not |
| `Running` | whether it is |
| `Start()` | starts or resumes; starting a running one is not an error and does not restart it |
| `Stop()` | pauses, keeping what was measured |
| `Reset()` | zero, and stopped |

All three hand the watch back, so `new Stopwatch().Start()` is one line.

**`Date` cannot answer this, and the reason is not precision.** A `Date` reads
the wall clock, and a wall clock is a *setting*: NTP steps it, a timezone change
moves it, somebody corrects it by hand. Any of those during a measurement makes
the answer wrong — and a step backwards makes it **negative**, which is how a
stopwatch built on `Date.now()` reports a lap that took minus four seconds on a
machine that did nothing but sit there. This reads `g_get_monotonic_time()`, the
clock that only goes forward, which is the one GLib already schedules every
[`Timer`](#timer) against. So it is not a second notion of time in the runtime:
it is the one that was already under the scheduler, published.

**The raw reading has no name in this language.** It counts from an unspecified
point — the machine's boot, on Linux — so a single reading means nothing and only
the difference between two does; leaving it exposed would invite it being
printed, stored, or compared against a date. `rad.js` captures it and the runtime
deletes the name, on the same terms as `setTimeout` and for the same reason: see
[the language underneath](#the-language-underneath).

**And counting ticks is the other wrong answer, the one that looks right.** A
timer asked for 100 ms fires a little late every time, so a display that adds 100
to a counter falls behind and never catches up — twenty ticks of 100 ms measured
2003 ms of real time on the machine this was written on, which is a minute short
by most of a second and an hour short by most of a minute. **A tick is for
deciding when to repaint; what is painted comes from `Elapsed`.**
[`examples/stopwatch`](../examples/stopwatch) is built on that separation and
says how to test it: turn its repaint down from twenty times a second to once,
and the reading stays exact.

There is no `Locale` format for a duration, deliberately. `Locale.Date(x, "Time")`
answers *what o'clock*, which is a different question with a different answer for
the same number; and the colons and leading zeros of `2:15:00,05` are the same in
every language. The one part that is not is the mark before the hundredths, which
is `Locale.DecimalPoint`.

## Dictionary

What a bag of data holds.

```js
Dictionary.Keys(bag)          // ["Text", "Width", "Enabled"]
Dictionary.Values(bag)        // ["Guardar", 90, false]
Dictionary.Entries(bag)       // [{ Key: "Text", Value: "Guardar" }, …]
Dictionary.Count(bag)         // 3
Dictionary.Has(bag, "Text")   // true
```

| | |
|---|---|
| `Keys(bag)` | the names it holds, in the object's own order |
| `Values(bag)` | what is under them |
| `Entries(bag)` | the pairs, as `{ Key, Value }` records |
| `Count(bag)` | how many |
| `Has(bag, key)` | whether that key is one of its own |

**`for...in` recites and `Dictionary` counts.** Reciting a bag needs no
intermediary and allocates nothing — it is how a `.form`'s `properties` is
applied — so the loop stays the way to walk one:

```js
for (const key in settings) applyOne(key, settings[key]);
```

What was missing was the other half. An *array* of names is what you want when a
`.sort()`, a `.filter()`, a `.length` or a `new Set` comes next, and that is what
this is for. `for (const key of Dictionary.Keys(o))` says the same thing twice.

**Absent is empty.** `Dictionary.Keys(null)` is `[]` and `Count(undefined)` is
`0`, the same bargain `Apply` makes with a missing dictionary — because
`for...in` over nothing is already zero turns while `Object.keys(null)` threw, and
that asymmetry is the whole reason `Object.keys(node.properties || {})` used to be
written that way.

**A number or a text is refused**, naming the verb and the value. The
`Object.keys` this replaced answered `["0","1","2","3"]` for a text and said
nothing about it, and a dictionary that agreed to that would be wrong somewhere
further along than here. An object is an object, though — including a class,
which is what the IDE's completion asks about.

**It answers what an object holds, which is not what its class declares.** A
`Record`'s fields and a control's properties live behind accessors on the
prototype, so neither is among what the object holds and both answer
`PropertyNames()` instead. It is the distinction a `.form` already makes between
`properties` — held — and `PropertyNames()` — declared.

### Why it is a module and not a method

Because in JavaScript a dictionary and an object are the same thing, so the keys
of the data and the names of the methods share one namespace: a `bag.Keys` would
be inherited by every object in the program and would collide with a bag that has
an entry called `Keys`. Every language in which the dictionary *is* the general
object arrived at the same answer — Lua's `pairs(t)`, Perl's `keys %h`, Clojure's
`(keys m)`, and JavaScript's own `Object.keys` — which is what this replaced, and
which is no longer part of the language. Only the name was ours to pick, and a
module named for the type is how Elixir (`Map.keys/1`) and Tcl (`dict keys`)
spell it.

`Dictionary` next to `Directory` is .NET's own arrangement: it ships
`System.IO.Directory` and `System.Collections.Generic.Dictionary`, both in view at
once, and nobody confuses them.

### When the keys are numbers, use a `Map`

A key that looks like a whole number is not kept where it was put:

```js
Dictionary.Keys({ "10": 1, "2": 2, "Text": 3 })    // ["2", "10", "Text"]
```

Integer-like keys sort numerically and come before the rest. That happens in the
object model, before anything here looks — `JSON.parse` hands the keys over
already moved, so a data file keyed by number does not round-trip in the order it
was written. `Map` keeps insertion order for every kind of key, and that is what
it is for.

## Hash

A checksum, of a string or of a file. `GChecksum` underneath, which is GLib's
and already linked — what is written here is the surface, the refusals and the
block-at-a-time read.

```js
Hash.Md5(text)  Hash.Sha1(text)  Hash.Sha256(text)  Hash.Sha512(text)
File.Hash(path, [algorithm])         // "Sha256" unless told; any of the four
```

Every answer is lower-case hex. An algorithm this does not know is refused by
name, with the four said out loud, rather than answering the wrong digest.

**A string is hashed as its UTF-8 bytes**, which is the reading that makes a
digest computed here equal to what `sha256sum` says about the same text in a
file, accents included — the only one that is not a private convention. A
[`Bytes`](#bytes) is hashed as the bytes it is, which is the case a checksum is
actually for.

**`File.Hash` does not load the file.** 64 KB at a time through `g_checksum_update`,
because the operation that most wants a checksum is the one over a file too big
to hold — and because `File.Load` answers a *string*, so it would refuse most of
what gets hashed. It is the one file operation here that reads bytes and says
nothing about encoding.

These are checksums and **not** password hashes: no salt, no work factor. What
they are for is comparing a download against a published digest, keying a cache,
and telling two files apart.

## Bytes

The value a file is when it is not text: one class with a copy of the bytes,
immutable, in `bta_bytes.c`.

```js
new Bytes([value])   Bytes.FromBase64(t)   Bytes.FromHex(t)
Length  At(i)  Slice(from,[count])  Concat(...)  Equals(other)
ToText()  ToBase64()  ToHex()  toString()  toJSON()
File.LoadBytes(path)  File.SaveBytes(path, bytes)
```

**Why not `Uint8Array`.** QuickJS has the typed arrays and `close_hatches` takes
them off the language: they bring a view/buffer distinction, a shared-memory
story, an `Atomics` namespace and index syntax that reads like an array of
numbers — a whole model for a value an application reads a file into, cuts a
piece off, and writes back out. `Decimal` made the same call for the same reason.

**Immutable, and that is load-bearing.** No `Set`, no resize: every operation
answers a new one, so handing a `Bytes` to a record field and keeping it is safe
without copying at the boundary. `bta_bytes_new` copies *in*, because every
caller hands over memory that is not ours — a GLib buffer from
`g_file_get_contents`, a sqlite BLOB that belongs to the statement until the next
`step`, a base64 decode.

**The text edge is explicit both ways.** `ToText` runs `g_utf8_validate_len` and
throws rather than answering replacement characters; `toString` is
`Bytes(1234)`, never the content. `toJSON` is base64, which is what makes
`Field.Bytes` survive `File.SaveJson`.

**Base64 in is checked before it is decoded.** `g_base64_decode` *ignores*
characters outside the alphabet — `"hello"` comes back as three bytes rather
than an error — and `Field.Bytes` reads base64 out of files, which is exactly
where that would land. The alphabet, the padding and the length are decidable up
front, so `Bytes.FromBase64` decides them.

**sqlite carries it as a BLOB**, in both directions (`sqlite3_bind_blob`, and
`sqlite3_column_blob` *before* `_bytes`, which is sqlite's own ordering rule).
The driver used to refuse a BLOB by name; that was right for exactly as long as
there was no value to hand back.

## Decimal

Exact base-10 arithmetic, **with the ordinary operators**.

```js
const precio = new Decimal("19.99");
const total  = precio * cantidad + iva;      // exact, to the cent
```

| | |
|---|---|
| `new Decimal(value, [decimals])` | from text, a number or another decimal; `decimals` fixes the scale, rounding if it has to |
| `Round(decimals, [how])` | `"Away"` (the default), `"Even"`, `"Zero"`, `"Up"`, `"Down"` |
| `Trim()` | the same value remembering no more places than it needs: `2.50` → `2.5` |
| `Abs()` | |
| `Scale` | how many decimal places it will be written at |
| `Sign` | `-1`, `0` or `1` |
| `IsExact` | whether it has an exact decimal form at all — `false` for a third |
| `Number()` | the double it is nearest, asked for **by name** |
| `Decimal.Split(total, parts)` | pieces that add back up to the total, exactly |

`+ - * /`, `< > <= >=` and unary `-` all work, and mix with the ordinary numbers
and texts a program already has: `precio * 3`, `precio - "0.99"`.

### Why this exists

JavaScript has one numeric type and it is binary floating point, so `0.1` ten
times is not `1` and `(1.005).toFixed(2)` is `"1.00"`. That last one is not a
rounding bug: the double the literal `1.005` produces really *is*
1.00499999999999989, so the information is gone before anything can round it. No
rounding function can recover it — only never going through a double can, which
is why a decimal is built from **text**:

```js
new Decimal("1.005").Round(2)        // 1.01, where toFixed says 1.00
new Decimal("8.165").Round(2)        // 8.17, where Math.round(x*100)/100 says 8.16
```

In a RAD language that is the ordinary path anyway: an amount is typed into a
`TextBox` and shown in a `Label`, so if it is carried exactly from one to the
other the double never gets a chance.

### A fraction, not a scaled integer

The obvious build is an integer and a scale — `19.99` as 1999 with scale 2, which
is what VB's `Currency` and Delphi's are. This was that, and it was wrong for one
reason:

```js
(new Decimal("10") / new Decimal("3")) * new Decimal("3")     // has to be 10
```

A scaled integer has to *decide* what ten thirds is the moment it is asked, and
every decision is a rounding: 3.33, and three of those are 9.99. What was thrown
away is not recoverable, so no care further down puts the cent back.

So a value is a **fraction** — numerator and denominator, both 64-bit, always
reduced. Ten over three stays ten thirds, and multiplying by three cancels them:

```js
(a / b) * b === a          // for every a and b, exactly
new Decimal("1") / new Decimal("3") + new Decimal("2") / new Decimal("3")   // 1
```

It is what Scheme, Ruby's `Rational` and Python's `fractions.Fraction` hold, and
what makes the arithmetic **closed**: every operator answers exactly, and
rounding happens in one place only — when the value is written down.

**`0.1` is one tenth**, not an approximation of it. The same theorem governs both
this and the double: a fraction terminates in base *B* exactly when its reduced
denominator's only prime factors are *B*'s. Ten is 2×5, so tenths are exact here
and thirds are not; two is 2, so tenths are not exact in a double. This type did
not solve that — it moved to the base money is written in.

**What overflows throws.** Every product is checked in 128 bits and the fraction
is reduced after every operation, which is what keeps money — where every
denominator is a power of ten — nowhere near the ceiling. Adding fractions with
coprime denominators is the case that grows: a third plus a seventh is a
twenty-first, and a long chain of those is refused, loudly.

### The scale a value remembers

A fraction has no places of its own — 199/10 and 19.90 are the same number — and
a column of prices still has to line up. So a value also carries the scale it was
*written* at, which is presentation and never arithmetic: widest wins when
adding, they add when multiplying, and only `toString` reads it.

```js
new Decimal("19.9", 2)                          // 19.90 — the column
new Decimal("1") / new Decimal("8")             // 0.125 — the places it needs
new Decimal("10.00") / new Decimal("4")         // 2.50  — the column it had
new Decimal("10") / new Decimal("4")            // 2.5
```

A value with **no** exact decimal is written at nine places, rounded — and that
rounding is in the text and never in the value, which is why multiplying it back
still gives a whole ten. `IsExact` is the question, and `Trim()` drops places a
value is not using.

### The operators come from a patch to the engine

quickjs-ng removed the operator overloading and the `BigDecimal` that Bellard's
quickjs carried, so `JS_SetArithHandler` is a hook the arithmetic slow paths
consult before they reach `ToPrimitive`
([`AGENTS.md`](../AGENTS.md#the-two-patches-in-vendor)). Two consequences worth
knowing:

**`===` is not hooked, deliberately.** Strict equality on objects is identity, it
has no slow path, and giving it one would change what identity means for every
object in the program. Compare with `<` `>` `<=` `>=`, or with `` `${a}` ===
`${b}` `` when what is wanted is *the same value*.

**`+` with a text is concatenation**, as everywhere else in JavaScript, so
`"Total: " + precio` builds a message. The other operators keep the decimal
reading, because `-` `*` `/` on a text already mean *convert it to a number*.

`%` and `**` are **refused**. Letting them through would reach `ToPrimitive`,
which reads the decimal's text back as a double — so `precio ** 2` would quietly
answer with the floating point this type exists to avoid.

### Scales, and the one place it is not exact

Adding lines the scales up and multiplying adds them, which is what decimals do:

```js
new Decimal("1.5") + new Decimal("0.25")     // 1.75
new Decimal("1.5") * new Decimal("1.5")      // 2.25
```

**Division is exact too**, which is the whole point of a fraction: `10 / 3` is
ten thirds and not an approximation of it. What *cannot* be exact is writing one
down — a third has no decimal form at any length — so a non-terminating value is
shown at nine places and stays exact underneath.

`Round(n, how)` is the one operation that deliberately **loses** something, which
is why it is asked for by name: a third rounded to two places is 3.33 and is no
longer a third, so multiplying it back by three gives 9.99. Everything else is
exact; this is where a program says it is done being exact.

### Splitting, which no decimal type solves

Ten between three is 3.33 each and one cent left over, and rounding each share
separately gives 9.99. `Decimal.Split` hands the remainder out:

```js
Decimal.Split(new Decimal("10.00"), 3)       // 3.34, 3.33, 3.33 — and they sum to 10.00
```

The pieces keep the total's scale, and the property that matters is the one the
suite asserts: **they add back up to the total, exactly.**

Dividing would answer with exact thirds, which also add back up — but a share has
to be an amount somebody can be paid, and a third of a cent is not one. That is
the difference between dividing and sharing out, and it is why both exist.

### Showing one

`Locale.Number` and `Locale.Currency` take a decimal and write it from its own
digits, never through a double — see [Locale](#locale). `JSON.stringify` writes
its text (a string, because a JSON number would be a double again), and
`Number()` is how a program asks for the double on purpose, for the places that
genuinely want one: a chart, a width, a percentage of a window.

## Day

The calendar date, which is the value JavaScript does not have.

```js
Day.Today                      // "2026-08-31" — the date it is here
Day.Add("2026-03-08", 7)       // "2026-03-15"; negative counts go back
Day.Between(from, to)          // whole days, signed
Day.Weekday("2026-03-08")      // "Sunday"
```

| | |
|---|---|
| `Today` | today's date, at **local** midnight. A getter, like `Locale.Current` |
| `Add(date, days)` | a date, `days` may be negative; refuses to leave the calendar |
| `Between(from, to)` | whole days from one to the other, negative when `to` is earlier |
| `Weekday(date)` | `"Monday"` … `"Sunday"` — a key to test against, never text to show |

**A date is `"YYYY-MM-DD"`, the text**, and that is the whole type: what a
[`DatePicker`](widgets.md#datepicker) answers with, what a
[`Field.Date`](#record-and-field) holds, and what goes into JSON as itself. So
there is no conversion at any edge, and `a < b` already orders two of them, which
is the one thing ISO 8601 was designed for. Anything else is refused rather than
guessed at — `"08-03-2026"` means two different days on two desktops, and
`2026-02-30` is not a day at all.

### Why it exists

JavaScript has one date type and it is an **instant**: milliseconds since an
epoch, read back through a time zone. An appointment, a birthday and a due date
are none of those — they have no hour, they are the same date for everyone
looking at them, and their arithmetic counts days. Borrowing the instant to stand
for the date is where every one of these comes from:

```js
new Date("2026-03-08").getDate()        // 7 in Buenos Aires, 8 in Berlin
new Date("2026-03-08").getDay()         // and therefore the wrong weekday
(b - a) / 86400000                      // 6.958333 for a week, across a clock change
new Date().toISOString().slice(0, 10)   // yesterday, all morning, in Lima
```

The first is the specification and not a quirk — **a date-only string is parsed
as UTC midnight** — which is exactly what makes it hard to find: it is right on
the machine of whoever wrote it if they live east of Greenwich, and off by one for
half the world. It is `0.1 + 0.2` one type up: a value forced through a
representation that cannot hold it, and [`Decimal`](#decimal) is the same answer
to the same shape of problem.

### Three decisions worth knowing about

**`Weekday` answers a name.** There are at least four numberings in circulation —
JavaScript and .NET count from Sunday as 0, ISO 8601 and Java from Monday as 1,
Python has `weekday()` at Monday 0 *and* `isoweekday()` at Monday 1, PostgreSQL
has `DOW` and `ISODOW`. A bare integer makes every caller remember which one this
runtime picked, and every off-by-one it causes is silent; Java, C# and Go all
answer with an enum for the same reason. It is a value to test against, the way
`File.Info`'s `Type` is `"image/png"` and not the description GIO would have
translated — what a person reads comes from `Locale.Date(date, "Weekday")`, in
their language.

**`Between` is signed, and its argument order is `(from, to)`.** Java's
`DAYS.between(a, b)` is the same both ways; Delphi's `DaysBetween` answers an
absolute value and loses which way round they were. Signed is what lets one call
say *in three days* and *three days ago*.

**`Today` is local midnight**, which is the whole reason it exists rather than
being written out at each call site: `toISOString().slice(0, 10)` is UTC's date,
and for everyone west of Greenwich that is yesterday for the first hours of every
morning. It is the single most common way this bug reaches production.

### Why a module and not a type with operators

`date + 7` reads better than `Day.Add(date, 7)`, and the engine patch that would
allow it is already paid for — [`Decimal`](#decimal) needed it and
`JS_SetArithHandler` is not specific to decimals. It is still not what this
family of languages does: Gambas and Delphi, the two nearest relatives, both ship
functions over a date value (`DateAdd`/`DateDiff`, `IncDay`/`DaysBetween`), and
Java, Go and `Temporal` all ship methods rather than operators without anybody
feeling the loss. Functions over the text everything already speaks is the
smaller thing that answers the whole question.

**And `Day` rather than `Calendar`** because that word is taken and for something
else: in Java it is the superseded API, in .NET and PHP it is *which* calendar —
Gregorian, Hijri, Japanese — and in Python it is month grids and day-name tables.
What every language that has this value calls it is a date *without a time*:
`LocalDate`, `DateOnly`, `PlainDate`. `Day` is that in one word, and `Date` was
not available — JavaScript's is still installed, and `File.Info`'s `Modified` is
one.

The arithmetic is `GDate`'s, which GLib has kept apart from `GDateTime` since
long before any of this: `g_date_add_days`, `g_date_days_between`,
`g_date_get_weekday`. The calendar runs from `0001-01-01` to `9999-12-31`, which
is what four digits of year can hold — and the bound is enforced so that
everything `Add` answers is something `Weekday` accepts.

[`examples/agenda`](../examples/agenda) is the whole of it running: a day at a
time, with weekly and yearly entries, and not one `new Date` in the file.

## Text

What a string measures, where there is no `Painter` to ask.

```js
Text.Width("Statement of account", "Bold 18")   // 178
Text.Height(description, "", { Width: 300 })    // the height of the wrapped run
Text.Size(description, "", { Width: 300 })      // { Width, Height, Lines }
Text.Lines(description, "", { Width: 300 })     // the lines it breaks into
Text.Font                                       // the desktop's UI font
```

| | |
|---|---|
| `Width(text, [font], [options])` | how wide it lays out, in pixels |
| `Height(text, [font], [options])` | how tall: one line, or the whole block when it wraps |
| `Size(text, [font], [options])` | `{ Width, Height, Lines }` from one layout |
| `Lines(text, [font], [options])` | the lines it breaks into |
| `Font` (ro) | the desktop's UI font; `""` with no display to ask |

`font` is a Pango description and defaults to `Text.Font`; `options` is
`{ Width }`, the width to wrap to. A word too long for that width is **broken**
rather than left to overflow, so a measurement never promises a width the text
will not keep.

**It answers what a `Painter` would.** One `PangoContext` off
`pango_cairo_font_map_get_default()`, with the desktop's own resolution read from
`gtk-xft-dpi` on every call -- so a text scale of 125% moves this and the widgets
together, and changing it while the program runs is not a stale number here.
`tests/widgets` asserts the equality against `Painter.TextWidth` rather than
trusting it. A **vector** surface can differ by a pixel: hinting is off for PDF
output, which is a property of that surface and not of this answer.

**One context and one layout, kept.** Building either per call is what would make
a measuring API cost more than the drawing it was meant to save -- measured for
the painter's own layout: 200 labels are 1.84 ms to draw and 0.75 ms to measure,
so a layout per call would be most of a chart's text budget.

The client this was built for is `lib/report`'s `Height: "Auto"`: a band as tall
as its own contents, worked out in a pass that never opens a frame.

## Screen

The desktop's geometry, off `GdkMonitor`.

```js
Screen.Width  Screen.Height  Screen.Scale     // the monitor in use
Screen.Monitors()                             // [{ X, Y, Width, Height, Scale, Name }, …]
```

**Which monitor `Width` means is a decision, because GTK4 has no primary one.**
`gdk_screen_get_primary_monitor` went with GTK3 — Wayland does not answer it —
so the monitor that matters is the one the user is looking at, which is the one
`gtk_application_get_active_window` is on (`gdk_display_get_monitor_at_surface`).
Before any window is realised there is no such answer and it falls back to the
first monitor the display lists; with no display at all — a console project — it
is `0`, not a refusal, because "how big is the screen" has an honest answer of
zero when there is no screen and the caller is usually choosing a default.

**And there is no work area.** GTK4 dropped `gdk_monitor_get_workarea` for the
same reason: a Wayland client cannot know what a panel has taken. Anything that
wanted to fill the screen wants `Maximized` instead, which is a request the
compositor honours.

The geometry is in **logical** pixels, the same ones a form's `Width` is in, with
`Scale` answered separately — `gdk_monitor_get_geometry` is already in those
units, so nothing here divides by anything.

## Time

A time of day as `"HH:MM"` / `"HH:MM:SS"`, beside `Day` in `bta_day.c` because it
is the same argument one unit down: the value is the text, and the functions are
over it.

| | |
|---|---|
| `Now` | with seconds, always |
| `Add(time, minutes)` | **wraps** at midnight |
| `Between(from, to)` | whole minutes, signed |
| `Seconds(time)` | seconds since midnight |

**`Add` wraps where `Day.Add` refuses.** A date past the end of the calendar is a
mistake; a clock has no end to fall off, and twenty minutes after 23:50 is 00:10
by every clock there is. Which day that belongs to is exactly what a time of day
does not carry — a caller that needs both is holding two values.

**The parse is strict**: five or eight characters, colons in the right places,
`24:00` refused. A value that is sometimes four characters and sometimes five
does not sort, and sorting is most of what a time as text is for; `Field.Time`
compares `min`/`max` as plain strings for the same reason.

`Field.Time` is in rad.js beside the other field kinds, with `required`, `min`
and `max`.

## Regex

A pattern, with nothing remembered between questions.

```js
const pair = new Regex("(?<key>\\w+)\\s*=\\s*(\\d+)");

pair.IsMatch(text)                       // is there one
const m = pair.Match(text);              // the first, or null
m.Value; m.Index; m.Length;
m.Group("key"); m.Group(1); m.Groups[0]  // by name or by number
for (const m of pair.Matches(text)) …    // all of them, as a list
pair.Replace(text, "${key}")             // every match, .NET's substitution
pair.Split(text)
Regex.Escape(name)                       // a text as a literal in a pattern
```

| On a Regex | |
|---|---|
| `new Regex(pattern, [options])` | a pattern that does not compile throws, **naming itself** |
| `IsMatch(text)` | whether there is one |
| `Match(text, [start])` | the first match at or after `start`, or `null` |
| `Matches(text)` | every match, as a list |
| `Replace(text, replacement, [count])` | **all** of them unless `count` says how many; `replacement` is a text or a function of the `Match` |
| `Split(text)` | what the matches separate, with any captured groups among them |
| `Pattern` | what it was built from — what was *written*, not what was compiled |
| `Regex.Escape(text)` | that text as a literal inside a pattern |

| On a Match | |
|---|---|
| `Value`, `Index`, `Length` | what was found and where |
| `Groups` | numbered as .NET numbers them: `Groups[0]` is the whole match, so `Groups[1]` is the first parenthesis |
| `Group(nameOrNumber)` | either kind of group through one door; `""` for one that is not there |

| Option | |
|---|---|
| `IgnoreCase` | |
| `Multiline` | `^` and `$` match at every line |
| `Singleline` | `.` matches a newline too |
| `Unicode` | the `u` JavaScript spells as a flag: `.` counts **code points** — one match for an emoji, not two — and `\p{L}` is the Unicode property it looks like. Without it `\p{L}` **compiles and matches the literal text `p{L}`** |
| `IgnorePatternWhitespace` | .NET's free spacing: whitespace and `# comments` are dropped **from the pattern**, so a long one can be laid out over several lines. Inside a character class a space is still a space |

An option nobody has is refused by name, the way a `Field`'s is.

**The engine is the language's own `RegExp`, and this is the only way to it from
a string.** The name `RegExp` is gone — `close_hatches` takes it, and
`RegExp.prototype.constructor` with it so `(/(?:)/).constructor` cannot hand it
back — but `/x/g` is syntax and still makes one, so a pattern that is *fixed* is
well written as a literal and a pattern **built at run time** has exactly one
spelling. `rad.js` captured the constructor before the name went, which is what
`Regex` is built on, and `Unicode` is where the `u` that only
`new RegExp(p, "u")` used to reach lives now. Three more things change, and each
was a bug this repository has actually written:

**No `lastIndex`.** A `/g` pattern remembers where it stopped, so one object
answers `test` true and then false depending on who asked before it, and every
walk over matches is a `while ((m = re.exec(text)))` that holds together only
while nothing else touches the pattern. `Matches()` hands back the whole list and
nothing here remembers anything — which is why a `Regex` can be a `const` at the
top of a file, the shape the IDE used to rebuild inside its loops to stay out of
trouble.

**`Replace` replaces all.** The `g` that had to be remembered is not a flag any
more. `count` is there for when one was genuinely meant — moving a class between
namespaces rewrites its *declaration*, and a comment further down that happens to
name it is not a second declaration.

**A function is handed the `Match`.** JavaScript hands a replacer a list of
arguments whose shape depends on how many groups the pattern happens to have,
which is what makes one awkward to write against.

**`Escape` is the one that was missing** rather than merely awkward. Every pattern
built around a name the program did not choose needs it: the IDE finds a renamed
control by looking for `\bButton1\b`, and a class name derived from a file called
`My.Form.form` has a dot in it that would otherwise match anything. The designer
already refuses a control name that is not an identifier, so this is the second
lock rather than the first — but the names that reach these patterns come from
file names, from `Namespace()` declarations read out of a project's source, and
from `Widget.Name`, which the runtime does not check at all.

**What this is not is a second engine.** .NET's balancing groups, conditionals,
character-class subtraction and the `\A` / `\z` anchors are grammar `RegExp` does
not have, and inventing them here would be a parser rather than a word. What is
.NET here is the API and the absence of state, not the pattern language.

The substitution syntax **is** .NET's: `$1`, `${name}`, `$&`, `` $` ``, `$'` and
`$$` — not JavaScript's `$<name>` — because the replacement is expanded here
rather than handed to `String.replace`, and a translation between the two spellings
would be a second syntax to get wrong.

## Logger

```js
Logger.Info("started");
Logger.Warning("no config, using defaults");
Logger.Error("could not save", err.message);
Logger.Debug("x =", x);
```

Arguments are joined with a space, like `print`. What `console` used to be, with
the two things it lacked: a level that means something, and somewhere to send it.
(`console.log` and `console.error` both went to stdout, so the one distinction it
offered was a lie.)

Spelled out rather than `Log`, which next to a number reads as a logarithm.

| | |
|---|---|
| `Logger.Level` | `"Debug"`, `"Info"` (default), `"Warning"`, `"Error"`, `"None"` — below it, nothing is even formatted |
| `Logger.Target` | `"Terminal"` (default) or `"Journal"` |
| `Logger.Handler` | `(level, text) => …` — set it and it takes over completely |

**The base is stdout and stderr**, which every system has: `Debug` and `Info` to
stdout, `Warning` and `Error` to stderr, where anything supervising the program
looks for them.

**`Logger.Handler` is how an application logs its own way** — to a file, to a widget,
to a socket. It takes over completely; a handler that throws is reported once to
stderr and cannot log its way back in.

**Platform backends are extensions.** `Logger.Target = "Journal"` writes straight to
the systemd journal with the level as its syslog priority, and it is compiled in
only when `libsystemd` is found (`runtime/src/bta_journal.c`, `BTA_HAVE_JOURNAL`).
On a build without it the assignment is **refused** rather than ignored — an
application that asked for the journal and quietly got nothing would never find
out. Another operating system's log is another file answering the same two
questions: is it available, and take this message at this level.

## Clipboard

- `Clipboard.Copy(text)` — immediate.
- `Clipboard.Paste(cb)` — `cb(text)`, and `""` when there is nothing to paste.

Copying is a call and pasting is an answer that arrives: the clipboard's contents
belong to whoever owns the selection, and come when that application replies.
Nothing to paste is an empty string, not an error — a clipboard holding an image
is as ordinary as an empty one.

## Waiting for GTK

A widget just created or just shown has no allocation until the main loop runs
again, so anything that measures (`OriginIn`, `PickAt`, an unset `Width`) has to
let a frame pass first — `Timer.After(0, …)`. The test suite uses generators for
exactly this; see [testing.md](testing.md).

`Timer` runs on the GLib main loop. The browser-named primitives it is built out
of are captured by `rad.js` and then removed, so `Timer` is the only way to
schedule — which is the point.

## Record and Field

The shape data has, declared once — what a control's properties are to a control.

```js
class Customer extends Record {
    static Naming = "same";                       // same | lower | snake
    static Fields = {
        Name:     Field.Text({ required: true, max: 80 }),
        Email:    Field.Text({ as: "email_address" }),
        Balance:  Field.Number({ decimals: 2, min: 0 }),
        Category: Field.Enum(["Retail", "Wholesale"]),
        Active:   Field.Bool(true),
        Since:    Field.Date(),
        Tags:     Field.List(Field.Text()),
        Address:  Field.Record(Address),          // a record inside a record
        Orders:   Field.List(Order),              // ...and a list of them
    };

    /* A field written by hand is a field. Read-only, so it is not written back. */
    get Label() { return `${this.Name} (${this.Id})`; }
}
```

What that produces is **ordinary accessors on the prototype**, so a record is
discovered by the same machinery a widget is: `Serialize`, `Apply`,
`PropertyNames` and `PropertyOptions` all work, and a property grid can edit one
without being told which it has. Declaring is only how the accessors get written
— not a second place the shape lives.

| Kind | Holds | Options beyond `as` and `def` |
|---|---|---|
| `Field.Text(o)` | a string | `required`, `max` (characters) |
| `Field.Int(o)` | a whole number | `required`, `min`, `max` |
| `Field.Number(o)` | a number | `required`, `min`, `max`, `decimals` |
| `Field.Bool(def, o)` | `true`/`false`, and SQL's `0`/`1` | |
| `Field.Date(o)` | `"YYYY-MM-DD"`, checked against the calendar | `required` |
| `Field.Time(o)` | `"HH:MM"` or `"HH:MM:SS"` | `required`, `min`, `max` |
| `Field.DateTime(o)` | `"YYYY-MM-DDTHH:MM"` or `"…:SS"`, with `Z`/`±HH:MM` kept as written — what an XML `dateTime` is | `required`; `min`/`max` over local time only, since a text order over moments is a wrong answer |
| `Field.Enum(values, def, o)` | one of `values`; the list is what `PropertyOptions` hands out | `required` |
| `Field.List(item, o)` | an array, each entry through `item` — a `Field`, or a `Record` class for a list of records | `required`, `max` (entries) |
| `Field.Record(of, o)` | another record: the class, or `() => the class` for a shape that contains itself | `required` |
| `Field.Decimal(o)` | a [`Decimal`](#decimal) at a fixed scale, from text, a number or a decimal | `required`, `min`, `max`, `decimals` (2 by default) |

| On a record | |
|---|---|
| `new C({ Name: "Ana" })` | through the setters, so every value is checked |
| `Apply(values)` | the same, by **property** name |
| `Serialize([all])` | a plain object; what differs from the start, or everything |
| `toJSON()` | so `JSON.stringify` and `File.SaveJson` are the record |
| `Clone()` | a copy, for the dialog that edits one: written and read back, so it is what saving and loading would have produced |
| `Validate()` | **the state**: what is wrong with what it holds *now*, as a list, without throwing |
| `Problems` | **the report of one `Load`**: what the file said that could not be taken (read-only) |
| `PropertyNames()`, `PropertyOptions(name)`, `Dump()` | as a widget answers them |
| `C.Load(json)` | a file, read leniently: see below |
| `C.LoadXml(node)` | the same for an XML document or element, with the same `Problems` |
| `ToXml([all])` | → a new element: what differs from the start, or every field |
| `SaveXml(node)` | writes **into** that element, touching only what the shape models |

**Assigning validates; reading a file does not stop.** A setter refuses what the
field does not accept and says what was wrong with the value — the same bargain
every setter in this runtime makes. `Load` is the exception, and deliberately: a
row that no longer satisfies today's rules must still be readable, or it can never
be corrected. So a value it cannot take leaves the field at what it starts from
and goes on `Problems`, and one bad key does not cost the other twenty.

**A key the record does not describe survives the round trip.** A manifest
carrying a field from a newer version must not be deleted by an older program that
saved it, so `Load` keeps what it did not understand and `Serialize` writes it back
after the fields it does.

### `Validate()` and `Problems` answer different questions

**`Validate()` is the state.** Recomputed every time, and it is what a Save button
and an error marked beside a field must ask.

**`Problems` is the report of one `Load`** — what the file said that this shape
could not take. Ask it once, after `Load`, and act on it then: a value the file
lost is a value the next save writes over, and this is the only place that says
so. **Nothing clears it**, not assigning to the field, not saving, not saving
successfully; it is a record of an act of reading and that act is over.

```js
const c = Client.Load(File.LoadJson(path));  // the file had name "" and balance -500
c.Problems   // ['Name is required -- left at ""', 'Balance: 0 at least, got -500.00 …']
c.Validate() // ['Name is required']            — 0.00 is a valid balance

c.Name = "Ayelén";                           // the user fills the form in
c.Validate() // []                              — correct: it is fine now
c.Problems   // still both sentences            — history, not state
```

A caller that wants both says so — `rec.Problems.concat(rec.Validate())` — which
is what the two places in this tree that report on *opening a file* do. Getting
this the other way round is a real bug and it is why the two are separate: a form
that validated with `Problems` refused to save a record the user had already
fixed, and showed `Name is required` against a field with a name in it.

### A record inside a record

A `Record` class is accepted wherever a field is expected, so master–detail is
**declared**:

```js
class Quote extends Record {
    static Fields = {
        Customer: Field.Text({ required: true }),
        Lines:    Field.List(Line),               // and not Field.List(Field.Record(Line))
        Ship:     Field.Record(Address),          // starts at null
        Bill:     Field.Record(Address, { def: { City: "CABA" } }),
    };
}
```

`Field.List(Line)` is the spelling to write; `Field.List(Field.Record(Line))`
means the same thing and is what it builds. Everything a shallow record promises
reaches through:

| | |
|---|---|
| `Serialize` | one object, each child in **its own** `Naming` and keeping its own unknown keys |
| `Load` | leniently, all the way down: a bad price costs that price, not the line, and not the file |
| `Validate` / `Problems` | every complaint at once, with the path in front of it — `Lines[2].Price: 0 at least, got -5`, by **property** name |
| `Clone` | deep, since it is `Load(Serialize(true))` |

**A record field starts at `null` — absent, not empty.** That is what a file
means by a key it does not have (a `.form` node without `children` has none), and
it is what lets a shape contain itself: a default that built an empty child would
build one forever. `def` is how a record that always has one says so, and it is
the ordinary common option rather than a special case — `{ def: {} }` for an empty
child, `{ def: { City: "CABA" } }` for a seeded one. **Do not ask for it on a
shape that contains itself**: that is the forever the `null` avoids.

**A shape that contains itself needs the thunk.** Inside a class body the class
is not bound yet, so `Field.List(Node)` written within `Node` is a
`ReferenceError`:

```js
class Node extends Record {
    static Fields = {
        Text:     Field.Text({ required: true }),
        Children: Field.List(() => Node),
    };
}
```

`static get Fields()` is the other tempting way to defer it, and it is
**refused**: a getter's descriptor has no `value`, so it used to declare no
fields at all, in silence.

**The thunk is also the answer to file order**, which is the case that bites
without any recursion in sight. A static field that mentions a class runs while
the class is being declared, so `Lines: Field.List(Line)` needs `Line` evaluated
first — exactly the dependency `extends` creates, and `project.json`'s `sources`
is where it is expressed (see [formats.md](formats.md#projectjson)). Get the order
wrong and it is `ReferenceError: Line is not defined` pointing at the
declaration, with nothing pointing at the load order. `Field.List(() => Line)`
has no such dependency at all: the class is not looked at until the first value
goes through the field.

**A list of records has no absent entries — it has fewer.** A `null` in one is
refused, where a `null` in a `Field.List(Field.Text())` becomes `""`; the
asymmetry falls out of the defaults, since a record field is the one whose own
starting value is null.

Two things nesting does *not* change. `push` goes around the setter, so a plain
object pushed into a list of records is answered by `Validate` (`Lines[1] is not
a Line`) rather than when it goes in — the same bargain `Field.List` always had.
And a record that really holds itself cannot be serialised, because JSON cannot
say it: it is refused with `<Class> contains itself` rather than hung on.

**A money field is `Field.Decimal({ decimals: 2 })`**, and there is no separate
`Money`, because money *is* a decimal with two places and saying so is one word
rather than a second name for the same thing. The places belong to the field and
not to the value — a column of prices all show two, so `19.9` arriving from
anywhere becomes `19.90` — which is what `NUMERIC(12,2)` means in a database.
`min` and `max` may be written as text, since comparing decimals is an operator.

It serialises as **text**, not as a JSON number: a number would be a double
again on the way back in.

**Names are a rule about the file, not a decision per field.** `Naming` says how
the file spells them — `lower` for a `project.json`, `snake` for SQL — once,
instead of an `as:` on every line. `as` is the exception for the field the rule
does not fit.

**A wrong declaration is answered before anything trips over it**, and there are
two moments, which is worth knowing when reading the traceback:

*While the class is being declared*, because `static Fields = { … }` runs the
factories: an option nobody has, an `Enum` default outside its own list, a default
an `Enum` default outside its own list, and `Field.List` or `Field.Record` handed
something that is neither a field nor a record class.

*At the first construction*, because that is when the fields are merged down the
chain and nothing else knows when a class was declared: something in `Fields` that
is not a `Field`, a `Fields` that is a getter rather than an object, a field
declared twice (once in `Fields` and once by hand), a `Naming` that does not
exist, a default the field itself would refuse (`Field.Int({ min: 1 })` starts at
0, and so does a `def` a child's own shape would not take), and a thunk that
answers with something that is not a `Record`.

The values live where only the runtime can reach them, which is what makes the
setter the only way in: there is no `customer._Name` to go around it with. See
[architecture.md](architecture.md#what-radjs-keeps-for-itself).

### A record over XML

XML is a **document** and JSON is a value, so a record does not "become" XML:
it **declares** the element it is. `static Xml` names the root, the fields name
their own children with the same `as`/`Naming` pair a column uses, and three
options cover what XML has and a plain object does not:

```js
class Task extends Record {
    static Xml = { Root: "Task" };
    static Fields = {
        UID:       Field.Int({ key: true }),               // the identity SaveXml matches by
        Name:      Field.Text(),
        Start:     Field.DateTime(),
        Milestone: Field.Bool(),                           // true/false out; true/false/1/0 in
        Links:     Field.List(Link),                       // repeated, no wrapper
    };
}

class Project extends Record {
    static Xml = { Root: "Project",
                   Namespace: ["http://schemas.microsoft.com/project",
                               "http://schemas.microsoft.com/project/2007"] };
    static Fields = {
        Author: Field.Text({ attribute: true }),           // Author="…"
        Tasks:  Field.List(Task, { in: "Tasks" }),         // <Tasks><Task>…</Task></Tasks>
        Tags:   Field.List(Field.Text(), { element: "Tag", in: "Tags" }),
    };
}

const p = Project.LoadXml(File.LoadXml("plan.xml"));   // lenient; Problems
p.Tasks[0].Name = "Analyse";
File.SaveXml("plan.xml", p.SaveXml(doc.Root));         // in place: only what it models
const fresh = p.ToXml(true);                           // a new element, every field
```

**`ToXml` is `Serialize` and `LoadXml` is `Load`.** `ToXml()` omits what is at
its starting value — **a `key` excepted: identity is written either way, and so
is `SaveXml`** — and `ToXml(true)` writes every field, which a schema whose
elements are not `minOccurs="0"` needs. `LoadXml` reads a document or element,
checks the root's name and namespace (a **list**, because an official schema and
the files it describes can disagree about the URI and both be right), takes what
fits, and reports what the shape does not model on `Problems` with the path in
front of it. A missing `Root` is not an error at declaration — a record is a
shape before it is a file — but `ToXml`/`SaveXml` refuse it and `LoadXml` says
so in `Problems`.

**`SaveXml` is the road an interchange file needs, and it is neither.** It
writes into the element it is handed and touches **only** what the shape models:
unknown elements, foreign namespaces and comments stay exactly where they were,
a missing modelled element is inserted in declaration order among the modelled
ones, a field back at its starting value has its element removed — **except a
`key`, which is identity and is written whatever it holds**, so the project
summary task keeps its `UID 0` and an element it matches keeps the children the
shape does not model — and a list is reconciled, matched by the record's `key`
(key text for key text, a key at its starting value included, because there is
no INSERT here to assign one) or by position, unmatched elements removed, new
ones added, the array's order the element order afterwards. `Table`'s *an int
key of 0 is a row never saved* is the database's rule and does not reach XML.
Writing into the wrong root is a **throw** and not a `Problems` line: the
lenient road is `LoadXml`.

**What is not modelled is reported, never silently written.** There is no bag of
raw nodes: re-emitting an unknown element at the end of an `xsd:sequence` is a
wrong answer that looks right, so the shape says what it dropped and `SaveXml`
is what preserves it. A scalar field reads its element's **text**, so an
attribute of that element, child markup inside it, or a second element with the
same name is reported too — those are things the shape is not taking.

[`examples/feeds`](../examples/feeds) is the first real caller: two shapes
(RSS 2.0 and Atom 1.0) over one list, and the window counts what either shape
could not take rather than hiding it. [`examples/gpx`](../examples/gpx) is the
second: a track whose points carry their position as **attributes** and whose
watch's `<extensions>` survive a Save that changes the name.

## Database and Table

A record over a table. Two halves, and the split is the point.

```js
class Client extends Record {
    static Naming = "snake";                      // the SQL spelling, said once
    static Fields = {
        Id:         Field.Int({ key: true }),     // the identity
        Name:       Field.Text({ required: true, max: 80 }),
        Balance:    Field.Decimal({ decimals: 2 }),
        PostalCode: Field.Text({ max: 8 }),       // ...is the column postal_code
    };
}

const db      = Database.Sqlite("data/sales.db");
const clients = db.Table("clients", Client);

const c = clients.Save(new Client({ Name: "Ana" }));   // INSERT; c.Id is filled
c.Balance = "1500.50";
clients.Save(c);                                       // UPDATE, by the key

clients.Find(c.Id)                       // one record, or null
clients.Where("balance > ? ORDER BY name", 0)
clients.Count("active = ?", 1)
clients.Delete(c)
```

**`Database.Sqlite` is a driver, and it is named for the library it is** because
half of what a driver does is not portable — the parameter marker, how a new key
comes back, where the metadata lives, and whether an exact decimal exists at all.
`Database` is the theme and each member is one driver; there is no
`Connection.Open`, because opening is the one operation that belongs to a driver
rather than to a connection. A driver's connections **are** `Connection`s and
inherit `Table` from it; the head of
[`bta_sqlite.c`](../runtime/src/bta_sqlite.c) has the per-engine table and what a
second driver has to provide.

`Table` reads what differs off `Dialect`, so a second driver changes nothing in
it:

| A driver answers | |
|---|---|
| `Query(sql, [params])` | rows, as plain objects |
| `Execute(sql, [params])` | `{ Changes, LastId }` |
| `Transaction(fn)` | all of it or none; nested through savepoints |
| `Columns(table)` | `[{ Name, Type, Required, Key }]` |
| `Tables` | tables and views, ordered |
| `Dialect` | `{ Placeholder, Quote, NewKey }` |

`Database.Sqlite` adds `Script(sql)` (several statements, no parameters — a
schema), `Path`, `Open` and `Close()`.

### Which of sqlite's types a field maps to

**Four of sqlite's five storage classes**, and the fifth is this runtime's gap
rather than sqlite's:

| field | column | |
|---|---|---|
| `Field.Text`, `Field.Enum` | TEXT | |
| `Field.Date` | TEXT | `"YYYY-MM-DD"`, which is sqlite's own date convention |
| `Field.Int` | INTEGER | and a key at 0 is a row never saved |
| `Field.Bool` | INTEGER | sqlite's `0`/`1`, which `Field.Bool` already took |
| `Field.Number` | REAL | a whole one binds as INTEGER: they are different storage classes, and a rowid written `3.0` is one no `= 3` finds |
| `Field.Decimal` | TEXT | the only standard type that keeps it exactly — see [below](#a-decimal-column-and-sqlites-limitation) |
| `Field.Record`, `Field.List` | *refused* | a detail is a table of its own |
| `Field.Bytes` | BLOB | a [`Bytes`](#bytes) in, a `Bytes` out. This was a refusal by name until there was a value to hand back — a BLOB returned as a string is corruption that reads like success |

### A row is a file

Nothing in `Table` converts a value, and it does not have to.
[`Load`](#record-and-field) already reads an object keyed by whatever `Naming`
spells, and a row **is** that object; `Serialize` already writes one with its
decimals as text, which is the one shape sqlite holds exactly. That is what
`Naming = "snake"` was written for, and it needed no changes to become the SQL
spelling.

Three consequences worth having:

- **Reading is lenient.** A column today's rules would refuse leaves its field at
  what it starts from and goes on `Problems`, so one bad value does not cost the
  other nineteen — the same bargain a file gets, for the same reason.
- **A column the shape does not describe survives the round trip.** It is read,
  kept and written back, so the first program to save a row does not empty it.
- **A `Field.Bool` and a `Field.Date` need no mapping at all**, because they were
  designed against SQL before there was any: a boolean already takes sqlite's
  `0`/`1`, and a date is already `"YYYY-MM-DD"`.

### `key`, and what falls out of it

`key: true` marks the identity, and it is on the **shape** rather than on the
source: identity belongs to the customer, not to the table it happens to be kept
in, and the same `Client` read from `clients` and from `clients_archive` is
identified the same way. More than one marked is a compound key, in declaration
order — and `Find` takes one value per key field, in that order.

**An `int` key at 0 — what the kind starts from — is a row that was never
saved**, so nothing needs a flag to tell an INSERT from an UPDATE. `Save` reads
it that way.

The corollary is the thing to know: a key the *program* chooses (a code somebody
types) is never at its starting value once it is filled, so `Save` will try to
update a row that is not there and say so. `Insert(rec)` and `Update(rec)` are
the explicit pair for that; `Save` is the convenience that picks between them.

A record with no key can be **read** and not written — an `UPDATE` with no
`WHERE` is not a fallback.

### The shape is checked against the table

On the first statement, once. Four ways a shape can fail to fit, and the third is
why the check exists:

| | |
|---|---|
| a field that is a record or a list | a detail is a table of its own, and saving one with its master is not built (see [plans/data-plan.md](plans/data-plan.md)) |
| a field with no column | named, with the columns the table does have |
| **a column spelled with another case** | SQL identifiers are case-insensitive, so `Code` against a column `code` *writes perfectly and reads empty*: the values land in the bag of keys the shape does not describe, nothing throws, and the first thing anybody notices is a form full of blanks |
| no such table | said here, rather than arriving from the middle of a generated statement |

### What it refuses, and what is not built

**Values are bound, never interpolated**, and there is no way from here to ask
for anything else — the runtime does the escaping so no program has to remember
to. A filter is SQL because SQL is the filter language and sqlite already says
what is wrong with one; a grammar of our own inside a value is what
[plans/data-plan.md](plans/data-plan.md) refused twice. `Execute` takes **one** statement,
because running the head of what it was given and reporting success is worse
than a complaint. An `Update` or a `Delete` that matched no row **throws**: a
save that saved nothing and said so is found days later by somebody looking for
what they typed.

There is **no lazy loading, no identity map and no session.** The machinery those
exist for is machinery to make lazy loading safe, and lazy loading is what turns
one screen into a thousand statements and hides it.

Not built yet, and named so it is not looked for: **a detail saved with its
master**, a cursor over a query for a grid, and a `.conn` file as a project
resource.

### A decimal column, and sqlite's limitation

**A `Table` uses sqlite's standard types and no format of its own.** A decimal is
held as **TEXT**, because that is the standard type that keeps it exactly:
`NUMERIC` and `DECIMAL(12,2)` are *affinities* and turn `'19.90'` into the REAL
`19.9`, the scale gone and the value binary — which is what most ORMs declaring a
`decimal` column actually get. `Table` refuses a decimal field over any column
whose affinity is not TEXT.

**The consequence is that sqlite cannot order or total such a column**: text
compares byte by byte, so `'9.00'` follows `'10.00'`, and `SUM` goes through a
double. That is a limitation of sqlite and it is not papered over — **the program
filters and orders**, which is what text ordering needs anyway:

```js
const rows = clients.All();
rows.sort((a, b) => a.Balance - b.Balance < 0 ? -1 : 1);   // exact, by value

let total = new Decimal("0", 2);
for (const r of rows) total = total + r.Balance;           // exact
```

And it is worth saying plainly: **if an application's core is money, sqlite may
be the wrong engine.** A driver over one with a real `NUMERIC` maps the same
`Field.Decimal` to a numeric column and every one of these statements works.

### Ordering and filtering a decimal in SQL: name the collation per statement

Every connection this driver opens has a `DECIMAL` collation, `decimal_cmp` and
`decimal_sum` registered. **Naming the collation in the statement gives you all
of it and costs nothing in portability**, because the schema stays plain `TEXT`
and only your own queries mention it. Measured:

```js
db.Query("SELECT money FROM t ORDER BY money")                  // -3.25 10.00 100.50 9.00
db.Query("SELECT money FROM t ORDER BY money COLLATE DECIMAL")  // -3.25 9.00 10.00 100.50

db.Query("SELECT count(*) AS n FROM t WHERE money > '9.00'")                  // 0
db.Query("SELECT count(*) AS n FROM t WHERE money > '9.00' COLLATE DECIMAL")  // 2

db.Query("SELECT MIN(money COLLATE DECIMAL) AS n FROM t")   // "-3.25"
db.Query("SELECT decimal_sum(money) AS n FROM t")           // "116.25", exact
```

and through a `Table`, which appends whatever SQL it is given:

```js
table.Where("1 = 1 ORDER BY money COLLATE DECIMAL")
table.Where("money > ? COLLATE DECIMAL", "9.00")
```

`decimal_sum` is a **window function**, so `decimal_sum(x) OVER (ORDER BY id)` is
a running total. `SUM`, `total` and `AVG` are the three built-in aggregates no
collation can reach — a collation compares and they add — and `decimal_sum`
answers for the first two. There is no `decimal_avg`: an exact average of
decimals is not a decimal, so it would have to round, and to how many places is
the caller's decision.

**What breaks compatibility is naming the collation in a *schema*, not in a
statement.** Measured from another client, against a file written with
`balance TEXT COLLATE DECIMAL`:

```
select count(*) from clients                  ok
select name from clients order by balance     no such collation sequence: DECIMAL
select min(balance) from clients              no such collation sequence: DECIMAL
create index i on clients(balance)            no such collation sequence: DECIMAL
```

A `.db` that only this runtime can query is not a `.db`. So: declare the column
`TEXT`, and say `COLLATE DECIMAL` in the statements that need it. The one thing
per-statement collation cannot give you is a useful **index** on that column,
which is what stage 3's cursor will have to answer.

The same three are also what read a decimal **somebody else** wrote as text.

## Http

A native HTTP client over libsoup3.
`Http.Client(opts)` holds its own `SoupSession`; `Http.Get/Post/...` are
shorthands on a shared default client.

```js
const api = Http.Client({ BaseUrl: "https://api.example.com/v1",
                          Headers: { Accept: "application/json" },
                          Timeout: 60000, FollowRedirects: true,
                          Auth: { User: "u", Password: "p" } });

api.Get("/users", {}, (r) => this.show(r.Body.ToText()),
                      (e) => Message.Error("{0}", e.Message));

// Both callbacks are handed the request's own handle as well, so a form with
// more than one in the air can tell whose answer arrived:
api.Get("/users", {}, (r, h) => { if (h === this.pending) this.show(r); });

const r = Http.GetWait("https://example.com/", { Timeout: 5000 });
// r = { Status: 200, Reason: "OK", Headers: {...}, Body: Bytes, Url: "final..." }
// ...and TimedOut: true in the one case where the answer and the guard tie

const up = new Multipart().Field("note", "hello")
    .File("scan", "a.png", File.LoadBytes("a.png"), "image/png");
api.Post("/upload", up, (r) => print(r.Status), (e) => print(e.Message));
```

Two callbacks, `Exec`-style: `4xx/5xx` go to `onDone` (it is an answer),
transport/DNS/TLS/timeout go to `onError`. `Body` is always `Bytes`: text via
`Body.ToText()` (strict UTF-8, throws), JSON via `JSON.parse` + `Record.Load`,
binary via `File.SaveBytes` / `Hash.Sha256(Bytes)`. An object passed as `body`
serialises canonical (`JSON.stringify(v,null,2)+"\n"`, the `File.SaveJson`
shape) with `application/json`; text defaults to
`text/plain;charset=utf-8`, `Bytes` to `application/octet-stream`. A
`Multipart` built with `Field`/`File` posts as `multipart/form-data` with
soup's boundary -- one upload posts twice, and a `ContentType` beside it is
refused rather than breaking the framing silently:

| | |
|---|---|
| `Client([opts])` | the options are an object -- a bare URL is refused, since reading it as "none given" configures nothing while looking like it worked. `BaseUrl` (ours; absolute URL wins; `/a/`+`/b`=`/a/b`), `Headers` (defaults, request merges and wins), `Timeout` ms (our guard+cancel; soup `timeout` stays 60s), `FollowRedirects: true` (→ inverted `NO_REDIRECT`), `Language` (→ `Accept-Language`), `Proxy: "default"` (system resolver) \| `null` (direct, no proxy) \| `"http(s)://..."` (one of your own), `Auth: { User, Password }` (Basic, preemptive; reads back `null` when none is set, like `Proxy`), `Cookies: false` (`true` keeps a jar of the session's own), `UserAgent` (sent as-is; `""` sends none), `Log: "none"` (`"minimal"`/`"headers"`/`"body"` send the traffic through `Logger` at `Debug`), `IdleTimeout` (ms idle before soup closes a pooled connection, `0` is soup's own 60 s), `MaxConns`/`MaxPerHost` (`10`/`2`; constructor-only, assigning later throws) |
| `Request(method, url, [body], [opts], onDone, [onError])` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`; anything else is refused naming what it accepts |
| `Get(url, [opts], onDone, [onError])` | no body |
| `Post(url, body, [opts], onDone, [onError])` | with body |
| `Put(url, body, …)`, `Patch(url, body, …)` | with body, like `Post` |
| `Delete(url, …)`, `Head(url, …)` | no body, like `Get` |
| `Stream(method, url, [body], [opts], onLine, [onDone], [onError])` | the answer **as it arrives**: `soup_session_send_async` instead of `send_and_read_async`, the `GInputStream` read through a `GDataInputStream` one line at a time, the next read armed only once the callback returns (which is the back-pressure). `onLine(line, handle)` per text line, newline stripped, blank lines included |
| `RequestWait(method, url, [body], [opts])` | blocking: answers with the record, **throws** on transport failure |
| `GetWait(url, [opts])`, `PostWait(url, body, [opts])` | blocking per verb |
| `PutWait`, `PatchWait` (with body), `DeleteWait`, `HeadWait` (without) | blocking per verb |
| Per-request `opts` | `Headers` (merge), `Query: {k:v}` (appended escaped), `Body`, `ContentType`, `Timeout` (guard only), `FollowRedirects` (request wins), `Auth` (request wins over the client's). Naming any of them makes the object options rather than a JSON body, in both spellings |
| `new Multipart()` | `Field(name, value)`, `File(name, filename, body, [contentType])` — a body for `Post`/`Put`/`Patch` (a `GET` carrying one is refused, since it would land in the options unheard); `Length` counts the parts, `Part(index)` reads one back as `{ Name, Filename, Type, Data }` |

The handle: `Running`, `TimedOut`, `Url`, `Method`, `Stop()` (→ bool). It is
also the **second argument** to both callbacks — `onDone(res, handle)`,
`onError(err, handle)` — because `Stop()` asks rather than undoes: a cancelled
request still answers, a turn of the loop later, by which time the request
that replaced it is already in flight. Comparing the handle handed in against
the one being waited for is how a form drops a stale answer
(`examples/jokes`).
`Stop()` cancels one live request → `Running=false`, `onError
{Kind:"Cancelled"}`; the guard instead sets `TimedOut=true` + `onError
{Kind:"Timeout"}`. `onError` is `{Message, Kind, Status: 0}` with `Kind` one of
`Timeout|Dns|Tls|Refused|Cancelled|Redirect|Error`, and the message names the
caller (`Http.Get: cannot reach '...': ...`). What a `Wait` **throws** carries
the same `Kind` and `Status` on it, so a `catch` can tell a name that does not
resolve from a deadline without reading the prose back. A callback is required
(`a callback is required: http is async`); `Wait` takes none. `Headers must be
an object`; a relative URL with no `BaseUrl` is refused where it is asked.
`Wait` freezes the window like `Exec.Wait` — no handler runs inside it.

`Stream` is the only verb that answers before EOF, and it keeps five promises.
The end is the ordinary `onDone` with an **empty `Body`** -- what already went
out line by line is not sent twice, and `http_response_object` builds that for
free from a NULL `GBytes`. **Only a 2xx streams**: the status is known when
`soup_session_send_finish` returns, which is the one moment the destination of
those bytes can still be chosen, so a `4xx`/`5xx` is spliced whole into memory
and delivered the way `Get` would have, `onLine` uncalled -- a line arriving at
all means 2xx. `Timeout` is unchanged and means the whole flight, so a live
feed asks `Timeout: 0`; but what arrived before a guard or a `Stop()` **stays
arrived**, which is what the buffered road cannot do. `Stop()` from inside
`onLine` is safe (the `File.Watch` `calling`/`dead` mold) and answers a turn
later as `Cancelled`, since the freshly armed read completes cancelled. There
is no `StreamWait`. A body that is not UTF-8 ends the flight through `onError`
rather than arriving as mojibake. And `bta_http_pending` counts a live feed, so
a console program following one does not return from `Main` until EOF or
`Stop()`.

Honest limits: `404 goes to onDone`, `Wait freezes`, `cancel calls onError
Cancelled`, `a streamed Body is empty`, `only a 2xx streams`, `Timeout cuts a
stream too`, credentials never belong in a `.form`. `Auth` is Basic sent
preemptively -- libsoup3 has no session `authenticate` signal (connecting one
is a `GLib-GObject-CRITICAL`), and its replacement wants a challenge round
trip; a 401 from anything else is answered, like any other status. An explicit
`Authorization` header wins over `Auth`, and an explicit `Content-Type` header
wins over the one the body's shape implies: the specific spelling beats the
general one, both times. A response's repeated header keeps the last of them
(`Headers` is an object, and `Set-Cookie` is what repeats -- which is what
`Cookies: true` is for). Nameless clients get refused out in the wild: one echo service
answers no `User-Agent` with a 402 and no body, which is why the knob exists
(`examples/session` names itself). `Log` never spews on its own: traffic
arrives as `Debug`, so `Logger.Level = "Debug"` shows it and a `Handler`
takes it -- except a `Wait`'s, which never reaches a `Handler`, since its
context is private and its caller is blocked mid-call. Without `Cookies`
every request travels
alone: a `Set-Cookie`
answer is kept nowhere, so the next request sends nothing back -- which is the
default, and what a login flow turns on. libsoup is optional at build time
(`BTA_HAVE_SOUP`); without it `Http` exists and says which package is missing.
`examples/http` (a console tool against a public JSON API), `examples/jokes`
(a window on JokeAPI: async on a form, cancelled on close) and
`examples/session` (auth plus cookies against httpbingo: login, prove the jar,
every verb) are the whole of it running.

## Http Server

Serving over the same transport, answered on the loop the application already
runs -- which is why there is no affinity question here: creation and dispatch
share the default context by construction, the thing `Wait` needed two
sessions for.

```js
const srv = Http.Server({ Port: 8080 });
srv.Request = (req) => {
    if (req.Path === "/hi" && req.Method === "GET") req.Answer(200, "hola");
    else req.Answer(404, "nope");
};
srv.Start();   // throws naming the GError: a busy port says which one
```

| | |
|---|---|
| `Server([opts])` | the options are an object, like the client's -- a bare port is refused. `Port` (`8080` unless told, `0` ephemeral and read back after `Start`), `Host: "local"` (loopback only) \| `"any"` (all interfaces -- an explicit word, since binding the world by default is the footgun), `ServerName` (the `Server:` header; `""` for soup's own), `Tls: { Cert, Key }` (files; `https` when set, missing ones fail at `Start` naming them), `Allow` (exact IPs, or nothing which is open -- refused remotes get `403` before the handler runs), `Auth: { Realm, Users }` (Basic over the whole server; nothing set is open, and `Auth`/`Tls` read back `null` when they are). `Allow` matches an address exactly, so a `Host: "any"` server on a dual-stack machine sees `::1` and `127.0.0.1` as two different remotes |
| `Request` | assign `(req) => …`; required before `Start` (`Request is required`), replaceable while running; anything but a function is refused |
| `Start()` | listens now; a second `Start` while running is refused rather than rebound. `Port`/`Host`/`ServerName` apply here, so re-`Start`ing moves the server |
| `Stop()` | `true` while something was listening, `false` after -- the `Exec` mold |
| `Running`, `Port`, `Url` | `Port` is declared until `Start`, actual after; `Url` is `""` until then, and empty again after `Stop` |
| `req.Method`, `req.Path`, `req.Query`, `req.Headers`, `req.Body`, `req.Remote` | `Headers` lower-cased and `Body` always `Bytes`, like the client's answers; `Query` repeats keep one; `Remote` is the IP, for the log line |
| `req.Multipart()` | the upload parsed into a `Multipart` (`Part(index)` reads `{ Name, Filename, Type, Data }`); refused on a plain body |
| when it applies | `Port`/`Host`/`Tls`/`ServerName` apply at `Start`, so re-`Start`ing moves all of them; `Allow`, `Auth` and `Request` take effect at once, which is what makes banning mid-run possible |
| `Answer(status, [body], [opts])` | `body` follows the client's rules (an object serialises canonical); `opts` carries `Headers` and `ContentType`. Positional, so a JSON body never reads as options: the second argument is always the body, the third always the options |
| second `Answer`, late `Answer` | refused (`already answered` / `already ended`); a handler that returns without answering gets a `500` |

**The handler answers before it returns.** There is no deferred answer yet, so a
route that has to ask a database or another server first has nowhere to wait: a
`Wait` inside the handler would freeze the very loop the server answers on, and
returning to answer later gets the `500` above. Handlers serve what is already
in hand. libsoup can pause a message and it is what a later phase would build
on; today it is a limit worth knowing before designing a route around it.

A listening server counts like a watch: a console project that returned from
`main` with one running stays for its requests, and `Application.Quit(code)`
still ends it. Dropping a server without `Stop` disconnects in the finalizer,
or the port stays held past the program. `examples/serve` is a static file
server in ten lines of handler: routing, `Bytes` straight from disk to socket,
and statuses. It carries no `".."` refusal, and says why -- soup normalizes a
request's dot-segments before the handler runs, so `/a/../../x` arrives as
`/x` and a guard for it would be dead code teaching the wrong lesson.

## Printer

What this machine can print on, and the two ways a drawing gets there. It is in
`bta_printer.c`.

**A theme and not a verb on a control.** `Save`, `ToPng` and `SavePdf` are the
drawing's own -- they write what it *is* -- but a printer is a thing outside the
program, with a name, a default and a dialog, and those questions do not belong
on a widget. `Printer` and not `Print` because `print` is already a global here,
and because `Print` as a verb means writing text in the family this language
comes from.

```js
Printer.Names                                    // ["Ink-Tank-310", "Print to File"]
Printer.Default                                  // "Ink-Tank-310"
Printer.Send(this.Sheet, { Pages: 12 })          // the dialog, then a printer
Printer.ToFile(this.Sheet, path, { Pages: 12 })  // a PDF, and no dialog
```

| Member | |
|---|---|
| `Send(area, [setup], cb)` | the print dialog, then paper. **Async**; `cb({ Copies, From, To })`, and not called on a cancel |
| `ToFile(area, path, [setup])` | the same sheets as one PDF, no dialog. → how many pages |
| `Names` | the printers this session can reach. `[]` for none, `null` if this build cannot ask |
| `Default` | the one it would use. `""` for none, `null` if it cannot ask |
| `Papers` | `{ A4: { Width, Height }, … }` in points, read off GTK |

`area` is a control that draws. Its handler runs once per sheet against the
print context, and the sheet arrives as an argument:
`DrawPage(painter, page, width, height)`, falling back to `Draw` for a form that
declares none. The frame is the printable area in **points**.

**And how many sheets there are is asked**, because it depends on the paper the
dialog settles on: a control may declare `Paginate(width, height)` and answer its
count at that size, and `Printer` asks it in `begin-print` -- the only moment the
paper is resolved and the count can still change. Declare none and the `Pages`
given stands, which is right for a layout that does not move with the paper
(`lib/report` scales, `lib/markdown` re-flows). It runs inside the print
operation: measure freely, raise no events.

| Setup | |
|---|---|
| `Pages` | how many sheets, 1 to 10000. Default 1 |
| `Paper` | `A4`, `Letter`, `A5` |
| `Orientation` | `Portrait`, `Landscape` |
| `From`, `To` | the range; `To` defaults to the last page |
| `Copies` | **`Send` only** |

**Two verbs and not one with a destination.** As one call, `Copies: 3` with a
file answered *three copies sent* and wrote the same bytes as one copy -- a file
has no copies, so `ToFile` refuses the key. It is the split `Dialog.OpenFile`
and `Dialog.SaveFile` already are.

**`Names` and `Default` need `gtk4-unix-print`**, which is a GTK module of its
own; a build without it answers **`null`** -- a third value, because `[]` cannot
be told apart from a machine with no printer and a throw would make a capability
question something a program has to catch. Printing itself is core GTK and works
either way.

## AudioPlayer

Sound with no window, over GStreamer -- the `Video` widget's engine without
the widget. One playbin3 per player, with the video branch switched off and
never decoded, so several may play at once:

```js
const cue = new AudioPlayer();
cue.Uri = "done.ogg";
cue.OnEnded = () => print("ding");
cue.OnError = (msg) => print(`no cue: ${msg}`);
cue.Play();
```

| | |
|---|---|
| `new AudioPlayer()` | takes no arguments; everything is assigned, like `Video` without the frame |
| `Uri`, `User`, `Password`, `Latency`, `Volume`, `Muted`, `Loop` | as `Video`'s: a URI or a plain path, RTSP digest identity via `source-setup`, a write-only secret, the `rtspsrc` jitterbuffer in ms (`2000`), `0…1`, silence, reseek |
| `Position`, `Duration`, `Playing`, `Seekable`, `Buffering` | read-only facts about the stream; `Duration -1` is live or unknown, and `Buffering` is `0`…`100` with `100` meaning nothing to wait for |
| `OnEnded`, `OnError(message, kind)` | assign a function, `null` takes it off; anything else is refused where assigned. The DOM's `onended` spelling, since a player outlives any one `Play` and per-call callbacks would be the wrong shape |
| `Play()`, `Pause()`, `Stop()`, `Seek(seconds)` | as `Video`'s: replay from the top, hold, park, jump (refused where there is nowhere to go) |

**A playing player holds a reference to its own JS object**, released at the
end, at an error, or at `Pause`/`Stop`. Without it a cue was a local variable
and the shape a confirmation sound has -- `function ding() { const a = new
AudioPlayer(); a.Uri = "done.ogg"; a.Play(); }` -- played *nothing*: the
refcount hit zero on the way out and the finalizer stopped the pipeline. The
reference is deliberately invisible to `gc_mark`: it is the pipeline's claim on
the object rather than one the object owns, and a cycle detector that could see
it would collect exactly what it protects. It is also what makes `OnEnded`
safe to write anything in -- dropping the last reference from inside the
handler used to free the struct under the callback that was emitting.

Honest limits, shared with `Video`: `Seek` on a live stream is refused rather
than pretended; `Position` reads `0` when unknown, which includes playing live;
`Playing` is what `Play` asked for and not a sample of the pipeline, which
reads as stopped during a loop's flushing seek and while a network stream
refills; a paused player is a deliberate hold and keeps nothing alive.
Handlers are `Dup`'d and reported via `gc_mark` (a player whose `OnEnded`
closes over the player is the `Http` client's cycle again), and duplicated
again for the length of a call, so a handler may reassign itself.
`Error`/`OnError` carry a `kind` alongside the sentence -- `NotFound`,
`NotAuthorized`, `Unreachable`, `Decode`, `Error`, the `Http` client's
vocabulary and for the same reason. GStreamer is optional at build time
(`BTA_HAVE_GST`); without it the constructor says which package is missing,
the `Http`/`Database` mold, while a `Video`'s properties keep answering so the
designer and the serialiser do not depend on the engine. `gst_init` runs on
first use and not at startup: it reads the plugin registry, which is 6 ms warm
and 573 ms cold, and no program should pay that for a feature it never calls.
`examples/video` plays an audio-only clip from lorem.video through one.

## Others

- `print(...)` — a line to stdout. What a program that talks to a terminal
  writes; the test suites report with it.
- `BTA_VERSION` — the runtime version string.
- The language underneath: `JSON`, `Math`, `Map`, `Set`, `Date`, template
  literals, classes, destructuring, generators, and every ordinary object and
  array — but **not** all of what QuickJS can provide. What is installed and what
  is taken away is [above](#the-language-underneath).

**There is no `Promise`, so `async` and `await` are refused where they are
written.** It is the one omission that is a decision rather than an economy:
this is a language of events, and the sequences that would otherwise want a
promise are written as a chain of callbacks — `Exec`'s exit callback,
`Dialog`'s answer, `Timer.After`. Nothing drains a microtask queue because there
is no queue to drain.

There is no `window`, no `document`, no `fetch`, no `require`. `Http` above is
the one that speaks to a network.

## What rad.js adds to the prototypes

| | |
|---|---|
| `Widget.PropertyNames()` | every settable property, discovered along the prototype chain |
| `Widget.Declared(name)` | what the `.form` said, whatever has been put on it since |
| `Widget.Fill(...args)` | the declared `Text` as a template, filled in — so the template stays in the file |
| `Widget.SetDesign(name, value)` / `DesignValue(name)` | what the *designer* shows instead of the declared value; `""` removes it |
| `Widget.Serialize(parentIsFixed?)` | this widget as a `.form` node |
| `Form.Serialize()` | the whole file, keyed by class |
| `Form.SaveForm(path)` | `Serialize()` plus `File.Save`, pretty-printed |
| `Form.Controls` | every child bound to this form, in creation order |
| `Container.AddNode(node)` | build a live widget from a `.form` node |
| `Container.BuildChildren(node)` | replace the contents with the node's children |
| `Caption` | alias of `Text` on `Form`, `Label`, `Button`, `TextBox`, `CheckButton` |

`AddNode` / `BuildChildren` are the loader's job done in JS. Having both is what
lets the designer display a form it is not running, and lets undo be a snapshot of
the serialised tree instead of a list of inverse actions.

`Controls` is a view over the form's own widget-valued properties — everything the
loader assigned by name. `Children`, by contrast, is the real containment tree, one
level at a time.
