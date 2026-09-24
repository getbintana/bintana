# ISSUE: a control's menu labels never reach a catalogue

## What the application needed

A form whose control declares its own menu, and the labels of that menu
translated like every other string in the `.form`:

```json
{ "type": "TableView", "name": "Changes",
  "properties": {
    "Menu": [ { "name": "MnuChDiff", "text": "Show the diff" },
              { "name": "MnuChStage", "text": "Stage" } ] } }
```

The IDE is the application that needed it first. Four of its controls declare a
`Menu` in `MainForm.form` — the changes table, the file tree, the tab strip and
the control tree — 21 labels among them, 13 of which are in no catalogue. In a
Spanish session the whole window is Spanish and those four menus are English.

The second is `examples/table`, whose heading menu was going to be declared in
the `.form` — the shape the runtime documents as the simple case — until this
was found.

## What I wrote instead

For the example, the menu is built in code, where `Locale.Text` is read:
`Big_HeaderClick` returns the spec and every label is a `Locale.Text` call. It
works, and it costs the declaration: the menu is no longer in the `.form`, the
designer cannot show it, and the labels live in the handler instead of beside
the columns they belong to.

For the IDE there is no workaround short of writing each label a second time as
a `Locale.Text` in some source file, which is two places to keep in step — and
one of them is invisible to whoever edits the `.form`.

## The code I wish I could have written

The declaration above, and a catalogue entry for it:

```
#: Form1.form: Files.HeaderMenu MnuFileHide
msgid "Hide this column"
msgstr "Ocultar esta columna"
```

which is what the extractor already writes for a form's own `menus` block:

```
#: forms/MainForm.form: menu MnuEditMenu
msgid "_Edit"
```

## Why the existing words do not cover it

The extractor reads prose from two places. A **class** declares which of its
properties hold text a person reads (`Widget.TextProperties`), and a form's own
`menus` block is walked by name — `Strings.fromMenu` — because a menu label is
not a property any class declares. A control's `Menu` and `HeaderMenu` are the
same kind of thing as that block: not a property, and in no class's declaration.
No walk visits them, so their labels are translated at runtime by the menu
builder and never collected.

It is worse than a missing entry: a `po` file that carries one by hand loses it
at the next extraction, because `Translations.update` runs `msgmerge` against a
template that does not mention the msgid, and an entry with no `#:` reference
comes back obsolete.

## Prior art

Delphi keeps a menu's captions in the `.dfm` and its translation tools walk the
whole form. WinForms puts a context menu's item text in the same `.resx` as
everything else. Qt's `lupdate` reads `.ui` files and `tr()` calls. The shape is
the same in all three: **a menu is prose wherever it is declared**, and the
tooling does not care that it is not a control.

## How much it mattered

It works and a part of it is noticeably worse: the IDE's own four context menus
are untranslated in every language, and a `HeaderMenu` declared in a `.form` —
the simple case — cannot be translated through the IDE's tooling at all.
