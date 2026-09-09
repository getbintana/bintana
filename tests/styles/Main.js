/*
 * Which style classes this desktop's theme defines, and what each one is
 * written for.
 *
 *   tests/styles.sh                 the theme compiled into GTK (what everyone gets)
 *   tests/styles.sh --all           every class in it, by how much it is used
 *   tests/styles.sh path/to/gtk.css a theme of your own
 *   tests/styles.sh --json          the same, for something else to read
 *
 * `Style` takes CSS class names, and which ones exist is the *theme's* answer
 * and never ours -- so a list written into the IDE would be a list that drifts,
 * and a drop-down of it would be a menu pretending to be complete for a
 * vocabulary that is open by definition. The vocabulary lives in
 * docs/widgets.md instead, and this is what generates it.
 *
 * What it reads is the stylesheet's own selectors, which say more than a list of
 * names could: `button.suggested-action` is for buttons and nothing else,
 * `.boxed-list > row` has to sit on the widget whose children are rows, and
 * `.linked` styles the children rather than the thing it is on. That is exactly
 * what one needs to know before writing a class into a form and wondering why
 * nothing happened.
 *
 * The suite cannot answer this, for the same reason it cannot answer which icons
 * exist: it runs under Xvfb against whatever Adwaita GTK carries, and the person
 * using the IDE may be running something else.
 */
"use strict";

const USAGE = `tests/styles.sh                 the theme compiled into GTK
tests/styles.sh --all           every class in it, by how much it is used
tests/styles.sh --json          the same as a machine reads it
tests/styles.sh path/to/gtk.css a theme of your own`;

/*
 * The classes worth reporting, grouped the way one goes looking for them.
 *
 * Not a list of what exists -- `--all` is that -- but of what a person writing a
 * form reaches for, which is a different and much shorter list.
 */
const GROUPS = [
    ["type",     ["large-title", "title-1", "title-2", "title-3", "title-4",
                  "heading", "body", "caption-heading", "caption", "title",
                  "subtitle", "dim-label", "monospace"]],
    ["buttons",  ["suggested-action", "destructive-action", "flat", "circular",
                  "image-button", "text-button"]],
    ["state",    ["error", "warning", "needs-attention"]],
    ["surfaces", ["frame", "view", "background", "osd", "toolbar", "linked",
                  "sidebar", "content-view"]],
    ["lists",    ["boxed-list", "rich-list", "navigation-sidebar", "data-table"]],
];

/*
 * A pseudo-class sits between the class and whatever it selects next, so it has
 * to be stepped over or `.linked:not(.vertical) > button` reads as styling
 * nothing.  Getting this wrong is what once offered `linked` on a Switch.
 */
const PSEUDO = /^(?::[a-z-]+(?:\([^)]*\))?)+/;

function Main() {
    const args = Application.Arguments;
    const all  = args.includes("--all");
    const json = args.includes("--json");

    if (args.includes("-h") || args.includes("--help")) {
        print(USAGE);
        Application.Quit(0);
        return;
    }

    const own = args.find((a) => !a.startsWith("-"));
    if (own) {
        if (!File.Exists(own)) {
            Logger.Error(`no such stylesheet: ${own}`);
            Application.Quit(1);
            return;
        }
        if (!json) print(`== ${own}`);
        report(File.Load(own), all, json);
        return;
    }

    defaultTheme((css, from) => {
        if (css === null) {
            Logger.Error(from);   /* what was missing, said once */
            Application.Quit(1);
            return;
        }
        if (!json) print(`== ${from}, Default-light`);
        report(css, all, json);
    });
}

/*
 * GTK keeps its own theme inside the library rather than on disk, which is why
 * there is nothing to find in /usr/share/themes for the default one.
 *
 * The shell version extracted it to a temporary file and set a trap to remove
 * it; here the lines are the answer, so there is no file to clean up and no
 * trap to get wrong.
 */
