# Bintana technical documentation

The top-level [`README.md`](../README.md) is the presentation: what Bintana is
and where each document lives. These documents go under that surface — how the
runtime is built and why, what the file formats mean exactly, and what it takes
to extend either side.

| Document | What is in it |
|---|---|
| [first-app.md](first-app.md) | **Start here to write an application in the IDE**: the shape of a project and a five-minute tutorial ending in a greeting |
| **[reference/](reference/README.md)** | **One page per class and per global, for the person writing an application**: what it is, which neighbour to use instead, an example off the tree, every member explained, and what goes wrong. The long form of `llm/controls.md` and `llm/library.md`, and what the IDE shows as help |
| **[llm/](llm/README.md)** | **The public contract**: everything needed to write an application, and nothing about the runtime. Nine files, addressed to whoever writes one — a person or a language model. Start here if you are writing an application rather than the runtime |
| [architecture.md](architecture.md) | Boot sequence, the C/JS split, the class table, event dispatch, the object model, lifetimes and teardown |
| [installing.md](installing.md) | Building and installing it on Fedora and Debian/Ubuntu: dependencies per distribution, the optional ones and what each turns on, staging an install, and what the test suites need |
| [formats.md](formats.md) | `project.json`, the `.form` grammar, serialisation rules, the icon directory |
| [runtime-api.md](runtime-api.md) | Everything a project sees as a global, plus what `rad.js` adds to the prototypes |
| [widgets.md](widgets.md) | Per-widget semantics: what each control is made of in GTK, and the behaviour a table cannot state |
| [extending.md](extending.md) | Adding a widget, a property, an enum, an event — and the traps that cost time |
| [plugins.md](plugins.md) | Native code outside the tree: a `<name>.so` inside a library, the callback table a plugin is written against, how to build one, and the TagLib wrapper as the worked example |
| [resources.md](resources.md) | Text as a resource: which properties hold prose, `po/` catalogues, `Locale`, design values, and extraction |
| [ide.md](ide.md) | How the IDE and its designer work, as a Bintana application with no privileges |
| **[plans/](plans/README.md)** | **Designs argued before they are code**: the ten of them, each saying in its first lines whether it is built, waiting for a caller or not started — records and forms, git and the debugger, `--strict`, completion, `Exec.Wait`, what `Http.Server` refuses, Windows, macOS and the `.bta` bundle |
| [issues/](issues/README.md) | **Reported gaps**: what the runtime is missing, each written in the form `llm/issues.md` asks for — never how to add it |
| [testing.md](testing.md) | The four test projects, what they can prove, what `tests/install.sh` proves about an installed copy, and what has to be checked by hand |

Working *on* this repository — commands, conventions, the trap list — is
[`AGENTS.md`](../AGENTS.md), and it is the one document a change to the API, the
runtime or the widgets has to move with: whatever you had to read the C to find
out goes there, so the next person does not. Writing an application *with* it is
[`llm/`](llm/README.md), which is the only part meant to be handed to somebody
who has not read the rest.

## The one rule

**The IDE is written in Bintana and has no privileged API.** When it needs
something the runtime lacks, what gets added is a runtime feature every
application then has. Recent examples, all of which exist because the IDE
needed them: `Arrangement`, `Split`, `SourceEditor`, `Terminal`, `Notebook`,
`Switcher`, `Image`, `RowList`, `DragData`/`AcceptDrop`, dynamic menu items,
`Application.ConfigDirectory`, `Application.HasIcon`, `SourceEditor`'s search,
`Terminal.LinkPattern`, menu items that hold a state, `TextBox.Placeholder`,
`Widget.TextProperties()`, `Widget.Types()`, `Widget.EventNames()`,
`SourceEditor.Completion`, `TableView`, `Application.HasCommand()` and
`Action` — the last of which the IDE needed most visibly of all: three of its
commands were written four times each, with their availability computed in two
files with two different expressions.

The corollary runs the other way and is easier to forget: before writing C,
check whether the thing is expressible as a Bintana form. `AskForm`,
`ConfirmForm`, `NewProjectForm` and `AboutForm` are dialogs, not runtime
primitives -- the last one although GTK ships a `GtkAboutDialog`.
