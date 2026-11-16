/*
 * tools/release: the mechanical half of a release.
 *
 *   tools/release.sh 0.4.1              prepare, verify, commit and tag v0.4.1
 *   tools/release.sh 0.4.1-rc1          the same, as a pre-release
 *   tools/release.sh 0.4.1 --dry-run    say what it would change, write nothing
 *   tools/release.sh 0.4.1 --quick      skip check, install and the suite
 *   tools/release.sh 0.4.1 --verbose    show everything every step prints
 *
 * **What is left to a person** is the number, the notes under `## Unreleased`
 * in `CHANGELOG.md`, the push, and the tag's push -- the remote is SSH and an
 * agent's shell usually has no key.
 *
 * Everything else is a list of files held together by `tests/pack.sh` and
 * `tests/api.sh`, and it is here: the version in `CMakeLists.txt` (which
 * `bta_runtime.c` compiles) and in `ide/project.btp`, the IDE's metainfo
 * release, the Flatpak BaseApp's branch and `tag:`, the two applications'
 * `base-version`, `docs/installing.md`, the Windows examples, the CHANGELOG
 * heading and its compare link, the rebuilt `api.json` and `llms-full.txt`,
 * the checks, the commit and the tag.
 *
 * **It refuses rather than guesses.** A tree that is not clean, a branch that
 * is not `main`, a tag that exists, a file whose line it cannot find, an empty
 * `## Unreleased`, or a step that leaves something behind outside the release:
 * each of those stops it with the reason and nothing written. A tool that
 * "fixes" a file it did not understand is how a release ships the previous
 * version in one place.
 */
"use strict";

/* <repo>/tools/release -> <repo>, asked of the project and not of the working
 * directory, so `tools/release.sh` can be started from anywhere. */
const ROOT = File.Directory(File.Directory(Application.Directory));
const SITE = "https://github.com/getbintana/bintana";

function fail(why) {
    print("release: " + why);
    Application.Quit(1);
}

function read(path) {
    return File.Load(File.Join(ROOT, path));
}

function exists(path) {
    return File.Exists(File.Join(ROOT, path));
}

/* The text between two markers, and a sentence naming what was not found --
 * a release tool that silently replaces nothing is worse than one that stops. */
function between(text, open, close, what) {
    const at = text.indexOf(open);
    if (at < 0)
        throw new Error(`cannot find ${what || JSON.stringify(open)}`);
    const from = at + open.length;
    const to = text.indexOf(close, from);
    if (to < 0)
        throw new Error(`cannot find the end of ${what || JSON.stringify(open)}`);
    return text.slice(from, to);
}

function occurrences(text, part) {
    let n = 0;
    let at = 0;
    for (;;) {
        const i = text.indexOf(part, at);
        if (i < 0) return n;
        n++;
        at = i + part.length;
    }
}

/* The release's date is the person's own: `toISOString` is UTC, and a release
 * made at 22:00 in Buenos Aires would be dated tomorrow. */
