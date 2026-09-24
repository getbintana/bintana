/*
 * project.json, as a shape rather than as a bag of keys.
 *
 * Every mutation of a project's manifest went through `withConfig`, which read
 * JSON, handed a plain object to a mutator and wrote it back -- so what the file
 * is *allowed* to say lived in the mutators, one `Array.isArray(config.sources)`
 * at a time, and what was wrong with a broken one was only ever discovered by
 * the thing that tripped over it.
 *
 * Declared here once, the same way a control declares its properties: the names,
 * what each one accepts, and which are not optional.  Reading a file reports
 * everything wrong with it at once instead of stopping at the first, and writing
 * one goes through the setters, so the IDE cannot save a manifest that a project
 * would refuse to open.
 *
 * `Naming = "lower"` because the file spells its keys in lower case and Bintana
 * spells properties in PascalCase.  That is a rule about the file, said once,
 * rather than an `as:` on every field.
 */
"use strict";

Namespace("Ide");

/*
 * What a project starts at, in the two words the dialogs show.
 *
 * Here and not in either dialog, because both ask the same question and a
 * project's sources share one scope: two files declaring `const KIND_FORM` at
 * the top level is a redeclaration, and the runtime says so.
 */
Ide.Kind = { Form: "a form", Function: "a function" };

Ide.ProjectFile = class ProjectFile extends Record {
    static Naming = "lower";

    static Fields = {
        /* A project has a name and something to start.  *Something*, and that is
         * why neither of the next two is required on its own: a project starts
         * at a form (`startup`) or at a function (`main`), and `Validate` below
         * is where "one of them" is said -- a `Field` can only speak about
         * itself. */
        Name:    Field.Text({ required: true, max: 120 }),
        Startup: Field.Text({ max: 120 }),
        Main:    Field.Text({ max: 120 }),

        /*
         * The application's identity, in reverse DNS -- `io.github.you.App`.
         *
         * It is the one name the whole chain shares: the runtime hands it to
         * `GtkApplication` and to the program name, so it is the window's own
         * class; the project's `<id>.metainfo.xml` declares it; and a package
         * installs under it. A window that is classed by something else is one
         * a dock shows with a generic icon, which is why the runtime refuses a
         * bad one instead of ignoring it.
         *
         * Optional: a project without one is an ordinary project, classed by
         * the program's name as it always was, and it simply cannot be
         * packaged. Not a `Field` check because a `Field` speaks about one
         * value and the rule is the platform's -- `Validate` reports it and
         * `idValid` is the rule, written once for this side.
         */
        Id:      Field.Text({ max: 255 }),

        /*
         * Load order, and only needed when one class extends another of the same
         * project.  Empty is legitimate and means "every .js under the project,
         * sorted by path" -- so it is not required, and an empty list is not a
         * complaint.
         */
        Sources: Field.List(Field.Text()),

        /*
         * The libraries this project uses, by name -- resolved by the runtime
         * over six places (see `docs/formats.md`), which is why the IDE asks
         * `Application.LibraryPath` rather than looking for them itself: two
         * copies of a search path drift, and the one that drifts is the one
         * nobody runs from a shell.
         *
         * Not required, and an empty list is the ordinary state: a project that
         * uses nothing shared is most projects.
         */
        Uses: Field.List(Field.Text()),

        /*
         * What the project calls its own release. Free text and not a checked
         * shape: "1.0", "2026.08", "3.1-rc2" and a bare git hash are all things
         * projects really put here, and a rule that only admitted `x.y.z` would
         * be this IDE deciding for them. Optional -- a project without a version
         * is an ordinary project, and the runtime answers "" for it.
         */
        Version: Field.Text({ max: 40 }),

        Description: Field.Text({ max: 400 }),

        /*
         * How this project is run: named configurations, each with the
         * arguments, the directory and the environment it needs
         * (`Ide.LaunchConfig`). Versioned on purpose -- *what this project needs
         * to start* is a fact about the project and not about whoever opened it,
         * so it belongs beside `sources` and `uses` rather than in anybody's
         * settings.
         *
         * Not required, and empty is the ordinary state: a project that needs no
         * arguments is most projects, and Run does for it exactly what it always
         * did.
         *
         * **Which one is chosen is not here.** That is personal and per project
         * -- two people on one project may well be running different ones -- so
         * it lives in `Settings` with the rest of what this window remembers
         * about itself.
         */
        Launch: Field.List(Ide.LaunchConfig),
    };

    /*
     * The rule no single field can state: **one or the other**.
     *
     * A project with neither loads and cannot run, which is the state worth
     * reporting; a project with both is worse, because it looks like it draws
     * and does not -- the runtime calls `main` and never opens the form. Both go
     * to the console with everything else that is wrong with the manifest, so a
     * project is still opened and can still be fixed.
     */
    Validate() {
        const out = super.Validate();

        if (!this.Startup && !this.Main)
            out.push("nothing to start: declare a startup form or a main function");
        else if (this.Startup && this.Main)
            out.push(`declares both startup (${this.Startup}) and main (${this.Main}); ` +
                     "the runtime calls main and never opens the form");

        if (this.Id && !ProjectFile.idValid(this.Id))
            out.push(`"${this.Id}" is not an application id -- a reverse-DNS name ` +
                     "like io.github.you.App");

        return out;
    }

    /*
     * Whether a string is an application id, in the shape the runtime enforces
     * -- reverse DNS, at least one dot, no element starting with a digit.
     *
     * **The runtime asks the platform and this is the same rule written
     * here**, because the IDE cannot call GIO: `bta_app_new` refuses a bad id
     * with `g_application_id_is_valid`, and the dialogs refuse one with this.
     * Two spellings of one rule is the kind of copy that drifts, which is why
     * the two are one paragraph apart in `docs/formats.md` and why the tests
     * put the same bad ids through both.
     */
    static idValid(text) {
        return /^[A-Za-z_-][A-Za-z0-9_-]*(\.[A-Za-z_-][A-Za-z0-9_-]*)+$/.test(text);
    }

    /*
     * Whether `sources` is the list that decides load order.  A project without
     * one is loaded by directory, and the mutators have to leave it alone rather
     * than inventing one: writing a list where there was none would freeze the
     * load order of a project that never asked for it.
     *
     * Empty and absent are the same question, which is the runtime's own rule and
     * not a convenience: `collect_sources` falls back to the directory scan when
     * the list it built is empty, so `"sources": []` loads exactly what no
     * `sources` key loads.  Asking `Array.isArray` instead -- which is what this
     * used to do -- called an empty list a list, and the first form created would
     * have frozen the order of a project that had asked for the scan.
     */
    get Lists() { return this.Sources.length > 0; }
};
