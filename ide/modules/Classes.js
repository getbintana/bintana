/*
 * What the project contains: its files, its classes, and what each class is
 * called.
 *
 * The scan is the answer to every question here, and it is worked out once per
 * listing rather than per caller: a class's name has to be read out of its `.js`
 * (see `qualifiedName`), and the callers ask in loops.
 *
 * The rules this file holds are the *runtime's*, written down:
 *
 *   - a class is found by name and not by path, so the same name in two folders
 *     is a project that will not run -- which is what `warnDuplicateClasses`
 *     says out loud;
 *   - a namespace is what a file *declares*, never what its folder suggests, so
 *     the IDE reads the declaration exactly as the runtime does;
 *   - a form is two files that travel together, and its `.js` is the one beside
 *     it -- two folders may each have a `notes.js`.
 *
 * `MainForm` keeps the surface: `files`, `components`, `qualifiedName` and the
 * rest read as the window's own, and `tests/ide` drives them by name.
 */
"use strict";

Namespace("Ide");

/* A form's name is the name of a JS class. */
/*
 * Where a new class goes when nothing says otherwise -- named after the
 * categories the project view groups by, so a directory ends up shaped like the
 * view one reads it in. Shared with `NewProjectForm`, which starts a project
 * with the same shape rather than leaving it to be tidied later.
 */
const FORM_DIR      = "forms";
const COMPONENT_DIR = "components";
const MODULE_DIR    = "modules";

/*
 * The folders a *tool* names, and what belongs in each.
 *
 * Three are the IDE's own -- it writes there without being asked -- and `po/`
 * is the runtime's, which looks for the catalogues in it. None of the four is
 * an organisation somebody chose, and two things follow from that, both of them
 * the same rule said twice: **a folder the programmer organised means
 * something, a folder a tool named does not.**
 *
 *   - The project view does not draw them (`ProjectTree.isToolFolder`): a
 *     `forms` node with a `Formularios` inside it is one thing said twice, the
 *     second half a translation of the first.
 *   - The organiser files into them and leaves everything else alone.
 *
 * They used to need a second exemption -- *and they are not namespaces* -- which
 * is gone with the rule that needed it: no folder's name is a namespace now, so
 * `forms.Chip` was never a name anybody could arrive at. See the note above
 * `namespaceHere`.
 *
 * Only at the root, and only while the folder holds nothing but its own kind:
 * a `src/forms/` somebody nested is theirs, and so is a `.png` left in
 * `modules/`.
 */
const TOOL_DIRS = {
    [FORM_DIR]:      (f) => ["form", "js"].includes(File.Extension(f).toLowerCase()),
    [COMPONENT_DIR]: (f) => ["form", "js"].includes(File.Extension(f).toLowerCase()),
    [MODULE_DIR]:    (f) => File.IsExtension(f, "js"),
    po:              (f) => Ide.Translations.isCatalogue(f),
};

const CLASS_NAME = new Regex("^[A-Za-z_$][A-Za-z0-9_$]*$");

/* What may name a folder inside the project: no dots, so no "..", and nothing
 * that would turn a relative path into an absolute one. */
const FOLDER_NAME = new Regex("^[A-Za-z0-9_-]+$");

/* What a file says about the namespace it belongs to.  The declaration is what
 * the runtime acts on, so it is what the IDE reads -- deducing it from the
 * folder would let the two disagree, and the IDE would then write types into
 * .form files that name a class nobody declared. */
const DECLARES_NAMESPACE = new Regex(
    `\\bNamespace\\s*\\(\\s*["']([A-Za-z_$][A-Za-z0-9_$.]*)["']\\s*\\)`);

