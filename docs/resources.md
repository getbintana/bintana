# Resources: text, translations, and what the designer shows

Android needs `R.string.save` because its resources are compiled into an APK and
addressed by an integer. Here the **project directory is the resource tree** —
`icons/` and `app.css` are found by name, with nothing in `project.json`
pointing at them, and nothing is compiled or packed. So of the four things
Android bundles under "resources", three were already answered:

| Android | Bintana |
|---|---|
| `colors.xml` | `app.css` plus `Style`, which is better: there is a cascade |
| `dimens.xml` | geometry is drawn, not typed; anchors and boxes do the work |
| `drawable/` | `icons/` plus `Application.HasIcon()` |
| `strings.xml`, `values-es/` | **this document** |

What was genuinely missing is the indirection that varies with the locale, and
one thing that has nothing to do with translation at all: a way to lay out a form
whose text the code fills in.

## Where the text is

In a RAD environment, writing text in code is the exception. The IDE — the most
code-heavy Bintana application there is — counts:

| Where | Strings |
|---|---|
| `Text`/`Tooltip` in the `.form` files | 78 |
| menu labels in the `.form` files | 52 |
| **declared** | **130** |
| `Message.*` with a composed template | 36 |
| `Message.*` with a literal | 13 |
| `AskForm`/`ConfirmForm`, whose prose is a `Locale.Text` at the call site | 7 |
| assignments to `.Text`/`.Tooltip` from code | 7 |
| **in code** | **63** |

Two things follow, and between them they decide the whole design. First, the
declarative side is where the weight is, so **a `.form` has to be translated
without asking**: JSON cannot call a function, and a scheme that needed one would
leave most of every application untranslated. Second, of the 63 in code, 56 are
messages and dialogs and only 7 touch a control's text — so "text in code" really
means *messages*, and they are overwhelmingly composed rather than literal.

## A position that holds prose

The unifying idea is not a helper. It is that **some positions hold text a person
reads**, and a position can be a property or an argument.

For properties it is one field in the class table, next to `options`:

```c
BTA_CLASS_TEXT("Button", "Control", build_button, button_props, false, "Text"),
```

`Widget.TextProperties()` publishes it, accumulated along the class chain — a
Button's are its own `Text` plus `Widget`'s `Tooltip`. **One declaration, three
consumers**: the loader looks the string up in the catalogue, the property grid
offers a design value for it, the extractor collects it. None of them keeps a
list of its own that can drift from the widget set.

It is declared per class and never deduced from the name, and that is the point
rather than a detail:

> `SourceEditor.Text` is the source file being edited. A catalogue holding a line
> of it would rewrite the user's code — silently, and only for whoever runs in
> that language.

`Terminal.Text` and `TreeView.Text` are read-only and excluded for free. `Style`,
`Icon` and `Font` hold names that look like prose and are never looked up.

For arguments it is the same idea by hand, in the two places the runtime owns:

```js
Message.Info("Saved");
Message.Error("Cannot open {0}: {1}", path, e.message);
```

The first argument of a message is a declared position, so it goes through the
catalogue and takes `{0}`-style arguments of its own. That is why a message needs
no helper around it, and why interpolating *there* rather than at the call site
matters: a template literal would arrive already filled in, and no catalogue
could ever match it.

