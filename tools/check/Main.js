/*
 * `bintana check <project>`: the IDE's project pass from a shell.
 *
 * A console project, like `tests/api` and `tools/llms`: no display, no window,
 * and the runtime loads it only when the subcommand runs. The check itself is
 * `lib/check`, so what answers here is the same code an application can use --
 * and nothing about it is loaded by a run that never asks.
 *
 *   bintana check <project>            text, one line per finding
 *   bintana check --json <project>     one JSON line per finding, and one Done
 *   bintana check --strict <project>   warnings fail the run too
 *   bintana check --components <file>  the IDE's component events, as JSON
 *   bintana check --fix <project>      apply the unambiguous Label.For repairs
 *
 * The exit code is what a CI reads: 1 for an error, or for a warning under
 * `--strict`; 0 otherwise, and 2 when the command itself could not start.
 */
"use strict";

function usage() {
    print("usage: bintana check [--json] [--strict] [--components <file>] [--fix] <project-dir>");
}

/* The node with that name, at any depth. */
function nodeNamed(nodes, name) {
    for (const node of nodes || []) {
        if (node.name === name) return node;
        const deeper = nodeNamed(node.children, name);
        if (deeper) return deeper;
    }
    return null;
}

/*
 * The one repair a machine can make without inventing prose: a caption that
 * sits immediately above a field, and no `For` on either side. Answers whether
 * the file changed.
 */
function applyLabelFor(root, finding) {
    const form  = File.LoadJson(File.Join(root, finding.file));
    const label = nodeNamed(form.children, finding.fix.label);
    if (!label) return false;

    label.properties = label.properties || {};
    if (label.properties.For) return false;
    label.properties.For = finding.fix.field;

    File.SaveJson(File.Join(root, finding.file), form);
    return true;
}

function main() {
    let json = false, strict = false, fix = false, target = null, components = null;
    let bad = null;
    const args = Application.Arguments;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--json")       json = true;
        else if (arg === "--strict") strict = true;
        else if (arg === "--fix")    fix = true;
        else if (arg === "--components") {
            const path = args[++i];
            if (!path) bad = "--components needs a file";
            else       components = path;
        } else if (arg === "-h" || arg === "--help") {
            usage();
            Application.Quit(0);
            return;
        } else if (arg.startsWith("-")) bad = arg;
        else if (target) bad = arg;
        else target = arg;
    }

    if (bad || !target) {
        if (bad) print(`bintana check: unexpected '${bad}'`);
        usage();
        Application.Quit(2);
        return;
    }

    const root = File.Absolute(target);
    if (!File.IsDir(root)) {
        print(`bintana check: '${target}' is not a directory`);
        Application.Quit(2);
        return;
    }

    const files = new ProjectFiles(root);
    files.scan();

    const sources = files.sources();
    /* Read once: `Names.ambiguous` asks who owns a name for every file it
     * walks, and `Owners.of` reads and parses every source. Rebuilding it per
     * file was O(files²) -- 12.6 s against this repository's own `ide/`, 3.2 s
     * with the map made once. */
    const owners  = Owners.of(sources);

    /*
     * The IDE runs this check as a child, and a component of the project is a
     * class this process cannot build. The events it declares come from the
     * IDE's `Classes.componentEventsMap()` in a file beside the command; a
     * shell without one says nothing about a component's events, which is the
     * refusal it has always made.
     */
    let componentEvents = null;
    if (components) {
        try {
            const map = File.LoadJson(File.Absolute(components));
            componentEvents = (type) => map[type] || null;
        } catch (e) {
            print(`bintana check: cannot read --components: ${e.message}`);
            Application.Quit(2);
            return;
        }
    }

    const names   = new Names({
        owners: () => owners,
        componentEvents,
    });

    const host = {
        project: root,
        classes: { files: files.files, formOf: (rel) => files.formOf(rel) },
        names,
        problems: { report() {}, clear() {} },
    };
    let found = new Check(host).run();
    let fixed = 0;

    if (fix) {
        for (const f of found) {
            if (!f.fix || !f.file) continue;
            try {
                if (applyLabelFor(root, f)) fixed++;
            } catch (e) {
                print(`bintana check: could not fix ${f.file}: ${e.message}`);
            }
        }
        if (fixed) found = new Check(host).run();
    }

    if (fix) {
        if (json)
            print(JSON.stringify({ Event: "Fixed", Count: fixed }));
        else
            print(`fixed ${fixed} accessibility row${fixed === 1 ? "" : "s"}`);
    }

    /* Worst first, then by place, and the same order in both spellings. The
     * panel's order, so a shell and the IDE read the list the same way. */
    const rank = { Error: 0, Warning: 1, Info: 2 };
    found.sort((a, b) => (rank[a.kind] - rank[b.kind]) ||
                         Locale.Compare(a.file, b.file) ||
                         (a.line - b.line) ||
                         Locale.Compare(a.text, b.text));

    let errors = 0, warnings = 0, infos = 0;

    for (const f of found) {
        if (f.kind === "Error") errors++;
        else if (f.kind === "Warning") warnings++;
        else infos++;

        if (json) {
            const row = {
                Event: "Finding",
                Kind:  f.kind,
                File:  f.file,
                Line:  f.line || 0,
                Text:  f.text,
            };
            if (f.fix) row.Fix = f.fix;
            print(JSON.stringify(row));
        } else {
            print(`${f.file}:${f.line || 0}: ${String(f.kind).toLowerCase()}: ${f.text}`);
        }
    }

    if (json)
        print(JSON.stringify({ Event: "Done", Errors: errors, Warnings: warnings,
                               Infos: infos, Strict: strict }));

    Application.Quit(errors || (strict && warnings) ? 1 : 0);
}
