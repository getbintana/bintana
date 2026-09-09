/*
 * Bintana IDE -- written in Bintana, running on the Bintana runtime.
 *
 *   bintana ide                     opens empty
 *   bintana ide examples/hello      opens that project
 *
 * Everything this file needed and did not exist (Arrangement, Split,
 * SourceEditor, File, Dir, Exec, Dialog) was added to the runtime.  That is the
 * rule: the IDE has no privileges, it uses the same API as any application.
 *
 * What is left in *this* file is the window: the project it has open, the recent
 * list, `refresh` -- the one place that decides what is enabled and what the
 * status bar says -- and one line per control event.  A control's event is looked
 * up on the form (`bta_emit` asks `form.BtnRun_Click`), so every handler has to
 * be a method of `MainForm` and cannot live anywhere else; what it can do is
 * hand the work to whoever owns the subject:
 *
 *   Classes       what the project holds, and what each class is called
 *   ProjectTree   ...as the file tree shows it
 *   FormFiles     creating, renaming and deleting a form, and writing its code
 *   TabSet        the open files, each page owning its editor or its canvas
 *   Designer      the form designer (and the three panels beside it)
 *   Finder        the find bar
 *   Runner        running the project, and reading what it printed
 *   Manifest      project.json, and everything that writes to it
 *
 * The one-line delegations below are that surface: they are what the helpers call
 * each other through, and what `tests/ide` drives by name.
 */
"use strict";

/*
 * A place, as a traceback writes one: `at Boom_Click (/path/Form1.js:42:30)`.
 *
 * One string for the two who need it -- the console, which makes text matching
 * it clickable, and the parser that reads a click back -- because a pattern that
 * highlights what the parser cannot read is a link that does nothing.  Basic
 * enough to mean the same thing to PCRE2 and to JavaScript.
 */
const SOURCE_LINK = "[\\w./+-]+\\.(?:js|form|json):\\d+";

/* The stylesheet a new project starts with: how the application looks, in the
 * one place that answers for it.  A control wears a class from here by setting
 * Style; Background, Foreground and Font on a control are the exception. */
const APP_CSS = `/*
 * <project>/app.css -- the application's own look.
 *
 * A class here is worn by setting Style on a control ("danger", or "card title"
 * for more than one).  The desktop's theme already declares plenty of them --
 * suggested-action, destructive-action, title-1, heading, dim-label, monospace,
 * flat -- so a control can be dressed before anything is written here.
 */

/* .danger {
 *     background-color: #c01c28;
 *     color: #ffffff;
 * }
 *
 * .danger:hover {
 *     background-color: #e01b24;
 * }
 */
`;

/*
 * What a console project starts as.
 *
 * A project that declares `main` opens no window and never touches the display,
 * so it gets neither a form nor an `app.css`: a stylesheet for a program with
 * nothing on screen would be a file that can only ever be wrong. What it gets is
 * the one function the runtime will call, and a line saying what the shape is
 * for -- the same job `Form1` does for a project that draws.
 */
const MAIN_JS = `/*
 * <project>/Main.js -- a console project: no window, no display.
 *
 * The runtime calls Main() once the sources are loaded and the program ends when
 * nothing is left to answer for: no child running, no timer armed, no file
 * watched.  Application.Quit(code) ends it with a status.
 */
"use strict";

function Main() {
    print("Hello from " + Application.Name);
}
`;

/* The tab strip's action button, in order of preference: the first the desktop
 * really has wins.  See dressTabActions. */
const TAB_ACTION_ICON = [
    "view-more-symbolic", "open-menu-symbolic",
    "document-properties-symbolic", "pan-down-symbolic",
];

/* How many projects the "Recent projects" menu remembers.  Where they are kept
 * is Settings' business, and Settings is per application, so the IDE's list
 * never collides with any other project's (nor with the tests'). */
const RECENT_MAX = 8;
const RECENT_KEY = "recent";

/*
 * What marks an entry of *Write handler*.  Two characters wide either way, so the
 * event names line up in a column -- the same reason `PoForm`'s marks are.
 * Written means choosing it goes there; the rest are a method that does not exist
 * yet, and choosing one writes it.
 */
const HANDLER_WRITTEN = "\u2022 ";   /* • already in the .js */
const HANDLER_NEW     = "  ";
/*
 * What *Write handler* reads with nothing selected, and what *Recent projects*
 * reads with nothing in it: **the literal goes at the call site**, inside
 * `Locale.Text`, and not into a `const` here.
 *
 * Two reasons, and the second is the one that bites. A `const` is evaluated once
 * at load while the catalogue is chosen per run -- and even wrapped, a
 * `Locale.Text(SOME_CONST)` hands the extractor a *variable*, so nothing is
 * collected and the string is untranslatable exactly as a template literal would
 * be. `RECENT_EMPTY` was that: a bare literal in a const, and "(none yet)" is in
 * no catalogue.
 */

/*
 * The two things the window can be, as pages of `Pages` -- a `Switcher` with no
 * strip, which is a bare stack: one of them on screen and nothing to click
 * between them.
 *
 * Before there was a welcome page, an IDE with no project open was the whole
 * workspace with nothing in it: an empty tree, a dead toolbar, a tab strip of no
 * tabs, and a line in the console asking the user to open something. What a
 * window with nothing to show should show is what it can *do*, which is three
 * things -- open one, start one, or go back to one.
 */
const PAGE_WELCOME = 0;
const PAGE_WORK    = 1;


class MainForm extends Form {

    /*
     * The helpers this window is made of, as fields and not as `Form_Open`.
     *
     * A control's event can arrive as early as the .form *loading* -- the
     * Notebook fires Switch when a page is added -- which is before `Form_Open`
     * runs, and a handler that reached for a helper that was not there yet blew
     * up.  A field initialiser runs at construction, so every one of these is
     * there before any event can be.  None of them touches a widget to be
     * built, which is what makes that safe.
     */
    finder    = new Ide.Finder(this);        // the find bar
    runner    = new Ide.Runner(this);        // running the project, and its output
    manifest  = new Ide.Manifest(this);      // project.json
    classes   = new Ide.Classes(this);       // what the project holds, and its names
    projectTree = new Ide.ProjectTree(this); // ...as the file tree shows it
    formFiles = new Ide.FormFiles(this);     // creating, renaming, deleting one
    strings   = new Ide.Strings(this);       // what the project shows, extracted
    catalogues = new Ide.Translations(this); // the .po files, and msgmerge
    exporter  = new Ide.Exporter(this);      // the project tree as one .tar
    tabs      = new Ide.TabSet(this);        // the open files
    completion = new Ide.Completion(this);   // what the editor proposes
    /* The palette is one widget for every open form, so it is the window's and
     * not a designer's: what it offers is the project's components, and the
     * designer on screen only says which tool is marked. */
    palette   = new Ide.Palette(this);

    /*
     * The catalogue the left button last selected, or null.
     *
     * The tree's menu acts on the file that is **open**, because a right click
     * does not move a TreeView's selection and an item aiming at the row it was
     * opened over would act on whichever row was selected last. A catalogue is
     * never open -- no tab holds one -- so it needs a word of its own, and this
     * is it: still *select then ask*, still only ever what the left button
     * pointed at, and it can never be confused with the open file.
     *
     * A class field because `refresh()` reads it, and `refresh()` runs on the
     * welcome page where nothing has selected anything.
     */
    selectedCatalogue = null;