/* ------------------------------------------------------------------------
 * What a component's class publishes about itself.
 *
 * A control written in C states three things next to its properties -- the
 * events it raises, the values a property accepts, which of its strings hold
 * prose -- and `EventNames()`, `PropertyOptions()` and `TextProperties()` hand
 * them to whoever is editing one.  A component written in JS could state none
 * of them: those three walk the *class table*, and a class of the project is
 * not in it, so a Stepper answered with Widget's mouse events, no drop-down
 * anywhere, and nothing the extractor would collect.
 *
 * So the class says it, where `Record` already says its `Fields`:
 *
 *     class Stepper extends Component {
 *         static Events         = ["Change"];
 *         static Options        = { Step: ["1", "5", "10"] };
 *         static TextProperties = ["Caption"];
 *     }
 *
 * Named after the questions they answer, so the declaration and the method that
 * publishes it read as the same thing said on two sides of the process line.
 *
 * Read out of the **text**, like everything else in this file: the IDE does not
 * load the project's code.  That is also what makes a declaration worth more
 * here than the `get`/`set` pairing below -- a literal list is what it says it
 * is, where an accessor has to be inferred from a shape that also occurs in a
 * comment or a string.  Anything that is not a literal is not read: a list
 * built at run time is not something text can answer for, and half a list is
 * worse than none.
 * ---------------------------------------------------------------------- */

const DECLARES_EVENTS  = new Regex("\\bstatic\\s+Events\\s*=\\s*\\[([^\\]]*)\\]");
const DECLARES_TEXTS   = new Regex(
    "\\bstatic\\s+TextProperties\\s*=\\s*\\[([^\\]]*)\\]");
/* Values are lists, so the first `}` after the opening one really is its
 * closing brace -- there is nothing between them that could nest. */
const DECLARES_OPTIONS = new Regex("\\bstatic\\s+Options\\s*=\\s*\\{([^}]*)\\}");

/* One `Name: [ ... ]` inside a static Options block. */
const OPTION_ENTRY = new Regex("([A-Za-z_$][\\w$]*)\\s*:\\s*\\[([^\\]]*)\\]");

/* An accessor, by the serialiser's own rule read off the text. */
const DECLARES_GETTER = new Regex(
    "\\bget\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(\\s*\\)");
const DECLARES_SETTER = new Regex(
    "\\bset\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(");

/* A double- or single-quoted literal, either way. */
const LITERAL_STRING = new Regex(`"([^"\\\\]*)"|'([^'\\\\]*)'`);

/* The strings of a literal list, in the order written and without repeats. */
function stringsIn(text) {
    const out = [];

    for (const match of LITERAL_STRING.Matches(text)) {
        /* Whichever of the two alternatives matched.  A group that did not take
         * part reads `""` here, which falls through to the other one -- and an
         * empty literal was never worth collecting either way. */
        const value = match.Group(1) || match.Group(2);
        if (value && !out.includes(value)) out.push(value);
    }
    return out;
}

/* What one component's source declares, as the three answers it can give. */
function contractIn(source) {
    const events = DECLARES_EVENTS.Match(source);
    const texts  = DECLARES_TEXTS.Match(source);
    const opts   = DECLARES_OPTIONS.Match(source);

    const options = {};
    if (opts) {
        for (const entry of OPTION_ENTRY.Matches(opts.Group(1))) {
            const values = stringsIn(entry.Group(2));
            /* A property whose list came out empty is one this cannot read, and
             * an empty drop-down is worse than the text field it replaced. */
            if (values.length) options[entry.Group(1)] = values;
        }
    }

    return {
        events:         events ? stringsIn(events.Group(1)) : [],
        textProperties: texts  ? stringsIn(texts.Group(1))  : [],
        options,
    };
}

/*
 * The properties of a component, by the serialiser's own rule applied to the
 * text: an accessor with **both** a getter and a setter.  A getter without a
 * setter is left out for the reason it always is -- the `.form` could never put
 * the value back.
 */
function accessorsIn(source) {
    const gets = {}, sets = {};

    for (const match of DECLARES_GETTER.Matches(source)) gets[match.Group(1)] = true;
    for (const match of DECLARES_SETTER.Matches(source)) sets[match.Group(1)] = true;

    return Dictionary.Keys(gets).filter((k) => sets[k]).sort();
}

/*
 * Declared first, then inherited -- which is `EventNames()`'s order, and the
 * reason `EventNames()[0]` is the event a control is really about.  A name said
 * on both sides is one name: the answer is a set, not a tally.
 */
function ownThenInherited(own, inherited) {
    const out = [];
    for (const name of own.concat(inherited))
        if (!out.includes(name)) out.push(name);
    return out;
}

