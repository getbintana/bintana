# The Flatpak repository

`build.yml` is the workflow of a **separate** GitHub repository that builds the
BaseApp, the IDE and the example out of [`getbintana/bintana`][source] and
publishes them as a Flatpak repository on its own `gh-pages` branch.

[source]: https://github.com/getbintana/bintana

## One-time setup

Create the repository (`getbintana/flatpak`, or any name) **empty** on GitHub,
then, from a checkout of `bintana`:

```sh
git clone git@github.com:getbintana/flatpak.git
cd flatpak

# The workflow, which is what runs the builds.
mkdir -p .github/workflows
cp ../bintana/flatpak/ci/build.yml .github/workflows/build.yml
git add .github/workflows/build.yml
git commit -m "the workflow"
git branch -M main          # a fresh clone has no branch until this commit

# The branch the repository is published on, empty and with no history in
# common with the workflow's.
git checkout --orphan gh-pages
git rm -rf .
git commit --allow-empty -m "the published repository"

git push origin main gh-pages
```

Pushing `main` is what starts the first build (the workflow runs on a push to
`main`), and it builds everything — that is the first publish. If it does not
start, run it by hand: *Actions → flatpak repository → Run workflow*.

Then **Settings → Pages**: source *Deploy from a branch*, branch `gh-pages`,
folder `/`.

A source repository that is not public needs a token to be checked out; the
default `GITHUB_TOKEN` of this repository can only read this one. Everything
else needs no secret.

## What users do

```sh
flatpak remote-add --if-not-exists --no-gpg-verify bintana \
    https://getbintana.github.io/flatpak/
flatpak install bintana io.github.getbintana.Ide
```

**`--no-gpg-verify` is for the first tests.** The repository is unsigned until
there is a project key; then the summary is signed with
`tools/flatpak-build.sh <repo> --sign <key>` and the public key goes into a
`.flatpakrepo` file, which is what a user adds instead of a bare URL. That file
is one INI document:

```ini
[Flatpak Repo]
Title=Bintana
Url=https://getbintana.github.io/flatpak/
Homepage=https://github.com/getbintana/bintana
GPGKey=<base64 of the public key>
```

## What it rebuilds

`builds.json` on `gh-pages` records the source commit and tag the published refs
were built from. On every run the workflow compares that against the source's
HEAD:

| changed | rebuilt |
|---|---|
| a new tag | everything |
| the runtime, `lib/`, the vendor, the build files | the BaseApp **and every app** -- a BaseApp's files are copied into each application at build time, so a new base is a new app |
| `ide/**`, `docs/**` | the IDE alone |
| `examples/hello/**` | the example alone |

The last two are the point of the split: the IDE and each application are their
own refs, so a change to one does not rebuild the other, and the BaseApp is
small enough that a rebuild of it is the only thing that costs anything.