function defaultTheme(then) {
    const lib = gtkLibrary();
    if (!lib) {
        then(null, "no libgtk-4 found; pass a gtk.css instead");
        return;
    }
    if (!Application.HasCommand("gresource")) {
        then(null, "gresource not found (glib2), and no gtk.css given");
        return;
    }

    const lines = [];
    Exec(["gresource", "extract", lib, "/org/gtk/libgtk/theme/Default/Default-light.css"],
         (line) => lines.push(line),
         (code) => {
             if (code !== 0)
                 then(null, `gresource could not read the theme out of ${lib}`);
             else
                 then(lines.join("\n"), File.Name(lib));
         });
}

/* The versioned file and not the linker's symlink: `libgtk-4.so` is a
 * development link that need not be installed, and it is the same library. */
function gtkLibrary() {
    for (const dir of ["/usr/lib64", "/usr/lib"]) {
        if (!File.IsDir(dir)) continue;
        const found = Directory.List(dir, "libgtk-4.so.*");
        if (found.length) return File.Join(dir, found[0]);
    }
    return null;
}

function report(css, all, json) {
    /* One selector per entry: `a, b > c { }` is two things said, not one. */
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, " ");
    const sels  = [];
    for (const m of clean.matchAll(/([^{}]+)\{/g))
        for (const one of m[1].split(","))
            sels.push(one.trim());

    if (all) {
        const count = new Map();
        for (const sel of sels)
            for (const m of sel.matchAll(/\.([a-z][a-z0-9_-]*)/g))
                count.set(m[1], (count.get(m[1]) || 0) + 1);

        for (const [name, n] of [...count].sort((a, b) => b[1] - a[1]))
            print(`  ${name.padEnd(24)}${String(n).padStart(5)}`);

        Application.Quit(0);
        return;
    }

    if (json) {
        const out = [];
        for (const [group, names] of GROUPS) {
            for (const name of names) {
                const { n, hosts, kids } = look(sels, name);
                if (n) out.push({ name, group, on: hosts, kids });
            }
        }
        print(JSON.stringify(out, null, 2));
        Application.Quit(0);
        return;
    }

    for (const [group, names] of GROUPS) {
        print(`\n-- ${group}`);
        for (const name of names) {
            const { n, hosts, kids } = look(sels, name);
            if (!n) {
                print(`  ${name.padEnd(20)}   not in this theme`);
                continue;
            }
            /* Never truncated: a node name cut in half is a node name that is
             * wrong, and this list is read to write selectors with. */
            print(`  ${name.padEnd(20)}${String(n).padStart(4)}  on: ${hosts.join(", ")}`);
            if (kids.length)
                print(`  ${"".padEnd(24)}      styles > ${kids.join(", ")}`);
        }
    }

    print(`
\`on: any\` is a class the theme leaves unqualified: it applies wherever it is put.
Anything else is a class written for that node and no other -- \`Style\` on a
control puts the class on the node docs/widgets.md lists for it, and a class
whose node does not match is accepted, saved, and does nothing.

\`styles > x\` means the rules are about the children rather than the thing
carrying the class, so it needs a widget whose children really are \`x\`.`);

    Application.Quit(0);
}

/*
 * Where a class is written to go: how often the theme mentions it, which nodes
 * it is qualified to, and whose children it really styles.
 */
function look(sels, name) {
    const hosts = new Set();
    const kids  = new Set();
    const at    = new RegExp(`(?:^|[\\s>+~])([a-z-]*)\\.${name}\\b`, "g");
    let   n     = 0;

    for (const sel of sels) {
        at.lastIndex = 0;
        for (let m; (m = at.exec(sel)) !== null; ) {
            n++;
            hosts.add(m[1] || "any");

            const tail  = sel.slice(m.index + m[0].length).replace(PSEUDO, "");
            const child = /^\s*[>+~]\s*([a-z-]+)/.exec(tail);
            if (child) kids.add(child[1]);
        }
    }
    return { n, hosts: [...hosts].sort(), kids: [...kids].sort() };
}
