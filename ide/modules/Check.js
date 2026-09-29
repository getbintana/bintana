/*
 * What is wrong with the project, asked of the whole of it.
 *
 * `Ide.Live` reads the file on screen, which is one file. Most of what this
 * language accepts in silence is not about the file on screen at all: a `.form`
 * loses a control because another one has its name, a manifest lists a source
 * that is not there, a `.js` sits on disk that nothing loads. Those are just as
 * wrong in a file nobody has open, and until now nothing looked.
 *
 * **Seven checks, and every one of them was measured before it was written.** Each
 * is a thing the runtime accepts without a word, found by writing it wrong on
 * purpose and watching what happened:
 *
 *     two controls of one name      the first one is gone -- two nodes in the
 *                                   file, one control on the window. A menu item
 *                                   and a command are bound by name too, so the
 *                                   same is true of them
 *     a control named `Actions`     `this.Actions` answers the *form's* actions,
 *                                   so the control has no name at all. The
 *                                   runtime refuses such a form now -- control,
 *                                   menu item and command alike -- so what is
 *                                   left here is saying so before it is run
 *     a property the class lacks    applied, ignored, never mentioned
 *     source that does not compile  refused at the first line, whatever the file
 *                                   is, whether or not a `.form` sits beside it
 *     a `.js` sources does not list not loaded; the symptom is a ReferenceError
 *                                   in another file entirely
 *     a key nothing reads           ignored; `"format"` was in one of this
 *                                   repository's own examples
 *     a member or a handler         `Ide.Names`, over every pair, not just the
 *                                   one on screen
 *     a call to a name taken away   `setTimeout(fn, 100)` runs into a
 *                                   ReferenceError at the next run, and the
 *                                   replacement was nowhere in the project.
 *                                   `Ide.Names` asks the runtime's own table
 *
 * The last two are why `Ide.Names` exists apart from `Ide.Live`: *does this
 * control have this member* has to have one answer, and a second copy of it
 * would be a second answer to drift from the first — and the third of them asks
 * about no `.form` at all, so it runs over a module too.
 *
 * **It runs no compiler and opens no file in a tab.** `File.LoadJson` and
 * `File.Load` are the whole of what it asks for, which is what keeps a pass over
 * a project cheap enough to run when one is opened -- with one exception, the
 * syntax pass below, which asks the compiler for the one answer it is uniquely
 * placed to give.
 *
 * Prior art: this is *Build → Check* in Delphi and Lazarus, `Project → Compile`
 * in Visual Basic -- the pass that says what is wrong before you press Run. What
 * this language has instead of a compiler is a `.form` that says what every
 * control is, which turns out to be enough for the mistakes that hurt most.
 */
"use strict";

Namespace("Ide");

