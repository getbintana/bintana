# The Windows installers

`build.yml` and `apps/` are the workflow and the registry of a **separate**
GitHub repository -- `getbintana/windows` -- that builds a Windows installer
for every application in `apps/` out of its own sources, and publishes each as
a release of that repository.

It is the Flatpak repository's twin (`flatpak/ci`): the same registry, the same
"nothing here names an application", the same smoke before the publish. What
differs is the product -- a setup executable instead of an OSTree branch -- and
so where it goes: GitHub releases, and the state on a `state` branch.

## One-time setup

Create the repository (`getbintana/windows`, or any name) **empty** on GitHub,
then, from a checkout of `bintana`:

```sh
git clone git@github.com:getbintana/windows.git
cd windows

# The workflow and the registry, which is what runs the builds.
mkdir -p .github/workflows
cp ../bintana/windows/ci/build.yml .github/workflows/build.yml
cp -r ../bintana/windows/ci/apps .
cp ../bintana/windows/ci/README.md .
git add .github/workflows/build.yml apps README.md
git commit -m "the workflow and the applications it builds"

# The branch the state is kept on, empty and with no history in common with
# the workflow's.
git checkout --orphan state
git rm -rf .
git commit --allow-empty -m "what was built, and from what"

git push origin main state
```

Pushing `main` starts the first build, and it builds everything. If it does
not start, run it by hand: *Actions → windows installers → Run workflow*,
which also has the box that rebuilds everything whatever changed.

## Adding an application

A directory in `apps/` whose name is the application's, with one `app.json` --
**the same file the Flatpak repository takes**, minus what only a Flatpak has:

| | |
|---|---|
| `id` | the application id, which the project's `project.json` and its `<id>.metainfo.xml` also declare |
| `repo` | where the source lives, reachable by the runner |
| `ref` | the branch or tag to build. Absent means the default branch. A commit id is not a ref: put a tag on what you want |
| `project` | the Bintana project inside that repository, packaged by `tools/pack.sh --nsis` |
| `watch` | for an application in the runtime's repository, the paths whose change rebuilds it. Default `.` |
| `with` | paths of the runtime tree the installer carries **besides the runtime**, relative to it (`share/bintana/examples`). One the tree does not have stops the run: it is never left out quietly |

`manifest` and `finish-args` are the Flatpak's and mean nothing here. **The
IDE is registered as the project it is** (`ide`), and carries `with` what
makes it the portable zip's equal: the examples, the runtime's documentation
and the bundled NSIS that *Project → Windows installer…* compiles with -- the
same setup the runtime's own `windows` job attaches to a runtime release. The
F1 reference is in neither: it is `bintana-docs`, and without it F1 builds the
topic from the runtime.

**What the project needs** is what the packaging step asks for: an `id`, an
`<id>.metainfo.xml` that agrees with `project.json`, and -- for the
installer's own icon, the shortcuts' and the one in *Installed apps* --
`icons/<id>.png`. An svg cannot be worn by NSIS: a project with only one
builds, with the generic icon and a note in the log.

## What it rebuilds

`builds.json` on `state` records the runtime's commit and one entry per
application. On every run:

| changed | rebuilt |
|---|---|
| no state at all, or *Run workflow* with "everything" ticked | everything |
| the runtime, `lib/`, the vendor, `tools/pack`, `tools/windows-portable.sh`, `CMakeLists.txt` | every application -- each installer carries its own copy of the runtime |
| an application's `watch` paths in the runtime's repository | it alone |
| an application's own repository | it alone |
| an application's registration (`app.json`) | it alone |

## What it publishes

A release named `<app>-<version>` (`project-0.2.0rc1`), the version being the
project's own `project.json`, with
`<command>-<version>-windows-x86_64.exe` attached. A version with a letter in
it is a **prerelease**, so the repository's *latest* stays on the last final
one. A rebuild under the same version -- the runtime moved, the application did
not -- **replaces** the setup in that release; a new version is a new release.

The release is created at this repository's commit, not the application's:
the tag names the build, and the notes say which commit of the application and
of the runtime went into it.

## What it runs

Before anything is published, every setup this run built is **installed**,
silently (`/S`, into a directory of the run's own), and the installed tree is
run: `bin/bintana.exe --version`, which is the DLL closure, and one console
project, which is the runtime working out of a tree that is not the build one.
The launcher the shortcut points at and the application's `project.json` have
to be where the script put them. A setup that installs a program that does not
start is not released.

What is **not** run is the application's window: a hosted runner may have no
desktop for it to open on, which is the same reason the runtime's own job only
glances at the IDE.

**Nothing here is verified on Windows by whoever edits it**, as with
`tools/windows-portable.sh`: the run's log is the first place a change is seen
working.
