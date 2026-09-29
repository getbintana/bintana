# Bintana: working on the runtime

These documents go under the runtime's surface — how it is built and why, what
the file formats mean exactly, and what it takes to extend either side. They
are written for somebody changing this tree; the documentation an application
author reads lives in two repositories of its own:

| | |
|---|---|
| [`bintana-docs`](https://github.com/getbintana/bintana-docs) | the reference and the contract: a page per class and per global, the compact `llm/` pages, the formats, the designer. What the IDE shows as help, and what `bintana-docs`' own check holds to `api.json` |
| [`bintana-llm`](https://github.com/getbintana/bintana-llm) | `llm.txt` and the step-by-step guide for writing an application without the IDE |

What stays here changes with the runtime, and is what a change to it has to
move with:

| Document | What is in it |
|---|---|
| [architecture.md](architecture.md) | Boot sequence, the C/JS split, the class table, event dispatch, the object model, lifetimes and teardown |
| [extending.md](extending.md) | Adding a widget, a property, an enum, an event — and the traps that cost time |
| [plugins.md](plugins.md) | Native code outside the tree: a `<name>.so` inside a library, the callback table a plugin is written against, how to build one, and the TagLib wrapper as the worked example |
| [installing.md](installing.md) | Building and installing it on Fedora and Debian/Ubuntu: dependencies per distribution, the optional ones and what each turns on, staging an install, and what the test suites need |
| [testing.md](testing.md) | The test projects, what they can prove, what the suites need, and what has to be checked by hand |
| [ide-internals.md](ide-internals.md) | How the IDE is built: its parsers, its caches, how a form is built and drawn, the shape of the tree. The half of the IDE's documentation that is about changing it |
| [llm/issues.md](llm/issues.md) | **What is deliberately not here**: the curated language's decisions, what is missing, and what to do about it. What an application author is told to read before inventing something |
| [plans/](plans/README.md) | **Designs argued before they are code**: each saying in its first lines whether it is built, waiting for a caller or not started |
| [issues/](issues/README.md) | **Reported gaps**: what the runtime is missing, each written in the form `llm/issues.md` asks for — never how to add it |

Working *on* this repository — commands, conventions, the trap list — is
[`AGENTS.md`](../AGENTS.md). Writing an application *with* it is
[`bintana-docs`](https://github.com/getbintana/bintana-docs) and
[`bintana-llm`](https://github.com/getbintana/bintana-llm).

The one rule stays where it was: **the IDE is written in Bintana and has no
privileged API.** When it needs something the runtime lacks, what gets added is
a runtime feature every application then has. The corollary runs the other way
too: before writing C, check whether the thing is expressible as a Bintana
form. `AskForm`, `ConfirmForm`, `NewProjectForm` and `AboutForm` are dialogs,
not runtime primitives — the last one although GTK ships a `GtkAboutDialog`.
