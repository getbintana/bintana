# Bintana

Bintana is a RAD environment for building desktop apps with visual forms and plain JavaScript on GTK4.

A RAD environment in the spirit of Visual Basic and Gambas: forms laid out by
absolute coordinates, one class per form, and handlers that wire themselves up
by name. The engine is **QuickJS** embedded in a **GTK4** runtime written in C.

The language is plain modern JavaScript. What is VB-like is the *model* — forms,
controls, `Control_Event` methods, no imports, no build step for the code.

**The IDE is written in Bintana and runs on this runtime.** That is the rule of
the project: the IDE has no privileges and no special API. When it needs
something the runtime lacks, what gets added is a runtime feature that every
application then has.

## Quickstart

```sh
git clone --recurse-submodules https://github.com/getbintana/bintana.git
cd bintana
cmake -S . -B build && cmake --build build -j
./build/bintana ide examples/hello    # the IDE, opening an example project
./tests/run.sh                        # the suite, on a virtual display
```

Dependencies: `gtk4` (4.10 or newer), `gtksourceview-5` (both with headers),
a C compiler, CMake and pkg-config. QuickJS is vendored as a submodule. Per-distribution
package names, the optional dependencies, installing and uninstalling are in
[docs/installing.md](docs/installing.md).

## Writing an application

The documentation an application author reads is two repositories of its own,
and neither needs this tree:

- **[bintana-docs](https://github.com/getbintana/bintana-docs)** — one page per
  control and per global, each member explained (what the IDE shows as help,
  F1), the compact `llm/` contract, the `.form` format and the designer.
- **[bintana-llm](https://github.com/getbintana/bintana-llm)** — `llm.txt` and
  the step-by-step guide for writing every file by hand, without the IDE.

Both are checked against [`api.json`](api.json), the public surface as data,
which `./tools/apijson.sh` builds out of the descriptions written beside each
member here.

## Documentation for this tree

[docs/](docs/README.md) is the index of what is about *working on the runtime*:
the runtime ([architecture](docs/architecture.md)), extending it
([extending](docs/extending.md)), native plugins ([plugins](docs/plugins.md)),
installing ([installing](docs/installing.md)), the IDE's own machinery
([ide-internals](docs/ide-internals.md)) and testing ([testing](docs/testing.md)).

What is missing, already decided, or still planned lives with the gaps:
[docs/issues/](docs/issues/README.md), [docs/llm/issues.md](docs/llm/issues.md)
and [docs/plans/](docs/plans/README.md), which is where every `*-plan.md` now
lives. [`AGENTS.md`](AGENTS.md) is the working notes: commands, conventions and
the trap list.

## Licence

MIT — see [LICENSE](LICENSE).

QuickJS-ng, vendored under `vendor/quickjs`, is MIT as well and carries its own
[LICENSE](vendor/quickjs/LICENSE); its copyright notice has to travel with any
copy of it, which is what that file is for. Nothing else is bundled: GTK4,
GtkSourceView and VTE are linked against and belong to their own projects.
