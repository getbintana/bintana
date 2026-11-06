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

/* The mark kind a breakpoint wears. */
const BREAK_MARK = "Bookmark";

/* And the one the stopped line wears, so the two are told apart by the gutter
 * rather than by colour alone. */
const HERE_MARK = "Info";

/* A breakpoint that is there and switched off: a hollow circle, and a mark of
 * its own so it keeps its line as the file is edited -- which only a mark does. */
const OFF_MARK = "Inactive";

/* What a breakpoint's settings are keyed by, here and in the runtime's `id`. */
function breakKey(file, line) { return `${file}:${line}`; }

/* The values tree: how far a level goes in, which is also the triangle's width,
 * and how wide a name is at the top. */
const INDENT     = 18;
const NAME_WIDTH = 120;

/* The triangle, by the names the desktop is likeliest to have. */
const ICON_SHUT = ["pan-end-symbolic", "go-next-symbolic"];
const ICON_OPEN = ["pan-down-symbolic", "go-down-symbolic"];

/*
 * The expression that reaches a field, from the one that reached its owner:
 * `client` and `address` make `client.address`, an index makes `tags[2]`, and
 * a name that is not an identifier is quoted -- `row["first name"]`. It is what
 * the runtime is asked to `expand`, and a path of names has no side effect.
 */
function childPath(owner, name) {
    if (isIndex(name)) return `${owner}[${name}]`;
    if (isIdentifier(name)) return `${owner}.${name}`;
    return `${owner}[${JSON.stringify(name)}]`;
}

/* A canonical array index and not merely digits: `[01]` is a legacy octal
 * literal, and the source is compiled in strict mode, so a field named "01"
 * would make an expansion fail instead of answering. */
function isIndex(s) {
    return s.length > 0 && String(Number(s)) === s && Number.isSafeInteger(Number(s));
}

function isIdentifier(s) {
    if (s.length === 0) return false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const word = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
        if (!word && (i === 0 || c < "0" || c > "9")) return false;
    }
    return true;
}

export class Debugger {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* file -> [line], the breakpoints of files whether open or not.  A
         * `Map` and not a `Dictionary`, which is this language's word for a bag
         * of *static* helpers over a plain object and not a class to build --
         * the open tabs are kept in a `Map` for the same reason. */
        this.marks = new Map();
        /* ...and the ones switched off, the same way: file -> [line]. */
        this.offMarks = new Map();
        /* "file:line" -> the id the protocol knows that breakpoint by. */
        this.ids = new Map();
        /* And what a breakpoint can be told to do: a condition, a message, or
         * neither.  The runtime has carried `when` since conditions were built
         * and `log` beside it now; these are what the IDE sends. */
        this.whens = new Map();
        this.logs  = new Map();
        /* And which pass it stops on: `5`, `>= 5`, `% 10` -- the runtime's
         * grammar, checked in `BreakpointForm` before it gets here. */
        this.hitSpecs = new Map();
        /* How often each breakpoint has been reached in this run, by its key:
         * the stop says it, and `hits` answers all of them at once. */
        this.hitCounts = new Map();
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
        /* The values opened in the tree, by the expression that reaches them
         * (`client.address`). Kept between stops, so a value opened once stays
         * open while the program is stepped -- and asked again at each stop,
         * since what was inside it is the program's and has moved on. */
        this.opened   = new Set();
        /* What each opened expression answered at this stop: its `expand`
         * reply, or null where it does not mean anything here. */
        this.children = new Map();
        /* The rows as drawn, so an activated index finds what it was. */
        this.rows = [];
        /* The fields the program stops on when they change, by the path the
         * tree reached them by -> the id the runtime knows the watch by. What
         * is watched is an object of this run, so a run ending forgets them. */
        this.fieldWatches = new Map();
        this.nextWatch    = 1;
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
        const off  = this.offLinesOf(this.ide.Editor).includes(line);

