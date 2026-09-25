# package

The files a package is built from: the project's metainfo, its menu entry, its
icon and the Flatpak manifest that turns them into an application.

```json
{ "name": "Notes", "id": "io.github.you.Notes", "startup": "MainForm",
  "uses": ["package"] }
```

Two classes: `Package`, which writes the artefacts, and `Metainfo`, the AppStream
file the project carries. The IDE uses `Metainfo` to edit it -- *Project →
Application info…* -- and `tools/pack` is the command line around `Package`:

```sh
tools/pack.sh <project> <out> [--finish-args <a,b,c>]
flatpak-builder <out>/<id>.json
```

`--finish-args` is how an application asks for more than a window: the default
is the four permissions an ordinary one needs, and a program that opens the
user's files adds `--filesystem=home` (or a narrower one).

## Package

| | |
|---|---|
| `Package.Write(project, out, [options])` | writes `<id>.metainfo.xml`, `<id>.desktop`, the icon as `<id>.svg\|png`, a copy of the project and `<id>.json`; answers where each went |
| `Package.defaults` | what the manifest carries when the caller says nothing: the GNOME runtime, the shared BaseApp and its version, the branch, and the permissions an ordinary windowed application needs |
| `Package.configOf(project)` | `project.json` as `{ Id, Name, Version, Dir }`, or a refusal naming what is missing |
| `Package.commandName(id)` | `bintana-notes` for `io.github.you.Notes` |

`options` is laid over `Package.defaults` one key at a time: `Runtime`,
`RuntimeVersion`, `Sdk`, `Base`, `BaseVersion`, `Branch` and `FinishArgs`. A
program that needs the network or the user's files passes its own `FinishArgs`,
because only its author knows.

**The manifest is JSON**, because flatpak-builder reads both formats and the
runtime already writes JSON -- a YAML writer would be a second format for one
caller. The output directory is a build context: everything the manifest names
is beside it, so it can be copied anywhere and built. It may be a top-level
folder of the project (`h/dist`), which is then left out of the copy; deeper
inside the project is refused.

**The icon is `icons/<id>.svg` or `icons/<id>.png`**, because `icons/` also
holds the glyphs a project's controls draw. Without that file, the one drawing
there not named `*-symbolic` is taken, and more than one is refused. An svg goes
to `hicolor/scalable`, a PNG to `hicolor/<its size>`, read out of the file.

**What it refuses is the point, and it refuses before it writes.** A project
with no `id`, no metainfo, no icon, an `icons/` it cannot tell the icon in, a
PNG icon that is not square or not a size the theme has (64 to 512), a metainfo
whose `<id>`/`<name>` disagrees with `project.json`, or one `appstreamcli
validate` would refuse (an empty or multi-line `<summary>`, an empty
`<description>`) stops here with a sentence, and `out` is left as it was. Each of those becomes, half a build later and by another
program, an application that installs under one name and claims another, an
appstream compose that fails with `icon-not-found`, or a package nothing can
describe.

## Metainfo

| | |
|---|---|
| `Metainfo.find(project)` | the project's `*.metainfo.xml`, or `null` -- found by suffix, because the id may have moved |
| `Metainfo.fileName(id)` | `<id>.metainfo.xml` |
| `Metainfo.load(path)` / `Metainfo.save(path, doc)` | `File.LoadXml` / `File.SaveXml` |
| `Metainfo.read(doc)` | the common fields as data: id, name, summary, description, developer, the two licenses, the URLs, the categories |
| `Metainfo.write(doc, fields, config)` | writes them, **taking the id and the name from `project.json`** and leaving every translated element alone |
| `Metainfo.create(project, config)` | a minimal metainfo that `appstreamcli validate` accepts, written beside `project.json`: a one-line summary from the description's first line, and a description paragraph |
| `Metainfo.problems(doc, path, config)` | what does not agree with `project.json` -- the id, the primary name, the file's own name -- and what the validator refuses: an empty or multi-line summary, an empty description |
| `Metainfo.rename(project, newId, [newName])` | moves the file with the id and rewrites `<id>`, `<launchable>`, a **stock** `<icon>` (a remote or local one is left alone) and, given `newName`, the primary `<name>`; refuses when a file is already at the new name |
| `Metainfo.translations(doc)` | the `<name xml:lang>` and `<summary xml:lang>` values by language, which is what a `.desktop` carries as `Name[es]` |
| `Metainfo.XMLNS` | the XML namespace, which is how `xml:lang` is spelled |

**The identity is not edited and the rest is not lost.** The id and the primary
name are one identity in three places -- the window's class, the package's name
and what a software centre shows -- so `write` takes them from the manifest on
every save and the two files cannot drift while it is the writer. Everything
else is left where it was: a `<p xml:lang="es">` survives an edit of the primary
description, because the DOM keeps what it is not asked about.
