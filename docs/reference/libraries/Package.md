# Package

A project as the files a package is built from.

`Package.Write` takes a project directory and an output directory and writes
four files and a manifest: the metainfo, the `.desktop` entry, the icon named
after the id, a copy of the project, and `<id>.json` -- the Flatpak manifest
`flatpak-builder` reads. It ships in the `package` library and is reached with
`uses`.

```json
{ "name": "Notes", "id": "io.github.you.Notes", "uses": ["package"] }
```

```js
const written = Package.Write("/home/ana/Notes", "/tmp/notes-out");

print(written.Command);    // "bintana-notes"
print(written.Manifest);   // /tmp/notes-out/io.github.you.Notes.json
```

Then the output directory is a build context, and the build is one command:

```sh
flatpak-builder /tmp/notes-out/io.github.you.Notes.json
```

**It writes and it does not build.** What `flatpak-builder` does with the files
is its own business, and the runtime has no part in it; what this owns is what
the files must say.

## Every member

| | | |
|---|---|---|
| `Write(project, out, [options])` | → where each artefact went | [writing](#writing) |
| `defaults` | what the manifest carries when the caller says nothing | [the manifest](#the-manifest) |
| `configOf(project)` | `project.json` as `{ Id, Name, Version, Dir }` | [the manifest](#the-manifest) |
| `commandName(id)` | `bintana-notes` for `io.github.you.Notes` | [the command](#the-command) |

## Writing

`Write(project, out, [options])` answers an object and not nothing, because the
caller -- a build step, a script, the IDE -- needs to know where the manifest
is:

| | |
|---|---|
| `Id` | the application's id, from `project.json` |
| `Command` | the launcher's name, `bintana-` and the id's last element |
| `Manifest` | `<out>/<id>.json` |
| `Metainfo` | `<out>/<id>.metainfo.xml` |
| `Desktop` | `<out>/<id>.desktop` |
| `Icon` | `<out>/<id>.svg` or `<out>/<id>.png` |
| `Project` | `<out>/project/`, the copy the manifest builds from |

**The project copy leaves out hidden entries.** `.git` and `.cache` are not the
program; everything else travels, including a `lib/` of its own. It is a copy
and not a reference, so the output directory can be moved and built anywhere --
which is what a build machine needs.

**And it refuses, with a sentence, what would become a wrong package.** A
project with no `id` (there is nothing to install under and no name for the
metainfo), one with no metainfo, one with no icon (AppStream will not compose an
application without one), and one whose metainfo disagrees with `project.json`.
Each of those fails half a build later otherwise, by another program, naming
something nobody wrote.

## The manifest

`Write` lays `options` over `Package.defaults`, one key at a time:

| | |
|---|---|
| `Runtime`, `RuntimeVersion`, `Sdk` | the GNOME runtime the base was built against. Default `org.gnome.Platform`, `"50"`, `org.gnome.Sdk` |
| `Base`, `BaseVersion` | the shared BaseApp and its branch. Default `io.github.getbintana.BaseApp`, and the runtime's own release -- `BTA_VERSION`'s first two numbers -- because the base's branch *is* that release |
| `Branch` | the application's own branch. Default `"stable"` |
| `FinishArgs` | the sandbox permissions. Default the four a windowed application needs: `--share=ipc`, both display sockets and `--device=dri` |

The module is `simple`, and its sources are all beside the manifest: the project
copy, the entry, the metainfo and the icon. The build commands put each one
where a desktop reads it -- `/app/share/applications`, `/app/share/metainfo`,
`/app/share/icons/hicolor` -- and install the launcher script as the command.

**The command is a script and not the runtime.** A package runs `bintana` on its
own project, which lives inside the sandbox, and the launcher is the one line
that makes that a word a menu can run.

## The command

`commandName(id)` is `bintana-` and the **last element** of the id, lowercased
and with everything that is not a letter or a digit turned into a dash: the last
element is the part that names the application, and `io.github.you.My App`
becomes `bintana-my-app`.

## What the entry says

The `.desktop` is written through `Desktop.Entries.Write`, so the format's
quoting is the runtime's and not a second spelling of it. Two things are this
module's:

- **`StartupWMClass` is the id**, which is the class the window really has --
  the runtime hands the id to `GtkApplication` and to the program name. An entry
  claiming anything else is one a dock can never match.
- **`%f` is appended and not passed through `Exec`.** `Exec` is for a command
  line, where a `%` is a literal that has to be doubled; a field code is the
  format's own and is written as it is.

The translations travel too: a `<name xml:lang="es">` in the metainfo is a
`Name[es]` in the entry, so the menu and the software centre say the same thing.
