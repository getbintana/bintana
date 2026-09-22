# Xml

An XML document: parse it, walk it, change it, write it.

XML is not JSON with pointier brackets. JSON and JavaScript are the same value
model — object, list, scalar — which is why a [`Record`](Record.md) survives a
JSON file as itself; XML is a **document** model, and attributes, element order
(an MSPDI schema is an `xsd:sequence`), namespaces and mixed content have
nowhere to go in a plain object. So this answers a tree, and a shape maps onto an
element by **declaring** it — [`Record`](Record.md)'s `static Xml` and its
`LoadXml`/`ToXml`/`SaveXml`. [`docs/plans/xml-plan.md`](../../plans/xml-plan.md)
is where that design is argued.

## Every member

| | | |
|---|---|---|
| `Parse(text)` | → a document, or a `SyntaxError` with `línea:columna` | [reading](#reading) |
| `ParseBytes(bytes)` | the same, honouring the declared encoding | [reading](#reading) |
| `Element(name)` | → a **detached** element, for building | [building](#building) |
| `Stringify(node)` | → the canonical text | [writing](#writing) |
| `Available` (ro) | whether this build has libxml2 | [availability](#availability) |
| `Root` (ro) | the root element, or `null` | [reading](#reading) |
| `Name` (ro) | the element's local name | [names and namespaces](#names-and-namespaces) |
| `Prefix` (ro) | its prefix, `""` when there is none | [names and namespaces](#names-and-namespaces) |
| `Namespace` (ro) | its namespace URI, `""` when there is none | [names and namespaces](#names-and-namespaces) |
| `SetNamespace(uri, [prefix])` | puts the element in that namespace | [names and namespaces](#names-and-namespaces) |
| `Text` | all the character data under it; assigning replaces the children | [reading](#reading) |
| `Attr(name)` | the value, `""`, or `null` for none | [attributes](#attributes) |
| `SetAttr(name, value)` | both as text; creates or replaces | [attributes](#attributes) |
| `RemoveAttr(name)` | takes it away | [attributes](#attributes) |
| `AttributeNames()` | the local names | [attributes](#attributes) |
| `Children` (ro) | its element children, in file order | [children](#children) |
| `Find(name)` | the first direct child called that, or `null` | [children](#children) |
| `FindAll(name)` | every direct child called that | [children](#children) |
| `Add(child)` | a node or an element name; answers the node **in this tree** | [building](#building) |
| `Insert(index, child)` | before the element child at `index`, or at the end | [building](#building) |
| `Remove()` | out of the tree, and the wrapper stops answering | [building](#building) |
| `Parent` (ro) | the parent element, or `null` for a root | [children](#children) |
| `Copy()` | → a detached subtree of its own | [building](#building) |

`File.LoadXml` and `File.SaveXml` are the file roads; see [`File`](File.md).

## Reading

| | |
|---|---|
| `Parse(text)` | a string, already decoded, to a document |
| `ParseBytes(bytes)` | the same, and the declaration's encoding is honoured — what `File.LoadXml` uses |
| `Root` (ro) | the root element of a document, or `null` |
| `Text` | all the character data under an element; assigning replaces the children |

```js
const doc   = File.LoadXml("plan.xml");       // the error names the file
const tasks = doc.Root.Find("Tasks").FindAll("Task");

for (const task of tasks)
    print(`${task.Find("UID").Text} ${task.Find("Name").Text}`);
```

`File.LoadXml` reads **bytes** and lets the declaration say what encoding they
are in: decoding as UTF-8 first would destroy an ISO-8859-1 document before the
line that says so could be read. `Xml.Parse` is the string road, for text that
already came from somewhere else — an `Http` body, a `SourceEditor`.

A malformed document **throws**, with `línea:columna` in front of the parser's
sentence; there is no partial answer to check for.

## Children

| | |
|---|---|
| `Children` (ro) | the element children, in order |
| `Find(name)` | the first direct child element with that local name, or `null` |
| `FindAll(name)` | every direct child element with it |
| `Parent` (ro) | the parent element, or `null` for a root or a detached node |

`Children` is the **element** children only. Comments and processing
instructions are nodes in the tree and are written back where they were, but
they are not what a data walk is for; the same goes for text nodes, which an
element's `Text` collects. `Find` and `FindAll` look at direct children and
match the local name — a namespace is asked about with `Namespace`, and a deeper
walk is a loop, not a path language.

## Attributes

| | |
|---|---|
| `Attr(name)` | the value; `""` for one that is present and empty, `null` for one that is not |
| `SetAttr(name, value)` | both as text; creates or replaces |
| `RemoveAttr(name)` | |
| `AttributeNames()` | the local names |

An `xmlns` declaration is not in `AttributeNames()` and cannot be read with
`Attr`: in a document's tree it is the namespace, which is what `Namespace`,
`Prefix` and `SetNamespace` are for.

## Names and namespaces

| | |
|---|---|
| `Name` (ro) | the local name |
| `Prefix` (ro) | the prefix, `""` when there is none |
| `Namespace` (ro) | the URI, `""` when there is none |
| `SetNamespace(uri, [prefix])` | puts the element in that namespace, reusing a declaration already in reach |

Asking twice for the same namespace is one declaration. A *different* URI for a
prefix (or a default namespace) the element already declares throws, naming the
one it has: rewriting that declaration would move every descendant using it
along with the element.

A name that is not one — with a space in it, say — is refused at `Add` and
`Element` rather than written into a document no parser could read.

## Building

| | |
|---|---|
| `Element(name)` | a detached element; its own tree, not in any document |
| `Add(child)` | a node or an element name |
| `Insert(index, child)` | before the element child at `index`, or at the end |
| `Remove()` | takes the node out for good |
| `Copy()` | a detached subtree of its own |

```js
const fresh = Xml.Element("Task");
fresh.Add("Name").Text = "Build";
doc.Root.Find("Tasks").Add(fresh);          // copied in; the variable stays detached
```

**A node from another tree is copied in, and `Add` answers the node that is in
*this* tree.** Within one tree `Add` moves the node, as a DOM does; across trees
it copies, because moving a subtree between documents would have to repoint
every wrapper under it — and one that was not repointed is memory that has been
freed. The idiom is always `const el = parent.Add(Xml.Element("Task"))`, and a
freshly built `Xml.Element` is *always* in another tree.

`Remove()` takes the node out and **that** wrapper stops answering, rather than
reading freed memory. `Copy()` first if the subtree is wanted elsewhere. A
wrapper is not the node — two `Find`s of one element are two wrappers — so
another one taken before the `Remove()` still answers, about a node that is now
detached, and can `Add` it back. So can a child kept across a `Text`
assignment, which detaches the children without silencing anybody.

## Writing

| | |
|---|---|
| `Stringify(node)` | the canonical text: a declaration, indentation of two, one trailing newline |

`File.SaveXml` writes exactly that, by the atomic [`File.Save`](File.md). So a
parsed document comes back with different whitespace and attribute order — both
insignificant to XML, and one shape is worth more than byte fidelity. Comments
keep their place, and what is written is always UTF-8, whatever the file
declared. `Xml.Stringify(element)` takes a detached element too: it is copied
into a document of its own so the declaration is written with it.

## Availability

| | |
|---|---|
| `Available` (ro) | whether this build has libxml2 |

XML is optional at build time, like `Database.Sqlite`: without libxml2,
`Available` is `false` and every verb refuses with a sentence naming the
package. The class is installed in a worker too, so a big file can be parsed
off the main thread.

## What goes wrong

- **`Parse` threw naming a line and a column.** A malformed document is not an
  empty one. Catch it, or `File.Exists` first for the file road.
- **`File.LoadXml` threw naming the file.** A syntax error in *something* is
  not an answer; the file road adds which file.
- **An attribute read back `null`.** There is no such attribute. `""` means one
  is there and empty, which is a different fact.
- **A node stopped answering.** That wrapper was `Remove()`d. `Copy()` first
  when the subtree is wanted again, or keep a second wrapper to `Add` it back.
- **A child is no longer under its parent, and still answers.** The parent's
  `Text` was assigned, which detaches the children it replaces.
- **`Add` answered a different node than was handed in.** The argument came from
  another document and was copied; use the answer.
- **`Available` is `false`.** This build has no libxml2; CMake printed which
  packages it found, either way.

## See also

[`File`](File.md) · [`Record`](Record.md) · [`Bytes`](Bytes.md), which
`ParseBytes` takes · [`Http`](Http.md), whose body is often one of these ·
[`docs/plans/xml-plan.md`](../../plans/xml-plan.md)
