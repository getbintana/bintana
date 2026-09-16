/*
 * The tree, in two views.
 *
 * **Project** is the one this file is mostly about: every editable file, grouped
 * by what it *is*. **Files** is the other question -- what is really in that
 * directory -- and the two are worth having separately for the reason Android
 * Studio has them: the first is where one works, and the second is where one
 * goes when the first is not telling the whole truth.
 *
 * The project view is a *lie about the disk*, deliberately: a form's two files
 * are one node, catalogues from anywhere in the tree gather under one category,
 * the hierarchy is the namespaces rather than the directories, and `po/` is not
 * drawn at all. That is what makes it useful and what makes it
 * unable to answer "why is there a stray file in here". The files view shows
 * everything, in the folders it is really in, including what the project does
 * not recognise -- a `README`, a `.tar` an export left behind, an `.svg` in
 * `icons/`. Those were invisible in this IDE until it existed.
 *
 * Both fill the same `byKey`, so selecting, renaming and deleting work the same
 * in either and nothing downstream has to know which view is up.
 */

/*
 * The project tree: every editable file under the project, grouped.
 *
 * The grouping is the whole of it.  A form is one thing even though it lives in
 * two files, so the `.form` and the `.js` beside it hang under one node;
 * components are apart, because they are in the project to be *used* by the
 * other forms rather than opened; and a class hangs under the *namespace* its
 * code declares rather than the folder its file sits in -- `Widgets.Stepper` is
 * what a .form writes and what the runtime resolves, and one namespace declared
 * in two folders is one node here. A folder is still a folder for everything
 * else, which is where a class in no namespace stays: at the top, which is what
 * the runtime says of a bare name.
 *
 * Leaf keys are the file name, so a selection is a file.  Grouping nodes carry a
 * prefix (`dir:`, `ns:`, `cat:`, `form:`) so they can never collide with one, and
 * `byKey` says which file a key stands for -- a group node stands for the design
 * of the form it names.
 *
 * What is *in* the project is `Classes`'s answer; this is how it is shown.
 */
"use strict";

Namespace("Ide");

/*
 * Where the runtime looks for the catalogues.  A folder the *runtime* names, not
 * one the programmer organised -- which is why the tree does not show it: its
 * contents get a category of their own, and a folder holding one category says
 * the same thing twice.
 */
const PO_DIR = "po";


/* The two views, by index: what the chooser shows is prose, what is remembered
 * is a number. */
const VIEW_PROJECT = 0;
const VIEW_FILES   = 1;