function today() {
    const d = new Date();
    const two = (n) => (n < 10 ? "0" : "") + n;
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function capture(argv, done) {
    const lines = [];
    Exec(argv, { Directory: ROOT, Timeout: 120000 },
        (line) => lines.push(line),
        (code) => done(code, lines.join("\n")));
}

function series(tasks, done) {
    let i = 0;
    const next = () => {
        if (i >= tasks.length) { done(); return; }
        const task = tasks[i++];
        task((valid, why) => {
            if (!valid) { fail(why); return; }
            next();
        });
    };
    next();
}

function Main() {
    const args = Application.Arguments;
    let version = "";
    let dry = false;
    let quick = false;
    let verbose = false;

    for (const arg of args) {
        if (arg === "--dry-run") dry = true;
        else if (arg === "--quick") quick = true;
        else if (arg === "--verbose") verbose = true;
        else if (arg === "--help" || arg === "-h") {
            print("usage: tools/release.sh <version> [--dry-run] [--quick] [--verbose]");
            print("  <version>: 0.4.1, or 0.4.1-rc1 for a pre-release");
            Application.Quit(0);
            return;
        } else if (arg.charAt(0) === "-") {
            fail(`unknown option ${arg}`);
            return;
        } else if (!version) {
            version = arg;
        } else {
            fail(`one version at a time (${version} and ${arg})`);
            return;
        }
    }
    if (!version) {
        fail("no version -- usage: tools/release.sh <version> [--dry-run] [--quick]");
        return;
    }

    const SHAPE = new Regex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-rc[0-9]+)?$");
    if (!SHAPE.IsMatch(version)) {
        fail(`${version} is not x.y.z or x.y.z-rcN`);
        return;
    }

    const numeric = version.split("-")[0];
    const parts = numeric.split(".");
    const release = {
        version,
        numeric,
        /* The Flatpak BaseApp's branch is BTA_VERSION's major.minor, which is
         * the one number `tests/pack.sh` holds the manifests and
         * docs/installing.md to. */
        branch: parts[0] + "." + parts[1],
        tag: "v" + version,
        date: today(),
        rc: version !== numeric,
        previous: "",
        quick,
        verbose,
    };

    const tasks = [
        (ok) => capture(["git", "status", "--porcelain"], (code, out) => {
            if (code !== 0) return ok(false, "git status failed -- is this a checkout?");
            if (out.trim() !== "")
                return ok(false, "the tree is not clean -- commit or stash it first:\n" + out);
            ok(true);
        }),
        (ok) => capture(["git", "rev-parse", "--abbrev-ref", "HEAD"], (code, out) => {
            if (code !== 0) return ok(false, "not a git checkout");
            if (out.trim() !== "main") return ok(false, `on ${out.trim()}, not main`);
            ok(true);
        }),
        (ok) => capture(["git", "rev-parse", "-q", "--verify", "refs/tags/" + release.tag], (code) => {
            if (code === 0)
                return ok(false, `${release.tag} already exists -- a published tag is never moved`);
            ok(true);
        }),
        (ok) => capture(["git", "describe", "--tags", "--abbrev=0"], (code, out) => {
            if (code !== 0) return ok(false, "there is no tag to compare this release with");
            release.previous = out.trim();
            ok(true);
        }),
    ];

    series(tasks, () => {
        let plan;
        try {
            plan = planRelease(release);
        } catch (e) {
            fail(e.message);
            return;
        }

        if (dry) {
            printPlan(plan);
            Application.Quit(0);
            return;
        }

        try {
            for (const file of plan.files)
                File.Save(File.Join(ROOT, file.path), file.text);
        } catch (e) {
            fail(`writing the release's files: ${e.message}`);
            return;
        }

        print(`release: ${plan.tag} prepared -- ${plan.steps.length} steps, then the commit and the tag`);
        runSteps(plan, 0);
    });
}

/* Every file the release moves, and what it says in each. The "current" side of
 * each pair is read from the tree rather than written here, so a release after
 * a manual edit reads the file that is there; a pair whose old side is missing
 * -- and whose new side is not already there -- is what stops the tool. */
