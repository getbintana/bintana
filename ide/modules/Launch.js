/*
 * The three places a launch configuration is made of, and the rule that joins
 * them.
 *
 *     Settings, global          a *suggestion*: what a new configuration
 *                               should start with. Read when one is made.
 *     project.json              the configurations themselves, named and
 *                               versioned: arguments, directory, environment.
 *     Settings, per project     which one is chosen right now.
 *
 * **It is a template and not a cascade**, which is the decision the whole shape
 * rests on: the suggestion is *copied* when a configuration is created and is
 * the configuration's own from then on. Changing it later changes nothing that
 * exists. `Ide.LaunchConfig` has the argument and the prior art; the
 * consequence here is that nothing has to resolve anything at read time, so
 * there is no layer to walk and no value that means *ask my parent*.
 *
 * Three things in three places, and none of them means two things:
 *
 * - **the project** says what it needs to start -- a data directory, a port, a
 *   sample database. That is a fact about the project, so it is versioned and
 *   the whole team gets it.
 * - **you** say which of them you are running. Two people on one project may
 *   well be running different ones, so that is personal and not versioned.
 * - **the tick in the menu** says *run it strictly anyway*, on top of whichever
 *   is chosen. It only ever adds strictness and never takes it away: a
 *   development switch that could quietly make checking *looser* than the
 *   project asked for would be a worse thing to have than not to have.
 *
 * Which is why the choice is not in `session.projects` with the open tabs,
 * although that is also personal and per project: that entry is **deleted when
 * a project has nothing open** (see `Ide.Session`), and a choice has to outlive
 * closing the last tab.
 */
"use strict";

Namespace("Ide");

/* What a new configuration starts with, and which one is chosen where. */
const SUGGESTION_KEY = "launch.suggestion";
const CHOSEN_KEY     = "launch.chosen";

