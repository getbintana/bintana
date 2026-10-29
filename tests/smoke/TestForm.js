/*
 * Runtime smoke test.
 *
 * Runs inside Form_Open and quits with a non-zero status on any failure, so
 * `tests/run.sh` can gate on it.  Event assertions matter most: setting a
 * property from JS has to travel out to GTK, come back as a real signal, and
 * land on the form's Name_Event method.
 */
"use strict";

const fired = [];
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

function throws(name, fn) {
    try {
        fn();
        failures.push(`${name}: expected a throw, none happened`);
    } catch (e) {
        passed++;
    }
}

class TestForm extends Form {

    /* --- handlers the runtime is expected to find by name --------------- */
    Button1_Click()   { fired.push("Button1_Click"); }
    TextBox1_Change() { fired.push("TextBox1_Change"); }
    CheckBox1_Click() { fired.push("CheckBox1_Click"); }
    ListBox1_Select() { fired.push("ListBox1_Select"); }

    Form_Open() {
        fired.push("Form_Open");

        /* Without this, an unexpected throw would abort Form_Open before the
         * Quit and the run would hang until the timeout instead of failing. */
        try {
            this.runAll();
        } catch (e) {
            failures.push(`uncaught: ${e.message}\n${e.stack || ""}`);
        }

        print("");
        for (const f of failures) print(`  FAIL  ${f}`);
        print(`smoke: ${passed} passed, ${failures.length} failed`);
        Application.Quit(failures.length ? 1 : 0);
    }

    /*
     * **Every shipped library, in one project.** This is the only place any two
     * of them are loaded together, and until it existed nothing was: each
     * library had a test project of its own, so the suite proved all three work
     * and never that any two work at once.
     *
     * What that hid was fatal and silent to the suite. A library's sources are
     * evaluated into the project's own global scope, so `lib/report` and
     * `lib/markdown` each declaring a top-level `const PAPERS` meant a project
     * naming both did not start at all -- `SyntaxError: redeclaration of
     * 'PAPERS'`, on line 1 of a file its author never wrote. `tests/api.sh`
     * compares the top-level names now; this is the other half, because a name
     * check cannot prove three libraries actually come up.
     */
    testLibrariesTogether() {
        /* `typeof` on a bare name rather than a lookup on the global object:
         * there is no `globalThis` here, and `typeof` is the one operator that
         * does not throw on a name that was never declared -- which is exactly
         * the answer being asked for. */
        check("Report is here with the others",   typeof Report === "function");
        check("and Markdown", typeof Markdown === "function");
        check("and Chart",    typeof Chart === "function");
        check("and both of the questions", typeof Confirm === "function" &&
                                       typeof AskText === "function");

        /* `lib/dialog`'s two classes are `Form` subclasses, so *building* one
         * runs the `.form` loader against the class -- which is the thing that
         * can be wrong and the thing a `typeof` cannot see. Neither is shown:
         * a smoke run leaves no window on screen, and what is asserted here is
         * that the form and its controls came up, not how a dialog behaves.
         * `tests/widgets` drives the behaviour. */
        const ask = new AskText();
        eq("a question's own class is what it is",
           ask instanceof AskText, true);
        eq("and it built its field", typeof ask.TxtValue.Text, "string");
        eq("with the focus going there, not to a button",
           ask.TxtValue.Focusable, true);
        const dlg = new Confirm();
        eq("and the yes/no is a form too", dlg instanceof Confirm, true);
        eq("whose accepting button carries the destructive style",
           dlg.BtnAccept.Style, "destructive-action");
        eq("and whose cancel is not Default, so Enter cannot destroy anything",
           dlg.BtnCancel.Default, false);
        eq("while the prompt's OK is, because there Enter is the answer",
           ask.BtnOk.Default, true);

        /* The declared prose, and *which* prose: the two labels each class owns
         * and not the caller's. This is the declaration the extractor would read
         * if it could reach a library, which it cannot -- `docs/llm/dialog.md`
         * says so and says what a project does instead. */
        eq("the yes/no declares its two labels",
           Confirm.TextProperties.join(","), "BtnAccept,BtnCancel");
        eq("and the prompt its own two",
           AskText.TextProperties.join(","), "BtnOk,BtnCancel");

        /* And the table they used to keep a copy of each is one table. */
        eq("a paper size is the runtime's", Printer.Papers.A4.Width, 595);
    }

