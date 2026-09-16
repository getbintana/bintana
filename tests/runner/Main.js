/*
 * The test runner, in the language it tests.
 *
 *   ./tests/run.sh                all of them
 *   ./tests/run.sh widgets        only that project
 *   ./tests/run.sh ide menus      only that one, stopping after its `menus` phase
 *   ./tests/run.sh ide list       what phases it has
 *
 * `tests/run.sh` is ten lines of shell that check there is a binary and hand it
 * this project; everything the old script did is here.  The shell that is left
 * is the part that has to work when the runtime does not -- a runner written in
 * Bintana cannot be what tells you that Bintana will not build.
 *
 * **This is a console project** (`"main"` in project.json): it opens no window
 * and needs no display, which is what lets it be the one that *decides* whether
 * the suite needs a virtual one.  The projects it runs are ordinary Bintana
 * applications and do need a display; finding them one is the job.
 */
"use strict";

/* <repo>/tests/runner -> <repo>.  Asked of the project and not of the working
 * directory: the answer is the same wherever it was started from. */
const ROOT  = File.Directory(File.Directory(Application.Directory));
const TESTS = File.Join(ROOT, "tests");

/*
 * The binary under test is **the one running this**.
 *
 * `tests/run.sh` resolves `BINTANA=<path>` and executes it, so by the time this runs
 * the choice has already been made and `Application.Executable` is what was chosen.
 * The old script carried the path around and passed it down; there is nothing to
 * carry.
 */
const BINTANA = Application.Executable;

/*
 * GTK's portal and D-Bus chatter, and Mesa's complaint about a virtual display
 * having no GPU.  Neither says anything about the runtime.
 *
 * Applied to every line, which is coarser than it looks like it should be:
 * `Exec` can keep the two streams apart (`Stderr: "separate"`), and filtering
 * only stderr would mean a project's own `print` could never be eaten by a
 * filter aimed at the toolkit.  **It would not work here.** `xvfb-run` runs its
 * command as `"$@" 2>&1` -- it merges the two itself, before we ever see them --
 * so under the virtual display, which is the ordinary case, there is only one
 * stream to separate and every line arrives as `out`. Splitting would filter
 * nothing and look like it was filtering.
 */
const NOISE = /Gdk-WARNING|Gtk-WARNING|libEGL warning/;

/*
 * The guard against a hang, which is a real failure mode here: an uncaught throw
 * in `Form_Open` aborts before `Application.Quit` and the project would sit there
 * forever.
 *
 * It has to stay well clear of how long a project legitimately takes -- `tests/ide`
 * drives the whole IDE, twice that under a sanitizer, which is what `TIMEOUT` is
 * for (`tests/asan.sh` raises it).  A guard set just above the real time turns a
 * slow machine into a red suite, and that is worse than waiting.
 *
 * **Six hundred, because `tests/ide` measures 4m45 here** -- and the comment above
 * this line said *3m30* when the guard was 300, which is the second time the
 * suite has grown into its own guard. It did trip once: a passing run reported
 * `timed out after 300s` and the next run of the same code passed in 285. A
 * guard fifteen seconds from the real time is not a guard, it is a coin toss.
 *
 * The suite grows into it over many changes rather than in one: everything up to
 * and including the `help` phase is 25 seconds, so what takes the time is the
 * second half -- the phases that open and reopen projects. **That is measured
 * and it is one project's doing**: `ide` is 285 seconds of a 300-second suite,
 * against 8.8 for `widgets` and about 3 each for the other three. Running the
 * projects in parallel would buy nothing; whatever is to be won is inside this
 * one. Worth a look one day; a guard that a passing run trips is worth nothing
 * today.
 */
const TIMEOUT = Number(Environment.Get("TIMEOUT")) || 600;

/*
 * The grace between the guard's two signals, handed to `Exec` as `KillAfter`.
 *
 * `xvfb-run` is a shell script that takes its X server down when asked, which is
 * worth waiting five seconds for; killing it outright leaves the server orphaned
 * to init.  This used to be two `Timer`s and a flag in a closure here -- the
 * runtime does the guard now, and answers `TimedOut` on the handle, which is the
 * part that could not be written out here at all.
 */
const GRACE = 5000;

function Main() {
    const only  = Application.Arguments[0] || "";
    const extra = Application.Arguments[1] || "";

    warnIfStale();

    const projects = chosen(only);
    if (!projects.length) {
        /* A name that matches nothing is a mistake, not an empty pass: a run that
         * tested nothing must not end well. */
        Logger.Error(`no test project matches "${only}" -- try: ${all().join(" ")}`);
        Application.Quit(2);
        return;
    }

    const wrap = display();
    if (!wrap) {
        Logger.Error("no display and no xvfb-run -- install xorg-x11-server-Xvfb (or xvfb)");
        Application.Quit(2);
        return;
    }

    run(projects, wrap, extra, 0, 0);
}