function planRelease(v) {
    const cmake    = read("CMakeLists.txt");
    const base     = read("flatpak/io.github.getbintana.BaseApp.yml");
    const hello    = read("flatpak/io.github.getbintana.Hello.yml");
    const ideYml   = read("flatpak/io.github.getbintana.Ide.yml");
    const install  = read("docs/installing.md");
    const portable = read("tools/windows-portable.sh");
    const tree     = read("tools/windows-build-tree.sh");
    const meta     = read("ide/io.github.getbintana.Ide.metainfo.xml");

    const cmakeNow  = between(cmake, "project(bintana VERSION ", " LANGUAGES C");
    const ideNow    = between(read("ide/project.btp"), '"version": "', '"');
    const baseNow   = between(base, "branch: '", "'");
    const tagNow    = between(base, "`tag: ", "`");
    const helloNow  = between(hello, "base-version: '", "'");
    const ideYmlNow = between(ideYml, "base-version: '", "'");
    const tarNow    = between(install, "tar xzf bintana-", "-linux-x86_64.tar.gz");
    const widNow    = between(portable, "stage/bintana-", "-windows-x86_64");
    const wbtNow    = between(tree, "stage/bintana-build-", "-windows-x86_64");

    const releaseAt = meta.indexOf("<release ");
    if (releaseAt < 0) throw new Error("the IDE's metainfo has no <release>");
    let releaseEnd = meta.indexOf("/>", releaseAt);
    if (releaseEnd < 0) throw new Error("the IDE's <release> has no end");
    releaseEnd += 2;
    const metaNow = meta.slice(releaseAt, releaseEnd);

    const groups = [
        {
            path: "CMakeLists.txt",
            pairs: [["VERSION " + cmakeNow + " LANGUAGES C",
                     "VERSION " + v.numeric + " LANGUAGES C"]],
        },
        {
            path: "ide/project.btp",
            pairs: [['"version": "' + ideNow + '",', '"version": "' + v.numeric + '",']],
        },
        {
            path: "ide/io.github.getbintana.Ide.metainfo.xml",
            pairs: [[metaNow, `<release version="${v.numeric}" date="${v.date}"/>`]],
        },
        {
            path: "flatpak/io.github.getbintana.BaseApp.yml",
            pairs: [["branch: '" + baseNow + "'", "branch: '" + v.branch + "'"],
                    ["`tag: " + tagNow + "`", "`tag: " + v.tag + "`"]],
        },
        {
            path: "flatpak/io.github.getbintana.Hello.yml",
            pairs: [["base-version: '" + helloNow + "'", "base-version: '" + v.branch + "'"]],
        },
        {
            path: "flatpak/io.github.getbintana.Ide.yml",
            pairs: [["base-version: '" + ideYmlNow + "'", "base-version: '" + v.branch + "'"]],
        },
        {
            path: "docs/installing.md",
            pairs: [["BaseApp//" + baseNow, "BaseApp//" + v.branch],
                    ["bintana-" + tarNow + "-linux-x86_64.tar.gz",
                     "bintana-" + v.numeric + "-linux-x86_64.tar.gz"]],
        },
        {
            path: "tools/windows-portable.sh",
            pairs: [["stage/bintana-" + widNow + "-windows-x86_64",
                     "stage/bintana-" + v.numeric + "-windows-x86_64"]],
        },
        {
            path: "tools/windows-build-tree.sh",
            pairs: [["stage/bintana-build-" + wbtNow + "-windows-x86_64",
                     "stage/bintana-build-" + v.numeric + "-windows-x86_64"]],
        },
    ];

    const files = [];
    const changes = [];
    for (const group of groups) {
        let text = read(group.path);
        for (const pair of group.pairs) {
            const old = pair[0];
            const made = pair[1];
            if (old === made) continue;

            const seen = occurrences(text, old);
            if (seen === 0) {
                /* A second release of the same number (`-rc2`) arrives with the
                 * line already at its new value, and that is not a failure. */
                if (occurrences(text, made) > 0) continue;
                throw new Error(`${group.path}: cannot find ${JSON.stringify(old)}`);
            }
            if (seen > 1)
                throw new Error(`${group.path}: ${JSON.stringify(old)} appears ${seen} times`);
            text = text.split(old).join(made);
            changes.push({ file: group.path, from: old, to: made });
        }
        files.push({ path: group.path, text });
    }

    const section = releaseSection(read("CHANGELOG.md"), v);
    files.push({ path: "CHANGELOG.md", text: section.text });

    const steps = [];
    const step = (why, argv) => steps.push({ why, argv });
    if (!exists("build/CMakeCache.txt"))
        step("configure", ["cmake", "-S", ".", "-B", "build"]);
    step("build", ["cmake", "--build", "build", "--parallel"]);
    step("api.json", [File.Join(ROOT, "tools/apijson.sh")]);
    step("llms-full.txt", [File.Join(ROOT, "tools/llms.sh")]);
    step("the documented surface", [File.Join(ROOT, "tests/api.sh")]);
    step("the packaging invariants", [File.Join(ROOT, "tests/pack.sh")]);
    if (!v.quick) {
        step("the project check", [File.Join(ROOT, "tests/check.sh")]);
        step("the install", [File.Join(ROOT, "tests/install.sh")]);
        step("the suite", [File.Join(ROOT, "tests/run.sh")]);
    }

    /* What a step is allowed to have changed. `tests/run.sh` writes to /tmp and
     * to the projects' own scratch, but a test that leaves a file in the tree
     * would otherwise ride into the release commit. */
    const allowed = files.map((file) => file.path);
    allowed.push("api.json", "llms-full.txt");

    return {
        version: v.version,
        numeric: v.numeric,
        branch: v.branch,
        tag: v.tag,
        date: v.date,
        rc: v.rc,
        quick: v.quick,
        verbose: v.verbose,
        previous: v.previous,
        files,
        changes,
        steps,
        allowed,
        heading: section.heading,
        compare: section.compare,
        message: commitMessage(v, steps),
    };
}

/* `## Unreleased` becomes the release's section, and an empty one is left for
 * the next cycle. The notes are the one part a person writes: an empty
 * `## Unreleased` is a release with nothing to say about itself. */
function releaseSection(text, v) {
    const marker = "## Unreleased";
    const at = text.indexOf(marker);
    if (at < 0)
        throw new Error("CHANGELOG.md has no `## Unreleased` -- write what changed there first");

    const lineEnd = text.indexOf("\n", at);
    if (lineEnd < 0)
        throw new Error("CHANGELOG.md: `## Unreleased` is its last line");

    let rest = text.slice(lineEnd + 1);
    while (rest.charAt(0) === "\n") rest = rest.slice(1);

    /* The next heading ends the notes -- and a `## ` at the very start is one
     * already: an empty `## Unreleased` sits directly above the previous
     * release, with no blank line to stop at. */
    let notes = "";
    if (rest.slice(0, 3) !== "## ") {
        const next = rest.indexOf("\n## ");
        notes = (next < 0 ? rest : rest.slice(0, next)).trim();
    }
    if (notes === "")
        throw new Error("CHANGELOG.md: `## Unreleased` is empty -- write what changed there first");

    const previous = v.previous.charAt(0) === "v" ? v.previous.slice(1) : v.previous;
    const heading = `## ${v.version} — ${v.date}`;
    const compare = `[Compare with ${previous}](${SITE}/compare/${v.previous}...${v.tag})`;

    return {
        text: text.slice(0, at) +
              `${marker}\n\n${heading}\n\n${compare}\n\n` + rest,
        heading,
        compare,
    };
}