Ide.Launch = class Launch {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    /* --- the project's own ---------------------------------------------- */

    /*
     * Every configuration this project declares, as records.
     *
     * Read through the manifest rather than kept, because `project.json` is
     * edited by this window, by the project dialog, and by whoever opens it in
     * an editor -- a copy here would be a fourth opinion about a file three
     * things already write.
     *
     * **Which puts a file read on the typing path**, since `show()` is called
     * from `refresh()` and `Editor_Cursor` refreshes on every caret move. That
     * is worth knowing and it is not worth a cache: measured at **0.31 ms** a
     * read -- `File.LoadJson` plus building the records -- against a 16 ms
     * frame. A cache would have to be invalidated by the mtime of a file this
     * window writes itself, and buying 0.3 ms with an invalidation rule is the
     * wrong trade until something measures otherwise.
     */
    get all() {
        const config = this.ide.manifest.read();
        return config ? config.Launch : [];
    }

    /* One by name, or null. */
    named(name) {
        return this.all.find((one) => one.Name === name) || null;
    }

    /*
     * The one that is running when Run is pressed: what you chose, or the first
     * one, or nothing.
     *
     * **Nothing is an ordinary answer and not a fault.** A project that needs no
     * arguments declares no configurations, and Run then does exactly what it
     * always did -- which is what keeps this from being a thing every project
     * has to learn before it can be started.
     */
    get chosen() {
        const all = this.all;
        if (!all.length) return null;

        return this.named(this.chosenName()) || all[0];
    }

    /* --- which one, which is yours and not the project's ----------------- */

    chosenName(dir = this.ide.project) {
        const all = Settings.Get(CHOSEN_KEY, null);
        return all && typeof all === "object" && !Array.isArray(all)
            ? String(all[dir] || "") : "";
    }

    choose(name) {
        const all = Settings.Get(CHOSEN_KEY, null);
        const map = all && typeof all === "object" && !Array.isArray(all) ? all : {};

        /* The first one is what an unchosen project runs, so choosing it is the
         * same as choosing nothing -- and writing it down would be a second
         * spelling of one state. */
        if (name) map[this.ide.project] = name;
        else delete map[this.ide.project];

        return Settings.Set(CHOSEN_KEY, map);
    }

    /* --- the suggestion, which is only ever read when one is made -------- */

    /*
     * What a new configuration starts with. A plain object and not a record: it
     * is two booleans, and a record would be a shape to keep in step with
     * `Ide.LaunchConfig`'s own for no gain.
     */
    suggestion() {
        const said = Settings.Get(SUGGESTION_KEY, null);
        const bag  = said && typeof said === "object" ? said : {};

        return { Strict: bag.Strict === true, StopOnThrow: bag.StopOnThrow === true };
    }

    suggest(what) {
        return Settings.Set(SUGGESTION_KEY, {
            Strict:      what.Strict === true,
            StopOnThrow: what.StopOnThrow === true,
        });
    }

    /*
     * A new configuration, with the suggestion copied in.
     *
     * **This is the only place the suggestion is read**, which is what makes the
     * whole thing a template rather than a cascade -- and what lets every field
     * of `Ide.LaunchConfig` be an ordinary one, since none of them ever has to
     * mean *nothing said*.
     */
    make(name) {
        const one   = new Ide.LaunchConfig();
        const seed  = this.suggestion();

        one.Name        = name;
        one.Strict      = seed.Strict;
        one.StopOnThrow = seed.StopOnThrow;
        return one;
    }

    /* --- writing the list back ------------------------------------------- */

    /*
     * The whole list at once, because that is what the dialog edits: it works on
     * a copy and hands it back, the way every dialog here does, so a Cancel
     * costs nothing and a save is one write.
     */
    save(list) {
        return this.ide.manifest.update((config) => {
            config.Launch = list;
        });
    }

    /*
     * The dialog, which edits a copy and hands back both halves: the list, and
     * the two ticks as the suggestion for whatever is made next.
     *
     * Saving the suggestion on every save is what makes the boxes mean the
     * second thing without a second window -- *this is how I run things*, said
     * once. And it is the only write to it, so the template stays a template:
     * nothing reads it except `make`.
     */
    edit() {
        if (!this.ide.project) return;

        LaunchForm.edit(this.all, this.suggestion(), (list, suggestion) => {
            this.save(list);
            this.suggest(suggestion);

            /* A configuration that was renamed or removed is one nobody chose
             * any more: `chosen` falls back to the first, and leaving the old
             * name written down would make a later configuration of that name
             * silently become the choice. */
            if (!this.named(this.chosenName())) this.choose("");
            this.ide.refresh();
        });
    }

    /* --- the menu ---------------------------------------------------------- */

    /*
     * The chooser, which is a **radio** dynamic item: a list of names with the
     * chosen one marked. A project that declares none says so rather than
     * offering an empty menu, the way the recent list does.
     *
     * `Value` is assigned after `Items`, because assigning the entries is what
     * builds them and an index into a list that is not there yet marks nothing.
     * Out of range is how *none of them* is said, which is the state a project
     * with no configurations is in.
     */
    show() {
        const all   = this.all;
        const empty = all.length === 0;
        const item  = this.ide.MnuLaunch;

        item.Items   = empty ? [Locale.Text("(none declared)")]
                             : all.map((one) => one.Name);
        item.Enabled = !empty;

        const chosen = this.chosen;
        item.Value   = chosen ? all.findIndex((one) => one.Name === chosen.Name) : -1;

        this.ide.MnuLaunchEdit.Enabled = this.ide.project !== "";
    }

    /* --- what a run is made of -------------------------------------------- */

    /*
     * The arguments after the project directory, the options `Exec` takes, and
     * whether this run is strict -- the three questions `Ide.Runner` and
     * `Ide.Debugger` ask, answered in one place so the two cannot drift.
     *
     * With no configuration this is what Run always did: the project's own
     * directory and nothing else.
     */
    plan() {
        const one = this.chosen;
        const dir = this.ide.project;

        if (!one)
            return { arguments: [], options: { Directory: dir },
                     strict: false, stopOnThrow: false };

        const options = { Directory: one.Directory || dir };
        const vars    = one.Variables;

        if (Dictionary.Count(vars)) options.Environment = vars;

        return {
            arguments:   one.Arguments.slice(),
            options,
            strict:      one.Strict,
            stopOnThrow: one.StopOnThrow,
        };
    }
};
