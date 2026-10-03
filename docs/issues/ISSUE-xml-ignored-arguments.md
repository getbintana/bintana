# ISSUE: Remove and Add cannot refuse a wrong argument

## What the application needed

A save path that cannot lose the document. `bintana-project` writes an MSPDI plan
back after every edit and every autosave, and an editing command is a piece of
code the user triggers with a keystroke. A mistake in one of those commands must
not be able to delete the plan without a word -- and where the whole plan lives
in one file, "without a word" is the difference between an inconvenience and the
work of a year.

## What I wrote instead

A rule in the source, in the comment on the shape that owns the lists: `Remove()`
is only ever called with no arguments, on the node to be taken out, and never as
`parent.Remove(child)`. The second half of the same rule is that a new element is
built first and then filled -- `const el = parent.Add(Xml.Element("Task"))`, then
`el.Text = ...` -- because `Add` is not where a value goes.

Neither rule is in a language. Both are in a comment, which is checked by
whoever reads it and by nobody else. I went looking for the mistake on purpose,
writing the calls the way a DOM reads, and both of them are accepted.

## The code I wish I could have written

The calls I wrote, believing they said what they say in any other XML binding:

```js
const doc  = File.LoadXml(path);
const task = doc.Root.Find("Task");   // the one to delete
doc.Root.Remove(task);               // takes it out

doc.Root.Add("Name", "Analyse");     // an element with this value
```

## Why the existing words do not cover it

Both calls are accepted, and each does the wrong thing quietly. On
`<r><a/><b/><c/></r>`, and for `Add` on a fresh `<r/>`:

| call | what the document says afterwards |
|---|---|
| `d.Root.Children[1].Remove()` | `<r><a/><c/></r>` -- correct |
| `d.Root.Remove(d.Root.Children[0])` | the document body is gone and `d.Root === null` |
| `d.Root.Remove("a")` | the document body is gone and `d.Root === null` |
| `d.Root.Add("a", "T")` | `<r><a/></r>` -- the value is not there |

`Stringify` on the emptied document writes the XML declaration and nothing else,
and `File.SaveXml` writes exactly that: a two-line file where the plan was. No
exception, no return value, no diagnostic.

`Remove` declares no parameters and `Add` declares one, so both calls are wrong
against their own signatures -- but nothing can see it, because a binding that
does not need the argument does not look at it, and `Add("1bad")` and
`Add("p:a")` *are* refused, so the name is clearly being checked. The argument
is simply past the end of what the function reads.

What makes this worth reporting rather than reading twice is that the rest of
the surface refuses:

- `Xml.Element()` -> `TypeError: Xml.Element(name) expects a name`
- `Insert("b", "a")` -> `TypeError: Insert: "b" is not a number`
- `Insert(-1, el)` -> `RangeError: Insert: -1 is not a position`
- `SetAttrNS("urn:z", "a", "1")` -> `TypeError: SetAttrNS: no prefix for
  'urn:z' is declared on this element or around it`
- `el.Text = "a\u0001b"` -> `TypeError: Text: character 2 is U+0001, which XML
  cannot carry -- a document holding it could not be read back`

and the one that matters most is already right: a wrapper whose node was removed
stops answering, with `TypeError: this node is no longer in a document`, so the
wrapper half of the mistake is caught. `Remove` and `Add` are the two of the
twenty-one members on an element that take an argument and cannot say no -- and
for `Remove` the silence is total, because the node it takes out instead of the
one named is the document's root.

Nothing configurable reaches this either: `Xml.Parse(text, true)` and
`Xml.Stringify(node, "anything")` accept and discard a second argument, so a
strict mode for these calls is not something the application can turn on.

## Prior art

Every DOM raises rather than guessing: `removeChild` throws `NotFoundError` when
the node is not a child, and `insertBefore` throws `NotFoundError` or
`HierarchyRequestError`. libxml2's `xmlUnlinkNode` is a primitive with no
signature to get wrong -- there is no "which node" in it -- so the mistake is
purely the binding's, and it is the binding that owns what a surplus argument
means.

## How much it mattered

Latent, and that is the honest measure: nothing in this application calls
`Remove` today, and the record mapper uses the no-argument form throughout, so no
file has been lost to it. It is filed because the failure is silent and total,
because the two calls above are the ones a programmer writes first, and because
five members of the same object were found refusing a wrong argument while these
two were not -- which is what makes them read as a hole rather than as a rule
that was left out.