    /* The image the left button last pointed at, for the same reason and with
     * the same shape: a class field because `refresh()` runs on the welcome
     * page, where nothing has ever been selected. */
    selectedImage = null;

    /* And the one that is neither: something the files view showed and no
     * editor here can hold. */
    selectedOther = null;

    /* Defaults, for the same reason: an event can arrive before Form_Open. */
    project = null;
    recent = [];
    muted = false;
    running = false;
    designing = false;

    /* The file the window is showing, which every helper reads and only `TabSet`
     * writes.  Null with nothing open, and that is not the same as no project. */
    activeFile = null;

    /* The events *Write handler* is currently offering, in the order its entries
     * are in. A class field because `refresh()` fills it and `refresh()` runs on
     * the welcome page, where nothing has ever been selected. */
    handlerEvents = [];

    Form_Open() {
        this.dressTabActions();
        this.dressViews();
        /* An error in the console names a line, and a line is somewhere to go. */
        this.Console.LinkPattern = SOURCE_LINK;
        this.renderTabs();          /* no pages yet: no strip either */
        this.setMode(false);        /* ...and so no editor nor designer either */
        this.loadRecent();

        const arg = Application.Arguments[0];
        if (arg) {
            this.openProject(arg);
        } else {
            /* The welcome page says the rest; the console keeps the version,
             * which is the one thing it says that a button cannot. */
            this.log(`Bintana ${BTA_VERSION}\n`);
            this.Pages.Current = PAGE_WELCOME;
            this.refresh();
        }
    }

    /*
     * The tab strip's action menu is declared in MainForm.form, on the notebook
     * itself, with `"strip": "End"` -- so the IDE's own window says what is in
     * its tab strip the same way it says everything else, and the IDE can open
     * and save that file without losing it.  Which is the whole premise.
     */
    /* The button opens what it carries: a click and a right click on it are the
     * same question. */
    TabActions_Click() { this.TabActions.PopupMenu(0, 0); }

    MnuTabClose_Click()   { this.closeActiveTab(); }
    MnuTabAll_Click()     { this.closeAllTabs(); }
    MnuTabSaveAll_Click() { this.saveAllDirty(); }

    MnuTabOthers_Click() {
        const keep = this.activeFile;
        for (const name of [...this.tabOrder])
            if (name !== keep) this.closeTabByName(name, true);
    }

    /* ------------------------------------------------------------- project */

    openProject(dir) {
        if (!File.IsDir(dir)) {
            Message.Error("No such directory:\n{0}", dir);
            return;
        }
        /* Absolute from here on: when running, the child starts with the
         * project directory as its cwd, and a relative path would stop
         * resolving from there. */
        dir = File.Absolute(dir);
        if (!File.Exists(File.Join(dir, "project.json"))) {
            Message.Warning("{0} has no project.json.\nIt can still be edited, but it will not be able to run.", File.Name(dir));
        }

        this.project = dir;
        this.closeAllTabs();
        this.Text = Locale.Text("Bintana IDE -- {0}", File.Name(dir));

        /* The workspace is what a project looks like; nothing takes the window
         * back to the welcome page, because nothing closes a project. */
        this.Pages.Current = PAGE_WORK;

        this.listFiles();
        this.rememberRecent(dir);
        this.log(`Project: ${dir}\n`);
        this.reportProject();
    }

    /* --------------------------------------------------------- recent list
     *
     * The list is saved in Application.ConfigDirectory and read back at startup, so it
     * survives closing the IDE -- which is the whole point of having it.
     */

    loadRecent() {
        const saved = Settings.Get(RECENT_KEY, []);

        /* A project that is gone drops off the list silently: the menu offers
         * only what can be opened. */
        this.recent = (Array.isArray(saved) ? saved : [])
            .filter((dir) => typeof dir === "string" && File.IsDir(dir))
            .slice(0, RECENT_MAX);

        this.showRecent();
    }

    /* Most recent first, no duplicates: opening something already on the list
     * moves it to the top instead of repeating it. */
    rememberRecent(dir) {
        this.recent = [dir, ...this.recent.filter((d) => d !== dir)].slice(0, RECENT_MAX);
        this.showRecent();

        /* Failing to write the list down cannot stop the project from opening:
         * what is lost is the memory, not the work. */
        if (!Settings.Set(RECENT_KEY, this.recent)) {
            this.log("Could not save the recent list.\n");
        }
    }

    /*
     * *Form -> Write handler*: every event the selected control raises, asked of
     * the control itself (`EventNames()`).  The head of that list is what a
     * double click writes; the rest were reachable only by typing the method name
     * by hand and hoping it was spelled the way the runtime dispatches.
     *
     * One already written is **marked and jumped to** rather than written twice,
     * which is what `openHandler` was already doing -- this only says so before
     * the click instead of after it.
     */
    showHandlers(picked) {
        const control = picked ? this.designer.selected : null;
        const events  = control ? this.designer.eventsOf(control) : [];

        this.MnuHandler.Items = events.length
            ? events.map((e) => (this.hasHandler(control.Name, e)
                                     ? `${HANDLER_WRITTEN}${e}` : `${HANDLER_NEW}${e}`))
            : [Locale.Text("(select a control)")];
        this.MnuHandler.Enabled = events.length > 0;

        /* What the indices mean, kept beside them: the labels carry a mark, so
         * the entry chosen is not the event's name. */
        this.handlerEvents = events;
    }

    showRecent() {
        const empty = this.recent.length === 0;

        /* The project's name and, dimmer, the folder it lives in: two projects
         * can share a name, and the name alone is not enough to choose. */
        const entries = this.recent.map((d) => `${File.Name(d)}  —  ${File.Directory(d)}`);

        this.MnuRecent.Items   = empty ? [Locale.Text("(none yet)")] : entries;
        this.MnuRecent.Enabled = !empty;

        /* The same list, on the welcome page.  One place decides what is in it,
         * so the menu and the page cannot disagree about what was opened last --
         * and the page is where it is worth having, since the menu is two clicks
         * away from a window that has nothing else to offer. */
        this.WelcomeRecent.Items = empty ? [Locale.Text("(none yet)")] : entries;
        this.LblWelcomeRecent.Visible = !empty;
        this.WelcomeRecent.Enabled    = !empty;
    }

    /*
     * The button at the end of the tab strip, which is the only way to reach
     * *Close others* and *Save all*.
     *
     * Its icon is chosen here and not written into the `.form`, because a `.form`
     * can only name one and a name the desktop lacks is dropped in silence: this
     * button came out blank on a machine whose theme is elementary-xfce, which
     * ships `view-more-symbolic` as a file GTK renders to nothing. And if none of
     * them resolve it gets a glyph instead, because a button with neither icon
     * nor text is a blank square nobody can find -- which is the state this was
     * in twice.
     */
    dressTabActions() {
        this.TabActions.Icon = TAB_ACTION_ICON.find((n) => Application.HasIcon(n)) || "";
        if (!this.TabActions.Icon) this.TabActions.Text = "⋯";   /* ⋯ */
    }