/*
 * ---------------------------------------------------------------------------
 * **A namespace is not a folder's name, and there is no function here that
 * turns one into the other any more.**
 *
 * There used to be: `namespaceOfFolder("Widgets")` answered `Widgets`, a new
 * class created there declared `Namespace("Widgets")`, and moving a file between
 * folders rewrote its namespace to match. It was convenient and it was two
 * sources of truth for one fact -- the runtime resolves a namespace only from
 * what the code declares -- and the cost of that showed up as a list of
 * exceptions: `forms/`, `components/`, `modules/` and `po/` had to be exempted
 * (moving `Chip` into `components/` renamed the class to `components.Chip` and
 * rewrote every `.form` that placed one), and `lib/` was about to become the
 * fifth when a vendored library arrived. A rule that needs five exceptions is
 * the wrong rule.
 *
 * What replaces it is the same fact read from the only place it is ever stated:
 * **the neighbours' code**. `namespaceHere(folder)` answers what the classes
 * already in a folder put themselves in, so a batch written together stays
 * consistent -- and two folders may feed one namespace, which is what a
 * namespace is *for* and what no folder-derived rule could express.
 *
 * And moving a file no longer changes a class's namespace. A file move renames a
 * file; changing what namespace a class is in is an edit to its `Namespace(...)`
 * line, which is a change to the code and belongs to whoever is writing it.
 * ---------------------------------------------------------------------------
 */

/*
 * A project file is a path relative to the project -- "widgets/Stepper.form" --
 * and its folder is "" when it sits at the top.  The empty string, and not ".",
 * so that joining is plain concatenation and two paths for the same file cannot
 * both exist: everything here is compared by string.
 */
function folderOf(file) {
    const dir = File.Directory(file);
    return (dir === "." || dir === "/" || dir === file) ? "" : dir;
}

function inFolder(folder, name) {
    return folder ? `${folder}/${name}` : name;
}

/* The file next to this one with another extension: a form's code, a class's
 * design.  Both live in the same folder, always -- that is what makes them a
 * pair rather than two files that happen to share a name. */
function sibling(file, ext) {
    return inFolder(folderOf(file), `${File.BaseName(file)}.${ext}`);
}