Ide.ProjectTree = class ProjectTree {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
        /* Tree key -> the file it stands for.  Read by `FileTree_Select`, and
         * empty until the first listing -- which is the welcome page's state. */
        this.byKey = {};

        /* Which view is up. Remembered across runs, because it is a way of
         * working and not a thing one re-chooses every morning. */
        this.view = Settings.Get("tree.view", VIEW_PROJECT);
    }

    /* The views, in the order the chooser offers them. Their *names* are prose
     * and are filled in from code; what is stored and compared is the index, so
     * a translated word can never become a value nothing recognises. */
    static get views() {
        return [Locale.Text("Project"), Locale.Text("Files")];
    }

    setView(which) {
        if (which === this.view) return;

        this.view = which;
        Settings.Set("tree.view", which);
        this.build();
    }

    /*
     * Fills the tree in from what the last scan found.
     *
     * Clearing and refilling makes the TreeView report selections of its own
     * along the way; none of them is the user asking for anything, which is what
     * `muted` says.
     */
    build() {
        const ide = this.ide;

        ide.muted = true;
        ide.FileTree.Clear();
        this.byKey = {};
        /* What each file row was labelled with, so something that decorates one
         * -- git's indicator today -- can put the label back rather than
         * decorating its own decoration. Only file rows: a category has nothing
         * to say about itself that changes. */
        this.labels = {};

        if (ide.project) {
            if (this.view === VIEW_FILES) {
                this.addRealFolder("", undefined);
            } else {
                this.addNamespaces(undefined);
                this.addFolder("", undefined);
            }
        }

        ide.muted = false;
    }

    /* --- the files view -----------------------------------------------------
     *
     * The directory as it is: folders first, then files, both by name, and
     * everything shown -- what the project recognises and what it does not.
     *
     * Hidden entries stay hidden. `.git` is not a thing anybody opens from here,
     * and a tree that showed it would be mostly it.
     */
    addRealFolder(folder, parentKey) {
        const here = folder ? File.Join(this.ide.project, folder) : this.ide.project;

        let names;
        try { names = Directory.List(here); } catch (e) { return; }

        const entries = names.filter((n) => !n.startsWith("."))
                             .map((n) => ({
                                 name: n,
                                 rel:  folder ? `${folder}/${n}` : n,
                                 dir:  File.IsDir(File.Join(here, n)),
                             }))
                             /* Folders first, and then the order this desktop puts names
                              * in. This was `localeCompare`, which on this engine is a
                              * codepoint compare: every accented file name filed after Z. */
                             .sort((a, b) => (a.dir === b.dir)
                                 ? Locale.Compare(a.name, b.name)
                                 : (a.dir ? -1 : 1));

        for (const entry of entries) {
            if (entry.dir) {
                const key = `dir:${entry.rel}`;
                this.ide.FileTree.Add(key, entry.name, parentKey, this.icon("folder"));
                this.addRealFolder(entry.rel, key);
                continue;
            }

            /*
             * **The icon is the desktop's, asked per file.** `File.Info` answers
             * with the name the desktop draws for that kind of file, so a
             * `.tar`, a `.md` and an `.svg` come out looking like what they are
             * without this file keeping a table of guesses -- which is half of
             * why `Info` exists. The tree's own icons stay for what the desktop
             * has nothing for.
             */
            const info = File.Info(File.Join(here, entry.name));
            const icon = (info && info.Icon) || this.icon("file");

            this.addFile(entry.rel, entry.name, parentKey, icon);
            this.byKey[entry.rel] = entry.rel;
        }
    }

    /*
     * A file row, remembered by its label.
     *
     * Every row that stands for a file goes through here and nothing else does:
     * a decoration is put on a label and has to be able to find the label
     * again, and reading it back off the tree is not possible -- `TreeView.Text`
     * answers for the *selected* row and a decoration is applied to all of them.
     */
    addFile(key, text, parentKey, icon) {
        this.ide.FileTree.Add(key, text, parentKey, icon);
        this.labels[key] = text;
    }

    /* What each kind of node in the project tree is shown with. The first name
     * the desktop really has wins; one it does not comes back empty and the
     * node simply has no icon, the same bargain Button.Icon makes. */
    icon(kind) {
        const names = {
            folder:     ["folder-symbolic"],
            /* A namespace is not a folder and must not look like one: it is a
             * name classes are inside of, gathered from wherever their files
             * are. A package, which is what every other IDE draws for this. */
            namespace:  ["package-x-generic-symbolic", "folder-symbolic"],
            forms:      ["folder-documents-symbolic", "bta-frame-symbolic"],
            components: ["application-x-addon-symbolic", "bta-component-symbolic"],
            mods:       ["folder-scripts-symbolic", "folder-symbolic"],
            /* A language, not a folder: the catalogues are a category of their
             * own because they are opened with something else. */
            langs:      ["preferences-desktop-locale-symbolic",
                         "accessories-dictionary-symbolic", "folder-symbolic"],
            catalogue:  ["preferences-desktop-locale-symbolic",
                         "text-x-generic-symbolic", "bta-file-symbolic"],
            /* The category and the file get the same picture: there is no
             * per-format icon worth having at 16px, and what the node says is
             * "this is an image", which is what the viewer opens. */
            images:     ["image-x-generic-symbolic", "bta-image-symbolic"],
            image:      ["image-x-generic-symbolic", "bta-image-symbolic"],
            /* A document and the category it is in: what the desktop draws for
             * a page of text, with the runtime's own file behind it. */
            docs:       ["x-office-document-symbolic", "text-x-generic-symbolic",
                         "folder-symbolic"],
            document:   ["x-office-document-symbolic", "text-x-generic-symbolic",
                         "bta-file-symbolic"],
            other:      ["folder-symbolic"],
            form:       ["window-new-symbolic", "bta-frame-symbolic"],
            /* The one the project starts at. A play triangle and not a star:
             * what is being said is "this is the one that runs", not "this is
             * the important one". */
            startup:    ["media-playback-start-symbolic", "media-playback-start"],
            design:     ["view-grid-symbolic", "bta-panel-symbolic"],
            code:       ["text-x-script-symbolic", "bta-code-symbolic"],
            file:       ["text-x-generic-symbolic", "bta-file-symbolic"],
        }[kind] || [];
        return names.find((name) => Application.HasIcon(name)) || "";
    }

    /* The folders directly inside this one, from the files themselves: a folder
     * with nothing to edit in it has nothing to show. */
    subfoldersOf(folder) {
        const prefix = folder ? `${folder}/` : "";
        const names  = new Set();

        for (const file of this.ide.files) {
            /* Placed by its namespace, so it makes no folder here: a `widgets/`
             * holding nothing but `Widgets` classes is a folder with nothing
             * left to show. */
            if (this.ide.classes.namespaceOf(file)) continue;

            const dir = folderOf(file);
            if (!dir.startsWith(prefix)) continue;

            const rest = dir.slice(prefix.length);
            if (rest) names.add(rest.split("/")[0]);
        }
        /* A folder a tool named is not a node: see TOOL_DIRS. At the root only,
         * because `forms/` next to `project.json` is the IDE's doing and
         * `src/forms/` is somebody's. */
        if (!folder)
            for (const name of [...names])
                if (this.isToolFolder(name)) names.delete(name);

        /* Folder names a person reads, so the desktop's order: see the note above. */
        return [...names].sort(Locale.Compare);
    }

    /*
     * Whether that folder is one a tool named *and* holds nothing but what
     * belongs in it -- a `README` dropped in `modules/` puts the folder back on
     * the tree, because the tree would otherwise be hiding a file from the
     * person who left it there.
     */
    isToolFolder(name) {
        const belongs = TOOL_DIRS[name];
        if (!belongs) return false;

        const prefix = `${name}/`;
        const inside = this.ide.files.filter((f) => f.startsWith(prefix));

        return inside.length > 0 &&
               inside.every((f) => belongs(f) && folderOf(f) === name);
    }

    /* One folder: what is inside it first, then what is in it. */
    addFolder(folder, parentKey) {
        for (const name of this.subfoldersOf(folder)) {
            const path = inFolder(folder, name);
            const key  = `dir:${path}`;

            this.ide.FileTree.Add(key, name, parentKey, this.icon("folder"));
            this.addFolder(path, key);
        }
        this.addCategories(this.filesOf(folder), parentKey, folder);
    }

    /* --- the namespaces ------------------------------------------------------
     *
     * **The hierarchy of the project view is the namespaces, not the folders**,
     * which is the difference between this view and the other one. A namespace
     * is what the runtime resolves -- `Widgets.Stepper` is the name a `.form`
     * writes and `startup` names -- and it is declared by the code, so it is
     * free of where the file happens to sit. Two folders feeding one namespace
     * are one node here, which no folder tree can show.
     *
     * `A.B` nests under `A`, and a level with no class of its own is still a
     * node: it is a step of a name somebody wrote.
     *
     * What is left -- a class in no namespace -- stays where it was. It
     * conceptually lives at the top, which is what the runtime says of it when
     * it resolves a bare name, and what the folders below draw.
     */
    addNamespaces(parentKey) {
        const byPath = new Map();

        for (const file of this.ide.files) {
            const ns = this.ide.classes.namespaceOf(file);
            if (!ns) continue;
            if (!byPath.has(ns)) byPath.set(ns, []);
            byPath.get(ns).push(file);
        }
        if (!byPath.size) return;

        for (const top of this.namespacesUnder("", byPath))
            this.addNamespace(top, parentKey, byPath);
    }

    /* The next segment of every namespace below this one, once each: `A.B` and
     * `A.C` under "A" are `A.B` and `A.C`, and both give `A` under "". */
    namespacesUnder(path, byPath) {
        const prefix = path ? `${path}.` : "";
        const names  = new Set();

        for (const ns of byPath.keys()) {
            if (!ns.startsWith(prefix)) continue;
            const rest = ns.slice(prefix.length);
            if (rest) names.add(prefix + rest.split(".")[0]);
        }
        return [...names].sort(Locale.Compare);
    }

    addNamespace(path, parentKey, byPath) {
        const key = `ns:${path}`;

        /* The last segment, since the ones before it are the nodes above. */
        this.ide.FileTree.Add(key, path.slice(path.lastIndexOf(".") + 1),
                              parentKey, this.icon("namespace"));

        for (const child of this.namespacesUnder(path, byPath))
            this.addNamespace(child, key, byPath);

        this.addCategories(byPath.get(path) || [], key, key);
    }

    /*
     * The files a folder node shows: the ones really in it, minus whatever a
     * namespace took -- and, at the root, whatever a folder a tool named holds,
     * since that folder is not drawn and its files have nowhere else to be.
     * Which is what the catalogues already did: `langs` collects them from the
     * whole project rather than from a folder.
     */
    filesOf(folder) {
        return this.ide.files.filter((f) => {
            if (this.ide.classes.namespaceOf(f)) return false;

            const dir = folderOf(f);
            if (dir === folder) return true;
            return !folder && this.isToolFolder(dir);
        });
    }

    /*
     * The files of one folder, grouped: forms with their code, components
     * apart -- they are in the project to be used by the other forms, not to be
     * shown -- then loose modules and the rest.
     */
    addCategories(here, parentKey, scope) {
        /* Components are known by the name a .form uses for them, which is
         * qualified once they live in a namespace. */
        const isComponent = (file) =>
            this.ide.components.some((c) => c.file === file);
        /* The scope is the folder or the namespace this is filling in, so the
         * same category under two of them cannot collide. */
        const catKey = (base) => (scope ? `cat:${base}:${scope}` : `cat:${base}`);

        const paired = [];
        const forms  = here.filter((f) => File.Extension(f).toLowerCase() === "form");

        const groups = [
            { key: catKey("forms"),      text: Locale.Text("Forms"), icon: "forms",
              files: forms.filter((f) => !isComponent(f)) },
            { key: catKey("components"), text: Locale.Text("Components"), icon: "components",
              files: forms.filter(isComponent) },
        ];

        for (const cat of groups) {
            if (!cat.files.length) continue;

            this.ide.FileTree.Add(cat.key, cat.text, parentKey, this.icon(cat.icon));
            for (const form of cat.files) {
                /* Keyed by path and shown by class: a project with the same
                 * name in two folders will not run, but the tree that says so
                 * has to be able to show both. */
                const group = `form:${form.slice(0, -".form".length)}`;
                /* The one that runs says so, by the name the runtime looks it up
                 * by -- qualified when its code puts it in a namespace, since
                 * that is what `startup` has to name to be found. */
                const starts = this.ide.startupClass &&
                               this.ide.qualifiedName(form) === this.ide.startupClass;
                this.addFile(group, File.BaseName(form), cat.key,
                                  this.icon(starts ? "startup" : "form"));
                this.byKey[group] = form;

                this.addLeaf(form, Locale.Text("design"), group, "design");
                paired.push(form);

                const js = sibling(form, "js");
                if (this.ide.files.includes(js)) {
                    this.addLeaf(js, Locale.Text("code"), group, "code");
                    paired.push(js);
                }
            }
        }

        const loose = here.filter((f) => !paired.includes(f));
        const ext   = (f) => File.Extension(f).toLowerCase();
        const mods  = loose.filter((f) => ext(f) === "js");
        /* Every catalogue the project has, at the top, whichever folder it is
         * in -- `po/` is a place the runtime looks in rather than a shape the
         * programmer chose, so it is the category that carries the meaning. */
        const langs = scope ? [] : this.ide.files.filter((f) => Ide.Translations.isCatalogue(f));
        const pics  = loose.filter((f) => isImageFile(f));
        const docs  = loose.filter((f) => ext(f) === "md");
        const rest  = loose.filter((f) => ext(f) !== "js" && ext(f) !== "md" &&
                                          !Ide.Translations.isCatalogue(f) &&
                                          !isImageFile(f));

        if (mods.length) {
            this.ide.FileTree.Add(catKey("mods"), Locale.Text("Modules"), parentKey,
                              this.icon("mods"));
            for (const f of mods) this.addLeaf(f, File.Name(f), catKey("mods"), "code");
        }

        /*
         * The catalogues get a category of their own rather than falling into
         * "Other", because they are not opened the way everything else here is:
         * activating one hands it to a translation editor.  A category is how the
         * tree already says "these are a different kind of thing" -- it is what
         * separates a component from a form.
         *
         * They live in po/, so this normally draws under that folder's node and
         * the category names what is in it.
         */
        if (langs.length) {
            this.ide.FileTree.Add(catKey("langs"), Locale.Text("Translations"), parentKey,
                              this.icon("langs"));
            for (const f of langs)
                this.addLeaf(f, File.Name(f), catKey("langs"), "catalogue");
        }
        /*
         * Images get their own category for the reason the catalogues do: they
         * are not opened the way everything else here is. Activating one hands
         * it to a viewer, and a category is how this tree already says "these
         * are a different kind of thing".
         *
         * **Always, even in a folder that holds nothing else.** Dropping it
         * there was tried and put back: this is a view of the *project* and not
         * of the disk -- it already shows a form's two files as one node, which
         * no directory does -- so the categories are the vocabulary it speaks
         * in, and one that comes and goes depending on what else is in the
         * folder is a vocabulary with a hole in it. What the folder happens to
         * be called is a different question, and the answer to it is a
         * different view.
         */
        if (pics.length) {
            this.ide.FileTree.Add(catKey("images"), Locale.Text("Images"), parentKey,
                              this.icon("images"));
            for (const f of pics)
                this.addLeaf(f, File.Name(f), catKey("images"), "image");
        }
        /*
         * And the documents, for the third time the same reason: a `.md` is
         * opened as the document it is and not as its source, which is a
         * different kind of thing from the modules beside it. It is also the
         * category a stranger looks in first -- a project's README is what they
         * came to read.
         */
        if (docs.length) {
            this.ide.FileTree.Add(catKey("docs"), Locale.Text("Documents"), parentKey,
                              this.icon("docs"));
            for (const f of docs)
                this.addLeaf(f, File.Name(f), catKey("docs"), "document");
        }
        if (rest.length) {
            this.ide.FileTree.Add(catKey("other"), Locale.Text("Other"), parentKey,
                              this.icon("other"));
            for (const f of rest) this.addLeaf(f, File.Name(f), catKey("other"), "file");
        }
    }

    addLeaf(fileName, text, parentKey, kind) {
        this.addFile(fileName, text, parentKey, this.icon(kind || "file"));
        this.byKey[fileName] = fileName;
    }
};