    /* ------------------------------------------------------- the file listing
     *
     * What the project holds is `Classes`'s and how the tree shows it is
     * `ProjectTree`'s.  Reading the project again and rebuilding the tree is one
     * gesture, and this is it: everything that changes a file on disk ends here.
     */
    listFiles() {
        this.classes.rescan();
        /* A control renamed, a form created or deleted: what the completion
         * would propose is a different answer now. */
        this.completion.forget();
        this.projectTree.build();

        /* What the palette offers changes with the project, so it is set from
         * the same scan that lists its files -- for every form open, since each
         * has a designer of its own and any of them may be switched to. */
        for (const st of this.openTabs.values())
            if (st.designer) st.designer.setComponents(this.components);

        this.refresh();
    }

    /* What the last listing found.  The window is what the rest of the IDE and
     * `tests/ide` ask, and `Classes` is what answers. */
    get files()        { return this.classes.files; }
    get components()   { return this.classes.components; }
    get startupClass() { return this.classes.startupClass; }
    get byKey()        { return this.projectTree.byKey; }

    treeIcon(kind)  { return this.projectTree.icon(kind); }

    /* --- the project's classes ----------------------------------------------
     *
     * All of it is `Classes`: what the project has, and what each class is
     * called once a namespace is in play.  These read as the window's own and
     * `tests/ide` drives them by name, which is why they stay in sight here.
     */
    qualifiedName(file) { return this.classes.qualifiedName(file); }
    classNames()        { return this.classes.names(); }
    classExists(name)   { return this.classes.exists(name); }
    formOfClass(name)   { return this.classes.formOfClass(name); }
    componentsInProject() { return this.classes.componentsInProject(); }

    /* A form is two files that travel together; everything else travels alone. */
    pairOf(file)     { return this.classes.pairOf(file); }
    isFormPair(file) { return this.classes.isFormPair(file); }
    formOf(file)     { return this.classes.formOf(file); }

    /* What a new class would be called, and whether it should join a namespace
     * named after its folder. */
    suggestFormName(stem)      { return this.classes.suggestName(stem); }
    namespaceDefault(folder)   { return this.classes.namespaceDefault(folder); }
    namespaceOption(suggested) { return this.classes.namespaceOption(suggested); }
    /* The namespace the classes in a folder are in, read from their code -- never
     * from the folder's name. See the note above `namespaceHere`. */
    namespaceHere(folder)      { return this.classes.namespaceHere(folder); }

    /*
     * The folder chooser only lets one pick a folder that already exists, so the
     * directory had to be created outside the IDE.  Now it asks for the name and
     * the base folder, and the IDE creates the folder.
     */
    newProject() {
        const base = this.project ? File.Directory(this.project) : Application.Directory;

        NewProjectForm.ask(base, (info) =>
            this.startProject(File.Join(info.base, info.name), info.description,
                              info.console));
    }

    startProject(path, description, console) {
        if (File.Exists(path) && !File.IsDir(path)) {
            Message.Error("{0} already exists and is not a folder.", File.Name(path));
            return false;
        }

        Directory.Make(path);
        return this.createProject(path, description, console);
    }

    createProject(dir, description, console) {
        if (File.Exists(File.Join(dir, "project.json"))) {
            Message.Error("{0} is already a project.", File.Name(dir));
            return false;
        }

        /* Through the record, so a new manifest is one the runtime would open --
         * and with no description the key is simply not written, since a field
         * left at what it starts from is not a decision worth recording. */
        /*
         * **It starts in `forms/`**, the shape a project would be tidied into
         * later anyway -- and starting there is what keeps it from being a
         * special case that only new files follow. The class is still `Form1`:
         * the runtime finds a form by name wherever the file is, and a folder is
         * a namespace only where somebody asked for one.
         */
        if (console) return this.createConsoleProject(dir, description);

        const first = inFolder(FORM_DIR, "Form1");

        const config = new Ide.ProjectFile({
            Name:        File.Name(dir),
            Startup:     "Form1",
            Sources:     [`${first}.js`],
            Description: description || "",
        });

        File.SaveJson(File.Join(dir, "project.json"), config);

        /* A project starts with a stylesheet, empty but for what it is for.
         * The runtime finds app.css by name, so an existing project gets one by
         * dropping the file in -- but a new one should not have to be told that
         * the file may exist: how an application looks is a decision it makes
         * once, in one place, and the place has to be there to be found. */
        File.Save(File.Join(dir, "app.css"), APP_CSS);

        /* writeForm writes inside this.project, so it has to point there
         * before the project is formally opened -- and it decides whether a
         * class name is free by what the project has, which is the new
         * directory and not the one still open. */
        this.project = File.Absolute(dir);
        this.classes.rescan();
        if (!this.writeForm(first)) return false;

        this.openProject(dir);
        this.openInTab(`${first}.form`);
        return true;
    }

    /*
     * A project with no window: `main`, one source, and nothing else.
     *
     * No form, and **no app.css** -- how an application looks is a decision a
     * program with nothing on screen does not have to make. The file sits at the
     * root rather than in a folder: `forms/` is where a form goes because a
     * project grows several, and a `main` is one function in one place.
     */
    createConsoleProject(dir, description) {
        const config = new Ide.ProjectFile({
            Name:        File.Name(dir),
            Main:        "Main",
            Sources:     ["Main.js"],
            Description: description || "",
        });

        File.SaveJson(File.Join(dir, "project.json"), config);
        File.Save(File.Join(dir, "Main.js"), MAIN_JS);

        this.project = File.Absolute(dir);
        this.classes.rescan();

        this.openProject(dir);
        this.openInTab("Main.js");
        return true;
    }












    /* --------------------------------------------------------- project.json */

    /*
     * The manifest is `Manifest`, and every write to it goes through its one
     * funnel.  What stays here is the surface other things reach for: `tests/ide`
     * drives these by name, and the callers below read better saying what they
     * mean than saying `this.manifest` twice a line.
     */
    withConfig(mutate)  { return this.manifest.update(mutate); }
    registerSource(f)   { this.manifest.registerSource(f); }
    renameSource(a, b)  { this.manifest.renameSource(a, b); }
    dropSource(f)       { this.manifest.dropSource(f); }
    renameStartup(a, b) { this.manifest.renameStartup(a, b); }
    warnMissingStartup() { this.manifest.warnMissingStartup(); }
    reportProject()     { this.manifest.report(); }
    editProject()       { this.manifest.editSettings(); }

    /* --- creating, renaming and deleting ------------------------------------
     *
     * All of it is `FormFiles`, which knows that a form is two files: what stays
     * here is the surface, since a menu item and `tests/ide` both ask the window.
     */
    newForm()      { this.formFiles.newForm(); }
    newComponent() { this.formFiles.newComponent(); }
    newModule()    { this.formFiles.newModule(); }
    tidyProject()  { this.formFiles.tidyProject(); }
    tidyPlan()     { return this.formFiles.tidyPlan(); }
    tidy(plan)     { return this.formFiles.tidy(plan); }
    createModule(name, useNs) { return this.formFiles.createModule(name, useNs); }
    writeForm(where, kind, useNs) { return this.formFiles.writeForm(where, kind, useNs); }
    createForm(name, kind, useNs) { return this.formFiles.createForm(name, kind, useNs); }

    renameSelectedFile()          { this.formFiles.renameSelectedFile(); }
    renameForm(oldClass, target)  { return this.formFiles.renameForm(oldClass, target); }
    renameFile(oldFile, target)   { return this.formFiles.renameFile(oldFile, target); }
    deleteSelectedFile()          { this.formFiles.deleteSelectedFile(); }
    deleteFiles(targets)          { return this.formFiles.deleteFiles(targets); }

