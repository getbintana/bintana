/*
 * `project.json`, and everything that writes to it.
 *
 * One funnel -- `update` -- reads the file as a [`ProjectFile`](ProjectFile.js),
 * hands it to a mutator and writes it back.  So what the file may say is the
 * record's business, not every caller's, and a mutator cannot write a manifest the
 * runtime would refuse to open.
 *
 * `MainForm` keeps the handlers that reach in here and the two or three methods
 * `tests/ide` drives by name; the rest is this class's.
 */
"use strict";

Namespace("Ide");

Ide.Manifest = class Manifest {

    constructor(ide) {
        this.ide = ide;
    }

    get path() { return File.Join(this.ide.project, "project.json"); }

    /*
     * The mutator returning false means nothing changed, so nothing is written: an
     * untouched file keeps its mtime and its formatting.
     *
     * A file that was already broken is read anyway and reported (see `report`) --
     * refusing to load it would leave the one thing that can fix it unable to open
     * it.
     */
    update(mutate) {
        if (!this.ide.project || !File.Exists(this.path)) return null;

        let config;
        try {
            config = Ide.ProjectFile.Load(File.LoadJson(this.path));
        } catch (e) {
            Message.Warning("project.json could not be read:\n{0}", e.message);
            return null;
        }

        try {
            if (mutate(config) === false) return config;   // unchanged
        } catch (e) {
            /* A refused assignment says what was wrong with the value; saying it
             * beats writing a manifest that would not open. */
            Message.Error("project.json was left alone:\n{0}", e.message);
            return config;
        }

        File.SaveJson(this.path, config);
        return config;
    }

    /* The manifest as it stands, without touching it. */
    read() { return this.update(() => false); }

    /*
     * A project's list of sources only decides load order when it has one; a
     * project without it is loaded by directory, and writing a list where there
     * was none would freeze an order nobody asked for.  So all four of these leave
     * a listless project alone -- which `Lists` is the name for.
     *
     * They assign rather than push: the setter is what checks the list, and a
     * `push` into the array it handed over goes around it.
     */
    registerSource(fileName) {
        this.update((config) => {
            if (!config.Lists) return false;
            if (config.Sources.includes(fileName)) return false;
            config.Sources = config.Sources.concat(fileName);
        });
    }

    renameSource(oldFile, newFile) {
        this.update((config) => {
            if (!config.Lists) return false;
            if (!config.Sources.includes(oldFile)) return false;
            config.Sources = config.Sources.map((f) => (f === oldFile ? newFile : f));
        });
    }

    dropSource(fileName) {
        this.update((config) => {
            if (!config.Lists) return false;
            if (!config.Sources.includes(fileName)) return false;
            config.Sources = config.Sources.filter((f) => f !== fileName);
        });
    }

    renameStartup(oldClass, newClass) {
        this.update((config) => {
            if (config.Startup !== oldClass) return false;
            config.Startup = newClass;
        });
    }

    /* Deleting the startup form leaves the project unable to run. */
    warnMissingStartup() {
        const config = this.read();
        if (!config || !config.Startup) return;

        if (!this.ide.classExists(config.Startup)) {
            Message.Warning("The project starts at {0}, which no longer exists. It will not be able to run.", config.Startup);
        }
    }

    /*
     * What is wrong with the manifest, said once when the project opens.
     *
     * It used to be found a piece at a time by whoever tripped over it -- a
     * mutator checking `Array.isArray(config.sources)`, a run that failed for a
     * reason the console did not explain.  The record answers all of it at once,
     * and the console is where it goes: these are things to fix, not a dialog to
     * dismiss before working.
     */
    report() {
        const config = this.read();
        if (!config) return;

        /*
         * **Both halves, and said so.** `Problems` is the report of the *load*
         * -- what the file said that could not be taken -- and `Validate()` is
         * what is wrong with the manifest as it now stands, which is where
         * `ProjectFile`'s own rule lives: a project that declares neither
         * `startup` nor `main` has nothing wrong with any single field and is
         * still unopenable. Asking only the first would stop reporting exactly
         * that.
         */
        for (const problem of config.Problems.concat(config.Validate())) {
            this.ide.log(`project.json: ${problem}\n`);
        }
    }

    /* --- the project's own settings ----------------------------------------
     *
     * The dialog checks nothing itself: it assigns to the record and reports
     * whichever setter refused.  Add a field to `ProjectFile` and the dialog
     * validates it for free.
     */
    editSettings() {
        const ide = this.ide;
        if (!ide.project) return;

        const config = this.read();
        if (!config) {
            Message.Warning("{0} has no project.json to edit.", File.Name(ide.project));
            return;
        }

        /* Kept while it is open, for the same reason the menu editor is: it is
         * what lets a test drive it. */
        ide.projectEditor = ProjectForm.edit(
            config, ide.classNames(), this.loadOrder(),
            (edited) => this.apply(edited));
    }

    /*
     * The order the runtime would load a project that declares none: every `.js`
     * under it, sorted by path.  The same rule `collect_sources` follows, so
     * writing it down changes nothing about what happens today -- which is the
     * whole point of being able to.
     */
    loadOrder() {
        return this.ide.files
                   .filter((f) => File.Extension(f).toLowerCase() === "js").sort();
    }

    apply(edited) {
        this.update((config) => {
            /*
             * **Every field the record declares, asked of the record.** This used
             * to name three of them, which quietly made the claim in
             * `ProjectForm`'s own header false: adding a field to `ProjectFile`
             * was *not* all it took. `Version` is how that showed -- declared on
             * the record, shown by the dialog, refused by the record when too
             * long, and then dropped on the way to the file by this line, which
             * knew about three fields and not four.
             *
             * A record discovers its own properties exactly as a widget does
             * (`PropertyNames`), and a getter with no setter is left out on its
             * own -- so `Lists` and `Problems` never appear here.
             */
            for (const key of edited.PropertyNames()) {
                if (key === "Sources") continue;      /* the rule below */
                config[key] = edited[key];
            }

            /* Only when the project decides its own order.  Assigning the list of
             * a project that had none is exactly the thing that freezes an order
             * nobody asked for -- and the dialog's *Decide* is where that choice
             * is made on purpose. */
            if (edited.Lists) config.Sources = edited.Sources;
        });

        /* The tree marks the startup form, and the name may have moved. */
        this.ide.listFiles();
        this.ide.log("project.json saved\n");
    }

    /*
     * Which form the project starts at.
     *
     * It acts on the **open** file and not on the row under the pointer, which is
     * what the File menu's own Rename and Delete do -- and not for consistency's
     * sake alone: a right click does not move a `TreeView`'s selection, so an item
     * that aimed at the row it was opened over would act on a different one.  What
     * a left click does is open, so selecting a form and then asking is the
     * gesture; the menu speaks about the file one is looking at.
     *
     * The name written down is the qualified one, because that is what the runtime
     * looks a class up by: a form in a namespace whose bare name was written would
     * not be found.
     */
    setStartupForm() {
        const ide  = this.ide;
        const form = ide.formOf(ide.activeFile);
        if (!form) return;

        const name = ide.qualifiedName(form);
        let changed = false;

        this.update((config) => {
            if (config.Startup === name) return false;
            config.Startup = name;
            /* A project starts at a form or at a function, never both: choosing
             * a form here is choosing *against* whatever `main` said, and
             * leaving both would write a manifest that looks like it draws and
             * does not -- the runtime calls `main` and never opens the form. */
            config.Main = "";
            changed = true;
        });
        if (!changed) return;

        ide.log(`Starts at ${name}\n`);
        ide.listFiles();                /* the marker moved */
    }
};
