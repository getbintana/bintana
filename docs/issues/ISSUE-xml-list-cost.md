# ISSUE: a list in a document costs its square to write

## What the application needed

`bintana-project` opens an MS Project plan (MSPDI), shows it as a tree and a
Gantt chart, lets it be edited, and writes it back. The plans it is for are
ordinary ones: the one real file I was given, written by Project 16.0, is 326 KB
and 59 tasks, and a programme of a few thousand tasks is a normal thing to be
handed. The application saves on every edit and **autosaves every 60 seconds**,
and a save is the whole document -- re-read, mapped, written back. So the cost of
a save has to be proportional to the size of the plan, and there is a second
thing it has to be: the save must not run long enough to be felt, because it
runs on the thread that draws.

## What I wrote instead

At first nothing: it worked on the ten fixtures and on the one real file I was
given, and that file is small. The application grew a `check` mode that
round-trips synthetic plans, and that is where the wall appeared. Two habits in
the tree are there because of it and say so where they are written --
`writeMspdi` re-parses the text it kept instead of writing into the live tree,
and `leafValues` takes `el.Children` once per element rather than indexing it
inside a loop.

The step the application cannot avoid is `Record.SaveXml`, and **a save of 8000
tasks takes two and a half minutes**. The road that is left is to stop using
`SaveXml` for a long list and place the items by hand out of one `FindAll`, which
gives up exactly what the mapper is for: the `xsd:sequence` order (`#xmlSlot`)
and the rule that a field sitting at its declared default is left out of the file
-- the two things the fidelity notes count as the whole point of the round trip.

## The code I wish I could have written

The declaration is the one already written and already in use. What is missing is
what it costs:

```js
class MspProject extends Record {
    static Xml    = { Root: "Project",
                      Namespace: ["http://schemas.microsoft.com/project",
                                  "http://schemas.microsoft.com/project/2007"] };
    static Fields = { Name:        Field.Text(),
                      Tasks:       Field.List(MspTask,       { in: "Tasks" }),
                      Resources:   Field.List(MspResource,   { in: "Resources" }),
                      Assignments: Field.List(MspAssignment, { in: "Assignments" }) };
}

const project = MspProject.LoadXml(doc.Root);
project.SaveXml(doc.Root);   // same declaration; a save measured in seconds
File.SaveXml(path, doc);
```

Two tables, both measured on `build/bintana` at `2f5ecb8` with libxml2 2.12.10,
whole seconds because that is the resolution the runtime's clock gives.

One element holding N element children, each loop asking the question N times:

| N children | `Children` once, then indexed | `Children[i]` in the loop | `FindAll(name)` in the loop | `Find(name)` in the loop |
|---|---|---|---|---|
| 2000 | under a second | 1 s | 1 s | under a second |
| 4000 | under a second | 4 s | 3 s | under a second |
| 8000 | under a second | 12 s | 11 s | under a second |
| 16000 | under a second | 50 s | 51 s | under a second |

The application's own read-save cycle on synthetic MSPDI plans (one `<Task>` per
element, timed in pieces, one pass each):

| tasks | `File.LoadXml` | `Record.LoadXml` | `Xml.Stringify` | `SaveXml` + `Stringify` |
|---|---|---|---|---|
| 500 | 0 s | 0 s | 0 s | 0.5 s |
| 2000 | 0 s | 1 s | 0 s | 6.5 s |
| 4000 | 0 s | 1 s | 0 s | 29 s |
| 8000 | 0 s | 3 s | 0 s | 151 s |

Doubling the plan from 4000 to 8000 tasks multiplies the save by 5.2. The read
is 3 s at 8000 and the serializer writes 8.6 MB in under a second, so neither
the DOM nor libxml2 is what is slow.

## Why the existing words do not cover it

`Children` and `FindAll` each build a fresh array with a fresh wrapper per
element child **on every access**, so asking a container about its children
costs what the container holds, every time it is asked. There is no word for "the
children, once" and nothing that survives the access: two `Find`s of one element
are two wrappers and `doc.Root === doc.Root` is `false`, so a program cannot even
keep the answer to compare it against. `Find` is the exception in the table
because it stops at the first match.

`Record.SaveXml` places a list by finding where each item belongs among its
holder's children, and re-reads them for each item.

There is also nothing to configure: `Xml.Parse(text, true)` and
`Xml.Stringify(node, "anything")` both accept a second argument and discard it,
so there is no flag to ask for, and the parser's own limit cannot be turned on
either -- a 300-deep document is refused with `Excessive depth in document: 256
use XML_PARSE_HUGE option`.

What is already written down, so it is referred to rather than re-reported: the
SAX row of `docs/plans/xml-plan.md` defers a reader *"until one is measured"*.
The memory half of that measurement, offered because it was asked for -- 1.1 MB
of MSPDI is 51 MB peak RSS for load, read, save and two serializations, and
4.5 MB is 117 MB. That is linear, and it is not what hurts. The time is what
hurts, and it is in the caller.

## Prior art

The DOM has a live `childNodes` collection and `insertBefore` / `appendChild` are
constant time per insert, so a mapper that walks children once and splices is
the ordinary shape. libxml2's own `xmlAddChild` and `xmlAddNextSibling` are
pointer splices -- the cost of placing a list is the caller looking it up again,
never the library moving a node. Qt's `QDomDocument` is the same libxml2-backed
shape and inherits the same freedom.

## How much it mattered

The application cannot be written for a plan of a few thousand tasks. Up to 500
tasks I have measured the whole application end to end and it is fine; past that
the autosave alone stops the window for minutes at a time, and the fix available
to me is to stop using the layer that keeps the schema's order.