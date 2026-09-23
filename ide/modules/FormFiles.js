/*
 * Creating, renaming and deleting the project's forms and files -- and writing
 * into their code, which is the half that makes it more than a file manager.
 *
 * A form is two files that travel together, so nothing here touches one alone:
 * renaming a form moves the `.form` and the `.js`, rewrites the class in the
 * code, follows the namespace its folder implies, retypes every other `.form`
 * that places the class, and tells `project.json`.  Doing four of those five and
 * forgetting the fifth is a project that no longer runs, and the failure would
 * turn up in a running program rather than here.
 *
 * The line it will not cross is *someone else's code*: references from other
 * `.js` files are reported (`warnDanglingReferences`), never rewritten.  The
 * `.form` files are the IDE's own format and are rewritten; a JavaScript file is
 * the programmer's.
 *
 * `openHandler` is the other half: double clicking a control writes the handler
 * and jumps to it, which is the central gesture of a RAD.  It is here because
 * that means editing the class's source, and `insertMethod` below is what knows
 * how.
 */
"use strict";

Namespace("Ide");

/* Index of the closing quote of the string that starts at `start`. */
function endOfString(source, start) {
    const quote = source[start];
    for (let i = start + 1; i < source.length; i++) {
        if (source[i] === "\\") { i++; continue; }
        if (source[i] === quote) return i;
        if (source[i] === "\n" && quote !== "`") return i;   // unterminated
    }
    return source.length;
}

/*
 * Index of the brace that closes the body opening at `open`, counting braces
 * but skipping strings and comments: a brace inside a string would throw the
 * count off and the method would end up inserted anywhere at all.  Returns -1
 * if it does not close (or if something confuses it, e.g. a regular expression
 * with braces, which is not recognised).
 */
function endOfBlock(source, open) {
    let depth = 0;

    for (let i = open; i < source.length; i++) {
        const c = source[i], next = source[i + 1];

        if (c === "/" && next === "/") {
            i = source.indexOf("\n", i);
            if (i < 0) break;
        } else if (c === "/" && next === "*") {
            i = source.indexOf("*/", i + 2);
            if (i < 0) break;
            i++;
        } else if (c === '"' || c === "'" || c === "`") {
            i = endOfString(source, i);
        } else if (c === "{") {
            depth++;
        } else if (c === "}") {
            if (--depth === 0) return i;
        }
    }
    return -1;
}

/*
 * Inserts an empty method in the class.  It goes at the end of the body, which
 * is where one would write it; if the body could not be delimited with
 * confidence it falls back to the start, which is always correct even if it
 * ends up in reverse order.
 */
function insertMethod(source, className, method) {
    const declaration = new Regex(`class\\s+${Regex.Escape(className)}\\b[^{]*\\{`);
    const found       = declaration.Match(source);
    if (!found) return null;

    const open  = found.Index + found.Length - 1;
    const close = endOfBlock(source, open);
    const at    = close >= 0 ? close : open + 1;

    const snippet = `\n    ${method}() {\n        \n    }\n`;
    const out     = source.slice(0, at) + snippet + source.slice(at);

    /* The cursor goes to the blank line of the body, the one after the signature.
     * `at` and `snippet` are for a caller inserting into a live editor rather
     * than writing the whole text back. */
    return { source: out, at, snippet,
             line: Text.LineOf(out, out.indexOf(`${method}() {`, at)) + 1 };
}

/*
 * Moves a class between namespaces, in its own source.
 *
 * Two precise edits and not a global replace: the declaration `Namespace("X")`
 * and the assignment `X.Klass =` are the only two places the namespace appears,
 * and a folder name is a common enough word to be somewhere else in the file.
 *
 * Leaving a namespace turns the assignment back into a plain declaration, and
 * entering one does the reverse -- which is what makes moving a file between
 * folders in the IDE mean the same thing as writing it there by hand.
 */
