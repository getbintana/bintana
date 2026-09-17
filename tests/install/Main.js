/*
 * What `make install` produces, tried the way somebody who ran it would.
 *
 *   ./tests/install.sh
 *
 * It installs the project into a staging prefix under /tmp, then starts the
 * *installed* IDE through the *installed* launcher and asks the X server what
 * appeared. Nothing here reads the source tree except to know what should have
 * been copied out of it.
 *
 * **Why an installed copy needs a test of its own.** Everything else in this
 * repository runs the IDE as `<repo>/ide`, where every file it could want is
 * next to it because it was never moved. An install moves it, and the ways that
 * go wrong are quiet: a form nobody added to a list, a `po/` that landed
 * somewhere the runtime does not look, a launcher carrying the prefix it was
 * configured with rather than the one it ended up in. None of those is a build
 * error and none of them shows up until the menu entry opens a window that is
 * missing something.
 *
 * **The window is the assertion.** The title it comes up with is
 * `IDE de Bintana — hello` under `LANGUAGE=es`: three separate things had to
 * be found for that one string -- the installed sources, the installed
 * `po/es.po`, and the project the launcher was handed -- and one string is how
 * they are asked about together. Its class is `bintana-ide`, which is what the
 * installed `bintana-ide.desktop` says it matches; that is the other end of the
 * same question, and the reason the launcher starts the runtime under a name of
 * its own.
 *
 * **This is a console project, and it runs the IDE on an X server it starts
 * itself.** Not `xvfb-run`, which owns the display it makes and hands it to one
 * child: the window has to be *asked about* from outside, so the display has to
 * outlive the command that opened it. And never the real screen -- a test that
 * takes over the desktop of whoever ran it is not one anybody runs twice.
 */
"use strict";

/* <repo>/tests/install -> <repo>, asked of the project rather than of the
 * working directory, so it is the same answer wherever this was started. */
const ROOT = File.Directory(File.Directory(Application.Directory));

/* The build to install *from* is the one this binary came out of: `BINTANA=<path>`
 * has already chosen it by the time anything here runs, exactly as in
 * `tests/runner`. Nothing is passed down and nothing can disagree. */
const BUILD = File.Directory(Application.Executable);

/* GTK's portal and D-Bus chatter, and Mesa on a display with no GPU. The same
 * three the suite filters, and for the same reason: none of them says anything
 * about the runtime, let alone about where its files are.
 *
 * `MESA-EGL` is the fourth, and it is the same bargain one layer down: an
 * `Xvfb` has no DRI3, so Mesa's EGL loader says so on its way past -- before
 * `GSK_RENDERER=cairo` has had any say -- and that line is the driver clearing
 * its throat, not the IDE.  It arrived with a Mesa that started warning; the
 * check is about what the *application* says, and a filter that let this
 * through reports a failure about nothing the install controls. */
const NOISE = /Gdk-WARNING|Gtk-WARNING|libEGL warning|MESA-EGL|Gtk-Message/;

/* How long the IDE gets to put a window up, in quarter seconds. Generous: this
 * runs after a cold install, on a virtual display, and the cost of it being too
 * short is a failure that looks like a missing file. */
const APPEAR = 60;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
    } else {
        failures.push(detail ? `${name}: ${detail}` : name);
    }
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function Main() {
    /* The tools this needs and cannot do without, named together so a machine
     * missing two of them is told about both. `cmake` installs, `Xvfb` is the
     * screen nobody has to look at, and `xdotool` is the only one of the three
     * that is not already a dependency of the suite -- it is what asks the
     * display what is on it, which is the whole check. */
    const missing = ["cmake", "Xvfb", "xdotool"].filter((c) => !Application.HasCommand(c));
    if (missing.length) {
        Logger.Error(`missing: ${missing.join(", ")} -- install them (Fedora: cmake xorg-x11-server-Xvfb xdotool)`);
        Application.Quit(2);
        return;
    }

    if (!File.Exists(File.Join(BUILD, "CMakeCache.txt"))) {
        Logger.Error(`${BUILD} is not a CMake build directory -- cmake -S . -B build`);
        Application.Quit(2);
        return;
    }

    const work = File.Join(Environment.TempDirectory, `bintana-install-${Environment.ProcessId}`);
    if (File.Exists(work)) Directory.DeleteTree(work);
    Directory.Make(work);

    const prefix = File.Join(work, "prefix");

    print(`installing ${BUILD} into ${prefix}`);
    if (!staged(prefix)) {
        report(work);
        return;
    }

    contents(prefix);
    pluginDev(prefix, work);
    launcher(prefix);
    entry(prefix);

    /*
     * And the last phase reports for itself, because it is the only one that
     * waits: `Main` returns while the IDE is still starting, and what finishes
     * the run is the timer below. A console project's main loop keeps going
     * after `Main` -- that is what `tests/runner` is built on too.
     */
    opens(prefix, work, () => report(work));
}