    /* Renaming a control carries its handlers along, and double clicking one
     * writes the handler that is not there yet: both edit the class's source,
     * which is why the designer asks the window for them. */
    renameHandlers(formPath, oldName, newName) {
        return this.formFiles.renameHandlers(formPath, oldName, newName);
    }
    openHandler(controlName, eventName) {
        return this.formFiles.openHandler(controlName, eventName);
    }
    hasHandler(controlName, eventName) {
        return this.formFiles.hasHandler(controlName, eventName);
    }

    /* --- tabs ----------------------------------------------------------------
     *
     * The open files are `TabSet`'s: a page per file, each owning its own editor
     * or its own canvas.  What stays here is the surface the rest of the IDE and
     * `tests/ide` reach for by name, and the notebook's own event -- a control's
     * events are looked up on the form, so `Tabs_Switch` cannot live anywhere
     * else.
     */
    get openTabs() { return this.tabs.openTabs; }
    get tabOrder() { return this.tabs.tabOrder; }

    openInTab(name)      { return this.tabs.open(name); }
    switchToTab(name)    { this.tabs.switchTo(name); }
    closeActiveTab()     { this.tabs.closeActive(); }
    closeAllTabs()       { this.tabs.closeAll(); }
    closeTabByName(n, f) { this.tabs.closeByName(n, f); }
    renameTab(from, to)  { this.tabs.rename(from, to); }
    cycleTab(direction)  { this.tabs.cycle(direction); }
    renderTabs()         { this.tabs.render(); }
    setMode(designing)   { this.tabs.setMode(designing); }
    save()               { return this.tabs.save(); }
    saveAllDirty()       { this.tabs.saveAllDirty(); }
    liveDirty(state)     { return this.tabs.liveDirty(state); }

    /* Whether the *active* tab has unsaved changes; `hasDirtyTabs` asks about
     * every one of them, which is what Save all reads. */
    isDirty()      { return this.tabs.isDirty(); }
    hasDirtyTabs() { return this.tabs.hasDirty(); }
    dirtyNames()   { return this.tabs.dirtyNames(); }

    /*
     * --- quitting with unsaved work ---------------------------------------
     *
     * `Form_Close` is *asked*, and returning true keeps the window open: the X,
     * Quit and Ctrl+Q all end up here, so there is one place that decides and no
     * way out of the IDE that skips it.
     *
     * Answering is what the dialog does, and it cannot answer from here --
     * nothing in this runtime blocks -- so the shape is: veto now, and quit from
     * the answer.  `Application.Quit` and not `Close()` on the way out, because
     * quitting the main loop asks nobody: a second trip through this handler
     * would be a second dialog for a question already answered.
     */
    Form_Close() {
        return this.confirmQuit();
    }

    /*
     * Whether quitting has to wait for an answer.  What comes back is the
     * question that was put up, or null when there was nothing to ask -- truthy
     * either way, which is what both callers read, and a handle on the dialog
     * for whoever is driving the IDE rather than using it.
     */
    confirmQuit() {
        const dirty = this.dirtyNames();
        if (!dirty.length) return null;

        const list = dirty.join(", ");
        return ConfirmForm.ask(
            Locale.Text("Quit"),
            Locale.Plural("{1} has unsaved changes.",
                          "{0} files have unsaved changes:\n{1}",
                          dirty.length, list),
            Locale.Text("Quit without saving"),
            () => Application.Quit(0),
            { Text: Locale.Text("Save all and quit"),
              Run:  () => { this.saveAllDirty(); Application.Quit(0); } });
    }

    /* The Notebook fires Switch while the .form is still loading, when no tab
     * has been opened yet: there is nothing at that index and nothing to do. */
    Tabs_Switch(index) {
        const name = this.tabOrder[index];
        if (name) this.tabs.switchTo(name);
    }

    /* Opening a file *by name*, which is what the tree's own selection does:
     * the row is marked and the tab follows. */
    openNamed(name) {
        if (!this.FileTree.Exists(name)) return;
        this.muted = true;
        this.FileTree.Key = name;
        this.muted = false;
        this.openInTab(name);
    }


    /* -------------------------------------------------------------- correr */

    /* Running the project, and what its output names, are `Runner`'s.  `log`
     * stays here: it is what the whole IDE writes with. */
    run() { this.runner.start(); }

    /* A terminal wants CRLF; the rest of the program thinks in \n. */
    log(text) {
        this.Console.Feed(text.replace(/\n/g, "\r\n"));
    }


    /* ---------------------------------------------------------------- vista */