Ide.Classes = class Classes {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* Everything editable under the project, as paths relative to it. */
        this.files      = [];
        /* Which of its classes are components, as the palette needs them. */
        this.components = [];
        /* The class the project starts at: what the tree marks with a play
         * triangle, read once per listing rather than once per node. */
        this.startupClass = "";
        /* `names()`, worked out on demand and thrown away by every rescan. */
        this.cache = null;
    }

    /*
     * Reads the project again.  Everything above is answered from this, and it
     * is the one place that goes to disk for it -- so a listing costs one walk
     * and one read per `.js`, whatever asks afterwards.
     */
    rescan() {
        this.files        = [];
        this.components   = [];
        this.startupClass = "";
        this.cache        = null;
        this.byNamespace  = null;
        if (!this.ide.project) return;

        this.files      = this.scan("");
        /* Where the libraries are, before anything asks what is a component: a
         * project may keep one in its own `lib/`, and those files are inside the
         * project tree without being the project's classes. */
        this.libraries  = this.resolveLibraries();
        /* The project's first, so a project that keeps its own copy of a
         * component shadows a library's rather than the other way round -- the
         * same order the runtime's own library search has. */
        this.components = this.componentsInProject()
                              .concat(this.componentsInLibraries());

        const config = this.ide.manifest.read();
        this.startupClass = config ? config.Startup : "";

        this.warnDuplicateClasses();
    }

    /*
     * Everything editable under the project, as paths relative to it.  A folder
     * is not a category the IDE invented: it is where the programmer put the
     * file, and the runtime finds a class's .form by name wherever it is.
     */
    scan(folder) {
        const out  = [];
        const here = folder ? File.Join(this.ide.project, folder) : this.ide.project;

        for (const name of Directory.List(here)) {
            if (name.startsWith(".")) continue;      /* .git and company */

            const rel = inFolder(folder, name);
            if (File.IsDir(File.Join(this.ide.project, rel))) {
                out.push(...this.scan(rel));
                /* Named at all and not a truthiness test: an entry may be `false`, which
                 * means the project owns the file and the tree shows it but no
                 * tab opens it (a .po goes to a translation editor). */
            } else if (editableOf(File.Extension(name)) !== undefined) {
                out.push(rel);
            }
        }
        return out;
    }

    /*
     * Class names are global -- the runtime looks a form up by name, not by
     * path -- so the same name in two folders is a project that will not run.
     * Said in the console and not in a dialog: this is rebuilt on every refresh,
     * and a modal on every refresh would be unusable.
     */
    warnDuplicateClasses() {
        const seen = {};
        for (const file of this.files) {
            if (!File.IsExtension(file, "form")) continue;

            const name = File.BaseName(file);
            (seen[name] = seen[name] || []).push(file);
        }

        for (const name in seen) {
            if (seen[name].length > 1) {
                this.ide.log(`Warning: ${seen[name].join(" and ")} are both ${name}; ` +
                         `the runtime cannot tell which one to load\n`);
            }
        }
    }

    /*
     * The namespace question, asked where the name is typed -- **and only when
     * there is one to ask about**.
     *
     * It names the namespace, because that is the answer: *put it in `Parts`,
     * like its neighbours*. The old wording was "in a namespace named after its
     * folder", which was the design this no longer has. With no neighbour in a
     * namespace there is nothing to offer and no checkbox: a *new* namespace is
     * declared in code, where namespaces live.
     */
    namespaceOption(suggested) {
        const ns = this.namespaceHere(folderOf(suggested));
        if (!ns) return null;

        return {
            text: Locale.Text("Put the class in {0}, like the others here", ns),
            checked: true,
            namespace: ns,
        };
    }

    /*
     * The namespace the classes already in this folder are in, or "".
     *
     * **Read from their code**, which is the only place a namespace is ever
     * stated -- `namespaceOf` has already parsed every `.js` in the project for
     * the tree, so this costs a lookup. The folder's *name* has nothing to do
     * with the answer: a folder called `Widgets` whose classes declare
     * `Namespace("Parts")` answers `Parts`, and one whose classes declare nothing
     * answers "".
     *
     * What it is for is keeping a batch consistent: create three forms in a
     * folder where the first one joined `Parts`, and the other two are offered
     * `Parts` as well. The first one had to be told, and that is right -- a
     * namespace is a decision, not a side effect of `mkdir`.
     */
    namespaceHere(folder) {
        for (const file of this.files) {
            if (folderOf(file) !== folder) continue;

            const ns = this.namespaceOf(file);
            if (ns) return ns;
        }
        return "";
    }

    /* Whether a class created in this folder has a namespace to join. */
    namespaceDefault(folder) {
        return !!this.namespaceHere(folder);
    }

    /*
     * A free name, in the folder being worked in.  Class names are global -- the
     * runtime finds a form by name, wherever the file is -- so a name is free
     * only when no folder in the project has it.
     */
    /*
     * Where a new class goes when nothing says otherwise.
     *
     * **Beside whatever is open**, which is the rule that was always here: one
     * creates a form while working on another, and the one being created belongs
     * with it. What is new is the answer when there is nothing to be beside --
     * the project root, which is where everything landed and how a root becomes
     * unmanageable: a project of twenty forms is forty files in one directory,
     * with `project.json` and `app.css` somewhere among them.
     *
     * So the root sends it to a folder named after what it is: `forms/`,
     * `components/`. The same words the project view groups by, which is the
     * point -- the directory ends up shaped like the view one reads it in.
     *
     * **A folder is not a namespace by itself**, which is what makes this safe:
     * `namespaceDefault` proposes one only where a folder is *already* being
     * used that way, so `forms/` changes where a file lives and not what the
     * class is called.
     */
    homeFor(stem) {
        const folder = this.ide.activeFile ? folderOf(this.ide.activeFile) : "";
        if (folder) return folder;

        if (stem === "Part")   return COMPONENT_DIR;
        if (stem === "Module") return MODULE_DIR;
        return FORM_DIR;
    }

    suggestName(stem = "Form") {
        const folder = this.homeFor(stem);
        /* Free under the name it would really get, which is the namespace the
         * folder's own classes are in -- not one made out of its name. */
        const ns = this.namespaceHere(folder);

        let n = 1;
        while (this.exists(ns ? `${ns}.${stem}${n}` : `${stem}${n}`)) n++;
        return inFolder(folder, `${stem}${n}`);
    }

    /*
     * The .form of a class, wherever it is; null when the project has none.
     *
     * By qualified name first, because that is what identifies a class now that
     * Widgets.Marco and Otros.Marco can both exist.  A bare name is still
     * accepted, but only while exactly one class answers to it -- guessing which
     * of two the caller meant is how a rename moves the wrong file.
     */
    formOfClass(name) {
        const forms = this.files.filter((f) => File.IsExtension(f, "form"));

        const exact = forms.find((f) => this.qualifiedName(f) === name);
        if (exact) return exact;

        const bare = forms.filter((f) => File.BaseName(f) === name);
        return bare.length === 1 ? bare[0] : null;
    }

    /*
     * The `.js` that declares a class, by the name a `.form` or a `new` would
     * use for it -- `Ide.Runner` answers `modules/Runner.js`, `MainForm`
     * answers `forms/MainForm.js`.
     *
     * The companion of `formOfClass`, and the half it cannot do: most of a
     * project's classes have no `.form` at all -- eighteen of the IDE's own --
     * and a completion that can only reach the ones that do would answer for a
     * form and go quiet for a module.
     *
     * By qualified name first, for the reason `formOfClass` does it: a bare name
     * is accepted only while one class answers to it, because guessing which of
     * two was meant is how a lookup starts lying.
     */
    fileOfClass(name) {
        const sources = this.files.filter(
            (f) => File.IsExtension(f, "js"));

        const dot  = String(name).lastIndexOf(".");
        const ns   = dot < 0 ? "" : name.slice(0, dot);
        const base = dot < 0 ? name : name.slice(dot + 1);

        const mine = sources.filter((f) => File.BaseName(f) === base &&
                                           this.namespaceOf(f) === ns);
        return mine.length === 1 ? mine[0] : null;
    }

    /*
     * The name this class goes by in a .form: qualified when its code declares a
     * namespace and assigns itself into it, bare otherwise.
     *
     * Read from the .js and not deduced from the folder, for the same reason the
     * runtime reads it there: the declaration is what will actually run.  A file
     * that names a namespace but assigns the class plainly is not in it.
     */
    qualifiedName(file) {
        const base = File.BaseName(file);
        const js   = File.Join(this.ide.project, sibling(file, "js"));
        if (!File.Exists(js)) return base;

        try {
            const source = File.Load(js);
            const found  = DECLARES_NAMESPACE.Match(source);
            if (!found) return base;

            const ns = found.Group(1);
            /* It has to put *this* class there; declaring the namespace alone
             * says nothing about where the class ended up. */
            const assigns = new Regex(
                `\\b${Regex.Escape(ns)}\\.${Regex.Escape(base)}\\s*=`);
            return assigns.IsMatch(source) ? `${ns}.${base}` : base;
        } catch (e) {
            return base;
        }
    }

    /*
     * Every class of the project, by the name a .form would use for it.  Worked
     * out once per listing: each answer costs reading a .js, and the callers ask
     * in loops.
     */
    names() {
        if (!this.cache) {
            this.cache = this.files
                                .filter((f) => File.IsExtension(f, "form"))
                                .map((f) => this.qualifiedName(f));
        }
        return this.cache;
    }

    /*
     * What a namespace holds, by what the code says -- `Ide` answers `Chrome`,
     * `Classes`, `Completion` and the rest.
     *
     * The IDE cannot ask the namespace object: it belongs to the project, which
     * runs in another process, and the whole point of `Namespace` is that it is
     * an ordinary object built at load time. So this reads the two halves the
     * runtime will act on -- the declaration and an assignment into it -- the
     * same pair `qualifiedName` reads for a form.
     *
     * Loose `.js` files and not only forms, because a namespace is mostly made
     * of classes that have no `.form` at all: eighteen of the IDE's own do.
     * Worked out on demand rather than in `rescan`, since it costs reading every
     * source and only completion asks -- and dropped with the rest when the
     * listing changes.
     */
    namespaceMembers(ns) {
        return this.scanNamespaces().members[ns] || [];
    }

    /*
     * The namespace a file's own class is in, or "" for a class in none.
     *
     * A file, and not a class name, because this is what the tree asks -- and it
     * is the file that has to end up somewhere.  A `.js` answers for the class
     * named after it; a `.form` answers what its code says, which is where its
     * qualified name comes from too.
     */
    namespaceOf(file) {
        return this.scanNamespaces().of[file] || "";
    }

    scanNamespaces() {
        if (!this.byNamespace) this.byNamespace = this.readNamespaces();
        return this.byNamespace;
    }

    readNamespaces() {
        const members = {};             /* namespace -> what is in it */
        const of      = {};             /* file -> the namespace of its class */
        const fresh   = new Map();

        for (const file of this.files) {
            if (!File.IsExtension(file, "js")) continue;

            const said = this.namespaceIn(file, fresh);
            if (!said) continue;

            for (const name of said.names) {
                const here = members[said.ns] || (members[said.ns] = []);
                if (!here.includes(name)) here.push(name);
            }

            /* The file belongs to the namespace when what it puts there is its
             * own class.  A file that merely writes into one -- as any caller
             * may -- is not a member of it. */
            if (said.names.includes(File.BaseName(file))) of[file] = said.ns;
        }

        /*
         * A form is placed by what its code says -- and its code is the `.js`
         * beside it, which the loop above has already read. Asking
         * `qualifiedName` here instead would read every one of them a second
         * time, and this runs on every listing.
         */
        for (const file of this.files) {
            if (!File.IsExtension(file, "form")) continue;

            const ns = of[sibling(file, "js")];
            if (ns) of[file] = ns;
        }

        this.parsed = fresh;
        for (const ns in members) members[ns].sort();
        return { members, of };
    }

    /*
     * What one `.js` says about a namespace: the declaration, and every name it
     * assigns into it.  Null when it says nothing.
     *
     * **Kept from one listing to the next, by the file's own timestamp.** The
     * tree is rebuilt on every save and every refresh, and reading the project's
     * sources is what this costs: measured on the IDE itself -- 44 files, 29 of
     * them `.js` -- a full read is 38 ms against 11 ms for the whole of
     * `rescan`, which would have made a listing three times its own cost. A
     * `stat` instead of a read for a file nobody touched brings it back to 1 ms.
     *
     * The bargain is `make`'s, one notch finer: two writes in the same
     * *millisecond* that leave the file the same length are one write here. A
     * person saving twice cannot do that, and a program that can has the tree it
     * asked for by asking again.
     */
    namespaceIn(file, fresh) {
        const path = File.Join(this.ide.project, file);

        /* The size as well as the time: a timestamp is only as fine as the
         * filesystem keeps it, and two writes it cannot tell apart almost
         * always differ in length. */
        const info  = File.Info(path);
        const stamp = info && info.Modified
                          ? `${info.Modified.getTime()}:${info.Size}` : "";
        const known = this.parsed && this.parsed.get(file);

        /* No timestamp is no answer about staleness, so it is read. */
        if (stamp && known && known.stamp === stamp) {
            fresh.set(file, known);
            return known.said;
        }

        let source;
        try {
            source = File.Load(path);
        } catch (e) {
            return null;                /* unreadable is not an answer */
        }

        const found = DECLARES_NAMESPACE.Match(source);
        let   said  = null;

        if (found) {
            const ns      = found.Group(1);
            const names   = [];
            const assigns = new Regex(
                `\\b${Regex.Escape(ns)}\\.([A-Za-z_$][\\w$]*)\\s*=`);

            for (const match of assigns.Matches(source)) {
                const name = match.Group(1);
                if (!names.includes(name)) names.push(name);
            }

            said = { ns, names };
        }

        fresh.set(file, { stamp, said });
        return said;
    }

    /*
     * Whether the project already has this class.  By qualified name, which is
     * what the runtime resolves: Widgets.Stepper and Parts.Stepper are two
     * classes and both may exist.  A bare name still collides with a bare one,
     * and that is the case the runtime cannot tell apart.
     */
    exists(name) {
        return this.names().includes(name);
    }

    /*
     * Which of the project's classes are components, by what their code says.
     * The IDE cannot ask the class -- it is the project's, and lives in the
     * project's process -- so it reads the declaration, which is the same thing
     * the runtime will act on.
     */
    componentsInProject() {
        const out = [];

        for (const file of this.files) {
            if (!File.IsExtension(file, "form")) continue;
            /* **A vendored library is not the project's own.** `<project>/lib/x`
             * is the first place `uses` looks and those files are inside the
             * tree -- so without this the same class is a project component *and*
             * a library one, and the palette grows two buttons for it. It stays
             * in the project tree, which is right: it is a file in the project
             * and editing it is allowed. It is simply not the project's class. */
            if (this.inLibrary(file)) continue;

            const base = File.BaseName(file);
            const js   = File.Join(this.ide.project, sibling(file, "js"));
            if (!File.Exists(js)) continue;

            const declares = new Regex(
                `class\\s+${Regex.Escape(base)}\\s+extends\\s+Component\\b`);
            try {
                const code = File.Load(js);
                if (!declares.IsMatch(code)) continue;

                /* Its own .form says how big it wants to be, which is the size
                 * the designer should give it when it is placed. */
                const props = File.LoadJson(File.Join(this.ide.project, file))
                                  .properties || {};
                /* By the name a .form will use for it, which is what the
                 * palette has to write when the component is placed. */
                /* Everything the class publishes about itself, read while its
                 * source is already open -- so what the designer, the grid, the
                 * completion and the extractor ask costs no read of their own,
                 * and none of them can be looking at an older file than the
                 * others. */
                out.push({ name: this.qualifiedName(file), file,
                           source: sibling(file, "js"),
                           Width: props.Width, Height: props.Height,
                           properties: accessorsIn(code), ...contractIn(code) });
            } catch (e) {
                /* Unreadable, or not JSON: not something to offer in a palette. */
            }
        }
        return out;
    }

    /*
     * The components of the libraries this project `uses`, offered like its own.
     *
     * **Where a library lives is the runtime's answer and not the IDE's.**
     * `Application.LibraryPath(name, project)` is the same six-place search
     * `"uses"` itself resolves through, published for exactly this: the IDE opens
     * *other* projects, so it has to ask about their libraries rather than its
     * own, and a second copy of that list here would drift the first time either
     * was fixed -- and the copy that drifted would be the one nobody runs from a
     * shell.
     *
     * A library is a flat directory of `.js` and `.form` pairs, so this is the
     * project's own walk with two differences: the paths are absolute, which is
     * what keeps them from matching anything that compares against a
     * project-relative one (the tree's categories, the organiser's plan), and
     * `library` says which one it came from -- which is what gives it a tab of
     * its own in the palette instead of sitting in the project's.
     *
     * A library that is not installed is skipped in silence here on purpose: the
     * runtime stops the program and prints every path it tried, which is a better
     * place to say it than a palette with one tab missing.
     */
    /*
     * Where each one is, as `[{ name, dir }]`, asked of the runtime.
     * A library that is not installed is skipped in silence: the runtime stops
     * the program and prints every path it tried, which is a better place to say
     * it than a palette with one tab missing.
     */
    resolveLibraries() {
        const config = this.ide.manifest.read();
        const out    = [];

        for (const name of (config ? config.Uses : []) || []) {
            const dir = Application.LibraryPath(name, this.ide.project);
            if (dir) out.push({ name, dir });
        }
        return out;
    }

    /* Whether a project-relative file is inside one of them. */
    inLibrary(file) {
        if (!this.libraries || !this.libraries.length) return false;

        const path = File.Absolute(File.Join(this.ide.project, file));
        return this.libraries.some((lib) => File.Within(path, lib.dir));
    }

    componentsInLibraries() {
        const out = [];

        for (const { name: library, dir } of this.libraries || []) {
            for (const path of Directory.Files(dir, { Pattern: "*.form",
                                                      Recursive: true })) {
                const base = File.BaseName(path);
                const js   = File.Join(File.Directory(path), `${base}.js`);
                if (!File.Exists(js)) continue;

                const declares = new Regex(
                    `class\\s+${Regex.Escape(base)}\\s+extends\\s+Component\\b`);
                try {
                    const code = File.Load(js);
                    if (!declares.IsMatch(code)) continue;

                    const props = File.LoadJson(path).properties || {};
                    out.push({ name: base, file: path, source: js, library,
                               Width: props.Width, Height: props.Height,
                               properties: accessorsIn(code), ...contractIn(code) });
                } catch (e) {
                    /* Unreadable, or not JSON: not something to offer. */
                }
            }
        }
        return out;
    }

    /* --- what a component's class publishes ----------------------------------
     *
     * The four questions the runtime answers about a control, answered for a
     * class the IDE cannot hold: `PropertyNames`, `EventNames`, `TextProperties`
     * and `PropertyOptions`, off the last listing's read of its source.
     *
     * **Null means "not a component of this project"** -- a type nothing here
     * can speak for -- and is not the same answer as an empty list, which is a
     * component that has none.  Every caller has something else to do with the
     * first and nothing to do with the second.
     */

    /* What the last listing found out about one, or null. */
    componentClass(type) {
        return this.components.find((c) => c.name === type) || null;
    }

    componentProperties(type) {
        const found = this.componentClass(type);
        return found ? found.properties.slice() : null;
    }

    /* Most derived first: what the class declares, then what any widget raises.
     * The head of it is what a double click writes. */
    /*
     * A component's own `.form`, parsed -- what the designer draws when a list
     * declares it as its item.
     *
     * The path knowledge is here and not at the call site because there are two
     * of them: a component of the *project* is listed by a path relative to it,
     * and one out of a library by an absolute one. Every other reader of a
     * component goes through this class for exactly that reason.
     *
     * `null` for a name nothing here has, and for a file that cannot be read --
     * which are the same answer to whoever is drawing: nothing to draw.
     */
    componentTree(type) {
        const spec = this.components.find((c) => c.name === type);
        if (!spec || !spec.file) return null;

        const path = spec.library ? spec.file
                                  : File.Join(this.ide.project, spec.file);
        try {
            return File.LoadJson(path);
        } catch (e) {
            return null;
        }
    }

    componentEvents(type) {
        const found = this.componentClass(type);
        return found ? ownThenInherited(found.events,
                                        Widget.EventNames("Component"))
                     : null;
    }

    /*
     * Which of a component's properties hold prose -- **null when its class
     * declares none**, which is the one place the rule above bends and does so
     * on purpose.
     *
     * A class that has not been told to say is not a class saying "nothing of
     * mine is prose": it is one that has not been asked yet, and the callers
     * have kept an answer for that since before this existed -- the extractor
     * collects nothing rather than guess, design mode offers everything rather
     * than hide it.  Answering `[]` here would turn both of those into a claim
     * the source never made, and would silently drop the captions of every
     * component written before today.
     */
    componentTextProperties(type) {
        const found = this.componentClass(type);
        if (!found || !found.textProperties.length) return null;

        return ownThenInherited(found.textProperties,
                                Widget.TextProperties("Component"));
    }

    /* The values one of its properties accepts, or null where it is free-form
     * -- which is the answer `PropertyOptions` gives, for the same reason. */
    componentOptions(type, prop) {
        const found = this.componentClass(type);
        const values = found && found.options[prop];
        return values ? values.slice() : null;
    }

    /* A form is two files that travel together; everything else travels alone. */
    pairOf(fileName) {
        const ext = File.Extension(fileName).toLowerCase();
        if (ext !== "form" && ext !== "js") return [fileName];
        if (!this.isFormPair(fileName)) return [fileName];

        const form = sibling(fileName, "form");
        const js   = sibling(fileName, "js");
        return this.files.filter((f) => f === form || f === js);
    }

    /* Its pair is the file beside it, not merely one with the same name: two
     * folders may each have a notes.js, and only one of them is this form's. */
    isFormPair(fileName) {
        return this.files.includes(sibling(fileName, "form"));
    }

    /*
     * The form a file stands for, whichever half of it this is: a `.form`, or the
     * `.js` beside it, both mean the same form.  Null for anything that is not one
     * half of a pair -- a module, a stylesheet, the manifest itself.
     */
    formOf(file) {
        if (!file || !this.isFormPair(file)) return null;

        const form = sibling(file, "form");
        return this.files.includes(form) ? form : null;
    }
};
