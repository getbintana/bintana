# The ecosystem: a library a stranger can publish and another can install

**Status: design, not built (2026-11-12).** A project says `uses: ["charts"]` and
the runtime finds a directory of `.js`/`.form` files in one of six places. What
does not exist is the road from *somebody else wrote a library* to *this project
uses it*: no registry, no version, no install, no update, no lock. This plan
starts with the smallest road that works -- a static index, a vendored copy and
a lock file -- and leaves a resolver for the day a real dependency graph asks
for one.

## What exists today

- `uses` names a library; `bta_runtime.c` searches six places, first the
  project's own `lib/<name>`, then `$BINTANA_LIB_PATH`, then the shipped `lib/`.
- A library is a directory: `.js`, `.form`, optional `project.btp` (`sources`,
  `worker`) and optional native code (`<name>.so`, the plugin ABI).
- The shipped libraries (`charts`, `report`, `xlsx`, `markdown`, `dialog`,
  `datagrid`, `pdfview`, `propertygrid`, `check`, `package`, `qr`) are
  directories in this repository, copied by `cmake --install`.
- There is no manifest with a version, no checksum, no index and no command
  that puts a library into a project. A person copies a folder and edits
  `project.btp` by hand.
- The IDE's project tree lists `lib/` libraries like any other folder; the
  palette and completion see the classes once the project `uses` them.
- Templates are *a form* or *a function* in the IDE's New dialog. There is no
  project template, no gallery, no forum.

## What "ecosystem" means here

Five verbs, in the order an author meets them:

1. **Publish** -- a library has a name, a version, a repository and a licence.
2. **Find** -- somebody can see what exists and what it is for.
3. **Install** -- one command puts it in the project, with its version written
   down.
4. **Update / remove** -- the project can move to a newer version or let it go,
   and can still build from a clean checkout.
5. **Start** -- a project template gives a working application, not an empty
   form.

A forum and a website are part of the answer; they are not the same project as
the installer, and this plan keeps them at the end.

## The recommendation: an index, a vendor, a lock

**A static, curated index plus a copy under the project's `lib/`**, with exact
versions and checksums. No semver resolver in v1.

- **The index is data**, not a server: `libraries.json` in a repository
  (`getbintana/libraries`), published as a file. Each entry:

  ```json
  {
    "name": "charts",
    "summary": "Line, bar, area and pie charts for a DrawingArea",
    "repository": "https://github.com/getbintana/bintana",
    "version": "1.0.0",
    "path": "lib/charts",
    "bintana": ">=0.3",
    "license": "MIT",
    "sha256": "…",
    "tags": ["chart", "drawing"],
    "native": false
  }
  ```

  A second entry with the same name and another version is how a version is
  offered; the index is the catalogue, not a solver.

- **`bintana add <name>[@version]`** is a console project (`tools/add`, no GTK)
  that reads the index, picks the exact version (the latest by default), downloads
  the archive from the repository or a release URL, verifies `sha256`, extracts
  to `<project>/lib/<name>`, and adds the name to `uses` in `project.btp` if it
  is not there. `bintana remove <name>` takes it out and removes the entry;
  `bintana list` shows what is installed and what the index offers.
- **`bintana.lock`** in the project root records, for each installed library:
  name, version, source URL, sha256 and (if a repository archive is not stable)
  the commit. A clean checkout plus `bintana install` reproduces the tree
  without a network resolver. The lock is JSON and readable, like `project.btp`.
- **Vendoring is the model.** The runtime already finds `<project>/lib/<name>`
  first; copying is what makes an installed project build offline and on
  another machine. A global package cache is a later optimisation, not the
  first design.
- **No transitive dependencies in v1.** A library that needs another vendors it
  or documents it; a `requires` list and recursive install is v2, after a real
  library asks for it. The lock file leaves room for the list.
- **No semver range resolver in v1.** `@version` is exact; the index may carry
  compatibility prose. A resolver is a project of its own, and a wrong version
  picked automatically is worse than a pinned one a person chose.

### What a library is

Keep the current shape: a directory with `.js`/`.form` files, an optional
`project.btp` for `sources`/`worker`, an optional native `.so` and a README.
The index carries the metadata the runtime does not need; a `library.json` in
the directory would be a second manifest to keep in sync, and `project.btp`
already exists. If a library needs an icon for the IDE, the convention
`icons/<name>.svg` is enough.

### Trust, and what it does not promise

