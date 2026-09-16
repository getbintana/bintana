/*
 * What is wrong with the project, in one list.
 *
 * **It finds nothing of its own, and that is the whole design.** Every check
 * behind these rows already existed and already ran; what none of them had was
 * somewhere to be seen. The syntax error a save found went to a gutter mark and
 * a line in the log, where the next run scrolls it away. The string lint went to
 * `Logger.Warning`, which is the terminal the IDE was launched from -- nobody
 * running the IDE from a desktop menu has ever read one. A run that died named a
 * file and a line in a wall of output. Three channels, three places to look, and
 * no answer at all to *what is wrong right now*.
 *
 * Prior art, and it is old: Visual Basic's *Messages* pane, Delphi's and
 * Lazarus's *Messages*, Visual Studio's *Error List*, VS Code's *Problems*. All
 * four are the same object -- a docked list of places, grouped by severity, each
 * row a jump -- and all four sit under the editor rather than beside it, because
 * a problem is about a line and the line is what one wants to keep looking at.
 *
 * **A source replaces its own rows and nobody else's.** That is the one rule
 * that makes a collector work: `report("strings", ...)` says everything the
 * string lint currently has to say, so a lint that now finds nothing clears its
 * own rows without touching the syntax error in the file next door. Saving one
 * file must not drop what is known about another, which is why the syntax source
 * is `syntax:<file>` -- one source per file, each replacing itself.
 *
 * What it owns is a table, the rows under it, and a signature of what it last
 * drew. Where a row goes is `Runner.open`, which is already what a click on the
 * log does: one spelling for *go to this place in this project*.
 */
"use strict";

Namespace("Ide");

/*
 * The three severities, in the order they are shown -- and they are
 * `SourceEditor.Mark`'s three words rather than three of our own, because a
 * problem and the mark in the gutter beside it are the same fact twice and
 * spelling them differently is how the two drift apart.
 */
const PROBLEM_KINDS = ["Error", "Warning", "Info"];

/* The severity column: an icon, and never text. Wide enough for one at 16px
 * with the cell's own padding either side. */
const PROBLEM_KIND_W = 34;

/* The place column. `ProjectTree.js:1234` is the longest thing that goes in it
 * and a file of this project is rarely deeper than that. */
const PROBLEM_PLACE_W = 220;