    /* One single place decides what is enabled and what the status bar says, so
     * no handler can leave the UI in an inconsistent state. */
    refresh() {
        const dirty   = this.isDirty();
        const open    = this.project !== null;
        const design  = this.designing;
        const picked  = design && this.designer.selected !== null;

        this.BtnSave.Enabled   = dirty;
        this.BtnReload.Enabled = open;
        this.BtnRun.Enabled    = open && !this.running;
        this.BtnStop.Enabled   = this.running;

        /* A disabled item loses its accelerator too, so this is all it takes for
         * Ctrl+S not to fire when there is nothing to save. */
        this.MnuSave.Enabled   = dirty;
        this.MnuSaveAll.Enabled = this.hasDirtyTabs();
        this.MnuReload.Enabled = open;
        this.MnuRun.Enabled    = open && !this.running;
        this.MnuStop.Enabled   = this.running;
        this.MnuNewForm.Enabled = open;
        this.MnuRename.Enabled  = this.activeFile !== null;
        this.MnuDelete.Enabled  = this.activeFile !== null;
        this.MnuCloseTab.Enabled = this.activeFile !== null;
        this.MnuAdd.Enabled    = design;
        this.showHandlers(picked);
        /*
         * `ActDelCtl`, `ActRaise` and `ActLower` are **not** set here any more:
         * they are commands, and `Designer.refresh` owns whether a command that
         * acts on a selection is available. This block used to compute the same
         * thing with a different expression, in a different file.
         */

        /* Aligning needs something to align against: at least two. */
        const many = design && this.designer.selection.length > 1;
        for (const item of [this.MnuAlignLeft, this.MnuAlignRight,
                            this.MnuAlignTop, this.MnuAlignBottom,
                            this.MnuSameWidth, this.MnuSameHeight]) {
            item.Enabled = many;
        }

        /* Distributing shares the gap between the outer two: it needs three. */
        const spread = design && this.designer.selection.length > 2;
        this.MnuSpreadH.Enabled = spread;
        this.MnuSpreadV.Enabled = spread;
        this.MnuUndo.Enabled = design ? this.designer.canUndo()
                                      : !!this.Editor && this.Editor.CanUndo;
        this.MnuRedo.Enabled = design ? this.designer.canRedo()
                                      : !!this.Editor && this.Editor.CanRedo;

        /* The tree's own menu speaks about the file that is open, so its state is
         * decided here with everything else that does. */
        this.MnuFtStartup.Enabled = this.formOf(this.activeFile) !== null;
        this.MnuFtRename.Enabled  = this.activeFile !== null;
        this.MnuFtDelete.Enabled  = this.activeFile !== null;
        /* Editing is for a translation; starting one is for the template. The
         * two are never both about the same file. */
        const cat = this.selectedCatalogue;
        this.MnuFtTranslate.Enabled       = cat !== null && !Ide.Translations.isTemplate(cat);
        this.MnuFtNewTranslation.Enabled  = cat !== null && Ide.Translations.isTemplate(cat);
        this.MnuFtTranslateWith.Enabled   = cat !== null;
        this.MnuTranslationNew.Enabled    = open;
        this.MnuFtProject.Enabled = open;
        this.MnuProjectSettings.Enabled = open;
        this.MnuExport.Enabled = open;

        /* Searching needs text: a form tab is a tree, and Ctrl+F loses its
         * accelerator along with the item rather than doing nothing on it. */
        const searchable = !!this.Editor;
        this.MnuComplete.Enabled = searchable;
        this.MnuFind.Enabled     = searchable;
        this.MnuReplace.Enabled  = searchable;
        this.MnuFindNext.Enabled = searchable;
        this.MnuFindPrev.Enabled = searchable;

        /* The clipboard items are the designer's: with a code tab up they have to
         * be *disabled*, or their accelerators would take Ctrl+C and Ctrl+V away
         * from the editor that is supposed to answer them. Paste is offered
         * whenever a form is being designed, since what the clipboard holds is
         * an answer that only arrives after asking for it. */
        this.MnuCut.Enabled       = picked;
        this.MnuCopy.Enabled      = picked;
        this.MnuDuplicate.Enabled = picked;
        this.MnuPaste.Enabled     = design;

        /* Find in project asks the *files* and not the tab, so what it needs is
         * a project and not an editor -- which is the whole point of it: looking
         * for a name across a project one has just opened is exactly when
         * nothing is up yet. */
        this.MnuFindAll.Enabled = open;

        let status;
        if (!this.project) {
            status = Locale.Text("No project");
        } else if (this.selectedCatalogue) {
            /* Selecting a catalogue opens nothing, so without this the click
             * appears to do nothing at all -- which is worse than either opening
             * it or leaving it alone. The bar is where the gesture is named. */
            status = Locale.Text("{0}   double click to edit", this.selectedCatalogue);
        } else if (!this.activeFile) {
            status = Locale.Plural("{0} file", "{0} files", this.files.length);
        } else {
            status = `${this.activeFile}${dirty ? " *" : ""}`;
            if (this.designing) {
                const sel = this.designer.selected;
                /* With nothing selected the form is what is being edited, so
                 * its size is what the bar should say -- which is also what
                 * makes dragging the border legible while it happens. */
                const size = this.designer.formSize();
                status += sel
                    ? `   ${sel.Name} (${sel.X}, ${sel.Y}) ${sel.Width}x${sel.Height}` +
                      this.designer.overflowNote(sel)
                    : Locale.Text("   form {0}x{1}", size.w, size.h);
            } else {
                if (this.Editor)
                    status += Locale.Text("   Ln {0}, Col {1}", this.Editor.Line, this.Editor.Column);
            }
        }
        this.LblStatus.Text = status;
    }

    /* -------------------------------------------------------------- eventos */

    BtnOpen_Click() {
        Dialog.SelectFolder("Open a Bintana project", (dir) => this.openProject(dir));
    }

    /* --- the welcome page -------------------------------------------------
     *
     * The same three commands the toolbar and the menu already carry: this page
     * exists because a window with no project has nowhere else to put them, not
     * because they are different commands here.
     */
    BtnWelcomeOpen_Click() { this.BtnOpen_Click(); }
    BtnWelcomeNew_Click()  { this.newProject(); }

    /*
     * A row opens what it names.  The selection is dropped afterwards, or
     * choosing the same project a second time would select what is already
     * selected -- which GTK, rightly, does not report as a change.
     */
    WelcomeRecent_Select() {
        const index = this.WelcomeRecent.Index;
        const dir   = index >= 0 ? this.recent[index] : null;

        this.WelcomeRecent.Index = -1;
        if (!dir) return;

        /* Gone since the list was written: it drops off rather than being
         * offered again, which is what loadRecent does at startup. */
        if (!File.IsDir(dir)) {
            this.recent = this.recent.filter((d) => d !== dir);
            this.showRecent();
            Message.Warning("{0}\nis not there any more.", dir);
            return;
        }
        this.openProject(dir);
    }

    BtnReload_Click() {
        if (this.project) this.listFiles();
    }

    BtnSave_Click() {
        this.save();
    }

    BtnRun_Click() {
        this.run();
    }

    BtnStop_Click() {
        this.Console.Stop();
    }

    Console_Exit(code) { this.runner.finished(code); }
    Console_Link(text) { this.runner.clicked(text); }

    /* Both delegate to `Runner`, and these two are here because `tests/ide`
     * drives them by name -- as good a reason as a handler's. */
    errorLocation(text)   { return this.runner.errorLocation(text); }
    findErrorLine(tries)  { return this.runner.findErrorLine(tries); }
    openSource(path, line) { return this.runner.open(path, line); }

    /* The designer's control tree: the other way to select something, and the
     * only one for a control the canvas cannot offer -- behind another, or in a
     * container too small to aim at. */
    WidgetTree_Select() {
        if (this.designing) this.designer.tree.selectFromKey(this.WidgetTree.Key);
    }

    WidgetTree_Activate() {
        if (this.designing) this.designer.tree.renameFromKey(this.WidgetTree.Key);
    }

    /*
     * The property grid's design-value switch.
     *
     * It needs no guard against the grid's own writes: `setDesignMode` returns at
     * once when the mode already matches, and filling the switch in from
     * `adopt()` can only ever match.  Which is the same rule the rest of this
     * file settled on -- an edit that changes nothing is not an edit -- rather
     * than a flag that has to be up at the right moment.
     */
    PropDesign_Click() {
        if (this.designing && this.designer) {
            this.designer.grid.setDesignMode(this.PropDesign.Active);
        }
    }

    /*
     * The grid's filter box. A view setting and not an edit, so it is kept on
     * the grid and survives selecting another control -- one looks for `Margin`
     * and then walks the form with it still typed.
     */
    PropFind_Change() {
        if (this.designer) this.designer.grid.setFilter(this.PropFind.Text);
    }

    /*
     * Which of the grid's rows the filter lets through, asked of us by GTK.
     *
     * A method here and not a handler the grid installs on us, unlike
     * `Prop_<Key>_Change`: those belong to editors that are built and thrown away,
     * and this one is about a widget that is always there. It delegates to
     * whichever designer is showing, exactly as `PropFind_Change` does -- one
     * panel, one selection, whoever's tab is up.
     */
    PropGrid_Filter(control, index) {
        return this.designer ? this.designer.grid.rowVisible(index) : true;
    }

    /* --- the project tree's menu -------------------------------------------
     *
     * Declared on the tree in MainForm.form, like every other context menu here,
     * and dispatching as Name_Click like every other item.  What it carries is
     * what one comes to the tree to do beyond opening a file -- which the left
     * button already does, and is why there is no *Open* on it.
     *
     * Every item acts on the file that is **open**, exactly as the File menu's own
     * Rename and Delete do.  See `setStartupForm` for why that is not merely a
     * matter of consistency.
     */
    MnuFtStartup_Click() { this.manifest.setStartupForm(); }
    MnuFtRename_Click()  { this.renameSelectedFile(); }
    MnuFtDelete_Click()  { this.deleteSelectedFile(); }
    MnuFtProject_Click() { this.editProject(); }

