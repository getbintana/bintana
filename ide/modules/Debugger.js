/*
 * Debugging a project, from this side.
 *
 * The runtime does the stopping (`runtime/src/bta_debug.c`); this speaks to it
 * and draws what it says.  The protocol is one JSON object per line, out on the
 * child's third stream and in on its stdin -- which is what `Exec`'s `Control`
 * option and the handle's `Write` exist for, both added because the IDE needed
 * them and both available to any application now.
 *
 * **What is a breakpoint here is a gutter mark there.**  `SourceEditor.Mark`
 * has had a `Bookmark` kind since it was written, with its reference page
 * saying in as many words that a breakpoint is what it is for.  So the marks
 * *are* the state: there is no second list to disagree with what is on screen,
 * and a file that is not open has its lines kept here until it is.
 *
 * The runtime answers where a breakpoint really landed (`armed`), because a
 * line the compiler ran together with the one above it cannot stop -- and a
 * mark beside a line that will never stop is a lie the programmer then acts on.
 * So the mark moves to where the runtime put it, which is what every editor
 * does with a click on a blank line.
 */
"use strict";

Namespace("Ide");

/* The mark kind a breakpoint wears. */
const BREAK_MARK = "Bookmark";

/* And the one the stopped line wears, so the two are told apart by the gutter
 * rather than by colour alone. */
const HERE_MARK = "Info";