**A project's own function is not on that list**, and cannot be: `ConfirmForm` is
a form of the project's, and giving the IDE a way to declare argument positions
would be exactly the privileged API the one rule forbids. Those get the helper —
and every call site does wrap, which is what the two entries in `Strings.js`'s
`CALLS` are for: the helper does not translate by itself (what it passes reaches
a form's `Text`, which only the `.form` loader puts through a catalogue), so the
entries are the lint that catches an unwrapped literal at one of those
positions, and the extraction is `Locale.Text`'s.

## The helper, for the residue

```js
Locale.Text("Saved in {0}", this.path)
Locale.Plural("{0} file", "{0} files", n)
Locale.Context("verb", "Open")
Locale.Current                    /* read and write */
Locale.Available
```

Plain functions. The msgids come **first** in `Plural`, as they do in `ngettext`,
and that is not cosmetic: an extractor has to find both literals, and with `n` in
front it would have to skip an arbitrary expression — `this.files.length`, a
call, a sum — to reach the first one. `n` fills `{0}` without being passed twice.

`{0}` and not `%s` because a translator has to be able to move the holes; the
test catalogue does exactly that, turning `"{0} files, {1} unsaved"` into
`"{1} sin guardar de {0}"`.

## …and the template can be declarative too

If the text lives in the form, the text *with holes* can too:

```json
{ "type": "Label", "name": "LblStatus",
  "properties": { "Text": "{0} files, {1} unsaved" },
  "design":     { "Text": "12 files, 2 unsaved" } }
```

```js
this.LblStatus.Fill(this.files.length, this.dirty.length);
```

The template is translated on load, shown in the grid, extracted with everything
else, and the code passes **data rather than prose** — which is the RAD bargain,
and the reason the most common excuse for writing text in code goes away.

`Fill` re-reads the declared template every time instead of keeping one, so
calling it twice does not fill in its own output. It is called `Fill` and not
`Format` because `Format` is already a `DatePicker` property, and a method that
shadows a property breaks silently the moment a `.form` assigns it.

## The catalogue is a .po

```
myproject/
  po/
    es.po
    pt_BR.po
```

Found by name, like `icons/` and `app.css`. The **literal is the key** — gettext's
bargain and Qt's — so a form reads as prose with no indirection, an untranslated
application shows real text rather than `@string/save`, and two forms that both
say "Save" share one entry without anybody arranging it.

**The `.po` and not the `.mo`.** A project directory holds sources; nothing in it
is generated or compiled, and a catalogue is no exception. The cost is parsing a
text file at startup rather than mapping a hash table, which for a few hundred
strings is not measurable. What it buys is that the file in the tree is the same
file Poedit and Weblate edit — `.mo` is only `.po` compiled — so the whole
ecosystem works without this runtime knowing any of it exists.

Which catalogue starts in use is the first of the desktop's languages the project
has a file for: `g_get_language_names()` hands back the whole ordered list a
locale implies (`es_AR.UTF-8`, `es_AR`, `es`, `C`), so a project shipping only
`es.po` serves an Argentine desktop with nobody listing the variants. Assigning
`Locale.Current` reloads, and **only affects what is built afterwards** — a form
on screen holds strings, not references to a catalogue.

A fuzzy entry is dropped (a tool guessed it and nobody confirmed, so showing it
is worse than showing the original) and so is an empty `msgstr`, which is what a
freshly extracted catalogue is full of.

### The plural rule is evaluated

A `.po` header carries its language's rule as a C expression over `n`:

```
"Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\n"
```

There is no way around evaluating it. `eval` is not part of this language, and a
table of known languages would be wrong for the next one — so
`runtime/src/bta_locale.c` parses it. The grammar is small and closed: C's
conditional expression over one variable and integer literals, and nothing in it
can reach out. Integers are read digit by digit rather than with `strtol`,
because GTK has called `setlocale()` by then and a catalogue header is not the
desktop's to spell.

## The trap all of this had to be built around

The serialiser reads the **current** value of every property. So a form opened in
Spanish and saved would come back with the Spanish in it and the original gone.

**That is the `Width`/`Height` trap wearing a different hat** — today's
substitution written down as tomorrow's declaration, exactly as saving an
allocation turned a measurement into a floor.

So a substitution leaves a note of both values, and `collectProperties` writes the
declared one back — *as long as what was applied is still what is there*. Anything
that assigned since is the newer truth and wins, which makes it self-correcting:
the property grid never has to tell the serialiser it edited something.

```js
this.Lbl.Declared("Text")     // what the .form said, whatever is on it now
```

## What a translator is allowed to decide

Two things, and the second is why controls have no mnemonic.

**Which letter is a menu's accelerator.** The `_` marker travels inside the
msgid, so it is the catalogue that places it: `_File` becomes `_Archivo`, and
`F_orm` moved its underscore to `F_ormulario`. That is correct — the letter has to
be one that exists in the translated word — and it works, because a menu bar is
five curated titles.

**And that is exactly as far as it goes.** A mnemonic on a *control* would put the
same marker in every caption on every form, and then two controls on one dialog
can claim the same letter in one language and not in another — rendering
perfectly, with one of them simply never answering. Nothing in the runtime could
say so, and nothing in a `.po` looks wrong. Five titles a translator can hold in
their head; a dialog of twelve fields across a dozen languages nobody can.

The decision and the prior art behind it — Gambas dropped control mnemonics and
kept `Menu.Shortcut`; the accessibility argument for a label pointing at its field
was never verified — are in the README's known limitations. What a control gets
instead is a menu item with a `shortcut`, which is a real accelerator, is declared
outside the prose, and takes a list so a desktop stealing one key does not take
the command with it.

## Design values

A design value is what the **designer** shows so a form whose text the code fills
in can still be laid out. Android's `tools:text` is the same idea; `strip` is the
precedent for a node key that is neither a type nor a property.

Nothing here can reach a running application, and that is structural rather than
a check: the only code that applies a design value is `AddNode`'s designing
branch, and the C loader has no idea the key exists.

```js
container.AddNode(node, true)   // true = a drawing of an application, not one
```

Two things follow from that flag and both matter. Prose is left as the file wrote
it, so a designer running in Spanish cannot bake a translation into a form it
saves. And the `design` block is applied over the properties.

**Lorem is not a runtime feature.** The property grid's sample button writes
*literal words* into the `design` block, so the file holds text rather than an
`@sample/lorem` the loader would have to understand. Nothing to resolve, nothing
to invent, and the sample is stable between runs — which is what makes two
screenshots comparable.

## Extraction

`Project > Update translations` in the IDE walks the project and writes
`po/<name>.pot`, then runs `msgmerge` over whatever catalogues are there.

The half that matters is the one no existing tool can do: **walking the `.form`
files.** `xgettext` reads JavaScript and knows nothing about a widget tree, and
that is where 130 of the IDE's 193 strings live.

**It deliberately does not merge.** Keeping a translator's work while strings come
and go is `msgmerge`'s whole job and what every gettext project already uses;
a second, worse copy of it here would be the wrong kind of ambition. With
gettext-tools absent the `.pot` is still written, which is exactly what Poedit's
"update from POT file" wants.

Which properties hold prose is asked of the runtime — `Widget.New(type)
.TextProperties()` — never matched against a list of names in the IDE. A widget
added in C is extracted with nothing changed. A project's own component is the one
thing that cannot be asked, for the same reason the designer cannot build one, and
its captions are declared in its own `.form`, which the walk reaches anyway.

### The catalogues in the tree

A `.po` belongs to the project, so the project tree lists it — under a
**Translations** category of its own rather than in "Other", because it is not
opened the way everything else there is, and at the top level rather than under a
`po/` node. A folder earns a place in that tree by being where the programmer put
the file; `po/` is a place the runtime looks in, so showing it would be one
category wearing two labels.

**It does not open in a code tab, and that is the point.** A catalogue is text,
so a tab would work, and that is exactly the hazard: Poedit saving underneath a
stale tab, or `Update translations` rewriting the file while a tab holds the old
content, loses a translator's work in the ordinary course of using both — and the
IDE runs `msgmerge` over these files itself. Two editors over one file is a
hazard the IDE would be creating, so it does not offer the second one.
`EDITABLE` says as much: the value for `po` is `false`, which means *listed, not
opened as text*. It opens in the catalogue editor below instead.

So the gestures split, the way a file manager's do:

| | |
|---|---|
| single click | selects it, and the status bar names the gesture |
| double click, or Enter | a `.po` opens in the catalogue editor; a `.pot` starts a translation |
| tree menu → *Edit translations* | the same, for the hand that does not think to double click |
| tree menu → *New translation from this template…* | on the `.pot` |
| tree menu → *Open in external editor* | hands it to Poedit instead |

**A `.pot` and a `.po` are not the same file and do not do the same thing.** Every
msgstr in a template is empty by definition, so there is nothing in it to edit,
and opening one in the catalogue editor would only offer to write translations
into a file the next extraction overwrites. What a template is *for* is starting
a translation, so that is what activating one does.

Selecting cannot launch anything: selection moves with the arrow keys, and a tree
that spawned Poedit once per row walked through would be unusable. And a click
that appears to do nothing is worse than either, which is what the status bar
line is for.

The tree's menu acts on the file that is **open** — a right click does not move a
`TreeView`'s selection, so an item aiming at the row it was opened over would act
on whichever row was selected last. A catalogue is never open, so it gets a word
of its own (`ide.selectedCatalogue`), set by the left button and released the
moment anything else is selected. Still *select then ask*, and still only ever
what the left button pointed at.

### Editing one here

`ide/forms/PoForm.js` — a window of its own, which is `MenuForm`'s shape and for the
same reason: a third kind of tab would touch how every tab is placed, saved,
marked dirty and closed, for a file most projects have two of.

```
┌ Translations — po/es.po ─────────────────────────────────┐
│ 1 of 7 left to translate            [x] Only untranslated│
├──────────────────────────────────────────────────────────┤
│   Hello Bintana                                          │
│   Your name:                                             │
│ ● Upper case                    ● nothing in it          │
│ ~ Greet                         ~ needs work             │
├──────────────────────────────────────────────────────────┤
│ Source                                                   │
│ Upper case                                               │
│ Translation                                              │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Mayúsculas                                           │ │
│ └──────────────────────────────────────────────────────┘ │
│ [ ] Needs work                                           │
│ Form1.form: CheckBox1.Text                               │
│                                    [  Save  ] [ Close ]  │
└──────────────────────────────────────────────────────────┘
```

**What it does not do is the interesting half.** No translation memory, no fuzzy
matching against similar strings, no machine translation, no format checks —
those are what Poedit is actually good at, and it is one menu item away. What
this covers is the case a RAD flow really produces: the strings of your own
application, edited where you already are.

Details that are decisions rather than accidents:

- **The boxes are `TextEditor`s, not `TextBox`es.** A translation may have
  newlines and a `GtkEntry` cannot hold one — it would drop them on save,
  silently, which is the single thing this must not do.

  They are the *plain* editor now, and until there was one they were the source
  editor wearing three lines of apology — `Language = ""`, `ShowLineNumbers =
  false`, `Wrap = true`. This form is the reason `TextEditor` exists as a control
  of its own: the IDE needed a multi-line prose field and the widget set had
  none, which is exactly the kind of gap the rule about the IDE having no
  privileged API is meant to surface.
- **They are built once**, `nplurals` of them, and shown or hidden per entry.
  Rebuilding an editor takes the focus and the caret from whoever is typing and
  throws its undo history away; the property grid learnt that twice.
- **The list row is only rewritten when its mark changes**, not on every
  keystroke. With the filter on, refilling as you type would take the row out
  from under the cursor at the first character.
- **The X and the Close button ask the same question**, and they did not always.
  The X saved behind the translator's back, because a form could not refuse to
  close and keeping the work was the better of two surprises. `Form_Close` is a
  veto now, so both ways out put up the same dialog — *Close without saving*,
  *Save and close*, or cancel — and there is one answer to what happens to unsaved
  work instead of two.
- **`Update translations` refuses while an editor is open.** `msgmerge` rewrites
  these files, and the open editor holds the entries it read: saving afterwards
  would put them back over the merge.

### Starting a translation

*Project > New translation…*, or activating the `.pot` in the tree. It asks for a
locale, copies every entry of the template, and writes `po/<locale>.po`.

Two things it has to get right, and they are the reason this is not a file copy:

**The name has to be a locale.** `po/Español.po` is a catalogue nothing will ever
load — `g_get_language_names()` never answers that — so a name that is not a
locale is refused where it is typed rather than discovered later as a translation
that silently never appears.

**The plural rule is a property of the language and cannot be worked out.** How
many forms a language has, and which one a number takes, comes from gettext's own
table; `PLURAL_RULES` in `ide/modules/Translations.js` carries the common ones, the exact
locale beating its base so `pt_BR` differs from `pt`. It matters beyond the
header: a plural entry is given one `msgstr[n]` slot per form *that* language has,
so a three-form language does not start life unable to say its third. An unlisted
locale starts at the English rule, which is visible in the header immediately and
is the first thing a translator would fix.

Everything else is carried over untouched, and the translations are blanked — a
template's are empty already, and blanking is what makes this predictable if one
ever is not.

### Which program opens one

```js
Application.HasCommand("poedit")     // the same question HasIcon answers
```

Chosen the way an icon is: `poedit`, `gtranslator`, `lokalize`, `virtaal`, then
`xdg-open` — the first the desktop actually has. `xdg-open` is last because a
translation editor is a better answer than a text editor when both are installed,
and it is *there* because "whatever this desktop associates with a `.po`" is a
real answer.

`Application.HasCommand` exists because `Exec` **throws** when the program is not
there, so without it the only way to find out is to try and catch — an exception
used as a question. It answers about an absolute path too, by looking at the file.

*Project > Translation editor…* overrides the choice, and it is kept in
`Settings` and not in `project.json`: a path to a program on this machine is not
a property of the project, and putting it in the manifest would commit one
person's setup to everybody's checkout. A configured command that has since been
uninstalled falls back rather than failing — the setting is a preference, not a
promise about the disk.

### The lint

Two silent failures the IDE is the only thing in a position to notice:

- **A template literal in a position that holds prose.** The msgid arrives
  already interpolated, so no catalogue can ever match it, and nothing says so at
  runtime. Reported only when the literal parts contain letters:
  `` `${key}: ${e.message}` `` is punctuation around two values and has nothing
  to translate — warning about that is how a lint gets switched off.
- **A literal assigned to a text property from code.** In a RAD project that is a
  caption that escaped the designer: it is in no `.form`, so no translator sees it
  and the property grid cannot show it either.

This is the same shape as the walk over every declared `Icon` in `tests/ide`: the
answer to a silent failure is to *find* it, not to make it impossible.

## The IDE is translated, and that is what proved the rest

`ide/po/es.po` is the IDE in Spanish, 163 strings, and translating it was worth
more than having it: **it found four kinds of string that escape the system**, and
each one is a silent failure — the application works, in one language, for ever.

| What escapes | How it was found |
|---|---|
| A msgid built by **joining two literals** (`"part " + "two"`) | The extractor wrote `"There is no template yet. Run Project > Update "` into the `.pot`. Worse than a template literal, because it looks like a valid entry: a translator translates it and it never matches |
| A **template literal in a `Message.*`** | 34 of them in the IDE. The msgid arrives already filled in |
| A **template assigned to a text property** (`this.Text = \`… ${x}\``) | Every menu came out in Spanish and the window title stayed in English |
| Text passed as a **method argument** (`FileTree.Add(key, text)`) | The whole project tree read *Forms / Components / design / code* under a Spanish menu bar |

The first three are now lint rules. The fourth is not, and cannot be by the same
means: a position on a *method* is not something a class declares, and the lint
would have to know that the second argument of `TreeView.Add` is prose. It is the
one gap left, and worth naming rather than papering over — the IDE's own were
wrapped by hand.

After that sweep: **163 strings extracted, 0 warnings.** Which is the number that
says the mechanism reaches everything the IDE shows.

### Layout is the other half, and it is measurable

Spanish is longer, and `examples/i18n` exists to say by how much and what breaks.
The same three buttons — `Item`, `Submenu`, `Rule` → `Ítem`, `Submenú`,
`Separador` — laid out four ways, with a rule drawn where each row's room ends,
and a report of what each button actually measured:

```
                              msgid          translated
1 coordinates, no slack       fits           OVERFLOWS its room by 5px
2 coordinates, with slack     fits           fits
3 horizontal box              as needed      as needed
4 box, homogeneous            as needed      as needed
```

Row 1 is the shape the IDE's own menu editor has: three buttons whose declared
widths add up to exactly the width of the list above them. **A declared `Width` is
a minimum, not a size** — so a row with no slack does not clip when the text grows,
it *overflows*, into whatever is beside it. `Rule` draws 50px wide and `Separador`
draws 72.

### …and one thing that was the runtime's fault

The example's second form, *Anchors*, found a real bug rather than a design that
was too tight. A form whose caption outgrew its declared width **opens wider than
it was drawn** — `Fixed` reports the bounding box of its children's minimums, so
nothing clips. The surface then latched that wider size as the size the
coordinates were written against, which made every anchor inert: the slack existed
and nothing used it.

The IDE's own *New translation* dialog is where it shows. Declared 380 wide, it
opens at 432 because the prompt is longer in Spanish, and the input stopped **77px
short** of the edge while the buttons sat **85px** left of the corner.

Two changes in `runtime/src/bta_fixed.c`, and the second is not optional given the
first:

- **A form's declared size is the anchor origin**, and the first allocation is
  only the fallback. Only a form's, because a `Width` inside a box is a minimum
  rather than a size.
- **The floor is applied after the anchor, growing away from the anchored edge.**
  Otherwise a control that outgrew its declared width takes its own growth *and*
  the whole slack, and ends up past the edge it is anchored to.
- **A `Fill` child's far-side gap counts when the surface measures itself.**
  Otherwise the control that grew pushes by exactly its own growth and ends up
  flush against the frame while everything beside it keeps the margin — which is
  what the dialog looked like after the first two fixes: a prompt touching the
  edge over an input that stopped short.

Measured after: every `End` anchor keeps the gap it was drawn with — including the
button that grew from 120 to 143 — `Center` moves half the slack, `Fill`
stretches, and the pushed dialog lays out exactly as the design does, only wider.

## What was rejected

| Rejected | Why |
|---|---|
| `strings.json` with `@string/save` | A format to invent, tooling to write, and a small language inside a value — which was already refused for `Source` in [plans/data-plan.md](plans/data-plan.md). The `.po` is the central list of UI strings that keys were supposed to buy |
| Translating in the **setter**, so `this.Lbl.Text = "Save"` needs nothing | Tempting, and fatal: `this.Lbl.Text = customer.Name` would look a customer's name up too, so a client called "Open" comes out translated. A bug in one record in a thousand, impossible to explain. **A translation has to be marked where the literal is written, or data joins the catalogue.** The population flowing through `Message.Error` is small enough that the same reasoning goes the other way there |
| A method on `String` (`"Saved {0}".T(x)`) | Patching a built-in prototype, and it invites `variable.T()` — the same footgun with less signal |
| `_()`, the gettext spelling | Breaks the convention that every global here is capitalised, and — worse — its natural JS spelling is the broken one: everybody writes the backtick, and the translation dies in silence |
| A tagged template (`` T`Saved in ${p}` ``) | It makes the mistake *impossible* rather than reported, which is real. But it forces `T.Plural` — a function with properties hung off it, a shape that exists nowhere else in this runtime — and a lint gets the same result the way this codebase already answers silent failures |
| ICU MessageFormat (`{0, plural, one {…}}`) | A whole grammar inside a string, to solve what one argument to `Locale.Plural` solves |
| A `colors.json` | `app.css` and `Style` already are it, and GTK has `@define-color` for the palette |
| Compiling `.po` to `.mo` at load | A generated file in a project tree, against the rule that holds for everything else in it |

## Staging, and what is not built

Built: `TextProperties()`, the `.po` reader, `Locale` (including `Locale.Read`,
`Locale.Number`, `Locale.Date` and `Locale.Currency`),
translation on load (properties and menu labels), the declared-value note,
`Declared`, `Fill`, the `design` block, `SetDesign`, the property grid's design
mode and sample button, `TextBox.Placeholder`, the extractor, the lint, the
catalogues in the project tree, `Application.HasCommand` with the external editor
that follows from it, the catalogue editor itself, and starting a translation
from the template.

Not built, and each for a stated reason:

- **A per-string translation dialog in the grid** — the button inside a prose row
  that shows that literal across every catalogue. The catalogue editor covers the
  same strings from the other end, and the machinery it would share is the same.
- **Re-wrapping long values on save.** A value the file split across quoted
  chunks for line length comes back on one line: the split is spelling, not
  content, and gettext's own tools re-wrap the same way. The suite asserts
  *nothing lost* and *idempotent* rather than byte-identical, because asserting
  bytes would be asserting a formatter nobody wrote.
- **A named colour palette in the property grid.** `@define-color` is per CSS
  provider in GTK, and the per-widget `Background`/`Foreground` sheet is a
  different provider from `app.css` — so whether a `@brand` written in one
  resolves in the other has to be checked before it is offered.
- **~~Currency by locale.~~** Built: `Locale.Currency`, and with it the
  [`Decimal`](runtime-api.md#decimal) that made it worth having — money in a
  language with one binary floating-point type was the larger conversation, and
  it was had. What is *not* built is a per-currency choice: the symbol is the
  desktop's, so an application invoicing in a currency that is not the machine's
  has nowhere to say so.
- **Custom date and number patterns.** The four formats offered are the four the
  locale itself defines. A `"Long"` date and a `dd/MM/yyyy`-style pattern are the
  next step, and the pattern language is the decision to make first: VB and
  Gambas spell it `dd/mm/yyyy`, .NET `dd/MM/yyyy`, and GLib takes strftime's
  `%d/%m/%Y` natively.
- **Changing language without rebuilding.** A form holds strings. Saying so beats
  pretending otherwise; an application offering a language menu reopens its
  window.
