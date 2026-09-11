/*
 * The desk, as it was left.
 *
 * Two different memories, and telling them apart is the whole design of this
 * file. **The window is the person's**: how big it is and where the four
 * dividers sit are answers about one screen and one pair of eyes, and they are
 * the same answers in every project. **What is open is the project's**: the tabs
 * and the line each one was on are about the work, and the next project has its
 * own. So one entry for the window, one per project, and nothing that mixes the
 * two.
 *
 * **It is kept in `Settings`, not beside the project.** Delphi writes a `.dsk`
 * next to the `.dpr` and Lazarus a `.lps` next to the `.lpi`, and the first
 * thing every one of their users does is put it in `.gitignore` -- because a
 * project is a thing you hand to somebody else, and where *my* divider is is not
 * part of it. Nothing here ever writes in the project directory. `Recovery`
 * settled the same question the same way for the same reason, and this is the
 * cheaper half of it: what it protects is a minute of rearranging, not work.
 *
 * **And the map is pruned to the recent list**, which is the only bound worth
 * having: the IDE remembers a session for exactly the projects it offers to
 * reopen, so a directory that has fallen off the menu takes its session with it
 * and the file cannot grow without end. `loadRecent` already drops a project
 * that is gone; this follows it rather than keeping a second opinion about which
 * projects exist.
 *
 * **What is not here**: the selection in a designer, the scroll of an editor,
 * the undo history. Those belong to a tab that is being *kept*, which is what
 * makes `TabSet` able to give them back across a switch for free -- across a
 * restart there is no tab to keep them in, and writing them down would be
 * inventing a second, staler notion of what the widget holds. The line is the
 * exception because it is the one of them a person can name: *I was at line
 * 400*.
 */
"use strict";

Namespace("Ide");

/* The window, and the projects. Dotted like `tree.view` and `recovery.seconds`:
 * a settings file is something a person opens, and a prefix is how the entries
 * of one subject stay together in it. */
const WINDOW_KEY   = "session.window";
const PROJECTS_KEY = "session.projects";

/*
 * The dividers, by name, and the list is read in **this** direction on purpose:
 * what the settings file holds is what each divider is worth, never which
 * control to touch. A hand-edited file -- or one left by a future version that
 * had five of them -- can then say nothing that reaches a widget this version
 * did not mean to move.
 */
const DIVIDERS = ["Split", "RightSplit", "WorkArea", "SideSplit"];

/*
 * Under this is not a window, it is a mistake in a file: the IDE's own minimum
 * is larger still and GTK enforces that itself, so this only has to catch a
 * number that could never have come from a resize.
 *
 * `MIN_WINDOW` and not `MIN_SIZE`, which `Designer` already has: a top-level
 * `const` is in the one global lexical scope whatever file it is written in --
 * the same thing that put every one of these classes in `Ide`. The runtime says
 * so out loud (`SyntaxError: redeclaration`), which is the good case.
 */
const MIN_WINDOW = 200;