    MnuProjectSettings_Click() { this.editProject(); }

    /*
     * Under Project rather than File for the reason Update translations is: it
     * is the whole project's answer, and a File menu acting on the tree instead
     * of on the open file would be two meanings on one menu.
     */
    MnuTidy_Click()   { this.tidyProject(); }
    MnuExport_Click() { this.exporter.run(); }

    /*
     * Extraction: every string the project shows a person, into po/<name>.pot,
     * and msgmerge over whatever catalogues are there.
     *
     * Under Project and not Form because it is the whole project's answer -- a
     * .pot gathered from one open form would be a catalogue with most of the
     * application missing.
     */
    MnuTranslations_Click() {
        if (!this.project) {
            Message.Info("Open a project first.");
            return;
        }
        this.catalogues.update();
    }

    FileTree_Select() {
        if (this.muted) return;

        const key  = this.FileTree.Key;
        const name = this.byKey[key];
        if (!name) return;

        /*
         * A catalogue is not opened here, so selecting one must not open a tab
         * -- and must not launch anything either. Selection moves with the arrow
         * keys, and a tree that spawns Poedit once per row walked through is
         * unusable. Double click is what opens it, which is the file manager's
         * gesture and the one hands already make; the status bar says so,
         * because a click that appears to do nothing is worse than either.
         */
        const wasCatalogue = this.selectedCatalogue;

        if (Ide.Translations.isCatalogue(name)) {
            this.selectedCatalogue = name;
            this.refresh();
            return;
        }
        this.selectedCatalogue = null;

        /* Letting go of one changes the menu and the bar, and selecting the file
         * that is *already* open does nothing else -- so without this the item
         * stays enabled for a catalogue nobody is pointing at any more. */
        if (wasCatalogue) this.refresh();

        /*
         * An image is the catalogue's case exactly: the tree shows it, nothing
         * opens it in a tab -- it is not text and `File.Load` on a PNG is a
         * string full of nothing anybody wants -- and a *double* click hands it
         * to the viewer. Selection may not open one for the reason it may not
         * open a translation editor: the arrow keys walk a tree, and a viewer
         * per row walked through is unusable.
         */
        this.selectedImage = isImageFile(name) ? name : null;
        if (this.selectedImage) return;

        /*
         * The files view shows what the project does not recognise, so a
         * selection there can be a `.tar` or a font. Reading one into an editor
         * would fill it with the bytes of something that is not text -- and
         * *what is text* is not a list of extensions to keep here, it is
         * something the desktop already knows: `File.Info` says the content
         * type. Anything else waits for a double click and goes to whatever
         * opens it.
         */
        this.selectedOther = this.opensAsText(name) ? null : name;
        if (this.selectedOther) return;

        if (name === this.activeFile) return;

        /* With tabs, switching loses nothing: the state lives in the active tab
         * and comes back as it was.  The status bar keeps showing `*` so it is
         * not forgotten. */
        this.openInTab(name);
    }

    /*
     * Double click, or Enter, on a file in the tree.
     *
     * Only a catalogue does anything with it: everything else is already open by
     * the time this arrives, since selecting it opened the tab.
     */
    /*
     * Double click, or Enter, opens the catalogue **here**. The IDE owns the
     * file, so its own editor is the default and the external one is a menu item
     * away -- which is also the arrangement that keeps two editors off one file
     * unless somebody asks for it.
     */
    FileTree_Activate() {
        if (this.muted) return;
        if (this.selectedCatalogue)  this.openCatalogue(this.selectedCatalogue);
        else if (this.selectedImage) ImageForm.show(this, this.selectedImage);
        else if (this.selectedOther) this.openOutside(this.selectedOther);
    }

    /*
     * Whether a file is something an editor can show.
     *
     * The extensions the IDE *edits* are its own business and are declared in
     * `TabSet`; for everything else the question is only "is this text", and the
     * desktop answers it -- a content type of `text/...` is what a file has when
     * a person can read it. A table of extensions here would be wrong the first
     * time somebody used one nobody thought of.
     */
    opensAsText(name) {
        if (!name || !this.project) return false;
        if (EDITABLE[File.Extension(name).toLowerCase()]) return true;

        const info = File.Info(File.Join(this.project, name));
        return !!(info && !info.IsDir && info.Type.startsWith("text/"));
    }

    /* Handed to whatever the desktop opens that kind of file with -- which is
     * the honest answer for a `.tar` or a font, and better than either refusing
     * or opening it as text it is not. */
    openOutside(name) {
        try {
            File.Open(File.Join(this.project, name));
            this.log(`Opened ${name} outside the IDE\n`);
        } catch (e) {
            Message.Error("Cannot open {0}:\n{1}", name, e.message);
        }
    }

    /*
     * What activating one does, and the two files are not the same thing.
     *
     * A `.pot` is a template: every msgstr in it is empty by definition, so
     * there is nothing in it to edit and opening it in the catalogue editor
     * would only offer to write translations into a file the next extraction
     * overwrites.  What a template is *for* is starting a translation, so that
     * is what it does.
     */
    openCatalogue(file) {
        if (Ide.Translations.isTemplate(file)) this.newTranslation(file);
        else                               PoForm.edit(this, file);
    }

    newTranslation(template) {
        this.catalogues.createFrom(template, (made) => {
            this.listFiles();
            this.selectedCatalogue = made;
            PoForm.edit(this, made);
        });
    }

    /* The same from a menu, for the hand that does not think to double click --
     * and so the command has a name somewhere it can be read. */
    MnuFtTranslate_Click() {
        if (this.selectedCatalogue && !Ide.Translations.isTemplate(this.selectedCatalogue)) {
            PoForm.edit(this, this.selectedCatalogue);
        }
    }

    MnuFtNewTranslation_Click() { this.startTranslation(); }
    MnuTranslationNew_Click()   { this.startTranslation(); }

    /*
     * Start one, from whichever template there is.  The tree's selection when it
     * is a `.pot`, and otherwise the project's own -- so the command works from
     * the Project menu with nothing selected, which is where somebody looks for
     * it the first time.
     */
    startTranslation() {
        const template = this.selectedCatalogue &&
                         Ide.Translations.isTemplate(this.selectedCatalogue)
            ? this.selectedCatalogue : this.catalogues.templateFile();

        if (!template) {
            /* One literal, however long: joining two extracts as the first piece
             * alone, which looks like a valid msgid and never matches. */
            Message.Info("There is no template yet. Run Project > Update translations first: it gathers every string the project shows and writes the .pot a translation starts from.");
            return;
        }
        this.newTranslation(template);
    }

    /* And the other one, for a translator who wants the tool that does fuzzy
     * matching and translation memory -- which this editor deliberately does
     * not. */
    MnuFtTranslateWith_Click() {
        if (this.selectedCatalogue) this.catalogues.open(this.selectedCatalogue);
    }

    MnuTranslationEditor_Click() { this.catalogues.askEditor(); }

    Editor_Change() {
        if (this._loadingEditor) return;
        if (!this.activeFile) return;
        const state = this.openTabs.get(this.activeFile);
        if (!state || state.mode === "design") return;
        if (state.dirty !== this.Editor.Modified) {
            state.dirty = this.Editor.Modified;
            this.renderTabs();
        }
        this.refresh();
    }