/* ------------------------------------------------------------------ install
 *
 * `--prefix` and not a second configure: what a packager does is install a
 * build that was configured for `/usr/local` into a staging root, and it is the
 * case most likely to be broken by anything that writes a path down at
 * configure time. Testing the install that was configured for /tmp would be
 * testing the one shape that cannot fail.
 */
function staged(prefix) {
    const r = Exec.Wait(["cmake", "--install", BUILD, "--prefix", prefix],
                        { Timeout: 120000, Stderr: "separate" });
    check("cmake --install", r.ExitCode === 0, r.Errors || r.Output);
    return r.ExitCode === 0;
}

/* ----------------------------------------------------------------- contents
 *
 * The named files first, because those are the ones a person looks for; then
 * the two project trees whole, which is the check that keeps working after
 * somebody adds a form. A list of names here would go stale the same way a list
 * of names in CMakeLists.txt would, which is why neither has one.
 */
function contents(prefix) {
    for (const rel of ["bin/bintana",
                       "bin/bintana-ide",
                       "share/bintana/ide/project.json",
                       "share/bintana/ide/po/es.po",
                       "share/bintana/examples/hello/project.json",
                       /* A shipped library, which the runtime finds one hop from
                        * its own binary -- so this path *is* the mechanism. */
                       "share/bintana/lib/charts/Chart.js",
                       "share/bintana/lib/charts/Chart.form",
                       /* What an editor that is not the IDE reads about this
                        * runtime: a `tsconfig.json` in somebody's project names
                        * it, so it has to be somewhere a path can reach. */
                       "share/bintana/bintana.d.ts",
                       "share/applications/bintana-ide.desktop",
                       "share/icons/hicolor/scalable/apps/bintana-ide.svg",
                       "share/doc/bintana/README.md",
                       "share/doc/bintana/docs/ide.md"])
        check(`installed ${rel}`, File.Exists(File.Join(prefix, rel)));

    for (const tree of ["ide", "examples", "lib"])
        whole(tree, File.Join(ROOT, tree), File.Join(prefix, "share", "bintana", tree));

    /* The sources the manifest names, resolved against the installed directory
     * rather than the source one. A project.json that lists a file the install
     * did not carry is exactly the failure this exists for, and the runtime
     * would report it as a missing class three screens later. */
    const ide      = File.Join(prefix, "share", "bintana", "ide");
    const manifest = File.Join(ide, "project.json");
    if (File.Exists(manifest)) {
        const gone = File.LoadJson(manifest).sources
                         .filter((src) => !File.Exists(File.Join(ide, src)));
        check("every source in the installed project.json is there", gone.length === 0,
              gone.join(", "));
    }
}

/* -------------------------------------------------------------- plugins
 *
 * The development surface a native plugin needs, and it is deliberately one
 * header and one pkg-config file.  **Compiled against and not merely listed**:
 * the failure this exists for is a header that lands in the wrong directory or
 * a `Cflags` line that points nowhere, and both look exactly like a successful
 * install until somebody outside this tree tries to build a plugin.
 *
 * The source is the suite's own reference plugin, so what compiles here is what
 * `tests/widgets` loads and `docs/plugins.md` points at.  It is compiled
 * against the *staged* prefix and not the source tree: the point is that an
 * installed runtime can be extended from outside, with nothing left over from
 * the tree it was built in.
 */
