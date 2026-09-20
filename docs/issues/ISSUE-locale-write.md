# ISSUE: a catalogue can be read and not written

## What the application needed

To save a `.po` after a translator edited it. The IDE reads one with
`Locale.Read`, shows the entries, lets somebody type a translation, and then has
to put the file back.

## What I wrote instead

The format, by hand: `Translations.js:88-175`, some eighty-seven lines. `poQuote`
at `89` for the escaping, then the header, the plural forms, the line wrapping,
and `File.Save` at `174`.

```js
function poQuote(s) { /* ...\" \\ \n \t, and the wrap at 76 columns... */ }
```

## The code I wish I could have written

```js
Locale.Write(path, entries);
```

## Why the existing words do not cover it

`Locale.Read` exists (`bta_locale.c:1691`) and is the half that was needed
first. It is also the half that already knows the format, and it knows something
the hand-written writer had to be taught separately: **what it cannot model
rides along**. `AGENTS.md` states that rule -- fuzzy entries, comments and `#~`
blocks are kept as raw strings on the entry so that an editor built on the
reader cannot destroy a translator's work -- and the writer is where that
promise is either kept or broken. Keeping it in two places, one of them a
hundred lines of JavaScript, is how it gets broken.

There is no other verb that writes a structured format: `File.SaveJson` is the
nearest, and a catalogue is not JSON.

## Prior art

`msgfmt`/`msgmerge` are what the IDE shells out to for the *other* operations,
so the tooling is assumed present -- but neither writes an edited catalogue back
from a data structure. GNU gettext's own `libgettextpo` has
`po_file_write`. Python's `polib` is `pofile.save()`. Every library that reads
this format writes it, because the format exists to be round-tripped.

## How much it mattered

One consumer, which is the honest count. What makes it worth reporting anyway is
that it is the only implementation in existence here, it is eighty-seven lines
of a format with real escaping rules, and the reader it has to agree with is
already in C. The suite asserts *nothing lost* and *writing twice changes
nothing* about that pair -- two properties currently held up by a JavaScript
function in the IDE.
