/*
 * Which declared icons this desktop really has -- and which of them will draw.
 *
 *   tests/icons.sh            every .form in the tree
 *   tests/icons.sh ide        only that directory
 *
 * The suite cannot answer this and never will: it runs under Xvfb, where GTK
 * falls back to Adwaita, so a name Adwaita ships and the user's theme does not
 * passes every test and comes out blank on the screen. `view-more-symbolic` did
 * it once and `view-table-symbolic` did it again.
 *
 * **So this must not ask GTK either**, and that is the whole design: it reads
 * the theme directories off the disk, the way the desktop's own specification
 * says to. `Application.HasIcon` would answer about whatever display this
 * process has -- which under Xvfb is Adwaita, which is the bug. A console
 * project has no display at all, so the mistake is not available to make.
 *
 * It looks in the same three places GTK does, and the third is the one that is
 * easy to forget: GTK4 embeds ~127 symbolic icons in its own library, so a name
 * that is in no theme directory can still be perfectly available.
 *
 * **Being there is not the same as drawing**, which is the second question and
 * was learnt the hard way: see `drawsNothing`. A theme file GTK cannot render is
 * reported apart from a name the desktop does not have, because the two are
 * somebody else's bug and ours respectively.
 */
"use strict";

const WHERE = File.Absolute(Application.Arguments[0] || ".");

/* The three roots of the icon theme specification, in the order GTK reads
 * them: the user's own first, the system's after. */
const ROOTS = [
    File.Join(Environment.HomeDirectory, ".local", "share", "icons"),
    "/usr/share/icons",
    File.Join(Environment.HomeDirectory, ".icons"),
];

/* `flatpak/` and `build-flatpak/` are build output of a package -- copies of
 * the tree's `.form` files -- and a copy would be reported twice. */
const SKIP = ["build", "build-asan", "build-flatpak", "flatpak", "vendor",
              ".git", "node_modules"];

function Main() {
    desktopTheme((theme) => {
        /* hicolor last and only if the chain did not already reach it: every
         * theme inherits it in the end, declared or not. */
        const themes = chain(theme);
        if (!themes.includes("hicolor")) themes.push("hicolor");

        const names = new Set();
        const where = new Map();   /* icon -> the file it resolves to */

        for (const name of themes)
            for (const root of ROOTS)
                collectImages(File.Join(root, name), names, where);

        embeddedNames(names, (embedded) => {
            /* And what a project ships itself: <project>/icons is on the search
             * path, so an icon of its own is as available as the desktop's. */
            const own = new Set();
            for (const dir of Directory.Folders(WHERE, { Pattern: "icons", Recursive: true }))
                for (const file of Directory.Files(dir))
                    own.add(File.BaseName(File.Name(file)));
            for (const name of own) names.add(name);

            print(`theme: ${themes.join(" -> ")}`);
            print(`${names.size} names (${embedded} of them inside GTK, ` +
                  `${own.size} shipped by the project)`);

            report(names, where);
        });
    });
}

/*
 * What this desktop calls its icon theme.
 *
 * Two desktops answer, in the order of who is more likely to be right about
 * *this* session: XFCE keeps it in xfconf and GNOME in gsettings, and a machine
 * with both installed is answered by whichever is actually running -- xfconf
 * fails on a GNOME session and the other way around. `hicolor` when neither
 * says: it is the fallback every theme inherits, so the answer is never empty.
 */
function desktopTheme(then) {
    ask(["xfconf-query", "-c", "xsettings", "-p", "/Net/IconThemeName"], (xfce) => {
        if (xfce) { then(xfce); return; }

        ask(["gsettings", "get", "org.gnome.desktop.interface", "icon-theme"], (gnome) => {
            /* gsettings quotes its answer, xfconf does not. */
            then(gnome ? gnome.replace(/^'|'$/g, "") : "hicolor");
        });
    });
}

/* One line of output from a program, or null when there is no such program or
 * it failed.  A missing desktop tool is the ordinary case here -- most machines
 * have one of the two -- and not a failure worth a message. */
function ask(argv, then) {
    if (!Application.HasCommand(argv[0])) { then(null); return; }

    let first = null;
    Exec(argv, (line) => { if (first === null) first = line.trim(); },
               (code) => then(code === 0 && first ? first : null));
}

/*
 * A theme and everything it inherits, in order.
 *
 * `Inherits=` in index.theme, which is how a theme says "and everything else
 * from there" -- following it is what makes a theme that ships forty icons
 * usable at all.  Cycles are real (two themes inheriting each other is a
 * packaging mistake nobody notices), so a name already seen ends that branch.
 */
