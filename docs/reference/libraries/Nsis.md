# Nsis

The open project as a Windows installer: an NSIS script out of its metainfo.

It is Windows-only, and says so in its name -- it is not "the installer",
Flatpak is [`Package`](Package.md)'s. What it builds is the project as a
Windows application: the Windows runtime tree, the project itself and a `.cmd`
launcher, installed per-user with an uninstaller. Three verbs over one build
context: `Script` writes `<out>/<id>.nsi` (and `<out>/<id>.ico` when the
project ships a PNG icon), `Stage` copies the payload into `<out>/payload`,
and `Build` verifies that payload runs and compiles the script beside it with
`makensis`.

```js
const ctx = Nsis.Script("/home/ana/Notes", "/tmp/notes-nsis");
Nsis.Stage("/home/ana/Notes", "/tmp/notes-nsis", { Prefix: "C:\\stage" });
Nsis.Build(ctx.Script, "C:\\dist\\Notes-2.1-windows-x86_64.exe"); // Windows
```

**Only `Build` needs Windows, and only `Build` refuses anywhere else.**
`Script` is text and works wherever it is written -- the IDE writes it on any
desktop and says compiling is Windows -- and `Stage` copies whatever tree it
is pointed at. What cannot happen anywhere else is running a Windows
`bintana.exe` to prove the payload, or compiling it.

## Every member

| | | |
|---|---|---|
| `Script(project, out)` | → the script from the metainfo, answering where everything went | [the script](#the-script) |
| `Stage(project, out, [options])` | → the payload the script installs | [the payload](#the-payload) |
| `Build(script, exe, [options])` | → the setup executable, compiled on Windows | [compiling it](#compiling-it) |
| `Ico(pngPath)` | → the PNG as a `.ico`, as `Bytes` | [the icon](#the-icon) |

## The script

`Script` answers `{ Id, Command, Version, Script, Icon, Payload, Note }`: the
script's path, the `.ico` beside it (or `null`, with `Note` saying which file
would change that), and where `Stage` will put the payload the script compiles
in. **Every refusal comes before the first write**, `Package`'s rule: no id,
no metainfo, a metainfo that disagrees with `project.json`, a broken icon and
an output inside the project all stop here with a sentence.

What the metainfo becomes in NSIS, since a second reader should not have to
derive it:

| Metainfo | Installer |
|---|---|
| `Name` | the installer, the Start Menu folder, `DisplayName` |
| `Summary` | `FileDescription`, the branding line |
| `Description` | the welcome page's text |
| `DeveloperName` | `Publisher`, `CompanyName` |
| `Homepage` | `URLInfoAbout`, the finish page's link |
| `ProjectLicense` | nowhere: it is a license id, not copyright text |
| `Categories` | nowhere: Windows has no categories |
| `Bugtracker` | nowhere: the installer is not the place for it |

Per-user throughout (`RequestExecutionLevel user`,
`$LOCALAPPDATA\Programs\<command>`), so installing needs no elevation. An NSIS
string holds no `$` and no bare `"`, so both are escaped on the way in -- and a
line break becomes the `\r\n` the script spells literally, while a backslash
passes through untouched, which is why the payload is named with them. The
version's numeric head becomes `VIProductVersion` (`"2.1"` is `"2.1.0.0"`);
anything else leaves the version resource out rather than writing one
`makensis` would refuse the script over.

Three sections: `Application` (required) installs `payload/` beside the script,
writes the uninstaller and registers the Add/Remove Programs entry under the
id; `Desktop shortcut` adds one on the desktop; `Uninstall` removes the
shortcuts, the directory and the registry key.

## The payload

`Stage` copies the Windows runtime tree the caller points at
(`options.Prefix`, or the tree this runtime runs from): `bin/bintana.exe` and
its DLLs, the data GTK opens by name (schemas, the pixbuf cache, GIO modules,
Adwaita and hicolor, GtkSourceView, the MIME database, the font setting), the
shipped libraries the project's `uses` resolve from -- and the project itself
under `share/bintana/apps/<command>`, the way `Package.Write` copies it, with
a `.cmd` launcher beside the executable. It answers the payload directory.

The tree is copied by name and not collected by link: a development checkout
is not a shippable tree, and `ldd` is an MSYS2 program no Windows user has.
What is refused is a prefix with no `bin/bintana.exe` in it. What is
deliberately left out is the IDE, the examples and the compiler -- an
application installer ships the application, and `makensis` stays with whoever
builds it.

## Compiling it

`Build` refuses outside Windows: the payload is a Windows tree, and proving it
runs means running it. On Windows the staged `bintana.exe --version` is asked
first -- the same proof the CI gives the portable build -- and a payload that
does not run stops here instead of becoming an installer that installs
something broken. `options.Makensis` names the compiler; without it the tree's
own `share/bintana/tools/nsis` is tried first and then the PATH.

## The icon

`Ico` answers the PNG as a `.ico` NSIS can wear: the 6-byte directory, one
16-byte entry and the file's own bytes verbatim -- nothing is decoded and
nothing is scaled, so what the installer shows is the drawing the project
ships. A 256-pixel side is written as 0, which is how the format spells it.

`Script` wraps `icons/<id>.png` by name, measured the way `Package` measures
it -- a broken one is refused rather than wrapped. Anything else keeps NSIS's
own icon: an svg cannot be worn, and no drawing at all is the ordinary state
of a project that never needed one. Two drawings with none named after the id
is refused, the same refusal `Package` makes: not guessing which drawing is
the application.
