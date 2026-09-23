/*
 * Running the project, and reading what it printed.
 *
 * The child is an `Exec`, and what it printed goes into a `TextEditor` -- the
 * shape `examples/usage` documents, and the one every other application would
 * write.  The pane used to be a `Terminal`: a real pty, for a consumer that
 * never typed into it, never coloured anything and never ran `less`.  What the
 * IDE does is launch a child and show what it printed, and neither of those
 * needs a terminal.
 *
 * What this class adds is the other direction: a traceback names a place, and a
 * place is somewhere to go.  A terminal answered that with `LinkPattern` and an
 * event; a text buffer answers it with the token under the click, which is
 * `linkAt` below -- ten lines, and testable without a pointer.
 *
 * `MainForm` keeps `log` and the pane's one handler -- a control's events are
 * looked up on the form, and `log` is what the whole IDE writes with -- and
 * hands the work here.
 */
"use strict";

Namespace("Ide");

/* Where the tick is remembered. A property of this window and not of any
 * project: the same project is run both ways. */
const STRICT_KEY = "run.strict";

Ide.Runner = class Runner {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* The child, while there is one: an Exec handle. */
        this.job = null;
        /* Lines waiting for the end of the turn: see `log`. */
        this.pending  = [];
        this.flushJob = null;
    }

    /*
     * A line of the child's output, **collected and put in once per turn**.
     *
     * A program that prints in a tight loop otherwise asked the pane for one
     * `Append` -- and one full-buffer copy of its text -- per line. Lines are
     * batched into one append on the next turn, which is what `Timer.After(0)`
     * is for.
     */
    log(text) {
        this.pending.push(text);
        if (this.flushJob) return;

        this.flushJob = Timer.After(0, () => {
            this.flushJob = null;
            this.flushLog();
        });
    }

    flushLog() {
        if (!this.pending.length) return;

        const batch = this.pending.join("");
        this.pending.length = 0;
        this.ide.log(batch);
    }

    start() {
        const ide = this.ide;
        if (!ide.project) return;

        /* A .form and its .js travel together: running with either unsaved would
         * execute something other than what is on screen. */
        ide.saveAllDirty();

        ide.clearLog();
        this.pending.length = 0;
        /* The console is cleared, and what the last run said about itself goes
         * with it: a place a program died at two runs ago is not a fact about
         * the program on screen now. */
        ide.problems.clear("run");
        const plan = ide.launch.plan();

        ide.log(`> bintana ${[...this.options(), ide.project,
                             ...plan.arguments].join(" ")}\n`);
        ide.running = true;
        ide.refresh();

        /*
         * The lines arrive split and without their newline, which is what the
         * pane puts back: `Append` writes at the end and scrolls there.  stdout
         * and stderr are merged on purpose -- a traceback interleaved with the
         * program's own output in the wrong order is worse than either.
         */
        /*
         * The chosen configuration says the rest: the arguments after the
         * project directory, where to start, and what to put in the
         * environment. A project that declares none plans an empty run, which
         * is exactly what this line was before there were any.
         */
        this.job = Exec([Application.Executable, ...this.options(), ide.project,
                         ...plan.arguments],
                        plan.options,
                        (line) => this.log(`${line}\n`),
                        (code) => this.finished(code));
    }

    /*
     * What this run is, as against what the project is.
     *
     * `--strict` makes a control refuse a property its class does not have, so
     * `this.Lbl.Txt = "x"` throws where it is written instead of doing nothing
     * forever -- the half of that question `Ide.Live` and `Ide.Check` cannot
     * answer, because it needs the program to be running.
     *
     * **Two things can turn it on and they mean different things.** The chosen
     * launch configuration may say a run is strict -- that is the project's, it
     * is versioned, and the whole team gets it. The tick in the menu is yours
     * and says *strictly anyway*, on top of whichever is chosen.
     *
     * So they are an `||` and not a choice: the tick only ever **adds**
     * strictness. A development switch that could quietly make checking looser
     * than the project asked for would be a worse thing to have than not to
     * have, and there is a way to say that already -- edit the configuration,
     * which is where the project said it.
     */
    options() {
        const strict = Settings.Get(STRICT_KEY, false) ||
                       this.ide.launch.plan().strict;

        return strict ? ["--strict"] : [];
    }

    /* The tick put back where the last session left it. A menu item's state
     * belongs to the runtime and starts at false, so a setting that nothing
     * restores is a setting that is on in the file and off on the screen. */
    restore() {
        this.ide.MnuStrict.Value = Settings.Get(STRICT_KEY, false);
    }

    /* Chosen. The item has already moved its own tick and hands over what it
     * became, so all that is left is writing it down. */
    chose(on) {
        Settings.Set(STRICT_KEY, on);
    }

    /* What the Stop button means, in the one place that knows there is a child
     * at all.  Pressed twice is an ordinary thing to do, so it asks first. */
    stop() {
        if (this.job && this.job.Running) this.job.Stop();
    }

    /* The child is over. A run that ended badly said where, so go there rather
     * than making the user read the traceback and find the file by hand. */
    finished(code) {
        const ide = this.ide;

        this.job = null;
        /* Whatever arrived in the same turn as the exit, before the traceback
         * below is read out of the pane. */
        this.flushLog();
        ide.log(code === 0 ? "\n[finished ok]\n"
                           : `\n[finished with code ${code}]\n`);
        ide.running = false;
        ide.refresh();

        if (code !== 0) this.findErrorLine();
    }

    /*
     * A place clicked in the log.
     *
     * The pane is an ordinary read-only `TextEditor`, and a click in one moves
     * the insertion cursor: `Line` and `Column` say where it landed, `Text` has
     * the rest, and `linkAt` puts those three together.  Measured, on a real
     * pointer under Xvfb -- which is what this replaced a terminal's
     * `LinkPattern` with.
     *
     * `Selection` is the guard.  A click leaves none; a drag leaves the text it
     * covered, and dragging across a place to copy it must not go there.  (A
     * drag does not usually produce a `MouseUp` here at all -- GTK's own drag
     * gesture claims the sequence -- but that is a second line of defence and
     * not one to lean on.)
     */
    followClick() {
        const view = this.ide.LogView;
        if (view.Selection !== "") return false;

        const link = this.linkAt(view.Line, view.Column, view.Text);
        return link ? this.clicked(link) : false;
    }

    /*
     * The place written at a line and column of some text, `""` for none.
     *
     * This is what `LinkPattern` used to do inside VTE, and it is split out
     * from the click for the reason that matters: a test can drive it without a
     * pointer, which is where the behaviour actually is.  `line` and `column`
     * are 1-based, the way `Editor` reports them.
     *
     * The token is the run of characters a place can be made of around that
     * column -- letters, digits, the separators of a path, and the colons a
     * `file:line:column` carries -- and `SOURCE_LINK` is matched inside it.
     * Not against the whole line: `at Form_Open (/tmp/Main.js:42:9)` holds one
     * place, and a click at either end of that line is on neither of them.
     */
    linkAt(line, column, text) {
        const row = (text || "").split("\n")[line - 1];
        if (!row) return "";

        /*
         * **A path may hold a space**, and the token walk below stops at one --
         * so a place in `/tmp/My Projects/Main.js` was unclickable. This first
         * pass looks for a whole place containing the click and allows the
         * space: an absolute path, or a relative one with a folder in it. It is
         * not a looser token walk -- prose does not match, because the pattern
         * still has to end in `.js:NN`.
         */
        const spaced = new Regex(
            "(?:[/~][\\w./+ \\-]+|[\\w.+\\-]+/[\\w.+\\- ]+(?:/[\\w.+\\- ]+)*)" +
            "\\.(?:js|form|json):\\d+");

        for (const m of spaced.Matches(row)) {
            if (column - 1 >= m.Index && column - 1 < m.Index + m.Value.length)
                return m.Value;
        }

        const TOKEN = /[\w./+:-]/;
        let from = column - 1;

        /* The cursor clamps to the end of the line, so a click anywhere in the
         * empty space to the right of a traceback would otherwise read the
         * frame it ends with -- a click on nothing, going somewhere. */
        if (from >= row.length) return "";

        /* A click just past the end of a word does land on the space after it,
         * and there the character before is the one that was aimed at. */
        if (!TOKEN.test(row[from])) from--;
        if (from < 0 || !TOKEN.test(row[from])) return "";

        let to = from;
        while (from > 0 && TOKEN.test(row[from - 1])) from--;
        while (to + 1 < row.length && TOKEN.test(row[to + 1])) to++;

        const found = new Regex(SOURCE_LINK).Match(row.slice(from, to + 1));
        return found ? found.Value : "";
    }

    /*
     * A place, as text: `file.js:42`, with the column a traceback adds allowed
     * and ignored.  Answers whether it went anywhere.
     */
    clicked(text) {
        const at = /^(.*):(\d+)(?::\d+)?$/.exec(text);
        return at ? this.open(at[1], Number(at[2])) : false;
    }

    /*
     * Opens a file the log named, at a line.  Only files of this project: a
     * traceback runs through the runtime's own frames and through whatever else
     * the program read, and those are not the IDE's to open.  Answers whether it
     * went anywhere.
     */
    open(path, line) {
        const ide = this.ide;
        if (!ide.project) return false;

        /* Tabs are keyed by the name relative to the project, which is what the
         * file tree and `openInTab` both speak. */
        let name = path;
        if (path.startsWith("/")) {
            if (!File.Within(path, ide.project)) return false;
            name = File.Relative(path, ide.project);
        }
        if (!File.Exists(File.Join(ide.project, name))) return false;
        if (!ide.openInTab(name)) return false;

        /* A .form opens in the designer, which has no lines to go to. */
        if (ide.Editor) {
            ide.Editor.GotoLine(line);
            ide.Editor.SetFocus();
        }
        ide.log(`${name}:${line}\n`);
        return true;
    }

    /*
     * The innermost frame of the last traceback that belongs to this project.
     *
     * A traceback is printed innermost first, so the first frame naming a file of
     * ours is the one that threw -- what is under it is `(native)` or the
     * runtime's own.  `start` clears the pane, so anything found here is from
     * this run.
     */
    errorLocation(text) {
        if (!text) return null;

        /* The last error and not the first: a program can survive several, and
         * the one worth going to is the one that just happened. */
        const said  = text.lastIndexOf("Bintana error:");
        const where = said >= 0 ? text.slice(said) : text;

        for (const m of new Regex(`(${SOURCE_LINK})`).Matches(where)) {
            const at = /^(.*):(\d+)$/.exec(m.Group(1));
            if (!at) continue;
            const path = at[1];
            /* Ours, or the runtime's? Only the first question has an answer the
             * IDE can act on. */
            if (path.startsWith("/") &&
                !File.Within(path, this.ide.project)) continue;
            return { path, line: Number(at[2]) };
        }
        return null;
    }

    /*
     * Where the run that just failed died, if it said.
     *
     * Looked for once and not on a retry.  `Exec` calls the exit callback only
     * after both pipes have seen EOF, and `Append` puts a line in the buffer as
     * it arrives -- so by the time `finished` runs, everything the child printed
     * is in `Text`.  This used to be ten tries thirty milliseconds apart,
     * because VTE digests what it is fed on its own time and the exit signal
     * could arrive before the last of the traceback was on screen.  There is no
     * pty left to wait for.
     *
     * Giving up quietly is still the right answer when the program died of
     * something that named no line at all.
     */
    findErrorLine() {
        const text  = this.ide.LogView.Text;
        const where = this.errorLocation(text);
        if (!where) return;

        this.ide.problems.report("run", [{
            kind: "Error",
            file: this.relative(where.path),
            line: where.line,
            text: this.errorMessage(text),
        }]);
        this.open(where.path, where.line);
    }

    /*
     * What the run died of, as one line.
     *
     * The escapes are taken off, and **that is a defence and no longer a
     * correction**. The runtime used to write `Bintana error:` in red whether or
     * not anything was listening in a terminal, which was true and invisible
     * while this pane was a VTE that ate them; finding them here the day it
     * became a text buffer is what got `isatty` put in front of that `fprintf`,
     * so a child of this IDE writes none. What a child may still write is
     * colour of *its own* -- a program that paints its own output does not stop
     * doing so because the IDE is reading it -- and one line of a traceback is
     * not the place to show it.
     */
    errorMessage(text) {
        const said = text.lastIndexOf("Bintana error:");
        if (said < 0) return Locale.Text("the run ended badly");

        const line = text.slice(said + "Bintana error:".length).split("\n")[0];
        return line.replace(/\x1b\[[0-9;]*m/g, "").trim()
            || Locale.Text("the run ended badly");
    }

    /* A path the traceback named, as a tab is keyed. Absolute is what a
     * traceback writes; relative is what everything in this IDE speaks. */
    relative(path) {
        return File.Relative(path, this.ide.project);
    }
};