function chain(theme, seen = []) {
    if (!theme || seen.includes(theme)) return seen;
    seen = seen.concat(theme);

    for (const root of ROOTS) {
        const index = File.Join(root, theme, "index.theme");
        if (!File.Exists(index)) continue;

        for (const line of File.Load(index).split("\n")) {
            if (!line.startsWith("Inherits=")) continue;
            for (const parent of line.slice("Inherits=".length).split(","))
                seen = chain(parent.trim(), seen);
        }
    }
    return seen;
}

/*
 * Every icon name under a theme directory: the file's name without its
 * extension, which is the name GTK is asked for.
 *
 * Three globs rather than one walk with a test, because the walk is the
 * runtime's now and a pattern is what it takes.  A theme's files are mostly
 * *symlinks* to other files -- elementary-xfce is built out of them -- and they
 * count: `Directory.Files` lists a symlinked file as a file, and only declines
 * to *descend into* a symlinked directory.
 */
function collectImages(dir, into, where) {
    if (!File.IsDir(dir)) return;

    for (const pattern of ["*.svg", "*.png", "*.xpm"])
        for (const path of Directory.Files(dir, { Pattern: pattern, Recursive: true })) {
            const name = File.BaseName(File.Name(path));

            into.add(name);
            if (where) remember(where, name, path);
        }
}

/*
 * Which file a name resolves to.
 *
 * The **first** one, since the themes are walked in the order they inherit and
 * the roots in the order GTK reads them -- with one correction, which is the
 * only part of GTK's choice that changes the answer here: a `-symbolic` name
 * asked for at 16px comes out of the theme's *scalable* `symbolic/` directory,
 * not out of the fixed-size `24/` next to it. elementary-xfce ships both, and
 * they are different drawings: the one in `24/` needs no transform and the one
 * GTK actually uses does.
 */
function remember(where, name, path) {
    const had = where.get(name);
    if (had === undefined) { where.set(name, path); return; }

    /* A `-symbolic` name asked for at 16px comes out of the theme's *scalable*
     * `symbolic/` directory and not out of the fixed-size `24/` next to it.
     * elementary-xfce ships both, and they are different drawings. */
    const mine = name.endsWith("-symbolic") && path.includes("/symbolic/");
    const its  = name.endsWith("-symbolic") && had.includes("/symbolic/");

    if (mine !== its) {
        if (mine) where.set(name, path);
        return;
    }

    /*
     * And otherwise the smaller path, which is **not** arbitrary: a directory
     * listing has no promised order, so "the first one seen" made this tool
     * answer differently on two runs of the same command. A rule that ignores
     * the order is the only kind worth having here.
     */
    if (path < had) where.set(name, path);
}

/*
 * Whether GTK will draw that file as nothing.
 *
 * **Being on the desktop is not the question this tool was written to answer,
 * and it took a blank arrow to notice.** GTK 4.20 replaced the librsvg path for
 * symbolic icons with an SVG parser of its own, and that parser does not apply
 * `transform`. A theme that positions its artwork with one -- elementary-xfce
 * draws 120 of its 258 symbolic icons as a path at x=321 pulled back by
 * `translate(-313 3)` -- then has every one of them land outside the 16x16 box.
 * The file is there, the name resolves, `Application.HasIcon` says yes, and the
 * button is empty.
 *
 * So: a transform, and geometry that only fits once it is applied. The box is
 * the `viewBox` or the `width`, and the test is the largest number in any path:
 * inside a drawing that fits, no coordinate is far outside its own box.
 *
 * Only SVGs, and only a guess -- a full SVG is not parsed here and never will
 * be. It is the same bargain the rest of this file makes: read the disk the way
 * the specification says to, and be specific about what is not being asked.
 */
function drawsNothing(name, path) {
    /*
     * **Only the symbolic ones**, and that is measured rather than assumed: an
     * ordinary icon goes through the SVG loader that has always been there and
     * draws its transform correctly. Put `edit-delete` and
     * `edit-delete-symbolic` on two buttons of the same window under this theme
     * and the first one appears; both files position their artwork the same way.
     * Reporting the plain one would be crying wolf about the eight hundred
     * icons in this theme that are fine.
     */
    if (!name.endsWith("-symbolic")) return false;
    if (!File.IsExtension(path, "svg")) return false;

    let svg;
    try { svg = File.Load(path); } catch (e) { return false; }

    if (!new Regex("transform\\s*=\\s*\"[^\"]*(translate|matrix)").IsMatch(svg))
        return false;

    const box = sizeOf(svg);
    if (!box) return false;

    let far = 0;
    for (const d of new Regex("\\bd\\s*=\\s*\"([^\"]*)\"").Matches(svg))
        for (const n of new Regex("-?\\d+(\\.\\d+)?").Matches(d.Group(1)))
            far = Math.max(far, Math.abs(Number(n.Value)));

    /* Twice the box: a drawing that fits has no coordinate far outside it, and
     * one that is placed by a transform has all of them. Nothing lands between
     * the two in practice -- elementary's arrow is 20 times its own box. */
    return far > box * 2;
}

