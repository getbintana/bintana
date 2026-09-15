# SourceEditor

Code: highlighting, completion, search and gutter marks.

A `GtkSourceView`, which is a `GtkTextView` that knows about programs. It is an
[`Editor`](Editor.md) plus everything below, and it is what the IDE's own tabs
are made of.

## Every member

| | | |
|---|---|---|
| `Completion` | offer completions while typing | [completion](#completion) |
| `CompletionTitle` | the heading of that popup. **Translated** | [completion](#completion) |
| `Language` | a GtkSourceView id: `js` `json` `c` `markdown`… | [highlighting](#highlighting) |
| `MatchIndex` (ro) | which match the cursor is standing on | [search](#search) |
| `Matches` (ro) | how many `Search` found | [search](#search) |
| `ShowLineNumbers` | the gutter's numbers. Default `true` | [highlighting](#highlighting) |
| `ShowMarks` | the gutter's marks | [marks](#marks) |
| `Theme` | the colour scheme | [highlighting](#highlighting) |
| `ClearMarks([kind])` | takes them off every line | [marks](#marks) |
| `FindNext()` | moves to the next match, wrapping | [search](#search) |
| `FindPrevious()` | and backwards | [search](#search) |
| `Unmark(line, [kind])` | takes marks off one line | [marks](#marks) |
| `Mark(line, kind, [text])` | a gutter mark | [marks](#marks) |
| `Marks([kind])` | → a record per mark: `{ Line, Kind, Text }` | [marks](#marks) |
| `Replace(with)` | the match the cursor is on | [search](#search) |
| `ReplaceAll(with)` | every match | [search](#search) |
| `Search(text, [options])` | → how many, highlighting every one | [search](#search) |
| `ShowCompletion()` | opens the completion popup from code | [completion](#completion) |
| **event** `Complete(word, line, column, text)` | a completion was asked for | [completion](#completion) |

`Text` is [`Editor`](Editor.md)'s here and is **not** a translated property: a
catalogue must never rewrite code.

## Highlighting

| | |
|---|---|
| `Language` | a GtkSourceView id — `js` `json` `c` `python3` `markdown` `css` `sh` `xml` `sql` `yaml` `diff`… `""` for none. **`PropertyOptions("Language")` asks this machine what it has**, which is the honest list rather than one written down here |
| `Theme` | `Adwaita` `Adwaita-dark` `classic` `classic-dark` `cobalt` `cobalt-light` `kate` `kate-dark` `oblivion` `solarized-light` `solarized-dark` `tango`. Default `"classic"` |
| `ShowLineNumbers` | the gutter's numbers. Default `true` |

## Search

| | |
|---|---|
| `Search(text, [{CaseSensitive, WholeWord, Regex}])` | → how many there are, highlighting every one. **It does not move the cursor**: typing in a find field and jumping to a match happen at different moments, and a find bar that jumped on every keystroke would drag the view about while somebody is still typing |
| `Matches` (ro) | how many the last `Search` found |
| `MatchIndex` (ro) | which one the cursor is standing on — the `3` in *3/12* |
| `FindNext()` | moves to the next match, wrapping around |
| `FindPrevious()` | and backwards |
| `Replace(with)` | the match the cursor is standing on |
| `ReplaceAll(with)` | every match |

## Marks

| | |
|---|---|
| `Mark(line, kind, [text])` | a gutter mark. `kind` is `Error` `Warning` `Info` `Bookmark` — or `Added` `Removed` `Gap`, which **paint the line** — and `text` is its tooltip |
| `Unmark(line, [kind])` | takes marks off that line |
| `Marks([kind])` | → **a record per mark**, in line order: `{ Line, Kind, Text }` — not a list of line numbers, which is what "the lines that carry one" was read as by the first thing that used it |
| `ClearMarks([kind])` | takes them off every line |
| `ShowMarks` | whether the gutter draws them |

### The three that paint the line

`Added`, `Removed` and `Gap` are about the **line** rather than about a message,
and they tint it: a translucent green, a translucent red and a dim grey, blended
over whatever the theme paints, so one pair of numbers is right in a light scheme
and in a dark one. `Added` and `Removed` carry a gutter icon as well, because a
diff read by somebody who cannot tell the two tints apart is a diff with nothing
in it.

`Gap` is the odd one: a line that is **not there** on this side. A side-by-side
diff pads, so that ten added lines on the right face the place they were added on
the left — and a blank line meaning *nothing here* must not look like a blank
line that is in the file.

```js
Before.Mark(12, "Removed");
After.Mark(12, "Added");
After.Mark(13, "Gap");        // the line 13 on the left has and this one has not
```

What they are *for* is yours: an error from a compiler, a breakpoint, the line a
search came from. The IDE marks the line an exception names, which is how a
message in its log becomes a place in a file — and its *Changes* window is these
three.

## Completion

| | |
|---|---|
| `Completion` | offer the buffer's own words while typing — the floor of what an editor owes, and the whole of what can be known without being told |
| `CompletionTitle` | the heading of the popup your own provider fills. **Translated** |
| `ShowCompletion()` | opens it from code |
| **event** `Complete(word, line, column, text)` | a completion was asked for. **Answer with a list, or nothing.** An entry is a word, or `{ Text, Detail }` for one that says what it is beside itself |

```js
Editor_Complete(word, line, column, before) {
    if (!before.endsWith("this.")) return [];
    return this.controls.map((c) => ({ Text: c.Name, Detail: c.TypeName }));
}
```

**Nothing here is inferred**, which is the whole reason a completion this useful
is possible without a parser: the runtime publishes what it knows about itself
and the `.form` beside a class says what every control on it is, so the
completions worth having are table lookups. Where nothing says what a name is,
answer nothing — see [ide.md](../../ide.md).

## What goes wrong

- **A language is not highlighted.** This machine's GtkSourceView does not have
  it; ask `PropertyOptions("Language")`.
- **The search moved the view while somebody was typing.** It does not —
  something is calling `FindNext` on every keystroke.
- **A `.form` says `TextEditor` and the source properties do nothing.** The
  control was renamed: what loads is the plain editor, and the loader assigns
  what a file declares without asking whether the class has it. Renaming the type
  in the file is the whole of the fix.

## See also

[`Editor`](Editor.md) · [`TextEditor`](TextEditor.md) ·
[ide.md](../../ide.md), which is this control driven in anger
