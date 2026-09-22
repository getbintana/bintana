# XML: a plan, not a feature

**Stages 1 to 3 are built**: `Xml` is a document DOM over libxml2 (optional at
build time, installed in a worker too), `File.LoadXml`/`File.SaveXml` are the
file roads, and a record maps onto an element by declaring `static Xml` —
`Field.DateTime`, `LoadXml`/`ToXml`/`SaveXml`, the unknown-content policy in
`Problems`, and `SaveXml`'s in-place reconciliation by key.  The **first real
caller arrived before MSPDI did**: [`examples/feeds`](../../examples/feeds)
reads RSS 2.0 and Atom 1.0 over one list, and found the one bug the MSPDI-shaped
tests could not -- the object `LoadXml` builds is keyed by the file's spelling,
so a shape with `Naming = "lower"` had every field at its default.  What is
**not** built is the fixtures (stage 4) and the MSPDI library, which is now a
project of its own, and there is still no golden file written by a real
Project.  The rest of this document is the design those are held to, kept
because the decisions in it are not derivable from the calls.

The design was argued against a corpus of six synthetic MSPDI files plus the
official `mspdi_pj12.xsd`, kept outside this tree and **not** a golden set: its
own README says the acceptance file has to be a real `Save As → XML` from
Project, and that step is still pending. What the corpus *did* do was correct
the design in three places, and each one is written down where it bit.

## So what it is for

Every data format this runtime speaks is JSON. `File.LoadJson`/`SaveJson`,
`Record.Load`/`Serialize` and `Settings` are all the same shape, and that was
enough while every file was one written by a program in this tree. It stops
being enough the moment the file is written by somebody else's program, because
the formats other programs use are XML — MSPDI, SOAP, SVG, `.ui`, RSS, ODF —
and an application that cannot read one is an application that cannot
interchange with anything.

The temptation, and the reason this plan exists, is to make XML the second
JSON: parse it into objects, serialize objects back. That is the one design
this document refuses, and the argument for refusing it is the rest of the
document.

## A document, not a value

JSON is a **value** model and JavaScript has the same one: object, list,
scalar. There is an isomorphism, which is why `Record.Serialize` and `Load` are
a dozen lines each.

XML is a **document** model, and it is not isomorphic to anything:
`<a b="1">x</a>` cannot become a value without deciding arbitrarily whether `b`
is a key or an attribute, whether `"1"` is a number or text, where the element
went among its siblings, what its namespace was, and what happened to the
comment beside it. Attributes, order (the MSPDI schema is an `xsd:sequence`),
namespaces and mixed content are all structure that a value mapping has nowhere
to keep.

So the runtime exposes a document and the value mapping becomes a
**declaration**, exactly as it did for a database:

| | its generic half | its declared half |
|---|---|---|
| a table | `Connection.Query` / `Execute` (C driver) | `Table` + `PropertyInfo` (`rad.js`) |
| a document | the `Xml` DOM (C over libxml2) | `static Xml` + `LoadXml`/`ToXml`/`SaveXml` (`rad.js`) |

Which is also why the whole XML half cannot be a native plugin: `Record` lives
in `rad.js`, `rad.js` is baked into the binary, and a library's globals arrive
after it. XML is a standard syntax — the same kind of fact as JSON — and the
runtime is where a program already looks for one.

## What the corpus measured

Six small files (`01-minimal` … `06-timephased-custom`) and the official schema
were read against this design. Three findings changed it, and one is the kind
that a hand-written parser gets wrong for a year:

- **The namespace is two namespaces.** The official XSD declares
  `targetNamespace="http://schemas.microsoft.com/project/2007"` and every file
  Project writes uses `http://schemas.microsoft.com/project` — the corpus
  validated against the schema only after remapping it, and its README says a
  reader "must accept both or ignore the namespace" (MPXJ does the same). So a
  class's declared namespace is **a string or a list**: the first is what is
  written, all of them are accepted on read, and a root that matches none is a
  `Problems` line rather than a refusal — a format that renamed its namespace
  between generations is not a value error.
- **Order and presence are the schema's, not the record's.** `xsd:sequence`
  with elements that have no `minOccurs="0"` (`CurrencyCode`) means a writer
  cannot just omit what is at its default and be right. The mapping therefore
  has `ToXml(true)` — write every field — and a format library expresses "the
  schema requires this" as a non-empty default or `required: true`.
