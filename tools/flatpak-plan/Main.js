/*
 * What has to be rebuilt, out of the application registry and the recorded
 * state.
 *
 *   bintana tools/flatpak-plan <apps-dir> <sources-dir> <state.json>
 *
 * It prints one ref per line -- `BaseApp` when the runtime has to be rebuilt,
 * and every application with it, because the BaseApp's files are copied into
 * each application at build time -- or nothing when everything is up to date.
 * `tools/flatpak-build.sh` is what builds what this names.
 *
 * **The registry is a directory per application**, `<apps-dir>/<name>/app.json`,
 * and adding one is adding the directory: this discovers them, so nothing in
 * the CI names an application.
 *
 * ```json
 * {
 *   "id": "com.example.MyApp",
 *   "repo": "https://github.com/someone/myapp.git",
 *   "ref": "main",
 *   "project": ".",
 *   "watch": ["."]
 * }
 * ```
 *
 * | | |
 * |---|---|
 * | `id` | the application id, and what the package installs under |
 * | `project` **or** `manifest` | a Bintana project, packaged by `tools/pack.sh`, or a Flatpak manifest, built as it is. Exactly one |
 * | `repo` | where the source lives. Absent means this runtime's own repository, which is what the IDE and the examples are |
 * | `ref` | the branch or tag to build. Absent means the default branch (or, for this repository, the ref the base is being built from) |
 * | `watch` | the paths in that source whose change rebuilds it. Default `.`, meaning all of it. Only consulted for a source this run has the history of: a `repo` of its own is rebuilt when its commit moves |
 *
 * **A source with a `repo` of its own needs no history here**: it is rebuilt
 * when the recorded commit and its HEAD differ, and `watch` is not read. The
 * runtime's own repository is checked out whole, so an application inside it is
 * rebuilt only when something under its own paths changed -- which is the whole
 * point of `watch`.
 *
 * The state is `builds.json` from the published branch: the tag, the base's
 * commit, and one entry per application with the repository it came from and
 * the commit it was built at.
 */
"use strict";

/* The runtime's own repository, and what a `repo` of its own falls back to. */
const BINTANA = "https://github.com/getbintana/bintana.git";

/*
 * The paths that are the BaseApp: the runtime, the libraries it ships, and the
 * packaging tool every project-based application's manifest is written by. A
 * change to any of them is a new base -- and a new base is every application
 * rebuilt.
 */
const BASE_PATHS = [
    "runtime",
    "vendor",
    "lib",
    "CMakeLists.txt",
    "runtime/js",
    "tools/embed_text.cmake",
    "tools/extract_signatures.cmake",
    "tools/bintana.pc.in",
    "tools/bintana-uninstalled.pc.in",
    "tools/pack",
    "tools/pack.sh",
    "lib/package",
    "flatpak/io.github.getbintana.BaseApp.yml",
];

function Main() {
    const args = Application.Arguments;

    if (args.length < 3) {
        print("usage: flatpak-plan <apps-dir> <sources-dir> <state.json>");
        Application.Quit(2);
        return;
    }

    const appsDir    = args[0];
    const sourcesDir = args[1];
    const statePath  = args[2];

    const bintana = File.Join(sourcesDir, "bintana");
    if (!File.IsDir(bintana)) {
        print(`flatpak-plan: no source checkout at ${bintana}`);
        Application.Quit(2);
        return;
    }

    const apps = discover(appsDir);
    if (apps === null)
        return;                       /* a refusal was printed */

    const state = File.Exists(statePath) ? (File.LoadJson(statePath) || {}) : {};

    const head = git(bintana, ["rev-parse", "HEAD"]);
    const tag  = git(bintana, ["describe", "--tags", "--abbrev=0"]);

    const oldBase = state.base || "";
    const oldTag  = state.tag  || "";

    /* A tag is a release: everything.  So is a state that has never been
     * written, and so is a base whose paths moved. */
    let base = !oldBase || oldTag !== tag ||
               changed(bintana, oldBase, head, BASE_PATHS);

    const out = [];
    if (base)
        out.push("BaseApp");

    for (const app of apps) {
        const repo = app.repo || BINTANA;
        const src  = app.repo ? File.Join(sourcesDir, app.name) : bintana;

        if (!File.IsDir(src)) {
            print(`flatpak-plan: ${app.name} has no source checkout at ${src}`);
            Application.Quit(2);
            return;
        }

        const recorded = state.apps && state.apps[app.name];

        /* A new base is every application, whatever its own paths say: the
         * base's files are copied into each of them at build time. */
        let rebuild = base;

        if (!rebuild) {
            if (!recorded || !recorded.commit)
                rebuild = true;
            else if (recorded.repo && recorded.repo !== repo)
                rebuild = true;
            else if (app.repo)
                rebuild = recorded.commit !== git(src, ["rev-parse", "HEAD"]);
            else
                rebuild = changed(bintana, recorded.commit, head, app.watch);
        }

        if (rebuild)
            out.push(app.name);
    }

    for (const ref of out)
        print(ref);

    Application.Quit(0);
}

/*
 * Every application in the registry, sorted by name, or `null` after printing
 * what is wrong with one -- a malformed entry is a refusal and not a skip,
 * because a package that silently stops being built is a package nobody
 * notices is missing.
 */
function discover(appsDir) {
    if (!File.IsDir(appsDir)) {
        print(`flatpak-plan: no registry at ${appsDir}`);
        return null;
    }

    const out = [];

    for (const dir of Directory.Folders(appsDir)) {
        const path = File.Join(dir, "app.json");
        if (!File.Exists(path))
            continue;

        const name = File.Name(dir);

        let app;
        try {
            app = File.LoadJson(path);
        } catch (e) {
            print(`flatpak-plan: ${path}: ${e.message}`);
            return null;
        }

        if (!app || !app.id) {
            print(`flatpak-plan: ${path} declares no id`);
            return null;
        }
        if (!!app.project === !!app.manifest) {
            print(`flatpak-plan: ${path} needs exactly one of project or manifest`);
            return null;
        }

        app.name  = name;
        app.repo  = app.repo  || "";
        app.watch = Array.isArray(app.watch) && app.watch.length ? app.watch : ["."];

        out.push(app);
    }

    out.sort((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
    return out;
}

/* One git answer, or "" -- a question that fails is answered *changed* by the
 * callers that care, and `git describe` with no tags is an ordinary "". */
function git(dir, args) {
    const r = Exec.Wait(["git", "-C", dir].concat(args),
                        { Timeout: 60000, Stderr: "separate" });

    return r.ExitCode === 0 ? r.Output.trim() : "";
}

/*
 * Whether anything under `paths` changed between two commits.  A commit that
 * cannot be diffed -- a history rewritten, a state from another repository --
 * is a change: rebuilding once costs a build, and not rebuilding costs a
 * package that never updates.
 */
function changed(dir, from, to, paths) {
    if (!from || !to)
        return true;
    if (from === to)
        return false;

    const r = Exec.Wait(["git", "-C", dir, "diff", "--quiet", from, to, "--"]
                            .concat(paths),
                        { Timeout: 120000, Stderr: "separate" });

    return r.ExitCode !== 0;
}
