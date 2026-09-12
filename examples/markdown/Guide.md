# The reader, and what it reads

This document is the example's sample and its test at once: everything the
`markdown` library knows how to draw is somewhere on this page, so a change that
breaks one of them is visible by scrolling.

The column is capped at 720 pixels and centred — a document that fills a
maximised window is a line of ninety words, and nobody reads those.

Drag over any of it to select, double click for a word, Ctrl+A for the whole
document and Ctrl+C to copy. The *Copy* button above is enabled by the `Select`
event, which arrives when a drag ends.

Links are clickable: [jump to the tables](#tables) needs no handler at all, and
where anything else goes is this example's decision — see `Doc_Link` in
`Reader.js`.

## Words

A paragraph wraps at the measure of the column. It can carry **bold**, *italic*,
`a code span`, ~~something struck out~~ and [a link](https://example.org), and it
stays one paragraph however it is wrapped in the source, because a newline
between two lines of prose is a space.

A line that ends in two spaces  
breaks there, and only there.

An `_` inside a word leaves it alone: `snake_case` and file_name_here are one
word each, not an invitation to italics. A backslash escapes what Markdown would
otherwise have eaten: \*not emphasis\*.

### Three levels down

The top two levels get a rule under them; this one does not, which is what says
it belongs to the section above rather than starting one.

## Lists

- the first item
- the second, long enough to wrap: the marker hangs to the left of the column,
  so the second line starts under the text and not under the bullet
- and a nested one
  - which changes its glyph
    - and again, once
- back out

1. an ordered list
2. starts at the number it says
3. and counts from there

A blank line between two items does not end the list — it makes it *loose*, and
the items are spaced apart. Only a paragraph like this one ends it, so the next
list is a new one, and a new one starts at the number it says:

7. this one starts at seven
8. and carries on

## Quotes

> A quote is indented, dimmed and marked with a bar as tall as what it quotes.
>
> It can hold anything a document can:
>
> - a list
> - and `code`
>
> > and another quote inside it.

## Code

A fenced block keeps its spaces and its line breaks, and is set in the monospace:

```js
class Reader extends Form {
    Form_Open() {
        this.Doc.Load(File.Join(Application.Directory, "Guide.md"));
        for (const h of this.Doc.Headings) this.Contents.Add(h.Text);
    }
}
```

The language on the fence is read and kept, and nothing is coloured by it: a
viewer that shipped half a highlighter would be wrong in a different language
every week.

    Four spaces of indent is a code block too,
    which is how it was written before fences existed.

## Tables

| Column | What it holds | Amount |
|---|---|---:|
| `Text` | the document, as Markdown | 1 |
| `MaxWidth` | the measure of the column, in pixels | 720 |
| `Headings` | every heading, in order, with where it is | 12 |
| A long cell | columns take what their widest cell needs, and are shrunk in proportion when the row will not fit | 1.050 |

The last column is right-aligned because its delimiter says `---:`.

## Pictures

A picture on a line of its own is drawn as one, fitted to the column and never
enlarged past its own size:

![The logo](logo.png)

One that is not there is a dashed box with its alt text in it, and not a crash:

![a picture that is not there](no-such-file.png)

---

That rule above is a thematic break. Below it is the last paragraph, which is
here so there is something to reach with `End`.