Ide.Check = class Check {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* Which type names the runtime answers by class, worked out once: the
         * class list does not change while the IDE runs. */
        this.widgets = new Set(Widget.Types());
    }

    /*
     * Whether the loader will *refuse* this name or merely shadow what it
     * lands on.
     *
     * `Widget.Member` answers what the name is on a bare `Form` -- the class,
     * not a window built to ask -- and a **read-only** member is the one the
     * loader refuses: `Actions`, `Menus`, `Controls`, `DefaultButton`,
     * `CancelButton`. Anything else is shadowed, the form runs, and the
     * collision is all that can be said.
     */
    refusedByForm(name) {
        return Widget.Member("Form", name) === "ReadOnly";
    }

    /*
     * The pass. Everything it finds goes in under one source, so running it
     * again replaces what it said last time and nothing else -- the rule every
     * source of the Problems panel keeps.
     */
    run() {
        const ide = this.ide;
        if (!ide.project) return [];

        const found = [];
        this.manifest(found);

        for (const file of ide.classes.files) {
            const ext = File.Extension(file).toLowerCase();
            if (ext === "form") this.form(file, found);
            if (ext === "js")   this.code(file, found);
        }

        ide.problems.report("project", found);
        return found;
    }

    /* Everything this pass said, taken back: a project being closed has nothing
     * to answer for. */
    forget() {
        this.ide.problems.clear("project");
    }

    /* --- the manifest -------------------------------------------------------- */

    /*
     * `sources` is a **whitelist** once it is there, which is the half nobody
     * expects: a project with no `sources` loads every `.js` under it, and one
     * with a `sources` loads exactly those. So adding a file and forgetting the
     * manifest is a file that never loads, and what says so is a `ReferenceError`
     * in whichever other file called it.
     *
     * The keys are `Ide.ProjectFile`'s own -- it is a `Record`, so what a
     * manifest may hold is a list this class does not have to keep.
     */
    manifest(found) {
        const rel  = "project.json";
        const path = File.Join(this.ide.project, rel);

        let cfg;
        try {
            cfg = File.LoadJson(path);
        } catch (e) {
            found.push({ kind: "Error", file: rel, line: 0, text: e.message });
            return;
        }

        const known = new Ide.ProjectFile().PropertyNames().map((n) => n.toLowerCase());
        for (const key in cfg) {
            if (known.includes(key.toLowerCase())) continue;
            found.push({
                kind: "Warning", file: rel, line: 0,
                text: `"${key}" is not something a project.json says: nothing reads it`,
            });
        }

        if (!Array.isArray(cfg.sources)) return;     /* none is "load everything" */

        const listed = cfg.sources.map((s) => String(s));
        for (const file of this.ide.classes.files) {
            if (!File.IsExtension(file, "js")) continue;
            if (listed.includes(file)) continue;

            found.push({
                kind: "Warning", file, line: 0,
                text: `sources does not list this file, so it is never loaded`,
            });
        }

        for (const named of listed) {
            if (File.Exists(File.Join(this.ide.project, named))) continue;
            found.push({
                kind: "Error", file: rel, line: 0,
                text: `sources names ${named}, which is not there`,
            });
        }
    }

    /* --- one .form ----------------------------------------------------------- */

    /*
     * Three things a form file can say that the loader takes without a word.
     *
     * The collision one is the subtlest and the measurement is worth keeping:
     * a control named `Close` **wins** -- `this.Close` is the label, and the
     * method is what is lost -- while a control named `Actions` **loses**, since
     * that one is a getter with no setter and the assignment goes nowhere. The
     * same mistake resolves two different ways depending on what it lands on,
     * and neither way says anything. So the test is `Widget.Member` against the
     * class, which answers for both -- and is the `in` this used to run on a
     * bare `Form` made to ask.
     */
    form(rel, found) {
        let root;
        try {
            root = File.LoadJson(File.Join(this.ide.project, rel));
        } catch (e) {
            found.push({ kind: "Error", file: rel, line: 0, text: e.message });
            return;
        }

        /*
         * The names come from `Ide.Names`, which walks all three blocks a
         * `.form` binds by name -- `children`, `menus` and `actions`. This
         * class had a walk of its own that read `children` alone, so a menu
         * item called `Close` was a collision nothing looked for.
         */
        const seen = {};
        for (const node of this.ide.names.tableOf(root)) {
            if (seen[node.name])
                found.push({
                    kind: "Error", file: rel, line: 0,
                    text: `two controls are called ${node.name}: only the ` +
                          `last one is built`,
                });
            seen[node.name] = true;

            if (Widget.Member("Form", node.name) !== "") {
                /*
                 * Two different futures, and the reader does different things
                 * about them -- so they are two different rows. A **read-only**
                 * member (`Actions`, `Menus`, `Controls`, `DefaultButton`,
                 * `CancelButton`) makes the bind fail, and all three loaders
                 * refuse the form now: the program will not start. Anything
                 * else is shadowed, the form runs, and this is the only thing
                 * that will ever say so.
                 */
                const refused = this.refusedByForm(node.name);

                found.push({
                    kind: refused ? "Error" : "Warning", file: rel, line: 0,
                    text: refused
                        ? `${node.name} is also a member of Form, and a ` +
                          `read-only one: the form will not load`
                        : `${node.name} is also a member of Form: one of ` +
                          `the two is unreachable under that name`,
                });
            }
        }

        /*
         * The properties, which is a walk of `children` and only of `children`:
         * what a menu item or a command declares is `text`, `icon`, `shortcut`
         * -- keys of the file, in lower case, and not properties of a class.
         */
        const walk = (nodes) => {
            for (const node of nodes || []) {
                if (node.properties && node.type)
                    for (const key in node.properties)
                        if (this.hasMember(node.type, key) === false)
                            found.push({
                                kind: "Warning", file: rel, line: 0,
                                text: `${node.type} has no ${key}: the value is ` +
                                      `read and does nothing (${node.name || "unnamed"})`,
                            });

                walk(node.children);
            }
        };
        walk(root.children);
    }

    /*
     * Whether a class of that type has the member -- and **`null` when nothing
     * here can say**, which is a component of the project: its class belongs to
     * a process this one is not, so the node is passed over rather than guessed
     * at. A widget's class answers by name; the two classes that are not
     * widgets answer from the sample this window lends.
     */
    hasMember(type, key) {
        if (this.widgets.has(type)) return Widget.Member(type, key) !== "";

        const sample = this.ide.names.sampleFor(type);
        return sample ? key in sample : null;
    }

    /* --- one .js ------------------------------------------------------------- */

    /*
     * Two questions about a source file, and only one of them needs a `.form`.
     *
     * **The syntax check is the one that used to be missing, and it was missing
     * for the reason the second one is skipped.** `Ide.Live` checks the file on
     * screen and the save-time check in `Ide.TabSet` checks the tab in front of
     * you, so a module -- a `.js` with no `.form` beside it, which is most of
     * them -- was read by nobody at any point. The answer came from the run
     * instead, as a `ReferenceError` in whichever *other* file called it, and
     * `Application.CheckSource` was sitting right there with a line and a column
     * in it. There is nothing a `.form` can add to that question and the check
     * asks none, which is why it does not have one.
     *
     * The cost is a compile per file, and it was measured rather than guessed:
     * 610 us a file over this repository's own 63 `.js` and 1.07 MB of ide/,
     * 39 ms for the whole set, three rounds agreeing to within 4%. It is
     * proportional to the bytes and not to the number of files, so a project of
     * four hundred small modules costs less than one large form. It runs once,
     * when a project opens, and again on demand from Project -> Check.
     */
    code(rel, found) {
        let text;
        try {
            text = File.Load(File.Join(this.ide.project, rel));
        } catch (e) {
            return;                       /* a half-written file is not this pass's */
        }

        const bad = Application.CheckSource(text);
        if (bad)
            found.push({ kind: "Error", file: rel, line: bad.Line, text: bad.Message });

        /* The names the language has taken, which asks no `.form` and so runs on
         * a module as well as on a form's own class. `Ide.Names` owns it and
         * `Ide.Live` runs the same one over the file on screen. */
        for (const problem of this.ide.names.curated(text, rel, -1))
            found.push(problem);

        const form = this.ide.classes.formOf(rel);
        if (!form) return;

        let root;
        try {
            root = File.LoadJson(File.Join(this.ide.project, form));
        } catch (e) {
            return;                       /* the .form's own problem, `form()` says it */
        }

        const controls = this.ide.names.tableOf(root);
        for (const problem of this.ide.names.check(text, controls, rel, -1))
            found.push(problem);
    }
};