- **There is nothing but elements.** No prefixed names, no attributes other
  than `xmlns`, in the whole corpus. `attribute: true` exists because XML's
  identity includes attributes and the mapping would not be general without it;
  namespaces and prefixes are the DOM's, and the record mapping matches by
  local name and inherits its parent's namespace.

Two smaller facts worth having measured: the corpus carries a comment before
the root and an explicit empty `<Name></Name>` on the null task, and both are
the kind of thing a round trip either preserves or quietly loses. The plan's
answer is that the DOM preserves comments (they are nodes in libxml2's tree,
and the canonical writer emits them where they were), while an explicit empty
element is **not** preserved by the mapping — `""` is the default a field
starts from, so `ToXml` omits it and `SaveXml` removes it. A format that means
something by present-but-empty says so with a `def`, and the limitation is
documented rather than discovered.

The schema itself is not vendored: it is Microsoft's, it is 240 KB, and the
runtime does not validate against it. It stays a reference on the machine the
format is written against, which is where it was useful.

## The surface

XML gets the same pair of verbs JSON has, and no more:

```js
Xml.Parse(text)          → Document      // SyntaxError: línea:columna: mensaje
Xml.ParseBytes(bytes)    → Document      // what Http or File.LoadBytes answers with
Xml.Stringify(node)      → string        // the canonical shape, like JSON.stringify
Xml.Element(name)        → Element        // detached, for building
Xml.Available            → bool           // read off the build, like Terminal.Available

File.LoadXml(path)       → Document      // the error names the file
File.SaveXml(path, node)                 // atomic (File.Save) and canonical
```

`File.LoadXml` reads **bytes** and lets libxml2 honour the declared encoding;
`Xml.Parse` is for a string that is already decoded. The canonical shape is
`SaveJson`'s decision repeated: a declaration, indentation of two, one trailing
newline, UTF-8. A parsed document is rebuilt in that shape, so whitespace and
attribute order are not preserved — both are insignificant to XML, and one
canonical shape is worth more than byte fidelity.

A node answers `Name`, `Prefix`, `Namespace`, `Text` (get and set; setting
replaces the children), `Attr` / `SetAttr` / `RemoveAttr` / `AttributeNames`,
`Children` (element children, a copy), `Find` / `FindAll` (direct children, by
local name), `Add` / `Insert` / `Remove`, `Parent`, `Copy` and
`SetNamespace(uri, [prefix])`. Text nodes are not exposed: an element's `Text`
is its character data, and mixed content is the price, said as a limit rather
than faked.

**Deliberately absent, each with the trigger that would bring it back:**

| Not here | Why, and what would reopen it |
|---|---|
| `Find("Tasks/Task")` | A path language inside a string, which is the small-language-in-a-value this tree already refused for `Source` and for Go-style field tags. If querying is wanted, the standard vocabulary is **XPath** and it will be spelled that way, the same bargain `Database.Query` makes with SQL |
| XPath | A whole second language; nothing in the corpus needs it, and `Find`/`FindAll` plus the DOM walk covers reading. Reopens the day a format's navigation cannot be written as two nested loops |
| XSD validation | A schema is another language and another dependency-shaped feature, and Project is the validator that matters. The corpus's namespace mismatch shows validation would have to remap namespaces first; reopens when an application must reject a bad file before reading it |
| DTD, entities, network | Security. Parsed with `XML_PARSE_NONET`, and without `NOENT`/`DTDLOAD`/`HUGE`: external entities, billion-laughs and a 2 GB node are not configurations to get right, they are negatives. A program that needs entities has a different problem |
| HTML | Not XML — `xmlReadMemory`, never `htmlReadMemory`. An HTML parser is a browser dependency, not a data format |
| SAX, `xmlTextReader` | The DOM costs memory proportional to the file, and a 50 MB MSPDI is a real file. Deferred until one is measured, because `File` already reads whole files and the streaming API is a different contract (callbacks where a program expects an answer) |

And the whole surface is installed in a **worker** too, beside
`bta_database_init`: parsing is computation over a string, libxml2 is
thread-safe per document, and reading a big project file in a `Task` is the
case that wants it.

## Record: a declaration beside `Table`

`Naming` is not enough, and the reason is worth stating: `Naming` says how a
field's *name* is spelled, and the XML half is not naming — it is root,
namespace, attribute-versus-element, list wrappers, and what to do with what
the shape does not model. That is structure, and it gets a declaration:

