/*
 * What the IDE would lose if it never got to ask.
 *
 * Every editor of this family has this and it is always the same shape, because
 * there is only one shape that is safe: **the file on disk is never written
 * behind the user's back.** An autosave that saved *in place* would take away the
 * one thing closing without saving is for -- "I have made a mess of this, let me
 * start from the file" -- and it would do it silently, which is worse than losing
 * the session it means to protect. So what is written is a copy, aside, in the
 * IDE's own configuration directory; the project directory is untouched, and
 * nothing here can ever produce a diff the user did not ask for. VS Code's hot
 * exit, LibreOffice's AutoRecovery and vim's swap files are all this and so is
 * this.
 *
 * The snapshot is only ever read once, when a project opens, and only when one
 * was left behind -- which happens when the IDE went away without being asked: a
 * crash, a kill, a power cut, an X session that ended. Every ordinary way out
 * goes through `MainForm.quit()`, which throws the snapshot away first, because
 * by then the question has been put and answered: *quit without saving* is a
 * decision, and offering to undo it next time would be second-guessing the user.
 *
 * What is *not* here, deliberately: versions, a history, a per-keystroke journal.
 * One snapshot per project, replaced in place, holding what the dirty tabs hold
 * right now. Anything more is a feature about the past rather than a net under
 * the present, and it has to be designed rather than accumulated.
 */
"use strict";

Namespace("Ide");

/*
 * How often, and it is a compromise with one number on each side: a tick is a
 * `JSON.stringify` of the dirty tabs plus, when something really changed, one
 * file written -- and what it buys is the ceiling on what a crash costs.
 * Thirty seconds is gedit's order of magnitude and a fraction of LibreOffice's
 * ten minutes, which is a default from the age of spinning disks.
 *
 * **And it is the user's**, kept in `Settings` like the external translation
 * editor -- the IDE's other preference about how it behaves rather than about a
 * project. Whoever works on a laptop that never crashes wants it slower, and
 * whoever has just lost an afternoon wants it faster; neither of them should
 * have to be told that thirty is the right number.
 */
const SNAP_KEY     = "recovery.seconds";
const SNAP_DEFAULT = 30;

/*
 * `0` is off, and it is a real answer rather than a value to refuse: a snapshot
 * is a copy of somebody's source in a directory they did not choose, and that is
 * a thing one is allowed to say no to.
 *
 * The floor under everything else is five seconds. Below that the tick stops
 * being a net and becomes a background process writing a file while a person
 * types -- and the thing being protected against is a crash, which does not
 * arrive on a schedule fine enough for one second to matter.
 */
const SNAP_MIN = 5;
const SNAP_OFF = 0;

/* Beside the settings and not among them: `Settings` is small values a person
 * might want to read, and this is a copy of somebody's source file. */
const FOLDER = "recovery";