/* The side of the square the icon is drawn in: the viewBox if there is one,
 * and the width if there is not. */
function sizeOf(svg) {
    const view = new Regex("viewBox\\s*=\\s*\"\\s*[-\\d.]+\\s+[-\\d.]+\\s+([\\d.]+)").Match(svg);
    if (view) return Number(view.Group(1));

    const wide = new Regex("\\bwidth\\s*=\\s*\"([\\d.]+)").Match(svg);
    return wide ? Number(wide.Group(1)) : 0;
}

/*
 * What GTK carries inside itself, which no theme directory shows.
 *
 * Its resources are compiled into the library, so the only way to see them is
 * to ask `gresource`.  A name found here is available on every desktop that has
 * GTK, which is the whole point: it cannot be missing.
 */
function embeddedNames(into, then) {
    const lib = gtkLibrary();
    if (!lib || !Application.HasCommand("gresource")) { then(0); return; }

    let found = 0;
    Exec(["gresource", "list", lib],
         (line) => {
             if (!line.includes("/icons/")) return;
             into.add(File.BaseName(File.Name(line.trim())));
             found++;
         },
         () => then(found));
}

function gtkLibrary() {
    for (const dir of ["/usr/lib64", "/usr/lib"]) {
        if (!File.IsDir(dir)) continue;
        const found = Directory.List(dir, "libgtk-4.so*");
        if (found.length) return File.Join(dir, found[0]);
    }
    return null;
}

/*
 * The declared icons, and which of them this desktop cannot draw.
 *
 * A `.form` is JSON, so this is a walk of the tree rather than a search of the
 * text: `Icon` is a property of a control and `"Icon"` in a label's text is
 * not the same thing.
 */
function report(names, where) {
    const missing = new Map();   /* icon -> the places that declare it */
    const blank   = new Map();   /* icon -> the same, for ones that draw nothing */
    let checked = 0;

    for (const path of Directory.Files(WHERE, { Pattern: "*.form", Recursive: true })) {
        if (skipped(path)) continue;

        let root;
        try {
            root = File.LoadJson(path);
        } catch (e) {
            continue;   /* not a .form this runtime could open either */
        }

        walk(root, (node) => {
            const icon = (node.properties || {}).Icon;
            if (typeof icon !== "string" || !icon) return;

            checked++;

            const said = `${path}: ${node.name || node.class}`;
            const into = !names.has(icon) ? missing
                       : blankly(icon, where) ? blank
                       : null;
            if (!into) return;

            if (!into.has(icon)) into.set(icon, []);
            into.get(icon).push(said);
        });
    }

    print(`${checked} icons declared in .form files`);

    if (!missing.size && !blank.size) {
        print("all of them are on this desktop, and all of them draw");
        Application.Quit(0);
        return;
    }

    if (missing.size)
        say("NOT on this desktop -- there is no such file here:", missing);

    if (blank.size)
        say("on this desktop and EMPTY -- the file positions its drawing with a\n" +
            "transform, and GTK 4.20 and later do not apply one to a symbolic icon:",
            blank);

    Application.Quit(1);
}

/* Answered once per name however many forms declare it: a theme file is read
 * from the disk, and `view-list-symbolic` is on eleven controls. */
const verdicts = new Map();

function blankly(icon, where) {
    if (!verdicts.has(icon)) {
        const file = where.get(icon);
        verdicts.set(icon, file ? drawsNothing(icon, file) : false);
    }
    return verdicts.get(icon);
}

function say(headline, found) {
    print(`\n${headline}`);
    for (const icon of [...found.keys()].sort()) {
        print(`  ${icon}`);
        for (const said of found.get(icon).sort()) print(`      ${said}`);
    }
}

function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    visit(node);
    for (const child of node.children || []) walk(child, visit);
}

/* Built output and vendored source are not this project's files: a copy of a
 * .form under build/ would be reported twice, and vendor/ is somebody else's. */
function skipped(path) {
    return SKIP.some((name) => path.includes(`/${name}/`));
}