    runAll() {
        this.testLibrariesTogether();
        this.testFormLoader();
        this.testGeometry();
        this.testProperties();
        this.testEvents();
        this.testListBox();
        this.testContainers();
        this.testPrelude();
        this.testConsoleExit();
        this.testLook();
        this.testTests();
    }

    /* --- .form loading -------------------------------------------------- */
    testFormLoader() {
        eq("form.Text from .form", this.Text, "smoke");
        eq("form.Width from .form", this.Width, 320);

        for (const n of ["Label1", "Button1", "TextBox1", "CheckBox1", "ListBox1", "Panel1"]) {
            check(`${n} exists`, this[n] instanceof Widget, `this.${n} is ${typeof this[n]}`);
        }
        check("Button1 is a Button", this.Button1 instanceof Button);
        check("Button1 is also a Control", this.Button1 instanceof Control);
        check("Panel1 is a Container", this.Panel1 instanceof Container);
        check("nested child loaded", this.Nested1 instanceof Label);
        eq("nested child text", this.Nested1.Text, "nested");
    }

    /* --- geometry ------------------------------------------------------- */
    testGeometry() {
        eq("Button1.X from .form", this.Button1.X, 10);
        eq("Button1.Y from .form", this.Button1.Y, 40);
        eq("Button1.Width from .form", this.Button1.Width, 90);

        this.Button1.Move(33, 44);
        eq("Move sets X", this.Button1.X, 33);
        eq("Move sets Y", this.Button1.Y, 44);

        this.Button1.Resize(120, 40);
        eq("Resize sets Width", this.Button1.Width, 120);
        eq("Resize sets Height", this.Button1.Height, 40);

        this.Button1.X = 10;
        eq("X is assignable", this.Button1.X, 10);
    }

    /* --- properties ----------------------------------------------------- */
    testProperties() {
        eq("Label1.Text from .form", this.Label1.Text, "label");
        this.Label1.Text = "cambiado";
        eq("Label.Text round-trip", this.Label1.Text, "cambiado");

        eq("Button1.Text from .form", this.Button1.Text, "button");

        eq("Enabled defaults true", this.Button1.Enabled, true);
        this.Button1.Enabled = false;
        eq("Enabled round-trip", this.Button1.Enabled, false);
        this.Button1.Enabled = true;

        this.TextBox1.Password = true;
        eq("Password round-trip", this.TextBox1.Password, true);
        this.TextBox1.Password = false;

        this.TextBox1.ReadOnly = true;
        eq("ReadOnly round-trip", this.TextBox1.ReadOnly, true);
        this.TextBox1.ReadOnly = false;

        this.Label1.Alignment = "Right";
        eq("Alignment round-trip", this.Label1.Alignment, "Right");

        eq("Name reflects the .form", this.Button1.Name, "Button1");
        eq("a form answers to Form for events", this.Name, "Form");
    }

    /* --- events: JS -> GTK -> JS ---------------------------------------- */
    testEvents() {
        check("Form_Open fired", fired.includes("Form_Open"));

        const before = fired.length;
        this.TextBox1.Text = "hi";
        check("assigning Text raises Change",
              fired.length > before && fired[fired.length - 1] === "TextBox1_Change",
              `fired=${JSON.stringify(fired)}`);
        eq("TextBox1.Text round-trip", this.TextBox1.Text, "hi");

        this.CheckBox1.Active = true;
        check("assigning Value raises Click", fired.includes("CheckBox1_Click"));
        eq("CheckBox1.Active round-trip", this.CheckBox1.Active, true);

        /* A handler that does not exist must simply be ignored. */
        this.Label1.Text = "no handler";
        check("missing handler is not an error", true);
    }