function commitMessage(v, steps) {
    const lines = [
        `Bintana ${v.version}`,
        "",
        `The version is ${v.numeric} in CMakeLists.txt, which bta_runtime.c compiles, in`,
        `ide/project.btp and in the IDE's metainfo, and the tag is ${v.tag}.`,
    ];
    if (v.rc) {
        lines.push("A tag with a letter in it is a pre-release: the package and windows jobs");
        lines.push("pass `--prerelease`, so the repository's *latest* stays on the last final");
        lines.push("release.");
    }
    lines.push("");
    lines.push(`The Flatpak BaseApp follows BTA_VERSION's major.minor to ${v.branch} -- its branch,`);
    lines.push("the two applications' base-version and docs/installing.md -- and its `tag:` names");
    lines.push("this release. CHANGELOG.md has the section, from `## Unreleased`.");
    lines.push("");
    lines.push("api.json and llms-full.txt are regenerated after the rebuild, and the checks this");
    lines.push(`tool ran passed on that build: ${steps.map((s) => s.why).join(", ")}.`);
    return lines.join("\n");
}

function printPlan(plan) {
    print(`release: would prepare ${plan.version} (tag ${plan.tag}) on ${plan.date}, from ${plan.previous}`);
    for (const change of plan.changes)
        print(`  ${change.file}\n      - ${change.from}\n      + ${change.to}`);
    print("  CHANGELOG.md");
    print(`      + ${plan.heading}`);
    print(`      + ${plan.compare}`);
    print("  then:");
    for (const s of plan.steps)
        print("      " + s.argv.join(" "));
    print(`      git commit -m "Bintana ${plan.version} ..."`);
    print(`      git tag ${plan.tag}`);
    print("release: --dry-run -- nothing was written");
}

function runSteps(plan, i) {
    if (i >= plan.steps.length) {
        commitAndTag(plan);
        return;
    }

    const step = plan.steps[i];
    print(`== ${step.why}`);
    if (plan.verbose)
        print("   " + step.argv.join(" "));

    const lines = [];
    Exec(step.argv, { Directory: ROOT, Timeout: 0 },
        (line) => {
            if (plan.verbose) print(line);
            else lines.push(line);
        },
        (code) => {
            if (code !== 0) {
                if (!plan.verbose)
                    for (const line of lines) print(line);
                fail(`\`${step.argv.join(" ")}\` failed (exit ${code}) -- the release is not committed`);
                return;
            }
            runSteps(plan, i + 1);
        });
}

function commitAndTag(plan) {
    capture(["git", "status", "--porcelain"], (code, out) => {
        if (code !== 0) { fail("git status failed"); return; }

        const stray = [];
        for (const line of out.split("\n")) {
            if (line.trim() === "") continue;
            const path = line.slice(3).trim();
            if (!plan.allowed.includes(path)) stray.push(line);
        }
        if (stray.length > 0) {
            print("release: a step left these behind, and they are not part of a release:");
            for (const line of stray) print("  " + line);
            fail("nothing was committed");
            return;
        }

        print("== commit");
        Exec(["git", "add", "-A"], { Directory: ROOT, Timeout: 120000 },
            () => {},
            (added) => {
                if (added !== 0) { fail("git add failed"); return; }
                Exec(["git", "commit", "-m", plan.message], { Directory: ROOT, Timeout: 120000 },
                    (line) => print(line),
                    (committed) => {
                        if (committed !== 0) { fail("git commit failed"); return; }
                        print(`== tag ${plan.tag}`);
                        Exec(["git", "tag", plan.tag], { Directory: ROOT, Timeout: 120000 },
                            () => {},
                            (tagged) => {
                                if (tagged !== 0) { fail("git tag failed"); return; }
                                printNext(plan);
                            });
                    });
            });
    });
}

function printNext(plan) {
    print("");
    print(`release: Bintana ${plan.version} is committed and tagged ${plan.tag}`);
    print("  git push origin main");
    print(`  git push origin ${plan.tag}`);
    print("");
    print("The tag's push runs CI, which creates the release and attaches the Linux");
    print("tarball, api.json and the Windows assets; a tag with a letter in it is a");
    print("pre-release, so *latest* stays on the last final release.");
    print("The Flatpak repository picks the new tag up on its daily run -- to have it");
    print("now: Actions -> flatpak repository -> Run workflow.");
    if (plan.quick)
        print("release: --quick -- check, install and the suite were not run");
    Application.Quit(0);
}