```js
class Task extends Record {
    static Xml = { Root: "Task" };
    static Fields = {
        UID:       Field.Int({ key: true }),
        Name:      Field.Text(),
        Start:     Field.DateTime(),                       // the one new kind
        Milestone: Field.Bool(),                           // the file writes true/false or 1/0
        PredecessorLink: Field.List(PredecessorLink),      // repeated, no container
    };
}

class Project extends Record {
    static Xml = { Root: "Project",
                   Namespace: ["http://schemas.microsoft.com/project",
                               "http://schemas.microsoft.com/project/2007"] };
    static Fields = {
        Name:  Field.Text(),
        Tasks: Field.List(Task, { in: "Tasks" }),          // <Tasks><Task>…</Task></Tasks>
    };
}

const p = Project.LoadXml(File.LoadXml(path));   // lenient → Problems
p.SaveXml(File.LoadXml(path).Root);              // in place: touches only what it models
const fresh = p.ToXml(true);                     // a new element, every field
```

The rules, each of them a consequence of something already in the tree:

- **The element name is `as` or `Naming`** — one outside spelling per field, the
  same one a column uses. `Root` and `Namespace` come off `static Xml`, and a
  class with no `Root` is not an XML shape: `ToXml` refuses it.
- **The mapper owns the lexer**, because XML hands everything over as text and
  `Field.Bool` does not accept `"0"`: `Int`/`Number` through a strict
  `-?[0-9]+`, `Bool` from `1`/`0`/`true`/`false`, `Date`, `Time` and the new
  `DateTime` by shape, `Decimal` from its own digits (the text `Serialize`
  wrote, which is the one road that stays exact), `Bytes` from base64, `Enum`
  against its values. The setter runs after and still owns the range, so the
  field remains the one declaration of what a value may be.
- **Order is declaration order**, which is how a class states an `xsd:sequence`.
  `ToXml()` omits what is at its default, exactly as `Serialize` does, and
  `ToXml(true)` writes every field.
- **Lists**: `{ in: "Tasks" }` wraps; without `in` the items are siblings. A
  list of scalars names its item with `{ element: "X", in: "Xs" }`.
- **`LoadXml` is lenient**, like `Load`: what fits is taken, what does not goes
  to `Problems` with the path in front of it. A root of another name, a
  namespace in neither list, an unknown element, an unknown attribute — all
  `Problems`, none of them throws.
- **`ToXml` does not carry unknown content**, and that is deliberate: a raw
  unknown node kept in a bag would be re-emitted at the wrong position in an
  `xsd:sequence`, which is a wrong answer that looks right. `Problems` says what
  was dropped, and the lossless road is the other verb.
- **`SaveXml(element)` is the lossless road**, and it is `Table`'s relationship
  to a row applied to an element: the document owns everything, the record is a
  typed view, and only the fields it declares are touched. It updates existing
  elements, creates missing ones in declaration order among the modelled ones,
  removes a modelled element a field left at its default, and reconciles lists
  by the `key: true` field (UID in MSPDI) or by index when there is no key.
  Everything else — unknown elements, foreign namespaces, comments — is exactly
  where it was. It is strict where `LoadXml` is lenient: writing into the wrong
  element is a mistake, not a value a file can have, so it throws.
- **`Field.DateTime` arrives with this and is not about XML**: `Date` alone and
  `Time` alone cannot say `2026-09-01T08:00:00`. It holds
  `YYYY-MM-DDTHH:MM[:SS]`, and — since Atom and GPX write them — an optional
  `Z`/`±HH:MM`, kept exactly as written. A fraction of a second is refused, and
  **`min`/`max` are local-time only**: with a zone a text order is not a time
  order, so the two are refused together rather than compared wrongly.
- **Duration is not a field kind.** MSPDI's `PT16H0M0S` is working time and
  needs a calendar to mean anything; the schema forbids the `P2W`/`P1M`
  spellings, and the corpus uses `PT…S` throughout. It is `Field.Text` in the
  format library, with a helper if the library wants one — a runtime kind for
  one format's lexical type is the invented format this tree keeps refusing.

One asymmetry is documented where `Record` is: `Load`/`Serialize` keep unknown
JSON keys in the `#x` bag, and `LoadXml`/`ToXml` do not keep unknown elements.
The reason is the two media: a JSON object has no order to violate, and an
`xsd:sequence` does; the preserving road for XML is `SaveXml`, which needs no
bag because it never rebuilds the document.

