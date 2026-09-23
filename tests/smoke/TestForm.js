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
              libs.includes("charts") && libs.includes("report"),
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
}