function pluginDev(prefix, work) {
    const header = File.Join(prefix, "include", "bintana", "bta_plugin.h");
    check("installed include/bintana/bta_plugin.h", File.Exists(header));

    const pcs = Directory.Files(prefix, { Pattern: "bintana.pc", Recursive: true });
    check("installed a bintana.pc for pkg-config", pcs.length === 1, pcs.join(", "));
    if (!pcs.length || !Application.HasCommand("cc")) {
        check("a plugin compiles against the installed header", false,
              pcs.length ? "no cc" : "no bintana.pc");
        return;
    }

    const flags = Exec.Wait(["pkg-config", "--cflags", "bintana"],
                            { Environment: { PKG_CONFIG_PATH: File.Directory(pcs[0]) },
                              Timeout: 20000, Stderr: "separate" });
    check("pkg-config finds the installed bintana", flags.ExitCode === 0,
          flags.Errors || flags.Output);
    if (flags.ExitCode !== 0)
        return;

    const out  = File.Join(work, "stage-testplug.so");
    const argv = ["cc", "-shared", "-fPIC", "-o", out,
                  File.Join(ROOT, "tests", "plugins", "testplug.c")]
                     .concat(flags.Output.trim().split(/\s+/).filter((s) => s));
    const r = Exec.Wait(argv, { Timeout: 60000, Stderr: "separate" });

    check("a plugin compiles against the installed header", r.ExitCode === 0,
          r.Errors || r.Output);
    check("...and the shared object it produced is there", File.Exists(out));
    if (r.ExitCode !== 0)
        return;

    /*
     * **And the installed runtime has to load it and run it.**  A compile
     * answers *does the header point somewhere*; this answers the rest -- the
     * installed binary's loader, its GModule, its ABI check, and the global the
     * plugin installs -- which is the whole reason a plugin exists.  A console
     * project of our own, a library directory made of the one file, and the
     * installed runtime run against both.
     */
    const lib  = File.Join(work, "plugins");
    const mine = File.Join(lib, "testplug");
    Directory.Make(mine);
    File.Copy(out, File.Join(mine, "testplug.so"));

    const proj = File.Join(work, "plugproj");
    Directory.Make(proj);
    File.SaveJson(File.Join(proj, "project.json"),
                  { name: "stageplug", main: "Main", uses: ["testplug"] });
    File.Save(File.Join(proj, "Main.js"), `
"use strict";
function Main() {
    print("stage:" + TestPlug.Echo("ok"));
    Application.Quit(0);
}
`);

    const ran = Exec.Wait([File.Join(prefix, "bin", "bintana"), proj],
                          { Environment: { BINTANA_LIB_PATH: lib },
                            Timeout: 60000, Stderr: "separate" });
    check("the installed runtime loads a plugin built against it",
          ran.ExitCode === 0, ran.Errors || ran.Output);
    check("...and the global it installs answers",
          (ran.Output || "").includes("stage:ok"), ran.Output);
}

/* Every file of a tree, minus the .pot the install leaves out on purpose. */
function whole(name, from, to) {
    const gone = Directory.Files(from, { Recursive: true })
        .map((path) => path.slice(from.length + 1))
        .filter((rel) => !rel.endsWith(".pot"))
        .filter((rel) => !File.Exists(File.Join(to, rel)));

    check(`${name}/ installed whole`, gone.length === 0,
          `${gone.length} missing, first: ${gone.slice(0, 3).join(", ")}`);
}

/* ----------------------------------------------------------------- launcher
 *
 * That it works is `opens()` below; what is asked here is the thing working
 * cannot answer, because this install and the source tree are on the same
 * machine: whether it would still work anywhere else. A launcher that mentions
 * the directory it was built in runs perfectly here and is broken in every
 * package built from it.
 */
function launcher(prefix) {
    const path = File.Join(prefix, "bin", "bintana-ide");
    if (!File.Exists(path)) return;

    const text = File.Load(path);
    check("the launcher names no path in the source tree", !text.includes(ROOT), ROOT);
}

/* -------------------------------------------------------------------- entry
 *
 * The menu entry, checked by the desktop's own validator when there is one --
 * it knows the spec and this test does not. What it cannot check is the one
 * line that has to agree with something outside the file, and that is the
 * class: `opens()` reads the real window's, and this reads what the entry
 * claims. They are compared there.
 */
function entry(prefix) {
    const path = File.Join(prefix, "share", "applications", "bintana-ide.desktop");
    if (!File.Exists(path)) return;

    if (Application.HasCommand("desktop-file-validate")) {
        const r = Exec.Wait(["desktop-file-validate", path], { Timeout: 20000, Stderr: "separate" });
        check("desktop-file-validate", r.ExitCode === 0, r.Output + r.Errors);
    } else {
        print("no desktop-file-validate: the entry is installed but unvalidated");
    }
}

/* Whatever `key=` says in the installed entry, or "" -- the localised
 * `Name[es]` spellings are separate keys, so a plain prefix match is right. */
