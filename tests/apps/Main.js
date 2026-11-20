/*
 * `bintana apps`, the CLI over the entries a user installed for themselves.
 *
 *   ./tests/apps.sh
 *
 * It writes two entries into a scratch `XDG_DATA_HOME` of its own -- one the
 * IDE would have written, with `X-Bintana-Project`, and one it would not -- and
 * runs the command as a child: what it lists, what it refuses to touch, what
 * `files` answers and what `remove` takes away. The parent sets
 * `XDG_DATA_HOME` before any child, so the run never reads or writes the
 * person's own menu.
 *
 * **No display, no project and no IDE**: the command is the core's, and the
 * only thing it needs is the folder. On Windows the entry is a Start Menu
 * `.lnk`, which no test can write by hand -- the runtime's half is
 * `tests/widgets`' `Desktop`, and this says it skipped rather than passing on
 * nothing.
 */
"use strict";

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

const root = File.Join(Environment.TempDirectory, `bta-apps-${Environment.ProcessId}`);
const dir  = File.Join(root, "applications");

const steps = [];

function step(fn) { steps.push(fn); }

function next() {
    const fn = steps.shift();

    if (!fn) {
        report();
        return;
    }
    fn(next);
}

function main() {
    if (Environment.OS === "Windows") {
        print("apps: the entry is a Start Menu .lnk, which this test cannot write -- skipped");
        Application.Quit(0);
        return;
    }

    Directory.Make(dir);

    /* Every child inherits this, and the parent never reads the person's own
     * applications folder. */
    Environment.Set("XDG_DATA_HOME", root);

    File.Save(File.Join(dir, "org.example.Demo.desktop"),
              "[Desktop Entry]\n" +
              "Type=Application\n" +
              "Name=Demo app\n" +
              "Comment=A test\n" +
              "Exec=/bin/true\n" +
              "X-Bintana-Project=/tmp/demo-project\n");

    File.Save(File.Join(dir, "org.other.Thing.desktop"),
              "[Desktop Entry]\n" +
              "Type=Application\n" +
              "Name=Somebody else\n" +
              "Exec=/bin/true\n");

    step(list);
    step(json);
    step(files);
    step(aForeignOneIsNotListedAsOurs);
    step(removeRefusesWhatItDidNotWrite);
    step(remove);
    step(empty);

    next();
}

/* The child, with the environment the parent has set. */
function apps(argv, done) {
    const lines = [];

    Exec([Application.Executable, "apps"].concat(argv),
         { Timeout: 20000 },
         (line) => lines.push(line),
         (code) => done(code, lines.join("\n")));
}

function list(done) {
    apps([], (code, out) => {
        eq("the command answers 0", code, 0);
        check("it lists the entry the IDE wrote", out.includes("Demo app"), out);
        check("...and not one it did not write", !out.includes("Somebody else"), out);
        check("...with the project it points at",
              out.includes("/tmp/demo-project"), out);
        done();
    });
}

function json(done) {
    apps(["--json"], (code, out) => {
        eq("--json answers 0", code, 0);

        let said = null;
        try { said = JSON.parse(out.split("\n")[0]); } catch (e) { said = null; }

        check("every line is a JSON object", said !== null, out);
        if (said) {
            eq("...with the id", said.Id, "org.example.Demo");
            eq("...the name", said.Name, "Demo app");
            eq("...the project", said.Project, "/tmp/demo-project");
            eq("...and the file it wrote",
               (said.Files || []).join(","),
               File.Join(dir, "org.example.Demo.desktop"));
        }
        done();
    });
}

function files(done) {
    apps(["files", "org.example.Demo"], (code, out) => {
        eq("files answers 0", code, 0);
        eq("with the one file an install wrote", out.trim(),
           File.Join(dir, "org.example.Demo.desktop"));
        done();
    });
}

function aForeignOneIsNotListedAsOurs(done) {
    apps(["files", "org.other.Thing"], (code, out) => {
        eq("an entry that is not the IDE's is refused", code, 1);
        check("...with a sentence naming it", out.includes("no application installed as"),
              out);
        done();
    });
}

function removeRefusesWhatItDidNotWrite(done) {
    apps(["remove", "org.other.Thing"], (code, out) => {
        eq("removing it is refused too", code, 1);
        check("...and the file is still there",
              File.Exists(File.Join(dir, "org.other.Thing.desktop")), out);
        done();
    });
}

function remove(done) {
    apps(["remove", "org.example.Demo"], (code, out) => {
        eq("removing what the IDE wrote answers 0", code, 0);
        check("...and says what it removed", out.includes("removed org.example.Demo"), out);
        check("...and the file is gone",
              !File.Exists(File.Join(dir, "org.example.Demo.desktop")));
        done();
    });
}

function empty(done) {
    apps([], (code, out) => {
        eq("an empty folder answers 0", code, 0);
        eq("...and says so", out.trim(), "No application installed from the IDE.");
        done();
    });
}

function report() {
    print("");
    print(`${passed} passed, ${failures.length} failed`);
    for (const f of failures) print(`  FAIL ${f}`);

    if (failures.length) {
        print(`\nthe scratch folder is still at ${root}`);
    } else {
        Directory.DeleteTree(root);
    }

    Application.Quit(failures.length ? 1 : 0);
}