function retargetNamespace(source, klass, oldNs, newNs) {
    if (oldNs === newNs) return source;

    /* One each: a comment further down that happens to name the class is not a
     * second declaration. */
    if (oldNs) {
        const declared = new Regex(
            `^[ \\t]*Namespace\\s*\\(\\s*["\']${Regex.Escape(oldNs)}["\']\\s*\\)\\s*;?[ \\t]*\\n+`,
            { Multiline: true });
        const assigned = new Regex(
            `\\b${Regex.Escape(oldNs)}\\.${Regex.Escape(klass)}\\s*=\\s*`);

        source = declared.Replace(source, newNs ? `Namespace("${newNs}");\n\n` : "", 1);
        source = assigned.Replace(source, newNs ? `${newNs}.${klass} = ` : "", 1);
        return source;
    }

    /* Into a namespace: declare it, and make the declaration an assignment. */
    const declares = new Regex(`\\bclass\\s+${Regex.Escape(klass)}\\b`);
    if (!declares.IsMatch(source)) return source;

    return `Namespace("${newNs}");\n\n` +
           declares.Replace(source, `${newNs}.${klass} = class ${klass}`, 1);
}

Ide.FormFiles = class FormFiles {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    /* ------------------------------------------------------- creating things */

    newForm() {
        if (!this.ide.project) {
            Message.Warning("Open a project before creating a form.");
            return;
        }
        const suggested = this.ide.suggestFormName();
        AskForm.prompt("New form", "Class name (a folder is allowed):", suggested,
                       (name, useNs) => this.createForm(name, "Form", useNs),
                       this.ide.namespaceOption(suggested));
    }

    /* Writes both files and registers them.  Without touching the UI, so it
     * serves just as well when creating a project from scratch.  Answers with the
     * `.form` it wrote, or null -- which was a boolean and a field on the window
     * that the one caller needing the name read back out of. */
    writeForm(where, kind = "Form", useNamespace) {
        const folder = folderOf(where);
        const name   = File.BaseName(where);

        if (!CLASS_NAME.IsMatch(name)) {
            Message.Error("\"{0}\" is not usable as a class name.", name);
            return null;
        }
        if (folder && !folder.split("/").every((part) => FOLDER_NAME.IsMatch(part))) {
            Message.Error("\"{0}\" is not usable as a folder.", folder);
            return null;
        }

        /*
         * **The namespace comes from the neighbours' code, never from the folder's
         * name.** A folder is where a file sits; a namespace is what the code
         * says, and the prologue written below is what makes it true. So what is
         * on offer here is the namespace the classes already in this folder are
         * in -- which keeps a batch written in one place consistent -- and a
         * folder with no namespaced class in it offers nothing.
         *
         * `useNamespace` may also be a string, which is how a caller asks for a
         * namespace outright: creating the *first* class of one is a decision
         * nobody can infer.
         */
        const here = this.ide.namespaceHere(folder);
        const ns   = typeof useNamespace === "string" ? useNamespace
                   : useNamespace === false          ? ""
                   : useNamespace === undefined      ? here
                   : here;
        const full = ns ? `${ns}.${name}` : name;

        /* By the name a .form would use: Widgets.Stepper and Parts.Stepper are
         * two classes and both may exist, but two bare Steppers are a project
         * that cannot say which one it means. */
        if (this.ide.classExists(full)) {
            Message.Error("The project already has a {0}.", full);
            return null;
        }

        const formFile = inFolder(folder, `${name}.form`);
        const jsFile   = inFolder(folder, `${name}.js`);
        const formPath = File.Join(this.ide.project, formFile);
        const jsPath   = File.Join(this.ide.project, jsFile);

        if (File.Exists(formPath) || File.Exists(jsPath)) {
            Message.Error("The project already has a {0}.", name);
            return null;
        }
        if (folder) Directory.Make(File.Join(this.ide.project, folder));

        /* A component has no title: it is not a window.  Everything else about
         * the two files is the same, which is the point of a component. */
        const component = kind === "Component";
        const properties = component ? { Width: 200, Height: 60 }
                                     : { Text: name, Width: 400, Height: 300 };

        File.SaveJson(formPath, {
            format: "bintana-form/1",
            class: full,
            properties,
            children: [],
        });

        File.Save(jsPath, this.classSource(name, ns, kind));

        /* Without this the class never loads and the form does not exist at run
         * time.  With its folder: "sources" is a list of paths. */
        this.ide.registerSource(jsFile);
        return formFile;
    }

    /*
     * The code for a new class.  With a namespace it is declared and then
     * assigned into it -- plain JavaScript, no module system: `Namespace` makes
     * the object, the assignment puts the class in it, and `class Name` keeps
     * the constructor named after the file.
     */
    classSource(name, ns, kind) {
        /* A module extends nothing: it is a class of the project's own, and the
         * two the runtime offers are for the two things that go on a screen. */
        const extend = kind === "Component" ? " extends Component"
                     : kind === "Module"    ? ""
                     :                        " extends Form";
        const body   = kind === "Form" ? "\n\n    Form_Open() {\n    }\n" : "\n\n";

        if (!ns) return `class ${name}${extend} {${body}}\n`;

        return `Namespace("${ns}");\n\n` +
               `${ns}.${name} = class ${name}${extend} {${body}};\n`;
    }

    /*
     * A module: one class, one file, no window.
     *
     * The third thing a project is made of and the only one that had no menu
     * item -- a form and a component are two files each and the IDE wrote them
     * both, while a plain class was "make a file, then remember to put it in
     * `sources`", which is the step that is forgotten and the failure that
     * follows is `X is not defined` at run time.
     *
     * With nothing open it goes to `modules/`, beside the other two conventions,
     * and it takes a folder in the name like everything else here.
     */
    newModule() {
        if (!this.ide.project) {
            Message.Warning("Open a project before creating a module.");
            return;
        }
        const suggested = this.ide.suggestFormName("Module");
        AskForm.prompt("New module", "Class name (a folder is allowed):", suggested,
                       (name, useNs) => this.createModule(name, useNs),
                       this.ide.namespaceOption(suggested));
    }

    createModule(name, useNamespace) {
        const jsFile = this.writeModule(name, useNamespace);
        if (!jsFile) return false;

        this.ide.listFiles();
        this.ide.openInTab(jsFile);
        this.ide.log(`Created ${jsFile}\n`);
        return true;
    }

    /*
     * Writes the file and registers it, which is the half nobody remembers.
     *
     * The name is checked against the project's *form* classes, which is the
     * check this IDE can make: a loose class is not in any `.form` and nothing
     * lists them, so two modules of one name in two folders is still a project
     * the runtime will refuse to load and this will not have warned about. The
     * file's own path is checked, which catches it in the folder that matters.
     */
    writeModule(where, useNamespace) {
        const folder = folderOf(where);
        const name   = File.BaseName(where);

        if (!CLASS_NAME.IsMatch(name)) {
            Message.Error("\"{0}\" is not usable as a class name.", name);
            return null;
        }
        if (folder && !folder.split("/").every((part) => FOLDER_NAME.IsMatch(part))) {
            Message.Error("\"{0}\" is not usable as a folder.", folder);
            return null;
        }

        /* The neighbours' namespace, or the one the caller named: see `newForm`. */
        const here = this.ide.namespaceHere(folder);
        const ns   = typeof useNamespace === "string" ? useNamespace
                   : useNamespace === false          ? "" : here;
        const full = ns ? `${ns}.${name}` : name;

        if (this.ide.classExists(full)) {
            Message.Error("The project already has a {0}.", full);
            return null;
        }

        const jsFile = inFolder(folder, `${name}.js`);
        const jsPath = File.Join(this.ide.project, jsFile);

        if (File.Exists(jsPath)) {
            Message.Error("The project already has a {0}.", jsFile);
            return null;
        }
        if (folder) Directory.Make(File.Join(this.ide.project, folder));

        File.Save(jsPath, this.classSource(name, ns, "Module"));

        /* Without this the class never loads, and the first thing that names it
         * fails at run time with a word nobody wrote. */
        this.ide.registerSource(jsFile);
        return jsFile;
    }

    createForm(name, kind = "Form", useNamespace) {
        const formFile = this.writeForm(name, kind, useNamespace);
        if (!formFile) return false;

        this.ide.listFiles();
        this.ide.openInTab(formFile);
        this.ide.log(`Created ${formFile} and ${sibling(formFile, "js")}\n`);
        return true;
    }

    /*
     * A component is a form that is not a window: the IDE creates it the same
     * way, and from then on the palette offers it like any control.
     */
    newComponent() {
        if (!this.ide.project) {
            Message.Warning("Open a project before creating a component.");
            return;
        }
        const suggested = this.ide.suggestFormName("Part");
        AskForm.prompt("New component", "Class name (a folder is allowed):", suggested,
                       (name, useNs) => this.createForm(name, "Component", useNs),
                       this.ide.namespaceOption(suggested));
    }

    /*
     * Renaming the **file** that is open -- which is what F2 and the File menu
     * mean, and what the project tree's menu means.
     *
     * It was called `renameSelected`, and so was the one that renames the
     * selected *control* four hundred lines further down: two methods, one name,
     * and in JavaScript the later one wins. So F2 renamed a control, this was
     * dead code, and nothing said so -- `tests/ide` calls `renameForm` directly
     * and never went through the menu. Two names now, and a test for the path.
     */
    renameSelectedFile() {
        if (!this.ide.activeFile) return;

        /* A .form or .js with unsaved changes cannot be renamed on disk
         * without losing them: the UI has nowhere to put that state. */
        if (this.ide.isDirty()) {
            Message.Warning("Save the changes before renaming.");
            return;
        }

        if (this.ide.isFormPair(this.ide.activeFile)) {
            /* Asked by its short name, resolved by its qualified one: two
             * namespaces may hold a class of the same name, and only the file
             * being looked at says which one is being renamed. */
            const file = this.ide.activeFile;
            this.ide.renamePrompt = AskForm.prompt(
                "Rename form", "New class name (a folder moves it):",
                File.BaseName(file),
                (name) => this.renameForm(this.ide.qualifiedName(file), name));
        } else {
            this.ide.renamePrompt = AskForm.prompt(
                "Rename file", "New name (a folder moves it):",
                File.Name(this.ide.activeFile),
                (name) => this.renameFile(this.ide.activeFile, name));
        }
    }

    /*
     * Renaming a form moves both files and rewrites the class name: if only the
     * .form moved, the runtime would look for <Class>.form and not find it.  It
     * renames the corresponding tab as well.
     */
    renameForm(oldClass, target) {
        const oldFormFile = this.ide.formOfClass(oldClass);
        if (!oldFormFile) {
            Message.Error("The project has no single class called {0}.", oldClass);
            return false;
        }
        /* Everything below works on the short name -- what the class is called
         * in its own file -- and on the qualified one, which is what a .form
         * and project.json use for it. */
        const oldName = File.BaseName(oldFormFile);

        /* A bare name renames in place; one with a folder moves the pair as
         * well, which is the only sane reading of typing a path in there. */
        const newName   = File.BaseName(target);
        const newFolder = target.includes("/") ? folderOf(target)
                                               : folderOf(oldFormFile);

        if (!CLASS_NAME.IsMatch(newName)) {
            Message.Error("\"{0}\" is not usable as a class name.", newName);
            return false;
        }
        if (newFolder && !newFolder.split("/").every((part) => FOLDER_NAME.IsMatch(part))) {
            Message.Error("\"{0}\" is not usable as a folder.", newFolder);
            return false;
        }

        const newFormFile = inFolder(newFolder, `${newName}.form`);
        const newJsFile   = inFolder(newFolder, `${newName}.js`);

        if (newFormFile === oldFormFile) return true;
        if (File.Exists(File.Join(this.ide.project, newFormFile))) {
            Message.Error("{0} already exists.", newFormFile);
            return false;
        }

        /* The rename is made from the files, so an unsaved `.form` is saved
         * first -- the bargain writing a handler already makes. The `.js` half
         * is not: its tab is carried along below, typed text and all. */
        const formState = this.ide.openTabs.get(oldFormFile);
        if (formState && this.ide.tabs.dirtyOf(oldFormFile, formState) &&
            !this.ide.tabs.saveAllDirty([oldFormFile])) return false;
        if (newFolder) Directory.Make(File.Join(this.ide.project, newFolder));

        /*
         * **A move does not change a namespace.** It used to: moving a file
         * between folders rewrote its `Namespace(...)` to match the new folder,
         * so dragging a file in the tree renamed a class and every `.form` that
         * placed it. A namespace is what the code declares, so a file operation
         * cannot be what changes it -- and the class keeps the one it had,
         * wherever the file lands.
         *
         * Changing a class's namespace is an edit to that line, which is a change
         * to the code and belongs to whoever is writing it.
         */
        const oldFull = this.ide.qualifiedName(oldFormFile);
        const oldNs   = oldFull.includes(".") ? oldFull.slice(0, oldFull.lastIndexOf(".")) : "";
        const newNs   = oldNs;
        const newFull = newNs ? `${newNs}.${newName}` : newName;

        if (newFull !== oldFull && this.ide.classExists(newFull)) {
            Message.Error("The project already has a {0}.", newFull);
            return false;
        }

        const oldForm = File.Join(this.ide.project, oldFormFile);
        const newForm = File.Join(this.ide.project, newFormFile);

        const node = File.LoadJson(oldForm);
        node.class = newFull;
        File.SaveJson(newForm, node);
        File.Delete(oldForm);

        /* With word boundaries, so renaming Form1 does not touch Form1Extra.
         * Only inside its own file. The namespace lives in the code, so moving
         * the file is not enough: the declaration has to move with it or the
         * class keeps answering to the name of the folder it left. Applying it
         * twice changes nothing, which is what lets the open tab have it too. */
        const renamedWord = new Regex(`\\b${Regex.Escape(oldName)}\\b`);
        const retext = (source) =>
            retargetNamespace(renamedWord.Replace(source, newName), newName, oldNs, newNs);

        const oldJsFile = sibling(oldFormFile, "js");
        const hasJs     = this.ide.files.includes(oldJsFile);
        if (hasJs) {
            const oldJs = File.Join(this.ide.project, oldJsFile);
            const newJs = File.Join(this.ide.project, newJsFile);

            File.Save(newJs, retext(File.Load(oldJs)));
            File.Delete(oldJs);
            this.ide.renameSource(oldJsFile, newJsFile);
        }

        this.ide.renameStartup(oldFull, newFull);
        this.warnDanglingReferences(oldName, newName);

        /* Every .form that places this class names it by its old name.  They are
         * JSON and the IDE owns their shape, so they are rewritten rather than
         * reported -- unlike the .js, where a warning is the honest limit. */
        const retyped = this.retypeForms(oldFull, newFull, newFormFile);
        if (retyped.length) {
            this.ide.log(`Renamed ${oldFull} to ${newFull} in ${retyped.join(", ")}\n`);
        }

        /* The tabs follow the files, and **their text follows too**: the `.js`
         * tab used to keep `class Form1` under its new name, and saving it
         * wrote that into NewName.js -- undoing the rename, dirty or not. The
         * `.form` was saved above, so it is reloaded; the `.js` gets the same
         * edit the file got, on top of whatever was typed into it. */
        this.ide.renameTab(oldFormFile, newFormFile);
        this.ide.tabs.reloadFromDisk(newFormFile);
        if (hasJs) {
            this.ide.renameTab(oldJsFile, newJsFile);
            this.ide.tabs.rewriteSource(newJsFile, retext);
        }

        this.ide.listFiles();
        this.ide.openInTab(newFormFile);
        this.ide.log(`Renamed ${oldFormFile} to ${newFormFile}\n`);
        return true;
    }

    /*
     * Rewrites the type of every control that places this class.  A form that
     * says "Widgets.Stepper" would silently stop finding it once the class moved
     * to another namespace, and the failure would surface as an empty control in
     * a running program rather than here.
     *
     * `skip` is the file just written, which is the class's own.
     */
    retypeForms(oldFull, newFull, skip) {
        if (oldFull === newFull) return [];
        const touched = [];

        for (const file of this.ide.files) {
            if (file === skip || !File.IsExtension(file, "form")) continue;

            const path = File.Join(this.ide.project, file);
            let root;
            try {
                root = File.LoadJson(path);
            } catch (e) {
                continue;      /* not ours to repair */
            }

            let changed = false;
            const walk = (nodes) => {
                for (const node of nodes || []) {
                    if (node.type === oldFull) {
                        node.type = newFull;
                        changed = true;
                    }
                    walk(node.children);
                }
            };
            walk(root.children);

            if (changed) {
                File.SaveJson(path, root);
                touched.push(file);

                /* Whatever is open has to be reloaded from disk, or saving that
                 * tab would put the old type back. */
                const state = this.ide.openTabs.get(file);
                if (state && state.mode === "design") state.root = root;
            }
        }
        return touched;
    }

    /* References from other files are left alone: warning is better than
     * blindly rewriting someone else's code. */
    warnDanglingReferences(oldName, newName) {
        const pattern = new Regex(`\\b${Regex.Escape(oldName)}\\b`);
        const guilty  = this.ide.files.filter((f) =>
            File.IsExtension(f, "js") &&
            File.BaseName(f) !== oldName &&
            pattern.IsMatch(File.Load(File.Join(this.ide.project, f))));

        if (guilty.length) {
            this.ide.log(`Ojo: ${guilty.join(", ")} todavia nombran a ${oldName}\n`);
            Message.Warning("These files still name {0}:\n{1}\n\nThey have to be updated by hand.",
                            oldName, guilty.join("\n"));
        }
    }

    renameFile(oldFile, target) {
        /* A bare name stays where it is: the prompt shows the file and not a
         * path, and nobody typing "notes.json" means "move it to the top". */
        const newFile = target.includes("/") ? target
                                             : inFolder(folderOf(oldFile), target);

        if (!File.Name(newFile).includes(".") ||
            newFile.split("/").slice(0, -1).some((part) => !FOLDER_NAME.IsMatch(part))) {
            Message.Error("\"{0}\" is not usable as a file name.", target);
            return false;
        }
        if (newFile === oldFile) return true;
        if (File.Exists(File.Join(this.ide.project, newFile))) {
            Message.Error("{0} already exists.", newFile);
            return false;
        }

        const intoFolder = folderOf(newFile);
        if (intoFolder) Directory.Make(File.Join(this.ide.project, intoFolder));

        File.Rename(File.Join(this.ide.project, oldFile),
                    File.Join(this.ide.project, newFile));
        this.ide.renameSource(oldFile, newFile);

        this.ide.renameTab(oldFile, newFile);
        this.ide.listFiles();
        this.ide.openInTab(newFile);
        this.ide.log(`Renamed ${oldFile} to ${newFile}\n`);
        return true;
    }

    /* --- tidying an existing project ----------------------------------------
     *
     * The convention -- `forms/`, `components/`, `modules/` -- arrived after
     * this IDE had already written a great many flat projects, and it only ever
     * applied to what was created *next*. So a project from before stayed as it
     * was: thirty-five files in one directory, which is the shape the convention
     * exists to prevent. This is the one-command answer.
     *
     * **Only what is at the root moves.** A file in a folder is where the
     * programmer put it, and moving it would be the IDE overruling that -- and
     * worse, `widgets/Stepper` is possibly `Widgets.Stepper`, so moving it would
     * rename the class. Everything else at the root stays too: `app.css`,
     * `project.json`, an image; the convention names three kinds of *class*
     * file, not a place for everything.
     *
     * It is a series of renames and not a new mechanism, which is what makes it
     * safe: `renameForm` already moves a pair, follows it in `sources`, and
     * rewrites every `.form` that places it; `renameFile` already moves a loose
     * one. A tidy that invented its own file moving would be a second
     * implementation of the hardest part of this file.
     */
    tidyPlan() {
        const plan = [];

        for (const file of this.ide.files) {
            if (folderOf(file)) continue;               /* somebody's own folder */

            const ext = File.Extension(file).toLowerCase();

            if (ext === "form") {
                const folder = this.ide.components.some((c) => c.file === file)
                    ? COMPONENT_DIR : FORM_DIR;
                plan.push({ file, pair: true,
                            to: inFolder(folder, File.BaseName(file)) });
            } else if (ext === "js" &&
                       !this.ide.files.includes(sibling(file, "form"))) {
                plan.push({ file, pair: false,
                            to: inFolder(MODULE_DIR, File.Name(file)) });
            }
        }
        return plan;
    }

    tidyProject() {
        if (!this.ide.project) {
            Message.Warning("Open a project before tidying it.");
            return;
        }
        /* The same refusal renaming makes, for the same reason: a file with
         * unsaved changes cannot be moved on disk without losing them. */
        if (this.ide.isDirty()) {
            Message.Warning("Save the changes before tidying the project.");
            return;
        }

        const plan = this.tidyPlan();
        if (!plan.length) {
            Message.Info("Nothing to tidy: every class is already in a folder.");
            return;
        }

        const lines = plan.map((m) => `${m.file}  ->  ${m.to}${m.pair ? " (+ .js)" : ""}`);
        ConfirmForm.ask("Tidy files into folders",
                        `${plan.length} of them will move:\n\n${lines.join("\n")}`,
                        "Tidy", () => this.tidy(plan));
    }

    tidy(plan) {
        let moved = 0;

        for (const move of plan) {
            /* A pair is moved by its *class*, which is what carries the `.form`
             * and the `.js` together and what every other `.form` names it by.
             * The name does not change: a folder a tool named is not a
             * namespace, so `Form1` stays `Form1`. */
            const ok = move.pair
                ? this.renameForm(this.ide.qualifiedName(move.file), move.to)
                : this.renameFile(move.file, move.to);

            if (ok) moved++;
            else break;         /* it has said why; going on would bury it */
        }

        this.ide.listFiles();
        this.ide.log(`Tidied ${moved} of ${plan.length} into folders\n`);
        return moved;
    }

    /* Careful: this deletes files.  The designer's one, which deletes a
     * control, is `ide.designer.deleteSelected()`. */
    deleteSelectedFile() {
        if (!this.ide.activeFile) return;

        const targets = this.ide.pairOf(this.ide.activeFile);
        ConfirmForm.ask("Delete from project",
                        `These will be deleted from disk:\n\n${targets.join("\n")}`,
                        "Delete", () => this.deleteFiles(targets));
    }

    /*
     * **To the trash when there is one.**
     *
     * Deleting is the operation with no way back, and every file manager on
     * every desktop answers that the same way: the file goes to the trash and
     * the person decides later. An IDE that offers *Delete* and means `unlink`
     * is harsher than the desktop it runs on -- and the file it takes is
     * somebody's afternoon.
     *
     * A trash lives on the filesystem the file is on, so a project on a stick,
     * on a share or on tmpfs has none; `File.Trash` says so instead of quietly
     * deleting, and *this* is where the decision belongs. What the console says
     * is which of the two happened, because "deleted" and "recoverable from the
     * desktop's trash" are not the same sentence to whoever changes their mind.
     */
    deleteFiles(targets) {
        let trashed = 0;

        for (const name of targets) {
            const path = File.Join(this.ide.project, name);
            if (File.Exists(path)) {
                try {
                    File.Trash(path);
                    trashed++;
                } catch (e) {
                    File.Delete(path);
                }
            }
            if (File.IsExtension(name, "js")) this.ide.dropSource(name);
        }

        /* Close the tabs of what was deleted before re-listing the tree. */
        for (const name of targets) this.ide.closeTabByName(name, /* force */ true);

        this.ide.warnMissingStartup();
        this.ide.listFiles();
        this.ide.log(trashed === targets.length
            ? `Moved to the trash: ${targets.join(", ")}\n`
            : `Deleted ${targets.join(", ")}\n`);
        return true;
    }

    /*
     * Carries the references to a renamed control over to the code.  Two precise
     * patterns instead of a global replace of the name:
     *
     *   this.Button1        ->  this.BtnSave        (access to the control)
     *   Button1_Click(...)  ->  BtnSave_Click(...)  (handler, declared or called)
     *
     * Since "_" counts as a word character, the first pattern does not tread on
     * the handlers, and neither of them touches a Button10 that merely shares a
     * prefix.  Returns how many references moved.
     */
    renameHandlers(formPath, oldName, newName) {
        const jsPath = File.Join(File.Directory(formPath),
                                 `${File.BaseName(formPath)}.js`);
        if (!File.Exists(jsPath)) return 0;

        const quoted  = Regex.Escape(oldName);
        const member  = new Regex(`\\bthis\\.${quoted}\\b`);
        const handler = new Regex(`\\b${quoted}_(\\w+)`);
        let   moved   = 0;

        /* Counted on the text the user is looking at: the file and the tab can
         * differ, and the log line is about what changed where they will read. */
        this.ide.tabs.rewriteSource(File.Relative(jsPath, this.ide.project), (source) => {
            moved = 0;
            source = member.Replace(source, () => {
                moved++;
                return `this.${newName}`;
            });
            return handler.Replace(source, (match) => {
                moved++;
                return `${newName}_${match.Group(1)}`;
            });
        });
        return moved;
    }

    /*
     * Opens a control's handler, creating it if it does not exist.  It is the
     * central gesture of a RAD: double click a button and you are writing what
     * it does, without having to remember the naming convention.
     */
    /*
     * Is that handler already written?  The same regular expression
     * `openHandler` uses to decide between jumping and writing, asked without
     * doing either -- which is what lets the Form menu say which of a control's
     * events are already answered.
     */
    hasHandler(controlName, eventName) {
        return new Regex(`\\b${Regex.Escape(`${controlName}_${eventName}`)}\\s*\\(`)
                   .IsMatch(this.siblingSource());
    }

    /*
     * What the `.js` beside the form being designed says **now**.
     *
     * The tab when it is open, and the file otherwise: a handler written a
     * moment ago and not yet saved is still a handler, and everything asking
     * this is asking in order not to be surprised by one.
     */
    siblingSource() {
        if (!this.ide.activeFile || !this.ide.project) return "";

        const jsName = sibling(this.ide.activeFile, "js");
        const state  = this.ide.openTabs.get(jsName);
        if (state && state.editor) return state.editor.Text;

        const jsPath = File.Join(this.ide.project, jsName);
        return File.Exists(jsPath) ? File.Load(jsPath) : "";
    }

    /*
     * Which events of that control the source answers.
     *
     * Static and taking the text, because the caller that matters walks a whole
     * pasted subtree asking about one name after another and reading the file
     * once is the difference between a lookup and a lot of I/O.
     *
     * Anchored at four spaces: a method of the class, which is where a handler
     * lives. `\b` alone would find `this.Button1_Click()` in a *call* and count
     * a name as answered because something mentioned it.
     */
    static handlersIn(source, controlName) {
        if (!source || !controlName) return [];

        const re = new Regex(
            `^ {4}(?:static\\s+|async\\s+)*${Regex.Escape(controlName)}_([A-Za-z][\\w$]*)\\s*\\(`,
            { Multiline: true });

        return re.Matches(source).map((match) => match.Group(1));
    }

    openHandler(controlName, eventName) {
        if (!this.ide.designing || !this.ide.activeFile) return false;

        const base   = File.BaseName(this.ide.activeFile);   /* the class's name */
        const jsName = sibling(this.ide.activeFile, "js");
        const jsPath = File.Join(this.ide.project, jsName);

        if (!File.Exists(jsPath)) {
            Message.Error("{0} does not exist, there is nowhere to write the handler.", jsName);
            return false;
        }

        /* The .js is about to be written: the .form has to be saved, or the two
         * files would end up describing different forms. */
        const state = this.ide.tabs.activeState();
        if (state && this.ide.liveDirty(state) && !this.ide.save()) return false;

        /*
         * **The open tab is the source, when there is one.** This used to read
         * the file, write the method into it and then `reloadFromDisk` the
         * tab -- which assigns the editor's `Text`, so whatever had been typed
         * into the `.js` and not saved was gone, and the undo history with it.
         * With the tab open the method goes into its editor as one insertion:
         * nothing typed is lost, Ctrl+Z takes the method back out, and a tab
         * that was clean is saved again so the file says what it did before.
         */
        const js     = this.ide.openTabs.get(jsName);
        const editor = js && js.editor ? js.editor : null;
        const wasDirty = editor ? this.ide.liveDirty(js) : false;

        const method = `${controlName}_${eventName}`;
        const source = editor ? editor.Text : File.Load(jsPath);
        const already = new Regex(`\\b${Regex.Escape(method)}\\s*\\(`);

        let line;
        const found = already.Match(source);
        if (found) {
            line = Text.LineOf(source, found.Index);
        } else {
            const written = insertMethod(source, base, method);
            if (!written) {
                Message.Error("Class {0} not found in {1}.", base, jsName);
                return false;
            }

            /* Synthesised code, checked before it lands: insertMethod works on
             * text, and a file the IDE broke is worse than a handler it did not
             * write.  Asking is not running -- CheckSource only compiles. */
            const bad = Application.CheckSource(written.source);
            if (bad) {
                Message.Error("Adding {0}() to {1} would break it:\n{2}", method, jsName, bad);
                return false;
            }

            if (editor) {
                const start  = source.lastIndexOf("\n", written.at - 1) + 1;
                const column = [...source.slice(start, written.at)].length + 1;

                editor.Select(Text.LineOf(source, written.at), column, 0);
                editor.Insert(written.snippet);
                /* A tab off screen answers `dirtyOf` from its copied flag. */
                js.dirty = true;
                if (!wasDirty) this.ide.tabs.saveAllDirty([jsName]);
            } else {
                File.Save(jsPath, written.source);
            }
            line = written.line;
            this.ide.log(`Added ${method}() to ${jsName}\n`);
        }

        this.ide.openInTab(jsName);
        this.ide.Editor.GotoLine(line);
        this.ide.Editor.SetFocus();
        this.ide.renderTabs();
        return true;
    }
};
