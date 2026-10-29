/*
 * A project's own tests: writing one, running them, and reading the answer.
 *
 * **The runtime runs them and this reads what it says.** `bintana test --json`
 * loads the project, then `tests/*Test.js`, and prints one JSON line per test
 * (see `Test` in rad.js). Nothing here knows what a test is beyond those lines:
 * a second runner inside the IDE would be a second answer to *did it pass*, and
 * it would be the one CI never runs.
 *
 * The answer is a page of the bottom panel beside Output and Problems -- a row
 * per test, its time, and for a failure the message -- because that is where
 * Lazarus, Visual Studio and Qt Creator all put it, and for `Problems`' reason:
 * a failure is about a line, and the line is what one keeps looking at. A
 * failed row goes to its line, through `Runner.open`, like every other place
 * in this IDE.
 *
 * What the child prints that is not a result -- the program's own `print`, a
 * traceback -- goes to Output, where a run's output always goes.
 */
"use strict";

/* The folder `bintana test` reads, and the only one: see `Test` in rad.js. */
export const TEST_DIR = "tests";

const TEST_KIND_W = 34;
const TEST_TIME_W = 70;
const TEST_NAME_W = 260;

export class Tests {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        this.job = null;
        /* Parallel to the table's rows: which result each one is. */
        this.rows = [];
        this.passed = 0;
        this.failed = 0;
    }

    /* Whether a project-relative file is one of the tests, which a normal run
     * never loads and `sources` therefore never lists. */
    static isTest(file) {
        return file.split("/")[0] === TEST_DIR;
    }

    /* --- writing one ------------------------------------------------------- */

    newTest() {
        if (!this.ide.project) {
            Message.Warning("Open a project before creating a test.");
            return;
        }
        AskForm.prompt(Locale.Text("New test"), Locale.Text("What it tests (a class name):"),
                       "Invoice", (name) => this.create(name));
    }

    /*
     * `tests/<Name>Test.js`, with one test in it that fails until it is
     * written -- a template that passes says something that is not true.
     */
    create(name) {
        const base = name.endsWith("Test") ? name.slice(0, -4) : name;
        if (!CLASS_NAME.IsMatch(base)) {
            Message.Error("\"{0}\" is not usable as a class name.", name);
            return null;
        }
        const cls  = `${base}Test`;
        const file = `${TEST_DIR}/${cls}.js`;
        const path = File.Join(this.ide.project, file);
        if (File.Exists(path)) {
            Message.Error("{0} already exists.", file);
            return null;
        }

        Directory.Make(File.Join(this.ide.project, TEST_DIR));
        File.Save(path,
            `/* Tests for ${base}. Run them with Project > Run tests. */\n` +
            `class ${cls} extends Test {\n` +
            `\n` +
            `    /* Before each test, on a new instance. */\n` +
            `    Setup() {\n` +
            `    }\n` +
            `\n` +
            `    testSomething() {\n` +
            `        this.Fail("not written yet");\n` +
            `    }\n` +
            `}\n`);

        this.ide.listFiles();
        this.ide.openInTab(file);
        this.ide.log(`Created ${file}\n`);
        return file;
    }

    /* --- running them ------------------------------------------------------ */

    run(filter) {
        const ide = this.ide;
        if (!ide.project) return;
        if (this.job && this.job.Running) this.job.Stop();

        ide.saveAllDirty();
        this.rows = [];
        this.passed = this.failed = 0;
        this.show();
        this.reveal();

        const plan = ide.launch.plan();
        const argv = ["test", "--json", ide.project, ...(filter ? [filter] : [])];
        ide.log(`> bintana ${argv.join(" ")}\n`);

        const job = Exec([Application.Executable, ...argv], plan.options,
                         (line) => this.line(line),
                         (code) => this.finished(job, code));
        this.job = job;
    }

    /* One line of the child's: a result, or something for Output. */
    line(text) {
        let row = null;
        if (text.startsWith("{")) {
            try { row = JSON.parse(text); } catch (e) { row = null; }
        }
        if (!row || typeof row.Event !== "string") {
            this.ide.runner.log(`${text}\n`);
            return;
        }
        if (row.Event === "Test") {
            this.rows.push(row);
            if (row.Ok) this.passed++; else this.failed++;
            this.show();
        }
    }

    finished(job, code) {
        if (this.job === job) this.job = null;
        this.ide.runner.flushLog();
        /* 0 and 1 are the two answers; anything else is a run that did not get
         * as far as answering, and the reason is in Output. */
        if (code !== 0 && code !== 1)
            this.ide.log(`[tests did not run: code ${code}]\n`);
        else
            this.ide.log(`[tests: ${this.passed} passed, ${this.failed} failed]\n`);
        this.show();
    }

    /* --- the view ---------------------------------------------------------- */

    show() {
        const table = this.ide.TestView;
        if (!table) return;

        table.Columns = [{ Text: "", Width: TEST_KIND_W },
                         { Text: Locale.Text("Test"), Width: TEST_NAME_W },
                         { Text: Locale.Text("Time"), Width: TEST_TIME_W },
                         { Text: Locale.Text("Message") }];
        table.Clear();
        /* Failures first: a list of forty green rows with one red one at the
         * bottom is a list that hides the only row worth reading. */
        this.shown = this.rows.filter((r) => !r.Ok).concat(this.rows.filter((r) => r.Ok));
        for (let i = 0; i < this.shown.length; i++) {
            const r = this.shown[i];
            table.Add(["", r.Name ? `${r.Class}.${r.Name}` : r.Class,
                       r.Ok ? `${r.Ms} ms` : "", r.Message || ""]);
            const icon = this.icon(r.Ok);
            if (icon) table.SetIcon(i, 0, icon);
        }
        this.say();
    }

    icon(ok) {
        const names = ok ? ["object-select-symbolic", "emblem-ok-symbolic"]
                         : ["dialog-error-symbolic", "dialog-error"];
        return names.find((name) => Application.HasIcon(name)) || "";
    }

    say() {
        const box = this.ide.ConsoleBox;
        const at  = this.page;
        if (!box || at < 0) return;
        if (!this.tab) {
            this.tab = new Label();
            box.SetTabLabel(at, this.tab);
        }
        this.tab.Text = this.failed
            ? Locale.Plural("{0} test failed", "{0} tests failed", this.failed)
            : Locale.Text("Tests");
    }

    get page() {
        const box = this.ide.ConsoleBox;
        if (!box || !this.ide.TestView) return -1;
        return box.Children.findIndex((c) => c.Name === "TestView");
    }

    /* The panel turned to the page, and shown if it was put away. */
    reveal() {
        if (this.page >= 0) this.ide.showConsole(this.page);
    }

    /* A row double clicked: a failure goes to its line. */
    activated() {
        const r = (this.shown || [])[this.ide.TestView.Index];
        if (!r || !r.File) return false;
        return this.ide.runner.open(r.File, r.Line || 1);
    }
}