Ide.Problems = class Problems {

    constructor(ide) {
        this.ide = ide;

        /* Source -> what that source currently says. A Map and not a bag: the
         * keys are file names, which have dots and slashes in them. */
        this.bySource = new Map();

        /* Parallel to the table's rows: which problem each one is, so an
         * activated row knows where to go without parsing what it shows. */
        this.rows = [];

        /* What the table already says, so a report that changed nothing costs a
         * string compare -- `Changes` next door makes the same bargain, and for
         * the same reason: this hangs off a save, which happens all day. */
        this.drawn = null;

        /* The tab's own label, so the count can be written on it. It has to be a
         * widget: `Notebook.Tabs` replaces every label with a plain one, which
         * would take the Terminal's with it. */
        this.tab = null;
    }

    /*
     * Everything `source` has to say, replacing whatever it said before. An
     * empty list is how a source says it is happy, which is what clears its
     * rows.
     *
     * A problem is `{ kind, file, line, text }`: `kind` one of `PROBLEM_KINDS`, `file`
     * relative to the project the way a tab name is, `line` 1-based or `0` when
     * there is no line to go to.
     */
    report(source, list) {
        if (list && list.length) this.bySource.set(source, list);
        else                     this.bySource.delete(source);

        this.show();
    }

    /* The same thing said the other way round, for a caller that has nothing to
     * report and would otherwise have to write `[]` to say so. */
    clear(source) {
        this.report(source, []);
    }

    /*
     * Every problem, worst first.
     *
     * Ordered by severity, then by file and line -- the order one reads a list
     * of places in. `Locale.Compare` and not `<` for the file names, which is
     * this project's rule everywhere a person sees an order.
     */
    get all() {
        const out = [];
        for (const list of this.bySource.values()) out.push(...list);

        return out.sort((a, b) => {
            const kind = PROBLEM_KINDS.indexOf(a.kind) - PROBLEM_KINDS.indexOf(b.kind);
            if (kind) return kind;

            const file = Locale.Compare(a.file || "", b.file || "");
            if (file) return file;

            return (a.line || 0) - (b.line || 0);
        });
    }

    /*
     * What one source currently says, which is the question `all` cannot answer:
     * a problem carries where it is, not who found it. Two sources may have
     * something to say about one file -- a name the live check does not like and
     * a manifest that does not list it -- and telling them apart is what a test
     * about one of them needs.
     */
    of(source) {
        return this.bySource.get(source) || [];
    }

    /* How many of one severity there are, for the tab and for a test. */
    count(kind) {
        return this.all.filter((p) => !kind || p.kind === kind).length;
    }

    /* --- the view ---------------------------------------------------------- */

    /*
     * Fills the table, and says on the tab how many there are.
     *
     * The count is on the tab because a panel one has to turn to before it can
     * say whether anything is wrong is a panel one stops turning to. It is the
     * one thing every prior art above agrees on.
     */
    show() {
        const all       = this.all;
        /* `JSON.stringify` and not a joined string: a separator would have to be
         * a character no message can hold, and a message here is whatever a
         * compiler said. */
        const signature = JSON.stringify(all);
        if (signature === this.drawn) return;

        this.drawn = signature;
        this.build(all);
        this.say(all.length);
    }

    build(all) {
        const table = this.ide.ProblemView;
        if (!table) return;

        table.Columns = [{ Text: "", Width: PROBLEM_KIND_W },
                         { Text: Locale.Text("Place"), Width: PROBLEM_PLACE_W },
                         { Text: Locale.Text("Problem") }];
        table.Clear();
        this.rows = all;

        for (let i = 0; i < all.length; i++) {
            const p = all[i];
            table.Add(["", this.place(p), p.text]);

            const icon = this.icon(p.kind);
            if (icon) table.SetIcon(i, 0, icon);
        }
    }

    /* `file:line`, or the file alone when the problem is about the whole of it
     * -- a catalogue with nothing translated in it has no line to name. */
    place(p) {
        if (!p.file) return "";
        return p.line ? `${p.file}:${p.line}` : p.file;
    }

    /*
     * The desktop's picture for a severity, with the runtime's own behind it.
     * The same shape as `ProjectTree.icon`, and for the same reason: a theme
     * that lacks a name draws nothing at all rather than a missing-image box.
     */
    icon(kind) {
        const names = {
            Error:   ["dialog-error-symbolic", "dialog-error"],
            Warning: ["dialog-warning-symbolic", "dialog-warning"],
            Info:    ["dialog-information-symbolic", "dialog-information"],
        }[kind] || [];

        return names.find((name) => Application.HasIcon(name)) || "";
    }

    /*
     * The tab, which is where the count is.
     *
     * `Locale.Plural` and not a string with a number stuck on the end: *1
     * problem* and *2 problems* are two forms in English and more than two in
     * the languages this IDE is already translated into.
     */
    say(n) {
        const box = this.ide.ConsoleBox;
        if (!box || this.page < 0) return;

        if (!this.tab) {
            this.tab = new Label();
            box.SetTabLabel(this.page, this.tab);
        }

        this.tab.Text = n ? Locale.Plural("{0} problem", "{0} problems", n)
                          : Locale.Text("Problems");
    }

    /* Which page of the bottom panel this is. Asked of the notebook rather than
     * counted, so a page added before it does not have to remember this one. */
    get page() {
        const box = this.ide.ConsoleBox;
        if (!box || !this.ide.ProblemView) return -1;

        return box.Children.findIndex((c) => c.Name === "ProblemView");
    }

    /* --- what a row does --------------------------------------------------- */

    /*
     * A row was double clicked, or Enter was pressed on it: go to the place it
     * names.
     *
     * Through `Runner.open`, which is what a click on a traceback in the log
     * already does -- it refuses a file outside the project, opens the tab,
     * moves the cursor and takes the focus. A second way to go to a line is a
     * second set of those four decisions.
     */
    activated() {
        const p = this.rows[this.ide.ProblemView.Index];
        if (!p || !p.file) return false;

        return this.ide.runner.open(p.file, p.line || 1);
    }
};