    /* --- ListBox -------------------------------------------------------- */
    testListBox() {
        this.ListBox1.Items = ["one", "two", "three"];
        eq("Items sets Count", this.ListBox1.Count, 3);
        eq("Items round-trip", JSON.stringify(this.ListBox1.Items),
           JSON.stringify(["one", "two", "three"]));
        eq("nothing selected yet", this.ListBox1.Index, -1);

        this.ListBox1.Index = 1;
        eq("Index round-trip", this.ListBox1.Index, 1);
        eq("Text follows Index", this.ListBox1.Text, "two");
        check("selecting raises Select", fired.includes("ListBox1_Select"));

        this.ListBox1.Add("cuatro");
        eq("Add appends", this.ListBox1.Count, 4);

        this.ListBox1.RemoveRow(0);
        eq("Remove drops one", this.ListBox1.Count, 3);
        eq("Remove shifts the rest", this.ListBox1.Items[0], "two");

        this.ListBox1.Clear();
        eq("Clear empties", this.ListBox1.Count, 0);
    }

    /* --- containers ----------------------------------------------------- */
    testContainers() {
        const b = new Button();
        b.Text = "dinamico";
        b.Name = "Dyn1";
        this.Panel1.Add(b);
        b.Move(5, 40);
        eq("added child keeps geometry", b.X, 5);
        eq("dynamic Button.Text", b.Text, "dinamico");

        throws("Add rejects non-widgets", () => this.Panel1.Add(42));
        throws("Add rejects a form", () => this.Panel1.Add(new TestForm()));
        throws("leaf controls are not containers", () => this.Label1.Add(b));
        throws("abstract Widget is not constructible", () => new Widget());
        throws("abstract Control is not constructible", () => new Control());
    }

    /* --- rad.js prelude ------------------------------------------------- */
    testPrelude() {
        eq("Caption aliases Text", this.Button1.Caption, this.Button1.Text);
        this.Button1.Caption = "via caption";
        eq("Caption writes through", this.Button1.Text, "via caption");

        const names = this.Controls.map((c) => c.Name).sort();
        check("Controls lists the loaded controls",
              names.includes("Button1") && names.includes("Panel1"),
              `got ${JSON.stringify(names)}`);

        check("Message is available", typeof Message.Info === "function");
        check("Application.Directory points at the project",
              Application.Directory.endsWith("tests/smoke"), Application.Directory);
        /*
         * Two versions, and the point of the pair is that they are different
         * questions. `BTA_VERSION` is the runtime's, out of the one place
         * CMakeLists declares it -- so `x.y.z` and not the empty string proves it
         * came from the build rather than from a literal somebody forgot.
         * `Application.Version` is the *project's*, and this project declares
         * none, which is the state every project written before the field
         * existed is in.
         */
        check("the runtime says which version it is",
              /^\d+\.\d+\.\d+$/.test(BTA_VERSION), BTA_VERSION);
        eq("and a project that declares none answers with nothing",
           Application.Version, "");

        /*
         * The two halves of the library lookup, and the point of asserting them
         * together is that they are one search: `Libraries` says which names
         * there are and `LibraryPath` says where one of them is, over the same
         * six places. A name the first offers that the second cannot find would
         * mean two implementations had already drifted -- which is the whole
         * reason neither of them lives in the IDE.
         */
        const libs = Application.Libraries();
        check("the libraries that ship here are offered",
              libs.includes("charts") && libs.includes("report") &&
              libs.includes("dialog"),
              JSON.stringify(libs));
        check("every name it offers resolves",
              libs.every((name) => Application.LibraryPath(name) !== ""),
              JSON.stringify(libs.filter((n) => !Application.LibraryPath(n))));
        check("each one once, and in order",
              JSON.stringify(libs) === JSON.stringify([...new Set(libs)].sort()),
              JSON.stringify(libs));
        eq("and a name nothing has resolves to nothing",
           Application.LibraryPath("no-such-library-here"), "");
    }

