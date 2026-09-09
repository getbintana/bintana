/*
 * Running the project, and reading what it printed.
 *
 * The child gets a real pty (`Terminal.Run`), so nothing has to be captured or
 * forwarded and its colours work.  What this class adds is the other direction:
 * a traceback names a place, and a place is somewhere to go.
 *
 * `MainForm` keeps `log` and the two console handlers -- a control's events are
 * looked up on the form, and `log` is what the whole IDE writes with -- and hands
 * the work here.
 */
"use strict";

Namespace("Ide");

Ide.Runner = class Runner {

    constructor(ide) {
        this.ide = ide;
    }

    start() {
        const ide = this.ide;
        if (!ide.project) return;

        /* A .form and its .js travel together: running with either unsaved would
         * execute something other than what is on screen. */
        ide.saveAllDirty();

        ide.Console.Clear();
        ide.log(`> bintana ${ide.project}\n`);
        ide.running = true;
        ide.refresh();

        ide.Console.Run([Application.Executable, ide.project], ide.project);
    }

    /* The child is over. A run that ended badly said where, so go there rather
     * than making the user read the traceback and find the file by hand. */
    finished(code) {
        const ide = this.ide;

        ide.log(code === 0 ? "\n[finished ok]\n"
                           : `\n[finished with code ${code}]\n`);
        ide.running = false;
        ide.refresh();

        if (code !== 0) this.findErrorLine();
    }

    /*
     * A place clicked in the console.  The pattern that made it clickable is
     * `SOURCE_LINK`, set on the terminal in `Form_Open` -- one string for the two
     * who need it, since a pattern that highlights what the parser cannot read is
     * a link that does nothing.
     */
    clicked(text) {
        const at = /^(.*):(\d+)(?::\d+)?$/.exec(text);
        if (at) this.open(at[1], Number(at[2]));
    }

    /*
     * Opens a file the console named, at a line.  Only files of this project: a
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
            const root = `${ide.project}/`;
            if (!path.startsWith(root)) return false;
            name = path.slice(root.length);
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
     * runtime's own.  `start` clears the console, so anything found here is from
     * this run.
     */
    errorLocation(text) {
        if (!text) return null;

        /* The last error and not the first: a program can survive several, and
         * the one worth going to is the one that just happened. */
        const said  = text.lastIndexOf("Bintana error:");
        const where = said >= 0 ? text.slice(said) : text;

        const scan = new RegExp(`(${SOURCE_LINK})`, "g");
        let m;
        while ((m = scan.exec(where)) !== null) {
            const at = /^(.*):(\d+)$/.exec(m[1]);
            if (!at) continue;
            const path = at[1];
            /* Ours, or the runtime's? Only the first question has an answer the
             * IDE can act on. */
            if (path.startsWith("/") &&
                !path.startsWith(`${this.ide.project}/`)) continue;
            return { path, line: Number(at[2]) };
        }
        return null;
    }

    /*
     * VTE digests what it is fed on its own time, so the exit signal can arrive
     * before the last lines of the traceback are on screen: looking once would
     * work most of the time, which is the worst kind of working.  A few turns of
     * the main loop is all it takes, and giving up quietly is the right answer
     * when the program died of something that named no line at all.
     */
    findErrorLine(tries = 10) {
        const where = this.errorLocation(this.ide.Console.Text);
        if (where) {
            this.open(where.path, where.line);
            return;
        }
        if (tries > 0) Timer.After(30, () => this.findErrorLine(tries - 1));
    }
};