    Editor_Cursor() {
        this.refresh();
    }

    /* --- teclado ----------------------------------------------------------
     * Ctrl+W (close) and Ctrl+Tab / Ctrl+Shift+Tab (cycle) are taken here;
     * anything else is delegated.  Returning true consumes the key. */
    Editor_KeyPress(key, ctrl, shift) {
        if (key === "w" && ctrl && !shift) {
            this.closeActiveTab();
            return true;
        }
        if (key === "Tab" && ctrl) {
            this.cycleTab(shift ? -1 : 1);
            return true;
        }
        /* Escape closes the find bar from the text as well as from the bar: one
         * has just pressed Enter to get here, and the highlight is still on. */
        if (key === "Escape" && this.finder.visible) {
            this.finder.close();
            return true;
        }
        return false;
    }

    /* --- find and replace -------------------------------------------------
     *
     * The bar's own logic is `Finder`.  What stays here is what has to: the
     * runtime looks a control's handler up on the *form*, so `FindText_Change`
     * cannot live anywhere else -- and it does not have to, being one line.
     */
    FindText_Change()   { this.finder.search(); }
    FindText_Activate() { this.finder.step(1); }

    /* Escape from either field, and Enter in the replacement means replace. */
    FindText_KeyPress(key)    { return this.finder.escaped(key); }
    ReplaceText_KeyPress(key) { return this.finder.escaped(key); }
    ReplaceText_Activate()    { this.finder.replaceOne(); }

    ChkFindCase_Click()  { this.finder.search(); }
    ChkFindWord_Click()  { this.finder.search(); }
    ChkFindRegex_Click() { this.finder.search(); }

    BtnFindNext_Click()   { this.finder.step(1); }
    BtnFindPrev_Click()   { this.finder.step(-1); }
    BtnFindClose_Click()  { this.finder.close(); }
    BtnReplace_Click()    { this.finder.replaceOne(); }
    BtnReplaceAll_Click() { this.finder.replaceAll(); }

    /*
     * What the editor proposes, asked of the project rather than of the buffer.
     *
     * Dispatched by name like every other event: each tab's editor is called
     * `Editor`, so one handler answers for all of them -- and only the one on
     * screen can be typed into, which is the one `this.Editor` points at.
     */
    Editor_Complete(word, line, column, before) {
        return this.completion.answer(word, line, column, before);
    }

    /*
     * The two views of the tree, offered by name.
     *
     * The names are prose and the value is the **index**: what the chooser shows
     * goes through the catalogue, so comparing the text would mean comparing a
     * translation -- the trap a `ComboBox` of keywords in a `.form` already
     * taught this project once.
     */
    dressViews() {
        this.CmbView.Items = Ide.ProjectTree.views;
        this.CmbView.Index = this.projectTree.view;
    }

    CmbView_Select() {
        this.projectTree.setView(this.CmbView.Index);
    }

    /* --- what happened to the file while it was open -----------------------
     *
     * A bar over the editor rather than a dialog: what it says is *there is a
     * newer version of this*, which is news and not a question -- and a modal
     * over an editor one is typing in would be the wrong shape for news. It is
     * a `Panel` wearing the theme's toolbar class and not a `GtkInfoBar`, which
     * GTK4 deprecated; a bar here is a box with a label and two buttons, which
     * is what that widget was.
     *
     * Shown for the tab on screen only: a file that changed in a tab one is not
     * looking at has nothing to interrupt, and the bar comes up when that tab
     * does.
     */
    showReloadBar() {
        const state = this.tabs.activeState();
        const gone  = state && state.goneFromDisk;
        const newer = state && state.changedOnDisk;

        this.ReloadBar.Visible = !!(gone || newer);
        if (!this.ReloadBar.Visible) return;

        this.LblReload.Text = gone
            ? Locale.Text("{0} is no longer on disk.", this.activeFile)
            : this.isDirty()
                ? Locale.Text("{0} changed on disk, and there are unsaved changes here.",
                              this.activeFile)
                : Locale.Text("{0} changed on disk.", this.activeFile);

        /* Nothing to take from a file that is gone. */
        this.BtnTakeDisk.Enabled = !gone;
    }

    /*
     * Taking the newer file. It replaces what is in the tab, so with unsaved
     * work it asks first -- the same words the rest of the IDE uses for losing
     * changes, and the same shape: veto now, act from the answer.
     */
    BtnTakeDisk_Click() {
        const name = this.activeFile;
        if (!name) return;

        if (!this.isDirty()) {
            this.tabs.takeFromDisk(name);
            return;
        }
        ConfirmForm.ask(
            Locale.Text("Reload"),
            Locale.Text("{0} changed on disk. Take the newer file and lose what is unsaved here?", name),
            Locale.Text("Reload without saving"),
            () => this.tabs.takeFromDisk(name));
    }

    /* Keeping what is open: the news has been read, and saying it twice for the
     * same change would make the bar something one closes without looking. */
    BtnReloadHide_Click() {
        const state = this.tabs.activeState();
        if (state) {
            state.changedOnDisk = false;
            state.goneFromDisk  = false;
        }
        this.ReloadBar.Visible = false;
    }

    /* --- el portapapeles del disenador --------------------------------------
     *
     * **Only while designing**, and that is the whole of how these can carry
     * `Ctrl+C`/`Ctrl+V` at all: a code tab's editor answers those itself, and an
     * accelerator on an item that is *enabled* would take them away from it.
     * A disabled item loses its accelerator with it, which is the same
     * mechanism `Ctrl+F` uses on a form tab -- so `refresh()` deciding these is
     * not decoration, it is what keeps the text editor working.
     */
    MnuCut_Click()       { this.designer.cutSelection(); }
    MnuCopy_Click()      { this.designer.copySelection(); }
    MnuPaste_Click()     { this.designer.paste(); }
    MnuDuplicate_Click() { this.designer.duplicateSelection(); }

    /*
     * Complete now, which is the other half of a completion that also comes up
     * on its own: `Ctrl+Space` is the key every editor has for it, and having
     * the runtime able to ask without an item to ask from was an API with no
     * user. Enabled with a code tab and not otherwise -- the accelerator has to
     * be free for whatever else has the focus.
     */
    MnuComplete_Click() {
        if (this.Editor) this.Editor.ShowCompletion();
    }

    MnuFind_Click()     { this.finder.open(false); }
    MnuReplace_Click()  { this.finder.open(true); }
    MnuFindNext_Click() { this.finder.step(1); }
    MnuFindPrev_Click() { this.finder.step(-1); }

    /*
     * Find in project is a window of its own (`SearchForm`), not a mode of the
     * bar: what it has that a bar cannot hold is a result set. It opens on the
     * selection, the way `Ctrl+F` does, and falls back to whatever the bar was
     * last looking for -- so the two searches start from the same place without
     * being the same search.
     */
    MnuFindAll_Click() {
        const picked = this.Editor ? this.Editor.Selection : "";
        SearchForm.find(this, picked || this.FindText.Text);
    }

    /* --- disenador -------------------------------------------------------
     * Events go to the form that owns the control, so the handlers live here and
     * delegate to Designer. */

    Glass_MouseDown(x, y, button, ctrl) { this.designer.mouseDown(x, y, button, ctrl); }