function entryValue(prefix, key) {
    const path = File.Join(prefix, "share", "applications", "bintana-ide.desktop");
    if (!File.Exists(path)) return "";

    const line = File.Load(path).split("\n").find((l) => l.startsWith(key + "="));
    return line ? line.slice(key.length + 1).trim() : "";
}

/* --------------------------------------------------------------------- runs
 *
 * The installed IDE, opening an installed example, on a display of this
 * project's own.
 *
 * **The waiting is a `Timer` and not a loop, and that is not a style choice.**
 * Everything the child says arrives on callbacks, and callbacks run on the main
 * loop; a `for` loop polling with `Exec.Wait` never gives the loop a turn, so
 * `output` stays empty and `Running` stays true however badly the child failed.
 * Written that way first, and the two assertions that read them could not fail:
 * an install pointed at a directory that was not there exited instantly and
 * this still reported it as running and silent. Between ticks the loop runs,
 * which is what makes those two answers real -- and what lets a child that dies
 * at once be reported at once instead of after the fifteen seconds nothing was
 * ever going to appear in.
 */
function opens(prefix, work, done) {
    /* A copy, because the install is read-only in the shape that matters: the
     * examples land beside the IDE under a prefix the user may not own, and
     * what somebody actually does with one is copy it somewhere writable. That
     * copy also gives the window a title to be checked against. */
    const example = File.Join(prefix, "share", "bintana", "examples", "hello");
    if (!File.IsDir(example)) {
        check("an installed example to open", false, `no ${example}`);
        done();
        return;
    }

    const project = File.Join(work, "hello");
    Directory.Copy(example, project);

    const home   = File.Join(work, "home");
    const config = File.Join(home, ".config");
    Directory.Make(config);

    const server = display();
    if (!server) {
        check("an X server for the installed IDE", false, "Xvfb would not start on :90-:99");
        done();
        return;
    }

    /* Everything it wrote that was not the toolkit clearing its throat, and the
     * status if it ended by itself. Both are filled in from callbacks, which is
     * the whole reason the wait below is a timer. */
    const output = [];
    let ended = null;
    const ide = Exec([File.Join(prefix, "bin", "bintana-ide"), project],
        {
            Environment: {
                DISPLAY: server.name,
                /* GTK would prefer the session's Wayland socket over the X
                 * server we just started, and then this would be testing the
                 * window on the user's screen. */
                WAYLAND_DISPLAY: null,
                GDK_BACKEND: "x11",
                /* A virtual display is the last place to expect a GL context,
                 * and none of this needs one. */
                GSK_RENDERER: "cairo",
                /* Its settings, its recent list: an installed IDE writes them
                 * under the user's config, and a test must not be what puts
                 * this project at the top of somebody's Recent menu. */
                HOME: home,
                XDG_CONFIG_HOME: config,
                LANGUAGE: "es",
            },
            Timeout: 120000,
            KillAfter: 2000,
        },
        /* The blank line is part of the noise and not an oversight: GLib puts
         * one in front of every warning it prints, so filtering the warning and
         * keeping the empty line before it reports *something was said* with
         * nothing to show for it. */
        (line) => { if (line.trim() && !NOISE.test(line)) output.push(line); },
        (code) => { ended = code; });

    /* What the window should say, read out of the catalogue that was installed
     * rather than written down here: the point is that the runtime found that
     * file, not that anybody agrees with its wording. */
    const want = translated(prefix, "Bintana IDE -- {0}").replace("{0}", File.Name(project));

    let ticks = 0;
    let grace = 2;
    const poll = new Timer(250, () => {
        const title = shown(server.name);

        /* A child that died gets two more ticks before anything is concluded
         * about it: the exit callback and the last of its output are two
         * different notifications, and the complaint that says *why* is in the
         * output. */
        if (!title && ended !== null && grace-- > 0) return;
        if (!title && ended === null && ++ticks < APPEAR) return;

        poll.Stop();
        finish(title);
    });
    poll.Start();

    function finish(title) {
        check("the installed IDE puts up a window", title !== "",
              ended !== null ? `it exited with ${ended} first` : `nothing in ${APPEAR / 4}s`);
        if (title) eq("...whose title says the installed po/es.po was read", title, want);
        eq("...of the class the installed .desktop matches",
           entryValue(prefix, "StartupWMClass"), "bintana-ide");

        check("it is still running", ended === null, `exited with ${ended}`);
        check("and said nothing on the way up", output.length === 0,
              output.slice(0, 5).join(" | "));

        /* Its settings went to the redirected config directory and not into the
         * install: an IDE that could only remember things in its own tree would
         * work from a build directory and fail from /usr. */
        check("its settings went to the user's config directory",
              File.Exists(File.Join(config, "bintana", "Bintana IDE", "settings.json")));

        ide.Stop();
        server.handle.Stop();
        done();
    }
}