Ide.Recovery = class Recovery {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide   = ide;
        this.timer = null;
        /* What the last write held, so a tick over a file nobody has touched
         * since costs a `stringify` and no disk at all -- which is most ticks:
         * a person types in bursts and thinks in between. */
        this.last  = "";
    }

    get folder() { return File.Join(Application.ConfigDirectory, FOLDER); }

    /*
     * The configured interval in seconds: `0` for off, and anything else no
     * faster than the floor. A setting file edited by hand is one of the ways
     * this is written, so what comes back is checked rather than trusted -- the
     * same reason `loadRecent` filters what it reads.
     */
    seconds() {
        const n = Number(Settings.Get(SNAP_KEY, SNAP_DEFAULT));

        if (!Number.isFinite(n) || n < 0) return SNAP_DEFAULT;
        if (n === SNAP_OFF)               return SNAP_OFF;
        return Math.max(SNAP_MIN, Math.round(n));
    }

    /*
     * One file per project, named after a digest of its path.
     *
     * Not after the project's name, which two directories can share -- a
     * `hello` copied somewhere to try something out is the ordinary case, and
     * it would recover the wrong one. Not the path itself either: a path is not
     * a file name, and escaping one into a file name is a rule this tree would
     * then own forever.
     */
    fileFor(project) {
        return File.Join(this.folder, `${Hash.Sha256(project).slice(0, 16)}.json`);
    }

    /*
     * Starts the tick, or restarts it on the interval the settings now hold --
     * which is the same call, because "every N seconds" is one fact and there is
     * no state in a timer worth keeping across a change of it.
     */
    start() {
        const every = this.seconds();

        if (this.timer) this.timer.Stop();
        this.timer = every === SNAP_OFF
            ? null
            : Timer.Every(every * 1000, () => this.snapshot());
        return this;
    }

    /*
     * Asks how often, and remembers it.
     *
     * A prompt and not a preferences window, which the IDE does not have and
     * should not grow for one number -- the external translation editor is the
     * precedent, and it is the same shape: ask, validate, `Settings.Set`, act on
     * it now rather than at the next start.
     *
     * Turning it off **leaves any snapshot behind**: it is what the last tick
     * saw, the user may still want it back, and deleting somebody's only copy of
     * their work because they changed a setting would be the one unforgivable
     * thing this module could do.
     */
    ask() {
        const now = this.seconds();

        /* Handed back like `confirmQuit`'s question and `offer`'s: nothing in
         * this runtime blocks, so the dialog *is* the answer as far as the
         * caller is concerned, and it is what a test drives. */
        return AskForm.prompt(
            Locale.Text("Autosave"),
            /* One literal, because the extractor reads the source: a message
             * built by adding two strings together is a message no catalogue
             * ever hears about. */
            Locale.Text("Copy unsaved tabs aside every how many seconds? 0 turns it off; {0} is the least.",
                        SNAP_MIN),
            String(now),
            (value) => {
                const n = Number(String(value).trim());

                if (!Number.isFinite(n) || n < 0) {
                    Message.Error("{0} is not a number of seconds.", value);
                    return;
                }
                Settings.Set(SNAP_KEY, n === SNAP_OFF
                                       ? SNAP_OFF : Math.max(SNAP_MIN, Math.round(n)));
                this.start();
                this.ide.log(this.seconds()
                    ? `Autosave: every ${this.seconds()}s\n`
                    : "Autosave: off\n");
            });
    }

    /*
     * The dirty tabs, written aside.
     *
     * With nothing dirty there is nothing to recover -- the work is in the
     * project, which is the only place it was ever going to be read from -- so
     * the snapshot goes rather than being left to offer a file that is already
     * saved.
     */
    snapshot() {
        const ide = this.ide;
        if (!ide.project) return false;

        const names = ide.tabs.dirtyNames();
        if (!names.length) {
            this.forget();
            return false;
        }

        const files = [];
        for (const name of names) {
            const one = ide.tabs.contentOf(name);
            if (one) files.push(one);
        }

        /* The signature is the files and not the whole snapshot: the timestamp
         * changes on every tick and would make every tick a write. */
        const signature = JSON.stringify(files);
        if (signature === this.last) return false;

        try {
            Directory.Make(this.folder);
            File.SaveJson(this.fileFor(ide.project),
                          { project: ide.project,
                            when:    `${Day.Today} ${Time.Now}`,
                            files });
        } catch (e) {
            /* A snapshot that cannot be written is a net that is not there, and
             * that is all it is: the IDE goes on. Said once, in the log, rather
             * than in a dialog every thirty seconds. */
            ide.log(`Recovery: ${e.message}\n`);
            return false;
        }

        this.last = signature;
        return true;
    }

    /* The user has answered, one way or the other. */
    forget() {
        this.last = "";
        if (!this.ide.project) return;

        const path = this.fileFor(this.ide.project);
        try {
            if (File.Exists(path)) File.Delete(path);
        } catch (e) {
            this.ide.log(`Recovery: ${e.message}\n`);
        }
    }

    /* What was left behind for this project, or null. A file that is half
     * written -- the crash landed in the middle of one -- is not an error to
     * report: it is a net that did not hold, and the answer is the same as no
     * file at all. */
    pending(project) {
        const path = this.fileFor(project);
        if (!File.Exists(path)) return null;

        try {
            const shot = File.LoadJson(path);
            return shot && Array.isArray(shot.files) && shot.files.length
                ? shot : null;
        } catch (e) {
            return null;
        }
    }

    /*
     * Asked once, when a project opens, and never on a timer: an offer that
     * arrives while somebody is typing is an interruption, and there is nothing
     * new to say after the first time.
     *
     * Answering is what the dialog does -- nothing in this runtime blocks -- so
     * this hands back the question it put, which is what a test drives and what
     * `openProject` ignores.
     */
    offer(project) {
        const shot = this.pending(project);
        if (!shot) return null;

        const list = shot.files.map((f) => f.name).join(", ");
        const when = shot.when ? `\n\n${shot.when}` : "";

        return ConfirmForm.ask(
            Locale.Text("Recover"),
            Locale.Plural("{1} was not saved when the IDE last closed.",
                          "{0} files were not saved when the IDE last closed:\n{1}",
                          shot.files.length, list) + when,
            Locale.Text("Recover"),
            () => this.restore(shot),
            { Text: Locale.Text("Discard"), Run: () => this.forget() });
    }

    /*
     * The snapshot back into tabs, each one dirty -- which is the honest state:
     * what is on screen is not what is in the file, and the tab says so with the
     * asterisk it would have had. Nothing is written to the project here either;
     * recovering gives the work back, and saving it is still the user's.
     */
    restore(shot) {
        let done = 0;
        for (const one of shot.files)
            if (this.ide.tabs.restore(one)) done++;

        this.ide.log(`Recovered ${done} of ${shot.files.length}\n`);

        /* Answered, so the file goes -- and the tabs are dirty again, so the
         * next tick writes a fresh one. The net is back up within a tick of the
         * recovery, which is the same guarantee it gives the rest of the time. */
        this.forget();
        this.ide.refresh();
        return done;
    }
};
