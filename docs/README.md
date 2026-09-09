# Bintana technical documentation

The top-level [`README.md`](../README.md) is the overview and the quick
reference: what Bintana is, how to write an application, and what every widget
exposes. These documents go under that surface — how the runtime is built and
why, what the file formats mean exactly, and what it takes to extend either
side.

| Document | What is in it |
|---|---|
| **[llm/](llm/README.md)** | **The public contract**: everything needed to write an application, and nothing about the runtime. Eight files, addressed to whoever writes one — a person or a language model. Start here if you are writing an application rather than the runtime |
| [architecture.md](architecture.md) | Boot sequence, the C/JS split, the class table, event dispatch, the object model, lifetimes and teardown |
| [formats.md](formats.md) | `project.json`, the `.form` grammar, serialisation rules, the icon directory |
| [runtime-api.md](runtime-api.md) | Everything a project sees as a global, plus what `rad.js` adds to the prototypes |
| [widgets.md](widgets.md) | Per-widget semantics: what each control is made of in GTK, and the behaviour a table cannot state |
| [extending.md](extending.md) | Adding a widget, a property, an enum, an event — and the traps that cost time |
| [resources.md](resources.md) | Text as a resource: which properties hold prose, `po/` catalogues, `Locale`, design values, and extraction |
| [ide.md](ide.md) | How the IDE and its designer work, as a Bintana application with no privileges |
| [data-plan.md](data-plan.md) | **Not a feature**: the design for binding records to forms and reading them from a database, **wanted and waiting for a caller**, not for a prerequisite: every one it named is built (the focus events, the grid, a `Record` that holds a list of records, and `Database.Sqlite` + `Table`), so only the declarative half is left. Thirteen findings from two hand-written screens are in it, three of which corrected the design |
| [async-plan.md](async-plan.md) | **One decision and one deferral**: `Exec.Wait` for the case that hurts, and why the language has no word yet for *do this, then that* — with what would reopen it |
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
