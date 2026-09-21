  /*
 * Covers everything added for the IDE: elastic containers, Arrangement, the
 * the two editors, and the File/Dir/Exec surface.
 *
 * Exec is asynchronous, so the run finishes from its exit callback rather
 * than at the end of Form_Open.
 */
"use strict";

/* Tagged with what the runner passed -- its pid -- so two suites at once do not
 * share a scratch directory.  See tests/run.sh. */
const SCRATCH = `/tmp/bta-test-widgets${Application.Arguments[0] ? `-${Application.Arguments[0]}` : ""}`;

/* The pictures this project ships, for the tests that need a real file: a
 * `Picture`, an `Image`, and a drawing that puts one down. */
const IMAGES = File.Join(Application.Directory, "images");

let passed = 0;
const failures = [];

/* What ran, and whether that was all of it: a partial run must never read like a
 * whole one. */
const ran = [];
let partial = false;
/* `list` answers a question rather than running anything, so it reports nothing. */
let listed = false;

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function throws(name, fn) {
    try {
        fn();
        failures.push(`${name}: expected a throw, none happened`);
    } catch (e) {
        passed++;
    }
}

/*
 * A locale off this machine that actually collates, for testLocaleOrder.
 *
 * `C` and `C.UTF-8` order by byte, which is the case being contrasted against,
 * so they are exactly what this must not return.  `en_US` first when it is
 * there, so a failure reads the same on two machines; otherwise whatever the
 * machine has, since every real glibc collation agrees about the two things the
 * test asserts.
 */
function utf8Locale() {
    let listed = "";
    try {
        listed = Exec.Wait(["locale", "-a"], { Timeout: 20000 }).Output;
    } catch (e) {
        return "";
    }

    const names = listed.split("\n").map((s) => s.trim()).filter(
        (s) => (s.endsWith(".utf8") || s.endsWith(".UTF-8")) &&
               s !== "C" && !s.startsWith("C.") && !s.startsWith("POSIX"));

    return names.find((s) => s.startsWith("en_US")) || names[0] || "";
}

/*
 * Waits for something to be true instead of counting frames.  A layout lands
 * on a frame of GTK's choosing and a machine under a sanitizer takes more of
 * them, which is exactly what makes a test that counts them flaky.
 *
 * **What waits is counted, and the report waits for it.** Otherwise a condition
 * that never comes true is not a failure but a *silence*: the run finishes and
 * reports while this is still counting down, its assertions never run, and the
 * total is a few lower than it was yesterday with nothing red to say why. A
 * whole block of `testWindowState` sat unrun behind exactly that -- and the only
 * reason it was ever noticed is that the sanitizer is slow enough for the
 * timeout to land first, which turned a silent absence into four red lines.
 */
let waiting = 0;

function until(name, cond, then, tries = 200) {
    waiting++;

    /* One place counts and one place stops counting: the walk is the inner
     * function, so re-entering `until` cannot lose track of an outstanding
     * one -- which is the mistake this made the first time, with the recursion
     * carrying the count. */
    const step = (left) => {
        if (cond()) { waiting--; then(); return; }
        if (left <= 0) {
            failures.push(`${name}: never became true`);
            waiting--;
            then();
            return;
        }
        Timer.After(10, () => step(left - 1));
    };
    step(tries);
}

/*
 * And the same wait where giving up is an *answer* rather than a failure:
 * `then(true)` when it happened and `then(false)` when it did not.
 *
 * For the one question in this file that turns on a library's version rather
 * than on this runtime. Counted exactly as `until` is, and for the same
 * reason: a wait nobody counts lets `finish()` report while its assertions
 * have not run, which is a smaller total and not a red line.
 */
function waitsFor(cond, then, tries = 50) {
    waiting++;

    const step = (left) => {
        if (cond()) { waiting--; then(true); return; }
        if (left <= 0) { waiting--; then(false); return; }
        Timer.After(20, () => step(left - 1));
    };
    step(tries);
}

/* No .form of its own: the test generates one and instantiates it, to prove that
 * serialising and loading back gives the same tree. */
class RoundTrip extends Form {}

/* A form with no .form at all: what a menu-less form has to answer. */
class RoundTrip2 extends Form {}

/* A window of its own for the anchor test, because WidgetsForm is arranged
 * Vertical and what is under test is a fixed surface being resized. */
class AnchorForm extends Form {}

/* And one more for a window asked to be smaller than what is in it. */
class ShrinkForm extends Form {}

/*
 * A window that writes down every size it is told it has.
 *
 * The handler is **on the window** and not on the test form, which is where the
 * runtime looks: a form's own events dispatch as `Form_<Event>` on itself,
 * whatever the class is called and whatever `Name` says. `Name = "Sized"` plus a
 * `Sized_Resize` over here is what this test used to do, and nothing was ever
 * dispatched to it -- so the block that reads `seen` waited two seconds and the
 * run reported before its failure landed. Under the sanitizer, which is slower,
 * it went red and said so.
 */
class SizedForm extends Form {
    seen = [];
    Form_Resize(w, h) { this.seen.push([w, h]); }
}

/*
 * A window that refuses to close the first time it is asked.  `Form_Close`
 * returning true is the veto -- the same convention `KeyPress` uses for a key
 * it consumed -- and the count is how the test tells "it was asked" from "it
 * closed anyway".
 */
class VetoForm extends Form {
    Form_Close() {
        this.asked = (this.asked || 0) + 1;
        return this.asked < 2;
    }
}

/* A form whose .form declares a TableView, so the loader's translation of a
 * named member is exercised the way a real project meets it. */
class TableForm extends Form {}

/* And another for the case where the *contents* outgrow the declared size,
 * which needs the form's own surface rather than a panel on it: a window's
 * declared size is the design, and a panel's inside a box is a floor. */
class PushedForm extends Form {}

/* A form with a `.form` behind it, for testAnchorsNarrow: what makes that test
 * mean anything is that its coordinates came out of a file rather than out of
 * the `Resize` the test does to it. */
class NarrowForm extends Form {}

/* --- records ------------------------------------------------------------
 * A shape with one of every kind, and one field whose name in the file is not
 * its name here. */
class Customer extends Record {
    static Fields = {
        Id:       Field.Int(),
        Name:     Field.Text({ required: true, max: 8 }),
        Email:    Field.Text({ as: "email_address" }),
        Balance:  Field.Number({ decimals: 2, min: 0 }),
        Category: Field.Enum(["Retail", "Wholesale"]),
        Active:   Field.Bool(true),
        Since:    Field.Date(),
        Tags:     Field.List(Field.Text({ max: 4 }), { max: 3 }),
    };

    /* A field written by hand is a field: read-only, so it is not written back. */
    get Label() { return `${this.Name} (${this.Id})`; }
}

/* The file spells its keys in lower case; the record says so once. */
class Lowered extends Record {
    static Naming = "lower";
    static Fields = { Name: Field.Text(), Startup: Field.Text() };
}

/* ...and SQL spells them the other way, which is the same rule with another
 * word. */
class Snaked extends Record {
    static Naming = "snake";
    static Fields = { CustomerName: Field.Text(), PostalCode: Field.Text() };
}

/* A subclass adds to its parent's fields instead of hiding them. */
class Vip extends Customer {
    static Fields = { Discount: Field.Number({ decimals: 1 }) };
}

/* Three ways to declare a record wrongly, each of which has to say so when the
 * class is first used rather than when something trips over it. */
class NotAField extends Record {
    static Fields = { Broken: 3 };
}

class Clash extends Record {
    static Fields = { Name: Field.Text() };
    get Name()  { return "by hand"; }
    set Name(v) { /* ...and also declared above */ }
}

/* A record with decimal fields, for testFieldDecimal. */
class Priced extends Record {
    static Fields = {
        Name:   Field.Text({ required: true }),
        Price:  Field.Decimal({ decimals: 2, min: "0" }),
        Weight: Field.Decimal({ decimals: 3 }),
    };
}

class BadNaming extends Record {
    static Naming = "shouting";
    static Fields = { Name: Field.Text() };
}

/* A field that starts at a value it would not accept: valid to write, invalid
 * before anybody touches it. */
class BadDefault extends Record {
    static Fields = { Count: Field.Int({ min: 1 }) };
}

/* --- records inside records ---------------------------------------------
 * A child, a master with a list of them, and a shape that contains itself --
 * which is master-detail, and which is also what a menu and a `.form` are. */
class Address extends Record {
    static Fields = {
        Street: Field.Text({ required: true, max: 40 }),
        City:   Field.Text({ max: 20 }),
    };
}

/* `Priced` is the detail shape, declared above for testFieldDecimal: one shape,
 * two sources, which is the whole argument for keeping the two apart. */
class Invoice extends Record {
    static Naming = "lower";
    static Fields = {
        Customer: Field.Text({ required: true }),
        Lines:    Field.List(Priced, { max: 3 }),
        Ship:     Field.Record(Address),
        Bill:     Field.Record(Address, { def: { City: "CABA" } }),
    };
}

/*
 * The thunk, and the reason it cannot be avoided: inside a class body the class
 * is not bound yet, so `Field.List(Node)` written here is a ReferenceError.
 * `() => Node` is resolved the first time the field is used, which is always
 * after the declaration finished.
 */
class Node extends Record {
    static Fields = {
        Text:     Field.Text({ required: true }),
        Children: Field.List(() => Node),
    };
}

/* --- a shape over a table ------------------------------------------------
 * `snake` is the SQL spelling, and this is its first user in the tree: the rule
 * was written for this and had none until now. */
class Client extends Record {
    static Naming = "snake";
    static Fields = {
        Id:         Field.Int({ key: true }),
        Name:       Field.Text({ required: true, max: 80 }),
        Balance:    Field.Decimal({ decimals: 2 }),
        Active:     Field.Bool(true),
        Since:      Field.Date(),
        PostalCode: Field.Text({ max: 8 }),
    };
}

/* A key the program chooses rather than one the engine generates. */
class Coded extends Record {
    static Naming = "lower";
    static Fields = { Code: Field.Text({ key: true }), What: Field.Text() };
}

/* Three shapes that do not fit that table, each in its own way. */
class NoKeyed extends Record {
    static Naming = "snake";
    static Fields = { Name: Field.Text() };
}
class MisCased extends Record {
    static Fields = { Code: Field.Text({ key: true }), What: Field.Text() };
}
class MissingColumn extends Record {
    static Naming = "lower";
    static Fields = { Code: Field.Text({ key: true }), Nadie: Field.Text() };
}
class Detailed extends Record {
    static Naming = "snake";
    static Fields = { Id: Field.Int({ key: true }), Lines: Field.List(Coded) };
}

/* Three more ways to declare one wrongly. A `Fields` getter is the tempting way
 * to write a recursive shape -- it defers the class body's own name until it is
 * bound -- and it used to declare **nothing, in silence**. */
class GetterFields extends Record {
    static get Fields() { return { Name: Field.Text() }; }
}

class BadSeed extends Record {
    static Fields = { A: Field.Record(Address, { def: { Street: 5 } }) };
}

class BadThunk extends Record {
    static Fields = { A: Field.List(() => 3) };
}

/*
 * The tests, in the order they run in, and what `./tests/run.sh widgets <name>`
 * matches -- `run.sh widgets record` is 20-odd assertions in a third of a second
 * against 800 in twenty.
 *
 * A filter here *selects*, where tests/ide's has to run a prefix: these are
 * independent, because each one builds the controls it needs and deletes them
 * again. Two exceptions, and they are why this is a list and not a loop over the
 * methods:
 *
 *   Serializer  has to see the form exactly as the .form left it, since the rest
 *               dirty it -- so it is first, and stays first
 *   Exec        the asynchronous tail: it reports and quits, and what it checks
 *               includes what Terminal and Timer left behind, so asking for it
 *               brings those along (see NEEDS)
 */
const TESTS = [
    "Serializer",
    /* Beside it: what it asserts is that the serialiser can reach the bottom of
     * a tree at all, which is a property of the build and not of a widget. */
    "DeepSerialize",
    /*
     * Second, and not near the other Exec: it is the one test that **holds the
     * main loop**, since every `Exec.Wait` blocks for as long as its child runs.
     * Anything already waiting on a deadline -- `until`'s two-second failure
     * timer, most of all -- would have that time taken out of its budget by a
     * test that ran later, and the failures would land somewhere else entirely.
     * Here nothing else has armed anything yet.
     */
    "ExecWait",
    /* Blocking too, and for the same reason: it holds the loop while a local
     * server answers, so it runs before anything has armed a deadline. */
    "HttpWait",
    /* Also blocking: it starts a child of its own to pin the exact strings. */
    "LocaleFormat",
    /* Blocking too, and for the same reason: the order is pinned from children
     * started in a locale of our choosing. */
    "LocaleOrder",
    /* Blocking too: two children, to see that Today follows the time zone. */
    "Day",
    /* Blocking as well -- `desktop-file-validate` and `gio launch` are children
     * awaited to the end -- so it joins the group that runs before anything has
     * armed a deadline (see the note above ExecWait). Its last assertions are a
     * launch landing on a later turn, which `until` counts. */
    "Desktop",
    "Time",
    "Stopwatch",
    "Shortcut", "Decimal", "FieldDecimal",
    /* Early on purpose: they show windows of their own, and the pushed-surface
     * assertions in the async tail measure a form on the frame it settles. See
     * the note below. */
    "DefaultButton", "ActivatesDefault", "TabOrder", "Completion", "EventNames", "WindowState", "FormMargin", "HideOnClose", "PointerEvents", "On", "Field", "Separator", "TableView", "TableTree", "TableOnDemand", "TableSort", "TableIcon", "TableProse",
    "Arrangement", "Orientation", "Boxes", "Stacking", "Splits",
    "Expand", "Spacing", "Scrolling", "FillScroll", "FileInfo", "FileWatch", "Picture", "Media", "SmallOnes", "Scrollbars", "Expander", "SourceEditor", "TextEditor", "EditorScroll", "EditorMarks", "Search", "Tree", "TreeIcons", "TreeExpand",
    "CloseVeto",
    "ContextMenu", "Combo", "Spin", "Focus", "Cursor", "Theme", "Record", "Nested", "Database", "Action", "Groups",
    "Toggle", "Switch", "Progress", "Slider", "Date", "Calendar", "Drawing", "Metrics", "Library", "Plugin", "ListMulti", "MenuState",
    "RowList", "RowFilter", "PropertyOptions", "CssNode", "TabAction", "Image", "Switcher", "Reorder", "Aspect",
    "Removal", "NumericSetters",
    "Caption", "LabelWrap", "LabelEllipsize", "ChildRefs", "DragDrop", "Errors", "Component", "Namespace",
    "CuratedLanguage", "Dictionary", "Regex", "Bytes", "Hash", "Screen", "JsonFiles", "Log", "Apply", "TimerShorthand", "Terminal",
    "Settings", "Timer", "Icons", "Font", "Style", "Radius", "Padding", "Shadow", "StyleRule",
    "ColorButton",
    "ColorDialog", "FileDialog", "IconList", "FormIcon", "ButtonClick",
    "Available", "TextProperties", "Locale", "LocaleRead", "TranslatedForm", "Fill", "DesignValues",
    "Grid",
    "File", "Dir", "Trash", "Environment",
    /* Async too: its answers land on later turns of the loop, like Exec's,
     * and a run filtered to it alone would report before they arrive. */
    "Task", "Lock",
    /* Async, and last but one: its callbacks land on later turns of the loop,
     * like Exec's, and it stops its own server before the run ends. */
    "Http",    /* Async as well, and it dribbles on purpose: its server writes a line
     * every fifth of a second, so the run has to still be going a second
     * later. */
    "HttpStream",
    /* Async too, and answered on this same loop: it dogfoods the client, so
     * both must be going when either is. A Wait would freeze the loop the
     * server answers on -- that dogfood is async or it is a deadlock. */
    "HttpServer",
    /* Async, and last: it reports and quits. */
    "Exec",
];

/*
 * What a test cannot run without, and it runs both ways: the asynchronous tail
 * checks what `Terminal` and `TimerShorthand` left behind -- `Terminal.Text` is
 * only readable a beat after being fed, and a timer has to have fired -- so
 * asking for the tail brings those, and
 * asking for either of those brings the tail that finishes them. Otherwise
 * `run.sh widgets terminal` would answer with half of the terminal's assertions
 * and look complete.
 */
const NEEDS = {
    Exec:           ["Terminal", "TimerShorthand"],
    /* Its assertions land once GTK has bound some rows, which is a frame away. */
    TableOnDemand:  ["Exec"],
    /* Its zoom assertions measure an allocation, which is a frame away. */
    Picture:        ["Exec"],
    /* Its clips play on later turns of the loop, so the run has to still be
     * going when EOS and the error arrive. */
    Media:          ["Exec"],
    /* Its two measurements are a window being laid out, twice. */
    Scrollbars:     ["Exec"],
    /* Every claim it makes is an allocation, which is a frame away. */
    FillScroll:     ["Exec"],
    /* Its last block measures a child shown and then hidden, a frame each. */
    DragDrop:       ["Exec"],
    /* Its second window has to be shown, closed and shown again. */
    HideOnClose:    ["Exec"],
    /* Its events arrive from the filesystem, which is not this turn of the
     * loop: the run has to still be going when they do. */
    FileWatch:      ["Exec"],
    /* Its last assertion measures an allocation, which is a frame away too. */
    Separator:      ["Exec"],
    /* Its Resize assertions arrive once the window is up, which is not now. */
    WindowState:    ["Exec"],
    /* Its focus walk waits for the window to be mapped -- Form_Open runs before
     * it is presented -- so the run has to still be going when it lands. */
    TabOrder:       ["Exec"],
    /* Its layout assertions land a frame later, so the run has to still be
     * going when they do -- otherwise `run.sh widgets grid` answers with the
     * five that are synchronous and looks complete. */
    Grid:           ["Exec"],
    /* What proves a row is filtered out is that GTK gave it no room, which is a
     * frame away -- twice over, since it also has to come back. */
    RowFilter:      ["Exec"],
    Terminal:       ["Exec"],
    TimerShorthand: ["Exec"],
    /* Its callbacks land on later turns of the loop, so the run has to still
     * be going when they do -- otherwise `run.sh widgets http` answers with
     * the synchronous half and looks complete. */
    Http:           ["Exec"],
    /* Same bargain as Http: answers arrive later, so asking for it alone
     * brings the tail that finishes the run. */
    Task:           ["Exec"],
    HttpStream:     ["Exec"],
    HttpServer:     ["Exec"],
    /* Its round trip happens once the window is up, which is not now: Form_Open
     * runs before the window is presented and a completion asked for off screen
     * is asked of nothing. */
    Completion:     ["Exec"],
};

/*
 * Which of them this run is about.  A name that matches nothing is a mistake and
 * not an empty pass, and `list` says what there is.
 */
function chosenTests() {
    const only = (Application.Arguments[1] || "").trim();
    if (!only) return TESTS;

    if (only === "list") {
        for (const name of TESTS) print(`  ${name}`);
        listed = true;                    /* nothing to report: it was a question */
        Application.Quit(0);
        return [];
    }

    const wanted = TESTS.filter((n) => n.toLowerCase().includes(only.toLowerCase()));
    if (!wanted.length) {
        failures.push(`no test matches "${only}" -- try one of: ${TESTS.join(", ")}`);
        return [];
    }

    /* To a fixed point, since what a test needs may need something itself. */
    const need = new Set(wanted);
    for (let grew = true; grew; ) {
        grew = false;
        for (const n of [...need]) {
            for (const also of NEEDS[n] || []) {
                if (!need.has(also)) { need.add(also); grew = true; }
            }
        }
    }

    /* In the list's order, whatever order they were asked for in. */
    return TESTS.filter((n) => need.has(n));
}

class WidgetsForm extends Form {

    /* The component's event, dispatched by name like any control's. */
    Step1_Change(value) { this.stepSaid = value; }
    Gad1_Change(value)  { this.gadSaid  = value; }

    Ed_Change()  { this.edChanges++; }
    B1_Click()   { this.b1Clicks++; }

    Form_Open() {
        this.edChanges = 0;
        this.b1Clicks  = 0;

        /* Without this, an unexpected throw would abort Form_Open before the
         * Quit and the run would hang until the timeout instead of failing. */
        try {
            const chosen = chosenTests();
            partial = chosen.length !== TESTS.length;

            for (const name of chosen) {
                ran.push(name);
                this[`test${name}`]();
            }

            /* `Exec` ends the run from its own callback.  With it filtered out
             * nothing else would: a run that reported nothing and waited for the
             * timeout reads exactly like a test that froze. */
            if (!chosen.includes("Exec") && !listed) this.finish();
        } catch (e) {
            failures.push(`uncaught: ${e.message}\n${e.stack || ""}`);
            this.finish();
        }
    }

    /* --- serializer ----------------------------------------------------- */
    testSerializer() {
        /* A subtree built by hand: the exact shape has to be predictable. */
        const panel = new Panel();
        panel.Name = "P1";

        const btn = new Button();
        btn.Name = "B1";
        btn.Text = "ok";
        panel.Add(btn);
        btn.Move(5, 6);
        btn.Resize(70, 20);

        const node = panel.Serialize();
        eq("node carries the type", node.type, "Panel");
        eq("node carries the name", node.name, "P1");
        eq("untouched properties are omitted", JSON.stringify(node.properties), "{}");
        eq("children are nested", node.children.length, 1);
        eq("child type", node.children[0].type, "Button");
        eq("child name", node.children[0].name, "B1");
        eq("only what was set, in a stable order",
           JSON.stringify(node.children[0].properties),
           JSON.stringify({ Height: 20, Text: "ok", Width: 70, X: 5, Y: 6 }));

        /* Read-only properties can never be assigned back, so they must not be
         * written: ListBox.Count and Editor.Line would both break a load. */
        const lb = new ListBox();
        lb.Items = ["a", "b"];
        const lbNode = lb.Serialize();
        check("arrays round-trip", sameJson(lbNode.properties.Items, ["a", "b"]),
              JSON.stringify(lbNode.properties));
        check("read-only properties are skipped", !("Count" in lbNode.properties),
              JSON.stringify(lbNode.properties));
        check("Caption is not written next to Text", !("Caption" in lbNode.properties));

        /* The real test: serialise, load, and serialise again. */
        const original = this.Serialize();
        eq("format tag", original.format, "bintana-form/1");
        eq("keyed by class, not type", original.class, "WidgetsForm");
        check("Arrangement comes before the rest",
              Dictionary.Keys(original.properties)[0] === "Arrangement",
              JSON.stringify(Dictionary.Keys(original.properties)));

        const path = File.Join(Application.Directory, "RoundTrip.form");
        this.SaveForm(path);

        let reloaded;
        try {
            reloaded = new RoundTrip().Serialize();
        } finally {
            File.Delete(path);
        }

        eq("round-trip preserves the form's properties",
           JSON.stringify(reloaded.properties), JSON.stringify(original.properties));
        eq("round-trip preserves the whole child tree",
           JSON.stringify(reloaded.children), JSON.stringify(original.children));

        /* Menus are the one part of a form that cannot be read back from GTK: a
         * GMenu has no nesting left, its separators are section boundaries and
         * its items are actions.  So the spec is kept as it was loaded -- and if
         * it were not, saving a form would quietly drop its menu bar. */
        check("menus are serialised next to the children",
              Array.isArray(original.menus) && original.menus.length === 1,
              JSON.stringify(original.menus));
        eq("with the whole tree: items, separators, dynamic, check and radio",
           JSON.stringify(original.menus[0].children.length), "6");
        eq("round-trip preserves the menus",
           JSON.stringify(reloaded.menus), JSON.stringify(original.menus));
        /* Commands before menus before children, which is the order the loader
         * reads them in: an item and a control may both name a command, so a
         * file whose blocks were the other way round is a file that cannot be
         * loaded. The serialiser writing them in that order is what keeps a
         * saved form loadable. */
        check("and the file puts the blocks in the order the loader needs",
              Dictionary.Keys(original).join(",") ===
                  "format,class,properties,actions,menus,children",
              Dictionary.Keys(original).join(","));

        eq("Menus reads the spec back", this.Menus.length, 1);
        eq("a form without menus reads an empty list", new RoundTrip2().Menus.length, 0);
        check("Menus is not a property: read-only, so it never lands in properties",
              !this.PropertyNames().includes("Menus") && !("Menus" in original.properties));

        /* The items themselves are live objects on the form, by name. */
        eq("each item is exposed by name", this.MnuOne.Name, "MnuOne");
        eq("a dynamic item takes its entries", (this.MnuMany.Items = ["a", "b"]).length, 2);
    }

    /* --- Arrangement ---------------------------------------------------- */
    testArrangement() {
        eq("form arrangement from .form", this.Arrangement, "Vertical");
        eq("Panel defaults to Fixed", this.Fixed1.Arrangement, "Fixed");
        eq("Frame defaults to Fixed", this.Group1.Arrangement, "Fixed");
        /* A container that is its own slot has no arrangement to report: what
         * it does with its children is its nature, and a Box says which way
         * with Orientation.  Reporting it twice would serialise a second,
         * unsettable spelling of the same fact into the .form. */
        eq("a container arranged as a row says so", this.Bar.Arrangement, "Horizontal");

        eq("child of a Fixed keeps its X", this.Inner1.X, 7);
        eq("child of a Fixed keeps its Y", this.Inner1.Y, 9);

        throws("arrangement must be a known value",
               () => { const p = new Panel(); p.Arrangement = "Diagonal"; });

        const p = new Panel();
        p.Arrangement = "Horizontal";
        eq("empty container can be re-arranged", p.Arrangement, "Horizontal");
    }

    /* --- boxes ---------------------------------------------------------- */
    /* --- one box, one split, and a property that says which way -------------
     *
     * There used to be four classes where there are two.  What the extra pair
     * bought was nothing the value could not say, and what it cost was this:
     * turning a row into a column meant deleting it and building the other one,
     * children and all.
     */
    testOrientation() {
        const p = new Panel();
        eq("a container starts on coordinates", p.Arrangement, "Fixed");
        check("and offers the three words it takes",
              sameJson(p.PropertyOptions("Arrangement"),
                       ["Fixed", "Horizontal", "Vertical"]),
              JSON.stringify(p.PropertyOptions("Arrangement")));

        /* The point of the whole exercise: a container that already holds
         * something can be turned into a row and back.  It used to refuse --
         * "set Arrangement before adding children" -- which left the property
         * useless for the one thing anybody wants it for. */
        const a = new Label(), b = new Label();
        a.Name = "OrA"; b.Name = "OrB";
        a.Move(11, 22);
        p.Add(a);
        p.Add(b);

        p.Arrangement = "Horizontal";
        eq("a container that holds something can still be re-arranged",
           p.Arrangement, "Horizontal");
        eq("keeping its children", p.Children.length, 2);
        eq("in the order they were in", p.Children[0].Name, "OrA");

        p.Arrangement = "Fixed";
        eq("and back again", p.Arrangement, "Fixed");
        eq("with the coordinates it had", p.Children[0].X, 11);
        eq("in both axes",                p.Children[0].Y, 22);

        /* Spacing and Homogeneous belong to the box a container is arranged
         * as, not to a class of its own. */
        p.Arrangement = "Vertical";
        p.Spacing = 6;
        eq("Spacing applies to whatever it is arranged as", p.Spacing, 6);

        /*
         * **A column turned into a row is the same box.** `Arrangement` swaps the
         * layout manager, and going from one box to another only turns the one
         * that is there -- so `Spacing` and `Homogeneous` survive it. The version
         * that replaced the whole slot built a fresh box and dropped both without
         * saying anything.
         */
        p.Homogeneous = true;
        p.Arrangement = "Horizontal";
        eq("turning a column into a row keeps its spacing", p.Spacing, 6);
        eq("and whether it is homogeneous", p.Homogeneous, true);
        p.Homogeneous = false;

        p.Arrangement = "Fixed";
        eq("and reads as nothing when it is not a box", p.Spacing, 0);

        /*
         * Anchoring is the container's answer and it lives in the layout, which
         * a box has no room for -- so it has to be carried across a round trip
         * rather than read back from where it was.
         */
        p.Anchored = false;
        p.Arrangement = "Horizontal";
        p.Arrangement = "Fixed";
        eq("and anchoring survives the round trip", p.Anchored, false);
        p.Anchored = true;

        /* Twice in a row, which is what a designer does to one panel in an
         * afternoon: it is the same widget every time, so there is no state to
         * run out of. */
        for (const want of ["Horizontal", "Vertical", "Fixed", "Vertical"]) {
            p.Arrangement = want;
            eq(`re-arranging again lands on ${want}`, p.Arrangement, want);
            eq("with both children still there", p.Children.length, 2);
        }
        p.Arrangement = "Fixed";

        /* A Split is arranged too -- same word -- but has no Fixed to offer. */
        const split = new Split();
        eq("a split starts split across", split.Arrangement, "Horizontal");
        check("and says so it takes only two",
              sameJson(split.PropertyOptions("Arrangement"),
                       ["Horizontal", "Vertical"]),
              JSON.stringify(split.PropertyOptions("Arrangement")));

        split.Arrangement = "Vertical";
        eq("it turns round", split.Arrangement, "Vertical");
        throws("and refuses the one it cannot be",
               () => { split.Arrangement = "Fixed"; });

        /* A container whose slot is its own widget has no arrangement to
         * report, and saying one would put an unsettable value in the .form. */
        eq("a Notebook reports none", new Notebook().Arrangement, "");
    }

    testBoxes() {
        eq("Spacing from .form", this.Bar.Spacing, 8);
        this.Bar.Spacing = 3;
        eq("Spacing round-trip", this.Bar.Spacing, 3);

        this.Bar.Homogeneous = true;
        eq("Homogeneous round-trip", this.Bar.Homogeneous, true);
        this.Bar.Homogeneous = false;

        const box = new Panel();
        box.Arrangement = "Vertical";
        box.Add(new Button());
        box.Add(new Button());
        check("a box takes many children", true);
    }

    /* --- stacking and removal ------------------------------------------- */
    testStacking() {
        /* In a Fixed, list order is paint order; restacking must not disturb
         * anyone's coordinates. */
        const box = new Panel();
        const a = new Button(), b = new Button(), c = new Button();
        a.Name = "A"; b.Name = "B"; c.Name = "C";
        for (const w of [a, b, c]) box.Add(w);
        a.Move(1, 2); b.Move(3, 4); c.Move(5, 6);

        const order = () => box.Children.map((w) => w.Name).join("");
        eq("children come back in order", order(), "ABC");

        a.Raise();
        eq("Raise moves it last, so it paints on top", order(), "BCA");
        eq("restacking keeps X", a.X, 1);
        eq("restacking keeps Y", a.Y, 2);
        eq("and leaves the others where they were", b.X, 3);

        a.Lower();
        eq("Lower moves it first, to the back", order(), "ABC");

        c.Lower();
        eq("Lower from the top of the stack", order(), "CAB");
        eq("still at its own coordinates", c.X, 5);

        c.Delete();
        eq("Delete drops it from the tree", order(), "AB");
        eq("a deleted widget has no parent", c.Serialize().type, "Button");

        box.Clear();
        eq("Clear empties the container", box.Children.length, 0);
    }

    /* --- splits --------------------------------------------------------- */
    /*
     * Every container loses a child, and gives it back.
     *
     * Three defects lived here together and only the first was ever reported.
     * A `Grid` had no branch in `bta_container_detach`, so it could be filled
     * once and never rebuilt -- found by a calendar written against docs/llm/,
     * whose month view is the shape that rebuilds one. Fixing `Clear()`'s walk
     * (which used to unparent a paned's own handle) then uncovered that a
     * `Split` and an `Overlay` were being *unparented* rather than cleared
     * through the property that held them, so GTK went on believing they were
     * full: the split refused the next `Add` and the overlay tripped an
     * assertion. What ties the three together is the round trip -- fill, empty,
     * fill again -- which nothing had asked any container to do.
     */
    testRemoval() {
        for (const type of ["Panel", "Frame", "Expander", "Scroller", "Flow",
                            "RowList", "Notebook", "Switcher", "Grid", "Overlay"]) {
            const c = Widget.New(type);
            const a = new Label(), b = new Label();

            a.Text = "a"; b.Text = "b";
            c.Add(a); c.Add(b);
            eq(`${type} took two`, c.Children.length, 2);

            a.Delete();
            eq(`${type} lost one to Delete`, c.Children.length, 1);
            eq(`${type} kept the other`, c.Children[0].Text, "b");

            c.Clear();
            eq(`${type} is empty after Clear`, c.Children.length, 0);

            /* Refilled, which is the half that was broken: an empty container
             * that will not take a child again is not empty. */
            c.Add(new Label());
            eq(`${type} refills after Clear`, c.Children.length, 1);
        }

        /* A Split holds two and says so -- and still says so after a round trip,
         * which is what the unparent left it unable to do. */
        const sp = new Split();
        sp.Add(new Panel()); sp.Add(new Panel());
        sp.Clear();
        eq("a cleared split is empty", sp.Children.length, 0);
        sp.Add(new Panel()); sp.Add(new Panel());
        eq("and takes two again", sp.Children.length, 2);
        throws("a split still holds exactly two", () => sp.Add(new Panel()));

        /* Remove() detaches without destroying, so the widget is usable after. */
        const g = new Grid();
        const keep = new Label();
        g.Add(keep);
        g.Add(new Label());
        keep.Remove();
        eq("Remove took it out", g.Children.length, 1);
        keep.Text = "still a widget";
        eq("Remove did not destroy it", keep.Text, "still a widget");

        /* A grid re-flows what stayed, so a hole closes up rather than persists:
         * this is what makes rebuilding one mean anything. */
        const gr = new Grid();
        gr.Columns = 3;
        const cells = [];
        for (let i = 0; i < 6; i++) {
            const l = new Label();
            l.Text = String(i);
            gr.Add(l);
            cells.push(l);
        }
        cells[0].Delete();
        eq("the survivors keep their order", gr.Children.map((c) => c.Text).join(""), "12345");

        /* The calendar's own shape: rebuilt on every render, three times over. */
        for (let round = 0; round < 3; round++) {
            gr.Clear();
            for (let i = 0; i < 37; i++) {
                const l = new Label();
                l.Text = String(i);
                gr.Add(l);
            }
        }
        eq("a grid rebuilt three times", gr.Children.length, 37);

        /* A ListBox's rows are text and have no wrapper of ours, and they are
         * still its contents: the two-pass walk has to keep taking them. */
        const lb = new ListBox();
        lb.Items = ["a", "b", "c"];
        lb.Clear();
        eq("a list box clears its text rows", lb.Count, 0);
        lb.Add("again");
        eq("...and takes more", lb.Count, 1);
    }

    /*
     * A numeric property refuses what has no numeric reading.
     *
     * `JS_ToInt32` answers 0 for a string that is not a number and does not
     * fail, so every numeric setter used to take whatever it was handed:
     * `Margin = "0 0 0 12"` -- Padding's spelling, in a delivered application --
     * was a silent zero and the gap simply never appeared. `bta_to_number` is
     * the one place that now says so, which is why this test walks the family
     * rather than the one property that was reported.
     */
    testNumericSetters() {
        const l = new Label();

        throws("Margin refuses Padding's spelling", () => { l.Margin = "0 0 0 12"; });
        eq("and the value it had stands", l.Margin, 0);

        l.Margin = 8;
        eq("Margin takes a number", l.Margin, 8);
        l.Margin = "12";
        eq("Margin takes a numeric string", l.Margin, 12);
        l.Margin = "";
        eq("nothing asked for is zero", l.Margin, 0);

        /* The message names the property and shows the value, as every refusal
         * in this runtime does. */
        try {
            l.Width = "wide";
            check("Width refused a word", false, "it took it");
        } catch (e) {
            check("the message names the property", e.message.includes("Width"), e.message);
            check("the message shows the value", e.message.includes("wide"), e.message);
        }

        throws("X refuses a word",          () => { l.X = "left"; });
        throws("TabIndex refuses a word",   () => { l.TabIndex = "first"; });
        throws("ColumnSpan refuses a word", () => { l.ColumnSpan = "two"; });

        /* These two check a range, and a range check is not a type check: NaN
         * fails both comparisons, so before this they let a word through. */
        throws("FontScale refuses a word", () => { l.FontScale = "big"; });
        eq("FontScale kept its value", l.FontScale, 1);
        throws("Opacity refuses a word", () => { l.Opacity = "faint"; });
        eq("Opacity kept its value", l.Opacity, 1);

        const sb = new SpinBox();
        throws("SpinBox.Value refuses a word", () => { sb.Value = "ten"; });
        throws("SpinBox.Max refuses a word",   () => { sb.Max = "lots"; });
        const sl = new Slider();
        throws("Slider.Value refuses a word", () => { sl.Value = "half"; });
        const pb = new ProgressBar();
        throws("ProgressBar.Value refuses a word", () => { pb.Value = "most"; });
        const im = new Image();
        throws("Image.Size refuses a word", () => { im.Size = "big"; });
        const gr = new Grid();
        throws("Grid.Columns refuses a word",    () => { gr.Columns = "seven"; });
        throws("Grid.RowSpacing refuses a list", () => { gr.RowSpacing = "6 6"; });
        const nb = new Notebook();
        throws("Notebook.Current refuses a word", () => { nb.Current = "first"; });

        /* And the property that does take a list still takes it: the point was
         * to tell the two apart, not to narrow both. */
        l.Padding = "0 0 0 12";
        eq("Padding still takes four sizes", l.Padding, "0 0 0 12");
        l.Radius = "8 8 0 0";
        eq("Radius still takes four", l.Radius, "8 8 0 0");
    }

    testSplits() {
        eq("Position from .form", this.Split.Position, 200);
        this.Split.Position = 150;
        eq("Position round-trip", this.Split.Position, 150);

        const s = new Split();
        s.Add(new Button());
        s.Add(new Button());
        throws("a split holds exactly two", () => s.Add(new Button()));

    }

    /* --- expand / margin ------------------------------------------------ */
    testExpand() {
        eq("HExpand from .form", this.L1.HExpand, true);
        eq("HExpand alone is not Expand", this.L1.Expand, false);

        this.L1.VExpand = true;
        eq("Expand is both axes", this.L1.Expand, true);
        this.L1.VExpand = false;

        this.L1.Expand = true;
        eq("Expand sets HExpand", this.L1.HExpand, true);
        eq("Expand sets VExpand", this.L1.VExpand, true);
        this.L1.Expand = false;

        this.L1.Margin = 11;
        eq("Margin round-trip", this.L1.Margin, 11);
    }

    /* --- SourceEditor --------------------------------------------------- */
    testSourceEditor() {
        eq("Language from .form", this.Ed.Language, "js");
        eq("a fresh editor is empty", this.Ed.Text, "");

        const before = this.edChanges;
        this.Ed.Text = "let a = 1;\nlet b = 2;\nlet c = 3;\n";
        check("assigning Text raises Change", this.edChanges > before);
        eq("Text round-trip", this.Ed.Text, "let a = 1;\nlet b = 2;\nlet c = 3;\n");

        check("assigning Text marks it modified", this.Ed.Modified);
        this.Ed.Modified = false;
        eq("Modified is resettable", this.Ed.Modified, false);

        this.Ed.GotoLine(2);
        eq("GotoLine moves the cursor", this.Ed.Line, 2);
        eq("column is 1-based", this.Ed.Column, 1);

        this.Ed.GotoLine(9999);
        eq("GotoLine clamps past the end", this.Ed.Line, 4);

        this.Ed.Append("// fin\n");
        check("Append adds at the end", this.Ed.Text.endsWith("// fin\n"),
              JSON.stringify(this.Ed.Text.slice(-12)));

        this.Ed.Clear();
        eq("Clear empties", this.Ed.Text, "");

        this.Ed.Language = "json";
        eq("Language round-trip", this.Ed.Language, "json");
        throws("unknown language is rejected", () => { this.Ed.Language = "cobol-2077"; });

        this.Ed.Theme = "Adwaita";
        eq("Theme round-trip", this.Ed.Theme, "Adwaita");
        throws("unknown theme is rejected", () => { this.Ed.Theme = "no-such-scheme"; });

        this.Ed.ShowLineNumbers = false;
        eq("ShowLineNumbers round-trip", this.Ed.ShowLineNumbers, false);
        this.Ed.Wrap = true;
        eq("Wrap round-trip", this.Ed.Wrap, true);
        this.Ed.ReadOnly = true;
        eq("ReadOnly round-trip", this.Ed.ReadOnly, true);

        /* A read-only view must still be writable by the program: that is what
         * makes a console pane possible. */
        this.Ed.Append("consola\n");
        eq("Append works while ReadOnly", this.Ed.Text, "consola\n");
        this.Ed.ReadOnly = false;
        this.Ed.Clear();
    }

    /* --- marks in the gutter ----------------------------------------------
     *
     * What an editor says about a *line*: the syntax error a file was saved
     * with, a result one jumped to, a bookmark.  Asserted through what GTK
     * really holds (`Marks()` walks the buffer's own marks) and not through the
     * call having been made -- a mark is exactly the kind of feature that can
     * read back while nothing was ever drawn.
     */
    /*
     * Where an editor is scrolled to, which it could not say until now.
     *
     * `Line`, `Column`, `GotoLine` and `Select` are all about the *cursor*, with
     * the scroll following as a side effect -- so a wheel movement with the
     * cursor parked was unobservable and two panes could not be kept in step.
     * That gap is what `ISSUE-editor-scroll` reported, from a diff viewer that
     * had to follow the cursor instead of locking the views.
     *
     * The four names and the event are `Scroller`'s own, because an editor
     * *builds* a GtkScrolledWindow around its view: it is the same thing
     * underneath and the same number has to come out of both.
     */
    testEditorScroll() {
        /*
         * Its own editor on the surface, and not the `.form`'s.
         *
         * `this.Ed` lives on a page nothing is looking at during a full run, and
         * a view that is never laid out never measures its text -- so the end of
         * the file stays zero and every assertion below waits forever. It passed
         * on its own and failed in the suite, which is the shape of that bug.
         * `testScrolling` puts its `Scroller` on `Fixed1` for the same reason.
         */
        const ed = new TextEditor();
        this.Fixed1.Add(ed);
        ed.Name = "Ed2";
        ed.Wrap = false;
        ed.Resize(200, 120);

        let text = "";
        for (let i = 1; i <= 400; i++) text += `line ${i}\n`;
        ed.Text = text;

        eq("a fresh editor is at the top", ed.ScrollY, 0);

        /* **The text has to have been laid out before the end exists.** It was
         * assigned this turn and has no measured height yet, so the adjustment
         * still describes an empty view -- the same rule `testScrolling` above
         * follows, and the same one `Bounds()` does. */
        until("a long file is measured", () => ed.ScrollMaxY > 0, () => {
            check("and then it has somewhere to go", ed.ScrollMaxY > 0,
                  String(ed.ScrollMaxY));

            /*
             * **Nothing here is a fixed number of pixels**, and that is the
             * lesson rather than a convenience. A `GtkTextView` validates its
             * text a little at a time, so the end of a long file *grows* while
             * it is being measured: a test that asked for 300 got 10, then 46,
             * and the same assignment twice emitted twice because the ceiling
             * had moved between them. What is stable is the relation -- it goes
             * where it is told inside the range, and stops at the ends.
             */
            this.scrolls = [];
            const half = Math.floor(ed.ScrollMaxY / 2);

            ed.ScrollY = half;
            eq("assigning it moves it", ed.ScrollY, half);
            eq("and says so once", this.scrolls.length, 1);
            eq("with where it went", this.scrolls[0][1], half);

            /* Assigning what it already has emits nothing, which is what keeps
             * two panes pointed at each other from bouncing off one another. */
            ed.ScrollY = half;
            eq("assigning the same value again says nothing", this.scrolls.length, 1);

            /*
             * Clamped, not refused: past the end is the end, the way `GotoLine`
             * treats a line past the last one.
             *
             * Asserted as `<=` and not as equality, and that is the same lesson
             * again: setting a value validates more text, so the ceiling read
             * after the assignment is already higher than the one the clamp
             * used. `10` against a `ScrollMaxY` of `28`, measured. What cannot
             * happen is going past it.
             */
            ed.ScrollY = 999999;
            check("past the end does not go past the end",
                  ed.ScrollY <= ed.ScrollMaxY, `${ed.ScrollY} of ${ed.ScrollMaxY}`);
            check("and goes as far as there was", ed.ScrollY >= half,
                  `${ed.ScrollY} from ${half}`);
            ed.ScrollY = -50;
            eq("and before the start is the start", ed.ScrollY, 0);

            throws("a scroll that is not a number is refused",
                   () => { ed.ScrollY = NaN; });

            /*
             * **And this is what makes `GotoLine`'s scroll assertable at all.**
             * It revealed its line through an iter, and `scroll_to_iter` on a
             * view with no allocation does nothing and says nothing -- so
             * jumping in a tab opened in the same turn left the cursor right and
             * the view at the top. There was no way to see that from here until
             * an editor could say where it was scrolled to.
             */
            ed.GotoLine(380);
            eq("GotoLine puts the cursor there", ed.Line, 380);

            /*
             * **The cursor moves now; the scroll is only promised for later.**
             * `Line` above is already 380, because moving the cursor is a write
             * to the buffer. The scroll is revealed through a mark instead, so
             * that the request survives a view that has not been laid out --
             * which means a program must not read `ScrollY` on the next line and
             * believe it.
             *
             * **There is deliberately no assertion that it is still 0 here**,
             * and that is the finding rather than an omission. There was one,
             * and it failed about one run in five: `gtk_text_view_scroll_to_mark`
             * honours the mark *immediately* when the view already has a
             * validated allocation and on a later frame when it does not, so
             * whether the jump has landed by this line is a race against GTK and
             * not a property of the editor. Asserting a **negative about frame
             * timing** cannot be made to pass; `until` below asserts the half
             * that is real -- that the scroll does arrive.
             */
            until("the jump is carried out", () => ed.ScrollY > 0, () => {
                check("GotoLine really scrolls to its line", ed.ScrollY > 0,
                      `ScrollY=${ed.ScrollY} of ${ed.ScrollMaxY}`);

                /* A file that fits has nowhere to scroll, and says zero rather
                 * than something negative -- once it has been measured. */
                ed.Text = "una sola\n";
                until("the short file is measured", () => ed.ScrollMaxY === 0, () => {
                    eq("a file that fits cannot scroll", ed.ScrollMaxY, 0);
                    eq("and is at the top", ed.ScrollY, 0);
                    ed.Delete();          /* off the surface it was borrowed from */
                });
            });
        });
    }

    Ed2_Scroll(x, y) { if (this.scrolls) this.scrolls.push([x, y]); }

    testEditorMarks() {
        this.Ed.Text = "uno\ndos\ntres\ncuatro\n";

        eq("an editor starts with no marks", this.Ed.Marks().length, 0);
        eq("and no gutter to draw them in", this.Ed.ShowMarks, false);

        this.Ed.Mark(2, "Error", "algo va mal");
        eq("marking turns the gutter on, or nobody would see it",
           this.Ed.ShowMarks, true);

        this.Ed.Mark(3, "Bookmark");
        eq("both marks are there", this.Ed.Marks().length, 2);
        eq("in line order", JSON.stringify(this.Ed.Marks().map((m) => m.Line)), "[2,3]");
        eq("each saying its kind", this.Ed.Marks()[0].Kind, "Error");
        eq("and carrying what was said about the line",
           this.Ed.Marks()[0].Text, "algo va mal");
        eq("a mark with nothing to say has no text", this.Ed.Marks()[1].Text, "");

        eq("and one kind can be asked for on its own",
           this.Ed.Marks("Bookmark").length, 1);

        /* The reason `Marks()` walks GTK's marks instead of a list of ours: a
         * mark belongs to the line, and a line moves when something is typed
         * above it. */
        this.Ed.GotoLine(1);
        this.Ed.Insert("cero\n");
        eq("a mark follows the line it was put on",
           JSON.stringify(this.Ed.Marks().map((m) => m.Line)), "[3,4]");

        this.Ed.Unmark(3, "Error");
        eq("unmarking takes that kind off that line",
           JSON.stringify(this.Ed.Marks().map((m) => m.Kind)), '["Bookmark"]');

        this.Ed.ClearMarks();
        eq("and clearing takes the rest", this.Ed.Marks().length, 0);
        eq("the gutter stays, since text that jumps sideways is worse",
           this.Ed.ShowMarks, true);

        throws("a kind nobody defined is refused", () => this.Ed.Mark(1, "Fatal"));

        /*
         * The three kinds that are about the *line* and not about a message:
         * they paint it, which is what lets two panes be a diff rather than two
         * files. Read back like any other mark -- the painting itself is
         * GtkSourceView's and is not something a test can see.
         */
        this.Ed.ClearMarks();
        this.Ed.Mark(1, "Removed");
        this.Ed.Mark(2, "Added");
        this.Ed.Mark(3, "Gap");

        eq("a diff's three kinds are kinds like the others",
           JSON.stringify(this.Ed.Marks().map((m) => m.Kind)),
           '["Removed","Added","Gap"]');
        eq("and each can be asked for on its own", this.Ed.Marks("Added").length, 1);
        this.Ed.ClearMarks();

        /* --- Select: reaching a match, not just a line --- */
        this.Ed.Select(4, 2, 3);
        eq("Select lands on the line", this.Ed.Line, 4);
        eq("and takes the text from that column", this.Ed.Selection, "res");
        eq("leaving the cursor at the far end, as dragging one does",
           this.Ed.Column, 5);

        this.Ed.Select(2);
        eq("with nothing to take it is a cursor move", this.Ed.Selection, "");
        eq("at the start of the line", this.Ed.Column, 1);

        /* A result standing on a line that has been edited since must land
         * where it can rather than somewhere else entirely. */
        this.Ed.Select(2, 9999);
        eq("a column past the end of the line stays on that line", this.Ed.Line, 2);
        eq("standing at the end of it", this.Ed.Column, 4);

        /* And the end of a *last* line, which has no line break to stop at --
         * counting the break and subtracting one lands a character short there
         * and nowhere else, which is exactly the kind of edge a file without a
         * trailing newline walks into. */
        this.Ed.Text = "sin salto";
        this.Ed.Select(1, 9999);
        eq("a line with no break after it still ends where it ends",
           this.Ed.Column, 10);

        this.Ed.ShowMarks = false;
        eq("ShowMarks round-trip", this.Ed.ShowMarks, false);
        this.Ed.Clear();
    }

    /* --- a form that refuses to close --------------------------------------
     *
     * `Form_Close` is asked rather than told: returning true keeps the window
     * open, which is what lets a form with unsaved work put a question up
     * instead of losing it.  Both halves are asserted, because a veto that
     * never lets go is as broken as one that never holds.
     */
    testCloseVeto() {
        const win = new VetoForm();
        win.Text = "veto";
        win.Resize(240, 120);
        win.Show();

        win.Close();
        eq("closing asks the form", win.asked, 1);
        eq("and refusing keeps the window", win.Visible, true);

        win.Close();
        eq("asked again the next time", win.asked, 2);
        eq("and answering nothing lets it go", win.Visible, false);
    }

    /* What the editor under test asks its form. Returning an array is the
     * answer; returning nothing at all is a form with nothing to say. */
    Comp_Complete(word, line, column, before) {
        this.completions.push([word, line, column, before]);
        return ["Uno", { Text: "Dos", Detail: "algo" }];
    }

    /* --- focus -----------------------------------------------------------
     *
     * `GotFocus`/`LostFocus` are what "when the user is done with this box" is
     * said with: a field that checks what was typed checks it then, and Enter is
     * only the other half of the answer.
     *
     * Asserted through the round trip, like every other event here: `SetFocus()`
     * has to reach GTK, come back as a real focus change, and land on the
     * handlers -- and `Focused` has to agree with what they said.
     */
    testFocus() {
        this.focusLog = [];

        const a = new TextBox();
        const b = new TextBox();
        this.Fixed1.Add(a);
        this.Fixed1.Add(b);
        a.Name = "FocA";
        b.Name = "FocB";

        eq("nothing is focused to begin with", a.Focused, false);

        a.SetFocus();
        eq("SetFocus reports arriving",  JSON.stringify(this.focusLog), '["FocA in"]');
        eq("and Focused agrees",         a.Focused, true);
        eq("while the other one does not", b.Focused, false);

        b.SetFocus();
        eq("moving on reports both halves, in order",
           JSON.stringify(this.focusLog), '["FocA in","FocA out","FocB in"]');
        eq("and Focused follows", a.Focused, false);
        eq("...both ways",       b.Focused, true);

        /* Focus is where it is, not something a form declares: a setter would
         * have the serialiser write it into the .form. */
        check("Focused is read-only, so it is never serialised",
              !a.PropertyNames().includes("Focused"),
              a.PropertyNames().join(","));

        /*
         * `Focusable = false` has to reach the widget the focus really sits on.
         * On an entry that is the `GtkText` inside it, so setting the flag on the
         * outside alone read back correctly and did nothing -- the focus went
         * straight in past it. This is the assertion that says otherwise.
         */
        a.Focusable = false;
        a.SetFocus();
        eq("what cannot be focused does not take the focus", a.Focused, false);
        eq("and the one that had it keeps it",               b.Focused, true);
        a.Focusable = true;
        a.SetFocus();
        eq("and turning it back on lets it in again", a.Focused, true);

        /*
         * And it answers for the *control*, not for the widget GTK gave the
         * focus to.  A TextBox's focus really sits on the GtkText inside its
         * entry, and an editor's on the view inside its scroller -- both would
         * answer false if the question were `has_focus` on the outer widget.
         */
        const ed = new TextEditor();
        this.Fixed1.Add(ed);
        ed.Name = "FocEd";
        ed.SetFocus();
        eq("a control wrapped in a scroller answers for itself", ed.Focused, true);

        a.Delete();
        b.Delete();
        ed.Delete();
    }

    FocA_GotFocus()  { this.focusLog.push("FocA in"); }
    FocA_LostFocus() { this.focusLog.push("FocA out"); }
    FocB_GotFocus()  { this.focusLog.push("FocB in"); }
    FocB_LostFocus() { this.focusLog.push("FocB out"); }

    /* --- records ---------------------------------------------------------
     *
     * The claim being tested is that a declared field *is* an ordinary accessor:
     * it validates on assignment like every setter in this runtime, it
     * round-trips through the same discovery the serialiser uses, and it answers
     * PropertyNames/PropertyOptions the way a control does -- so whoever edits a
     * control can edit a record without being told which it has.
     */
    testRecord() {
        const c = new Customer();

        eq("a field starts at what its kind starts at", c.Id, 0);
        eq("...and text at nothing",                    c.Name, "");
        eq("a bool default is the one declared",         c.Active, true);
        eq("an enum with no default takes the first",    c.Category, "Retail");
        eq("a list starts empty",  JSON.stringify(c.Tags), "[]");
        check("and a fresh one per record, not one shared",
              new Customer().Tags !== new Customer().Tags);

        /* The setters: the same bargain as C's, with the offending value named. */
        c.Name = "Ana";
        eq("assigning goes in", c.Name, "Ana");
        throws("required refuses nothing",     () => { c.Name = ""; });
        throws("and text longer than declared", () => { c.Name = "demasiado largo"; });
        throws("a number is not text",          () => { c.Name = 3; });
        eq("and none of the refused ones stuck", c.Name, "Ana");

        c.Id = 7;
        throws("a fraction is not a whole number", () => { c.Id = 1.5; });

        c.Balance = 10.567;
        eq("a number is rounded to what it holds", c.Balance, 10.57);
        throws("and refused below its floor", () => { c.Balance = -5; });

        c.Active = 0;
        eq("SQL's spelling of false is accepted", c.Active, false);
        c.Active = 1;
        eq("...and of true",                      c.Active, true);
        throws("but a string is not a boolean", () => { c.Active = "true"; });

        c.Since = "2026-02-28";
        eq("a date is ISO text", c.Since, "2026-02-28");
        throws("a day that does not exist", () => { c.Since = "2026-02-30"; });
        throws("and something that is not a date", () => { c.Since = "ayer"; });

        c.Category = "Wholesale";
        throws("an enum takes what it declared", () => { c.Category = "Other"; });
        eq("and offers it, as a control does",
           c.PropertyOptions("Category").join(","), "Retail,Wholesale");
        eq("a field with no list offers none", c.PropertyOptions("Name").length, 0);

        c.Tags = ["one", "two"];
        eq("a list checks its entries", JSON.stringify(c.Tags), '["one","two"]');
        throws("...each of them",  () => { c.Tags = ["one", "muylargo"]; });
        throws("...and how many",  () => { c.Tags = ["a", "b", "c", "d"]; });
        throws("a list is not text", () => { c.Tags = "one"; });

        eq("a hand-written field is a field", c.Label, "Ana (7)");
        check("and read-only ones are not written back",
              !("Label" in c.Serialize()), JSON.stringify(c.Serialize()));

        /* Writing: what differs from the start, with the file's own names. */
        const written = c.Serialize();
        eq("only what was decided is written",
           JSON.stringify(written),
           JSON.stringify({ Id: 7, Name: "Ana", Balance: 10.57,
                            Category: "Wholesale", Since: "2026-02-28",
                            Tags: ["one", "two"] }));
        check("a field at its default is left out", !("Active" in written));
        check("and `as` is the name in the file, not the one here",
              !("Email" in written));
        c.Email = "ana@example.com";
        eq("which shows the moment it has a value",
           c.Serialize().email_address, "ana@example.com");

        check("everything, for a reader that is a contract",
              "Active" in c.Serialize(true), JSON.stringify(c.Serialize(true)));

        /* JSON.stringify has to be the record and not the empty object the
         * private bag would otherwise show. */
        eq("stringify is the record", JSON.stringify(c), JSON.stringify(c.Serialize()));

        eq("PropertyNames lists them", c.PropertyNames().join(","),
           "Id,Name,Email,Balance,Category,Active,Since,Tags");

        /* Naming is a rule about the file, said once. */
        const low = new Lowered({ Name: "Hello", Startup: "Form1" });
        eq("lower case keys", JSON.stringify(low),
           JSON.stringify({ name: "Hello", startup: "Form1" }));
        const snake = new Snaked({ CustomerName: "Ana", PostalCode: "1900" });
        eq("snake case keys", JSON.stringify(snake),
           JSON.stringify({ customer_name: "Ana", postal_code: "1900" }));

        /* Reading a file: lenient, and it says everything at once. */
        const read = Customer.Load({ Id: 3, Name: "Bo", Category: "Wholesale",
                                     email_address: "bo@example.com" });
        eq("a file is read by its own names", read.Email, "bo@example.com");
        eq("and its values arrive",           read.Id, 3);
        eq("a good file has nothing to report", read.Problems.length, 0);

        const broken = Customer.Load({ Id: "three", Name: "", Category: "Other",
                                       Tags: "one", extra: { keep: true } });
        check("a bad value is reported, not thrown",
              broken.Problems.length >= 4, JSON.stringify(broken.Problems));
        check("...naming the field and what was wrong",
              broken.Problems.some((p) => p.startsWith("Id:")),
              JSON.stringify(broken.Problems));
        eq("and the field is left where it started", broken.Id, 0);
        check("...and says what the field was left at",
              broken.Problems.some((p) => p === `Name is required -- left at ""`),
              JSON.stringify(broken.Problems));

        /*
         * **`Problems` is the report of one `Load` and not the state of the
         * record.** It used to be that plus `Validate()`, and a form that
         * validated with it refused to save a record the user had already
         * fixed -- showing `Name is required` against a field with a name in
         * it. Nothing clears it either: it is a record of an act of reading,
         * and that act is over.
         */
        broken.Name = "Ana";
        eq("a field the user fixed is out of Validate at once",
           JSON.stringify(broken.Validate().filter((p) => p.startsWith("Name"))),
           "[]");
        check("...and the load report still says what the file had said",
              broken.Problems.some((p) => p.startsWith("Name is required")),
              JSON.stringify(broken.Problems));
        check("so Problems does not contain Validate's half",
              !broken.Problems.some((p) => p === "Name is required"),
              JSON.stringify(broken.Problems));

        /* A file that says nothing wrong about a required field it simply does
         * not carry is a clean *load* with an invalid record: the two questions,
         * answered separately. */
        const absent = Customer.Load({ Id: 1 });
        eq("a key the file does not carry is not a load complaint",
           JSON.stringify(absent.Problems), "[]");
        check("...and is still what Validate is for",
              absent.Validate().includes("Name is required"),
              JSON.stringify(absent.Validate()));

        /* A key the record does not describe survives the round trip: a manifest
         * carrying a key from a newer version must not be deleted by an older
         * one that saved it. */
        eq("what it did not understand comes back out",
           JSON.stringify(broken.Serialize().extra), JSON.stringify({ keep: true }));

        const notObject = Customer.Load("nope");
        check("something that is not an object is reported, not thrown",
              notObject.Problems.some((p) => p.includes("expected an object")),
              JSON.stringify(notObject.Problems));

        /* Validate is Problems without the file: what it holds, checked. */
        const half = new Customer();
        check("a record built by hand reports what it lacks",
              half.Validate().includes("Name is required"),
              JSON.stringify(half.Validate()));

        /* A subclass adds to its parent's fields. */
        const vip = new Vip({ Name: "Ana", Discount: 12.34 });
        eq("the parent's fields are there", vip.Name, "Ana");
        eq("and the subclass's too",        vip.Discount, 12.3);
        check("all of them", vip.PropertyNames().includes("Category") &&
                             vip.PropertyNames().includes("Discount"),
              vip.PropertyNames().join(","));

        /* And the bag is nobody else's. */
        eq("there is no way around the setter", c.d, undefined);
        eq("nor a name for it",                 typeof Record.peek, "undefined");

        /* Declaring it wrongly is answered when the class is used, not later. */
        throws("an option nobody has",      () => Field.Text({ maxx: 3 }));
        throws("an enum default outside its own list",
               () => Field.Enum(["a", "b"], "z"));
        throws("a list of nothing in particular", () => Field.List("text"));

        /*
         * **And a list of records, which used to be the wall.** `Field.List`
         * took a *field* for its entries and a `Record` was not one, so a record
         * could not contain a list of records -- an invoice could not hold its
         * own lines, and `examples/quote` was shaped around it with the header
         * and the lines side by side in the file. A Record class is accepted
         * where a field is expected now, which is the short spelling of a
         * detail; `testNested` is where what it builds is checked.
         */
        check("a list of records", Field.List(Priced).__field === true);
        check("...and the long spelling says the same thing",
              Field.List(Field.Record(Priced)).__field === true);
        throws("something that is not a Field",   () => new NotAField());
        throws("a field declared twice",          () => new Clash());
        throws("a naming rule nobody has",        () => new BadNaming());
        throws("a default the field itself would refuse", () => new BadDefault());
        throws("a Fields getter, which used to declare nothing in silence",
               () => new GetterFields());
        throws("a seed the child's own shape would refuse", () => new BadSeed());
        throws("a thunk that answers with something that is not a Record",
               () => new BadThunk());
        throws("a record field of nothing in particular",
               () => Field.Record("Address"));
    }

    /* --- records inside records -------------------------------------------
     *
     * The claim: **a record is a field**, so master-detail is *declared* and not
     * assembled -- and `Field.List` needed no new mechanism for it, since its
     * entries were always described by a field and a record field is one.
     *
     * What that has to reach through is everything the shallow case already
     * promised: the serialiser, the loader *leniently*, `Validate` and
     * `Problems` with all the complaints at once and the path in front of each,
     * and `Clone`. And it has to survive a shape that contains itself, which is
     * not an exotic case here -- a `.form` node holds `.form` nodes and a menu
     * item holds menu items, both of them read and written by hand today.
     */
    testNested() {
        const inv = new Invoice({ Customer: "Acme" });

        /* The defaults, which are the whole of the null-versus-empty decision:
         * a record field starts **absent**, because that is what lets a shape
         * contain itself and what a file means by a key it does not have. */
        eq("a list of records starts empty", JSON.stringify(inv.Lines), "[]");
        eq("a record field starts at null -- absent, not empty", inv.Ship, null);
        check("...and `def` is how a record that always has one says so",
              inv.Bill instanceof Address && inv.Bill.City === "CABA",
              JSON.stringify(inv.Bill));
        check("a fresh seed per record, not one shared between them",
              new Invoice().Bill !== new Invoice().Bill);

        /* Assigning is strict one level down exactly as it is one level up. */
        inv.Ship = { Street: "Corrientes 1234", City: "CABA" };
        check("a plain object goes in through the child's own setters",
              inv.Ship instanceof Address &&
              inv.Ship.Street === "Corrientes 1234", JSON.stringify(inv.Ship));
        throws("a bad member is refused, with the path in the sentence",
               () => { inv.Ship = { Street: 5 }; });
        throws("and so is something that is not a record at all",
               () => { inv.Ship = 7; });

        /*
         * A required member simply *not mentioned* is left to Validate, which is
         * what happens at the top too: `new Invoice()` is a legal object to
         * build and an invalid one to save, and a child is no different.
         */
        eq("a child's required member is Validate's business, as it is at the top",
           JSON.stringify(new Invoice({ Ship: { City: "Rosario" } }).Validate()),
           JSON.stringify(["Customer is required", "Ship.Street is required",
                           "Bill.Street is required"]));

        /* Entries. A plain object becomes one; a null is not one. */
        inv.Lines = [{ Name: "Perfil", Price: "1000" }];
        check("a plain object in a list becomes an entry",
              inv.Lines[0] instanceof Priced);
        throws("a null entry: a list has fewer entries, not absent ones",
               () => { inv.Lines = [null]; });

        /*
         * **The hole worth knowing about.** `push` goes around the setter, so a
         * plain object pushed into a list of records is not checked when it goes
         * in -- it is checked when the record is, which is the same bargain
         * `Field.List(Field.Text())` has always had and the moment a save asks.
         */
        inv.Lines.push({ Name: "no es un Priced" });
        check("push goes around the setter, and Validate is where that lands",
              inv.Validate().some((p) => p === "Lines[1] is not a Priced"),
              JSON.stringify(inv.Validate()));
        inv.Lines.pop();

        /* The list's own rules are about the list and not about an entry. */
        throws("more entries than the list takes", () => {
            inv.Lines = [{ Name: "a" }, { Name: "b" }, { Name: "c" },
                         { Name: "d" }];
        });

        /* Serialising: one object, and each child in its **own** spelling --
         * how a file spells its keys is a rule about that record, so a lower-case
         * master can hold PascalCase children. */
        const full = new Invoice({ Customer: "Acme",
            Lines: [{ Name: "Chapa", Price: "16500" }],
            Ship:  { Street: "Corrientes 1234" } });
        eq("one file, and not two halves of one",
           JSON.stringify(full.Serialize()),
           JSON.stringify({ customer: "Acme",
                            lines: [{ Name: "Chapa", Price: "16500.00" }],
                            ship:  { Street: "Corrientes 1234" } }));
        check("a seeded child at its seed is not a decision the file records",
              full.Serialize().bill === undefined,
              JSON.stringify(full.Serialize()));

        /*
         * And a child keeps its own unknown keys. A file from a newer version has
         * to survive being saved by an older one at **every** level: `.form` is
         * the case in point, and a form saved with its msgids gone is what that
         * rule already cost this codebase once.
         */
        const kept = Invoice.Load({ customer: "Acme",
            lines: [{ Name: "Chapa", Price: "10", colour: "rojo" }],
            ship:  { Street: "Corrientes 1234", floor: 3 } });
        eq("an unknown key inside a child comes back out",
           JSON.stringify(kept.Serialize().ship),
           JSON.stringify({ Street: "Corrientes 1234", floor: 3 }));
        eq("...and inside a list entry too", kept.Serialize().lines[0].colour,
           "rojo");

        /*
         * Loading is lenient all the way down: a child is *loaded* and not
         * assigned, so one bad price costs that price and not the rest of the
         * line. The path in front of each complaint is the shape `Columns[2]`
         * has in `bta_table.c`, which validates a list of records by hand for
         * one property -- this is that, once, for every record.
         */
        const bad = Invoice.Load({ customer: "Acme",
            lines: [{ Name: "ok", Price: "10" },
                    { Name: "", Price: "-5" },
                    7],
            ship:  { Street: 5 } });
        const said = JSON.stringify(bad.Problems);

        eq("a bad entry costs its own field and not the file", bad.Lines[0].Name,
           "ok");
        eq("...nor the rest of its own entry", `${bad.Lines[1].Price}`, "0.00");
        check("an entry's complaint carries its index and its member",
              said.includes("Lines[1].Price: 0 at least"), said);
        check("...and a child's carries the child", 
              said.includes("Ship.Street: expected text"), said);
        check("an entry that is not an object is one complaint, not a hole",
              said.includes("Lines[2]: expected an object, got number") &&
              bad.Lines[2] instanceof Priced, said);

        /* Clone is Load(Serialize(true)), so a deep copy costs nothing extra --
         * and it is what the menu editor does by hand with
         * JSON.parse(JSON.stringify(menus)). */
        const copy = full.Clone();
        copy.Lines[0].Name = "Otra";
        copy.Ship.Street   = "Rivadavia 100";
        eq("a clone's entries are its own",  full.Lines[0].Name, "Chapa");
        eq("...and so is its child",         full.Ship.Street, "Corrientes 1234");

        /* A shape that contains itself, to any depth. */
        const tree = Node.Load({ Text: "_File", Children: [
            { Text: "Save" },
            { Text: "Recent", Children: [{ Text: "one" }] }] });
        eq("a record holds its own kind, to any depth",
           tree.Children[1].Children[0].Text, "one");
        eq("...and writes back exactly what it read",
           JSON.stringify(tree.Serialize()),
           JSON.stringify({ Text: "_File", Children: [{ Text: "Save" },
               { Text: "Recent", Children: [{ Text: "one" }] }] }));

        /* A required field the file does not carry two levels down: a clean
         * load, and Validate is what finds it -- with the path in front. */
        const deep = Node.Load({ Text: "a", Children: [{ Children: [{}] }] });
        eq("a key nobody wrote is not a load complaint",
           JSON.stringify(deep.Problems), "[]");
        check("...and Validate finds it two levels down, with the path",
              deep.Validate().includes("Children[0].Children[0].Text is required"),
              JSON.stringify(deep.Validate()));

        /* And a value the file *did* carry and the shape refused, at the same
         * depth: that is the load report, and it carries the path too. */
        const refused = Node.Load({ Text: "a",
                                    Children: [{ Text: "b",
                                                 Children: [{ Text: 5 }] }] });
        check("a value the file had and the shape refused says where it was",
              refused.Problems.some((p) =>
                  p.startsWith("Children[0].Children[0].Text: expected text")),
              JSON.stringify(refused.Problems));

        /* A record that really holds itself. JSON cannot say it, so it is a
         * sentence rather than a hang. */
        const loop = new Node({ Text: "a" });
        loop.Children.push(loop);
        throws("a cycle is refused, not hung on", () => loop.Serialize());
    }

    /* --- a command in several places --------------------------------------
     *
     * An `Action` is a named command that a button, a menu item and a key all
     * point at. **What makes it worth having is the shared `Enabled`**, not the
     * shared body: the IDE had three commands written four times each, with
     * their availability computed in two files with two different expressions,
     * and whether those agreed was not answerable by reading either one.
     *
     * So the claims are about what a control can no longer do on its own.
     */
    testAction() {
        const act = this.ActTest;

        eq("a command is exposed on the form by name", act.Name, "ActTest");
        eq("...with what the .form declared", `${act.Text} ${act.Icon}`,
           "Test command list-add-symbolic");
        eq("Text is read-only: it is the declaration, not a value",
           this.readOnly(act, "Text"), true);
        eq("a command declared off starts off", this.ActOff.Enabled, false);
        eq("...and one that did not, on",       act.Enabled, true);

        /* Binding, and the two refusals that make it worth binding. */
        const btn = new Button(this, "ActBtn");
        this.Add(btn);
        btn.Action = "ActTest";

        eq("Action reads the name and not GTK's path", btn.Action, "ActTest");
        eq("a bound control takes the command's label", btn.Text, "Test command");
        eq("...and its icon",                           btn.Icon, "list-add-symbolic");

        act.Enabled = false;
        eq("one assignment, and the bound control follows", btn.Enabled, false);
        act.Enabled = true;
        eq("...both ways", btn.Enabled, true);

        throws("a bound control refuses an Enabled of its own",
               () => { btn.Enabled = false; });
        throws("and a command that is not there is refused where it is written",
               () => { btn.Action = "ActNope"; });

        const lbl = new Label(this, "ActLbl");
        this.Add(lbl);
        throws("a control that is not pressed cannot have one",
               () => { lbl.Action = "ActTest"; });

        /* Fired from code, the way a menu item can be. */
        this.actionFired = 0;
        act.Click();
        eq("Click runs the handler", this.actionFired, 1);
        act.Enabled = false;
        throws("...and a disabled command refuses to be pressed",
               () => act.Click());
        act.Enabled = true;

        /*
         * **A control that declared an icon is an icon control and stays one.**
         * A 34-pixel toolbar button handed the command's words as well grows
         * until it pushes what is beside it out of shape -- which is how the
         * IDE's own layout test caught the first version of this.
         */
        const iconic = new Button(this, "ActIcon");
        this.Add(iconic);
        iconic.Icon   = "edit-copy-symbolic";
        iconic.Action = "ActTest";
        eq("an icon suppresses the label", iconic.Text, "");
        eq("...and the icon it declared is kept", iconic.Icon, "edit-copy-symbolic");

        /*
         * And what a bound control writes back. `Enabled` is the command's, so
         * it is not written at all -- saving a form while a command was off
         * used to put `"Enabled": false` on every control naming it, and the
         * file would not load again, because the loader is refused too.
         */
        act.Enabled = false;
        const node = btn.Serialize();
        act.Enabled = true;

        eq("a bound control writes its Action", node.properties.Action, "ActTest");
        eq("...and no Enabled, whatever the command says",
           "Enabled" in node.properties, false);
        eq("...nor the label it was lent",  "Text" in node.properties, false);
        eq("...nor the icon",               "Icon" in node.properties, false);

        eq("the form serialises its commands, before its menus",
           JSON.stringify(this.Serialize().actions.map((a) => a.name)),
           JSON.stringify(["ActTest", "ActOff"]));

        btn.Delete();
        lbl.Delete();
        iconic.Delete();
    }

    ActTest_Click() { this.actionFired = (this.actionFired || 0) + 1; }

    /* Whether assigning to a member throws, which is what "read-only" means to
     * a program rather than to a descriptor. */
    readOnly(obj, key) {
        try { obj[key] = "x"; return false; } catch (e) { return true; }
    }

    /* --- a database, and a shape over a table -----------------------------
     *
     * Two halves and the seam between them. `Database.Sqlite` is a **driver**,
     * in C, named for the library it is because half of what it does is not
     * portable -- `?` for a parameter, a path for a location, and a decimal
     * stored as text because sqlite is the one of these engines with no exact
     * numeric type at all. `Table` is the portable half, in `rad.js`, and it
     * reads the three facts known to differ off `Dialect` rather than assuming
     * them.
     *
     * The claim worth asserting is smaller than it looks: **a row is a file.**
     * `Load` already reads an object keyed by whatever `Naming` spells and
     * `Serialize` already writes one with its decimals as text, so nothing here
     * converts a value -- which is why `Naming = "snake"`, written for this and
     * unused until now, needed no changes to become the SQL spelling.
     *
     * sqlite is optional at build time, so this reports one assertion instead of
     * fifty on a runtime built without it.
     */
    testDatabase() {
        let db = null;

        try {
            db = Database.Sqlite(":memory:");
        } catch (e) {
            /* Not a skip: the claim is that a runtime built without the library
             * says which one, rather than being missing a global. */
            check("built without sqlite, Database.Sqlite says which package",
                  e.message.includes("sqlite"), e.message);
            return;
        }

        /*
         * **The seam, asserted rather than described.** `Connection` is a base
         * class with an empty prototype in `bta_database.c`; the driver builds
         * its own on top of it; `rad.js` hangs `Table` on the base. That is what
         * lets a second driver share the portable half without sharing a line of
         * implementation -- and every one of those three is a claim that would
         * rot in a comment.
         */
        check("a driver's connection is a Connection", db instanceof Connection);
        eq("Table lives on the base prototype",
           typeof Connection.prototype.Table, "function");
        check("...and a sqlite connection reaches that same one",
              db.Table === Connection.prototype.Table);
        eq("while Query is the driver's own and not the base's",
           typeof Connection.prototype.Query, "undefined");
        eq("a driver adds its opener to Database", typeof Database.Sqlite,
           "function");
        eq("and there is no Connection.Open: opening belongs to a driver",
           typeof Connection.Open, "undefined");

        eq("a database in memory reports its path", db.Path, ":memory:");
        eq("and is open",                           db.Open, true);
        eq("the dialect is the three facts a Table cannot assume",
           JSON.stringify(db.Dialect),
           JSON.stringify({ Placeholder: "?", Quote: "\"", NewKey: "LastId" }));

        db.Script(`
            CREATE TABLE clients (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL, balance TEXT,
                active INTEGER, since TEXT, postal_code TEXT, note TEXT);
            CREATE TABLE coded (code TEXT PRIMARY KEY, what TEXT);
            CREATE VIEW rich AS SELECT * FROM clients;
        `);

        check("Script runs several statements, which Execute will not",
              sameJson(db.Tables, ["clients", "coded", "rich"]),
              JSON.stringify(db.Tables));
        eq("Columns answers in a Field's words, not a PRAGMA's",
           JSON.stringify(db.Columns("clients")[1]),
           JSON.stringify({ Name: "name", Type: "TEXT", Required: true, Key: 0 }));
        eq("...and a key is its position, so a compound one keeps its order",
           db.Columns("clients")[0].Key, 1);

        /* --- the driver on its own ---------------------------------------- */

        const wrote = db.Execute(
            "INSERT INTO clients (name, balance, active, since) VALUES (?, ?, ?, ?)",
            ["Ana", new Decimal("16500.005", 2), true, "2026-08-24"]);
        eq("Execute says how many rows it touched", wrote.Changes, 1);
        eq("...and the key it made",                wrote.LastId, 1);

        const raw = db.Query("SELECT * FROM clients")[0];
        eq("a decimal is held as text, which keeps it exactly",
           raw.balance, "16500.01");
        eq("a boolean is stored as sqlite's 0/1",   raw.active, 1);
        eq("a date is the text a Field.Date holds", raw.since, "2026-08-24");
        eq("a column nothing was written to is null", raw.note, null);
        eq("an integer column comes back a number", typeof raw.id, "number");

        /* A whole number binds as INTEGER and not REAL: they are different
         * storage classes, and a rowid written 3.0 is one no `= 3` finds. */
        eq("a whole number binds as an integer",
           db.Query("SELECT id FROM clients WHERE id = ?", [1]).length, 1);

        /*
         * **The driver binds a `Decimal` as its own exact text, and what the
         * column does with that text is affinity -- which is a trap the driver
         * cannot see.** Into a TEXT column it stays exact; into a column of
         * INTEGER or NUMERIC affinity sqlite converts it to a REAL, and the
         * scale and the exactness are gone. A `Table` never does this, because
         * it writes units; a raw `Execute` can.
         */
        db.Script("CREATE TABLE bound (t TEXT, n INTEGER)");
        db.Execute("INSERT INTO bound VALUES (?, ?)",
                   [new Decimal("19.90", 2), new Decimal("19.90", 2)]);
        const bound = db.Query("SELECT t, typeof(t) AS tt, n, typeof(n) AS nt " +
                               "FROM bound")[0];
        eq("a Decimal into a TEXT column is its own text", bound.t, "19.90");
        eq("...and stays text",                            bound.tt, "text");
        eq("a Decimal into an INTEGER column becomes a double",
           bound.nt, "real");
        check("...and the scale is gone with it", bound.n === 19.9,
              `${bound.n}`);

        throws("fewer parameters than the statement takes",
               () => db.Query("SELECT * FROM clients WHERE id = ? AND name = ?", [1]));
        throws("two statements in Execute",
               () => db.Execute("SELECT 1; SELECT 2"));
        throws("an object as a parameter",
               () => db.Query("SELECT ?", [{ a: 1 }]));
        /*
         * **A BLOB, both ways.** This used to be a refusal -- the driver said so
         * by name, because there was no value in the language to hand back --
         * and it stayed right until `Bytes` existed. A BLOB literal comes back
         * as bytes, and a `Bytes` bound into a column is stored as a BLOB and
         * not as the text of `toString`.
         */
        const dead = db.Query("SELECT x'DEADBEEF' AS photo")[0].photo;
        check("a BLOB comes back as Bytes", dead instanceof Bytes, `${dead}`);
        eq("byte for byte", dead.ToHex(), "deadbeef");

        db.Script("CREATE TABLE blobs (name TEXT, data BLOB)");
        const bin = new Bytes([0, 1, 2, 255, 0]);
        db.Execute("INSERT INTO blobs VALUES (?, ?)", ["zeros", bin]);

        const stored = db.Query("SELECT data, typeof(data) AS t, " +
                                "length(data) AS n FROM blobs")[0];
        eq("a Bytes is stored as a BLOB", stored.t, "blob");
        eq("with its zero bytes and all", stored.n, 5);
        check("and reads back equal", stored.data.Equals(bin), stored.data.ToHex());

        /* Empty is a BLOB of nothing and not NULL, which is the difference
         * between "there is no file" and "the file is empty". */
        db.Execute("INSERT INTO blobs VALUES (?, ?)", ["empty", new Bytes()]);
        const none = db.Query("SELECT data, typeof(data) AS t FROM blobs " +
                              "WHERE name = 'empty'")[0];
        eq("an empty Bytes is still a BLOB", none.t, "blob");
        eq("of no bytes", none.data.Length, 0);
        throws("SQL that does not parse", () => db.Query("SELEC 1"));
        throws("a Connection cannot be constructed", () => new Connection());

        /* QuickJS pads argv to the declared arity, so an omitted argument
         * arrives as `undefined` and would reach sqlite as the literal word --
         * `no such column: undefined`, a complaint about the wrong thing. */
        throws("Query with no statement",   () => db.Query());
        throws("Execute with no statement", () => db.Execute());
        throws("Columns with no table",     () => db.Columns());
        throws("Database.Sqlite with no path", () => Database.Sqlite());

        /* A column with no declared type is `''` and not NULL, which is the
         * case the text guard in Columns is really about. */
        db.Script("CREATE TABLE untyped (a TEXT, b)");
        eq("a column with no declared type has an empty type",
           db.Columns("untyped")[1].Type, "");

        /* Foreign keys are on: declaring a shape nothing enforces is pointless,
         * and sqlite leaves them off for compatibility with older files. */
        db.Script("CREATE TABLE orders (id INTEGER PRIMARY KEY, " +
                  "who INTEGER REFERENCES clients(id))");
        throws("a foreign key is enforced",
               () => db.Execute("INSERT INTO orders (who) VALUES (?)", [999]));

        /* --- transactions ------------------------------------------------- */

        db.Transaction(() => {
            db.Execute("UPDATE clients SET name = ? WHERE id = ?", ["Ana María", 1]);
        });
        eq("a transaction that returned commits",
           db.Query("SELECT name FROM clients WHERE id = 1")[0].name, "Ana María");

        let said = "";
        try {
            db.Transaction(() => {
                db.Execute("UPDATE clients SET name = ? WHERE id = ?", ["Perdida", 1]);
                /* Nested, through a savepoint: whoever wants a transaction is
                 * rarely whoever already has one. */
                db.Transaction(() => db.Execute("DELETE FROM clients WHERE id = 1"));
                throw new Error("me arrepentí");
            });
        } catch (e) {
            said = e.message;
        }
        eq("the throw that comes back is the program's, not the rollback's",
           said, "me arrepentí");

        /* Closing from inside a transaction is odd and reachable, and finishing
         * the unit of work on a handle that is gone used to be a dereference of
         * NULL rather than a sentence. */
        const other = Database.Sqlite(":memory:");
        throws("a connection closed inside its own transaction",
               () => other.Transaction(() => other.Close()));
        eq("a transaction that threw rolls back",
           db.Query("SELECT name FROM clients WHERE id = 1")[0].name, "Ana María");
        eq("...and takes the nested one with it",
           db.Query("SELECT count(*) AS n FROM clients")[0].n, 1);

        /* --- Table: the shape over the table ------------------------------ */

        const clients = db.Table("clients", Client);
        eq("a table knows its name",  clients.Name, "clients");
        eq("...and its shape",        clients.Shape, Client);

        /* PropertyInfo is what makes the mapping possible at all. */
        const blank = new Client();
        eq("PropertyInfo says what a field is called in a row",
           blank.PropertyInfo("PostalCode").Column, "postal_code");
        eq("...and which field is the identity",
           blank.PropertyInfo("Id").Key, true);
        eq("...and answers nothing for a name that is not a field",
           blank.PropertyInfo("Nope"), undefined);

        const c = new Client({ Name: "Ñanculeo, Ayelén", Balance: "9.005",
                               Since: "2026-08-24", PostalCode: "8300" });
        eq("an int key starts at 0, which is a row never saved", c.Id, 0);

        clients.Insert(c);
        eq("Insert tells the record its new key", c.Id, 2);
        eq("...through the setter, so it is a number", typeof c.Id, "number");

        /* A row is a file: nothing in Table converts a value. */
        const back = clients.Find(2);
        eq("a decimal comes back a Decimal",  back.Balance instanceof Decimal, true);
        eq("...at the field's own scale",     `${back.Balance}`, "9.01");
        eq("a boolean comes back a boolean",  typeof back.Active, "boolean");
        eq("a date comes back as it went in", back.Since, "2026-08-24");
        eq("a snake column fills a PascalCase field", back.PostalCode, "8300");
        eq("and a row that fits raises no complaints",
           JSON.stringify(back.Problems), "[]");

        /*
         * **The one thing sqlite cannot do, and it is stated as sqlite's
         * limitation rather than worked around.** A decimal is held as text,
         * because that is the standard type that keeps it exactly -- and text
         * compares byte by byte, so the *engine* cannot order or total such a
         * column. The file stays entirely standard and **the program filters and
         * orders**, which is what `examples/clients` does.
         */
        eq("the engine orders such a column by byte, which is not by value",
           db.Query("SELECT balance FROM clients ORDER BY balance")
             .map((r) => r.balance).join(" "), "16500.01 9.01");
        check("...and the program orders it by value, which is the answer",
              db.Query("SELECT balance FROM clients").map((r) => r.balance)
                .sort((a, b) => new Decimal(a, 2) - new Decimal(b, 2) < 0 ? -1 : 1)
                .join(" ") === "9.01 16500.01");
        db.Execute("CREATE INDEX clients_by_balance ON clients(balance)");
        check("an ordinary index on it is still an ordinary index", true);

        /*
         * **And naming the collation *in the statement* gives all of it back
         * with the file still portable**, because the schema stays plain TEXT
         * and only these queries mention it. This is the answer to "can I have
         * an exact decimal that orders and filters", and it is asserted so it
         * stays the answer.
         */
        db.Script("CREATE TABLE money2 (m TEXT)");
        for (const v of ["9.00", "10.00", "100.50", "-3.25"])
            db.Execute("INSERT INTO money2 VALUES (?)", [v]);

        eq("plain ORDER BY compares bytes",
           db.Query("SELECT m FROM money2 ORDER BY m").map((r) => r.m).join(" "),
           "-3.25 10.00 100.50 9.00");
        eq("...and COLLATE DECIMAL in the statement orders by value",
           db.Query("SELECT m FROM money2 ORDER BY m COLLATE DECIMAL")
             .map((r) => r.m).join(" "), "-3.25 9.00 10.00 100.50");
        eq("a plain comparison finds nothing",
           db.Query("SELECT count(*) AS n FROM money2 WHERE m > '9.00'")[0].n, 0);
        eq("...and with the collation it finds the two",
           db.Query("SELECT count(*) AS n FROM money2 " +
                    "WHERE m > '9.00' COLLATE DECIMAL")[0].n, 2);
        eq("MIN takes it as an expression",
           db.Query("SELECT MIN(m COLLATE DECIMAL) AS n FROM money2")[0].n,
           "-3.25");
        eq("...and MAX", 
           db.Query("SELECT MAX(m COLLATE DECIMAL) AS n FROM money2")[0].n,
           "100.50");
        eq("decimal_sum totals it exactly",
           db.Query("SELECT decimal_sum(m) AS n FROM money2")[0].n, "116.25");

        /* And it reaches through a Table, which appends the SQL it is given. */
        eq("a Table orders by value when the statement says so",
           clients.Where("1 = 1 ORDER BY balance COLLATE DECIMAL")
                  .map((c) => `${c.Balance}`).join(" "), "9.01 16500.01");
        eq("...and filters by value the same way",
           clients.Where("balance > ? COLLATE DECIMAL", "10.00").length, 1);

        /*
         * And the mismatch that would otherwise lose the exactness in silence.
         * `NUMERIC` and `DECIMAL(12,2)` are **affinities**, not types: a column
         * declared either turns `'19.90'` into the double `19.9`. Judged by
         * sqlite's own affinity rules, in sqlite's own order.
         */
        db.Script("CREATE TABLE numericky (id INTEGER PRIMARY KEY, name TEXT, " +
                  "balance NUMERIC, active INTEGER, since TEXT, " +
                  "postal_code TEXT)");
        throws("a decimal field over a NUMERIC column is refused",
               () => db.Table("numericky", Client).All());
        db.Script("CREATE TABLE inty (id INTEGER PRIMARY KEY, name TEXT, " +
                  "balance INTEGER, active INTEGER, since TEXT, " +
                  "postal_code TEXT)");
        throws("...and over an INTEGER one too",
               () => db.Table("inty", Client).All());

        eq("Find answers null for a key that is not there", clients.Find(99), null);
        eq("All reads the table",  clients.All().length, 2);
        eq("Where takes SQL, and anything after the filter goes with it",
           clients.Where("active = ? ORDER BY name", 1).length, 2);
        eq("Count answers a number and builds no records",
           clients.Count("id > ?", 1), 1);

        /* Save picks by the key rather than by a flag. */
        back.Name = "Cambiada";
        clients.Save(back);
        eq("Save updates a record that has a key",
           db.Query("SELECT name FROM clients WHERE id = 2")[0].name, "Cambiada");
        const fresh = clients.Save(new Client({ Name: "Nueva" }));
        eq("...and inserts one whose key is still at 0", fresh.Id, 3);

        /*
         * A column the shape says nothing about survives the round trip, and
         * here that earns its keep twice: reading, keeping and writing it back
         * is what stops the first program that saves a row from emptying it.
         */
        db.Execute("UPDATE clients SET note = ? WHERE id = ?", ["de otro", 2]);
        const kept = clients.Find(2);
        kept.Name = "Otra vez";
        clients.Save(kept);
        eq("a column the shape does not describe is written back",
           db.Query("SELECT note FROM clients WHERE id = 2")[0].note, "de otro");

        clients.Delete(fresh);
        eq("Delete removes it", clients.Count(), 2);

        /* --- what Table refuses ------------------------------------------- */

        throws("a record of another shape",
               () => clients.Save(new Coded({ Code: "A" })));
        throws("Find with the wrong number of key values",
               () => clients.Find(1, 2));
        throws("an Update that matched no row -- a save that saved nothing",
               () => clients.Update(new Client({ Id: 77, Name: "Nadie" })));
        throws("a Delete that matched no row",
               () => clients.Delete(new Client({ Id: 77, Name: "Nadie" })));
        throws("a Table over something that is not a connection",
               () => new Table({}, "clients", Client));
        throws("a Table over something that is not a Record",
               () => db.Table("clients", Date));

        /*
         * **The four ways a shape can fail to fit a table**, checked once on the
         * first statement. The third is the one this check exists for: SQL
         * identifiers are case-insensitive, so `Code` against a column `code`
         * writes perfectly and reads *empty* -- the values land in the bag of
         * keys the shape does not describe, nothing throws, and the first thing
         * anybody notices is a form full of blanks.
         */
        throws("a shape with a nested field, which is a table of its own",
               () => db.Table("clients", Detailed).All());
        throws("a field with no column at all",
               () => db.Table("coded", MissingColumn).All());
        throws("a column spelled with another case",
               () => db.Table("coded", MisCased).All());
        throws("a table that is not there",
               () => db.Table("nadie", Coded).All());

        /* A shape with no key can be *read* and not written: identity is what an
         * UPDATE needs, and an UPDATE with no WHERE is not a fallback. */
        eq("a shape with no key reads", db.Table("clients", NoKeyed).All().length, 2);
        throws("...and does not write",
               () => db.Table("clients", NoKeyed).Save(new NoKeyed({ Name: "x" })));

        /*
         * A key the *program* chooses is never at its starting value once it is
         * filled, so `Save` tries to update a row that is not there and says so.
         * `Insert` is the one that means it.
         */
        const coded = db.Table("coded", Coded);
        throws("Save on a chosen key that is not in the table yet",
               () => coded.Save(new Coded({ Code: "ABC", What: "algo" })));
        coded.Insert(new Coded({ Code: "ABC", What: "algo" }));
        eq("Insert writes a chosen key as any other column",
           coded.Find("ABC").What, "algo");

        /* Nothing is pasted into a statement, ever. */
        eq("a value that reads like SQL is a value",
           clients.Where("name = ?", "O'Brien\"; DROP TABLE clients --").length, 0);
        eq("...and the table is still there", clients.Count(), 2);

        /* Load is lenient from a row exactly as it is from a file: a value
         * today's rules refuse costs that column and goes on Problems. */
        db.Execute("UPDATE clients SET postal_code = ? WHERE id = ?",
                   ["demasiado largo", 2]);
        const bad = clients.Find(2);
        check("a column today's rules refuse lands on Problems",
              bad.Problems.some((p) => p.includes("PostalCode")),
              JSON.stringify(bad.Problems));
        eq("...and costs that column and no other", bad.Name, "Otra vez");

        /* --- decimals held as text, which is somebody else's schema -------
         *
         * **This is the import path and not how a `Table` stores anything.** A
         * decimal of ours is an integer of units, for the reason asserted
         * above. But a database written by another program may well hold its
         * money as text, and `Query` + `Record.Load` reads that -- so the
         * collation and the aggregate exist for it.
         *
         * `TEXT COLLATE DECIMAL` in a schema is the thing **not** to write: it
         * makes the file unusable by any client that has not registered the
         * collation. It is used here because this is what the collation is for.
         */
        db.Script(`CREATE TABLE money (
                       priced TEXT COLLATE DECIMAL, plain TEXT)`);
        for (const v of ["9.00", "10.00", "100.5", "2", "-3.25", "19.9", "19.90"])
            db.Execute("INSERT INTO money VALUES (?, ?)", [v, v]);

        eq("TEXT on its own sorts by byte, which is the problem",
           db.Query("SELECT plain FROM money ORDER BY plain")
             .map((r) => r.plain).join(" "),
           "-3.25 10.00 100.5 19.9 19.90 2 9.00");
        eq("COLLATE DECIMAL sorts by value",
           db.Query("SELECT priced FROM money ORDER BY priced")
             .map((r) => r.priced).join(" "),
           "-3.25 2 9.00 10.00 19.9 19.90 100.5");
        eq("MIN uses the column's collation too",
           db.Query("SELECT MIN(priced) AS n FROM money")[0].n, "-3.25");
        eq("...and a comparison against a literal",
           db.Query("SELECT count(*) AS n FROM money WHERE priced > '9.00'")[0].n,
           4);
        eq("19.9 and 19.90 are one number written two ways",
           db.Query("SELECT count(DISTINCT priced) AS n FROM money")[0].n, 6);

        /*
         * `SUM` and `AVG` are arithmetic and not comparison, so the collation
         * cannot reach them. **And the reason is not that a small total loses a
         * cent** -- sqlite has Kahan-summed REAL since 3.44, so those usually
         * come out right, which makes them worse to rely on. The reasons are
         * that the answer is a REAL, so the scale is gone and it re-enters the
         * program as a double rather than a Decimal; and that past 2^53 a
         * double cannot tell whole numbers apart at all.
         */
        eq("decimal_sum answers text, at the widest scale it saw",
           db.Query("SELECT decimal_sum(priced) AS n FROM money")[0].n, "158.05");
        eq("...which reads back into a Decimal exactly",
           `${new Decimal(db.Query("SELECT decimal_sum(priced) AS n FROM money")[0].n, 2)}`,
           "158.05");
        eq("while SUM answers a number, and the scale is gone",
           typeof db.Query("SELECT SUM(priced) AS n FROM money")[0].n, "number");

        db.Script("CREATE TABLE big (v TEXT COLLATE DECIMAL)");
        db.Execute("INSERT INTO big VALUES (?)", ["9007199254740993.00"]);
        db.Execute("INSERT INTO big VALUES (?)", ["0.01"]);
        eq("past 2^53 a double loses the unit as well as the cent",
           `${db.Query("SELECT SUM(v) AS n FROM big")[0].n}`, "9007199254740992");
        eq("...and decimal_sum does not",
           db.Query("SELECT decimal_sum(v) AS n FROM big")[0].n,
           "9007199254740993.01");

        eq("decimal_cmp answers the same order as a value",
           `${db.Query("SELECT decimal_cmp('9.00','10.00') AS a, " +
                       "decimal_cmp('19.9','19.90') AS b")[0].a}` +
           `${db.Query("SELECT decimal_cmp('9.00','10.00') AS a, " +
                       "decimal_cmp('19.9','19.90') AS b")[0].b}`,
           "-10");

        /*
         * **A window function and not only an aggregate**, because every one of
         * sqlite's own thirty-three is (`pragma_function_list` says `type='w'`
         * for all of them) and the first version of this was not: a running
         * total down a column of amounts is most of what a report is.
         */
        eq("decimal_sum is registered as a window function",
           db.Query("SELECT type FROM pragma_function_list " +
                    "WHERE name = 'decimal_sum'")[0].type, "w");

        db.Script("CREATE TABLE runs (id INTEGER PRIMARY KEY, " +
                  "v TEXT COLLATE DECIMAL)");
        for (const v of ["100.00", "50.25", "0.75", "-10.00"])
            db.Execute("INSERT INTO runs (v) VALUES (?)", [v]);

        eq("a running total is exact where a double loses the scale",
           db.Query("SELECT decimal_sum(v) OVER (ORDER BY id) AS a, " +
                    "sum(v) OVER (ORDER BY id) AS d FROM runs")
             .map((r) => `${r.a}/${r.d}`).join(" "),
           "100.00/100 150.25/150.25 151.00/151 141.00/141");

        /* A moving frame is what exercises xInverse -- values leaving the
         * accumulator, which is why `bad` is a count and not a flag. */
        eq("a moving frame takes values back out again",
           db.Query("SELECT decimal_sum(v) OVER (ORDER BY id " +
                    "ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS w FROM runs")
             .map((r) => r.w).join(" "),
           "100.00 150.25 51.00 -9.25");
        eq("and it is still an ordinary aggregate",
           db.Query("SELECT decimal_sum(v) AS n FROM runs")[0].n, "141.00");
        eq("...with FILTER, which comes free",
           db.Query("SELECT decimal_sum(v) FILTER (WHERE v > '0') AS n " +
                    "FROM runs")[0].n, "151.00");
        eq("...and PARTITION BY",
           db.Query("SELECT decimal_sum(v) OVER (PARTITION BY v > '0') AS n " +
                    "FROM runs ORDER BY v")[0].n, "-10.00");

        /*
         * The whole family that orders rather than adds is correct for nothing
         * extra, because an `OVER` clause's `ORDER BY` uses the column's
         * collation exactly as a statement's does.
         */
        eq("rank and lag follow the column's collation",
           db.Query("SELECT v, rank() OVER (ORDER BY v) AS r FROM runs")
             .map((r) => `${r.v}=${r.r}`).join(" "),
           "-10.00=1 0.75=2 50.25=3 100.00=4");

        /* group_concat's own ORDER BY (sqlite 3.44 and later) uses it too. */
        eq("an aggregate's internal ORDER BY uses it as well",
           db.Query("SELECT group_concat(v ORDER BY v) AS n FROM runs")[0].n,
           "-10.00,0.75,50.25,100.00");

        /*
         * A column that is not all decimals. The collation still has to be a
         * *total* order -- sqlite builds indexes with it -- so text that is not
         * a decimal sorts after everything that is, rather than the sort being
         * refused because one row is wrong.
         */
        db.Execute("INSERT INTO money VALUES (?, ?)", ["hola", "hola"]);
        eq("a non-decimal sorts after every decimal",
           db.Query("SELECT priced FROM money ORDER BY priced")
             .map((r) => r.priced).join(" "),
           "-3.25 2 9.00 10.00 19.9 19.90 100.5 hola");
        throws("...and decimal_sum refuses it rather than skipping it",
               () => db.Query("SELECT decimal_sum(priced) AS n FROM money"));
        eq("no rows at all is null and not zero, as SUM answers",
           db.Query("SELECT decimal_sum(priced) AS n FROM money WHERE 0")[0].n,
           null);

        db.Close();
        eq("Close closes it", db.Open, false);
        throws("using it afterwards", () => db.Query("SELECT 1"));
        db.Close();
        check("closing twice is not an error", true);
    }

    /* --- CheckButton, and what a Group makes of it ------------------------ */

    /*
     * One control, two things: a box one ticks, and one of a set. `Group` is
     * what says which, and that is the whole of the difference -- there is no
     * RadioButton class here because there is none in GTK4 either, where a radio
     * *is* a check button that belongs to a group.
     *
     * So what is under test is the grouping: which of them turn each other off,
     * and which mind their own business. The shape they are drawn in follows
     * from the same grouping and is checked by hand -- a circle and a square are
     * not something JS can ask about.
     */
    testGroups() {
        const box = new Panel();
        this.Fixed1.Add(box);
        box.Name = "GroupBox";

        const put = (parent, name, text, group) => {
            const b = new CheckButton();
            parent.Add(b);
            b.Name = name;
            b.Text = text;
            if (group !== undefined) b.Group = group;
            return b;
        };

        /* --- with no group, they are boxes one ticks ----------------------
         *
         * The assertion that says what unifying the two controls means: a row of
         * check buttons in one container is a row of independent ticks, and the
         * container alone does *not* make a set. The old RadioButton grouped by
         * container with nothing declared, which cannot survive one class -- it
         * would turn every row of tick boxes into a set of choices.
         */
        const one = put(box, "C1", "uno");
        const two = put(box, "C2", "dos");

        eq("Text round-trip", one.Text, "uno");
        /*
         * **`Active` and not `Value`**, which is GTK's own name for it and the
         * one that reads right in context: `if (this.ChkCase.Active)` says
         * something, `.Value` of a tick says nothing. The line is drawn at what
         * the property *is* -- `Active` where it is on or off, `Value` where
         * there is a number or a string: a `Slider`, a `SpinBox`, a `DatePicker`
         * all keep theirs.
         */
        check("the state is Active", one.PropertyNames().includes("Active"));
        check("and there is no Value beside it to get wrong",
              !one.PropertyNames().includes("Value"),
              JSON.stringify(one.PropertyNames()));

        eq("a check button starts off", one.Active, false);
        eq("and belongs to no set", one.Group, "");

        one.Active = true;
        two.Active = true;
        eq("two of them in one container are two ticks", one.Active, true);
        eq("...and both can be on at once",              two.Active, true);

        /* --- a name makes a set -------------------------------------------- */
        const a = put(box, "R1", "a", "sexo");
        const b = put(box, "R2", "b", "sexo");
        const c = put(box, "R3", "c", "sexo");

        eq("Group round-trip", a.Group, "sexo");

        a.Active = true;
        eq("turning one on", a.Active, true);
        b.Active = true;
        eq("turns off the others of its set", a.Active, false);
        eq("and leaves the chosen one on",    b.Active, true);
        eq("the one nobody chose was never on", c.Active, false);
        eq("while a tick beside them is untouched", one.Active, true);

        /* Two sets in one container is what a second name is for. */
        const other = put(box, "R4", "otro", "second");
        other.Active = true;
        eq("another name in the same container is another set", b.Active, true);
        eq("and answers for itself",                            other.Active, true);

        /* --- and the container still scopes the name ----------------------- */
        const box2 = new Panel();
        this.Fixed1.Add(box2);
        box2.Name = "GroupBox2";

        const d = put(box2, "R5", "otra caja", "sexo");
        d.Active = true;
        eq("the same name in another container is another set", b.Active, true);

        /*
         * And moving one takes it out of the set it was in. Turning it on must
         * not reach back into a container it left -- which is what one still
         * linked into its old chain would do.
         */
        const moved = put(box, "R6", "movido", "sexo");
        moved.Remove();
        box2.Add(moved);
        moved.Active = true;
        eq("one that moved leaves its old set alone", b.Active, true);
        eq("and joins the one it moved into",         d.Active, false);

        /* --- and a set can be left -----------------------------------------
         *
         * Which is also the case that found a cycle: this runs a regroup over a
         * container whose set already has a head leading its own anchor, and
         * re-grouping that head inside its own list closed the chain into a
         * ring. The symptom was a click that never returned.
         */
        const leaving = put(box, "R7", "se va", "sexo");
        leaving.Active = true;
        eq("it took the set", b.Active, false);

        leaving.Group = "";
        eq("clearing the name leaves the set", leaving.Group, "");
        b.Active = true;
        eq("so the set no longer speaks for it", leaving.Active, true);
        box.Delete();
        box2.Delete();
    }

    /* --- what the desktop knows about a file, and being told it changed ----
     *
     * `Info` is one trip through the filesystem for five answers, and the two
     * that are not obvious are the ones worth having: the content type, which
     * is a value one can test against, and the icon name, which is what a file
     * tree otherwise writes a table of guesses for.
     */
    testFileInfo() {
        const js  = File.Join(Application.Directory, "WidgetsForm.js");
        const png = File.Join(Application.Directory, "images", "wide.png");

        const info = File.Info(js);
        check("a file has an info", info !== null);
        check("with its size",      info.Size > 1000, `${info.Size}`);
        eq("whether it is a folder", info.IsDir, false);
        eq("what kind of file it is", info.Type, "text/javascript");

        /* A moment, and every question one asks of it is a comparison `Date`
         * already does. */
        check("and when it was last written", info.Modified instanceof Date);
        check("which is in the past", info.Modified.getTime() <= Date.now() + 1000);

        /*
         * **To the millisecond, which is what a Date is.** Truncated to the
         * second -- what this returned at first -- every save inside one second
         * is the same instant, and anything comparing a file against what it
         * read a moment ago sees no change at all.
         *
         * Asked of the value and not of two writes: two `File.Save` calls in a
         * row really do land in the same millisecond, so a difference between
         * them would be the flaky half of this. A truncated clock lands on
         * `.000` every time; a real one does so once in a thousand, and five
         * times over is not something to wait for.
         */
        Directory.Make(SCRATCH);
        const stamp = File.Join(SCRATCH, "stamp.txt");
        let subsecond = false;

        for (let i = 0; i < 5 && !subsecond; i++) {
            File.Save(stamp, `${i}`);
            subsecond = File.Info(stamp).Modified.getTime() % 1000 !== 0;
        }
        check("the time it says is not truncated to the second", subsecond,
              `${File.Info(stamp).Modified.getTime()}`);
        File.Delete(stamp);

        const shot = File.Info(png);
        eq("a PNG says so",       shot.Type, "image/png");
        check("and offers an icon the desktop really has",
              shot.Icon !== "" && Application.HasIcon(shot.Icon), shot.Icon);

        const dir = File.Info(Application.Directory);
        eq("a folder says it is one", dir.IsDir, true);

        /* Absent is an ordinary state: asking about a file that is not there is
         * how one finds out that it is not there. */
        eq("and what is not there answers nothing",
           File.Info(File.Join(Application.Directory, "no-such-file")), null);

        /* --- copying, which Load and Save cannot do ---------------------- */
        const copy = File.Join(SCRATCH, "copied.png");
        Directory.Make(SCRATCH);
        if (File.Exists(copy)) File.Delete(copy);

        File.Copy(png, copy);
        eq("a copy is the same file, byte for byte",
           File.Info(copy).Size, File.Info(png).Size);
        eq("...and still an image", File.Info(copy).Type, "image/png");
        throws("copying over something is refused", () => File.Copy(png, copy));
        File.Delete(copy);

        /* --- and handing one to the desktop ------------------------------
         *
         * `File.Open` answers before the file is open: launching is
         * asynchronous and the program that opens it is somebody else's, so
         * what it promises is that the request was made. The one failure a
         * caller can do something about -- there is no such file -- is refused
         * here; anything after that goes to the log, named.
         */
        let refused = false;
        try { File.Open(js); } catch (e) { refused = true; }
        eq("opening a file that is there is not refused", refused, false);

        throws("one that is not there is",
               () => File.Open(File.Join(Application.Directory, "no-such-file")));
        throws("and so is asking for nothing", () => File.Open());
    }

    /* --- being told a file changed ---------------------------------------- */
    testFileWatch() {
        Directory.Make(SCRATCH);
        const path = File.Join(SCRATCH, "watched.txt");
        if (File.Exists(path)) File.Delete(path);
        File.Save(path, "uno\n");

        this.watched = [];
        const watch = File.Watch(path, (event, where) => {
            this.watched.push(`${event} ${File.Name(where)}`);
        });

        eq("a watch says what it is watching", watch.Path, path);
        check("and can be stopped", typeof watch.Stop === "function");

        File.Save(path, "dos\n");

        until("the change is reported", () => this.watched.length > 0, () => {
            /*
             * **One event for one save.** A write is a burst -- changed while
             * the bytes go out, then done -- and only the settled one is
             * reported, or anything listening would react to a file that is
             * briefly half there.
             */
            eq("a save is reported once", this.watched.length, 1);
            eq("as a change to that file", this.watched[0], "Changed watched.txt");

            File.Delete(path);
            until("the deletion is reported too",
                  () => this.watched.length > 1, () => {
                eq("going away is news of its own",
                   this.watched[1], "Deleted watched.txt");

                /* And stopping really stops: the file comes back and nothing
                 * is said about it. */
                watch.Stop();
                File.Save(path, "tres\n");

                Timer.After(200, () => {
                    eq("a stopped watch says nothing more", this.watched.length, 2);
                    File.Delete(path);
                    this.watchStopsItself();
                });
            });
        });
    }

    /*
     * **A watch stopped from inside its own callback.**
     *
     * Not an exotic thing to do and not a stress test: an editor told that its
     * file changed underneath reloads it, and reloading means watching the new
     * file instead -- so `Stop` runs with the callback still on the stack, one
     * frame down. `examples/notes` does exactly that, which is where this was
     * found, and doing it was a **segfault**: the job was freed and then read
     * back by the lines after the call, inside the file monitor's own signal
     * emission.
     *
     * Two things are asserted, and the first is only that the process is still
     * here to assert the second.
     */
    watchStopsItself() {
        const path = File.Join(SCRATCH, "restarted.txt");
        File.Save(path, "uno\n");

        const said = [];
        let   watch = File.Watch(path, (event) => {
            said.push(event);
            watch.Stop();                       /* from inside its own callback */
            watch = File.Watch(path, (e) => said.push(`again ${e}`));
        });

        File.Save(path, "dos\n");

        until("the watch that restarts itself reports", () => said.length > 0, () => {
            check("stopping from inside the callback does not take the process down",
                  true);
            eq("the first watch reported once", said[0], "Changed");

            /* And the one it started in its place is a working watch, not a
             * handle onto something already freed. */
            File.Save(path, "tres\n");
            until("the watch it started in its place reports too",
                  () => said.length > 1, () => {
                eq("and it is the new one talking", said[1], "again Changed");
                watch.Stop();
                File.Delete(path);
            });
        });
    }

    /* --- a photograph, which is not an icon --------------------------------
     *
     * `Image` draws an icon at its natural size and refuses to scale, which is
     * right for an icon and useless for a photograph. `Picture` is the other
     * one, and `Fit` is the whole of the difference between showing an image
     * and showing it well.
     */
    testPicture() {
        const dir = File.Join(Application.Directory, "images");
        const pic = new Picture();
        this.Fixed1.Add(pic);
        pic.Name = "Pic1";
        pic.Resize(200, 120);

        eq("a fresh picture holds nothing", pic.File, "");
        eq("and says so about its size",    pic.SourceWidth, 0);

        pic.File = File.Join(dir, "wide.png");
        eq("File round-trip", pic.File, File.Join(dir, "wide.png"));

        /* What the file really is, which is not what the control is: a viewer
         * needs both to say "120 x 80" and to decide what to offer. */
        eq("the source's own width",  pic.SourceWidth, 120);
        eq("and its own height",      pic.SourceHeight, 80);
        eq("while the control is the size it was given", pic.Width, 200);

        check("neither is settable, being facts about the file",
              !pic.PropertyNames().includes("SourceWidth"),
              JSON.stringify(pic.PropertyNames()));

        eq("it letterboxes by default", pic.Fit, "Contain");
        for (const fit of ["Fill", "Cover", "ScaleDown", "Contain"]) {
            pic.Fit = fit;
            eq(`Fit round-trips as ${fit}`, pic.Fit, fit);
        }
        throws("and nothing else", () => { pic.Fit = "Squash"; });
        eq("what it accepts is published",
           JSON.stringify(pic.PropertyOptions("Fit")),
           '["Fill","Contain","Cover","ScaleDown"]');

        /* Another file replaces what is shown, dimensions and all. */
        pic.File = File.Join(dir, "tall.png");
        eq("a second file is measured too", pic.SourceHeight, 140);

        /*
         * **A path that is not an image throws**, which is the point of loading
         * through a texture rather than handing the name to GTK: the alternative
         * is an empty frame and no way to tell a missing file from a corrupt one
         * from a text file with a picture's name.
         */
        throws("a file that does not exist says so",
               () => { pic.File = File.Join(dir, "nope.png"); });
        throws("and one that is not an image either",
               () => { pic.File = File.Join(Application.Directory, "project.json"); });
        eq("and the last good one is still shown", pic.SourceHeight, 140);

        pic.File = "";
        eq("clearing it empties the frame", pic.File, "");
        eq("and there is nothing left to measure", pic.SourceWidth, 0);

        /*
         * --- the same picture, out of memory ---------------------------------
         *
         * The circle `Http` and `File.LoadBytes` left open: both answer `Bytes`,
         * and until this the only thing that could *show* one wanted a path, so
         * "download it and show it" meant a temporary file written and deleted
         * around the control that would rather have been handed the bytes.
         *
         * A verb and not a property on purpose: a property here is a promise
         * that the designer can edit it and the `.form` can carry it, and a
         * megabyte of JPEG is neither.
         */
        const bytes = File.LoadBytes(File.Join(dir, "wide.png"));

        pic.LoadBytes(bytes);
        eq("bytes are measured like a file",  pic.SourceWidth, 120);
        eq("in both directions",              pic.SourceHeight, 80);
        eq("and no file is claimed for them", pic.File, "");
        check("so nothing about them reaches the .form",
              !("File" in pic.Serialize().properties),
              JSON.stringify(pic.Serialize().properties));
        check("...and it stays a verb, which is why",
              !pic.PropertyNames().includes("LoadBytes"),
              JSON.stringify(pic.PropertyNames()));

        /* The last source wins, whichever way round. */
        pic.File = File.Join(dir, "tall.png");
        eq("a file after bytes replaces them", pic.SourceHeight, 140);
        pic.LoadBytes(bytes);
        eq("and bytes after a file replace it", pic.SourceHeight, 80);
        eq("with the name gone, not left lying", pic.File, "");

        throws("bytes that are not an image are refused",
               () => { pic.LoadBytes(new Bytes("this is not a picture")); });
        throws("and so are none at all",
               () => { pic.LoadBytes(new Bytes()); });
        throws("and a path, which is the other verb's",
               () => { pic.LoadBytes(File.Join(dir, "wide.png")); });
        eq("none of which disturbed what is shown", pic.SourceHeight, 80);

        pic.File = "";

        pic.File = File.Join(dir, "small.png");
        pic.Fit  = "Cover";
        eq("what it shows is saved",  pic.Serialize().properties.File,
           File.Join(dir, "small.png"));
        eq("and how it is fitted too", pic.Serialize().properties.Fit, "Cover");

        /* The default stays out, like every other property equal to a fresh
         * control's -- a `.form` says what was decided, not what was left. */
        pic.Fit = "Contain";
        check("...but the default is left out",
              !("Fit" in pic.Serialize().properties),
              JSON.stringify(pic.Serialize().properties));

        /* --- Zoom: the room's business, or one's own ----------------------
         *
         * `Fit` answers "what do I do with the space I was given"; `Zoom`
         * answers "give me the space I want". Inside a `Scroller` the second is
         * the one a viewer drives -- and a viewer's *fit to window* is a zoom it
         * works out from the room, which is what every image viewer does and why
         * `SourceWidth` is published.
         *
         * **Last in this test, and everything it touches is deleted inside the
         * wait.** Written above the assertions that follow it, the picture was
         * cleared and deleted by the time the frame arrived, and what the wait
         * then measured was a control with no file in a container with no
         * children -- which reads exactly like a broken zoom.
         */
        eq("a picture is the room's business by default", pic.Zoom, 0);
        throws("and a negative zoom is refused", () => { pic.Zoom = -1; });
        pic.Delete();

        /*
         * A picture of its own, with no declared size: `Width` is a *minimum*
         * here as everywhere, so a control drawn 200 wide never shows a zoom
         * smaller than that -- which is the trap a viewer walks into if it sets
         * both. A viewer sets the zoom and lets the picture be the size the zoom
         * makes it.
         */
        const zoomed = new Picture();
        zoomed.File = File.Join(dir, "wide.png");
        zoomed.Zoom = 2;
        eq("Zoom round-trip", zoomed.Zoom, 2);

        const scroller = new Scroller();
        this.Fixed1.Add(scroller);
        scroller.Move(0, 0);
        scroller.Resize(300, 200);
        scroller.Add(zoomed);

        until("the zoomed picture is laid out",
              () => zoomed.Bounds().Width > 0, () => {
            eq("zoom 2 draws it twice its own size", zoomed.Bounds().Width, 240);
            eq("...on both axes",                    zoomed.Bounds().Height, 160);

            /* And the next file is measured afresh: a viewer showing a second
             * image at the first one's size is the bug this guards. */
            zoomed.File = File.Join(dir, "tall.png");
            until("the second one is laid out",
                  () => zoomed.Bounds().Width === 120, () => {
                eq("another file at the same zoom is its own size times it",
                   `${zoomed.Bounds().Width}x${zoomed.Bounds().Height}`, "120x280");

                zoomed.Zoom = 0;
                eq("and zero puts it back under Fit's control", zoomed.Zoom, 0);
                scroller.Delete();
            });
        });
    }

    /* --- Video and AudioPlayer ----------------------------------------------
     *
     * Playback over GStreamer, one playbin3 per player. The Video widget shows
     * its frames through the gtk4paintablesink in a GtkPicture; an
     * AudioPlayer is the same pipeline with the video branch off and no
     * window.
     *
     * **What they play is generated, not committed.** A second of test
     * pattern and a third of a second of silence, made with `gst-launch-1.0`
     * into a temporary directory -- the TLS certificate's bargain, for the
     * same two reasons: a fixture nobody can regenerate is a fixture nobody
     * can change, and a tree with media files in it grows them. No
     * `gst-launch` skips the parts that need a file; no GTK4 sink skips the
     * video half and still runs the audio one, which is what a machine with
     * only GStreamer's base plugins has (CI included).
     *
     * A container of its own, per the tab-order trap: what other tests left
     * in Fixed1 is none of this test's business.
     */
    testMedia() {
        /* Whether there is an engine at all, asked of the one thing that
         * answers it without a pipeline, a clip or a plugin: the constructor
         * of an AudioPlayer, which is where a build without GStreamer
         * refuses. Probing with `Play()` cannot say it -- the refusal for a
         * player with no Uri and the refusal for a runtime with no GStreamer
         * are both throws, and a machine with the base plugins but no GTK4
         * sink throws a third thing. */
        let hasGst = true;
        let refusal = "";

        try {
            new AudioPlayer();
        } catch (e) {
            hasGst  = false;
            refusal = e.message;
        }

        if (!hasGst) {
            /*
             * Without the engine the *verbs* refuse and the properties
             * answer, which is not a nicety: the designer reads every value
             * of a selected control and the serialiser reads them all again
             * to save, so a getter that threw made a runtime with no
             * GStreamer one that could not draw a form with a Video in it --
             * or load one, since a declared `Uri` is assigned like any other.
             */
            const v = new Video();

            check("the missing package is named", /GStreamer/.test(refusal), refusal);
            throws("and the audio spelling refuses again", () => { new AudioPlayer(); });

            v.Uri     = "clip.mp4";
            v.Volume  = 0.5;
            v.Latency = 300;
            v.Loop    = true;

            /* With somewhere to go, so what refuses is the engine and not the
             * missing Uri: the message has to be the one that names the
             * package. */
            let said = "";

            try {
                v.Play();
            } catch (e) {
                said = e.message;
            }
            check("Play names the package too", /GStreamer/.test(said), said);
            said = "";
            try {
                v.Seek(1);
            } catch (e) {
                said = e.message;
            }
            check("and so does Seek", /GStreamer/.test(said), said);
            /* Save refuses for want of a frame, which is the truth here: with
             * no engine there is never going to be one. */
            throws("and Save has no frame to write",
                   () => { v.Save(File.Join(Environment.TempDirectory, "bta-no.png")); });
            eq("but Uri is kept, so a .form still loads", v.Uri, "clip.mp4");
            eq("and Volume with it",  v.Volume, 0.5);
            eq("and Latency",         v.Latency, 300);
            eq("and Loop",            v.Loop, true);
            eq("nothing is playing",  v.Playing, false);
            eq("nothing is seekable", v.Seekable, false);
            eq("no length either",    v.Duration, -1);
            eq("and nothing is ever waited for", v.Buffering, 100);
            eq("and no frame to measure", v.SourceWidth, 0);
            eq("what it shows is saved", v.Serialize().properties.Uri, "clip.mp4");
            eq("the control is still placeable",
               Widget.New("Video").CssNode(), "picture");
            return;
        }

        const box = new Panel();
        this.Fixed1.Add(box);
        box.Move(0, 0);
        box.Resize(340, 200);

        const v = new Video();
        box.Add(v);
        v.Name = "MediaVid";
        v.Resize(320, 180);

        eq("a fresh video holds nothing", v.Uri, "");
        eq("no identity either",          v.User, "");
        eq("and the password never reads back", v.Password, "");
        eq("rtspsrc's own jitterbuffer default", v.Latency, 2000);
        eq("full volume",  v.Volume, 1);
        eq("unmuted",      v.Muted, false);
        eq("no loop",      v.Loop, false);
        eq("letterboxes by default", v.Fit, "Contain");
        eq("nothing playing",        v.Playing, false);
        eq("nowhere to be",          v.Position, 0);
        eq("a live length until something loads", v.Duration, -1);
        eq("nothing seekable either", v.Seekable, false);
        eq("nothing to wait for",     v.Buffering, 100);
        eq("and no frame to measure yet", v.SourceWidth, 0);
        eq("nor a height",                v.SourceHeight, 0);
        eq("the event a double click writes", v.EventNames()[0], "Ended");
        eq("what Fit accepts is published",
           JSON.stringify(v.PropertyOptions("Fit")),
           '["Fill","Contain","Cover","ScaleDown"]');

        throws("Play with nowhere to go", () => { v.Play(); });
        throws("Volume past full",        () => { v.Volume = 2; });
        throws("Volume in words",         () => { v.Volume = "loud"; });
        eq("the refused volume did not stick", v.Volume, 1);
        throws("a negative Latency",      () => { v.Latency = -1; });
        throws("Fit in words of its own", () => { v.Fit = "Squash"; });
        throws("Seek with nothing loaded", () => { v.Seek(1); });
        throws("Save with nothing decoded",
               () => { v.Save(File.Join(Environment.TempDirectory, "bta-no-frame.png")); });

        v.Fit = "Cover";
        eq("Fit round-trips", v.Fit, "Cover");
        v.Fit = "Contain";

        /* Write-only on purpose: a password that read back would be
         * serialised into the .form in clear text on the next save. */
        v.Password = "s3cret";
        check("the secret stays out of the file",
              !("Password" in v.Serialize().properties),
              JSON.stringify(v.Serialize().properties));

        /* The declarative half, which is where a Video actually comes from:
         * a node with the properties a .form would carry, applied by the same
         * loader, and serialised back to the same thing. */
        const declared = box.AddNode({
            type: "Video", name: "MediaDeclared",
            properties: { Uri: "camera.mp4", Fit: "Cover", Loop: true, Volume: 0.5 },
        });

        eq("a declared Uri arrives",  declared.Uri, "camera.mp4");
        eq("a declared Fit with it",  declared.Fit, "Cover");
        eq("and a declared Loop",     declared.Loop, true);
        eq("what came from the file goes back to it",
           JSON.stringify(declared.Serialize().properties),
           '{"Fit":"Cover","Loop":true,"Uri":"camera.mp4","Volume":0.5}');
        declared.Delete();

        /*
         * The clips. Generated once per run into the temporary directory, and
         * skipped -- never failed -- where there is no gst-launch to make
         * them with.
         */
        const dir = File.Join(Environment.TempDirectory,
                              `bintana-media-${Environment.ProcessId}`);
        const clip = File.Join(dir, "short.ogv");
        const cue  = File.Join(dir, "short.wav");
        let   made = Application.HasCommand("gst-launch-1.0");

        if (made) {
            Directory.Make(dir);
            /* A second of 160x120 Theora in Ogg, and a third of a second of
             * silence in WAV: both decode with GStreamer's base plugins
             * alone, which is the point of choosing them. */
            const video = Exec.Wait(["gst-launch-1.0", "-q",
                                     "videotestsrc", "num-buffers=30", "!",
                                     "video/x-raw,width=160,height=120,framerate=30/1", "!",
                                     "theoraenc", "!", "oggmux", "!",
                                     "filesink", `location=${clip}`], { Timeout: 30000 });
            const audio = Exec.Wait(["gst-launch-1.0", "-q",
                                     "audiotestsrc", "num-buffers=16", "wave=silence", "!",
                                     "audioconvert", "!", "wavenc", "!",
                                     "filesink", `location=${cue}`], { Timeout: 30000 });

            made = video.ExitCode === 0 && audio.ExitCode === 0 &&
                   File.Exists(clip) && File.Exists(cue);
            if (!made)
                print(`  (skipping the clips: gst-launch exited ${video.ExitCode}/${audio.ExitCode})`);
        } else {
            print("  (skipping the clips: they need gst-launch-1.0 to be made)");
        }

        if (!made) {
            v.Delete();
            this.mediaBadPhase(box);
            return;
        }

        v.Uri = clip;
        eq("a path is taken as a path", v.Uri, clip);
        eq("what it shows is saved", v.Serialize().properties.Uri, clip);

        /*
         * A machine with GStreamer's base plugins and no gst-plugins-rs has
         * no GTK4 sink, so there is nowhere to put the frames -- which is
         * exactly the shape CI has, and the audio half is unaffected.
         *
         * The rule is the invariant rather than the wording: a *throw* out of
         * Play means the pipeline could not be built (a missing element,
         * named), and anything that goes wrong while playing arrives as an
         * Error event instead. So any throw here skips the video half and
         * says why, whichever element it was.
         */
        let started = true;

        try {
            v.Play();
        } catch (e) {
            started = false;
            print(`  (skipping the video half: ${e.message})`);
        }
        if (!started) {
            eq("a Video that could not start is not playing", v.Playing, false);
            v.Delete();
            this.mediaAudioPhase(cue, box);
            return;
        }

        this.mediaEnded = 0;
        eq("Playing is what Play asked for", v.Playing, true);
        until("...and it learns its length", () => v.Duration > 0, () => {
            /* Length and seekability arrive once the demuxer has seen the
             * stream, which is after the first frame -- not with it. */
            check("it is seekable once it runs", v.Seekable === true,
                  `seekable=${v.Seekable}`);
            check("Duration is the clip's length",
                  v.Duration > 0.5 && v.Duration < 1.5, String(v.Duration));
            /* A local file never waits for data, so this is the one thing the
             * suite can say about it without a slow server to play against:
             * playing does not make it drop. Below 100 was measured by hand,
             * against a server throttled to just above the bitrate. */
            eq("a local clip never waits for data", v.Buffering, 100);

            this.mediaFramePhase(v, dir, cue, box);
        });
    }

    /*
     * The frame itself, which arrives later again than the length: the
     * paintable has nothing to measure, and nothing to write out, until
     * something has been decoded into it.
     *
     * A method of its own rather than a fourth `until` inside the third: the
     * phases of this test read as a list here and as a staircase there.
     */
    mediaFramePhase(v, dir, cue, box) {
        until("...and a frame arrives", () => v.SourceWidth > 0, () => {
            eq("the frame's own width",  v.SourceWidth, 160);
            eq("and its own height",     v.SourceHeight, 120);

            /* A still of what is on screen, which is what a viewer of a clip
             * it just recorded wants next. */
            const shot = File.Join(dir, "frame.png");

            v.Save(shot);
            check("a frame saves as a PNG", File.Exists(shot) && File.Info(shot).Size > 0,
                  JSON.stringify(shot));

            /* Pause holds the frame and the position: it is not a Stop. */
            v.Pause();
            eq("Pause is not playing", v.Playing, false);
            check("and it holds a position", v.Position > 0, String(v.Position));
            v.Play();
            eq("and Play picks it up again", v.Playing, true);

            until("...and reaches its end", () => this.mediaEnded > 0, () => {
                check("Position got there too",
                      v.Position > 0.5, String(v.Position));
                eq("EOS leaves it paused, not playing", v.Playing, false);
                v.Seek(0.2);
                v.Play();
                eq("and Play after the end starts it again", v.Playing, true);
                v.Stop();
                eq("Stop parks it", v.Playing, false);
                v.Delete();
                this.mediaAudioPhase(cue, box);
            });
        });
    }

    MediaVid_Ended() { this.mediaEnded = (this.mediaEnded || 0) + 1; }
    MediaBad_Error(msg, kind) { this.mediaError = msg; this.mediaKind = kind; }

    mediaAudioPhase(cue, box) {
        const a = new AudioPlayer();

        eq("audio starts empty too", a.Uri, "");
        eq("no identity either",     a.User, "");
        eq("and no secret to read",  a.Password, "");
        eq("same jitterbuffer default", a.Latency, 2000);
        eq("nothing playing",        a.Playing, false);
        eq("a live length",          a.Duration, -1);
        eq("and nothing to wait for", a.Buffering, 100);

        throws("a handler is a function or nothing",
               () => { a.OnEnded = "soon"; });
        throws("Play with nowhere to go", () => { a.Play(); });

        a.User     = "camara";
        a.Password = "s3cret";
        a.Latency  = 500;
        eq("User round-trips",    a.User, "camara");
        eq("Password never does", a.Password, "");
        eq("Latency round-trips", a.Latency, 500);

        /* Assigned, read back, and taken off again: `null` is how a handler
         * stops being called, and it is the only value besides a function
         * that is not refused. */
        const noop = () => {};

        a.OnEnded = noop;
        eq("a handler reads back", a.OnEnded, noop);
        a.OnEnded = null;
        eq("and null takes it off", a.OnEnded, undefined);

        this.audioEnded = false;
        this.audioError = undefined;
        a.OnEnded = () => { this.audioEnded = true; };
        a.OnError = (msg) => { this.audioError = msg; };
        a.Uri = cue;
        a.Play();
        /*
         * Ended **or** a reason: a machine with no audio output at all -- a CI
         * runner with no sound card -- cannot play a cue, and that is a skip
         * rather than a failure. What is never skipped is that one of the two
         * arrived and that a failure is well formed, so the error path stays
         * covered on the machines that take it.
         */
        until("a cue answers, one way or the other",
              () => this.audioEnded === true || this.audioError !== undefined, () => {
            if (this.audioError !== undefined) {
                check("a cue that cannot play says what and why",
                      this.audioError.startsWith(`AudioPlayer: cannot play '${cue}'`),
                      JSON.stringify(this.audioError));
                print(`  (skipping the rest of the cue: ${this.audioError})`);
                this.mediaBadPhase(box);
                return;
            }
            check("its length is the file's",
                  a.Duration > 0.2 && a.Duration < 0.6, String(a.Duration));
            eq("and it played to its end", this.audioEnded, true);

            /* Looping reseeks instead of ending: past one length it is still
             * going and no Ended arrived. */
            const b = new AudioPlayer();

            b.Uri  = cue;
            b.Loop = true;
            let bEnded = false;
            b.OnEnded = () => { bEnded = true; };
            b.Play();
            const t0 = Date.now();
            until("a looped cue is still going past its length",
                  () => Date.now() - t0 > 800 && b.Playing, () => {
                check("and no Ended arrived", bEnded === false,
                      `ended=${bEnded}`);
                b.Stop();
                eq("Stop ends the loop", b.Playing, false);
                this.mediaBadPhase(box);
            });
        });
    }

    /*
     * What failure says. Neither of these needs a clip of its own, so this
     * phase runs even on a machine that could not generate one -- and the
     * Video half of it is skipped, not failed, where there is no sink to
     * build a pipeline with.
     */
    mediaBadPhase(box) {
        /* A file that is not there is an Error event with something to say,
         * not a silent black frame. */
        this.mediaError = null;
        const w = new Video();

        box.Add(w);
        w.Name = "MediaBad";
        w.Uri = "file:///nonexistent-bta-media-clip.mp4";
        try {
            w.Play();
        } catch (e) {
            print(`  (skipping the Video failure: ${e.message})`);
            w.Delete();
            this.mediaRtspOnly(box);
            return;
        }
        until("a missing file answers with an error",
              () => !!this.mediaError, () => {
            check("and it names the player and the clip",
                  /^Video: cannot play 'file:\/\/\/nonexistent-bta-media-clip\.mp4': ./
                      .test(this.mediaError),
                  JSON.stringify(this.mediaError));
            eq("and says what kind of failure it was", this.mediaKind, "NotFound");
            eq("a failed clip is not playing", w.Playing, false);
            w.Delete();
            this.mediaRtspOnly(box);
        });
    }

    /* An unreachable camera answers the same way, through the RTSP branch:
     * refused on loopback is instant, which is the whole point of that
     * address. */
    mediaRtspOnly(box) {
        this.rtspError = null;
        const r = new AudioPlayer();

        r.Uri = "rtsp://127.0.0.1:9/nothing";
        r.OnError = (msg, kind) => { this.rtspError = msg; this.rtspKind = kind; };
        r.Play();
        until("an unreachable camera answers with an error",
              () => !!this.rtspError, () => {
            check("and it names what it could not play",
                  this.rtspError.startsWith("AudioPlayer: cannot play 'rtsp://127.0.0.1:9/nothing'"),
                  JSON.stringify(this.rtspError));
            check("with a kind a form can act on",
                  ["Unreachable", "NotFound", "NotAuthorized", "Error"].includes(this.rtspKind),
                  JSON.stringify(this.rtspKind));
            eq("and it is not playing", r.Playing, false);
            r.Stop();
            box.Delete();
        }, 600);
    }
    /* --- three small controls the vocabulary was missing -------------------
     *
     * A `ProgressBar` says how far along; a `Spinner` says only that there is
     * work, which is the honest answer while a child process runs. A `LevelBar`
     * is a reading and not a progress: a battery has no end. And a `LinkButton`
     * is an address, handed to the desktop rather than to `Exec`.
     */
    testSmallOnes() {
        const sp = new Spinner();
        this.Fixed1.Add(sp);

        eq("a spinner starts still", sp.Active, false);
        sp.Active = true;
        eq("and spins when asked",   sp.Active, true);
        check("its state is Active, like everything else that is on or off",
              sp.PropertyNames().includes("Active") &&
              !sp.PropertyNames().includes("Value"),
              JSON.stringify(sp.PropertyNames()));
        eq("and is saved", sp.Serialize().properties.Active, true);
        sp.Delete();

        const link = new LinkButton();
        this.Fixed1.Add(link);

        link.Uri = "https://example.org/manual";
        eq("Uri round-trip", link.Uri, "https://example.org/manual");
        eq("a link with no words of its own shows the address",
           link.Text, "https://example.org/manual");

        link.Text = "The manual";
        eq("...and words replace it when there are any", link.Text, "The manual");
        eq("without touching where it goes", link.Uri, "https://example.org/manual");
        check("its caption is prose, so it travels through the catalogue",
              link.TextProperties().includes("Text"));
        check("and it raises Click like any other button",
              link.EventNames().includes("Click"));
        link.Delete();

        const lv = new LevelBar();
        this.Fixed1.Add(lv);

        eq("a level runs 0 to 1 until told otherwise", lv.Max, 1);
        lv.Min = 0;
        lv.Max = 100;
        lv.Value = 40;
        eq("Value round-trip", lv.Value, 40);

        /* Clamped and not refused: a reading out of range is a reading, and a
         * meter that threw would take the program down for a disk that filled. */
        lv.Value = 150;
        eq("out of range is clamped", lv.Value, 100);
        lv.Value = -5;
        eq("at both ends",            lv.Value, 0);

        eq("it fills by default", lv.Mode, "Continuous");
        lv.Mode = "Discrete";
        eq("...or shows blocks",  lv.Mode, "Discrete");
        throws("and nothing else", () => { lv.Mode = "Dotted"; });
        eq("what it accepts is published",
           JSON.stringify(lv.PropertyOptions("Mode")), '["Continuous","Discrete"]');

        lv.Orientation = "Vertical";
        eq("it stands up too", lv.Orientation, "Vertical");
        lv.Delete();
    }

    /*
     * The pointer over a control: one name out of a closed list, on every part
     * the control is made of.
     *
     * **What no assertion here can see is the pointer itself.** Nothing in JS
     * can ask what GTK is drawing, and a run has no pointer over anything, so
     * this measures the property and not the picture -- the same honesty as the
     * calendar's page turn. What the property has to get right, and what is
     * here: the list is closed, a name outside it is refused rather than
     * silently drawn as an arrow (GDK answers a live cursor for any name at
     * all), and `Auto` puts back what the control had instead of stripping it.
     */
    testCursor() {
        const p = new Panel();
        this.Fixed1.Add(p);

        eq("nothing said is Auto", p.Cursor, "Auto");
        p.Cursor = "Crosshair";
        eq("round-trip", p.Cursor, "Crosshair");
        p.Cursor = "crosshair";
        eq("and the case is the caller's, like HAlign", p.Cursor, "Crosshair");

        /*
         * The CSS spelling is refused on purpose: the names here are the
         * project's -- `ResizeTopLeft`, not `nwse-resize` -- and GDK would have
         * taken the other one and drawn nothing in particular.
         */
        throws("a css name is not one of ours", () => { p.Cursor = "nwse-resize"; });
        try {
            p.Cursor = "Finger";
        } catch (e) {
            check("the message shows the value", e.message.includes("Finger"), e.message);
            check("and points at the list", e.message.includes("PropertyOptions"), e.message);
        }
        eq("and the refusal changed nothing", p.Cursor, "Crosshair");

        const names = p.PropertyOptions("Cursor");
        eq("the whole list is published", names.length, 28);
        eq("Auto heads it", names[0], "Auto");
        check("an edge is an axis and a corner is a corner",
              names.includes("ResizeHorizontal") && names.includes("ResizeTopLeft"),
              names.join(","));
        check("and the window manager's one-headed arrows are not offered",
              !names.some((n) => /^Resize(Top|Bottom|Left|Right)$/.test(n)),
              names.join(","));

        /* A property on Widget is a property on all forty classes, so what it
         * costs every `.form` in the tree is worth an assertion of its own. */
        const fresh = new Panel();
        this.Fixed1.Add(fresh);
        check("a control nobody asked writes nothing",
              !("Cursor" in fresh.Serialize().properties),
              JSON.stringify(fresh.Serialize().properties));
        fresh.Cursor = "Hand";
        eq("one that was asked writes it", fresh.Serialize().properties.Cursor, "Hand");
        fresh.Delete();

        /*
         * GTK gives a link its own hand, so `Auto` there cannot mean *no
         * cursor*: the property would take the hand away for good the first
         * time anybody touched it.
         */
        const link = new LinkButton();
        this.Fixed1.Add(link);
        eq("a link comes with the hand GTK gave it", link.Cursor, "Hand");
        check("which is its default, so it is not written either",
              !("Cursor" in link.Serialize().properties),
              JSON.stringify(link.Serialize().properties));
        link.Cursor = "Wait";
        eq("it can be overridden", link.Cursor, "Wait");
        link.Cursor = "Auto";
        eq("and Auto hands it back", link.Cursor, "Hand");
        link.Delete();

        /* The entry is the case the whole `cursor_apply` walk exists for: its
         * text sits in a `GtkText` of its own carrying `text`, so a cursor set
         * on the outside alone would read back and never be seen. Measured with
         * a probe in C, since from here only the round trip shows. */
        const t = new TextBox();
        this.Fixed1.Add(t);
        eq("an entry says nothing of its own", t.Cursor, "Auto");
        t.Cursor = "Progress";
        eq("takes one", t.Cursor, "Progress");
        t.Cursor = "Auto";
        eq("and gives it back", t.Cursor, "Auto");
        t.Delete();

        p.Delete();
    }

    /*
     * Light or dark, which is the one thing a form with colours or icons of its
     * own has to know and could not ask.
     *
     * **The two settings that look like the answer are not**, measured here:
     * `gtk-theme-name` reads `"Default"` under Adwaita and
     * `gtk-application-prefer-dark-theme` reads `false` under
     * `GTK_THEME=Adwaita:dark`. What is true is the ink being drawn, so that is
     * what `Dark` is derived from -- and the assertions below are about the
     * shape of the answer rather than its value, because the value is the
     * desktop's and a test that pinned it would fail on half of them.
     *
     * **That the event fires is not here and cannot be**: nothing in JS can
     * change the desktop's theme, so raising `ThemeChange` is C on both sides.
     * Measured with a probe that flipped the setting from `build_form` and is
     * gone again: the event arrives, and `Dark` read inside the handler is
     * already the new answer rather than the one that was true a moment ago.
     */
    testTheme() {
        const b = new Button();
        this.Fixed1.Add(b);

        eq("a form answers whether it is drawn dark", typeof this.Dark, "boolean");
        eq("and so does every control", typeof b.Dark, "boolean");
        eq("with the same answer, since it is the same desktop", b.Dark, this.Dark);

        /* A widget in no window has no resolved style and answers white in
         * every theme -- which would be *dark* on the lightest desktop there
         * is. The fallback is the application's first window, so a control
         * answers before it is added what it will answer after. */
        const loose = new Button();
        eq("a control that is in no window yet answers anyway",
           loose.Dark, this.Dark);
        loose.Delete();

        check("it is read-only, so no .form ever carries it",
              !("Dark" in this.Serialize().properties),
              JSON.stringify(this.Serialize().properties));

        check("a form says it raises ThemeChange",
              this.EventNames().includes("ThemeChange"),
              this.EventNames().join(","));
        check("...and a control does not: it is the form that restyles",
              !b.EventNames().includes("ThemeChange"),
              b.EventNames().join(","));

        b.Delete();
    }

    /* --- a field: how much, what kind, and what is highlighted ------------- */
    testField() {
        const t = new TextBox();
        this.Fixed1.Add(t);

        /* --- how many characters it will take ------------------------------ */
        eq("a field takes as many as one types", t.MaxLength, 0);
        check("so that stays out of the .form",
              !("MaxLength" in t.Serialize().properties),
              JSON.stringify(t.Serialize().properties));

        t.MaxLength = 6;
        eq("MaxLength round-trip", t.MaxLength, 6);
        eq("and is saved", t.Serialize().properties.MaxLength, 6);
        throws("a negative length is refused", () => { t.MaxLength = -1; });

        /* **The field refuses the seventh character**, which is the whole point:
         * a code that is six long says so while it is being typed, and never has
         * to say it again in a dialog. */
        t.Text = "12345678";
        eq("what is too long is cut where it stops fitting", t.Text, "123456");

        t.MaxLength = 0;
        t.Text = "12345678";
        eq("and zero is no limit again", t.Text, "12345678");

        /* --- what kind of thing goes in it --------------------------------- */
        eq("a field holds free text until told otherwise", t.Purpose, "Text");
        t.Purpose = "Email";
        eq("Purpose round-trip", t.Purpose, "Email");
        eq("and is saved", t.Serialize().properties.Purpose, "Email");
        throws("and nothing outside the list", () => { t.Purpose = "Postcode"; });
        eq("which the designer can offer",
           JSON.stringify(t.PropertyOptions("Purpose")),
           '["Text","Digits","Number","Phone","Url","Email","Name"]');
        check("and passwords are not in it, this class having a flag for that",
              !t.PropertyOptions("Purpose").includes("Password") &&
              t.PropertyNames().includes("Password"));

        /* Declaring is not validating: nothing here refuses what does not
         * match, because an input method reading the hint is what this is for. */
        t.Text = "no arroba";
        eq("declaring what goes in refuses nothing", t.Text, "no arroba");
        t.Purpose = "Text";

        /* --- which end it sits at ------------------------------------------ */
        eq("text starts at the left, like a Label's", t.Alignment, "Left");
        t.Alignment = "Right";
        eq("Alignment round-trip", t.Alignment, "Right");
        throws("and takes the three a Label takes",
               () => { t.Alignment = "Justify"; });
        t.Alignment = "Left";

        /* --- the selection -------------------------------------------------- */
        t.Text = "hola mundo";
        eq("nothing is highlighted to begin with", t.SelectedText, "");

        t.Select(5, 5);
        eq("Select highlights from there", t.SelectedText, "mundo");

        t.Select(2);
        eq("with no length it is a cursor and not a selection", t.SelectedText, "");

        t.Select(5, 999);
        eq("past the end is the end", t.SelectedText, "mundo");

        t.SelectAll();
        eq("SelectAll takes the lot", t.SelectedText, "hola mundo");
        throws("and a position is not negative", () => t.Select(-1, 2));

        check("SelectedText is a reading and not a setting",
              !("SelectedText" in t.Serialize().properties));

        t.Delete();
    }

    /* --- closed, or put away ----------------------------------------------
     *
     * The difference is not cosmetic and not an optimisation: a form's window is
     * built once, when the form is constructed, so a closed one is *gone* --
     * `Show` on it is not an error and not a window either. A form meant to be
     * opened again either says `HideOnClose` or is constructed again every time.
     */
    testHideOnClose() {
        const gone = new Form();
        gone.Text = "closed for good";
        gone.Resize(320, 200);

        const kept = new Form();
        kept.Text = "put away";
        kept.HideOnClose = true;
        kept.Resize(320, 200);

        const field = new TextBox();
        kept.Add(field);
        field.Move(10, 10);
        field.Text = "half typed";

        eq("a window is taken apart on close until told otherwise",
           gone.HideOnClose, false);
        check("so that stays out of the .form",
              !("HideOnClose" in gone.Serialize().properties),
              JSON.stringify(gone.Serialize().properties));
        eq("asking otherwise reads back", kept.HideOnClose, true);
        eq("and is saved", kept.Serialize().properties.HideOnClose, true);

        gone.Show();
        kept.Show();

        until("both windows are up", () => kept.Bounds().Width > 0, () => {
            gone.Close();
            kept.Close();

            /* Shown again: one of them is a window and the other is nothing. */
            gone.Show();
            kept.Show();

            until("the one that was put away is back",
                  () => kept.Bounds().Width > 0, () => {
                eq("...at the size it had", kept.Bounds().Width, 320);
                eq("with what was typed in it still there", field.Text, "half typed");

                eq("while the one that was closed does not come back",
                   gone.Bounds().Width, 0);

                kept.HideOnClose = false;
                kept.Close();
            });
        });
    }

    /* --- which way a view may scroll -------------------------------------- */
    testScrollbars() {
        const win = new Form();
        win.Text = "scrollbars";
        win.Arrangement = "Vertical";
        win.Resize(400, 300);

        const view = new Scroller();
        win.Add(view);

        const wide = new Panel();
        view.Add(wide);
        wide.Resize(800, 400);

        eq("a view scrolls both ways until told otherwise", view.Scrollbars, "Both");
        check("so that stays out of the .form",
              !("Scrollbars" in view.Serialize().properties),
              JSON.stringify(view.Serialize().properties));

        throws("and it takes the four words it published",
               () => { view.Scrollbars = "Sideways"; });
        eq("which the designer can offer",
           JSON.stringify(view.PropertyOptions("Scrollbars")),
           '["Both","Horizontal","Vertical","None"]');

        win.Show();

        /*
         * **The effect, not the property.** An axis that may not scroll is not a
         * hidden scrollbar: GTK stops offering the child a viewport it can be
         * bigger than, so the view has to be as wide as the child asked for --
         * and the window with it. Eight hundred against four hundred is the
         * whole difference, and it is what makes a list of long lines wrap
         * instead of running off the side.
         */
        until("the view is laid out", () => view.Bounds().Width > 0, () => {
            eq("scrolling both ways, the view is the room it was given",
               view.Bounds().Width, 400);

            view.Scrollbars = "Vertical";
            until("...and it settles again",
                  () => view.Bounds().Width !== 400, () => {
                eq("with no sideways scrolling it is as wide as its contents",
                   view.Bounds().Width, 800);
                eq("and the window had to follow", win.Bounds().Width, 800);

                eq("Vertical is saved, being no longer the default",
                   view.Serialize().properties.Scrollbars, "Vertical");
                win.Close();
            });
        });
    }

    /* --- a container that folds ------------------------------------------- */
    testExpander() {
        const ex = new Expander();
        this.Fixed1.Add(ex);
        ex.Name = "Ex1";
        ex.Text = "Advanced";

        eq("Text round-trip", ex.Text, "Advanced");
        eq("it starts folded",  ex.Expanded, false);

        /* `Expanded` and not `Expand`, which is the layout boolean every widget
         * has -- the same collision the tree avoided with `ExpandNode`. */
        check("its own boolean does not shadow the layout one",
              ex.PropertyNames().includes("Expanded") &&
              ex.PropertyNames().includes("Expand"));
        eq("and the layout one still means what it always did",
           typeof ex.Expand, "boolean");

        this.expanderSaid = 0;
        ex.Expanded = true;
        eq("unfolding reads back", ex.Expanded, true);
        eq("and reports",          this.expanderSaid, 1);

        ex.Expanded = false;
        eq("folding reports too",  this.expanderSaid, 2);

        /* It is a container: what goes in it lays out the RAD way. */
        const inside = new Button();
        ex.Add(inside);
        inside.Move(8, 8);
        eq("it holds controls",           ex.Children.length, 1);
        eq("and they keep coordinates",   ex.Children[0].X, 8);

        eq("its caption is prose", JSON.stringify(ex.TextProperties()),
           JSON.stringify(["Text", "Tooltip"]));
        ex.Delete();
    }

    /* --- the room between things, and who takes it ------------------------
     *
     * A grid had no spacing at all and a split could not say which half grows,
     * which are the two layouts one cannot get by drawing: a form of labelled
     * fields whose controls do not touch, and a sidebar that stays the width it
     * was while the work beside it takes the window.
     */
    testSpacing() {
        const g = new Grid();
        this.Fixed1.Add(g);
        g.Name = "SpaceGrid";

        eq("a grid starts with no room between cells", g.RowSpacing, 0);
        eq("on either axis",                           g.ColumnSpacing, 0);

        g.RowSpacing    = 6;
        g.ColumnSpacing = 12;
        eq("rows round-trip",    g.RowSpacing, 6);
        eq("columns round-trip", g.ColumnSpacing, 12);
        eq("and the two are not the same knob", g.RowSpacing, 6);

        throws("a negative gap is refused", () => { g.RowSpacing = -1; });
        eq("and nothing stuck", g.RowSpacing, 6);

        eq("a grid is ragged until asked otherwise", g.Homogeneous, false);
        g.Homogeneous = true;
        eq("and even on both axes when it is", g.Homogeneous, true);

        check("all three are the grid's to serialise",
              g.PropertyNames().includes("RowSpacing") &&
              g.PropertyNames().includes("ColumnSpacing") &&
              g.PropertyNames().includes("Homogeneous"));
        eq("and are saved", g.Serialize().properties.RowSpacing, 6);
        g.Delete();

        const f = new Flow();
        this.Fixed1.Add(f);
        f.RowSpacing = 4;
        f.ColumnSpacing = 8;
        eq("a flow has the same two", f.RowSpacing, 4);
        eq("...and they are its own",  f.ColumnSpacing, 8);
        f.Homogeneous = true;
        eq("and an even one is even", f.Homogeneous, true);
        f.Delete();

        /* --- the container's own word for the same gap ---------------------- */
        const box = new Panel();
        this.Fixed1.Add(box);
        box.Arrangement = "Vertical";
        box.Spacing = 6;
        eq("Spacing round-trips on a container", box.Spacing, 6);
        throws("a negative spacing is refused", () => { box.Spacing = -1; });
        eq("and nothing stuck", box.Spacing, 6);
        box.Delete();

        /* --- which half of a split grows --------------------------------- */
        const sp = new Split();
        this.Fixed1.Add(sp);
        sp.Add(new Panel());
        sp.Add(new Panel());

        eq("a split shares what it is given", sp.Grows, "Both");

        sp.Grows = "End";
        eq("...or gives it to one side", sp.Grows, "End");
        sp.Grows = "Start";
        eq("...or the other",            sp.Grows, "Start");
        sp.Grows = "Neither";
        eq("...or to nobody, which pins the divider", sp.Grows, "Neither");

        throws("a word nobody defined is refused", () => { sp.Grows = "Sideways"; });
        eq("and the last good one stands", sp.Grows, "Neither");

        eq("what it accepts is published, so the grid offers a drop-down",
           JSON.stringify(sp.PropertyOptions("Grows")),
           '["Both","Start","End","Neither"]');

        eq("the handle is a hairline until asked", sp.WideHandle, false);
        sp.WideHandle = true;
        eq("and a grip when it is",                sp.WideHandle, true);
        sp.Delete();
    }

    /* --- ToggleButton --------------------------------------------------- */
    testToggle() {
        const t = new ToggleButton();
        this.Fixed1.Add(t);
        t.Name = "T1";
        t.Text = "press me";

        this.toggleRef  = t;
        this.toggleSaid = [];

        eq("Text round-trip",   t.Text, "press me");
        eq("a toggle starts out", t.Active, false);

        /* The round trip that matters: assigning from JS has to reach GTK and
         * come back as a real signal. */
        t.Active = true;
        eq("Active round-trip",            t.Active, true);
        eq("and assigning it reports",    this.toggleSaid.length, 1);
        eq("with the state it now has",   this.toggleSaid[0], true);

        t.Click();
        eq("Click() toggles it",  t.Active, false);
        eq("and reports again",   this.toggleSaid.length, 2);

        t.Enabled = false;
        t.Click();
        eq("a disabled toggle does not move", t.Active, false);
        eq("and says nothing",                this.toggleSaid.length, 2);

        t.Delete();
    }

    /* --- Switch --------------------------------------------------------- */

    /*
     * A CheckButton drawn as the desktop draws a setting, so what is under test is
     * that it is one: the boolean round trip, and the click that comes back from
     * GTK whichever way the switch went.  It carries no caption -- the label
     * beside one is a Label -- which is the only thing it has less of.
     */
    testSwitch() {
        const s = new Switch();
        this.Fixed1.Add(s);
        s.Name = "Sw1";

        this.switchRef  = s;
        this.switchSaid = [];

        eq("a switch starts off", s.Active, false);
        eq("and has no caption of its own", s.PropertyNames().includes("Text"), false);

        /* The round trip that matters: assigning from JS has to reach GTK and
         * come back as a real signal. */
        s.Active = true;
        eq("Active round-trip",          s.Active, true);
        eq("and assigning it reports",  this.switchSaid.length, 1);
        eq("with the state it now has", this.switchSaid[0], true);

        s.Active = false;
        eq("turning it off reports too", this.switchSaid.length, 2);
        eq("the other way round",        this.switchSaid[1], false);

        /* Assigning what it already holds is not a change: GTK notifies on the
         * property, and a property that did not move notifies nobody. */
        s.Active = false;
        eq("and setting it to what it is says nothing", this.switchSaid.length, 2);

        s.Delete();
    }

    /* --- ProgressBar ---------------------------------------------------- */
    testProgress() {
        const p = new ProgressBar();
        this.Fixed1.Add(p);
        p.Name = "Prog1";

        eq("a bar starts at nothing", p.Value, 0);
        p.Value = 42;
        eq("Value is a percentage and round-trips exactly", p.Value, 42);
        p.Value = 33.5;
        eq("fractions survive too", p.Value, 33.5);
        p.Value = 150;
        eq("out of range is clamped, not refused", p.Value, 100);
        p.Value = -10;
        eq("at both ends",                         p.Value, 0);

        eq("no text of its own", p.Text, "");
        p.ShowText = true;
        eq("ShowText round-trip", p.ShowText, true);
        p.Text = "loading";
        eq("Text round-trip", p.Text, "loading");
        p.Text = "";
        eq("and empty hands GTK's own percentage back", p.Text, "");

        eq("horizontal to begin with", p.Orientation, "Horizontal");
        p.Orientation = "Vertical";
        eq("Orientation round-trip", p.Orientation, "Vertical");
        throws("and anything else is refused", () => { p.Orientation = "sideways"; });
        eq("the designer is offered the two",
           p.PropertyOptions("Orientation").join(","), "Horizontal,Vertical");

        /* Nothing to assert about a pulse but that it is there: an indeterminate
         * bar has no value to read back. */
        p.Pulse();
        check("Pulse is callable", true);

        p.Delete();
    }

    /* --- Slider --------------------------------------------------------- */
    testSlider() {
        const s = new Slider();
        this.Fixed1.Add(s);
        s.Name = "Sld1";

        this.sliderSaid = 0;

        eq("the range a slider starts with", s.Min, 0);
        eq("...and its top",                 s.Max, 100);

        s.Value = 30;
        eq("Value round-trip",                s.Value, 30);
        eq("and assigning it raises Change",  this.sliderSaid, 1);

        s.Min = 10;
        eq("Min round-trip", s.Min, 10);
        s.Step = 5;
        eq("Step round-trip", s.Step, 5);

        s.ShowValue = true;
        eq("ShowValue round-trip", s.ShowValue, true);

        eq("horizontal to begin with", s.Orientation, "Horizontal");
        s.Orientation = "Vertical";
        eq("Orientation round-trip", s.Orientation, "Vertical");
        throws("and anything else is refused", () => { s.Orientation = "up"; });

        /*
         * **Decimals, and not GTK's `digits`**: a `SpinBox` already calls this
         * `Decimals`, and it is the same question about the same kind of number.
         * It rounds the *value*, which is what keeps a slider of whole numbers
         * from handing a program 7.000001.
         */
        s.Orientation = "Horizontal";
        eq("a slider works in whole numbers to begin with", s.Decimals, 0);
        check("the word is the one SpinBox uses for it",
              s.PropertyNames().includes("Decimals") &&
              !s.PropertyNames().includes("Digits"));

        s.Min = 0;
        s.Max = 10;
        s.Value = 3.14159;
        eq("with no decimals the value is rounded", s.Value, 3);

        s.Decimals = 2;
        s.Value = 3.14159;
        eq("and to as many as it was given", s.Value, 3.14);
        throws("a negative count is refused", () => { s.Decimals = -1; });

        /* Where the number shows, for the ones that show one. */
        eq("the reading sits above the rail", s.ValuePosition, "Top");
        s.ValuePosition = "Bottom";
        eq("ValuePosition round-trip", s.ValuePosition, "Bottom");
        throws("and takes the four sides", () => { s.ValuePosition = "Middle"; });
        eq("which the designer can offer",
           JSON.stringify(s.PropertyOptions("ValuePosition")),
           '["Top","Bottom","Left","Right"]');

        /* Which end the low values are at. */
        eq("low is at the start until turned over", s.Inverted, false);
        s.Inverted = true;
        eq("Inverted round-trip", s.Inverted, true);
        eq("and is saved", s.Serialize().properties.Inverted, true);
        s.Inverted = false;

        /*
         * A tick on the rail, with a word under it: `Mark` and `ClearMarks`, the
         * names a `SourceEditor` uses for the same idea -- something put *at* a
         * place rather than a property of the whole.
         */
        check("marks are verbs, being things put at a place",
              typeof s.Mark === "function" && typeof s.ClearMarks === "function");
        s.Mark(5, "Normal");
        s.Mark(8);
        s.ClearMarks();
        throws("and a mark needs a place to be at", () => s.Mark());
        check("none of which is a property to save",
              !("Marks" in s.Serialize().properties));

        s.Delete();
    }

    /* --- DatePicker ----------------------------------------------------- */
    testDate() {
        const d = new DatePicker();
        this.Fixed1.Add(d);
        d.Name = "Date1";

        this.dateSaid = 0;

        check("a fresh picker holds a date", /^\d{4}-\d{2}-\d{2}$/.test(d.Value),
              JSON.stringify(d.Value));

        d.Value = "2026-08-11";
        eq("Value round-trips as ISO",       d.Value, "2026-08-11");
        eq("and one assignment is one Change", this.dateSaid, 1);

        /* The end of the month is where a three-setter date goes wrong, so it is
         * what the test walks through. */
        d.Value = "2026-01-31";
        eq("the last day of a long month", d.Value, "2026-01-31");
        d.Value = "2026-02-28";
        eq("...and of a short one after it", d.Value, "2026-02-28");

        throws("a string that is not a date is refused",
               () => { d.Value = "yesterday"; });
        throws("nor is a day that does not exist",
               () => { d.Value = "2026-02-30"; });
        throws("nor a date with something after it",
               () => { d.Value = "2026-08-11 and then some"; });
        eq("and none of the refused ones stuck", d.Value, "2026-02-28");

        eq("Format reads as ISO until told otherwise", d.Format, "%Y-%m-%d");
        d.Format = "%d/%m/%Y";
        eq("Format round-trip", d.Format, "%d/%m/%Y");
        eq("and how it reads does not change what it is", d.Value, "2026-02-28");

        /*
         * No date at all, which is what an optional one needs and GTK does not
         * have: a `GtkCalendar` always holds a day. Without this the control
         * answered *today* for a field nobody filled in -- a date the program
         * never meant, written into the record without a word, which is the
         * limit `data-plan.md` named.
         *
         * **What no assertion here can reach is the popover**: that choosing a
         * day ends the empty state and that turning the page does not is C on
         * both sides of a widget JS cannot see into, measured with a probe in
         * `build_datepicker` and gone again. The same hole the calendar's own
         * page turn is in.
         */
        const said = this.dateSaid;
        d.Value = "";
        eq("a date can be none at all", d.Value, "");
        eq("and emptying it is a Change like any other", this.dateSaid, said + 1);
        eq("which is the same empty Field.Date spells", typeof d.Value, "string");

        throws("a refusal still refuses while it is empty",
               () => { d.Value = "the other day"; });
        eq("and leaves it empty", d.Value, "");

        d.Value = "2026-02-28";
        eq("and a date fills it again", d.Value, "2026-02-28");

        eq("empty reads as an em dash until somebody says otherwise",
           d.Placeholder, "\u2014");
        d.Placeholder = "Sin fecha";
        eq("Placeholder round-trip", d.Placeholder, "Sin fecha");
        check("and it is prose, so it travels through the catalogue",
              d.TextProperties().includes("Placeholder"),
              JSON.stringify(d.TextProperties()));
        d.Placeholder = "";
        eq("emptying it restores the dash rather than blanking the button",
           d.Placeholder, "\u2014");

        /* A control that declared the empty state has to carry it across a save,
         * which is the whole point: it is the one value that differs from a
         * fresh picker's and the serialiser writes exactly those. */
        d.Value = "";
        eq("an empty date survives the round trip through the .form",
           d.Serialize().properties.Value, "");

        /* The month is not a field: there is no way to draw a month with no day
         * on it, so it says so instead of accepting and lying. */
        const cal = new Calendar();
        this.Fixed1.Add(cal);
        const held = cal.Value;
        throws("a Calendar refuses the empty date", () => { cal.Value = ""; });
        eq("and keeps the day it had", cal.Value, held);
        cal.Delete();

        d.Delete();
    }

    /* --- a library: project.json's "uses" ------------------------------- */
    /*
     * **Where a shared class lives, and how the runtime finds it.**
     *
     * A project loads its own `.js` and nothing else, so until `uses` there was
     * nowhere for a *library* of Bintana classes to be: a chart set could only
     * be copied into every project that wanted one. `"uses": ["charts"]` names a
     * directory of `.js` and `.form` files, resolved over six places -- the
     * project's own `lib/`, `$BINTANA_LIB_PATH`, the user's data directory, then two
     * hops from the runtime's own binary (the source tree uninstalled, and
     * `share/bintana/lib` installed), then `/usr`. `lib_candidates` in
     * `bta_runtime.c` is that list and says why each entry is in it.
     *
     * Asserted by **running the runtime against a library this test writes**,
     * because the two halves that matter are startup-time and cannot be reached
     * from inside a running project: that the classes arrive, and that a
     * library's `.form` is indexed with the project's -- which is what lets a
     * form say `"type": "Marca"` about a class the project does not contain.
     *
     * `BINTANA_LIB_PATH` is the override that makes this testable at all, and it is
     * in the search path for exactly this reason: developing a library that is in
     * neither tree yet.
     */
    testLibrary() {
        Directory.Make(SCRATCH);

        const libs  = File.Join(SCRATCH, "libpath");
        const mine  = File.Join(libs, "marca");
        const proj  = File.Join(SCRATCH, "uses");

        Directory.Make(mine);
        Directory.Make(proj);

        Directory.Make(File.Join(mine, "po"));
        Directory.Make(File.Join(mine, "icons"));

        /*
         * **A library is a directory of classes and forms**, and everything a
         * project can have beside its classes a library can have too: a load
         * order, a catalogue and icons of its own.
         *
         * The order is the one thing it cannot do without once its own classes
         * extend each other -- `Marca extends Zocalo` sorts the wrong way round
         * by path, which is exactly why a project has `sources` -- so a library
         * may carry a `project.json` and only that key is read from it.
         */
        File.SaveJson(File.Join(mine, "project.json"),
                      { sources: ["Zocalo.js", "Marca.js"] });
        File.Save(File.Join(mine, "Zocalo.js"),
                  'class Zocalo extends Component {\n' +
                  '    get Said() { return Locale.Text("from the library"); }\n' +
                  '}\n');
        File.Save(File.Join(mine, "po", "es.po"),
                  'msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8\\n"\n\n' +
                  'msgid "from the library"\nmsgstr "de la biblioteca"\n\n' +
                  'msgid "both"\nmsgstr "la biblioteca"\n');
        File.Save(File.Join(mine, "icons", "marca-symbolic.svg"),
                  '<!-- A mark. -->\n' +
                  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
                  'viewBox="0 0 16 16"><path d="M3 3h10v10H3z"/></svg>\n');

        File.Save(File.Join(mine, "Marca.js"), "class Marca extends Zocalo {}\n");
        File.SaveJson(File.Join(mine, "Marca.form"), {
            format: "bintana-form/1", class: "Marca",
            properties: { Width: 90, Height: 24 },
            children: [{ type: "Label", name: "Inside",
                         properties: { Text: "from the library" } }],
        });

        Directory.Make(File.Join(proj, "po"));
        File.Save(File.Join(proj, "po", "es.po"),
                  'msgid ""\nmsgstr "Content-Type: text/plain; charset=UTF-8\\n"\n\n' +
                  'msgid "both"\nmsgstr "el proyecto"\n');
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "uses", startup: "Probe", uses: ["marca"] });
        File.SaveJson(File.Join(proj, "Probe.form"), {
            type: "Form", name: "Probe",
            properties: { Text: "Probe", Width: 200, Height: 80 },
            children: [{ type: "Marca", name: "M", properties: { X: 4, Y: 4 } }],
        });
        File.Save(File.Join(proj, "Probe.js"), `
class Probe extends Form {
    Form_Open() {
        /*
         * **Never mapped.** Form_Open runs before Show() returns, so hiding here
         * means this window is never on screen -- which matters because this
         * child is started asynchronously and the suite that started it has
         * assertions about who has the focus. One stolen focus turned three
         * Tab-order assertions red, which is the hazard testTabOrder already
         * warns about.
         */
        this.Visible = false;
        print("class:" + (typeof Marca === "function"));
        print("form:" + this.M.Inside.Text);
        print("component:" + (this.M instanceof Component));
        print("order:" + (this.M instanceof Zocalo));
        print("catalogue:" + this.M.Said);
        print("tie:" + Locale.Text("both"));
        print("icon:" + Application.HasIcon("marca-symbolic"));
        print("languages:" + JSON.stringify(Locale.Available));
        Application.Quit(0);
    }
}
`);

        const said = {};
        Exec([Application.Executable, proj],
             { Environment: { BINTANA_LIB_PATH: libs, LANGUAGE: "es" }, Timeout: 20000 },
             (line) => {
                 const at = line.indexOf(":");
                 if (at > 0) said[line.slice(0, at)] = line.slice(at + 1);
             },
             (code) => {
                 eq("a project that uses a library runs", code, 0);
                 eq("the library's class arrived",      said.class, "true");
                 /* Its `.form` was indexed *and* its prose went through its own
                  * catalogue -- which is two facts in one string, and the second
                  * one is the reason a library has a `po/` at all. */
                 eq("...and its .form was indexed, and its prose translated",
                    said.form, "de la biblioteca");
                 eq("...as a component of the project's own form",
                    said.component, "true");

                 /* Its own load order: `Marca extends Zocalo`, which by path
                  * would have loaded the child first and thrown. */
                 eq("a library's own sources order is honoured", said.order, "true");

                 /* Its own catalogue, read before the project's -- so a library
                  * ships its prose and the project can still overrule a word. */
                 eq("a library's catalogue is read too",
                    said.catalogue, "de la biblioteca");
                 eq("...and the project wins where both translate the same string",
                    said.tie, "el proyecto");
                 eq("...while a language only a library has is still offered",
                    said.languages, '["es"]');

                 /* And its icons, on the search path after the project's. */
                 eq("a library's icons are found", said.icon, "true");
                 this.shippedLibrary();
             });
        waiting++;
    }

    /*
     * **The library this tree actually ships**, exercised the same way -- and the
     * claim asserted is the one that would rot quietly.
     *
     * `lib/charts` draws a rounded line with a *monotone* interpolation: between
     * two samples the curve stays between their values, so a spike does not grow
     * a taller peak and a series that never went below zero never dips under the
     * axis. That is a promise about numbers nobody can see in a picture -- a
     * curve that overshoots by three pixels looks like a nicer curve -- so it is
     * read off `DrawingArea.Dump()`, where every `CurveTo`'s control points are
     * written down.
     *
     * No `BINTANA_LIB_PATH` here: this is the resolution that matters, one hop from
     * the runtime's own binary.
     */
    shippedLibrary() {
        const proj = File.Join(SCRATCH, "uses-charts");
        Directory.Make(proj);

        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "charted", startup: "Spike", uses: ["charts"] });
        File.SaveJson(File.Join(proj, "Spike.form"), {
            type: "Form", name: "Spike",
            properties: { Text: "Spike", Width: 420, Height: 260 },
            children: [{ type: "Chart", name: "C",
                         properties: { Type: "Line", Legend: "None", Curved: true,
                                       X: 4, Y: 4, Width: 400, Height: 240 } }],
        });
        File.Save(File.Join(proj, "Spike.js"), `
class Spike extends Form {
    Form_Open() {
        this.Visible = false;                 /* never mapped: see the note above */
        this.C.Series = [{ Values: [0, 0, 10, 0, 0, 5, 5, 0, 0] }];
        this.C.Save(File.Join("${SCRATCH}", "spike.png"), 400, 240);

        const box  = this.C.lastBox;
        const zero = this.C.yOf(box, 0), top = this.C.yOf(box, 10);
        let curves = 0, out = 0;

        for (const line of this.C.Canvas.Dump().split("\\n")) {
            if (!line.startsWith("CurveTo")) continue;
            curves++;
            for (const m of line.matchAll(/\\(([-\\d.]+),([-\\d.]+)\\)/g)) {
                const y = Number(m[2]);
                if (y > zero + 0.51 || y < top - 0.51) out++;
            }
        }
        print("curves:" + curves);
        print("outside:" + out);

        /*
         * The window, which is the arithmetic that breaks quietly: an index maps
         * to an x and back, and if the two ever disagree the hover points at the
         * wrong reading -- which looks like a chart working.
         */
        const long = [];
        for (let i = 0; i < 4000; i++) long.push(i % 97);
        this.C.Series = [{ Values: long }];
        this.C.Zoomable = true;

        this.C.Count = 100;
        this.C.From  = 500;
        this.C.Save(File.Join("${SCRATCH}", "window.png"), 400, 240);

        const b = this.C.lastBox;
        print("count:" + b.view.count);
        print("from:" + b.view.from);
        /* The map and its inverse, at both edges and in the middle. */
        print("roundtrip:" + [500, 550, 599]
            .every((i) => this.C.indexAt(b, this.C.xOf(b, i)) === i));
        /* Zoomed in far enough, every sample is drawn with its own index -- which
         * is what zooming a decimated series is for. */
        const drawn = this.C.reduce(long, 400, b.view);
        print("samples:" + drawn.length + "," + drawn[0][0] + "," + drawn.at(-1)[0]);

        /* Clamped, both ways: more than there is shows everything, and a start
         * past the end is pulled back to where the last window fits. */
        this.C.Count = 99999;
        print("clamped:" + this.C.view().whole);
        this.C.Count = 100;
        this.C.From  = 99999;
        print("pulled:" + this.C.view().from);

        /* And the wheel keeps the datum under the pointer where it was: zooming
         * is a lens, not a jump. */
        this.C.From = 1000; this.C.Count = 200;
        this.C.Save(File.Join("${SCRATCH}", "window.png"), 400, 240);
        const box2 = this.C.lastBox;
        this.C.pointer = (box2.left + box2.right) / 2;
        const under = this.C.indexAt(box2, this.C.pointer);
        this.C.Canvas_MouseWheel(0, -1);
        this.C.Save(File.Join("${SCRATCH}", "window.png"), 400, 240);
        print("closer:" + (this.C.view().count < 200));
        print("kept:" + Math.abs(this.C.indexAt(this.C.lastBox, this.C.pointer) - under));

        Application.Quit(0);
    }
}
`);

        const said = {};
        Exec([Application.Executable, proj], { Timeout: 20000 },
             (line) => {
                 const at = line.indexOf(":");
                 if (at > 0) said[line.slice(0, at)] = line.slice(at + 1);
             },
             (code) => {
                 eq("the shipped chart library loads and draws", code, 0);
                 check("a rounded line is drawn as curves",
                       Number(said.curves) >= 8, said.curves);
                 eq("...and not one control point leaves the data's own range",
                    said.outside, "0");
                 check("and the PNG it wrote is there",
                       File.Exists(File.Join(SCRATCH, "spike.png")));

                 /*
                  * **The window into a long series**: `From` and `Count` are
                  * ordinary properties, so the wheel and the drag are only
                  * another way of setting them -- and the map from an index to an
                  * x has an inverse that has to agree with it, or the hover
                  * points at the wrong reading and the chart looks fine.
                  */
                 eq("a chart can be given a window",  said.count, "100");
                 eq("...starting where it was told",  said.from, "500");
                 eq("...and the index-to-x map round-trips", said.roundtrip, "true");
                 eq("zoomed in, every sample in the window is drawn, by its own "
                    + "index", said.samples, "100,500,599");
                 eq("a window bigger than the data is the whole of it",
                    said.clamped, "true");
                 eq("...and one starting past the end is pulled back",
                    said.pulled, "3900");
                 eq("the wheel zooms in", said.closer, "true");
                 eq("...and keeps the reading under the pointer where it was",
                    said.kept, "0");
                 this.libraryMissing();
             });
    }

    /*
     * And a `uses` naming something that is not there **stops the program and
     * says where it looked**. Carrying on would fail a moment later with
     * `unknown widget type 'Marca'`, which says nothing about a library at all.
     */
    libraryMissing() {
        const proj = File.Join(SCRATCH, "uses-missing");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "missing", main: "Main", uses: ["nosuchlibrary"] });
        File.Save(File.Join(proj, "Main.js"), "function Main() { print('ran'); }\n");

        const said = [];
        Exec([Application.Executable, proj], { Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 eq("a library that is not there stops the program", code, 2);
                 const all = said.join("\n");
                 check("saying what it looked for",
                       all.includes('uses "nosuchlibrary"'), all);
                 check("...and every place it looked",
                       all.includes("/nosuchlibrary") &&
                       all.split("/nosuchlibrary").length - 1 >= 4, all);
                 check("and the main never ran", !all.includes("ran"), all);
                 waiting--;
                 this.errorIsNotColoured();
             });
    }

    /* --- a plugin: native code inside a library -------------------------- */
    /*
     * **A library may carry a shared object**, and this is the whole of that
     * path: a real one, built by CMake from `tests/plugins/testplug.c` -- the
     * reference implementation `docs/plugins.md` points at -- loaded by the
     * same `uses` resolution as the library, before its `.js`, and driven
     * through the callback table in `runtime/include/bta_plugin.h`.
     *
     * Three children, because the loader has three answers and each is a
     * sentence somebody will meet: it loads and installs; a plugin built for
     * another ABI stops the program naming both numbers; a shared object with
     * no entry point stops it naming the file.  They are console projects,
     * which is also the proof that a plugin has nothing to do with a display.
     *
     * The `.so` is copied from beside the running binary -- `testlibs/` under
     * the build directory -- which is what makes the test follow `BINTANA=`.
     * The suffix is spelled out because the suite is a Linux suite and always
     * has been: `G_MODULE_SUFFIX` is the runtime's spelling, and a plugin for
     * another platform is built with that platform's compiler anyway.
     */
    testPlugin() {
        waiting++;

        Directory.Make(SCRATCH);

        const libs  = File.Join(SCRATCH, "plugpath");
        const built = File.Join(File.Directory(Application.Executable), "testlibs");
        const mine  = File.Join(libs, "testplug");
        Directory.Make(mine);

        File.Copy(File.Join(built, "testplug", "testplug.so"),
                  File.Join(mine, "testplug.so"));

        /*
         * The library's JavaScript half, which has to find the global the
         * native half installed: the load order is the whole reason a plugin
         * and a library share a directory.
         */
        File.Save(File.Join(mine, "testplug.js"), `
const GLUE_SAW = typeof TestPlug === "object";
function plugGlue() { return "saw:" + GLUE_SAW; }
`);

        const proj = File.Join(SCRATCH, "plugproj");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "plug", main: "Main", uses: ["testplug"] });
        File.Save(File.Join(proj, "Main.js"), `
"use strict";
function Main() {
    print("echo:" + TestPlug.Echo("hola"));
    print("add:" + TestPlug.Add(2, 3));
    print("prims:" + [null, 1, "x", true, undefined]
        .map((v) => TestPlug.Describe(v)).join(","));
    print("pair:" + JSON.stringify(TestPlug.Pair(4, 5)));
    print("fields:" + JSON.stringify(TestPlug.Fields()));
    print("length:" + TestPlug.Length([1, 2, 3]));
    print("arity:" + JSON.stringify(TestPlug.Arity()));
    print("extra:" + JSON.stringify(TestPlug.Arity(7, 8, 9)));
    print("values:" + JSON.stringify(TestPlug.Values()));
    print("drop:" + TestPlug.Drop());
    print("glue:" + plugGlue());
    print("apply:" + TestPlug.Apply((v) => v + "!", "hola"));
    try { TestPlug.Apply(() => { throw new Error("thrown in the callback"); }); }
    catch (e) { print("called:" + e.message); }
    try { TestPlug.Apply(7); }
    catch (e) { print("notfn:" + (e instanceof TypeError)); }
    Logger.Level = "Debug";
    TestPlug.Log("from the plugin");
    try { TestPlug.Boom("bang"); }
    catch (e) { print("boom:" + e.message + "," + (e instanceof Error)); }
    Application.Quit(0);
}
`);

        const lines = [];
        const said  = {};
        Exec([Application.Executable, proj],
             { Environment: { BINTANA_LIB_PATH: libs }, Timeout: 20000 },
             (line) => {
                 lines.push(line);
                 const at = line.indexOf(":");
                 if (at > 0) said[line.slice(0, at)] = line.slice(at + 1);
             },
             (code) => {
                 eq("a project that uses a library with a plugin in it runs",
                    code, 0);
                 eq("a plugin function answers a string", said.echo, "hola");
                 eq("...a number", said.add, "5");
                 eq("...and kind() names what it was given",
                    said.prims, "null,number,string,bool,undefined");
                 eq("an array it built with push()", said.pair, "[4,5]");
                 eq("an object it built with set()", said.fields,
                    '{"Name":"testplug","Abi":1,"Native":true,"Nil":null,"Nested":{}}');
                 eq("get() reads a property", said.length, "3");
                 eq("a missing argument arrives undefined at the declared arity",
                    said.arity, '[2,"undefined"]');
                 eq("...and extra arguments are still there",
                    said.extra, '[3,"number"]');
                 eq("every value kind it can make", said.values,
                    '[null,null,false,2.5,"hecho",{},[]]');
                 eq("release() drops a value without complaint", said.drop, "true");
                 eq("the library's .js ran after the .so", said.glue, "saw:true");
                 eq("fail() raises an Error the caller can catch",
                    said.boom, "bang,true");
                 eq("a plugin can call a JavaScript function it was given",
                    said.apply, "hola!");
                 eq("...and the error that function throws reaches the caller",
                    said.called, "thrown in the callback");
                 eq("...while a value that is not a function is refused",
                    said.notfn, "true");

                 const all = lines.join("\n");
                 check("its log() line reaches the application's logger",
                       all.includes("Debug: from the plugin"), all);
                 check("and cleanup() ran at teardown",
                       all.includes("testplug: cleanup"), all);

                 this.pluginOld(libs, built);
             });
    }

    /* A `.so` that says it was built for another ABI: refused by name. */
    pluginOld(libs, built) {
        const dir = File.Join(libs, "oldplug");
        Directory.Make(dir);
        File.Copy(File.Join(built, "testplug-old", "testplug-old.so"),
                  File.Join(dir, "oldplug.so"));

        const proj = File.Join(SCRATCH, "plugold");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "old", main: "Main", uses: ["oldplug"] });
        File.Save(File.Join(proj, "Main.js"),
                  "function Main() { print('ran'); }\n");

        const said = [];
        Exec([Application.Executable, proj],
             { Environment: { BINTANA_LIB_PATH: libs }, Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 eq("a plugin built for another ABI stops the program", code, 2);
                 const all = said.join("\n");
                 check("...saying which ABI it was built for and which this is",
                       all.includes("ABI 0") && all.includes("speaks 1"), all);
                 check("...and the project itself never ran",
                       !all.includes("ran"), all);
                 this.pluginBare(libs, built);
             });
    }

    /* And a shared object that is not a plugin: refused, naming the file. */
    pluginBare(libs, built) {
        const dir = File.Join(libs, "bareplug");
        Directory.Make(dir);
        File.Copy(File.Join(built, "testplug-bare", "testplug-bare.so"),
                  File.Join(dir, "bareplug.so"));

        const proj = File.Join(SCRATCH, "plugbare");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "bare", main: "Main", uses: ["bareplug"] });
        File.Save(File.Join(proj, "Main.js"),
                  "function Main() { print('ran'); }\n");

        const said = [];
        Exec([Application.Executable, proj],
             { Environment: { BINTANA_LIB_PATH: libs }, Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 eq("a shared object with no entry point stops the program",
                    code, 2);
                 const all = said.join("\n");
                 check("...saying which file is not a Bintana plugin",
                       all.includes("exports no bta_plugin"), all);
                 check("...and the project itself never ran",
                       !all.includes("ran"), all);
                 this.pluginAbi1(libs, built);
             });
    }

    /*
     * **And a plugin built to the version-1 offsets still works**, which is the
     * one claim the ABI number makes and the one nothing else here can check:
     * this `.so` was compiled against the frozen copy of the header in
     * `tests/plugins/abi1/`, so it calls the host table by the slots version 1
     * had.  A field appended to `BtaHost` is fine -- old plugins read the
     * prefix -- and a field *reordered* without the number moving is a wrong
     * call here, which is the failure a plugin recompiled from the current
     * source can never see.
     */
    pluginAbi1(libs, built) {
        const dir = File.Join(libs, "abi1plug");
        Directory.Make(dir);
        File.Copy(File.Join(built, "testplug-abi1", "testplug-abi1.so"),
                  File.Join(dir, "abi1plug.so"));

        const proj = File.Join(SCRATCH, "plugabi1");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "abi1", main: "Main", uses: ["abi1plug"] });
        File.Save(File.Join(proj, "Main.js"), `
"use strict";
function Main() {
    print("echo:" + TestPlug.Echo("version 1"));
    print("add:" + TestPlug.Add(2, 3));
    print("fields:" + JSON.stringify(TestPlug.Fields()));
    Application.Quit(0);
}
`);

        const said = {};
        Exec([Application.Executable, proj],
             { Environment: { BINTANA_LIB_PATH: libs }, Timeout: 20000 },
             (line) => {
                 const at = line.indexOf(":");
                 if (at > 0) said[line.slice(0, at)] = line.slice(at + 1);
             },
             (code) => {
                 eq("a plugin built against the version-1 header still runs",
                    code, 0);
                 eq("...its strings arrive", said.echo, "version 1");
                 eq("...its numbers arrive", said.add, "5");
                 eq("...and its setters land where version 1 put them",
                    said.fields,
                    '{"Name":"testplug","Abi":1,"Native":true,"Nil":null,"Nested":{}}');
                 waiting--;
             });
    }

    /*
     * And what a program that throws writes into a **pipe** has no colour in it.
     *
     * `Bintana error:` is written in red, and it was written in red whether or
     * not anything was listening in a terminal. That was true and invisible for
     * as long as the IDE's output pane was a VTE, which ate the escapes; the day
     * it became an ordinary text buffer they became six visible characters in
     * front of every traceback -- and the same six are in a redirected log and in
     * a CI capture, which is where most tracebacks are read from.
     *
     * `isatty` is the whole of the fix and this is the half of it that can be
     * asserted: a child of this process writes down a pipe. The other half -- the
     * red is still red on a terminal -- needs a pty and is checked by hand.
     */
    errorIsNotColoured() {
        waiting++;

        const proj = File.Join(SCRATCH, "throws");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "throws", main: "Main" });
        File.Save(File.Join(proj, "Main.js"),
                  "function Main() { throw new Error('a purpose'); }\n");

        const said = [];
        Exec([Application.Executable, proj], { Timeout: 20000 },
             (line) => said.push(line),
             () => {
                 const all = said.join("\n");
                 check("a traceback still says what went wrong",
                       all.includes("a purpose"), all);
                 check("...and down a pipe it says it with no escape in it",
                       !all.includes("\x1b"), JSON.stringify(all.slice(0, 120)));
                 waiting--;
                 this.nameTakenByForm();
             });
    }

    /*
     * A control cannot be called what a `Form` already calls something.
     *
     * `form.Button1 = <widget>` is how a handler reaches a control, and when the
     * name is already a member of `Form` the assignment **fails**: `Actions`,
     * `Menus`, `Controls`, `DefaultButton` and `CancelButton` are getters with no
     * setter. The loader used not to look at the answer -- a hundred lines above
     * the same file checks its own -- so the form went on loading with a control
     * that nothing could reach and nobody was told. This repository's own
     * `examples/clients` had a `Panel` named `Actions`, and `this.Actions` there
     * answered the form's action list.
     *
     * A *method* is a different case and is deliberately not here: `Close` is
     * shadowed by the control rather than refusing it, the assignment succeeds,
     * and finding that one is `Ide.Check`'s job. Both are written down in
     * `docs/plans/strict-plan.md`.
     */
    nameTakenByForm() {
        waiting++;

        const proj = File.Join(SCRATCH, "name-taken");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "taken", startup: "Taken", sources: ["Taken.js"] });
        File.SaveJson(File.Join(proj, "Taken.form"), {
            format: "bintana-form/1",
            class: "Taken",
            properties: { Width: 200, Height: 100 },
            children: [{ type: "Panel", name: "Actions", properties: { X: 1, Y: 1 } }],
        });
        /*
         * **`Application.OnError`, because otherwise this hangs.** A startup form
         * that fails to load puts the runtime on a modal dialog and waits for
         * somebody to dismiss it -- right for a person, a hung child for a test.
         * The hook is evaluated with the sources, before the form is built, so it
         * is already in place when the loader refuses.
         */
        File.Save(File.Join(proj, "Taken.js"),
                  "Application.OnError = (m) => { print('caught: ' + m); };\n" +
                  "class Taken extends Form { Form_Open() { print('ran'); } }\n");

        const said = [];
        Exec([Application.Executable, proj], { Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 const all = said.join("\n");
                 /* `check` and not a `neq`, which this project does not have --
                  * and reaching for one threw inside this very callback, which
                  * stopped the chain and read as a *hang* rather than as a red
                  * line. The exception was printed; the run still looked frozen. */
                 check("a control named after a Form member stops the form",
                       code !== 0, String(code));
                 check("...saying which control and why",
                       all.includes("Panel 'Actions'") &&
                       all.includes("a Form already has a member of that name"), all);
                 check("...and the form never opened", !all.includes("ran"), all);
                 check("...with the hook reaching it too",
                       all.includes("caught: TypeError"), all);
                 waiting--;
                 this.menuNameTakenByForm();
             });
    }

    /*
     * And a **menu item** cannot be called it either, nor a command.
     *
     * The loader binds all three blocks a `.form` names something in --
     * `children`, `menus` and `actions` -- on the form by name, with the same
     * `JS_SetPropertyStr`. The control one started looking at its answer and
     * these two did not, so the form went on loading with an item that
     * `MnuActions_Click` could never reach and `this.MnuActions` answered the
     * *form's* action list. Found by closing the same gap in the IDE's checks
     * and noticing the runtime had it twice more.
     *
     * Both are asserted, because they are two call sites and a fix to one is
     * not a fix to the other -- which is the whole reason this was three
     * silences and not one.
     */
    menuNameTakenByForm() {
        waiting++;

        const proj = File.Join(SCRATCH, "menu-taken");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "menutaken", startup: "Taken2", sources: ["Taken2.js"] });
        File.SaveJson(File.Join(proj, "Taken2.form"), {
            format: "bintana-form/1",
            class: "Taken2",
            properties: { Width: 200, Height: 100 },
            /* One mistake per form, because the loader builds the commands
             * before the menus and stops at the first: two in one file would
             * assert the same call site twice and the other one never. */
            menus: [{ name: "MnuTop", text: "T",
                      children: [{ name: "Actions", text: "A" }] }],
            children: [],
        });
        File.Save(File.Join(proj, "Taken2.js"),
                  "Application.OnError = (m) => { print('caught: ' + m); };\n" +
                  "class Taken2 extends Form { Form_Open() { print('ran'); } }\n");

        const said = [];
        Exec([Application.Executable, proj], { Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 const all = said.join("\n");

                 check("a menu item named after a Form member stops the form",
                       code !== 0, String(code));
                 check("...saying which item and why",
                       all.includes("menu item 'Actions'") &&
                       all.includes("a Form already has a member of that name"), all);
                 check("...and the form never opened", !all.includes("ran"), all);
                 waiting--;
                 this.commandNameTakenByForm();
             });
    }

    /* The command half, which is a different call site in the same file. */
    commandNameTakenByForm() {
        waiting++;

        const proj = File.Join(SCRATCH, "action-taken");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "acttaken", startup: "Taken3", sources: ["Taken3.js"] });
        File.SaveJson(File.Join(proj, "Taken3.form"), {
            format: "bintana-form/1",
            class: "Taken3",
            properties: { Width: 200, Height: 100 },
            actions: [{ name: "Controls", text: "C" }],
            children: [],
        });
        File.Save(File.Join(proj, "Taken3.js"),
                  "Application.OnError = (m) => { print('caught: ' + m); };\n" +
                  "class Taken3 extends Form { Form_Open() { print('ran'); } }\n");

        const said = [];
        Exec([Application.Executable, proj], { Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 const all = said.join("\n");

                 check("a command named after a Form member stops the form too",
                       code !== 0, String(code));
                 check("...saying which command and why",
                       all.includes("action 'Controls'") &&
                       all.includes("a Form already has a member of that name"), all);
                 check("...and the form never opened", !all.includes("ran"), all);
                 waiting--;
                 this.strictChecks();
             });
    }

    /*
     * `--strict`: a control refuses a property its class does not have.
     *
     * `this.Lbl.Txt = "x"` is accepted by JavaScript, creates an own property on
     * the control and does nothing, forever. Under this switch the control is
     * **non-extensible**, so the same line throws where it is written -- and the
     * runtime's own strict mode is what makes that a throw rather than a silent
     * failure, since every project source is evaluated with
     * `JS_EVAL_FLAG_STRICT` whatever its pragma says.
     *
     * **This test is the proof that a cleanup landed, not only that a flag
     * works.** Six things the runtime used to keep as own properties of a widget
     * -- `__declared`, `__children`, `__menus`, `__actions`, `__columns`,
     * `__painter` -- would each have thrown here, and two of them are created
     * long after the control is (a table's columns when an application assigns
     * `Columns`, a drawing area's painter on the first frame it paints). They
     * live on the widget's struct now. If one ever comes back, this is what says
     * so. `docs/plans/strict-plan.md` is the argument.
     *
     * **A component of the project is sealed with the controls**, and that is
     * the half this test did not have: its scratch project was built out of
     * built-in widgets only, so the mode went out with every component in this
     * tree -- `lib/markdown`, `lib/report`, `lib/charts` -- creating its fields
     * the first time it measured, drew or was pointed at, and throwing there.
     * `Probe` is a component whose fields are declared and one property that is
     * never set from a `.form`, so the line that assigns it is the line that
     * used to throw; `Nope` beside it says a component still refuses a name its
     * class does not have, which is the reason to seal one at all.
     *
     * A child process, because the switch is a property of the run: it is one
     * argument to `bintana` and there is nothing to turn on from inside.
     *
     * And the line that writes it **right** is beside the one that writes it
     * wrong, which is the half that would otherwise go unnoticed: a mode that
     * refused everything would pass a test that only looked for a throw.
     */
    strictChecks() {
        waiting++;

        const proj = File.Join(SCRATCH, "strict");
        Directory.Make(proj);
        File.SaveJson(File.Join(proj, "project.json"),
                      { name: "strict", startup: "Strict",
                        sources: ["Probe.js", "Strict.js"] });

        /* A component of the project: its own `.form`, its own class, placed on
         * the form below like any control. Its `.form` sets **nothing**, so
         * `_lazy` exists only because the class body declares it. */
        File.SaveJson(File.Join(proj, "Probe.form"), {
            format: "bintana-form/1",
            class: "Probe",
            properties: { Width: 60, Height: 20 },
            children: [],
        });
        File.Save(File.Join(proj, "Probe.js"),
                  "class Probe extends Component {\n" +
                  "    _lazy;\n" +
                  "    get Lazy()  { return this._lazy || ''; }\n" +
                  "    set Lazy(v) { this._lazy = String(v); }\n" +
                  "}\n");
        File.SaveJson(File.Join(proj, "Strict.form"), {
            format: "bintana-form/1",
            class: "Strict",
            properties: { Width: 240, Height: 140 },
            actions: [{ name: "ActGo", text: "Go" }],
            menus: [{ name: "MnuFile", text: "F",
                      children: [{ name: "MnuSave", text: "S" }] }],
            children: [
                { type: "Label",     name: "Lbl",  properties: { Text: "hi" } },
                { type: "TableView", name: "Tbl",  properties: { X: 1, Y: 40 } },
                { type: "DrawingArea", name: "Art", properties: { X: 1, Y: 80 } },
                { type: "Probe",     name: "Cmp",  properties: { X: 1, Y: 110 } },
            ],
        });
        File.Save(File.Join(proj, "Strict.js"),
                  `const PNG = ${JSON.stringify(File.Join(proj, "frame.png"))};\n` +
                  "class Strict extends Form {\n" +
                  "    Art_Draw(p) { p.Rectangle(0, 0, 10, 10); p.Fill(); }\n" +
                  "    Form_Open() {\n" +
                  "        this.own = 1;                       /* a form is not sealed */\n" +
                  "        print('form field: ' + this.own);\n" +
                  "        this.Lbl.Text = 'written';          /* the setter still works */\n" +
                  "        print('text: ' + this.Lbl.Text);\n" +
                  "        this.Tbl.Columns = [{ title: 'A' }]; /* late, and used to be a note */\n" +
                  "        this.Art.Save(PNG, 40, 40);          /* the painter, likewise */\n" +
                  "        print('columns: ' + this.Tbl.Columns.length);\n" +
                  "        print('painted: ' + (this.Art.Dump().length > 0));\n" +
                  "        try { this.Lbl.Txt = 'typo'; print('accepted Txt'); }\n" +
                  "        catch (e) { print('refused: ' + e.message); }\n" +
                  "        try { this.MnuSave.Enabld = false; print('accepted Enabld'); }\n" +
                  "        catch (e) { print('menu refused: ' + e.message); }\n" +
                  "        try { this.ActGo.Enabld = false; print('accepted action'); }\n" +
                  "        catch (e) { print('action refused: ' + e.message); }\n" +
                  "        this.Cmp.Lazy = 'set';              /* a field its class declares */\n" +
                  "        print('component: ' + this.Cmp.Lazy);\n" +
                  "        try { this.Cmp.Nope = 1; print('accepted Nope'); }\n" +
                  "        catch (e) { print('component refused: ' + e.message); }\n" +
                  "        print('saved: ' + JSON.stringify(this.Serialize()).length);\n" +
                  "        Application.Quit(0);\n" +
                  "    }\n" +
                  "}\n");

        const said = [];
        Exec([Application.Executable, "--strict", proj], { Timeout: 20000 },
             (line) => said.push(line),
             (code) => {
                 const all = said.join("\n");

                 check("the run finishes", code === 0, `${code}: ${all}`);
                 check("a form still takes fields of its own",
                       all.includes("form field: 1"), all);
                 check("...and a real property still reaches its setter",
                       all.includes("text: written"), all);
                 check("a misspelt property throws where it is written",
                       all.includes("refused: "), all);
                 check("...naming the property, which is the whole point",
                       all.includes("no 'Txt' to assign"), all);
                 check("a menu item refuses one too",
                       all.includes("no 'Enabld' to assign"), all);
                 check("...and so does a command",
                       all.split("no 'Enabld' to assign").length - 1 === 2, all);

                 /* The two that used to arrive *after* the control was built,
                  * and would have made this mode impossible. */
                 check("a table still takes its columns under the mode",
                       all.includes("columns: 1"), all);
                 check("...and a drawing area still makes its painter",
                       all.includes("painted: true"), all);

                 /* The component, both ways round: the field its class declares
                  * is writable, and the name it never declared is not. */
                 check("a component takes the fields its class declares",
                       all.includes("component: set"), all);
                 check("...and refuses one it does not have",
                       all.includes("no 'Nope' to assign"), all);
                 check("...with nothing quietly accepted",
                       !all.includes("accepted"), all);
                 check("and the form still serialises",
                       /saved: \d\d+/.test(all), all);
                 waiting--;
             });
    }

    /*
     * A tree deeper than any real form still serialises -- **in this build,
     * whichever build it is**.
     *
     * The walk that writes a `.form` is recursive with the data, and QuickJS
     * enforces a stack budget in *bytes*. What matters is the number of levels
     * that budget buys, and it is not the same number twice: measured, a tower
     * of `Panel`s serialises a hundred levels deep in an ordinary build and used
     * to stop at **ten** under AddressSanitizer, whose frames are about ten
     * times fatter. Ten is exactly the depth of the IDE's own window, so the
     * sanitized suite had no headroom at all and `tests/ide` was red there while
     * green everywhere else -- which is the false failure that job exists to
     * avoid producing, rather than one to produce.
     *
     * Fifteen is the number here because it is half again the deepest form this
     * repository has and well inside what the tightest build allows. It is an
     * assertion about the *ceiling*, so it belongs with the widgets and not with
     * the IDE: what it is really asking is whether this build can save a form at
     * all.
     */
    testDeepSerialize() {
        const DEPTH = 15;

        const root = new Panel();
        let at = root;
        for (let i = 0; i < DEPTH; i++) {
            const box = new Panel();
            box.Name = `Deep${i}`;
            at.Add(box);
            at = box;
        }

        let node = null;
        try {
            node = root.Serialize();
        } catch (e) {
            check(`a tree ${DEPTH} deep serialises`, false, e.message);
            return;
        }

        /* Walked to the bottom, so the depth asserted is the depth written. */
        let deep = 0;
        for (let n = node; n && n.children && n.children.length; n = n.children[0])
            deep++;

        eq(`a tree ${DEPTH} deep serialises, all of it`, deep, DEPTH);
    }

    /* --- DrawingArea ----------------------------------------------------- */
    /*
     * The surface, and the painter its `Draw` hands over.
     *
     * **`Save()` is what makes this testable at all**, and that is why it is in
     * the first version of the feature rather than the fourth: it runs the same
     * `Draw` against an image surface, synchronously, so everything below is
     * asserted without waiting for GTK to decide to paint. The on-screen path is
     * asserted too, at the bottom, through `until` -- because "the draw function
     * is wired to the widget" is a different claim from "the handler works".
     *
     * What is asserted is `Dump()`: the calls the painter was given, as text. The
     * same answer `Widget.Dump()` gives about a tree and for the same reason -- a
     * picture proves nothing twice. What it cannot say is that the ink landed
     * where the numbers meant, and that was checked by rendering
     * (`tests/manual`, and the plan's own screenshots).
     */
    testDrawing() {
        const area = new DrawingArea();
        this.Fixed1.Add(area);
        area.Name = "Plot1";
        /*
         * **Sized, because a drawing area has no natural size.** There is nothing
         * inside it to measure, so one placed with neither a size nor an `Expand`
         * is allocated 0x0 and its handler is called with a 0x0 frame -- which
         * draws nothing and reads as a broken control. The same is true of an
         * empty `Panel`; it is worth stating because a drawing area is *always*
         * empty as far as GTK can see.
         */
        area.Resize(200, 100);

        this.plotFrames = 0;
        this.plotWhat   = "grid";
        /* A control made in code is not a property of the form -- only what the
         * `.form` declared is -- so the handler is handed it this way. */
        this.plotArea   = area;

        eq("a surface that has never drawn has nothing to say", area.Dump(), "");
        /* Not a size, and not guessed at: a surface with no allocation has none. */
        throws("Save on an unallocated surface needs a size given",
               () => area.Save(File.Join(SCRATCH, "never.png")));

        Directory.Make(SCRATCH);
        const png = File.Join(SCRATCH, "plot.png");
        area.Save(png, 200, 100);

        eq("one Save is one frame", this.plotFrames, 1);
        eq("and the calls come back as text, in order", area.Dump(),
           "LineWidth 2\n" +
           "LineDash [2,3]\n" +
           "MoveTo (10,20)\n" +
           "LineTo (190,20)\n" +
           "Stroke\n" +
           "LineDash []\n" +
           /* What the caller said, not what it resolved to: `Color` reads back
            * the string it was given, the way every setter here does. */
           "Color blue\n" +
           "Polyline 3 points (0,0)..(20,10)\n" +
           "Stroke\n" +
           "Rectangle (4,4) 40x20\n" +
           "Fill\n" +
           "Text \"12,5\" at (8,60)\n" +
           "Arc (30,30) r20 0..90\n" +
           "ArcNegative (30,30) r10 90..0\n" +
           "ClosePath\n" +
           "Fill\n");

        /*
         * **The decimal point is a point in a `Dump()`, whatever the locale.**
         * `%g` through printf follows `LC_NUMERIC`, so the point `(380, 142.449)`
         * came out as `(380,142,449)` on the machine this was written on -- a
         * decimal comma in the middle of a comma-separated pair, in the one
         * output a test reads. It goes through `g_ascii_formatd` now.
         */
        this.plotWhat = "fraction";
        area.Save(png, 200, 100);
        check("a fraction is written with a point", area.Dump().includes("(1.5,2.25)"),
              area.Dump());

        /* A PNG that is really one, and really that size: the file is the other
         * half of what Save is for, and `Picture` is what can read one back. */
        const shown = new Picture();
        shown.File = png;
        eq("the file is an image of the size asked for", shown.SourceWidth, 200);
        eq("...in both directions",                      shown.SourceHeight, 100);

        /*
         * --- and the same frame without a file -------------------------------
         *
         * `ToPng` closes the circle from the other end: `Http` answers `Bytes`,
         * `File.SaveBytes` writes them, and until this the only way *out* of a
         * drawing was a path -- so a chart to be posted or attached was a
         * temporary file written and deleted around the one call that mattered.
         * The same frame, the same refusals, and nothing on disk.
         */
        const inMemory = area.ToPng(200, 100);
        check("ToPng answers Bytes", inMemory instanceof Bytes);
        eq("which really are a PNG", inMemory.Slice(1, 3).ToText(), "PNG");
        eq("and are the same picture the file holds",
           inMemory.Length, File.LoadBytes(png).Length);

        shown.LoadBytes(inMemory);
        eq("so a Picture reads them back at that size", shown.SourceWidth, 200);
        eq("...in both directions",                     shown.SourceHeight, 100);

        throws("a size a surface never had has to be given, here too",
               () => { new DrawingArea().ToPng(); });
        throws("and one no allocator should be asked for is refused",
               () => { area.ToPng(40000, 40000); });
        shown.Delete();

        /* Everything the painter refuses, which is everything a drawing can get
         * wrong and still look almost right. */
        this.plotWhat = "refusals";
        area.Save(png, 60, 60);
        eq("and every refusal is the painter's", this.plotRefused.join("|"),
           ["Color: 'not a colour' is not a colour",
            "LineCap: 'Flat' is not one of Butt, Round, Square",
            "LineJoin: 'Sharp' is not one of Miter, Round, Bevel",
            "LineWidth: -1 is not a width",
            "Arc: -2 is not a radius",
            "ArcNegative: -2 is not a radius",
            "a flat array of coordinates has an even length; this one has 3",
            "LineDash expects an array of lengths ([] for a solid line)",
            "LineDash: -1 is not a length"].join("|"));

        /*
         * **An image, which is a file the drawing reads rather than ink it
         * makes.** `tests/widgets/images/wide.png` is 120x80, so its proportions
         * are what a single given side has to reproduce.
         */
        this.plotWhat  = "image";
        this.plotBytes = File.LoadBytes(File.Join(IMAGES, "wide.png"));
        area.Save(png, 200, 100);
        eq("an image is drawn at its natural size, and says so",
           area.Dump().split("\n").filter((l) => l.startsWith("Image"))[0],
           `Image "${File.Join(IMAGES, "wide.png")}" at (5,5) 120x80`);
        /* One side given and the other follows: 120x80 asked for 40 tall is 60
         * wide, and a caller that had to work that out itself would have to know
         * what shape the file is -- the one thing it read the file to avoid. */
        eq("one side given scales the other with it",
           area.Dump().split("\n").filter((l) => l.startsWith("Image"))[1],
           `Image "${File.Join(IMAGES, "wide.png")}" at (5,95) 60x40`);

        /*
         * **And the bytes themselves are the same argument.** A string is a file
         * and `Bytes` are the image, which is the whole of the choice -- there
         * is nothing to configure. The dump names what it was given: a path, or
         * how many bytes there were, which is what a test can assert and a person
         * can recognise without the picture.
         */
        eq("bytes are drawn like a file, named by their size",
           area.Dump().split("\n").filter((l) => l.startsWith("Image"))[2],
           `Image "${this.plotBytes.Length} bytes" at (120,5) 30x20`);

        /*
         * **A frame that threw is not a file.** The handler's throw is reported
         * where every event's is, and it used to stop there: `Save` wrote a PNG
         * of whatever had been drawn before the error and returned happily.
         */
        /*
         * **A deliberate throw needs `OnError` taken over first.** An uncaught
         * error with no handler set opens a modal alert, `report_error` will not
         * open a second one until that one is dismissed, and nothing in a test
         * dismisses it -- so every later error in the run is swallowed and the
         * test that asserts *that* fails, three thousand assertions away. Taking
         * the handler means no dialog, and the message can be asserted besides.
         */
        const errors = [];
        Application.OnError = (message) => errors.push(message);

        this.plotWhat = "bad image";
        const missing = File.Join(SCRATCH, "not-written.png");
        throws("a Draw that throws fails the Save", () => area.Save(missing, 40, 40));
        check("and writes nothing", !File.Exists(missing));
        check("and the handler's own error is what was reported",
              errors.length === 1 && errors[0].includes("there-is-no-such-file"),
              JSON.stringify(errors));

        /*
         * **`SavePdf` is the same `Draw`, once per page, into one file.** The
         * page size is in points and the handler is told those numbers.
         *
         * **Two ways to know which page it is, and they agree.** `before(page)`
         * is called first, and then the frame itself goes to `DrawPage(p, page,
         * …)` when the form declared one -- this is paper, and paper is what
         * that event is for. A form with no `DrawPage` gets `Draw`, which is
         * what every caller had before the event existed and why nothing had to
         * change when it arrived.
         */
        this.plotWhat = "grid";
        this.plotPages = [];
        this.plotBefore = [];
        const pdf = File.Join(SCRATCH, "pages.pdf");
        area.SavePdf(pdf, 595, 842, 3, (page) => {
            this.plotBefore.push(page);
            this.plotSize = null;
        });
        eq("SavePdf writes a PDF", File.Info(pdf).Type, "application/pdf");
        eq("before is called once per page, in order", this.plotBefore.join(","), "1,2,3");
        eq("and DrawPage is told the same pages", this.plotPages.join(","), "1,2,3");
        eq("and the frame is the page, in points", JSON.stringify(this.plotSize), "[595,842]");

        eq("a page defaults to one", (() => {
            area.SavePdf(File.Join(SCRATCH, "one.pdf"), 200, 200);
            return this.plotFrames;
        })() > 0, true);

        throws("a page of no size is refused",  () => area.SavePdf(pdf, 0, 842, 1));
        throws("and one past PDF's own limit",  () => area.SavePdf(pdf, 20000, 842, 1));
        throws("and a document of no pages",    () => area.SavePdf(pdf, 595, 842, 0));
        throws("and a `before` that is not a function",
               () => area.SavePdf(pdf, 595, 842, 1, "page 1"));

        /* The same bargain as `Save`, and the reason it matters more here: cairo
         * streams a PDF as it goes, so the half of it that exists is a file that
         * would look like an export that worked. */
        const half = File.Join(SCRATCH, "half.pdf");
        this.plotWhat = "grid";
        this.plotPages = [];
        throws("a page that throws fails the document",
               () => area.SavePdf(half, 200, 200, 3, (page) => {
                   this.plotWhat = page === 2 ? "bad image" : "grid";
               }));
        check("and leaves no half-written file", !File.Exists(half));
        this.plotWhat = "grid";
        Application.OnError = null;     /* back to the dialog for anything else */

        /*
         * **And to paper, which is `Printer`'s and not the drawing's.** A
         * printer is a thing outside the program -- a name, a default, a
         * dialog -- so the verbs live on a theme of their own, the way
         * `Dialog`'s and `Desktop`'s do. `ToFile` is the road a test can
         * assert on; `Send` opens the dialog and is checked by hand.
         */
        this.plotWhat = "grid";
        this.plotPages = [];
        const printed = File.Join(SCRATCH, "printed.pdf");
        const wrote = Printer.ToFile(area, printed, { Pages: 3, Paper: "A4" });
        eq("Printer.ToFile writes a PDF with no dialog", File.Info(printed).Type,
           "application/pdf");
        eq("and answers how many pages it holds", wrote, 3);
        eq("DrawPage is called once per sheet, in order",
           this.plotPages.join(","), "1,2,3");

        /* A range of a longer document: the file holds exactly it. */
        this.plotPages = [];
        const ranged = File.Join(SCRATCH, "ranged.pdf");
        eq("a range writes exactly its pages",
           Printer.ToFile(area, ranged, { Pages: 5, Paper: "Letter",
                                          From: 2, To: 3 }), 2);
        eq("and draws exactly those", this.plotPages.join(","), "2,3");
        eq("in a Letter file", File.Info(ranged).Type, "application/pdf");

        /*
         * **A key that is `null` was not given**, which every key takes it for
         * -- and `To` is the one with a default of its own, so it is where the
         * two could disagree: it read as page 1 while `Pages` said five, and
         * printed one page without a word.
         */
        this.plotPages = [];
        Printer.ToFile(area, printed, { Pages: 4, To: null });
        eq("To: null is the absence it is", this.plotPages.join(","), "1,2,3,4");
        this.plotPages = [];
        Printer.ToFile(area, printed, { Pages: 4, To: undefined });
        eq("and so is To: undefined", this.plotPages.join(","), "1,2,3,4");

        /* **A file has no copies**, which is the whole of why there are two
         * verbs: `Copies: 3` used to answer "three sent" and write the same
         * file, byte for byte, as one. */
        throws("Copies on a file is refused",
               () => Printer.ToFile(area, printed, { Pages: 2, Copies: 3 }));

        throws("a document of no pages is refused",
               () => Printer.ToFile(area, printed, { Pages: 0 }));
        throws("and a range outside the document",
               () => Printer.ToFile(area, printed, { Pages: 3, From: 2, To: 4 }));
        throws("and a backwards one",
               () => Printer.ToFile(area, printed, { Pages: 3, From: 3, To: 2 }));
        throws("and an unknown paper",
               () => Printer.ToFile(area, printed, { Paper: "Legal" }));
        throws("and an unknown orientation",
               () => Printer.ToFile(area, printed, { Orientation: "Sideways" }));
        throws("and a setup that is not an object",
               () => Printer.ToFile(area, printed, 42));
        /* **A control that is not a drawing is refused**, and that is not
         * pedantry: every widget has a painter note it could be asked for, so
         * a `Button` handed to this came back with a one-page PDF of nothing,
         * reported as a document that was written. */
        throws("and a first argument that does not draw",
               () => Printer.ToFile("Canvas1", printed, {}));
        const notadrawing = new Button();
        this.Fixed1.Add(notadrawing);
        throws("nor does a control that is not a drawing",
               () => Printer.ToFile(notadrawing, printed, { Pages: 1 }));
        notadrawing.Delete();
        throws("and no copies either, on the road that has them",
               () => Printer.Send(area, { Copies: 0 }, () => {}));

        /*
         * **`Send` takes a callback, like every other dialog here.** The person
         * answers in their own time, so the call returns at once and the answer
         * arrives later -- and **not at all when it was cancelled**, which is
         * `Dialog.OpenFile`'s rule and spares every caller a test it would
         * forget once. A setup with no callback is refused rather than run with
         * nobody to tell.
         */
        throws("Send needs a callback", () => Printer.Send(area));
        throws("and one that is a function",
               () => Printer.Send(area, { Pages: 1 }, "later"));


        /*
         * **What the machine has**, and both ways it can answer.
         *
         * `Names` is the printers this session can reach and `Default` the one
         * it would use -- the question a palette has to be able to ask before
         * it offers a button, the same argument `Video.Available` settled. But
         * they are GTK's **Unix** print backend, an optional module, so there
         * are three answers and not two: the printers, `[]` for a machine that
         * has none, and **`null` for a session that cannot ask at all**. This
         * asserts whichever this build gives, the way `testTerminal` does for
         * VTE.
         *
         * They threw once, and twice over. `Printer.Names` read unguarded on a
         * build without the module ended `Form_Open` and took **1633 unrun
         * assertions** with it, reported as a single failure; and the `try` that
         * fixed that was a capability question answered by catching something,
         * which is the control flow `Video.Available` exists to prevent. `null`
         * is the third value the argument for throwing was really asking for.
         */
        const names = Printer.Names;

        if (names === null) {
            check("a build that cannot ask answers null, and says so once",
                  Printer.Default === null, JSON.stringify(Printer.Default));
        } else {
            check("Printer.Names is a list", Array.isArray(names),
                  JSON.stringify(names));
            check("of names", names.every((n) => typeof n === "string"),
                  JSON.stringify(names));
            check("and Default is one of them, or the empty string",
                  typeof Printer.Default === "string" &&
                  (Printer.Default === "" || names.includes(Printer.Default)),
                  `${JSON.stringify(Printer.Default)} against ${JSON.stringify(names)}`);
        }

        /*
         * **How many sheets a document is depends on the paper, and the paper
         * is not known until the dialog has been answered.**
         *
         * `Pages` in the setup is worked out against the paper the caller had.
         * A viewer laid out for A4 is more sheets on A5 -- and the operation
         * used to print the count that was declared and drop the rest: four
         * declared, six needed, four printed, silently, measured on a real
         * document. `Paginate(width, height)` is asked in `begin-print`, where
         * the paper is resolved and the count can still be changed.
         *
         * Its own control, because declaring the event changes where a range is
         * checked -- see the assertions below -- and the area above is asserting
         * the other half.
         */
        const sheet = new DrawingArea();
        this.Fixed1.Add(sheet);
        sheet.Name = "Sheet1";
        sheet.Resize(100, 60);

        const sheetPdf = File.Join(SCRATCH, "sheets.pdf");
        this.sheetDrew = [];
        const two = Printer.ToFile(sheet, sheetPdf, { Pages: 1, Paper: "A4" });
        eq("Paginate decides how many sheets there are, not the setup", two, 2);
        eq("and every one of them is drawn", this.sheetDrew.join(","), "1,2");
        check("it is asked with the printable area, which is smaller than the sheet",
              this.sheetFrame[0] < 595 && this.sheetFrame[1] < 842,
              JSON.stringify(this.sheetFrame));

        /* A smaller paper is more sheets, which is the whole point. */
        this.sheetDrew = [];
        eq("a smaller paper is more of them",
           Printer.ToFile(sheet, sheetPdf, { Pages: 1, Paper: "A5" }), 3);
        eq("and all of those are drawn too", this.sheetDrew.join(","), "1,2,3");

        /* A range is settled against the count that turned out to be true. */
        this.sheetDrew = [];
        eq("a To past the end is the end",
           Printer.ToFile(sheet, sheetPdf, { Pages: 1, Paper: "A5", From: 2, To: 9 }), 2);
        eq("and it drew exactly those", this.sheetDrew.join(","), "2,3");
        throws("a From past the end is a range with nothing in it",
               () => Printer.ToFile(sheet, sheetPdf,
                                    { Pages: 1, Paper: "A4", From: 5, To: 6 }));
        throws("and a backwards range is refused whatever the paper",
               () => Printer.ToFile(sheet, sheetPdf, { Pages: 4, From: 3, To: 2 }));

        /* A handler that throws stops the print, like a page that throws. */
        this.sheetCount = 0;         /* an answer the runtime cannot use */
        eq("an answer that is not a count leaves the declared one standing",
           Printer.ToFile(sheet, sheetPdf, { Pages: 2 }), 2);
        this.sheetCount = null;
        const pgerrors = [];
        Application.OnError = (m) => { pgerrors.push(m); };
        this.sheetThrow = true;
        throws("and a Paginate that throws stops the print",
               () => Printer.ToFile(sheet, sheetPdf, { Pages: 2 }));
        this.sheetThrow = false;
        check("with the handler's own error reported",
              pgerrors.length === 1 && pgerrors[0].includes("no pagination"),
              JSON.stringify(pgerrors));
        /*
         * **One control prints once at a time**, which only became askable when
         * the dialog stopped blocking. GTK runs a nested main loop while it is
         * up, so the program keeps going -- timers fire, buttons can be clicked
         * -- and a second print of the same drawing used to start and write its
         * pages. Measured before the guard existed. The `Draw` guard does not
         * catch it: between two sheets there is no frame open.
         *
         * Asserted from inside `DrawPage`, which is a moment the first print is
         * certainly in flight.
         */
        this.sheetInner = null;
        this.sheetCtl     = sheet;      /* the handler is the form's, not the control's */
        this.sheetReenter = sheetPdf;
        Printer.ToFile(sheet, sheetPdf, { Pages: 2 });
        this.sheetReenter = null;
        check("a print inside a print is refused by name",
              this.sheetInner !== null &&
              this.sheetInner.includes("already printing"),
              JSON.stringify(this.sheetInner));

        Application.OnError = null;
        sheet.Delete();

        /* A page that throws fails the run, and a file road must not keep
         * the half of it that exists -- the same bargain as `SavePdf`. */
        const phalf = File.Join(SCRATCH, "phalf.pdf");
        const perrors = [];
        Application.OnError = (m) => { perrors.push(m); };
        this.plotBad = 2;
        throws("a page that throws fails the print",
               () => Printer.ToFile(area, phalf, { Pages: 3 }));
        this.plotBad = 0;
        check("and leaves no half-written file", !File.Exists(phalf));
        check("and the handler's own error is what was reported",
              perrors.length === 1 &&
              perrors[0].includes("there-is-no-such-file"),
              JSON.stringify(perrors));
        this.plotWhat = "grid";
        Application.OnError = null;     /* back to the dialog for anything else */

        /* Printing from inside a `Draw` is refused up front, with the dialog
         * still down -- refusing one page later would show it first. */
        this.plotWhat = "nestedprint";
        area.Save(png, 40, 40);
        check("a Draw that prints is refused",
              this.plotNested.includes("already being drawn"), this.plotNested);
        this.plotWhat = "grid";

        /*
         * **The painter is over when the frame is.** The natural mistake is to
         * keep it and draw from a timer later, which is a write into freed memory
         * a few frames on -- so it is a refusal and not a crash.
         */
        throws("a painter kept past its frame refuses", () => this.plotKept.MoveTo(0, 0));
        check("and says why", (() => {
            try { this.plotKept.Stroke(); return ""; }
            catch (e) { return e.message; }
        })().includes("the frame is over"));

        /* One object per surface, reused: the same painter came back. */
        this.plotWhat = "grid";
        const first = this.plotKept;
        area.Save(png, 200, 100);
        check("the same painter is handed over every frame", this.plotKept === first);

        throws("and a Painter cannot be built by hand", () => new Painter());

        /* One painter means one frame at a time, and `Save` is a frame: asking
         * for another from inside a handler would take the outer one's context
         * away and leave it refusing for a reason nobody could act on. */
        this.plotWhat = "nested";
        area.Save(png, 40, 40);
        check("a Draw asking for a frame of its own is refused",
              this.plotNested.includes("a frame is already being drawn"),
              this.plotNested);
        this.plotWhat = "grid";

        throws("and a size no allocator should be asked for is refused",
               () => area.Save(png, 40000, 40000));
        check("though the class is there, so a handler can ask",
              this.plotKept instanceof Painter);

        /* The theme's ink, which is the one fact a drawing cannot work out and
         * the reason a chart is visible on a dark desktop. */
        check("the painter arrives knowing the theme's ink",
              /^rgba?\(\d+,\d+,\d+/.test(this.plotInk), this.plotInk);
        eq("and whether the ground is dark, derived from it",
           typeof this.plotDark, "boolean");
        /* One derivation and not two: `Painter.Dark` and `Widget.Dark` are the
         * same function, so a drawing and the form around it cannot disagree
         * about which way the desktop is. */
        eq("which is the same answer the control itself gives",
           this.plotDark, this.plotArea.Dark);

        /*
         * **And the control's own `Foreground` is what it reads**, resolved
         * through the style: so a form can colour a drawing in the `.form` and
         * the handler needs to know nothing about it.
         *
         * Set before the first frame it lands at once, as here -- there is no
         * computed style yet to be stale. *Changing* it after one does not, until
         * a turn has passed: measured, `rgb(255,0,0)` still in the same turn and
         * the new colour in the next. On screen that never bites, since a frame
         * is always a turn away; it bites exactly one way, in a `Save()` in the
         * same turn as the change.
         */
        const tinted = new DrawingArea();
        this.Fixed1.Add(tinted);
        tinted.Name       = "Plot2";
        tinted.Foreground = "rgb(255,0,0)";
        tinted.Save(File.Join(SCRATCH, "tinted.png"), 20, 20);
        eq("a drawing takes its ink from the control's Foreground",
           this.plot2Ink, "rgb(255,0,0)");
        tinted.Delete();

        /* And the on-screen path, which `Save` cannot speak for. */
        const before = this.plotFrames;
        area.Redraw();
        until("the surface is drawn on screen", () => this.plotFrames > before, () => {
            check("a real frame carries the widget's own size",
                  this.plotSize[0] > 0 && this.plotSize[1] > 0,
                  JSON.stringify(this.plotSize));
            area.Delete();
        });
    }

    Plot2_Draw(p) { this.plot2Ink = p.Foreground; }

    /* The paper's handler: the sheet arrives as an argument, which is the whole
     * point of the event -- it used to travel through a field of this form,
     * written by a `before` callback and read back in `Draw`. The body is the
     * screen's, so what is asserted about a page is what is asserted about a
     * frame. */
    /* The second drawing area's three handlers: it exists to assert `Paginate`,
     * which the first one deliberately does not declare. One sheet per 200
     * points of height, so the count really does follow the paper. */
    Sheet1_Paginate(width, height) {
        this.sheetFrame = [width, height];
        /*
         * The re-entry probe, and `Paginate` is the right moment for it: the
         * print is under way and **no frame is open**, which is the gap the
         * painter's own guard cannot see and the one a timer or a second click
         * falls into.
         */
        if (this.sheetReenter && this.sheetInner === null) {
            try {
                Printer.ToFile(this.sheetCtl, this.sheetReenter, { Pages: 1 });
                this.sheetInner = "NOT REFUSED";
            } catch (e) { this.sheetInner = e.message; }
        }
        if (this.sheetThrow) throw new Error("no pagination today");
        if (this.sheetCount !== null && this.sheetCount !== undefined)
            return this.sheetCount;
        return Math.ceil(1200 / height);
    }

    Sheet1_DrawPage(p, page, width, height) {
        this.sheetDrew.push(page);
        p.Text(10, 20, `sheet ${page}`);
    }

    Sheet1_Draw(p, width, height) { p.Text(10, 20, "sheet"); }

    Plot1_DrawPage(p, page, width, height) {
        this.plotPages.push(page);
        /* Which sheet is asked to fail, for the assertion that a page that
         * throws takes the whole print with it. 0 means none. */
        const was = this.plotWhat;
        if (this.plotBad === page)
            this.plotWhat = "bad image";
        try { this.Plot1_Draw(p, width, height); }
        finally { this.plotWhat = was; }
    }

    Plot1_Draw(p, width, height) {
        this.plotFrames++;
        this.plotKept = p;
        this.plotInk  = p.Foreground;
        this.plotDark = p.Dark;
        this.plotSize = [width, height];

        if (this.plotWhat === "fraction") {
            p.MoveTo(1.5, 2.25);
            return;
        }
        if (this.plotWhat === "nested") {
            try { this.plotArea.Save(File.Join(SCRATCH, "nested.png"), 20, 20);
                  this.plotNested = "NOT REFUSED"; }
            catch (e) { this.plotNested = e.message; }
            return;
        }
        if (this.plotWhat === "nestedprint") {
            try { Printer.ToFile(this.plotArea, File.Join(SCRATCH, "nested.pdf"), {});
                  this.plotNested = "NOT REFUSED"; }
            catch (e) { this.plotNested = e.message; }
            return;
        }
        if (this.plotWhat === "image") {
            p.Image(File.Join(IMAGES, "wide.png"), 5, 5);
            p.Image(File.Join(IMAGES, "wide.png"), 5, 95, undefined, 40);
            /* The same picture by the other road: the bytes themselves, which
             * is what Http answers with and File.LoadBytes reads. */
            p.Image(this.plotBytes, 120, 5, 30, 20);
            return;
        }
        if (this.plotWhat === "bad image") {
            p.Image(File.Join(IMAGES, "there-is-no-such-file.png"), 0, 0);
            return;
        }
        if (this.plotWhat === "metrics") {
            p.Font = this.metricsFont;
            this.metricsPainter = { Width: p.TextWidth(this.metricsText),
                                    Height: p.TextHeight(this.metricsText) };

            /* The same three options `Text` measures with, on the painter:
             * a wrapped run, a styled one, and the two together -- which is
             * what a paragraph of `lib/markdown` is. */
            this.metricsWrapped = p.TextHeight(this.metricsLong, { Width: 120 });
            this.metricsMarkup  = p.TextWidth(this.metricsStyled, { Markup: true });
            this.metricsPlain   = p.TextWidth(this.metricsText);

            p.Text(this.metricsStyled, 0, 0, { Width: 120, Markup: true, Align: "Right" });
            p.Text(this.metricsText, 0, 60);

            this.metricsBad = [];
            const refused = (fn) => {
                try { fn(); this.metricsBad.push("NOT REFUSED"); }
                catch (e) { this.metricsBad.push(e.message); }
            };
            refused(() => p.Text("a <b>b", 0, 0, { Markup: true }));
            refused(() => p.Text("x", 0, 0, { Align: "Middle" }));
            refused(() => p.Text("x", 0, 0, "wide"));
            return;
        }
        if (this.plotWhat === "refusals") {
            this.plotRefused = [];
            const refused = (fn) => {
                try { fn(); this.plotRefused.push("NOT REFUSED"); }
                catch (e) { this.plotRefused.push(e.message); }
            };
            refused(() => { p.Color     = "not a colour"; });
            refused(() => { p.LineCap   = "Flat"; });
            refused(() => { p.LineJoin  = "Sharp"; });
            refused(() => { p.LineWidth = -1; });
            refused(() => p.Arc(10, 10, -2, 0, 90));
            refused(() => p.ArcNegative(10, 10, -2, 90, 0));
            refused(() => p.Polyline([1, 2, 3]));
            refused(() => { p.LineDash  = 4; });
            /* A negative *inside* the array: the message used to be built out
             * of the array after it was freed, which read correctly and was a
             * use-after-free.  This is the assertion that proves it under
             * tests/asan.sh. */
            refused(() => { p.LineDash  = [-1]; });
            return;
        }

        p.LineWidth = 2;
        p.LineDash  = [2, 3];
        p.MoveTo(10, 20);
        p.LineTo(190, 20);
        p.Stroke();

        p.LineDash = [];
        p.Color    = "blue";
        p.Polyline([0, 0, 10, 5, 20, 10]);
        p.Stroke();

        p.Rectangle(4, 4, 40, 20);
        p.Fill();
        p.Text("12,5", 8, 60);

        /* A ring segment, which is the shape `ArcNegative` exists for: one path,
         * out along the outer radius and back along the inner one. Written with a
         * `MoveTo` for the way back it is two subpaths, and a fill across two
         * subpaths cuts wedges through it -- what a doughnut looked like before
         * this call was added. */
        p.Arc(30, 30, 20, 0, 90);
        p.ArcNegative(30, 30, 10, 90, 0);
        p.ClosePath();
        p.Fill();
    }

    /* --- Scroller: where it is scrolled to -----------------------------------
     *
     * A list that remembers where the user was, one that loads a page more as
     * they near the bottom, a log pinned to its newest line. The claim that
     * matters is that the **maximum is the content minus one view**, so
     * `ScrollY === ScrollMaxY` is the honest test for *at the bottom* -- the
     * content's own height would be a position where the last screenful is
     * already past the edge.
     */
    testScrolling() {
        const sc = new Scroller();
        this.Fixed1.Add(sc);
        sc.Name = "Sc1";
        sc.Resize(200, 120);

        eq("nothing to scroll is a maximum of nothing", sc.ScrollMaxY, 0);
        eq("and a position of nothing",                 sc.ScrollY, 0);

        for (let i = 0; i < 40; i++) {
            const row = new Label();
            row.Text = `row ${i}`;
            row.Move(0, i * 30);
            row.Resize(400, 24);
            sc.Add(row);
        }

        this.scrolled = [];

        /* **The content has to have been laid out before the end exists.** The
         * rows were added in this turn and have no allocation yet, so the
         * adjustment still describes the empty scroller; one turn later it is
         * the real thing. It is the same rule `PickAt` and `Bounds()` follow. */
        until("the content is measured", () => sc.ScrollMaxY > 0, () => {
            const max = sc.ScrollMaxY;
            check("taller content can be scrolled", max > 0, max);
            check("and wider content across too",   sc.ScrollMaxX > 0, sc.ScrollMaxX);

            sc.ScrollY = max;
            eq("scrolling to the maximum arrives", sc.ScrollY, max);
            check("which is what at-the-bottom means", sc.ScrollY === sc.ScrollMaxY);

            sc.ScrollY = 99999;
            eq("past the end is the end", sc.ScrollY, max);
            sc.ScrollY = -20;
            eq("and before the start is the start", sc.ScrollY, 0);

            sc.ScrollX = 30;
            eq("across is its own axis", sc.ScrollX, 30);
            eq("and did not move the other one", sc.ScrollY, 0);

            /* Every move said so, both axes at once. */
            check("the moves were reported", this.scrolled.length >= 3,
                  JSON.stringify(this.scrolled));
            check("each carrying both axes",
                  this.scrolled.every((p) => p.length === 2),
                  JSON.stringify(this.scrolled));
            check("and the last one is where it ended up",
                  JSON.stringify(this.scrolled[this.scrolled.length - 1]) ===
                  JSON.stringify([sc.ScrollX, sc.ScrollY]),
                  JSON.stringify(this.scrolled));

            throws("a position that is not a number is refused",
                   () => { sc.ScrollY = "down"; });

            sc.Delete();
        });
    }

    Sc1_Scroll(x, y) { this.scrolled.push([x, y]); }

    /* --- A Scroller that fills the room it has, and scrolls when it cannot ----
     *
     * These are two containers in the field's vocabulary -- WinForms'
     * `TableLayoutPanel` with `AutoScroll`, CSS `overflow: auto` around a grid
     * -- and one here, which is why it was reported as a gap and is not one:
     * **`Arrangement` decides which of the two a `Scroller` is.**
     *
     * Its slot is a `Fixed` unless it is told otherwise, and a `Fixed` sizes
     * its content at the content's own natural size: there is no design size
     * for an anchor to keep a gap against, so `Fill` has nothing to fill and a
     * panel in a scroller is as wide as what is in it. Arranged, the slot is a
     * box, and a box stretches an expanding child across itself and lets it
     * grow past the view along itself -- which is fill *and* scroll, decided by
     * the content rather than ahead of it.
     *
     * The numbers this was written against are a wall of camera tiles, a `Grid`
     * of `ceil(sqrt(n))` columns in a 900x500 view: **one tile is 898x498**,
     * four are 2x2 at 445x245 with nothing to scroll, and twenty are a
     * 924x538 grid with `ScrollMaxY 38` -- and the window stays 900x500.
     * `examples/kanban` is the same two words the other way round: a row of
     * columns that scrolls sideways, each column a scroller that fills.
     *
     * The half that is **not** `Arrangement`'s, measured the same afternoon:
     * an axis that may not scroll propagates its content's minimum outwards,
     * so the same twenty tiles under `Scrollbars: "Vertical"` push the window
     * from 900 to 924 wide. A floor on the scroller does not stop it and is
     * not what this is for -- scroll the axis that must not ask its parent for
     * room.
     */
    testFillScroll() {
        const W = 240, H = 160;

        /* The declared shape is the same for both, and only the arrangement
         * differs -- which is the whole claim. */
        const build = (name, arranged) => {
            const sc = new Scroller();
            this.Fixed1.Add(sc);
            sc.Name = name;
            if (arranged) sc.Arrangement = "Vertical";
            sc.Scrollbars = "Both";
            sc.Resize(W, H);

            const inner = new Panel();
            inner.HAlign  = "Fill";
            inner.VAlign  = "Fill";
            inner.HExpand = true;
            inner.VExpand = true;
            inner.MinWidth  = 60;
            inner.MinHeight = 40;
            sc.Add(inner);
            return [sc, inner];
        };

        const [plain,  loose] = build("ScPlain", false);
        const [filled, tight] = build("ScFilled", true);

        until("both scrollers are laid out",
              () => plain.Bounds().Width > 1 && filled.Bounds().Width > 1, () => {
            const view = filled.Bounds();
            const got  = tight.Bounds();
            const nat  = loose.Bounds();

            check("a Fixed slot leaves its content at its own size",
                  nat.Width < view.Width - 40,
                  `${nat.Width} in a view of ${view.Width}`);

            eq("an arranged slot hands it the view's width",  got.Width,  view.Width);
            eq("and the view's height while there is spare", got.Height, view.Height);
            eq("with nothing to scroll",                     filled.ScrollMaxY, 0);

            /* And now the content outgrows the view. Its floor is what it may
             * not be squeezed below -- the axis is `Fill` -- so this is the
             * same declaration asking for more than there is. */
            tight.MinHeight = H * 2;

            until("the taller content is measured", () => filled.ScrollMaxY > 0, () => {
                check("content that no longer fits scrolls instead",
                      filled.ScrollMaxY > 0, String(filled.ScrollMaxY));
                eq("and the view is still the size it was given",
                   filled.Bounds().Height, view.Height);
                eq("while the width still follows it",
                   tight.Bounds().Width, view.Width);

                plain.Delete();
                filled.Delete();
            });
        });
    }


    /* --- Time: the clock half of Day ----------------------------------------
     *
     * A time of day is the text `"HH:MM"` (seconds optional), for the same
     * reasons a date is `"YYYY-MM-DD"`: it is what a schedule holds, it sorts as
     * itself, and it is not an instant -- 08:30 has no day and no time zone.
     *
     * **The two claims worth testing are the strictness and the wrap.** The
     * shape is fixed so that `a < b` orders two times, which is what everything
     * else here relies on; and `Add` wraps at midnight where `Day.Add` refuses
     * to leave the calendar, because a clock has no end to fall off.
     */
    testTime() {
        eq("Now is HH:MM:SS", /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(Time.Now),
           true, Time.Now);

        eq("adding minutes",           Time.Add("08:30", 40), "09:10");
        eq("and taking them away",     Time.Add("09:10", -40), "08:30");
        eq("adding past midnight wraps", Time.Add("23:50", 30), "00:20");
        eq("and before it, the other way", Time.Add("00:20", -45), "23:35");
        eq("a whole day is where it started", Time.Add("07:45", 24 * 60), "07:45");
        eq("and two days too",         Time.Add("07:45", 48 * 60), "07:45");

        /* Seconds are optional and kept: a schedule written in minutes stays in
         * minutes, and nothing grows `:00` for having been through here. */
        eq("minutes stay minutes",     Time.Add("08:30", 1), "08:31");
        eq("seconds are kept",         Time.Add("08:30:15", 1), "08:31:15");

        eq("between two times, in minutes", Time.Between("08:30", "19:00"), 630);
        eq("and signed the other way",      Time.Between("19:00", "08:30"), -630);
        eq("the same time is no time at all", Time.Between("11:11", "11:11"), 0);
        eq("seconds since midnight",   Time.Seconds("08:30:15"), 30615);
        eq("and at the start of it",   Time.Seconds("00:00"), 0);

        /* **Strict on the shape, which is what makes them sortable.** A value
         * that is sometimes four characters and sometimes five does not order,
         * and ordering is most of what a time held as text is for. */
        throws("a missing leading zero is refused", () => Time.Seconds("8:30"));
        throws("and an hour that no clock shows",   () => Time.Seconds("24:00"));
        throws("and sixty minutes",                 () => Time.Seconds("12:60"));
        throws("and something that is not a time",  () => Time.Seconds("half eight"));
        throws("and nothing at all",                () => Time.Seconds());
        throws("Add needs both",                    () => Time.Add("08:00"));
        throws("Between needs both",                () => Time.Between("08:00"));

        check("and they order as text", "09:30" < "17:00" && "23:00" > "08:15");

        /* And the field kind, which is where a record checks one. */
        class Hours extends Record {
            static Fields = {
                Opens:  Field.Time({ required: true }),
                Closes: Field.Time({ min: "06:00", max: "22:00" }),
            };
        }

        const h = new Hours({ Opens: "08:30", Closes: "19:00" });
        eq("a record holds a time", h.Opens, "08:30");
        eq("and saves it as itself", h.Serialize().Closes, "19:00");
        eq("with seconds when it has them",
           new Hours({ Opens: "08:30:45" }).Opens, "08:30:45");

        throws("a field refuses a shape that is not a time",
               () => { h.Opens = "half eight"; });
        throws("and a time past its max", () => { h.Closes = "23:30"; });
        throws("and one before its min",  () => { h.Closes = "05:59"; });
        throws("and nothing where one is required",
               () => { h.Opens = ""; });

        /* Reading is lenient and says what it could not take, the way every
         * other field kind does. */
        const read = Hours.Load({ Opens: "08:00", Closes: "25:00" });
        eq("a bad time is a problem and not a throw", read.Problems.length, 1);
        check("naming the field", read.Problems[0].includes("Closes"),
              JSON.stringify(read.Problems));
    }

    /* --- TableView: rows that nest -------------------------------------------
     *
     * A table whose rows have a `Key` is a tree. What that is *for* is the shape
     * a file browser is -- a hierarchy where every row also has fields, with the
     * headings over the whole of it -- which until now was two controls and a
     * join kept by hand.
     *
     * **The claim under all of it is that a node is addressed by its key**, and
     * the reason is worth a test of its own: a position in a tree is a position
     * in the *visible* list, so it moves when something above it collapses. The
     * assertion that says so is the one where collapsing changes `Index` and
     * leaves `Key` alone.
     */
    testTableTree() {
        const t = new TableView();
        this.Fixed1.Add(t);
        t.Name = "Tree1";
        t.Resize(400, 200);
        t.Columns = [{ Text: "Name" }, { Text: "Size", Alignment: "Right" }];

        t.Add(["src", "3"],       { Key: "/src" });
        t.Add(["main.c", "12 KB"], { Key: "/src/main.c", Parent: "/src" });
        t.Add(["bta.h", "4 KB"],   { Key: "/src/bta.h",  Parent: "/src" });
        t.Add(["docs", "1"],       { Key: "/docs" });
        t.Add(["api.md", "40 KB"], { Key: "/docs/api.md", Parent: "/docs" });

        eq("Count is every node at every level", t.Count, 5);
        eq("a node is there", t.Exists("/src/bta.h"), true);
        eq("and one that is not, is not", t.Exists("/nope"), false);

        /* Addressed by key, in every member that used to take an index. */
        eq("Cell by key", t.Cell("/src/main.c", 1), "12 KB");
        eq("Row by key",  JSON.stringify(t.Row("/docs")), JSON.stringify(["docs", "1"]));
        t.Key = "/docs/api.md";
        t.SetCell("/docs/api.md", 1, "41 KB");
        eq("SetCell by key", t.Cell("/docs/api.md", 1), "41 KB");
        /* Changing a cell is not moving the selection -- which a flat table
         * gets from GTK and a tree has to be given. */
        eq("and it does not move the selection", t.Key, "/docs/api.md");
        t.SetIcon("/src", 0, "folder");
        eq("SetIcon by key does not disturb the text", t.Cell("/src", 0), "src");

        /* And an icon can come *with* the node, the way `TreeView.Add` takes
         * one -- a second call for something known at the first is what the
         * two controls disagreed about. */
        t.Add(["lib", "0"], { Key: "/lib", Icon: "folder" });
        eq("a node added with an icon is still a node", t.Exists("/lib"), true);
        eq("and its cells are its cells", t.Cell("/lib", 0), "lib");

        /* Opening and closing, and `AutoExpand` which is on. */
        eq("AutoExpand is on", t.AutoExpand, true);
        eq("so a node that gained children is open", t.Expanded("/src"), true);
        t.CollapseNode("/src");
        eq("and it closes", t.Expanded("/src"), false);
        t.ExpandNode("/src");
        eq("and opens again", t.Expanded("/src"), true);
        t.CollapseAll();
        check("CollapseAll closes every one",
              !t.Expanded("/src") && !t.Expanded("/docs"));
        t.ExpandAll();
        check("and ExpandAll opens them", t.Expanded("/src") && t.Expanded("/docs"));

        /*
         * **Why a key and not a position.** With everything open, `/docs` is the
         * fourth row; collapsing `/src` takes two rows out from above it and it
         * becomes the second. The key did not move.
         */
        t.Key = "/docs";
        const openAt = t.Index;
        t.CollapseNode("/src");
        check("a position moves when something above it collapses",
              t.Index !== openAt, `${openAt} then ${t.Index}`);
        eq("and the key does not", t.Key, "/docs");
        t.ExpandAll();

        /* Selecting by key opens the way to the node: one under a closed parent
         * has no row to select. */
        t.CollapseNode("/src");
        t.Key = "/src/bta.h";
        eq("selecting a hidden node reveals it", t.Key, "/src/bta.h");
        eq("which means opening its parent", t.Expanded("/src"), true);

        /* Sorting is per level -- a child above its own parent is not an order --
         * and the selection survives it, as it does in a flat table. */
        t.SortBy(0, false);
        eq("the selection survives a sort", t.Key, "/src/bta.h");
        eq("and the levels are what got sorted", t.Cell("/src", 0), "src");

        /* What a tree refuses, and every message says what would have worked. */
        throws("a row with no key, in a tree",   () => t.Add(["x"]));
        throws("an empty key",                   () => t.Add(["x"], { Key: "" }));
        throws("options with no Key",            () => t.Add(["x"], { Parent: "/src" }));
        throws("a key that is already there",    () => t.Add(["x"], { Key: "/src" }));
        throws("a parent that is not there",     () => t.Add(["x"], { Key: "/x", Parent: "/nope" }));
        throws("a node that is not there",       () => t.SetCell("/nope", 0, "x"));
        throws("Count, which a tree answers itself", () => { t.Count = 5; });
        throws("MultiSelect on a hierarchy",     () => { t.MultiSelect = true; });

        /* Removing a node takes its subtree with it: a subtree with no parent is
         * not something this control can show. */
        t.Remove("/src");
        eq("the node is gone",      t.Exists("/src"), false);
        eq("and so are its children", t.Exists("/src/main.c"), false);
        eq("leaving the rest",      t.Count, 3);

        /* And `Clear()` is the way back out of the tree: a table is flat or a
         * tree, decided by the first row put in it. */
        t.Clear();
        eq("cleared", t.Count, 0);
        t.Add(["flat", "again"]);
        eq("and flat again",  JSON.stringify(t.Row(0)), JSON.stringify(["flat", "again"]));
        eq("addressed by index once more", t.Cell(0, 1), "again");
        eq("with no keys in it", t.Exists("/src"), false);

        /* The other two controls are untouched by any of it. */
        const flat = new TableView();
        this.Fixed1.Add(flat);
        flat.Columns = [{ Text: "One" }];
        flat.Add(["a"]);
        throws("a flat table has no nodes to expand", () => flat.ExpandNode("a"));
        eq("and answers Exists with false", flat.Exists("a"), false);
        eq("and Key with nothing", flat.Key, "");
        flat.Delete();

        t.Delete();
    }

    /* --- Bytes --------------------------------------------------------------
     *
     * The value a file is when it is not text. Two claims are worth testing and
     * the rest follows from them: that a file survives a round trip **byte for
     * byte**, which is the whole point, and that the text edge is a refusal
     * rather than a mangling -- bytes that are not UTF-8 have no text to be, and
     * answering replacement characters would be corruption that reads like
     * success.
     */
    testBytes() {
        const hello = new Bytes("hola ñandú");

        eq("text goes in as its UTF-8", hello.Length, 12);   /* ñ and ú are two each */
        eq("and comes back out",        hello.ToText(), "hola ñandú");
        eq("nothing is nothing",        new Bytes().Length, 0);
        eq("and its text is empty",     new Bytes().ToText(), "");
        eq("a copy is a copy",          new Bytes(hello).Equals(hello), true);

        eq("a list of numbers is those bytes",
           new Bytes([137, 80, 78, 71]).ToHex(), "89504e47");
        eq("hex reads back",  Bytes.FromHex("89504e47").ToHex(), "89504e47");
        eq("base64 too",      Bytes.FromBase64(hello.ToBase64()).ToText(), "hola ñandú");

        eq("At is one byte",  hello.At(0), 104);
        eq("Slice cuts",      hello.Slice(0, 4).ToText(), "hola");
        eq("past the end is what there is", hello.Slice(0, 999).Length, 12);
        eq("a negative start counts back",  hello.Slice(-5).ToText(), "andú");
        eq("Concat joins",
           new Bytes("a").Concat(new Bytes("b"), new Bytes("c")).ToText(), "abc");

        /* `==` compares two objects by identity, so two files read separately
         * would never be equal without this. */
        check("Equals is byte for byte",
              hello.Equals(new Bytes("hola ñandú")) &&
              !hello.Equals(new Bytes("hola")) &&
              !hello.Equals("hola ñandú"));

        /* **`${b}` is a description and not the content.** A JPEG interpolated
         * into a log line by accident is a megabyte of noise that reads as if it
         * had worked. */
        eq("toString says what it is", `${hello}`, "Bytes(12)");
        eq("and JSON carries base64",
           JSON.stringify({ f: hello }), `{"f":"${hello.ToBase64()}"}`);

        throws("At past the end",        () => hello.At(99));
        throws("a byte over 255",        () => new Bytes([1, 300]));
        throws("half a hex byte",        () => Bytes.FromHex("abc"));
        throws("something that is not base64", () => Bytes.FromBase64("hello"));
        throws("and bytes that are not text",
               () => new Bytes([0xff, 0xfe]).ToText());
        throws("a source that is neither", () => new Bytes(42));

        /* A real file, in and out, which is the case the whole thing exists
         * for: `File.Load` would have replaced every byte that is not UTF-8. */
        Directory.Make(SCRATCH);
        const png  = File.Join(IMAGES, "wide.png");
        const copy = File.Join(SCRATCH, "copied.png");
        const read = File.LoadBytes(png);

        eq("a PNG starts with its signature",
           read.Slice(0, 8).ToHex(), "89504e470d0a1a0a");
        /* The size is in the header, big-endian at byte 16 -- which is the
         * example the issue that asked for this was written around. */
        const be = (i) => (read.At(i) << 24) | (read.At(i + 1) << 16) |
                          (read.At(i + 2) << 8) | read.At(i + 3);
        eq("and its width in the header",  be(16), 120);
        eq("and its height",               be(20), 80);

        File.SaveBytes(copy, read);
        check("a file written back is the same file",
              File.LoadBytes(copy).Equals(read));
        eq("and hashes the same", Hash.Sha256(read), File.Hash(copy));
        check("where File.Load would not have",
              new Bytes(File.Load(png)).Length !== read.Length);

        throws("SaveBytes will not take text",
               () => File.SaveBytes(copy, "text"));
        throws("and LoadBytes says when there is no file",
               () => File.LoadBytes(File.Join(SCRATCH, "no-such-file")));
        File.Delete(copy);

        /* And in a record, which is where an attachment lives. */
        class Attachment extends Record {
            static Fields = {
                Name: Field.Text({ required: true }),
                Data: Field.Bytes({ required: true, max: 4096 }),
            };
        }

        const a = new Attachment({ Name: "wide.png", Data: read });
        eq("a record holds it", a.Data.Length, read.Length);
        eq("and writes base64", typeof a.Serialize().Data, "string");
        check("which reads back as the same bytes",
              Attachment.Load(a.Serialize()).Data.Equals(read));
        check("a copy keeps them too", a.Clone().Data.Equals(read));

        const blank = new Attachment();
        eq("a bytes field starts empty", blank.Data.Length, 0);
        check("and empty is not written to the file",
              !("Data" in blank.Serialize()), JSON.stringify(blank.Serialize()));
        check("required means not empty",
              blank.Validate().some((p) => p.includes("Data")),
              JSON.stringify(blank.Validate()));

        throws("a field refuses text that is not base64",
               () => { a.Data = "hello"; });
        throws("and anything that is not bytes at all",
               () => { a.Data = 42; });
        throws("and more than its max",
               () => { a.Data = new Bytes(new Array(5000).fill(65)); });

        /* Reading is lenient and reports, the way every field kind is. */
        const bad = Attachment.Load({ Name: "x", Data: "not base64!" });
        check("a bad file is a problem and not a throw",
              bad.Problems.length === 1 && bad.Problems[0].includes("Data"),
              JSON.stringify(bad.Problems));
    }

    /* --- Hash ---------------------------------------------------------------
     *
     * Checksums, and the only claim worth making about one is that it is **the**
     * checksum: a digest that is merely self-consistent is a digest that will not
     * match the published one it exists to be compared against. So the vectors
     * below are the standard ones, and the file assertions are checked against
     * the string answer for the same bytes.
     */
    testHash() {
        eq("SHA-256 of abc", Hash.Sha256("abc"),
           "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        eq("MD5 of abc", Hash.Md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
        eq("SHA-1 of nothing", Hash.Sha1(""),
           "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        eq("SHA-512 of abc, its first half", Hash.Sha512("abc").slice(0, 32),
           "ddaf35a193617abacc417349ae204131");

        /* **A string is hashed as its UTF-8 bytes**, which is what makes this
         * digest the same one `sha256sum` gives for a file holding that text --
         * accents and all. Any other reading would be a private convention. */
        eq("and a string is its UTF-8 bytes", Hash.Sha256("ñandú"),
           "43dbd6bf7148e6e6584eee6d8b61ab8e5dd76374c4587cdabd50a3274e11f9d3");

        eq("every digest is lower-case hex", /^[0-9a-f]{64}$/.test(Hash.Sha256("x")), true);

        Directory.Make(SCRATCH);
        const path = File.Join(SCRATCH, "hashed.txt");
        File.Save(path, "abc");

        eq("File.Hash defaults to SHA-256", File.Hash(path), Hash.Sha256("abc"));
        eq("and takes any of the four",     File.Hash(path, "Md5"), Hash.Md5("abc"));
        eq("naming it in any case",         File.Hash(path, "sha256"), Hash.Sha256("abc"));

        /* The file is read in 64 KB blocks, so what this proves is that the
         * blocks are fed in order and nothing is dropped at the seam -- the one
         * thing a chunked checksum gets wrong. */
        let big = "";
        for (let i = 0; i < 20000; i++) big += `line ${i}\n`;
        const bigPath = File.Join(SCRATCH, "big.txt");
        File.Save(bigPath, big);
        check("a file past the block size hashes the same as its text",
              File.Hash(bigPath) === Hash.Sha256(big) && big.length > 200000,
              `${big.length} bytes`);

        throws("an algorithm it does not know is refused",
               () => File.Hash(path, "crc32"));
        throws("a file that is not there says so",
               () => File.Hash(File.Join(SCRATCH, "no-such-file")));
        throws("and hashing needs something to hash", () => Hash.Sha256());

        File.Delete(path);
        File.Delete(bigPath);
    }

    /* --- Screen -------------------------------------------------------------
     *
     * The desktop's geometry. What can be asserted without knowing the machine
     * is the **shape** of the answer and that the parts agree with each other:
     * the monitor `Width` reports is one of the monitors `Monitors()` lists, and
     * both are in the pixels a window is measured in. The actual numbers are the
     * screen's, and under `xvfb-run` they are whatever the virtual display was
     * given -- asserting those would be asserting the test harness.
     */
    testScreen() {
        check("the screen has a width",  Screen.Width  > 0, Screen.Width);
        check("and a height",            Screen.Height > 0, Screen.Height);
        check("and a scale of at least one", Screen.Scale >= 1, Screen.Scale);
        eq("which is a whole number", Screen.Scale, Math.round(Screen.Scale));

        const monitors = Screen.Monitors();
        check("there is at least one monitor", monitors.length >= 1, monitors.length);

        for (const m of monitors) {
            for (const key of ["X", "Y", "Width", "Height", "Scale", "Name"])
                check(`a monitor has ${key}`, key in m, JSON.stringify(m));
            check("with a size", m.Width > 0 && m.Height > 0, JSON.stringify(m));
        }

        /* The one that `Width` speaks for is one of them, which is the claim
         * that ties the two answers together: a `Width` off some other display
         * would pass every assertion above and still be wrong. */
        check("the current monitor is one of the listed ones",
              monitors.some((m) => m.Width === Screen.Width && m.Height === Screen.Height),
              JSON.stringify([Screen.Width, Screen.Height, monitors]));

        /* And it is the monitor this window is on, which is what makes the
         * answer *where the user is looking* rather than a fact about the
         * display: the form is real and realised by the time a test runs. */
        check("and the window fits inside it",
              this.Width <= Screen.Width && this.Height <= Screen.Height,
              `${this.Width}x${this.Height} in ${Screen.Width}x${Screen.Height}`);
    }

    /* --- Text: measuring without a frame ---------------------------------- */
    /*
     * `Text` answers what a string measures where there is no painter, which is
     * everywhere a layout is *decided* rather than drawn: a report that must say
     * how many pages it has before a preview has drawn anything, a band that
     * grows to fit its description, a column sized to its widest value.
     *
     * **The claim worth testing is not that it answers -- it is that it answers
     * the same as the painter**, since a caller measures here and draws there.
     * So the same string is measured both ways, in the same font, and the two
     * are compared. Everything else about this API is a convenience over that
     * one fact.
     */
    testMetrics() {
        const area = new DrawingArea();
        this.Fixed1.Add(area);
        area.Name = "Plot1";
        area.Resize(200, 100);
        this.plotArea = area;

        Directory.Make(SCRATCH);
        const png = File.Join(SCRATCH, "metrics.png");

        this.metricsFont   = "Cantarell Bold 12";
        this.metricsText   = "Statement of account";
        this.metricsLong   = "Design of the catalogue, the corrections, and the " +
                             "meeting on the 9th";
        this.metricsStyled = "a <b>bold</b> word";
        this.plotWhat      = "metrics";
        area.Save(png, 200, 100);

        const painter = this.metricsPainter;
        eq("Text.Width is the width the painter would have drawn",
           Text.Width(this.metricsText, this.metricsFont), painter.Width);
        eq("and Text.Height its height",
           Text.Height(this.metricsText, this.metricsFont), painter.Height);
        check("which is a real measurement and not zero", painter.Width > 0, painter.Width);

        /* A bigger font is wider, which is the sanity check that the font
         * argument is being read at all rather than quietly ignored. */
        check("the font argument is read",
              Text.Width(this.metricsText, "Cantarell 24") >
              Text.Width(this.metricsText, "Cantarell 8"));

        /* And with no font: the desktop's, which is what a control draws with. */
        check("Text.Font is a font description", typeof Text.Font === "string");
        eq("no font means that one",
           Text.Width("x"), Text.Width("x", Text.Font));

        /* Wrapping, which is the half a report needs: how tall this run will be
         * inside a column of that width, and what the lines are. */
        const long = "Design of the catalogue: cover, twenty inside pages and " +
                     "the corrections agreed at the meeting on the 9th";
        const flat = Text.Size(long, Text.Font);
        const box  = Text.Size(long, Text.Font, { Width: 200 });

        eq("unwrapped is one line", flat.Lines, 1);
        check("wrapped is several", box.Lines > 1, JSON.stringify(box));
        check("and taller by as many", box.Height > flat.Height * (box.Lines - 1),
              JSON.stringify([flat, box]));
        check("and no wider than it was asked to be", box.Width <= 200, box.Width);

        const lines = Text.Lines(long, Text.Font, { Width: 200 });
        eq("Lines gives that many", lines.length, box.Lines);
        eq("and they are the text, unchanged",
           lines.join(" ").replace(/\s+/g, " ").trim(), long);
        check("each fits the width",
              lines.every((l) => Text.Width(l.trim(), Text.Font) <= 200),
              JSON.stringify(lines.map((l) => Text.Width(l.trim(), Text.Font))));

        /* **A word too long for the box is broken, not left to overflow.** A
         * measurement that promised a width the text would not keep would be
         * worse than no measurement: the caller sized a column by it. */
        const word = Text.Lines("Donaudampfschifffahrtsgesellschaft", Text.Font,
                                { Width: 60 });
        check("a word longer than the box is broken", word.length > 1,
              JSON.stringify(word));
        check("and every piece fits",
              word.every((l) => Text.Width(l, Text.Font) <= 60),
              JSON.stringify(word));

        eq("nothing measures as nothing", Text.Width(""), 0);
        eq("and is still one line", Text.Size("").Lines, 1);

        throws("measuring needs something to measure", () => Text.Width());
        eq("a number is measured as its digits",
           Text.Width(12, Text.Font), Text.Width("12", Text.Font));

        /*
         * **Markup**, which is what a paragraph whose font changes halfway is
         * measured and drawn as. `Label` has had it since the beginning; this is
         * the same answer where the text is drawn rather than packed, and
         * `lib/markdown` is the library that asked for it.
         */
        const styled = "a <b>bold</b> word";
        eq("markup lays out its text and not its tags",
           Text.Width(styled, Text.Font, { Markup: true }) >
           Text.Width("a bold word", Text.Font), true);
        check("which is nothing like measuring the tags",
              Text.Width(styled, Text.Font, { Markup: true }) <
              Text.Width(styled, Text.Font));
        eq("and without the flag the tags are text",
           Text.Width(styled, Text.Font), Text.Width(styled, Text.Font, {}));

        /* The state is not left on the shared layout: a measurement after a
         * markup one is a plain measurement again. */
        eq("markup does not leak into the next measurement",
           Text.Width("a bold word", Text.Font),
           (Text.Width(styled, Text.Font, { Markup: true }),
            Text.Width("a bold word", Text.Font)));

        const wrapped = Text.Size("a <b>bold</b> word in a narrow column indeed",
                                  Text.Font, { Width: 80, Markup: true });
        check("markup wraps like anything else", wrapped.Lines > 1, JSON.stringify(wrapped));

        throws("bad markup is refused where it was written",
               () => Text.Width("a <b>b", Text.Font, { Markup: true }));
        throws("and so is an alignment that is not one",
               () => Text.Width("x", Text.Font, { Align: "Middle" }));
        throws("the lines of a styled paragraph are not strings",
               () => Text.Lines(styled, Text.Font, { Markup: true }));

        eq("Escape makes a document's characters into markup that says them",
           Text.Escape("a < b & c"), "a &lt; b &amp; c");
        eq("and what it escapes measures as what it was",
           Text.Width(Text.Escape("a < b & c"), Text.Font, { Markup: true }),
           Text.Width("a < b & c", Text.Font));

        /* The painter's side of the same surface, measured inside a real frame:
         * `TextWidth`/`TextHeight` take the options `Text` takes. */
        check("the painter wraps too", this.metricsWrapped > painter.Height,
              JSON.stringify([this.metricsWrapped, painter.Height]));
        check("and reads markup", this.metricsMarkup > 0 &&
              this.metricsMarkup < Text.Width(this.metricsStyled, this.metricsFont),
              this.metricsMarkup);
        eq("its plain measurement is the one it always was",
           this.metricsPlain, painter.Width);
        eq("and its refusals are three", this.metricsBad.length, 3);
        check("none of them drew anything",
              this.metricsBad.every((m) => m !== "NOT REFUSED"),
              JSON.stringify(this.metricsBad));

        /*
         * **Where a character is**, which is the pair of questions a selection
         * asks and the one thing a caller cannot work out for itself.
         */
        const line = "The quick brown fox jumps over the lazy dog";

        eq("the left edge is the first character", Text.IndexAt(line, 0, 0), 0);
        eq("and past the right edge is the last",
           Text.IndexAt(line, 9999, 0), line.length);
        check("a point inside lands inside",
              Text.IndexAt(line, 40, 0) > 0 && Text.IndexAt(line, 40, 0) < line.length,
              Text.IndexAt(line, 40, 0));
        check("further along is further in",
              Text.IndexAt(line, 120, 0) > Text.IndexAt(line, 40, 0));

        /* Above the text is its beginning and below it is its end -- which is
         * this call's own answer and not Pango's, whose clamp put a drag that
         * left the paragraph on the *left* back at the start of the last line. */
        eq("above the text is the beginning", Text.IndexAt(line, 200, -50), 0);
        eq("below it is the end",
           Text.IndexAt(line, 0, 9999, Text.Font, { Width: 120 }), line.length);

        /* Markup is measured on its text: the index is into what Pango laid
         * out, with the tags already consumed.
         *
         * **A neutral tag, and that is the assertion and not a detail.** `<b>`
         * makes "quick" bold, bold is wider, and a point 40 pixels in then
         * lands one character earlier than in the plain string -- so the two
         * indices agreeing at all was luck of the rounding, and the runner
         * disagreed by one. `<span>` changes nothing Pango lays out, which
         * makes the only difference between the two strings the tags
         * themselves: exactly the thing being asked about. */
        eq("markup is indexed by its text and not its tags",
           Text.IndexAt("The <span>quick</span> brown fox", 40, 0,
                        Text.Font, { Markup: true }),
           Text.IndexAt("The quick brown fox", 40, 0));

        const boxes = Text.Bounds(line, 0, 3);
        eq("a range on one line is one rectangle", boxes.length, 1);
        eq("starting at the left", boxes[0].X, 0);
        check("as wide as those characters are",
              Math.abs(boxes[0].Width - Text.Width("The")) <= 1,
              `${boxes[0].Width} against ${Text.Width("The")}`);

        const across = Text.Bounds(line, 0, 30, Text.Font, { Width: 120 });
        check("a range that wraps is a rectangle a line", across.length > 1,
              JSON.stringify(across));
        check("each below the last",
              across.every((b, i) => i === 0 || b.Y > across[i - 1].Y),
              JSON.stringify(across.map((b) => b.Y)));

        eq("an empty range covers nothing", Text.Bounds(line, 5, 5).length, 0);
        eq("and a backwards one is the same as forwards",
           JSON.stringify(Text.Bounds(line, 3, 0)), JSON.stringify(Text.Bounds(line, 0, 3)));

        /* A JS string index and not a code point: the caller slices with it. */
        const emoji = "a\u{1F600}b";
        eq("the index is a JS string index", Text.IndexAt(emoji, 9999, 0), emoji.length);

        /* The options are an object a caller hands over, so its properties may
         * be getters and a getter may throw. Every option checks its
         * conversion: the alternative is a failed one read as `true` with an
         * exception already pending. */
        throws("an option that throws is a throw and not a value",
               () => Text.Width("x", Text.Font,
                                { get Markup() { throw new Error("no"); } }));

        throws("a hit test needs a point", () => Text.IndexAt(line));
        throws("and a range needs two ends", () => Text.Bounds(line, 1));

        /* And the dump says what was asked for, which is what a drawing is
         * asserted on: the options are on the line or they are not there. */
        const drawn = this.plotArea.Dump().split("\n");
        check("a wrapped, aligned, styled run says so in the dump",
              drawn.some((l) => l.includes("width 120") && l.includes("right") &&
                                l.includes("markup")),
              JSON.stringify(drawn.filter((l) => l.startsWith("Text"))));
        check("and a plain one says nothing extra",
              drawn.some((l) => l.startsWith(`Text "${this.metricsText}" at (0,60)`) &&
                                !l.includes("markup")));

        area.Delete();
    }

    /* --- Calendar -------------------------------------------------------- */
    /*
     * The month on the form, over the same `Value` a `DatePicker` answers with:
     * what is asserted here is the half a popover cannot have -- the marks -- and
     * that the shared half really is shared and not a second copy of it.
     *
     * **A mark is a date and GTK's is a day of the month**, so the list is ours
     * and the marks in view are a drawing of the part of it on screen. Whether a
     * mark is *drawn* is not answerable from JS -- it is a day inside GTK's own
     * grid -- and it was measured instead: three renders under an Xvfb of its
     * own, where marking a day in view changes the picture, marking one in
     * another month changes nothing at all, and turning the page to that month
     * brings it out. What is left here is the list, which is what an application
     * reads.
     */
    testCalendar() {
        const c = new Calendar();
        this.Fixed1.Add(c);
        c.Name = "Cal1";

        this.calSaid = 0;

        check("a fresh calendar holds a date", /^\d{4}-\d{2}-\d{2}$/.test(c.Value),
              JSON.stringify(c.Value));

        c.Value = "2026-03-08";
        eq("Value round-trips as ISO",        c.Value, "2026-03-08");
        eq("and one assignment is one Change", this.calSaid, 1);

        /* The same complaint as a DatePicker's, because it is the same code:
         * `Value` is refused by one parser and named by the member that took it. */
        throws("a string that is not a date is refused",
               () => { c.Value = "8 de marzo"; });
        throws("nor is a day that does not exist",
               () => { c.Value = "2026-02-30"; });
        eq("and neither of them stuck", c.Value, "2026-03-08");

        eq("nothing is marked to begin with", JSON.stringify(c.Marks), "[]");

        c.Mark("2026-03-04");
        c.Mark("2026-02-11");
        eq("marks come back earliest first, whatever order they went in",
           JSON.stringify(c.Marks), '["2026-02-11","2026-03-04"]');

        c.Mark("2026-03-04");
        eq("marking one twice marks it once",
           JSON.stringify(c.Marks), '["2026-02-11","2026-03-04"]');
        c.Mark("2026-3-9");
        eq("and a date is normalised on the way in, so it cannot be marked twice "
           + "in two spellings",
           JSON.stringify(c.Marks), '["2026-02-11","2026-03-04","2026-03-09"]');

        c.Unmark("2026-03-04");
        eq("Unmark takes one out",
           JSON.stringify(c.Marks), '["2026-02-11","2026-03-09"]');
        /* Not an error: it is the state the caller asked for, and a calendar
         * clearing a day it never marked is the ordinary case. */
        c.Unmark("2026-12-25");
        eq("unmarking what was not marked leaves the rest alone",
           JSON.stringify(c.Marks), '["2026-02-11","2026-03-09"]');

        throws("a mark that is not a date is refused",  () => c.Mark("nope"));
        throws("and so is an unmark",                   () => c.Unmark("nope"));

        /* Marks are what the application knows and not what the designer drew, so
         * the property is read-only and the `.form` never carries one. */
        throws("Marks is read-only", () => { c.Marks = ["2026-03-04"]; });
        check("so a saved calendar carries its value and no marks",
              !("Marks" in c.Serialize().properties),
              JSON.stringify(c.Serialize().properties));

        c.ClearMarks();
        eq("ClearMarks empties it", JSON.stringify(c.Marks), "[]");

        eq("a month arrives with its heading",   c.ShowHeading, true);
        eq("and with the names of the days",     c.ShowDayNames, true);
        eq("and without the week numbers",       c.ShowWeekNumbers, false);
        c.ShowWeekNumbers = true;
        c.ShowHeading     = false;
        eq("ShowWeekNumbers round-trip", c.ShowWeekNumbers, true);
        eq("ShowHeading round-trip",     c.ShowHeading, false);
        eq("and none of the three is the value", c.Value, "2026-03-08");

        c.Delete();
    }

    /* --- ListBox: more than one ----------------------------------------- */
    testListMulti() {
        const lb = new ListBox();
        this.Fixed1.Add(lb);
        lb.Name = "LB2";
        lb.Items = ["uno", "dos", "tres", "cuatro"];

        this.multiSaid = 0;

        eq("a list selects one at a time to begin with", lb.MultiSelect, false);
        lb.Index = 1;
        eq("Index answers",                    lb.Index, 1);
        eq("and Text with it",                 lb.Text, "dos");
        eq("Selection is that one row",        JSON.stringify(lb.Selection), "[1]");
        throws("SelectAll needs MultiSelect",  () => lb.SelectAll());

        lb.MultiSelect = true;
        eq("MultiSelect round-trip", lb.MultiSelect, true);

        lb.DeselectAll();
        eq("with nothing selected there is nothing to report",
           JSON.stringify(lb.Selection), "[]");
        eq("and Index says so", lb.Index, -1);

        check("Select says whether there was such a row", lb.Select(0));
        check("and says no when there was not",           !lb.Select(99));
        lb.Select(2);
        eq("more than one, in the order they are in", JSON.stringify(lb.Selection),
           "[0,2]");
        /* The two that used to go blank the moment a list took more than one. */
        eq("Index is the first of them", lb.Index, 0);
        eq("and Text is its text",       lb.Text, "uno");
        check("and selecting reported it", this.multiSaid > 0);

        lb.Deselect(0);
        eq("Deselect takes one out", JSON.stringify(lb.Selection), "[2]");
        lb.SelectAll();
        eq("SelectAll takes the lot", JSON.stringify(lb.Selection), "[0,1,2,3]");

        lb.MultiSelect = false;
        check("and going back to one leaves at most one",
              lb.Selection.length <= 1, JSON.stringify(lb.Selection));

        /* --- picking a row, which is not landing on one --------------------
         *
         * `Select` is where the highlight is and fires on every arrow key;
         * `Activate` is the user saying *this one*. Every other list here told
         * the two apart already -- `TreeView` and `TableView` both raise it --
         * and without it "open what I picked" could not be written.
         */
        check("a list says it raises Activate, like every other list",
              lb.EventNames().includes("Activate"),
              JSON.stringify(lb.EventNames()));

        this.multiChose = [];
        this.chosenIn    = lb;

        /* Selected first, because that is what the double click did: `Activate`
         * carries no row of its own, so the handler asks the list which one --
         * and the list has to already know. */
        lb.Activate(3);
        eq("activating a row raises it, on that row",
           JSON.stringify(this.multiChose), "[3]");
        eq("which is selected, as a double click would have left it", lb.Index, 3);

        lb.Index = 1;
        lb.Activate();
        eq("with no row named it is the one already current",
           JSON.stringify(this.multiChose), "[3,1]");

        lb.DeselectAll();
        lb.Activate();
        eq("nothing chosen is nothing to choose, and not an error",
           JSON.stringify(this.multiChose), "[3,1]");
        lb.Activate(99);
        eq("nor is a row that is not there",
           JSON.stringify(this.multiChose), "[3,1]");

        /* Two clicks by default, like every other list here; one for a list that
         * *is* the choice -- a palette, a picker in a popover. */
        eq("a row is chosen with two clicks", lb.ActivateOnSingleClick, false);
        check("so that stays out of the .form",
              !("ActivateOnSingleClick" in lb.Serialize().properties),
              JSON.stringify(lb.Serialize().properties));

        lb.ActivateOnSingleClick = true;
        eq("...or with one, when the list is the choice",
           lb.ActivateOnSingleClick, true);
        eq("and then it is saved",
           lb.Serialize().properties.ActivateOnSingleClick, true);

        lb.Delete();
    }

    /* --- menus that remember ---------------------------------------------
     *
     * Whether a tick is *drawn* is GTK's business and not answerable from here;
     * what is asserted is the state behind it, which is what the application
     * reads and what the mark comes from.
     */
    testMenuState() {
        this.tickSaid = [];

        eq("a check item starts unticked", this.MnuTick.Value, false);
        this.MnuTick.Click();
        eq("choosing it ticks it",             this.MnuTick.Value, true);
        eq("and reports what it just became",  JSON.stringify(this.tickSaid), "[true]");
        this.MnuTick.Click();
        eq("choosing it again unticks it",     this.MnuTick.Value, false);
        eq("and says so",                      JSON.stringify(this.tickSaid),
           "[true,false]");

        /* Assigning it is how a setting is restored, so it must not run the
         * command the item stands for. */
        this.MnuTick.Value = true;
        eq("Value can be assigned",   this.MnuTick.Value, true);
        eq("without pressing anything", this.tickSaid.length, 2);

        this.MnuTick.Enabled = false;
        this.MnuTick.Click();
        eq("a disabled item does not tick", this.MnuTick.Value, true);
        this.MnuTick.Enabled = true;

        /* A radio item is a dynamic one that remembers which entry was chosen. */
        this.pickSaid = [];

        eq("nothing is chosen to begin with", this.MnuPick.Value, -1);
        this.MnuPick.Items = ["Light", "Dark"];
        this.MnuPick.Click(1);
        eq("choosing an entry remembers it", this.MnuPick.Value, 1);
        eq("and reports index and label",    JSON.stringify(this.pickSaid),
           '[[1,"Dark"]]');
        this.MnuPick.Value = 0;
        eq("Value can be assigned there too", this.MnuPick.Value, 0);
        eq("and again presses nothing",       this.pickSaid.length, 1);

        throws("a plain item has no Value",   () => this.MnuOne.Value);
        throws("...and cannot be given one",  () => { this.MnuOne.Value = true; });
        throws("a check item has no Items",   () => { this.MnuTick.Items = ["a"]; });
    }

    Ex1_Toggle() { this.expanderSaid++; }
    T1_Click()   { this.toggleSaid.push(this.toggleRef.Active); }
    Sw1_Click()  { this.switchSaid.push(this.switchRef.Active); }
    Sld1_Change() { this.sliderSaid++; }
    Date1_Change() { this.dateSaid++; }
    Memo1_Change() { this.memoChanges++; }
    Cal1_Change()  { this.calSaid++; }
    LB2_Select() { this.multiSaid++; }
    LB2_Activate() { this.multiChose.push(this.chosenIn.Index); }
    MnuTick_Click(on)      { this.tickSaid.push(on); }
    MnuPick_Click(i, text) { this.pickSaid.push([i, text]); }

    /* --- TextEditor: the plain one -------------------------------------- */
    /*
     * A `GtkTextView`, and what it is for is the field a `TextBox` could not be:
     * observations, a note, a log pane. A `GtkEntry` cannot hold a newline at
     * all, so before this class the choice was to drop the text or to use the
     * source editor with its languages turned off -- which the IDE did, in three
     * lines, in `PoForm`.
     *
     * What is asserted here is the part that a review cannot see by reading:
     * that the shared half really reaches a plain view. `Text`, the cursor, the
     * selection, undo and the two events are declared once on the abstract
     * `Editor` and inherited by both editors, so every one of them is a place
     * where "it compiles" and "it works" come apart.
     */
    testTextEditor() {
        const memo = new TextEditor();
        this.Fixed1.Add(memo);
        memo.Name = "Memo1";

        this.memoChanges = 0;

        /* The hierarchy, once: GTK's own is the same shape, which is why the
         * shared half can be shared at all. */
        check("a plain editor is an Editor",        memo instanceof Editor);
        check("and a source editor is one too",     this.Ed instanceof Editor);
        check("but neither is the other",           !(this.Ed instanceof TextEditor));
        throws("and Editor itself cannot be built", () => new Editor());

        /* The one default the two disagree about, and the whole of the
         * difference in use: prose in a narrow box with a horizontal scrollbar
         * under it is unreadable, and code that wraps hides its indentation. */
        /* A fresh one of each, because this is a question about what a control
         * *arrives* with and the form's own editor has been through the tests
         * above -- one of which turns wrapping on. */
        const fresh = new SourceEditor();
        eq("a plain editor arrives wrapping", memo.Wrap, true);
        eq("and a source editor does not",    fresh.Wrap, false);
        fresh.Delete();

        /* What a TextBox cannot hold. */
        memo.Text = "primera linea\nsegunda linea\n";
        eq("Text keeps its newlines", memo.Text, "primera linea\nsegunda linea\n");
        check("and assigning it raised Change", this.memoChanges > 0);

        eq("the cursor starts at the top after a load", memo.Line, 1);
        eq("...and in the first column",                memo.Column, 1);
        memo.GotoLine(2);
        eq("GotoLine moves it", memo.Line, 2);

        memo.Select(1, 9, 5);
        eq("Select reaches a word", memo.Selection, "linea");

        /* At the cursor, and the selection is left alone -- `insert_at_cursor`
         * does not delete it, and `Select` leaves the cursor at the far end. So
         * this lands *after* the selected word rather than replacing it, which
         * is worth pinning down: "insert" reads like typing, and typing over a
         * selection replaces it. */
        memo.Insert("X");
        eq("Insert puts text at the cursor without touching the selection",
           memo.Text, "primera lineaX\nsegunda linea\n");
        memo.Append("tercera\n");
        check("Append puts text at the end whatever the cursor was doing",
              memo.Text.endsWith("tercera\n"), JSON.stringify(memo.Text.slice(-12)));

        check("a buffer that has been typed into can be undone", memo.CanUndo);
        memo.Undo();
        check("and Undo takes the last change back",
              !memo.Text.endsWith("tercera\n"), JSON.stringify(memo.Text.slice(-12)));
        check("...which is then a redo", memo.CanRedo);
        memo.Redo();
        check("and Redo puts it back", memo.Text.endsWith("tercera\n"));

        check("assigning Text marks it modified", memo.Modified);
        memo.Modified = false;
        eq("Modified is resettable", memo.Modified, false);

        eq("ReadOnly starts off", memo.ReadOnly, false);
        memo.ReadOnly = true;
        eq("ReadOnly round-trip", memo.ReadOnly, true);
        /* The program is not the user: a log pane is read-only and still filled. */
        memo.Append("desde el programa\n");
        check("and the program can still write to it",
              memo.Text.endsWith("desde el programa\n"));
        memo.ReadOnly = false;

        memo.Clear();
        eq("Clear empties it", memo.Text, "");

        /*
         * **And it has none of the source editor's half**, which is the other
         * half of the rename: `Language`, a gutter, search, marks and completion
         * are GtkSourceView's, and a control that pretended to them would be the
         * old apology with a new name.
         */
        const only = this.Ed.PropertyNames().filter(
            (n) => !memo.PropertyNames().includes(n));
        eq("what the source editor adds, and nothing of it here",
           JSON.stringify(only),
           JSON.stringify(["Completion", "CompletionTitle", "Language",
                           "ShowLineNumbers", "ShowMarks", "Theme"]));
        for (const gone of ["Search", "FindNext", "Replace", "Mark", "ClearMarks",
                            "ShowCompletion"])
            eq(`${gone} is not a plain editor's`, typeof memo[gone], "undefined");
        /* ...and the two it does share the name of are Widget's, not the
         * editor's: `Marks` on a Calendar is a different idea again. */
        check("while Select and GotoLine are both editors'",
              typeof memo.Select === "function" && typeof memo.GotoLine === "function");

        eq("it saves as itself", memo.Serialize().type, "TextEditor");
        check("and a wrapping default is not written into the .form",
              !("Wrap" in memo.Serialize().properties),
              JSON.stringify(memo.Serialize().properties));

        memo.Delete();
    }

    /* --- SourceEditor: search and replace ------------------------------- */
    testSearch() {
        const ed = this.Ed;

        ed.Text = "uno dos tres\nDos dos\ntres uno\n";

        eq("Search counts the matches",        ed.Search("dos"), 3);
        eq("Matches reports the same number",  ed.Matches, 3);
        eq("search is case-insensitive by default", ed.Search("DOS"), 3);
        eq("CaseSensitive narrows it",         ed.Search("Dos", { CaseSensitive: true }), 1);
        eq("WholeWord does not match a prefix", ed.Search("un", { WholeWord: true }), 0);
        eq("WholeWord matches the whole word", ed.Search("uno", { WholeWord: true }), 2);
        eq("Regex searches as a pattern",      ed.Search("tr\\w+", { Regex: true }), 2);
        eq("a text nobody wrote has no matches", ed.Search("zzz"), 0);
        throws("a broken pattern is rejected", () => ed.Search("(", { Regex: true }));

        /* Search highlights and counts; it deliberately does not move the
         * cursor, so nothing is a match until something is found. */
        eq("Search counts three again", ed.Search("dos"), 3);
        ed.GotoLine(1);
        eq("no match is current before finding", ed.MatchIndex, 0);
        eq("Selection is empty with nothing selected", ed.Selection, "");

        check("FindNext finds one",       ed.FindNext());
        eq("MatchIndex says which one",   ed.MatchIndex, 1);
        eq("the match is the selection",  ed.Selection, "dos");

        ed.FindNext();
        eq("FindNext advances",           ed.MatchIndex, 2);
        eq("case-insensitively",          ed.Selection, "Dos");
        ed.FindNext();
        eq("and again",                   ed.MatchIndex, 3);
        check("FindNext wraps around",    ed.FindNext());
        eq("back to the first",           ed.MatchIndex, 1);
        check("FindPrevious goes back",   ed.FindPrevious());
        eq("wrapping the other way",      ed.MatchIndex, 3);

        /* Replace works on the match one is standing on, so a Find/Replace loop
         * walks the file; the replacement is left selected. */
        ed.Text = "aaa bbb aaa\n";
        eq("two to replace", ed.Search("aaa"), 2);
        ed.GotoLine(1);
        check("Replace refuses when no match is current", !ed.Replace("zzz"));
        ed.FindNext();
        check("Replace replaces the current match", ed.Replace("zzz"));
        eq("the replacement is what changed", ed.Text, "zzz bbb aaa\n");
        eq("the replacement is selected",     ed.Selection, "zzz");
        eq("one match is left",               ed.Matches, 1);

        eq("ReplaceAll reports how many it did", ed.ReplaceAll("qqq"), 1);
        eq("and did them",                       ed.Text, "zzz bbb qqq\n");

        /* An empty search is how a find bar closes: no matches, no highlight. */
        eq("an empty search clears it", ed.Search(""), 0);
        eq("with nothing searched there is nothing to count", ed.Matches, 0);
        check("and nothing to find", !ed.FindNext());
        check("in either direction", !ed.FindPrevious());

        ed.Clear();
    }

    /* --- Button.Click --------------------------------------------------- */
    testButtonClick() {
        const before = this.b1Clicks;
        this.B1.Click();
        eq("Click() raises the handler", this.b1Clicks, before + 1);

        this.B1.Enabled = false;
        this.B1.Click();
        eq("a disabled button does not fire", this.b1Clicks, before + 1);
        this.B1.Enabled = true;
    }

    /* --- TreeView -------------------------------------------------------- */
    testTree() {
        const t = new TreeView();
        eq("a fresh tree is empty", t.Count, 0);
        eq("with nothing selected", t.Key, "");

        t.Add("raiz1", "Uno");
        t.Add("raiz2", "Dos");
        t.Add("hijo", "Anidado", "raiz1");
        eq("Count counts every node, at any depth", t.Count, 3);

        check("Exists finds a key", t.Exists("hijo"));
        check("and misses one that is not there", !t.Exists("fantasma"));

        throws("a duplicate key is refused", () => t.Add("raiz1", "otra vez"));
        throws("an unknown parent is refused", () => t.Add("x", "X", "fantasma"));
        throws("an empty key is refused", () => t.Add("", "no key"));
        eq("and none of those added anything", t.Count, 3);

        /* The tree autoexpands, so a child is selectable without opening it. */
        t.Key = "hijo";
        eq("Key selects by key", t.Key, "hijo");
        eq("Text follows the selection", t.Text, "Anidado");

        t.Key = "raiz2";
        eq("selection moves", t.Text, "Dos");

        throws("selecting a key that is not there throws",
               () => { t.Key = "fantasma"; });
        eq("and leaves the selection alone", t.Key, "raiz2");

        t.Key = "";
        eq("an empty key clears the selection", t.Key, "");
        eq("and then there is no text", t.Text, "");

        /*
         * **`Remove(key)` takes the subtree with it.** A tree that could only be
         * emptied whole was the one gap the four lists did not share -- and a
         * node whose parent is gone is not something this control can show, so
         * losing the branch is the only honest reading of losing the node.
         */
        /*
         * **A node used to be write-once.** Its text and icon were arguments to
         * `Add` and nothing could change either: renaming a file in a project
         * tree meant rebuilding the branch. `TableView` has had `SetCell` and
         * `SetIcon` since it existed; these are the same two for the control
         * with one column, which is why there is no column argument.
         */
        t.Add("named", "Before", "", "folder");
        t.Key = "named";
        eq("a node's text is what it was added with", t.Text, "Before");
        t.SetText("named", "After");
        eq("and SetText changes it", t.Text, "After");
        eq("and renaming does not move the selection", t.Key, "named");
        t.SetIcon("named", "text-x-generic");
        t.SetIcon("named", "");            /* "" takes it off */
        eq("nor does changing the icon", t.Key, "named");
        throws("a key that is not there", () => t.SetText("nope", "x"));
        throws("SetIcon needs both",      () => t.SetIcon("named"));
        t.Remove("named");

        const was = t.Count;
        t.Add("gone", "Gone", "");
        t.Add("gone/one", "One", "gone");
        t.Add("gone/one/deep", "Deep", "gone/one");
        eq("three more nodes", t.Count, was + 3);

        t.Remove("gone");
        eq("the node is gone",        t.Exists("gone"), false);
        eq("and its child",           t.Exists("gone/one"), false);
        eq("and its grandchild",      t.Exists("gone/one/deep"), false);
        eq("leaving what was there",  t.Count, was);
        throws("a key that is not there is refused", () => t.Remove("nope"));

        t.Clear();
        eq("Clear empties it", t.Count, 0);
        check("and forgets the keys", !t.Exists("raiz1"));
        t.Add("raiz1", "reutilizada");
        eq("so a key can be used again", t.Count, 1);
    }

    /* --- ComboBox -------------------------------------------------------- */
    testCombo() {
        const c = new ComboBox();
        c.Name = "Combo1";
        this.Bar.Add(c);          // bound to the form: the events arrive here

        eq("a fresh combo is empty", c.Count, 0);
        eq("with nothing chosen", c.Index, -1);
        eq("and no text", c.Text, "");

        this.comboSelects = 0;
        c.Items = ["rojo", "verde", "azul"];
        eq("Items fills the list", c.Count, 3);

        /* A drop-down cannot show nothing: with items, one is always selected.
         * That is the difference from ListBox. */
        eq("and it is left showing the first", c.Index, 0);
        eq("the event arrived", this.comboSelects, 1);

        /* The full round trip: assigning from JS has to reach GTK, come back as
         * notify::selected, and land in Combo1_Select. */
        c.Index = 1;
        eq("Index selects", c.Text, "verde");
        eq("y volvio a avisar", this.comboSelects, 2);

        c.Text = "azul";
        eq("Text selects by value", c.Index, 2);

        throws("a value not in the list is refused",
               () => { c.Text = "violeta"; });
        eq("and it does not touch what was there", c.Text, "azul");

        c.Index = 9;
        eq("an out-of-range index moves nothing either", c.Index, 2);

        c.Add("negro");
        eq("Add appends at the end", c.Count, 4);
        eq("and does not touch the selection", c.Text, "azul");

        const node = c.Serialize();
        check("Items is saved", sameJson(node.properties.Items,
              ["rojo", "verde", "azul", "negro"]), JSON.stringify(node.properties));
        check("Count is read-only, and not saved",
              !("Count" in node.properties), JSON.stringify(node.properties));

        c.Clear();
        eq("Clear lo vacia", c.Count, 0);
        eq("and then nothing is selected", c.Index, -1);
        c.Delete();
    }

    Combo1_Select() { this.comboSelects++; }

    /* --- SpinBox --------------------------------------------------------- */
    testSpin() {
        const s = new SpinBox();
        s.Name = "Spin1";
        this.Bar.Add(s);

        this.spinChanges = 0;
        eq("arranca en cero", s.Value, 0);

        s.Value = 42;
        eq("Value asigna", s.Value, 42);
        eq("and the change comes back as an event", this.spinChanges, 1);

        /* The factory range is wide on purpose: a .form applies properties in the
         * order they are written, and a narrow range would silently clamp a Value
         * set before its Max. */
        s.Value = -5000;
        eq("it takes negatives with no range declared", s.Value, -5000);

        s.Min = 0;
        eq("Min clamps what it already held", s.Value, 0);
        s.Max = 10;
        s.Value = 25;
        eq("y Max tambien", s.Value, 10);

        s.Decimals = 2;
        s.Value = 3.14159;
        eq("Decimals redondea", s.Value, 3.14);

        s.Step = 0.5;
        eq("Step reads back", s.Step, 0.5);

        /*
         * Two habits of the box rather than of what it holds.  `Wrap` is the
         * hour that goes 23 -> 00, which is a property of the quantity; and
         * there is deliberately no `Page`, because `Step` already sets what
         * PageUp moves by and a `Page` the next `Step` quietly undid would be
         * worse than none.
         */
        eq("a spin box stops at the ends", s.Wrap, false);
        s.Wrap = true;
        eq("Wrap round-trip", s.Wrap, true);
        eq("and is saved", s.Serialize().properties.Wrap, true);
        s.Wrap = false;

        /* On, and worth pinning: a box with arrows that accepted "hola" would
         * be a surprise. Turning it off is for the box that also takes a word --
         * a page number that accepts `end` -- and then the program parses it. */
        eq("and it refuses letters as they are typed", s.Numeric, true);
        check("so that stays out of the .form",
              !("Numeric" in s.Serialize().properties),
              JSON.stringify(s.Serialize().properties));
        s.Numeric = false;
        eq("Numeric round-trip", s.Numeric, false);
        eq("and then it is saved", s.Serialize().properties.Numeric, false);
        s.Numeric = true;

        check("neither is a page increment, which Step already decides",
              !s.PropertyNames().includes("Page"),
              JSON.stringify(s.PropertyNames()));

        const node = s.Serialize();
        eq("only what changed, in stable order",
           JSON.stringify(node.properties),
           JSON.stringify({ Decimals: 2, Max: 10, Min: 0, Step: 0.5, Value: 3.14 }));

        s.Delete();
    }

    Spin1_Change() { this.spinChanges++; }

    /* --- RowList --------------------------------------------------------- */
    /* --- Flow ----------------------------------------------------------------
     *
     * A box makes one line and a grid makes a table; neither reflows.  What a
     * wall of equally sized things wants is to answer the width it is given --
     * which is measured here, because it is the whole reason the class exists.
     */
    testFlow(done) {
        /* On a fixed surface of its own, so Resize really is the width it gets:
         * in a box the parent decides, and the width is the thing under test. */
        const host = new Panel();
        host.Name = "FlowHost";
        host.Move(0, 0);
        host.Resize(640, 220);
        this.Add(host);

        const f = new Flow();
        f.Name = "Gallery";
        f.Move(0, 0);
        f.Resize(240, 200);
        host.Add(f);

        eq("a flow is a container", f.Children.length, 0);

        for (let i = 0; i < 12; i++) {
            const b = new Button();
            b.Name = `Cell${i}`;
            b.Text = "";
            b.Resize(40, 40);
            f.Add(b);
        }
        eq("that takes children like any other", f.Children.length, 12);
        eq("read back in the order they went in", f.Children[0].Name, "Cell0");

        /* GtkFlowBox wraps each child in a cell of its own, so a child's GTK
         * parent is that cell -- which Children and Delete look through. */
        f.Children[0].Delete();
        eq("and taking one out takes its cell with it", f.Children.length, 11);
        eq("leaving no hole", f.Children[0].Name, "Cell1");

        f.Spacing = 4;
        eq("Spacing is the container's word here too", f.Spacing, 4);
        f.MaxPerLine = 3;
        eq("and a line can be held to a shape", f.MaxPerLine, 3);
        throws("which has to be at least one", () => { f.MaxPerLine = 0; });

        const perLine = () => {
            const rows = {};
            for (const c of f.Children) rows[c.Bounds(f).Y] = true;
            return Math.ceil(f.Children.length / Dictionary.Keys(rows).length);
        };

        until("the flow lays out", () => f.Children[0].Bounds(f).Width > 0, () => {
            eq("capped, it puts that many on a line", perLine(), 3);

            f.MaxPerLine = 100;
            until("uncapped it fits what it can", () => perLine() > 3, () => {
                const narrow = perLine();

                f.Resize(600, 200);
                until("and a wider one fits more", () => perLine() > narrow, () => {
                    check("which is what reflowing means",
                          perLine() > narrow, `${narrow} -> ${perLine()}`);
                    host.Delete();
                    done();
                });
            });
        });
    }

    /* --- what a font size actually draws at ----------------------------------
     *
     * The property kept what it was given all along; what was wrong was the CSS
     * written from it, so the only way to see any of this was to measure the
     * ink.  Three separate mistakes lived here:
     *
     *   - integer division, so "Cantarell 11.5" drew at 11
     *   - an *absolute* description ("12px") written out as "12pt", a third too
     *     large -- the number means device units then, not points
     *   - the decimal separator is the locale's, and GTK calls setlocale() at
     *     startup: %g writes "11,5" in half the world, which CSS does not parse
     */
    testFontSize(done) {
        const host = new Panel();
        host.Name = "FontHost";
        host.Move(0, 0);
        host.Resize(300, 200);
        this.Add(host);

        const at = (desc, y) => {
            const l = new Label();
            l.Text = "Hgx";
            l.Font = desc;
            l.Move(0, y);
            host.Add(l);
            return l;
        };

        const small = at("Cantarell 11",   0);
        const half  = at("Cantarell 11.5", 40);
        const big   = at("Cantarell 12",   80);
        const px    = at("Cantarell 12px", 120);

        until("the fonts are laid out", () => small.Bounds().Height > 0, () => {
            const h = (l) => l.Bounds().Height;

            /*
             * **Pixel heights round, so the half point need not show, and its
             * not showing is not the bug.** Cantarell 11.5 against 11 and 12
             * measured 19, 20, 20 on the runner -- Pango honoured the fraction
             * and the grid absorbed it -- while this machine happened to give
             * it a pixel of its own. What the assertion is for is a size that
             * is *thrown away*: all three equal. So the half is no smaller
             * than its neighbour, and a whole point is still a whole point.
             */
            check("a fractional size is not thrown away, and a larger one is larger",
                  h(half) >= h(small) && h(big) > h(small),
                  `11=${h(small)} 11.5=${h(half)} 12=${h(big)}`);

            /* 12px is about 9pt: an absolute size read as points draws a third
             * too large, and looks plausible enough to go unnoticed. */
            check("an absolute size is not read as points",
                  h(px) < h(big), `12px=${h(px)} 12=${h(big)}`);

            host.Delete();
            done();
        });
    }

    Rows1_Activate() { this.rowActivates++; }

    testRowList() {
        const list = new RowList();
        list.Name = "Rows1";
        this.Group1.Add(list);

        eq("a new list has no rows", list.Count, 0);
        eq("ni fila elegida", list.Index, -1);

        this.rowSelects = 0;

        /* Every row is any widget at all, which is the difference from ListBox:
         * in here goes a row built out of other controls. */
        const rows = [];
        for (let i = 0; i < 3; i++) {
            const row = new Panel();
            row.Arrangement = "Horizontal";
            row.Spacing = 4;
            const label = new Label();
            label.Text = `fila ${i}`;
            row.Add(label);
            list.Add(row);
            rows.push(row);
        }
        eq("Add agrega filas", list.Count, 3);
        eq("Children sees through GTK's row", list.Children.length, 3);
        check("and returns the widgets, not the rows", list.Children[0] === rows[0]);

        list.Index = 1;
        eq("Index selects a row", list.Index, 1);
        eq("y avisa", this.rowSelects, 1);

        list.Index = -1;
        eq("and it can be left with nothing selected", list.Index, -1);

        /* A control inside is still a control: its events reach the form by name,
         * as in any other container. */
        const btn = new Button();
        btn.Name = "RowBtn";
        this.rowClicks = 0;
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Add(btn);
        list.Add(row);
        btn.Click();
        eq("a button inside a row dispatches", this.rowClicks, 1);

        rows[0].Delete();
        eq("deleting the widget takes its row with it", list.Count, 3);
        eq("y Children lo acompania", list.Children.length, 3);

        /*
         * **The list vocabulary, which is the same in all four.** A `RowList` is
         * a `GtkListBox` exactly as a `ListBox` is -- the difference is what
         * goes in a row -- so selecting, removing and activating are the same
         * members with the same meanings. They were missing here and nowhere
         * else, which is what made moving a list from strings to widgets cost
         * half its vocabulary.
         */
        eq("one at a time by default", list.MultiSelect, false);
        eq("and two clicks decide, as in a ListBox", list.ActivateOnSingleClick, false);

        eq("Select answers whether there was a row", list.Select(0), true);
        eq("and says so when there is not",          list.Select(99), false);
        eq("selecting shows in Index",     list.Index, 0);
        eq("and in Selection",             JSON.stringify(list.Selection), "[0]");

        throws("SelectAll needs MultiSelect", () => list.SelectAll());
        list.MultiSelect = true;
        list.SelectAll();
        eq("SelectAll takes them all", list.Selection.length, list.Count);
        list.Deselect(1);
        eq("and Deselect takes one out", list.Selection.length, list.Count - 1);
        check("the right one", !list.Selection.includes(1), JSON.stringify(list.Selection));
        list.DeselectAll();
        eq("DeselectAll leaves none", list.Selection.length, 0);
        eq("and nothing is the index", list.Index, -1);
        list.MultiSelect = false;

        /* `Activate` is the double click from code, and it selects first --
         * the event carries no row, so the list has to already know which. */
        this.rowActivates = 0;
        list.Activate(2);
        eq("Activate raises the event", this.rowActivates, 1);
        eq("and selected the row it activated", list.Index, 2);

        /*
         * **`Remove` goes through the container.** A row holds a widget the
         * application made and the list is holding a JS reference to it;
         * unparenting the row would leave that behind. So this is the same act
         * as deleting the child, and `Children` says so.
         */
        const before = list.Children.length;
        eq("Remove answers whether there was a row", list.Remove(0), true);
        eq("and it is gone",        list.Count, before - 1);
        eq("with its widget",       list.Children.length, before - 1);
        eq("a row that is not there is not an error", list.Remove(99), false);

        throws("it refuses Arrangement: the rows are its arrangement",
               () => { list.Arrangement = "Vertical"; });

        list.Clear();
        eq("Clear empties it", list.Count, 0);
        eq("leaving no children behind", list.Children.length, 0);

        list.Delete();
    }

    Rows1_Select() { this.rowSelects++; }
    RowBtn_Click() { this.rowClicks++; }

    /*
     * The filter: GTK asks the form which rows to show, one row at a time.
     *
     * `Filter(control, index)` and its return value, the shape `Data` and
     * `Form_Close` already have. What is asserted is the whole of the bargain:
     * the answer decides what is on screen, a row that is not shown is **still a
     * row**, and the answer changes without anything being rebuilt -- which is
     * the reason this exists at all. The property grid used to rebuild its forty
     * rows on every letter typed into its search field, because a list had no way
     * of hiding one.
     *
     * Measured on the allocation and not on a property: nothing on this side
     * *sets* anything, which is exactly the point, so what proves a row is hidden
     * is that GTK gave it no room.
     */
    testRowFilter() {
        const list = new RowList();
        list.Name = "Filter1";
        this.Add(list);
        list.Expand = true;

        this.rowAsks   = 0;
        this.rowSeen   = {};       /* name -> the index it was asked about with */
        this.rowNeedle = "";       /* what Filter1_Filter answers from */

        check("Filter is published as an event of its own",
              list.EventNames().includes("Filter"),
              JSON.stringify(list.EventNames()));
        eq("and Select is still the default one, the one a double click writes",
           list.EventNames()[0], "Select");

        const rows = ["Margin", "MinWidth", "Text"].map((text) => {
            const label = new Label();
            label.Name = `Row_${text}`;
            label.Text = text;
            list.Add(label);
            return label;
        });

        check("GTK asks as the rows arrive, with no filter to speak of",
              this.rowAsks >= 3, `${this.rowAsks}`);
        eq("and says which row it is asking about", this.rowSeen.Row_MinWidth, 1);
        eq("counting every row, shown or not", this.rowSeen.Row_Text, 2);

        /*
         * Read off *where the rows are*, and not off a size of their own.
         *
         * A filtered row is hidden with `child-visible`, which takes it out of
         * the layout without touching it: GTK never allocates it again, so the
         * width and height it reports are the ones it last had -- 19px of a row
         * that is nowhere on screen. What moves is everything under it, and that
         * is the honest measurement: with the two others out, the row that
         * matched sits where the first row used to.
         */
        until("the list lays out", () => rows[2].Bounds(list).Y > 0, () => {
            const before = rows.map((row) => row.Bounds(list).Y);

            check("the three rows stack in order to begin with",
                  before[0] < before[1] && before[1] < before[2],
                  before.join(", "));

            const asked = this.rowAsks;
            this.rowNeedle = "min";
            list.Refilter();

            check("Refilter asks again, once per row",
                  this.rowAsks - asked >= 3, `${this.rowAsks - asked}`);
            eq("and the list still holds every row it held", list.Count, 3);
            eq("with every child still there to be asked about",
               list.Children.length, 3);

            until("the row that matched rises to the top",
                  () => rows[1].Bounds(list).Y < before[1], () => {
                eq("the only row left is where the first one was",
                   rows[1].Bounds(list).Y, before[0]);

                /* Nothing was destroyed to filter, so nothing has to be built to
                 * stop: the same three widgets come back, in their places. */
                this.rowNeedle = "";
                list.Refilter();

                until("they come back",
                      () => rows[1].Bounds(list).Y === before[1], () => {
                    check("the same widgets come back, not new ones",
                          list.Children[0] === rows[0] && list.Children[2] === rows[2]);
                    eq("each in the place it had", rows[2].Bounds(list).Y, before[2]);
                    list.Delete();
                });
            });
        });
    }

    /* A lookup and nothing else, which is the rule for a handler GTK calls while
     * it is laying the list out. */
    Filter1_Filter(control, index) {
        this.rowAsks++;
        this.rowSeen[control.Name] = index;   /* asserted once, outside */
        return !this.rowNeedle ||
               control.Name.toLowerCase().includes(this.rowNeedle);
    }

    /* --- ordering a box's children ------------------------------------------
     *
     * In a box, order is position: there are no coordinates, so moving a control
     * means moving it among its siblings.  A Fixed refuses -- there the order is
     * the painting order, and Raise/Lower already say that.
     */
    /* --- a widget in the tab strip -------------------------------------------
     *
     * The strip has room at either end that nothing else can reach: a "new tab"
     * button, a menu of what to do with the whole set.  GTK always had it; a
     * page is not that, so nothing here could say it.
     */
    testTabAction() {
        const book = new Notebook();
        this.Add(book);
        book.Append(new Panel());
        book.Append(new Panel());

        const b = new Button();
        b.Name = "StripAct";        /* before adopting: events are looked up by it */
        b.Text = "+";
        book.SetAction(b, "End");

        /* The whole point of the distinction: it is in the notebook and it is
         * not a page, so what counts pages goes on counting two. */
        eq("an action widget is not a page", book.Count, 2);
        eq("nor one of the children", book.Children.length, 2);

        this.stripSaid = null;
        b.Click();
        eq("but its events reach the form", this.stripSaid, "act");

        /* Adopted like a page, which is what keeps the wrapper alive while GTK
         * still shows it -- the alternative is a control collected under GTK's
         * feet. */
        const other = new Button();
        other.Name = "StripAct2";
        book.SetAction(other, "End");
        eq("setting another replaces it", book.Count, 2);

        book.SetAction(null, "End");
        eq("and it can be taken out again", book.Count, 2);

        throws("a form cannot go in a strip", () => book.SetAction(this));
        throws("nor an invented place",      () => book.SetAction(b, "Middle"));
        throws("and it has to be a widget",  () => book.SetAction(42));

        /* Both ends, and they are different places. */
        const left = new Button();
        left.Name = "StripLeft";
        book.SetAction(left, "Start");
        book.SetAction(b, "End");
        eq("both ends can be used at once", book.Count, 2);

        /*
         * **Where the tabs are is `Strip`, which is what a `Switcher` calls it.**
         * The same question about the same thing, and answering to `Strip` on one
         * and `TabPosition` on the other is one concept with two names and a coin
         * flip every time somebody writes it.
         */
        const stack = new Switcher();
        eq("both say where their strip is with the same word",
           JSON.stringify(book.PropertyOptions("Strip")),
           JSON.stringify(stack.PropertyOptions("Strip")));
        check("and neither has a second name for it",
              !book.PropertyNames().includes("TabPosition"),
              JSON.stringify(book.PropertyNames()));
        stack.Delete();

        eq("tabs are on top to begin with", book.Strip, "Top");
        check("so that stays out of the .form",
              !("Strip" in book.Serialize().properties),
              JSON.stringify(book.Serialize().properties));

        book.Strip = "Start";
        eq("Strip round-trip", book.Strip, "Start");
        eq("and is saved", book.Serialize().properties.Strip, "Start");
        throws("and an invented side is refused", () => { book.Strip = "Middle"; });

        /* `None` is the notebook somebody else turns the page of -- a wizard, a
         * menu of views -- and it is the tabs not being there rather than a
         * strip hidden behind the pages. */
        book.Strip = "None";
        eq("a notebook can have no tabs at all", book.Strip, "None");
        eq("and the pages are still there", book.Count, 2);

        book.Strip = "Start";
        eq("...and the side it had comes back with them", book.Strip, "Start");

        book.Delete();
    }

    StripAct_Click() { this.stripSaid = "act"; }

    /* --- an image ----------------------------------------------------------
     *
     * A picture and nothing else: until this existed, the only control that
     * could show one was a `Button`, so every empty state was a button
     * pretending not to be one.
     */
    testImage() {
        const img = new Image();
        img.Name = "Img1";
        this.Add(img);

        eq("a fresh image shows nothing", img.Icon, "");
        eq("and names no file",           img.File, "");
        eq("and asks for no size of its own", img.Size, -1);

        img.Icon = "folder";
        eq("an icon is named like a button's", img.Icon, "folder");
        img.Size = 96;
        eq("and drawn at the size it was given", img.Size, 96);

        /*
         * One source at a time.  A GtkImage holds one thing, so remembering the
         * other would be state GTK does not have -- and a `.form` that wrote
         * both would load back showing whichever came last.
         */
        Directory.Make(SCRATCH);
        const path = File.Join(SCRATCH, "dot.svg");
        File.Save(path, '<svg xmlns="http://www.w3.org/2000/svg" width="16" ' +
                        'height="16" viewBox="0 0 16 16"><rect width="16" ' +
                        'height="16"/></svg>\n');

        img.File = path;
        eq("a file can be named instead", img.File, path);
        eq("and it lets the icon go",     img.Icon, "");

        img.Icon = "folder";
        eq("and the other way round", img.File, "");
        eq("with the icon back",      img.Icon, "folder");

        img.Icon = "";
        eq("nothing at all is a picture of nothing", img.Icon, "");

        /*
         * The third source, and the only one that is a verb: an image already in
         * memory. `Icon` and `File` are names -- a `.form` declares either -- and
         * bytes are neither, so they arrive through a call and the same rule
         * holds: the last source wins, and the two names read back empty rather
         * than claiming something that is not what is drawn.
         */
        const shot = File.LoadBytes(File.Join(IMAGES, "small.png"));

        img.Icon = "folder";
        img.LoadBytes(shot);
        eq("bytes take the icon's place", img.Icon, "");
        eq("and name no file either",     img.File, "");
        check("and carry nothing into the .form",
              !("Icon" in img.Serialize().properties) &&
              !("File" in img.Serialize().properties),
              JSON.stringify(img.Serialize().properties));

        throws("bytes that are not an image are refused",
               () => { img.LoadBytes(new Bytes("no")); });
        throws("and a path is not bytes", () => { img.LoadBytes("folder"); });

        /* Designable and serialisable like everything else: both getters have a
         * setter, which is the whole test the .form applies. */
        const node = img.Serialize();
        eq("what it is saved as", node.type, "Image");
        check("with the properties it was given",
              node.properties.Size === 96, JSON.stringify(node.properties));

        img.Delete();
    }

    /* --- a switcher --------------------------------------------------------
     *
     * A stack behind a strip of linked buttons.  Pages are children like a
     * notebook's, but the name on a button is a *string* on the page and not a
     * widget, so Tabs is the whole of the strip and there is nothing else that
     * can carry it.
     */
    testSwitcher() {
        const sw = new Switcher();
        sw.Name = "Sw";
        this.Add(sw);

        eq("a fresh switcher has no pages", sw.Count, 0);
        eq("and no strip to speak of", JSON.stringify(sw.Tabs), "[]");
        /* Like a Notebook: it arranges its children by its own nature, and
         * saying otherwise would swap the stack the strip points at. */
        eq("a switcher reports no arrangement", sw.Arrangement, "");
        throws("and refuses to be given one", () => { sw.Arrangement = "Vertical"; });

        this.switched = [];

        const first = new Panel();
        first.Name = "P1";
        sw.Append(first, "One");
        const second = new Panel();
        second.Name = "P2";
        sw.Add(second);

        eq("pages go in from either door", sw.Count, 2);
        eq("Children answers with them", sw.Children.length, 2);
        /* A page nobody named still has to be a button somebody can aim at. */
        eq("a named page keeps its name and a nameless one gets one",
           JSON.stringify(sw.Tabs), JSON.stringify(["One", "Page 2"]));

        /* The first page in is what the stack shows, and that is a switch. */
        eq("the first page becomes the current one", sw.Current, 0);
        check("and showing it is an event", this.switched.length > 0,
              JSON.stringify(this.switched));

        this.switched = [];
        sw.Current = 1;
        eq("the second page can be shown", sw.Current, 1);
        eq("which fires Switch with its index", JSON.stringify(this.switched), "[1]");

        /* An index nothing answers to leaves the strip alone rather than
         * blanking it: a switcher is routinely told which page to show before
         * its pages exist. */
        sw.Current = 7;
        eq("an index out of range changes nothing", sw.Current, 1);

        sw.Tabs = ["Uno", "Dos"];
        eq("Tabs renames what is there", JSON.stringify(sw.Tabs),
           JSON.stringify(["Uno", "Dos"]));

        /* GTK cannot reorder a stack, so the runtime takes the pages out and
         * puts them back -- with their names, and without a fistful of Switch
         * events for something the user did not do. */
        this.switched = [];
        sw.Reorder(second, 0);
        eq("a page can be moved among its siblings",
           sw.Children.map((c) => c.Name).join(""), "P2P1");
        eq("and its name goes with it", JSON.stringify(sw.Tabs),
           JSON.stringify(["Dos", "Uno"]));
        eq("the page on screen is still the one that was", sw.Current, 0);
        eq("and rebuilding the stack is not a switch",
           JSON.stringify(this.switched), "[]");

        /* Names outlive the pages not existing yet: the .form loader applies
         * properties before it builds children. */
        const late = new Switcher();
        this.Add(late);
        late.Tabs = ["a", "b"];
        eq("a switcher with no pages takes no names", JSON.stringify(late.Tabs), "[]");
        late.Add(new Panel());
        late.Add(new Panel());
        eq("and the pages take them as they arrive", JSON.stringify(late.Tabs),
           JSON.stringify(["a", "b"]));

        /* Lifetimes: a page only GTK holds is collected while GTK still shows
         * it, so the container holds a reference and lets go on removal. */
        const kids = (c) => (c.__children || []).length;
        eq("a switcher holds a reference per page", kids(late), 2);
        late.Remove(0);
        eq("removing a page releases it", kids(late), 1);
        eq("and the page is gone", late.Count, 1);
        late.Children[0].Delete();
        eq("a page can be deleted like any other child", late.Count, 0);
        throws("and removing what is not there says so", () => late.Remove(0));

        throws("a form cannot be a page", () => sw.Append(this));
        throws("nor can a number", () => sw.Append(42));

        /*
         * Where the buttons are, or nothing at all.  `Strip` is read back off
         * the widgets themselves -- which way the box runs, which child comes
         * first, whether the strip is shown -- so asking is what proves the box
         * was really turned around and its children really reordered.
         */
        eq("a switcher puts its strip on top", sw.Strip, "Top");
        for (const where of ["Bottom", "Start", "End", "Top"]) {
            sw.Strip = where;
            eq(`the strip goes ${where}`, sw.Strip, where);
        }
        throws("and nowhere else", () => { sw.Strip = "Middle"; });

        /* None is the whole point of it being a property: the pages, the names
         * and Current all still mean what they meant, and only code changes
         * which one is up -- a welcome screen swapped for the workspace. */
        sw.Strip = "None";
        eq("a switcher can have no strip at all", sw.Strip, "None");
        eq("and is a bare stack that still switches", sw.Count, 2);
        sw.Current = 1;
        eq("by code", sw.Current, 1);
        eq("with the names still there", sw.Tabs.length, 2);

        sw.Delete();
        late.Delete();
    }

    Sw_Switch(index) { this.switched.push(index); }

    /* --- AspectFrame: a rectangle of a given proportion ---------------------
     *
     * The claim is not that a picture can be letterboxed -- `Fit: "Contain"`
     * already does that inside the picture -- but that **the rectangle the
     * picture occupies is a container**, so something else can be put on it: a
     * camera's name in the corner of its image and not out on the black.
     *
     * The two numbers that decide whether it is usable in a wall are the
     * minimums: a frame whose child asks for nothing must ask for nothing, or
     * twenty tiles are twenty floors under the window.
     */
    testAspect() {
        const frame = new AspectFrame();
        this.Add(frame);

        eq("a fresh frame keeps the child's own proportion", frame.Ratio, "");
        eq("and it holds one child, which gets all of it", frame.Placement, "Single");
        throws("Arrangement is refused: its nature settles it",
               () => { frame.Arrangement = "Vertical"; });
        eq("and reads as nothing", frame.Arrangement, "");

        /* Written as anybody means it, and kept as written: 1.7778 in a
         * property grid is a number nobody recognises. */
        frame.Ratio = "16:9";
        eq("a ratio is kept as it was written", frame.Ratio, "16:9");
        frame.Ratio = "4/3";
        eq("and a slash says the same thing", frame.Ratio, "4/3");
        frame.Ratio = 1.5;
        eq("a number is taken too", frame.Ratio, "1.5");
        frame.Ratio = 0;
        eq("zero is the child's own again", frame.Ratio, "");
        frame.Ratio = "";
        eq("and so is nothing", frame.Ratio, "");

        throws("a word is not a ratio",      () => { frame.Ratio = "wide"; });
        throws("nor is a negative number",   () => { frame.Ratio = -2; });
        throws("nor a division by nothing",  () => { frame.Ratio = "16:0"; });
        eq("and a refused ratio changes nothing", frame.Ratio, "");

        /* One child: a second is refused where it is asked for rather than
         * dropping the first without a word, which is what GTK would do. */
        const stage = new Overlay();
        frame.Add(stage);
        throws("an aspect frame holds one child", () => frame.Add(new Label()));
        eq("and it is the one it was given", frame.Children[0] === stage, true);

        /* Emptied and refilled, the round trip every container is held to. */
        frame.Clear();
        eq("cleared", frame.Children.length, 0);
        const again = new Panel();
        frame.Add(again);
        eq("and filled again", frame.Children[0] === again, true);

        /*
         * **A frame whose child asks for nothing asks for nothing**, which is
         * the whole reason this is a container: the application that asked for
         * it sized the video from code instead, and the largest frame a full
         * screen ever needed became the window's floor.
         */
        frame.Ratio = "16:9";
        eq("a frame over a child with no size of its own has none either",
           `${again.SizeRequest()[0]},${frame.SizeRequest()[0]}`, "-1,-1");

        /* And the child is centred in the room there is, at the proportion
         * asked for -- measured on a frame the form stretches. */
        const host = new Panel();
        host.Arrangement = "Vertical";
        this.Add(host);
        host.Resize(320, 320);

        const shaped = new AspectFrame();
        shaped.Ratio  = "16:9";
        shaped.Expand = true;
        host.Add(shaped);

        const inner = new Panel();
        shaped.Add(inner);

        until("the frame is laid out", () => inner.Bounds().Width > 1, () => {
            const box = shaped.Bounds();
            const kid = inner.Bounds();
            const wide = Math.round(kid.Width / kid.Height * 100) / 100;

            eq("the child keeps the proportion it was given", wide, 1.78);

            /*
             * **The biggest rectangle of that shape that fits**, which is the
             * whole sentence: it reaches the box on the axis that runs out
             * first and is centred on the other. Which axis that is depends on
             * the room, so asserting a particular one would be asserting the
             * size of this test's host and not the rule.
             */
            check("inside the room there is",
                  kid.Width <= box.Width && kid.Height <= box.Height,
                  `${kid.Width}x${kid.Height} in ${box.Width}x${box.Height}`);
            check("and as big as that allows",
                  kid.Width === box.Width || kid.Height === box.Height,
                  `${kid.Width}x${kid.Height} in ${box.Width}x${box.Height}`);

            const slackX = box.Width  - kid.Width;
            const slackY = box.Height - kid.Height;
            check("centred in whatever is left over",
                  Math.abs((kid.X - box.X) * 2 - slackX) <= 1 &&
                  Math.abs((kid.Y - box.Y) * 2 - slackY) <= 1,
                  `at ${kid.X - box.X},${kid.Y - box.Y} of ${slackX}x${slackY}`);

            /* Settable while it runs, which is the case it exists for: a
             * stream's proportion arrives when the server answers. */
            shaped.Ratio = "1:2";
            until("it reshapes", () => inner.Bounds().Height > inner.Bounds().Width, () => {
                const tall = inner.Bounds();

                check("a new ratio reshapes what is in it",
                      Math.abs(tall.Height / tall.Width - 2) < 0.05,
                      `${tall.Width}x${tall.Height}`);
                host.Delete();
            });
        });

        frame.Delete();
    }

    testReorder() {
        const box = new Panel();
        box.Arrangement = "Vertical";
        this.Add(box);

        const made = ["a", "b", "c"].map((name) => {
            const b = new Button();
            b.Name = name;
            box.Add(b);
            return b;
        });
        const order = () => box.Children.map((c) => c.Name).join("");
        eq("children come back in the order they were added", order(), "abc");

        box.Reorder(made[2], 0);
        eq("to the front", order(), "cab");
        box.Reorder(made[2], 2);
        eq("to the end", order(), "abc");
        box.Reorder(made[0], 1);
        eq("and to the middle", order(), "bac");

        /* Out of range is clamped by walking what is there, not an error. */
        box.Reorder(made[0], 99);
        eq("past the end is the end", order(), "bca");

        /* A notebook orders its pages, and the tab goes with the page. */
        const book = new Notebook();
        this.Add(book);
        const pages = ["p", "q"].map((name) => {
            const panel = new Panel();
            panel.Name = name;
            book.Append(panel);
            return panel;
        });
        book.Tabs = ["first", "second"];
        eq("a notebook takes its tab names", JSON.stringify(book.Tabs),
           JSON.stringify(["first", "second"]));

        book.Reorder(pages[1], 0);
        eq("reordering a page moves it", book.Children.map((c) => c.Name).join(""), "qp");
        eq("and its tab goes with it", JSON.stringify(book.Tabs),
           JSON.stringify(["second", "first"]));

        /* Tab names outlive the pages not existing yet: the .form loader sets
         * properties before it builds children. */
        const late = new Notebook();
        this.Add(late);
        late.Tabs = ["one", "two"];
        eq("a notebook with no pages takes none", JSON.stringify(late.Tabs), "[]");
        late.Add(new Panel());
        late.Add(new Panel());
        eq("and the pages take the names when they arrive",
           JSON.stringify(late.Tabs), JSON.stringify(["one", "two"]));

        /* A split has two halves, and ordering says which child is which. */
        const paned = new Split();
        this.Add(paned);
        const halves = ["l", "r"].map((name) => {
            const panel = new Panel();
            panel.Name = name;
            paned.Add(panel);
            return panel;
        });
        eq("a split takes two", paned.Children.map((c) => c.Name).join(""), "lr");
        throws("and refuses a third", () => paned.Add(new Panel()));

        paned.Reorder(halves[1], 0);
        eq("ordering a half swaps them", paned.Children.map((c) => c.Name).join(""), "rl");
        paned.Reorder(halves[1], 0);
        eq("and asking for where it already is does nothing",
           paned.Children.map((c) => c.Name).join(""), "rl");

        /*
         * **A split with one half is ordinary**, and reordering that half is
         * documented API -- it is what a Split looks like once the first child
         * is dropped.  The paned branch used to `g_object_ref` both halves
         * unguarded, so this raised two GLib-GObject-CRITICALs and carried on:
         * the move was right, nothing failed, and the runner counts no
         * criticals, which is why nobody had seen it.  Under
         * `G_DEBUG=fatal-criticals` it aborted.
         */
        halves[0].Delete();
        eq("a split keeps working with one half", paned.Children.length, 1);
        paned.Reorder(halves[1], 1);
        eq("and that half can be reordered", paned.Children.map((c) => c.Name).join(""), "r");
        paned.Reorder(halves[1], 0);
        eq("and back", paned.Children.map((c) => c.Name).join(""), "r");

        book.Delete();
        late.Delete();
        paned.Delete();

        /*
         * **Every container that has an order answers the same four questions**,
         * and the loop is the test: three of these used to refuse `Reorder`
         * outright -- a `Flow`, a `RowList` and an `Overlay`, all three on the
         * designer's palette, so dropping a control into one raised *this
         * container has no order to give* after the control had been added.
         *
         * The same indices mean the same thing in all five, which is what makes
         * one gesture in the designer enough: `index` counts the siblings
         * without the one being moved.
         */
        for (const type of ["Flow", "RowList", "Grid", "Overlay"]) {
            const c = Widget.New(type);
            this.Add(c);

            const kids = ["a", "b", "c"].map((name) => {
                const b = new Button();
                b.Name = `${type}${name}`;
                b.Text = name;
                c.Add(b);
                return b;
            });
            const at = () => c.Children.map((k) => k.Text).join("");

            eq(`${type} keeps the order it was given`, at(), "abc");
            c.Reorder(kids[2], 0);
            eq(`${type}: to the front`, at(), "cab");
            c.Reorder(kids[2], 2);
            eq(`${type}: and back to the end`, at(), "abc");
            c.Reorder(kids[0], 1);
            eq(`${type}: and to the middle`, at(), "bac");
            c.Reorder(kids[0], 99);
            eq(`${type}: past the end is the end`, at(), "bca");

            c.Delete();
        }

        /*
         * What an index *means*, asked of the runtime rather than decided by
         * class name -- which is what the designer used to do, and why three
         * containers reached its palette with every gesture treating them as
         * boxes. Five answers, because there are five kinds of gesture.
         */
        const placements = {
            Grid: "Order", Flow: "Order", RowList: "Order", Overlay: "Layers",
            Notebook: "Pages", Switcher: "Pages", Split: "Halves",
        };
        for (const type in placements) {
            const c = Widget.New(type);
            eq(`a ${type} places by ${placements[type]}`, c.Placement, placements[type]);
            c.Delete();
        }

        const surface = new Panel();
        eq("a Fixed panel places by coordinates", surface.Placement, "Coordinates");
        surface.Arrangement = "Vertical";
        eq("and as a column, by order", surface.Placement, "Order");
        eq("Placement is read-only", surface.PropertyNames().includes("Placement"), false);
        surface.Delete();

        /*
         * An `Overlay` is a stack: the order **is** the z-order, and index 0 is
         * the bottom of it -- which is the base layer, the one child GTK hands
         * the whole allocation to. So `Children[0]` is the base at every moment,
         * and that is what makes an index mean something here.
         */
        const stack = new Overlay();
        this.Add(stack);

        const base = new Panel();
        const over = new Label();
        over.Text = "encima";
        stack.Add(base);
        stack.Add(over);
        stack.Resize(220, 90);

        eq("the first child of a stack is its base", stack.Children[0] === base, true);

        stack.Reorder(over, 0);
        eq("ordering a layer to 0 makes it the base", stack.Children[0] === over, true);
        eq("and the old base is the layer above", stack.Children[1] === base, true);

        /* Raise and Lower go through the same door, or Raise on a base would
         * leave it filling while painting over its own floaters. */
        over.Raise();
        eq("Raise puts a layer on top", stack.Children[1] === over, true);
        over.Lower();
        eq("Lower in a stack means become the base", stack.Children[0] === over, true);

        /* Whoever is left has to be a base: an overlay with floaters and no base
         * has nothing that fills. */
        over.Delete();
        eq("the survivor of a stack is one child", stack.Children.length, 1);
        eq("and it is the base", stack.Children[0] === base, true);
        const mark = new Label();        /* would trip an assertion with no base */
        mark.Text   = "cargando";
        mark.HAlign = "Center";
        mark.VAlign = "Center";
        stack.Add(mark);
        eq("and a stack whose base left takes children again", stack.Children.length, 2);

        /*
         * The base is the one that fills, which is the whole claim -- measured a
         * frame later, since nothing is allocated until the loop runs again.
         *
         * And note what the floater's alignment is doing: a layer left alone
         * fills too (GTK aligns `Fill` by default), so `HAlign`/`VAlign` is how
         * a spinner ends up centred over a picture rather than stretched across
         * it. That is the whole placement vocabulary a stack has.
         */
        until("a stack allocates", () => stack.Children[0].Bounds().Width > 1, () => {
            const whole  = stack.Bounds();
            const fills  = stack.Children[0].Bounds();
            const floats = mark.Bounds();

            eq("the base layer is given the whole stack",
               `${fills.Width}x${fills.Height}`, `${whole.Width}x${whole.Height}`);
            check("and a centred layer keeps its own size",
                  floats.Width < whole.Width, `${floats.Width} of ${whole.Width}`);
            check("and is where its alignment put it",
                  floats.X > whole.X, `${floats.X} of ${whole.X}`);

            /*
             * **And moving it is enough: nothing else has to happen.**
             * `gtk_widget_set_halign` queues an allocate on the *child*, which
             * re-allocates it into the rectangle it already had -- so the
             * alignment was stored and never carried out, and the layer sat
             * where it was until something made the overlay lay out again.
             * Found by hand, by changing it in the property grid and then
             * hiding the layer and showing it, which moved it.
             */
            mark.HAlign = "Start";
            mark.VAlign = "Start";

            /* Both read again in here, never against the rectangle measured
             * above: anything else added to this form moves the stack, and a
             * remembered rectangle then reads as a failure that is not one. */
            until("the layer moves", () => mark.Bounds().X === stack.Bounds().X, () => {
                const at  = stack.Bounds();
                const now = mark.Bounds();

                eq("changing a layer's alignment moves it, with no other help",
                   `${now.X},${now.Y}`, `${at.X},${at.Y}`);
                stack.Delete();
            });
        });

        /*
         * A `RowList` keeps its rows in a sequence of GTK's own, so a reorder
         * goes out and back in through the list -- and the selection has to
         * survive it. `gtk_list_box_remove` leaves the row's own flag set and
         * `select_row` refuses a row that already claims to be selected, so
         * getting this wrong leaves a row drawing selected while `Index` answers
         * -1, with nothing but a click to get out of it.
         */
        const ordered = new RowList();
        ordered.Name = "Ordered";
        this.Add(ordered);

        const lines = ["uno", "dos", "tres"].map((text) => {
            const l = new Label();
            l.Text = text;
            ordered.Add(l);
            return l;
        });

        this.orderedSelects = 0;
        ordered.Index = 2;
        eq("the last row is selected", ordered.Index, 2);
        eq("and it said so once", this.orderedSelects, 1);

        ordered.Reorder(lines[2], 0);
        eq("reordering moves the row", ordered.Children[0] === lines[2], true);
        eq("the selection follows the row", ordered.Index, 0);
        eq("Selection agrees", JSON.stringify(ordered.Selection), "[0]");
        eq("and no Select was reported for a move nobody made",
           this.orderedSelects, 1);

        /* Selectable again afterwards, which is the half the flag would eat. */
        ordered.Index = 1;
        eq("and the list still selects", ordered.Index, 1);
        ordered.Delete();

        throws("a Fixed has no order to give",
               () => this.Fixed1.Reorder(this.Fixed1.Children[0], 0));
        throws("nor is a stranger a child of it",
               () => box.Reorder(new Button(), 0));

        box.Delete();
    }

    Ordered_Select() { this.orderedSelects++; }

    /* --- Label.Wrap ---------------------------------------------------------
     *
     * Width is a minimum, so a label with a long line stretches whatever holds
     * it -- a dialog grew to 1151 px from one sentence of help text.  Wrapping
     * caps the natural width instead, and the label keeps the box the .form
     * asked for.
     */
    /* --- three things a caption can be ------------------------------------ */
    testCaption() {
        const label = new Label();
        this.Fixed1.Add(label);

        /* --- words one can pick up ----------------------------------------- */
        eq("a caption cannot be selected until it is worth copying",
           label.Selectable, false);
        check("so that stays out of the .form",
              !("Selectable" in label.Serialize().properties),
              JSON.stringify(label.Serialize().properties));

        label.Selectable = true;
        eq("Selectable round-trip", label.Selectable, true);
        eq("and is saved", label.Serialize().properties.Selectable, true);
        label.Selectable = false;

        /* --- markup, which is a way of reading Text and not a second Text --- */
        label.Text = "un <b>aviso</b>";
        eq("plain, the tags are the text", label.Text, "un <b>aviso</b>");
        eq("a caption is plain until told otherwise", label.Markup, false);

        label.Markup = true;
        eq("Markup round-trip", label.Markup, true);
        eq("and what it holds is still what was written",
           label.Text, "un <b>aviso</b>");
        eq("which is what gets saved -- a label that lost its tags by being " +
           "saved would change every time",
           label.Serialize().properties.Text, "un <b>aviso</b>");

        /* Turning it on after the fact re-reads what is already there, which is
         * the order a `.form` writes properties in half the time. */
        const after = new Label();
        after.Text   = "<i>ya</i>";
        after.Markup = true;
        eq("turning it on says what it holds again", after.Text, "<i>ya</i>");

        /* And off again: the tags become text, not a parse error. */
        label.Markup = false;
        eq("off, the tags are text once more", label.Text, "un <b>aviso</b>");
        check("and it is the same one prose property either way -- the "
              + "catalogue collects markup and all, as gettext always has",
              label.TextProperties().includes("Text"),
              JSON.stringify(label.TextProperties()));

        /* --- how many lines it may take ------------------------------------- */
        eq("a caption takes as many lines as it needs", label.Lines, 0);
        throws("a negative count is refused", () => { label.Lines = -1; });

        label.Lines = 3;
        eq("Lines round-trip", label.Lines, 3);
        eq("and is saved", label.Serialize().properties.Lines, 3);
        label.Lines = 0;
        eq("and zero is no limit again", label.Lines, 0);

        label.Delete();
        after.Delete();
    }

    testLabelWrap() {
        const label = new Label();
        this.Fixed1.Add(label);
        label.Move(4, 4);
        label.Resize(120, 60);
        label.Text = "a line long enough that nothing this narrow could hold it " +
                     "on one row, which is the whole point of wrapping it";

        eq("a label does not wrap by default", label.Wrap, false);
        label.Wrap = true;
        eq("Wrap reads back", label.Wrap, true);

        check("and it is saved like any other property",
              label.Serialize().properties.Wrap === true,
              JSON.stringify(label.Serialize().properties));

        const plain = new Label();
        check("while an unwrapped one writes nothing",
              !("Wrap" in plain.Serialize().properties));

        label.Wrap = false;
        eq("and it can be turned off again", label.Wrap, false);

        label.Delete();
    }

    /* --- Label.Ellipsize ----------------------------------------------------
     *
     * The other answer to the question `Wrap` answers: keep the one line and
     * give up the tail of it.  What wants it is a caption on a strip that cannot
     * grow -- the designer's preview of the form's title bar is the case that
     * asked for it, where a long caption would have pushed the title bar wider
     * than the form it titles.
     */
    testLabelEllipsize() {
        const label = new Label();
        this.Fixed1.Add(label);
        label.Move(4, 4);
        label.Resize(120, 24);
        label.Text = "a caption far longer than the strip it has been given to sit on";

        eq("a label does not ellipsize by default", label.Ellipsize, false);
        label.Ellipsize = true;
        eq("Ellipsize reads back", label.Ellipsize, true);

        check("and is saved like any other property",
              label.Serialize().properties.Ellipsize === true,
              JSON.stringify(label.Serialize().properties));
        check("while a plain one writes nothing",
              !("Ellipsize" in new Label().Serialize().properties));

        /* The two are answers to the same question and a label can only give
         * one: text that wraps has no end to put the ellipsis at. */
        label.Wrap = true;
        eq("wrapping turns ellipsizing off", label.Ellipsize, false);
        label.Ellipsize = true;
        eq("and ellipsizing turns wrapping off", label.Wrap, false);

        label.Ellipsize = false;
        eq("and it can be turned off again", label.Ellipsize, false);

        label.Delete();
    }

    /* --- what a container keeps alive --------------------------------------
     *
     * The wrapper owns the BtaWidget, so a container has to hold a JS reference
     * to every child -- and let go of it on removal, or a long-running
     * application (an IDE opening and closing tabs) piles wrappers up for the
     * life of the container.  `__children` is that reference; counting it is the
     * only way a test can see the difference.
     */
    testChildRefs() {
        const kids = (c) => (c.__children || []).length;

        const panel = new Panel();
        this.Add(panel);

        const a = new Button(), b = new Button();
        panel.Add(a);
        panel.Add(b);
        eq("a container holds a reference per child", kids(panel), 2);

        a.Delete();
        eq("deleting one lets go of it", kids(panel), 1);
        b.Remove();
        eq("detaching without destroying lets go too", kids(panel), 0);

        /* A Notebook adds pages its own way, so it has to release them its own
         * way as well: Remove(index) is not Delete(). */
        const book = new Notebook();
        this.Add(book);

        for (let i = 0; i < 3; i++) {
            const page  = new Panel();
            page.Arrangement = "Vertical";
            const label = new Label();
            label.Text = `t${i}`;
            book.Append(page, label);
        }
        eq("three pages and three tabs", kids(book), 6);
        eq("and the notebook says three", book.Count, 3);

        /* A notebook's GTK children are its header and its stack, so Children has
         * to answer with the pages instead -- that is what being a child of a
         * notebook means. */
        eq("Children answers with the pages", book.Children.length, 3);

        book.Remove(0);
        eq("removing a page releases the page and its tab", kids(book), 4);
        eq("and the page is gone", book.Count, 2);

        /* Replacing a tab label releases the one that was there. */
        const fresh = new Label();
        fresh.Text = "new";
        book.SetTabLabel(0, fresh);
        eq("replacing a tab label releases the old one", kids(book), 4);

        /* Delete() on a page goes through the container path and has to work at
         * all: a notebook slot used to throw "cannot remove from this container". */
        const first = book.Children[0];
        first.Delete();
        eq("a page can be deleted like any other child", book.Count, 1);

        book.Delete();
        panel.Delete();
    }

    /* --- drag and drop ----------------------------------------------------
     *
     * DragData and AcceptDrop are properties of any widget, not of some special
     * control.  What a test can assert is exactly that: that they are assigned,
     * read back, and saved into the .form like any other (a real drop is GTK's
     * doing with the mouse, and that is verified by hand).
     */
    testDragDrop() {
        const source = new Button();
        const target = new Panel();

        eq("nothing is draggable by default", source.DragData, "");
        eq("nor receives anything", target.AcceptDrop, false);

        source.DragData = "Button";
        eq("DragData reads back as written", source.DragData, "Button");

        /* Emptying it turns dragging off again: the only way to undo it without
         * recreating the control. */
        source.DragData = "";
        eq("and emptying it turns it off", source.DragData, "");

        target.AcceptDrop = true;
        eq("AcceptDrop turns on", target.AcceptDrop, true);
        target.AcceptDrop = false;
        eq("and turns off", target.AcceptDrop, false);

        /* **Files from the desktop are a second, independent drop.** The
         * application's own drag carries a string and the file manager offers a
         * list of files, so they are two targets and two events -- and a control
         * may want either, both, or neither. What a test can assert is the
         * surface; the drop itself is GTK's doing with a real pointer and a real
         * file manager, and is checked by hand like the other one. */
        eq("no files by default", target.AcceptFiles, false);
        target.AcceptFiles = true;
        eq("AcceptFiles turns on", target.AcceptFiles, true);
        eq("without touching the other one", target.AcceptDrop, false);
        target.AcceptDrop = true;
        eq("and both at once is a control that takes either",
           target.AcceptFiles && target.AcceptDrop, true);
        target.AcceptFiles = false;
        eq("files turn off on their own", target.AcceptFiles, false);
        eq("leaving the drag alone", target.AcceptDrop, true);
        target.AcceptDrop = false;

        /*
         * **And the one thing about *placing* a drop that a test can reach.**
         * `Drop(data, x, y)` carries the point in the accepting widget's own
         * coordinates, and `child.Bounds(that widget)` answers in the same
         * space -- so which row a drop is over is a comparison, and a list
         * can place a dropped card instead of appending it. None of that is
         * assertable here: there is no synthetic pointer, and an `Emit` would
         * only hand our own numbers back. It was measured by hand instead
         * (`examples/kanban`, and the note in AGENTS.md).
         *
         * What *is* assertable is the guard such a walk needs: a hidden child
         * does not keep its last rectangle, it measures **0x0 at the origin**
         * -- which is a rectangle every point in the container is below, so a
         * walk that forgot `Visible` would answer with the wrong row rather
         * than with none.
         */
        const seen = new Panel();
        seen.Width = 120;
        seen.Height = 40;
        this.Fixed1.Add(seen);
        seen.Move(4, 4);

        until("the panel is laid out", () => seen.Bounds().Width > 1, () => {
            check("a shown child has a rectangle", seen.Bounds().Width >= 120,
                  JSON.stringify(seen.Bounds()));
            seen.Visible = false;

            until("and the hidden one is measured again",
                  () => seen.Bounds().Width === 0, () => {
                eq("a hidden child measures nothing wide", seen.Bounds().Width, 0);
                eq("nothing tall",                         seen.Bounds().Height, 0);
                eq("and sits at the origin",               seen.Bounds().X, 0);
                seen.Delete();
            });
        });

        /* An empty tooltip is none, not a blank balloon. */
        eq("no Tooltip by default", source.Tooltip, "");
        source.Tooltip = "Save";
        eq("Tooltip reads back as written", source.Tooltip, "Save");

        /* And they travel to the .form, because they are properties with a getter
         * and a setter: the same rule that makes everything else designable. */
        source.DragData    = "Button";
        target.AcceptDrop  = true;
        target.AcceptFiles = true;
        eq("DragData is saved", source.Serialize().properties.DragData, "Button");
        eq("AcceptDrop is saved", target.Serialize().properties.AcceptDrop, true);
        eq("AcceptFiles too", target.Serialize().properties.AcceptFiles, true);
        eq("Tooltip is saved", source.Serialize().properties.Tooltip, "Save");

        const plain = new Button();
        check("and what nobody touched is not saved",
              !("DragData" in plain.Serialize().properties) &&
              !("AcceptDrop" in plain.Serialize().properties) &&
              !("AcceptFiles" in plain.Serialize().properties) &&
              !("Tooltip" in plain.Serialize().properties),
              JSON.stringify(plain.Serialize().properties));

        source.Delete();
        target.Delete();
    }

    /* --- components ----------------------------------------------------------
     *
     * A form that is not a window: its own .form, its own class, dropped into
     * another form as if it were a control.  What makes it work is that nothing
     * had to learn about it -- the loader instantiates any class the project
     * declares, and the serialiser discovers its properties the same way it
     * discovers a Button's.
     */
    testComponent() {
        const step = this.Step1;

        eq("the .form instantiated a class of the project's", step.constructor.name, "Stepper");
        check("which is a component", step instanceof Component);
        check("and a container, like anything with children", step instanceof Container);

        eq("its own .form was loaded into it", step.Children.length, 3);
        eq("with its children named on itself", step.Shown.Text, "5");
        eq("and not on the form holding it", this.Shown, undefined);

        eq("a property of its own was set from the file", step.Value, 5);

        /* Its children's events are its own: a Button inside it dispatches to
         * the component, not to the form. */
        step.Up.Click();
        eq("a button inside it reaches its own handler", step.Value, 6);
        eq("and the change shows", step.Shown.Text, "6");

        /* And what it says goes to whoever holds it, by name. */
        eq("Emit arrives on the form as Name_Event", this.stepSaid, 6);

        step.Value = 9;
        eq("with the argument it was given", this.stepSaid, 9);

        /* Serialised as a black box: what is inside belongs to its own .form and
         * would come back doubled if it were written here too. */
        const node = step.Serialize();
        eq("saved by its own type", node.type, "Stepper");
        check("with its own properties", node.properties.Value === 9,
              JSON.stringify(node.properties));
        check("and no children of its own", !("children" in node),
              JSON.stringify(node));

        /*
         * What the class declares about itself.
         *
         * `Value` was discoverable because it is *there* -- an accessor, which
         * the same walk the serialiser uses finds on any prototype.  These three
         * are not: they are declarations, and until a class could make them the
         * answers came from the class *table*, which holds no class of the
         * project.  A Stepper published Widget's mouse events however much it
         * emitted, and `EventNames()[0]` -- the event a double click writes --
         * was `MouseDown` for every component ever written.
         */
        eq("a component's own event leads what it publishes",
           step.EventNames()[0], "Change");
        check("with what every widget raises after it",
              step.EventNames().includes("MouseDown"),
              JSON.stringify(step.EventNames()));
        eq("and said once, though the walk passes Widget either way",
           step.EventNames().filter((e) => e === "Change").length, 1);

        eq("the values a property accepts come from the class too",
           step.PropertyOptions("Step").join(","), "1,5,10");
        eq("one it says nothing about is free-form, as anywhere else",
           step.PropertyOptions("Value"), null);
        check("and a name it never declared cannot reach through to Object's",
              step.PropertyOptions("constructor") === null,
              JSON.stringify(step.PropertyOptions("constructor")));

        eq("which of its strings hold prose, likewise -- its own, then Widget's",
           JSON.stringify(step.TextProperties()), '["Caption","Tooltip"]');

        /*
         * A component extending a component: the middle of the chain is a class
         * the table does not hold either, and the order still comes out
         * most-derived first because the statics are read *inside* the walk
         * rather than added to its answer.
         */
        const chip = new Chip();
        this.Fixed1.Add(chip);

        eq("a component may extend a component", chip instanceof Stepper, true);
        eq("its own event comes first", chip.EventNames()[0], "Pressed");
        eq("then the one it inherits from the component above it",
           chip.EventNames()[1], "Change");
        check("then every widget's", chip.EventNames().includes("MouseDown"),
              JSON.stringify(chip.EventNames()));

        eq("prose accumulates down the same chain",
           JSON.stringify(chip.TextProperties()), '["Legend","Caption","Tooltip"]');
        eq("while a list of values is the first class that answers",
           chip.PropertyOptions("Step").join(","), "1,5,10");
        eq("and its own answers for its own",
           chip.PropertyOptions("Size").join(","), "Small,Large");

        /* Inherited statics are read as the parent's, at the parent's step: a
         * class that declares nothing adds nothing of its own. */
        const quiet = new Gadgets.Stepper();
        eq("a component that declares no events publishes what it inherits",
           quiet.EventNames()[0], "MouseDown");
        eq("and no prose of its own", JSON.stringify(quiet.TextProperties()),
           '["Tooltip"]');
        quiet.Delete();
        chip.Delete();

        /* Built from code as readily as from a file. */
        const made = new Stepper();
        this.Fixed1.Add(made);
        made.Name = "Made";
        made.Value = 2;
        eq("one built from code works the same", made.Shown.Text, "2");
        made.Delete();

        step.Value = 5;   /* what the round-trip assertions expect */
    }

    /* --- namespaces ----------------------------------------------------------
     *
     * Gadgets/Stepper.js declares `Gadgets.Stepper`, which shares its short name
     * with the Stepper at the project root and is a different class entirely.
     * That is the whole point: without namespaces the second one could not
     * exist, because a .form names a type and there would be no way to say
     * which of the two it means.
     */
    testNamespace() {
        const plain = this.Step1;
        const gad   = this.Gad1;

        /* Two classes, not one used twice. */
        check("a namespace is an object on globalThis", typeof Gadgets === "object");
        check("holding the class", Gadgets.Stepper === gad.constructor);
        check("which is not the one at the root", gad.constructor !== plain.constructor);
        eq("though both are called Stepper", gad.constructor.name, plain.constructor.name);

        /* Each loaded its own .form, which is what the bare/qualified split
         * buys: the root file for the bare name, the folder's for the other. */
        eq("the root class got the root .form", plain.Children.length, 3);
        eq("and the namespaced one got its own", gad.Children.length, 2);
        eq("with its own children", gad.Bump.Text, "bump");

        /* Its own setter ran: this one counts by tens. */
        eq("a property from the file reached the right class", gad.Value, 3);
        eq("through its own accessor", gad.Shown.Text, "30");
        eq("without disturbing the other", plain.Shown.Text, "5");

        gad.Bump_Click();
        eq("its own handler works", gad.Value, 4);
        eq("and Emit still arrives by control name", this.gadSaid, 4);

        /* The name it goes by in a .form -- which a constructor cannot answer
         * on its own, since the class expression was named before the
         * assignment that put it in the namespace. */
        eq("TypeName qualifies a class in a namespace",
           Widget.TypeName(Gadgets.Stepper), "Gadgets.Stepper");
        eq("and leaves a class in none alone",
           Widget.TypeName(plain.constructor), "Stepper");
        eq("a runtime class is itself", Widget.TypeName(Button), "Button");

        /* Serialised by that name, so what the designer writes loads back. */
        const node = gad.Serialize();
        eq("a component serialises under its qualified type", node.type, "Gadgets.Stepper");
        eq("and the bare one under its bare type", plain.Serialize().type, "Stepper");

        /*
         * Defaults are per class and not per name.  Both declare a Width in
         * their own .form -- 180 and 140 -- so each has to be compared against
         * its own bare instance; sharing one by name would make one of the two
         * write a Width it never changed.
         */
        check("a value equal to its own default is left out",
              !("Width" in node.properties), JSON.stringify(node.properties));
        check("for the other class too",
              !("Width" in plain.Serialize().properties),
              JSON.stringify(plain.Serialize().properties));

        /* Built by name, which is what the .form loader and the designer do. */
        const made = Widget.New("Gadgets.Stepper");
        this.Fixed1.Add(made);
        made.Value = 7;
        eq("Widget.New takes a qualified name", made.Shown.Text, "70");
        check("and builds the right class", made.constructor === Gadgets.Stepper);
        made.Delete();

        /* Declaring a namespace twice is not a reset: it is how every file of a
         * folder says which one it belongs to. */
        const again = Namespace("Gadgets");
        check("Namespace returns the object", again === Gadgets);
        check("and does not clear it", Gadgets.Stepper !== undefined);

        throws("a namespace has to be nameable", () => Namespace("no-dashes"));
        throws("an empty segment is refused", () => Namespace("A..B"));
    }

    /* --- JSON files, without the ceremony -----------------------------------
     *
     * Reading one was always `JSON.parse(File.Load(path))` and writing one
     * always the same stringify, with the same indent and the same trailing
     * newline.  Two names for the pair, and neither the ritual nor the choice
     * comes up again -- the IDE went from 26 mentions of JSON to one.
     */
    testJsonFiles() {
        /*
         * **A fraction survives being parsed, whatever the desktop's language.**
         *
         * `JSON.parse("0.05")` answered **0** on this machine and on every one
         * whose locale writes a decimal comma -- es, de, fr, pt, ru -- because
         * QuickJS's JSON tokenizer reached for `strtod`, which reads the C
         * locale's separator, and GTK calls `setlocale(LC_ALL, "")` at startup.
         * Every other number path uses QuickJS's own conversion; that one line
         * did not. See the patch note in `vendor/quickjs/quickjs.c`.
         *
         * Silently, which is what makes it worth a test of its own: a `.form`
         * carrying `Step: 0.05` loaded a spin that would not step, a price in a
         * settings file came back whole, and nothing anywhere said so. It is the
         * same trap the font size documents in `bta_widget.c`, one layer down.
         */
        eq("a fraction parses as one", JSON.parse("0.05"), 0.05);
        eq("inside an array too", JSON.parse("[0.5]")[0], 0.5);
        eq("and inside an object", JSON.parse('{"a":1.25}').a, 1.25);
        eq("negative and exponent alike", JSON.parse("-1.5e2"), -150);
        eq("what a whole number was always fine at", JSON.parse("7"), 7);

        Directory.Make(SCRATCH);
        const path = File.Join(SCRATCH, "thing.json");
        const value = { name: "x", list: [1, 2], nested: { on: true },
                        /* Round trip through the file, since that is how a
                         * project keeps its settings. */
                        rate: 0.05 };

        File.SaveJson(path, value);
        check("what comes back is what went in",
              sameJson(File.LoadJson(path), value), File.Load(path));

        const text = File.Load(path);
        check("written indented, like every file this project writes",
              text.includes('\n  "name"'), JSON.stringify(text));
        check("and ending in a newline", text.endsWith("}\n"), JSON.stringify(text.slice(-4)));

        /* A .form the IDE is about to open is exactly this case, and a bare
         * SyntaxError would not say which file was at fault. */
        File.Save(path, "{ not json");
        let said = "";
        try { File.LoadJson(path); } catch (e) { said = e.message; }
        check("a broken file names itself", said.includes("thing.json"), said);

        throws("a missing file still throws",
               () => File.LoadJson(File.Join(SCRATCH, "nope.json")));

        File.Delete(path);
    }

    /* --- applying a dictionary of properties --------------------------------
     *
     * The other half of Serialize, and the reason nobody has to write
     * `for (const key of Object.keys(node.properties))` again: applying a bag of
     * settings to a control is what a .form does, what the designer does, and
     * what an application restoring its own state does.
     */
    testApply() {
        const b = new Button();
        this.Fixed1.Add(b);

        const back = b.Apply({ Text: "hola", Width: 120, Height: 28 });
        eq("every property is assigned", b.Text, "hola");
        eq("including the numbers", b.Width, 120);
        check("and it hands the control back, so it can be chained", back === b);

        /* A missing dictionary applies nothing: the caller never has to check,
         * which is why AddNode can pass node.properties straight through. */
        b.Apply(undefined);
        eq("a missing dictionary is not an error", b.Text, "hola");
        b.Apply({});
        eq("nor an empty one", b.Text, "hola");

        /* It is the exact inverse of Serialize, which is what makes a .form
         * round-trip at all. */
        const node = b.Serialize();
        const twin = new Button();
        this.Fixed1.Add(twin);
        twin.Apply(node.properties);
        eq("what Serialize wrote, Apply reads back", twin.Text, b.Text);
        eq("geometry included", twin.Width, b.Width);

        /*
         * And the idiom underneath it.  `for...in` is a footgun in JavaScript
         * because an object can inherit enumerable properties; here it cannot --
         * Object.create, setPrototypeOf and __proto__ are all gone -- so it is
         * simply how a dictionary is read.
         */
        const seen = [];
        for (const key in { a: 1, b: 2 }) seen.push(key);
        eq("for...in reads a dictionary", seen.join(), "a,b");

        b.Delete();
        twin.Delete();
    }

    /* --- logging -------------------------------------------------------------
     *
     * What `console` was standing in for badly: its .log and .error both went to
     * stdout, so the one distinction it offered was a lie.  A level says how
     * much it matters and the application says where it goes.
     */
    testLog() {
        eq("Debug is off unless asked for", Logger.Level, "Info");
        eq("and the terminal is where it goes", Logger.Target, "Terminal");

        /* Handler takes it over, which is what makes a custom log possible at
         * all -- to a file, to a widget, to whatever the application reaches. */
        const seen = [];
        Logger.Handler = (level, text) => seen.push(`${level}|${text}`);

        Logger.Info("uno");
        Logger.Error("dos", "tres");
        eq("the handler gets level and text", seen[0], "Info|uno");
        eq("with the arguments joined, like print", seen[1], "Error|dos tres");

        /* Below the threshold nothing is even formatted. */
        Logger.Debug("no");
        eq("Debug is not reported at Info", seen.length, 2);

        Logger.Level = "Debug";
        Logger.Debug("si");
        eq("and is once the level allows it", seen[2], "Debug|si");

        Logger.Level = "None";
        Logger.Error("nada");
        eq("None silences even errors", seen.length, 3);
        Logger.Level = "Info";

        /* A handler that throws is reported once and does not come back in. */
        Logger.Handler = () => { throw new Error("handler roto"); };
        Logger.Info("esto no cuelga");
        check("a broken handler does not take the application with it", true);

        Logger.Handler = null;
        eq("clearing it gives the terminal back", Logger.Target, "Terminal");

        throws("an unknown level is refused", () => { Logger.Level = "Chatty"; });
        eq("and the old one stands", Logger.Level, "Info");
        throws("an unknown target is refused", () => { Logger.Target = "Carrier pigeon"; });

        /*
         * The journal is an extension, not part of logging: on a system that has
         * it, asking works; on one that does not, asking is refused rather than
         * silently logging nowhere.  Either answer is correct -- what would not
         * be is accepting and then dropping the message.
         */
        let took = true;
        try { Logger.Target = "Journal"; } catch (e) { took = false; }
        eq("the journal is either there or says it is not",
           Logger.Target, took ? "Journal" : "Terminal");
        Logger.Target = "Terminal";

        /* And the thing it replaced is gone. */
        eq("console is not part of the language", typeof console, "undefined");
    }

    /* --- timers, said in one line -------------------------------------------
     *
     * The two things anyone wants from a timer, and both hand the timer back so
     * what was started can still be stopped.
     */
    testTimerShorthand() {
        const after = Timer.After(5, () => { this.afterRan = true; });
        check("After gives back a timer", after instanceof Timer);
        eq("which is running", after.Enabled, true);

        const every = Timer.Every(5, () => { this.everyRan = (this.everyRan || 0) + 1; });
        check("Every gives back one too", every instanceof Timer);
        eq("also running", every.Enabled, true);
        eq("with the delay it was given", every.Delay, 5);

        /* Stoppable, which a bare timer id never was without keeping it. */
        every.Stop();
        eq("and it can be stopped", every.Enabled, false);

        /* That they actually fire is checked once the loop has turned. */
        this.pendingAfter = after;
    }

    checkTimers() {
        eq("After fired", this.afterRan, true);
        eq("and does not repeat", this.pendingAfter.Enabled, false);
        check("a stopped Every never fired", !this.everyRan, String(this.everyRan));
    }

    /* --- the language a project actually gets --------------------------------
     *
     * The context is built from chosen intrinsics rather than the whole standard
     * library, and the ways back into the raw language are closed once rad.js
     * has what it needs.  `typeof` is the one operator that does not throw on a
     * name that is not there, which is how this can be asked at all.
     */
    testCuratedLanguage() {
        /* Scheduling: Timer is the way, so the primitives it is built out of are
         * not also lying around under another name. */
        eq("setTimeout is not part of the language", typeof setTimeout, "undefined");
        eq("nor setInterval", typeof setInterval, "undefined");
        eq("nor the clears that went with them", typeof clearInterval, "undefined");
        check("but Timer still schedules", Timer.After(5, () => {}) instanceof Timer);

        /* Turning a string into code: not something this language does. */
        eq("eval is not part of the language", typeof eval, "undefined");
        eq("nor is Function", typeof Function, "undefined");

        /* Nor by the road that does not need the name.  Deleting the property
         * makes the lookup fall through to Object, which cannot compile. */
        eq("a function's constructor no longer compiles",
           (function () {}).constructor.name, "Object");

        /*
         * **Object is empty.**  What a control can be asked for is answered by
         * PropertyNames(), what a plain object holds by Dictionary, and a
         * property is written by declaring get/set in a class -- so every static
         * it used to carry either has a word of its own here or is machinery
         * rad.js captured before the names went.
         *
         * Asserted one by one, and it has to be: walking the object would need
         * the very reflection this is about, and a static is non-enumerable so
         * `for...in` would report an empty Object either way.  **So this list is
         * the test, and it is a copy** -- the authority is `statics[]` in
         * close_hatches(), and a member the engine grows later is absent from
         * both until somebody adds it to both.  That is the honest limit of
         * checking a curation from inside it.
         */
        for (const gone of ["create", "getPrototypeOf", "setPrototypeOf",
                            "defineProperty", "defineProperties",
                            "getOwnPropertyNames", "getOwnPropertyDescriptor",
                            "getOwnPropertyDescriptors", "getOwnPropertySymbols",
                            "keys", "values", "entries", "hasOwn",
                            "fromEntries", "assign", "groupBy", "is",
                            "freeze", "isFrozen", "seal", "isSealed",
                            "preventExtensions", "isExtensible"]) {
            eq(`Object.${gone} is not part of the language`,
               typeof Object[gone], "undefined");
        }

        /* The plurals are the half that was missed the first time: the singulars
         * were taken and `defineProperties` still wrote the accessors, while
         * `getOwnPropertyDescriptors` read what its singular could not -- enough
         * to replace the setter on a Record's field with one that validates
         * nothing.  Which is why the rule is emptiness and not a shorter list. */

        /*
         * And not by the same capability spelled on the prototype, where every
         * object carries it: __defineGetter__ is defineProperty and
         * __lookupGetter__ is getOwnPropertyDescriptor walking the chain.
         * Leaving those while taking the statics would have been theatre, which
         * is the reason __proto__ went with getPrototypeOf.
         */
        eq("__proto__ does not reach the prototype", ({}).__proto__, undefined);
        for (const hatch of ["__defineGetter__", "__defineSetter__",
                             "__lookupGetter__", "__lookupSetter__"]) {
            eq(`nor ${hatch}`, typeof ({})[hatch], "undefined");
        }

        /* What asks about an object rather than rewriting it stays -- and the
         * last two are how a value becomes a string at all. */
        for (const kept of ["hasOwnProperty", "isPrototypeOf",
                            "propertyIsEnumerable", "toString", "valueOf"]) {
            eq(`${kept} is still there`, typeof ({})[kept], "function");
        }

        /* What replaced them, and what was never in question. */
        check("PropertyNames still answers for a control",
              this.B1.PropertyNames().includes("Text"),
              JSON.stringify(this.B1.PropertyNames().slice(0, 5)));
        /* Reading a dictionary is not reflection: a .form's `properties` is one,
         * and applying it entry by entry is what keeps the format from knowing
         * about any control in particular.  Dictionary is the word for it now. */
        check("and Dictionary reads a plain object",
              Dictionary.Keys({ a: 1, b: 2 }).join() === "a,b");
        check("as does for...in, which is the other half of the rule",
              (() => { const k = []; for (const x in { a: 1, b: 2 }) k.push(x);
                       return k.join(); })() === "a,b");

        /*
         * **Why `for...in` is safe, said correctly.**
         *
         * `llm/language.md` justified it with *nothing can put anything on a
         * prototype any more*, which was three claims in a row and only one of
         * them true. The safety is real and is the **engine's**: `toString` and
         * its siblings are non-enumerable and always were, so emptying `Object`
         * had nothing to do with it. What emptying `Object` did do is take away
         * `freeze`, `seal` and `preventExtensions`, so a program can neither
         * lock `Object.prototype` nor ask whether anything wrote to it -- and an
         * ordinary assignment there still works and *is* recited.
         *
         * `Dictionary` is immune to both, which is the better argument for it
         * and was written down nowhere.
         */
        const recite = (o) => { const k = []; for (const x in o) k.push(x); return k.join(); };

        check("what an object inherits is reachable", "toString" in {});
        eq("...and for...in walks past it, because it is not enumerable",
           recite({ a: 1 }), "a");

        Object.prototype.auditProbe = 1;
        try {
            eq("an enumerable one put there *is* recited",
               recite({ a: 1 }), "a,auditProbe");
            eq("...and Dictionary.Keys is immune, being own keys only",
               Dictionary.Keys({ a: 1 }).join(), "a");
        } finally {
            delete Object.prototype.auditProbe;
        }
        eq("and the probe left nothing behind", recite({ a: 1 }), "a");

        /* Nothing published could have stopped it: the four that would are gone
         * with the rest of Object's statics. */
        for (const lock of ["freeze", "seal", "preventExtensions", "isExtensible"])
            eq(`Object.${lock} is gone, so a prototype cannot be locked`,
               typeof Object[lock], "undefined");

        /*
         * **Every name the runtime looks something up by is ASCII**, which is
         * narrower than the language underneath and was written down nowhere.
         * The engine takes `Peón` as an identifier -- `CheckSource` says so, and
         * that is the half of the claim worth pinning, since it is what makes
         * the limit the runtime's own rather than QuickJS's.
         */
        eq("the engine accepts an accented identifier",
           Application.CheckSource("class Peón { }"), null);
        eq("...and so does a namespaced one",
           Application.CheckSource("const año = 1;"), null);
        throws("but Widget.New refuses a class name it cannot spell",
               () => Widget.New("Peón"));

        eq("Symbol is not part of the language", typeof Symbol, "undefined");

        /*
         * **Scheduling has one name, and `queueMicrotask` was a second one with
         * no switch and no handle.** It went with `setTimeout` and `setInterval`
         * for the sentence those went for, and the fact that it *worked* --
         * `bta_drain_jobs` pumps the queue after every event handler -- is why
         * it was worth taking rather than a reason to keep it.
         * `escape`/`unescape` are an Annex B URL encoding with no caller here.
         */
        eq("queueMicrotask is not the third way to schedule",
           typeof queueMicrotask, "undefined");
        eq("escape is gone", typeof escape, "undefined");
        eq("unescape is gone", typeof unescape, "undefined");

        /*
         * **And these are installed on purpose and documented as such.** They
         * were unlisted for a long time, which is the same defect as an
         * undocumented method: `docs/llm/` claims to be the whole public
         * surface. `WeakMap` is the load-bearing one -- `forms.js` keeps its
         * notes about a widget in one rather than on it.
         */
        for (const there of ["BigInt", "WeakMap", "WeakSet", "Iterator",
                             "DisposableStack"]) {
            eq(`${there} is installed and documented`,
               typeof this.globalNamed(there), "function");
        }

        /* Generators themselves keep working -- the tests are written in them,
         * and iterating one never needed Symbol by name. */
        const counted = [...(function* () { yield 1; yield 2; })()];
        eq("generators still work", counted.join(","), "1,2");

        /* The back door to everything at once.  Namespace() is how a project
         * publishes here, and it still works because rad.js captured the object
         * before the name went away. */
        eq("globalThis is not part of the language", typeof globalThis, "undefined");
        check("but a namespace still publishes", typeof Gadgets === "object");

        /* Never used by any Bintana code, so never installed. */
        for (const absent of ["Promise", "Proxy", "Reflect", "WeakRef", "Symbol",
                              "ArrayBuffer", "Uint8Array", "atob", "performance"]) {
            eq(`${absent} is not installed`, typeof this.globalNamed(absent), "undefined");
        }

        /* What the language is made of, and what it would be absurd without. */
        for (const kept of ["JSON", "RegExp", "Regex", "Dictionary", "Map", "Set", "Date", "Math",
                            "Namespace", "Widget", "Settings", "Timer", "Logger"]) {
            check(`${kept} is there`, typeof this.globalNamed(kept) !== "undefined");
        }

        /* The one honest use of Function, published on its own. */
        eq("valid source checks out",
           Application.CheckSource("class A extends Form {}"), null);

        const bad = Application.CheckSource("class {{{");
        check("and a broken one says why", bad.Message.length > 0, JSON.stringify(bad));

        /*
         * **And says where**, which is the half that makes it usable by an
         * editor: the position is the compiler's own, picked out of the frame
         * this function named, not parsed back out of the message.
         */
        const late = Application.CheckSource("let a = 1;\nlet b = 2;\nlet c = ;\n");
        eq("with the line it stopped on", late.Line, 3);
        check("and a column on it", late.Column > 0, JSON.stringify(late));

        /* Compiled, not run: asking is not executing. */
        eq("checking does not run the code",
           Application.CheckSource("noSuchFunction(); throw new Error('boom');"), null);

        /*
         * **And the position survives whatever the program did to `Error`.**
         *
         * There is nowhere else to read it from: a QuickJS error carries no
         * `lineNumber`, `columnNumber` or `fileName`, so `check_position` parses
         * `<check>:LINE:COL` out of `.stack` and that is the only way there is.
         * Which meant two ordinary assignments used to break this answer in
         * silence -- `prepareStackTrace` replaces the whole string and
         * `stackTraceLimit = 0` empties it, and both returned `Line: 0,
         * Column: 0` with the message still correct, so an editor underlined the
         * first character of the file and nothing said why. The second is the
         * likelier one: it is what somebody sets to quieten a log.
         *
         * `CheckSource` takes its own reading now and hands the settings back
         * untouched -- what a program does to `Error` is its business, and must
         * not be able to corrupt a runtime answer.
         */
        const mine = () => "nothing like a stack";
        const src  = "let a = 1;\nlet b = ;\n";

        Error.prepareStackTrace = mine;
        const prep = Application.CheckSource(src);
        eq("a prepareStackTrace does not move the line", prep.Line, 2);
        check("...nor the column", prep.Column > 0, JSON.stringify(prep));
        check("...and the program keeps its own", Error.prepareStackTrace === mine);
        Error.prepareStackTrace = undefined;

        Error.stackTraceLimit = 0;
        const none = Application.CheckSource(src);
        eq("a stackTraceLimit of 0 does not move the line", none.Line, 2);
        check("...nor the column", none.Column > 0, JSON.stringify(none));
        eq("...and the program keeps its own", Error.stackTraceLimit, 0);
        Error.stackTraceLimit = 10;

        /*
         * **`async` is refused where it is written, in every form it has.**
         *
         * This is the guard on the fifth vendor patch, and it is worth knowing
         * what it replaced: the engine's async classes are registered by
         * `JS_AddIntrinsicPromise` and nothing else, and this runtime does not
         * install it -- so the object the parser built for an `async` function
         * had no finalizer and no mark function, was never collected, and
         * `JS_FreeRuntime`'s `assert(list_empty(&rt->gc_obj_list))` aborted the
         * process **after** it had done its work and asked to quit with 0. A
         * Release build leaked it instead. A name that parses and then makes a
         * program unable to close is worse than either having the feature or
         * not having it.
         *
         * Every spelling, because `func_kind` reaches the parser two ways: a
         * method or an arrow arrives with it already set, a declaration or an
         * expression has it upgraded from the `async` keyword.
         */
        for (const [what, src] of [
            ["a declaration",    "async function f() {}"],
            ["an expression",    "const f = async function () {};"],
            ["an arrow",         "const f = async () => {};"],
            ["a class method",   "class C { async m() {} }"],
            ["an object method", "const o = { async m() {} };"],
            ["an async generator", "async function* g() {}"],
            ["one that awaits",  "async function f() { await 1; }"],
        ]) {
            const no = Application.CheckSource(src);

            check(`${what} with async is refused`,
                  no !== null && /async functions are not available/.test(no.Message),
                  JSON.stringify(no));
            check(`...and says where ${what} was`, no !== null && no.Column > 0,
                  JSON.stringify(no));
        }
    }

    /* `typeof x` is safe on an undeclared name, but only written literally --
     * so the loop above needs this rather than an index into a global object
     * that is itself no longer reachable. */
    globalNamed(name) {
        switch (name) {
        case "Promise":     return typeof Promise     === "undefined" ? undefined : Promise;
        case "Proxy":       return typeof Proxy       === "undefined" ? undefined : Proxy;
        case "Reflect":     return typeof Reflect     === "undefined" ? undefined : Reflect;
        case "WeakRef":     return typeof WeakRef     === "undefined" ? undefined : WeakRef;
        case "ArrayBuffer": return typeof ArrayBuffer === "undefined" ? undefined : ArrayBuffer;
        case "Uint8Array":  return typeof Uint8Array  === "undefined" ? undefined : Uint8Array;
        case "atob":        return typeof atob        === "undefined" ? undefined : atob;
        case "performance": return typeof performance === "undefined" ? undefined : performance;
        case "JSON":        return JSON;
        case "RegExp":      return RegExp;
        case "Regex":       return Regex;
        case "Dictionary":  return Dictionary;
        case "Map":         return Map;
        case "Set":         return Set;
        case "Date":        return Date;
        case "Math":        return Math;
        case "Symbol":      return typeof Symbol      === "undefined" ? undefined : Symbol;
        /* Installed and documented as such, which they were not for a long
         * time -- see testCuratedLanguage. */
        case "BigInt":      return typeof BigInt      === "undefined" ? undefined : BigInt;
        case "WeakMap":     return typeof WeakMap     === "undefined" ? undefined : WeakMap;
        case "WeakSet":     return typeof WeakSet     === "undefined" ? undefined : WeakSet;
        case "Iterator":    return typeof Iterator    === "undefined" ? undefined : Iterator;
        case "DisposableStack":
            return typeof DisposableStack === "undefined" ? undefined : DisposableStack;
        case "Logger":      return Logger;
        case "Namespace":   return Namespace;
        case "Widget":      return Widget;
        case "Settings":    return Settings;
        case "Timer":       return Timer;
        default:            return undefined;
        }
    }

    /* --- Dictionary ---------------------------------------------------------
     *
     * What a bag of data holds.  Two of these are the reason it is a module and
     * not a method: a bag with a key called `Keys`, and a `Record`, which holds
     * nothing at all because its fields are declared.
     */
    testDictionary() {
        const bag = { Text: "Guardar", Width: 90, Enabled: false };

        eq("Keys", Dictionary.Keys(bag).join(), "Text,Width,Enabled");
        check("Values", sameJson(Dictionary.Values(bag), ["Guardar", 90, false]),
              JSON.stringify(Dictionary.Values(bag)));
        eq("Count", Dictionary.Count(bag), 3);
        check("Has", Dictionary.Has(bag, "Width"));
        check("and not what is not there", !Dictionary.Has(bag, "Height"));

        /* `key in bag` would say true here, and would be answering about the
         * prototype rather than about the data. */
        check("Has does not look at the prototype", !Dictionary.Has(bag, "toString"));

        /* The pairs, with their halves named -- KeyValuePair, Map.Entry,
         * Association.  It does not destructure, which is the whole cost. */
        const entries = Dictionary.Entries(bag);
        eq("Entries has one per key", entries.length, 3);
        eq("Entries gives a Key", entries[0].Key, "Text");
        eq("...and a Value", entries[0].Value, "Guardar");

        /*
         * Absent is empty, all five ways.  `for...in` over nothing is already
         * zero turns while `Object.keys(null)` throws, and that asymmetry is
         * where every `Object.keys(node.properties || {})` in this repository
         * came from.
         */
        eq("Keys of nothing", Dictionary.Keys(null).length, 0);
        eq("Keys of undefined", Dictionary.Keys(undefined).length, 0);
        eq("Values of nothing", Dictionary.Values(null).length, 0);
        eq("Entries of nothing", Dictionary.Entries(null).length, 0);
        eq("Count of nothing", Dictionary.Count(null), 0);
        eq("Has of nothing", Dictionary.Has(null, "x"), false);

        /* An empty bag is not an absent one, and they answer the same anyway. */
        eq("Count of an empty bag", Dictionary.Count({}), 0);

        /*
         * The structural reason this is a module: a method called `Keys` would
         * be shadowed by the data.  Here the data is just data.
         */
        const trap = { Keys: 1, Count: 2, Has: 3 };
        eq("a bag may have a key called Keys", Dictionary.Keys(trap).join(),
           "Keys,Count,Has");
        eq("...and it can still be counted", Dictionary.Count(trap), 3);
        check("...and asked about", Dictionary.Has(trap, "Keys"));

        /* A primitive is refused, naming the verb and the value: `Object.keys`
         * quietly answers ["0","1","2","3"] for a text. */
        for (const value of ["hola", 42, true]) {
            let complaint = "";
            try {
                Dictionary.Keys(value);
            } catch (e) {
                complaint = e.message;
            }
            check(`${typeof value} is refused, by verb and value`,
                  complaint.includes("Dictionary.Keys") &&
                  complaint.includes(JSON.stringify(value)), complaint);
        }

        let complaint = "";
        try {
            Dictionary.Count("hola");
        } catch (e) {
            complaint = e.message;
        }
        check("and each verb complains as itself",
              complaint.includes("Dictionary.Count"), complaint);

        /* An object is an object: a global built in C, and a class, which is
         * what the IDE's completion asks about. */
        check("a global built in C", Dictionary.Keys(File).includes("LoadJson"),
              JSON.stringify(Dictionary.Keys(File).slice(0, 4)));
        eq("a class holds nothing, and does not fail", Dictionary.Count(Timer), 0);

        /*
         * Held is not declared.  A Record's fields live behind accessors on the
         * prototype, so it holds nothing and answers `PropertyNames()` -- the
         * same distinction a `.form` makes between `properties` and
         * `PropertyNames()`.
         */
        const customer = new Customer({ Name: "Ana" });
        eq("a record holds nothing", Dictionary.Count(customer), 0);
        check("because what it has is declared",
              customer.PropertyNames().includes("Name"));

        /*
         * A control is the same, and it holds nothing at all -- not even the
         * notes rad.js leaves on it.  `__declared` and `__design` go through
         * `hiddenBag`, which defines them non-enumerable the way C defines
         * `__children`; a plain assignment used to make them own enumerable
         * properties and this assertion is what caught it.
         */
        eq("a control holds nothing either", Dictionary.Count(this.B1), 0);
        check("its properties are not among what it holds",
              !Dictionary.Keys(this.B1).includes("Text"),
              JSON.stringify(Dictionary.Keys(this.B1)));
        check("...they are declared, and PropertyNames is the question",
              this.B1.PropertyNames().includes("Text"));

        /* Text keys keep the order they went in. */
        eq("insertion order", Dictionary.Keys({ z: 1, a: 2, m: 3 }).join(), "z,a,m");

        /*
         * And the one thing it cannot fix, asserted so that it is written down
         * rather than discovered: a key that looks like a whole number is not
         * kept where it was put.  This happens in the object model, before
         * anything here looks -- JSON.parse hands them over already moved.
         */
        const numeric = JSON.parse('{"10":1,"2":2,"Text":3}');
        eq("integer-like keys sort numerically and come first",
           Dictionary.Keys(numeric).join(), "2,10,Text");
        check("which is why Map is the answer when the keys are numbers",
              [...new Map([["10", 1], ["2", 2], ["Text", 3]]).keys()].join() ===
              "10,2,Text");
    }

    /* --- Regex --------------------------------------------------------------
     *
     * The pattern with nothing remembered between questions.  What is asserted
     * here is mostly the *absence* of `lastIndex`: every one of these asks the
     * same Regex twice, because asking twice is what a `/g` RegExp cannot
     * survive and is the whole reason this class exists.
     */
    testRegex() {
        const word = new Regex("\\w+");

        check("IsMatch does not alternate", word.IsMatch("hola") && word.IsMatch("hola"));
        eq("Match is the first one, twice over",
           `${word.Match("a b").Value}${word.Match("a b").Value}`, "aa");
        eq("Matches counts them all", word.Matches("a b c").length, 3);
        eq("and counts the same the second time", word.Matches("a b c").length, 3);

        /* A pattern that can match nothing would never advance. */
        eq("an empty match still moves along", new Regex("x*").Matches("abc").length, 4);

        /* --- one match, and what it caught --- */
        const kv = new Regex("(?<name>\\w+)=(\\w+)");
        const m  = kv.Match("  x=1  ");
        eq("Value", m.Value, "x=1");
        eq("Index", m.Index, 2);
        eq("Length", m.Length, 3);
        eq("Groups[0] is the whole match, as .NET numbers them", m.Groups[0], "x=1");
        eq("so Groups[1] is the first parenthesis", m.Groups[1], "x");
        eq("Group by name", m.Group("name"), "x");
        eq("Group by number", m.Group(2), "1");
        eq("a group nobody declared is empty", m.Group("nope"), "");
        eq("and so is a number past the end", m.Group(9), "");
        eq("no match at all is null", kv.Match("nothing"), null);

        /* A group that did not take part reads as "there is none", which is the
         * answer Locale.Current and File.Extension give too. */
        eq("a group that did not take part is empty",
           new Regex("a(b)?c").Match("ac").Group(1), "");

        eq("Match can be told where to start",
           new Regex("a").Match("aXa", 1).Index, 2);

        /* --- Replace --- */
        const pair = new Regex("(?<key>\\w+)=(\\d+)");
        eq("replaces every match with no flag to say so",
           pair.Replace("a=1 b=2", "X"), "X X");
        eq("...and a count says when one is meant",
           pair.Replace("a=1 b=2", "X", 1), "X b=2");
        eq("${name} is .NET's spelling, not $<name>",
           pair.Replace("a=1", "${key}"), "a");
        eq("$1 by number", pair.Replace("a=1", "$1"), "a");
        eq("$& is the whole match", pair.Replace("a=1", "[$&]"), "[a=1]");
        eq("$$ is a dollar", pair.Replace("a=1", "$$"), "$");
        eq("$12 where there are two groups is $1 and a 2",
           pair.Replace("a=1", "$12"), "a2");
        eq("a $ that names nothing is a $", pair.Replace("a=1", "$z"), "$z");
        eq("nothing to replace is the text back", pair.Replace("nada", "X"), "nada");

        /* The function is handed the Match, not JavaScript's list of arguments
         * -- whose shape depends on how many groups the pattern happens to
         * have, which is what makes it awkward to write against. */
        eq("a function is handed the Match",
           pair.Replace("a=1 b=2", (found) => found.Group("key").toUpperCase()),
           "A B");

        /* --- Split --- */
        eq("Split", new Regex(",").Split("a,b,c").join("|"), "a|b|c");
        eq("and it keeps what it split on, when that was captured",
           new Regex("(,)").Split("a,b").join("|"), "a|,|b");

        /* --- options are words --- */
        check("IgnoreCase", new Regex("abc", { IgnoreCase: true }).IsMatch("ABC"));
        check("and is not the default", !new Regex("abc").IsMatch("ABC"));
        check("Multiline", new Regex("^b", { Multiline: true }).IsMatch("a\nb"));
        check("Singleline", new Regex("a.b", { Singleline: true }).IsMatch("a\nb"));
        check("a dot is not a newline by default", !new Regex("a.b").IsMatch("a\nb"));

        /* Free spacing: the reason the IDE's long patterns had to be read as
         * one unbroken string. */
        const free = new Regex(`
            (\\w+)          # the name
            \\s* = \\s*
            (\\d+)          # the number
        `, { IgnorePatternWhitespace: true });
        eq("IgnorePatternWhitespace lays a pattern out",
           free.Match("x  =  12").Value, "x  =  12");
        check("inside a class a space is still a space",
              new Regex("a[ ]b", { IgnorePatternWhitespace: true }).IsMatch("a b"));
        check("and an escaped one survives",
              new Regex("a\\ b", { IgnorePatternWhitespace: true }).IsMatch("a b"));

        eq("Pattern is what was written, not what was compiled",
           new Regex("a b", { IgnorePatternWhitespace: true }).Pattern, "a b");

        /* Refused, with the offending value, as every setter here does. */
        let complaint = "";
        try {
            new Regex("a", { Global: true });
        } catch (e) {
            complaint = e.message;
        }
        check("an option nobody has is refused, by name",
              complaint.includes("Global"), complaint);

        complaint = "";
        try {
            new Regex("(");
        } catch (e) {
            complaint = e.message;
        }
        check("and a pattern that does not compile names itself",
              complaint.includes('"("'), complaint);

        /* --- Escape, which is the one that was missing --- */
        check("Escape makes a dot a dot", new Regex(Regex.Escape("a.b")).IsMatch("a.b"));
        check("...and only a dot", !new Regex(Regex.Escape("a.b")).IsMatch("axb"));
        check("a name that would not compile does",
              new Regex(Regex.Escape("Btn(")).IsMatch("x Btn( y"));
        check("an escaped space survives free spacing",
              new Regex(Regex.Escape("a b"), { IgnorePatternWhitespace: true })
                  .IsMatch("a b"));
        check("and so does a #, which is a comment there",
              new Regex(Regex.Escape("a#b"), { IgnorePatternWhitespace: true })
                  .IsMatch("a#b"));

        /* What the IDE builds out of a name it did not choose: a form file
         * called `My.Form.form` has a dot in the class name it derives. */
        const derived = "My.Form";
        check("a derived name matches itself",
              new Regex(`class\\s+${Regex.Escape(derived)}\\b`)
                  .IsMatch("class My.Form extends Component {"));
        check("and not the thing the dot would have matched",
              !new Regex(`class\\s+${Regex.Escape(derived)}\\b`)
                  .IsMatch("class MyXForm extends Component {"));
    }

    /* --- terminal -----------------------------------------------------------
     *
     * What Text answers is what the program printed, not what fits on screen:
     * a console pane a couple of rows tall is the normal case, and one that
     * reported only the visible rows could not be tested against at all.
     *
     * **VTE is optional at build time**, so the first thing asked is whether
     * there is a pty here at all -- the way `testMedia` asks about GStreamer.
     * What survives the answer being no is checked either way: the class is
     * there, it draws, its state answers, and the three verbs that need a
     * child refuse by name.
     */
    testTerminal() {
        const term = new Terminal();
        this.Fixed1.Add(term);
        term.Name = "Term1";
        term.Resize(200, 40);        /* two or three rows, like a console pane */

        /* Asked of the class and of the control, which must agree: a palette
         * asks the first (it has a name and no widget) and a program with one
         * in front of it asks the second. */
        eq("a Terminal says whether this build can run one",
           term.Available, Widget.Available("Terminal"));
        check("...and it is a boolean either way",
              typeof term.Available === "boolean", `${term.Available}`);

        /*
         * Without VTE the *state* still answers and the *verbs* refuse, which
         * is not a nicety: the designer reads every value of a selected
         * control and the serialiser reads them all again to save, so a getter
         * that threw would make a runtime with no VTE one that could not draw
         * a form with a Terminal in it -- or load one, since a declared
         * LinkPattern is assigned like any other property.
         */
        if (!term.Available) {
            term.Feed("sin pty\n");
            eq("a Terminal with no pty still shows what it is fed",
               term.Text, "sin pty");
            check("...and still says nothing is running", !term.Running);

            term.LinkPattern = "[\\w./-]+\\.js:\\d+";
            eq("...and still keeps a pattern a .form declared",
               term.LinkPattern, "[\\w./-]+\\.js:\\d+");
            eq("...and its scrollback", (term.ScrollbackLines = 500, term.ScrollbackLines), 500);

            const refused = [];
            for (const verb of [() => term.Run(["true"]), () => term.Stop(),
                                () => term.Kill()]) {
                try { verb(); refused.push("did not refuse"); }
                catch (e) { refused.push(/VTE/.test(e.message) ? "named" : e.message); }
            }
            eq("the three verbs that need a child refuse, naming the package",
               JSON.stringify(refused), '["named","named","named"]');

            term.Clear();
            eq("and Clear empties it", term.Text, "");

            term.Delete();
            this.term = null;
            return;
        }

        for (let i = 1; i <= 40; i++) term.Feed(`line ${i}\r\n`);
        check("nothing is running in it", !term.Running);

        /* The same two verbs an Exec handle takes, meaning the same two things:
         * `Stop` asks (SIGTERM), `Kill` makes (SIGKILL). With nothing running
         * there is nothing to signal, and both say so rather than throwing --
         * a Stop button pressed twice is an ordinary thing to do. */
        check("a terminal with no child has nothing to stop", term.Stop() === false);
        check("and nothing to kill either", term.Kill() === false);

        /*
         * A pattern makes matching text in the output clickable, and the click
         * arrives as Term1_Link(text).  Whether the pointer really finds it is a
         * pointer question and is checked by hand; what is checked here is the
         * spec -- the pattern round-trips, a broken one is refused, and the event
         * dispatches by name like any other.
         */
        eq("no pattern to begin with", term.LinkPattern, "");
        term.LinkPattern = "[\\w./-]+\\.js:\\d+";
        eq("LinkPattern round-trip", term.LinkPattern, "[\\w./-]+\\.js:\\d+");
        throws("a broken pattern is refused", () => { term.LinkPattern = "(unclosed"; });
        eq("and the refused one did not stick", term.LinkPattern, "[\\w./-]+\\.js:\\d+");

        this.linked = null;
        term.Emit("Link", "Form1.js:42");
        eq("Link dispatches by name", this.linked, "Form1.js:42");

        term.LinkPattern = "";
        eq("and it can be taken off again", term.LinkPattern, "");

        /* What was fed is digested by GTK, not by the caller: reading it back in
         * the same turn reads a terminal that has not seen it yet. */
        this.term = term;
    }

    Term1_Link(text) { this.linked = text; }

    checkTerminal() {
        if (!this.term) return;        /* no VTE: testTerminal said so and finished */

        const text = this.term.Text;

        check("the last line is there", text.includes("line 40"),
              JSON.stringify(text.slice(-40)));
        check("and so is the first, long scrolled away",
              text.includes("line 1\n"), JSON.stringify(text.slice(0, 40)));
        eq("every line exactly once",
           text.split("\n").filter((l) => l === "line 7").length, 1);

        this.term.Delete();
    }

    /* --- errors nobody caught -----------------------------------------------
     *
     * A handler that throws used to leave the application running with nothing
     * said and nothing done: the button simply stopped working.  Now it is
     * reported -- to the terminal always, and to whoever is looking: an
     * application that sets Application.OnError takes it over, and one that does
     * not gets a dialog with the stack, which is the part that says where to
     * look.
     */
    testErrors() {
        const seen = [];
        Application.OnError = (message, stack) => seen.push({ message, stack });

        const boom = new Button();
        boom.Name = "Boom";
        this.Fixed1.Add(boom);

        boom.Click();      /* Boom_Click throws, and nobody catches it */

        eq("an uncaught error reaches the application", seen.length, 1);
        check("with what went wrong", seen[0].message.includes("thrown on purpose"),
              seen[0].message);
        check("and the stack that says where",
              seen[0].stack.includes("Boom_Click"), seen[0].stack);
        check("naming the file and the line",
              /WidgetsForm\.js:\d+/.test(seen[0].stack), seen[0].stack);

        /* The application's own handler replaces the dialog, it does not add to
         * it: an application that logs errors its own way says so once. */
        boom.Click();
        eq("every one of them arrives", seen.length, 2);

        boom.Delete();
        Application.OnError = null;    /* back to the dialog for anything else */
    }

    Boom_Click() { throw new Error("thrown on purpose"); }

    /* --- Settings ------------------------------------------------------------
     *
     * Application.ConfigDirectory is a directory; this is the file every application was
     * going to write in it.  Values are whatever JSON carries, and a default
     * comes back when there is nothing, so a caller never has to tell "missing"
     * from "false".
     */
    testSettings() {
        Settings.Clear();
        eq("a fresh set has no keys", Settings.Keys().length, 0);
        eq("and a missing one answers the default", Settings.Get("nope", 7), 7);
        eq("with undefined when none was given", Settings.Get("nope"), undefined);

        Settings.Set("recent", ["/a", "/b"]);
        Settings.Set("size", { w: 800, h: 600 });
        Settings.Set("on", false);

        check("what goes in comes out", sameJson(Settings.Get("recent"), ["/a", "/b"]));
        eq("objects too", Settings.Get("size").w, 800);
        eq("and false is a value, not a missing one", Settings.Get("on", true), false);
        check("Has says so", Settings.Has("on") && !Settings.Has("nope"));
        eq("Keys lists them", Settings.Keys().sort().join(","), "on,recent,size");

        /* On disk, and readable: a settings file nobody can read by hand is a
         * settings file nobody can fix by hand. */
        const onDisk = JSON.parse(File.Load(Settings.Path));
        eq("written where it says", File.Name(Settings.Path), "settings.json");
        eq("with what was set", onDisk.size.h, 600);
        check("under the application's own config",
              Settings.Path.startsWith(Application.ConfigDirectory), Settings.Path);

        Settings.Delete("on");
        check("Delete removes it", !Settings.Has("on"));
        eq("and the file follows",
           "on" in JSON.parse(File.Load(Settings.Path)), false);

        Settings.Clear();
        eq("Clear empties it", Settings.Keys().length, 0);
    }

    /* --- Timer ---------------------------------------------------------------
     * The state machine here; that it fires needs frames, so tests/ide checks
     * that part where it can wait for one. */
    testTimer() {
        const t = new Timer(50);

        eq("a timer starts stopped", t.Enabled, false);
        eq("with the delay it was given", t.Delay, 50);

        t.Start();
        eq("Start runs it", t.Enabled, true);
        t.Stop();
        eq("Stop stops it", t.Enabled, false);

        t.Enabled = true;
        eq("and Enabled is the same switch", t.Enabled, true);
        t.Enabled = false;
        eq("both ways", t.Enabled, false);

        t.Start(10);
        eq("Start takes a delay of its own", t.Delay, 10);
        t.Stop();

        /* Once is running until it fires, and then it is not. */
        t.Once(10);
        eq("Once counts as running", t.Enabled, true);
        t.Stop();
    }

    /* --- icons -------------------------------------------------------------
     * The desktop's theme and, on top of it, the icons the project ships in
     * icons/.  Asking before assigning is what allows a fallback to be chosen: an
     * icon that is not there is dropped, and on a button with no text that leaves
     * nothing to look at. */
    /* --- Application.Icons ---------------------------------------------------
     *
     * HasIcon answers about a name one already has in mind; this is the other
     * question -- what is there at all -- which is what anything that lets a
     * person *choose* an icon needs.
     */
    /* --- the window's icon ---------------------------------------------------
     *
     * What the desktop shows for a window in a task list or a switcher.  Stored
     * as it was given and only *applied* when the desktop really has it, the
     * same bargain Button.Icon makes -- a .form has to round-trip what it
     * declared even on a machine whose theme is missing it.
     */
    testFormIcon() {
        class Bare extends Form {}
        const f = new Bare();

        eq("a form starts with no icon", f.Icon, "");
        check("so it stays out of the .form",
              !("Icon" in f.Serialize().properties),
              JSON.stringify(f.Serialize().properties));

        f.Icon = "folder";
        eq("setting one reads back", f.Icon, "folder");
        eq("and is saved", f.Serialize().properties.Icon, "folder");

        /* The one thing that separates this from a Button's: a window icon the
         * theme lacks is simply not shown, and the name is still what the form
         * declared. Losing it on a machine without that icon would rewrite the
         * file the next time it was saved. */
        f.Icon = "no-such-icon-anywhere";
        eq("a name the desktop lacks is kept, not dropped",
           f.Icon, "no-such-icon-anywhere");
        eq("and still saved", f.Serialize().properties.Icon, "no-such-icon-anywhere");

        f.Icon = "";
        eq("and it can be cleared", f.Icon, "");
        f.Close();
    }

    /* --- Dialog.Color --------------------------------------------------------
     *
     * The one chooser that cannot be a Bintana form: a colour wheel is not
     * something the widget set can be talked into being, so it is a primitive
     * like the file dialogs -- and asynchronous for the same reason, since GTK4
     * has no modal answer to give.
     *
     * What it *answers* with is testable without a person clicking: the string
     * it produces has to be one the properties it feeds will take.
     */
    /* --- ColorButton ---------------------------------------------------------
     *
     * GtkColorDialogButton is the swatch; what it has no idea of is *no
     * colour*, and here that is a real value -- `Background = ""` means
     * "whatever the theme says", the state most controls are in and the one a
     * person needs a way back to.  So: the button, and a clear beside it.
     */
    /* --- Font, and the button that picks one ---------------------------------
     *
     * The colours' bargain in Pango's spelling: parsed and written back out, so
     * what is stored is Pango's own version and never the string as typed -- a
     * .form cannot smuggle anything into the stylesheet through here.
     */
    testFont() {
        const l = new Label();
        this.Add(l);

        eq("a control starts with the theme's font", l.Font, "");
        check("so it stays out of the .form",
              !("Font" in l.Serialize().properties),
              JSON.stringify(l.Serialize().properties));

        l.Font = "Cantarell Bold 12";
        eq("a description reads back", l.Font, "Cantarell Bold 12");
        eq("and is saved",             l.Serialize().properties.Font, "Cantarell Bold 12");

        /* An unknown family is kept, exactly as an unknown icon name is: only
         * whoever chose it can choose a fallback. */
        l.Font = "No Such Family 10";
        eq("an unknown family is kept, not refused", l.Font, "No Such Family 10");

        l.Font = "";
        eq("and it can be cleared", l.Font, "");
        l.Font = "   ";
        eq("blank means none, not an error", l.Font, "");

        /* And nothing else is refused: Pango takes almost anything -- "," comes
         * back as "Normal" -- so judging it here would be inventing a rule. */
        l.Font = ",";
        eq("anything else is Pango's to interpret", l.Font, "Normal");
        l.Font = "";

        const f = new FontButton();
        f.Name = "FntB";
        this.Add(f);

        eq("a font button starts with none", f.Value, "");
        f.Value = "Cantarell Bold 12";
        eq("setting one reads back", f.Value, "Cantarell Bold 12");

        /* What it holds is what Font takes, so it edits one with nothing in
         * between -- the same as the colour button and its properties. */
        l.Font = f.Value;
        eq("what it holds is what Font takes", l.Font, "Cantarell Bold 12");

        f.Value = "";
        eq("and it clears back to the theme's", f.Value, "");
        check("assigning it reports a change", this.fontSaid > 0, `${this.fontSaid}`);

        l.Delete();
        f.Delete();
    }

    FntB_Change() { this.fontSaid = (this.fontSaid || 0) + 1; }

    /* --- Style, and the application's own stylesheet -------------------------
     *
     * The property is a list of class names, so the round-trip is all a
     * synchronous test can see.  Whether the stylesheet beside project.json was
     * loaded at all is a different question, and only the ink answers it:
     * testStyleSheet measures a label wearing .t-big against a bare one.
     */
    testStyle() {
        const l = new Label();
        this.Add(l);

        eq("a control wears no class of the application's", l.Style, "");
        check("so it stays out of the .form",
              !("Style" in l.Serialize().properties),
              JSON.stringify(l.Serialize().properties));

        l.Style = "t-big";
        eq("a class reads back", l.Style, "t-big");
        eq("and is saved",       l.Serialize().properties.Style, "t-big");

        /* More than one is the point of a list, and how they were separated is
         * not something to remember: what comes back is the normalised form. */
        l.Style = "  t-big,t-red   card ";
        eq("several are normalised to one spelling", l.Style, "t-big t-red card");

        /* A name GTK will never match is a typo now, not a fallback later --
         * unlike a font family or an icon name, nothing downstream resolves it. */
        throws("a name CSS could not be is refused", () => { l.Style = "t big;"; });
        eq("and the control is left as it was", l.Style, "t-big t-red card");

        l.Style = "";
        eq("and it can be cleared", l.Style, "");

        /* Cleared means the classes came off, not just that the property is
         * empty: setting one again and clearing it has to be repeatable. */
        l.Style = "t-red";
        l.Style = "t-big";
        eq("assigning replaces rather than accumulates", l.Style, "t-big");

        l.Delete();
    }

    /* --- Radius --------------------------------------------------------------
     *
     * Rounded corners, through the same per-widget stylesheet the colours use --
     * no theme has a class for "rounded by this much".  What asked for it is the
     * designer's preview of a form's title bar: a window is rounded on top and
     * square underneath, which one number cannot say.
     */
    testRadius() {
        const p = new Panel();
        this.Add(p);

        eq("a control has square corners", p.Radius, "");
        check("so it stays out of the .form",
              !("Radius" in p.Serialize().properties),
              JSON.stringify(p.Serialize().properties));

        p.Radius = 8;
        eq("a number reads back as one size", p.Radius, "8");
        eq("and is saved", p.Serialize().properties.Radius, "8");

        p.Radius = "8 8 0 0";
        eq("four sizes are kept in CSS's order", p.Radius, "8 8 0 0");

        /* px is how CSS spells it and how anyone would write it; there is no
         * other unit here, so it is accepted and dropped. */
        p.Radius = "6px 6px";
        eq("a unit is accepted and normalised away", p.Radius, "6 6");

        throws("a fifth size is refused",      () => { p.Radius = "1 2 3 4 5"; });
        throws("and so is something not a size", () => { p.Radius = "round"; });
        throws("and a negative one",             () => { p.Radius = "-4"; });
        eq("with the control left as it was", p.Radius, "6 6");

        /* Square all round is the same as none, and writes nothing. */
        p.Radius = "0 0 0 0";
        eq("all zeroes is square again", p.Radius, "");
        p.Radius = "8";
        p.Radius = "";
        eq("and so is nothing at all", p.Radius, "");

        p.Delete();
    }

    /* --- Padding -------------------------------------------------------------
     *
     * The half of spacing `Margin` does not cover: margin pushes the neighbours
     * away, padding pushes the contents in.  GTK has no widget-level padding at
     * all -- it is CSS and nothing else -- which is what makes it the answer to a
     * theme one cannot select into: GTK's own window buttons are `padding: 0`
     * inside a `windowcontrols` node no application can build, and the IDE's
     * title bar came out 43px tall against the desktop's 37 until it could say
     * the same thing.
     */
    testPadding() {
        const b = new Button();
        this.Add(b);

        eq("a control says nothing about padding", b.Padding, "");
        check("so it stays out of the .form",
              !("Padding" in b.Serialize().properties),
              JSON.stringify(b.Serialize().properties));

        b.Padding = "4 9";
        eq("sizes read back in CSS's order", b.Padding, "4 9");
        eq("and are saved", b.Serialize().properties.Padding, "4 9");

        /*
         * Zero is not nothing here, and that is the whole point of the property:
         * `0` is a control asking for no padding *against* a theme that gives it
         * some, while `""` is taking whatever the theme says.  `Radius` collapses
         * its zero because there is only one way for a corner to be square.
         */
        b.Padding = 0;
        eq("zero is a value of its own", b.Padding, "0");
        check("and is written to the .form",
              b.Serialize().properties.Padding === "0",
              JSON.stringify(b.Serialize().properties));

        b.Padding = "";
        eq("while nothing hands it back to the theme", b.Padding, "");

        throws("a fifth size is refused", () => { b.Padding = "1 2 3 4 5"; });
        throws("and so is a word",        () => { b.Padding = "tight"; });
        eq("with the control left as it was", b.Padding, "");

        b.Delete();
    }

    /* --- Shadow --------------------------------------------------------------
     *
     * What a control casts on whatever is behind it: CSS's shorthand, minus what
     * nobody needs here.  One shadow, never `inset`, and the colour through the
     * same GdkRGBA the background colours use, so nothing reaches the stylesheet
     * as text.  The case that asked for it is a window that is not one -- the
     * designer's board, which is a form drawn on a desk and has to sit above it.
     */
    testShadow() {
        const p = new Panel();
        this.Add(p);

        eq("a control casts none", p.Shadow, "");
        check("so it stays out of the .form",
              !("Shadow" in p.Serialize().properties),
              JSON.stringify(p.Serialize().properties));

        p.Shadow = "0 3 9 1 rgba(0,0,0,0.5)";
        eq("what GTK gives a window reads back", p.Shadow, "0 3 9 1 rgba(0,0,0,0.5)");
        eq("and is saved", p.Serialize().properties.Shadow, "0 3 9 1 rgba(0,0,0,0.5)");

        /* The tail is optional: a shadow with no spread has none, and one with
         * no colour is the translucent black a shadow is. */
        p.Shadow = "0 2 6";
        eq("a short one is filled in", p.Shadow, "0 2 6 0 rgba(0,0,0,0.5)");

        /* The colour is parsed and written back out in GdkRGBA's spelling, never
         * as it was typed -- the same care Background takes. */
        p.Shadow = "-4 -4 8 0 #000";
        eq("offsets may be negative and the colour is re-spelled",
           p.Shadow, "-4 -4 8 0 rgb(0,0,0)");

        throws("a blur cannot be",        () => { p.Shadow = "0 0 -3"; });
        throws("a word is not a shadow",  () => { p.Shadow = "soft"; });
        throws("nor is a colour alone",   () => { p.Shadow = "black"; });
        throws("nor half a position",     () => { p.Shadow = "4"; });
        eq("with the control left as it was", p.Shadow, "-4 -4 8 0 rgb(0,0,0)");

        p.Shadow = "";
        eq("and it can be cleared", p.Shadow, "");

        p.Delete();
    }

    /* <project>/app.css is found by name, like <project>/icons: nothing in
     * project.json points at it.  A class that changes the font size is what
     * makes it visible from inside the application -- and the same measurement
     * shows the layering, since Font on the control has to win over it. */
    testStyleSheet(done) {
        const host = new Panel();
        host.Move(0, 0);
        host.Resize(300, 200);
        this.Add(host);

        const at = (y, dress) => {
            const l = new Label();
            l.Text = "Hgx";
            l.Move(0, y);
            host.Add(l);
            dress(l);
            return l;
        };

        const plain   = at(0,   () => {});
        const styled  = at(40,  (l) => { l.Style = "t-big"; });
        const both    = at(120, (l) => { l.Style = "t-big"; l.Font = "Cantarell 8"; });

        until("the labels are laid out", () => plain.Bounds().Height > 0, () => {
            const h = (l) => l.Bounds().Height;

            check("a class from app.css reaches the control",
                  h(styled) > h(plain), `t-big=${h(styled)} plain=${h(plain)}`);
            check("and Font on the control still overrides it",
                  h(both) < h(styled), `both=${h(both)} t-big=${h(styled)}`);

            host.Delete();
            done();
        });
    }

    testColorButton() {
        const c = new ColorButton();
        this.Add(c);

        eq("a colour button starts with none", c.Value, "");
        check("so it stays out of the .form",
              !("Value" in c.Serialize().properties),
              JSON.stringify(c.Serialize().properties));

        this.colorSaid = 0;
        c.Name = "ColB";

        c.Value = "rgb(32,64,96)";
        eq("setting one reads back",  c.Value, "rgb(32,64,96)");
        eq("and is saved",            c.Serialize().properties.Value, "rgb(32,64,96)");
        eq("with alpha too", (c.Value = "rgba(1,2,3,0.25)", c.Value), "rgba(1,2,3,0.25)");

        /* The value it holds is the string the colour properties take, so it
         * edits them with nothing in between. */
        const p = new Panel();
        p.Background = c.Value;
        eq("what it holds is what a colour property takes", p.Background, "rgba(1,2,3,0.25)");

        c.Value = "";
        eq("and it can be cleared back to none", c.Value, "");
        c.Value = "not-a-colour";
        eq("something unreadable is none, not a crash", c.Value, "");

        /* Assigning goes out to GTK and comes back as a real Change -- the same
         * round trip a TextBox's Text makes, which is what the tests here are
         * for in the first place. */
        check("assigning it reports a change", this.colorSaid > 0, `${this.colorSaid}`);

        c.Delete();
    }

    ColB_Change() { this.colorSaid = (this.colorSaid || 0) + 1; }

    testColorDialog() {
        throws("Dialog.Color needs a callback, being async",
               () => Dialog.Color("t", "#204060"));

        /* Opening it must survive a starting colour that does not parse: that
         * is a form with no colour set yet, which is the common case. */
        Dialog.Color("t", "not-a-colour", () => {});
        Dialog.Color("t", "", () => {});
        check("and opens whatever it is started from", true);

        /* The round trip that matters: gdk_rgba_to_string's spelling is what
         * Background and Foreground accept and echo back unchanged. */
        const p = new Panel();
        p.Background = "rgb(32,64,96)";
        eq("an opaque colour round-trips", p.Background, "rgb(32,64,96)");
        p.Foreground = "rgba(32,64,96,0.5)";
        eq("and one with alpha too", p.Foreground, "rgba(32,64,96,0.5)");
        p.Background = "";
        eq("and it can be cleared back to the theme's", p.Background, "");
    }

    /*
     * The file dialogs, and what can honestly be asserted about them: every
     * refusal, and nothing about what the chooser shows.  Whether a filter
     * really reaches the drop-down is a separate surface nobody can measure
     * from here -- it is on the by-hand list in AGENTS.md, next to whether a
     * popover appeared.
     *
     * What *is* worth a test is that a refused option throws **before** the
     * dialog is shown: a shape the runtime does not accept has to fail while
     * there is still a caller to fail at, not leave a chooser open on a
     * half-applied set of options.
     */
    testFileDialog() {
        check("SaveFile is there", typeof Dialog.SaveFile === "function");

        for (const name of ["SelectFolder", "OpenFile", "SaveFile"]) {
            throws(`${name} needs a callback, being async`,
                   () => Dialog[name]("t"));
            /* Options and no callback is the same mistake wearing the shape
             * this call just learned. */
            throws(`${name} with options still needs one`,
                   () => Dialog[name]("t", { Name: "x.txt" }));

            throws(`${name}: options are an object`,
                   () => Dialog[name]("t", "Documents", () => {}));
            throws(`${name}: Filters is a list`,
                   () => Dialog[name]("t", { Filters: "*.png" }, () => {}));
            throws(`${name}: a filter is a [label, patterns] pair`,
                   () => Dialog[name]("t", { Filters: ["*.png"] }, () => {}));
            throws(`${name}: both halves of the pair are strings`,
                   () => Dialog[name]("t", { Filters: [["Images", 7]] }, () => {}));
            /* A filter matching nothing hides every file, which reads as an
             * empty directory rather than as a mistake. */
            throws(`${name}: a filter with no pattern is refused`,
                   () => Dialog[name]("t", { Filters: [["Images", "  "]] }, () => {}));
        }

        /*
         * **And nothing here opens one.** An accepted set of options ends in a
         * chooser being shown, it is modal, and nothing in JS can close it -- so
         * it sits on top of the form the next test measures. One was enough to
         * turn `testExec`'s pushed-surface assertions red while this test passed
         * on its own; `Dialog.Color`'s two get away with it and a file chooser
         * does not. So the accepted shapes -- `Folder`, `Name`, a suffix
         * pattern reaching the drop-down -- are on the by-hand list in
         * AGENTS.md, next to whether a popover appeared, and every refusal is
         * here, where a refusal shows nothing by construction.
         */
    }

    /*
     * What Enter and Escape do: `Button.Default` / `Button.Cancel`.
     *
     * **A key event is not something this suite can make**, so real Enter and
     * real Escape are on the by-hand list. What is here is everything that can
     * be measured, and the one that matters most is that `form_show` reached
     * GTK -- `Form.DefaultButton` asks the window rather than the flag, so it
     * answers about `gtk_window_set_default_widget` and not about our own
     * bookkeeping.
     */
    testDefaultButton() {
        const win = new Form();
        win.Text = "buttons";
        win.Resize(240, 120);

        const ok     = new Button();
        const cancel = new Button();
        win.Add(ok);
        win.Add(cancel);
        ok.Name     = "BtnOk";
        cancel.Name = "BtnCancel";

        eq("a button is no form's default to begin with", ok.Default, false);
        eq("nor its cancel",                              ok.Cancel,  false);
        check("and the form has neither", win.DefaultButton === null &&
                                          win.CancelButton === null);
        /* Neither is written to the .form until it is asked for, which is the
         * serialiser's own rule: equal to a fresh control's value, so omitted. */
        check("so neither is in the .form",
              !("Default" in ok.Serialize().properties) &&
              !("Cancel"  in ok.Serialize().properties),
              JSON.stringify(ok.Serialize().properties));

        ok.Default    = true;
        cancel.Cancel = true;
        eq("declaring it reads back",       ok.Default, true);
        eq("and is saved",                  ok.Serialize().properties.Default, true);
        eq("Cancel likewise",               cancel.Serialize().properties.Cancel, true);

        /*
         * Before Show the declaration is widget state and nothing else -- which
         * is what keeps the designer's canvas out of the window's business. The
         * cancel button is a walk, so it answers at once; the default is GTK's
         * and does not exist yet.
         */
        check("Cancel answers before the form is shown", win.CancelButton === cancel);
        check("the window's default waits for Show",     win.DefaultButton === null);

        win.Show();
        check("showing the form hands the default to GTK",
              win.DefaultButton === ok,
              `${win.DefaultButton && win.DefaultButton.Name}`);
        check("and the cancel button is still the same one",
              win.CancelButton === cancel);

        /*
         * Declaring another one while the form is open does not move it, and
         * that is deliberate rather than unfinished: the assignment would have
         * to win over the earlier declaration, winning means clearing the flag
         * on its siblings, and a button's siblings are its *form's* -- which on
         * a designer canvas are the IDE's own controls. The window learns at
         * Show, where a drawing never goes.
         */
        cancel.Default = true;
        check("a later declaration does not move an open form's default",
              win.DefaultButton === ok,
              `${win.DefaultButton && win.DefaultButton.Name}`);

        /*
         * Tree order decides, and the loser is cleared -- so what the grid shows
         * and what the serialiser writes are the button that really answers
         * Enter. Both flagged and never shown: the first one wins.
         */
        const two = new Form();
        const a   = new Button();
        const b   = new Button();
        two.Add(a);
        two.Add(b);
        a.Name = "A";
        b.Name = "B";
        cancel.Default = false;      /* undo the stray declaration above */

        a.Default = b.Default = true;
        a.Cancel  = b.Cancel  = true;
        two.Show();
        check("of two defaults the first in tree order wins",
              two.DefaultButton === a, `${two.DefaultButton && two.DefaultButton.Name}`);
        eq("and the second is cleared", b.Default, false);
        check("the same for cancel", two.CancelButton === a);
        eq("and cleared there too",   b.Cancel, false);

        /*
         * Deleting the one that answered leaves the form with none.
         *
         * `CancelButton` is a walk, so it simply stops finding it. `DefaultButton`
         * is GTK's, and GTK4 keeps an *unowned* pointer to it -- so this asserts
         * that removal cleared it. Without that, the class GTK takes off the old
         * default lands on freed memory and three GTK-CRITICALs come out at the
         * next thing that touches the window, looking like a bug in whatever
         * that was. Which is exactly how it was found.
         */
        a.Delete();
        check("deleting the cancel button leaves none", two.CancelButton === null);
        check("and the window is left with no default either",
              two.DefaultButton === null,
              `${two.DefaultButton && two.DefaultButton.Name}`);

        /* And the same when the container it sits in goes, not the button: the
         * pointer is just as dangling either way. */
        const holder = new Panel();
        const inner  = new Button();
        two.Add(holder);
        holder.Add(inner);
        inner.Name = "Inner";
        inner.Default = true;
        two.Show();
        check("a button inside a panel can be the default", two.DefaultButton === inner);
        holder.Delete();
        check("and detaching the panel clears it", two.DefaultButton === null);

        two.Close();
        win.Close();
    }

    /*
     * Tab order: `Widget.TabIndex`, carried out by the surface's own `focus`.
     *
     * Pressing Tab is not something this suite can do, and the order is not
     * checked by pressing it: `FocusNext` asks the container to move the focus
     * one place, which is the same `gtk_widget_child_focus` GTK itself calls --
     * so what runs is the real `bta_fixed_focus` and the real GTK walk, and
     * `Focused` says where it landed. The only thing left for a person is that
     * the *key* arrives, which matters because an editor and a `Terminal`
     * are supposed to keep Tab for themselves.
     *
     * **On `Fixed1` and not on a window of its own.** A form shown here is a
     * window that takes the focus, and the pushed-surface assertions in the
     * async tail measure on the frame they settle: a window of mine open while
     * they ran turned two of them red about one run in three. This form is
     * already shown and already mapped, so the walk needs no waiting either.
     * `Fixed1` holds one `Label`, which cannot take the focus, so what is walked
     * is exactly the three controls below.
     */
    testTabOrder() {
        /*
         * A surface of its own, holding nothing but these three. `Fixed1` had
         * five children by the time this ran -- a scroller left in it by another
         * test, focusable -- so "past the last one the focus leaves" walked into
         * it and the assertion read like a broken sort. A test that walks an
         * order has to own every stop in it.
         */
        const surf = new Panel();
        this.Fixed1.Add(surf);
        surf.Move(4, 4);
        surf.Resize(180, 140);

        const box   = [new TextBox(), new TextBox(), new TextBox()];
        const names = ["TabA", "TabB", "TabC"];
        box.forEach((t, i) => {
            surf.Add(t);
            t.Name = names[i];
            t.Move(6, 6 + i * 40);
            t.Resize(160, 30);
        });
        const [a, b, c] = box;

        eq("nothing declares a place to begin with", a.TabIndex, 0);
        check("so it stays out of the .form",
              !("TabIndex" in a.Serialize().properties),
              JSON.stringify(a.Serialize().properties));
        throws("a place in an order is not negative", () => { a.TabIndex = -1; });
        a.TabIndex = 3;
        eq("declaring one reads back", a.TabIndex, 3);
        eq("and is saved",             a.Serialize().properties.TabIndex, 3);
        a.TabIndex = 0;

        /* And there is no TabStop beside it: a control Tab skips is a control
         * that cannot take the focus, which `Focusable` already says. */
        check("Focusable is the TabStop", a.PropertyNames().includes("Focusable"));
        check("and there is no second word for it",
              !a.PropertyNames().includes("TabStop"),
              JSON.stringify(a.PropertyNames()));

        /*
         * **The walk waits for the window to be mapped**, and that is the whole
         * of why this half is deferred. `gtk_widget_child_focus` refuses a widget
         * that is not mapped -- it answers false and moves nothing -- and
         * `Form_Open` runs *before* the window is presented, so every assertion
         * below would have failed for a reason that has nothing to do with the
         * tab order. `grab_focus` does not care, which is what makes the
         * difference invisible until something walks.
         */
        a.SetFocus();
        eq("the walk starts where the focus is", a.Focused, true);
        until("the window is mapped", () => surf.Bounds().Width > 0, () => {
        /* Grabbed again, like every walk below does: the tail runs after
         * every sync test, and anything shown since -- a window of another
         * test's, a second of exports -- may have moved the focus. What is
         * walked here is the order, not where the focus survived from. */
        a.SetFocus();
        check("undeclared, Tab follows the order they were drawn in",
              surf.FocusNext() && b.Focused, this.focusName(box));
        check("and on to the next",
              surf.FocusNext() && c.Focused, this.focusName(box));
        check("backwards, the same order in reverse",
              surf.FocusPrevious() && b.Focused, this.focusName(box));

        /* Nothing focusable left that way is `false`, not a wrap: the focus
         * leaving the surface is what lets Tab reach whatever is beside it. */
        c.SetFocus();
        eq("past the last one it says the focus left", surf.FocusNext(), false);

        /* Now declare one. C first, then the two 5s in the order they were
         * added: ties fall back to the child order, which is what makes a
         * partial declaration mean something. */
        c.TabIndex = 0;
        a.TabIndex = 5;
        b.TabIndex = 5;
        c.SetFocus();
        check("a declared place moves it ahead of the undeclared",
              surf.FocusNext() && a.Focused, this.focusName(box));
        check("and ties fall back to the drawn order",
              surf.FocusNext() && b.Focused, this.focusName(box));

        /* A control that cannot take the focus is a control Tab skips -- the
         * whole of what a TabStop would have said. */
        a.Focusable = false;
        c.SetFocus();
        check("what cannot be focused is skipped",
              surf.FocusNext() && b.Focused, this.focusName(box));

        /* Taken out again, or the focus test after this one walks into them. */
        surf.Delete();
        });
    }

    /* Which of them has it, for a failure that says where the focus really went
     * instead of only that it was not where it should be. */
    focusName(controls) {
        const on = controls.filter((t) => t.Focused).map((t) => t.Name);
        return on.length ? on.join(",") : "none";
    }

    /*
     * The window's own state: `Resizable`, `Maximized`, `FullScreen`, `Minimize`,
     * and the `Resize` event.
     *
     * The pair is here because of the case that asked for it: a dialog that asks
     * for a name has nothing to gain from being dragged bigger and nothing at all
     * from being maximised, and until this every one of them could be.
     */
    testWindowState() {
        const win = new SizedForm();
        win.Text = "state";
        win.Resize(320, 200);

        /* A request GTK remembers, like Modal: it reads back with no window. */
        eq("a form can be dragged bigger by default", win.Resizable, true);
        check("so that stays out of the .form",
              !("Resizable" in win.Serialize().properties),
              JSON.stringify(win.Serialize().properties));

        win.Resizable = false;
        eq("asking otherwise reads back", win.Resizable, false);
        eq("and is saved", win.Serialize().properties.Resizable, false);

        /*
         * **And it does not stop the contents pushing it.** `Resizable` is about
         * the user dragging the frame; a caption too long for the width still
         * makes the window open wider, which is what translation does to every
         * dialog and the reason this had to be checked rather than assumed.
         */
        const wide = new Label();
        win.Add(wide);
        wide.Move(8, 8);
        wide.Resize(60, 24);
        wide.Text = "a caption far too long for sixty pixels to hold, by a distance";

        /* A state, not a request: nothing is true of a window that is not up. */
        eq("nothing is maximised before there is a window", win.Maximized, false);
        eq("nor full screen", win.FullScreen, false);
        check("and Minimize is a verb, because the state cannot be read back",
              typeof win.Minimize === "function");
        check("Maximized is not published as prose either",
              !win.TextProperties().includes("Maximized"));

        eq("a window that is not up has been told no size yet", win.seen.length, 0);
        win.Show();

        until("the window reports its size", () => win.seen.length > 0, () => {
            check("showing it raises Resize", win.seen.length > 0,
                  JSON.stringify(win.seen));

            const [w, h] = win.seen[win.seen.length - 1];

            /*
             * **The size it is told is the size it has**, and that is the whole
             * of what was wrong here: the event used to ride
             * `notify::default-width`, which fires before the window has been
             * laid out at the new size -- so it carried the *previous* one and
             * `Bounds()` disagreed with it. It rides `GdkSurface::layout` now,
             * which is what GTK lays the window out on.
             */
            eq("with the size GTK gave, which is what Bounds says too",
               `${w}x${h}`, `${win.Bounds().Width}x${win.Bounds().Height}`);
            check("and the contents pushed it past its declared width",
                  w > 320, `${w} against a declared 320`);

            /* One resize is one event: a `layout` is emitted for a relayout that
             * is not a resize too, and a form that relaid itself twice per drag
             * step would be this event's whole cost. */
            const pairs = win.seen.map(([a, b]) => `${a}x${b}`);
            eq("and no size is reported twice in a row",
               JSON.stringify(pairs.filter((p, i) => i > 0 && p === pairs[i - 1])),
               "[]");

            /* And a resize while it is up arrives, which is the half a window
             * nobody drags never sees. */
            const before = win.seen.length;
            win.Resize(w + 90, h + 70);

            until("a resize on a window that is up arrives",
                  () => win.seen.length > before, () => {
                const [w2, h2] = win.seen[win.seen.length - 1];
                eq("with the size it was asked for", `${w2}x${h2}`,
                   `${win.Bounds().Width}x${win.Bounds().Height}`);
                check("which is the new one and not the one before it",
                      w2 > w || h2 > h, `${w2}x${h2} after ${w}x${h}`);
                win.Close();
            });
        });
    }

    /*
     * `Margin` on a **form**, which is the one control where it cannot mean what
     * it means everywhere else.
     *
     * A margin is room *outside* a widget, and outside a toplevel there is
     * nothing: GTK honours it by insetting the window's content inside its own
     * surface, and the window's background is painted on the content. What is
     * left is a band of window that nothing draws -- **transparent** under a
     * compositor, so the desktop showed through the right and bottom edges of
     * the two examples that declared `Margin: 8` on the form. It read like a bug
     * in the `DrawingArea` both of them happened to contain.
     *
     * So on a form the margin lands on the surface: the window keeps its whole
     * size and paints all of it, and what moves is what is inside. Both halves
     * are asserted here, because either alone passes for the broken version --
     * the old one moved the children too.
     */
    testFormMargin() {
        const win = new SizedForm();
        win.Text = "margin";
        win.Resize(300, 200);

        const b = new Button();
        win.Add(b);
        b.Move(0, 0);
        b.Resize(120, 30);

        eq("a form starts with no margin", win.Margin, 0);
        check("so it stays out of the .form",
              !("Margin" in win.Serialize().properties));

        win.Show();

        until("the window is laid out", () => win.Bounds().Width > 0, () => {
            const flush = win.Bounds(), at = b.Bounds();

            win.Margin = 8;
            eq("a form's margin reads back like any other", win.Margin, 8);
            eq("and is saved", win.Serialize().properties.Margin, 8);

            until("the margin is laid out", () => b.Bounds().X > at.X, () => {
                eq("the window is not shrunk by it -- the band it used to leave "
                   + "was unpainted, which is a transparent window",
                   `${win.Bounds().Width}x${win.Bounds().Height}`,
                   `${flush.Width}x${flush.Height}`);
                eq("what moves is what is inside, by the margin",
                   `${b.Bounds().X - at.X},${b.Bounds().Y - at.Y}`, "8,8");
                win.Close();
            });
        });
    }

    /*
     * The four events that were missing, and what can be asserted about them
     * without a pointer or a key: that the classes *declare* them.
     *
     * Which is not a formality. A handler connected in C and left out of the
     * class row fires and is never offered by the IDE -- the flag-versus-effect
     * trap, from the other side. Whether they arrive is on the by-hand list.
     */
    testPointerEvents() {
        const names = new Button().EventNames();

        for (const e of ["MouseEnter", "MouseLeave", "MouseWheel", "KeyRelease"]) {
            check(`${e} is one of the events a control raises`,
                  names.includes(e), JSON.stringify(names));
        }
        eq("declared on Widget, so a Separator has them too",
           new Separator().EventNames().includes("MouseWheel"), true);
        eq("...and a container",
           new Panel().EventNames().includes("MouseEnter"), true);

        /* MouseMove says where the pointer is; these say whether it is here at
         * all, which motion cannot answer -- there is no event for having left. */
        check("and they sit beside the ones that were already there",
              names.includes("MouseMove") && names.includes("KeyPress"));
    }

    /*
     * Separator -- a rule, and the last of the plain controls that was missing.
     *
     * One property, which is the point of it: a separator that needed
     * configuring would be a `Frame`. What is worth asserting is that its one
     * word is the *same* word two other controls already answer to, and that its
     * thickness is the line rather than the room around it -- the thing everyone
     * gets wrong once.
     */
    testSeparator() {
        const s = new Separator();
        this.Fixed1.Add(s);

        eq("a separator lies down by default", s.Orientation, "Horizontal");
        check("so that stays out of the .form",
              !("Orientation" in s.Serialize().properties),
              JSON.stringify(s.Serialize().properties));

        /* The same word Slider and ProgressBar answer to, through the same
         * accessor: GtkOrientable is what the three have in common. And the
         * runtime publishes what it accepts, so a property editor offers a
         * drop-down without having heard of Orientation. */
        eq("and the options are the runtime's own",
           JSON.stringify(s.PropertyOptions("Orientation")),
           '["Horizontal","Vertical"]');
        eq("the same list a Slider gives",
           JSON.stringify(s.PropertyOptions("Orientation")),
           JSON.stringify(new Slider().PropertyOptions("Orientation")));

        s.Orientation = "Vertical";
        eq("standing it up reads back", s.Orientation, "Vertical");
        eq("and is saved", s.Serialize().properties.Orientation, "Vertical");
        throws("and there is no third way",
               () => { s.Orientation = "Diagonal"; });
        eq("a refused value leaves it as it was", s.Orientation, "Vertical");

        /* Nothing to read and nothing to press: no prose of its own, and no
         * events of its own either -- what it answers is Widget's. */
        eq("it holds no prose", JSON.stringify(s.TextProperties()), '["Tooltip"]');
        eq("and raises nothing of its own", s.EventNames()[0], "MouseDown");

        /*
         * **Its thickness is the line.** A GtkSeparator paints its whole
         * allocation, so the natural height of a horizontal one is a pixel --
         * which is what makes `Margin` and not `Height` the way to give it room.
         * Measured rather than assumed, because it is the one number a caller
         * will get wrong.
         */
        s.Orientation = "Horizontal";
        s.Move(4, 4);
        s.Resize(120, 0);
        until("the separator is laid out", () => s.Bounds().Width > 1, () => {
            eq("a horizontal rule is one pixel tall", s.Bounds().Height, 1);
            s.Delete();
        });
    }

    /*
     * TableView -- the list with columns.
     *
     * Named for its sibling: a `TreeView` is one column with disclosure, this is
     * many columns without. What is asserted here is the declaration (which is
     * the part a `.form` carries and the designer edits), the rows, and the one
     * safety property that has bitten this codebase before -- that a translated
     * heading is **not** what gets saved.
     */
    testTableView() {
        const t = new TableView();
        this.Fixed1.Add(t);
        t.Name = "Tab1";

        eq("a table starts with no columns",
           JSON.stringify(t.Columns), "[]");
        eq("and no rows", t.Count, 0);

        /* --- what a column may say ---------------------------------------- */
        throws("Columns is a list",           () => { t.Columns = "Name"; });
        throws("...of objects",               () => { t.Columns = ["Name"]; });
        throws("Text is a string",            () => { t.Columns = [{ Text: 7 }]; });
        throws("a width is not negative",     () => { t.Columns = [{ Text: "A", Width: -1 }]; });
        throws("Alignment is one of three",   () => { t.Columns = [{ Text: "A", Alignment: "Sideways" }]; });
        eq("and a refused declaration leaves the table as it was",
           JSON.stringify(t.Columns), "[]");

        t.Columns = [{ Text: "Customer", Width: 200 },
                     { Text: "Balance", Width: 90, Alignment: "Right" }];
        eq("declaring them reads back",
           JSON.stringify(t.Columns),
           '[{"Text":"Customer","Width":200},{"Text":"Balance","Width":90,"Alignment":"Right"}]');
        eq("and is saved",
           JSON.stringify(t.Serialize().properties.Columns),
           JSON.stringify(t.Columns));
        check("so the designer's grid edits it like any other property",
              t.PropertyNames().includes("Columns"));

        /* --- rows ---------------------------------------------------------- */
        t.Add(["Ana", "10.50"]);
        t.Add(["Beto", "3.25"]);
        t.Add("Cora");                       /* one cell is a row of one */
        eq("adding counts", t.Count, 3);
        eq("a row reads back as it was added",
           JSON.stringify(t.Row(1)), '["Beto","3.25"]');
        eq("a row shorter than the columns is short, not padded",
           JSON.stringify(t.Row(2)), '["Cora"]');
        check("and a row that is not there is null", t.Row(9) === null);

        eq("a single cell reads back", t.Cell(1, 1), "3.25");
        eq("and one that is not there is empty, not an error", t.Cell(9, 9), "");
        eq("...including a short row's missing cells", t.Cell(2, 1), "");

        t.SetCell(1, 1, "99.99");
        eq("a cell can be written in place",
           JSON.stringify(t.Row(1)), '["Beto","99.99"]');
        eq("and read back one at a time", t.Cell(1, 1), "99.99");
        t.SetCell(2, 1, "0.00");
        eq("...and writing past the end of a short row fills it out",
           JSON.stringify(t.Row(2)), '["Cora","0.00"]');
        throws("but not past the end of the table", () => t.SetCell(9, 0, "x"));

        t.Remove(0);
        eq("removing one shortens it", t.Count, 2);
        eq("and the rest move up", JSON.stringify(t.Row(0)), '["Beto","99.99"]');
        throws("removing what is not there is refused", () => t.Remove(9));

        /* --- selection ------------------------------------------------------ */
        eq("nothing is selected to begin with", t.Index, -1);
        eq("and the selection is empty", JSON.stringify(t.Selection), "[]");

        t.Index = 1;
        eq("selecting one reports it", t.Index, 1);
        eq("and it is the whole selection", JSON.stringify(t.Selection), "[1]");
        t.Index = -1;
        eq("and it can be cleared", t.Index, -1);

        eq("one row at a time by default", t.MultiSelect, false);
        t.MultiSelect = true;
        eq("until it is asked otherwise", t.MultiSelect, true);
        t.Index = 0;
        eq("which still answers about the first selected",
           JSON.stringify(t.Selection), "[0]");

        t.Clear();
        eq("clearing empties it", t.Count, 0);
        check("and the columns survive it",
              t.Columns.length === 2, JSON.stringify(t.Columns));

        /*
         * **The four verbs that move a selection**, which this control had a
         * `MultiSelect` and a `Selection` without: a table could be told it
         * takes several rows and then had no way to choose one from code.
         */
        t.Clear();
        t.MultiSelect = false;          /* whatever the test above left it at */
        for (let i = 0; i < 4; i++) t.Add([`r${i}`]);

        eq("Select answers whether there was a row", t.Select(2), true);
        eq("and says so when there is not",          t.Select(99), false);
        eq("it shows in Index",     t.Index, 2);
        eq("and in Selection",      JSON.stringify(t.Selection), "[2]");

        throws("SelectAll needs MultiSelect", () => t.SelectAll());
        t.MultiSelect = true;
        t.SelectAll();
        eq("SelectAll takes them all", t.Selection.length, 4);
        t.Deselect(1);
        eq("Deselect takes one out",   t.Selection.length, 3);
        check("the right one", !t.Selection.includes(1), JSON.stringify(t.Selection));
        t.DeselectAll();
        eq("DeselectAll leaves none",  t.Selection.length, 0);
        t.MultiSelect = false;

        t.Delete();
    }

    /*
     * On demand: `Count = N` and the table asks `Data(row, column)` for each
     * cell it draws.
     *
     * This is what makes a table backed by a query possible -- Gambas' `Data`
     * event and WinForms' `VirtualMode` -- and the assertion that matters is
     * that **the handler is asked at all** and only about what is on screen: a
     * table of a hundred thousand rows that called the handler a hundred
     * thousand times would be the same thing as holding the data.
     */
    testTableOnDemand() {
        const t = new TableView();
        this.Fixed1.Add(t);
        t.Name    = "Virt";
        t.Columns = [{ Text: "N" }, { Text: "Square" }];
        t.Move(4, 4);
        t.Resize(240, 120);

        this.virtAsked = [];

        t.Add(["held", "row"]);
        eq("a table holds what it is given", t.Count, 1);

        t.Count = 100000;
        eq("...until it is told how many there are", t.Count, 100000);
        /*
         * What it held is dropped, and asking about a row is now the wrong
         * question -- the rows exist but their values live wherever the handler
         * reads them. All four refusals say so rather than answering "" or null,
         * which would look like an answer.
         */
        throws("asking for a row is refused",   () => t.Row(0));
        throws("...and so is asking for a cell", () => t.Cell(0, 0));
        throws("...and putting an icon on one",  () => t.SetIcon(0, 0, "folder"));
        throws("...and sorting what it does not have", () => t.SortBy(0, true));

        /* Adding is saying it holds its own again. */
        t.Add(["back", "again"]);
        eq("adding takes it out of on-demand", t.Count, 1);
        eq("and the row is there", JSON.stringify(t.Row(0)), '["back","again"]');

        t.Count = 500;
        eq("and it can go back", t.Count, 500);

        /* The handler is asked while rows are drawn, so this waits for a frame
         * rather than counting: nothing is bound until GTK lays the view out. */
        until("the table asks about its rows", () => this.virtAsked.length > 0, () => {
            check("it asks for cells it is drawing", this.virtAsked.length > 0,
                  `${this.virtAsked.length}`);
            check("and not for all five hundred rows",
                  this.virtAsked.length < 500 * 2,
                  `${this.virtAsked.length} calls for 500 rows`);

            const rows = this.virtAsked.map((a) => a[0]);
            check("every row asked about is one that exists",
                  rows.every((r) => r >= 0 && r < 500), JSON.stringify(rows.slice(0, 5)));
            const cols = this.virtAsked.map((a) => a[1]);
            check("and every column too",
                  cols.every((c) => c === 0 || c === 1), JSON.stringify(cols.slice(0, 5)));

            t.Delete();
        });
    }

    /* What a virtual table answers with: a string, or Text and an Icon. */
    Virt_Data(row, col) {
        this.virtAsked.push([row, col]);
        return col === 0 ? String(row)
                         : { Text: String(row * row), Icon: "folder" };
    }

    /*
     * Sorting: the header is clickable and says so, and **the table does not
     * reorder itself**. One line in the handler does, when the table has the
     * data -- which is the line Gambas draws between `Sorted` and its `Sort`
     * event, and the only one that can hold for an on-demand table too.
     */
    testTableSort() {
        const t = new TableView();
        this.Fixed1.Add(t);
        t.Columns = [{ Text: "Name" }, { Text: "N" }];

        eq("headers are not clickable until asked", t.Sortable, false);
        t.Sortable = true;
        eq("and then they are", t.Sortable, true);
        check("which stays out of the .form only if it is the default",
              t.Serialize().properties.Sortable === true,
              JSON.stringify(t.Serialize().properties));

        t.Add(["Cora", "3"]);
        t.Add(["Ana",  "1"]);
        t.Add(["Beto", "2"]);

        t.SortBy(0, true);
        eq("SortBy orders the rows it holds",
           [t.Cell(0, 0), t.Cell(1, 0), t.Cell(2, 0)].join(","), "Ana,Beto,Cora");
        t.SortBy(0, false);
        eq("...and the other way",
           [t.Cell(0, 0), t.Cell(1, 0), t.Cell(2, 0)].join(","), "Cora,Beto,Ana");
        eq("the whole row travels, not just the key it was sorted on",
           t.Cell(0, 1), "3");

        throws("a column that is not there is refused", () => t.SortBy(-1, true));

        /* Declaring columns rebuilds them, and a rebuilt column has no sorter:
         * the flag has to be re-applied or the headers go dead. */
        t.Columns = [{ Text: "Name" }, { Text: "N" }, { Text: "More" }];
        eq("re-declaring the columns keeps them sortable", t.Sortable, true);

        check("Sort is one of the events it raises",
              t.EventNames().includes("Sort") && t.EventNames().includes("Data"),
              JSON.stringify(t.EventNames().slice(0, 4)));
        t.Delete();

        /*
         * --- the header, and the order that was broken --------------------
         *
         * `Sortable` **before** `Columns`, which is the order a `.form` uses --
         * its properties are applied as the file lists them, and that is
         * alphabetical, so almost every form does it this way. It used to set the
         * flag when there were no columns and then `Columns` rebuilt them with no
         * sorter: the headers were dead and `Sortable` still read `true`.
         *
         * Which is why this asserts the **effect**. `SortColumn` is the header
         * clicked from code, so `Sort` arriving is the proof that a real click
         * would arrive too -- a pointer on a GTK header being the one thing the
         * suite cannot do.
         */
        const h = new TableView();
        this.Fixed1.Add(h);
        h.Name = "SortT";
        this.sorts = [];

        h.Sortable = true;                       /* first, as a .form does */
        h.Columns  = [{ Text: "A" }, { Text: "B" }];

        h.SortColumn(1, true);
        eq("clicking a heading raises Sort", JSON.stringify(this.sorts), "[[1,true]]");
        h.SortColumn(1, false);
        eq("...and says which way", JSON.stringify(this.sorts[1]), "[1,false]");
        h.SortColumn(0, true);
        eq("...and which column",  JSON.stringify(this.sorts[2]), "[0,true]");

        throws("a column that is not there is refused", () => h.SortColumn(9, true));

        /* And the other order, which was the one that happened to work. */
        const k = new TableView();
        this.Fixed1.Add(k);
        k.Name    = "SortT";
        k.Columns = [{ Text: "A" }];
        k.Sortable = true;
        this.sorts = [];
        k.SortColumn(0, false);
        eq("declaring the columns first works the same",
           JSON.stringify(this.sorts), "[[0,false]]");

        /* Nothing to click until it is asked for, and saying so beats a call
         * that quietly does nothing. */
        k.Sortable = false;
        throws("an unsortable table refuses to be sorted by a heading",
               () => k.SortColumn(0, true));

        h.Delete();
        k.Delete();
    }

    /* Both tables above are named SortT: only one is alive at a time, and what
     * is recorded is what arrived. */
    SortT_Sort(column, ascending) { this.sorts.push([column, ascending]); }

    /* An icon beside a cell's text, which is what makes a list of files look
     * like one. */
    testTableIcon() {
        const t = new TableView();
        this.Fixed1.Add(t);
        t.Columns = [{ Text: "File" }];
        t.Add(["Form1.js"]);

        t.SetIcon(0, 0, "text-x-generic");
        check("an icon can be put on a cell", true);
        t.SetIcon(0, 0, "");
        check("and taken off again", true);

        /* The text is untouched by either, which is the point of it being a
         * separate call rather than a second kind of cell value. */
        eq("and the text is untouched", t.Cell(0, 0), "Form1.js");

        throws("a row that is not there is refused", () => t.SetIcon(9, 0, "x"));
        throws("and neither is a column", () => t.SetIcon(0, -1, "x"));
        t.Delete();
    }

    /*
     * A column heading is prose and the rest of the column is not, which is what
     * `texts = "Columns.Text"` says. Both halves are asserted, and the second is
     * the one that matters: a catalogue that reached `Alignment` would translate
     * a keyword, and the runtime would then refuse the value it wrote itself.
     */
    testTableProse() {
        const t = new TableView();
        this.Fixed1.Add(t);

        eq("the class declares which part of a column is prose",
           JSON.stringify(t.TextProperties().filter((p) => p.startsWith("Columns"))),
           '["Columns.Text"]');

        Locale.Current = "zz";
        try {
            const form = new TableForm();
            const col  = form.Grid1.Columns;

            eq("the heading comes through the catalogue", col[0].Text, "CLIENTE");
            eq("and the alignment is left exactly alone", col[1].Alignment, "Right");
            eq("...even though the catalogue has an entry for it",
               Locale.Text("Right"), "MAL-TRADUCIDO");

            /*
             * The one that has bitten before: the serialiser reads the *current*
             * value, so a form opened in another language and saved would write
             * the translation and lose the msgid. What the file said is written
             * back instead.
             */
            const saved = form.Grid1.Serialize().properties.Columns;
            eq("what is saved is what the file declared, not what was shown",
               saved[0].Text, "Customer");
            eq("and the rest of the column is unchanged", saved[1].Alignment, "Right");
            form.Close();
        } finally {
            Locale.Current = "";
        }
        t.Delete();
    }

    /*
     * EventNames(): which events a control raises, most derived first.
     *
     * The runtime dispatches by name, so which events exist was knowable only by
     * reading the C -- and the IDE therefore kept a table of fifteen types with
     * `|| "MouseDown"` for the rest. Five controls were not in it. What this
     * asserts is the two properties that let a table be deleted rather than
     * merely duplicated: **the head is the event the control is about**, and
     * every control answers.
     */
    testEventNames() {
        const head = (type) => Widget.New(type).EventNames()[0];

        /* The fifteen the old table had, and the same answers. */
        eq("a button is about being clicked",   head("Button"), "Click");
        eq("a text box about being changed",    head("TextBox"), "Change");
        eq("a list about what is selected",     head("ListBox"), "Select");
        eq("a tree likewise",                   head("TreeView"), "Select");
        eq("a combo likewise",                  head("ComboBox"), "Select");
        eq("a slider about its value",          head("Slider"), "Change");
        eq("a terminal about its child ending", head("Terminal"), "Exit");
        eq("a form about being opened",         head("Form"), "Open");

        /* And the five that were missing from it, which fell back to a mouse
         * handler nobody wanted. */
        for (const [type, want] of [["ColorButton", "Change"], ["FontButton", "Change"],
                                    ["Notebook", "Switch"], ["Switcher", "Switch"],
                                    ["RowList", "Select"]]) {
            eq(`${type} was missing from the table it replaced`, head(type), want);
        }

        /* Accumulated along the chain, not first-match: a Button's own Click and
         * then everything Widget raises. A control with none of its own answers
         * with Widget's, whose head is MouseDown -- which is exactly what the
         * table used as its fallback, so deleting it changed nothing. */
        const btn = Widget.New("Button").EventNames();
        check("its own event comes before the ones it inherits",
              btn[0] === "Click" && btn.includes("MouseDown") &&
              btn.indexOf("Click") < btn.indexOf("MouseDown"),
              JSON.stringify(btn));
        eq("and a control that raises none of its own falls back to Widget's",
           head("Label"), "MouseDown");
        eq("...as a container does too", head("Panel"), "MouseDown");

        /*
         * Every class one can *place* answers something: an empty list is a
         * control the designer cannot write a handler for.
         *
         * Which ones those are is decided by trying, not by a list here --
         * `Widget`, `Control` and `Container` are abstract and say so by throwing,
         * and a list of them in this file would be the very thing `EventNames`
         * exists to delete.
         */
        const silent = [];
        for (const type of Widget.Types()) {
            let w = null;
            try { w = Widget.New(type); } catch (e) { continue; }   /* abstract */
            if (w.EventNames().length === 0) silent.push(type);
        }
        eq("every type that can be placed raises something",
           JSON.stringify(silent), "[]");

        /* A set, not a tally: a subclass naming what a parent already did must
         * not appear twice. */
        const dup = btn.filter((e, i) => btn.indexOf(e) !== i);
        eq("and no event is listed twice", JSON.stringify(dup), "[]");
    }

    /*
     * `On(event, fn)`: a handler on the control, for a control built in code.
     *
     * Beside `EventNames`, because that list is what this one is checked
     * against -- the two are the same declaration read from opposite ends.
     */
    testOn() {
        const b = new Button();
        let   seen = 0;

        eq("On answers with the control, so one can be dressed in an expression",
           b.On("Click", () => { seen++; }), b);

        b.Click();
        eq("the handler installed on the control runs", seen, 1);

        /* It needed no name, no form and no parent, which is the whole point:
         * the name the convention wants exists only to build a property out
         * of, and that property outlives the control. */
        eq("and it needed no name", b.Name, "");

        /* Installing again replaces. That is what makes rebuilding a palette
         * need no bookkeeping, and it is why there is no `Off`. */
        let other = 0;
        b.On("Click", () => { other++; });
        b.Click();
        eq("a second On replaces the first", seen, 1);
        eq("and the second is what runs", other, 1);

        b.On("Click", null);
        b.Click();
        eq("null removes it", other, 1);

        /* The answer travels back: eight of this runtime's events are asked a
         * question rather than told something, and `Emit` is the one road a
         * test can put a value through. */
        const q = new Button();
        q.On("Click", () => 42);
        eq("what the handler answers comes back", q.Emit("Click"), 42);

        /* `this` is undefined, like every other callback this runtime is
         * handed. Sources run under forced strict mode, so a non-arrow
         * function that reads it throws rather than finding the global. */
        let sawThis = "unset";
        const t = new Button();
        t.On("Click", function () { sawThis = this; });
        t.Click();
        eq("a handler is called with no this", sawThis, undefined);

        /* Checked against EventNames(), so a misspelling throws where it is
         * written instead of never firing and never saying so. */
        throws("an event the control does not raise is refused",
               () => b.On("Clik", () => {}));
        throws("and so is a handler that is not a function",
               () => b.On("Click", 5));

        /*
         * **Two handlers for one event are refused where the second is
         * written**, which is what the precedence assertions here used to be.
         * Of two answers only one could ever be used -- eight events here are
         * asked a question -- so picking one would silence the other in
         * silence.
         *
         * Driven through the component already on this form, whose `Up` button
         * is bound by name to a real `Up_Click` -- so nothing has to be added
         * to `Fixed1`, whose children `testTabOrder` walks.
         */
        const st  = this.Step1;
        const was = st.Value;

        st.Up.Click();
        eq("a named handler inside a component runs", st.Value, was + 1);

        throws("and On over it is refused, not silently preferred",
               () => st.Up.On("Click", () => {}));

        st.Up.Click();
        eq("so the named handler still has the event", st.Value, was + 2);

        /* Taking one away cannot make a pair, so clearing is let through even
         * where installing would not be. */
        st.Up.On("Click", null);
        st.Up.Click();
        eq("...and clearing is not refused", st.Value, was + 3);

        st.Value = was;   /* what testComponent left, put back */

        /*
         * The other half of the gap this answers. A component added from code
         * keeps *itself* as its event target -- only the `.form` loader rebinds
         * one to its host -- so `<name>_<event>` on the host never fires for it.
         * `Emit` reads the control's own note like every other event, so the
         * host hears it with no rebinding and no change to what `Add` means.
         */
        const made = new Stepper();
        let   said = null;

        made.On("Change", (v) => { said = v; });
        made.Value = 3;
        eq("a component built in code reports to whoever holds it", said, 3);

        /* And its own `static Events` is what the check reads, which is the
         * same walk `EventNames()` above makes. */
        throws("a component's own declaration is what checks its events",
               () => made.On("Changed", () => {}));

        /*
         * The other door into the refused pair: a control carrying a handler of
         * its own, **renamed** onto a name its form already answers for.
         *
         * Inside the component built above, because that is the one event target
         * here with an `Up_Click` to collide with -- `this.Step1` looks like it
         * would and does not, since the `.form` loader rebound it to *this* form
         * and a child added to it from code binds to this form too.
         */
        const child = new Button();
        made.Add(child);
        child.On("Click", () => {});

        throws("a rename onto a name the form answers for is refused too",
               () => { child.Name = "Up"; });
        eq("and the name it had is the one it keeps", child.Name, "");

        /* It is the *pair* that is refused and not the name: the same rename
         * with no handler of its own goes through. */
        const plain = new Button();
        made.Add(plain);
        plain.Name = "Up";
        eq("a control with no handler of its own may take it", plain.Name, "Up");

        /*
         * **And the third door, which the first two cannot cover.**  Both of
         * them ask about the control's *form*, and a control built in code has
         * not got one until it is adopted -- so naming it and installing a
         * handler *before* `Add` passed both and made the pair in silence.  The
         * adoption is where the form arrives, so the adoption is what is asked,
         * before the child is put into GTK: `bta_widget_adopt` runs after the
         * attach and so cannot refuse anything.
         */
        const held = made.Children.length;
        const both = new Button();

        both.Name = "Up";                 /* no form yet: nothing to collide with */
        both.On("Click", () => {});       /* likewise */

        throws("a control that arrives carrying both is refused at the Add",
               () => made.Add(both));
        eq("and the refusal left nothing behind", made.Children.length, held);

        /* Over-refusing would be worse than the hole was, so the same shape
         * with a name the form does not answer for still goes in and still
         * answers. */
        const fine = new Button();
        let   rang = 0;

        fine.Name = "NadaLoResponde";
        fine.On("Click", () => { rang++; });
        made.Add(fine);
        fine.Click();
        eq("a name the form does not answer for is no pair at all", rang, 1);
    }

    /*
     * `Border`, and `StyleRule()` -- the two halves of writing a class.
     *
     * The appearance a control can be given by hand -- colours, font, radius,
     * padding, shadow and now a border -- is the **exception**: the rule is a
     * class in `app.css`. `StyleRule()` is what turns one into the other, so the
     * IDE's class editor can set these on a control nobody sees and write what
     * comes back into the project's stylesheet. The point of it is that the units,
     * the colour normalising and the three ways a font size reaches CSS wrong stay
     * written **once**, in the code that already had to get them right.
     */
    testStyleRule() {
        const w = new Label();
        this.Fixed1.Add(w);

        eq("a control with nothing set comes to no rule", w.StyleRule(), "");

        eq("a border starts unset", w.Border, "");
        w.Border = "2 dashed #3584e4";
        eq("and is normalised on the way in, like a shadow",
           w.Border, "2 dashed rgb(53,132,228)");
        eq("so it is what the .form will carry",
           w.Serialize().properties.Border, "2 dashed rgb(53,132,228)");

        w.Border = "3";
        eq("a width on its own is solid and the theme's black",
           w.Border, "3 solid rgb(0,0,0)");
        throws("a colour with no width is not a border", () => { w.Border = "red"; });
        throws("and neither is a word that is nothing", () => { w.Border = "verde"; });
        w.Border = "";
        eq("and nothing at all is none", w.Border, "");

        /*
         * **A weight and a relative size, and no family** -- which is how the
         * desktop's own type classes are written, and what a whole font cannot
         * say. `.title-1` is `font-weight: 800; font-size: 200%`; `.heading` is
         * 700 and 110%; `.dim-label` is not a grey but `opacity: 0.55`. A class
         * that named a family would freeze it, and one that named 20pt would
         * ignore whoever runs at a different text scale.
         */
        const head = new Label();
        this.Fixed1.Add(head);

        head.Font = "Bold";
        eq("a font can be a weight alone", head.StyleRule(), "font-weight: 700;");
        head.FontScale = 1.1;
        eq("with the size a factor of whatever is in force",
           head.StyleRule(), "font-size: 110%; font-weight: 700;");

        /* Pango marks weight and style as set whatever the text said, so this
         * used to come out carrying `font-weight: 400; font-style: normal` --
         * two declarations nobody asked for, which in a class override whatever
         * the theme or another class said. */
        head.Font = "12";
        head.FontScale = 1;
        eq("a size alone says only the size", head.StyleRule(), "font-size: 12pt;");

        head.Font = "";
        head.Opacity = 0.55;
        eq("and dim is an opacity, which is what the theme's own dim-label is",
           head.StyleRule(), "opacity: 0.55;");

        /*
         * **1 is "nothing said" for both**, and it is where they start.
         *
         * Not 0, which was the first answer and wrong twice: a spin that opens on
         * the end of its own range has a button that does nothing, and the first
         * click on the other one made text 5% tall. And `font-size: 100%` is a
         * declaration like any other -- on a control also wearing `.title-1` it
         * would win and undo it -- so 1 writes nothing at all, for the same
         * reason `font-weight: 400` does not.
         */
        eq("a scale starts at the size in force", new Label().FontScale, 1);
        eq("and an opacity at whole", new Label().Opacity, 1);

        head.Font = ""; head.FontScale = 1; head.Opacity = 1;
        eq("so neither reaches the stylesheet until it is asked for",
           head.StyleRule(), "");
        check("and neither reaches the .form",
              !("FontScale" in head.Serialize().properties) &&
              !("Opacity" in head.Serialize().properties),
              JSON.stringify(head.Serialize().properties));

        throws("a scale of nothing is not a size", () => { head.FontScale = 0; });
        throws("nor a negative one", () => { head.FontScale = -1; });
        throws("and an opacity outside nought and one",
               () => { head.Opacity = 2; });
        head.Delete();

        /* The whole of what a class can say, in one string. */
        w.Background = "rgb(255,0,0)";
        w.Foreground = "#ffffff";
        w.Font       = "Cantarell Bold 12.5";
        w.Radius     = "6";
        w.Padding    = "4 8";
        w.Border     = "2 dashed #3584e4";

        const rule = w.StyleRule();

        check("the rule carries the colour, normalised",
              rule.includes("background-color: rgb(255,0,0)"), rule);
        check("and covers the gradient a theme would paint over it",
              rule.includes("background-image: none"), rule);
        check("units are added on the way out, not stored",
              rule.includes("border-radius: 6px") && rule.includes("padding: 4px 8px"),
              rule);
        check("the border comes out as CSS writes one",
              rule.includes("border: 2px dashed rgb(53,132,228)"), rule);
        /* The three font traps, in one line: fractional, in points, with a dot
         * whatever the locale is. */
        check("and the font size survives being fractional, and the locale",
              rule.includes("font-size: 12.5pt"), rule);
        check("with the family quoted and the weight a number",
              rule.includes('font-family: "Cantarell"') && rule.includes("font-weight: 700"),
              rule);

        w.Delete();
    }

    /*
     * `CssNode()`: which CSS node a stylesheet has to name to reach a control.
     *
     * **This table is an API.** `Style` puts a class on that node, and the node
     * decides which of the theme's rules can match: `button.suggested-action`
     * reaches a `Button` and never a `ColorButton`, and `.boxed-list > row`
     * reaches neither. So a build function that swaps the outer widget silently
     * breaks every `app.css` that named the old one -- and nothing else here
     * would notice, which is not a hypothesis: three of these moved in one
     * afternoon while the whole suite stayed green.
     *
     * Read off GTK rather than declared, so it cannot drift from what the widget
     * is; written down here, so it cannot change without somebody saying so.
     */
    testCssNode() {
        const NODES = {
            Label: "label", Button: "button", ToggleButton: "button",
            LinkButton: "button", CheckButton: "checkbutton", TextBox: "entry",
            SpinBox: "spinbutton", ComboBox: "dropdown", Switch: "switch",
            Slider: "scale", ProgressBar: "progressbar", LevelBar: "levelbar",
            Image: "image", Picture: "picture", Separator: "separator",
            /* A GtkPicture wearing a paintable: the node is what the widget
             * is, and a video frame is still a picture to a stylesheet. */
            Video: "picture",
            /* GTK gives a plain GtkDrawingArea no name of its own, so the node is
             * the generic one -- which means a stylesheet reaches a drawing
             * through the class `Style` puts on it and never through the node. */
            DrawingArea: "widget",
            Spinner: "spinner", DatePicker: "menubutton",
            Calendar: "calendar",
            ColorButton: "colorbutton", FontButton: "fontbutton",
            /* Everything that scrolls is the scroller, and the control is inside
             * it -- which is the whole of why a class meant for the list does
             * nothing on a RowList. */
            ListBox: "scrolledwindow", RowList: "scrolledwindow",
            TreeView: "scrolledwindow", TableView: "scrolledwindow",
            TextEditor: "scrolledwindow", SourceEditor: "scrolledwindow",
            Terminal: "scrolledwindow",
            Flow: "scrolledwindow", Scroller: "scrolledwindow",
            /* Ours, and it says so: BtaFixed sets its own CSS name. */
            Panel: "fixed", Component: "fixed",
            Grid: "grid", Split: "paned", Overlay: "overlay",
            Notebook: "notebook", Switcher: "box", Frame: "frame",
            /* GTK's own, and **not** `frame`: a GtkAspectFrame is not a
             * GtkFrame -- it descends from GtkWidget and has no caption. */
            AspectFrame: "aspectframe",
            Expander: "expander-widget", Form: "window",
        };

        const made = [];
        const nodeOf = (type) => {
            const w = Widget.New(type);
            made.push(w);
            return w.CssNode();
        };

        for (const type of Dictionary.Keys(NODES)) {
            eq(`${type} is a '${NODES[type]}' to a stylesheet`, nodeOf(type), NODES[type]);
        }

        /* The three the docs turn into rules, said as consequences rather than
         * as node names: this is what the table is read for. */
        check("so button.suggested-action cannot reach a ColorButton",
              nodeOf("ColorButton") !== nodeOf("Button"),
              `${nodeOf("ColorButton")} against ${nodeOf("Button")}`);
        eq("a Panel wears the class where its children are, so .linked works",
           nodeOf("Panel"), "fixed");
        check("and a RowList does not, so .boxed-list > row cannot match",
              nodeOf("RowList") !== "list", nodeOf("RowList"));

        /*
         * Every placeable type is in the table above. Which ones those are is
         * decided by trying rather than by a second list here -- and a widget
         * added to the runtime lands in this assertion until its node is written
         * down, which is the point: a table nobody is forced to update is the
         * kind that was wrong by the time anybody looked.
         */
        const missing = [];
        for (const type of Widget.Types()) {
            let w = null;
            try { w = Widget.New(type); } catch (e) { continue; }   /* abstract */
            made.push(w);
            if (!(type in NODES)) missing.push(type);
            else if (!w.CssNode()) missing.push(`${type} (empty)`);
        }
        eq("every type that can be placed has its node written down",
           JSON.stringify(missing), "[]");

        for (const w of made) {
            if (w instanceof Form) w.Close();
            else                   w.Delete();
        }
    }

    /*
     * Completion: the words in the buffer, offered as you type.
     *
     * Whether the popover *appears* is not answerable from JS -- it is a separate
     * surface, like every other popover here -- so what is asserted is the
     * property and its round trip through GtkSourceView: turning it on registers
     * a provider on this buffer, turning it off unregisters it, and the getter
     * reports which. Off by default, because an editor is also used to show a log
     * or a diff and a popover over one of those is uninvited.
     */
    testCompletion() {
        const ed = new SourceEditor();
        this.Fixed1.Add(ed);

        eq("an editor offers nothing until asked", ed.Completion, false);

        /*
         * **Set before it is in a container**, which is the order the IDE used
         * and the order that broke it: the popover is built where the property is
         * set, and one built on a view that is in no window has no size -- it
         * renders once and every attempt after it fails. The property has to be a
         * request the runtime carries out when there is a window, so it reads
         * back either way.
         */
        const loose = new SourceEditor();
        loose.Completion = true;
        eq("asking before there is a window still reads back", loose.Completion, true);
        this.Fixed1.Add(loose);
        eq("...and survives being added", loose.Completion, true);
        loose.Completion = false;
        eq("...and can still be turned off", loose.Completion, false);
        loose.Delete();
        check("so it stays out of the .form",
              !("Completion" in ed.Serialize().properties),
              JSON.stringify(ed.Serialize().properties));

        ed.Completion = true;
        eq("turning it on reads back", ed.Completion, true);
        eq("and is saved",             ed.Serialize().properties.Completion, true);

        /* Twice is not two providers: the second is asked for what is already
         * there, and a second registration on one buffer is GTK complaining. */
        ed.Completion = true;
        eq("asking twice is asking once", ed.Completion, true);

        ed.Completion = false;
        eq("and it can be turned off again", ed.Completion, false);
        ed.Completion = false;
        eq("...twice, likewise", ed.Completion, false);

        /* It survives the text changing under it, which is the case the IDE is:
         * one editor per tab, its buffer written whenever the file is loaded. */
        ed.Completion = true;
        ed.Text = "const alpha = 1;\nconst beta = 2;\n";
        eq("and the provider outlives the buffer being filled", ed.Completion, true);

        eq("it is the property grid's to edit like any other",
           ed.PropertyNames().includes("Completion"), true);

        /* --- and the half that knows what the text means -------------------
         *
         * The words provider proposes what is already in the buffer. What it
         * *means* is the application's to say, and it says it the way a widget
         * asks anything: an event, dispatched by name.
         */
        eq("the editor publishes the event that asks",
           ed.EventNames().includes("Complete"), true);

        eq("the heading over the answers is prose",
           ed.TextProperties().includes("CompletionTitle"), true);
        ed.CompletionTitle = "What this project knows";
        eq("and reads back", ed.CompletionTitle, "What this project knows");
        eq("and is saved, being a caption like any other",
           ed.Serialize().properties.CompletionTitle, "What this project knows");

        /*
         * **The round trip, which is the only thing worth asserting here.**
         * Whether a popover appeared is not answerable from JS -- it is a
         * surface of its own -- but asking for one makes GTK build a context and
         * put the question to every provider, so a handler that recorded what it
         * was asked proves the dispatch really goes through the completion
         * machinery and not through a call this test made itself.
         */
        ed.Name  = "Comp";
        this.completions = [];

        /*
         * **The round trip, and the contract it hands over.**
         *
         * Whether a popover appeared is not answerable from JS -- it is a
         * surface of its own -- but asking for one makes GTK build a context and
         * put the question to every provider, so a handler that records what it
         * was asked proves the dispatch goes through the completion machinery
         * and not through a call this test made itself.
         *
         * And *what* it is asked is the half worth pinning. A handler reading
         * these arguments has to know that `before` stops where the word starts
         * and that a name with an underscore arrives whole, as the word -- the
         * IDE's completion was written against a guess at both, answered for one
         * keystroke and stopped for the second, and no test noticed because the
         * test made the arguments up too.
         */
        const CASES = [
            { text: "        this.Ok.",   word: "",      before: "        this.Ok." },
            { text: "        this.Ok.Te", word: "Te",    before: "        this.Ok." },
            { text: "    Ok_",            word: "Ok_",   before: "    " },
            { text: "    Ok_Cl",          word: "Ok_Cl", before: "    " },
        ];

        /*
         * After the window is up, and this is not a detail: `Form_Open` runs
         * before the window is presented, and a completion asked for on a view
         * that is not on screen is asked of nothing -- the machinery is there,
         * the providers are attached, and no context is ever built. It reads
         * exactly like a provider that was never registered.
         */
        until("the editor is on screen", () => ed.Bounds().Height > 0, () => {
            ed.SetFocus();

            const step = (i) => {
                if (i === CASES.length) {
                    ed.Delete();
                    return;
                }
                const c = CASES[i];
                ed.Text = c.text;
                ed.Select(1, c.text.length + 1);

                eq(`asking after \`${c.text.trim()}\` is answered`,
                   ed.ShowCompletion(), true);

                /* Not on this turn of the loop: GTK builds the context and puts
                 * the question on its own time, which is the difference between
                 * asking for a popover and having one. */
                until(`the form is asked about ${c.text.trim()}`,
                      () => this.completions.length > i, () => {
                    const got = this.completions[i] || [];
                    eq(`the word being typed after \`${c.text.trim()}\``,
                       got[0], c.word);
                    eq(`and the line up to where that word starts`,
                       got[3], c.before);
                    step(i + 1);
                });
            };

            /*
             * **The first question is also the version check.** Whether a
             * programmatic show reaches the providers turns on the library and
             * not on this runtime: `gtk_source_completion_show` asked them on
             * this machine's GtkSourceView 5.20 and did not on the ubuntu-24.04
             * runner's 5.12, where four red assertions would be four ways of
             * saying "5.12". The path a person uses -- typing the trigger --
             * is not this one. So one case is asked quietly; if nothing
             * answers, it is said out loud and the four are skipped.
             */
            const probe = CASES[0];
            ed.Text = probe.text;
            ed.Select(1, probe.text.length + 1);
            ed.ShowCompletion();

            waitsFor(() => this.completions.length > 0, (asked) => {
                if (!asked) {
                    print("  (skipping the completion round trip: this GtkSourceView " +
                          "does not ask its providers when the completion is shown " +
                          "from code -- 5.12 on the runner does not, 5.20 here does)");
                    ed.Delete();
                    return;
                }
                this.completions = [];
                step(0);
            });
        });
    }

    /* Enter in a field: one meaning or the other, never both. */
    testActivatesDefault() {
        const t = new TextBox();
        eq("a field raises Activate by default", t.ActivatesDefault, false);
        check("so it stays out of the .form",
              !("ActivatesDefault" in t.Serialize().properties),
              JSON.stringify(t.Serialize().properties));

        t.ActivatesDefault = true;
        eq("turning it on reads back", t.ActivatesDefault, true);
        eq("and is saved", t.Serialize().properties.ActivatesDefault, true);
        eq("and it is the property grid's to edit like any other",
           t.PropertyNames().includes("ActivatesDefault"), true);

        t.ActivatesDefault = false;
        eq("and back", t.ActivatesDefault, false);
        t.Delete();
    }

    testIconList() {
        const all = Application.Icons();
        check("the theme offers a list of names", all.length > 0, `${all.length}`);
        check("sorted, because a chooser shows them in order",
              JSON.stringify(all) === JSON.stringify([...all].sort()),
              "not sorted");

        const some = Application.Icons("folder");
        check("and it can be narrowed", some.length > 0 && some.length < all.length,
              `${some.length} of ${all.length}`);
        check("to the ones that contain the text",
              some.every((n) => n.includes("folder")), JSON.stringify(some.slice(0, 3)));

        eq("a text nothing contains gives nothing",
           Application.Icons("no-such-icon-anywhere").length, 0);

        check("and narrowing takes them from the same list",
              some.every((n) => all.includes(n)), JSON.stringify(some.slice(0, 3)));
    }

    testIcons() {
        eq("an icon that does not exist is reported absent",
           Application.HasIcon("bta-no-existe-symbolic"), false);
        eq("and an empty name does not exist either", Application.HasIcon(""), false);
        check("the desktop theme is available",
              Application.HasIcon("document-save") ||
              Application.HasIcon("document-save-symbolic"));

        /* An icon of the project's own icons/ directory is found like any
         * other: the search path is one, whoever put the file there. */
        eq("an icon of the project's own is found",
           Application.HasIcon("bta-probe-plain-symbolic"), true);

        /* The runtime resolves an icon itself rather than handing GTK a name
         * (see bta_image_set_icon), so a size change has to re-resolve it --
         * from here all that is visible is that the name still stands. */
        const img = new Image();
        img.Icon = "bta-probe-plain-symbolic";
        img.Size = 16;
        eq("an Image shows it", img.Icon, "bta-probe-plain-symbolic");
        img.Size = 24;
        eq("and keeps it when the size changes", img.Icon, "bta-probe-plain-symbolic");
        img.Delete();
    }

    /* --- PropertyOptions -------------------------------------------------- */
    /* --- TreeView icons ------------------------------------------------------
     *
     * A node may carry an icon, and one the desktop turns out not to have is
     * dropped rather than drawn as the broken-image glyph -- the same bargain
     * Button.Icon makes. Neither case may disturb the node itself.
     */
    testTreeIcons() {
        const t = new TreeView();

        t.Add("a", "with an icon", "", "folder-symbolic");
        t.Add("b", "without one", "a");
        t.Add("c", "with one that does not exist", "a", "no-such-icon-anywhere");

        eq("a node with an icon is added like any other", t.Count, 3);
        check("nested under the one it named", t.Exists("b") && t.Exists("c"));

        t.Key = "a";
        eq("and keeps its text", t.Text, "with an icon");
        t.Key = "c";
        eq("as does one whose icon is not there", t.Text, "with one that does not exist");

        /* The name is only worth passing if the desktop has it, which is what
         * HasIcon answers -- the tree asks the same question internally. */
        check("an icon the desktop lacks is knowable beforehand",
              Application.HasIcon("no-such-icon-anywhere") === false);

        t.Clear();
        eq("clearing takes them with it", t.Count, 0);
    }

    /* --- TreeView expand / collapse ------------------------------------------
     *
     * The widget used to be open always, because the model was told to
     * autoexpand -- which cannot coexist with closing a node, since it would
     * reopen it. Doing it ourselves is what lets both exist.
     */
    testTreeExpand() {
        const t = new TreeView();

        t.Add("a", "A");
        t.Add("b", "B", "a");
        t.Add("c", "C", "b");        /* three levels: a > b > c */

        eq("a tree opens what it is given by default", t.AutoExpand, true);
        check("so a node added under another is open", t.Expanded("a") && t.Expanded("b"));

        t.CollapseNode("a");
        eq("closing one closes it", t.Expanded("a"), false);
        check("and what is under it is no longer showing at all",
              t.Expanded("b") === false, "b still reports open");
        eq("without losing the nodes", t.Count, 3);

        /* Opening a buried node has to open the way to it, or the answer would
         * be a promise half kept. */
        t.ExpandNode("c");
        check("opening a buried node opens the way to it",
              t.Expanded("a") && t.Expanded("b"), `a=${t.Expanded("a")} b=${t.Expanded("b")}`);

        t.CollapseAll();
        check("CollapseAll closes every level",
              !t.Expanded("a") && !t.Expanded("b"), `a=${t.Expanded("a")} b=${t.Expanded("b")}`);

        t.ExpandAll();
        check("and ExpandAll opens them again",
              t.Expanded("a") && t.Expanded("b"), `a=${t.Expanded("a")} b=${t.Expanded("b")}`);

        /* Selecting reveals: a closed node is not in the flattened list, so
         * without this Key would silently do nothing for a node that exists. */
        t.CollapseAll();
        t.Key = "c";
        eq("selecting a closed node reaches it", t.Key, "c");
        eq("and reports its text", t.Text, "C");
        check("having opened the way", t.Expanded("a") && t.Expanded("b"));

        throws("a key that is not there is refused", () => t.ExpandNode("nope"));
        eq("and Expanded just says no for it", t.Expanded("nope"), false);

        /*
         * **`TreeView` and `TableView` answer these three the same way**, and
         * that is what is being pinned: they reach a node's row through one
         * shared walk now (`bta_treerows.c`) and they expand through one
         * mechanism, where before each had its own. Nothing here is a new
         * promise -- every line was measured against both controls *before* the
         * merge and says what they already did -- which is what makes it a
         * merge and not a change.
         *
         * The third is the one a mechanism is easiest to get wrong on: GTK's
         * own autoexpand re-opens a row when it gains a child, and an explicit
         * `CollapseNode` has to survive until then.
         */
        for (const kind of ["TreeView", "TableView"]) {
            const t = Widget.New(kind);
            if (kind === "TableView") t.Columns = [{ title: "Name" }];

            const put = (key, parent) => (kind === "TableView"
                ? t.Add([key], parent ? { Key: key, Parent: parent } : { Key: key })
                : t.Add(key, key, parent));

            put("leaf");
            eq(`${kind}: a childless node reads as open`, t.Expanded("leaf"), true);

            put("p");
            put("k1", "p");
            t.CollapseNode("p");
            eq(`${kind}: closing one closes it`, t.Expanded("p"), false);
            put("k2", "p");
            eq(`${kind}: and a new child opens it again`, t.Expanded("p"), true);

            const shut = Widget.New(kind);
            if (kind === "TableView") shut.Columns = [{ title: "Name" }];
            shut.AutoExpand = false;
            shut.Add(...(kind === "TableView" ? [["p"], { Key: "p" }] : ["p", "P"]));
            shut.Add(...(kind === "TableView"
                ? [["k"], { Key: "k", Parent: "p" }] : ["k", "K", "p"]));
            eq(`${kind}: with AutoExpand off nothing opens itself`,
               shut.Expanded("p"), false);
        }

        /* Turned off, a tree comes up closed and the application says what to
         * open -- which is what a tree with thousands of nodes needs. */
        const shut = new TreeView();
        shut.AutoExpand = false;
        eq("AutoExpand reads back", shut.AutoExpand, false);

        shut.Add("r", "Root");
        shut.Add("k", "Kid", "r");
        eq("a node added now stays closed", shut.Expanded("r"), false);

        shut.ExpandNode("r");
        eq("until it is opened by name", shut.Expanded("r"), true);

        /*
         * A tree is a widget first: the layout property `Expand` is still the
         * boolean it is everywhere else.  This is not a hypothetical -- naming
         * the method `Expand` shadowed it on the prototype, and then a .form
         * assigning the layout property put a boolean on the instance and the
         * method vanished, which is exactly how it broke.
         */
        const both = new TreeView();
        both.Add("n", "N");
        both.Expand = true;
        eq("Expand on a tree is still the layout boolean", both.Expand, true);
        both.ExpandNode("n");
        eq("and opening a node still works beside it", both.Expanded("n"), true);
        eq("with the boolean untouched", both.Expand, true);
    }

    /* --- context menus -------------------------------------------------------
     *
     * The same spec a form's menu bar is written with, on one widget. Nothing
     * about it is a second kind of menu: the items land on the form by name and
     * dispatch as Name_Click, so a handler cannot tell which one it came from.
     */
    testContextMenu() {
        const p = new Panel();
        p.Name = "CtxHost";
        this.Add(p);

        eq("a widget starts with no menu", p.Menu, undefined);
        throws("Menu refuses what is not a list", () => { p.Menu = "Cut"; });

        p.Menu = [
            { name: "MnuCtxOne", text: "One" },
            { separator: true },
            { name: "MnuCtxSub", text: "More", children: [
                { name: "MnuCtxDeep", text: "Deeper" },
            ] },
        ];

        check("the spec is kept as written", Array.isArray(p.Menu) && p.Menu.length === 3,
              JSON.stringify(p.Menu));
        check("its items are on the form by name", !!this.MnuCtxOne && !!this.MnuCtxDeep);

        /* The proof they are ordinary menu items: Click() and Enabled, the same
         * two things a menu bar item answers to. */
        this.ctxSaid = null;
        this.MnuCtxOne.Click();
        eq("choosing one dispatches Name_Click", this.ctxSaid, "one");

        this.MnuCtxDeep.Click();
        eq("a submenu's item too", this.ctxSaid, "deep");

        this.MnuCtxOne.Enabled = false;
        eq("and Enabled works on it", this.MnuCtxOne.Enabled, false);

        /* Popping it up from code is what a right click does, and is the half
         * of it a test can drive. */
        p.PopupMenu(10, 10);
        check("PopupMenu is answerable before a frame", true);

        /* Reassigning replaces it rather than piling a second popover on the
         * widget, and clearing leaves it with none. */
        p.Menu = [{ name: "MnuCtxTwo", text: "Two" }];
        eq("reassigning replaces the menu", p.Menu.length, 1);
        check("with the new item exposed", !!this.MnuCtxTwo);

        /* A control that has no menu of its own passes the click outwards: a
         * Button handles the press itself, so the event never reaches the
         * container, and without the walk a container's menu would work
         * everywhere except over its own contents.  Whether the popover
         * appears is not answerable from here -- that is verified by hand --
         * but asking for it must reach the right widget and not throw. */
        p.Menu = [{ name: "MnuCtxHost", text: "From the panel" }];
        const inside = new Button();
        inside.Name = "CtxInside";
        p.Add(inside);

        eq("a child has no menu of its own", inside.Menu, undefined);
        inside.PopupMenu(2, 2);   /* resolves to the panel's; must not throw */
        check("asking a child for a menu reaches the container's", true);

        p.Menu = null;
        eq("and null clears it", p.Menu, undefined);
        p.PopupMenu(10, 10);      /* nothing to show; must not throw */
        inside.PopupMenu(2, 2);   /* nor has anything above it now */

        p.Delete();
    }

    MnuCtxOne_Click()  { this.ctxSaid = "one"; }
    MnuCtxDeep_Click() { this.ctxSaid = "deep"; }

    testPropertyOptions() {
        const label = new Label();
        check("an enumerated property declares its values",
              sameJson(label.PropertyOptions("Alignment"), ["Left", "Center", "Right"]),
              JSON.stringify(label.PropertyOptions("Alignment")));

        eq("a free-form one declares nothing", label.PropertyOptions("Text"), null);
        eq("nor does one that does not exist", label.PropertyOptions("Fantasma"), null);

        /* Inherited along the prototype chain, just like the property. */
        check("a container inherits its parent's",
              sameJson(new Panel().PropertyOptions("Arrangement"),
                       ["Fixed", "Horizontal", "Vertical"]),
              JSON.stringify(new Panel().PropertyOptions("Arrangement")));
        check("and so does a form, subclass or not",
              sameJson(this.PropertyOptions("Arrangement"),
                       ["Fixed", "Horizontal", "Vertical"]));

        /* Language and Theme come from GtkSourceView, not from a hand-written
         * list: what matters is that it offers what the setter accepts. */
        const langs = this.Ed.PropertyOptions("Language");
        check("the editor offers the languages it knows",
              langs.includes("js") && langs.includes("json"),
              JSON.stringify(langs && langs.slice(0, 5)));
        check("including the empty one, which is plain text", langs.includes(""));
        check("and the themes installed",
              this.Ed.PropertyOptions("Theme").length > 0);
    }

    /*
     * --- what this build can run -----------------------------------------
     *
     * `Widget.Types()` says which classes there are; this says which of them
     * this *build* can run, which is not the same question and had no word at
     * all. A class whose engine is optional -- `Terminal` without VTE -- is
     * there either way: it constructs, it draws, a `.form` naming one loads,
     * and only the verbs refuse. A palette asks this before it offers a button
     * for it, because a control the user cannot finish is worse than a missing
     * one.
     */
    testAvailable() {
        check("an ordinary control is available", Widget.Available("Button"));
        check("...and so is an abstract class, which is about the build and not"
              + " about whether one can be made", Widget.Available("Widget"));

        /* The optional one, whichever way this build went: what is asserted is
         * that the answer is a boolean and that the class exists regardless --
         * `testTerminal` is where each branch is checked. */
        check("Terminal answers one way or the other",
              typeof Widget.Available("Terminal") === "boolean");
        check("...and is in the list of classes either way",
              Widget.Types().includes("Terminal"));
        eq("...and can still be made, which is what loading a .form needs",
           Widget.New("Terminal").CssNode(), "scrolledwindow");

        /*
         * `Video` is the class whose answer is **asked of the machine** rather
         * than declared at build time: GStreamer can be linked in and its
         * registry still lack the sink, so what is asserted is the agreement
         * and not the value -- a machine with the base plugins and without
         * gst-plugins-rs answers `false`, this build answers `true`, and both
         * are right.
         */
        const video = new Video();
        eq("a Video answers for itself what its class answers",
           video.Available, Widget.Available("Video"));
        check("...which is a boolean either way",
              typeof video.Available === "boolean");
        video.Delete();

        /* A class of the project's own is JavaScript, and JavaScript this
         * runtime can always run. */
        check("a component of the project is available too",
              Widget.Available("Gadgets.Stepper"));

        /* And a name that is nothing at all answers rather than throwing: what
         * a caller does with the answer is skip a button, and wrapping that in
         * a try is the wrong shape. */
        check("a name that is no class at all is not available",
              !Widget.Available("Nonsense"));
        throws("...where Widget.New on the same name throws",
               () => Widget.New("Nonsense"));
    }

    /* --- which properties hold prose ------------------------------------ */
    testTextProperties() {
        const btn = new Button();
        check("a control declares the properties that hold prose",
              sameJson(btn.TextProperties().sort(), ["Text", "Tooltip"]),
              JSON.stringify(btn.TextProperties()));

        /* Accumulated along the chain, not first-match: Tooltip is Widget's and
         * Text is the Button's, and both have to come back.  This is where it
         * differs from PropertyOptions. */
        check("including the base class's, on a control that declares none of its own",
              new Image().TextProperties().includes("Tooltip"),
              JSON.stringify(new Image().TextProperties()));

        check("a list of strings a person reads counts",
              new ComboBox().TextProperties().includes("Items"));
        check("and a notebook's tab labels",
              new Notebook().TextProperties().includes("Tabs"));
        check("and a text field's placeholder",
              new TextBox().TextProperties().includes("Placeholder"));

        /*
         * The one that this whole mechanism exists for.  A SourceEditor's Text is
         * the source file being edited: a catalogue holding a line of it would
         * rewrite the user's code, in one language and no other.  So prose is
         * declared per class and never deduced from the name.
         */
        check("a SourceEditor's Text is source code and not prose",
              !this.Ed.TextProperties().includes("Text"),
              JSON.stringify(this.Ed.TextProperties()));
        check("but its tooltip still is", this.Ed.TextProperties().includes("Tooltip"));

        /*
         * **And the plain editor beside it says the opposite**, which is what the
         * abstract `Editor` between them is for: `texts` accumulates down the
         * class chain, so if the source editor's parent were `TextEditor` it
         * would inherit exactly the declaration above and a catalogue would
         * rewrite somebody's code. Siblings can disagree; a child cannot
         * disagree with its parent. Asserted as a pair, because the value of
         * either answer is that the other one differs.
         */
        const memo = new TextEditor();
        check("a plain TextEditor's Text is prose",
              memo.TextProperties().includes("Text"),
              JSON.stringify(memo.TextProperties()));
        check("and the two editors disagree about it, which is the point",
              memo.TextProperties().includes("Text") !==
              this.Ed.TextProperties().includes("Text"));
        memo.Delete();

        eq("a placeholder round-trips", (() => {
            const t = new TextBox();
            t.Placeholder = "escriba";
            return t.Placeholder;
        })(), "escriba");
    }

    /* --- the catalogue -------------------------------------------------- */
    testLocale() {
        eq("no catalogue is in use by default", Locale.Current, "");
        check("but the project's are listed", Locale.Available.includes("zz"),
              JSON.stringify(Locale.Available));
        eq("an untranslated text is itself", Locale.Text("Name:"), "Name:");

        throws("a locale with no .po is refused", () => { Locale.Current = "qq"; });

        Locale.Current = "zz";
        try {
            eq("in use", Locale.Current, "zz");
            eq("a text is translated", Locale.Text("Name:"), "NOMBRE:");
            eq("one the catalogue lacks is itself", Locale.Text("Nowhere"), "Nowhere");
            eq("an entry with an empty msgstr is untranslated, not blank",
               Locale.Text("Untranslated"), "Untranslated");
            eq("a fuzzy entry is not used", Locale.Text("Guessed"), "Guessed");
            eq("an obsolete one is not in the catalogue at all",
               Locale.Text("Gone"), "Gone");
            eq("escapes are unescaped",
               Locale.Text('Quote "inside"'), 'Cita "adentro"');
            eq("a msgid split over lines is joined",
               Locale.Text("a long one split over lines"), "uno largo partido en lineas");

            /* Positional, so a translator can move the holes -- which this
             * catalogue does: the entry reads "{1} sin guardar de {0}". */
            eq("arguments are interpolated",
               Locale.Text("{0} files, {1} unsaved", 12, 2), "2 sin guardar de 12");
            eq("and reordered by the translation, not by the caller",
               Locale.Text("{0} files, {1} unsaved", "A", "B"), "B sin guardar de A");
            eq("a hole nobody filled says so rather than vanishing",
               Locale.Text("{0} files, {1} unsaved", 12), "{1} sin guardar de 12");
            eq("a brace that is not a hole is text",
               Locale.Text("{a} y {0}", 1), "{a} y 1");

            eq("a context picks its own entry",
               Locale.Context("verb", "Open"), "Abrir");
            eq("and the same word with no context picks the other",
               Locale.Text("Open"), "Abierto");
            eq("a context nobody declared falls back to the text",
               Locale.Context("noun", "Open"), "Open");

            /*
             * The plural rule comes out of the catalogue's own Plural-Forms
             * header, which is a C expression over n -- there is no way around
             * evaluating it, and `eval` is not part of this language.  This one
             * is the Slavic three-form rule.
             */
            eq("plural form 0", Locale.Plural("{0} file", "{0} files", 1), "1 archivo");
            eq("plural form 1", Locale.Plural("{0} file", "{0} files", 2), "2 archivoj");
            eq("plural form 2", Locale.Plural("{0} file", "{0} files", 5), "5 archivojn");
            eq("11 is not 1 in this rule",
               Locale.Plural("{0} file", "{0} files", 11), "11 archivojn");
            eq("21 is", Locale.Plural("{0} file", "{0} files", 21), "21 archivo");
            eq("22 takes the second form",
               Locale.Plural("{0} file", "{0} files", 22), "22 archivoj");
            eq("and 25 the third",
               Locale.Plural("{0} file", "{0} files", 25), "25 archivojn");
            eq("n fills {0} without being passed twice",
               Locale.Plural("{0} file", "{0} files", 3), "3 archivoj");
        } finally {
            Locale.Current = "";
        }
        eq("cleared", Locale.Current, "");
        eq("and nothing is translated again", Locale.Text("Name:"), "Name:");

        /* With no catalogue the two forms the caller wrote are all there is,
         * which is English's rule and the only honest answer. */
        eq("plural with no catalogue, one", Locale.Plural("{0} file", "{0} files", 1),
           "1 file");
        eq("plural with no catalogue, many", Locale.Plural("{0} file", "{0} files", 3),
           "3 files");
    }

    /* --- reading a catalogue as data ------------------------------------ */
    testLocaleRead() {
        const path = File.Join(Application.Directory, "po/zz.po");
        const es   = Locale.Read(path);

        check("a catalogue reads back as entries", es.length > 10, `${es.length}`);

        /* The header is entry zero and an ordinary entry, which is what makes
         * writing the file back one loop with no special case. */
        const header = es.find((e) => e.msgid === "");
        check("the header is an entry like any other",
              header && /nplurals=3/.test(header.forms[0]),
              header && header.forms[0]);

        /*
         * What the catalogue reading throws away, this keeps -- and that is the
         * whole point: an editor that loses what it does not understand destroys
         * a translator's work the first time it saves.
         */
        const fuzzy = es.find((e) => e.msgid === "Guessed");
        check("a fuzzy entry is kept, flag and all",
              fuzzy && fuzzy.flags.includes("fuzzy") && fuzzy.forms[0] === "NO USAR",
              JSON.stringify(fuzzy));

        const empty = es.find((e) => e.msgid === "Untranslated");
        check("and so is an untranslated one",
              empty && empty.forms[0] === "", JSON.stringify(empty));

        const plural = es.find((e) => e.msgid === "{0} file");
        check("a plural carries its second msgid and every form",
              plural && plural.plural === "{0} files" && plural.forms.length === 3,
              JSON.stringify(plural));

        const ctxt = es.find((e) => e.ctxt === "verb");
        check("a context is its own entry", ctxt && ctxt.msgid === "Open",
              JSON.stringify(ctxt));
        check("and the same msgid with no context is another",
              es.some((e) => e.msgid === "Open" && e.ctxt === undefined));

        check("comments are kept as written",
              es.some((e) => e.comments.some((c) => c.startsWith("# Reordered"))));

        /*
         * The `#~` tail a merge leaves behind is deliberately *not* modelled:
         * it rides along as comment lines on a block whose msgid is null, which
         * is lossless and costs nothing.  Having a shape for that block is what
         * makes writing the file back exact rather than approximate.
         */
        const tail = es[es.length - 1];
        check("an obsolete block comes back as raw lines with no msgid",
              tail.msgid === null &&
              tail.comments.some((c) => c.startsWith("#~ msgid")),
              JSON.stringify(tail));

        throws("a file that is not there says so", () => Locale.Read("/nope/x.po"));

        /* Reading is not using: the catalogue in force is untouched. */
        eq("reading a catalogue does not put it in use", Locale.Current, "");
    }

    /* --- a .form through the catalogue ---------------------------------- */
    testTranslatedForm() {
        Locale.Current = "zz";
        let t;
        try {
            /* Constructing runs the real C loader, which is the path under test
             * -- a form built by AddNode would prove only rad.js's half. */
            t = new Translated();

            eq("declared prose is translated on load", t.Lbl.Text, "NOMBRE:");
            eq("so is a tooltip", t.Lbl.Tooltip, "el nombre del cliente");
            eq("so is a placeholder", t.Txt.Placeholder, "escriba aqui");
            check("and every entry of a list of strings",
                  sameJson(t.Cmb.Items, ["Minorista", "Mayorista"]),
                  JSON.stringify(t.Cmb.Items));

            /* The two negative cases, which matter more than the positive ones. */
            eq("a Style that happens to be a msgid is untouched",
               t.LblStyled.Style, "heading");
            eq("a SourceEditor's source text is not prose", t.Ed.Text, "Name:");
            eq("though its tooltip is", t.Ed.Tooltip, "escriba aqui");
            /* The same declaration on the plain editor, which is prose: the two
             * classes are siblings so that they can disagree about this. */
            eq("a plain TextEditor's text is prose and is translated",
               t.Memo.Text, "NOMBRE:");

            /*
             * The trap this had to be built around.  The serialiser reads the
             * *current* value of every property, so without a note a form opened
             * in another language and saved would come back with the translation
             * in it and the original gone -- the Width/Height trap wearing a
             * different hat.
             */
            /* Each control on its own: a Component serialises as a black box --
             * what is inside it belongs to its own .form -- so its children are
             * not in its node. */
            const lbl = t.Lbl.Serialize(false);
            eq("saving writes back what the file said, not what is on screen",
               lbl.properties.Text, "Name:");
            eq("and the tooltip too", lbl.properties.Tooltip, "the customer's name");

            const cmb = t.Cmb.Serialize(false);
            check("a translated list is written back untranslated",
                  sameJson(cmb.properties.Items, ["Retail", "Wholesale"]),
                  JSON.stringify(cmb.properties.Items));
            const txt = t.Txt.Serialize(false);
            eq("and so is a placeholder", txt.properties.Placeholder, "type here");

            eq("Declared says what the file said", t.Lbl.Declared("Text"), "Name:");
            eq("and a property nothing substituted is simply itself",
               t.Lbl.Declared("Style"), "");

            /*
             * ...and the note is only believed while what was applied is still
             * what is there.  An edit is the newer truth, so the property grid
             * never has to tell the serialiser it changed something.
             */
            t.Lbl.Text = "Otra cosa";
            eq("an assignment since load wins over the note",
               t.Lbl.Serialize(false).properties.Text, "Otra cosa");
        } finally {
            Locale.Current = "";
            if (t) t.Delete();
        }
    }

    /* --- Fill: the template stays in the .form -------------------------- */
    testFill() {
        Locale.Current = "zz";
        let t;
        try {
            t = new Translated();
            eq("the template is translated on load, holes and all",
               t.LblCount.Text, "{1} sin guardar de {0}");

            t.LblCount.Fill(12, 2);
            eq("Fill puts the arguments in the translated template",
               t.LblCount.Text, "2 sin guardar de 12");

            /* Twice, which is the reason Fill re-reads the declared template
             * instead of keeping one: otherwise the second call would fill in
             * the first one's output. */
            t.LblCount.Fill(7, 1);
            eq("and again, without eating its own output",
               t.LblCount.Text, "1 sin guardar de 7");

            eq("the declared template survives being filled",
               t.LblCount.Declared("Text"), "{0} files, {1} unsaved");
            eq("so a save still writes the template",
               t.LblCount.Serialize(false).properties.Text,
               "{0} files, {1} unsaved");
        } finally {
            Locale.Current = "";
            if (t) t.Delete();
        }

        /* And with no catalogue at all, which is most projects. */
        const lbl = new Label();
        this.Add(lbl);
        lbl.Text = "{0} de {1}";
        lbl.Fill(3, 9);
        eq("Fill works with no catalogue", lbl.Text, "3 de 9");
        lbl.Delete();
    }

    /* --- design values -------------------------------------------------- */
    testDesignValues() {
        /*
         * A design value is what the *designer* shows so a form whose text the
         * code fills in can still be laid out.  The runtime must never apply
         * one, and that is structural rather than a check: the only code that
         * reads the `design` block is AddNode's designing branch, and the C
         * loader has no idea the key exists.
         */
        const t = new Translated();
        eq("the runtime ignores the design block", t.LblCount.Text,
           "{0} files, {1} unsaved");
        eq("and reports no design value", t.LblCount.DesignValue("Text"), undefined);
        t.Delete();

        /* The designer's path: build the same node with designing on. */
        const host = new Panel();
        host.Arrangement = "Vertical";
        this.Add(host);

        const node = {
            type: "Label", name: "L1",
            properties: { Text: "{0} files" },
            design:     { Text: "12 files" },
        };
        const drawn = host.AddNode(node, true);
        eq("the designer shows the design value", drawn.Text, "12 files");
        eq("while the declared one is still the template",
           drawn.Declared("Text"), "{0} files");
        eq("and it says which it is showing", drawn.DesignValue("Text"), "12 files");

        const back = drawn.Serialize(false);
        eq("saving writes the real value to properties", back.properties.Text,
           "{0} files");
        eq("and the design value to its own block", back.design.Text, "12 files");

        /* Setting one from the grid, and taking it away again. */
        drawn.SetDesign("Text", "otra muestra");
        eq("a design value set later is shown", drawn.Text, "otra muestra");
        eq("without disturbing the declared one", drawn.Declared("Text"), "{0} files");
        eq("and is what gets saved", drawn.Serialize(false).design.Text,
           "otra muestra");

        drawn.SetDesign("Text", "");
        eq("clearing it puts the declared value back", drawn.Text, "{0} files");
        eq("and writes no design block at all",
           drawn.Serialize(false).design, undefined);

        /* Prose is left alone while designing: a designer that translated would
         * show one language and save another. */
        Locale.Current = "zz";
        try {
            const plain = host.AddNode({ type: "Label", name: "L2",
                                         properties: { Text: "Name:" } }, true);
            eq("the designer shows what the file says, not the translation",
               plain.Text, "Name:");
            const running = host.AddNode({ type: "Label", name: "L3",
                                          properties: { Text: "Name:" } });
            eq("while an application building the same node gets the translation",
               running.Text, "NOMBRE:");
            eq("and still saves the original",
               running.Serialize(false).properties.Text, "Name:");
        } finally {
            Locale.Current = "";
        }
        host.Delete();
    }

    /* --- File ----------------------------------------------------------- */
    testFile() {
        Directory.Make(SCRATCH);
        const path = File.Join(SCRATCH, "a.txt");

        File.Save(path, "hola\nmundo\n");
        eq("Save then Load", File.Load(path), "hola\nmundo\n");
        eq("Exists finds it", File.Exists(path), true);
        eq("a file is not a dir", File.IsDir(path), false);
        eq("the dir is a dir", File.IsDir(SCRATCH), true);

        eq("Name", File.Name("/x/y/z.js"), "z.js");
        eq("Dir", File.Directory("/x/y/z.js"), "/x/y");
        eq("Ext", File.Extension("/x/y/z.js"), "js");
        eq("BaseName", File.BaseName("/x/y/z.js"), "z");
        eq("Ext of an extensionless name", File.Extension("/x/y/z"), "");
        eq("a dotted directory does not fake an extension",
           File.Extension("/x.y/z"), "");
        eq("Join", File.Join("a", "b", "c.js"), "a/b/c.js");

        /* UTF-8 has to survive the round trip byte for byte. */
        File.Save(path, "ñandú — ok\n");
        eq("utf-8 round-trip", File.Load(path), "ñandú — ok\n");

        const moved = File.Join(SCRATCH, "b.txt");
        File.Rename(path, moved);
        eq("Rename moves the file", File.Exists(moved), true);
        eq("and leaves nothing behind", File.Exists(path), false);
        eq("with its contents intact", File.Load(moved), "ñandú — ok\n");

        /* Renaming over an existing file would lose it without a word. */
        File.Save(path, "otro");
        throws("Rename refuses to clobber", () => File.Rename(path, moved));
        eq("so the target survives", File.Load(moved), "ñandú — ok\n");
        File.Delete(moved);

        File.Delete(path);
        eq("Delete removes it", File.Exists(path), false);

        throws("loading a missing file throws", () => File.Load(File.Join(SCRATCH, "nope")));
        eq("Exists on a missing file is false", File.Exists("/no/such/path"), false);
    }

    /* --- Dir ------------------------------------------------------------ */
    testDir() {
        const sub = File.Join(SCRATCH, "deep/deeper");
        Directory.Make(sub);
        eq("Make creates parents too", File.IsDir(sub), true);

        File.Save(File.Join(SCRATCH, "one.js"), "1");
        File.Save(File.Join(SCRATCH, "two.js"), "2");
        File.Save(File.Join(SCRATCH, "three.form"), "3");

        const all = Directory.List(SCRATCH);
        check("List finds the files", all.includes("one.js") && all.includes("three.form"),
              JSON.stringify(all));
        check("List is sorted", JSON.stringify(all) === JSON.stringify([...all].sort()),
              JSON.stringify(all));

        const js = Directory.List(SCRATCH, "*.js");
        eq("List filters by pattern", JSON.stringify(js), JSON.stringify(["one.js", "two.js"]));

        throws("listing a missing dir throws", () => Directory.List("/no/such/dir"));

        /* --- Files and Folders: full paths, and as deep as asked -------------
         *
         * `List` answers one level as names; these answer paths, which is what
         * a walk needs -- two directories down a bare name no longer says where
         * the file is. The hand-written walk they replace was in three tools of
         * this repository, which is three chances to get the symlink case wrong.
         */
        const here = Directory.Files(SCRATCH);
        check("Files gives full paths",
              here.every((p) => p.startsWith(`${SCRATCH}/`)), JSON.stringify(here));
        check("and only files", !here.some((p) => File.IsDir(p)), JSON.stringify(here));
        check("leaving the directories to Folders",
              Directory.Folders(SCRATCH).includes(File.Join(SCRATCH, "deep")),
              JSON.stringify(Directory.Folders(SCRATCH)));

        eq("a bare string is the pattern",
           JSON.stringify(Directory.Files(SCRATCH, "*.js").map((p) => File.Name(p))),
           JSON.stringify(["one.js", "two.js"]));

        /* One level unless asked, which is the same bargain `List` makes. */
        check("shallow by default",
              !Directory.Files(SCRATCH).some((p) => p.includes("/deep/")),
              JSON.stringify(Directory.Files(SCRATCH)));
        File.Save(File.Join(sub, "buried.txt"), "hondo");
        check("and as deep as asked",
              Directory.Files(SCRATCH, { Pattern: "buried.txt", Recursive: true })
                  .includes(File.Join(sub, "buried.txt")));
        check("Folders recurses too",
              Directory.Folders(SCRATCH, { Recursive: true }).includes(sub),
              JSON.stringify(Directory.Folders(SCRATCH, { Recursive: true })));

        /* Sorted and depth-first, so two runs of a tool that walks a tree print
         * the same thing in the same order -- otherwise a diff of its output is
         * worthless. */
        const deep = Directory.Files(SCRATCH, { Recursive: true });
        check("a walk is repeatable",
              JSON.stringify(deep) === JSON.stringify(Directory.Files(SCRATCH, { Recursive: true })),
              JSON.stringify(deep));

        /*
         * A symlinked file counts and a symlinked directory is not entered --
         * `find` and `os.walk` both default to this, because a link to a parent
         * is a loop. An icon theme is mostly symlinked files, so getting the
         * first half wrong would lose most of a theme.
         */
        const linkDir = File.Join(SCRATCH, "links");
        Directory.Make(linkDir);
        Exec(["ln", "-sfn", File.Join(SCRATCH, "one.js"), File.Join(linkDir, "linked.js")],
             null,
             () => Exec(["ln", "-sfn", SCRATCH, File.Join(linkDir, "loop")], null, () => {
                 const found = Directory.Files(linkDir, { Recursive: true });
                 check("a symlinked file is a file",
                       found.includes(File.Join(linkDir, "linked.js")), JSON.stringify(found));
                 check("and a symlinked directory is not walked into",
                       !found.some((p) => p.includes("/loop/")), JSON.stringify(found));
                 check("though it is listed as a folder",
                       Directory.Folders(linkDir).includes(File.Join(linkDir, "loop")));
                 waiting--;
             }));
        waiting++;

        throws("Files needs a directory", () => Directory.Files("/no/such/dir"));

        /* --- copying a folder ------------------------------------------------
         *
         * GIO has no recursive copy -- `g_file_copy` is one file -- so the walk
         * is the feature, and what it has to get right is the *shape*: a tree
         * that arrives flat, or missing what was two levels down, is a backup
         * that is not one.
         */
        File.Save(File.Join(sub, "buried.txt"), "hondo");

        const copy = File.Join(SCRATCH, "copia");
        Directory.Copy(File.Join(SCRATCH, "deep"), copy);

        check("a folder is copied with what is in it",
              File.IsDir(File.Join(copy, "deeper")));
        eq("...however deep that is",
           File.Load(File.Join(copy, "deeper", "buried.txt")), "hondo");
        throws("and copying onto something that is there is refused",
               () => Directory.Copy(File.Join(SCRATCH, "deep"), copy));

        /* --- and the two deletes ---------------------------------------------
         *
         * One word apart on purpose: a recursive delete behind an innocent name
         * is how a wrong path becomes a lost afternoon. `Delete` takes a folder
         * with nothing left in it, which is the operation a program actually
         * reaches for, and says so when it is not that.
         */
        throws("deleting a folder with something in it is refused",
               () => Directory.Delete(copy));
        check("and it is still there", File.IsDir(copy));

        Directory.DeleteTree(copy);
        check("the one that says it takes everything, does",
              !File.Exists(copy));

        const empty = File.Join(SCRATCH, "vacia");
        Directory.Make(empty);
        Directory.Delete(empty);
        check("an empty one goes with the plain word", !File.Exists(empty));

        throws("and a file handed to the recursive one is a computed path gone "
               + "wrong, not a job",
               () => Directory.DeleteTree(File.Join(SCRATCH, "one.js")));
        check("so it is still there", File.Exists(File.Join(SCRATCH, "one.js")));
    }

    /* --- the desktop's undo for a delete ------------------------------------
     *
     * A trash lives on the filesystem the file is on, and this suite writes to
     * `/tmp` -- which on this machine is tmpfs and has none. So what is pinned
     * here is the half that matters for a program: **it says it could not**
     * rather than quietly deleting, which is the one thing a `Trash` must never
     * do. The other half is the desktop's own code path and is exercised by
     * using the IDE on a project in a home directory.
     */
    testTrash() {
        Directory.Make(SCRATCH);
        const doomed = File.Join(SCRATCH, "trash-me.txt");
        File.Save(doomed, "hola");

        let said = "";
        try {
            File.Trash(doomed);
        } catch (e) {
            said = e.message;
        }

        if (said) {
            check("with no trash on this filesystem it says so", said.includes(doomed),
                  said);
            check("and the file is left where it was, not deleted behind one's back",
                  File.Exists(doomed), said);
            File.Delete(doomed);
        } else {
            check("where there is a trash, the file leaves its place",
                  !File.Exists(doomed));
        }

        throws("and it needs a path", () => File.Trash());
    }

    /* --- Environment ----------------------------------------------------- */
    testEnvironment() {
        check("a variable that is not set answers null",
              Environment.Get("BTA_NOT_A_VARIABLE") === null);

        Environment.Set("BTA_TEST_VAR", "puesta");
        eq("Set then Get", Environment.Get("BTA_TEST_VAR"), "puesta");
        check("and Variables shows it",
              Environment.Variables.BTA_TEST_VAR === "puesta");
        check("along with the rest of the environment",
              Dictionary.Keys(Environment.Variables).length > 1);

        Environment.Set("BTA_TEST_VAR", null);
        check("null takes it away", Environment.Get("BTA_TEST_VAR") === null);

        throws("Get needs a name", () => Environment.Get());
        throws("Set needs a name", () => Environment.Set());

        /* The directory the process is in, which is the one fact here that
         * moves -- so it is the one asked twice. */
        const was = Environment.CurrentDirectory;
        check("there is a current directory", was.length > 0 && was.startsWith("/"));

        Directory.Make(SCRATCH);
        Environment.CurrentDirectory = SCRATCH;
        eq("entering a directory moves there", Environment.CurrentDirectory, SCRATCH);
        check("and a relative path resolves against it",
              File.Absolute("stamp.txt") === File.Join(SCRATCH, "stamp.txt"),
              File.Absolute("stamp.txt"));

        /* Refused and not ignored: a directory that was never entered would
         * leave every relative path after it pointing somewhere else. */
        throws("entering a directory that is not there is an error",
               () => { Environment.CurrentDirectory = File.Join(SCRATCH, "no-such-dir"); });
        eq("and it stayed where it was", Environment.CurrentDirectory, SCRATCH);

        Environment.CurrentDirectory = was;

        /* The suite runs on a display -- the desktop's, or the one xvfb-run
         * made -- so this is true here and false in a console project, which is
         * what testConsoleProject checks from the other side. */
        check("the suite has a display", Environment.HasDisplay === true);

        check("the process has an id", Environment.ProcessId > 0);
        check("and knows how wide to build", Environment.ProcessorCount >= 1);
        check("the machine has a name", Environment.HostName.length > 0);
        check("the user has one too", Environment.UserName.length > 0);
        check("home is a path", Environment.HomeDirectory.startsWith("/"));
        check("temp is a path", Environment.TempDirectory.startsWith("/"));
        check("the system says what it is", Environment.OS.length > 0, Environment.OS);
        check("and which release", Environment.OSVersion.length > 0);

        /* What the IDE's completion asks of every global it offers: a member
         * nobody can enumerate is a member it cannot propose. */
        const members = Dictionary.Keys(Environment);
        for (const name of ["Get", "Set", "Variables", "CurrentDirectory",
                            "HasDisplay", "ProcessId", "HomeDirectory", "OS"]) {
            check(`Environment.${name} is enumerable`, members.includes(name),
                  JSON.stringify(members));
        }
    }

    /* --- the user's own menu entries ----------------------------------------
     *
     * `Desktop.Entries` writes a `.desktop` file into the user's applications
     * directory, which is `$XDG_DATA_HOME/applications` -- and **the runner
     * points `XDG_DATA_HOME` at a scratch directory** (tests/runner/Main.js), so
     * the entry that goes in here is not one anybody's menu will offer. Run by
     * hand with `tests/try.sh` there is no such promise, which is why the ids
     * are uninstalled before they are installed: the test cleans up after
     * itself either way.
     *
     * **The file is not the thing worth asserting.**  A `.desktop` is a
     * key-file with a quoting of its own, and what can go wrong is not that the
     * string was written but that the desktop's reader does not understand it.
     * So the entry installed at the end runs a script through `gio launch` --
     * a real `GDesktopAppInfo`, the same road a menu takes -- and the arguments
     * it receives are read back from the file it wrote: a space, a percent, a
     * double quote, a dollar, a backslash and an accent, all in one command.
     */
    testDesktop() {
        check("the data directory is a path", Desktop.DataDirectory.startsWith("/"),
              Desktop.DataDirectory);
        eq("and the entries live under it", Desktop.Entries.Directory,
           File.Join(Desktop.DataDirectory, "applications"));
        check("which is there", File.IsDir(Desktop.Entries.Directory));

        const id = "bta-test-entry";

        /* Left over from a run that was not the runner's, or from a crash: not
         * this test's business to keep, and not a state it may read. */
        Desktop.Entries.Uninstall(id);
        check("nothing is installed under this name",
              !Desktop.Entries.Installed().includes(id));
        eq("and reading one that is not there answers null",
           Desktop.Entries.Read(id), null);

        /* The command line, which is the desktop entry format's quoting and not
         * the shell's -- and which is why this is a verb and not a line in an
         * application. */
        eq("a command line is quoted and escaped the format's way",
           Desktop.Entries.Exec(["a b", "100%", 'a"b', "a$b", "a\\b", "café"]),
           "\"a b\" \"100%%\" \"a\\\"b\" \"a\\$b\" \"a\\\\b\" \"café\"");
        eq("a command with no arguments is the empty string",
           Desktop.Entries.Exec([]), "");

        const exec = Desktop.Entries.Exec(["/bin/true"]);
        const path = Desktop.Entries.Install(id, {
            "Desktop Entry": {
                Type:       "Application",
                Name:       "Bta test",
                "Name[es]": "Prueba",
                Comment:    "an entry the suite installs",
                Exec:       exec,
                Icon:       "applications-development",
            },
        });

        check("installing answers where it went", path.endsWith(`/${id}.desktop`), path);
        check("and writes a file there", File.Exists(path));
        check("which shows up as installed", Desktop.Entries.Installed().includes(id));

        const read = Desktop.Entries.Read(id);
        eq("what comes back is the group that went in",
           read["Desktop Entry"].Name, "Bta test");
        eq("with the localized keys as the ordinary keys they are",
           read["Desktop Entry"]["Name[es]"], "Prueba");
        eq("and the command exactly as it was given",
           read["Desktop Entry"].Exec, exec);

        if (Application.HasCommand("desktop-file-validate")) {
            const r = Exec.Wait(["desktop-file-validate", path],
                                { Timeout: 20000, Stderr: "separate" });
            eq("and the specification's own checker accepts it", r.ExitCode, 0,
               r.Output + r.Errors);
        } else {
            print("no desktop-file-validate: the entry is installed but unvalidated");
        }

        /* Everything the desktop would ignore in silence is refused here, where
         * there is a sentence to read. */
        throws("an id that could be a path is refused",
               () => Desktop.Entries.Install("a/b", {}));
        throws("an id that is a file name is refused",
               () => Desktop.Entries.Install("x.desktop", {}));
        throws("an entry with no [Desktop Entry] group is refused",
               () => Desktop.Entries.Install("bta-bad", { "Other": { Name: "x" } }));
        throws("an application with no Exec is refused",
               () => Desktop.Entries.Install("bta-bad",
                       { "Desktop Entry": { Type: "Application", Name: "x" } }));
        throws("a value that is not text is refused",
               () => Desktop.Entries.Install("bta-bad",
                       { "Desktop Entry": { Type: "Link", Name: 5 } }));
        throws("Read needs an id", () => Desktop.Entries.Read());
        throws("Exec needs an array", () => Desktop.Entries.Exec("nope"));
        throws("and refuses an argument that is not text",
               () => Desktop.Entries.Exec([7]));
        throws("Uninstall needs an id", () => Desktop.Entries.Uninstall());
        check("and none of those wrote anything",
              !File.Exists(File.Join(Desktop.Entries.Directory, "bta-bad.desktop")));

        /* And a file the runtime did not write, holding a value the key file's
         * syntax cannot express: reading it is refused, naming the key, rather
         * than answered with half of itself.  The parser is GLib's and it is
         * the same one the desktop reads a menu with. */
        const broken = File.Join(Desktop.Entries.Directory, "bta-broken.desktop");
        File.Save(broken, "[Desktop Entry]\nType=Application\nName=a\\qb\nExec=/bin/true\n");
        throws("a value with an escape the format has not got is refused",
               () => Desktop.Entries.Read("bta-broken"));
        File.Delete(broken);

        eq("uninstalling says it was there",
           Desktop.Entries.Uninstall(id), true);
        check("and the file is gone", !File.Exists(path));
        eq("uninstalling it again says it was not",
           Desktop.Entries.Uninstall(id), false);

        /*
         * And the round trip through the desktop's own launcher, which is the
         * claim the whole verb exists for.  A script is written (with a space in
         * its name, and a space in the directory above it) that dumps its
         * arguments to a file, and the entry that runs it is installed and
         * launched.  The file is not read here: the process `gio` starts is
         * somebody else's and has not run yet, so an `until` waits for it -- and
         * `finish` waits for that, which is what keeps a launch that never
         * happened from reading as a smaller total.
         */
        if (!Application.HasCommand("gio")) {
            print("no gio: the entry is written but nothing launched it");
            return;
        }

        const probe = "bta-desktop-probe";
        const dir   = File.Join(SCRATCH, "desktop probe");
        const argv  = File.Join(dir, "argv probe.sh");
        const said  = File.Join(dir, "argv.txt");

        Desktop.Entries.Uninstall(probe);
        Directory.Make(dir);
        if (File.Exists(said)) File.Delete(said);
        File.Save(argv, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + said + "\"\n");
        Exec.Wait(["chmod", "+x", argv], { Timeout: 20000 });

        Desktop.Entries.Install(probe, {
            "Desktop Entry": {
                Type:     "Application",
                Name:     "Bta probe",
                Exec:     Desktop.Entries.Exec([argv, "a b", "100%", 'a"b', "a$b", "a\\b", "café"]),
                Terminal: "false",
            },
        });

        const launched = Exec.Wait(
            ["gio", "launch", File.Join(Desktop.Entries.Directory, probe + ".desktop")],
            { Timeout: 20000, Stderr: "separate" });
        eq("gio launches the entry", launched.ExitCode, 0,
           launched.Output + launched.Errors);

        until("the launched command wrote its arguments", () => File.Exists(said), () => {
            eq("and they are exactly what was asked for",
               File.Load(said), "a b\n100%\na\"b\na$b\na\\b\ncafé\n");
            Desktop.Entries.Uninstall(probe);
        });
    }

    /* --- Shortcut ------------------------------------------------------------
     *
     * The keys that press a control, declared where the control is.  `shortcut`
     * is the word a menu item has had since menus existed, and this is the same
     * word one widget further out -- the question is the same one: **which key
     * means this command**.
     *
     * What cannot be asserted here is a key actually arriving: that needs a real
     * X server and xdotool, and `examples/calculator` is driven that way by hand.
     * What is asserted is everything up to it -- what the property accepts, what
     * it refuses, and that it round-trips into a `.form`.
     */
    testShortcut() {
        const b = new Button();
        this.Fixed1.Add(b);

        eq("a control starts with none", b.Shortcut, "");

        b.Shortcut = "F5";
        eq("one accelerator comes back as itself", b.Shortcut, "F5");

        b.Shortcut = ["7", "KP_7"];
        check("a list comes back as a list", Array.isArray(b.Shortcut), b.Shortcut);
        eq("...with what was written in it", b.Shortcut.join(), "7,KP_7");

        /* A list of one is a string on the way back, so a `.form` round-trips
         * whichever way it was written. */
        b.Shortcut = ["Escape"];
        eq("a list of one is text again", b.Shortcut, "Escape");

        b.Shortcut = "";
        eq("and the empty answer takes them away", b.Shortcut, "");
        b.Shortcut = ["<Control>s", "<Control><Shift>s"];
        b.Shortcut = null;
        eq("as does nothing at all", b.Shortcut, "");

        /* The three spellings GTK accepts, so a modifier is not a special case
         * for the caller. */
        for (const accel of ["<Control>s", "<Control><Shift>n", "F11", "KP_Enter",
                             "period", "asterisk"]) {
            b.Shortcut = accel;
            eq(`${accel} is an accelerator`, b.Shortcut, accel);
        }

        /*
         * Refused with the offending value, as every setter here does -- and
         * refused **before** the old ones are taken away, so a typo leaves the
         * control with the keys it had rather than with none.
         */
        b.Shortcut = "F6";
        for (const [what, bad] of [["a word that is not a key", "banana"],
                                   ["an empty modifier", "<Nonsense>x"],
                                   ["a number", 7]]) {
            let complaint = "";
            try {
                b.Shortcut = bad;
            } catch (e) {
                complaint = e.message;
            }
            check(`refuses ${what}`, complaint.includes("Shortcut"), complaint);
        }
        eq("and a refused one leaves the old keys alone", b.Shortcut, "F6");

        /* It is a Widget property, so everything has it -- and what it does is
         * activate, which is what each kind already means by being pressed. */
        const chk = new CheckButton();
        this.Fixed1.Add(chk);
        chk.Shortcut = "<Control>t";
        eq("a CheckButton takes one too", chk.Shortcut, "<Control>t");

        /* It serialises like any other settable property, which is what makes it
         * something the designer could offer. */
        b.Shortcut = ["7", "KP_7"];
        const node = b.Serialize();
        check("it reaches a .form node",
              sameJson(node.properties.Shortcut, ["7", "KP_7"]),
              JSON.stringify(node.properties.Shortcut));

        b.Delete();
        chk.Delete();
    }

    /* --- Decimal ------------------------------------------------------------
     *
     * Exact base-10 arithmetic **with the operators**, which needs a patch to
     * the engine: quickjs-ng removed the operator overloading Bellard's quickjs
     * had, so `JS_SetArithHandler` is a hook the arithmetic slow paths consult
     * before they reach ToPrimitive.  Half of what is asserted here is therefore
     * that *everything else still works* -- a patch to the interpreter's
     * arithmetic is where a language breaks quietly.
     */
    testDecimal() {
        /* --- what a double cannot --- */
        eq("19.99 * 3", `${new Decimal("19.99") * new Decimal("3")}`, "59.97");

        let acc = new Decimal("0");
        for (let i = 0; i < 10; i++) acc = acc + new Decimal("0.1");
        eq("a tenth, ten times", `${acc}`, "1.0");

        let cents = new Decimal("0.00");
        for (let i = 0; i < 100; i++) cents = cents + new Decimal("0.01");
        eq("a cent, a hundred times", `${cents}`, "1.00");

        /*
         * The three the platform gets wrong, and they are wrong for one reason:
         * the double the literal makes is already below the half, so no rounding
         * function can recover it.  Only never going through a double can.
         */
        eq("1.005 rounds up, where toFixed says 1.00",
           `${new Decimal("1.005").Round(2)}`, "1.01");
        eq("0.615 too, where toFixed says 0.61",
           `${new Decimal("0.615").Round(2)}`, "0.62");
        eq("and 8.165, where Math.round(x*100)/100 says 8.16",
           `${new Decimal("8.165").Round(2)}`, "8.17");

        /* --- the operators, one at a time --- */
        const p = new Decimal("19.99");
        eq("plus",   `${p + new Decimal("0.01")}`, "20.00");
        eq("minus",  `${p - new Decimal("0.99")}`, "19.00");
        eq("times",  `${p * new Decimal("2")}`,    "39.98");
        eq("divide", `${new Decimal("10") / new Decimal("4")}`, "2.5");
        eq("negate", `${-p}`, "-19.99");

        /* Mixed with the ordinary numbers and texts a program already has. */
        eq("times a plain number", `${p * 3}`, "59.97");
        eq("and the other way round", `${3 * p}`, "59.97");
        eq("minus a text, which JavaScript already reads as a number",
           `${p - "0.99"}`, "19.00");

        /*
         * `+` with a text is **concatenation**, as everywhere else in
         * JavaScript.  Without this exception `"Total: " + precio` threw, and
         * building a message out of a decimal is the second thing anybody does
         * with one.
         */
        eq("a text plus a decimal is a text", `${"Total: " + p}`, "Total: 19.99");
        eq("...and the other way round", `${p + " pesos"}`, "19.99 pesos");

        /*
         * **The reason this is a fraction and not a scaled integer.**
         *
         * A scaled integer has to decide what ten thirds *is* the moment it is
         * asked, and every decision is a rounding: 3.33, and three of those are
         * 9.99.  A fraction keeps the thirds, so multiplying by three cancels
         * them.  This file was the scaled integer first and this assertion is
         * what it could not pass.
         */
        eq("(10 / 3) * 3 is ten",
           `${(new Decimal("10") / new Decimal("3")) * new Decimal("3")}`, "10");
        eq("...and a seventh, seven times, is one",
           `${(new Decimal("1") / new Decimal("7")) * new Decimal("7")}`, "1");
        eq("...and a third plus two thirds is one",
           `${new Decimal("1") / new Decimal("3")
              + new Decimal("2") / new Decimal("3")}`, "1");
        eq("...and what comes back subtracts to nothing",
           `${(new Decimal("100") / new Decimal("7")) * new Decimal("7")
              - new Decimal("100")}`, "0");

        /*
         * A quotient that *does* have an exact decimal is written at exactly the
         * places it needs -- an eighth is three, and nobody declared them.  The
         * scaled version answered `0.13`, because neither operand happened to be
         * written with decimals: an accident of how the left side was typed.
         */
        eq("an eighth is exact", `${new Decimal("1") / new Decimal("8")}`, "0.125");
        eq("and a sixteenth", `${new Decimal("1") / new Decimal("16")}`, "0.0625");

        /* ...while a money value keeps the column it was declared with. */
        eq("but a two-place value divides to two places",
           `${new Decimal("10.00") / new Decimal("4")}`, "2.50");

        /*
         * A value with no exact decimal at any length is *written* at nine
         * places, rounded -- and that rounding is in the text and never in the
         * value, which is what the assertions above depend on.
         */
        eq("a third is written at nine places",
           `${new Decimal("1") / new Decimal("3")}`, "0.333333333");
        eq("and says it is not exact",
           (new Decimal("1") / new Decimal("3")).IsExact, false);
        eq("where a tenth is", new Decimal("0.1").IsExact, true);

        /*
         * What it refuses rather than getting wrong: denominators that do not
         * cancel multiply, and a long chain of coprime ones outgrows an int64.
         * Money never approaches it -- every denominator is a power of ten --
         * and this is loud rather than silent, which is the whole bargain.
         */
        let grew = "";
        try {
            let sum = new Decimal("1") / new Decimal("3");
            for (let i = 0; i < 40; i++)
                sum = sum + new Decimal("1") / new Decimal(`${i * 2 + 5}`);
        } catch (e) {
            grew = e.message;
        }
        check("a chain of coprime denominators is refused, not wrapped",
              grew.includes("does not fit"), grew);

        /* --- scales --- */
        eq("adding lines up the scales", `${new Decimal("1.5") + new Decimal("0.25")}`,
           "1.75");
        eq("multiplying adds them", `${new Decimal("1.5") * new Decimal("1.5")}`,
           "2.25");
        eq("a scale can be declared", `${new Decimal("19.9", 2)}`, "19.90");
        eq("and read back", new Decimal("19.90").Scale, 2);

        /* --- comparisons, which the same patch hooks --- */
        const a = new Decimal("10.00"), b = new Decimal("9.99");
        check("greater", a > b);
        check("not less", !(a < b));
        check("greater or equal across scales", a >= new Decimal("10.0"));
        check("and less or equal", b <= new Decimal("9.990"));

        /*
         * `===` is **not** hooked, deliberately: strict equality on objects is
         * identity, it has no slow path, and giving it one would change what
         * identity means for every object in the program.  Asserted so that the
         * absence is a decision on the record rather than a surprise.
         */
        check("=== is identity and stays that way",
              !(new Decimal("1.00") === new Decimal("1.00")));

        /* --- rounding, by name --- */
        eq("Away is the default", `${new Decimal("1.005").Round(2)}`, "1.01");
        eq("Even sends a half to the even neighbour",
           `${new Decimal("1.005").Round(2, "Even")}`, "1.00");
        eq("...which is not always down",
           `${new Decimal("1.015").Round(2, "Even")}`, "1.02");
        eq("Zero truncates", `${new Decimal("1.999").Round(2, "Zero")}`, "1.99");
        eq("Up goes to +infinity", `${new Decimal("1.001").Round(2, "Up")}`, "1.01");
        eq("Down goes to -infinity",
           `${new Decimal("-1.001").Round(2, "Down")}`, "-1.01");
        eq("and Away means away, on a negative too",
           `${new Decimal("-1.005").Round(2)}`, "-1.01");

        /* --- Split: the problem no decimal type solves --- */
        const parts = Decimal.Split(new Decimal("10.00"), 3);
        eq("three shares", parts.length, 3);
        eq("the remainder is handed out, not lost", parts.join(" "), "3.34 3.33 3.33");

        let back = new Decimal("0.00");
        for (const q of parts) back = back + q;
        eq("**and they add back up to the total**", `${back}`, "10.00");

        eq("a negative total splits the same way",
           Decimal.Split(new Decimal("-10.00"), 3).join(" "), "-3.34 -3.33 -3.33");

        eq("Abs", `${new Decimal("-5.5").Abs()}`, "5.5");
        eq("Sign", new Decimal("-5.5").Sign, -1);
        eq("of nothing", new Decimal("0").Sign, 0);

        /* --- what it refuses --- */
        for (const [what, fn] of [
            ["a text that is not a number", () => new Decimal("hola")],
            ["more places than it holds", () => new Decimal("1.0000000001")],
            ["division by zero", () => new Decimal("1") / new Decimal("0")],
            ["a rounding nobody has", () => new Decimal("1").Round(2, "Banker")],
            /* Falling through would reach ToPrimitive and answer with a double,
             * which is the floating point this type exists to avoid. */
            ["%", () => new Decimal("5") % new Decimal("2")],
            ["**", () => new Decimal("5") ** new Decimal("2")],
            ["NaN", () => new Decimal(0 / 0)],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`refuses ${what}`, complaint.includes("Decimal"), complaint);
        }

        /* --- and the half that matters: nothing else changed --- */
        eq("numbers still add", 1 + 2, 3);
        eq("texts still join", "a" + "b", "ab");
        eq("arrays still do whatever that is", [1] + [2], "12");
        eq("an object still stringifies", ({}) + 1, "[object Object]1");
        check("a Date still compares", new Date() > 0);
        eq("BigInt is untouched", `${1999n * 3n}`, "5997");
        eq("and so is its equality", 1999n === 1999n, true);
        eq("a plain object through the same slow path",
           JSON.stringify({ a: 1 }) + "!", '{"a":1}!');

        /* --- carrying it out of the program --- */
        eq("JSON writes the digits, not an empty object",
           JSON.stringify({ p }), '{"p":"19.99"}');
        eq("and the double is asked for by name, never by accident",
           p.Number(), 19.99);
    }

    /* --- Field.Decimal ------------------------------------------------------ */
    testFieldDecimal() {
        const item = new Priced({ Name: "Tornillo", Price: "19.9", Weight: 0.5 });

        eq("text arrives exact and at the field's scale", `${item.Price}`, "19.90");
        eq("a number does too", `${item.Weight}`, "0.500");
        eq("and the default is zero at that scale",
           `${new Priced({ Name: "x" }).Price}`, "0.00");

        item.Price = "1.005";
        eq("assigning rounds to the field's places", `${item.Price}`, "1.01");

        /* min and max are compared with the operators, which is what makes them
         * writable as text in the declaration. */
        let complaint = "";
        try {
            item.Price = "-1";
        } catch (e) {
            complaint = e.message;
        }
        check("min refuses, naming the field", complaint.startsWith("Price:"),
              complaint);

        complaint = "";
        try {
            item.Price = "hola";
        } catch (e) {
            complaint = e.message;
        }
        check("and so does a text that is not a number",
              complaint.startsWith("Price:"), complaint);

        /* A plain object is what Serialize promises, so a decimal goes out as
         * its own text -- which is also the only shape it reads back exactly,
         * since a JSON number would be a double again. */
        const written = item.Serialize();
        eq("serialised as text", written.Price, "1.01");
        eq("and read back exactly", `${Priced.Load(written).Price}`, "1.01");
        eq("with nothing to complain about", Priced.Load(written).Problems.length, 0);

        /*
         * A field still at its default is left out of the file, which only works
         * because `sameValue` learned to compare decimals: `===` on two of them
         * is identity, so every decimal field would otherwise be written on
         * every save.
         */
        check("a field at its default is not written",
              !("Price" in new Priced({ Name: "y" }).Serialize()),
              JSON.stringify(new Priced({ Name: "y" }).Serialize()));

        eq("a copy is the same value", `${item.Clone().Price}`, "1.01");
        check("PropertyNames sees it", item.PropertyNames().includes("Price"));

        /* What the whole thing is for. */
        eq("arithmetic straight off a field",
           `${item.Price * 3 + new Decimal("0.01")}`, "3.04");
    }

    /* --- Locale.Number and Locale.Date --------------------------------------
     *
     * How the **desktop** spells a value, which is a different question from
     * which catalogue the project shows -- so most of what can be asserted here
     * has to hold in *any* locale, since the suite runs in whatever the machine
     * has.  The exact strings are asserted from a child started with `LC_ALL=C`,
     * which every machine has and POSIX pins down.
     */
    testLocaleFormat() {
        /* --- what is true in every locale --- */
        eq("an integer gets no decimals it did not have", Locale.Number(3), "3");
        eq("nor does zero", Locale.Number(0), "0");

        /*
         * The separators are the locale's, so what can be checked is that the
         * digits survived and that the decimals asked for arrived.
         */
        const grouped = Locale.Number(1234567.891, 2);
        eq("every digit survives the grouping",
           grouped.replace(/[^0-9]/g, ""), "123456789");
        check("and something was put between them",
              grouped.replace(/[0-9]/g, "").length >= 1, grouped);

        /*
         * `1.5` and not a bigger number on purpose: with nothing to group, the
         * only non-digit in the answer is the decimal separator, so the run of
         * digits at the end *is* the decimals -- whatever this locale spells
         * them with.
         */
        const three = Locale.Number(1.5, 3);
        eq("three decimals asked for are three decimals given",
           /[0-9]+$/.exec(three)[0].length, 3);
        eq("...and they are the right ones", three.replace(/[^0-9]/g, ""), "1500");

        eq("rounding to none", Locale.Number(2.6, 0), "3");
        check("a negative keeps its sign", Locale.Number(-5, 0).startsWith("-"),
              Locale.Number(-5, 0));

        /* Refused rather than printed: "nan" in a label says nothing to whoever
         * reads it, which is the bargain Field.Number already makes. */
        for (const [what, fn] of [
            ["NaN", () => Locale.Number(0 / 0)],
            ["an infinity", () => Locale.Number(1 / 0)],
            ["more decimals than a double has", () => Locale.Number(1, 50)],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`Locale.Number refuses ${what}`,
                  complaint.includes("Locale.Number"), complaint);
        }

        /* --- Date: what is locale-independent --- */
        const when = new Date(2026, 7, 31, 14, 5, 9);

        /* ISO is the one format that is *not* the desktop's, which is the point
         * of having it: a date going into a file is not prose. */
        check("ISO is exact and the same everywhere",
              Locale.Date(when, "ISO").startsWith("2026-08-31T14:05:09"),
              Locale.Date(when, "ISO"));

        /*
         * The three shapes it takes, and the middle one is why: a `Field.Date`
         * holds `"YYYY-MM-DD"`, so `Locale.Date(customer.Since)` is the call
         * this exists for and a version taking only a `Date` would miss its own
         * customer.
         */
        eq("a Date and its milliseconds agree",
           Locale.Date(when), Locale.Date(when.getTime()));
        eq("and so does the string a Field.Date holds",
           Locale.Date("2026-08-31"), Locale.Date(new Date(2026, 7, 31)));

        eq("the default is the same as Date", Locale.Date(when),
           Locale.Date(when, "Date"));
        check("DateTime says more than Date does",
              Locale.Date(when, "DateTime").length > Locale.Date(when).length,
              `${Locale.Date(when, "DateTime")} vs ${Locale.Date(when)}`);

        for (const [what, fn] of [
            ["nothing at all", () => Locale.Date()],
            ["a format nobody has", () => Locale.Date(when, "Long")],
            ["a text that is not a date", () => Locale.Date("hola")],
            ["a date the calendar does not have", () => Locale.Date("2026-13-45")],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`Locale.Date refuses ${what}`,
                  complaint.includes("Locale.Date"), complaint);
        }

        /*
         * **The catalogue and the spelling are two settings.** Locale.Current
         * picks which .po the prose comes from; these follow the desktop's own
         * LANG.  A Spanish speaker on a German desktop wants Spanish words and
         * German numbers.
         */
        const wasCurrent = Locale.Current;
        const before     = `${Locale.Number(1234.5, 1)}|${Locale.Date(when)}`;
        Locale.Current   = "";
        eq("Locale.Current does not change how a value is spelled",
           `${Locale.Number(1234.5, 1)}|${Locale.Date(when)}`, before);
        Locale.Current = wasCurrent;

        /* --- and the exact strings, from a child whose locale we chose --- */
        Directory.Make(SCRATCH);
        const dir = File.Join(SCRATCH, "cformat");
        Directory.Make(dir);
        File.SaveJson(File.Join(dir, "project.json"),
                      { name: "cformat", main: "main" });
        File.Save(File.Join(dir, "Main.js"),
                  'function main() {\n' +
                  '    const d = new Date(2026, 7, 31, 14, 5, 9);\n' +
                  '    print(Locale.Number(1234567.891, 2));\n' +
                  '    print(Locale.Number(3));\n' +
                  '    print(Locale.Date(d));\n' +
                  '    print(Locale.Date(d, "Time"));\n' +
                  '    Application.Quit(0);\n' +
                  '}\n');

        /*
         * `LC_ALL=C` and not a real language: it is the one locale every machine
         * has, and POSIX says what it spells -- a period for the decimal, no
         * grouping at all, and `%m/%d/%y` for a date.  Asserting `1.234.567,89`
         * would be asserting this developer's desktop.
         */
        const ran = Exec.Wait([Application.Executable, dir],
                              { Environment: { LC_ALL: "C", LANG: "C" },
                                Timeout: 20000 });
        check("the child ran", ran.ExitCode === 0, ran.Output);
        check("and was not cut off", ran.TimedOut === false);

        const said = ran.Output.trim().split("\n");
        eq("under C there is no grouping and the decimal is a period",
           said[0], "1234567.89");
        eq("an integer is still bare", said[1], "3");
        eq("and C's date is month first", said[2], "08/31/26");
        eq("with its time unchanged", said[3], "14:05:09");
    }

    /* --- Stopwatch ----------------------------------------------------------
     *
     * How long something took, which is the one question a `Date` cannot answer:
     * a wall clock is a *setting*, and NTP stepping it during a measurement makes
     * the answer wrong -- backwards, it makes it negative. This reads the clock
     * that only goes forward, which is the one GLib already schedules every
     * `Timer` against.
     *
     * Most of what is asserted here is exact, because a stopped watch is: once
     * `Stop` has folded the run into what it holds, every read of `Elapsed`
     * answers the same number. The one measurement that is a measurement waits
     * for a real span to pass rather than counting frames.
     *
     * `examples/stopwatch` is the whole of it running.
     */
    testStopwatch() {
        const watch = new Stopwatch();

        eq("a fresh one is at zero", watch.Elapsed, 0);
        check("and not running", watch.Running === false);

        /* The raw clock is not part of the language: a single reading of it
         * counts from the machine's boot and means nothing, so `Stopwatch` is
         * the only shape it is published in. */
        check("the clock underneath has no name here",
              typeof monotonic === "undefined");

        check("Start hands the watch back", watch.Start() === watch);
        check("and it is running", watch.Running === true);

        /* Pressing Start twice is one intention said twice, and it must not
         * restart: the second press would otherwise throw away everything the
         * first one measured. */
        const wasRunning = watch.Elapsed;
        watch.Start();
        check("starting a running watch does not restart it",
              watch.Elapsed >= wasRunning, `${watch.Elapsed} vs ${wasRunning}`);

        until("the watch measures a real span", () => watch.Elapsed >= 120, () => {
            /*
             * **Not `=== 120`, and not a count of ticks.** Timers fire late and
             * never early, so what can be asserted is the floor -- and the
             * ceiling only as a sanity rail, since a machine under a sanitizer
             * can take its time.
             */
            check("what it measured is a real duration",
                  watch.Elapsed >= 120 && watch.Elapsed < 60000, `${watch.Elapsed}`);

            watch.Stop();
            check("and now it is stopped", watch.Running === false);

            /* Exact: a stopped watch holds a number, so reading it twice cannot
             * answer twice. This is the assertion that would fail if `Elapsed`
             * went on adding while stopped. */
            const held = watch.Elapsed;
            eq("a stopped watch reads the same twice", watch.Elapsed, held);
            eq("...and a third time", watch.Elapsed, held);

            check("stopping a stopped watch changes nothing",
                  watch.Stop().Elapsed === held);

            /* Started again it picks up rather than starting over, which is what
             * makes Stop a pause and not a lap. */
            watch.Start();
            check("resuming keeps what was already measured",
                  watch.Elapsed >= held, `${watch.Elapsed} vs ${held}`);

            watch.Reset();
            eq("Reset is back to zero", watch.Elapsed, 0);
            check("and stopped", watch.Running === false);
            check("Reset hands it back too", watch.Reset() === watch);

            /* Never negative, whatever was done to it -- the failure a wall
             * clock has and this one cannot. */
            check("a reading is never negative", watch.Elapsed >= 0);
        });
    }

    /* --- Locale.Compare and Locale.Matches ----------------------------------
     *
     * The order this desktop puts names in, and what it thinks a search finds.
     *
     * `localeCompare` is installed and is not this: QuickJS is built without
     * ICU, so with no `Intl` a comparison with no collator falls back to
     * comparing code units, and every accented name in a Spanish list files
     * after Z.  It reads like the fix and changes nothing, which is why the gap
     * lasted -- `TableView.SortBy` collates in C and always did, so the widget
     * that sorted its own rows was right while every list a program sorted by
     * hand was wrong.  `examples/contacts` is the whole of it running.
     *
     * Most of what is asserted here holds in **any** locale, since the suite
     * runs in whatever the machine has.  The order itself cannot: under `C` the
     * collation *is* byte order, and asserting otherwise would be asserting this
     * developer's desktop.  So the two orders are pinned from a child started in
     * a locale chosen off `locale -a`, and the C case is asserted too -- it is
     * not a skip, it is the other half of the same claim.
     */
    testLocaleOrder() {
        /*
         * **And `localeCompare` is refused, by name.** It used to be installed
         * and wrong: it answers exactly what no comparator at all answers, so
         * it read like the fix and changed nothing, and no list sorted with it
         * was ever right. The refusal says what to use, which is the point of
         * refusing rather than deleting -- a deletion says only *not a
         * function*. It lives in `rad.js` because a worker evaluates that file
         * entire and closes its hatches off a list of its own, so C would have
         * been a third catalogue to keep in step.
         */
        let refused = "NOT REFUSED";

        try { "Álvarez".localeCompare("Zapata"); }
        catch (e) { refused = e.message; }
        check("localeCompare is refused", refused.includes("code units"), refused);
        check("...and the refusal names Locale.Compare",
              refused.includes("Locale.Compare"), refused);

        /*
         * **And the bare sort is the one that stays silent**, which is why the
         * refusal above is not the whole answer. `sort()` with no comparator
         * gives exactly the order `localeCompare` gave -- that equality is the
         * measurement that settled the refusal, since it means the method added
         * nothing at all -- and it cannot be refused in turn: it is right for
         * paths, extensions and the keys of a bag, which is every other one of
         * the 26 bare sorts in this tree.
         *
         * Asserted here and not from a child in a chosen locale, unlike the
         * orders below: a comparator-less `sort` is specified to compare UTF-16
         * code units and never consults the locale at all, so this holds on
         * every desktop and under `C`.
         */
        eq("a bare sort compares code units, in any locale",
           ["Zapata", "Álvarez", "acosta"].sort().join(","),
           "Zapata,acosta,Álvarez");

        /* --- the contract, which holds anywhere --- */
        eq("a string equals itself", Locale.Compare("Ortiz", "Ortiz"), 0);
        eq("and the answer is one of three", Locale.Compare("Ana", "Bruno"), -1);
        eq("the other way round", Locale.Compare("Bruno", "Ana"), 1);

        /*
         * Antisymmetry over a list with every awkward letter in it.  This is
         * what `sort` requires of a comparator rather than a nicety: given one
         * that contradicts itself, a sort does not merely misorder the list, it
         * is free to lose entries out of it.
         */
        const awkward = ["Zapata", "Álvarez", "acosta", "Ñanculeo", "Öztürk",
                         "de la Fuente", "Bertoni", "Çelik", "Núñez"];
        let disagreed = "";
        for (const a of awkward)
            for (const b of awkward)
                if (Locale.Compare(a, b) !== -Locale.Compare(b, a))
                    disagreed = `${a} vs ${b}`;
        check("the order is total and antisymmetric", disagreed === "", disagreed);

        const sorted = awkward.slice().sort(Locale.Compare);
        let backwards = "";
        for (let i = 1; i < sorted.length; i++)
            if (Locale.Compare(sorted[i - 1], sorted[i]) > 0)
                backwards = `${sorted[i - 1]} before ${sorted[i]}`;
        check("and what it sorts comes out in it", backwards === "", backwards);

        /*
         * --- Matches, which is locale-independent, all of it ---
         *
         * The folding is decomposition and Unicode casefolding rather than
         * glibc's collation or GLib's transliteration to ASCII, so every one of
         * these holds under `C` and under `de_DE` alike -- and a name in an
         * alphabet with no ASCII to be transliterated to stays searchable.
         */
        check("what was typed is found in the middle of a word",
              Locale.Matches("Echeverría, Nahuel", "ver"));
        check("an accent typed without it still finds the name",
              Locale.Matches("García, Andrés", "garcia"));
        check("and the tilde too", Locale.Matches("Núñez, Facundo", "nunez"));
        check("and an umlaut, in any locale",
              Locale.Matches("Öztürk, Kerem", "ozturk"));
        check("case is not part of the question",
              Locale.Matches("ZAPATA", "zapata"));
        check("nor is it for the accented letters",
              Locale.Matches("Larrañaga, Valentina", "RAÑA"));

        /* The full fold and not `tolower`: these two are one-to-many, and a
         * casefold is the only thing that gets them. */
        check("ß folds to ss", Locale.Matches("Straße 5", "strasse"));
        check("and Turkish İ to i", Locale.Matches("İzmir", "izmir"));

        /* Marks are dropped rather than transliterated, so this reaches an
         * alphabet that has no ASCII to be turned into. */
        check("an alphabet that is not Latin is still searchable",
              Locale.Matches("Москва", "оск"));

        /*
         * The needle is split on its spaces and every word has to be somewhere,
         * which is what a substring search cannot do: it finds the name
         * whichever way round the list writes the two halves.
         */
        check("every word typed has to be found",
              Locale.Matches("Álvarez, María", "maria alv"));
        check("...so a word that is nowhere in it answers no",
              !Locale.Matches("Álvarez, María", "maria zapata"));

        /* Nothing typed is a real state of a search field, and it matches
         * everything -- so a filter needs no guard of its own. */
        check("an empty search finds everything", Locale.Matches("Zapata", ""));
        check("and so does one that is only spaces",
              Locale.Matches("Zapata", "   "));

        for (const [what, fn] of [
            ["one string", () => Locale.Compare("a")],
            ["nothing at all", () => Locale.Compare()],
        ]) {
            let complaint = "";
            try { fn(); } catch (e) { complaint = e.message; }
            check(`Locale.Compare refuses ${what}`,
                  complaint.includes("Locale.Compare"), complaint);
        }
        for (const [what, fn] of [
            ["only the text", () => Locale.Matches("a")],
            ["nothing at all", () => Locale.Matches()],
        ]) {
            let complaint = "";
            try { fn(); } catch (e) { complaint = e.message; }
            check(`Locale.Matches refuses ${what}`,
                  complaint.includes("Locale.Matches"), complaint);
        }

        /* --- and the two orders, from children whose locale we chose --- */
        Directory.Make(SCRATCH);
        const dir = File.Join(SCRATCH, "collate");
        Directory.Make(dir);
        File.SaveJson(File.Join(dir, "project.json"),
                      { name: "collate", main: "main" });
        File.Save(File.Join(dir, "Main.js"),
                  'function main() {\n' +
                  '    const n = ["Zapata", "Álvarez", "acosta", "Bertoni", "Núñez"];\n' +
                  '    print(Locale.Compare("a", "B"));\n' +
                  '    print(n.slice().sort(Locale.Compare).join("|"));\n' +
                  '    print(n.slice().sort().join("|"));\n' +
                  '    Application.Quit(0);\n' +
                  '}\n');

        const inLocale = (lc) => {
            const r = Exec.Wait([Application.Executable, dir],
                                { Environment: { LC_ALL: lc, LANG: lc },
                                  Timeout: 20000 });
            check(`the child ran under ${lc}`, r.ExitCode === 0, r.Output);
            return r.Output.trim().split("\n");
        };

        /*
         * Under `C` the collation is byte order, so the two agree -- which is
         * the assertion that pins `Compare` to `strcoll` rather than to
         * something of ours that merely looks right on a Spanish desktop.
         */
        const c = inLocale("C");
        eq("under C a lowercase letter sorts after an uppercase one", c[0], "1");
        eq("...so C's order is the code-unit order", c[1], c[2]);
        eq("and that order is this one", c[2],
           "Bertoni|Núñez|Zapata|acosta|Álvarez");

        /*
         * A real one, whichever this machine has.  Every glibc collation agrees
         * about the two things asserted: case is a lesser difference than a
         * letter, and an acute accent is a variant of its vowel rather than a
         * letter after Z.
         */
        const real = utf8Locale();
        check("the machine has a locale that collates", real !== "",
              "only C and POSIX in `locale -a`");
        if (real) {
            const r = inLocale(real);
            eq(`under ${real} case is not what orders names`, r[0], "-1");
            eq("...and the accents are where a person would look for them",
               r[1], "acosta|Álvarez|Bertoni|Núñez|Zapata");
            check("which is not what sort() answers", r[1] !== r[2],
                  `${r[1]}  vs  ${r[2]}`);
            eq("and sort() is the same order in every locale", r[2], c[2]);
        }
    }

    /* --- Day ----------------------------------------------------------------
     *
     * The calendar date, which is the value JavaScript does not have: its `Date`
     * is an instant, and every question an agenda asks of a date gets a different
     * answer through one.  What is asserted here is mostly pure arithmetic and
     * needs no display and no locale -- the calendar is the same everywhere, which
     * is the point of the type.  The one thing that is *not* pure is `Today`, and
     * it gets a child of its own.
     *
     * `examples/agenda` is the whole of it running.
     */
    testDay() {
        /* --- Add ------------------------------------------------------------ */
        eq("a week on", Day.Add("2026-03-08", 7), "2026-03-15");
        eq("and a week back", Day.Add("2026-03-15", -7), "2026-03-08");
        eq("nowhere at all", Day.Add("2026-03-08", 0), "2026-03-08");

        eq("over the end of a month", Day.Add("2026-01-31", 1), "2026-02-01");
        eq("back over one", Day.Add("2026-03-01", -1), "2026-02-28");
        eq("over the end of a year", Day.Add("2026-12-31", 1), "2027-01-01");

        /* The leap rule, all three clauses of it: divisible by four is a leap
         * year, by 100 is not, by 400 is again. */
        eq("February in a leap year", Day.Add("2024-02-28", 1), "2024-02-29");
        eq("...and in one that is not", Day.Add("2026-02-28", 1), "2026-03-01");
        eq("1900 was not a leap year", Day.Add("1900-02-28", 1), "1900-03-01");
        eq("2000 was", Day.Add("2000-02-28", 1), "2000-02-29");

        /* --- Between -------------------------------------------------------- */
        eq("a week apart", Day.Between("2026-03-08", "2026-03-15"), 7);
        eq("the same day", Day.Between("2026-03-08", "2026-03-08"), 0);

        /*
         * **Signed**, which is the decision this makes and Delphi's `DaysBetween`
         * makes the other way: an absolute value cannot tell *in three days* from
         * *three days ago*, and that is one line in an agenda rather than two.
         */
        eq("backwards is negative", Day.Between("2026-03-15", "2026-03-08"), -7);

        eq("an ordinary year", Day.Between("2026-01-01", "2027-01-01"), 365);
        eq("and a leap one", Day.Between("2024-01-01", "2025-01-01"), 366);

        /*
         * A week across a clock change is seven days, which is the whole reason
         * this is not milliseconds: `(b - a) / 86400000` answers 6.958333 for the
         * first of these in a European time zone and 7.041666 for the second.
         * These are dates, so there is no hour in them to be lost or repeated.
         */
        eq("a week across the spring change", Day.Between("2026-03-28", "2026-04-04"), 7);
        eq("and across the autumn one", Day.Between("2026-10-24", "2026-10-31"), 7);

        /* The two are each other's inverse, which is what makes either one
         * trustworthy: whatever `Add` walked, `Between` counts back. */
        let drifted = "";
        for (const n of [-400, -31, -1, 0, 1, 28, 365, 1000])
            if (Day.Between("2026-03-08", Day.Add("2026-03-08", n)) !== n)
                drifted = `${n}`;
        check("Add and Between agree, whatever the distance", drifted === "", drifted);

        /* --- Weekday -------------------------------------------------------- */
        eq("a Sunday", Day.Weekday("2026-03-08"), "Sunday");
        eq("a Monday", Day.Weekday("2026-08-31"), "Monday");
        eq("a Saturday", Day.Weekday("2026-02-14"), "Saturday");

        /*
         * A name and not a number, because there are four numberings in use --
         * JavaScript and .NET from Sunday 0, ISO and Java from Monday 1, Python
         * and PostgreSQL have both -- and a bare integer makes every caller
         * remember which. Java, C# and Go all answer with an enum for this reason.
         */
        check("it is a name", typeof Day.Weekday("2026-03-08") === "string");

        const week = new Set();
        for (let n = 0; n < 7; n++)
            week.add(Day.Weekday(Day.Add("2026-03-08", n)));
        eq("seven days are seven different names", week.size, 7);
        eq("and the eighth comes round again",
           Day.Weekday(Day.Add("2026-03-08", 7)), Day.Weekday("2026-03-08"));

        /* --- what it refuses ------------------------------------------------ */
        for (const [what, fn] of [
            ["a day the calendar has not", () => Day.Add("2026-02-30", 1)],
            ["February 29th of a common year", () => Day.Weekday("2026-02-29")],
            ["the locale's own order", () => Day.Weekday("08-03-2026")],
            ["a time on the end", () => Day.Add("2026-03-08T00:00", 1)],
            ["a month there is no such of", () => Day.Weekday("2026-13-01")],
            ["something that is not a date at all", () => Day.Weekday("hoy")],
            ["nothing at all", () => Day.Weekday()],
            ["only one date", () => Day.Between("2026-03-08")],
        ]) {
            let complaint = "";
            try { fn(); } catch (e) { complaint = e.message; }
            check(`Day refuses ${what}`, complaint.startsWith("Day."), complaint);
        }

        /*
         * **Everything `Add` answers is something the rest of `Day` accepts.**
         * The text holds four digits of year, so the calendar stops at 9999-12-31
         * and 0001-01-01; without the bound, `Add` would hand back an eleven-
         * character string that its own parser refuses two lines later.
         */
        eq("the last day there is", Day.Add("9999-12-30", 1), "9999-12-31");
        eq("and the first", Day.Add("0001-01-02", -1), "0001-01-01");
        eq("both round-trip", `${Day.Weekday("9999-12-31")}/${Day.Weekday("0001-01-01")}`,
           "Friday/Monday");

        for (const [what, fn] of [
            ["one day past the end", () => Day.Add("9999-12-31", 1)],
            ["one day before the start", () => Day.Add("0001-01-01", -1)],
            ["a million days", () => Day.Add("2026-03-08", 9000000)],
        ]) {
            let complaint = "";
            try { fn(); } catch (e) { complaint = e.message; }
            check(`Day.Add refuses ${what}`,
                  complaint.includes("outside the calendar"), complaint);
        }

        /* --- Today ----------------------------------------------------------
         *
         * The one part that is not arithmetic. It has to be **local** midnight:
         * `new Date().toISOString().slice(0, 10)` is the spelling this replaces,
         * and it answers yesterday for the whole of the morning anywhere west of
         * Greenwich.
         */
        const now = new Date();
        const two = (n) => `${n}`.padStart(2, "0");
        const local = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;

        /* `new Date()`'s own local getters, which is the same question asked of
         * the engine instead of of GLib. A midnight crossed between the two lines
         * would make them differ by a day, and nothing else would. */
        check("Today is the date it is here", Day.Today === local ||
              Day.Between(local, Day.Today) === 1, `${Day.Today} vs ${local}`);
        eq("...and it is a date the rest of Day takes",
           Day.Between(Day.Today, Day.Today), 0);

        /*
         * And that it follows the *time zone* and not UTC, which no assertion in
         * this process can make: two children, one as far east as the calendar
         * goes and one as far west, have different dates for the same instant
         * roughly all of the time -- and would have the same one if `Today` were
         * UTC's date.
         *
         * Guarded by what the children report about themselves rather than by
         * trusting the names: a machine with no tzdata answers UTC for both, and
         * asserting a difference there would be asserting the test machine's
         * package list.
         */
        Directory.Make(SCRATCH);
        const dir = File.Join(SCRATCH, "today");
        Directory.Make(dir);
        File.SaveJson(File.Join(dir, "project.json"), { name: "today", main: "main" });
        File.Save(File.Join(dir, "Main.js"),
                  'function main() {\n' +
                  '    print(Day.Today);\n' +
                  '    print(Locale.Date(new Date(), "ISO").slice(-6));\n' +
                  '    Application.Quit(0);\n' +
                  '}\n');

        const inZone = (tz) => {
            const r = Exec.Wait([Application.Executable, dir],
                                { Environment: { TZ: tz }, Timeout: 20000 });
            check(`the child ran under ${tz}`, r.ExitCode === 0, r.Output);
            return r.Output.trim().split("\n");
        };

        const east = inZone("Etc/GMT-14");     /* +14, the far side of the date line */
        const west = inZone("Etc/GMT+12");     /* -12 */

        if (east[1] !== west[1]) {
            /*
             * **Ahead, and not by exactly one.** Those two zones are twenty-six
             * hours apart, so which side of midnight each of them is on decides
             * whether the answer is one day or two -- and pinning it to one is
             * how this failed the first time it ran at the wrong hour. What is
             * being asserted is the thing UTC would get wrong: if `Today` read
             * the UTC date, both children would answer the same day and this
             * would be zero.
             */
            const apart = Day.Between(west[0], east[0]);
            check("east of the line is ahead of west",
                  apart === 1 || apart === 2, `${west[0]} -> ${east[0]} is ${apart}`);
        } else {
            /* No tzdata: both fell back to UTC, and that is the only thing left
             * worth asserting -- that they agree, rather than a difference the
             * machine cannot produce. */
            eq("with no tzdata both children are UTC", east[0], west[0]);
        }
    }

    /* --- Exec.Wait ------------------------------------------------------
     *
     * The blocking spelling, and it can be an ordinary test rather than part of
     * the asynchronous tail: nothing here waits for a later turn of the loop,
     * which is the whole point of it.
     */
    testExecWait() {
        const r = Exec.Wait(["sh", "-c", "echo hola; exit 0"]);
        eq("ExitCode of one that worked", r.ExitCode, 0);
        eq("Output is what it wrote", r.Output, "hola\n");

        /*
         * **A NUL is a character of the answer and not the end of it.**
         *
         * This was built on `communicate_utf8`, which hands back a C string, so
         * everything past the first NUL was thrown away -- and a NUL is what the
         * tools this call exists for separate their records with, *because* it
         * is the one byte a file name cannot contain. `git status -z` read as
         * one entry and lost the rest, silently.
         */
        const zero = Exec.Wait(["printf", "uno\\0dos y dos\\0tres\\0"]);
        eq("a NUL does not end the output", zero.Output.length, 19);
        eq("so a NUL-separated answer arrives whole",
           JSON.stringify(zero.Output.split("\0")),
           JSON.stringify(["uno", "dos y dos", "tres", ""]));

        /*
         * `Errors` is absent when the streams are merged: an empty string there
         * would read as *it wrote nothing to stderr*, which is a different claim
         * -- the same reason the callback spelling passes `undefined` rather than
         * `"out"` for a merged line's origin.
         */
        check("Errors is absent when the streams are merged", !("Errors" in r),
              JSON.stringify(Dictionary.Keys(r)));

        const failed = Exec.Wait(["sh", "-c", "exit 7"]);
        eq("the status of one that failed", failed.ExitCode, 7);
        eq("and its Output is empty rather than missing", failed.Output, "");

        const merged = Exec.Wait(["sh", "-c", "echo uno; echo dos >&2"]);
        check("merged, both streams land in Output",
              merged.Output.includes("uno") && merged.Output.includes("dos"),
              merged.Output);

        const apart = Exec.Wait(["sh", "-c", "echo salida; echo error >&2"],
                                { Stderr: "separate" });
        eq("apart, Output is only stdout", apart.Output, "salida\n");
        eq("...and Errors is stderr", apart.Errors, "error\n");

        /* The same options object the callback spelling takes, because it is the
         * same child started the same way. */
        eq("Directory", Exec.Wait(["pwd"], { Directory: "/tmp" }).Output.trim(),
           "/tmp");
        eq("Environment adds a name",
           Exec.Wait(["sh", "-c", "echo [$BTA_PROBE]"],
                     { Environment: { BTA_PROBE: "si" } }).Output.trim(), "[si]");

        Environment.Set("BTA_GOING", "here");
        eq("...and a null takes one away",
           Exec.Wait(["sh", "-c", "echo [$BTA_GOING]"],
                     { Environment: { BTA_GOING: null } }).Output.trim(), "[]");
        Environment.Set("BTA_GOING", null);

        /* A child stopped by a signal did not exit, so it has no status of its
         * own -- reported as -1, as the callback spelling reports it. */
        eq("a child killed by a signal answers -1",
           Exec.Wait(["sh", "-c", "kill -TERM $$"]).ExitCode, -1);

        /*
         * A pipe nobody drains is a child that blocks forever, which is the
         * deadlock a hand-written wait-then-read walks into.  Twenty thousand
         * lines is well past any pipe buffer there is.
         */
        const big = Exec.Wait(["sh", "-c", "yes hola | head -n 20000"]);
        eq("a large output does not deadlock", big.ExitCode, 0);
        eq("and arrives whole", big.Output.split("\n").length, 20001);

        /* What it refuses, naming itself -- `Exec` in the message would send
         * whoever reads it to the wrong line. */
        for (const [what, fn] of [
            ["no arguments at all", () => Exec.Wait()],
            ["an argv that is not a list", () => Exec.Wait("ls")],
            ["an empty argv", () => Exec.Wait([])],
            /* What somebody reaching for a second command would write. */
            ["a list where the options go", () => Exec.Wait(["true"], ["false"])],
            /* Wait takes no callbacks: it answers with a record. */
            ["a callback where the options go", () => Exec.Wait(["true"], () => 0)],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`refuses ${what}, by name`, complaint.includes("Exec.Wait"),
                  complaint);
        }

        let complaint = "";
        try {
            Exec.Wait(["/no/such/binary"]);
        } catch (e) {
            complaint = e.message;
        }
        check("and a missing binary says which call failed",
              complaint.includes("Exec.Wait failed"), complaint);

        /*
         * The case it exists for: N children in a row, as a `for` loop.  Written
         * with a callback this is a recursion carrying its own index, which is
         * what `Translations.mergeAll` had to do.
         */
        const seen = [];
        for (const name of ["uno", "dos", "tres"]) {
            const one = Exec.Wait(["sh", "-c", `echo ${name}`]);
            seen.push(`${one.Output.trim()}:${one.ExitCode}`);
        }
        eq("N in sequence, in a loop", seen.join(" "), "uno:0 dos:0 tres:0");

        /* --- the guard ---
         *
         * Deliberately short deadlines: every one of these holds the main loop
         * for as long as it waits, which is why this test runs second (see
         * TESTS).  Kept under a second all together.
         */
        eq("without a Timeout, TimedOut is false", r.TimedOut, false);
        check("a command that ends in time does not fire",
              Exec.Wait(["sh", "-c", "echo rapido"], { Timeout: 4000 })
                  .TimedOut === false);

        let started = Date.now();
        const late  = Exec.Wait(["sh", "-c", "sleep 30"], { Timeout: 150 });
        let   took  = Date.now() - started;

        check("one that does not end is cut off", late.TimedOut === true,
              JSON.stringify(late));
        eq("...with -1, because a signal ended it", late.ExitCode, -1);
        check("...and it took the deadline, not thirty seconds", took < 3000, took);

        /*
         * The case that decided the process group, and the reason it is asserted
         * rather than reasoned about: `sh` forks and waits, so the grandchild
         * holds the write end of the pipe.  Signalling only the direct child
         * leaves it holding it, the read never sees EOF, and this wait would
         * never return -- a hang and not a failure, which is the worst shape a
         * bug can have in a test suite.
         */
        started = Date.now();
        const tree = Exec.Wait(["sh", "-c", "sleep 30 & sleep 30"], { Timeout: 150 });
        took = Date.now() - started;
        check("the guard reaches a grandchild rather than hanging",
              tree.TimedOut === true && took < 3000, took);

        /* A child that refuses to end politely. `KillAfter: 0` is both signals
         * at once, for a caller with no use for a graceful ending. */
        started = Date.now();
        const hard = Exec.Wait(["sh", "-c", "trap '' TERM; sleep 30"],
                               { Timeout: 150, KillAfter: 0 });
        took = Date.now() - started;
        check("one that ignores TERM ends anyway with KillAfter 0",
              hard.TimedOut === true && took < 3000, took);

        /* ...and with a grace period, the second signal comes after it. */
        started = Date.now();
        const graced = Exec.Wait(["sh", "-c", "trap '' TERM; sleep 30"],
                                 { Timeout: 150, KillAfter: 200 });
        took = Date.now() - started;
        check("with a grace it waits, and then makes it end",
              graced.TimedOut === true && took >= 300 && took < 3000, took);

        /* What it wrote before the guard fired is still the answer. */
        check("output from before the cut still arrives",
              Exec.Wait(["sh", "-c", "echo antes; sleep 30"], { Timeout: 200 })
                  .Output.includes("antes"));
    }

    /* --- Http.Wait ------------------------------------------------------
     *
     * The blocking spelling, against servers of our own on 127.0.0.1: nothing
     * here waits for a later turn of the loop, which is the whole point of it
     * -- and why this runs second, beside ExecWait. Zero external net: one
     * `python3 -m http.server` for the ordinary answers and one sleeping
     * one-liner for the guard.
     *
     * libsoup is optional at build time, so without it this reports the stub
     * instead of the network -- the testDatabase mold: the claim is that the
     * runtime says which package is missing rather than missing a global.
     */
    testHttpWait() {
        if (!Application.HasCommand("python3")) {
            failures.push("Http tests need python3 on the PATH");
            return;
        }

        let noSoup = false;
        try {
            Http.GetWait("http://127.0.0.1:9/", { Timeout: 200 });
        } catch (e) {
            noSoup = /without libsoup/.test(e.message);
        }
        if (noSoup) {
            for (const [what, fn] of [
                ["Client", () => Http.Client()],
                ["Get", () => Http.Get("http://127.0.0.1:9/", () => 0)],
                ["Post", () => Http.Post("http://127.0.0.1:9/", "x", () => 0)],
                ["Request", () => Http.Request("GET", "http://127.0.0.1:9/", () => 0)],
                ["Stream", () => Http.Stream("GET", "http://127.0.0.1:9/", () => 0)],
                ["GetWait", () => Http.GetWait("http://127.0.0.1:9/")],
                ["PostWait", () => Http.PostWait("http://127.0.0.1:9/", "x")],
                ["RequestWait", () => Http.RequestWait("GET", "http://127.0.0.1:9/")],
                ["Multipart", () => new Multipart()],
            ]) {
                let complaint = "";
                try {
                    fn();
                } catch (e) {
                    complaint = e.message;
                }
                check(`without libsoup, Http.${what} says which package`,
                      complaint.includes("without libsoup"), complaint);
            }
            return;
        }

        const fast = Exec(["python3", "-m", "http.server", "8471",
                           "--directory", "/tmp"]);
        const slow = Exec(["python3", "-c", [
            "from http.server import BaseHTTPRequestHandler, HTTPServer",
            "import time",
            "class H(BaseHTTPRequestHandler):",
            "    def do_GET(self):",
            "        time.sleep(30)",
            "    def log_message(self, *a):",
            "        pass",
            "HTTPServer((\"127.0.0.1\", 8472), H).serve_forever()",
        ].join("\n")]);

        /* The servers take a moment, and a cold python takes longer: ask
         * until one answers or the budget is gone. Counting tries instead of
         * time is the flaky version -- a refused connection answers in a
         * millisecond, so forty tries can be over before the interpreter has
         * imported its own server. */
        let up = false;
        const t0 = Date.now();
        while (!up && Date.now() - t0 < 15000) {
            try {
                Http.GetWait("http://127.0.0.1:8471/", { Timeout: 250 });
                up = true;
            } catch (e) { /* not yet */ }
        }
        check("the local server answers", up);
        if (!up) {
            fast.Stop();
            slow.Stop();
            return;
        }

        const r = Http.GetWait("http://127.0.0.1:8471/");
        eq("a 200 answers 200", r.Status, 200);
        check("with a reason", r.Reason.length > 0, r.Reason);
        check("a body arrives as Bytes",
              r.Body instanceof Bytes && r.Body.Length > 0);
        check("headers arrive lower-cased",
              typeof r.Headers["content-type"] === "string",
              JSON.stringify(Dictionary.Keys(r.Headers).slice(0, 4)));
        eq("the final URL is the one asked", r.Url, "http://127.0.0.1:8471/");

        /* A 404 is an answer, not a transport failure: for Wait that means it
         * is returned rather than thrown. */
        eq("a 404 answers 404",
            Http.GetWait("http://127.0.0.1:8471/nobody-here").Status, 404);

        /* The query is appended escaped, never interpolated. */
        eq("a query does not break the answer",
            Http.GetWait("http://127.0.0.1:8471/", { Query: { a: "b c" } }).Status,
            200);

        const api = Http.Client({ BaseUrl: "http://127.0.0.1:8471", Timeout: 5000 });
        eq("BaseUrl reads back", api.BaseUrl, "http://127.0.0.1:8471");
        eq("Timeout reads back", api.Timeout, 5000);
        eq("FollowRedirects starts true", api.FollowRedirects, true);
        api.Headers = { "X-Probe": "si" };
        eq("Headers read back", api.Headers["X-Probe"], "si");
        eq("a relative URL rides the BaseUrl", api.GetWait("/").Status, 200);
        eq("an absolute URL wins over it",
            api.GetWait("http://127.0.0.1:8471/").Status, 200);

        /* POST answers rather than throws, whatever the status: http.server
         * answers no POST at all, so this is a 501 that still went and came. */
        const posted = api.PostWait("/", { hello: "world" });
        check("a POST answers with a status",
              typeof posted.Status === "number", JSON.stringify(posted.Status));
        check("...and a body", posted.Body instanceof Bytes);

        const full = Http.Client({ BaseUrl: "http://127.0.0.1:8471", Language: "es",
                                   Proxy: null, Auth: { User: "u", Password: "p" },
                                   UserAgent: "B/1.0" });
        eq("Language reads back", full.Language, "es");
        eq("Proxy null reads back", full.Proxy, null);
        eq("Auth reads back", full.Auth.User, "u");
        eq("UserAgent reads back", full.UserAgent, "B/1.0");
        full.Language = "de";
        eq("...and writes", full.Language, "de");
        full.Proxy = "default";
        eq("...and back to the system resolver", full.Proxy, "default");
        full.Auth = null;
        /* Nothing, not a pair of empty strings: the same answer `Proxy` gives
         * when it is off, so "no credentials" and "a user named nothing" are
         * not the same value. */
        eq("...and cleared", full.Auth, null);
        eq("a client with no Auth reads back nothing", Http.Client({}).Auth, null);

        const jarred = Http.Client({ Cookies: true });
        check("Cookies reads back", jarred.Cookies === true);
        jarred.Cookies = false;
        check("...and off", jarred.Cookies === false);

        const proxied = Http.Client({ Proxy: "http://127.0.0.1:8489" });
        eq("Proxy reads back", proxied.Proxy, "http://127.0.0.1:8489");
        proxied.Proxy = null;
        eq("...and off", proxied.Proxy, null);

        const limited = Http.Client({ MaxConns: 4, MaxPerHost: 1, IdleTimeout: 5000 });
        eq("MaxConns reads back", limited.MaxConns, 4);
        eq("MaxPerHost reads back", limited.MaxPerHost, 1);
        eq("IdleTimeout reads back", limited.IdleTimeout, 5000);
        eq("...soup's defaults when untold", Http.Client({}).MaxConns, 10);
        limited.IdleTimeout = 2000;
        eq("...and IdleTimeout writes", limited.IdleTimeout, 2000);
        eq("...through a tuned session",
            limited.GetWait("http://127.0.0.1:8471/").Status, 200);
        for (const [what, fn, name] of [
            ["assigning MaxConns", () => { limited.MaxConns = 9; }, "constructor-only"],
            ["assigning MaxPerHost", () => { limited.MaxPerHost = 9; }, "constructor-only"],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`refuses ${what}, by name`, complaint.includes(name), complaint);
        }

        /* The traffic itself goes to stdout, where no assertion can reach
         * it -- so this pins the knob and that a logging client still
         * answers, and a run with Log on is eyeballed once. */
        const logged = Http.Client({ Log: "headers" });
        eq("Log reads back", logged.Log, "headers");
        logged.Log = "none";
        eq("...and off", logged.Log, "none");
        const noisy = Http.Client({ BaseUrl: "http://127.0.0.1:8471", Log: "headers" });
        eq("a logging client still answers", noisy.GetWait("/").Status, 200);

        /* Traffic goes through Logger at Debug: with the default level
         * nothing flows, and a Wait never reaches a Handler -- its context
         * is private and its caller is blocked mid-call. */
        const seen = [];
        const wasLevel = Logger.Level;
        const wasHandler = Logger.Handler;
        Logger.Level = "Debug";
        Logger.Handler = (level, text) => seen.push(text);
        eq("a Wait with logging still answers", noisy.GetWait("/").Status, 200);
        check("...without ever calling home", seen.length === 0, seen.length);
        Logger.Handler = wasHandler;
        Logger.Level = wasLevel;

        /* The remaining verbs go out as themselves: http.server answers no
         * PUT/PATCH/DELETE at all (501s that still went and came) but it does
         * answer HEAD -- 200 with nothing in it. */
        const head = api.HeadWait("/");
        eq("HEAD answers 200", head.Status, 200);
        eq("...with no body", head.Body.Length, 0);
        check("PUT answers with a status",
              typeof api.PutWait("/", "x").Status === "number");
        check("PATCH answers with a status",
              typeof api.PatchWait("/", "x").Status === "number");
        check("DELETE answers with a status",
              typeof api.DeleteWait("/").Status === "number");

        const m = new Multipart().Field("note", "hello")
            .File("up", "a.txt", new Bytes("FILEDATA"));
        eq("a built multipart counts its parts", m.Length, 2);

        /* What it refuses, naming itself. */
        for (const [what, fn, name] of [
            ["no callback at all",
             () => Http.Get("http://127.0.0.1:8471/"), "a callback is required"],
            ["a Headers that is not an object",
             () => Http.Client({ Headers: "x" }), "Headers must be an object"],
            ["a callback where Wait's options go",
             () => Http.GetWait("http://127.0.0.1:8471/", () => 0),
             "takes no callbacks"],
            ["a relative URL with no BaseUrl",
             () => Http.GetWait("/relative"), "BaseUrl"],
            ["a verb that is not one",
             () => Http.Request("GETT", "http://127.0.0.1:8471/", () => 0),
             "is not one of"],
            ["a negative Timeout",
             () => Http.Get("http://127.0.0.1:8471/", { Timeout: -5 }, () => 0),
             "Timeout"],
            ["a Proxy that is neither default nor null",
             () => Http.Client({ Proxy: 42 }), "Proxy"],
            ["an Auth that is not an object",
             () => Http.Client({ Auth: "x" }), "Auth"],
            ["an Auth without a Password",
             () => Http.Client({ Auth: { User: "u" } }), "Password"],
            ["a Proxy that is neither default, null, nor a URL",
             () => Http.Client({ Proxy: 42 }), "must be"],
            ["a Proxy to nowhere parseable",
             () => Http.Client({ Proxy: "gopher://x" }), "http(s) URL"],
            ["no connections at all",
             () => Http.Client({ MaxConns: 0 }), "at least"],
            ["a negative IdleTimeout",
             () => Http.Client({ IdleTimeout: -1 }), "negative"],
            ["a Log level that is not one",
             () => Http.Client({ Log: "chatty" }), "must be one of"],
            ["a Multipart with arguments",
             () => new Multipart("x"), "no arguments"],
            ["a Field without both",
             () => new Multipart().Field("only"), "needs both"],
            ["a File with a bad body",
             () => new Multipart().File("f", "a.txt", 42), "text or Bytes"],
            ["a GET with a multipart",
             () => Http.Get("http://127.0.0.1:8471/", m, () => 0),
             "no body"],
            ["a multipart with a ContentType",
             () => api.PostWait("/", m, { ContentType: "x" }),
             "its own Content-Type"],
            ["a Query that is not an object",
             () => Http.GetWait("http://127.0.0.1:8471/", { Query: "a=1" }),
             "Query must be an object"],
            ["a Timeout that is not a number",
             () => Http.GetWait("http://127.0.0.1:8471/", { Timeout: "soon" }),
             "is not a number"],
            ["a Timeout setter that is not a number",
             () => { api.Timeout = "soon"; }, "is not a number"],
            ["a Part that is not a number",
             () => m.Part("x"), "is not a number"],
            ["a Part past the end",
             () => m.Part(9), "beyond"],
            /* A verb refused in one spelling and passed to soup in the other
             * is the same call answering two ways. */
            ["a verb RequestWait does not know",
             () => Http.RequestWait("CONNECT", "http://127.0.0.1:8471/"),
             "is not one of GET"],
            ["...and the same one on a client",
             () => api.RequestWait("TRACE", "/"), "is not one of GET"],
            /* A URL where the options go configures nothing while looking
             * like it worked -- the shape somebody coming from fetch writes. */
            ["a Client built from a bare URL",
             () => Http.Client("http://127.0.0.1:8471/"), "the options are an object"],
            ["a Server built from a bare port",
             () => Http.Server(8080), "the options are an object"],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`refuses ${what}, by name`, complaint.includes(name), complaint);
        }

        /* The guard: the slow server answers in thirty seconds, the deadline
         * is 300 ms, and the throw lands on the deadline. */
        const started = Date.now();
        let complaint = "";
        try {
            Http.GetWait("http://127.0.0.1:8472/", { Timeout: 300 });
        } catch (e) {
            complaint = e.message;
        }
        check("a guarded Wait throws", complaint.includes("cannot reach"), complaint);
        check("...on the deadline, not after thirty seconds",
              Date.now() - started < 3000, Date.now() - started);

        fast.Stop();
        slow.Stop();
    }

    /* --- Http -----------------------------------------------------------
     *
     * The callback spelling, against one small server of our own on 127.0.0.1
     * that answers `/`, bounces `/redir`, sleeps on `/slow`, echoes the two
     * probe headers on `/headers` and takes a POST to `/sub`. Its assertions
     * land on later turns of the loop, so this runs in the async tail (see
     * NEEDS) and stops its server when the chain ends.
     */
    testHttp() {
        if (!Application.HasCommand("python3")) {
            failures.push("Http tests need python3 on the PATH");
            return;
        }

        let noSoup = false;
        try {
            Http.GetWait("http://127.0.0.1:9/", { Timeout: 200 });
        } catch (e) {
            noSoup = /without libsoup/.test(e.message);
        }
        if (noSoup) {
            /* The Wait test asserts the whole stub; one refusal here proves
             * the async verbs throw before starting too. */
            let complaint = "";
            try {
                Http.Get("http://127.0.0.1:9/", () => 0, () => 0);
            } catch (e) {
                complaint = e.message;
            }
            check("without libsoup, Http.Get says which package",
                  complaint.includes("without libsoup"), complaint);
            return;
        }

        const srv = Exec(["python3", "-c", [
            "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
            "import base64",
            "import time",
            "WANT = \"Basic \" + base64.b64encode(b\"u:p\").decode()",
            "class H(BaseHTTPRequestHandler):",
            "    def answer(self, status, body, ctype=\"text/plain\"):",
            "        try:",
            "            self.send_response(status)",
            "            self.send_header(\"Content-Type\", ctype)",
            "            self.send_header(\"Content-Length\", str(len(body)))",
            "            self.end_headers()",
            "            self.wfile.write(body)",
            "        except (BrokenPipeError, ConnectionResetError):",
            "            pass",
            "    def echo_verb(self):",
            "        self.answer(200, (\"got \" + self.command).encode())",
            "    def do_GET(self):",
            "        path = self.path.split(\"?\")[0]",
            "        if path == \"/redir\":",
            "            self.send_response(302)",
            "            self.send_header(\"Location\", \"/\")",
            "            self.end_headers()",
            "            return",
            "        if path == \"/slow\":",
            "            time.sleep(30)",
            "            self.answer(200, b\"late\")",
            "            return",
            "        if path == \"/auth\":",
            "            if self.headers.get(\"Authorization\") != WANT:",
            "                self.send_response(401)",
            "                self.send_header(\"WWW-Authenticate\", 'Basic realm=\"probe\"')",
            "                self.end_headers()",
            "                return",
            "            self.answer(200, b\"authed\")",
            "            return",
            "        if path == \"/headers\":",
            "            d = self.headers.get(\"X-Def\", \"\")",
            "            q = self.headers.get(\"X-Req\", \"\")",
            "            g = self.headers.get(\"Accept-Language\", \"\")",
            "            u = self.headers.get(\"User-Agent\", \"\")",
            "            self.answer(200, (\"x-def=\" + d + \" x-req=\" + q + \" lang=\" + g + \" ua=\" + u).encode())",
            "            return",
            "        if path == \"/login\":",
            "            self.send_response(200)",
            "            self.send_header(\"Set-Cookie\", \"session=abc; Path=/\")",
            "            self.send_header(\"Content-Length\", \"5\")",
            "            self.end_headers()",
            "            self.wfile.write(b\"login\")",
            "            return",
            "        if path == \"/whoami\":",
            "            b = self.headers.get(\"Cookie\", \"\").encode()",
            "            self.send_response(200)",
            "            self.send_header(\"Content-Length\", str(len(b)))",
            "            self.end_headers()",
            "            self.wfile.write(b)",
            "            return",
            "        if path == \"/\":",
            "            self.answer(200, b\"hola\")",
            "            return",
            "        self.send_error(404)",
            "    def do_POST(self):",
            "        n = int(self.headers.get(\"Content-Length\", 0))",
            "        data = self.rfile.read(n)",
            "        if self.path.split(\"?\")[0] == \"/echo\":",
            "            ct = self.headers.get(\"Content-Type\", \"\")",
            "            self.answer(200, (\"type=\" + ct + \" body=\" + data.decode(\"utf-8\", \"replace\")).encode())",
            "            return",
            "        if self.path.split(\"?\")[0] == \"/sub\":",
            "            self.answer(201, b\"creado\")",
            "        elif self.path.split(\"?\")[0] == \"/mp\":",
            "            ct = self.headers.get(\"Content-Type\", \"\")",
            "            ok = ct.startswith(\"multipart/form-data; boundary=\") and b'name=\"note\"' in data and b'hello' in data and b'filename=\"a.txt\"' in data and b'FILEDATA' in data",
            "            self.answer(200, (\"multipart ok\" if ok else \"multipart BROKEN\").encode())",
            "        else:",
            "            self.send_error(404)",
            "    def do_PUT(self):",
            "        n = int(self.headers.get(\"Content-Length\", 0))",
            "        data = self.rfile.read(n)",
            "        if self.path.split(\"?\")[0] == \"/mp\":",
            "            ct = self.headers.get(\"Content-Type\", \"\")",
            "            ok = ct.startswith(\"multipart/form-data; boundary=\") and b'hello' in data",
            "            self.answer(200, (\"multipart ok\" if ok else \"multipart BROKEN\").encode())",
            "        else:",
            "            self.echo_verb()",
            "    def do_PATCH(self):",
            "        n = int(self.headers.get(\"Content-Length\", 0))",
            "        self.rfile.read(n)",
            "        self.echo_verb()",
            "    def do_DELETE(self):",
            "        self.echo_verb()",
            "    def do_HEAD(self):",
            "        self.send_response(200)",
            "        self.send_header(\"Content-Length\", \"0\")",
            "        self.end_headers()",
            "    def log_message(self, *a):",
            "        pass",
            "ThreadingHTTPServer((\"127.0.0.1\", 8473), H).serve_forever()",
        ].join("\n")]);

        const api = Http.Client({ BaseUrl: "http://127.0.0.1:8473",
                                  Headers: { "X-Def": "1" }, Timeout: 5000 });
        /* Two in flight, one of them stopped: the shape a form takes when a
         * control that stays enabled is used twice before the first answer
         * lands (`examples/jokes`' category combo -- the button cannot do it,
         * since it disables itself). `Stop()` asks rather than undoes, so the
         * cancelled request still answers a turn later, *after* its
         * replacement is already flying. What makes that answer droppable is
         * that each callback is handed its own handle: without it a stale
         * error overwrites what the live request is doing, and the example
         * showed `Cancelled` with its button re-enabled while a good request
         * was still on its way. */
        const race = () => {
            let landed = 0;
            const done = () => { if (++landed === 2) steps[6](); };
            const stale = api.Get("/slow", () => {
                failures.push("the stopped request of the pair must not answer");
                done();
            }, (e, handle) => {
                eq("the stale answer is an error", e.Kind, "Cancelled");
                check("...handed the handle of the request that was stopped",
                      handle === stale, `${handle && handle.Url}`);
                check("...which is not the one still flying", handle !== live);
                done();
            });
            const live = api.Get("/", (r, handle) => {
                eq("the replacement answers for itself", r.Status, 200);
                check("...handed its own handle", handle === live,
                      `${handle && handle.Url}`);
                check("...not the stopped one's", handle !== stale);
                done();
            }, (e) => {
                failures.push(`the replacement errored: ${e.Message}`);
                done();
            });

            check("both are in flight before either answers",
                  stale.Running === true && live.Running === true);
            stale.Stop();
        };

        const steps = [
            () => {
                const h = api.Get("/", (r) => {
                    eq("async GET answers 200", r.Status, 200);
                    check("a text body arrives", r.Body.ToText().includes("hola"),
                          r.Body.ToText().slice(0, 40));
                    check("the handle is done before onDone runs",
                          h.Running === false);
                    steps[1]();
                }, (e) => {
                    failures.push(`async GET errored: ${e.Message}`);
                    steps[1]();
                });
                check("the handle runs while the request flies",
                      h.Running === true);
                eq("the handle names its method", h.Method, "GET");
                eq("...and its URL", h.Url, "http://127.0.0.1:8473/");
            },
            () => api.Get("/headers", { Headers: { "X-Req": "2" } }, (r) => {
                check("client defaults and request headers merge",
                      r.Body.ToText().includes("x-def=1") &&
                      r.Body.ToText().includes("x-req=2"),
                      r.Body.ToText());
                steps[2]();
            }, (e) => {
                failures.push(`headers errored: ${e.Message}`);
                steps[2]();
            }),
            () => api.Get("/redir", (r) => {
                eq("a redirect is followed", r.Status, 200);
                check("...to the final URL", r.Url === "http://127.0.0.1:8473/",
                      r.Url);
                steps[3]();
            }, (e) => {
                failures.push(`redirect errored: ${e.Message}`);
                steps[3]();
            }),
            () => api.Get("/redir", { FollowRedirects: false }, (r) => {
                eq("FollowRedirects false answers the 302", r.Status, 302);
                steps[4]();
            }, (e) => {
                failures.push(`unfollowed redirect errored: ${e.Message}`);
                steps[4]();
            }),
            () => api.Post("/sub", { a: 1 }, (r) => {
                eq("a POST answers 201", r.Status, 201);
                eq("...with the echoed body", r.Body.ToText(), "creado");
                steps[5]();
            }, (e) => {
                failures.push(`POST errored: ${e.Message}`);
                steps[5]();
            }),
            () => {
                const h = api.Get("/slow", (r) => {
                    failures.push("a stopped request must not answer");
                    race();
                }, (e) => {
                    eq("stopping calls onError Cancelled", e.Kind, "Cancelled");
                    check("...and leaves TimedOut false", h.TimedOut === false);
                    check("stopping a finished job answers false",
                          h.Stop() === false);
                    race();
                });
                check("stopping a live request answers true", h.Stop() === true);
            },
            () => {
                const h = api.Get("/slow", { Timeout: 300 }, (r) => {
                    failures.push("a timed-out request must not answer");
                    steps[7]();
                }, (e) => {
                    eq("the guard calls onError Timeout", e.Kind, "Timeout");
                    check("...and marks the handle", h.TimedOut === true);
                    steps[7]();
                });
            },
            () => {
                /* The blocking spelling, against this server rather than the
                 * dogfooded one: a Wait aimed at a server in our own loop is
                 * a deadlock, and these are the assertions that need Wait.
                 *
                 * An object where a body goes is a body -- unless it names an
                 * option. `FollowRedirects` was in the async list and not the
                 * blocking one, so a Wait asking for it posted its own
                 * options as JSON and configured nothing. */
                const wait = Http.Client({ BaseUrl: "http://127.0.0.1:8473",
                                           Timeout: 5000 });

                for (const [key, value] of [["Query", { z: "1" }], ["Headers", {}],
                                            ["Timeout", 5000], ["FollowRedirects", true],
                                            ["ContentType", "text/plain"], ["Body", ""],
                                            ["Auth", null]]) {
                    const got = wait.PostWait("/echo", { [key]: value }).Body.ToText();

                    check(`a ${key} makes the object options, not a body`,
                          got.endsWith("body="), got);
                }
                check("...and an object naming none of them is the body",
                      wait.PostWait("/echo", { hello: 1 }).Body.ToText().includes('"hello"'));

                /* A Content-Type written by hand beats the one the body's
                 * shape implies: the rule `Authorization` already followed. */
                const named = wait.PostWait("/echo", { hi: 1 },
                    { Headers: { "Content-Type": "application/vnd.me+json" } }).Body.ToText();

                check("a declared Content-Type wins over the inferred one",
                      named.startsWith("type=application/vnd.me+json"), named);
                check("...and the body still goes out", named.includes('"hi"'), named);

                const asked = wait.PostWait("/echo", { hi: 1 },
                    { ContentType: "application/vnd.opt+json" }).Body.ToText();

                check("...and an explicit ContentType still wins over both",
                      asked.startsWith("type=application/vnd.opt+json"), asked);

                /* What a Wait throws carries the same Kind the callbacks get,
                 * so a catch can tell a deadline from a refusal. */
                let thrown = null;

                try {
                    Http.GetWait("http://127.0.0.1:9/", { Timeout: 2000 });
                } catch (e) {
                    thrown = e;
                }
                check("a Wait throws", thrown !== null);
                check("...carrying the Kind the callbacks would have got",
                      thrown && (thrown.Kind === "Refused" || thrown.Kind === "Error"),
                      thrown && thrown.Kind);
                eq("...and a Status", thrown && thrown.Status, 0);

                api.Put("/echo", "x", (r) => {
                    eq("PUT answers", r.Status, 200);
                    eq("...echoing the verb", r.Body.ToText(), "got PUT");
                    api.Patch("/echo", "x", (r2) => {
                        eq("PATCH answers", r2.Status, 200);
                        eq("...echoing the verb", r2.Body.ToText(), "got PATCH");
                        api.Delete("/echo", (r3) => {
                            eq("DELETE answers", r3.Status, 200);
                            eq("...echoing the verb", r3.Body.ToText(), "got DELETE");
                            api.Head("/echo", (r4) => {
                                eq("HEAD answers", r4.Status, 200);
                                eq("...with no body", r4.Body.Length, 0);
                                steps[8]();
                            }, (e) => {
                                failures.push(`HEAD errored: ${e.Message}`);
                                steps[8]();
                            });
                        }, (e) => {
                            failures.push(`DELETE errored: ${e.Message}`);
                            steps[8]();
                        });
                    }, (e) => {
                        failures.push(`PATCH errored: ${e.Message}`);
                        steps[8]();
                    });
                }, (e) => {
                    failures.push(`PUT errored: ${e.Message}`);
                    steps[8]();
                });
            },
            () => {
                const authed = Http.Client({ BaseUrl: "http://127.0.0.1:8473",
                                             Auth: { User: "u", Password: "p" } });
                eq("Auth reads back", authed.Auth.User, "u");
                authed.Get("/auth", (r) => {
                    eq("client Auth answers 200", r.Status, 200);
                    eq("...authed", r.Body.ToText(), "authed");
                    const wrong = Http.Client({ BaseUrl: "http://127.0.0.1:8473",
                                                Auth: { User: "u", Password: "no" } });
                    wrong.Get("/auth", (r2) => {
                        eq("a wrong password answers 401", r2.Status, 401);
                        api.Get("/auth", { Auth: { User: "u", Password: "p" } }, (r3) => {
                            eq("per-request Auth wins", r3.Status, 200);
                            steps[9]();
                        }, (e) => {
                            failures.push(`request Auth errored: ${e.Message}`);
                            steps[9]();
                        });
                    }, (e) => {
                        failures.push(`wrong Auth errored: ${e.Message}`);
                        steps[9]();
                    });
                }, (e) => {
                    failures.push(`Auth errored: ${e.Message}`);
                    steps[9]();
                });
            },
            () => {
                const es = Http.Client({ BaseUrl: "http://127.0.0.1:8473",
                                         Language: "es", UserAgent: "Bintana-Test" });
                eq("Language reads back", es.Language, "es");
                es.Get("/headers", (r) => {
                    check("Language arrives as Accept-Language",
                          r.Body.ToText().includes("lang=es"), r.Body.ToText());
                    check("UserAgent arrives as itself",
                          r.Body.ToText().includes("ua=Bintana-Test"), r.Body.ToText());
                    const direct = Http.Client({ Proxy: null });
                    check("Proxy null reads back", direct.Proxy === null);
                    direct.Get("http://127.0.0.1:8473/", (r2) => {
                        eq("a proxyless client still answers", r2.Status, 200);
                        steps[10]();
                    }, (e) => {
                        failures.push(`proxy errored: ${e.Message}`);
                        steps[10]();
                    });
                }, (e) => {
                    failures.push(`language errored: ${e.Message}`);
                    steps[10]();
                });
            },
            () => {
                const m = new Multipart().Field("note", "hello")
                    .File("up", "a.txt", new Bytes("FILEDATA"), "text/plain");
                eq("a built multipart counts its parts", m.Length, 2);
                api.Post("/mp", m, (r) => {
                    eq("a multipart posts", r.Status, 200);
                    eq("...framed", r.Body.ToText(), "multipart ok");
                    api.Put("/mp", m, (r2) => {
                        eq("...and reposts with its verb", r2.Status, 200);
                        eq("...framed again", r2.Body.ToText(), "multipart ok");
                        steps[11]();
                    }, (e) => {
                        failures.push(`multipart PUT errored: ${e.Message}`);
                        steps[11]();
                    });
                }, (e) => {
                    failures.push(`multipart errored: ${e.Message}`);
                    steps[11]();
                });
            },
            () => {
                const jar = Http.Client({ BaseUrl: "http://127.0.0.1:8473",
                                          Cookies: true });
                check("Cookies reads back", jar.Cookies === true);
                jar.Get("/login", (r) => {
                    eq("login answers", r.Status, 200);
                    jar.Get("/whoami", (r2) => {
                        check("the jar sends the cookie back",
                              r2.Body.ToText().includes("session=abc"),
                              r2.Body.ToText());
                        api.Get("/whoami", (r3) => {
                            check("without a jar nothing is sent",
                                  !r3.Body.ToText().includes("session="),
                                  JSON.stringify(r3.Body.ToText()));
                            steps[12]();
                        }, (e) => {
                            failures.push(`nojar errored: ${e.Message}`);
                            steps[12]();
                        });
                    }, (e) => {
                        failures.push(`whoami errored: ${e.Message}`);
                        steps[12]();
                    });
                }, (e) => {
                    failures.push(`login errored: ${e.Message}`);
                    steps[12]();
                });
            },
            () => {
                const seen = [];
                const wasLevel = Logger.Level;
                Logger.Level = "Debug";
                Logger.Handler = (level, text) => seen.push(`${level}|${text}`);
                api.Log = "body";
                api.Get("/", (r) => {
                    eq("a logging request still answers", r.Status, 200);
                    check("its traffic reaches the Handler",
                          seen.some((l) => l.includes("GET / ")),
                          `${seen.length} lines`);
                    check("...headers and body alike",
                          seen.some((l) => l.includes("hola")),
                          `${seen.length} lines`);
                    check("...as Debug",
                          seen.length > 0 && seen.every((l) => l.startsWith("Debug|")));
                    api.Log = "none";
                    Logger.Handler = null;
                    Logger.Level = wasLevel;
                    steps[13]();
                }, (e) => {
                    failures.push(`logged request errored: ${e.Message}`);
                    api.Log = "none";
                    Logger.Handler = null;
                    Logger.Level = wasLevel;
                    steps[13]();
                });
            },
            () => {
                /* A forward proxy of our own on an ephemeral port, read back
                 * like the server's: it prints the request line it gets
                 * (absolute-form, which only proxies ever see) and pipes the
                 * rest through rewritten to origin-form. A hardcoded port
                 * here collides with yesterday's crashed run, the same
                 * lesson `Port: 0` teaches one test over. */
                let fwd = null;
                let hit = null;
                let res = null;
                let tries = 0;
                let done = false;
                const px = Http.Client({ Timeout: 8000 });
                const maybe = () => {
                    if (done || !hit || !res)
                        return;
                    done = true;
                    eq("through the proxy", res, 200);
                    if (fwd)
                        fwd.Stop();
                    steps[14]();
                };
                const giveup = (why) => {
                    if (done)
                        return;
                    done = true;
                    failures.push(why);
                    if (fwd)
                        fwd.Stop();
                    steps[14]();
                };
                const ask = () => {
                    tries++;
                    px.Get("http://127.0.0.1:8473/headers", (r) => {
                        res = r.Status;
                        /* Arrived without transiting is the bug this hunts:
                         * fail loudly instead of hanging for the runner. */
                        Timer.After(3000, () => {
                            if (!done)
                                giveup("proxy never saw it");
                        });
                        maybe();
                    }, (e) => {
                        /* The forwarder takes a moment; ask again. */
                        if (tries < 25)
                            Timer.After(200, ask);
                        else
                            giveup(`proxy errored: ${e.Message}`);
                    });
                };
                try {
                    fwd = Exec(["python3", "-u", "-c", [
                    "import socket, threading",
                    "def pipe(a, b):",
                    "    try:",
                    "        while True:",
                    "            d = a.recv(65536)",
                    "            if not d: break",
                    "            b.sendall(d)",
                    "    except OSError:",
                    "        pass",
                    "def handle(client):",
                    "    try:",
                    "        req = b\"\"",
                    "        while b\"\\r\\n\" not in req:",
                    "            chunk = client.recv(4096)",
                    "            if not chunk: break",
                    "            req += chunk",
                    "        line, rest = req.split(b\"\\r\\n\", 1)",
                    "        print(\"HIT \" + line.decode(\"latin-1\"), flush=True)",
                    "        parts = line.split(b\" \")",
                    "        uri = parts[1] if len(parts) > 1 else b\"/\"",
                    "        if b\"://\" in uri:",
                    "            uri = uri.split(b\"/\", 3)[2]",
                    "            uri = b\"/\" + uri.split(b\"/\", 1)[-1] if b\"/\" in uri else b\"/\"",
                    "        server = socket.create_connection((\"127.0.0.1\", 8473), timeout=10)",
                    "        server.sendall(parts[0] + b\" \" + uri + b\" \" + parts[2] + b\"\\r\\n\" + rest)",
                    "        t = threading.Thread(target=pipe, args=(server, client), daemon=True)",
                    "        t.start()",
                    "        pipe(client, server)",
                    "    except OSError:",
                    "        pass",
                    "    finally:",
                    "        try: client.close()",
                    "        except OSError: pass",
                    "ls = socket.socket()",
                    "ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
                    "ls.bind((\"127.0.0.1\", 0))",
                    "ls.listen(50)",
                    "print(\"PORT %d\" % ls.getsockname()[1], flush=True)",
                    "while True:",
                    "    c, _ = ls.accept()",
                    "    threading.Thread(target=handle, args=(c,), daemon=True).start()",
                ].join("\n")], (line) => {
                    if (line.startsWith("PORT ")) {
                        try {
                            px.Proxy = "http://127.0.0.1:" + line.slice(5).trim();
                        } catch (e) {
                            giveup(`proxy address failed: ${e.message}`);
                            return;
                        }
                        ask();
                    } else if (line.startsWith("HIT")) {
                        check("the proxy sees absolute-form",
                              line.includes("GET http://127.0.0.1:8473/headers"),
                              line);
                        hit = line;
                        maybe();
                    }
                });
                } catch (e) {
                    giveup(`proxy spawn failed: ${e.message}`);
                }
                /* No PORT line means the forwarder never came up: fail
                 * loudly instead of hanging for the runner. */
                Timer.After(10000, () => {
                    if (!done && tries === 0)
                        giveup("proxy never started");
                });
            },
            () => api.Get("/nobody", (r) => {
                eq("a 404 answers 404", r.Status, 404);
                srv.Stop();
                /* The chain holds itself: every step closes over `steps` and
                 * `steps` holds every step, so without this the whole chain
                 * is garbage the collector only finds if it happens to run
                 * before teardown -- and `JS_FreeRuntime` aborts on GC luck. */
                steps.length = 0;
                waiting--;
            }, (e) => {
                failures.push(`a 404 must not error: ${e.Message}`);
                srv.Stop();
                steps.length = 0;
                waiting--;
            }),
        ];

        until("the http server answers", () => {
            try {
                Http.GetWait("http://127.0.0.1:8473/", { Timeout: 200 });
                return true;
            } catch (e) {
                return false;
            }
        }, () => {
            /* Counted, like an until: the run ends from Exec's tail, and on
             * a loaded machine it gets there before a chain nobody counted
             * does -- which reads as a smaller total with nothing red, the
             * same silence `until` was taught to refuse. */
            waiting++;
            steps[0]();
        });
    }

    /* --- HttpStream -----------------------------------------------------
     *
     * The answer read as it arrives, against a server of our own that
     * dribbles: `/feed` writes five lines a fifth of a second apart, so the
     * claim being measured is that the first line lands long before the last
     * one could possibly have been sent. Both halves of that are asserted --
     * without the second, a server that answered all at once would pass.
     *
     * A test of its own rather than steps bolted onto `testHttp`, whose chain
     * is indexed by hand: inserting into it renumbers a dozen callbacks.
     */
    testHttpStream() {
        if (!Application.HasCommand("python3")) {
            failures.push("Http tests need python3 on the PATH");
            return;
        }

        let noSoup = false;
        try {
            Http.Stream("GET", "http://127.0.0.1:9/", () => 0).Stop();
        } catch (e) {
            noSoup = /without libsoup/.test(e.message);
        }
        if (noSoup)
            return;   /* the Wait test already asserts what the stub says */

        /* `python3 -u`: a buffered interpreter holds the dribble back and the
         * whole point of the test with it. */
        const srv = Exec(["python3", "-u", "-c", [
            "from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer",
            "import json, time",
            "class H(BaseHTTPRequestHandler):",
            "    def feed(self, sep, n, gap):",
            "        self.send_response(200)",
            "        self.send_header(\"Content-Type\", \"text/event-stream\")",
            "        self.end_headers()",
            "        try:",
            "            for i in range(n):",
            "                self.wfile.write(('data: %d' % i).encode() + sep + sep)",
            "                self.wfile.flush()",
            "                time.sleep(gap)",
            "        except (BrokenPipeError, ConnectionResetError):",
            "            pass",
            "    def do_GET(self):",
            "        if self.path == \"/feed\":",
            "            self.feed(b\"\\n\", 5, 0.2)",
            "            return",
            "        if self.path == \"/crlf\":",
            "            self.feed(b\"\\r\\n\", 3, 0.05)",
            "            return",
            "        if self.path == \"/forever\":",
            "            self.feed(b\"\\n\", 100000, 0.1)",
            "            return",
            "        if self.path == \"/gone\":",
            "            b = json.dumps({\"error\": \"no such feed\"}).encode()",
            "            self.send_response(404)",
            "            self.send_header(\"Content-Type\", \"application/json\")",
            "            self.send_header(\"Content-Length\", str(len(b)))",
            "            self.end_headers()",
            "            self.wfile.write(b)",
            "            return",
            "        self.send_error(404)",
            "    def do_POST(self):",
            "        n = int(self.headers.get(\"Content-Length\", 0))",
            "        words = json.loads(self.rfile.read(n).decode())[\"words\"]",
            "        self.send_response(200)",
            "        self.send_header(\"Content-Type\", \"text/plain\")",
            "        self.end_headers()",
            "        for w in words:",
            "            self.wfile.write((w + \"\\n\").encode())",
            "            self.wfile.flush()",
            "            time.sleep(0.05)",
            "    def log_message(self, *a):",
            "        pass",
            "ThreadingHTTPServer((\"127.0.0.1\", 8474), H).serve_forever()",
        ].join("\n")]);

        const api = Http.Client({ BaseUrl: "http://127.0.0.1:8474", Timeout: 5000 });
        const steps = [
            /* The measurement the issue asked for, the other way round. */
            () => {
                const t0 = Date.now();
                const got = [];
                let first = -1, last = -1;
                const h = api.Stream("GET", "/feed", { Timeout: 0 }, (line, handle) => {
                    if (first < 0) {
                        first = Date.now() - t0;
                        check("a streamed line is handed its own handle", handle === h);
                    }
                    last = Date.now() - t0;
                    got.push(line);
                }, (r) => {
                    check("the first line arrives long before the answer is finished",
                          first >= 0 && first < 500, `${first}ms`);
                    check("...and the last one much later, so it was read as it arrived",
                          last - first > 600, `${first}ms then ${last}ms`);
                    eq("every line arrives", got.filter((l) => l !== "").length, 5);
                    eq("...in order", got.filter((l) => l !== "").join("|"),
                       "data: 0|data: 1|data: 2|data: 3|data: 4");
                    check("...blank lines included, since that is what separates two events",
                          got.includes(""), JSON.stringify(got.slice(0, 4)));
                    eq("a streamed answer still carries its status", r.Status, 200);
                    eq("...and its headers", r.Headers["content-type"], "text/event-stream");
                    eq("...and an empty Body, because it already went out line by line",
                       r.Body.Length, 0);
                    eq("...whose ToText is the empty string rather than a throw",
                       r.Body.ToText(), "");
                    check("the handle is finished before onDone runs", h.Running === false);
                    steps[1]();
                }, (e) => {
                    failures.push(`the feed errored: ${e.Message}`);
                    steps[1]();
                });
                check("a streaming request is running like any other", h.Running === true);
                eq("...and names its method", h.Method, "GET");
            },
            /* HTTP is a CRLF protocol and GLib's default newline is LF. */
            () => {
                const got = [];
                api.Stream("GET", "/crlf", (line) => got.push(line), () => {
                    check("a CRLF feed arrives with no carriage return left on it",
                          got.length > 0 && got.every((l) => !l.includes("\r")),
                          JSON.stringify(got));
                    check("...and its blank separator is empty, not a stray \\r",
                          got.includes(""), JSON.stringify(got));
                    steps[2]();
                }, (e) => {
                    failures.push(`the CRLF feed errored: ${e.Message}`);
                    steps[2]();
                });
            },
            /* An error page is an answer, not a feed. */
            () => {
                let called = 0;
                api.Stream("GET", "/gone", () => called++, (r) => {
                    eq("a 404 answers 404 even asked for as a stream", r.Status, 404);
                    eq("...without calling the line callback once", called, 0);
                    check("...and carries its whole body, which is the point of it",
                          r.Body.ToText().includes("no such feed"), r.Body.ToText());
                    steps[3]();
                }, (e) => {
                    failures.push(`a 404 must not error: ${e.Message}`);
                    steps[3]();
                });
            },
            /* Stopping from inside the line callback: the segfault File.Watch
             * learned about, and the reason for the calling/dead pair. */
            () => {
                let n = 0;
                const h = api.Stream("GET", "/forever", { Timeout: 0 }, (line, handle) => {
                    if (line !== "" && ++n === 3)
                        handle.Stop();
                }, () => {
                    failures.push("a stopped stream must not answer onDone");
                    steps[4]();
                }, (e) => {
                    eq("stopping from inside the line callback answers Cancelled",
                       e.Kind, "Cancelled");
                    eq("...and no line arrives after it", n, 3);
                    check("...leaving TimedOut false", h.TimedOut === false);
                    check("...and the handle finished", h.Running === false && h.Stop() === false);
                    steps[4]();
                });
            },
            /* The guard cuts a feed like any other flight -- and what already
             * arrived stays arrived, which is what a short Timeout could not
             * give before. */
            () => {
                const kept = [];
                api.Stream("GET", "/forever", { Timeout: 700 },
                           (line) => { if (line !== "") kept.push(line); }, () => {
                    failures.push("a timed-out stream must not answer onDone");
                    steps[5]();
                }, (e) => {
                    eq("a guard cuts a stream like any other flight", e.Kind, "Timeout");
                    check("...and the lines from before the deadline are not taken back",
                          kept.length > 0, kept.length);
                    steps[5]();
                });
            },
            /* A body, and an answer that arrives in pieces: the shape a
             * completions endpoint has. */
            () => {
                const got = [];
                const h = api.Stream("POST", "/echo", { words: ["uno", "dos", "tres"] },
                                     (line) => { if (line !== "") got.push(line); }, (r) => {
                    eq("a streamed POST sends its body", got.join(","), "uno,dos,tres");
                    eq("...and answers 200", r.Status, 200);
                    eq("...with the method on its handle", h.Method, "POST");
                    steps[6]();
                }, (e) => {
                    failures.push(`the streamed POST errored: ${e.Message}`);
                    steps[6]();
                });
            },
            /* The refusals, and the end of the chain. */
            () => {
                throws("a Stream with no line callback is refused",
                       () => api.Stream("GET", "/feed"));
                throws("...and so is one whose line callback is not a function",
                       () => api.Stream("GET", "/feed", 7));
                throws("a Stream refuses a verb it does not know",
                       () => api.Stream("FETCH", "/feed", () => 0));
                throws("Http.Stream needs a method before the url",
                       () => Http.Stream());
                srv.Stop();
                /* The chain holds itself -- see testHttp, and AGENTS.md. */
                steps.length = 0;
                waiting--;
            },
        ];

        until("the stream server answers", () => {
            try {
                Http.GetWait("http://127.0.0.1:8474/gone", { Timeout: 200 });
                return true;
            } catch (e) {
                return false;
            }
        }, () => {
            waiting++;   /* counted, like an until: see testHttp's tail */
            steps[0]();
        });
    }

    /* --- HttpServer -----------------------------------------------------
     *
     * Serving, dogfooded through the client: no python, no external net. The
     * dogfood is async on purpose -- a Wait would freeze the loop this same
     * server answers on, which is a deadlock and not a test. Ephemeral port,
     * read back: a hardcoded one collides with yesterday's crashed run.
     */
    testHttpServer() {
        let noSoup = false;
        try {
            Http.Server({ Port: 0 });
        } catch (e) {
            noSoup = /without libsoup/.test(e.message);
            if (!noSoup)
                throw e;
        }
        if (noSoup) {
            /* The Wait test asserts the client stub; one refusal here proves
             * the server is the same story. */
            let complaint = "";
            try {
                Http.Server({ Port: 0 });
            } catch (e) {
                complaint = e.message;
            }
            check("without libsoup, Http.Server says which package",
                  complaint.includes("without libsoup"), complaint);
            return;
        }

        /* The server under test is ours, and so is the client asking it, so
         * nothing outside is needed until the TLS step -- which wants a
         * certificate and something that speaks https to check it with. Both
         * are made here rather than committed: a key in the tree is a key
         * that expires one day with nobody watching, and a fixture nobody
         * generated is a fixture nobody can regenerate. Missing either tool
         * skips that one step; it never fails the suite for a machine that
         * simply does not have openssl. */
        const tlsDir = File.Join(Environment.TempDirectory,
                                 `bintana-tls-${Environment.ProcessId}`);
        const TlsCert = File.Join(tlsDir, "server.crt");
        const TlsKey = File.Join(tlsDir, "server.key");
        let canTls = Application.HasCommand("openssl") && Application.HasCommand("python3");

        if (canTls) {
            Directory.Make(tlsDir);
            const made = Exec.Wait(["openssl", "req", "-x509", "-newkey", "rsa:2048",
                                    "-nodes", "-days", "1",
                                    "-keyout", TlsKey, "-out", TlsCert,
                                    "-subj", "/CN=127.0.0.1",
                                    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
                                   { Timeout: 30000 });

            canTls = made.ExitCode === 0 && File.Exists(TlsCert) && File.Exists(TlsKey);
            if (!canTls)
                print(`  (skipping the TLS step: openssl exited ${made.ExitCode})`);
        } else {
            print("  (skipping the TLS step: it needs openssl and python3)");
        }

        const srv = Http.Server({ Port: 0 });
        eq("a new server is not running", srv.Running, false);
        eq("its URL is empty until Start", srv.Url, "");
        eq("its port is declared until Start", srv.Port, 0);

        let complaint = "";
        try {
            srv.Start();
        } catch (e) {
            complaint = e.message;
        }
        check("Start without Request is refused", complaint.includes("Request is required"),
              complaint);

        complaint = "";
        try {
            srv.Request = "answer";
        } catch (e) {
            complaint = e.message;
        }
        check("Request must be a function", complaint.includes("must be a function"),
              complaint);

        eq("Tls starts empty", srv.Tls, null);
        eq("Allow starts open", JSON.stringify(srv.Allow), "[]");
        eq("Auth starts open", srv.Auth, null);
        srv.Tls = { Cert: "a", Key: "b" };
        eq("Tls reads back", srv.Tls.Key, "b");
        srv.Tls = null;
        eq("...and clears", srv.Tls, null);
        srv.Allow = ["127.0.0.1"];
        eq("Allow reads back", JSON.stringify(srv.Allow), '["127.0.0.1"]');
        srv.Allow = null;
        srv.Auth = { Realm: "r", Users: { u: "p" } };
        eq("Auth reads back", srv.Auth.Users.u, "p");
        srv.Auth = null;
        eq("...and clears", srv.Auth, null);

        for (const [what, fn, name] of [
            ["Tls that is not an object", () => { srv.Tls = "x"; }, "Tls"],
            ["Tls without a Key", () => { srv.Tls = { Cert: "a" }; }, "Cert and a Key"],
            ["Allow that is not a list", () => { srv.Allow = "x"; }, "Allow"],
            ["Auth without Users", () => { srv.Auth = { Realm: "r" }; }, "Realm and Users"],
        ]) {
            let complaint = "";
            try {
                fn();
            } catch (e) {
                complaint = e.message;
            }
            check(`refuses ${what}, by name`, complaint.includes(name), complaint);
        }

        /* The shape every server is written in: a handler closing over the
         * server it belongs to. Held from C without being reported to the
         * collector, that pair is a cycle nothing can see -- a listening
         * socket nothing can reach and nothing can free. Made and dropped
         * here so the sanitizer run walks it; the collection itself is not
         * something this suite can force, since there is no `gc()` in the
         * language. */
        {
            const looped = Http.Server({ Port: 0 });

            looped.Request = (req) => req.Answer(200, looped.Url);
            looped.Start();
            check("a server its own handler names still listens",
                  looped.Running === true);
            looped.Stop();
        }

        srv.Request = (req) => {
            if (req.Path === "/echo") {
                req.Answer(200, { method: req.Method, path: req.Path,
                                  q: req.Query, agent: req.Headers["user-agent"],
                                  body: req.Body.ToText(), remote: req.Remote,
                                  type: req.Headers["content-type"] || "" });
            } else if (req.Path === "/declared") {
                /* An object body implies application/json; the header names
                 * something else, and the named one is the specific spelling. */
                req.Answer(200, { ok: true },
                           { Headers: { "Content-Type": "application/vnd.me+json" } });
            } else if (req.Path === "/mp") {
                try {
                    const mp = req.Multipart();
                    const parts = [];

                    for (let i = 0; i < mp.Length; i++) parts.push(mp.Part(i));
                    req.Answer(200, { count: mp.Length, parts });
                } catch (e) {
                    req.Answer(400, e.message);
                }
            } else if (req.Path === "/hi") {
                req.Answer(200, "hola");
            } else if (req.Path === "/badanswer") {
                try {
                    req.Answer("lots");
                } catch (e) {
                    req.Answer(200, e.message);
                }
            } else if (req.Path === "/silent") {
                /* falls off: the runtime answers 500 */
            } else {
                req.Answer(404, "nope");
            }
        };
        srv.Start();
        check("listening", srv.Running === true);
        check("on an ephemeral port", srv.Port !== 0, srv.Port);
        check("answered locally", srv.Url.startsWith("http://127.0.0.1:"),
              srv.Url);

        complaint = "";
        try {
            srv.Start();
        } catch (e) {
            complaint = e.message;
        }
        check("a second Start is refused", complaint.includes("already running"),
              complaint);

        complaint = "";
        try {
            srv.Port = "eighty";
        } catch (e) {
            complaint = e.message;
        }
        check("a Port that is not a number is refused", complaint.includes("is not a number"),
              complaint);

        /* Counted: like testHttp's chain, or the tail ends the run early --
         * and emptied at the end, for the same cycle the other chain taught. */
        waiting++;
        const api = Http.Client({ BaseUrl: srv.Url, Timeout: 5000,
                                  Headers: { "User-Agent": "Dogfood/1" } });
        const finish = () => {
            srv.Stop();
            if (File.Exists(TlsCert)) File.Delete(TlsCert);
            if (File.Exists(TlsKey)) File.Delete(TlsKey);
            if (File.IsDir(tlsDir)) Directory.Delete(tlsDir);
            steps.length = 0;
            waiting--;
        };
        const steps = [
            () => steps.pending = api.Get("/echo?r=1&r=2", { Query: { a: "1", b: "x y" } }, (r, handle) => {
                eq("dogfood answers 200", r.Status, 200);
                const echo = JSON.parse(r.Body.ToText());
                eq("...the method", echo.method, "GET");
                eq("...the path", echo.path, "/echo");
                eq("...the query", echo.q.b, "x y");
                eq("...repeats keep the last", echo.q.r, "2");
                eq("...the headers", echo.agent, "Dogfood/1");
                eq("...an empty body", echo.body, "");
                check("...the remote", echo.remote === "127.0.0.1", echo.remote);
                /* The handle rides along, so a form with two requests in the
                 * air can tell whose answer this is. */
                check("...and the callback is handed its own handle",
                      handle === steps.pending, `${handle && handle.Url}`);
                steps[1]();
            }, (e) => {
                failures.push(`dogfood errored: ${e.Message}`);
                finish();
            }),
            () => api.Post("/echo", { hello: "world" }, (r2) => {
                const posted = JSON.parse(r2.Body.ToText());

                eq("a posted body arrives", posted.body,
                   JSON.stringify({ hello: "world" }, null, 2) + "\n");
                eq("...typed by its shape", posted.type, "application/json");
                steps[2]();
            }, (e) => {
                failures.push(`POST errored: ${e.Message}`);
                finish();
            }),
            () => api.Get("/nobody", (r3) => {
                eq("unknown paths answer 404", r3.Status, 404);
                eq("...with the handler's words", r3.Body.ToText(), "nope");
                steps[3]();
            }, (e) => {
                failures.push(`404 errored: ${e.Message}`);
                finish();
            }),
            () => {
                srv.Allow = ["127.0.0.1"];
                api.Get("/hi", (ra) => {
                    eq("allowed remotes answer", ra.Status, 200);
                    srv.Allow = ["10.9.9.9"];
                    api.Get("/hi", (rb) => {
                        eq("others get 403", rb.Status, 403);
                        srv.Allow = null;
                        srv.Auth = { Realm: "probe", Users: { u: "p" } };
                        api.Get("/hi", (rc) => {
                            eq("no credentials answer 401", rc.Status, 401);
                            check("...challenged",
                                  (rc.Headers["www-authenticate"] || "")
                                      .includes("Basic realm=") &&
                                  (rc.Headers["www-authenticate"] || "")
                                      .includes("probe"),
                                  rc.Headers["www-authenticate"]);
                            api.Get("/hi", { Auth: { User: "u", Password: "no" } }, (rd) => {
                                eq("wrong ones too", rd.Status, 401);
                                api.Get("/hi", { Auth: { User: "u", Password: "p" } }, (re) => {
                                    eq("right ones pass", re.Status, 200);
                                    srv.Auth = null;
                                    api.Get("/hi", (rf) => {
                                        eq("open again", rf.Status, 200);
                                        steps[4]();
                                    }, (e) => {
                                        failures.push(`reopened errored: ${e.Message}`);
                                        finish();
                                    });
                                }, (e) => {
                                    failures.push(`authed errored: ${e.Message}`);
                                    finish();
                                });
                            }, (e) => {
                                failures.push(`wrong errored: ${e.Message}`);
                                finish();
                            });
                        }, (e) => {
                            failures.push(`gated errored: ${e.Message}`);
                            finish();
                        });
                    }, (e) => {
                        failures.push(`forbidden errored: ${e.Message}`);
                        finish();
                    });
                }, (e) => {
                    failures.push(`allowed errored: ${e.Message}`);
                    finish();
                });
            },
            () => {
                if (!canTls) {
                    steps[5]();
                    return;
                }
                srv.Stop();
                srv.Tls = { Cert: TlsCert, Key: TlsKey };
                try {
                    srv.Start();
                } catch (e) {
                    failures.push(`tls Start threw: ${e.message}`);
                    finish();
                    return;
                }
                check("https url", srv.Url.startsWith("https://"), srv.Url);

                try {
                    Exec(["python3", "-c", [
                        "import http.client, ssl",
                        "ctx = ssl._create_unverified_context()",
                        `c = http.client.HTTPSConnection("127.0.0.1", ${srv.Port}, context=ctx, timeout=10)`,
                        "c.request(\"GET\", \"/hi\")",
                        "r = c.getresponse()",
                        "print(\"TLS-OK\" if r.status == 200 and r.read() == b\"hola\" else \"TLS-BAD\")",
                    ].join("\n")],
                    (line) => {
                        check("tls answers", line.includes("TLS-OK"), line);
                    },
                    (code) => {
                        eq("tls probe exits", code, 0);
                        srv.Stop();
                        srv.Tls = null;
                        srv.Start();
                        steps[5]();
                    });
                } catch (e) {
                    failures.push(`tls probe could not run: ${e.message}`);
                    srv.Stop();
                    srv.Tls = null;
                    srv.Start();
                    steps[5]();
                }
            },
            () => {
                const m = new Multipart().Field("note", "hello")
                    .File("up", "a.txt", new Bytes("FILEDATA"), "text/plain");
                api.Post("/mp", m, (r) => {
                    eq("a parsed upload answers", r.Status, 200);
                    const got = JSON.parse(r.Body.ToText());
                    eq("...two parts", got.count, 2);
                    eq("...the field", got.parts[0].Name, "note");
                    eq("...its text", got.parts[0].Data, "aGVsbG8=");
                    eq("...the file", got.parts[1].Filename, "a.txt");
                    eq("...its type", got.parts[1].Type, "text/plain");
                    eq("...its bytes", got.parts[1].Data, "RklMRURBVEE=");
                    api.Post("/mp", { plain: "json" }, (r2) => {
                        eq("a plain body is not multipart", r2.Status, 400);
                        steps[6]();
                    }, (e) => {
                        failures.push(`plain-mp errored: ${e.Message}`);
                        finish();
                    });
                }, (e) => {
                    failures.push(`multipart errored: ${e.Message}`);
                    finish();
                });
            },
            () => api.Get("/badanswer", (r4) => {
                eq("a bad status answers", r4.Status, 200);
                check("...naming what arrived",
                      r4.Body.ToText().includes("is not a number"), r4.Body.ToText());
                steps[7]();
            }, (e) => {
                failures.push(`badanswer errored: ${e.Message}`);
                finish();
            }),
            () => api.Get("/silent", (r5) => {
                eq("no answer is a 500", r5.Status, 500);
                check("stopping answers true", srv.Stop() === true);
                check("...and then false", srv.Stop() === false);
                check("...and Running goes", srv.Running === false);
                steps.length = 0;
                waiting--;
            }, (e) => {
                failures.push(`silent errored: ${e.Message}`);
                srv.Stop();
                steps.length = 0;
                waiting--;
            }),
        ];
        steps[0]();
    }

    /* --- Lock ----------------------------------------------------------- */
    testLock() {
        /* A name is what two threads share, so it has to be one. */
        throws("Lock.Hold needs a name", () => Lock.Hold(7, () => {}));
        throws("...and a function", () => Lock.Hold("x"));
        throws("...and a name that is a name", () => Lock.Hold("", () => {}));

        let ran = false;
        Lock.Hold("bta-test", () => { ran = true; });
        check("Lock.Hold runs the function", ran);

        /*
         * Recursive, like `lock` in .NET and `synchronized` in Java. With a
         * plain GMutex this line is where the suite would stop forever, which
         * is why it is an assertion and not a comment.
         */
        let depth = 0;
        Lock.Hold("bta-test", () => {
            depth++;
            Lock.Hold("bta-test", () => { depth++; });
        });
        eq("a nested hold of one name does not deadlock", depth, 2);

        /*
         * A throw comes out and the lock does not stay held -- the unlock is
         * in C after the call, which is the whole reason this is a callback
         * and not Enter/Leave.
         */
        let said = "";
        try {
            Lock.Hold("bta-test", () => { throw new Error("boom"); });
        } catch (e) {
            said = e.message;
        }
        eq("a throw inside comes back out", said, "boom");
        let after = false;
        Lock.Hold("bta-test", () => { after = true; });
        check("...and the lock was released anyway", after);

        /* It answers nothing, deliberately: a critical section is a statement
         * everywhere else, and leaving the value unspoken keeps it free for a
         * future Try(). */
        eq("Hold answers nothing", Lock.Hold("bta-test", () => 42), undefined);
    }

    /* --- Task ----------------------------------------------------------- */
    /*
     * **A task class whose file appears after the first `Start` is found.**
     *
     * The file a worker is given is looked up in a cache of the project's
     * `.js`, built once and keyed by the project directory. It used to be
     * believed on a miss, so a `<Name>.js` created while the program ran stayed
     * invisible for the life of the process -- while the comment over it
     * claimed it rebuilt on a miss "the way form_path rebuilds on one", which
     * is a description of a different program.
     *
     * Driven as a **child**, the way `testDebugger` is, because the thing being
     * asserted is a process-lifetime cache: this project's own directory is the
     * one that would have to be written into otherwise, and a test that leaves
     * a `.js` in the tree is worse than no test. The class is declared in a file
     * named after nothing, so the first `Start` misses for real.
     */
    taskClassAppears() {
        const proj = File.Join(SCRATCH, "lateclass");

        Directory.Make(proj);
        File.Save(File.Join(proj, "project.json"),
                  JSON.stringify({ name: "lateclass", main: "Main",
                                   sources: ["Workers.js", "Main.js"] }));
        File.Save(File.Join(proj, "Workers.js"),
                  '"use strict";\n' +
                  'class Later extends Task {\n' +
                  '    Run(msg) { return { doubled: msg.n * 2 }; }\n}\n');
        File.Save(File.Join(proj, "Main.js"),
                  '"use strict";\n' +
                  'function Main() {\n' +
                  '    try { new Later().Start({ n: 21 }); print("1st: started"); }\n' +
                  '    catch (e) { print("1st: " + e.message); }\n' +
                  '    File.Save(File.Join(Application.Directory, "Later.js"),\n' +
                  '        \'"use strict";\\nclass Later extends Task {\\n\' +\n' +
                  '        \'    Run(msg) { return { doubled: msg.n * 2 }; }\\n}\\n\');\n' +
                  '    const t = new Later();\n' +
                  '    t.Done  = (r) => { print("2nd: " + r.doubled); Application.Quit(0); };\n' +
                  '    t.Error = (m) => { print("2nd: error " + m); Application.Quit(1); };\n' +
                  '    try { t.Start({ n: 21 }); }\n' +
                  '    catch (e) { print("2nd: " + e.message); Application.Quit(1); }\n' +
                  '}\n');
        /* Left over from a previous run, or the first Start would find it. */
        const late = File.Join(proj, "Later.js");

        if (File.Exists(late)) File.Delete(late);

        const r = Exec.Wait([Application.Executable, proj]);

        check("a task class with no file of its own is refused",
              r.Output.includes("1st: Task: cannot find task class 'Later'"),
              r.Output);
        check("...and is found once that file appears",
              r.Output.includes("2nd: 42"), r.Output);
        eq("...with the program closing cleanly", r.ExitCode, 0);
    }

    testTask() {
        /* Abstract, like Widget's own abstract classes: a base with no work. */
        throws("Task is abstract", () => new Task());
        this.taskClassAppears();
        /* One run: the second Start is refused, whatever the first one did. */
        throws("a Task runs once", () => {
            const t = new TaskWork();

            t.Done = () => {}; t.Error = () => {};
            t.Start({}); t.Start({});
        });
        /* A message JSON would silently subset is refused instead. */
        throws("a function does not cross", () => {
            const t = new TaskWork();

            t.Done = () => {}; t.Error = () => {};
            t.Start({ f: () => {} });
        });
        /* And Report is the worker's voice: on a proxy it is at the wrong end. */
        throws("Report is refused on the handle", () => new TaskWork().Report(1));

        /*
         * The asynchronous half, as a list of steps rather than a pyramid.
         *
         * **One place counts and one place stops counting.** The first version
         * of this decremented only on the happy path, so a failing assertion
         * left the run hanging instead of red -- the same mistake `until` has
         * a comment about. `finish` is idempotent and every ending goes
         * through it.
         */
        waiting++;
        let done = false;
        const finish = () => { if (!done) { done = true; waiting--; } };
        const fail = (why) => { failures.push(`Task: ${why}`); finish(); };

        /* Each step starts the next; the last one finishes. */
        const steps = [];
        const next = () => {
            const step = steps.shift();

            if (step) step(); else finish();
        };

        /* A round trip: what went in comes back, decimals included. */
        steps.push(() => {
            const t = new TaskWork();

            t.Error = (m) => fail(`echo errored: ${m}`);
            t.Done  = (r) => {
                eq("a round trip keeps numbers", r.n, 7);
                check("...and lists", sameJson(r.list, [1, "a", true, null, { k: "v" }]),
                      JSON.stringify(r.list));
                eq("...and decimals stay exact", r.total.toString(), "19.99");
                check("a finished task is not Running", t.Running === false);
                next();
            };
            t.Start({ mode: "echo", n: 7,
                      list: [1, "a", true, null, { k: "v" }],
                      total: new Decimal("19.99") });
            check("a task starts out Running", t.Running === true);
        });

        /*
         * The worker's Decimal is *the* Decimal, out of bta_decimal.c.
         *
         * This is the assertion the whole design turns on: a class id
         * registers into a second runtime, so there is one exact type in one
         * file and not a lookalike per thread. The abandoned version answered
         * 9.999999999 to the first of these.
         */
        steps.push(() => {
            const t = new TaskWork();

            t.Error = (m) => fail(`exact errored: ${m}`);
            t.Done  = (r) => {
                eq("thirds survive a worker", r.third, "10");
                eq("...and tenths are exact", r.price, "59.97");
                eq("...and Round is there", r.round, "20.0");
                check("...and Split adds back up",
                      sameJson(r.split, ["3.34", "3.33", "3.33"]),
                      JSON.stringify(r.split));
                eq("...and comparisons answer", r.cmp, true);
                check("a decimal comes back a Decimal", r.back instanceof Decimal);
                next();
            };
            t.Start({ mode: "exact", price: new Decimal("19.99") });
        });

        /* rad.js runs in the worker too, which is what gives it a way to walk
         * the keys of a message at all. */
        steps.push(() => {
            const t = new TaskWork();

            t.Error = (m) => fail(`prelude errored: ${m}`);
            t.Done  = (r) => {
                eq("a worker walks keys with Dictionary", r.keys, "mode");
                eq("...and has Regex", r.regex, "bbb");
                eq("...and Stopwatch", r.stopwatch, "function");
                eq("...and Record", r.record, "function");
                eq("...and Table", r.table, "function");
                /* And not what would fire on the main loop, or is ours. */
                eq("a worker has no Timer", r.timer, "undefined");
                eq("...no Settings", r.settings, "undefined");
                eq("...no Exec", r.exec, "undefined");
                /* The curation crosses with rad.js, and says the true thing on
                 * this side: there is no `Locale` here to be sent to. */
                eq("...and no Locale", r.locale, "undefined");
                check("localeCompare is refused in a worker too",
                      r.lc.includes("code units"), r.lc);
                check("...naming the main thread, since Locale is not here",
                      r.lc.includes("main thread"), r.lc);
                next();
            };
            t.Start({ mode: "prelude" });
        });

        /*
         * A worker writes, and the lock is not what lets it.
         *
         * These eleven were refused once "until there is a lock", which named
         * a real gap and aimed it at the wrong danger: `File.Save` renames a
         * temporary over the target, so two threads cannot tear one file. The
         * lost update is what a lock is for, and that is a sequence the
         * program writes rather than a call the runtime can guard. What stays
         * refused is the one thing that would reach the main loop.
         */
        steps.push(() => {
            const t = new TaskWork();

            t.Error = (m) => fail(`writes errored: ${m}`);
            t.Done  = (r) => {
                eq("a worker writes a file and reads it back", r.back, 7);
                check("...and renames one", r.moved === true);
                check("...and deletes one", r.gone === true);
                check("...and makes and sweeps a folder", r.swept === true);
                check("a worker may still not hand work to the loop",
                      r.watch.includes("main loop"), r.watch);
                next();
            };
            t.Start({ mode: "writes", n: 7, dir: Environment.TempDirectory });
        });

        /*
         * Four tasks and one counter: what a lock is actually for.
         *
         * Each of `File.LoadJson` and `File.SaveJson` is atomic on its own --
         * the save renames a temporary over the target -- and the total still
         * comes out short without the hold, because the gap is between them.
         * Measured while this was written: 68 of 240 unlocked, 240 of 240
         * held. Only the held half is asserted, because losing an update is a
         * race and a race can win.
         */
        steps.push(() => {
            const path   = File.Join(Environment.TempDirectory, "bta-lock-book.json");
            const rounds = 40, n = 4;
            let   left   = n;

            File.SaveJson(path, { total: 0 });
            for (let i = 0; i < n; i++) {
                const t = new TaskWork();

                t.Error = (m) => fail(`adds errored: ${m}`);
                t.Done  = () => {
                    if (--left) return;
                    eq("four tasks holding one lock lose no update",
                       File.LoadJson(path).total, n * rounds);
                    File.Delete(path);
                    next();
                };
                t.Start({ mode: "adds", path, rounds, lock: "bta-suite-book" });
            }
        });

        /* Reports arrive in order, and all of them before Done. */
        steps.push(() => {
            const t = new TaskWork();
            const seen = [];

            t.Progress = (p) => seen.push(p);
            t.Error = (m) => fail(`progress errored: ${m}`);
            t.Done  = (r) => {
                check("progress arrives in order", sameJson(seen, [1, 2, 3]),
                      JSON.stringify(seen));
                eq("...before Done does", r.ok, true);
                next();
            };
            t.Start({ mode: "progress" });
        });

        /* A throw reaches Error with both halves Application.OnError takes. */
        steps.push(() => {
            const t = new TaskWork();

            t.Done  = () => fail("a throw must not reach Done");
            t.Error = (m, stack) => {
                check("a throw reaches Error with its message",
                      String(m).includes("task boom 42"), String(m));
                check("...and a stack", typeof stack === "string" && stack.length > 0);
                check("a failed task is not Running", t.Running === false);
                next();
            };
            t.Start({ mode: "boom", n: 42 });
        });

        /* The guard ends a run that will not end itself, and says it was the
         * guard -- an ending the exit code of a child could never tell apart. */
        steps.push(() => {
            const t = new TaskWork();

            t.Done  = () => fail("a timeout must not reach Done");
            t.Error = (m) => {
                check("a timeout reports itself", String(m).includes("timed out"),
                      String(m));
                check("...on the handle too", t.TimedOut === true);
                /* The two endings are told apart by flags and not by reading
                 * the sentence -- which is what this used to have to do. */
                check("...and a timeout is not a cancel", t.Cancelled === false);
                next();
            };
            t.Start({ mode: "spin" }, { Timeout: 1000 });
        });

        /*
         * A stop is asked before it is enforced.
         *
         * **The flag the worker reads is the whole point.** `Stop()` raises
         * it and the interrupt handler deliberately ignores it, so a `Run`
         * watching `this.Stopping` reports what it has and returns -- and the
         * partial work arrives as `Progress` before the ending does. Without
         * that, everything the job had measured was thrown away.
         */
        steps.push(() => {
            const t = new TaskWork();
            let saved = 0;

            t.Progress = (p) => { saved = p.saved; };
            t.Done  = () => fail("a stop must not reach Done");
            t.Error = (m) => {
                check("a stop reports itself", String(m).includes("cancelled"),
                      String(m));
                check("...on the handle too", t.Cancelled === true);
                check("...and is not a timeout", t.TimedOut === false);
                check("a stopped worker keeps what it had measured", saved > 0,
                      String(saved));
                check("...and Stopping is false once it has ended",
                      t.Stopping === false);
                next();
            };
            t.Start({ mode: "partial" });
            check("a running task is not Stopping", t.Stopping === false);
            Timer.After(200, () => {
                check("stopping reports there was something to stop",
                      t.Stop() === true);
                check("...and the handle says so", t.Stopping === true);
            });
        });

        /*
         * And a `Run` that never looks is ended anyway, `KillAfter` later.
         *
         * Two stages, the same two `Exec`'s guard has: ask, then insist. The
         * default is five seconds like Exec's; this one asks for a short one
         * so the suite does not wait for it.
         */
        steps.push(() => {
            const t = new TaskWork();

            t.Done  = () => fail("a forced stop must not reach Done");
            t.Error = (m) => {
                check("a worker that ignores Stopping is ended anyway",
                      String(m).includes("cancelled"), String(m));
                check("...and still reports Cancelled", t.Cancelled === true);
                next();
            };
            t.Start({ mode: "spin" });
            Timer.After(100, () => t.Stop({ KillAfter: 150 }));
        });

        next();
        until("the task chain finishes", () => done, () => finish(), 900);
    }

    /* --- Exec ----------------------------------------------------------- */
    testExec() {
        throws("Exec needs an array", () => Exec("ls"));
        throws("Exec rejects an empty argv", () => Exec([]));
        throws("Exec reports a missing binary", () => Exec(["/no/such/binary"]));

        const running = Exec(["/bin/sh", "-c", "sleep 30"]);
        check("a child starts out running", running.Running === true);
        check("with no exit code yet", running.ExitCode === null);
        check("and a process id", typeof running.ProcessId === "number" &&
                                  running.ProcessId > 0, String(running.ProcessId));
        check("stopping it reports that there was something to stop",
              running.Kill() === true);

        /*
         * **A child that was asked to stop still ends, so its exit callback
         * still runs.** That is the contract every window with a cancel button
         * is built on: `examples/usage` has exactly one place that clears up
         * after a `du`, and it is the exit callback — a program that expected
         * `Stop()` to be the end would leave its Stop button lit forever.
         *
         * And the status cannot tell being stopped from having failed: a signal
         * reports as `-1`, and a `du` that could not read one folder exits
         * non-zero having worked perfectly. So the application has to remember
         * that it was the one asking, which is what that example's `stopping`
         * flag is for, and this pins the half of it that is the runtime's.
         */
        const cancelled = Exec(["/bin/sh", "-c", "sleep 30"], null, (code) => {
            check("a stopped child still runs its exit callback", true);
            check("...and says it is no longer running", cancelled.Running === false);
            eq("a child ended by a signal reports -1", code, -1);
            check("which is not something the code tells from a failure",
                  code === -1 && cancelled.TimedOut === false);
        });
        check("there was something to stop", cancelled.Stop() === true);

        /*
         * A child that is gone before the handle is built.
         *
         * GSubprocess reaps on GLib's worker thread, so `/bin/true` can be
         * finished between the spawn and the next line -- the pid is then 0 and
         * there is nothing to signal. Reading it *later* was a NULL dereference:
         * a crash the sanitizer found here, one run in two hundred.
         */
        const quick = Exec(["/bin/true"], null, (code) => {
            eq("a child that ends at once still reports its status", code, 0);
            check("and its handle knows", quick.Running === false && quick.ExitCode === 0);
            check("with nothing left to stop", quick.Stop() === false);
        });
        check("even a finished child hands back a handle",
              typeof quick.ProcessId === "number" && quick.ProcessId >= 0,
              String(quick.ProcessId));

        const lines = [];
        const said  = [];
        const job = Exec(["/bin/sh", "-c", "echo uno; echo dos >&2; exit 3"],
             (line, from) => { lines.push(line); said.push(from); },
             (code) => {
                 eq("exit code is reported", code, 3);
                 check("stdout is captured", lines.includes("uno"), JSON.stringify(lines));
                 check("stderr is merged in", lines.includes("dos"), JSON.stringify(lines));
                 /* Merged is one stream, so there is no honest answer to which
                  * of the two a line came from -- and inventing one would make
                  * the argument a lie exactly where it is read. */
                 check("and merged lines say nothing about where they came from",
                       said.every((s) => s === undefined), JSON.stringify(said));

                 /* The handle knows what became of it, and goes on knowing
                  * after the job itself is gone. */
                 check("the handle stopped running", job.Running === false);
                 eq("and carries the exit code", job.ExitCode, 3);

                 /*
                  * The guard, on the spelling that keeps the window alive: two
                  * internal timers rather than a private main context, and the
                  * same `TimedOut` on the handle -- which is the half that lets
                  * a caller say "timed out" instead of keeping a flag of its
                  * own, as tests/runner had to before this existed.
                  */
                 const guarded = Exec(["sh", "-c", "echo vivo; sleep 30"],
                                      { Timeout: 200, KillAfter: 150 },
                                      (line) => said.push(line),
                                      (rc) => {
                     check("an asynchronous child is cut off too",
                           guarded.TimedOut === true, guarded.TimedOut);
                     eq("...with -1, as a signal leaves it", rc, -1);
                     check("...and its handle agrees",
                           guarded.Running === false && guarded.ExitCode === -1);

                     /* A child that ends on its own must not be reported as
                      * having been cut off. */
                     const inTime = Exec(["sh", "-c", "echo ya"], { Timeout: 4000 },
                                         null, (c) => {
                         check("one that ends in time is not flagged",
                               inTime.TimedOut === false && c === 0,
                               JSON.stringify([inTime.TimedOut, c]));
                     });
                     check("and a handle starts out not timed out",
                           inTime.TimedOut === false);
                 });
                 check("the handle starts with TimedOut false",
                       guarded.TimedOut === false);

                /*
                 * The terminal digests what it was fed on GTK's own time, so
                 * the last of the assertions **waits for that to have
                 * happened** -- a fixed 250 ms is the counting-time mistake the
                 * rest of this file retired: it was enough here and not on the
                 * sanitizer runner, where those three assertions were the only
                 * red ones in the suite and read as a pty that had printed
                 * nothing. The condition is the one they assert: no pty at all,
                 * or the last line of what it was fed.
                 */
                until("the terminal digested what it was fed",
                      () => !this.term || this.term.Text.includes("line 40"),
                      () => {
                    this.checkTerminal();
                    this.checkTimers();
                    /* Needs real allocations, so it runs out here with the
                     * rest of what only a running main loop can answer. */
                    this.testAnchors(() => this.testBoxAlign(
                        () => this.testSwitcherRoom(
                            () => this.testFlow(() => this.testFontSize(
                                () => this.testStyleSheet(
                                    () => this.testDirectories()))))));
                });
             });
    }

    /* --- what a switcher does with the room ----------------------------------
     *
     * Two questions that look like one, and only the second used to be answered:
     * how the switcher divides the room it *has* between its strip and its
     * pages, and whether it claims room from the container *around* it.
     *
     * With the first unanswered a page stayed at its natural size inside a
     * switcher that had been given the whole window -- 44 pixels of button in a
     * 560 pixel window, and a band of nothing under it.  Both are measured here,
     * because a page that fills by accident (its own content happens to be
     * exactly as tall as the room) proves nothing.
     */
    testSwitcherRoom(done) {
        /* Given a size, by a surface: the page has to be worth all of it. */
        const host = new Panel();
        host.Name = "SwHost";
        host.Arrangement = "Fixed";
        host.Resize(200, 120);
        this.Add(host);

        const sw = new Switcher();
        sw.Name   = "SwFill";
        sw.Strip  = "None";
        sw.HAlign = "Fill";
        sw.VAlign = "Fill";
        sw.Resize(200, 120);
        host.Add(sw);

        const page = new Panel();
        page.Name = "SwPage";
        sw.Append(page, "one");

        /* And in a box, beside something that does want the room: a switcher
         * whose pages ask for nothing must not take any. */
        const col = new Panel();
        col.Name = "SwCol";
        col.Arrangement = "Vertical";
        col.Resize(200, 160);
        this.Add(col);

        const modest = new Switcher();
        modest.Name  = "SwModest";
        modest.Strip = "None";
        col.Add(modest);
        modest.Append(new Panel(), "one");

        const greedy = new Panel();
        greedy.Name    = "SwGreedy";
        greedy.VExpand = true;
        col.Add(greedy);

        until("the switcher is laid out", () => sw.Bounds().Height > 0, () => {
            eq("a switcher fills the room it was given", sw.Bounds().Height, 120);
            eq("and hands all of it to the page on screen",
               page.Bounds().Height, sw.Bounds().Height);
            eq("across as well", page.Bounds().Width, sw.Bounds().Width);

            until("and the column with it", () => col.Bounds().Height > 0, () => {
                const room = col.Bounds().Height;

                check("a switcher takes no room it was not given",
                      modest.Bounds().Height < room / 2,
                      `${modest.Bounds().Height} of ${room}`);
                check("the one that asked for it gets the rest",
                      greedy.Bounds().Height > room / 2,
                      `${greedy.Bounds().Height} of ${room}`);

                /* Asking is what changes that, the same way it does anywhere. */
                modest.VExpand = true;
                until("with the switcher asking too",
                      () => modest.Bounds().Height > room / 4, () => {
                    check("saying so is what makes it share",
                          Math.abs(modest.Bounds().Height - greedy.Bounds().Height) <= 2,
                          `${modest.Bounds().Height} vs ${greedy.Bounds().Height}`);

                    host.Delete();
                    col.Delete();
                    done();
                });
            });
        });
    }

    /* --- alignment in a box --------------------------------------------------
     *
     * The same four words, carried out by GTK rather than by a surface: where
     * the child sits in the cell the box gave it, across the direction the box
     * runs in.  Until this worked, everything in a column was the full width of
     * the column and a centred button had to be a Fixed panel with coordinates
     * worked out by hand -- which is exactly what the anchor model exists to
     * avoid.
     *
     * Measured with Bounds(), never with Width: what is under test is what GTK
     * did with the request, and Width would only read the request back.  Panels
     * again, because a Panel's drawn box is its allocation exactly.
     */
    testBoxAlign(done) {
        const col = new Panel();
        col.Name = "BCol";
        col.Arrangement = "Vertical";
        col.Resize(200, 120);
        this.Add(col);

        const kid = (box, name, halign, valign) => {
            const p = new Panel();
            p.Name = name;
            p.Resize(60, 20);
            if (halign) p.HAlign = halign;
            if (valign) p.VAlign = valign;
            box.Add(p);
            return p;
        };

        const auto   = kid(col, "BAuto",   null,     null);
        const start  = kid(col, "BStart",  "Start",  null);
        const middle = kid(col, "BCenter", "Center", null);
        const end    = kid(col, "BEnd",    "End",    null);

        const row = new Panel();
        row.Name = "BRow";
        row.Arrangement = "Horizontal";
        row.Resize(200, 60);
        this.Add(row);

        const vauto = kid(row, "BVAuto",   null, null);
        const vmid  = kid(row, "BVCenter", null, "Center");
        const vend  = kid(row, "BVEnd",    null, "End");

        until("the column is laid out", () => col.Bounds().Width > 60, () => {
            const width = col.Bounds().Width;
            const at    = (p) => p.Bounds(col);

            /* Nothing asked for is the whole cell, which is what a box has
             * always done -- and why the default had to be a word of its own
             * rather than Start. */
            eq("Auto fills the cell across the box", at(auto).Width, width);
            eq("starting at its edge",               at(auto).X,     0);

            eq("Start is its own width",   at(start).Width, 60);
            eq("against the near edge",    at(start).X,     0);

            eq("End is its own width too", at(end).Width,   60);
            eq("against the far edge",     at(end).X,       width - 60);

            check("Center sits in the middle",
                  Math.abs(at(middle).X - Math.round((width - 60) / 2)) <= 1,
                  `${at(middle).X} of ${width}`);
            eq("its own width there as well", at(middle).Width, 60);

            until("and the row too", () => row.Bounds().Height > 20, () => {
                const height = row.Bounds().Height;
                const rat    = (p) => p.Bounds(row);

                eq("VAlign answers the other axis", rat(vauto).Height, height);
                eq("End goes to the bottom",        rat(vend).Y, height - rat(vend).Height);
                check("and Center to the middle",
                      Math.abs(rat(vmid).Y - Math.round((height - rat(vmid).Height) / 2)) <= 1,
                      `${rat(vmid).Y} of ${height}`);

                /* The other half of the rule: which container the control is in
                 * is what decides, and a control changes containers.  Turned
                 * into a surface, the same Center means the anchor again -- so
                 * the control goes back to the coordinates it was given, not to
                 * the middle of anything. */
                col.Arrangement = "Fixed";
                middle.Move(4, 4);

                until("the column becomes a surface", () => at(middle).X === 4, () => {
                    eq("a drawn control is where it was drawn", at(middle).X, 4);
                    eq("at the size it asked for",              at(middle).Width, 60);

                    col.Delete();
                    row.Delete();
                    done();
                });
            });
        });
    }

    /* --- anchoring -----------------------------------------------------------
     *
     * A fixed surface used to place its children once and stop there, so a form
     * drawn at one size kept every control exactly where it was put when the
     * window grew.  HAlign/VAlign say what to do with the slack instead.
     *
     * Everything here is measured with Bounds(), never with X/Y: what is under
     * test is where GTK really put the control, and X/Y would only read back
     * the number that was assigned.  Panels are used as the children because a
     * Panel's drawn box matches its allocation exactly -- a Button's does not,
     * since the theme draws its face inset.
     */
    testAnchors(done) {
        /* Auto and not Start: the two kinds of container disagree about what
         * nothing-was-asked-for means -- a drawn control stays where it was
         * drawn, a child of a box fills its cell -- and naming the disagreement
         * is what lets the other four mean the same thing in both. */
        eq("HAlign defaults to Auto", new Panel().HAlign, "Auto");
        eq("VAlign defaults to Auto", new Panel().VAlign, "Auto");

        const opts = new Panel().PropertyOptions("HAlign");
        check("HAlign offers its values",
              sameJson(opts, ["Auto", "Start", "End", "Center", "Fill"]),
              JSON.stringify(opts));

        throws("HAlign refuses what it cannot mean", () => { new Panel().HAlign = "Sideways"; });

        /* The default is what every form did before there was a choice, so it
         * has to stay out of the .form. */
        const plain = new Panel();
        plain.Name = "Plain";
        check("Auto does not serialise", !("HAlign" in plain.Serialize().properties),
              JSON.stringify(plain.Serialize().properties));
        plain.HAlign = "Fill";
        eq("anything else does", plain.Serialize().properties.HAlign, "Fill");

        eq("MinWidth starts unset", new Panel().MinWidth, 0);
        check("and stays out of the .form until it is given one",
              !("MinWidth" in plain.Serialize().properties),
              JSON.stringify(plain.Serialize().properties));
        plain.MinWidth = 40;
        eq("then it is saved like any other", plain.Serialize().properties.MinWidth, 40);

        /* --- the real thing: a surface that changes size --------------------- */
        const win  = new AnchorForm();
        const host = new Panel();
        host.Name = "Host";
        host.Move(0, 0);
        host.Resize(200, 100);
        win.Add(host);

        const kid = (name, x, y, halign, valign) => {
            const p = new Panel();
            p.Name = name;
            p.Move(x, y);
            p.Resize(40, 20);
            p.HAlign = halign;
            p.VAlign = valign;
            host.Add(p);
            return p;
        };

        const stay    = kid("AStay",     10, 10, "Start",  "Start");
        const slide   = kid("ASlide",    60, 10, "End",    "End");
        const middle  = kid("AMiddle",  110, 40, "Center", "Center");
        const stretch = kid("AStretch",  10, 70, "Fill",   "Fill");

        /* The same, with a floor of its own declared. */
        const guarded = kid("AGuarded", 110, 70, "Fill", "Start");
        guarded.MinWidth = 30;

        win.Show();

        /* The size the coordinates were written against is the first real one
         * the surface is given, so nothing may change until it has one. */
        until("the surface gets its design size", () => host.Bounds().Width === 200, () => {
            const before = {
                stay:    stay.Bounds(host),    slide:   slide.Bounds(host),
                middle:  middle.Bounds(host),  stretch: stretch.Bounds(host),
            };
            eq("a control starts where it was put",  before.stay.X, 10);
            eq("at the size it asked for",           before.stay.Width, 40);
            eq("and nothing has moved yet",          before.slide.X, 60);

            host.Resize(300, 200);   /* 100 wider, 100 taller */

            until("the surface grows", () => host.Bounds().Width === 300, () => {
                const after = {
                    stay:    stay.Bounds(host),    slide:   slide.Bounds(host),
                    middle:  middle.Bounds(host),  stretch: stretch.Bounds(host),
                };

                eq("Start stays put",            after.stay.X,      before.stay.X);
                eq("on both axes",               after.stay.Y,      before.stay.Y);
                eq("without changing size",      after.stay.Width,  before.stay.Width);

                eq("End follows the right edge", after.slide.X,     before.slide.X + 100);
                eq("and the bottom one",         after.slide.Y,     before.slide.Y + 100);
                eq("still its own size",         after.slide.Width, before.slide.Width);

                eq("Center moves half of it",    after.middle.X,    before.middle.X + 50);
                eq("on both axes too",           after.middle.Y,    before.middle.Y + 50);

                eq("Fill stretches instead",     after.stretch.Width,  before.stretch.Width + 100);
                eq("in both directions",         after.stretch.Height, before.stretch.Height + 100);
                eq("without moving its origin",  after.stretch.X,      before.stretch.X);

                /* Shrinking back is the same rule with the slack negative. */
                host.Resize(200, 100);
                until("and shrinks back", () => host.Bounds().Width === 200, () => {
                    eq("End comes back",  slide.Bounds(host).X,       before.slide.X);
                    eq("Fill comes back", stretch.Bounds(host).Width, before.stretch.Width);

                    /* Past the design size now, which is the part a stretched
                     * control's drawn width is deliberately not a floor for:
                     * its size is derived, so the surface may be smaller than
                     * the form was drawn and it simply gets less.  What it may
                     * not pass is a floor of its own. */
                    host.Resize(180, 100);
                    until("and past the design size", () => host.Bounds().Width === 180, () => {
                        check("Fill gives back the room it borrowed",
                              stretch.Bounds(host).Width < before.stretch.Width,
                              `${stretch.Bounds(host).Width}`);
                        eq("but not past a declared MinWidth",
                           guarded.Bounds(host).Width, 30);
                        eq("which the one without keeps out of its way",
                           stretch.MinWidth, 0);

                        /* A drawing board rather than a window: the same
                         * surface, told not to anchor, puts everything exactly
                         * where it was drawn however big it grows.  It is what
                         * a designer's canvas needs -- it is stretched to the
                         * room the editor has, which is nobody's design size. */
                        eq("a surface anchors by default", host.Anchored, true);
                        host.Anchored = false;
                        host.Resize(300, 200);
                        until("with anchoring off", () => host.Bounds().Width === 300, () => {
                            eq("Anchored reads back",   host.Anchored, false);
                            eq("End stops following",   slide.Bounds(host).X,       before.slide.X);
                            eq("Center stops moving",   middle.Bounds(host).X,      before.middle.X);
                            eq("Fill stops stretching", stretch.Bounds(host).Width, before.stretch.Width);

                            /* A Scroller is the other answer to "there is not
                             * enough room": every other container makes its
                             * parent bigger, which is right for a window and
                             * wrong for a view onto something whose size is not
                             * the window's business. */
                            const view = new Scroller();
                            view.Name = "AView";
                            view.Move(10, 10);
                            view.Resize(80, 60);
                            win.Add(view);

                            const big = new Panel();
                            big.Name = "ABig";
                            big.Move(0, 0);
                            big.Resize(400, 300);
                            view.Add(big);

                            until("the scroller lays out", () => view.Bounds().Width > 0, () => {
                                const vb = view.Bounds(), bb = big.Bounds();
                                eq("a Scroller is a container", view.Children.length, 1);
                                check("that stays the size it was given",
                                      vb.Width <= 80 && vb.Height <= 60, JSON.stringify(vb));
                                check("however big what is inside it is",
                                      bb.Width >= 400 && bb.Height >= 300, JSON.stringify(bb));

                                win.Close();
                                this.testAnchorsNarrow(() =>
                                    this.testAnchorsPushed(done));
                            });
                        });
                    });
                });
            });
        });
    }

    /*
     * A form whose *contents* outgrew the size it was drawn at.
     *
     * This is the case translation makes, and it is the one the anchor model got
     * wrong: a control whose text needs more than its declared width pushes the
     * surface's minimum out -- rightly, or it would clip -- so the window opens
     * wider than the `.form` says. Latching *that* as the design size made every
     * anchor inert: the extra room sat dead against the far edge, an input
     * declared to stretch never stretched, and the buttons never reached the
     * corner. The IDE's own "New translation" dialog is where it was seen.
     *
     * What is asserted is the only thing that means anything here: **the gaps a
     * pushed form ends up with are the gaps it was drawn with.** Bigger window,
     * same layout.
     */
    /*
     * **A form shown narrower than it was drawn.**
     *
     * Every coordinate in a `.form` was measured against the `Width` that file
     * declares, and that stays true whatever size the window is later shown at.
     * Restoring a remembered window size is the ordinary way to arrive at one
     * that is smaller -- `examples/notes` does it in `Form_Open`, which is where
     * this was found.
     *
     * It used to latch the *allocation* as the design size, so a strip drawn at
     * `12..388` of a 400-wide form, shown at 340, had a trailing gap of **minus
     * 48** -- and `Fill` kept that faithfully at every size afterwards, so the
     * strip was 48 pixels wider than its own window whether that window was 340
     * or maximised. The cause was reading the form's *current* size, which
     * `Resize` writes, in place of the size its file drew.
     *
     * What is asserted is the thing that was wrong and not the arithmetic: a
     * control anchored inside a surface is inside it, at any size.
     */
    testAnchorsNarrow(done) {
        const win = new NarrowForm();

        /* Before `Show`, which is what an application restoring a size does --
         * and the window is 60 narrower than the file drew. */
        win.Resize(340, 120);
        win.Show();

        let seen = -1;
        const still = () => {
            const now = win.Bounds().Width;
            const same = now > 1 && now === seen;
            seen = now;
            return same;
        };

        until("the narrow form settles", still, () => {
            const inside = (c) => {
                const b = c.Bounds();
                return b.X >= 0 && b.X + b.Width <= win.Bounds().Width;
            };

            /* A `Label`, because `Bounds()` is what a control is *drawn* as and
             * a Button is inset by the theme's own margin -- the same reason the
             * test below compares against a number rather than another control. */
            check("a Fill control drawn to the margins stays inside a narrower window",
                  inside(win.NStrip),
                  `${win.NStrip.Bounds().X}..${win.NStrip.Bounds().X + win.NStrip.Bounds().Width}` +
                  ` of ${win.Bounds().Width}`);
            check("and so does one anchored to the far edge", inside(win.NEnd),
                  `${win.NEnd.Bounds().X}..${win.NEnd.Bounds().X + win.NEnd.Bounds().Width}`);

            /* And wider again: the design size is the file's, so the gaps are
             * the ones it drew rather than whatever the first allocation was. */
            win.Resize(700, 120);
            until("and settles again", still, () => {
                eq("at any size the far margin is the one the file drew",
                   win.Bounds().Width - (win.NStrip.Bounds().X + win.NStrip.Bounds().Width),
                   12);
                check("with the strip still inside", inside(win.NStrip));

                win.Close();
                done();
            });
        });
    }

    testAnchorsPushed(done) {
        const win = new PushedForm();
        win.Arrangement = "Fixed";
        win.Resize(300, 160);

        const put = (kind, name, x, y, w, halign) => {
            const c = Widget.New(kind);
            win.Add(c);
            c.Name = name;
            c.Move(x, y);
            c.Resize(w, 28);
            c.HAlign = halign;
            return c;
        };

        /*
         * Drawn 16 in from either edge -- 16 + 268 = 284 of a 300 design -- and
         * carrying a caption far wider than the 268 it declared. So it is both
         * what pushes the surface and what has to keep its margin afterwards.
         */
        const pusher = put("Label", "PPush", 16, 12, 268, "Fill");
        pusher.Wrap = false;
        pusher.Text = "A caption a great deal wider than the two hundred and sixty eight pixels it declared";

        const filler  = put("TextBox", "PFill", 16, 52, 268, "Fill");  /* also to 284 */
        const trailer = put("Button",  "PEnd", 194, 92,  90, "End");   /* also to 284 */
        const stayer  = put("Button",  "PStart", 16, 122, 60, "Start");

        win.Show();

        /*
         * Settled, not merely allocated. A form whose contents pushed it is
         * measured twice -- the first pass has no design size to know what gap a
         * stretched control was drawn with, and latching one asks for another --
         * so `Width > 1` is true a frame before the answer is. Waiting for two
         * readings that agree is the only general signal there is.
         */
        let seen = -1;
        const still = () => {
            const now = win.Bounds().Width;
            const same = now > 1 && now === seen;
            seen = now;
            return same;
        };

        until("the pushed form settles", still, () => {
            /* Read fresh every time: the surface is about to grow, and a gap
             * measured against the width it used to have is not a gap. */
            const gapOf = (c) =>
                win.Bounds().Width - (c.Bounds().X + c.Bounds().Width);

            const surface = win.Bounds().Width;

            check("a control wider than it declared pushes the surface out",
                  surface > 300, `${surface} against a declared 300`);
            check("and it is the text that did it, so nothing is clipped",
                  pusher.Bounds().Width > 268, `${pusher.Bounds().Width}`);

            /*
             * The one that pushed keeps the gap it was drawn with on the *far*
             * side too. It used to push by exactly its own growth and end up
             * flush against the edge while everything beside it kept the margin,
             * which is what the IDE's "New translation" dialog looked like: a
             * prompt touching the frame over an input that stopped short.
             */
            /* 300 - (16 + 268): the margin it was drawn inside. Compared
             * against that number and not against another control's, because
             * `Bounds()` is what a control is *drawn* as -- a Label matches its
             * allocation and a TextBox is inset by the theme, so the two are not
             * the same measurement. */
            eq("what pushed the surface keeps its own far margin",
               gapOf(pusher), 300 - (16 + 268));

            const fillGap  = gapOf(filler);
            const endGap   = gapOf(trailer);
            const stayLeft = stayer.Bounds().X;

            win.Resize(surface + 90, 160);
            until("and it survives a resize on top of that",
                  () => win.Bounds().Width >= surface + 80, () => {
                eq("Fill keeps its distance to the far edge", gapOf(filler), fillGap);
                eq("and so does End",                         gapOf(trailer), endGap);
                eq("while Start stays where it was drawn",    stayer.Bounds().X, stayLeft);

                check("Fill really did stretch, rather than staying put",
                      filler.Bounds().Width > 268, `${filler.Bounds().Width}`);

                win.Close();
                this.testSplitFloor(done);
            });
        });
    }

    /*
     * A Grid: rows and columns whose sizes come from what is in them.
     *
     * The thing a form drawn in coordinates cannot do, and the reason a caption
     * that grew in translation pushes a dialog out of shape instead of widening
     * a column. What is asserted is that the three promises hold -- a column is
     * as wide as its widest child, a child that expands takes the slack, and a
     * span really spans -- and that they hold **without any new vocabulary**:
     * HAlign and HExpand mean here exactly what they mean in a box.
     */
    testGrid() {
        const g = new Grid();
        this.Add(g);
        g.Columns = 2;
        g.Spacing = 8;

        eq("a grid starts at two columns", new Grid().Columns, 2);
        throws("and refuses a number of columns that is not one", () => { g.Columns = 0; });

        const put = (kind, text, props) => {
            const c = Widget.New(kind);
            g.Add(c);
            if (text !== null) c.Text = text;
            for (const k in props || {}) c[k] = props[k];
            return c;
        };

        const short  = put("Label", "Ab", { HAlign: "End" });
        const field1 = put("TextBox", "", { HExpand: true, HAlign: "Fill" });
        const long   = put("Label", "A considerably longer caption", { HAlign: "End" });
        const field2 = put("TextBox", "", { HExpand: true, HAlign: "Fill" });
        const note   = put("Label", "One that runs the whole width", { ColumnSpan: 2 });

        eq("a control takes one column unless it says otherwise", field1.ColumnSpan, 1);
        eq("and says so when it does", note.ColumnSpan, 2);
        throws("a span of nothing is refused", () => { note.ColumnSpan = 0; });

        until("the grid lays out", () => g.Bounds().Width > 1, () => {
            const at = (c) => c.Bounds(g);

            /*
             * The column is as wide as its widest child, so the two labels --
             * anchored End -- have their right edges in the same place. That is
             * the whole of what a grid buys over a row of coordinates, and it is
             * what no amount of translation can put out of line.
             */
            eq("a column is as wide as its widest child, so the labels align",
               at(short).X + at(short).Width, at(long).X + at(long).Width);
            check("with the wider one setting the width",
                  at(long).Width > at(short).Width,
                  `${at(long).Width} against ${at(short).Width}`);

            eq("the fields line up on the other side", at(field1).X, at(field2).X);
            check("and take the slack, because they said HExpand",
                  at(field1).Width > at(long).Width,
                  `${at(field1).Width}`);

            /* Two per row, so the second pair is below the first. */
            check("children flow in order, wrapping at Columns",
                  at(long).Y > at(short).Y, `${at(long).Y} after ${at(short).Y}`);
            /* Sharing a row is overlapping, not matching: `Bounds()` is the
             * drawn box, and a Label and a TextBox of the same row are centred
             * in it differently by a pixel or two. */
            const overlaps = (a, b) =>
                at(a).Y < at(b).Y + at(b).Height && at(b).Y < at(a).Y + at(a).Height;
            check("a pair shares its row", overlaps(short, field1),
                  `${at(short).Y} and ${at(field1).Y}`);

            check("a span really spans, to the width of the grid",
                  at(note).Width >= at(field1).X + at(field1).Width - at(short).X,
                  `${at(note).Width} of ${g.Bounds().Width}`);
            check("on a row of its own, under both", at(note).Y > at(field2).Y);

            /* Reordering is what it is in a box, and the layout follows. */
            g.Reorder(note, 0);
            until("the grid re-flows", () => at(note).Y < at(short).Y, () => {
                check("reordering moves it to the front", at(note).Y < at(short).Y,
                      `${at(note).Y} against ${at(short).Y}`);
                check("and pushes everything after it down",
                      at(short).Y > 0, `${at(short).Y}`);

                g.Delete();
                this.testGridDone = true;
            });
        });
    }

    /*
     * **Neither half of a split may be squeezed below what it needs.**
     *
     * GTK lets a paned do exactly that by default, and the result is not
     * clipping but *overlap*: the halves keep the size they need and are drawn
     * over each other and over whatever is beside them, because the split told
     * its parent it needed nothing. A window over one could then be dragged
     * smaller than its own contents -- the catalogue editor asked for 760x200
     * and came out with its buttons across its own list.
     *
     * Driven the way it shows: a window that is asked to be smaller than the two
     * halves together, and is not.
     */
    testSplitFloor(done) {
        const win = new ShrinkForm();
        win.Arrangement = "Vertical";
        win.Resize(400, 200);

        const split = new Split();
        win.Add(split);
        split.Expand = true;

        for (const w of [140, 110]) {
            const p = new Panel();
            split.Add(p);
            p.Resize(w, 40);
        }
        win.Show();

        until("the split lays out", () => win.Bounds().Width > 1, () => {
            win.Resize(80, 200);

            /* Two frames, because refusing a size is a negotiation and not an
             * assignment: the window asks, GTK answers with the minimum. */
            let seen = -1;
            const still = () => {
                const now = win.Bounds().Width;
                const same = now > 1 && now === seen;
                seen = now;
                return same;
            };
            until("and settles at what it will allow", still, () => {
                check("a window is not made smaller than both halves together",
                      win.Bounds().Width >= 250,
                      `${win.Bounds().Width} against 140+110`);
                check("and neither half is squashed below its own size",
                      split.Children.every((c) => c.Bounds().Width >= 100),
                      JSON.stringify(split.Children.map((c) => c.Bounds().Width)));

                win.Close();
                done();
            });
        });
    }

    /* --- a project laid out in directories -----------------------------------
     *
     * Run for real, in another process, because that is the only way to prove
     * what the loader does: a project with no "sources" list at all, its classes
     * in folders, and a component in a folder of its own being used by a form in
     * another.  Nothing in the files says where anything is -- a .form node
     * names a type and a class declaration names a class -- so the runtime has
     * to find <Class>.form by name, wherever it is.
     */
    testDirectories() {
        const dir = File.Join(SCRATCH, "nested");
        Directory.Make(File.Join(dir, "forms"));
        Directory.Make(File.Join(dir, "parts"));

        /* No "sources": the whole tree is the source. */
        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "nested", startup: "Main" }));

        File.Save(File.Join(dir, "forms", "Main.form"), JSON.stringify({
            format: "bintana-form/1",
            class: "Main",
            properties: { Text: "nested", Width: 300, Height: 200 },
            children: [
                { type: "Gauge", name: "G1",
                  properties: { X: 10, Y: 10, Width: 200, Height: 40, Level: 7 } },
            ],
        }));
        File.Save(File.Join(dir, "forms", "Main.js"),
                  'class Main extends Form {\n' +
                  '    Form_Open() {\n' +
                  '        print("level " + this.G1.Level);\n' +
                  '        print("shown " + this.G1.Shown.Text);\n' +
                  '        Application.Quit(0);\n' +
                  '    }\n' +
                  '}\n');

        File.Save(File.Join(dir, "parts", "Gauge.form"), JSON.stringify({
            format: "bintana-form/1",
            class: "Gauge",
            properties: { Width: 200, Height: 40 },
            children: [
                { type: "Label", name: "Shown",
                  properties: { X: 0, Y: 0, Width: 100, Height: 24, Text: "-" } },
            ],
        }));
        File.Save(File.Join(dir, "parts", "Gauge.js"),
                  'class Gauge extends Component {\n' +
                  '    get Level()  { return this._level || 0; }\n' +
                  '    set Level(v) { this._level = Number(v) || 0;\n' +
                  '                    this.Shown.Text = "L" + this._level; }\n' +
                  '}\n');

        const lines = [];
        Exec([Application.Executable, dir], (line) => lines.push(line), (code) => {
            eq("a project in directories starts", code, 0);
            check("a class in a folder found its own .form",
                  lines.includes("shown L7"), JSON.stringify(lines));
            check("and the form in another folder used it",
                  lines.includes("level 7"), JSON.stringify(lines));

            this.testAmbiguous();
        });
    }

    /*
     * The price of finding a .form by name: two of them with the same name are
     * not a choice to make quietly.  The classes would collide as well, so this
     * is a mistake worth a message and not a coin flip.
     */
    testAmbiguous() {
        const dir = File.Join(SCRATCH, "ambiguous");
        Directory.Make(File.Join(dir, "a"));
        Directory.Make(File.Join(dir, "b"));

        const twin = JSON.stringify({
            format: "bintana-form/1", class: "Twin",
            properties: { Text: "twin", Width: 100, Height: 100 }, children: [],
        });
        File.Save(File.Join(dir, "a", "Twin.form"), twin);
        File.Save(File.Join(dir, "b", "Twin.form"), twin);

        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "ambiguous", startup: "Twin",
                                   sources: ["a/Twin.js"] }));
        File.Save(File.Join(dir, "a", "Twin.js"), "class Twin extends Form {}\n");

        const lines = [];
        Exec([Application.Executable, dir], (line) => lines.push(line), (code) => {
            check("two forms with one name is an error", code !== 0, `exit ${code}`);
            check("and it says which name",
                  lines.some((l) => l.includes("Twin.form")), JSON.stringify(lines));
            this.testNamespaceProject();
        });
    }

    /*
     * The rest of the namespace machinery, which only shows up in a real run:
     * a qualified `startup`, a namespace two levels deep, and a class whose file
     * is not where its namespace would suggest.  No "sources" either, so the
     * whole tree is walked for both the code and the .form files.
     */
    testNamespaceProject() {
        const dir = File.Join(SCRATCH, "spaces");
        Directory.Make(File.Join(dir, "App"));
        Directory.Make(File.Join(dir, "Deep", "Parts"));

        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "spaces", startup: "App.Main" }));

        File.Save(File.Join(dir, "App", "Main.form"), JSON.stringify({
            format: "bintana-form/1",
            class: "App.Main",
            properties: { Text: "spaces", Width: 320, Height: 200 },
            children: [
                { type: "Deep.Parts.Chip", name: "C1",
                  properties: { X: 10, Y: 10, Width: 120, Height: 30, Level: 4 } },
                { type: "Away.Loose", name: "L1",
                  properties: { X: 10, Y: 60, Width: 120, Height: 30 } },
            ],
        }));
        File.Save(File.Join(dir, "App", "Main.js"),
                  'Namespace("App");\n' +
                  'App.Main = class Main extends Form {\n' +
                  '    Form_Open() {\n' +
                  '        print("chip " + this.C1.Shown.Text);\n' +
                  '        print("loose " + this.L1.Children.length);\n' +
                  '        print("type " + Widget.TypeName(this.C1.constructor));\n' +
                  '        Application.Quit(0);\n' +
                  '    }\n' +
                  '};\n');

        /* Two levels down, and the folders spell out the namespace. */
        File.Save(File.Join(dir, "Deep", "Parts", "Chip.form"), JSON.stringify({
            format: "bintana-form/1", class: "Deep.Parts.Chip",
            properties: { Width: 120, Height: 30 },
            children: [{ type: "Label", name: "Shown",
                         properties: { X: 0, Y: 0, Width: 80, Height: 24, Text: "-" } }],
        }));
        File.Save(File.Join(dir, "Deep", "Parts", "Chip.js"),
                  'Namespace("Deep.Parts");\n' +
                  'Deep.Parts.Chip = class Chip extends Component {\n' +
                  '    set Level(v) { this._l = v; this.Shown.Text = "n" + v; }\n' +
                  '    get Level()  { return this._l || 0; }\n' +
                  '};\n');

        /* Declares itself Away.Loose, but its file sits at the root: the class
         * name is what locates the file, and there is only one Loose. */
        File.Save(File.Join(dir, "Loose.form"), JSON.stringify({
            format: "bintana-form/1", class: "Away.Loose",
            properties: { Width: 120, Height: 30 },
            children: [{ type: "Label", name: "Tag",
                         properties: { X: 0, Y: 0, Width: 60, Height: 20, Text: "l" } }],
        }));
        File.Save(File.Join(dir, "Loose.js"),
                  'Namespace("Away");\n' +
                  'Away.Loose = class Loose extends Component {};\n');

        const lines = [];
        Exec([Application.Executable, dir], (line) => lines.push(line), (code) => {
            eq("a project of namespaces starts", code, 0);
            check("a qualified startup class was found",
                  lines.length > 0, JSON.stringify(lines));
            check("a namespace two folders deep resolved",
                  lines.includes("chip n4"), JSON.stringify(lines));
            check("and reports itself by its qualified name",
                  lines.includes("type Deep.Parts.Chip"), JSON.stringify(lines));
            check("a class found its .form outside its namespace's folder",
                  lines.includes("loose 1"), JSON.stringify(lines));

            this.testConsoleProject();
        });
    }

    /*
     * A project that declares `main` instead of `startup`: no window, and -- the
     * part worth a test -- **no display**.
     *
     * Run with DISPLAY and WAYLAND_DISPLAY taken out of its environment, which
     * is what `Environment: { NAME: null }` is for. The control below is the same
     * project as a form, which must fail there: without it this passes on a
     * runtime that quietly opened the display it was given anyway, and proves
     * nothing about console mode at all.
     */
    testConsoleProject() {
        const dir = File.Join(SCRATCH, "console");
        Directory.Make(dir);

        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "console", main: "Main" }));
        File.Save(File.Join(dir, "Main.js"),
                  'function Main() {\n' +
                  '    print("args " + Application.Arguments.join(","));\n' +
                  '    print("path set " + (Environment.Get("PATH") !== null));\n' +
                  '    print("absent " + Environment.Get("BTA_NOT_A_VARIABLE"));\n' +
                  /* No display, and it says so: the runner's own question,
                    * asked from the one program that must answer it right. */
                  '    print("display " + Environment.HasDisplay);\n' +
                  /* A timer, so the loop has to keep running for it: a console
                    * project that ended at the last line of main would not. */
                  '    Timer.After(20, () => { print("timer ran"); Application.Quit(7); });\n' +
                  '}\n');

        const blind = { Environment: { DISPLAY: null, WAYLAND_DISPLAY: null } };
        const lines = [];
        Exec([Application.Executable, dir, "uno", "dos"], blind,
             (line) => lines.push(line),
             (code) => {
                 eq("a console project quits with the status main asked for", code, 7);
                 check("it runs with no display at all",
                       lines.includes("args uno,dos"), JSON.stringify(lines));
                 check("Environment.Get reads the environment",
                       lines.includes("path set true"), JSON.stringify(lines));
                 check("and answers null for a name that is not there",
                       lines.includes("absent null"), JSON.stringify(lines));
                 check("a child with no DISPLAY says it has none",
                       lines.includes("display false"), JSON.stringify(lines));
                 check("the loop stays up while a timer is armed",
                       lines.includes("timer ran"), JSON.stringify(lines));

                 this.testConsoleControl();
             });
    }

    /* The control: the same directory as an ordinary project, which needs the
     * display the one above did without. */
    testConsoleControl() {
        const dir = File.Join(SCRATCH, "console-form");
        Directory.Make(dir);

        File.Save(File.Join(dir, "project.json"),
                  JSON.stringify({ name: "console-form", startup: "Blank" }));
        File.Save(File.Join(dir, "Blank.form"), JSON.stringify({
            format: "bintana-form/1", class: "Blank",
            properties: { Text: "blank", Width: 100, Height: 100 }, children: [],
        }));
        File.Save(File.Join(dir, "Blank.js"),
                  'class Blank extends Form { Form_Open() { Application.Quit(0); } }\n');

        const blind = { Environment: { DISPLAY: null, WAYLAND_DISPLAY: null } };
        Exec([Application.Executable, dir], blind, () => {}, (code) => {
            check("a project with a form still needs a display", code !== 0, `exit ${code}`);

            /* And a `main` that is not there is an error, not a silent exit 0:
             * a runner whose entry point was renamed must not look like a
             * runner with nothing to do. */
            const bad = File.Join(SCRATCH, "console-lost");
            Directory.Make(bad);
            File.Save(File.Join(bad, "project.json"),
                      JSON.stringify({ name: "console-lost", main: "Absent" }));
            File.Save(File.Join(bad, "Main.js"), "function Main() { print('no'); }\n");

            const lines = [];
            Exec([Application.Executable, bad], blind, (line) => lines.push(line), (rc) => {
                check("a missing main is a failure", rc !== 0, `exit ${rc}`);
                check("and it says which name it looked for",
                      lines.some((l) => l.includes("Absent")), JSON.stringify(lines));

                this.testExecOptions();
            });
        });
    }

    /* --- what a child is given, and how it is stopped -------------------- */
    testExecOptions() {
        const dir = File.Join(SCRATCH, "cwd");
        Directory.Make(dir);

        /* What `export` does in a shell: set here, inherited there. */
        Environment.Set("BTA_EXPORTED", "desde el padre");

        const lines = [];
        Exec(["/bin/sh", "-c",
              "pwd; echo mark=$BTA_MARK; echo path=${PATH:+set}; echo up=$BTA_EXPORTED"],
             { Directory: dir, Environment: { BTA_MARK: "here" } },
             (line) => lines.push(line),
             (code) => {
                 eq("a child with options runs", code, 0);
                 check("a child inherits what Environment.Set put there",
                       lines.includes("up=desde el padre"), JSON.stringify(lines));
                 Environment.Set("BTA_EXPORTED", null);
                 check("Dir is where it starts",
                       lines.some((l) => l.endsWith("/cwd")), JSON.stringify(lines));
                 check("Env adds a name", lines.includes("mark=here"), JSON.stringify(lines));
                 check("and the rest of the environment comes through",
                       lines.includes("path=set"), JSON.stringify(lines));

                 /* Removing one, which is the other half of Env and the half a
                  * replacement environment would make expensive. */
                 const gone = [];
                 Exec(["/bin/sh", "-c", "echo home=[$HOME]"],
                      { Environment: { HOME: null } },
                      (line) => gone.push(line),
                      () => {
                          check("a null value takes a name away",
                                gone.includes("home=[]"), JSON.stringify(gone));
                          this.testExecStreams();
                      });
             });
    }

    /*
     * The two streams, kept apart.
     *
     * Merged is the default and stays it, because merging is what keeps the
     * order: one pipe, one sequence, exactly what the child wrote. Two pipes
     * tell you which stream a line came from and stop promising anything about
     * how the two interleave -- so this asserts what each stream said and never
     * the order between them.
     */
    testExecStreams() {
        const out = [];
        const err = [];
        const odd = [];

        Exec(["/bin/sh", "-c", "echo salida; echo error >&2; echo mas; exit 4"],
             { Stderr: "separate" },
             (line, from) => {
                 if (from === "out") out.push(line);
                 else if (from === "err") err.push(line);
                 else odd.push(`${from}: ${line}`);
             },
             (code) => {
                 eq("a child with its streams apart still reports its status", code, 4);
                 eq("stdout arrives as stdout", JSON.stringify(out),
                    JSON.stringify(["salida", "mas"]));
                 eq("stderr arrives as stderr", JSON.stringify(err),
                    JSON.stringify(["error"]));
                 check("and nothing arrives as anything else", odd.length === 0,
                       JSON.stringify(odd));

                 this.testDebugger();
             });
    }

    /*
     * The debugger, end to end, and the assertion that guards the third patch
     * in `vendor/`.
     *
     * `bintana --debug` stops the program and speaks a line of JSON at a time:
     * out on descriptor 3, which is `Exec`'s `Control`, and in on stdin, which
     * is the handle's `Write`. So one test covers four things that arrived
     * together -- the patch, the two new pieces of `Exec`, and the flag.
     *
     * **It is here and not only in `tests/ide` because of what dropping the
     * patch looks like**: the build succeeds, `--debug` waits for a debugger
     * that can never stop anything, and every other test passes. The two
     * patches beside it in `AGENTS.md` are asserted here for the same reason.
     */
    testDebugger() {
        const proj = File.Join(SCRATCH, "dbg");

        Directory.Make(proj);
        File.Save(File.Join(proj, "project.json"),
                  JSON.stringify({ name: "dbg", main: "Main", sources: ["Main.js"] }));
        /* Three lines that each have an opcode of their own, so the breakpoint
         * needs no moving and the assertion below is about stopping and not
         * about pc2line. */
        File.Save(File.Join(proj, "Main.js"),
                  '"use strict";\n' +
                  'function twice(n) {\n' +
                  '    const doubled = n * 2;\n' +
                  '    return doubled;\n' +
                  '}\n' +
                  'function Main() {\n' +
                  '    print(`answer ${twice(21)}`);\n' +
                  '    Application.Quit(0);\n' +
                  '}\n');

        const stops = [];
        const out   = [];
        let   locals = null;
        let   armed  = null;

        const job = Exec([Application.Executable, "--debug", proj],
            {
                Timeout: 20000,
                Control: (line) => {
                    const msg  = JSON.parse(line);
                    const kind = msg.event || msg.reply;

                    if (kind === "ready") {
                        job.Write(JSON.stringify(
                            { do: "break", file: "Main.js", line: 3, id: 1 }));
                        job.Write(JSON.stringify({ do: "continue" }));
                    } else if (kind === "armed") {
                        armed = msg;
                    } else if (kind === "stopped") {
                        stops.push(msg);
                        job.Write(JSON.stringify({ do: "locals", frame: 0 }));
                    } else if (kind === "locals") {
                        locals = msg.items;
                        job.Write(JSON.stringify({ do: "continue" }));
                    }
                },
            },
            (line) => out.push(line),
            (code) => {
                eq("a program run under the debugger finishes", code, 0);
                check("and printed what it was going to print",
                      out.join("").includes("answer 42"), JSON.stringify(out));

                /* The patch, said as plainly as it can be: without the hook in
                 * the interpreter nothing ever stops, and this is zero. */
                eq("the debugger stopped it once", stops.length, 1);

                const at = stops[0];
                eq("on a breakpoint", at.reason, "breakpoint");
                eq("in the function the line is in", at.frames[0].Name, "twice");
                eq("on the line it was armed on", at.frames[0].Line, 3);
                eq("with the caller under it", at.frames[1].Name, "Main");

                check("the breakpoint reported where it landed", armed !== null);
                eq("...which is where it was asked for", armed && armed.line, 3);

                /* The frame's own arguments, by name, read out of `vardefs` --
                 * and `this`, which is a parameter of the call and has a slot on
                 * the frame only because the patch put one there. */
                const by = {};
                for (const item of locals || []) by[item.Name] = item.Value;

                eq("an argument is read by name", by.n, "21");
                check("and is marked as an argument",
                      (locals || []).some((i) => i.Name === "n" && i.Argument === true));
                check("`this` is among them", "this" in by, JSON.stringify(by));
                /* `doubled` is declared on the line it stopped *at*, so it is
                 * still the hole -- and a hole shown as a value would be a lie
                 * about the program. */
                check("a local not yet initialised is not offered",
                      !("doubled" in by), JSON.stringify(by));

                this.testDebuggerAsks();
            });

        check("Write answers whether there was a child to write to",
              typeof job.Write === "function");
    }


    /*
     * Stopping a child, and stopping **what the child started**.
     *
     * The second is the one that matters and the one that was wrong: a child is
     * usually a wrapper -- here a shell, in the test runner `xvfb-run` -- and
     * signalling only the wrapper leaves its own children running. The runner's
     * hang guard left an X server orphaned to init once per timeout, which is
     * what this measures now.
     */
    /*
     * What a stopped program can be **asked**, and told.
     *
     * The stage-1 test above proves it stops; this one proves the three things
     * that make stopping worth anything: an expression answered where the
     * program is standing, a value written back, and a breakpoint that only
     * stops when its condition holds. Plus stopping where a throw happens,
     * which is the one place the frames that built a failure are still alive.
     */
    testDebuggerAsks() {
        const proj = File.Join(SCRATCH, "dbg2");

        Directory.Make(proj);
        File.Save(File.Join(proj, "project.json"),
                  JSON.stringify({ name: "dbg2", main: "Main", sources: ["Main.js"] }));
        /*
         * `let` and `const` on purpose: a *direct* eval reaches arguments and
         * `var`s and stops there, so an immediate window built on one could read
         * `n` and not `total` -- which in this language is most of what there is
         * to read. What the runtime does instead is compile the expression as a
         * function of the frame's own names.
         */
        File.Save(File.Join(proj, "Main.js"),
                  '"use strict";\n' +
                  'function twice(n) {\n' +
                  '    const doubled = n * 2;\n' +
                  '    if (n === 9) throw new Error("nueve");\n' +
                  '    return doubled;\n' +
                  '}\n' +
                  'function Main() {\n' +
                  '    const cliente = { nombre: "Ana", saldo: 7 };\n' +
                  '    let total = 0;\n' +
                  '    for (let i = 0; i < 4; i++) total += twice(i);\n' +
                  '    try { twice(9); } catch (e) { total += 1; }\n' +
                  '    print(`total ${total}`);\n' +
                  '    Application.Quit(0);\n' +
                  '}\n');

        const stops = [];
        const said  = {};
        const out   = [];
        let   locals = null;
        let   step   = 0;

        /* One script, driven by what comes back: each stop asks its questions
         * and then lets it go, so the run is the assertions in order. */
        const atStop = [
            /* i === 2, by the condition: read a const of this frame and one of
             * the caller's, then change this frame's and carry on. */
            (job) => {
                job.Write(JSON.stringify({ do: "eval", frame: 0, text: "doubled" }));
                job.Write(JSON.stringify({ do: "eval", frame: 1, text: "cliente.nombre" }));
                job.Write(JSON.stringify({ do: "eval", frame: 1, text: "total" }));
                job.Write(JSON.stringify({ do: "eval", frame: 0, text: "no.such.thing" }));
                job.Write(JSON.stringify({ do: "set", frame: 0, name: "doubled",
                                           text: "1000" }));
                job.Write(JSON.stringify({ do: "clear", id: 1 }));
                job.Write(JSON.stringify({ do: "stopOnThrow", value: true }));
                job.Write(JSON.stringify({ do: "continue" }));
            },
            /* the throw */
            (job) => {
                job.Write(JSON.stringify({ do: "locals", frame: 0 }));
                job.Write(JSON.stringify({ do: "stopOnThrow", value: false }));
                job.Write(JSON.stringify({ do: "continue" }));
            },
        ];

        const job = Exec([Application.Executable, "--debug", proj],
            {
                Timeout: 20000,
                Control: (line) => {
                    const msg  = JSON.parse(line);
                    const kind = msg.event || msg.reply;

                    if (kind === "ready") {
                        /* A condition, which is what makes one breakpoint out of
                         * four passes the one that matters. */
                        /* Line 4 and not 3: on the line that *declares*
                         * `doubled` it is still the hole, and a value written
                         * there would be overwritten by the declaration a
                         * moment later. A debugger reads a variable after the
                         * line that makes it. */
                        job.Write(JSON.stringify({ do: "break", file: "Main.js",
                                                   line: 4, id: 1, when: "n === 2" }));
                        job.Write(JSON.stringify({ do: "continue" }));
                    } else if (kind === "stopped") {
                        stops.push(msg);
                        if (atStop[step]) atStop[step++](job);
                    } else if (kind === "eval") {
                        said[msg.text] = msg;
                    } else if (kind === "locals") {
                        locals = msg.items;
                    }
                },
            },
            (line) => out.push(line),
            (code) => {
                eq("a program asked questions still finishes", code, 0);

                /* --- the condition ---------------------------------------- */
                eq("a conditional breakpoint stops once", stops.length, 2);
                eq("...and only where its condition held",
                   stops[0].frames[0].Line, 4);
                eq("which is the call it names", stops[0].frames[0].Name, "twice");

                /* --- the immediate ---------------------------------------- */
                eq("a const of the stopped frame is readable",
                   said["doubled"] && said["doubled"].value, "4");
                eq("...and a field of an object in the caller's frame",
                   said["cliente.nombre"] && said["cliente.nombre"].value, '"Ana"');
                eq("...and a `let` of the caller, which a direct eval cannot see",
                   said["total"] && said["total"].value, "2");

                /* An expression that throws answers its message and leaves
                 * nothing behind for the program to find. */
                check("a broken expression answers instead of failing",
                      said["no.such.thing"] && said["no.such.thing"].failed === true,
                      JSON.stringify(said["no.such.thing"]));

                /*
                 * --- the write-back ---------------------------------------
                 *
                 * `twice` returns `doubled`, so 1000 instead of 4 on the third
                 * turn: 0 + 2 + 1000 + 6, and one more from the catch.
                 */
                check("a value written back reaches the program",
                      out.join("").includes("total 1009"), JSON.stringify(out));

                /* --- the throw -------------------------------------------- */
                eq("it stops where the throw happens", stops[1].reason, "exception");
                eq("in the function that threw", stops[1].frames[0].Name, "twice");
                eq("on the line that threw", stops[1].frames[0].Line, 4);

                /* The whole point of stopping there rather than at the catch:
                 * the frame that built the failure is still alive. */
                const by = {};
                for (const item of locals || []) by[item.Name] = item.Value;
                eq("with the values that led to it", by.n, "9");
                eq("...including what it had worked out", by.doubled, "18");

                this.testExecKill();
            });
    }

    testExecKill() {
        const said = [];
        const job = Exec(["/bin/sh", "-c", "sleep 30 & echo $!; wait"],
                         (line) => said.push(line),
                         (code) => {
                             eq("a child stopped by a signal did not exit", code, -1);
                             check("and stopping it again finds nothing to stop",
                                   job.Stop() === false);
                             check("nor is there anything left to kill",
                                   job.Kill() === false);

                             const grandchild = Number(said[0]);
                             check("the child said what it started", grandchild > 0,
                                   JSON.stringify(said));
                             this.checkGone(grandchild, 0);
                         });

        check("Exec hands back a process id",
              typeof job.ProcessId === "number" && job.ProcessId > 0,
              String(job.ProcessId));
        /* Two verbs and no flag: `Stop` asks (SIGTERM), `Kill` makes (SIGKILL),
         * and both reach the whole group. A boolean would have read as .NET's
         * `Kill(true)`, which means something else there. */
        check("and two ways to end it",
              typeof job.Stop === "function" && typeof job.Kill === "function");

        /* Once the shell has started its own child and said so, or the group
         * would be signalled before there is a group to prove anything about. */
        const armed = () => said.length > 0;
        const stop  = () => {
            if (!armed()) { Timer.After(20, stop); return; }
            check("Stop reaches a running child", job.Stop() === true);
        };
        Timer.After(20, stop);
    }

    /*
     * Whether that pid is gone, given a moment to become gone.
     *
     * The signal is delivered at once but the process is reaped by whoever
     * inherits it, and asking in the same instant would be measuring the
     * scheduler.  Ten tries at 50 ms, which is twenty times what it takes.
     */
    checkGone(pid, tries) {
        Exec(["/bin/sh", "-c", `kill -0 ${pid} 2>/dev/null`], () => {}, (code) => {
            if (code === 0 && tries < 10) {
                Timer.After(50, () => this.checkGone(pid, tries + 1));
                return;
            }
            check("killing a child kills what it started", code !== 0,
                  `pid ${pid} still alive after ${tries} tries`);
            this.finish();
        });
    }

    finish() {
        /*
         * Nothing may report while an `until` is still counting: its assertions
         * have not run yet, and a report that overtakes one turns a failure into
         * a smaller total. Every one of them ends within two seconds either way,
         * so this drains.
         */
        if (waiting > 0) {
            Timer.After(20, () => this.finish());
            return;
        }

        /*
         * Cleanup that fails must not sink the report.  The scratch directory is
         * made by the tests that write in it, so a run filtered down to a test
         * that does not has nothing to clean -- and listing a directory that is
         * not there threw, from inside the catch that calls this, which left the
         * run reporting nothing and waiting for the timeout.
         */
        try {
            for (const name of Directory.List(SCRATCH))
                try { File.Delete(File.Join(SCRATCH, name)); } catch (e) { /* dirs stay */ }
        } catch (e) { /* nothing was written: nothing to sweep */ }

        print("");
        for (const f of failures) print(`  FAIL  ${f}`);
        const what = !partial ? ""
                   : ran.length ? `  [only ${ran.join(", ")}]`
                                : "  [nothing ran]";
        print(`widgets: ${passed} passed, ${failures.length} failed${what}`);
        Application.Quit(failures.length ? 1 : 0);
    }
}
