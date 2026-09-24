# Metainfo

The AppStream file a project carries: `<id>.metainfo.xml`.

It is the project's identity written for whoever installs it -- the id, the
name, the summary, the description, the developer, the licenses, the links and
the categories -- and it ships in the `package` library. The runtime never reads
it; the programs that do are a software centre, an installer, `appstreamcli`
and the packaging step.

```js
const doc = Metainfo.load("/home/ana/Notes/io.github.you.Notes.metainfo.xml");

Metainfo.read(doc).Summary;          // "Notes, kept simply"
Metainfo.problems(doc, path, config); // [] when it agrees with project.json
```

It is the same file the IDE edits under *Project → Application info…* and the
raw XML tab, and the same one `Package.Write` refuses to package when it
disagrees with `project.json`.

## Every member

| | | |
|---|---|---|
| `find(project)` | → the project's file, or `null` | [finding it](#finding-it) |
| `fileName(id)` | → `<id>.metainfo.xml` | [finding it](#finding-it) |
| `load(path)`, `save(path, doc)` | the file, through `Xml` | [finding it](#finding-it) |
| `read(doc)` | → the common fields as data | [the fields](#the-fields) |
| `write(doc, fields, config)` | writes them, identity included | [the fields](#the-fields) |
| `create(project, config)` | → a minimal one, written | [creating one](#creating-one) |
| `problems(doc, path, config)` | → what disagrees with `project.json` | [the identity](#the-identity) |
| `rename(project, newId)` | the file follows the id | [the identity](#the-identity) |
| `translations(doc)` | → the `xml:lang` names and summaries | [translations](#translations) |
| `XMLNS` | the XML namespace, for `xml:lang` | [translations](#translations) |

## Finding it

`find` looks for `*.metainfo.xml` in the project's root and answers the first
one, or `null`. **By suffix and not by rebuilding the name from the id**: the id
may have changed since the file was written, and a project that has a metainfo
has one whatever it is called -- which is exactly the state `problems` is for.

`fileName(id)` is the name it *should* have, and what `create` and `rename`
write. `load` and `save` are `File.LoadXml` and `File.SaveXml`: the error names
the file, and the write is atomic.

## The fields

`read(doc)` answers an object with the common fields, each `""` when the element
is not there -- the same thing an empty text box is to whoever is about to type
in it:

| | |
|---|---|
| `Id`, `Name` | the primary `<id>` and `<name>` |
| `Summary` | the primary `<summary>` |
| `Description` | the primary `<p>` paragraphs, joined by a blank line |
| `DeveloperId`, `DeveloperName` | `<developer id>` and the `<name>` inside it |
| `MetadataLicense`, `ProjectLicense` | the two license elements |
| `Homepage`, `Bugtracker` | the `<url>` elements, by their `type` |
| `Categories` | the `<category>` names, comma-separated |

`write(doc, fields, config)` writes them back. **Only the primary elements are
touched**: a `<name xml:lang="es">` is a translation and stays, and so does a
`<p xml:lang="es">` under the description. The description's paragraphs are
replaced -- blank-line-separated on the way in, one `<p>` each on the way out --
and the translated ones are left where they were.

## The identity

Two of those fields are not content. **The id and the primary name are the
project's**, and `write` takes them from `project.json` on every save, so the
two files cannot drift while this is the writer.

`problems(doc, path, config)` is what reports a hand-edit that did:

- `<id>` is not `project.json`'s `id`;
- the primary `<name>` is not `project.json`'s `name`;
- the file's own name is not `<id>.metainfo.xml`;
- the project declares no id at all, so there is nothing to agree with.

`rename(project, newId)` is the other half: the file is moved to the new name
and its `<id>`, `<launchable>` and `<icon>` are rewritten with it. A metainfo
named after an id the project no longer has is one nothing looks for.

## Creating one

`create(project, config)` writes a minimal, valid metainfo beside
`project.json`: the id, the two licenses, the name, the summary from the
project's description, an empty description paragraph, the launchable
(`<id>.desktop`), the release the manifest declares with today's date, and a
content rating. It writes `<icon type="stock">` **only when the project ships a
drawing**, because an icon element naming a theme icon that is not there is
worse than none: the package then claims something it cannot draw.

## Translations

`translations(doc)` answers `{ Names, Summaries }`, each an object keyed by
language code, out of the `<name xml:lang>` and `<summary xml:lang>` elements.
It is what `Package` turns into `Name[es]` and `Comment[es]` in the entry.

`Metainfo.XMLNS` is `http://www.w3.org/XML/1998/namespace`, and it is needed
because an attribute's namespace has to be named:
`el.SetAttrNS(Metainfo.XMLNS, "lang", "es")` writes `<name xml:lang="es">`, and
`el.AttrNS(Metainfo.XMLNS, "lang")` reads it back. `Attr("lang")` answers `null`
for it, since an unprefixed name means an attribute with no namespace at all.

**A translated description is a `<p xml:lang="es">` inside the one
`<description>`, not a `<description xml:lang="es">` of its own.**
`appstreamcli` refuses the second with `metainfo-localized-description-tag` and
then two warnings that say the description has no valid content — a sentence
about the element and not about the shape. A summary is the other way round: a
`<summary xml:lang="es">` is an element of its own. `write` preserves both,
because it replaces only the primary elements.