/*
 * One project, then the next.  Sequentially, and that is not laziness: each one
 * opens windows, and two suites racing for the pointer fail assertions that look
 * like real bugs.
 */
function run(projects, wrap, extra, i, failed) {
    if (i >= projects.length) {
        Application.Quit(failed ? 1 : 0);
        return;
    }

    const name = projects[i];
    print(`== ${name}`);

    const argv = [...wrap.argv, BINTANA, File.Join(TESTS, name),
                  /* The pid, which the projects use to name their scratch
                   * directories: two suites at once -- a flake hunt beside an
                   * ordinary run, two CI jobs on one box -- would otherwise fight
                   * over one /tmp directory, and the collisions look exactly like
                   * real failures. */
                  String(Environment.ProcessId)];
    if (extra) argv.push(extra);

    const job = Exec(argv,
        { Environment: wrap.env, Timeout: TIMEOUT * 1000, KillAfter: GRACE },
        (line) => { if (!NOISE.test(line)) print(line); },
        (code) => {
            if (code !== 0) {
                print(job.TimedOut ? `== ${name} FAILED (timed out after ${TIMEOUT}s)`
                                   : `== ${name} FAILED (exit ${code})`);
                failed++;
            }
            run(projects, wrap, extra, i + 1, failed);
        });
}

/*
 * Which display the projects get, and what to tell them about it.
 *
 * An existing X or Wayland session is used as it is; with none there is
 * `xvfb-run`, which is what lets the suite run over ssh and in CI.  `HEADLESS`
 * set to anything **non-empty** forces the virtual display even when there is a
 * real one -- and `HEADLESS=` (empty) is the way back to the real screen, for
 * the one question that needs a real icon theme.
 *
 * Answers null when there is no display and no xvfb-run, which is the one case
 * with nothing to offer.
 */
function display() {
    const forced = (Environment.Get("HEADLESS") || "") !== "";

    if (!forced && Environment.HasDisplay)
        return { argv: [], env: {} };

    if (!Application.HasCommand("xvfb-run"))
        return null;

    return {
        argv: ["xvfb-run", "-a", "--server-args=-screen 0 1280x1024x24"],
        /* A GL context is what a virtual display is least likely to have, and
         * the tests do not need one: the cairo renderer draws the same widgets. */
        env: { GDK_BACKEND: "x11", GSK_RENDERER: Environment.Get("GSK_RENDERER") || "cairo" },
    };
}

/* Every test project, in the order the directory gives, which is sorted. */
function all() {
    return Directory.List(TESTS).filter(isTestProject);
}

function chosen(only) {
    return all().filter((name) => !only || name.includes(only));
}

/*
 * A directory with a manifest, and that manifest declaring a form.
 *
 * The second half is what keeps this project from running itself, and it is the
 * rule rather than a name to skip: a project that declares `main` is a tool, and
 * a test that did not go through GTK would prove nothing about a GTK binding
 * anyway.
 */
function isTestProject(name) {
    const manifest = File.Join(TESTS, name, "project.json");
    if (!File.Exists(manifest)) return false;

    try {
        return !File.LoadJson(manifest).main;
    } catch (e) {
        /* A manifest that cannot be read is a project that cannot run, and
         * saying so beats skipping it quietly. */
        Logger.Warning(`${name}/project.json could not be read: ${e.message}`);
        return false;
    }
}

/*
 * A stale binary is worse than no binary: `rad.js` is baked into it, so editing
 * the prelude and running the suite would test the previous one and pass.  Same
 * for any `.c`.
 *
 * It says so rather than rebuilding, because `BINTANA=<path>` may point anywhere --
 * including at a sanitizer build that takes two minutes to link.
 */
function warnIfStale() {
    const built = File.Info(BINTANA);
    if (!built) return;

    /* Everything the binary is made of: the C, the headers, and rad.js, which is
     * the one that does not look like a source. */
    const sources = [File.Join(ROOT, "CMakeLists.txt")];
    for (const pattern of ["*.c", "*.h", "*.js", "CMakeLists.txt"])
        for (const dir of [File.Join(ROOT, "runtime"), File.Join(ROOT, "vendor")])
            sources.push(...Directory.Files(dir, { Pattern: pattern, Recursive: true }));

    const newer = sources.find((path) => {
        const info = File.Info(path);
        return info && info.Modified > built.Modified;
    });
    if (newer)
        Logger.Warning(`${newer} is newer than ${BINTANA} -- rebuild first: cmake --build build`);
}