A library's JavaScript runs with the application's permissions; a native `.so`
runs arbitrary code. The index is curated, the checksum detects a changed
archive, and the README says what the library is. None of that is a sandbox.
The plan states it in the docs rather than implying a safety the runtime does
not have. A library that needs a native half is marked `"native": true` so a
person can see it before installing.

### Templates

A template is a project directory with a `project.btp` and sources, plus
`template.json`:

```json
{
  "name": "crud-sqlite",
  "summary": "A list, a form, a record and a SQLite table",
  "bintana": ">=0.3",
  "variables": ["Name", "Title"]
}
```

`bintana new <template> <dir>` copies it, replaces `{{Name}}`/`{{Title}}` in
paths and text, and runs `bintana check`. The IDE's New Project dialog gains a
gallery over the same index; it is the same data, not a second catalogue.
Templates are the answer to *what do I build first*: `crud-sqlite`, `report`,
`http-server`, `console-tool`, each a small working project rather than an
empty form.

### Docs and community

- A website with the install command, the index, the templates and a showcase.
- A forum (GitHub Discussions is the cheapest start, a Discourse when it
  outgrows it) for *how do I*, not for bug reports; the issue tracker stays the
  bugs.
- A release feed and a changelog per library, the same discipline the runtime
  already has.

## Stages

0. **Inventory and format** (2-3 days). Count what the shipped libraries need:
   `sources`, `.form`, native, icons, `uses`. Write the JSON shape and a local
   index with three entries; no installer.
1. **`bintana add` / `remove` / `list`** (1 week). The static index, checksum,
   copy under `lib/`, `uses`, `bintana.lock`; a test index served from a
   temporary directory; no network in the suite.
2. **`bintana install` and updates** (3-5 days). A clean checkout reproduces
   from the lock; `update <name>` moves one library and rewrites the lock;
   `remove` is the inverse of add.
3. **Templates** (1 week). The format, `bintana new`, two real templates, the
   IDE gallery.
4. **The IDE's library page** (1 week). Browse the index, install/remove,
   show the lock and what is outdated; the tree already lists `lib/`.
5. **Transitive requirements and semver** -- only when a library asks; the lock
   and the index carry the fields from the first version.
6. **Website and forum** -- parallel, once there is something to install.

## Tests

- A local index and archive under a temporary directory: add, list, remove,
  install from a lock, update, a checksum mismatch refused, a name that is not
  in the index refused, an archive that escapes its directory refused (the zip
  reader already has the rule).
- A project with `uses: ["charts"]` installed from the index passes
  `bintana check` and runs an example; removing it makes `check` name the
  missing library.
- A native library is marked and installed; a build without its dependency still
  checks the project (the `.so` is optional code, like a plugin).
- A template is instantiated twice under different names; `bintana check`
  passes; the IDE's New Project writes the same tree.
- No test reaches the network: the index and the archive are local; a public
  index is a release artifact, not a test dependency.

## Prior art

- **npm / Cargo**: a registry, a lock and a resolver; the lock is the part that
  matters, and it is what this plan keeps first.
- **Flatpak**: an index (the remote), a ref and a checksum; the model is close
  and already familiar to this project's packaging.
- **Delphi GetIt** and **Gambas components**: a catalogue inside the IDE; the
  gallery is the same shape.
- **VS Code extensions**: a marketplace with versions and install; the part
  this plan deliberately leaves out is the central server.

## Open questions for the owner

1. **Where the index lives**: a file in `getbintana/libraries` served by GitHub
   Pages, or a generated file in the main repository. A static file is enough
   for v1; a server is not.
2. **Name ownership**: first come, or a namespace (`author/name`)? A flat name
   matches `uses` today; a namespace needs a syntax change.
3. **Native code**: allow it with a flag, or keep the first index pure
   JavaScript? The plugin ABI already exists; trust is the question.
4. **Semver**: exact versions only in v1; when does a range earn its resolver?
5. **The lock's name**: `bintana.lock` versus a section of `project.btp`; a
   separate file is easier to merge and to ignore.
6. **Templates and libraries in one index or two?** One file with a `kind` is
   less machinery; two files are easier to review.

## What not to do

- A central server before there is a second library.
- A resolver that picks a version silently.
- A global install that a clean checkout cannot reproduce.
- A library manifest that duplicates `project.btp`.
- A marketplace UI before `bintana add` works from a shell.
- A native library without saying, in the index and the docs, that it runs with
  the application's permissions.
