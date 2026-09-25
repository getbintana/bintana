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
 * One string for the two who need it -- the click, which reads the token under
 * the pointer back, and the scan that finds the frame a failed run died in.
 * It was PCRE2's as well while the pane was a terminal and `LinkPattern` made
 * the text clickable; the pane is an ordinary `TextEditor` now, so it is only
 * ever a JavaScript regex -- see `Runner.linkAt`.
 */
const SOURCE_LINK = "[\\w./+-]+\\.(?:js|form|json):\\d+";

/* What the output pane keeps, in characters. Long enough for a traceback and
 * the output that led to it; short enough that a runaway `print` is a bounded
 * cost. Half of it goes when it is passed, so the trim is rare. */
const LOG_MAX = 200000;

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
/* The file a project opens on when there is no session to restore: the one it
 * was written for a person to read. */
const README = "README.md";

const RECENT_MAX = 8;
const RECENT_KEY = "recent";

/*
 * What marks an entry of *Write handler*.  Two characters wide either way, so the
 * event names line up in a column -- the same reason `PoForm`'s marks are.
 * Written means choosing it goes there; the rest are a method that does not exist
 * yet, and choosing one writes it.
 */
/* The branch one is standing on, in a list of them.  The same bullet the Form
 * menu marks a written handler with, because it is the same kind of fact: this
 * one, of the ones offered. */