/* The title of the IDE's window, or "" while there is not one yet.
 *
 * It puts up more than one window of its class -- the title bar it draws itself
 * needs one to measure in -- and only the real one carries a name, so the name
 * is what tells them apart. */
function shown(display) {
    for (const id of windows(display)) {
        const name = xdo(display, ["getwindowname", id]);
        if (name && name !== "bintana-ide") return name;
    }
    return "";
}

/* An X server of our own, on the first free display from :90 up.
 *
 * `xvfb-run -a` picks a free one too, and cannot be used: it owns the display
 * for the length of one command, and the whole check here is a second command
 * asking that display what the first one drew.
 */
function display() {
    for (let n = 90; n < 100; n++) {
        const name = `:${n}`;

        /* Whether that number is taken is asked of the display and not of
         * `/tmp/.X<n>-lock`, and the difference is the whole reason this runs
         * twice in a row: a lock file says either *somebody is using it* or
         * *somebody was killed while using it*, and an X server reclaims the
         * second kind on its own. Reading the lock skipped both, so ten runs
         * that ended badly left nowhere to start. */
        if (xdo(name, ["getdisplaygeometry"])) continue;

        const handle = Exec(["Xvfb", name, "-screen", "0", "1280x1024x24"]);
        for (let i = 0; i < 40; i++) {
            /* Being able to ask it something is the only proof it is up, and it
             * is the same question everything after this asks. */
            if (xdo(name, ["getdisplaygeometry"])) return { name, handle };
            pause(0.25);
        }
        /* `Stop` and never `Kill`, here and at the end: an X server asked to go
         * takes its lock and its socket with it, and one that is shot leaves
         * them for the next run to trip over. */
        handle.Stop();
    }
    return null;
}

/* The ids of the windows whose class is exactly ours -- xdotool takes a regular
 * expression, so the anchors are what keep this from matching a `bintana-ide2`
 * somebody is running beside it. */
function windows(name) {
    return xdo(name, ["search", "--classname", "^bintana-ide$"]).split("\n").filter(Boolean);
}

/* One xdotool question, answered with what it printed or "" -- every caller
 * here treats *did not answer* and *answered nothing* the same, because both
 * mean keep waiting. */
function xdo(display, args) {
    const r = Exec.Wait(["xdotool", ...args],
                        { Environment: { DISPLAY: display }, Stderr: "separate", Timeout: 10000 });
    return r.ExitCode === 0 ? r.Output.trim() : "";
}

/* What the installed catalogue makes of a string, read straight out of the .po.
 * Parsing it here rather than asking `Locale` is the point: `Locale` would
 * answer about *this* project's catalogue, and the question is about the one
 * that was installed. */
function translated(prefix, msgid) {
    const po = File.Join(prefix, "share", "bintana", "ide", "po", "es.po");
    if (!File.Exists(po)) {
        check(`the installed catalogue still translates "${msgid}"`, false, `no ${po}`);
        return msgid;
    }

    const lines = File.Load(po).split("\n");
    const at    = lines.indexOf(`msgid "${msgid}"`);

    check(`the installed catalogue still translates "${msgid}"`, at >= 0);
    if (at < 0) return msgid;

    const m = /^msgstr "(.*)"$/.exec(lines[at + 1] || "");
    check("...as a single-line msgstr", m !== null, lines[at + 1]);
    return m ? m[1] : msgid;
}

/* There is no blocking sleep in the language -- `Timer` is a callback, and
 * every wait here happens inside a function that has to answer before it
 * returns. One process, and it is the same one a shell script would use. */
function pause(seconds) {
    Exec.Wait(["sleep", String(seconds)]);
}

function report(work) {
    print("");
    print(`${passed} passed, ${failures.length} failed`);
    for (const f of failures) print(`  FAIL ${f}`);

    /* A failed install is worth looking at, so it stays; a passed one is 40 MB
     * of /tmp nobody will ever open. */
    if (failures.length) {
        print(`\nthe staged install is still at ${work}`);
    } else {
        Directory.DeleteTree(work);
    }

    Application.Quit(failures.length ? 1 : 0);
}