## What was rejected, and why

| Rejected | Why |
|---|---|
| GMarkup (GLib) | No namespaces at all, no DOM, and no serializer — writing one by hand is "build another parser", the mistake this tree's notes keep naming |
| GXml | Not packaged here (checked), and it is a GObject wrapper over libxml2 anyway: a dependency that buys indirection |
| A native plugin in `lib/xml` | It cannot be part of `rad.js`/`Record`, does not appear in `bintana.d.ts` or in `tests/api`, and makes every user compile. It is the right mould for a format parser, not for a standard syntax the runtime should speak like JSON |
| A JSON-shaped value mapping | Attributes, order, namespaces and mixed content have nowhere to go; any mapping has to be a declaration with a medium |
| Strict namespace equality | The official schema and the files disagree (measured); a list is the honest spelling |
| An unknown-node bag for `ToXml` | Re-emitting an unknown node at the end of a sequence is silently wrong; `Problems` plus `SaveXml` answers both halves |
| XPath, XSD, SAX now | Each is a language or a contract of its own, and nothing needs one yet — the triggers are in the table above |

## Implementation, and what it costs

`runtime/src/bta_xml.c` (a document wrapper owning the `xmlDocPtr`, node
wrappers holding a strong reference to it, which is the `gc_mark` shape
`AGENTS.md` already documents), `bta_xml_init` in `install_globals` and in the
worker's list, and CMake's optional-dependency mould: `pkg_check_modules`
without `REQUIRED`, a `BTA_HAVE_LIBXML` define, a `message(STATUS …)` either
way, and without the library `Xml.Parse`/`Stringify` refuse with a sentence.
The devel package is the only new build dependency (`libxml2-devel` /
`libxml2-dev`); at runtime GTK4 already loads libxml2 on this machine, so the
optional half is about the build, not about the desktop.

`AGENTS.md`'s "Five are optional" becomes six in the same change, and the
`no-libxml` branch has to be compiled to be known to work: a wrapper
`pkg-config` that answers no for `libxml-2.0`, a separate build, and the suite
against that binary.

## Staging

1. **This document**, and its row in the plans index. No code. **Built.**
2. **The core**: `bta_xml.c`, CMake, the worker, `File.LoadXml`/`SaveXml`,
   `Xml.Available`, the reference and `library.md`, and `tests/widgets`'
   `XmlFiles` — round trip, escaping, accents, an error naming line and column,
   an error naming the path, the canonical shape, comments, the namespace list.
   **Built**, and the `no-libxml` half compiled and run with a wrapper
   `pkg-config` that answers no for `libxml-2.0`.
3. **Record**: `Field.DateTime`, `static Xml`, the two field options and the
   three verbs, with the tests that prove element, attribute, wrapped and
   unwrapped lists, omission against `ToXml(true)`, `Problems` on what does not
   fit, and `SaveXml` leaving everything it does not own alone. **Built**, as
   `tests/widgets`' `XmlRecord`.
4. **The fixtures**: the six synthetic files become test material. The XSD stays
   out of the tree, and so does any claim that the round trip is golden until a
   real Project file opens on the other side.
5. **MSPDI itself**, outside this plan: written against the DOM by hand first,
   promoted to `lib/mspdi` when a second consumer wants it. XPath, XSD and
   streaming wait for their triggers.

## Where it stands

The compound is in: the DOM parses, walks, builds and writes; the file pair
names its file and reads bytes for the declared encoding; a record declares its
element and the three verbs move it there and back, with `SaveXml` the lossless
road; the six synthetic files of the corpus were read, walked and written back
element for element while the C was being written; the optional half refuses by
name; and the worker parses one off the main thread. What the tests hold is
`tests/widgets`' `XmlFiles`, `XmlRecord`, and the worker's two lines in
`testTask`.

The first caller was not the one this plan was written for.
[`examples/feeds`](../../examples/feeds) reads RSS 2.0 and Atom 1.0 as two
shapes over one list, and the declaration met its first real test there: RSS's
`Naming = "lower"` and its `<pubDate>` found that `LoadXml` was keying the
object `Load` reads by property name instead of by the file's spelling, which
MSPDI's `same` naming had hidden. What is left here is the six synthetic files
as fixtures (stage 4); MSPDI itself is a parallel project, and a file written
by a real Project is what its round trip will be measured against.