const BRANCH_HERE  = "\u2022 ";
const BRANCH_OTHER = "  ";

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
 * tabs, and a line in the output pane asking the user to open something. What a
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
     * up.  Being fields and not `Form_Open` is what fixes that for every event
     * raised after the window exists.  None of them touches a widget to be
     * built, which is what makes that safe.
     *
     * **It does not cover the load itself, and that was written here as though
     * it did.** The `.form` is read inside `Form`'s constructor, i.e. inside
     * `super()`, and a subclass's field initialisers run after `super()`
     * returns -- so a handler for an event the *load* raises still finds
     * `undefined`. Measured by adding one: `SideTabs_Switch` fires while the
     * switcher's first page is being added, with `at Form (native)` in the
     * traceback and every field below still unset. A handler that can be reached
     * that way guards, and says so; see `SideTabs_Switch`.
     */
    finder    = new Ide.Finder(this);        // the find bar
    runner    = new Ide.Runner(this);        // running the project, and its output
    manifest  = new Ide.Manifest(this);      // project.json
    launch    = new Ide.Launch(this);        // how this project is run, in three places
    classes   = new Ide.Classes(this);       // what the project holds, and its names
    projectTree = new Ide.ProjectTree(this); // ...as the file tree shows it
    formFiles = new Ide.FormFiles(this);     // creating, renaming, deleting one
    strings   = new Ide.Strings(this);       // what the project shows, extracted
    catalogues = new Ide.Translations(this); // the .po files, and msgmerge
    exporter  = new Ide.Exporter(this);      // the project tree as one .tar
    tabs      = new Ide.TabSet(this);        // the open files
    completion = new Ide.Completion(this);   // what the editor proposes
    recovery  = new Ide.Recovery(this);      // the dirty tabs, copied aside
    session   = new Ide.Session(this);       // the desk, as it was left
    /* The palette is one widget for every open form, so it is the window's and
     * not a designer's: what it offers is the project's components, and the
     * designer on screen only says which tool is marked. */
    palette   = new Ide.Palette(this);
    /* And the events page, beside the properties: one instance for the same
     * reason the palette is one, since what it shows is the one selection. */
    events    = new Ide.Events(this);
    /* F12: where a name is declared, by looking it up rather than guessing. */
    navigator = new Ide.Navigator(this);
    /* Breakpoints, the stack and the values: what the runtime's `--debug` says,
     * drawn. */
    debugger_ = new Ide.Debugger(this);
    /* What git says about the project, and the only thing here that runs one. */
    git       = new Ide.Git(this);
    /* The changed files as a page of the side bar, with the message box: the
     * Changes window is for reading a diff, and this is for living in. */
    changes   = new Ide.Changes(this);
    /* Everything that is wrong, in one list. It runs no check of its own: what
     * it collects is what the save, the lint and the failed run already found
     * and had nowhere to say. */
    problems  = new Ide.Problems(this);
    /* And the one thing that puts rows in it on its own: the names a file uses,
     * checked against the form beside it while it is being written. */
    /* The two checks that read a name against the `.form` beside it, shared by
     * the two things that ask: the pause, and the project pass. */
    names     = new Ide.Names(this);
    live      = new Ide.Live(this);
    /* ...and the pass itself: what is wrong with the project, asked of the whole
     * of it rather than of the file on screen. */
    check     = new Ide.Check(this);
    /* What is in the file on screen, beside it: the side panel's other half, for
     * the tabs where there is no selection to speak about. */
    outline   = new Ide.Outline(this);

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

    /* The bottom panel's terminal, and which page it is -- `null` and `-1` on a
     * build whose `Terminal` cannot run a child, since there is no second page
     * there at all. Declared here and not left to `buildTerminal`, so every
     * reader of them (`ConsoleBox_Switch`, `stopShell`) is answered either way. */
    Shell     = null;
    shellPage = -1;

    Form_Open() {
        /* First, because this is the one moment a window's size is not a resize
         * somebody watches happen: `Form_Open` runs before the window is
         * presented, so what is restored here is what it is mapped at. */
        this.session.restoreWindow();

        this.dressTabActions();
        this.dressViews();
        this.buildTerminal();
        this.renderTabs();          /* no pages yet: no strip either */
        this.setMode(false);        /* ...and so no editor nor designer either */
        this.loadRecent();
        this.runner.restore();      /* the tick the last session left on */
        /* Before the project opens, so the net is up for whatever the session
         * does -- including a project opened from the welcome page. */
        this.recovery.start();

        const arg = Application.Arguments[0];
        if (arg) {
            this.openProject(arg);
        } else {
            /* The welcome page says the rest; the log keeps the version,
             * which is the one thing it says that a button cannot. */
            this.log(`Bintana ${BTA_VERSION}\n`);
            this.Pages.Current = PAGE_WELCOME;
            this.refresh();
        }
    }

    /* Every resize, and all it does is keep the two numbers: what is written
     * down, and when, is `Session`'s. */
    Form_Resize(width, height) { this.session.noteSize(width, height); }

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
    MnuTabAll_Click()     { return this.closeAllTabs(); }
    MnuTabSaveAll_Click() { this.saveAllDirty(); }

    /* How often the dirty tabs are copied aside, which is the user's and not
     * ours: `Recovery` owns the question and the setting. */
    MnuRecovery_Click() { return this.recovery.ask(); }

    MnuTabOthers_Click() { return this.tabs.closeOthers(this.activeFile); }

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

        /* Before the tabs go: what was open in the project being left is that
         * project's session, and `discardAll` is about to make it unanswerable. */
        this.session.saveTabs();

        this.project = dir;
        this.git.forget();      /* another project is another repository */
        /* Without asking: every door that leads here asked first
         * (`leaveProject`), and asking here would be asking after `project`
         * had already moved. */
        this.tabs.discardAll();
        this.Text = Locale.Text("Bintana IDE -- {0}", File.Name(dir));

        /* The workspace is what a project looks like; nothing takes the window
         * back to the welcome page, because nothing closes a project. */
        this.Pages.Current = PAGE_WORK;

        /* Asked once per project opened, before the tree is drawn: every row's
         * indicator and the branch in the bar read the same answer. */
        this.git.refresh();
        this.listFiles();
        this.rememberRecent(dir);
        this.log(`Project: ${dir}\n`);
        this.reportProject();

        /*
         * And what is wrong with it, once, here.
         *
         * Opening a project is the moment one is willing to be told -- before
         * any of it is on screen, and not while typing in it. `Ide.Check` takes
         * the project's own listing, which `listFiles` above has just rebuilt,
         * and reads files rather than opening them.
         */
        this.check.forget();
        this.check.run();

        /* What was open the last time this project was, reopened before anything
         * is offered: the recovered text below lands in these same tabs. */
        const back = this.session.restoreTabs(dir);
        if (back) this.log(`Reopened ${back} file${back === 1 ? "" : "s"}\n`);

        /*
         * **A project nobody has worked in here opens on its README**, which is
         * the file it was written to be read from. Only when the session gave
         * nothing back: a project one was in the middle of reopens what was
         * being worked on, and a welcome page in front of that would be the IDE
         * having an opinion about where somebody left off.
         */
        if (!back && File.Exists(File.Join(dir, README))) this.openInTab(README);

        /* Last, and only here: whatever was left unsaved the last time this
         * project was open is offered once, with the tree and the tabs already
         * in place for the answer to land in. */
        this.recovery.offer(dir);
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

        /*
         * **One read of the `.js` and one pass over it for every event.** This
         * runs from `refresh()`, which runs on every keystroke, and asking
         * `hasHandler` per event read the file and compiled a fresh regex each
         * time. What makes the answer right is that `handlersIn` asks the
         * parser now: `\bBtnOk_Click\s*\(` found a *call* and marked an
         * unwritten handler as written.
         */
        const written = control
            ? Ide.FormFiles.handlersIn(this.formFiles.siblingSource(), control.Name)
            : [];

        this.MnuHandler.Items = events.length
            ? events.map((e) => (written.includes(e)
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

        /*
         * And what git says about each row, put on after the rows exist.
         *
         * Here rather than inside the tree, because the tree's job is to say
         * what the project holds and git's is to say what has changed about it:
         * two questions, and only one of them costs a child process. It is a
         * no-op without git or outside a repository.
         */
        this.git.markTree();

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

        this.leaveProject(() => NewProjectForm.ask(base, (info) =>
            this.startProject(File.Join(info.base, info.name), info.description,
                              info.console, info.id)));
    }

    /*
     * Every door out of the open project, asked once and before anything moves:
     * Open, a recent project (menu or welcome page), New and Clone. It used to
     * be nobody's -- `openProject` closed every tab with *force*, so opening
     * another project dropped unsaved work in this one without a word. Asked at
     * the door and not inside `openProject`, because by then the new project is
     * being written (`createProject` sets `project` to write its first form)
     * and a "no" would have nowhere to go back to.
     */
    leaveProject(then) {
        /* Leaving is an answer as well: whatever is still dirty once the
         * question is settled was chosen to be discarded, and a snapshot of it
         * would offer that work back the next time this project opens. Here and
         * not in `openProject`, because a new project has already moved
         * `project` by the time it gets there. */
        return this.tabs.whenSettled([...this.tabOrder],
                                     Locale.Text("Leave the project"),
                                     Locale.Text("Discard and continue"),
                                     Locale.Text("Save all and continue"),
                                     () => { this.recovery.forget(); then(); });
    }

    startProject(path, description, console, id) {
        if (File.Exists(path) && !File.IsDir(path)) {
            Message.Error("{0} already exists and is not a folder.", File.Name(path));
            return false;
        }

        Directory.Make(path);
        return this.createProject(path, description, console, id);
    }

    createProject(dir, description, console, id) {
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
        if (console) return this.createConsoleProject(dir, description, id);

        const first = inFolder(FORM_DIR, "Form1");

        const config = new Ide.ProjectFile({
            Name:        File.Name(dir),
            Id:          id || "",
            Startup:     "Form1",
            Sources:     [`${first}.js`],
            Description: description || "",
        });

        File.SaveJson(File.Join(dir, "project.json"), config);

        /* A project that declares an id gets its metainfo from the start: it is
         * part of what the project *is*, and creating it later is a step nobody
         * remembers. Without an id there is no name for the file, and the
         * Application info dialog is where one is made once there is. */
        if (id) Metainfo.create(dir, config);

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
    createConsoleProject(dir, description, id) {
        const config = new Ide.ProjectFile({
            Name:        File.Name(dir),
            Id:          id || "",
            Main:        "Main",
            Sources:     ["Main.js"],
            Description: description || "",
        });

        File.SaveJson(File.Join(dir, "project.json"), config);
        if (id) Metainfo.create(dir, config);
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
    editLaunch()        { this.launch.edit(); }

    /*
     * Installing the open project as a user application: a menu entry the user
     * owns, under their own data directory, with no root and no package.
     *
     * `Ide.Apps` owns the entry and the runtime owns the format; what this does
     * is hand the dialog the manifest it starts on -- a project whose
     * `project.json` declares a name has it filled in already -- and keep the
     * dialog so `tests/ide` can drive it, the way `editSettings` keeps the
     * project editor.
     *
     * A project.json that cannot be read is not a reason to refuse: the dialog
     * is where a name is typed, and the entry does not need the manifest at all.
     * It starts empty instead of quoting a file that is broken.
     */
    installAsApp() {
        if (!this.project) {
            Message.Info("Open a project first.");
            return;
        }
        this.appEditor = AppForm.edit(this.project, this.manifest.read() || {},
                                      () => this.refresh());
    }

    /* Kept while it is open, for the same reason the app editor is: it is what
     * lets a test drive the dialog. */
    editMetainfo() {
        this.metainfoEditor = MetainfoForm.open(this);
    }

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
    renameHandlers(formPath, oldName, newName, events) {
        return this.formFiles.renameHandlers(formPath, oldName, newName, events);
    }
    openHandler(controlName, eventName) {
        return this.formFiles.openHandler(controlName, eventName);
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
    closeAllTabs()       { return this.tabs.closeAll(); }
    closeTabByName(n, f) { this.tabs.closeByName(n, f); }
    renameTab(from, to)  { this.tabs.rename(from, to); }
    cycleTab(direction)  { this.tabs.cycle(direction); }
    renderTabs()         { this.tabs.render(); }
    setMode(designing)   { this.tabs.setMode(designing); }
    save()               { return this.tabs.save(); }
    saveAllDirty()       { return this.tabs.saveAllDirty(); }
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
     *
     * And neither door calls `Application.Quit` bare, because there is something
     * owed on the way out -- the terminal tab's shell is a child of this
     * process, and the desk is worth having back next time. `leaving()` is that
     * list, and both doors pass through it.
     */
    Form_Close() {
        const asked = this.confirmQuit();
        /* Nothing to ask, so it really closes -- and it closes by *returning*,
         * which is the one way out that never reaches `quit()`. Whatever is
         * owed on the way is owed here too, and `leaving()` is the one list of
         * it; the X button being the commonest way out of any window is what
         * makes this the door to get right. */
        if (!asked) this.leaving();
        return asked;
    }

    /*
     * Everything owed before the window goes.
     *
     * The shell is a child of this process and the desk is worth having back:
     * neither of them is about *why* the window is closing, which is what makes
     * this a list rather than a step in one of the two ways out.
     */
    leaving() {
        this.stopShell();
        this.session.save();
        /* Nothing unsaved is an answer too. The snapshot used to go only in
         * `quit()` or on a tick that found nothing dirty, so saving and closing
         * with the X inside thirty seconds left the last snapshot behind -- and
         * the next open offered to "recover" text older than what was saved.
         * With dirty tabs the only way here is `quit()`, which forgets anyway. */
        if (!this.hasDirtyTabs()) this.recovery.forget();
    }

    /* ...and the way out that has an answer behind it: the dialog said quit, so
     * the main loop ends here rather than by letting a window close. */
    quit() {
        this.leaving();
        /* The question has been asked and answered by the time anything reaches
         * here -- `confirmQuit` is the only way past a dirty tab -- so keeping
         * the snapshot would be offering to undo a decision the user made. */
        this.recovery.forget();
        Application.Quit(0);
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
            () => this.quit(),
            { Text: Locale.Text("Save all and quit"),
              Run:  () => { if (this.saveAllDirty()) this.quit(); } });
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

    /*
     * The output pane is a log view and not a console: `Append` writes at the
     * end and scrolls there whatever the cursor was doing, which is what a log
     * pane wants, and `ReadOnly` stops only the user's keyboard.
     *
     * No CRLF translation any more. A terminal is a grid of lines and wanted
     * one; a text buffer takes `\n` as the newline it is.
     *
     * **The pane has a ceiling.** A `print` in a loop would otherwise grow the
     * buffer for as long as the child runs -- and every click reads the whole
     * text back to find the token under it. Past `LOG_MAX` the oldest half goes
     * in one cut, not a line at a time: replacing the buffer is O(n), and
     * trimming per append would make a runaway child quadratic. The running
     * length is kept here so the check does not read the buffer it guards.
     */
    log(text) {
        this.LogView.Append(text);
        this.logged = (this.logged || 0) + text.length;

        if (this.logged <= LOG_MAX) return;

        const keep = Math.floor(LOG_MAX / 2);
        const held = this.LogView.Text;

        this.LogView.Text = held.slice(held.length - keep);
        this.logged = keep;
    }

    /* Emptying it is a reset of the count too, or the first append after would
     * trim a buffer that is already gone. */
    clearLog() {
        this.LogView.Clear();
        this.logged = 0;
    }


    /* ------------------------------------------------------------ terminal
     *
     * The bottom panel's second page, and the only place a real `Terminal` is
     * left in the IDE: the output pane above it is a log view, because showing
     * what a child printed needs no pty.  This one does -- it is Linux's actual
     * terminal, for git, a service, a file to move -- and it is why `Terminal`
     * was not removed when the console stopped being one.
     *
     * `Shell` and not `Terminal` for the control's name, because `Terminal` is
     * the class: a field of that name in this file would read as the class in
     * every line that mentioned it.  What the *user* sees is the tab, and the
     * tab says Terminal.
     */

    /* The page exists only where a child can be run in it, which is what
     * `Widget.Available` answers: a build without VTE gets a bottom panel of
     * one page, and no tab promising something that would refuse.
     *
     * Asked of the *class* and not of a control, because there is no control
     * yet -- which is the whole reason `Widget.Available(type)` exists beside
     * the `Available` an instance publishes. Building one to ask would be
     * building the thing the answer says not to build. */
    buildTerminal() {
        if (!Widget.Available("Terminal")) return;

        this.Shell = new Terminal();
        this.Shell.Name = "Shell";

        /* A tab label is a widget and not a string -- `Notebook.Append` takes
         * one or none, which is what lets the IDE colour its own tab strip --
         * so the page arrives nameless and is named next, the way `Palette`
         * builds its groups. */
        const tab = new Label();
        tab.Text = Locale.Text("Terminal");

        this.shellPage = this.ConsoleBox.Append(this.Shell);
        this.ConsoleBox.SetTabLabel(this.shellPage, tab);
    }

    /*
     * The shell starts when the page is first *looked at*, not when the IDE
     * opens: a terminal nobody has turned to is a child process nobody asked
     * for, and an IDE that starts one at launch has started one in whatever
     * directory it was launched from.
     *
     * In the project's directory, which is the whole point of it being here --
     * and in the user's own home when there is no project open, because a
     * shell has to start somewhere and the directory the IDE was launched from
     * is nobody's choice.
     */
    ConsoleBox_Switch(index) {
        if (!this.Shell || index !== this.shellPage) return;
        if (this.Shell.Running) return;

        const shell = Environment.Get("SHELL") || "/bin/sh";
        this.Shell.Run([shell], this.project || Environment.Get("HOME") || "/");
    }

    /* A shell that ended says so where it ended, and the next look at the tab
     * starts another: an empty black pane is not an answer. */
    Shell_Exit(code) {
        this.Shell.Feed(`\r\n[${Locale.Text("the shell ended")}: ${code}]\r\n`);
    }

    /*
     * Asks the child to end (SIGTERM, reaching its whole process group) on the
     * way out, and on the way back to the page so a dead shell is replaced.
     *
     * **It is not what ends an interactive shell**, and that is worth knowing
     * rather than assuming: bash ignores SIGTERM when it is interactive, so
     * `Running` is still true after this. What ends it is the pty being closed
     * -- the kernel hangs up the foreground process group, which is what
     * closing a terminal window has always meant, and VTE does it when the
     * widget goes. Measured: no shell is left behind after the IDE quits.
     *
     * So this is for everything that *does* honour SIGTERM, and for saying out
     * loud that the child is ours. It deliberately does not follow with a
     * `Kill()`: what is in the terminal may be a build or an editor, and
     * SIGKILL is not the IDE's to send on somebody's behalf.
     */
    stopShell() {
        if (this.Shell && this.Shell.Running) this.Shell.Stop();
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
        /* The same list the menu above is offering, drawn: it answers "nothing
         * changed" without reading anything, which is what lets it hang off a
         * call that also runs on every pixel of a form resize. */
        this.events.fill();
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
        this.MnuAppInstall.Enabled = open;
        this.MnuMetainfo.Enabled = open;
        this.launch.show();

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

        /* F12 reads the caret, so it wants a code editor and not merely a
         * project: on a form tab there is no word to be on. */
        this.MnuGoto.Enabled = !design && !!this.Editor;
        this.MnuGotoSymbol.Enabled = !design && !!this.Editor;

        /*
         * Debugging.  *Debug* is *Continue* while it is stopped, so it is
         * available in both states and unavailable only while the program is
         * running freely -- which is when *Pause* is the thing to press.
         */
        const halted = this.debugger_.halted;

        this.MnuDebug.Enabled    = open && (!this.running || halted);
        this.MnuPause.Enabled    = this.debugger_.running && !halted;
        this.MnuStepInto.Enabled = halted;
        this.MnuStepOver.Enabled = halted;
        this.MnuStepOut.Enabled  = halted;
        /* A breakpoint is set on a line, so it wants a code editor -- and it is
         * set whether or not anything is running, which is the point of it. */
        this.MnuBreakpoint.Enabled = !design && !!this.Editor;

        /* Asking is only a question a stopped program can answer; keeping one is
         * not, so a watch can be written down before anything runs. */
        this.TxtImmediate.Enabled = halted;
        this.BtnWatch.Enabled     = this.TxtImmediate.Text.trim() !== "";

        /*
         * Git. The whole menu needs the tool and a project; the commands need a
         * repository and *Start a repository here* needs the opposite, which is
         * the one entry that is on when the rest are off.
         */
        const git = open && this.git.available;
        const repo = git && this.git.isRepo;

        this.MnuGitRefresh.Enabled = repo;
        this.MnuGitChanges.Enabled = repo;
        this.MnuGitLog.Enabled     = repo;
        this.MnuGitNewBranch.Enabled = repo;

        /*
         * The remotes need somewhere to talk to, and only one of them may be in
         * flight: `Ide.Git` keeps one job, and a second Fetch while the first is
         * running would be silently dropped rather than queued.
         */
        const talking  = this.git.job !== null;
        const anywhere = repo && !talking && this.git.remoteNames.length > 0;

        this.MnuGitFetch.Enabled = anywhere;
        this.MnuGitPull.Enabled  = anywhere;
        /* Push is the one that can create the upstream, so it does not need one
         * to already exist -- only a remote to push to. */
        this.MnuGitPush.Enabled  = anywhere;
        /* Clone is the one that does not want a project: it is how somebody
         * with an empty IDE gets one. */
        this.MnuGitClone.Enabled = this.git.available && !talking;
        this.MnuGitInit.Enabled    = git && !repo;

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
            /* Said where the file is named, for as long as it is on screen:
             * the log line went by when it was opened. */
            if (this.tabs.isForeign(this.activeFile))
                status += Locale.Text("   read-only: not UTF-8");
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
        /*
         * And what git says, on the end of whatever the bar was already saying.
         *
         * On the end and not in a corner of its own: the bar is one sentence
         * about where you are, and a branch is part of that. It is `""` when
         * there is no repository, so nothing moves for a project without one.
         */
        const where = this.git.summary();
        if (where) status += `   ${where}`;

        this.LblStatus.Text = status;
    }

    /* -------------------------------------------------------------- eventos */

    BtnOpen_Click() {
        this.leaveProject(() =>
            Dialog.SelectFolder("Open a Bintana project", (dir) => this.openProject(dir)));
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
        this.leaveProject(() => this.openProject(dir));
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
        this.stopRun();
    }

    /*
     * A click in the log, which is how a traceback becomes somewhere to go.
     *
     * `MouseUp` and not `Cursor`, which was what this looked like it should be:
     * a click *does* move the insertion cursor in a `ReadOnly` editor and
     * `Cursor` does fire -- but so does every arrow key, so reading the log
     * with the keyboard would open a file per keystroke. `MouseUp` is the
     * pointer's alone. A drag usually produces none at all, GTK's own drag
     * gesture having claimed the sequence, but only usually -- which is why
     * `Runner.followClick` guards on `Selection` as well. Both measured.
     */
    LogView_MouseUp() { this.runner.followClick(); }

    /* A problem is a place, and the only thing to do with a place is go to it.
     * `Activate` and not `Select`: moving through the list with the arrows to
     * read it must not open a file per row, which is the same mistake `Cursor`
     * would have been above. */
    ProblemView_Activate() { this.problems.activated(); }

    /* Both delegate to `Runner`, and these two are here because `tests/ide`
     * drives them by name -- as good a reason as a handler's. */
    errorLocation(text)   { return this.runner.errorLocation(text); }
    findErrorLine()       { return this.runner.findErrorLine(); }
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

    /* The events page: activating a row writes that handler, or goes to it --
     * `openHandler` decides which, exactly as a double click on the canvas does. */
    EventList_Activate() { this.events.activated(this.EventList.Index); }

    /*
     * The side panel changed page.  What is on the events page was drawn for
     * whatever was selected when it was last on screen, so arriving at it is a
     * reason to look again -- and it is the only moment that is, since `fill()`
     * does nothing at all while the page is hidden.
     *
     * **Guarded, because this one really does arrive before the fields exist.**
     * A `Switcher` emits `Switch` when its first page makes `Current` go from
     * nothing to zero, and the pages are built by the `.form` -- which is loaded
     * inside `Form`'s own constructor, i.e. inside `super()`. A subclass's field
     * initialisers run *after* that, so `this.events` is genuinely undefined
     * here on the way up. (The note beside those fields said an initialiser runs
     * before any event can; that is true of every event the IDE raises later and
     * false of the ones the load itself raises.)
     */
    SideTabs_Switch() { if (this.events) this.events.shown(); }

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
     * A method here and not a handler on the control itself, unlike the grid's
     * editors: those are built and thrown away, so each carries its own (`On`),
     * while `PropGrid` is declared in this form's `.form` and is always there --
     * which is what makes the name the right place for it. It delegates to
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
    MnuAppInstall_Click() { this.installAsApp(); }

    /*
     * The metainfo: the AppStream file a package, an installer and a software
     * centre read.  The dialog writes a minimal one when the project has none,
     * so this is also how a project gets its first -- and the file is in the
     * tree beside `project.json` from then on, where the raw tab edits it.
     */
    MnuMetainfo_Click() { this.editMetainfo(); }

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

    /*
     * Quick open, and the palette, which are one window a character apart --
     * `Ctrl+P` lands on the files and `Ctrl+Shift+P` on the commands. See
     * `QuickForm`.
     *
     * `Ctrl+Shift+P` used to be *Project settings*, which gave it up: a reflex
     * brought from every editor written after Sublime has to land on the thing
     * it means, and project settings is two clicks away in the menu it has
     * always been in, and in the tree's own context menu besides.
     */
    /*
     * The pass over the whole project, which is the half `Ide.Live` cannot be:
     * it reads the file on screen, and a control lost to a name collision is
     * lost in a file nobody has open.
     *
     * It runs on its own when a project is opened, so this is *run it again* --
     * the one command a check needs once anybody has fixed something.
     */
    MnuCheck_Click() {
        const found = this.check.run();
        this.ConsoleBox.Current = this.problems.page;
        if (!found.length) this.log(`${Locale.Text("Nothing wrong with the project")}\n`);
    }

    MnuGotoFile_Click()  { QuickForm.show(this, false); }
    MnuCommands_Click()  { QuickForm.show(this, true); }

    Editor_Change() {
        /* Put off whatever the pause was going to check, whether or not the rest
         * of this returns early: the text changed, so what was about to be read
         * is out of date either way. */
        this.live.typed();

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
        /* And the outline marks the method the caret is now inside, which is the
         * half of Visual Basic's procedure dropdown that was not the jump. */
        this.outline.follow();
    }

    /* A row of the outline is a place in the file already open, so `Select` is
     * the gesture -- unlike the Problems panel, where a row is a place in
     * another file and walking the list must not open one per row. */
    OutlineList_Select() { this.outline.chosen(); }

    /*
     * --- the document tabs ---------------------------------------------------
     *
     * Both of these dispatch by name, so they arrive from whichever document is
     * on screen -- the same arrangement `Editor_Change` has -- and the tab is
     * looked up rather than the widget asked which one it belongs to.
     */
    DocSource_Click() {
        const doc = this.document;
        if (doc) doc.showSource(doc.toggle.Active);
    }

    /* A link in a document. Answering `true` says the IDE dealt with it; a
     * `#anchor` never arrives here, because the component scrolls to it when
     * nobody claims it. */
    Doc_Link(href, text) {
        return this.document ? this.document.follow(href, text) : false;
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
        /* The tree's two, and then the third thing the side bar can be. It is in
         * the same chooser and not a tab strip of its own because it answers the
         * same question -- *what is on the left* -- and two choosers stacked over
         * one column is the shape that makes people hunt. */
        this.CmbView.Items = [...Ide.ProjectTree.views, Locale.Text("Changes")];
        this.CmbView.Index = this.sideView;
    }

    /*
     * Which of the three is up, remembered across runs.
     *
     * The tree's own view is `ProjectTree`'s and stays there -- it is what the
     * tree is built from. What this adds is *the tree at all*, which is why the
     * two are not one number: coming back to the Changes page and choosing
     * Project again must find the view it was left in.
     */
    get sideView() {
        return Settings.Get("side.changes", false) ? Ide.Changes.view
                                                  : this.projectTree.view;
    }

    CmbView_Select() {
        const which = this.CmbView.Index;
        /* Filling `Items` moves the chooser to nothing on the way past, and
         * *nothing* is not a view to switch to. */
        if (which < 0) return;

        const changes = which === Ide.Changes.view;

        Settings.Set("side.changes", changes);
        this.FileTree.Visible   = !changes;
        this.ChangesBox.Visible = changes;

        if (changes) this.changes.shown();
        else         this.projectTree.setView(which);
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

    /*
     * --- F1 -----------------------------------------------------------------
     *
     * The reference, opened at whatever is being pointed at. Three answers, in
     * the order the question is usually being asked:
     *
     *   a control is selected     its class's page
     *   the editor has the focus  the word the cursor is on -- `File.Load` opens
     *                             `File` and lands on `Load`
     *   neither                   the index
     *
     * Everything about *showing* it is `HelpForm`'s; what is here is only which
     * page, which is the one question this form can answer and that one cannot.
     */
    MnuReference_Click() {
        const root = HelpForm.root();
        if (!root) {
            Message.Warning("The reference is not installed beside this build.");
            return;
        }

        const at = this.helpTopic();
        if (at) HelpForm.open(at.page, at.member);
        else    HelpForm.open(File.Join(root, "README.md"));
    }

    /* What F1 is about, or `null` for *the reference itself*. */
    helpTopic() {
        const control = this.designing ? this.designer.selected : null;

        if (control) {
            /* The tree's own answer, which knows a stand-in from a control: a
             * component's name has no page here, and falling through to the word
             * under the cursor is the right thing when it does not. */
            const page = HelpForm.pageFor(this.designer.tree.typeOf(control));
            const grid = this.designer ? this.designer.grid : null;
            if (page) return { page, member: grid ? grid.currentProperty() : "" };
        }

        const word = this.wordAtCursor();
        if (!word) return null;

        /* `File.Load` is a page and a member; `TableView` is a page. */
        const dot  = word.indexOf(".");
        const name = dot > 0 ? word.slice(0, dot) : word;
        const page = HelpForm.pageFor(name);

        return page ? { page, member: dot > 0 ? word.slice(dot + 1) : "" } : null;
    }

    /* The word the caret is in, as a name: letters, digits and the dot that
     * joins an object to one of its members. `""` where there is no editor or
     * nothing under the cursor. */
    wordAtCursor() {
        const editor = this.Editor;
        if (!editor || !editor.Visible) return "";

        const line = (editor.Text.split("\n")[editor.Line - 1] || "");
        const at   = Math.max(0, Math.min(line.length, editor.Column));

        let from = at, to = at;
        const part = (c) => c !== undefined && /[\w.]/.test(c);

        while (from > 0 && part(line[from - 1])) from--;
        while (to < line.length && part(line[to])) to++;

        return line.slice(from, to).replace(/^\.+|\.+$/g, "");
    }

    /* F12. Everything about *which* definition is `Navigator`'s; what is here
     * is the key, the way `MnuReference_Click` is F1's and nothing more. */
    MnuGoto_Click() { this.navigator.go(); }

    /*
     * --- debugging ----------------------------------------------------------
     *
     * Everything about *what* happens is `Ide.Debugger`'s; these are the keys.
     * *Debug* is also *Continue*, the way F5 is in every environment since
     * Visual Basic: what one presses to get going is the same whether it has
     * started or not.
     */
    MnuDebug_Click()      { this.debugger_.start(); }
    MnuPause_Click()      { this.debugger_.pause(); }
    MnuStepInto_Click()   { this.debugger_.step("into"); }
    MnuStepOver_Click()   { this.debugger_.step("over"); }
    MnuStepOut_Click()    { this.debugger_.step("out"); }
    MnuBreakpoint_Click() { this.debugger_.toggle(); }

    /* Stopping where a throw happens, which is **every** throw and not only the
     * ones nobody catches: whether something above will catch it is not a
     * question the engine can answer at the moment it is raised. */
    MnuStopThrow_Click() { this.debugger_.stopOnThrow(this.MnuStopThrow.Value); }

    /* The immediate box: Enter answers, the button keeps the question. */
    TxtImmediate_Activate() {
        this.debugger_.ask(this.TxtImmediate.Text.trim());
    }

    BtnWatch_Click() {
        if (this.debugger_.watch(this.TxtImmediate.Text.trim()))
            this.TxtImmediate.Text = "";
    }

    /* A row of the values: a watch comes off, a value is changed. */
    LocalList_Activate() { this.debugger_.activated(this.LocalList.Index); }

    /* A frame of the stack chosen: go to its line, and show *its* values. */
    StackList_Select() { this.debugger_.showFrame(this.StackList.Index); }

    /*
     * --- git ----------------------------------------------------------------
     *
     * Everything that runs one is `Ide.Git`; these are the commands. Asking
     * again is explicit rather than on a timer: a repository changes because
     * somebody did something, and a tree that redrew itself every few seconds
     * would move under the pointer.
     */
    MnuGitRefresh_Click() { this.refreshGit(); }

    MnuGitChanges_Click() { GitForm.open(this); }

    /*
     * A repository where there was none.
     *
     * Asked first, because it writes to the project's directory and a `.git`
     * appearing in a tree somebody did not ask for is the kind of surprise this
     * IDE does not spring. What it does not do is commit anything: what to put
     * in the first commit is the programmer's question, and the Changes window
     * is where it is answered.
     */
    MnuGitInit_Click() {
        ConfirmForm.ask(Locale.Text("Start a repository"),
                        Locale.Text("Create a git repository in {0}?", this.project),
                        Locale.Text("Create"),
                        () => {
                            const r = this.git.run(["init"]);
                            this.log(r.out.trim() ? `${r.out.trim()}\n` : "");
                            this.git.forget();
                            this.refreshGit();
                            this.listFiles();
                        });
    }

    /*
     * A file was written, so what git says about the project is older than the
     * project is.
     *
     * The tree's `[M]`, the counts in the status bar and the Changes page all
     * come from one `git status`, and without this they answered about the file
     * as it was before the save -- which is the moment somebody is most likely
     * to look at them. It is deliberately **not** `refreshGit`: the branches and
     * the distance from the remote cannot change because a buffer was written,
     * and a save is not the place to spend four child processes.
     */
    afterSave() {
        if (!this.git.available || !this.project) return;

        this.git.refreshStatus();
        this.git.markTree();
        this.changes.reload();
    }

    refreshGit() {
        this.git.refresh();
        this.git.markTree();
        this.changes.reload();
        this.showBranches();
        this.refresh();
    }

    /*
     * The branches, in the two menus that list them.
     *
     * Filled **here** and not in `refresh()`, which runs on every keystroke and
     * every selection: asking git costs a child process, and the branches change
     * when somebody does something rather than continuously. It is the same
     * reason `refreshGit` exists at all.
     */
    showBranches() {
        const on   = this.git.isRepo;
        const all  = on ? this.git.branches() : [];
        const here = this.git.branchName;

        /* The current one is marked and stays in the list: a list that dropped
         * it would make *where am I* a question with no answer on screen. */
        this.branchNames = all;
        this.MnuGitBranch.Items = all.length
            ? all.map((n) => (n === here ? `${BRANCH_HERE}${n}` : `${BRANCH_OTHER}${n}`))
            : [Locale.Text("(no branches yet)")];

        /* Deleting is the other list, and the one you are standing on is not in
         * it: git refuses that anyway, and offering it is offering an error. */
        this.dropNames = all.filter((n) => n !== here);
        this.MnuGitDropBranch.Items = this.dropNames.length
            ? this.dropNames.slice()
            : [Locale.Text("(no other branch)")];

        this.MnuGitBranch.Enabled     = on && all.length > 0;
        this.MnuGitDropBranch.Enabled = on && this.dropNames.length > 0;
    }

    /*
     * Moving to another branch.
     *
     * Saved first -- the Run and Export precedent: never operate on something
     * other than what is on screen, and a checkout with an unsaved buffer is a
     * file whose two versions are both wrong. Asked first as well when git says
     * there is something uncommitted, because a switch can refuse halfway and
     * leave the worktree spread across two branches.
     *
     * What happens to the files afterwards is not this method's problem: each
     * open tab watches its own file and the reload bar is what a file changing
     * underneath already looks like. That is the case those were written for.
     */
    MnuGitBranch_Click(index) {
        const name = (this.branchNames || [])[index];
        if (!name || name === this.git.branchName) return;

        this.saveAllDirty();

        const dirty = this.git.staged + this.git.changed;
        if (!dirty) return this.switchBranch(name);

        this.branchAsk = ConfirmForm.ask(
            Locale.Text("Switch branch"),
            Locale.Plural("There is {0} change here. Switching keeps it, unless the two branches disagree about the same file.",
                          "There are {0} changes here. Switching keeps them, unless the two branches disagree about the same file.",
                          dirty),
            Locale.Text("Switch"),
            () => this.switchBranch(name));
    }

    switchBranch(name) {
        const r = this.git.switchTo(name);

        this.log(r.out.trim() ? `${r.out.trim()}\n` : "");
        this.refreshGit();
        this.listFiles();
    }

    MnuGitNewBranch_Click() {
        /* Kept the way `columnEditor` is: a modal dialog is a window with no
         * other reference, and a test has to reach the one that is open. */
        this.branchAsk = AskForm.prompt(Locale.Text("New branch"), Locale.Text("Called"), "",
                       (name) => {
                           const r = this.git.newBranch(name.trim());
                           this.log(`${r.out.trim()}\n`);
                           this.refreshGit();
                           this.listFiles();
                       });
    }

    /*
     * Deleting one, which git refuses when it would lose commits -- and the
     * refusal is shown rather than worked around. `-D` is not offered: it would
     * be offering to ignore the one check that matters, and somebody who means
     * it has the Terminal tab.
     */
    MnuGitDropBranch_Click(index) {
        const name = (this.dropNames || [])[index];
        if (!name) return;

        this.branchAsk = ConfirmForm.ask(
            Locale.Text("Delete a branch"),
            Locale.Text("Delete {0}? Anything committed only there would be refused rather than lost.", name),
            Locale.Text("Delete"),
            () => {
                const r = this.git.deleteBranch(name);
                this.log(`${r.out.trim()}\n`);
                this.refreshGit();
            });
    }

    MnuGitLog_Click() { LogForm.open(this); }

    /*
     * --- the Changes page of the side bar -----------------------------------
     *
     * The handlers are one line each and the decisions are all in
     * `Ide.Changes`: this is the wiring between a control and a method, which
     * is what a `.form` and its class are for.
     */
    ChangeTable_Select()   { this.changes.say(); }
    ChangeTable_Activate() { this.changes.show(this.ChangeTable.Index); }

    TxtCommit_Change()   { this.changes.say(); }
    /* Enter in the box is the button: that is what makes it quick. */
    TxtCommit_Activate() { this.changes.commit(); }

    BtnChStage_Click()  { this.changes.stage(); }
    BtnChCommit_Click() { this.changes.commit(); }

    MnuChDiff_Click()    { this.changes.show(this.ChangeTable.Index); }
    MnuChOpen_Click()    { this.changes.open(this.ChangeTable.Index); }
    MnuChStage_Click()   { this.changes.stage(); }
    MnuChUnstage_Click() { this.changes.unstage(); }
    MnuChDiscard_Click() { this.changes.discard(); }
    MnuChAll_Click()     { this.changes.stageAll(); }
    MnuChWindow_Click()  { GitForm.open(this); }

    /*
     * --- the remotes --------------------------------------------------------
     *
     * The three that talk to somebody else's server, and the only git here that
     * is not a question answered in milliseconds. They go through `Exec` into
     * the log pane -- the `Runner` mould -- so the IDE stays usable while they
     * take as long as the network does, and Stop reaches them.
     *
     * **None of them can ask for a password.** A prompt with no terminal to
     * show it is a child waiting forever with nothing on screen saying why, so
     * the environment tells git and ssh to fail instead. What comes back is a
     * line in the log, and the Terminal tab is one click away for somebody who
     * needs to answer like a person.
     */
    MnuGitFetch_Click() { this.git.fetch(() => this.refreshGit()); }

    /*
     * Pull saves first, the way Run and Export and a branch switch do: never
     * operate on something other than what is on screen. `--ff-only`, so a pull
     * that would need a merge stops and says so rather than opening an editor
     * for a commit message inside a child nobody is looking at.
     */
    MnuGitPull_Click() {
        this.saveAllDirty();
        this.git.pull((ok) => {
            this.refreshGit();
            /* The worktree may be another one now, and the open tabs are already
             * watching their own files -- this is the tree catching up. */
            if (ok) this.listFiles();
        });
    }

    MnuGitPush_Click() { return this.git.push(() => this.refreshGit()); }

    /*
     * Cloning, which is the one git command that runs where there is no project.
     *
     * Asked in two steps because it needs two answers -- where from and where to
     * -- and the folder is asked with the desktop's own chooser rather than a
     * path typed into a box. What lands is opened as a project, which is what
     * somebody cloning one wanted; a clone of something that is not a Bintana
     * project opens anyway and says it has no `project.json`, which is the
     * sentence `openProject` already has.
     */
    MnuGitClone_Click() {
        this.leaveProject(() => {
            this.cloneAsk = AskForm.prompt(
                Locale.Text("Clone a repository"), Locale.Text("From"), "",
                (url) => this.cloneFrom(url.trim()));
        });
    }

    cloneFrom(url) {
        if (!url) return;

        Dialog.SelectFolder(Locale.Text("Clone into"),
                            { Folder: Environment.HomeDirectory },
                            (into) => this.cloneInto(url, into));
    }

    /*
     * The name git would give it, which is what a person expects to find: the
     * last piece of the URL without its `.git`. Worked out here rather than left
     * to git because the IDE has to know what to open afterwards, and refusing a
     * destination that exists is better than letting git refuse it -- the answer
     * arrives before anything runs.
     */
    cloneInto(url, into) {
        const name  = File.BaseName(url.replace(/\/+$/, ""));
        const where = File.Join(into, name);

        if (File.Exists(where)) {
            Message.Error("{0} already exists.", where);
            return;
        }

        this.git.clone(url, where, (ok) => {
            this.refreshGit();
            if (ok) this.openProject(where);
        });
        this.refresh();
    }

    /*
     * Ctrl+Shift+O, and Ctrl+L on the same command: the methods of the file as a
     * list, or a line number.  `SymbolForm` filters and hands back a line; which
     * methods there are is `Navigator.symbols`, which is where the one regular
     * expression that knows what a declaration looks like lives.
     */
    MnuGotoSymbol_Click() {
        if (!this.Editor) return;

        const text = this.Editor.Text;

        /* Kept the way `columnEditor` is: a modal dialog is a window with no
         * other reference, and a test has to be able to reach the one that is
         * open. */
        this.symbolPicker =
            SymbolForm.go(this.navigator.symbols(text), text.split("\n").length,
                          (line) => {
                              this.Editor.GotoLine(line);
                              this.Editor.SetFocus();
                          });
    }

    MnuRecent_Click(index) {
        const dir = this.recent[index];
        if (dir) this.leaveProject(() => this.openProject(dir));
    }

    MnuReload_Click() { this.BtnReload_Click(); }
    MnuSave_Click()   { this.save(); }
    MnuSaveAll_Click() { this.saveAllDirty(); }
    MnuQuit_Click()   { if (!this.confirmQuit()) this.quit(); }

    MnuRun_Click()    { this.run(); }
    /* One Stop for both: whichever of the two started a child, this is what
     * ends it -- a second button for "stop the one being debugged" would be a
     * second answer to a question with one. */
    MnuStop_Click()   { this.stopRun(); }

    /* A tick, and the runtime has already moved it: what is left is remembering
     * it. What it does is one argument to `bintana` -- see `Ide.Runner`. */
    MnuStrict_Click(on) { this.runner.chose(on); }

    /*
     * Which configuration this project runs with. A radio item, so the runtime
     * has already moved the mark and hands over the entry that was chosen; what
     * is left is writing it down, which is `Ide.Launch`'s -- it is yours and
     * per project, not the project's.
     */
    MnuLaunch_Click(index, text) {
        this.launch.choose(text);
        this.refresh();
    }

    MnuLaunchEdit_Click() { this.editLaunch(); }

    stopRun() {
        this.runner.stop();
        this.debugger_.stop();
        /* A fetch over a slow link is a child like any other, and Stop is the
         * one button that ends whichever of them is going. */
        this.git.stop();
    }

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
     * The order Tab takes the controls of a container in -- Delphi's *Edit >
     * Tab Order...*, in the Form menu because that is the menu about the form
     * being designed.
     *
     * Kept while it is open for the same reason the menu editor and the symbol
     * picker are: so a test can drive the dialog the menu opened rather than
     * the method under it.
     */
    MnuTabOrder_Click() {
        if (!this.designing) {
            Message.Warning("Open a form's design to edit its tab order.");
            return;
        }
        this.tabOrderForm = TabOrderForm.open(this);
    }

    /*
     * The version, and the binary it is running on.  Kept while it is open for
     * the same reason the menu editor is: so a test can drive the dialog the
     * menu opened, rather than the method under it.
     */
    MnuAbout_Click() { this.about = AboutForm.show(); }
}