    /* --- `bintana test`: a project's own tests ------------------------------
     *
     * A real project with a real `tests/` folder, run as a child under the
     * subcommand, in both shapes a project has (a startup form, and `main`):
     * what passed and failed, the status CI reads, the JSON the IDE reads, the
     * filter, a file whose class is missing, a wait that never holds, an error
     * in a callback landing on the test that was running -- and the half that
     * is easy to forget, that a normal run never loads `tests/`.
     */
    testTests() {
        const dir = File.Join(Environment.TempDirectory,
                              `bta-smoke-tests-${Environment.ProcessId}`);
        Directory.Make(File.Join(dir, "tests"));
        const write = (shape) => File.Save(File.Join(dir, "project.json"),
            JSON.stringify(shape === "main"
                ? { name: "smoke-tests", main: "Go" }
                : { name: "smoke-tests", startup: "Main" }));
        File.Save(File.Join(dir, "Invoice.js"),
            "class Invoice {\n" +
            "  constructor(l) { if (l.some((x) => x < 0)) throw new RangeError('neg'); this.l = l; }\n" +
            "  get Total() { return this.l.reduce((a, b) => a + b, 0); }\n" +
            "}\n" +
            "class Main extends Form { Form_Open() { print('the program ran'); Application.Quit(); } }\n" +
            "function Go() { print('the program ran'); }\n");
        File.Save(File.Join(dir, "tests", "InvoiceTest.js"),
            "class InvoiceTest extends Test {\n" +
            "  Setup() { this.inv = new Invoice([10, 5]); }\n" +
            "  testTotal() { this.Eq(this.inv.Total, 15); }\n" +
            "  testWrong() { this.Eq(this.inv.Total, 16, 'total'); }\n" +
            "  testRefuse() { this.Check(this.Throws(() => new Invoice([-1])) instanceof RangeError); }\n" +
            "  testLater() { let d = false; Timer.After(20, () => { d = true; }); this.Until(() => d, () => this.Check(d)); }\n" +
            "  testNever() { this.Until(() => false, () => {}, { Ms: 50, What: 'the reply' }); }\n" +
            "  testCallback() { Timer.After(5, () => nope()); this.Until(() => false, () => {}, { Ms: 150 }); }\n" +
            "}\n");
        File.Save(File.Join(dir, "tests", "LostTest.js"),
                  "print('tests were loaded');\nclass Elsewhere extends Test {}\n");

        const run = (...args) => {
            const res = Exec.Wait([Application.Executable, ...args], { Timeout: 20000 });
            const rows = res.Output.split("\n").filter((l) => l.startsWith("{"))
                            .map((l) => JSON.parse(l));
            return { code: res.ExitCode, out: res.Output, rows,
                     test: (n) => rows.find((r) => r.Event === "Test" && r.Name === n) };
        };

        try {
            for (const shape of ["startup", "main"]) {
                write(shape);
                const r = run("test", "--json", dir);
                eq(`${shape}: a failure ends the run 1`, r.code, 1);
                const done = r.rows.find((x) => x.Event === "Done");
                eq(`${shape}: ...and says how many of each`,
                   done && `${done.Passed}/${done.Failed}`, "3/4");
                eq(`${shape}: a test that holds passes`, r.test("testTotal").Ok, true);
                eq(`${shape}: one that does not says what it got`,
                   r.test("testWrong").Message, "total: expected 16, got 15");
                eq(`${shape}: ...and the line it is on`, r.test("testWrong").Line, 4);
                eq(`${shape}: a wait passes when it holds`, r.test("testLater").Ok, true);
                eq(`${shape}: and fails by name when it never does`,
                   r.test("testNever").Message, "the reply: never became true in 50 ms");
                check(`${shape}: an error in a callback is the running test's`,
                      !r.test("testCallback").Ok &&
                      r.test("testCallback").Message.includes("nope"),
                      JSON.stringify(r.test("testCallback")));
                check(`${shape}: a file without its class is a red line, not a smaller total`,
                      r.rows.some((x) => x.Class === "LostTest" && !x.Ok),
                      JSON.stringify(r.rows.filter((x) => x.Class === "LostTest")));
                check(`${shape}: the program itself does not run`,
                      !r.out.includes("the program ran"), r.out.slice(0, 300));
            }

            write("startup");
            const only = run("test", "--json", dir, "Total");
            eq("a filter keeps the tests whose name contains it", only.rows.length, 2);
            eq("and a run of passing tests ends 0", only.code, 0);

            const plain = run(dir);
            check("a normal run never loads tests/, even with no sources list",
                  plain.out.includes("the program ran") && !plain.out.includes("tests were loaded"),
                  plain.out.slice(0, 300));
            eq("--json is refused outside test", run("--json", dir).code, 2);
        } finally {
            Directory.DeleteTree(dir);
        }
    }