        /* F9 on a breakpoint takes it away, on or off: the gesture that put it
         * down is the one that removes it, and switching off is the panel's. */
        if (on || off) {
            this.forget(file, line);
        } else {
            this.ide.Editor.Mark(line, BREAK_MARK, this.markText(file, line));
            this.remember(file);
            if (this.running) this.send(this.armCommand(file, line));
        }
        this.changed();
        return true;
    }

    /*
     * One breakpoint taken away, wherever it is: its mark, its settings -- a
     * condition, a message and a hit count describe a stop that no longer
     * exists -- and the runtime's copy.
     */
    forget(file, line) {
        const ed  = this.editorFor(file);
        const key = breakKey(file, line);
        const was = ed ? this.linesOf(ed).includes(line)
                       : (this.marks.get(file) || []).includes(line);

        if (ed) {
            ed.Unmark(line, BREAK_MARK);
            ed.Unmark(line, OFF_MARK);
            this.remember(file, ed);
        } else {
            for (const map of [this.marks, this.offMarks])
                if (map.has(file)) map.set(file, map.get(file).filter((l) => l !== line));
        }
        this.whens.delete(key);
        this.logs.delete(key);
        this.hitSpecs.delete(key);
        this.hitCounts.delete(key);
        if (was && this.running) this.send({ do: "clear", id: this.idOf(file, line) });
    }

    /*
     * A breakpoint switched on or off. **Off is still a breakpoint**: it keeps
     * its line, its condition, its message and its count, and the gutter shows
     * it hollow -- what changes is only that the runtime is not told of it.
     */
    setEnabled(file, line, on) {
        const ed   = this.editorFor(file);
        const now  = ed ? this.linesOf(ed).includes(line)
                        : (this.marks.get(file) || []).includes(line);
        if (now === on) return false;

        if (ed) {
            ed.Unmark(line, on ? OFF_MARK : BREAK_MARK);
            ed.Mark(line, on ? BREAK_MARK : OFF_MARK, this.markText(file, line, on));
            this.remember(file, ed);
        } else {
            const from = on ? this.offMarks : this.marks;
            const to   = on ? this.marks : this.offMarks;
            from.set(file, (from.get(file) || []).filter((l) => l !== line));
            to.set(file, [...(to.get(file) || []), line].sort((a, b) => a - b));
        }
        if (this.running) this.send(on ? this.armCommand(file, line)
                                       : { do: "clear", id: this.idOf(file, line) });
        this.changed();
        return true;
    }

    /*
     * What a breakpoint's gutter mark says under the pointer: what it is, and
     * the two things it can be told to do. A condition and a message have no dot
     * of their own -- one mark kind is one picture -- so the tooltip is where a
     * breakpoint's settings are visible from.
     */
    markText(file, line, on = true) {
        const key  = breakKey(file, line);
        const when = this.whens.get(key);
        const log  = this.logs.get(key);
        const hits = this.hitSpecs.get(key);
        let   text = on ? Locale.Text("Stop here while debugging")
                        : Locale.Text("Breakpoint switched off");

        if (when) text += ` · ${Locale.Text("only when")}: ${when}`;
        if (log)  text += ` · ${Locale.Text("message")}: ${log}`;
        if (hits) text += ` · ${Locale.Text("on pass")}: ${hits}`;
        return text;
    }

    /*
     * What a tab says, written down so a file that is closed keeps it. The
     * editor is asked for rather than assumed: a tab being closed is not the
     * active one, and the marks of the one on screen have moved with its
     * editing while this map has not.
     */
    remember(file, editor) {
        const ed = editor || this.ide.Editor;
        if (!ed || !file) return;
        this.marks.set(file, this.linesOf(ed));
        this.offMarks.set(file, this.offLinesOf(ed));
    }

    /* A file renamed: the same lines under the new name, and the settings with
     * them -- a condition describes the line and not the path. */
    renamed(oldName, newName) {
        for (const map of [this.marks, this.offMarks])
            if (map.has(oldName)) {
                map.set(newName, map.get(oldName));
                map.delete(oldName);
            }

        for (const map of [this.whens, this.logs, this.hitSpecs])
            for (const [key, value] of [...map]) {
                const at = key.lastIndexOf(":");
                if (key.slice(0, at) !== oldName) continue;

                map.delete(key);
                map.set(`${newName}:${key.slice(at + 1)}`, value);
            }
    }

    /* One setting moving from one address to another: a breakpoint the runtime
     * resolved to a different line, or a file that was renamed. */
    moveNotes(fromKey, toKey) {
        for (const map of [this.whens, this.logs, this.hitSpecs]) {
            if (!map.has(fromKey)) continue;

            map.set(toKey, map.get(fromKey));
            map.delete(fromKey);
        }
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

    /* ...and the ones switched off. */
    offLinesOf(editor) {
        return editor.Marks(OFF_MARK).map((m) => m.Line);
    }

    /* Put the marks back on a tab that has just opened. */
    restore(file, editor) {
        for (const line of this.marks.get(file) || [])
            editor.Mark(line, BREAK_MARK, this.markText(file, line));
        for (const line of this.offMarks.get(file) || [])
            editor.Mark(line, OFF_MARK, this.markText(file, line, false));
    }

    /*
     * Every breakpoint, on and off, as `{ file, line, on }` in file and line
     * order: what the panel lists and what a session keeps. An open tab is read
     * live, as `all()` does and for the same reason.
     */
    list() {
        const out = [];
        const add = (file, line, on) => out.push({ file, line, on });

        for (const [file, state] of this.ide.openTabs) {
            if (!state.editor) continue;
            for (const line of this.linesOf(state.editor))    add(file, line, true);
            for (const line of this.offLinesOf(state.editor)) add(file, line, false);
        }
        for (const [map, on] of [[this.marks, true], [this.offMarks, false]])
            for (const [file, lines] of map) {
                const state = this.ide.openTabs.get(file);
                if (state && state.editor) continue;
                for (const line of lines) add(file, line, on);
            }
        return out.sort((a, b) => Locale.Compare(a.file, b.file) || a.line - b.line);
    }

    /*
     * What a session keeps of the debugger: every breakpoint with its settings,
     * and the watches -- the expressions a person typed, which are as much the
     * project's as the lines are. Plain data, for `Settings`.
     */
    snapshot() {
        const breakpoints = this.list().map((b) => {
            const key = breakKey(b.file, b.line);
            const one = { file: b.file, line: b.line };
            if (!b.on) one.off = true;
            if (this.whens.has(key))    one.when = this.whens.get(key);
            if (this.logs.has(key))     one.log  = this.logs.get(key);
            if (this.hitSpecs.has(key)) one.hits = this.hitSpecs.get(key);
            return one;
        });
        return { breakpoints, watches: this.watches.slice() };
    }

    /*
     * Everything about the project being left, forgotten: breakpoints, their
     * settings, the watches. It was never done, and a project opened after
     * another inherited its breakpoints by relative path -- `Main.js:12` of the
     * last project armed in this one's `Main.js`.
     */
    reset() {
        for (const map of [this.marks, this.offMarks, this.ids, this.whens, this.logs,
                           this.hitSpecs, this.hitCounts, this.answers])
            map.clear();
        this.watches = [];
        this.changed();
    }

    /*
     * A session's breakpoints and watches, put back -- before the tabs reopen,
     * so each tab finds its marks waiting the way a closed file's always do.
     * What is not plain data of the right shape is skipped, since a settings
     * file is something a person can edit.
     */
    load(saved) {
        this.reset();
        if (!saved || typeof saved !== "object") return 0;

        let n = 0;
        for (const b of Array.isArray(saved.breakpoints) ? saved.breakpoints : []) {
            if (!b || typeof b.file !== "string" || !b.file) continue;
            const line = Number(b.line);
            if (!Number.isInteger(line) || line < 1) continue;

            const map = b.off ? this.offMarks : this.marks;
            map.set(b.file, [...(map.get(b.file) || []), line]);
            const key = breakKey(b.file, line);
            if (typeof b.when === "string" && b.when) this.whens.set(key, b.when);
            if (typeof b.log === "string" && b.log)   this.logs.set(key, b.log);
            if (typeof b.hits === "string" && BreakpointForm.IsHitCount(b.hits) && b.hits)
                this.hitSpecs.set(key, b.hits);
            n++;
        }
        for (const w of Array.isArray(saved.watches) ? saved.watches : [])
            if (typeof w === "string" && w && !this.watches.includes(w)) this.watches.push(w);
        this.changed();
        return n;
    }

    /*
     * Every breakpoint there is, as the protocol spells one.
     *
     * **An open tab is read live.** GtkSourceView moves a mark with the
     * editing, so the lines the editor carries are the truth and the map is
     * only what a file that is closed keeps -- reading the map for a file that
     * is open armed breakpoints on the lines it had when it was last
     * remembered, and a file edited since had moved them.
     */
    all() {
        const out = [];

        for (const [file, state] of this.ide.openTabs) {
            if (!state.editor) continue;
            for (const line of this.linesOf(state.editor))
                out.push({ file, line });
        }
        for (const [file, lines] of this.marks) {
            const state = this.ide.openTabs.get(file);
            if (state && state.editor) continue;      /* read live above */
            for (const line of lines) out.push({ file, line });
        }
        return out;
    }

    armCommand(file, line) {
        const id      = this.nextId++;
        const key     = breakKey(file, line);
        const command = { do: "break", file, line, id };

        this.ids.set(key, id);
        /* The runtime carries both since conditions and logpoints were built;
         * an absent one is a breakpoint that stops, which is what it always
         * was. */
        const when = this.whens.get(key);
        const log  = this.logs.get(key);
        const hits = this.hitSpecs.get(key);
        if (when) command.when = when;
        if (log)  command.log  = log;
        if (hits) command.hits = hits;
        return command;
    }

    idOf(file, line) {
        return this.ids.get(breakKey(file, line)) || 0;
    }

    /* --- a breakpoint's settings -------------------------------------------- */

    setCondition(file, line, text) { this.setNote(this.whens, file, line, text); }
    setMessage(file, line, text)   { this.setNote(this.logs,  file, line, text); }
    setHits(file, line, text)      { this.setNote(this.hitSpecs, file, line, text); }

    /*
     * One setting changed: written down, drawn again, and -- if a program is
     * running -- taken back to the runtime, which has the old one armed.
     */
    setNote(map, file, line, text) {
        const key   = breakKey(file, line);
        const clean = (text || "").trim();

        if (clean) map.set(key, clean);
        else       map.delete(key);

        this.refreshMark(file, line);
        this.rearm(file, line);
        this.changed();
    }

    /* The breakpoint's tooltip, redrawn where it is on screen. */
    refreshMark(file, line) {
        const ed = this.editorFor(file);
        if (!ed) return;

        if (this.linesOf(ed).includes(line)) {
            ed.Unmark(line, BREAK_MARK);
            ed.Mark(line, BREAK_MARK, this.markText(file, line));
        } else if (this.offLinesOf(ed).includes(line)) {
            ed.Unmark(line, OFF_MARK);
            ed.Mark(line, OFF_MARK, this.markText(file, line, false));
        }
    }

    /* The open editor of a file, whichever tab it is, or null. */
    editorFor(file) {
        if (file === this.ide.activeFile) return this.ide.Editor;

        const state = this.ide.openTabs.get(file);
        return state && state.editor;
    }

    /*
     * A breakpoint already armed, told again. Clearing by the id it has and
     * arming a fresh one is the whole of it: the protocol has no *change a
     * breakpoint*, and a program that is stopped is a program whose armed set
     * can be edited one at a time.
     */
    rearm(file, line) {
        if (!this.running) return;
        const ed = this.editorFor(file);
        const on = ed ? this.linesOf(ed).includes(line)
                      : (this.marks.get(file) || []).includes(line);
        if (!on) return;            /* off is not armed, and has nothing to re-arm */

        this.send({ do: "clear", id: this.idOf(file, line) });
        this.send(this.armCommand(file, line));
    }

    /*
     * *Breakpoint...*: the condition and the message of the breakpoint under the
     * caret. Refused where there is none, because the thing being edited does
     * not exist yet -- F9 puts one down first, which is the order the gutter
     * already teaches.
     */
    editBreakpoint() {
        const file = this.ide.activeFile;
        const ed   = this.ide.Editor;
        if (!file || !ed) return false;

        const line = ed.Line;
        if (!this.linesOf(ed).includes(line) && !this.offLinesOf(ed).includes(line)) {
            this.ide.log(`${Locale.Text("Put the caret on a breakpoint first.")}\n`);
            return false;
        }

        const key = breakKey(file, line);
        this.ide.breakpointDialog = BreakpointForm.edit(
            `${File.Name(file)}:${line}`,
            this.whens.get(key), this.logs.get(key), this.hitSpecs.get(key),
            (condition, message, hits) => {
                this.setCondition(file, line, condition);
                this.setMessage(file, line, message);
                this.setHits(file, line, hits);
            });
        return true;
    }

    /* --- the run ------------------------------------------------------------ */

    /*
     * *Debug* while stopped means *Continue*, which is what one key doing both
     * buys: the thing one presses to get going is the same thing whether it has
     * started yet or not.
     */
    start(testRun) {
        if (this.halted) return this.send({ do: "continue" });
        if (this.running) return false;
        if (!this.ide.project) return false;

        this.ide.saveAllDirty();
        this.ide.clearLog();
        /* Whatever this run is, the debugger runs it too: `--strict` is a
         * property of the run and not of the button that started it, and a
         * misspelt property is exactly the thing one would want to stop at. */
        const options = ["--debug", ...this.ide.runner.options()];
        const plan    = this.ide.launch.plan();

        /* The project's tests instead of the project: `test --json` in front,
         * the filter after it, and the results to `Tests` rather than to the
         * log. The run configuration's arguments are the program's, not the
         * tests'. */
        this.tests = testRun || null;
        const argv = this.tests
            ? ["test", "--json", ...options, this.ide.project,
               ...(this.tests.test ? [this.tests.test] : [])]
            : [...options, this.ide.project, ...plan.arguments];

        this.ide.log(`> bintana ${argv.join(" ")}\n`);
        this.remember(this.ide.activeFile);

        this.stopped = null;
        this.ide.running = true;
        /* A run counts from nothing; the last run's counts stay readable in the
         * panel until this one starts. */
        this.hitCounts.clear();
        this.changed();

        /* What the program is started with, file by file: what a save is
         * compared against to know what changed (`HotSwap.Plan`). Read after
         * the save above, so it is the text the child loads. */
        this.loaded = new Map();
        for (const f of this.ide.classes.files || []) {
            if (!File.IsExtension(f, "js")) continue;
            try { this.loaded.set(f, File.Load(File.Join(this.ide.project, f))); }
            catch (e) { /* unreadable: nothing to compare a save against */ }
        }
        this.swaps = new Map();

        /* The same plan Run uses -- arguments, directory and environment -- with
         * the control channel added. Debugging a project with different
         * arguments than running it would be a second answer to the question
         * *how is this project started*. */
        const tests = this.tests;
        this.job = Exec([Application.Executable, ...argv],
                        { ...plan.options, Control: (line) => this.heard(line) },
                        (line) => (tests ? tests.onLine(line) : this.ide.log(`${line}\n`)),
                        (code) => this.finished(code));
        /*
         * What the configuration says about stopping, applied before anything
         * runs -- which is the first memory this switch has ever had. It was a
         * live command with nothing behind it, so it came up off in every
         * session however often it was turned on, and the menu tick said so
         * only until the next launch.
         */
        this.stopOnThrow(plan.stopOnThrow);
        this.ide.MnuStopThrow.Value = plan.stopOnThrow;

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
        this.peeking = null;
        this.thread  = "";
        /* What was refused was about this run; the next starts from the files. */
        for (const file of this.swapped || []) this.ide.problems.clear(`hotswap:${file}`);
        this.swapped = new Set();
        this.loaded  = null;
        this.swaps   = new Map();
        this.lagging = new Set();
        this.ide.tabs.render();
        this.fieldWatches.clear();
        /* What was opened is the run's objects, and the next run's are not
         * them: keeping the paths would ask a removed watch's expression again
         * at the first stop of a program that has nothing to do with it. */
        this.opened.clear();
        this.children.clear();
        this.ide.running = false;
        this.clearHere();
        const tests = this.tests;
        this.tests = null;
        /* A test run answers on its own page: 1 is *a test failed*, which is an
         * answer and not an error to go looking for a line of. */
        if (tests) {
            tests.onExit(code);
            this.fill();
            this.ide.refresh();
            return;
        }
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
        else if (kind === "refused") this.refused(msg);
        else if (kind === "stopped") this.halt(msg);
        else if (kind === "log")     this.recorded(msg);
        else if (kind === "locals")  this.showLocals(msg);
        else if (kind === "eval")    this.answered(msg);
        else if (kind === "expand")  this.expanded(msg);
        else if (kind === "watch")   this.watchAnswered(msg);
        else if (kind === "hits")    this.counted(msg);
        else if (kind === "replace") this.replaced(msg);
    }

    /*
     * A logpoint's line, in the output pane: where it fired and what the
     * expression came to. A line of the run and not a row of the values panel --
     * the program is still going, and a logpoint inside a loop would fill any
     * list.
     */
    /* --- a save, while the program runs -------------------------------------- */

    /*
     * A `.js` saved while a program runs under the debugger: what changed is
     * offered to the running program (`HotSwap.Plan`), one member at a time,
     * and what cannot be taken is said where it is. The answers arrive one per
     * member; `swapDone` reports once all of one save's have.
     */
    saved(file, text) {
        if (!this.running || !this.loaded || !File.IsExtension(file, "js")) return false;
        const before = this.loaded.get(file);
        if (before === undefined) return false;

        const plan = HotSwap.Plan(before, text);
        const save = { file, text, applied: [], refused: plan.refused.slice(), waiting: 0 };

        for (const m of plan.replace) this.sendSwap(save, m, false);
        for (const m of plan.remove)  this.sendSwap(save, m, true);
        if (!save.waiting) this.swapDone(save);
        return true;
    }

    sendSwap(save, m, remove) {
        const id = this.nextSwap = (this.nextSwap || 0) + 1;
        const command = { do: "replace", id, class: m.cls, name: m.name, kind: m.kind };
        if (remove) command.remove = true;
        else        command.text = m.text;

        save.waiting++;
        this.swaps.set(id, { save, member: m, remove });
        this.send(command);
    }

    /* Whether the running program has not taken all of what `file` says: the
     * tab shows it, until a save it takes whole or the run's end. */
    behind(file) {
        return !!(this.running && this.lagging && this.lagging.has(file));
    }

    /* The runtime's answer for one member. */
    replaced(msg) {
        const one = this.swaps.get(msg.id);
        if (!one) return;
        this.swaps.delete(msg.id);

        const { save, member, remove } = one;
        if (msg.applied)
            save.applied.push(remove ? Locale.Text("{0} (taken off)", member.name) : member.name);
        else
            save.refused.push({ line: remove ? 0 : member.line,
                                why: `${member.cls}.${member.name}: ${msg.why}` });
        if (--save.waiting === 0) this.swapDone(save);
    }

    /*
     * One save, answered: a line in the log, every refusal a row in Problems on
     * its line, and -- when the program is stopped inside a member that was
     * just replaced -- the reminder that this call finishes with the code it
     * started with. When nothing was refused, the saved text is what the
     * program runs from now on.
     */
    swapDone(save) {
        const { file, applied, refused } = save;
        if (applied.length)
            this.ide.log(`${Locale.Text("{0}: the running program takes {1}.", file, applied.join(", "))}\n`);
        if (refused.length)
            this.ide.log(`${Locale.Plural("{1}: {0} change is not taken while it runs (see Problems).",
                                          "{1}: {0} changes are not taken while it runs (see Problems).",
                                          refused.length, file)}\n`);

        this.swapped = this.swapped || new Set();
        this.swapped.add(file);
        this.ide.problems.report(`hotswap:${file}`, refused.map((r) => ({
            kind: "Warning", file, line: r.line, text: r.why })));
        if (!refused.length) this.loaded.set(file, save.text);
        this.lagging = this.lagging || new Set();
        if (refused.length) this.lagging.add(file);
        else                this.lagging.delete(file);
        this.ide.tabs.render();

        const top = this.stopped && this.stopped[this.frame];
        if (top && top.Line && this.projectName(top.File) === file) {
            const inside = HotSwap.Members(save.text);
            for (const m of inside ? inside.values() : [])
                if (applied.includes(m.name) && m.line <= top.Line && top.Line <= m.end)
                    this.ide.log(`${Locale.Text("This call of {0} finishes with the code it started with; the next one runs the new.", m.name)}\n`);
        }
    }

    /* Every breakpoint's passes so far, by the id it was armed with. */
    counted(msg) {
        for (const row of msg.items || []) {
            const key = this.keyOfId(row.id);
            if (key) this.hitCounts.set(key, row.hits);
        }
        this.changed();
    }

    /* --- the breakpoints page ----------------------------------------------- */

    /* Something about the breakpoints moved: the page says so. */
    changed() {
        this.fillBreakpoints();
    }

    /*
     * The page: one row per breakpoint, on or off, with what it is told to do
     * and how often it has been passed. Built from `list()`, which reads the
     * open editors live, so a row is never a second opinion about the gutter.
     */
    fillBreakpoints() {
        const table = this.ide.BreakView;
        if (!table) return;

        if (!this.breakDressed) {
            this.breakDressed = true;
            table.Columns = [
                { Text: "", Width: 36, Alignment: "Center",
                  Editor: { Kind: "Check", ActiveText: "true", InactiveText: "false" } },
                { Text: Locale.Text("Place"), Width: 200 },
                { Text: Locale.Text("Only when"), Width: 160 },
                { Text: Locale.Text("On pass"), Width: 80 },
                { Text: Locale.Text("Message"), Width: 160 },
                { Text: Locale.Text("Passes") } ];
        }
        table.Clear();
        this.breakRows = this.list();
        for (const b of this.breakRows) {
            const key  = breakKey(b.file, b.line);
            const seen = this.hitCounts.get(key);
            table.Add([b.on ? "true" : "false", `${b.file}:${b.line}`,
                       this.whens.get(key) || "", this.hitSpecs.get(key) || "",
                       this.logs.get(key) || "", seen === undefined ? "" : String(seen)]);
        }
        if (this.ide.BtnBpToggleAll)
            this.ide.BtnBpToggleAll.Text = this.breakRows.some((b) => b.on)
                ? Locale.Text("Disable all") : Locale.Text("Enable all");
    }

    /* The tick: on or off, answered with what the cell keeps. */
    ticked(row, text) {
        const b = (this.breakRows || [])[row];
        if (!b) return text;
        this.setEnabled(b.file, b.line, text === "true");
        return text;
    }

    /* A row activated: its line, in its file. */
    goToBreakpoint(row) {
        const b = (this.breakRows || [])[row];
        if (!b || !this.ide.openInTab(b.file)) return false;
        if (this.ide.Editor) this.ide.Editor.GotoLine(b.line);
        return true;
    }

    removeBreakpoint(row) {
        const b = (this.breakRows || [])[row];
        if (!b) return false;
        this.forget(b.file, b.line);
        this.changed();
        return true;
    }

    /* Every one off when any is on, every one on otherwise: the button says
     * which it will do. */
    toggleAll() {
        const on = !this.list().some((b) => b.on);
        for (const b of this.list()) this.setEnabled(b.file, b.line, on);
        this.changed();
    }

    removeAll() {
        for (const b of this.list()) this.forget(b.file, b.line);
        this.changed();
    }

    /* The "file:line" a protocol id stands for, or "". */
    keyOfId(id) {
        for (const [key, known] of this.ids) if (known === id) return key;
        return "";
    }

    recorded(msg) {
        this.ide.log(`${this.projectName(msg.file)}:${msg.line}: ${msg.text}\n`);
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
        this.moveNotes(breakKey(name, from), breakKey(name, msg.line));

        const state = this.ide.openTabs.get(name);
        if (state && state.editor) {
            state.editor.Unmark(from, BREAK_MARK);
            state.editor.Mark(msg.line, BREAK_MARK, this.markText(name, msg.line));
        }
        /* The newline is the log's business and not the translator's. */
        this.ide.log(`${Locale.Text("{0}:{1} cannot stop; the breakpoint moved to line {2}.",
                                    name, from, msg.line)}\n`);
        this.changed();
    }

    /*
     * A breakpoint the runtime has nowhere to stop for: past the last line of
     * its file that can stop, outside any function. The mark comes off, with
     * its condition and its message: a dot beside a line that will never stop
     * is a lie the programmer then acts on.
     */
    refused(msg) {
        const name  = this.projectName(msg.file);
        const lines = this.marks.get(name);

        if (lines) this.marks.set(name, lines.filter((l) => l !== msg.line));
        this.whens.delete(breakKey(name, msg.line));
        this.logs.delete(breakKey(name, msg.line));
        this.hitSpecs.delete(breakKey(name, msg.line));

        const state = this.ide.openTabs.get(name);
        if (state && state.editor) state.editor.Unmark(msg.line, BREAK_MARK);

        /* The runtime says why when it has a reason other than the line -- a
         * hit count it cannot read. */
        if (msg.why)
            this.ide.log(`${Locale.Text("{0}:{1} cannot stop: {2}", name, msg.line, msg.why)}\n`);
        else
            this.ide.log(`${Locale.Text("{0}:{1} cannot stop: nothing runs there or after it.",
                                        name, msg.line)}\n`);
        this.changed();
    }

    halt(msg) {
        /* Stopped by a field changing: what it was and what it is now are the
         * reason, and the line is the one that wrote it. */
        if (msg.reason === "watch")
            this.ide.log(`${Locale.Text("{0} changed: {1} -> {2}", msg.text, msg.old, msg.new)}\n`);
        /* A breakpoint says which pass this is, and one with a hit count says it
         * out loud: the pass is what was asked for. */
        if (msg.reason === "breakpoint" && msg.id) {
            const key = this.keyOfId(msg.id);
            if (key) {
                this.hitCounts.set(key, msg.hits);
                if (this.hitSpecs.has(key))
                    this.ide.log(`${Locale.Text("Stopped on pass {0}.", msg.hits)}\n`);
            }
        }
        this.stopped = msg.frames || [];
        this.frame   = 0;
        /* A stop inside a `Task` is on the worker's thread, and the stack is
         * the worker's: said above the stack and once in the log, since the
         * window is still running and that is worth knowing. */
        this.thread = msg.thread || "";
        if (this.thread)
            this.ide.log(`${Locale.Text("Stopped in task {0}.", this.thread)}\n`);
        this.fill();
        /* `showFrame` goes to the line and asks for that frame's values, so
         * asking here as well would be the same question twice. */
        this.showFrame(0);
        for (const text of this.watches) this.ask(text);
        /* How often every breakpoint has been passed, for the panel: the stop
         * is when a person looks, and one question answers all of them. */
        this.send({ do: "hits" });
        this.ide.refresh();
    }

    /* --- the panel ---------------------------------------------------------- */

    /* The stack, and under it whatever the selected frame holds. */
    fill() {
        const list = this.ide.StackList;

        if (this.ide.LblStack)
            this.ide.LblStack.Text = this.stopped && this.thread
                ? Locale.Text("Call stack: task {0}", this.thread)
                : Locale.Text("Call stack");
        list.Clear();
        if (!this.stopped) {
            this.locals = [];
            this.answers.clear();
            this.children.clear();
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
        /* What was inside the opened values belongs to the stop before, so
         * every one of them is asked again here, where the frame stands now. */
        this.children.clear();
        for (const path of this.opened)
            this.send({ do: "expand", frame: this.frame, text: path });
        this.fillValues();
    }

    /* An opened value's fields arriving. Matched by the expression, like a
     * watch's answer, and dropped when it was asked of another frame. */
    expanded(msg) {
        if (msg.frame !== this.frame || !this.opened.has(msg.text)) return;
        this.children.set(msg.text, msg.failed ? null : msg);
        this.fillValues();
    }

    /* A value and everything reached through it: `parent.field` and
     * `parent[0]` are both under `parent`, and neither is under `parentx`. */
    dropOpened(path) {
        for (const key of [...this.opened]) {
            if (key === path || key.startsWith(path + ".") ||
                key.startsWith(path + "[")) {
                this.opened.delete(key);
                this.children.delete(key);
            }
        }
        this.children.delete(path);
    }

    /* A triangle clicked: the value opens or closes. */
    toggleOpen(path) {
        if (this.opened.has(path)) {
            this.dropOpened(path);
        } else {
            this.opened.add(path);
            if (this.halted) this.send({ do: "expand", frame: this.frame, text: path });
        }
        this.fillValues();
    }

    /*
     * A field the program should stop on when it changes -- or no longer.
     *
     * Only a field: a local belongs to its frame, and the frame is the only
     * thing that can change it. What is armed is the object the path reaches
     * *now* (`watch_field` in the runtime), which is what a watchpoint is; the
     * mark stays on the path, which is where it was asked for.
     */
    toggleFieldWatch(node) {
        const was = this.fieldWatches.get(node.path);

        if (was !== undefined) {
            this.fieldWatches.delete(node.path);
            this.send({ do: "unwatch", id: was });
        } else {
            if (!this.halted) return false;
            const id = this.nextWatch++;
            this.fieldWatches.set(node.path, id);
            this.send({ do: "watch", id, frame: this.frame,
                        owner: node.owner, name: node.field });
        }
        this.fillValues();
        return true;
    }

    /* The runtime's answer to a field watch: armed, or why it could not be --
     * a getter, a field the object only inherits, one already watched. */
    watchAnswered(msg) {
        if (msg.armed) {
            this.ide.log(`${Locale.Text("Stops when {0} changes.", msg.text)}\n`);
            return;
        }
        for (const [path, id] of this.fieldWatches)
            if (id === msg.id) this.fieldWatches.delete(path);
        this.ide.log(`${Locale.Text("{0} cannot be watched: {1}", msg.text, msg.why)}\n`);
        this.fillValues();
    }

    /*
     * The values pane: the watches, then the frame's own, and under each opened
     * one what is inside it.
     *
     * One list and not two, because they answer the same question -- *what is
     * true here* -- and a panel 170 pixels tall cannot afford a second heading.
     * A watch is marked by carrying the expression as its name, which is what
     * it is, and by being removable.
     *
     * **A tree drawn as indented rows of the same list**, and not a `TreeView`:
     * a row here is a name and a value and a gesture, which is what the list
     * already was, and an opened value is one more question to the runtime
     * (`expand`) rather than a model to keep in step with it.
     */
    fillValues() {
        const list = this.ide.LocalList;

        list.Clear();
        this.rows = [];

        for (const text of this.watches) {
            const seen = this.answers.get(text);
            /* In parentheses, so `a + b`'s fields are asked of the sum. */
            this.addValue({ kind: "watch", name: text, path: `(${text})`,
                            value: seen ? seen.value : "…",
                            failed: seen && seen.failed,
                            openable: !!(seen && seen.children) }, 0);
        }
        for (const item of this.locals || [])
            this.addValue({ kind: "local", name: item.Name, path: item.Name,
                            value: item.Value, argument: item.Argument,
                            openable: !!item.Children }, 0);
    }

    addValue(node, depth) {
        const list = this.ide.LocalList;
        const open = node.openable && this.opened.has(node.path);
        {
            const row = new Panel();
            row.Arrangement = "Horizontal";
            row.Spacing     = 2;
            row.Margin      = 2;
            list.Add(row);
            this.rows.push(node);

            if (depth > 0) {
                const indent = new Panel();
                indent.Width = INDENT * depth;
                row.Add(indent);
            }

            /* The triangle, or the room it would take, so names line up. */
            if (node.openable) {
                const toggle = new Button();
                toggle.Icon  = (open ? ICON_OPEN : ICON_SHUT).find((n) => Application.HasIcon(n)) || "";
                if (!toggle.Icon) toggle.Text = open ? "▾" : "▸";
                toggle.Style = "flat";
                toggle.Width = INDENT;
                toggle.Tooltip = open ? Locale.Text("Close") : Locale.Text("Open");
                toggle.On("Click", () => this.toggleOpen(node.path));
                row.Add(toggle);
            } else {
                const room = new Panel();
                room.Width = INDENT;
                row.Add(room);
            }

            const label = new Label();
            label.Markup = true;
            /*
             * An argument is shown in bold: which names came in and which the
             * body made is the first thing one wants off a list like this.
             *
             * The escaping is the reason this is not `Text` alone. A local's
             * name is an identifier and needs none of it; a **watch**'s name is
             * whatever was typed, and `a < b` in a label with markup on is a
             * parse error that swallows the rest of the line. `Text.Escape` is
             * the runtime's own, and escapes the quotes as well as the three
             * that matter here -- harmless in markup text, where `&quot;` draws
             * as `"`.
             */
            /* A field the program stops on when it changes wears a dot. */
            const mark   = this.fieldWatches.has(node.path) ? "\u25c9 " : "";
            label.Text   = mark + (node.argument ? `<b>${Text.Escape(node.name)}</b>`
                                                 : Text.Escape(node.name));
            /* Narrower as it goes in, so the values stay in one column. */
            label.Width  = Math.max(NAME_WIDTH - INDENT * depth, INDENT * 2);
            label.HAlign = "Start";
            label.Tooltip = node.name;
            row.Add(label);

            const shown = new Label();
            shown.Text      = node.value;
            shown.Ellipsize = true;
            shown.HExpand   = true;
            shown.HAlign    = "Start";
            /* An expression that threw is dimmed rather than hidden: the
             * message is the answer, and a watch that cannot be answered in
             * this frame is a fact about the frame. */
            if (node.failed || node.kind === "more") shown.Style = "dim-label";
            row.Add(shown);
        }

        if (!open) return;

        const inside = this.children.get(node.path);
        if (!inside) return;           /* not answered yet, or not here */

        for (const item of inside.items || [])
            this.addValue({ kind: "child", name: item.Name, value: item.Value,
                            path: childPath(node.path, item.Name),
                            owner: node.path, field: item.Name,
                            failed: !!item.Failed, openable: !!item.Children },
                          depth + 1);
        if (inside.more > 0)
            this.addValue({ kind: "more", name: "",
                            value: Locale.Text("… {0} more", inside.more) },
                          depth + 1);
    }

    /*
     * A row activated: a watch comes off the list, a value is changed, a field
     * that has fields opens or closes, and one that has none is watched for a
     * change -- or no longer.
     *
     * The three are told apart by what the row is, which is what makes one
     * gesture do the right thing on a list that holds all of them.
     */
    activated(index) {
        const node = this.rows[index];
        if (!node) return;

        if (node.kind === "watch") {
            this.unwatch(node.name);
            return;
        }
        if (node.kind === "child") {
            if (node.openable) this.toggleOpen(node.path);
            else this.toggleFieldWatch(node);
            return;
        }
        if (node.kind !== "local" || !this.halted) return;

        AskForm.prompt(Locale.Text("Change a value"),
                       Locale.Text("{0} is", node.name), node.value,
                       (text) => this.poke(node.name, text));
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
        return path ? File.Relative(path, this.ide.project) : path;
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

    /*
     * A value for the pointer: the expression under it, asked where the
     * selected frame stands, with the answer handed to `then` instead of the
     * log. **One at a time** -- the pointer is in one place -- so a second peek
     * replaces the first, and an answer for one that was replaced is dropped
     * by its text. The runtime echoes `text` and `frame`, which is all the
     * matching there is.
     */
    peek(text, then) {
        if (!this.halted || !text) return false;
        this.peeking = { text, frame: this.frame, then };
        return this.send({ do: "eval", frame: this.frame, text });
    }

    /* The pointer went: whatever was asked for it is no longer wanted. */
    unpeek() {
        this.peeking = null;
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
        /* Its fields went with it: a removed watch must stop asking the
         * runtime to expand an expression nobody is watching. */
        this.dropOpened(`(${text})`);
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
        this.answers.set(msg.text, { value: msg.value, failed: !!msg.failed,
                                     children: !!msg.children });

        /* The pointer's question, answered to the pointer: never a line of the
         * log, which is the immediate box's conversation and not the hand's. */
        const peek = this.peeking;
        if (peek && peek.text === msg.text && peek.frame === msg.frame) {
            this.peeking = null;
            peek.then(msg);
            if (!this.watches.includes(msg.text)) return;
        }

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

    /*
     * Run to cursor: a breakpoint that takes itself out when it is reached, so
     * the next stop is the line the caret is on -- and a loop below it does not
     * stop again. Only while a program is being debugged: with none there is
     * nothing to run.
     */
    runToCommand(file, line) { return { do: "runto", file, line }; }

    runToCursor() {
        const file = this.ide.activeFile;
        if (!file || !this.ide.Editor) return false;

        if (!this.running) {
            this.ide.log(`${Locale.Text("Run to cursor needs a program being debugged.")}\n`);
            return false;
        }
        return this.send(this.runToCommand(file, this.ide.Editor.Line));
    }

    step(kind) {
        if (!this.halted) return false;

        this.clearHere();
        this.stopped = null;
        this.ide.refresh();
        return this.send({ do: "step", kind });
    }

    pause() { return this.running ? this.send({ do: "pause" }) : false; }
}