    /* The title bar is the form's, so clicking it selects the form -- which is
     * what the control tree's root does, and what a user who clicks the title bar
     * of a window is pointing at.  It is the only thing on the decoration that
     * answers: the buttons on it are a picture of the window's, and a preview
     * that could be minimised would be lying about what it is. */
    TitleBar_MouseDown() { if (this.designing) this.designer.select(null); }
    /* Shift suspends snapping to the guides, to nudge by a single pixel. */
    Glass_MouseMove(x, y, button, ctrl, shift) {
        this.designer.mouseMove(x, y, shift);
    }
    Glass_MouseUp(x, y, button, ctrl) { this.designer.mouseUp(x, y, button, ctrl); }

    Glass_DblClick(x, y) { this.designer.dblClick(x, y); }

    Glass_KeyPress(key, ctrl, shift) {
        if (key === "w" && ctrl && !shift) {
            this.closeActiveTab();
            return true;
        }
        if (key === "Tab" && ctrl) {
            this.cycleTab(shift ? -1 : 1);
            return true;
        }
        return this.designer.keyPress(key, ctrl, shift);
    }

    /* Adds another of the last type used: that is what Ctrl+Insert does, since
     * the palette already adds its own when pressed. */
    addFromPalette() {
        this.designer.addControl(this.designer.tool);
    }

    /* A type dragged from the palette and dropped on the form. */
    Glass_Drop(type, x, y) {
        this.designer.dropControl(type, x, y);
    }

    /*
     * The designer's context menus, on the canvas and on the control tree.
     * They carry no command of their own: each one is the button or the key
     * that already did it, reached from where the pointer is instead of from
     * across the window.
     *
     * **Which is now what the file says**, since they point at an `action`: the
     * three commands they share with the toolbar have no names of their own
     * here at all. There used to be two extra sets -- `MnuCvDel`, `MnuTrDel` --
     * because a menu item is exposed on the form by name and two widgets cannot
     * both own `MnuDel`. An item that points at a command is not one, so it
     * needs no name.  Renaming is still two, because the canvas renames the
     * selection and the tree renames the row the pointer is on: two commands
     * that read the same and are not.
     */
    MnuCvRename_Click() { this.renameSelectedControl(); }
    MnuTrRename_Click() { this.designer.tree.renameFromKey(this.WidgetTree.Key); }

    /* These two apply to the tree and not to a selection, so unlike the rest
     * they stay live with nothing selected. A form nested eight deep -- the
     * IDE's own is -- is what they are for. */
    MnuTrExpand_Click()   { this.WidgetTree.ExpandAll(); }
    MnuTrCollapse_Click() { this.WidgetTree.CollapseAll(); }

    /* The canvas has no key to rename by, so the menu is where it lives.  Named
     * for what it renames, since the file has a rename of its own. */
    renameSelectedControl() {
        const control = this.designer.selected;
        if (control) this.designer.tree.renameFromKey(control.Name);
    }

    /*
     * **Three commands, and each is written once.** Each of these was four
     * handlers -- the toolbar button, the Edit menu, the canvas menu and the
     * tree menu -- and their availability was computed in *two files with two
     * different expressions*: `Designer.refresh` said `selection.length > 0`
     * and `MainForm.refresh` said `design && designer.selected !== null`.
     * Whether those agreed was not answerable by reading either one.
     */
    ActDelCtl_Click()   { this.designer.deleteSelected(); }
    ActRaise_Click()    { this.designer.restack(true); }
    ActLower_Click()    { this.designer.restack(false); }

    /* --- menu ------------------------------------------------------------
     * The items duplicate the toolbar on purpose: the menu is what carries the
     * accelerators, and what shows them. */

    MnuNewProject_Click()   { this.newProject(); }
    MnuNewForm_Click()      { this.newForm(); }
    MnuNewComponent_Click() { this.newComponent(); }
    MnuNewModule_Click()    { this.newModule(); }
    MnuCloseTab_Click()   { this.closeActiveTab(); }
    MnuRename_Click()     { this.renameSelectedFile(); }
    MnuDelete_Click()     { this.deleteSelectedFile(); }
    MnuOpen_Click()   { this.BtnOpen_Click(); }

    /* The index comes from the entry chosen; the list may have changed in
     * between (opening another project reorders it), so it is validated. */
    /* The event chosen, by index: the label carries a mark, so it is not the
     * name to dispatch on.  Validated, because the selection may have changed. */
    MnuHandler_Click(index) {
        const event   = (this.handlerEvents || [])[index];
        const control = this.designing ? this.designer.selected : null;
        if (event && control) this.openHandler(control.Name, event);
    }

    MnuRecent_Click(index) {
        const dir = this.recent[index];
        if (dir) this.openProject(dir);
    }

    MnuReload_Click() { this.BtnReload_Click(); }
    MnuSave_Click()   { this.save(); }
    MnuSaveAll_Click() { this.saveAllDirty(); }
    MnuQuit_Click()   { if (!this.confirmQuit()) Application.Quit(0); }

    MnuRun_Click()    { this.run(); }
    MnuStop_Click()   { this.Console.Stop(); }

    /* Undo is split by mode, so Ctrl+Z does not steal the text editor's undo
     * when the editor is what is on screen. */
    MnuUndo_Click() {
        if (this.designing) this.designer.undo();
        else                this.Editor.Undo();
        this.refresh();
    }

    MnuRedo_Click() {
        if (this.designing) this.designer.redo();
        else                this.Editor.Redo();
        this.refresh();
    }

    MnuAdd_Click()   { this.addFromPalette(); }

    /*
     * The menu bar of the form being designed.  The board shows it -- a preview
     * built out of ordinary widgets, which is `Ide.MenuBar` -- but a menu is a
     * model wired to actions and not a tree of widgets to drag, so what reorders
     * and renames is this dialog, on the spec.
     *
     * Reached from the Form menu, from Ctrl+M, and from a double or right click
     * on the bar itself.
     */
    MnuMenus_Click() {
        if (!this.designing) {
            Message.Warning("Open a form's design to edit its menus.");
            return;
        }
        /* Kept so the editor can be reached while it is open -- which is what
         * lets a test drive it, and the IDE close it if the form goes away. */
        this.menuEditor = MenuForm.edit(
            this.designer.menus(),
            (spec) => this.designer.setMenus(spec),
            (name) => this.openHandler(name, "Click"));
    }
    /* Aligns against the last control touched, which is the convention. */
    MnuAlignLeft_Click()   { this.designer.align("left"); }
    MnuAlignRight_Click()  { this.designer.align("right"); }
    MnuAlignTop_Click()    { this.designer.align("top"); }
    MnuAlignBottom_Click() { this.designer.align("bottom"); }
    MnuSameWidth_Click()   { this.designer.align("width"); }
    MnuSameHeight_Click()  { this.designer.align("height"); }

    /* Sharing out the gap needs three: two are already at the ends. */
    MnuSpreadH_Click() { this.designer.distribute("h"); }
    MnuSpreadV_Click() { this.designer.distribute("v"); }

    /*
     * The version, and the binary it is running on.  Kept while it is open for
     * the same reason the menu editor is: so a test can drive the dialog the
     * menu opened, rather than the method under it.
     */
    MnuAbout_Click() { this.about = AboutForm.show(); }
}