    /* --- a run made to look another way ------------------------------------
     *
     * `--form`, `--theme`, `--text-scale` and `--rtl` are options of the run,
     * so the child is a real windowed project run under each, printing what it
     * sees -- which form opened, whether its ink says dark, how wide a sentence
     * comes out, which way a box lays out -- and quitting. The display is this
     * suite's own virtual one, which the child inherits.
     */
    testLook() {
        const dir = File.Join(Environment.TempDirectory,
                              `bta-smoke-look-${Environment.ProcessId}`);
        Directory.Make(dir);
        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "smoke-look", startup: "First",
                                   singleInstance: true, id: "org.bintana.SmokeLook",
                                   sources: ["Look.js"] }));
        File.Save(File.Join(dir, "Look.js"),
            "class First extends Form { Form_Open() { print('opened First'); Application.Quit(); } }\n" +
            "class Second extends Form {\n" +
            "  Form_Open() {\n" +
            "    this.Arrangement = 'Horizontal'; this.Resize(300, 60);\n" +
            "    this.A = new Label(); this.A.Text = 'Measure me please'; this.Add(this.A);\n" +
            "    this.B = new Label(); this.B.Text = 'B'; this.Add(this.B);\n" +
            "    Timer.After(300, () => {\n" +
            "      print(`opened Second dark=${this.Dark} wide=${this.A.Bounds().Width}` +\n" +
            "            ` rtl=${this.B.Bounds().X < this.A.Bounds().X}`);\n" +
            "      Application.Quit(); });\n" +
            "  }\n" +
            "}\n");

        const run = (...opts) => {
            const res = Exec.Wait([Application.Executable, ...opts, dir], { Timeout: 15000 });
            const m = /opened (\w+)(?: dark=(\w+) wide=(\d+) rtl=(\w+))?/.exec(res.Output);
            return m ? { form: m[1], dark: m[2], wide: Number(m[3]), rtl: m[4], code: res.ExitCode }
                     : { form: "", code: res.ExitCode, out: res.Output };
        };

        try {
            eq("with no option the startup form opens", run().form, "First");

            const plain = run("--form", "Second");
            eq("--form opens the one it names, single-instance or not", plain.form, "Second");
            eq("...in the desktop's own variant here", plain.dark, "false");
            eq("...laid out left to right", plain.rtl, "false");

            eq("--theme dark is the dark variant, as the ink says",
               run("--form", "Second", "--theme", "dark").dark, "true");

            const big = run("--form", "Second", "--text-scale", "2");
            check("--text-scale 2 makes a sentence about twice as wide",
                  big.wide > plain.wide * 1.8 && big.wide < plain.wide * 2.2,
                  `${plain.wide} then ${big.wide}`);

            eq("--rtl lays a box out the other way",
               run("--form", "Second", "--rtl").rtl, "true");

            eq("a theme that is not dark or light is refused",
               run("--theme", "blue").code, 2);
            eq("and a scale out of reason", run("--text-scale", "9").code, 2);
            eq("and a form with no name", run("--form").code, 2);
        } finally {
            Directory.DeleteTree(dir);
        }
    }

    /* --- a console program's exit status --------------------------------- */
    /*
     * **A traceback used to leave the status at 0**, and 0 is what a runner, a
     * build step and CI read as *it worked*: the error of a `Timer` callback
     * stopped at "Bintana error:", one line above an exit a script took for
     * success. The children are real console projects -- the thing being
     * asserted is another process's status, which no assertion inside this one
     * could see.
     */
    testConsoleExit() {
        const dir = File.Join(Environment.TempDirectory,
                              `bta-smoke-exit-${Environment.ProcessId}`);

        Directory.Make(dir);
        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "smoke-exit", main: "Main", version: "1.0",
                                   sources: ["Main.js"] }));

        try {
            const cases = [
                ["an error nobody caught fails the run",
                 "function Main(){ Timer.After(10, () => nope()); }", 1],
                ["Application.Quit outranks it",
                 "function Main(){ Timer.After(10, () => nope());" +
                 "               Timer.After(40, () => Application.Quit(7)); }", 7],
                ["and a program with nothing to report ends 0",
                 "function Main(){ print(\"ok\"); }", 0],
            ];

            for (const [name, body, want] of cases) {
                File.Save(File.Join(dir, "Main.js"), body);

                const res = Exec.Wait([Application.Executable, dir],
                                      { Timeout: 10000 });
                eq(name, res.ExitCode, want);
            }
        } finally {
            Directory.DeleteTree(dir);
        }
    }
}
