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
 *
 * The exit code is what a CI reads: 1 for an error, or for a warning under
 * `--strict`; 0 otherwise, and 2 when the command itself could not start.
 */
"use strict";

function usage() {
    print("usage: bintana check [--json] [--strict] <project-dir>");
}

function main() {
    let json = false, strict = false, target = null;
    let bad = null;

    for (const arg of Application.Arguments) {
        if (arg === "--json")       json = true;
        else if (arg === "--strict") strict = true;
        else if (arg === "-h" || arg === "--help") { usage(); Application.Quit(0); return; }
        else if (arg.startsWith("-")) bad = arg;
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
    const names   = new Names({
        owners: () => Owners.of(sources),
        /* A component of the project is not a class this process can build;
         * saying nothing about it is the same refusal the IDE makes. */
        componentEvents: null,
    });

    const host = {
        project: root,
        classes: { files: files.files, formOf: (rel) => files.formOf(rel) },
        names,
        problems: { report() {}, clear() {} },
    };
    const found = new Check(host).run();

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
            print(JSON.stringify({
                Event: "Finding",
                Kind:  f.kind,
                File:  f.file,
                Line:  f.line || 0,
                Text:  f.text,
            }));
        } else {
            print(`${f.file}:${f.line || 0}: ${String(f.kind).toLowerCase()}: ${f.text}`);
        }
    }

    if (json)
        print(JSON.stringify({ Event: "Done", Errors: errors, Warnings: warnings,
                               Infos: infos, Strict: strict }));

    Application.Quit(errors || (strict && warnings) ? 1 : 0);
}
