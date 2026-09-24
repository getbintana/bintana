# The Flatpak repository

`build.yml` and `apps/` are the workflow and the registry of a **separate**
GitHub repository -- this one -- that builds the Bintana BaseApp and every
application in `apps/` out of their own sources, and publishes them as a
Flatpak repository on its own `gh-pages` branch.

**Nothing here names an application.** `apps/` is the list, the workflow
discovers it, and `tools/flatpak-plan` (in [`getbintana/bintana`][source])
decides what has to be rebuilt. Adding an application is adding a directory.

[source]: https://github.com/getbintana/bintana

## One-time setup

Create the repository (`getbintana/flatpak`, or any name) **empty** on GitHub,
then, from a checkout of `bintana`:

```sh
git clone git@github.com:getbintana/flatpak.git
cd flatpak

# The workflow and the registry, which is what runs the builds.
mkdir -p .github/workflows
cp ../bintana/flatpak/ci/build.yml .github/workflows/build.yml
cp -r ../bintana/flatpak/ci/apps .
git add .github/workflows/build.yml apps
git commit -m "the workflow and the applications it builds"

# The branch the repository is published on, empty and with no history in
# common with the workflow's.
git checkout --orphan gh-pages
git rm -rf .
git commit --allow-empty -m "the published repository"

git push origin main gh-pages
```

Pushing `main` starts the first build, and it builds everything -- that is the
first publish. If it does not start, run it by hand: *Actions → flatpak
repository → Run workflow*.

Then **Settings → Pages**: source *Deploy from a branch*, branch `gh-pages`,
folder `/`.

## Adding an application

A directory in `apps/` whose name is the application's, with one `app.json`.
The name is the key in `builds.json` and in the workflow's output; the `id` is
what a package installs under.

**An application with a repository of its own** -- what a third party does:

```json
{
  "id": "com.example.MyApp",
  "repo": "https://github.com/someone/myapp.git",
  "project": "."
}
```

| | |
|---|---|
| `id` | the application id, which the project's `project.json` and its `<id>.metainfo.xml` also declare |
| `repo` | where the source lives. It has to be reachable by the runner, so a private one needs a token and this file is not where that goes |
| `ref` | the branch or tag to build. Absent means the default branch. A commit id is not a ref: put a tag on what you want |
| `project` | the Bintana project inside that repository, packaged by `tools/pack.sh` |
| `manifest` | **or** a Flatpak manifest, built as it is -- what the IDE uses, because it ships the reference F1 reads as well as its project |
| `watch` | the paths in the source whose change rebuilds it. Default `.`, meaning all of it |

**An application that lives in the runtime's repository** -- the IDE and the
examples -- leaves `repo` out and names a path inside it:

```json
{
  "id": "io.github.getbintana.Hello",
  "project": "examples/hello",
  "watch": ["examples/hello"]
}
```

`watch` is what keeps one of those from rebuilding the others: the runtime's
repository is the only source whose history the run has, so it is the only one
where *what changed inside it* can be asked. An application with a `repo` of its
own is rebuilt when the commit it was built at and its HEAD differ, whatever the
paths.

**What the project needs** is what the packaging step asks for: an `id`, an
`<id>.metainfo.xml` that agrees with `project.json`, and a drawing in `icons/`.
A project without them is refused with a sentence -- add them, push, and run the
workflow again.

## What it rebuilds

`builds.json` on `gh-pages` records the tag, the BaseApp's commit and one entry
per application. On every run:

| changed | rebuilt |
|---|---|
| a new tag, or no state at all | everything |
| the runtime, `lib/`, the vendor, the packaging tool, `CMakeLists.txt` | the BaseApp **and every application** -- a BaseApp's files are copied into each application at build time |
| `ide/**`, `docs/**` | the IDE alone |
| `examples/hello/**` | the example alone |
| an application's own repository | it alone |

## What users do

```sh
flatpak remote-add --if-not-exists --no-gpg-verify bintana \
    https://getbintana.github.io/flatpak/
flatpak install bintana com.example.MyApp
```

**`--no-gpg-verify` is for the first tests.** The repository is unsigned until
there is a project key; then the summary is signed with
`tools/flatpak-build.sh <repo> <apps> <sources> --sign <key>` and the public key
goes into a `.flatpakrepo` file, which is what a user adds instead of a bare
URL:

```ini
[Flatpak Repo]
Title=Bintana
Url=https://getbintana.github.io/flatpak/
Homepage=https://github.com/getbintana/bintana
GPGKey=<base64 of the public key>
```
