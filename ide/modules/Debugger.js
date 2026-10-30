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
    if (name.length > 0 && isDigits(name)) return `${owner}[${name}]`;
    if (isIdentifier(name)) return `${owner}.${name}`;
    return `${owner}[${JSON.stringify(name)}]`;
}

function isDigits(s) {
    for (const c of s) if (c < "0" || c > "9") return false;
    return true;
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
        /* "file:line" -> the id the protocol knows that breakpoint by. */
        this.ids = new Map();
        /* And what a breakpoint can be told to do: a condition, a message, or
         * neither.  The runtime has carried `when` since conditions were built
         * and `log` beside it now; these are what the IDE sends. */
        this.whens = new Map();
        this.logs  = new Map();
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

        if (on) {
            this.ide.Editor.Unmark(line, BREAK_MARK);
            /* A breakpoint taken away takes its condition and its message with
             * it: both described a stop that no longer exists. */
            this.whens.delete(breakKey(file, line));
            this.logs.delete(breakKey(file, line));
        } else {
            this.ide.Editor.Mark(line, BREAK_MARK, this.markText(file, line));
        }

        this.remember(file);
        if (this.running) this.send(on ? { do: "clear", id: this.idOf(file, line) }
                                       : this.armCommand(file, line));
        return true;
    }

    /*
     * What a breakpoint's gutter mark says under the pointer: what it is, and
     * the two things it can be told to do. A condition and a message have no dot
     * of their own -- one mark kind is one picture -- so the tooltip is where a
     * breakpoint's settings are visible from.
     */
    markText(file, line) {
        const key  = breakKey(file, line);
        const when = this.whens.get(key);
        const log  = this.logs.get(key);
        let   text = Locale.Text("Stop here while debugging");

        if (when) text += ` · ${Locale.Text("only when")}: ${when}`;
        if (log)  text += ` · ${Locale.Text("message")}: ${log}`;
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
    }

    /* A file renamed: the same lines under the new name, and the settings with
     * them -- a condition describes the line and not the path. */
    renamed(oldName, newName) {
        if (this.marks.has(oldName)) {
            this.marks.set(newName, this.marks.get(oldName));
            this.marks.delete(oldName);
        }

        for (const map of [this.whens, this.logs])
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
        for (const map of [this.whens, this.logs]) {
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

    /* Put the marks back on a tab that has just opened. */
    restore(file, editor) {
        const lines = this.marks.get(file);
        if (!lines) return;

        for (const line of lines)
            editor.Mark(line, BREAK_MARK, this.markText(file, line));
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
        if (when) command.when = when;
        if (log)  command.log  = log;
        return command;
    }

    idOf(file, line) {
        return this.ids.get(breakKey(file, line)) || 0;
    }

    /* --- a breakpoint's settings -------------------------------------------- */

    setCondition(file, line, text) { this.setNote(this.whens, file, line, text); }
    setMessage(file, line, text)   { this.setNote(this.logs,  file, line, text); }

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
    }

    /* The breakpoint's tooltip, redrawn where it is on screen. */
    refreshMark(file, line) {
        const ed = this.editorFor(file);
        if (!ed || !this.linesOf(ed).includes(line)) return;

        ed.Unmark(line, BREAK_MARK);
        ed.Mark(line, BREAK_MARK, this.markText(file, line));
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
        if (!this.linesOf(ed).includes(line)) {
            this.ide.log(`${Locale.Text("Put the caret on a breakpoint first.")}\n`);
            return false;
        }

        const key = breakKey(file, line);
        this.ide.breakpointDialog = BreakpointForm.edit(
            `${File.Name(file)}:${line}`,
            this.whens.get(key), this.logs.get(key),
            (condition, message) => {
                this.setCondition(file, line, condition);
                this.setMessage(file, line, message);
            });
        return true;
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
        this.ide.clearLog();
        /* Whatever this run is, the debugger runs it too: `--strict` is a
         * property of the run and not of the button that started it, and a
         * misspelt property is exactly the thing one would want to stop at. */
        const options = ["--debug", ...this.ide.runner.options()];
        const plan    = this.ide.launch.plan();

        this.ide.log(`> bintana ${[...options, this.ide.project,
                                   ...plan.arguments].join(" ")}\n`);
        this.remember(this.ide.activeFile);

        this.stopped = null;
        this.ide.running = true;

        /* The same plan Run uses -- arguments, directory and environment -- with
         * the control channel added. Debugging a project with different
         * arguments than running it would be a second answer to the question
         * *how is this project started*. */
        this.job = Exec([Application.Executable, ...options, this.ide.project,
                         ...plan.arguments],
                        { ...plan.options, Control: (line) => this.heard(line) },
                        (line) => this.ide.log(`${line}\n`),
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
        else if (kind === "log")     this.recorded(msg);
        else if (kind === "locals")  this.showLocals(msg);
        else if (kind === "eval")    this.answered(msg);
        else if (kind === "expand")  this.expanded(msg);
    }

    /*
     * A logpoint's line, in the output pane: where it fired and what the
     * expression came to. A line of the run and not a row of the values panel --
     * the program is still going, and a logpoint inside a loop would fill any
     * list.
     */
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

    /* A triangle clicked: the value opens or closes. */
    toggleOpen(path) {
        if (this.opened.has(path)) {
            this.opened.delete(path);
            this.children.delete(path);
        } else {
            this.opened.add(path);
            if (this.halted) this.send({ do: "expand", frame: this.frame, text: path });
        }
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
            label.Text   = node.argument ? `<b>${Text.Escape(node.name)}</b>`
                                         : Text.Escape(node.name);
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
                            failed: !!item.Failed, openable: !!item.Children },
                          depth + 1);
        if (inside.more > 0)
            this.addValue({ kind: "more", name: "",
                            value: Locale.Text("… {0} more", inside.more) },
                          depth + 1);
    }

    /*
     * A row activated: a watch comes off the list, a value is changed, and a
     * field opens or closes.
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
        this.answers.set(msg.text, { value: msg.value, failed: !!msg.failed,
                                     children: !!msg.children });

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