Ide.Session = class Session {

    constructor(ide) {
        this.ide = ide;

        /*
         * The last size seen while the window was **not** maximised, which is
         * the number that has to be written down.
         *
         * A maximised window reports the screen, so remembering that and
         * restoring it un-maximised gives back a window with no frame left to
         * grab -- the bug every toolkit's users know and nobody can name. The
         * cure is the one GNOME's own applications use: track the size the
         * ordinary way, ignore the frames where the window is maximised, and
         * write the flag down beside it.
         */
        this.size = null;
    }

    /* --- the window ------------------------------------------------------ */

    /* What was written down, or null -- and checked rather than trusted, for
     * the reason `Recovery.seconds` gives: a settings file is a file, and one
     * edited by hand is one of the ways this is written. */
    window() {
        const saved = Settings.Get(WINDOW_KEY, null);
        return saved && typeof saved === "object" && !Array.isArray(saved)
            ? saved : null;
    }

    /*
     * The window, before it is shown.
     *
     * `Form_Open` runs *before* `gtk_window_present`, so a size set here is the
     * size the window is mapped at and never a resize the user watches happen --
     * which is the same moment the `.form`'s own `Width` and `Height` take
     * effect, and why this can simply take their place.
     *
     * **There is no position.** GTK4 has no way to place its own window and
     * Wayland has no way to let it, so a remembered X and Y would be a setting
     * that lies: written every time, read every time, obeyed by nothing. The
     * size is the part the toolkit can still promise.
     */
    restoreWindow() {
        const saved = this.window();
        if (!saved) return false;

        const ide = this.ide;

        if (this.sane(saved.width) && this.sane(saved.height)) {
            /* Before `Maximized` and not instead of it: this is the size
             * un-maximising has to give back. */
            ide.Resize(saved.width, saved.height);
            this.size = { width: saved.width, height: saved.height };
        }
        if (saved.maximized === true) ide.Maximized = true;

        const at = saved.dividers && typeof saved.dividers === "object"
            ? saved.dividers : {};
        for (const name of DIVIDERS) {
            const where = Number(at[name]);
            if (ide[name] && Number.isFinite(where) && where > 0)
                ide[name].Position = Math.round(where);
        }
        return true;
    }

    sane(n) {
        return Number.isFinite(Number(n)) && Number(n) >= MIN_WINDOW;
    }

    /*
     * Every resize, which is what `Form_Resize` is for and all this costs: two
     * numbers, compared and kept. Nothing is written here -- a `Settings.Set`
     * per frame of a drag is a file rewritten a hundred times to record a
     * gesture that is not over.
     */
    noteSize(width, height) {
        if (this.ide.Maximized || this.ide.FullScreen) return;
        if (!this.sane(width) || !this.sane(height)) return;

        this.size = { width, height };
    }

    /* The window and its furniture, written down. */
    saveWindow() {
        const ide = this.ide;
        const dividers = {};

        for (const name of DIVIDERS)
            if (ide[name]) dividers[name] = ide[name].Position;

        const saved = { maximized: !!ide.Maximized, dividers };
        if (this.size) {
            saved.width  = this.size.width;
            saved.height = this.size.height;
        }
        return Settings.Set(WINDOW_KEY, saved);
    }

    /* --- what was open --------------------------------------------------- */

    /* The whole map, checked the same way -- an array or a string where an
     * object should be is an empty memory and not an error to report. */
    projects() {
        const saved = Settings.Get(PROJECTS_KEY, null);
        return saved && typeof saved === "object" && !Array.isArray(saved)
            ? saved : {};
    }

    /* What is remembered for one project, or null. */
    tabsOf(dir) {
        const one = this.projects()[dir];
        return one && Array.isArray(one.files) && one.files.length ? one : null;
    }

    /*
     * The open tabs of the project that is open now.
     *
     * The line comes from the tab's **own editor**, which is where it is: every
     * code tab holds its editor for as long as it is open, so this is the live
     * caret of all of them and not only of the one on screen. A design tab has
     * no line and is written down without one.
     */
    saveTabs() {
        const ide = this.ide;
        if (!ide.project) return false;

        const files = [];
        for (const name of ide.tabs.tabOrder) {
            const state = ide.tabs.openTabs.get(name);
            const line  = state && state.editor ? state.editor.Line : 0;

            files.push(line > 1 ? { name, line } : { name });
        }

        const all = this.projects();

        /* Nothing open is nothing to restore, so the entry goes rather than
         * being kept as an empty one: the map holds sessions, and a session with
         * no tabs in it is not one. */
        if (files.length) all[ide.project] = { files, active: ide.activeFile || "" };
        else delete all[ide.project];

        return Settings.Set(PROJECTS_KEY, this.pruned(all));
    }

    /* Only the projects the recent menu still offers. See the head of this
     * file: the recent list is what decides which projects the IDE remembers,
     * and one list deciding it is one list to be wrong. */
    pruned(all) {
        const keep = new Set(this.ide.recent);
        const out  = {};

        for (const dir in all)
            if (keep.has(dir)) out[dir] = all[dir];
        return out;
    }

    /*
     * ...and back, when that project opens again. What comes back is how many
     * tabs it reopened, which is what a test reads and what the log says.
     *
     * A file that is gone since is skipped **silently**: `TabSet.open` puts up a
     * dialog for a file that is not there, which is right when a person asked
     * for it by name and wrong six times over when it is a session reopening
     * what a `git checkout` has taken away. Checking first is what keeps the two
     * answers apart.
     *
     * Nothing here is ever dirty. What was unsaved is `Recovery`'s, it is
     * offered right after this, and it lands in these same tabs -- which is why
     * this runs first: the recovered text goes into a tab that is already open
     * and already showing the right file.
     */
    restoreTabs(dir) {
        const saved = this.tabsOf(dir);
        if (!saved) return 0;

        const tabs = this.ide.tabs;
        let done = 0;

        for (const one of saved.files) {
            const name = one && typeof one.name === "string" ? one.name : "";
            if (!name || !File.Exists(File.Join(dir, name))) continue;

            /*
             * One file that cannot be opened must not take the project with it.
             * A `.form` that is no longer valid JSON throws where it is read,
             * and before there was a session that could only happen to somebody
             * who had just clicked on it; now it happens while a project opens,
             * with the tree already built and the recovery offer still to come.
             * Said once in the log and stepped over -- the same bargain
             * `Settings` itself makes, where a file that cannot be read counts
             * as empty rather than stopping the program from starting.
             */
            try {
                if (!tabs.open(name)) continue;

                const state = tabs.openTabs.get(name);
                const line  = Number(one.line);
                if (state && state.editor && Number.isFinite(line) && line > 1)
                    state.editor.GotoLine(line);

                done++;
            } catch (e) {
                this.ide.log(`Session: ${name}: ${e.message}\n`);
            }
        }

        /* Last, so the tab that was in front is in front however many opened
         * after it -- and only if it is one of the ones that made it back. */
        if (saved.active && tabs.openTabs.has(saved.active))
            tabs.switchTo(saved.active);

        return done;
    }

    /*
     * Both halves, at the moments a session actually ends: quitting, and opening
     * another project. Not on a timer -- what is at stake is the furniture, and
     * `Recovery` is the net under the work.
     */
    save() {
        this.saveTabs();
        this.saveWindow();
    }
};