Ide.Debugger = class Debugger {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* file -> [line], the breakpoints of files whether open or not.  A
         * `Map` and not a `Dictionary`, which is this language's word for a bag
         * of *static* helpers over a plain object and not a class to build --
         * the open tabs are kept in a `Map` for the same reason. */
        this.marks = new Map();
        /* "file:line" -> the id the protocol knows that breakpoint by. */
        this.ids = new Map();
        /* The child while it is being debugged, and what it last said. */
        this.job     = null;
        this.stopped = null;      /* the frames, innermost first */
        this.frame   = 0;         /* which of them the panel is about */
        this.nextId  = 1;
        /* Expressions kept between stops, answered again at each one. */
        this.watches = [];
        /* The last answer per watch, so the list can be drawn before the
         * replies come back and not flicker through empty. */
        this.answers = new Map();
    }

    get running()  { return this.job !== null; }
    get halted()   { return this.stopped !== null; }

    /* --- breakpoints -------------------------------------------------------- */

    /*
     * F9 on the line the caret is on.  The mark is the state, so this reads it
     * back rather than keeping a second answer beside it.
     */
    toggle() {
        const file = this.ide.activeFile;
        if (!file || !this.ide.Editor) return false;

        const line = this.ide.Editor.Line;
        const on   = this.linesOf(this.ide.Editor).includes(line);

        if (on) this.ide.Editor.Unmark(line, BREAK_MARK);
        else    this.ide.Editor.Mark(line, BREAK_MARK,
                                     Locale.Text("Stop here while debugging"));

        this.remember(file);
        if (this.running) this.send(on ? { do: "clear", id: this.idOf(file, line) }
                                       : this.armCommand(file, line));
        return true;
    }

    /* What the open tab says, written down so a file that is closed keeps it. */
    remember(file) {
        if (!this.ide.Editor) return;
        this.marks.set(file, this.linesOf(this.ide.Editor));
    }

    /*
     * The lines an editor carries a breakpoint on.
     *
     * `Marks()` answers **records** -- `[{ Line, Kind, Text }]` -- and not the
     * line numbers its one-line summary reads as; everything here wants the
     * numbers, and wanted them in three places before this said so once.
     */
    linesOf(editor) {
        return editor.Marks(BREAK_MARK).map((m) => m.Line);
    }

    /* Put the marks back on a tab that has just opened. */
    restore(file, editor) {
        const lines = this.marks.get(file);
        if (!lines) return;

        for (const line of lines)
            editor.Mark(line, BREAK_MARK, Locale.Text("Stop here while debugging"));
    }

    /* Every breakpoint there is, as the protocol spells one. */
    all() {
        const out = [];
        for (const [file, lines] of this.marks)
            for (const line of lines) out.push({ file, line });

        return out;
    }

    armCommand(file, line) {
        const id = this.nextId++;
        this.ids.set(`${file}:${line}`, id);
        return { do: "break", file, line, id };
    }

    idOf(file, line) {
        return this.ids.get(`${file}:${line}`) || 0;
    }

    /* --- the run ------------------------------------------------------------ */

    /*
     * *Debug* while stopped means *Continue*, which is what one key doing both
     * buys: the thing one presses to get going is the same thing whether it has
     * started yet or not.
     */
    start() {
        if (this.halted) return this.send({ do: "continue" });
        if (this.running) return false;
        if (!this.ide.project) return false;

        this.ide.saveAllDirty();
        this.ide.LogView.Clear();
        /* Whatever this run is, the debugger runs it too: `--strict` is a
         * property of the run and not of the button that started it, and a
         * misspelt property is exactly the thing one would want to stop at. */
        const options = ["--debug", ...this.ide.runner.options()];

        this.ide.log(`> bintana ${[...options, this.ide.project].join(" ")}\n`);
        this.remember(this.ide.activeFile);

        this.stopped = null;
        this.ide.running = true;

        this.job = Exec([Application.Executable, ...options, this.ide.project],
                        { Directory: this.ide.project,
                          Control: (line) => this.heard(line) },
                        (line) => this.ide.log(`${line}\n`),
                        (code) => this.finished(code));
        this.flush();
        this.ide.refresh();
        return true;
    }

    stop() {
        if (this.job) this.job.Stop();
    }

    finished(code) {
        this.job     = null;
        this.stopped = null;
        this.ide.running = false;
        this.clearHere();
        this.ide.log(code === 0 ? "\n[finished ok]\n"
                                : `\n[finished with code ${code}]\n`);
        this.fill();
        this.ide.refresh();
        if (code !== 0) this.ide.runner.findErrorLine();
    }

    /*
     * A command to the child, or kept until there is one.
     *
     * The queue is not caution for its own sake: `Exec` hands the handle back
     * after it has spawned, and the child's first word arrives on its own time.
     * If `ready` ever won that race the reply would be dropped -- and the reply
     * to `ready` is what lets the program start at all, so the whole run would
     * hang with nothing anywhere saying why.
     */
    send(command) {
        const text = JSON.stringify(command);

        if (!this.job) {
            this.waiting = this.waiting || [];
            this.waiting.push(text);
            return true;
        }
        return this.job.Write(text);
    }

    /* Whatever was said before the handle existed. */
    flush() {
        for (const text of this.waiting || []) this.job.Write(text);
        this.waiting = null;
    }

    /* --- what the child says ------------------------------------------------ */

    heard(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch (e) {
            return;                /* a line we do not understand is not a crash */
        }

        const kind = msg.event || msg.reply;
        if (kind === "ready")   this.ready();
        else if (kind === "armed")   this.armed(msg);
        else if (kind === "stopped") this.halt(msg);
        else if (kind === "locals")  this.showLocals(msg);
        else if (kind === "eval")    this.answered(msg);
    }

    /*
     * The program is loaded and waiting: every breakpoint goes down now, before
     * a line of it has run.  A breakpoint armed after the program had started
     * would miss whatever it had already gone past.
     */
    ready() {
        for (const at of this.all()) this.send(this.armCommand(at.file, at.line));
        this.send({ do: "continue" });
    }

    /*
     * Where a breakpoint really landed.  The runtime moves one to the next line
     * that can stop, so the mark follows it: a mark on a line that will never
     * stop is worse than no mark.
     */
    armed(msg) {
        if (!msg.pending) return;

        const name  = this.projectName(msg.file);
        const lines = this.marks.get(name);
        if (!lines) return;

        /* The one it moved from is whichever of ours is nearest above it. */
        const from = lines.filter((l) => l <= msg.line).pop();
        if (from === undefined || from === msg.line) return;

        this.marks.set(name, lines.map((l) => (l === from ? msg.line : l)));

        const state = this.ide.openTabs.get(name);
        if (state && state.editor) {
            state.editor.Unmark(from, BREAK_MARK);
            state.editor.Mark(msg.line, BREAK_MARK,
                              Locale.Text("Stop here while debugging"));
        }
        /* The newline is the log's business and not the translator's. */
        this.ide.log(`${Locale.Text("{0}:{1} cannot stop; the breakpoint moved to line {2}.",
                                    name, from, msg.line)}\n`);
    }

    halt(msg) {
        this.stopped = msg.frames || [];
        this.frame   = 0;
        this.fill();
        /* `showFrame` goes to the line and asks for that frame's values, so
         * asking here as well would be the same question twice. */
        this.showFrame(0);
        for (const text of this.watches) this.ask(text);
        this.ide.refresh();
    }

    /* --- the panel ---------------------------------------------------------- */

    /* The stack, and under it whatever the selected frame holds. */
    fill() {
        const list = this.ide.StackList;

        list.Clear();
        if (!this.stopped) {
            this.locals = [];
            this.answers.clear();
            this.fillValues();
            return;
        }

        this.stopped.forEach((f, i) => {
            const row = new Panel();
            row.Arrangement = "Horizontal";
            row.Spacing     = 6;
            row.Margin      = 2;
            list.Add(row);

            const name = new Label();
            name.Text   = f.Name;
            name.Width  = 160;
            name.HAlign = "Start";
            row.Add(name);

            const at = new Label();
            at.Text    = f.Line ? `${File.Name(f.File)}:${f.Line}` : "(native)";
            at.Style   = "dim-label";
            at.HExpand = true;
            at.HAlign  = "Start";
            row.Add(at);
        });
        list.Index = 0;
    }

    showLocals(msg) {
        this.locals = msg.items || [];
        this.fillValues();
    }

    /*
     * The values pane: the watches, then the frame's own.
     *
     * One list and not two, because they answer the same question -- *what is
     * true here* -- and a panel 170 pixels tall cannot afford a second heading.
     * A watch is marked by carrying the expression as its name, which is what
     * it is, and by being removable.
     */
    fillValues() {
        const list = this.ide.LocalList;

        list.Clear();

        for (const text of this.watches) {
            const seen = this.answers.get(text);
            this.addValue(text, seen ? seen.value : "…", false,
                          seen && seen.failed);
        }
        for (const item of this.locals || [])
            this.addValue(item.Name, item.Value, item.Argument, false);
    }

    addValue(name, value, argument, failed) {
        const list = this.ide.LocalList;
        {
            const row = new Panel();
            row.Arrangement = "Horizontal";
            row.Spacing     = 6;
            row.Margin      = 2;
            list.Add(row);

            const label = new Label();
            label.Markup = true;
            /* An argument is shown in bold: which names came in and which the
             * body made is the first thing one wants off a list like this.
             * The escaping is the reason this is not `Text` alone -- a watch's
             * name is an expression and can hold a `<`. */
            label.Text   = argument ? `<b>${escapeMarkup(name)}</b>`
                                    : escapeMarkup(name);
            label.Width  = 120;
            label.HAlign = "Start";
            label.Tooltip = name;
            row.Add(label);

            const shown = new Label();
            shown.Text      = value;
            shown.Ellipsize = true;
            shown.HExpand   = true;
            shown.HAlign    = "Start";
            /* An expression that threw is dimmed rather than hidden: the
             * message is the answer, and a watch that cannot be answered in
             * this frame is a fact about the frame. */
            if (failed) shown.Style = "dim-label";
            row.Add(shown);
        }
    }

    /*
     * A row activated: a watch comes off the list, a value is changed.
     *
     * The two are told apart by where the row is, which is what makes one
     * gesture do the right thing on both halves of a list that holds both.
     */
    activated(index) {
        if (index < this.watches.length) {
            this.unwatch(this.watches[index]);
            return;
        }

        const item = (this.locals || [])[index - this.watches.length];
        if (!item || !this.halted) return;

        AskForm.prompt(Locale.Text("Change a value"),
                       Locale.Text("{0} is", item.Name), item.Value,
                       (text) => this.poke(item.Name, text));
    }

    /* Selecting a frame of the stack goes to its line and asks for its values. */
    showFrame(index) {
        if (!this.stopped || !this.stopped[index]) return;

        const f = this.stopped[index];
        this.frame = index;

        this.clearHere();
        if (f.Line && this.ide.openSource(this.projectName(f.File), f.Line)) {
            if (this.ide.Editor) {
                this.ide.Editor.Mark(f.Line, HERE_MARK, Locale.Text("Stopped here"));
                this.here = { file: this.ide.activeFile, line: f.Line };
            }
        }
        this.send({ do: "locals", frame: index });
        for (const text of this.watches) this.ask(text);
    }

    clearHere() {
        if (!this.here) return;

        const state = this.ide.openTabs.get(this.here.file);
        if (state && state.editor) state.editor.Unmark(this.here.line, HERE_MARK);
        this.here = null;
    }

    /* The child names a file the way it was loaded -- an absolute path; the tabs
     * and the tree name it the way the project does. */
    projectName(path) {
        const root = `${this.ide.project}/`;
        return path && path.startsWith(root) ? path.slice(root.length) : path;
    }

    /* --- what a stopped program can be asked --------------------------------- */

    /*
     * An expression, answered where the program is standing.
     *
     * What it can name is exactly what the values list shows, which is not a
     * coincidence: the runtime compiles it as a function of the frame's own
     * names and calls it with the frame's own values, so the panel and the box
     * can never disagree about what is in scope.
     */
    ask(text) {
        if (!this.halted || !text) return false;
        return this.send({ do: "eval", frame: this.frame, text });
    }

    /* An expression kept, and asked again at every stop. */
    watch(text) {
        if (!text || this.watches.includes(text)) return false;

        this.watches.push(text);
        if (this.halted) this.ask(text);
        return true;
    }

    unwatch(text) {
        this.watches = this.watches.filter((w) => w !== text);
        this.answers.delete(text);
        this.fillValues();
    }

    /*
     * An answer arriving.
     *
     * It is matched by the expression and not by arrival: the replies come back
     * in their own time and a watch list redrawn per reply would land them in
     * whatever order the pipe delivered.
     */
    answered(msg) {
        this.answers.set(msg.text, { value: msg.value, failed: !!msg.failed });

        if (this.watches.includes(msg.text)) {
            this.fillValues();
            return;
        }

        /*
         * A one-off from the box goes to the **log**, and not to a label beside
         * the box: an immediate window is a conversation, and the answer to the
         * question before last is worth as much as this one. It is what Visual
         * Basic's does, and it costs no room in a panel that has none.
         */
        this.ide.log(`${msg.text} => ${msg.value}\n`);
    }

    /* A value changed from the panel. The new one is an *expression*, so
     * `n + 1` and `this.Ok` work and not only literals. */
    poke(name, text) {
        if (!this.halted) return false;
        return this.send({ do: "set", frame: this.frame, name, text });
    }

    stopOnThrow(on) {
        this.throwing = on;
        return this.send({ do: "stopOnThrow", value: on });
    }

    /* --- the commands ------------------------------------------------------- */

    step(kind) {
        if (!this.halted) return false;

        this.clearHere();
        this.stopped = null;
        this.ide.refresh();
        return this.send({ do: "step", kind });
    }

    pause() { return this.running ? this.send({ do: "pause" }) : false; }
};

/*
 * A name put into markup.
 *
 * A local's name is an identifier and needs none of this; a **watch**'s name is
 * whatever was typed, and `a < b` in a label with markup on is a parse error
 * that swallows the rest of the line.
 */
function escapeMarkup(text) {
    return String(text).replace(/&/g, "&amp;")
                       .replace(/</g, "&lt;")
                       .replace(/>/g, "&gt;");
}
