/*
 * Integration test for the IDE.
 *
 * Loads the real ide/MainForm.js (see project.json) and drives it the way a
 * user would: selecting in the file list, typing in the editor, pressing the
 * toolbar buttons.  MainForm.form is a symlink to the IDE's own, so the two
 * cannot drift apart.
 *
 * The project it opens is generated in /tmp and quits by itself, so pressing
 * Run terminates instead of leaving a window open forever.
 */
"use strict";

/*
 * The project this suite builds and drives.  Tagged with whatever the runner
 * passed -- its pid -- so two suites running at once do not edit each other's
 * files: those collisions fail assertions that look like real bugs.
 */
const TAG = Application.Arguments[0] ? `-${Application.Arguments[0]}` : "";
const TMP = `/tmp/bta-test-ide${TAG}`;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function neq(name, got, unwanted) {
    check(name, got !== unwanted, `expected something other than ${JSON.stringify(unwanted)}`);
}

/*
 * Opening a project the way somebody who has never opened it before does.
 *
 * `Session` gives a project back the tabs it was left with, so `openProject` is
 * no longer the reset it was when these phases were written: reopening TMP in
 * the middle of a run would drag the previous phase's strip along with it, and
 * three phases assert what a fresh one looks like. Forgetting what is
 * remembered first *is* a first open -- and it is also what keeps one run of
 * the suite out of the next one's settings, since `examples/hello` and `ide/`
 * are the same two paths every time.
 *
 * The phase that tests the remembering is `session`, and it is the only one
 * that must not come through here.
 */
function openFresh(ide, dir) {
    /* The tabs first: `openProject` writes the session of the project it is
     * *leaving* before it closes anything, so clearing the map and then opening
     * the same project again would put it straight back. Nothing open is not a
     * session, so closing is what empties the entry. */
    ide.tabs.discardAll();
    Settings.Set("session.projects", {});
    ide.openProject(dir);
}

/* Undo rebuilds the widget tree, so a held reference goes stale: look up by
 * name after anything that can restore. */
/* The whole tree and not the first level: a form's controls are nested as deep
 * as it likes -- the IDE's own keeps all of them inside the stack that holds its
 * welcome page and its workspace -- and a name is unique across it either way. */
function byName(ide, name) {
    return ide.designer.allControls().find((c) => c.Name === name);
}

/*
 * Hands control back to GTK until something is true, or gives up.
 *
 * A frame is not a promise: a text change re-measures a label on the next one,
 * a container just shown may need two, and a machine under a sanitizer needs
 * more.  Counting yields by hand is what made these tests flaky; waiting for the
 * thing itself is not.
 */
function* until(what, tries = 30) {
    while (tries-- > 0 && !what()) yield;
}

/*
 * Hands control back until the layout stops moving.
 *
 * A bare `yield` is one turn of the main loop, and GTK does not promise to have
 * allocated anything by then -- under load it often has not.  That matters more
 * than it looks: aligning, resizing and distributing all read *drawn* geometry,
 * so driving one of them before the layout has settled measures the previous
 * frame and moves things to where they used to be.
 *
 * Two consecutive frames with identical geometry is the only general signal
 * there is that GTK is done; waiting for a specific number would be counting
 * frames again, which is what made these tests flaky in the first place.
 */
function* settled(ide) {
    const controls = () => (ide.designing ? ide.designer.allControls() : []);

    const snap = () => JSON.stringify([
        ide.Tabs.Height, ide.WorkArea.Width, ide.WorkArea.Height,
        controls().map((c) => ide.designer.rectOf(c)),
        /* The selection chrome is not a control and would not be watched below,
         * yet it is what half of these assertions measure. */
        ide.designing ? ide.designer.chrome.outline.map((b) => [b.X, b.Y, b.Width, b.Height])
                      : null,
    ]);

    /*
     * Nothing is allocated at the start, and two *unallocated* frames look
     * exactly alike -- so waiting for stillness first would call a surface of
     * zeroes settled.  Wait for real geometry before waiting for it to stop.
     */
    yield* until(() => controls().every((c) => {
        const r = ide.designer.rectOf(c);
        return !c.Visible || (r && r.w > 0 && r.h > 0);
    }));

    /* The designer re-lays its chrome on a 30 ms timer after every move, which
     * is several frames away: while that is pending nothing has settled. */
    yield* until(() => !ide.designing || !ide.designer.chrome.timer);

    let before = snap();
    yield;

    for (let tries = 0; tries < 30; tries++) {
        const now = snap();
        if (now === before) return;
        before = now;
        yield;
    }
}

/*
 * The palette's square button for that type.  Pressing it is how a user adds a
 * control: the button really exists, with its icon and its DragData, and its
 * Click travels through the same dispatch-by-name as any other control.
 */
function palette(ide, type) {
    return ide.palette.buttons[type];
}

/* The control the grid edits a property with.  Asked for again every time:
 * changing the selection rebuilds the grid and the previous editors are gone. */
/* Half a grip: the middle of it, which is where a drag has to grab. Kept in
 * step with Designer's HANDLE by hand -- the test drives the IDE from outside
 * and has no import to lean on. */
const HANDLE_HALF = 4;

function editor(ide, key) {
    return ide.designer.grid.editors[key];
}

/*
 * A drop-down and a spin apply on change alone: assigning the value goes out to
 * GTK and comes back as a signal, which is the round trip worth testing.  A text
 * field waits for Enter, and from JS that means raising it on the editor --
 * `Emit` goes through the same dispatch a real Enter would, which is what finds
 * the handler the grid installed on that control with `On`.
 */
function typeInto(ide, key, text) {
    editor(ide, key).Text = text;
    editor(ide, key).Emit("Activate");
}

/* Compile without running: the only honest way to claim that a file the IDE
 * rewrote is still valid JavaScript. */
function parses(source) {
    return Application.CheckSource(source) === null;
}

/* Deletes a folder and its contents: if it survives, the next run finds the
 * project already created and fails for something that is not the code. */
/*
 * Deletes a folder and everything under it.
 *
 * It walks now, and did not have to before: a project's files were all in one
 * directory. Once a new project starts with a `forms/` folder in it, a sweep
 * that only deletes files leaves the folder behind and `File.Delete` on a
 * non-empty directory refuses -- which is what it should do, and what the
 * runtime has no recursive answer for yet.
 */
function removeTree(dir) {
    if (!File.IsDir(dir)) return;

    for (const name of Directory.List(dir)) {
        const path = File.Join(dir, name);
        if (File.IsDir(path)) removeTree(path);
        else                  File.Delete(path);
    }
    File.Delete(dir);
}

function report() {
    print("");
    for (const f of failures) print(`  FAIL  ${f}`);

    /* A partial run says so, and says what it was: a green line that looks like
     * the whole suite passing, when eight of twelve phases never ran, is the
     * worst thing this file could print. */
    const what = !partial ? ""
               : ran.length ? `  [only ${ran.join(", ")}]`
                            : "  [nothing ran]";
    print(`ide: ${passed} passed, ${failures.length} failed${what}`);
    Application.Quit(failures.length ? 1 : 0);
}

/*
 * Everything under a directory, the directory itself left standing.  The tests
 * create folders now, and a leftover one from the previous run would show up as
 * a component nobody created in this one.
 */
function wipe(dir) {
    for (const name of Directory.List(dir)) {
        const path = File.Join(dir, name);
        try {
            if (File.IsDir(path)) wipe(path);
            File.Delete(path);
        } catch (e) {
            /* Nothing to do about it here; the assertions will say. */
        }
    }
}

/* A project that opens and immediately quits, so Run is testable. */
function makeChildProject() {
    Directory.Make(TMP);
    wipe(TMP);

    File.Save(File.Join(TMP, "project.json"),
              JSON.stringify({ name: "child", startup: "Child", sources: ["Child.js"],
                               uses: ["gadgets"] }));

    /*
     * **A library, in the project's own `lib/`** -- the first of the six places
     * `uses` looks, and the only one a test can write to without an environment
     * variable. What the IDE has to do with it is offer its components in a tab
     * of their own, which is what `p_palette` asserts below.
     */
    Directory.Make(File.Join(TMP, "lib", "gadgets"));
    File.Save(File.Join(TMP, "lib", "gadgets", "Dial.js"),
              'class Dial extends Component {\n' +
              '    static Events = ["Turn"];\n' +
              '    get Value() { return this._v || 0; }\n' +
              '    set Value(v) { this._v = Number(v) || 0; }\n' +
              '}\n');
    File.Save(File.Join(TMP, "lib", "gadgets", "Dial.form"), JSON.stringify({
        format: "bintana-form/1", class: "Dial",
        properties: { Width: 140, Height: 90 },
        children: [{ type: "Label", name: "Face",
                     properties: { X: 4, Y: 4, Text: "dial" } }],
    }, null, 2));
    File.Save(File.Join(TMP, "Child.js"),
              'class Child extends Form {\n' +
              '    Form_Open() {\n' +
              '        print("hello from the child");\n' +
              '        Application.Quit(0);\n' +
              '    }\n' +
              '}\n');

    /* The project's own stylesheet: what the Style drop-down offers before the
     * theme's classes, and a file the tree has to file and open like any other. */
    File.Save(File.Join(TMP, "app.css"),
              "/* .commented { color: red; } */\n" +
              ".danger { background-color: #c01c28; }\n" +
              ".danger:hover { background-color: #e01b24; }\n" +
              "button.pill-ish { border-radius: 12px; }\n");

    /* A .form for the designer.  At the end of the test the child really runs,
     * so this also proves that what the designer saves loads. */
    File.Save(File.Join(TMP, "Child.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Child",
        properties: { Text: "child", Width: 320, Height: 200 },
        children: [
            { type: "Button", name: "Ok",
              properties: { X: 20, Y: 30, Width: 100, Height: 30, Text: "ok" } },
            { type: "Label", name: "Msg",
              properties: { X: 20, Y: 80, Width: 120, Height: 24, Text: "hi" } },
        ],
    }, null, 2));
}

function* p_welcome(ide) {
    /*
     * Nothing open yet.  A page belongs to the file that opened it, so there are
     * none -- and a notebook with no pages is not nothing: it is an expanding
     * widget with an empty body, and it took 209px between the toolbar and a
     * blank editor before this. With no page there is no tab to click and no tab
     * action to take, so the strip is not there at all.
     */
    /*
     * And with no project there is no workspace either: the window is its
     * welcome page, which is the whole of what it can do at that point -- open
     * one, start one, or go back to one it knows.  A `Switcher` with no strip is
     * what holds the two, so this is the same switch a notebook makes and not a
     * pile of Visible flags.
     */
    eq("with no project the window is its welcome page", ide.Pages.Current, 0);
    eq("which is a stack with nothing to click between its pages",
       ide.Pages.Strip, "None");
    eq("and the workspace is the other one", ide.Pages.Count, 2);
    check("the recent list is the menu's, on the page",
          ide.WelcomeRecent.Count === Math.max(1, ide.recent.length),
          `${ide.WelcomeRecent.Count} rows for ${ide.recent.length} projects`);

    eq("no file, no pages", ide.Tabs.Count, 0);
    eq("and no strip either", ide.Tabs.Visible, false);
    eq("nor an editor: a code tab owns its own, and there is no tab",
       ide.Editor, null);
    check("so nothing in the work area is showing",
          ide.WorkArea.Children.every((c) => !c.Visible),
          ide.WorkArea.Children.map((c) => `${c.Name}=${c.Visible}`).join(" "));

    /*
     * And the window survives being asked what it can do before anything has been
     * listed.  `bintana ide` with no argument is exactly this state, and it is the one
     * the suite cannot reach on its own -- the runner always passes its pid, so
     * `Form_Open` takes the other branch.  A field left undeclared crashed the
     * IDE on startup here and every assertion above still passed.
     */
    ide.refresh();
    eq("with no project, the tree's menu can do nothing",
       ide.MnuFtStartup.Enabled, false);
    eq("...and the project's own settings are not on offer",
       ide.MnuProjectSettings.Enabled, false);
    eq("...nor is installing an application, which is about a project",
       ide.MnuAppInstall.Enabled, false);

    /* A relative path has to end up absolute: when running, the child starts
     * with the project as its cwd and the relative one would stop resolving.
     * (run.sh runs from the repo root.) */
    openFresh(ide, "examples/hello");
    eq("opening one turns the window into the workspace", ide.Pages.Current, 1);
    check("a relative project path is made absolute",
          ide.project.startsWith("/"), ide.project);
    check("and still points at the same project",
          ide.project.endsWith("examples/hello"), ide.project);

    makeChildProject();
    openFresh(ide, TMP);

    /* --- recent projects -------------------------------------------------
     * The submenu is built from what there is: a dynamic list, not items
     * declared in the .form.  Choosing one opens that project, and opening
     * something already on the list moves it up instead of repeating it. */
    eq("the project just opened tops the recent list", ide.recent[0], ide.project);
    check("the one before it comes next",
          ide.recent[1].endsWith("examples/hello"), JSON.stringify(ide.recent));
    eq("the menu shows one entry per remembered project",
       ide.MnuRecent.Items.length, ide.recent.length);
    check("each labelled with the project's folder",
          ide.MnuRecent.Items[0].includes(File.Name(TMP)), ide.MnuRecent.Items[0]);
    eq("and the submenu is available", ide.MnuRecent.Enabled, true);

    /* The welcome page reads the same list -- one place builds it, so the two
     * cannot disagree about what was opened last -- and choosing a row opens it,
     * dropping the selection so the same project can be chosen twice. */
    eq("the page lists what the menu lists",
       ide.WelcomeRecent.Count, ide.MnuRecent.Items.length);
    eq("in the same order", ide.WelcomeRecent.Items[0], ide.MnuRecent.Items[0]);

    /* Selecting a row is what a click does, handler and all.  Row 1 is the one
     * *before* the project that is open, so this really opens something -- and
     * the row after it is this project again, which puts it back. */
    ide.WelcomeRecent.Index = 1;
    check("choosing a row on the page opens that project",
          ide.project.endsWith("examples/hello"), ide.project);
    eq("and lets go of it, so the same one can be chosen twice",
       ide.WelcomeRecent.Index, -1);
    eq("with the window on the workspace", ide.Pages.Current, 1);

    ide.WelcomeRecent.Index = 1;
    eq("and back, which is what a list of recent projects is for",
       ide.project, File.Absolute(TMP));

    const remembered = ide.recent.length;

    /* Click(1) walks the real path: it activates the menu action with the index
     * as its parameter, which is what GTK does when the entry is chosen. */
    ide.MnuRecent.Click(1);
    check("choosing an entry opens that project",
          ide.project.endsWith("examples/hello"), ide.project);
    eq("and it moves to the top", ide.recent[0], ide.project);
    eq("without growing the list", ide.recent.length, remembered);
    eq("nor repeating anything", new Set(ide.recent).size, ide.recent.length);

    ide.MnuRecent.Click(1);
    eq("the list survives a round trip", ide.project, File.Absolute(TMP));

    /* Kept in Settings, which is where anything an application remembers goes:
     * the IDE has no file-writing of its own for this. */
    check("the list is written down to outlive the IDE",
          Settings.Get("recent", [])[0] === ide.project,
          JSON.stringify(Settings.Get("recent", [])));
    check("and it is in the settings file, readable by hand",
          JSON.parse(File.Load(Settings.Path)).recent[0] === ide.project);

    /* --- opening a project ---------------------------------------------- */
    /*
     * Four of the project's own, plus the two of the library it keeps in its own
     * `lib/`: **a vendored library is in the tree and editable**, because it is a
     * file in the project. What it is not is one of the project's *classes* --
     * see the palette phase, where it gets a tab of its own rather than sitting
     * in `Project`.
     */
    eq("lists the project files, a vendored library's included",
       ide.files.length, 6);
    eq("Save starts disabled", ide.BtnSave.Enabled, false);
    eq("Run enables with a project", ide.BtnRun.Enabled, true);
    eq("Refresh enables with a project", ide.BtnReload.Enabled, true);

    /* --- about ------------------------------------------------------------
     *
     * The two things the window cannot say on its own: which version this is,
     * and which of the builds on this machine it is running on.  Driven through
     * the *menu item*, because a method called directly says nothing about the
     * item that is supposed to reach it -- which is how the IDE once had two
     * `renameSelected` and a dead one of them.
     */
    ide.MnuAbout.Click();
    yield;

    const about = ide.about;
    check("the about dialog opens", !!about);
    check("it says which version this is",
          about.LblVersion.Text.includes(BTA_VERSION), about.LblVersion.Text);
    check("...and which version the IDE itself is, which is the other question",
          about.LblVersion.Text.includes(Application.Version),
          `${about.LblVersion.Text} / ${Application.Version}`);
    eq("and which binary it is running on", about.LblRuntime.Text, Application.Executable);
    eq("with the whole path in reach, however narrow the dialog",
       about.LblRuntime.Tooltip, Application.Executable);
    check("while the prose stays in the .form, where the catalogue reads it",
          about.LblName.Text !== "" && about.LblSummary.Text !== "",
          `${about.LblName.Text} / ${about.LblSummary.Text}`);

    /*
     * Escape is declared rather than handled now: `BtnClose` carries `Cancel` in
     * the .form, and the runtime presses it. `CancelButton` is what says the
     * declaration arrived, and clicking it is the very signal Escape emits --
     * the key itself is the one part of this no suite can make, so it is on the
     * by-hand list with every other question about real key delivery.
     */
    check("Escape has somewhere to go", about.CancelButton === about.BtnClose);
    about.CancelButton.Click();
    yield;

    eq("and closing takes the window away", about.Visible, false);
}

function* p_files(ide) {
    /* --- selecting a file ----------------------------------------------- */
    check("Child.js is listed", ide.files.includes("Child.js"),
          JSON.stringify(ide.files));

    /* The tree groups a form with its code, and hangs both off a category. */
    check("forms get their own branch", ide.FileTree.Exists("cat:forms"));
    check("with a node per form", ide.FileTree.Exists("form:Child"));
    check("holding the design", ide.FileTree.Exists("Child.form"));
    check("and the code", ide.FileTree.Exists("Child.js"));
    check("project.json is not filed under forms",
          ide.FileTree.Exists("cat:other") && ide.FileTree.Exists("project.json"));
    /* The stylesheet is the application's look and is edited here, not outside:
     * a project whose app.css could only be reached from a terminal would have
     * classes nobody writes, and Style would go back to being decoration. */
    check("and the stylesheet is a file of the project like any other",
          ide.FileTree.Exists("app.css"), JSON.stringify(ide.files));

    ide.FileTree.Key = "Child.js";             /* fires FileTree_Select */
    eq("selecting loads the file", ide.activeFile, "Child.js");
    check("the editor shows the contents",
          ide.Editor.Text.includes("hello from the child"));
    eq("highlighting follows the extension", ide.Editor.Language, "js");
    eq("loading a file is not an edit", ide.Editor.Modified, false);
    eq("Save stays disabled after a load", ide.BtnSave.Enabled, false);

    /* --- editing and saving --------------------------------------------- */
    ide.Editor.Text = ide.Editor.Text.replace("hello from the child", "edited hello");
    eq("editing enables Save", ide.BtnSave.Enabled, true);
    eq("and the menu item follows it", ide.MnuSave.Enabled, true);

    /* Via the menu: exercises the action and accelerator path, not the button. */
    ide.MnuSave.Click();
    eq("saving clears the dirty flag", ide.Editor.Modified, false);
    eq("saving disables Save again", ide.BtnSave.Enabled, false);
    eq("and disables its menu item", ide.MnuSave.Enabled, false);
    check("the file really changed on disk",
          File.Load(File.Join(TMP, "Child.js")).includes("edited hello"));

    /* A disabled item must be inert: its accelerator is gone with it. */
    ide.MnuSave.Click();
    check("choosing a disabled item does nothing", true);
    eq("menu items report their own name", ide.MnuRun.Name, "MnuRun");
    eq("Stop is off while nothing runs", ide.MnuStop.Enabled, false);

    /* --- multiple tabs: switching preserves per-tab state ---------------- */
    /* With tabs, switching files loses no changes: the state lives in the tab
     * and comes back when you do.  The status bar keeps the asterisk so it is not
     * forgotten. */
    ide.Editor.Text += "\n// dirty\n";
    eq("the dirty mark shows in the status", ide.isDirty(), true);

    ide.FileTree.Key = "project.json";
    eq("switching does not lose the unsaved Child.js",
       ide.openTabs.get("Child.js").dirty, true);
    eq("the new file becomes active", ide.activeFile, "project.json");
    eq("and the new tab is now dirty too", ide.isDirty(), false);
    eq("Child.js is still in the tab strip", ide.openTabs.has("Child.js"), true);

    ide.FileTree.Key = "Child.js";
    check("switching back brings the unsaved text",
          ide.Editor.Text.includes("// dirty"),
          JSON.stringify(ide.Editor.Text.slice(-30)));
    eq("and it is still dirty", ide.isDirty(), true);

    ide.BtnSave.Click();
    eq("saving clears the dirty flag", ide.Editor.Modified, false);
    ide.FileTree.Key = "project.json";
    eq("switches once saved", ide.activeFile, "project.json");
    eq("json gets json highlighting", ide.Editor.Language, "json");

    /* --- find and replace --------------------------------------------------
     *
     * The bar is chrome over `SourceEditor`'s own search, so what is asserted here
     * is that the two are wired: typing in the field counts, the arrows walk the
     * matches, replacing walks on, and closing takes the search off the editor.
     * Whether a match is really drawn highlighted is not answerable from JS --
     * the count is, and it is the same number the highlight comes from.
     */
    ide.FileTree.Key = "Child.js";
    const childSource = ide.Editor.Text;
    ide.Editor.Text   = "uno dos tres\nDos dos\n";

    eq("the find bar starts hidden", ide.FindBar.Visible, false);
    ide.MnuFind.Click();
    eq("Find shows it",              ide.FindBar.Visible, true);
    eq("with no replacement row",    ide.ReplaceRow.Visible, false);

    ide.FindText.Text = "dos";
    eq("typing counts as it goes",   ide.LblFindCount.Text, "3");
    eq("without moving the cursor",  ide.Editor.MatchIndex, 0);

    ide.BtnFindNext.Click();
    eq("the arrow finds one",        ide.Editor.MatchIndex, 1);
    eq("and says which of how many", ide.LblFindCount.Text, "1/3");
    eq("the match is the selection", ide.Editor.Selection, "dos");

    ide.BtnFindNext.Click();
    eq("case-insensitive by default", ide.Editor.Selection, "Dos");
    ide.ChkFindCase.Active = true;
    eq("matching case narrows it",    ide.LblFindCount.Text, "2");
    /* ...and letting it go widens it again -- and makes the selection a match
     * once more, which is why the counter can say which one it is on again. */
    ide.ChkFindCase.Active = false;
    eq("and letting it go widens it", ide.LblFindCount.Text, "2/3");

    ide.Editor.GotoLine(1);
    ide.MnuFindNext.Click();
    eq("F3 finds the first",  ide.Editor.MatchIndex, 1);
    ide.MnuFindNext.Click();
    ide.MnuFindNext.Click();
    eq("and walks to the last", ide.Editor.MatchIndex, 3);
    ide.MnuFindNext.Click();
    eq("then wraps around",     ide.Editor.MatchIndex, 1);
    ide.MnuFindPrev.Click();
    eq("and goes back the other way", ide.Editor.MatchIndex, 3);

    ide.MnuReplace.Click();
    eq("asking to replace opens the second row", ide.ReplaceRow.Visible, true);
    eq("keeping what was already being searched", ide.FindText.Text, "dos");
    ide.ReplaceText.Text = "XX";

    /* Replace acts on the match one is standing on: with none, the first press
     * finds and the second replaces. */
    ide.Editor.GotoLine(1);
    ide.BtnReplace.Click();
    eq("the first press finds",  ide.Editor.MatchIndex, 1);
    ide.BtnReplace.Click();
    check("the second replaces", ide.Editor.Text.startsWith("uno XX tres"),
          JSON.stringify(ide.Editor.Text));
    eq("and walks on to the next of what is left", ide.LblFindCount.Text, "1/2");

    ide.BtnReplaceAll.Click();
    eq("Replace all does the rest", ide.Editor.Text, "uno XX tres\nXX XX\n");
    eq("and leaves nothing to find", ide.LblFindCount.Text, "none");

    ide.BtnFindClose.Click();
    eq("closing hides the bar",    ide.FindBar.Visible, false);
    eq("and takes the search off the editor", ide.Editor.Matches, 0);
    eq("and empties the counter",  ide.LblFindCount.Text, "");

    /* The search belongs to the editor and a code tab owns its editor, so the
     * bar is a view of the active tab -- and of nothing on a form tab. */
    ide.MnuFind.Click();
    ide.FindText.Text = "uno";
    eq("one match in this file", ide.LblFindCount.Text, "1");
    ide.FileTree.Key = "project.json";
    eq("switching tabs re-counts in the new one", ide.LblFindCount.Text, "none");

    /* Put the file back the way the previous section left it: the scratch text
     * was for searching, not for keeping. */
    ide.FileTree.Key = "Child.js";
    ide.Editor.Text  = childSource;
    ide.MnuSave.Click();

}

function* p_designer(ide) {
    /* --- designer: opening ---------------------------------------------- */
    /* Selecting the form's group node opens its design, not a category. */
    ide.FileTree.Key = "form:Child";
    yield;

    eq("a form has no text to search, so the bar closes", ide.FindBar.Visible, false);
    eq("and Find is not on offer",                        ide.MnuFind.Enabled, false);
    /* The design host is shown, not created, so GTK allocates it on a frame of
     * its own choosing -- and everything below reads its geometry. Waiting for
     * the height itself rather than counting yields. */
    yield* until(() => ide.CanvasScroll.Bounds().Height > 0);
    eq("a .form opens in the designer", ide.designing, true);
    eq("the group node stands for the design", ide.activeFile, "Child.form");
    /* There is no editor to get out of the way: an editor belongs to a code
     * tab, and this tab is a form. */
    eq("a design tab has no editor at all", ide.Editor, null);
    eq("the side panel appears with it", ide.SidePanel.Visible, true);

    /* With the editor hidden the Notebook's page is empty.  If it kept
     * expanding, that empty page would take part of the height and leave a blank
     * band between the tabs and the design -- wider the bigger the window.  The
     * Notebook has to be worth exactly its tab strip. */
    /*
     * The design is *in* the page, which is the whole of it.  The notebook used
     * to be a tab strip with an emptied body and the designer hung below it, and
     * that cost two things: the empty page went on claiming height, so a blank
     * band opened between the tabs and the design, and `Tabs.VExpand = !designing`
     * existed to beat it back.  A ratio was what checked it, and a ratio was
     * happy with a 60px band.
     *
     * What is checked now is the arrangement itself: the page holds the design
     * host, and it holds all of it.  A band cannot open between a container and
     * its own child, so the bug is not one that can come back.
     */
    const dPage = ide.openTabs.get(ide.activeFile).view.Bounds();
    const dHost = ide.CanvasScroll.Bounds();

    eq("the notebook expands like a notebook again", ide.Tabs.VExpand, true);
    check("the design is what the page holds",
          dHost.Y >= dPage.Y && dHost.Y + dHost.Height <= dPage.Y + dPage.Height &&
          dHost.X >= dPage.X && dHost.X + dHost.Width  <= dPage.X + dPage.Width,
          `host=${JSON.stringify(dHost)} page=${JSON.stringify(dPage)}`);
    check("and all of it: nothing is left between the tabs and the design",
          dHost.Y === dPage.Y && dHost.Height === dPage.Height,
          `host=${JSON.stringify(dHost)} page=${JSON.stringify(dPage)}`);
    check("the tabs still span the width",
          ide.Tabs.Width > ide.WorkArea.Width / 2,
          `tabs=${ide.Tabs.Width} work=${ide.WorkArea.Width}`);

    /*
     * The form is not flush against the corner of the room it is drawn in, and it
     * is drawn with the decoration it will be shown with.  Both are the board's:
     * a column with the title bar over the canvas and a margin around the two, so
     * nothing has to be positioned.
     */
    const canvasOf = ide.openTabs.get(ide.activeFile).canvas;
    const boardAt  = canvasOf.board.Bounds(), viewAt = ide.CanvasScroll.Bounds();
    const barOf    = canvasOf.titlebar.panel;

    check("the board sits in from the corner, not on it",
          boardAt.X > viewAt.X && boardAt.Y > viewAt.Y,
          `board=${JSON.stringify(boardAt)} view=${JSON.stringify(viewAt)}`);
    eq("and is titled with the form's own caption", canvasOf.titlebar.Text, "child");
    check("which sits above the canvas, not on it",
          barOf.Bounds().Y + barOf.Bounds().Height <= ide.Canvas.Bounds().Y,
          `bar=${JSON.stringify(barOf.Bounds())} ` +
          `canvas=${JSON.stringify(ide.Canvas.Bounds())}`);

    /*
     * And it is the *desktop's* title bar, not a drawing of one: the two style
     * classes GTK dresses a window's own decoration with, which is what makes the
     * theme paint it here exactly as the window manager will paint it there.
     */
    eq("the title bar wears the theme's decoration",
       barOf.Style, "titlebar default-decoration");

    /* Rounded where the window meets the sky, square where it meets its own
     * body -- the one part of the decoration a theme cannot be asked for, since
     * GTK rounds a window through a `window` node no designer can build. */
    check("and is rounded on top and square underneath",
          /^[1-9]\d* [1-9]\d* 0 0$/.test(barOf.Radius), barOf.Radius);

    /*
     * The buttons are the ones this desktop puts on a window, in the order it
     * puts them: `Application.DecorationLayout` is the setting the window manager
     * reads too, so a machine that closes on the left is previewed that way.
     */
    const wanted = (Application.DecorationLayout || "icon:minimize,maximize,close")
                       .split(":").join(",").split(",")
                       .map((name) => name.trim())
                       .filter((name) => ["minimize", "maximize", "close"].includes(name));

    check("the buttons follow the desktop's decoration layout",
          wanted.length > 0 &&
          JSON.stringify(canvasOf.titlebar.buttons) === JSON.stringify(wanted),
          `layout=${JSON.stringify(Application.DecorationLayout)} ` +
          `buttons=${JSON.stringify(canvasOf.titlebar.buttons)}`);

    /*
     * And each is a *button* with an icon on it, because that is what a window
     * button is: the theme lights it under the pointer and presses it, which a
     * picture of one does not.
     */
    const keys  = barOf.Children.filter((c) => c.Style.includes("titlebutton"));
    const icons = keys.map((c) => c.Icon);

    eq("each is a button and not a picture of one", keys.length, wanted.length);
    check("with the icon of the button it stands for",
          icons.every((icon, i) => icon.endsWith(`window-${wanted[i]}-symbolic`)),
          JSON.stringify(icons));

    /*
     * The desktop's icon wherever the desktop has one, the IDE's own only where
     * it has none -- name by name, which is the order every icon in the IDE
     * follows.  This desktop draws `window-close-symbolic` and cannot be asked
     * for the other two, so it is a real mix and it is the right one: falling
     * back for all three would put a drawing of the IDE's where the desktop had
     * a perfectly good cross.
     */
    check("the desktop's icon wherever it draws, the IDE's where it does not",
          wanted.every((kind, i) =>
              icons[i] === (Application.HasIcon(`window-${kind}-symbolic`)
                                ? `window-${kind}-symbolic`
                                : `bta-window-${kind}-symbolic`)),
          JSON.stringify(icons));
    check("and every one of them draws something",
          icons.every((icon) => Application.HasIcon(icon)), JSON.stringify(icons));

    /* Round, like GTK's own -- which is what a person sees of them, since what
     * the highlight under the pointer is shaped like is the button. */
    check("the buttons are round",
          keys.every((c) => Number(c.Radius) * 2 === c.Width && c.Width > 0),
          keys.map((c) => `${c.Radius}/${c.Width}`).join(" "));

    /*
     * And the window sits above the desk: the shadow is the board's, because it
     * is the board -- bar and canvas together -- that is the window, and it is
     * cut to the same corners as the bar or the shadow would be square where the
     * window is round.
     */
    check("the window casts a shadow", /^-?\d+ -?\d+ [1-9]/.test(canvasOf.board.Shadow),
          canvasOf.board.Shadow);
    eq("shaped like the window itself", canvasOf.board.Radius, barOf.Radius);

    /*
     * A title bar wider than its window would be no title bar, and a caption is
     * as long as somebody types: the title ellipsizes, so the board is the form's
     * size and stays it.  Set from here rather than through the property grid --
     * what is under test is the measuring, not the editing.
     */
    canvasOf.titlebar.Text = "a caption far longer than the form it belongs to, and then some";
    yield* settled(ide);

    eq("and the bar never pushes the board wider than the form",
       canvasOf.board.Bounds().Width, ide.Canvas.Bounds().Width);

    ide.designer.refresh();     /* back to the form's own caption */
    yield* settled(ide);
    eq("the caption comes back from the form", canvasOf.titlebar.Text, "child");

    /*
     * The window's icon is the form's `Icon`, and it is shown where the desktop
     * says the icon goes -- on a layout that names none there is nothing to show
     * it on, and nothing to check.
     */
    if (canvasOf.titlebar.icon) {
        ide.designer.root.properties.Icon = "folder-symbolic";
        ide.designer.refresh();
        yield;
        eq("the form's icon is shown on its title bar",
           canvasOf.titlebar.Icon, "folder-symbolic");

        /* And one the desktop has no picture for leaves no hole in the bar. */
        ide.designer.root.properties.Icon = "no-such-icon-anywhere";
        ide.designer.refresh();
        yield;
        eq("an icon the desktop lacks is left out", canvasOf.titlebar.icon.Visible, false);

        delete ide.designer.root.properties.Icon;
        ide.designer.refresh();
        yield;
    }

    /* The other half of the arrangement: the canvas is the page's own, and what
     * sits beside the notebook is the shared panel -- one selection, one panel,
     * however many forms are open. */
    check("the canvas belongs to the page",
          ide.openTabs.get(ide.activeFile).view.Children.some((c) => c === ide.CanvasScroll),
          ide.openTabs.get(ide.activeFile).view.Children.map((c) => c.Name).join(" "));
    check("and the side panel is the notebook's neighbour, not its content",
          ide.WorkArea.Children.some((c) => c === ide.SidePanel),
          ide.WorkArea.Children.map((c) => c.Name).join(" "));

    /*
     * And the button that ends the strip is the only way to reach *Close others*
     * and *Save all*, so it may never come out blank.  Which icon it gets is the
     * desktop's business -- this machine's theme has no `view-more-symbolic` that
     * renders -- and that is exactly why the name is picked from a list in code
     * and a glyph stands in when none of them resolve.
     */
    check("the tab strip's button is never a blank square",
          ide.TabActions.Icon !== "" || ide.TabActions.Text !== "",
          `icon="${ide.TabActions.Icon}" text="${ide.TabActions.Text}"`);
    /*
     * The panel is three views of one selection, and the strip is what says
     * which is on screen: what the selection *is* on the first page, what it
     * *does* on the second, and the palette and the control tree -- which are
     * about the shape of the form rather than about the selection -- on the
     * third.  A column 280 wide cannot show them at once, and what it used to
     * do instead was give each a share of the height.
     */
    eq("the side panel is a switcher", ide.SideTabs.Count, 3);
    eq("with a page for each half of designing",
       JSON.stringify(ide.SideTabs.Tabs),
       JSON.stringify(["Properties", "Events", "Controls"]));

    /* Nothing in the side panel may hang out of it.  A control anchored inside
     * a container keeps the gap it was *drawn* with, so a coordinate guessed
     * against a container whose height the theme decides -- this one is the
     * split's minus the tab strip -- overflows by that difference for good, at
     * every window size.  Which is why the panel is a box and not coordinates.
     *
     * Each page is put on screen before it is measured: a page nobody is looking
     * at has no allocation, and a 0x0 satisfies every inequality below while
     * saying nothing at all. */
    for (const [page, content] of [[0, ide.PropGrid], [1, ide.EventList],
                                   [2, ide.Palette], [2, ide.WidgetTree]]) {
        ide.SideTabs.Current = page;
        yield* until(() => content.Bounds().Height > 0);

        const panel = ide.SidePanel.Bounds();
        const r     = content.Bounds();

        check(`${content.Name} stays inside the side panel`,
              r.Y >= panel.Y && r.Y + r.Height <= panel.Y + panel.Height &&
              r.X >= panel.X && r.X + r.Width  <= panel.X + panel.Width,
              `${content.Name}=${JSON.stringify(r)} panel=${JSON.stringify(panel)}`);
    }
    ide.SideTabs.Current = 0;
    yield* settled(ide);

    eq("the form's controls are built for real", ide.Surface.Children.length, 2);
    eq("the surface takes the form's size", ide.Surface.Width, 320);
    eq("controls keep their designed position", ide.Surface.Children[0].X, 20);

    const ok = ide.Surface.Children[0];

    /*
     * The canvas is stretched to whatever room the IDE has -- 520 here for a
     * form drawn 320 wide -- which is nobody's design size.  If it anchored,
     * a Fill control would be shown stretched to that room instead of to its
     * own width, so the canvas would disagree with the coordinates being
     * edited.  Changing the room must change nothing about what is drawn.
     */
    eq("the canvas does not anchor what is drawn on it", ide.Surface.Anchored, false);
    eq("nor does the layer over it",                     ide.Glass.Anchored,   false);

    ok.HAlign = "Fill";
    yield* settled(ide);
    const drawnAt = ide.designer.rectOf(ok);
    const room    = ide.WorkArea.Position;

    ide.WorkArea.Position = room - 140;
    yield* until(() => ide.designer.rectOf(ok).w > 0);
    yield* settled(ide);

    check("so a smaller canvas leaves what is drawn on it alone",
          ide.designer.rectOf(ok).w === drawnAt.w,
          `${JSON.stringify(drawnAt)} -> ${JSON.stringify(ide.designer.rectOf(ok))}`);

    /*
     * And the board never pushes the IDE's own layout around.  A `Scroller` is
     * what makes that possible: what the split holds is the *view*, whose size
     * is the room there is, while the board inside it is as big as the form
     * being drawn.  Before there was one, a split that could not give the
     * canvas its minimum handed it the space anyway -- spilling it outside its
     * own half and over the panel beside it.  Dragging the divider is what
     * makes that visible, so the divider is what this drives.
     */
    /*
     * Not below the tab strip: the notebook is the split's half now, and a
     * notebook is at least as wide as its tabs.  Asking for 150 is asking for
     * something no layout can give, and what it gives instead is the strip
     * drawn outside its own half.
     */
    for (const pos of [300, 250]) {
        ide.WorkArea.Position = pos;
        yield* until(() => ide.CanvasScroll.Bounds().Width > 0);
        yield* settled(ide);

        const host = ide.WorkArea.Bounds(), view = ide.CanvasScroll.Bounds();
        const side = ide.SidePanel.Bounds();

        check(`the canvas view stays in its half of the split at ${pos}`,
              view.X >= host.X && view.X + view.Width <= host.X + host.Width,
              `view=${JSON.stringify(view)} host=${JSON.stringify(host)}`);
        check(`and does not reach over the side panel at ${pos}`,
              view.X + view.Width <= side.X,
              `view=${JSON.stringify(view)} side=${JSON.stringify(side)}`);
    }

    ide.WorkArea.Position = room;
    ok.HAlign = "Start";
    yield* settled(ide);

    /* --- designer: selecting -------------------------------------------- */
    ide.Glass_MouseDown(30, 40);        /* inside Ok: (20,30)-(120,60) */
    ide.Glass_MouseUp();
    eq("clicking a control selects it", ide.designer.selected.Name, "Ok");

    eq("Delete becomes available", ide.ActDelCtl.Enabled, true);
    check("the selection handles show", ide.designer.chrome.handles.se.Visible);

    /* A corner and the corner across from it are one arrow, which is why
     * `Cursor` offers two diagonals and not four. */
    eq("a corner handle says what dragging it does",
       ide.designer.chrome.handles.se.Cursor, "ResizeTopLeft");
    eq("and so does the one across from it",
       ide.designer.chrome.handles.nw.Cursor, "ResizeTopLeft");
    eq("an edge one says the axis instead",
       ide.designer.chrome.handles.e.Cursor, "ResizeHorizontal");

    /*
     * The highlight has to land on the box the control *draws*, which is not the
     * one it asked for: Width is a request, and a theme's margins make a Button's
     * face smaller and offset inside it (17 px a side here).  Taking the origin
     * from the drawing and the size from the request is what left the outline
     * visibly off its control.
     */
    yield* settled(ide);   // GTK has to have laid it out

    const okDrawn = ok.Bounds(ide.Surface);
    const topBar  = ide.designer.chrome.outline[0].Bounds(ide.Glass);

    eq("the outline starts where the control is drawn", topBar.X, okDrawn.X);
    eq("at the top of it", topBar.Y, okDrawn.Y);
    eq("and is exactly as wide as what is drawn", topBar.Width, okDrawn.Width);

    const corner = ide.designer.chrome.handles.nw.Bounds(ide.Glass);
    eq("the corner handle is centred on that corner",
       corner.X + corner.Width / 2, okDrawn.X);
    eq("in both axes", corner.Y + corner.Height / 2, okDrawn.Y);

    /* --- the tab strip's action menu -----------------------------------------
     *
     * The commands are on the File menu too, but that is across the window from
     * the tabs they act on.  A button at the end of the strip, carrying a menu:
     * what GTK offers with set_action_widget and what a page could never be.
     */
    check("the strip carries a button", ide.TabActions !== undefined);
    check("which is not a page: the notebook counts only those",
          ide.Tabs.Children.length === ide.Tabs.Count,
          `${ide.Tabs.Children.length} children, ${ide.Tabs.Count} pages`);

    const stripAt = ide.TabActions.Bounds(), tabsAt = ide.Tabs.Bounds();
    check("sitting at the far end of the strip",
          stripAt.X > tabsAt.X + tabsAt.Width / 2,
          `${JSON.stringify(stripAt)} in ${JSON.stringify(tabsAt)}`);
    check("and in the strip, not in the page",
          stripAt.Y < tabsAt.Y + 40, `${stripAt.Y} vs ${tabsAt.Y}`);

    check("its menu is the ordinary kind", !!ide.MnuTabAll && !!ide.MnuTabOthers);

    /* --- designer: the control tree ------------------------------------------
     *
     * The other way to select something, and the only one for a control the
     * canvas cannot offer: behind another, or inside a container too small to
     * aim at.  Both ways go through setSelection, so they cannot disagree.
     */
    eq("the tree follows a selection made on the canvas", ide.WidgetTree.Key, "Ok");
    check("and shows the form itself as the root",
          ide.WidgetTree.Count === ide.Surface.Children.length + 1,
          `${ide.WidgetTree.Count} nodes for ${ide.Surface.Children.length} controls`);

    ide.WidgetTree.Key = ide.Surface.Children[1].Name;
    yield;
    eq("selecting in the tree selects on the canvas",
       ide.designer.selected.Name, ide.Surface.Children[1].Name);

    /* The root is the form, which is what an empty selection edits -- so it is
     * how the form's own properties are reached without a click on bare canvas. */
    ide.WidgetTree.Key = "@form";
    yield;
    eq("the root selects the form itself", ide.designer.selected, null);
    check("and the grid switches to the form's properties",
          ide.designer.grid.propKeys.includes("Text"), JSON.stringify(ide.designer.grid.propKeys));

    /* The title bar over the board is the form's, so clicking it says the same
     * thing the root of the tree does -- which is where a user who wants the
     * form's own properties reaches first. */
    ide.designer.select(ide.Surface.Children[0]);
    yield;
    neq("a control is selected to begin with", ide.designer.selected, null);
    ide.TitleBar_MouseDown();
    yield;
    eq("clicking the form's title bar selects the form", ide.designer.selected, null);

    /*
     * A form's grid is discovered, not listed.  It used to be three names
     * written by hand -- Text, Width, Height -- which meant a property added to
     * Form in C was designable on every control and invisible on the form, the
     * one place the invariant is easiest to break and hardest to notice.
     */
    const formKeys = ide.designer.grid.propKeys;
    for (const key of ["Modal", "Arrangement", "Background", "Anchored", "Icon"]) {
        check(`the form offers ${key}`, formKeys.includes(key), JSON.stringify(formKeys));
    }
    for (const key of ["X", "Y", "HAlign", "Margin", "Visible"]) {
        check(`and not ${key}, which a window has no use for`,
              !formKeys.includes(key), JSON.stringify(formKeys));
    }

    /* The editor is chosen by the value, so the value has to come back with its
     * real type -- a boolean read as "" would be edited in a text box. */
    eq("a boolean form property reads as one",
       typeof ide.designer.grid.formProperty("Modal"), "boolean");
    check("so it is edited with a drop-down", editor(ide, "Modal") instanceof ComboBox);
    check("and an enumerated one offers the runtime's values",
          JSON.stringify(ide.designer.grid.formProbe().PropertyOptions("Arrangement")) ===
          '["Fixed","Horizontal","Vertical"]');

    /* A drop-down applies on change alone -- assigning goes out to GTK and
     * comes back as a real Select -- so this is the round trip, not a poke. */
    editor(ide, "Modal").Text = "true";
    yield;
    eq("editing one lands on the form's node", ide.designer.root.properties.Modal, true);

    /* The window's icon arrived as an ordinary property, so it reached the grid
     * with the chooser already on it -- nothing in the designer was told. */
    check("the form's icon is edited with the chooser too",
          editor(ide, "Icon") instanceof TextBox && editor(ide, "Icon").Icon !== "",
          `${editor(ide, "Icon").Icon}`);

    ide.BtnSave.Click();
    const withModal = JSON.parse(File.Load(File.Join(TMP, "Child.form")));
    eq("and is saved with the form", withModal.properties.Modal, true);


    ide.designer.select(null);
    yield;
    editor(ide, "Modal").Text = "false";
    yield;
    ide.BtnSave.Click();
    yield;

    ide.designer.select(ide.Surface.Children[0]);
    yield;
    eq("selecting again on the canvas moves the tree back", ide.WidgetTree.Key, "Ok");

    /* --- designer: the context menus -----------------------------------------
     *
     * They carry no command of their own: each item is the button that already
     * did it, reached from the pointer instead of from across the window. So
     * what is worth testing is that they really *are* that button -- and that
     * they go grey with it, since a menu offering Delete with nothing selected
     * lies about what it can do.
     */
    /* Collapsing is what a deep form needs -- the IDE's own is eight levels --
     * and the two commands apply to the tree, not to a selection, so unlike the
     * rest of the menu they stay live with nothing selected. */
    ide.MnuTrCollapse.Click();
    yield;
    eq("Collapse all closes the tree", ide.WidgetTree.Expanded("@form"), false);
    eq("without losing a node of it",
       ide.WidgetTree.Count, ide.designer.allControls().length + 1);

    ide.MnuTrExpand.Click();
    yield;
    eq("Expand all opens it again", ide.WidgetTree.Expanded("@form"), true);

    /* And selecting still reaches a node whichever way the tree is left. */
    ide.MnuTrCollapse.Click();
    yield;
    ide.WidgetTree.Key = "Ok";
    yield;
    eq("selecting reaches a node in a closed tree", ide.designer.selected.Name, "Ok");
    ide.MnuTrExpand.Click();
    yield;

    ide.designer.select(byName(ide, "Ok"));
    yield;
    /*
     * **One command, and every place it appears follows it.** These used to be
     * four widgets with four `Enabled`s -- the toolbar button, the Edit menu,
     * the canvas menu and the tree menu -- set from two files with two
     * different expressions. Now there is one thing to ask, and the *reason*
     * the four agree is that there is nothing else they could disagree with:
     * a control bound to a command refuses an `Enabled` of its own.
     */
    eq("the command is live with a selection", ide.ActDelCtl.Enabled, true);
    eq("...and the button that names it follows", ide.BtnDelCtl.Enabled, true);
    let refused = false;
    try { ide.BtnDelCtl.Enabled = false; } catch (e) { refused = true; }
    check("a control bound to a command refuses an Enabled of its own", refused);

    ide.designer.select(null);
    yield;
    eq("it goes grey with nothing selected", ide.ActDelCtl.Enabled, false);
    eq("...and so does the button",          ide.BtnDelCtl.Enabled, false);
    eq("rename included",                    ide.MnuTrRename.Enabled, false);

    /* Bring to front from the menu is the same restack the button does. Undone
     * afterwards: painting order is what the tests below this one measure, and
     * leaving it changed would break them from a distance. */
    const painted = ide.Surface.Children.map((c) => c.Name);

    ide.designer.select(byName(ide, painted[0]));
    yield;
    ide.ActRaise.Click();
    yield;
    check("choosing Bring to front restacks, as the button does",
          ide.Surface.Children.map((c) => c.Name).join(",") !== painted.join(","),
          `${painted} -> ${ide.Surface.Children.map((c) => c.Name)}`);

    /* Raising each in turn leaves exactly the painted they were raised in. */
    for (const name of painted) {
        ide.designer.select(byName(ide, name));
        ide.designer.restack(true);
    }
    yield;
    eq("and the painted can be put back",
       ide.Surface.Children.map((c) => c.Name).join(","), painted.join(","));

    ide.designer.select(byName(ide, "Ok"));
    yield;

    /* Every type gets an icon, and the check is worth having because the table
     * is names: a typo, or a desktop that turns out not to ship one, comes back
     * empty and the node quietly loses it.  The IDE's own icons are the last
     * entry of each row for exactly that reason, so an empty answer here means
     * a type nobody wrote a fallback for. */
    for (const c of ide.designer.allControls()) {
        check(`${ide.designer.tree.typeOf(c)} has an icon in the tree`,
              ide.designer.tree.iconFor(c) !== "", ide.designer.tree.typeOf(c));
    }
    for (const kind of ["folder", "forms", "form", "design", "code", "file"]) {
        check(`the project tree has an icon for ${kind}`, ide.treeIcon(kind) !== "", kind);
    }

    /*
     * Every icon the IDE's own .form files name has to be one the desktop
     * really has.  A .form names *one*, where code picks the first of a list
     * that resolves -- so moving a control from code into the file quietly
     * loses its fallback, which is exactly how the tab strip's button came out
     * blank: view-more-symbolic is not on this desktop and nothing said so.
     */
    /*
     * **Every form in `ide/`, listed from the directory.**
     *
     * This was seven names written out by hand, and by the time anybody looked
     * the IDE had eleven forms: `ColumnForm`, `PoForm`, `ProjectForm` and
     * `SearchForm` had never had an icon checked, and `ColumnForm` was in fact
     * declaring one no desktop here ships. A list of files, in a test about
     * files, drifts from the directory the moment somebody adds one -- which is
     * the same reason `EventNames()` retired a hardcoded table of widget types.
     */
    const ideDir = File.Join(Application.Directory, "..", "..", "ide", "forms");
    const forms  = Directory.List(ideDir).filter((f) => File.IsExtension(f, "form"));

    check("the walk covers every form the IDE has", forms.length >= 11, `${forms.length}`);

    for (const entry of forms) {
        const file = File.BaseName(entry);
        const node = JSON.parse(File.Load(File.Join(ideDir, entry)));

        (function walk(n) {
            const icon = (n.properties || {}).Icon;
            if (typeof icon === "string" && icon) {
                check(`${file}: ${n.name || n.class} names an icon the desktop has`,
                      Application.HasIcon(icon), icon);
            }
            for (const c of n.children || []) walk(c);
        })(node);
    }

    /* --- the icon chooser ----------------------------------------------------
     *
     * `Icon` takes a name from the desktop's theme and there are thousands of
     * them, so typing one from memory was not editing.  The runtime gained
     * Application.Icons() -- the part a form could not do -- and the chooser
     * itself is an ordinary Bintana form.
     */
    const themeIcons = Application.Icons();
    check("the icon list reaches the project's own too",
          themeIcons.some((n) => n.startsWith("bta-")),
          `${themeIcons.length} icons, none of them the IDE's`);

    ide.designer.select(byName(ide, "Ok"));
    yield;

    check("Icon is edited in a field with a button on it",
          editor(ide, "Icon") instanceof TextBox && editor(ide, "Icon").Icon !== "",
          `${editor(ide, "Icon").Icon}`);

    /* A colour is a swatch, not six hex digits: the row shows what the value is
     * and opens the desktop's wheel when pressed.  A control of its own rather
     * than a field with a button, because that is what a colour looks like. */
    for (const key of ["Background", "Foreground"]) {
        check(`${key} is edited with a colour button`,
              editor(ide, key) instanceof ColorButton, editor(ide, key).constructor.name);
    }
    check("a font is shown in itself, by a font button",
          editor(ide, "Font") instanceof FontButton, editor(ide, "Font").constructor.name);
    check("while a plain string property is still a field",
          editor(ide, "Text") instanceof TextBox, editor(ide, "Text").constructor.name);

    /*
     * **Style is typed, and offered.** It used to be a drop-down, and that was
     * wrong twice: the property takes a *list* of classes and a combo can only
     * put one in, and which classes exist is the theme's answer and the
     * project's -- so a closed list was a menu claiming to be complete for a
     * vocabulary that is open by definition.
     *
     * What is asserted is both halves: that a combination can be written at all,
     * which is what the drop-down made impossible, and that the button still
     * offers what we do know, project's classes before the theme's.
     */
    const styles = editor(ide, "Style");
    check("Style is typed, not picked from a closed list", styles instanceof TextBox,
          styles.constructor.name);

    typeInto(ide, "Style", "danger");
    eq("writing one dresses the control", byName(ide, "Ok").Style, "danger");
    eq("as an edit like any other", ide.designer.dirty, true);
    check("and it is what the .form will carry",
          ide.designer.serializeForm().children.some((c) =>
              c.name === "Ok" && c.properties.Style === "danger"),
          JSON.stringify(ide.designer.serializeForm().children));

    /* The thing the drop-down could not do, and the reason not one `.form` in
     * this tree carries a combination while the IDE's own code uses three. */
    typeInto(ide, "Style", "danger title-1");
    eq("a control can wear more than one class", byName(ide, "Ok").Style,
       "danger title-1");

    /*
     * **The button opens a chooser**, which is the shape the icon row settled:
     * a menu can show a name and nothing else, and `Style` is a list -- what is
     * already on the control has to be visible, and ticking is how a combination
     * gets built.
     */
    typeInto(ide, "Style", "danger");
    editor(ide, "Style").Emit("IconClick");
    yield;

    const styleDlg  = ide.stylePicker;
    const offered = styleDlg.classes;

    check("which opens the chooser", styleDlg !== undefined);
    check("with what the control already wears, first and ticked",
          offered[0] === "danger" && styleDlg.boxes[0].Active, JSON.stringify(offered));
    check("the project's own classes are offered",
          offered.includes("pill-ish"), JSON.stringify(offered));
    check("and the theme's, to be used without writing any",
          offered.includes("suggested-action") && offered.includes("title-1"),
          JSON.stringify(offered));
    check("the project's before the theme's: they are the answer more often",
          offered.indexOf("pill-ish") < offered.indexOf("suggested-action"),
          JSON.stringify(offered));
    check("what a comment says is not a class",
          !offered.includes("commented"), JSON.stringify(offered));
    check("and nothing is offered twice",
          offered.filter((c) => c === "danger").length === 1, JSON.stringify(offered));

    /* The value being built is on screen while it is built: a list one cannot
     * see is a list one gets wrong. */
    eq("it shows what the value is so far", styleDlg.LblChosen.Text, "danger");

    /*
     * **Ordered by what can reach this control, and nothing hidden.**
     *
     * `suggested-action` is written `button.suggested-action` and this is a
     * `Button`, so it is among the ones offered for it; `boxed-list` styles
     * `> row` and no control here can be a row, so it is further down, dimmed,
     * saying why. Both are still tickable -- the field behind the dialog is free
     * text, and which classes exist is the theme's answer, not ours.
     */
    const fitting = offered.indexOf("suggested-action");
    const cannot  = offered.indexOf("boxed-list");

    check("a class the theme writes for this node is among the first",
          fitting >= 0, JSON.stringify(offered.slice(0, 8)));
    check("one that cannot reach it is still there", cannot >= 0);
    check("...but after the ones that can", cannot > fitting,
          `${cannot} against ${fitting}`);
    check("...and its row says why", styleDlg.boxes[cannot].Tooltip !== "",
          styleDlg.boxes[cannot].Tooltip);

    /*
     * **In controls, not in nodes.** Selecting a list and being told about a
     * `scrolledwindow` answers a question nobody asked: the heading names the
     * control, and a class written for somewhere else names the controls it is
     * for -- worked out from the runtime, so they are widgets that exist here.
     */
    check("the heading names the control rather than its CSS node",
          styleDlg.Text.includes("Button") && !styleDlg.Text.includes("button ") &&
          !styleDlg.Text.includes("scrolledwindow"), styleDlg.Text);

    /* `error` is written for entries, labels and spins -- not for a button -- so
     * on this one it names those controls rather than the nodes they are. */
    const elsewhere = offered.indexOf("error");

    check("a class for other controls names them, not their CSS nodes",
          elsewhere >= 0 && /TextBox|Label|SpinBox/.test(styleDlg.boxes[elsewhere].Tooltip),
          styleDlg.boxes[elsewhere].Tooltip);

    /* And one that is for a part a control keeps inside says so, with what to do
     * instead: `data-table` is written for the view inside a TableView, which no
     * control here *is*. */
    const inside = offered.indexOf("data-table");

    check("and one for a part kept inside says so, and where to write it",
          inside >= 0 && /app\.css/.test(styleDlg.boxes[inside].Tooltip),
          styleDlg.boxes[inside].Tooltip);

    /*
     * Searching narrows without rebuilding a row, which is what lets the rows be
     * checkboxes at all -- a filter that rebuilt them would throw the ticks away.
     * The same `RowList.Filter` the property grid uses.
     */
    const rowsBefore = styleDlg.List.Count;

    styleDlg.TxtFind.Text = "title";
    yield;
    check("searching leaves the ticks alone", styleDlg.boxes[0].Active);
    eq("and it is the list that hides rows, not a rebuild",
       styleDlg.List.Count, rowsBefore);

    const which = offered.indexOf("title-1");
    styleDlg.boxes[which].Active = true;
    /* Raised on the box, which is what carries the handler now. */
    styleDlg.boxes[which].Emit("Click");
    eq("ticking a second one adds it to the value", styleDlg.LblChosen.Text,
       "danger title-1");

    /*
     * **A class of the project's is made from here**, and lands in `app.css`.
     *
     * That is the whole point of a class: one name, every control that wears it,
     * changed in one place -- which a colour set on a control by hand can never
     * be. The editor writes no CSS itself: the values go on a control nobody
     * sees and `StyleRule()` says what they come to, so the units, the colours
     * and the three ways a font size reaches a stylesheet wrong stay written in
     * C and are read from there.
     */
    styleDlg.BtnNew_Click();
    yield;

    const classDlg = ide.classEditor;
    check("New… opens the class editor", classDlg !== undefined);

    classDlg.TxtName.Text    = "made-here";
    classDlg.ColBack.Value   = "rgb(0,128,0)";
    classDlg.TxtRadius.Text  = "8";
    classDlg.TxtRadius_Change();
    yield;

    eq("the sample wears what the class will say", classDlg.Sample.Radius, "8");
    eq("...and its colour", classDlg.Sample.Background, "rgb(0,128,0)");

    /* A value the runtime refuses is caught here, where there is a line to say
     * so, rather than on the way into somebody's stylesheet. */
    classDlg.TxtBorder.Text = "verde";
    classDlg.TxtBorder_Change();
    check("a value the runtime refuses is said, not written",
          classDlg.LblSays.Text.includes("Border"), classDlg.LblSays.Text);
    check("and there is nothing to save while it is wrong", !classDlg.BtnSave.Enabled);

    classDlg.TxtBorder.Text = "2 solid #888888";
    classDlg.TxtBorder_Change();
    check("fixing it clears the complaint", classDlg.LblSays.Text === "");

    /*
     * **A heading is a weight and a relative size, and no family** -- which is
     * how every one of the desktop's own type classes is written, and what a
     * whole-font chooser cannot say. `.title-1` is `font-weight: 800;
     * font-size: 200%`; `.dim-label` is not a grey but `opacity: 0.55`.
     */
    classDlg.TxtFont.Text  = "Bold";
    classDlg.SpnScale.Value = 1.1;
    classDlg.TxtFont_Change();
    yield;

    check("a font can be a weight alone, with no family frozen into it",
          classDlg.Sample.Font === "Bold", classDlg.Sample.Font);
    eq("and the size is a factor of whatever is in force",
       classDlg.Sample.FontScale, 1.1);

    classDlg.BtnSave_Click();
    yield;

    const sheet = File.Load(File.Join(TMP, "app.css"));

    check("the class is written into app.css, where it can be shared",
          /\.made-here\s*\{/.test(sheet), sheet);
    check("with what the runtime says it comes to, units and all",
          sheet.includes("border-radius: 8px") &&
          sheet.includes("border: 2px solid rgb(136,136,136)"), sheet);
    check("the size relative, the way the theme's own headings are written",
          sheet.includes("font-size: 110%") && sheet.includes("font-weight: 700"),
          sheet);
    check("and no family frozen into it",
          !/\.made-here[^}]*font-family/s.test(sheet), sheet);
    check("and everything that was already in the file is still there",
          sheet.includes(".danger") && sheet.includes("button.pill-ish") &&
          sheet.includes(".danger:hover"), sheet);

    check("the chooser offers it now", styleDlg.classes.includes("made-here"),
          JSON.stringify(styleDlg.classes));
    check("...ticked, since somebody who just made one means to use it",
          styleDlg.boxes[styleDlg.classes.indexOf("made-here")].Active);

    /*
     * And a class that says more than the editor can: `.danger:hover` is a
     * selector of somebody's own and `button.pill-ish` is written for a node --
     * neither is a rule this can round-trip, so the answer is *edit it by hand*
     * rather than a dialog that would quietly rewrite it into less.
     */
    eq("a rule the editor cannot reproduce is not offered for editing",
       ClassForm.edit(TMP, "pill-ish", () => {}), null);

    check("while one it wrote itself reads back",
          Ide.Sheet.owned(sheet, "made-here") !== null);

    styleDlg.BtnOk_Click();
    yield;
    check("and applying writes what was ticked",
          byName(ide, "Ok").Style.includes("made-here"), byName(ide, "Ok").Style);

    typeInto(ide, "Style", "");
    yield;
    eq("and going back to none takes it off", byName(ide, "Ok").Style, "");

    editor(ide, "Font").Value = "Cantarell Bold 12";
    yield;
    eq("a font set on the button applies", byName(ide, "Ok").Font, "Cantarell Bold 12");
    editor(ide, "Font").Value = "";
    yield;
    eq("and clearing goes back to the theme's", byName(ide, "Ok").Font, "");

    /* Assigning it reaches GTK and comes back as a real Change, which is the
     * round trip -- the same one a TextBox's Text makes. */
    editor(ide, "Background").Value = "rgb(32,64,96)";
    yield;
    eq("a colour set on the swatch applies", byName(ide, "Ok").Background, "rgb(32,64,96)");
    eq("as an edit like any other", ide.designer.dirty, true);

    /*
     * **The clear is the row's button, not something inside the swatch.**
     *
     * A `ColorButton` is a `GtkColorDialogButton` and nothing else, and a
     * `FontButton` a font button: the box that used to hold each of them next to
     * a clear was a widget the runtime made for one consumer -- this panel -- and
     * building a row out of controls is what this file does anyway.
     *
     * Pressed for real, so the round trip is the one a user makes: the button
     * dispatches by name on the IDE's form, the handler empties the editor, and
     * the assignment comes back from GTK as a Change that applies.
     */
    const groupOf = (key) => {
        for (const row of ide.PropGrid.Children) {
            if (!("Children" in row)) continue;
            for (const c of row.Children)
                if ("Children" in c &&
                    c.Children.some((k) => k.Name === `PropClear_${key}`)) return c;
        }
        return null;
    };
    const clearOf = (key) => {
        const group = groupOf(key);
        return group ? group.Children.find((c) => c.Name === `PropClear_${key}`)
                     : null;
    };

    const clearColor = clearOf("Background");
    check("the colour row carries a clear of its own", clearColor !== null);
    check("and so does the font row", clearOf("Font") !== null);
    check("while an ordinary row does not", clearOf("Text") === null);

    /*
     * **And the two read as one control**, which is the whole of what the theme's
     * `linked` says: a value and the way back to none of it are one thing, not a
     * control with something loose beside it.
     *
     * Asserted as the three conditions the class actually has, because a class
     * that reaches nothing is still accepted and saved -- the trap `Style =
     * "flat"` on a `ColorButton` fell into. Adwaita writes
     * `.linked:not(.vertical) > colorbutton > button`, so: the pair have to be
     * the panel's own children, the panel has to be a row, and the clear has to
     * be a button. `flat` blanks the border those rules shape, which would leave
     * a squared-off swatch with empty space beside it.
     */
    const colorGroup = groupOf("Background");
    eq("the swatch and its clear are linked", colorGroup.Style, "linked");
    eq("as a row, which is the half of the rule that is easy to lose",
       colorGroup.Arrangement, "Horizontal");
    eq("with the pair as its own children", colorGroup.Children.length, 2);
    eq("the value first", colorGroup.Children[0].constructor.name, "ColorButton");
    eq("and the font row the same", groupOf("Font").Children[0].constructor.name,
       "FontButton");
    eq("the clear is a plain button: flat would undraw what linking draws",
       clearColor.Style, "");

    clearColor.Click();
    yield;
    eq("and pressing it goes back to the theme's", byName(ide, "Ok").Background, "");

    editor(ide, "Icon").Emit("IconClick");
    yield;

    const picker = ide.iconPicker;
    check("which opens the chooser", picker !== undefined);
    check("showing a page and saying there is more",
          picker.Board.Children.length > 0 && picker.LblCount.Text.includes("of"),
          picker.LblCount.Text);

    picker.TxtFind.Text = "media-playback";
    yield;
    check("searching narrows it", picker.LblCount.Text.includes("match"),
          picker.LblCount.Text);
    check("to icons the desktop really has",
          picker.Board.Children.every((b) => Application.HasIcon(b.Icon)),
          "an icon that renders to nothing was offered");

    /* The gallery reflows: what a line holds is the width's business, so the
     * buttons are the flow's children and there are no rows to look inside. */
    const chosen = picker.Board.Children[0].Tooltip;
    picker.Board.Children[0].Click();
    yield;

    eq("choosing one applies it to the control", byName(ide, "Ok").Icon, chosen);
    eq("as an edit like any other", ide.designer.dirty, true);

    /* Cancelling is not the same as choosing none: one leaves the icon alone,
     * the other is a thing one means to do. */
    editor(ide, "Icon").Emit("IconClick");
    yield;
    ide.iconPicker.BtnCancel_Click();
    yield;
    eq("cancelling leaves it as it was", byName(ide, "Ok").Icon, chosen);

    editor(ide, "Icon").Emit("IconClick");
    yield;
    ide.iconPicker.BtnNone_Click();
    yield;
    eq("and None clears it", byName(ide, "Ok").Icon, "");


    ide.Glass_MouseDown(300, 190);      /* outside every control */
    ide.Glass_MouseUp();
    eq("clicking empty space deselects", ide.designer.selected, null);
    eq("and hides the handles", ide.designer.chrome.handles.se.Visible, false);

    /* --- designer: dragging --------------------------------------------- */
    ide.Glass_MouseDown(30, 40);
    ide.Glass_MouseMove(50, 60, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp();
    eq("dragging moves the control in x", ok.X, 40);
    eq("dragging moves the control in y", ok.Y, 50);
    eq("dragging marks the form dirty", ide.designer.dirty, true);
    eq("and the toolbar's Save follows", ide.BtnSave.Enabled, true);

    /* --- designer: resizing --------------------------------------------- */
    ide.Glass_MouseDown(45, 55);
    ide.Glass_MouseUp();
    eq("the moved control is selectable where it now is",
       ide.designer.selected.Name, "Ok");

    const se = ide.designer.chrome.handles.se;
    ide.Glass_MouseDown(se.X + 4, se.Y + 4);
    ide.Glass_MouseMove(se.X + 24, se.Y + 16);
    ide.Glass_MouseUp();
    eq("the corner handle grows the width", ok.Width, 120);
    eq("the corner handle grows the height", ok.Height, 42);

    /* Shrinking past the minimum must stop, not flip the control inside out. */
    const nw = ide.designer.chrome.handles.nw;
    ide.Glass_MouseDown(nw.X + 4, nw.Y + 4);
    ide.Glass_MouseMove(nw.X + 4 + 400, nw.Y + 4 + 400);
    ide.Glass_MouseUp();
    check("width stops at the minimum", ok.Width >= 12, `w=${ok.Width}`);
    check("height stops at the minimum", ok.Height >= 12, `h=${ok.Height}`);
    check("the far edge stays put", ok.X + ok.Width <= 160, `right=${ok.X + ok.Width}`);

    /* Put it back in order for the save assertions. */
    ok.Move(40, 50);
    ok.Resize(120, 42);

    /* --- designer: resizing the form by its border ---------------------------
     *
     * The border was already drawn; what it lacked was grips.  Only the far
     * edges get them: the form's origin is 0,0, so dragging the near ones would
     * mean moving every control instead of resizing anything.
     */
    const grips = ide.designer.chrome.formHandles;
    const size0 = ide.designer.formSize();

    check("the form's border offers grips", grips.se.Visible && grips.e.Visible);
    eq("the corner one sits on the corner", grips.se.X + HANDLE_HALF, size0.w);
    eq("in both axes",                      grips.se.Y + HANDLE_HALF, size0.h);

    ide.Glass_MouseDown(grips.se.X + HANDLE_HALF, grips.se.Y + HANDLE_HALF);
    ide.Glass_MouseMove(grips.se.X + HANDLE_HALF + 80, grips.se.Y + HANDLE_HALF + 60);
    ide.Glass_MouseUp(grips.se.X + HANDLE_HALF + 80, grips.se.Y + HANDLE_HALF + 60);
    yield* settled(ide);

    eq("dragging the corner resizes the form", ide.designer.formSize().w, size0.w + 80);
    eq("in both axes",                         ide.designer.formSize().h, size0.h + 60);
    eq("the grid follows what the drag did",
       ide.designer.grid.formProperty("Width"), size0.w + 80);
    eq("and it counts as an edit", ide.designer.dirty, true);

    ide.designer.undo();
    yield* settled(ide);
    eq("resizing the form undoes like any other edit",
       ide.designer.formSize().w, size0.w);
    eq("in both axes", ide.designer.formSize().h, size0.h);

    /* An edge grip moves one axis, whatever the pointer does with the other. */
    ide.Glass_MouseDown(grips.e.X + HANDLE_HALF, grips.e.Y + HANDLE_HALF);
    ide.Glass_MouseMove(grips.e.X + HANDLE_HALF + 40, grips.e.Y + HANDLE_HALF + 50);
    ide.Glass_MouseUp(grips.e.X + HANDLE_HALF + 40, grips.e.Y + HANDLE_HALF + 50);
    yield* settled(ide);

    eq("the right edge widens the form",  ide.designer.formSize().w, size0.w + 40);
    eq("and leaves the height alone",     ide.designer.formSize().h, size0.h);

    ide.designer.undo();
    yield* settled(ide);
    eq("back to the size it was drawn", ide.designer.formSize().w, size0.w);

    /* --- and the children follow ---------------------------------------------
     *
     * An anchor is measured against the form's *declared* size, so once that
     * changes the old coordinates no longer describe what the runtime would
     * draw.  Resizing the form therefore rewrites them -- moving a control on
     * screen and leaving the .form alone would show one thing and save another.
     */
    ide.designer.select(null);
    yield;
    byName(ide, "Ok").HAlign   = "End";
    byName(ide, "Ok").VAlign   = "End";
    byName(ide, "Msg").HAlign  = "Fill";
    byName(ide, "Msg").MinWidth = 60;
    yield* settled(ide);

    const okWas  = { x: byName(ide, "Ok").X, y: byName(ide, "Ok").Y };
    const msgWas = byName(ide, "Msg").Width;

    ide.Glass_MouseDown(grips.se.X + HANDLE_HALF, grips.se.Y + HANDLE_HALF);
    ide.Glass_MouseMove(grips.se.X + HANDLE_HALF + 40, grips.se.Y + HANDLE_HALF + 40);
    ide.Glass_MouseUp(grips.se.X + HANDLE_HALF + 40, grips.se.Y + HANDLE_HALF + 40);
    yield* settled(ide);

    eq("an End-anchored control follows the far edge", byName(ide, "Ok").X, okWas.x + 40);
    eq("in both axes",                                 byName(ide, "Ok").Y, okWas.y + 40);
    eq("and a Fill one stretches",                     byName(ide, "Msg").Width, msgWas + 40);

    /* The floor is the control's own: MinWidth when it declares one. Driven in
     * one gesture, because coming back has to be exact even after bottoming
     * out -- which is why the baseline is taken when the border is grabbed and
     * not read again each frame. */
    const gx = grips.se.X + HANDLE_HALF, gy = grips.se.Y + HANDLE_HALF;
    const stretched = byName(ide, "Msg").Width;

    ide.Glass_MouseDown(gx, gy);
    ide.Glass_MouseMove(gx - 400, gy - 400);
    yield* settled(ide);
    eq("shrinking stops at the declared MinWidth", byName(ide, "Msg").Width, 60);

    ide.Glass_MouseMove(gx, gy);
    ide.Glass_MouseUp(gx, gy);
    yield* settled(ide);
    eq("and coming back is exact, floors and all", byName(ide, "Msg").Width, stretched);
    eq("for what moved too", byName(ide, "Ok").X, okWas.x + 40);

    ide.designer.undo();
    ide.designer.undo();
    yield* settled(ide);
    eq("undo takes the form back", ide.designer.formSize().w, size0.w);

    /* --- Timer and Clipboard --------------------------------------------------
     *
     * Both need the main loop to come back: a timer has to be waited for, and
     * reading a clipboard is asynchronous because its contents belong to
     * whoever owns the selection.  This is the one place in the suite that can
     * hand control back to GTK and carry on.
     */
    let ticks = 0;
    const timer = new Timer(10, () => { ticks++; });
    timer.Start();
    yield; yield; yield;

    check("a timer fires while the loop runs", ticks > 0, `${ticks} ticks`);
    timer.Stop();

    const stopped = ticks;
    yield; yield;
    eq("and stops when told", ticks, stopped);

    let once = 0;
    new Timer(5, () => { once++; }).Once();
    yield; yield; yield;
    eq("Once fires exactly once", once, 1);

    /* The clipboard: copying is a call, pasting is an answer that arrives. */
    Clipboard.Copy("what the clipboard was given");
    let pasted = null;
    Clipboard.Paste((text) => { pasted = text; });
    yield; yield;

    eq("what was copied is what comes back", pasted, "what the clipboard was given");

    Clipboard.Copy("");
    Clipboard.Paste((text) => { pasted = text; });
    yield; yield;
    eq("and an empty clipboard is an empty string, not a failure", pasted, "");

    /* --- what GTK actually allocated ---------------------------------------
     *
     * Width and Height report the *request*, which is a minimum, so a control
     * that does not fit renders bigger and nothing says so.  Bounds() is what
     * makes that difference a number -- and a number is what a test can assert,
     * instead of someone looking at a screenshot.
     */
    const wide = new Label();
    ide.Surface.Add(wide);
    wide.Move(4, 4);
    wide.Resize(80, 30);
    wide.Text = "a line far longer than the eighty pixels it says it wants";
    yield* settled(ide);   // GTK has to have laid it out

    eq("Width reports what was asked for", wide.Width, 80);
    check("Bounds reports what GTK gave, which here is more",
          wide.Bounds().Width > 80, `${wide.Bounds().Width}`);
    /* Two frames, both useful: with a container it answers in that container's
     * coordinates, and with none in the window's -- which is what a click driven
     * from outside the application needs. */
    eq("Bounds(container) agrees with OriginIn",
       wide.Bounds(ide.Surface).X, wide.OriginIn(ide.Surface)[0]);
    check("and Bounds() answers in the window's, further right",
          wide.Bounds().X > wide.Bounds(ide.Surface).X,
          `${wide.Bounds().X} vs ${wide.Bounds(ide.Surface).X}`);

    /* Wrapping caps the natural width, so the label keeps the box it declared --
     * which is the whole reason the property exists. */
    wide.Wrap = true;
    yield* settled(ide);   // GTK has to have laid it out
    check("a wrapped label stays inside its declared width",
          wide.Bounds().Width <= 80, `${wide.Bounds().Width}`);

    /* And the tree in text: what a screenshot would have been asked. */
    const dump = ide.Surface.Dump();
    check("Dump names the controls it holds", dump.includes(wide.Name || "(unnamed)"),
          dump.slice(0, 200));
    check("with their real size", /\d+x\d+ @\(\d+,\d+\)/.test(dump), dump.slice(0, 200));

    wide.Visible = false;
    check("and says when one is hidden", wide.Dump().includes("hidden"), wide.Dump());
    wide.Delete();

}

function* p_palette(ide) {
    /* --- designer: palette -----------------------------------------------
     * One tab per group and a square button per type, with an icon and with what
     * gets dragged.  None of this is declared in the .form: the designer builds
     * the palette. */
    /*
     * One tab per group, plus one per library the project uses -- and the
     * project's own components would add one more, which this project has none
     * of. Counted against what the palette was *given* rather than against
     * `PALETTE_TABS` alone, since a library's tab is as real as a built-in one.
     */
    const libTabs = new Set(ide.components.filter((c) => c.library)
                                          .map((c) => c.library));
    eq("the palette has a tab per group, and per library",
       ide.Palette.Count, PALETTE_TABS.length + libTabs.size);
    eq("and a button per type, the libraries' included",
       Dictionary.Keys(ide.palette.buttons).length,
       PALETTE.length + ide.components.length);

    for (const type of PALETTE) {
        const button = palette(ide, type);
        check(`${type} has an icon`, button.Icon !== "", button.Icon);
        eq(`${type} says what it is`, button.Tooltip, type);
        eq(`${type} can be dragged`, button.DragData, type);
        check(`${type} is square`,
              button.Width === button.Height, `${button.Width}x${button.Height}`);
    }

    /* Each tab is a gallery, not rows of a fixed width: how many buttons go on
     * a line is the panel's business, and a tab with a project's worth of
     * components scrolls instead of losing the ones past the bottom. */
    eq("a palette tab is a Flow", ide.Palette.Children[0].constructor.name, "Flow");
    check("with the buttons as its own children, in no rows",
          ide.Palette.Children[0].Children.length === PALETTE_TABS[0].types.length,
          `${ide.Palette.Children[0].Children.length} children`);

    /* The ones the desktop lacks come from the set the IDE draws, which travels
     * with the project: whatever the theme, no button comes out empty. */
    check("a missing desktop icon falls back to the IDE's own",
          PALETTE.every((t) => Application.HasIcon(palette(ide, t).Icon)));

    /*
     * **A library's components are offered too, in a tab of their own.**
     *
     * A project loads its own `.js` and nothing else, so until `uses` a shared
     * class could only be copied into every project that wanted one. The IDE's
     * half of that is this: read `uses`, ask the *runtime* where each library is
     * -- `Application.LibraryPath`, the same six-place search the loader uses, so
     * there is one copy of it -- and offer what it finds. A tab named after the
     * library, because the same components in a tab called `Project` would be
     * saying something untrue.
     */
    const gadgets = ide.components.filter((c) => c.library === "gadgets");
    eq("a library's components are found", gadgets.length, 1);
    eq("...by the name a .form will use", gadgets[0].name, "Dial");
    check("...with an absolute path, so nothing project-relative matches it",
          gadgets[0].file.startsWith("/"), gadgets[0].file);
    eq("...and its own declared size", `${gadgets[0].Width}x${gadgets[0].Height}`,
       "140x90");
    check("...and what its class publishes, read from the library's source",
          (gadgets[0].properties || []).includes("Value") &&
          (gadgets[0].events || []).includes("Turn"),
          JSON.stringify([gadgets[0].properties, gadgets[0].events]));

    const tabs = [];
    for (let i = 0; i < ide.Palette.Count; i++) tabs.push(ide.Palette.Tabs[i]);
    /* Last, after the runtime's groups -- and there is no `Project` tab here at
     * all, because this project has no components of its own. A library's
     * components in a tab by that name would be saying something untrue. */
    eq("the library gets a tab of its own, last", tabs.at(-1), "gadgets");
    check("and no Project tab, since the project has none of its own",
          !tabs.includes(COMPONENT_TAB), JSON.stringify(tabs));

    check("and a button that places it", !!palette(ide, "Dial"));
    palette(ide, "Dial").Click();
    yield* settled(ide);
    eq("pressing it puts one on the form",
       ide.designer.selected.__node ? ide.designer.selected.__node.type : "",
       "Dial");
    ide.designer.deleteSelected();
    yield;

    /*
     * **And no two buttons are the same picture**, which is a different question
     * and was answered wrong four times: `ListBox` and `Separator` both drew
     * `view-list-symbolic`, `Panel`, `Grid` and `TableView` all drew
     * `view-grid-symbolic`, and `TextBox` and the two editors would have shared
     * `text-editor-symbolic`. A palette is read by its pictures, so two controls
     * with one picture is two buttons a user cannot tell apart -- and every
     * assertion above passes while it is true.
     *
     * What this can check is the theme the suite runs under, which is Adwaita
     * (Xvfb), and that is not the theme the IDE is used on. The other one is
     * asked the way `tests/icons.sh` asks: off the disk, and the table's comments
     * carry what it answered.
     */
    const drawn = {};
    for (const type of PALETTE) {
        const icon = palette(ide, type).Icon;
        (drawn[icon] = drawn[icon] || []).push(type);
    }
    const shared = Dictionary.Keys(drawn).filter((i) => drawn[i].length > 1)
                             .map((i) => `${i}: ${drawn[i].join(", ")}`);
    eq("no two types show the same picture", JSON.stringify(shared), "[]");

    /*
     * **Every type that can be placed is offered**, asked of the runtime rather
     * than of a second list here -- which is the only version of this check worth
     * having, because the version that was not asked let six classes sit in the
     * runtime with no button: `TreeView`, `SourceEditor`, `Terminal`, `RowList`,
     * `Overlay` and `Flow`, five of which the IDE's own forms are built out of.
     *
     * `Form` is the surface being drawn on and `Component` is the base a
     * project's own classes extend -- neither is a control one drops, and the
     * project's components have a tab of their own.
     *
     * **...and every type this build cannot run is not**, which is the same
     * question the other way round and the one the palette had no word for:
     * `Widget.Available`. On a runtime built without VTE the `Terminal` button
     * is simply absent -- the class is still there and a `.form` with one in it
     * still loads, so `Widget.Types()` is the wrong list to build a palette
     * from. Both directions asserted, because a filter that dropped everything
     * would pass the first on its own.
     */
    const NOT_PLACED = ["Form", "Component"];
    const unoffered  = [];
    const offeredAnyway = [];
    for (const type of Widget.Types()) {
        if (NOT_PLACED.includes(type)) continue;
        try { Widget.New(type).Delete(); } catch (e) { continue; }   /* abstract */

        if (!Widget.Available(type)) {
            if (PALETTE.includes(type)) offeredAnyway.push(type);
        } else if (!PALETTE.includes(type)) {
            unoffered.push(type);
        }
    }
    eq("every type that can be placed is on the palette",
       JSON.stringify(unoffered), "[]");
    eq("and nothing this build cannot run is",
       JSON.stringify(offeredAnyway), "[]");

    /* This build has VTE, so the case above is the one that is *not* exercised
     * here: what can be asserted either way is that the palette's list is the
     * available half of the declared one, and never more than it. */
    const declared = PALETTE_TABS.flatMap((t) => t.types);
    eq("the palette offers the available half of what it declares",
       JSON.stringify(declared.filter((t) => Widget.Available(t))),
       JSON.stringify(declared.filter((t) => PALETTE.includes(t))));

    const beforeAdd = ide.Surface.Children.length;
    palette(ide, "CheckButton").Click();
    yield;                 // a just-created control has no layout until the next frame
    eq("the palette adds a control", ide.Surface.Children.length, beforeAdd + 1);
    eq("the new control is selected",
       ide.designer.selected.constructor.name, "CheckButton");
    eq("and gets a free name", ide.designer.selected.Name, "CheckButton1");
    eq("the button that was pressed becomes the current tool",
       ide.designer.tool, "CheckButton");

    /* Ctrl+Insert repeats that type, which is what remembering it is for. */
    ide.MnuAdd.Click();
    yield* settled(ide);   // GTK has to have laid it out
    eq("Ctrl+Insert adds another of the same",
       ide.designer.selected.constructor.name, "CheckButton");
    ide.designer.deleteSelected();

    /* --- designer: dropping from the palette -----------------------------
     * Dragging a type to the form puts it where it is dropped, instead of in the
     * first free spot.  What arrives here is the runtime's Drop event: the same
     * (data, x, y) GTK delivers. */
    ide.Glass_Drop("Label", 200, 120);
    yield* settled(ide);   // GTK has to have laid it out
    const dropped = ide.designer.selected;
    eq("dropping creates that type", dropped.constructor.name, "Label");
    check("centred on where it was dropped",
          Math.abs(dropped.X + dropped.Width / 2 - 200) <= GRID &&
          Math.abs(dropped.Y + dropped.Height / 2 - 120) <= GRID,
          `(${dropped.X},${dropped.Y}) ${dropped.Width}x${dropped.Height}`);
    eq("and it lands on the grid", (dropped.X % GRID) + (dropped.Y % GRID), 0);
    eq("dropping marks the form dirty", ide.designer.dirty, true);

    /* Undo has to reach what came in by dragging too. */
    const afterDrop = ide.Surface.Children.length;
    ide.MnuUndo.Click();
    eq("undo takes the dropped control back out",
       ide.Surface.Children.length, afterDrop - 1);
    ide.MnuRedo.Click();
    yield* settled(ide);   // GTK has to have laid it out
    eq("and redo brings it back", ide.Surface.Children.length, afterDrop);
    ide.designer.deleteSelected();

    /* A type that does not exist arrives anyway if someone drags something else
     * in from outside the application: it must create nothing. */
    const beforeJunk = ide.Surface.Children.length;
    ide.Glass_Drop("/etc/passwd", 100, 100);
    eq("junk dropped from elsewhere is ignored",
       ide.Surface.Children.length, beforeJunk);

    /* And the check box is left selected, which is what the assertions below
     * talk about: this section added and removed things in between. */
    ide.designer.select(byName(ide, "CheckButton1"));

    /* --- designer: property grid ---------------------------------------- */
    check("the grid lists settable properties",
          ide.designer.grid.propKeys.includes("Text") &&
          ide.designer.grid.propKeys.includes("X"),
          JSON.stringify(ide.designer.grid.propKeys));
    check("and never read-only ones",
          !ide.designer.grid.propKeys.includes("Children"),
          JSON.stringify(ide.designer.grid.propKeys));

    /* One row per property, and in each the editor the value asks for: that is
     * what makes a new property in C editable properly without touching the
     * IDE. */
    /*
     * **The rows are grouped, so a row per property plus a heading per group.**
     * Alphabetical was one list of forty names with `Name` somewhere in the
     * middle of it, which is the wrong order for every question anybody asks of
     * this panel.
     */
    const groups = ide.designer.grid.groupsOf(ide.designer.grid.propKeys);
    eq("a row per property, and a heading per group",
       ide.PropGrid.Count, ide.designer.grid.propKeys.length + groups.length);

    eq("what it is comes first",
       JSON.stringify(groups.map((g) => g.title)),
       JSON.stringify([Locale.Text("Essential"), "CheckButton",
                       Locale.Text("Appearance"), Locale.Text("Layout"),
                       Locale.Text("Behaviour")]));
    eq("and the first row of all is the name", groups[0].keys[0], "Name");

    /*
     * The second group is the widget's own, and **nothing in the IDE says what
     * a CheckButton has**: what every control has is worked out by asking every
     * widget the runtime publishes, and what is left over is this class's. A
     * property added to a class in C lands here with nothing changed.
     */
    check("the group named after the class holds what that class adds",
          groups[1].keys.includes("Active") && groups[1].keys.includes("Group"),
          JSON.stringify(groups[1].keys));
    check("...and not what every control has",
          !groups[1].keys.includes("Enabled") && !groups[1].keys.includes("Width"),
          JSON.stringify(groups[1].keys));
    check("which is where those went instead",
          groups[3].keys.includes("Width") && groups[4].keys.includes("Enabled"),
          JSON.stringify(groups.map((g) => g.keys)));

    /*
     * **A font scale and an opacity are appearance**, and they were not.
     *
     * The last group is where a property none of the lists knows about falls,
     * and these two fell there: Widget's own, so not the control's; in neither
     * list, so "the rest". They are the two things the desktop's own type
     * classes are made of -- a weight and a relative size, and `.dim-label` is
     * `opacity: 0.55` -- which the class editor has said all along by putting
     * them next to the font.
     */
    check("a font scale and an opacity are appearance",
          groups[2].keys.includes("FontScale") && groups[2].keys.includes("Opacity"),
          JSON.stringify(groups[2].keys));
    check("and not what was left over at the end",
          !groups[4].keys.includes("FontScale") && !groups[4].keys.includes("Opacity"),
          JSON.stringify(groups[4].keys));
    eq("the scale immediately after the font it scales",
       groups[2].keys.indexOf("FontScale"), groups[2].keys.indexOf("Font") + 1);

    /*
     * **And the whole of what a class can say is appearance**, which is the
     * check that keeps this from happening a third time: `Border` fell to the
     * end the way the scale and the opacity did, and asserting it by name would
     * have caught that one and not the next one. `Sheet.props` is the look a
     * control can be given by hand -- exactly what a rule in `app.css` is
     * allowed to hold -- so anything in it that the control has belongs in this
     * group, and the test is that list and not a list written here.
     */
    const look = Ide.Sheet.props.filter((k) => ide.designer.grid.propKeys.includes(k));
    check("everything a class can say is in the appearance group",
          look.every((k) => groups[2].keys.includes(k)),
          JSON.stringify(look.filter((k) => !groups[2].keys.includes(k))));

    /*
     * **And a fractional property gets a spin that can hold a fraction.**
     *
     * Every number used to get one with no decimals, which took the edit, saved
     * it and destroyed it: `Opacity = 0.55` came back `1`. Which properties are
     * fractional is asked of the runtime -- a throwaway of the class is handed
     * `0.5` and asked what it kept -- because no list can be right. `Value` is
     * the proof, and it is asserted below: fractional on a `ProgressBar` and a
     * `LevelBar`, which are readings, and whole on a `SpinBox` and a `Slider`,
     * which carry their own `Decimals` and start it at none.
     */
    check("a fractional property is edited with decimals",
          editor(ide, "Opacity").Decimals >= 2 && editor(ide, "FontScale").Decimals >= 2,
          `Opacity ${editor(ide, "Opacity").Decimals}, ` +
          `FontScale ${editor(ide, "FontScale").Decimals}`);
    eq("and a whole one keeps the spin it always had",
       editor(ide, "Width").Decimals, 0);
    check("with a step that can reach a decimal",
          editor(ide, "Opacity").Step < 1, `${editor(ide, "Opacity").Step}`);

    editor(ide, "Opacity").Value = 0.55;
    yield;
    eq("so a fraction set on the row survives being set",
       byName(ide, "CheckButton1").Opacity, 0.55);
    eq("as an edit like any other", ide.designer.dirty, true);
    editor(ide, "Opacity").Value = 1;
    yield;

    /*
     * **The same value is edited the same way wherever it turns up.**
     *
     * A `ColorButton` and a `FontButton` can be placed from the palette now, and
     * the grid was editing the very value they exist to pick as a line of text:
     * `Value` is a colour because a colour button is holding it, exactly as
     * `Background` is one. Which is asked of the control -- its class is a fact,
     * where a list of type-and-property pairs is an opinion that goes stale.
     */
    palette(ide, "ColorButton").Click();
    yield;
    const swatch = ide.designer.selected;
    check("a colour button's own Value is edited with a swatch",
          editor(ide, "Value") instanceof ColorButton,
          editor(ide, "Value").constructor.name);
    check("and carries the clear the other colour rows have",
          ide.designer.grid.clearable("Value"));

    editor(ide, "Value").Value = "rgb(8,16,32)";
    yield;
    eq("and setting it reaches the control", swatch.Value, "rgb(8,16,32)");
    ide.designer.deleteSelected();
    yield;

    palette(ide, "FontButton").Click();
    yield;
    check("a font button's own Value is shown in the font itself",
          editor(ide, "Value") instanceof FontButton,
          editor(ide, "Value").constructor.name);
    ide.designer.deleteSelected();
    yield;

    /*
     * A `Calendar`, which is the one placeable control **bigger than the size the
     * palette asks for**: `Width` is a minimum, so a month drawn at 250x222 is
     * what GTK gives whatever the request. That is why its `DEFAULT_SIZE` is the
     * measured size and not a guess -- a smaller number would be written into the
     * `.form` and be a lie about what the user sees.
     */
    palette(ide, "Calendar").Click();
    yield* settled(ide);
    const month = ide.designer.selected;
    eq("a calendar is placed", month.constructor.name, "Calendar");
    /*
     * **No bigger, and not equality.**  `Bounds()` is the *drawn* box and a
     * themed control's own border is not part of it, so the runner's Adwaita
     * draws a calendar 220 high where this machine's draws 222 -- two pixels of
     * theme, not two pixels of size.  The direction that matters is the other
     * one: a `DEFAULT_SIZE` smaller than a month needs is a `.form` telling the
     * user 220 about something they see at 224, which is the lie the measured
     * number exists to prevent.
     */
    check("and is drawn no bigger than the palette asked for, because that size "
          + "is the one a month really is",
          month.Bounds().Width <= month.Width && month.Bounds().Height <= month.Height,
          `${JSON.stringify(month.Bounds())} against ${month.Width}x${month.Height}`);
    check("its own Value is edited as the text it is",
          editor(ide, "Value") instanceof TextBox,
          editor(ide, "Value").constructor.name);
    /* Marks are read-only, so the grid must not offer a row for them at all --
     * the same rule that keeps a ListBox's Selection out of it. */
    check("and marks are not a property the designer draws",
          !ide.designer.selected.PropertyNames().includes("Marks"));
    ide.designer.deleteSelected();
    yield;

    /*
     * A plain number called `Value` is still a number -- and *how* plain is the
     * class's answer and not the name's, which is the whole argument against a
     * list. These two carry the same property name and disagree about it.
     */
    palette(ide, "ProgressBar").Click();
    yield;
    check("a progress bar's Value is a number and stays one",
          editor(ide, "Value") instanceof SpinBox,
          editor(ide, "Value").constructor.name);
    check("a fractional one: a reading has no say in its own precision",
          editor(ide, "Value").Decimals >= 2, `${editor(ide, "Value").Decimals}`);
    ide.designer.deleteSelected();
    yield;

    palette(ide, "Slider").Click();
    yield;
    eq("while a slider's is whole, because its own Decimals starts at none",
       editor(ide, "Value").Decimals, 0);
    eq("which is the control's answer and not ours",
       ide.designer.selected.Decimals, 0);

    /*
     * **And it is the control's answer *now*, not its class's once.**
     *
     * A slider told to be precise really does hold 0.125, so the row beside it
     * has to take one. The probe wears the selection's own properties and is
     * rebuilt when they change -- and an edit ends in `fill`, so the beat that
     * sets `Decimals` is the beat that re-asks.
     */
    const slider = ide.designer.selected;

    editor(ide, "Decimals").Value = 3;
    yield;
    eq("telling a slider to be precise reaches it", slider.Decimals, 3);
    eq("and its Value row grows the decimals in the same beat",
       editor(ide, "Value").Decimals, 3);

    editor(ide, "Value").Value = 0.125;
    yield;
    eq("so a third decimal can be typed into it now", slider.Value, 0.125);

    editor(ide, "Decimals").Value = 0;
    yield;
    eq("and taking the precision away takes the decimals with it",
       editor(ide, "Value").Decimals, 0);

    ide.designer.deleteSelected();
    yield;

    /* Back to the control the assertions below talk about. */
    ide.designer.select(byName(ide, "CheckButton1"));
    yield;
    /*
     * **Bold is "this is in the file".** Which is the same question as "is this
     * not at its default", asked the way the file itself asks it: `Serialize`
     * writes what differs from a fresh instance, so the keys it returns are
     * exactly the ones the `.form` will carry. Nothing in the IDE decides what a
     * default is -- a second opinion would eventually disagree with the file.
     */
    const nameOf = (key) => ide.designer.grid.names[key].Text;

    eq("a property the file carries is shown in bold", nameOf("Text"), "<b>Text</b>");
    eq("and one still at its default is not", nameOf("Enabled"), "Enabled");
    /* The name is the node's own field and not one of its `properties`, so it
     * is never in that dictionary -- and needs no marking either, being the
     * first row of the first group. */
    eq("nor the name, which the node carries itself", nameOf("Name"), "Name");

    editor(ide, "Enabled").Text = "false";
    eq("changing one makes it bold", nameOf("Enabled"), "<b>Enabled</b>");
    editor(ide, "Enabled").Text = "true";
    eq("and putting it back leaves it plain again", nameOf("Enabled"), "Enabled");

    /*
     * **A row that does nothing is turned off, and says why.** On a fixed
     * surface a control keeps the place and size it was given, and the
     * alignment properties are inert -- measured in `tests/widgets`: a Button
     * given `HExpand`, `Expand` and `HAlign = Fill` there is allocated exactly
     * the rectangle it had without them. The pair is decided by the *parent*,
     * so each half is off in the other's world.
     */
    check("this surface places by coordinates",
          ide.designer.isFixed(ide.Surface));
    check("so where it sits can be edited", editor(ide, "X").Enabled);
    check("and how it asks for room cannot",
          !editor(ide, "HExpand").Enabled && !editor(ide, "HAlign").Enabled);
    check("with the reason on the row rather than a grey box and no answer",
          editor(ide, "HExpand").Tooltip !== "", editor(ide, "HExpand").Tooltip);
    check("and the name is greyed with it",
          !ide.designer.grid.names["HExpand"].Enabled);

    /*
     * **And a row that works, but only against one node, says which.**
     *
     * `Style` puts a class on the control's CSS node, and that node decides which
     * of the theme's rules can reach it: `button.suggested-action` reaches a
     * `Button` and never a `ColorButton`, whose node is `colorbutton`. A class
     * written for another node is accepted, saved into the `.form` and does
     * nothing -- the quietest failure the runtime has, and the node is the fact
     * that turns *"it did not work"* into *"of course not"*.
     *
     * Asked of the control through `CssNode()`, so this assertion cannot drift
     * from what the widget is either.
     */
    const node = ide.designer.selected.CssNode();

    check("a control knows which CSS node it is", node !== "", node);
    check("and the Style row says so, since that is what decides what can match",
          editor(ide, "Style").Tooltip.includes(node),
          `${node}: ${editor(ide, "Style").Tooltip}`);
    check("a row with nothing to explain carries no tooltip",
          editor(ide, "Text").Tooltip === "", editor(ide, "Text").Tooltip);

    /*
     * The headings are rows of the same list, so they have to be *drawn* -- a
     * heading that measures nothing is a heading nobody sees, and this panel is
     * 200 px wide with a filter box now sitting above it.
     */
    yield* settled(ide);
    const rows  = ide.PropGrid.Children;
    const heads = rows.filter((r) => r instanceof Label);

    eq("every group heading is a row of the list", heads.length, groups.length);
    check("and each one is drawn",
          heads.every((h) => h.Bounds().Height > 0),
          JSON.stringify(heads.map((h) => h.Bounds().Height)));
    check("with the grid still holding the panel",
          ide.PropGrid.Bounds().Height > 200, `${ide.PropGrid.Bounds().Height}`);
    check("under a filter box that is on screen",
          ide.PropFind.Bounds().Height > 0 && ide.PropFind.Bounds().Width > 0,
          JSON.stringify(ide.PropFind.Bounds()));

    /*
     * **The filter is the way to a property in a list of forty.** It is a view
     * setting and not an edit: nothing is applied, nothing is saved, and it
     * survives selecting another control the way a search field does everywhere.
     */
    const grid    = ide.designer.grid;
    const wasText = ide.designer.selected.Text;

    /*
     * **And nothing is rebuilt to filter it.** The rows the selection has are
     * built once and the list hides the ones that do not match -- `RowList`'s
     * `Filter` event, asked once per row per letter typed. It used to rebuild:
     * forty editors destroyed and forty built on every keystroke, which is also
     * why a half-typed value could not survive a search.
     *
     * So what is measured is both halves. What the filter *lets through*, from
     * the answer the grid gives GTK; and that the rows are the same objects
     * afterwards, which is the whole of the difference.
     */
    const wasRows   = ide.PropGrid.Count;
    const wasEditor = editor(ide, "Text");
    const yOf       = (key) => editor(ide, key).Bounds(ide.PropGrid).Y;
    const wasTextY  = yOf("Text");
    const wasSpanY  = yOf("ColumnSpan");

    ide.PropFind.Text = "col";
    ide.PropFind_Change();
    yield* settled(ide);

    const shown = grid.rowInfo.filter((keys, i) => grid.rowVisible(i));

    check("filtering shows only what matches, anywhere in the name",
          shown.length > 0 &&
          shown.every((keys) => keys.some((k) => k.toLowerCase().includes("col"))),
          JSON.stringify(shown));
    check("which is a whole word of neither of them",
          shown.some((keys) => keys.includes("ColumnSpan")),
          JSON.stringify(shown));
    check("the heading over it comes along, so the row is not orphaned",
          shown.some((keys) => keys.length > 1 && keys.includes("ColumnSpan")),
          JSON.stringify(shown));

    eq("nothing was rebuilt: the grid still holds every row it had",
       ide.PropGrid.Count, wasRows);
    check("and they are the same editors, not new ones",
          editor(ide, "Text") === wasEditor);
    check("what matched rises to the top, which is what hiding the rest means",
          yOf("ColumnSpan") < wasSpanY, `${yOf("ColumnSpan")} from ${wasSpanY}`);

    ide.PropFind.Text = "";
    ide.PropFind_Change();
    yield* settled(ide);

    check("clearing it brings the rest back", grid.rowVisible(0));
    eq("each row to the place it had", yOf("Text"), wasTextY);
    eq("and nothing was edited along the way", ide.designer.selected.Text, wasText);

    eq("text is edited with a field",
       editor(ide, "Text").constructor.name, "TextBox");
    eq("a number with a spin", editor(ide, "X").constructor.name, "SpinBox");
    eq("a boolean with a drop-down",
       editor(ide, "Enabled").constructor.name, "ComboBox");
    eq("and the editor shows what the control holds", editor(ide, "Text").Text,
       "CheckButton1");

    typeInto(ide, "Text", "Tildar");
    eq("editing a property applies it", ide.designer.selected.Text, "Tildar");

    /* The full round trip: assigning the spin reaches GTK, comes back as
     * value-changed, and lands in Prop_X_Change. */
    editor(ide, "X").Value = 64;
    eq("a spin applies on its own", ide.designer.selected.X, 64);
    eq("and the editor still shows the value", editor(ide, "X").Value, 64);

    /* "false" as bare text would be true: the type of what is there decides. */
    editor(ide, "Enabled").Text = "false";
    eq("a drop-down does too", ide.designer.selected.Enabled, false);

    /* A property that declares the values it accepts comes out as a closed list,
     * without the IDE knowing that Alignment exists. */
    palette(ide, "Label").Click();
    yield;
    const align = editor(ide, "Alignment");
    eq("an enumerated property is edited with a drop-down",
       align.constructor.name, "ComboBox");
    check("offering the values the control accepts",
          JSON.stringify(align.Items) === JSON.stringify(["Left", "Center", "Right"]),
          JSON.stringify(align.Items));
    align.Text = "Right";
    eq("y elegir uno lo aplica", ide.designer.selected.Alignment, "Right");

    /*
     * **And a property another property turns off is turned off here too.**
     * `Lines` is Pango's cap on a *wrapped* caption, and a caption that does not
     * wrap has one line by construction -- so the row invites an edit, takes it,
     * writes it into the `.form` and changes nothing on the screen. Which is
     * worse than not being there, and is why it says what it is waiting for.
     */
    eq("a fresh caption does not wrap", ide.designer.selected.Wrap, false);
    check("so the cap on its lines does nothing, and is off",
          !editor(ide, "Lines").Enabled);
    check("saying which property it is waiting for",
          editor(ide, "Lines").Tooltip.includes("Wrap"),
          editor(ide, "Lines").Tooltip);

    editor(ide, "Wrap").Text = "true";
    yield* settled(ide);

    eq("turning that one on applies it", ide.designer.selected.Wrap, true);
    check("and brings the other one back", editor(ide, "Lines").Enabled);

    ide.designer.deleteSelected();

    /* A list: its items are an array, edited as JSON, and its Index starts at
     * -1 -- the spin has to be able to show that, not clamp it. */
    palette(ide, "ListBox").Click();
    yield;
    eq("a list of values is edited as text",
       editor(ide, "Items").constructor.name, "TextBox");
    eq("and an index with nothing selected shows as it is", editor(ide, "Index").Value, -1);

    typeInto(ide, "Items", '["uno","dos"]');
    check("editing the JSON applies the list",
          JSON.stringify(ide.designer.selected.Items) === '["uno","dos"]',
          JSON.stringify(ide.designer.selected.Items));

    typeInto(ide, "Items", "not JSON");
    check("invalid JSON is rejected and the list stays as it was",
          JSON.stringify(ide.designer.selected.Items) === '["uno","dos"]',
          JSON.stringify(ide.designer.selected.Items));
    eq("and the editor goes back to what is there", editor(ide, "Items").Text,
       '["uno","dos"]');
    ide.designer.deleteSelected();

    /* A new control starts out with its name as Text, except those that cannot:
     * a ComboBox's has to be one of its items. */
    palette(ide, "ComboBox").Click();
    yield;
    eq("the palette adds a ComboBox",
       ide.designer.selected.constructor.name, "ComboBox");
    eq("without inventing an item for it", ide.designer.selected.Count, 0);
    /* Its items are put there by the application, not the runtime: to the grid
     * its Text is ordinary text, and what decides if it is valid is the control
     * itself. */
    eq("and its Text is edited as text", editor(ide, "Text").constructor.name,
       "TextBox");

    ide.designer.deleteSelected();
    ide.designer.select(byName(ide, "CheckButton1"));

    /* --- designer: keyboard ---------------------------------------------- */
    const cb = ide.designer.selected;          /* the CheckButton just added */
    const kx = cb.X, ky = cb.Y, kw = cb.Width;

    eq("an arrow is consumed", ide.Glass_KeyPress("Right", false, false), true);
    eq("an arrow nudges by one pixel", cb.X, kx + 1);

    ide.Glass_KeyPress("Down", false, true);
    eq("shift+arrow nudges by the grid", cb.Y, ky + 4);

    ide.Glass_KeyPress("Right", true, false);
    eq("ctrl+arrow resizes instead of moving", cb.Width, kw + 1);
    eq("and does not move it", cb.X, kx + 1);

    eq("a key nobody wants is left alone",
       ide.Glass_KeyPress("F7", false, false), false);

    eq("Escape is consumed", ide.Glass_KeyPress("Escape", false, false), true);
    eq("Escape deselects", ide.designer.selected, null);
    eq("with nothing selected an arrow does nothing",
       ide.Glass_KeyPress("Right", false, false), false);

    ide.designer.select(byName(ide, "CheckButton1"));

    /* --- designer: undo --------------------------------------------------- */
    const undoX = ide.designer.selected.X;
    ide.Glass_KeyPress("Right", false, false);
    eq("the nudge moved it", byName(ide, "CheckButton1").X, undoX + 1);

    ide.MnuUndo_Click();
    eq("undo puts it back", byName(ide, "CheckButton1").X, undoX);
    eq("undo keeps the selection", ide.designer.selected.Name, "CheckButton1");

    ide.MnuRedo_Click();
    eq("redo re-applies it", byName(ide, "CheckButton1").X, undoX + 1);
    ide.MnuUndo_Click();

    /* Undoing a delete has to bring the control back, not just its geometry. */
    const beforeDel = ide.Surface.Children.length;
    eq("Delete is consumed", ide.Glass_KeyPress("Delete", false, false), true);
    eq("Delete removes the control", ide.Surface.Children.length, beforeDel - 1);

    ide.MnuUndo_Click();
    eq("undo brings the control back", ide.Surface.Children.length, beforeDel);
    check("with its name intact", byName(ide, "CheckButton1") !== undefined);
    eq("and its properties", byName(ide, "CheckButton1").Text, "Tildar");

    /* A property edit is one undo step, not one per keystroke. */
    const sel = byName(ide, "CheckButton1");
    ide.designer.select(sel);
    typeInto(ide, "Text", "Otro");
    eq("the property changed", byName(ide, "CheckButton1").Text, "Otro");
    ide.MnuUndo_Click();
    eq("undo reverts the property", byName(ide, "CheckButton1").Text, "Tildar");

    /* A spin sends an event per click on the arrow: three clicks in a row on the
     * same property are a single edit, not three. */
    const spun = byName(ide, "CheckButton1");
    ide.designer.select(spun);
    const wasY = spun.Y;
    for (let i = 1; i <= 3; i++) editor(ide, "Y").Value = wasY + i;
    eq("the spin applied every step", ide.designer.selected.Y, wasY + 3);

    ide.MnuUndo_Click();
    eq("but undoing once goes back to where it started",
       byName(ide, "CheckButton1").Y, wasY);

    /* Another property opens another edit, or undo would take both. */
    editor(ide, "Y").Value = wasY + 5;
    typeInto(ide, "Text", "Aparte");
    ide.MnuUndo_Click();
    eq("undo only takes back the last property", byName(ide, "CheckButton1").Text,
       "Tildar");
    eq("leaving the one before it", byName(ide, "CheckButton1").Y, wasY + 5);
    ide.MnuUndo_Click();

    eq("undo is offered while there is history", ide.MnuUndo.Enabled, true);
    while (ide.designer.canUndo()) ide.MnuUndo_Click();
    eq("undo turns itself off when the history runs out", ide.MnuUndo.Enabled, false);
    eq("redo is available after undoing everything", ide.MnuRedo.Enabled, true);

    /* Back to the state the save assertions expect. */
    while (ide.designer.canRedo()) ide.MnuRedo_Click();
    eq("redo replays back to where we were",
       ide.Surface.Children.length, beforeDel);

    const okAgain = byName(ide, "Ok");
    okAgain.Move(40, 50);
    okAgain.Resize(120, 42);
    ide.designer.select(byName(ide, "CheckButton1"));

    /* --- designer: stacking --------------------------------------------- */
    const names = () => ide.Surface.Children.map((w) => w.Name).join(",");
    eq("the new control is last, so it paints on top", names(), "Ok,Msg,CheckButton1");

    ide.ActLower_Click();
    eq("Al fondo sends it behind", names(), "CheckButton1,Ok,Msg");
    ide.ActRaise_Click();
    eq("Al frente brings it back", names(), "Ok,Msg,CheckButton1");

    /* --- designer: deleting --------------------------------------------- */
    ide.ActDelCtl_Click();
    eq("deleting removes it from the surface",
       ide.Surface.Children.length, beforeAdd);
    eq("and clears the selection", ide.designer.selected, null);

    /* --- designer: saving ----------------------------------------------- */
    ide.BtnSave_Click();
    eq("saving clears the dirty flag", ide.designer.dirty, false);

    const saved = JSON.parse(File.Load(File.Join(TMP, "Child.form")));
    eq("the saved form keeps its class", saved.class, "Child");
    eq("and the properties the designer never touched",
       saved.properties.Width, 320);
    eq("the deleted control is gone", saved.children.length, 2);
    eq("the drag is persisted", saved.children[0].properties.X, 40);
    eq("so is the resize", saved.children[0].properties.Width, 120);
    eq("untouched controls are unchanged", saved.children[1].properties.Text, "hi");

}

/*
 * Copy, cut, paste and duplicate.
 *
 * It runs on the form `p_palette` left saved and puts it back exactly as it
 * found it: `p_forms` reads that file, and a phase that leaves two extra
 * controls behind would fail it for something that is not the code.
 */
function* p_clipboard(ide) {
    const before = ide.Surface.Children.length;
    const was    = ide.Surface.Children.map((c) => c.Name);

    /* --- what is offered, and when -----------------------------------------
     *
     * The enabling is not decoration: these carry Ctrl+C and Ctrl+V, and an
     * item that stayed enabled over a code tab would take those keys away from
     * the editor that is supposed to answer them.
     */
    ide.designer.select(null);
    yield;
    eq("with nothing selected there is nothing to copy", ide.MnuCopy.Enabled, false);
    eq("nor to cut",                                     ide.MnuCut.Enabled, false);
    eq("but pasting is offered while a form is being designed",
       ide.MnuPaste.Enabled, true);

    ide.designer.select(byName(ide, "Ok"));
    yield;
    eq("a selected control can be copied", ide.MnuCopy.Enabled, true);
    eq("and duplicated",                   ide.MnuDuplicate.Enabled, true);

    /* --- copy: through the real clipboard ---------------------------------- */
    ide.MnuCopy_Click();

    let text = null;
    Clipboard.Paste((t) => { text = t; });
    yield* until(() => text !== null);

    const clip = JSON.parse(text);
    eq("what is copied is .form nodes", clip.format, "bta-clip/1");
    eq("one per selected control",      clip.nodes.length, 1);
    eq("carrying its type",             clip.nodes[0].type, "Button");
    eq("and what the file would have held",
       clip.nodes[0].properties.Text, byName(ide, "Ok").Text);

    /* --- paste --------------------------------------------------------------
     *
     * The one edit in the designer that cannot finish in its own call: the
     * clipboard's contents belong to whoever owns the selection and arrive when
     * that application answers.
     */
    const okX = byName(ide, "Ok").X;
    ide.MnuPaste_Click();
    yield* until(() => ide.Surface.Children.length > before);

    eq("pasting adds one control", ide.Surface.Children.length, before + 1);

    const pasted = ide.Surface.Children[ide.Surface.Children.length - 1];
    check("with a name of its own", !was.includes(pasted.Name), pasted.Name);
    eq("of its type",               pasted.constructor.name, "Button");
    eq("keeping what it was copied from", pasted.Text, byName(ide, "Ok").Text);
    check("offset, so it does not hide what it came from", pasted.X > okX,
          `${pasted.X} against ${okX}`);
    eq("and it is what is selected now", ide.designer.selected.Name, pasted.Name);
    eq("the form is dirty, as after any edit", ide.designer.dirty, true);

    /*
     * **And the canvas says so**, which is not the same assertion: the status
     * bar reads `selected` and the outline reads the control's *allocation*, so
     * a paste whose control has not been laid out yet leaves one saying a name
     * and the other showing nothing at all.
     */
    yield* settled(ide);
    const ringRect = ide.designer.rectOf(pasted);
    const ring     = ide.designer.chrome.outline[0];

    check("the outline is drawn around it", ring.Visible);
    eq("on the control the status bar is naming",
       `${ring.X},${ring.Y} ${ring.Width}`,
       `${ringRect.x},${ringRect.y} ${ringRect.w}`);
    check("and not collapsed onto nothing, which is what an outline drawn " +
          "before GTK allocated the control looks like",
          ring.Width > 1, `${ring.Width}x${ring.Height}`);

    /* One paste is one undo. */
    ide.MnuUndo_Click();
    eq("undo takes the whole paste back", ide.Surface.Children.length, before);
    ide.MnuRedo_Click();
    eq("and redo brings it back", ide.Surface.Children.length, before + 1);

    /* --- duplicate: the same thing without the round trip ------------------- */
    ide.designer.select(byName(ide, "Ok"));
    ide.MnuDuplicate_Click();
    eq("duplicating adds one more", ide.Surface.Children.length, before + 2);

    const names = ide.Surface.Children.map((c) => c.Name);
    eq("and every name in the form is still unique",
       new Set(names).size, names.length);

    /* --- cut ---------------------------------------------------------------- */
    const cutName = ide.designer.selected.Name;
    ide.MnuCut_Click();
    eq("cutting takes it off the surface", ide.Surface.Children.length, before + 1);
    check("and it is gone by name",
          !ide.Surface.Children.some((c) => c.Name === cutName), cutName);

    text = null;
    Clipboard.Paste((t) => { text = t; });
    yield* until(() => text !== null);
    eq("what was cut is on the clipboard", JSON.parse(text).nodes.length, 1);

    ide.MnuPaste_Click();
    yield* until(() => ide.Surface.Children.length > before + 1);
    eq("so pasting brings it back", ide.Surface.Children.length, before + 2);

    /* --- a container brings its contents, renamed all the way down ----------
     *
     * A name is unique across the *form* and not among siblings -- handlers are
     * `Name_Event` on the form, so two controls of the same name at different
     * depths collide in the dispatch while nothing on screen looks wrong.
     */
    ide.designer.select(null);
    palette(ide, "Panel").Click();
    yield;
    const panel = ide.designer.selected;
    palette(ide, "Button").Click();          /* into the panel: it is selected */
    yield;
    const inside = ide.designer.selected;
    check("the button went into the panel", panel.Children.includes(inside));

    ide.designer.select(panel);
    ide.MnuDuplicate_Click();
    const copy = ide.designer.selected;
    check("a duplicated container is a new one", copy !== panel);

    /* The one place duplicating differs from pasting: a duplicate is a
     * *sibling*. Following the selection here would drop the copy inside the
     * original, which is nobody's idea of "one more of these". */
    check("and a sibling of it rather than its own child",
          !panel.Children.includes(copy) && ide.Surface.Children.includes(copy));
    eq("with the same number of children", copy.Children.length, panel.Children.length);
    check("whose child was renamed too",
          copy.Children[0].Name !== inside.Name,
          `${copy.Children[0].Name} vs ${inside.Name}`);

    const all = ide.designer.allControls().map((c) => c.Name);
    eq("and the whole form has no two controls of one name",
       new Set(all).size, all.length);

    /* ...while pasting *does* follow the selection, which is how one puts
     * something into a container at all. */
    ide.designer.select(byName(ide, "Ok"));
    ide.MnuCopy_Click();
    yield;
    ide.designer.select(panel);
    const held = panel.Children.length;
    ide.MnuPaste_Click();
    yield* until(() => panel.Children.length > held);
    eq("pasting with a container selected puts it inside",
       panel.Children.length, held + 1);

    /* --- a clipboard holding something else ---------------------------------
     *
     * The ordinary state of a clipboard. Not an error, and not silence either:
     * a Ctrl+V that appears to do nothing is worse than one that says why.
     */
    const settledCount = ide.designer.allControls().length;
    Clipboard.Copy("just some text");
    ide.MnuPaste_Click();
    yield;
    yield;
    eq("pasting prose adds nothing", ide.designer.allControls().length, settledCount);

    /* --- and the keys go back to the editor over a code tab ------------------ */
    ide.openInTab("Child.js");
    yield;
    eq("over a code tab there is nothing of the designer's to copy",
       ide.MnuCopy.Enabled, false);
    eq("nor to paste, so Ctrl+V stays the editor's",
       ide.MnuPaste.Enabled, false);

    ide.openInTab("Child.form");
    yield;

    /* Back to what `p_palette` saved: everything this phase put on the form
     * comes off, and the file is written again so the next phase finds it
     * exactly as it was. */
    for (const c of [...ide.Surface.Children])
        if (!was.includes(c.Name)) c.Delete();

    ide.designer.select(null);
    ide.designer.touch();
    ide.BtnSave_Click();
    eq("the form is back to what it was", ide.Surface.Children.length, before);
    eq("and saved", ide.designer.dirty, false);
    yield;
}

/*
 * The tab order, as a list.
 *
 * `TabIndex` was a number in the property grid: correct and unusable, because a
 * tab order is a relation and a number cannot say *before what*. The dialog is
 * the one Delphi and Visual Basic have -- a container's controls in the order
 * Tab takes them, with Up and Down -- and the order it shows is the runtime's
 * own rule, so what the list says is what the keyboard does.
 *
 * It runs on the form `p_clipboard` left saved and puts it back exactly as it
 * found it: `p_completion` and everything after reads that file.
 */
function* p_taborder(ide) {
    ide.openInTab("Child.form");
    yield* settled(ide);

    const was = ide.Surface.Children.map((c) => c.Name);

    /* Three more controls, so there is an order to change. `Ok` is the fourth
     * and the only one the form already had that Tab can reach -- `Msg` is a
     * `Label`, and a label is not a stop. */
    ["Txt1", "Txt2", "Txt3"].forEach((name, at) => {
        const t = new TextBox();
        t.Name = name;
        t.X = 20; t.Y = 100 + at * 40; t.Width = 140; t.Height = 30;
        ide.Surface.Add(t);
    });
    yield* settled(ide);

    /* --- the list ---------------------------------------------------------- */
    ide.designer.select(null);
    ide.MnuTabOrder_Click();
    const dlg = ide.tabOrderForm;
    yield;

    check("the tab order dialog opens", dlg !== undefined && dlg !== null);
    eq("with a row per focusable child", dlg.LstOrder.Count, 4);
    eq("in the order Tab takes them, ties in drawn order",
       dlg.LstOrder.Items.join(","), "Ok,Txt1,Txt2,Txt3");
    check("and it names the container it is editing",
          dlg.LblWhich.Text.includes("Child"), dlg.LblWhich.Text);

    /* --- nothing moved, nothing written ------------------------------------- */
    dlg.BtnOk_Click();
    yield;
    eq("OK without moving leaves the form unmodified", ide.designer.dirty, false);
    eq("and the controls as they were", byName(ide, "Txt1").TabIndex, 0);

    /* --- a real move -------------------------------------------------------- */
    ide.MnuTabOrder_Click();
    const moved = ide.tabOrderForm;
    yield;

    moved.LstOrder.Index = 0;
    moved.LstOrder_Select();
    check("up is off at the top", !moved.BtnUp.Enabled);
    check("and down is on", moved.BtnDown.Enabled);

    moved.LstOrder.Index = 3;
    moved.LstOrder_Select();
    check("down is off at the bottom", !moved.BtnDown.Enabled);

    moved.BtnUp_Click();
    eq("moving up swaps with the one above", moved.LstOrder.Items.join(","),
       "Ok,Txt1,Txt3,Txt2");
    eq("and the row stays chosen", moved.LstOrder.Index, 2);

    moved.BtnOk_Click();
    yield;
    eq("OK writes the order", byName(ide, "Txt3").TabIndex, 2);
    eq("...the one that came down", byName(ide, "Txt2").TabIndex, 3);
    eq("...and the ones that did not move", byName(ide, "Ok").TabIndex, 0);
    eq("and the form is modified", ide.designer.dirty, true);

    /* One Ctrl+Z for the whole reorder. The controls are rebuilt by an undo, so
     * they are found by name rather than held. */
    ide.MnuUndo_Click();
    yield;
    eq("one undo takes the whole reorder back", byName(ide, "Txt2").TabIndex, 0);
    eq("...and the other one with it", byName(ide, "Txt3").TabIndex, 0);

    /* --- a container edits its own children --------------------------------- */
    const box = new Panel();
    box.Name = "Box";
    box.X = 200; box.Y = 100; box.Width = 120; box.Height = 120;
    ide.Surface.Add(box);
    ["A", "B"].forEach((name, at) => {
        const t = new TextBox();
        t.Name = name;
        t.X = 10; t.Y = 10 + at * 40; t.Width = 90; t.Height = 30;
        box.Add(t);
    });
    yield* settled(ide);

    ide.designer.select(box);
    ide.MnuTabOrder_Click();
    const inner = ide.tabOrderForm;
    yield;
    eq("a selected container edits its own children",
       inner.LstOrder.Items.join(","), "A,B");
    check("and says which one", inner.LblWhich.Text.includes("Box"),
          inner.LblWhich.Text);
    inner.BtnCancel_Click();
    yield;

    /* A box has no order to give: `TabIndex` is read by a surface drawn in
     * coordinates, and GTK's own child order is what a box follows. */
    box.Arrangement = "Horizontal";
    eq("a box is not a container this edits", TabOrderForm.targetOf(ide), null);

    /* --- and the form goes back to what it was ------------------------------ */
    for (const c of [...ide.Surface.Children])
        if (!was.includes(c.Name)) c.Delete();

    ide.designer.select(null);
    ide.designer.touch();
    ide.BtnSave_Click();
    eq("the form is back to what it was", ide.Surface.Children.length, 2);
    eq("and saved", ide.designer.dirty, false);
    yield;
}

/*
 * What the editor proposes, once it is asked about the project rather than
 * about the words in the buffer.
 *
 * Everything here is a *lookup*: the controls come from the `.form` beside the
 * file, their properties and events from the real classes the runtime
 * publishes, and a global's members from the global itself. So this asserts the
 * answers exactly, which a completion built on inference could never be.
 */
function* p_completion(ide) {
    ide.openInTab("Child.js");
    yield;

    /*
     * The arguments the runtime really hands over, which `tests/widgets` pins by
     * measuring them through GTK: `before` stops where the word being typed
     * *starts*, and a name with an underscore arrives whole as the word. Made-up
     * arguments here are how the `Btn1_` case was first written passing a test
     * and answering nothing in the editor.
     */
    const ask    = (word, before) => ide.Editor_Complete(word, 1, 1, before);
    const answer = (word, before) => ask(word, before).map((p) => p.Text);

    check("a code tab says what its completion is called",
          ide.Editor.CompletionTitle !== "", ide.Editor.CompletionTitle);

    /* --- this. : the controls on the form beside this file ------------------ */
    const mine = answer("", "        this.");
    check("`this.` offers the form's own controls",
          mine.includes("Ok") && mine.includes("Msg"), JSON.stringify(mine));

    const ok = ask("", "        this.").find((p) => p.Text === "Ok");
    eq("each saying what it is", ok.Detail, "Button");

    check("and the methods this file declares",
          mine.some((t) => !["Ok", "Msg"].includes(t)),
          JSON.stringify(mine));

    /*
     * **The file is scanned when the completion starts, not on every keystroke
     * while it narrows.** Measured on the IDE's own `MainForm.js` -- 1239 lines
     * -- reading `Text` and scanning it is 9.2 ms, and this runs inside GTK's
     * completion machinery on the keystroke. Keying the cache on the text is a
     * cache that can never hit, the text being what changes as one types.
     */
    ide.completion.methods = { names: [] };
    answer("", "        this.");             /* starts a context: scans */
    const afterFirst = ide.completion.methods.names.length;
    check("starting a completion scans the file", afterFirst > 0);

    ide.completion.methods = { names: ["Marca"] };
    const narrowed = answer("Ma", "        this.");
    check("narrowing it does not scan again", narrowed.includes("Marca"),
          JSON.stringify(narrowed));
    eq("...which is what keeps 9 ms off every keystroke",
       ide.completion.methods.names.length, 1);
    ide.completion.methods = { names: [] };

    /* --- this.Ok. : what a Button really has -------------------------------- */
    const props = answer("", "        this.Ok.");
    check("`this.Btn.` offers that control's properties",
          props.includes("Text") && props.includes("Enabled"),
          JSON.stringify(props.slice(0, 10)));
    check("which are the class's own and not a list kept here",
          props.includes("Default"), JSON.stringify(props));
    check("a Label's are different from a Button's",
          !answer("", "        this.Msg.").includes("Default"));

    /* Two letters in, the context is the same string: `before` stops where the
     * word starts, so the answer does not fall apart as one types. Narrowing it
     * to `Te` is the runtime's, through GtkSourceView's own fuzzy match. */
    check("and still answers once letters of the property are typed",
          answer("Te", "        this.Ok.").includes("Text"),
          JSON.stringify(answer("Te", "        this.Ok.").slice(0, 6)));

    /* --- Ok_ : the events it raises ----------------------------------------- */
    /* The name arrives as the *word*, `_` being a word character, and `before`
      * holds only the indentation. */
    const events = answer("Ok_", "    ");
    eq("`Btn_` writes the handler's name", events[0], "Ok_Click");
    check("most derived first, which is EventNames()'s own order",
          events.indexOf("Ok_Click") < events.indexOf("Ok_MouseDown"),
          JSON.stringify(events));

    /* --- File. : a global's members, asked of the global -------------------- */
    const file = answer("", "        File.");
    check("a global offers what it really holds",
          file.includes("Load") && file.includes("Save"), JSON.stringify(file));
    eq("and says which of them are called",
       ask("", "        File.").find((p) => p.Text === "Load").Detail, "()");

    /* --- a namespace of this project ------------------------------------------
     *
     * `Ide.` in the IDE's own sources, and whatever a project declares in
     * anybody else's. It cannot be asked of the object the way `File.` is: the
     * namespace belongs to the project, which runs in another process, so this
     * reads the same two halves the runtime will act on -- the declaration, and
     * an assignment that really puts a class there.
     *
     * A loose `.js` and not a form, because that is what a namespace is mostly
     * made of: eighteen of the IDE's own classes have no `.form` at all.
     */
    Directory.Make(File.Join(TMP, "modules"));
    File.Save(File.Join(TMP, "modules", "Util.js"),
              'Namespace("Herr");\n\nHerr.Util = class Util {\n};\n');
    File.Save(File.Join(TMP, "modules", "Otro.js"),
              'Namespace("Herr");\n\nHerr.Otro = class Otro {\n};\n');
    File.Save(File.Join(TMP, "modules", "Suelto.js"), "class Suelto {\n}\n");
    ide.listFiles();
    yield;

    const ns = answer("", "        Herr.");
    check("a namespace offers what the project puts in it",
          ns.includes("Util") && ns.includes("Otro"), JSON.stringify(ns));
    eq("and nothing else", ns.length, 2);
    eq("a class in no namespace is not in one",
       answer("", "        Suelto.").length, 0);

    /* Declaring the namespace is not being in it: the assignment is what puts a
     * class there, and it is what the runtime will resolve. */
    File.Save(File.Join(TMP, "modules", "Otro.js"),
              'Namespace("Herr");\n\nclass Otro {\n}\n');
    ide.listFiles();
    yield;

    const still = answer("", "        Herr.");
    check("a file that only declares it adds no member",
          !still.includes("Otro") && still.includes("Util"), JSON.stringify(still));

    File.Delete(File.Join(TMP, "modules", "Util.js"));
    File.Delete(File.Join(TMP, "modules", "Otro.js"));
    File.Delete(File.Join(TMP, "modules", "Suelto.js"));
    File.Delete(File.Join(TMP, "modules"));
    ide.listFiles();
    yield;
    eq("and it goes with the files", answer("", "        Herr.").length, 0);

    /* --- a menu item, which is a thing a form has --------------------------- *
     *
     * It was not, for three flatteners at once: `Ide.Completion`, `Ide.Names`
     * and `Ide.Check` each walked a `.form`'s `children` and a menu is not among
     * them, so `this.MnuSave.` proposed nothing and `MnuSave_Clik()` went
     * unremarked. One walk now, in `Ide.Names`, over all three blocks that bind
     * a name on the form.
     *
     * And what a `MenuItem` has is asked of a real one, not listed here: neither
     * it nor an `Action` is a widget, so `Widget.New` cannot make one -- the
     * sample is borrowed from this window's own menu bar, which has both.
     */
    File.Save(File.Join(TMP, "Barra.form"), JSON.stringify({
        format: "bintana-form/1", class: "Barra",
        properties: { Width: 300, Height: 200 },
        actions: [{ name: "ActGo", text: "Go" }],
        menus: [{ name: "MnuTop", text: "T",
                  children: [{ name: "MnuSave", text: "S" },
                             { separator: true },
                             { name: "MnuRecent", text: "R", dynamic: true }] }],
        children: [{ type: "Label", name: "LblOne", properties: { X: 4, Y: 4 } }],
    }, null, 2));
    File.Save(File.Join(TMP, "Barra.js"),
              "class Barra extends Form {\n    MnuSave_Click() { }\n}\n");
    ide.listFiles();
    ide.openInTab("Barra.js");
    yield* settled(ide);

    const bar = answer("", "        this.");
    check("`this.` offers a menu item and a command, not only the controls",
          bar.includes("MnuSave") && bar.includes("ActGo") && bar.includes("LblOne"),
          JSON.stringify(bar));
    eq("...each saying what it is",
       ask("", "        this.").find((p) => p.Text === "MnuSave").Detail, "MenuItem");

    const item = answer("", "        this.MnuSave.");
    check("`this.MnuSave.` offers what a menu item really has",
          item.includes("Enabled") && item.includes("Items") && item.includes("Value"),
          JSON.stringify(item));
    check("and not a control's, which it is not",
          !item.includes("Text"), JSON.stringify(item));

    const menuEvents = answer("MnuSave_", "    ");
    eq("`MnuSave_` writes the one event an item raises", menuEvents[0], "MnuSave_Click");
    eq("...and it is the only one", menuEvents.length, 1);

    const cmd = answer("", "        this.ActGo.");
    check("a command answers for itself too", cmd.includes("Enabled"),
          JSON.stringify(cmd));

    /* --- a field or a local this file builds -------------------------------- *
     *
     * Still a lookup and still nothing inferred: what is read is a `new` written
     * in the file, or a JSDoc line. Measured before it was written -- of 1916
     * declarations in this tree only 12 % state a type at all -- so this is two
     * shapes and not a general answer, and the second is the one that matters:
     * `this.ide.` is 509 of the 1410 `this.<field>.` here, it is a constructor
     * parameter, and no `new` names it. TypeScript infers `any` for it too.
     */
    File.Save(File.Join(TMP, "Usa.js"),
              "class Usa {\n" +
              "    /** @param {Child} otro */\n" +
              "    constructor(otro) { this.otro = otro; }\n" +
              "    go() {\n" +
              "        const btn = new Button();\n" +
              "        this.lbl = new Label();\n" +
              "        this.suyo = new Barra();\n" +
              "    }\n" +
              "}\n");
    ide.listFiles();
    ide.openInTab("Usa.js");
    yield* settled(ide);

    const local = answer("", "        btn.");
    check("a local built here offers that class's properties",
          local.includes("Text") && local.includes("Default"), JSON.stringify(local));
    const field = answer("", "        this.lbl.");
    check("and so does a field", field.includes("Ellipsize"), JSON.stringify(field));
    check("...a Label's and not a Button's", !field.includes("Default"),
          JSON.stringify(field));

    const ours = answer("", "        this.suyo.");
    check("a class of the project answers with its own controls",
          ours.includes("LblOne") && ours.includes("MnuSave"), JSON.stringify(ours));
    check("...and the methods its file declares",
          ours.includes("MnuSave_Click"), JSON.stringify(ours));

    const said = answer("", "        this.otro.");
    check("a constructor parameter answers from the JSDoc line that says what it is",
          said.includes("Ok") && said.includes("Msg"), JSON.stringify(said));
    check("which is the 509-use case, and nothing else can say it",
          said.includes("Form_Open"), JSON.stringify(said));

    /* The tabs go before the files do: an open tab whose file disappears is a
     * question the IDE asks in a dialog, which is right for a person and a hung
     * test. */
    ide.closeTabByName("Usa.js", true);
    ide.closeTabByName("Barra.js", true);
    File.Delete(File.Join(TMP, "Usa.js"));
    File.Delete(File.Join(TMP, "Barra.js"));
    File.Delete(File.Join(TMP, "Barra.form"));
    ide.listFiles();
    ide.openInTab("Child.js");
    yield* settled(ide);

    /* Half a handler for a control that is not one is not a handler: it falls
     * through to the paths, which say nothing about it either. */
    eq("a local that merely looks like a handler proposes nothing",
       answer("my_thing", "        const ").length, 0);

    /* --- and where it stops, which is stated rather than guessed ------------- */
    eq("an expression the project says nothing about proposes nothing",
       answer("", "        makeThing().").length, 0);
    eq("nor does a control that is not on this form",
       answer("", "        this.Nope.").length, 0);
    eq("nor a name that is not a global",
       answer("", "        Whatever.").length, 0);

    /* --- what carries the question -------------------------------------------
     *
     * That the editor really *asks* is asserted in `tests/widgets`, where the
     * round trip goes through GTK's own completion machinery. It cannot be
     * asserted here: `gtk_source_completion_show` needs the view to hold the
     * keyboard focus, and holding it means the window is the *active* one --
     * which under Xvfb, with no window manager to make one active and other
     * windows from earlier phases about, the IDE's is not. Measured, not
     * assumed: the view is mapped and visible and `has_focus` is 0.
     *
     * What is left to pin here is the wiring, which is a name in two places.
     */
    /*
     * *Complete* (`Ctrl+Space`) is the other way to ask, and it is offered
     * exactly where there is text to ask about -- the accelerator has to be free
     * for whatever else has the focus on a form tab.
     */
    eq("asking for a completion is offered on a code tab", ide.MnuComplete.Enabled, true);
    ide.MnuComplete_Click();          /* it must not throw with an editor up */

    eq("every code tab's editor answers to one name", ide.Editor.Name, "Editor");
    check("which is the handler the runtime looks for on the form",
          typeof ide.Editor_Complete === "function");
    check("and the event that carries it is one the editor publishes",
          ide.Editor.EventNames().includes("Complete"));

    /* --- and it does not go stale --------------------------------------------
     *
     * The `.form` is read once and kept, because this runs on the keystroke --
     * so whoever changes the project's files has to say so, or a control added
     * in the designer would be missing from `this.` until the IDE was restarted.
     */
    check("the control added next is not there yet",
          !answer("", "        this.").includes("Button1"));

    ide.openInTab("Child.form");
    yield* settled(ide);
    palette(ide, "Button").Click();
    yield;
    const added = ide.designer.selected.Name;
    ide.BtnSave_Click();
    yield;

    ide.openInTab("Child.js");
    yield;
    check("a control added and saved is proposed without restarting anything",
          answer("", "        this.").includes(added), added);

    /* Put the form back the way the phases after this one expect it. */
    ide.openInTab("Child.form");
    yield* settled(ide);
    ide.designer.select(byName(ide, added));
    ide.ActDelCtl_Click();
    ide.BtnSave_Click();
    yield;
    eq("and the form is back to what it was", ide.Surface.Children.length, 2);

    ide.Editor && (ide.Editor.Modified = false);
    yield;
}

/*
 * Deleting a control, and what happens to the code it left behind.
 *
 * The two halves are one bug when they meet: the handlers stay in the `.js` --
 * deliberately, they are the user's code -- and names used to be handed out by
 * counting up over the live controls, so the next Button after deleting
 * `Button1` was `Button1` again and silently inherited whatever
 * `Button1_Click` still did.
 */
function* p_handlers(ide) {
    const jsName = "Child.js";
    const jsPath = File.Join(TMP, jsName);
    const wasJs  = File.Load(jsPath);        /* put back at the end */

    ide.openInTab("Child.form");
    yield* settled(ide);

    /* --- a control with something written for it ---------------------------- */
    ide.designer.select(null);
    palette(ide, "Button").Click();
    yield;
    const doomed = ide.designer.selected.Name;

    check("a fresh control gets a fresh name", doomed.startsWith("Button"), doomed);
    check("with nothing written for it yet",
          Ide.FormFiles.handlersIn(File.Load(jsPath), doomed).length === 0);

    /* Through the gesture, not by writing the file: double clicking a control is
     * what puts a handler in the .js. */
    check("writing its handler works", ide.formFiles.openHandler(doomed, "Click"));
    yield;
    eq("and the .js answers for it",
       JSON.stringify(Ide.FormFiles.handlersIn(File.Load(jsPath), doomed)),
       '["Click"]');

    /* --- deleting it ------------------------------------------------------- */
    ide.openInTab("Child.form");
    yield* settled(ide);
    ide.designer.select(byName(ide, doomed));

    /* Only what the log says *after* this: writing the handler a moment ago
     * logged its own line naming the same method and the same file, and an
     * assertion that searched the whole scrollback would pass on that -- which
     * is exactly what it did until the fix was reverted and it stayed green. */
    const said = ide.LogView.Text.length;
    ide.ActDelCtl_Click();

    check("the control is gone", !ide.Surface.Children.some((c) => c.Name === doomed));
    eq("and its code is not, which is the user's to keep",
       JSON.stringify(Ide.FormFiles.handlersIn(File.Load(jsPath), doomed)),
       '["Click"]');

    /* Said out loud: dead code nobody knows about is how this went wrong. */
    yield* until(() => ide.LogView.Text.slice(said).includes("still in"), 60);

    const tail = ide.LogView.Text.slice(said);
    check("the log says the handler stayed", tail.includes(`${doomed}_Click`),
          JSON.stringify(tail.slice(0, 200)));
    check("and which file it stayed in", tail.includes(jsName),
          JSON.stringify(tail.slice(0, 200)));
    check("and that the name is now spoken for",
          tail.includes("will not be given"), JSON.stringify(tail.slice(0, 200)));

    /* --- and the name is not handed on -------------------------------------- */
    palette(ide, "Button").Click();
    yield;
    const fresh = ide.designer.selected.Name;

    neq("the next control does not take the deleted one's name", fresh, doomed);
    check("so nothing it does was written for something else",
          Ide.FormFiles.handlersIn(File.Load(jsPath), fresh).length === 0, fresh);

    /*
     * And the evidence is in the file rather than in a counter, which is what
     * makes it survive the project being closed: asked again from nothing, the
     * answer is the same.
     */
    /* The method goes inside the class body, where a handler lives: a
     * `Name_Event() {}` after the closing brace is a call and a block, and the
     * parser does not report it as a method -- which is the point of asking a
     * parser instead of a pattern anchored at four spaces. */
    const brace = wasJs.lastIndexOf("}");
    eq("a name whose handlers are still written is taken",
       Ide.FormFiles.handlersIn(wasJs.slice(0, brace) +
                                `    ${doomed}_Click() {}\n` +
                                wasJs.slice(brace), doomed).length, 1);
    eq("and a mere mention of it in a call is not a handler",
       Ide.FormFiles.handlersIn(`        this.${doomed}_Click();\n`, doomed).length, 0);

    /* --- back to what the phases after this one expect ---------------------- */
    ide.designer.select(byName(ide, fresh));
    ide.ActDelCtl_Click();
    ide.BtnSave_Click();
    yield;

    File.Save(jsPath, wasJs);
    ide.tabs.reloadFromDisk(jsName);
    ide.openInTab("Child.form");
    yield* settled(ide);

    eq("and with a form up there is no text to complete",
       ide.MnuComplete.Enabled, false);
    eq("the form is as it was", ide.Surface.Children.length, 2);
    eq("and so is its code", File.Load(jsPath), wasJs);
}

/*
 * A file that changed underneath.
 *
 * The IDE writes these files itself, so the question a watch has to answer is
 * never "did it change" but "did somebody else change it" -- and the assertion
 * that matters most here is the negative one: saving must not put a notice up.
 */
/*
 * A file that is not UTF-8, which `File.Load` can only answer as text with
 * U+FFFD where every invalid byte was -- so opening a Latin-1 `.js` and saving
 * it replaced every accented letter, for good. It opens read-only now and no
 * road writes it: each one is driven here and the bytes compared after.
 */
function* p_foreign(ide) {
    /* "// cañón" with the two letters as Latin-1 bytes, and a class. */
    const latin = [0x2f, 0x2f, 0x20, 0x63, 0x61, 0xf1, 0xf3, 0x6e, 0x0a];
    for (const c of "class Latin extends Form {\n}\n") latin.push(c.charCodeAt(0));
    const path  = File.Join(TMP, "Latin.js");
    const fpath = File.Join(TMP, "Latin.form");
    File.SaveBytes(path, new Bytes(latin));
    File.SaveBytes(fpath, new Bytes([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d, 0x0a]));
    const hash  = File.Hash(path);
    const fhash = File.Hash(fpath);
    ide.listFiles();

    const said = ide.LogView.Text.length;
    ide.openInTab("Latin.js");
    yield* settled(ide);

    const state = ide.openTabs.get("Latin.js");
    check("a file that is not UTF-8 opens", !!state && ide.activeFile === "Latin.js");
    check("read-only", state && state.foreign && ide.Editor.ReadOnly);
    check("and the log says why",
          ide.LogView.Text.slice(said).includes("Latin.js") &&
          ide.LogView.Text.slice(said).includes("UTF-8"),
          ide.LogView.Text.slice(said));
    ide.refresh();
    check("and so does the status bar", ide.LblStatus.Text.includes("UTF-8"),
          ide.LblStatus.Text);

    /* Text assigned from code is the one way a read-only editor gets dirty. */
    ide.Editor.Text = `${ide.Editor.Text}// más\n`;
    eq("saving it is refused", ide.tabs.save(), false);
    eq("and so is saving everything", ide.tabs.saveAllDirty(), false);
    ide.tabs.rewriteSource("Latin.js", (t) => `${t}// rewritten\n`);
    eq("no recovery snapshot is taken of it", ide.tabs.contentOf("Latin.js"), null);
    eq("nor restored into it",
       ide.tabs.restore({ name: "Latin.js", mode: "edit", text: "x" }), false);
    eq("not a byte of the file changed", File.Hash(path), hash);

    ide.tabs.reloadFromDisk("Latin.js");
    check("reloading it keeps it read-only", ide.Editor.ReadOnly && state.foreign);

    /* A .form that is not UTF-8 is not drawn: a designer would serialise it. */
    ide.openInTab("Latin.form");
    yield* settled(ide);
    const fstate = ide.openTabs.get("Latin.form");
    check("a .form that is not UTF-8 opens as read-only text",
          fstate && fstate.mode === "edit" && fstate.foreign && ide.Editor.ReadOnly);
    eq("and is not written either", File.Hash(fpath), fhash);

    /* And U+FFFD in a file that *is* UTF-8 is a character, not a verdict. */
    File.Save(File.Join(TMP, "Replacement.js"), "// \uFFFD\n");
    ide.listFiles();
    ide.openInTab("Replacement.js");
    yield* settled(ide);
    check("a UTF-8 file holding U+FFFD is an ordinary tab",
          !ide.openTabs.get("Replacement.js").foreign && !ide.Editor.ReadOnly);

    for (const n of ["Latin.js", "Latin.form", "Replacement.js"]) {
        ide.closeTabByName(n, true);
        File.Delete(File.Join(TMP, n));
    }
    ide.listFiles();
    yield* settled(ide);
}

/*
 * A control's handlers are its name and one of its events, and nothing longer:
 * `\bBtn_(\w+)` took `Btn_Ok_Click`, the handler of a control called `Btn_Ok`,
 * so renaming `Btn` moved somebody else's code -- and the free-name check read
 * `Btn_Ok_Click` as `Btn` + `Ok_Click` and refused a name nobody was using.
 */
function* p_prefixes(ide) {
    const SOURCE = [
        "class Pre extends Form {",
        "    Btn_Click() {",
        "    }",
        "    Btn_Ok_Click() {",
        "    }",
        "}",
        "",
    ].join("\n");
    File.Save(File.Join(TMP, "Pre.js"), SOURCE);
    File.SaveJson(File.Join(TMP, "Pre.form"), {
        format: "bintana-form/1", class: "Pre",
        properties: { Width: 300, Height: 160 },
        children: [
            { type: "Button", name: "Btn",
              properties: { X: 10, Y: 10, Width: 80, Height: 30, Text: "a" } },
            { type: "Button", name: "Btn_Ok",
              properties: { X: 10, Y: 50, Width: 80, Height: 30, Text: "b" } },
        ],
    });
    ide.listFiles();
    ide.openInTab("Pre.form");
    yield* settled(ide);

    ide.designer.select(byName(ide, "Btn"));
    yield* settled(ide);
    check("renaming a control whose name another one starts with",
          ide.designer.renameControl("Save"));
    yield* settled(ide);
    let js = File.Load(File.Join(TMP, "Pre.js"));
    check("moves its own handler", js.includes("Save_Click()"), js);
    check("and leaves the other control's alone",
          js.includes("Btn_Ok_Click()") && !js.includes("Save_Ok_Click"), js);

    /* And back: `Btn_Ok_Click` is not a handler of a control called `Btn`. */
    ide.designer.select(byName(ide, "Save"));
    yield* settled(ide);
    check("a name another control's handlers start with is free",
          ide.designer.renameControl("Btn"));
    yield* settled(ide);
    js = File.Load(File.Join(TMP, "Pre.js"));
    check("and the handler comes back under it",
          js.includes("    Btn_Click()") && js.includes("Btn_Ok_Click()"), js);
    eq("Btn_Ok's handlers are not Btn's",
       Ide.FormFiles.handlersIn(js, "Btn").join(), "Click");

    for (const n of ["Pre.form", "Pre.js"]) {
        ide.closeTabByName(n, true);
        File.Delete(File.Join(TMP, n));
    }
    ide.listFiles();
    yield* settled(ide);
}

/*
 * A form open in a tab behind another one, rewritten by the IDE itself: its
 * **designer** is what saves, and it used to keep the old tree, class and path
 * while only `state.root` heard about the change -- so saving that tab after a
 * rename wrote the `.form` it had left, and after a class was renamed it put
 * the old type back into the form that places it.
 */
function* p_background(ide) {
    const form = (cls, children) => ({
        format: "bintana-form/1", class: cls,
        properties: { Width: 300, Height: 160 }, children,
    });
    File.SaveJson(File.Join(TMP, "Bg.form"), form("Bg", [
        { type: "Button", name: "B", properties: { X: 10, Y: 10, Width: 80, Height: 30, Text: "b" } }]));
    File.Save(File.Join(TMP, "Bg.js"), "class Bg extends Form {\n}\n");
    File.SaveJson(File.Join(TMP, "Part.form"), form("Part", []));
    File.Save(File.Join(TMP, "Part.js"), "class Part extends Component {\n}\n");
    File.SaveJson(File.Join(TMP, "Host.form"), form("Host", [
        { type: "Part", name: "P1", properties: { X: 10, Y: 10, Width: 80, Height: 30 } }]));
    File.Save(File.Join(TMP, "Host.js"), "class Host extends Form {\n}\n");
    ide.listFiles();

    /* --- a rename of the tab behind ---------------------------------------- */
    ide.openInTab("Bg.form");
    yield* settled(ide);
    ide.openInTab("Host.form");
    yield* settled(ide);
    eq("the form is renamed while its tab is behind another",
       ide.renameForm("Bg", "Bg2"), true);
    yield* settled(ide);
    const bg = ide.openTabs.get("Bg2.form");
    check("its designer follows the new path",
          bg && bg.designer && bg.designer.path.endsWith("Bg2.form"),
          bg && bg.designer ? bg.designer.path : "no tab");
    eq("and the new class", bg && bg.designer.serializeForm().class, "Bg2");
    ide.openInTab("Bg2.form");
    yield* settled(ide);
    ide.designer.touch();
    ide.save();
    yield* settled(ide);
    check("saving it does not bring the old file back",
          !File.Exists(File.Join(TMP, "Bg.form")));
    eq("and writes the new one with its class",
       File.LoadJson(File.Join(TMP, "Bg2.form")).class, "Bg2");

    /* --- a class renamed that the tab behind places ----------------------- */
    ide.openInTab("Host.form");
    yield* settled(ide);
    ide.openInTab("Bg2.form");
    yield* settled(ide);
    eq("a class the tab behind places is renamed", ide.renameForm("Part", "Piece"), true);
    yield* settled(ide);
    const host = ide.openTabs.get("Host.form");
    check("and nothing raises the reload bar for the IDE's own write",
          !host.changedOnDisk);
    ide.openInTab("Host.form");
    yield* settled(ide);
    eq("the tab behind draws the new type",
       ide.designer.serializeForm().children[0].type, "Piece");
    ide.designer.touch();
    ide.save();
    yield* settled(ide);
    eq("and saving it keeps the new type",
       File.LoadJson(File.Join(TMP, "Host.form")).children[0].type, "Piece");

    for (const n of ["Bg2.form", "Bg2.js", "Piece.form", "Piece.js", "Host.form", "Host.js"]) {
        ide.closeTabByName(n, true);
        if (File.Exists(File.Join(TMP, n))) File.Delete(File.Join(TMP, n));
        ide.dropSource(n);
    }
    ide.listFiles();
    yield* settled(ide);
}

function* p_watch(ide) {
    const name = "Child.js";
    const path = File.Join(TMP, name);

    ide.openInTab(name);
    yield;

    /*
     * From a known state: the phases before this one wrote `Child.js` straight
     * to disk, which is *precisely* what this feature reports -- so the bar is
     * up, correctly, before the first assertion is written.
     */
    ide.BtnReloadHide_Click();
    eq("with the news read, the bar goes away", ide.ReloadBar.Visible, false);

    /* --- our own save says nothing --------------------------------------- */
    const was = ide.Editor.Text;
    ide.Editor.Text = was + "\n/* mine */\n";
    ide.save();
    yield* until(() => false, 12);        /* give the watch its chance to fire */

    eq("saving from here is not somebody else changing it",
       ide.ReloadBar.Visible, false);

    /* --- and somebody else's write does ----------------------------------- */
    File.Save(path, was + "\n/* theirs */\n");
    yield* until(() => ide.ReloadBar.Visible, 80);

    check("a file rewritten from outside is reported", ide.ReloadBar.Visible);
    check("naming the file", ide.LblReload.Text.includes(name), ide.LblReload.Text);
    eq("and offering to take it", ide.BtnTakeDisk.Enabled, true);

    /* --- taking it --------------------------------------------------------- */
    ide.BtnTakeDisk_Click();
    yield;

    check("reloading takes what is on disk",
          ide.Editor.Text.includes("/* theirs */"), ide.Editor.Text.slice(-30));
    eq("and the bar has nothing left to say", ide.ReloadBar.Visible, false);

    /* --- a rewrite with the same bytes is not news ------------------------- */
    File.Save(path, ide.Editor.Text);
    yield* until(() => ide.ReloadBar.Visible, 40);
    eq("rewriting a file with what it already said changes nothing",
       ide.ReloadBar.Visible, false);

    /* --- and one can decline ---------------------------------------------- */
    File.Save(path, was + "\n/* again */\n");
    yield* until(() => ide.ReloadBar.Visible, 80);
    check("the next change is reported too", ide.ReloadBar.Visible);

    ide.BtnReloadHide_Click();
    eq("keeping what is open puts the bar away", ide.ReloadBar.Visible, false);
    check("and what is open is still what was open",
          !ide.Editor.Text.includes("/* again */"));

    /*
     * --- replaced, which is not the same as gone ---------------------------
     *
     * **Plenty of programs do not write a file in place**: the old one goes and
     * a new one takes its name. `git restore` is one of them, so discarding a
     * change reported *ClientsForm.js is no longer on disk* about a file that
     * was sitting right there, restored a moment earlier -- the watch believed
     * the word `"Deleted"` instead of looking.
     */
    const tab = ide.tabs.openTabs.get(name);

    File.Delete(path);
    File.Save(path, was + "\n/* replaced */\n");
    yield* until(() => tab.changedOnDisk, 80);

    check("a file replaced rather than rewritten is not a file that is gone",
          !tab.goneFromDisk);
    eq("and it is still offered", ide.BtnTakeDisk.Enabled, true);

    /* And the branch that must keep working: one that really is gone. */
    File.Delete(path);
    yield* until(() => tab.goneFromDisk, 80);

    check("a file that really went is still reported", tab.goneFromDisk);
    eq("with nothing to take from it", ide.BtnTakeDisk.Enabled, false);

    File.Save(path, was + "\n/* again */\n");
    yield* until(() => !tab.goneFromDisk, 80);
    check("and the notice is taken back when it comes back", !tab.goneFromDisk);

    ide.BtnReloadHide_Click();

    /* Put the project back the way the phases after this one expect it. */
    ide.Editor.Text = was;
    ide.save();
    ide.closeTabByName(name, true);
    yield;
    eq("and the file is as it was", File.Load(path), was);
}

/*
 * The events page of the side panel.
 *
 * What it has to prove is that it is a *view* and not a second opinion: the
 * rows are what `eventsOf` says, in that order, and the marks are what the
 * `.js` actually answers.  So every assertion here compares the drawn rows
 * against the same two sources the rest of the IDE asks, rather than against a
 * list written down in this file -- a control that grows an event in C must
 * show up here without this test being edited.
 */
function* p_events(ide) {
    const jsPath = File.Join(TMP, "Child.js");
    const wasJs  = File.Load(jsPath);        /* put back at the end */

    ide.openInTab("Child.form");
    yield* settled(ide);

    ide.SideTabs.Current = 1;
    yield* until(() => ide.EventList.Bounds().Height > 0);

    /* --- a control's events ------------------------------------------------ */
    ide.designer.select(null);
    palette(ide, "Button").Click();
    yield;

    const button = ide.designer.selected;
    const raised = ide.designer.eventsOf(button);

    eq("the page draws a row per event the control raises",
       eventRows(ide).length, raised.length);
    eq("in the order the control gives them, which is most derived first",
       JSON.stringify(eventRows(ide).map((r) => r.event)), JSON.stringify(raised));
    eq("and Click is the head of it, which is what a double click writes",
       raised[0], "Click");
    eq("each row shows the method it would be written as",
       eventRows(ide)[0].method, `${button.Name}_Click`);
    check("and nothing is marked, since nothing is written",
          eventRows(ide).every((r) => !r.written),
          JSON.stringify(eventRows(ide).filter((r) => r.written)));

    /* --- activating a row writes the handler -------------------------------- */
    ide.events.activated(0);
    yield;

    eq("activating a row writes that handler",
       JSON.stringify(Ide.FormFiles.handlersIn(File.Load(jsPath), button.Name)),
       '["Click"]');

    /* The page is behind the editor now -- writing a handler goes to it -- so
     * the row is read after coming back to the form. */
    ide.openInTab("Child.form");
    yield* settled(ide);
    ide.designer.select(byName(ide, button.Name));
    ide.SideTabs.Current = 1;
    yield;

    check("and the row for it is marked afterwards",
          eventRows(ide)[0].written,
          JSON.stringify(eventRows(ide)[0]));
    check("while the rest still are not",
          eventRows(ide).slice(1).every((r) => !r.written));

    /* Twice is a jump, not a second copy: `openHandler` decides, and this page
     * never has to know which of the two it asked for. */
    ide.events.activated(0);
    yield;
    eq("activating it again does not write it twice",
       Ide.FormFiles.handlersIn(File.Load(jsPath), button.Name).length, 1);

    /* --- the form's own events ---------------------------------------------- */
    ide.openInTab("Child.form");
    yield* settled(ide);
    ide.designer.select(null);
    ide.SideTabs.Current = 1;
    yield;

    const formEvents = ide.designer.grid.formProbe().EventNames();

    eq("with nothing selected the page is about the form",
       JSON.stringify(eventRows(ide).map((r) => r.event)), JSON.stringify(formEvents));
    check("whose handlers are written under the name a double click uses",
          eventRows(ide).every((r) => r.method.startsWith("Form_")),
          JSON.stringify(eventRows(ide).map((r) => r.method).slice(0, 3)));
    check("and Open is among them", formEvents.includes("Open"),
          JSON.stringify(formEvents));

    /* --- what makes it cheap enough to hang off refresh() ------------------- */
    const drawn = ide.events.drawn;
    ide.refresh();
    eq("a refresh that changes nothing redraws nothing", ide.events.drawn, drawn);

    ide.SideTabs.Current = 0;
    yield;
    const hidden = ide.EventList.Count;
    ide.designer.select(byName(ide, button.Name));
    ide.refresh();
    eq("and a selection while the page is hidden costs nothing",
       ide.EventList.Count, hidden);

    ide.SideTabs.Current = 1;
    yield;
    eq("which is caught up the moment it is looked at",
       eventRows(ide)[0].method, `${button.Name}_Click`);

    /* --- back to what the phases after this one expect ---------------------- */
    ide.ActDelCtl_Click();
    ide.BtnSave_Click();
    yield;

    File.Save(jsPath, wasJs);
    ide.SideTabs.Current = 0;
    yield* settled(ide);
}

/*
 * F12: where a name is declared.
 *
 * Almost everything here drives `find()` rather than the key, because that is
 * where the behaviour is -- a string in, a file and a line out, no caret and no
 * tab.  The gesture itself is asserted once at the end, with the caret really
 * put on a word, since what joins the two is `wordAtCursor` and that is worth
 * proving once rather than mocking.
 *
 * The negatives matter as much as the positives: this looks names up and never
 * infers, so a name nothing declares has to go **nowhere**.  A wrong jump is
 * the one outcome worse than no jump.
 */
function* p_goto(ide) {
    const jsPath = File.Join(TMP, "Child.js");
    const wasJs  = File.Load(jsPath);        /* put back at the end */

    /* An earlier phase left a tab open on this file, and a tab is what the
     * navigator reads -- so writing the file under it would prove nothing. */
    ide.closeTabByName("Child.js", true);
    yield;

    /* A method to find, and a control mentioned from the code. */
    File.Save(jsPath,
              'class Child extends Form {\n' +
              '    Form_Open() {\n' +
              '        this.Ok.Text = "ok";\n' +
              '        this.greet();\n' +
              '    }\n' +
              '\n' +
              '    greet() {\n' +
              '        print("hello from the child");\n' +
              '        Application.Quit(0);\n' +
              '    }\n' +
              '}\n');

    ide.openInTab("Child.js");
    yield* settled(ide);

    const nav = ide.navigator;

    /* --- a class of the project -------------------------------------------- */
    const cls = nav.find("Child");
    eq("a class of the project is found", cls && cls.file, "Child.js");
    eq("at the line it is declared on", cls && cls.line, 1);

    /* `Ide.Events` and `Events` are one class: the tail is its name. */
    const qualified = nav.find("Whatever.Child");
    eq("a qualified name resolves to the same class",
       qualified && qualified.file, "Child.js");

    /* A class the project reaches through `uses`, which lives under lib/ and is
     * in the listing like any other file of the tree. */
    const dial = nav.find("Dial");
    eq("a class in the project's own lib/ is found too",
       dial && dial.file, File.Join("lib", "gadgets", "Dial.js"));

    /* --- a method of the file being edited ---------------------------------- */
    const method = nav.find("greet");
    eq("a method of the open file is found", method && method.file, "Child.js");
    eq("at its own line", method && method.line, 7);

    const viaThis = nav.find("this.greet");
    eq("and `this.` reaches the same one", viaThis && viaThis.line, 7);

    /*
     * **What the tab says, not what the file says.** A method written a moment
     * ago and not yet saved is still a method, and jumping to where the file on
     * disk has it would land on the wrong line -- which is the same bargain
     * `FormFiles.siblingSource` makes for the handler marks.
     */
    const onScreen = ide.Editor.Text;

    /* Inside the class body, which is where a method is one: the answer comes
     * from the parser now, and a `later() {}` before the `class` line is a call
     * and a block -- not a method -- so it would not be found at all. */
    ide.Editor.Text = onScreen.replace("{\n", "{\n    later() {\n    }\n");
    yield;
    const unsaved = nav.find("later");
    eq("a method typed and not saved is found", unsaved && unsaved.line, 2);
    eq("and the ones under it have moved with it", nav.find("greet").line, 9);

    ide.Editor.Text = onScreen;
    yield;
    eq("and taking it back out puts the lines back", nav.find("greet").line, 7);

    /* --- a control of the .form beside the code ----------------------------- */
    const control = nav.find("this.Ok");
    eq("`this.` on a control names the form", control && control.file, "Child.form");
    eq("and which control it is", control && control.control, "Ok");
    check("a control is not given a line, because a designer has no lines",
          control && !("line" in control), JSON.stringify(control));

    /* --- and what it refuses ------------------------------------------------ */
    check("a name nothing declares goes nowhere", nav.find("NoSuchThing") === null);
    check("and neither does nothing at all", nav.find("") === null);
    check("nor a control of some other form",
          nav.find("this.Face") === null, JSON.stringify(nav.find("this.Face")));
    /*
     * The runtime's own names are F1's question, not this one: there is no
     * definition in this project to go to.
     */
    check("a runtime class is left to F1", nav.find("TableView") === null);

    /* --- what a declaration is, which is not a mention ---------------------- */
    const syms = nav.symbols(File.Load(jsPath));
    eq("every method the file declares is listed", syms.length, 2);
    eq("in the order they are written",
       JSON.stringify(syms.map((s) => s.name)), '["Form_Open","greet"]');
    eq("with the line each is on", syms[1].line, 7);
    eq("a mention in a call is not a declaration",
       nav.symbolLine("        this.greet();\n", "greet"), 0);

    /* --- the gesture, with a real caret ------------------------------------- */
    ide.Editor.Select(1, 8);                    /* inside `Child` */
    eq("the caret is on the class's name", ide.wordAtCursor(), "Child");

    ide.openInTab("Child.form");
    yield* settled(ide);
    check("a form tab has no word to be on, so F12 is off", !ide.MnuGoto.Enabled);

    ide.openInTab("Child.js");
    yield* settled(ide);
    check("and a code tab has", ide.MnuGoto.Enabled);

    ide.Editor.Select(3, 15);                   /* inside `this.Ok.Text` */
    /* The whole dotted run is the word, and trimming it to the part that can
     * be looked up is `find`'s job -- `this.Ok.Text` is the control `Ok`. */
    eq("the caret is on a control", ide.wordAtCursor(), "this.Ok.Text");

    /* Through the menu item, which is the road the key takes -- what it
     * answers is asserted below, by where the IDE ended up. */
    ide.MnuGoto_Click();
    yield* settled(ide);

    eq("which opens the form", ide.activeFile, "Child.form");
    eq("with that control selected", ide.designer.selected.Name, "Ok");

    /* A name that goes nowhere says so, rather than doing nothing in silence. */
    ide.openInTab("Child.js");
    yield* settled(ide);
    ide.LogView.Clear();
    ide.Editor.Select(8, 10);                   /* inside `print` */
    check("F12 on a name nothing declares does not move", !nav.go());
    check("and says so in the log", ide.LogView.Text.includes("print"),
          JSON.stringify(ide.LogView.Text.slice(0, 120)));

    /* --- Ctrl+Shift+O: the methods as a list, and a line number ------------- */
    ide.MnuGotoSymbol_Click();
    const dlg = ide.symbolPicker;
    yield;

    check("the go-to dialog opens", dlg !== undefined && dlg !== null);
    eq("with a row per method the file declares", dlg.List.Count, 2);
    eq("in the order they are written", dlg.symbols[0].name, "Form_Open");
    eq("and it says how many", dlg.LblCount.Text, Locale.Plural("{0} method",
                                                                "{0} methods", 2));

    /* Typing narrows it, and the same question answers both the filter and
     * Enter -- which is why they cannot disagree. */
    dlg.TxtFind.Text = "gre";
    dlg.TxtFind_Change();
    check("typing hides what does not match", !dlg.matches(0));
    check("and keeps what does", dlg.matches(1));
    eq("Enter would take the first one still showing", dlg.firstShowing(), 7);

    /* Digits are a line, which is what lets one box be both. */
    dlg.TxtFind.Text = "5";
    dlg.TxtFind_Change();
    eq("a number is a line", dlg.lineWanted(), 5);
    check("and then nothing in the list matches", !dlg.matches(0) && !dlg.matches(1));

    dlg.TxtFind.Text = "999";
    dlg.TxtFind_Change();
    eq("a line past the end of the file is not a line", dlg.lineWanted(), 0);
    /* 12 and not 11: the file ends in a newline, so there is a last empty line
     * a caret can sit on -- which is what the editor itself counts. */
    check("and the bar says how many there are",
          dlg.LblCount.Text.includes("12"), dlg.LblCount.Text);

    /*
     * And *Go* acts on the row that is chosen, which it did not: it took the
     * first match whatever the list was showing, so walking to a method with the
     * arrows and pressing the button went somewhere else. `QuickForm` was
     * written beside this one and found it.
     */
    dlg.TxtFind.Text = "";
    dlg.TxtFind_Change();
    dlg.List.Index = -1;
    eq("with nothing chosen, Go takes the first match",
       dlg.wanted(), dlg.firstShowing());

    dlg.List.Index = 1;
    eq("with a row chosen, Go takes that one", dlg.wanted(), dlg.symbols[1].line);
    check("...which is not the first",
          dlg.symbols[1].line !== dlg.firstShowing(),
          `${dlg.symbols[1].line} vs ${dlg.firstShowing()}`);

    /* A number still wins over both: it names a place the list does not hold. */
    dlg.TxtFind.Text = "5";
    dlg.TxtFind_Change();
    eq("a line number beats the chosen row", dlg.lineWanted(), 5);

    dlg.TxtFind.Text = "7";
    dlg.TxtFind_Change();
    dlg.BtnOk_Click();
    yield* settled(ide);

    eq("going to a line goes there", ide.Editor.Line, 7);
    check("and the dialog is gone", ide.symbolPicker.Visible === false);

    /*
     * And Escape closes it, which it did not.
     *
     * Escape emits `clicked` on whichever button carries `Cancel` and stops
     * there -- this runtime will not close a window on a stray keystroke unless
     * the window says so -- and this dialog had no handler on that button. So
     * neither Escape nor the button itself dismissed it, and nothing noticed,
     * the way nothing notices a handler that is never called. Every other dialog
     * in this IDE has the line; this one got it when `QuickForm` was written
     * beside it.
     */
    ide.MnuGotoSymbol_Click();
    yield;
    const escaping = ide.symbolPicker;
    check("the dialog is up again", escaping.Visible);
    eq("...and Escape is its Cancel button",
       escaping.CancelButton, escaping.BtnCancel);
    escaping.BtnCancel.Click();
    yield* until(() => !escaping.Visible);
    check("pressing it closes the window", !escaping.Visible);

    /* --- back to what the phases after this one expect ---------------------- */
    ide.closeTabByName("Child.js", true);
    yield;
    File.Save(jsPath, wasJs);
    yield* settled(ide);
}

/*
 * The rows as they are drawn, which is what a reader of the panel sees: the
 * mark, the event and the method.  Read off the labels rather than asked of
 * `Ide.Events`, because a page that agrees with itself proves nothing.
 */
function eventRows(ide) {
    return ide.EventList.Children.map((row) => {
        const [mark, name, method] = row.Children;
        return {
            written: mark.Text !== "",
            event:   name.Text.replace("<b>", "").replace("</b>", ""),
            method:  method.Text,
        };
    });
}

/*
 * The project's images: in the tree, and shown.
 *
 * A `.png` used not to be in the tree at all -- the IDE lists what it can open,
 * and an image is not something one edits here. Which left "the IDE cannot show
 * you your own file", a worse answer than a window that can.
 */
function* p_images(ide) {
    const shot = "shot.png";
    const from = File.Join(Application.Directory, "..", "widgets", "images", "wide.png");

    /* `File.Copy` and not `Load` + `Save`: those go through a JS string, which
     * is right for source and wrong for a PNG. */
    File.Copy(from, File.Join(TMP, shot));
    ide.listFiles();
    yield;

    check("an image is listed with the project's files",
          ide.files.includes(shot), JSON.stringify(ide.files));
    check("under a category of its own", ide.FileTree.Exists("cat:images"));
    check("and as a leaf one can point at", ide.FileTree.Exists(shot));

    /*
     * **The category is the vocabulary, so it does not come and go.** A folder
     * holding nothing but images still gets one: this is a view of the *project*
     * and not of the disk -- it shows a form's two files as one node, which no
     * directory does -- and a category that appeared only sometimes would be a
     * vocabulary with a hole in it. Dropping it there was tried and put back.
     */
    Directory.Make(File.Join(TMP, "art"));
    File.Copy(from, File.Join(TMP, "art", "one.png"));
    File.Copy(from, File.Join(TMP, "art", "two.png"));
    ide.listFiles();
    yield;

    check("a folder of images is a node of its own", ide.FileTree.Exists("dir:art"));
    check("with the category inside it, as anywhere else",
          ide.FileTree.Exists("cat:images:art"));
    check("and the images under that",
          ide.FileTree.Exists("art/one.png") && ide.FileTree.Exists("art/two.png"));

    File.Delete(File.Join(TMP, "art", "one.png"));
    File.Delete(File.Join(TMP, "art", "two.png"));
    File.Delete(File.Join(TMP, "art"));
    ide.listFiles();
    yield;

    /* --- selecting one opens nothing -------------------------------------
     *
     * The arrow keys walk a tree, so a viewer per row walked through is
     * unusable -- the same reason a catalogue is opened on Activate.
     */
    const openTabs = ide.Tabs.Count;
    ide.FileTree.Key = shot;
    ide.FileTree_Select();
    yield;

    eq("selecting it opens no tab", ide.Tabs.Count, openTabs);
    eq("but the tree remembers what was pointed at", ide.selectedImage, shot);

    /* --- and activating one shows it -------------------------------------- */
    ide.FileTree_Activate();
    yield;

    const viewer = ImageForm.open;
    check("double clicking opens the viewer", viewer !== null && viewer !== undefined);
    eq("on the file that was pointed at", viewer.file, shot);
    eq("which it says in its title",      viewer.Text, shot);
    check("modal, because looking is not a second thing to keep track of",
          viewer.Modal);

    eq("it measured the file", viewer.Shown.SourceWidth, 120);
    eq("...on both axes",      viewer.Shown.SourceHeight, 80);

    /* Fit is a zoom worked out from the room, which is what `SourceWidth` is
     * published for -- so it lands a frame later, once there is a room. */
    yield* until(() => viewer.Shown.Zoom > 0, 60);
    check("and fitted it to the window", viewer.Shown.Zoom > 0,
          `${viewer.Shown.Zoom}`);
    check("saying what it is and how it is shown",
          viewer.LblAbout.Text.includes("120") && viewer.LblAbout.Text.includes("%"),
          viewer.LblAbout.Text);

    viewer.BtnOne_Click();
    eq("1:1 is a zoom of one", viewer.Shown.Zoom, 1);
    viewer.BtnIn_Click();
    check("zooming in goes past it", viewer.Shown.Zoom > 1, `${viewer.Shown.Zoom}`);
    viewer.BtnOut_Click();
    eq("and back", Math.round(viewer.Shown.Zoom * 100) / 100, 1);

    /* The keys a viewer has. */
    eq("0 is one to one", viewer.Form_KeyPress("0", false), true);
    eq("...and it is",    viewer.Shown.Zoom, 1);
    eq("a key nobody claimed is left alone",
       viewer.Form_KeyPress("F7", false), false);

    viewer.BtnClose_Click();
    yield;
    check("closing lets go of it", ImageForm.open === null);

    /* Put the project back. */
    File.Delete(File.Join(TMP, shot));
    ide.listFiles();
    yield;
    check("and the image is gone from the tree", !ide.files.includes(shot));
}

/*
 * The tree, in two views.
 *
 * `Project` groups by what a file *is* and lies about the disk on purpose -- a
 * form's two files are one node, `po/` is not drawn. `Files` is the other
 * question: what is really in that directory, including everything the project
 * does not recognise, which until this view existed was invisible here.
 */
/*
 * The folders a tool names are not nodes.
 *
 * The IDE puts new files in `forms/`, `components/` and `modules/`, and the
 * runtime looks for catalogues in `po/`. None of the four is an organisation
 * somebody chose, so drawing them would put a `forms` node with a `Forms`
 * category inside it -- one thing said twice, the second half a translation of
 * the first. The category speaks for the folder and the files are gathered as
 * though they were at the root, which is what the catalogues always did.
 */
function* p_tooldirs(ide) {
    Directory.Make(File.Join(TMP, "forms"));
    File.Copy(File.Join(TMP, "Child.form"), File.Join(TMP, "forms", "Aparte.form"));
    File.Save(File.Join(TMP, "forms", "Aparte.js"),
              "class Aparte extends Form {\n}\n");
    Directory.Make(File.Join(TMP, "modules"));
    File.Save(File.Join(TMP, "modules", "Util.js"), "class Util {\n}\n");
    ide.listFiles();
    yield;

    check("a form in forms/ is in the project", ide.files.includes("forms/Aparte.form"));
    check("and so is a module in modules/",     ide.files.includes("modules/Util.js"));

    check("but neither folder is a node of its own",
          !ide.FileTree.Exists("dir:forms") && !ide.FileTree.Exists("dir:modules"));
    check("the form is under the category, at the top",
          ide.FileTree.Exists("form:forms/Aparte"));
    check("and the module under its own",
          ide.FileTree.Exists("modules/Util.js"));

    /*
     * Until somebody leaves something else in there -- an image dropped in
     * `modules/`. Hiding the folder would then be hiding a file from the person
     * who put it there, so it comes back as a folder.
     */
    File.Copy(File.Join(Application.Directory, "..", "widgets", "images", "wide.png"),
              File.Join(TMP, "modules", "logo.png"));
    ide.listFiles();
    yield;

    check("a folder holding something else is a folder again",
          ide.FileTree.Exists("dir:modules"));

    /*
     * None of which touches the other view: that one is a picture of the disk,
     * and on the disk the folder is there.
     */
    ide.CmbView.Index = 1;
    ide.CmbView_Select();
    yield;

    check("the files view draws it, because it is really there",
          ide.FileTree.Exists("dir:forms") && ide.FileTree.Exists("dir:modules"));
    check("with the file where it lives", ide.FileTree.Exists("forms/Aparte.form"));

    ide.CmbView.Index = 0;
    ide.CmbView_Select();
    yield;

    /* And a folder somebody organised is always a node, tool name or not. */
    File.Delete(File.Join(TMP, "modules", "logo.png"));
    Directory.Make(File.Join(TMP, "src"));
    Directory.Make(File.Join(TMP, "src", "forms"));
    File.Save(File.Join(TMP, "src", "forms", "Suyo.js"), "class Suyo {\n}\n");
    ide.listFiles();
    yield;

    check("a forms/ somebody nested is theirs, and is drawn",
          ide.FileTree.Exists("dir:src") && ide.FileTree.Exists("dir:src/forms"));

    /* Back to what the phases after this expect. */
    File.Delete(File.Join(TMP, "src", "forms", "Suyo.js"));
    File.Delete(File.Join(TMP, "src", "forms"));
    File.Delete(File.Join(TMP, "src"));
    File.Delete(File.Join(TMP, "forms", "Aparte.form"));
    File.Delete(File.Join(TMP, "forms", "Aparte.js"));
    File.Delete(File.Join(TMP, "forms"));
    File.Delete(File.Join(TMP, "modules", "Util.js"));
    File.Delete(File.Join(TMP, "modules"));
    ide.listFiles();
    yield;
}

/*
 * The hierarchy of the project view is the namespaces.
 *
 * A namespace is what the *runtime* resolves -- `Cosas.Uno` is the name a
 * `.form` writes and `startup` names -- and it is declared by the code, so it is
 * free of where the file sits. That is the whole reason it is the hierarchy
 * here: two folders feeding one namespace are one node, which no folder tree can
 * draw, and the folders are still there in the other view for the question they
 * do answer.
 */
function* p_namespaces(ide) {
    /* `una/` and not `lib/`: a folder called `lib` is where `project.json`'s
     * `uses` looks first, so it is a vendored library and never a namespace --
     * asserted at the end of this phase. Which folder these sit in is arbitrary
     * here, and that is the point of the phase. */
    Directory.Make(File.Join(TMP, "una"));
    Directory.Make(File.Join(TMP, "otra"));
    File.Save(File.Join(TMP, "una", "Uno.js"),
              'Namespace("Cosas");\n\nCosas.Uno = class Uno {\n};\n');
    File.Save(File.Join(TMP, "otra", "Dos.js"),
              'Namespace("Cosas");\n\nCosas.Dos = class Dos {\n};\n');
    File.Save(File.Join(TMP, "una", "Hondo.js"),
              'Namespace("Cosas.Muy");\n\nCosas.Muy.Hondo = class Hondo {\n};\n');
    File.Save(File.Join(TMP, "otra", "Plana.js"), "class Plana {\n}\n");
    ide.listFiles();
    yield;

    /* --- one node per namespace, wherever the files are --------------------- */
    check("a namespace is a node", ide.FileTree.Exists("ns:Cosas"));
    check("holding what the code put in it, from either folder",
          ide.FileTree.Exists("una/Uno.js") && ide.FileTree.Exists("otra/Dos.js"));
    check("under a category, as everything in this view is",
          ide.FileTree.Exists("cat:mods:ns:Cosas"));

    /* And it must not look like a folder: what it groups is a name classes are
     * inside of, gathered from wherever their files are. A package, which is
     * what every other IDE draws for this. */
    check("with an icon of its own, which is not the folder one",
          ide.treeIcon("namespace") !== "" &&
          ide.treeIcon("namespace") !== ide.treeIcon("folder"),
          `${ide.treeIcon("namespace")} vs ${ide.treeIcon("folder")}`);

    check("a folder that only fed a namespace is not drawn as well",
          !ide.FileTree.Exists("dir:una"), JSON.stringify(Dictionary.Keys(ide.byKey)));

    /* A class in no namespace lives at the top -- which is what the runtime says
     * of a bare name -- so the folder somebody made for it is still a folder. */
    check("a folder with a class in no namespace stays a folder",
          ide.FileTree.Exists("dir:otra"));
    check("with that class in it", ide.FileTree.Exists("otra/Plana.js"));

    /* --- and they nest ------------------------------------------------------ */
    check("a nested namespace is a node of its own",
          ide.FileTree.Exists("ns:Cosas.Muy"));
    /*
     * Under it in the tree, and not merely in the key this file chose to write.
     * `Expanded` answers false for a node whose ancestors are closed -- it has
     * no row then -- so closing `Cosas` is what proves `Cosas.Muy` hangs from
     * it. The folder beside it is the control: it stays open, being nobody's
     * child.
     */
    ide.FileTree.ExpandNode("ns:Cosas");
    ide.FileTree.ExpandNode("ns:Cosas.Muy");
    ide.FileTree.ExpandNode("dir:otra");
    check("the nested one can be opened", ide.FileTree.Expanded("ns:Cosas.Muy"));

    ide.FileTree.CollapseNode("ns:Cosas");
    check("and closing the one above takes it off the tree",
          !ide.FileTree.Expanded("ns:Cosas.Muy"));
    check("...while a node of the top level is untouched",
          ide.FileTree.Expanded("dir:otra"));
    check("and holds its own class", ide.FileTree.Exists("una/Hondo.js"));

    /* A level nobody is directly in is still a step of a name somebody wrote. */
    File.Delete(File.Join(TMP, "una", "Uno.js"));
    File.Delete(File.Join(TMP, "otra", "Dos.js"));
    ide.listFiles();
    yield;

    check("a namespace with only a nested one under it is still a node",
          ide.FileTree.Exists("ns:Cosas") && ide.FileTree.Exists("ns:Cosas.Muy"));
    check("and has no category of its own, having nothing of its own",
          !ide.FileTree.Exists("cat:mods:ns:Cosas"));

    /* --- what the other view says, which is the directory ------------------- */
    ide.CmbView.Index = 1;
    ide.CmbView_Select();
    yield;

    check("the files view draws the folders, because that is what is there",
          ide.FileTree.Exists("dir:lib") && ide.FileTree.Exists("dir:otra"));
    check("and no namespace at all, since none is a directory",
          !ide.FileTree.Exists("ns:Cosas"));

    ide.CmbView.Index = 0;
    ide.CmbView_Select();
    yield;

    /* --- it is read from the code, and follows it --------------------------- */
    File.Save(File.Join(TMP, "una", "Hondo.js"),
              'Namespace("Otras");\n\nOtras.Hondo = class Hondo {\n};\n');
    ide.listFiles();
    yield;

    check("editing the declaration moves the class in the tree",
          ide.FileTree.Exists("ns:Otras") && !ide.FileTree.Exists("ns:Cosas"),
          JSON.stringify(Dictionary.Keys(ide.byKey)));

    File.Delete(File.Join(TMP, "una", "Hondo.js"));
    File.Delete(File.Join(TMP, "otra", "Plana.js"));
    File.Delete(File.Join(TMP, "una"));
    File.Delete(File.Join(TMP, "otra"));
    ide.listFiles();
    yield;

    check("and a namespace nobody is in is not a node",
          !ide.FileTree.Exists("ns:Otras"));
}

/*
 * The IDE's own project, drawn by the IDE.
 *
 * It is the largest Bintana project there is and the one that uses every rule
 * here at once: eighteen classes in `Ide`, a `forms/` and a `modules/` the tool
 * named, forms in no namespace at all. Opening it read-only is the cheapest
 * check that the three fit together in something real rather than in fixtures.
 */
function* p_selfns(ide) {
    openFresh(ide, File.Join(Application.Directory, "..", "..", "ide"));
    yield;

    check("its own modules are a namespace", ide.FileTree.Exists("ns:Ide"));
    check("under a category, being loose classes",
          ide.FileTree.Exists("cat:mods:ns:Ide"));
    check("with the files themselves in it",
          ide.FileTree.Exists("modules/Designer.js") &&
          ide.FileTree.Exists("modules/ProjectTree.js"));
    check("and the folder they are in is not drawn as well",
          !ide.FileTree.Exists("dir:modules"));

    /* The forms are in no namespace, so they are at the top -- where a bare
     * name lives -- and `forms/` is a folder the tool named, so it is not a
     * node either. */
    check("its forms are a category of the top level",
          ide.FileTree.Exists("cat:forms") && !ide.FileTree.Exists("dir:forms"));
    check("with the startup form among them", ide.FileTree.Exists("form:forms/MainForm"));

    /* Back to the project the phases after this one work in. */
    openFresh(ide, TMP);
    yield;
    eq("and the tests go on where they were", ide.project, TMP);
}

function* p_views(ide) {
    const readme = "README.md";
    const stray  = "notes.txt";
    const blob   = "notes.bin";

    File.Save(File.Join(TMP, readme), "# el proyecto\n");
    /* Text, and not a kind of file the project knows: what this view is for. A
     * `.md` used to be this example and is a project file now -- it opens as a
     * document, which is `p_document` below. */
    File.Save(File.Join(TMP, stray), "un apunte\n");
    File.Copy(File.Join(Application.Directory, "..", "widgets", "images", "small.png"),
              File.Join(TMP, blob));

    /* A folder of its own, with something in it the project does not recognise
     * either: the point of this view is the shape of the directory. */
    Directory.Make(File.Join(TMP, "notas"));
    File.Save(File.Join(TMP, "notas", "leeme.md"), "hola\n");
    ide.listFiles();
    yield;

    /* --- the chooser -------------------------------------------------------- */
    eq("the side bar offers three views", ide.CmbView.Count, 3);
    eq("and starts on the project's", ide.CmbView.Index, 0);

    check("neither stray file is in the project view",
          !ide.FileTree.Exists(stray) && !ide.FileTree.Exists(blob));
    check("...because the project does not recognise them",
          !ide.files.includes(stray), JSON.stringify(ide.files.slice(0, 6)));
    check("a document of the project is in it, though",
          ide.FileTree.Exists(readme) && ide.files.includes(readme),
          JSON.stringify(ide.files.slice(0, 8)));

    /* --- what is really there ----------------------------------------------- */
    ide.CmbView.Index = 1;
    ide.CmbView_Select();
    yield;

    check("the files view shows what the project does not know about",
          ide.FileTree.Exists(stray) && ide.FileTree.Exists(blob));
    check("and the folders as they really are", ide.FileTree.Exists("dir:notas"));
    check("with what is inside them, where it lives",
          ide.FileTree.Exists("notas/leeme.md"));
    check("no categories, since this view is not grouping anything",
          !ide.FileTree.Exists("cat:forms") && !ide.FileTree.Exists("cat:images"));

    /* --- and what activating one does ---------------------------------------- */
    ide.FileTree.Key = stray;
    ide.FileTree_Select();
    yield;

    eq("a file the desktop calls text opens in a tab", ide.activeFile, stray);
    check("read into the editor", ide.Editor.Text.includes("un apunte"),
          ide.Editor.Text);

    /*
     * And one that is not text is not read into an editor: what *is* text is not
     * a list of extensions kept here, it is the content type the desktop
     * reports -- `notes.bin` is a PNG under another name, and the extension
     * would have said nothing.
     */
    const was = ide.activeFile;
    ide.FileTree.Key = blob;
    ide.FileTree_Select();
    yield;

    eq("something that is not text opens no tab", ide.activeFile, was);
    eq("and is remembered for the double click", ide.selectedOther, blob);

    /* --- back, and the choice is remembered ---------------------------------- */
    ide.CmbView.Index = 0;
    ide.CmbView_Select();
    yield;

    check("the project view is back", ide.FileTree.Exists("cat:forms"));
    check("and the stray files are out of sight again",
          !ide.FileTree.Exists(stray));
    eq("the choice is written down, so it survives closing the IDE",
       Settings.Get("tree.view", -1), 0);

    ide.closeTabByName(stray, true);
    File.Delete(File.Join(TMP, stray));
    File.Delete(File.Join(TMP, readme));
    File.Delete(File.Join(TMP, blob));
    File.Delete(File.Join(TMP, "notas", "leeme.md"));
    File.Delete(File.Join(TMP, "notas"));
    ide.listFiles();
    yield;
}

/*
 * A Markdown file, shown as the document it is.
 *
 * The IDE's one reader: `.md` is a project file, it opens rendered, the editor
 * is a click behind it, and a project nobody has opened here before opens on its
 * README. What is asserted is what a person would see -- the headings the page
 * really laid out, which widget is on screen, and the tab still being an
 * ordinary code tab underneath.
 */
function* p_document(ide) {
    const readme = "README.md";
    const text   = "# El proyecto\n\nUn parrafo con **negrita** y un " +
                   "[enlace](Child.form) al formulario.\n\n## Notas\n\nFin.\n";

    File.Save(File.Join(TMP, readme), text);
    ide.listFiles();
    yield;

    ide.FileTree.Key = readme;
    ide.FileTree_Select();
    yield;

    check("a document is in a category of its own",
          ide.FileTree.Exists("cat:docs") && ide.FileTree.Exists(readme));

    eq("a document opens like any other file", ide.activeFile, readme);
    check("and the tab holds one", !!ide.document);
    check("showing the document and not its source", !ide.document.editing());
    eq("with the file's headings laid out", ide.document.doc.Headings.length, 2);
    eq("the first of them the title", ide.document.doc.Headings[0].Text, "El proyecto");
    check("and a real height to it", ide.document.doc.ContentHeight > 60,
          ide.document.doc.ContentHeight);

    /* Underneath it is a code tab like any other: the editor holds the text,
     * which is what makes the save, the reload and the session work here with
     * nothing added to them. */
    check("the editor is there, holding the file", ide.Editor.Text === text);
    eq("in the markdown highlighting", ide.Editor.Language, "markdown");
    eq("but not on screen", ide.Editor.Visible, false);

    /* --- the toggle ---------------------------------------------------------- */
    ide.document.toggle.Click();
    yield;

    check("the toggle shows the source", ide.document.editing());
    eq("which is the editor", ide.Editor.Visible, true);
    eq("and the page steps aside", ide.document.doc.Visible, false);

    ide.Editor.Text = "# Otro titulo\n\nY otra cosa.\n";
    ide.document.toggle.Click();
    yield;

    check("going back renders what was typed", !ide.document.editing());
    eq("and not what was on disk",
       ide.document.doc.Headings[0].Text, "Otro titulo");
    eq("only one heading now", ide.document.doc.Headings.length, 1);

    /* It is dirty the way any edited tab is, and saving it is the same verb. */
    check("an edited document is a dirty tab", ide.tabs.liveDirty(ide.tabs.activeState()));
    ide.BtnSave_Click();
    yield;
    check("saved to the file", File.Load(File.Join(TMP, readme)).includes("Otro titulo"));

    /* --- what a link does ---------------------------------------------------- */
    ide.Editor.Text = text;
    ide.document.toggle.Click();       /* to the source... */
    ide.document.toggle.Click();       /* ...and back, which re-renders */
    yield;

    const opened = ide.Doc_Link("Child.form", "el formulario");
    yield;

    check("a link to a file of the project opens it", opened);
    eq("as a tab", ide.activeFile, "Child.form");

    ide.tabs.switchTo(readme);
    yield;

    check("a web address is nobody's here", ide.Doc_Link("https://example.org", "x"));
    eq("and opens no tab", ide.activeFile, readme);
    check("a link to a file that is not there says so",
          ide.Doc_Link("no-such-file.md", "x"));
    eq("and opens nothing either", ide.activeFile, readme);

    /* --- and the README a project opens on ----------------------------------- */
    ide.BtnSave_Click();
    openFresh(ide, TMP);
    yield;

    eq("a project nobody has been in here opens on its README",
       ide.activeFile, readme);
    eq("and on nothing else", ide.Tabs.Count, 1);
    check("rendered", !!ide.document && !ide.document.editing());

    /* A project that was in the middle of something reopens *that*, and the
     * README does not push in front of it. Left with one file open and opened
     * again: `openProject` writes the strip down on the way out and restores it
     * on the way in, which is the whole of what a session is. */
    ide.closeTabByName(readme, true);
    ide.openInTab("Child.js");
    yield;

    ide.openProject(TMP);
    yield;

    check("a session that gave something back is not interrupted",
          ide.tabs.openTabs.has("Child.js"), JSON.stringify(ide.tabs.tabOrder));
    check("and the README does not push in front of it",
          !ide.tabs.openTabs.has(readme), JSON.stringify(ide.tabs.tabOrder));

    /* Back to a clean desk for the phases after this one. */
    for (const name of [...ide.tabs.tabOrder]) ide.closeTabByName(name, true);
    File.Delete(File.Join(TMP, readme));
    ide.listFiles();
    yield;
}

/*
 * F1 and the reference window.
 *
 * The pages are `docs/reference/`, drawn by `lib/markdown` in a window of their
 * own. What is asserted here is the two halves that are the IDE's: **which page
 * F1 is about**, and that the window really lands on it.
 */
function* p_help(ide) {
    const root = HelpForm.root();

    check("the reference is found beside this build", !!root, root);
    if (!root) return;

    check("a class has a page", HelpForm.pageFor("TableView").endsWith("widgets/TableView.md"));
    check("a global has one too", HelpForm.pageFor("File").endsWith("globals/File.md"));
    check("and so does a library's component",
          HelpForm.pageFor("Chart").endsWith("libraries/Chart.md"));
    eq("a name that is nothing has none", HelpForm.pageFor("Nonesuch"), "");

    /* --- which page F1 is about ------------------------------------------- */
    ide.openInTab("Child.js");
    yield;

    ide.Editor.Text = "const t = File.Load(path);\n";
    ide.Editor.Select(1, 12);          /* inside `File.Load` */
    yield;

    const topic = ide.helpTopic();
    check("the word under the cursor decides the page",
          !!topic && topic.page.endsWith("globals/File.md"), JSON.stringify(topic));
    eq("and the member after the dot", topic.member, "Load");

    /* A form tab with a control selected asks about the control's class. */
    ide.openInTab("Child.form");
    yield;
    ide.designer.addControl("Label");
    yield;

    const about = ide.helpTopic();
    check("a selected control asks about its own class",
          !!about && about.page.endsWith("widgets/Label.md"),
          JSON.stringify(about) + " for " +
          (ide.designer.selected ? ide.designer.tree.typeOf(ide.designer.selected) : "nothing"));

    /* --- the window -------------------------------------------------------- */
    const help = HelpForm.open(HelpForm.pageFor("TableView"), "Sortable");
    yield* settled(ide);

    check("the window shows the page", help.Doc.Path.endsWith("widgets/TableView.md"));
    check("with the document really laid out", help.Doc.ContentHeight > 1000,
          help.Doc.ContentHeight);
    eq("and it landed on the member", help.Doc.Selection, "Sortable");
    check("which is not at the top of the page", help.Doc.Scroll > 0, help.Doc.Scroll);

    check("every page is in the tree", help.Pages.Count > 70, help.Pages.Count);
    check("under a category each", help.Pages.Exists("cat:widgets") &&
          help.Pages.Exists("cat:globals") && help.Pages.Exists("cat:libraries"));

    /* A link between two pages is how the reference is browsed. */
    const was = help.Doc.Path;
    help.Doc_Link("ListBox.md", "ListBox");
    yield;

    check("a link opens the page it names", help.Doc.Path.endsWith("widgets/ListBox.md"));
    check("and Back is offered", help.BtnBack.Enabled);

    help.BtnBack_Click();
    yield;
    eq("which goes back where it was", help.Doc.Path, was);

    /* The find box, which is the same verb F1 lands with. */
    help.TxtFind.Text = "Sortable";
    help.TxtFind_Activate();
    yield;
    check("the find box finds", help.Doc.Selection.includes("Sortable"),
          JSON.stringify(help.Doc.Selection));
    eq("and F3 takes the next one", help.Form_KeyPress("F3"), true);

    help.Close();
    yield;
    check("the window closes and keeps its page", help.Doc.Path.length > 0);
}

function* p_forms(ide) {
    /* --- prompt dialog ---------------------------------------------------
     * AskForm is an ordinary Bintana form, not a runtime primitive. */
    let answered = null;
    const dlg = AskForm.prompt("titulo", "etiqueta:", "inicial",
                               (v) => { answered = v; });

    eq("the prompt shows its title", dlg.Text, "titulo");
    eq("and its label", dlg.LblPrompt.Text, "etiqueta:");
    eq("and starts on the suggested value", dlg.TxtValue.Text, "inicial");
    eq("a prompt is modal", dlg.Modal, true);

    dlg.TxtValue.Text = "   ";
    dlg.BtnOk_Click();
    eq("blank input is not an answer", answered, null);

    dlg.TxtValue.Text = "  Respuesta  ";
    dlg.BtnOk_Click();
    eq("the answer comes back trimmed", answered, "Respuesta");

    answered = null;
    const dlg2 = AskForm.prompt("t", "l", "x", (v) => { answered = v; });
    check("the prompt declares what Escape presses",
          dlg2.CancelButton === dlg2.BtnCancel);
    dlg2.CancelButton.Click();
    eq("cancelling answers nothing", answered, null);
    /* And the other half of the pair, on the same dialog: Enter in the field
     * presses OK rather than raising Activate, which is why AskForm no longer
     * has a TxtValue_Activate. */
    check("and what Enter presses", dlg2.BtnOk.Default);
    check("with the field handing Enter over", dlg2.TxtValue.ActivatesDefault);

    /* The optional checkbox: one dialog carries both the name and the question
     * about it, so Cancel still means "not at all". */
    eq("without an option there is no checkbox", dlg2.ChkOption.Visible, false);

    let chose = null;
    const dlg3 = AskForm.prompt("t", "l", "x", (v, on) => { chose = [v, on]; },
                                { text: "una opcion", checked: true });
    eq("the option is shown", dlg3.ChkOption.Visible, true);
    eq("with its own text", dlg3.ChkOption.Text, "una opcion");
    eq("and the state it was given", dlg3.ChkOption.Active, true);

    /* Room was made for it: the buttons moved down and the window grew with
     * them, or the checkbox would sit on top of them. */
    check("the buttons moved below it",
          dlg3.BtnOk.Y > dlg3.ChkOption.Y + dlg3.ChkOption.Height,
          `chk ${dlg3.ChkOption.Y}+${dlg3.ChkOption.Height}, ok ${dlg3.BtnOk.Y}`);
    check("and the dialog is tall enough for them",
          dlg3.Height >= dlg3.BtnOk.Y + dlg3.BtnOk.Height,
          `height ${dlg3.Height}, ok at ${dlg3.BtnOk.Y}`);

    dlg3.ChkOption.Active = false;
    dlg3.BtnOk_Click();
    eq("the answer carries the name", chose[0], "x");
    eq("and what was chosen with it", chose[1], false);

    /* --- creating a form --------------------------------------------------
     *
     * **With nothing open, a new form goes to `forms/`.** The root is where
     * everything used to land, and it is how a root becomes unmanageable: a
     * project of twenty forms is forty files in one directory with
     * `project.json` somewhere among them. The folder is named after the
     * category the project view groups by, so the directory ends up shaped like
     * the view -- and a folder is not a namespace by itself, so this moves the
     * file and not the class's name.
     */
    eq("with nothing open a form goes to its own folder",
       ide.suggestFormName(), "forms/Form1");

    eq("creating a form succeeds", ide.createForm("Pantalla"), true);
    yield;
    check("it wrote the .form", File.Exists(File.Join(TMP, "Pantalla.form")));
    check("and the .js", File.Exists(File.Join(TMP, "Pantalla.js")));
    check("the class file declares the class",
          File.Load(File.Join(TMP, "Pantalla.js")).includes("class Pantalla extends Form"));

    /* Without registering it in sources the class never loads at run time. */
    const cfg = JSON.parse(File.Load(File.Join(TMP, "project.json")));
    check("the new source is registered", cfg.sources.includes("Pantalla.js"),
          JSON.stringify(cfg.sources));

    check("the new file is listed", ide.files.includes("Pantalla.form"),
          JSON.stringify(ide.files));
    eq("and opens in the designer", ide.activeFile, "Pantalla.form");
    eq("a new form starts empty", ide.Surface.Children.length, 0);
    eq("with the declared size", ide.Surface.Width, 400);
    eq("nothing is dirty yet", ide.designer.dirty, false);

    /* What was just created has to be editable straight away. */
    palette(ide, "Label").Click();
    yield;                 // a just-created control has no layout until the next frame
    eq("a control can be added right away", ide.Surface.Children.length, 1);
    ide.BtnSave_Click();
    const reread = JSON.parse(File.Load(File.Join(TMP, "Pantalla.form")));
    eq("and saved into the new file", reread.children.length, 1);
    eq("keeping its class", reread.class, "Pantalla");

    eq("a duplicate name is refused", ide.createForm("Pantalla"), false);
    eq("so is a name that is not an identifier", ide.createForm("2cosas"), false);
    eq("and one with a space", ide.createForm("mi form"), false);
    check("nothing was written for the bad names",
          !File.Exists(File.Join(TMP, "mi form.form")));

    /* The suggestion has to skip what already exists, not propose it. */
    eq("creating the suggested name works",
       ide.createForm(ide.suggestFormName()), true);
    eq("the suggestion then skips it", ide.suggestFormName(), "forms/Form2");

    /* --- renaming ----------------------------------------------------------
     * Renaming a form moves both files and rewrites the class: if only the .form
     * moved, the runtime would look for <Class>.form and fail. */
    ide.openNamed("Pantalla.form");
    yield;                 // let GTK allocate the design area
    eq("renaming a form succeeds", ide.renameForm("Pantalla", "Ventana"), true);

    check("the .form moved", File.Exists(File.Join(TMP, "Ventana.form")));
    check("the .js moved too", File.Exists(File.Join(TMP, "Ventana.js")));
    check("and the old pair is gone",
          !File.Exists(File.Join(TMP, "Pantalla.form")) &&
          !File.Exists(File.Join(TMP, "Pantalla.js")));

    const renamed = JSON.parse(File.Load(File.Join(TMP, "Ventana.form")));
    eq("the .form's class field follows", renamed.class, "Ventana");
    check("the class declaration follows",
          File.Load(File.Join(TMP, "Ventana.js")).includes("class Ventana extends Form"));
    check("and no trace of the old name",
          !File.Load(File.Join(TMP, "Ventana.js")).includes("Pantalla"));

    const srcAfter = JSON.parse(File.Load(File.Join(TMP, "project.json"))).sources;
    check("sources points at the new file",
          srcAfter.includes("Ventana.js") && !srcAfter.includes("Pantalla.js"),
          JSON.stringify(srcAfter));

    eq("the renamed form is open", ide.activeFile, "Ventana.form");
    check("and the tree knows it", ide.FileTree.Exists("form:Ventana"));
    check("the old node is gone", !ide.FileTree.Exists("form:Pantalla"));

    eq("renaming onto an existing name is refused",
       ide.renameForm("Ventana", "Child"), false);
    eq("so is a name that is not an identifier",
       ide.renameForm("Ventana", "3d"), false);
    eq("renaming to the same name is a no-op",
       ide.renameForm("Ventana", "Ventana"), true);
    check("and nothing was lost", File.Exists(File.Join(TMP, "Ventana.form")));

    /* Renaming the startup form has to move "startup" as well, or the project
     * stops starting. */
    const startupWas = JSON.parse(File.Load(File.Join(TMP, "project.json"))).startup;
    eq("the startup form is the child", startupWas, "Child");
    ide.openNamed("Child.form");
    yield;                 // let GTK allocate the design area
    eq("renaming the startup form works", ide.renameForm("Child", "Main"), true);
    eq("startup follows the rename",
       JSON.parse(File.Load(File.Join(TMP, "project.json"))).startup, "Main");

    /* --- deleting ----------------------------------------------------------- */
    ide.openNamed("Ventana.form");
    yield;                 // let GTK allocate the design area
    eq("a form counts as its pair", ide.pairOf("Ventana.form").length, 2);
    eq("a lone file counts as itself", ide.pairOf("project.json").length, 1);

    eq("deleting the pair succeeds", ide.deleteFiles(ide.pairOf("Ventana.form")), true);
    check("both files are gone",
          !File.Exists(File.Join(TMP, "Ventana.form")) &&
          !File.Exists(File.Join(TMP, "Ventana.js")));
    check("its source is unregistered",
          !JSON.parse(File.Load(File.Join(TMP, "project.json"))).sources.includes("Ventana.js"));
    check("and it left the tree", !ide.FileTree.Exists("form:Ventana"));
    /* Closing the tab lands on the next one, like a browser.  The previous IDE's
     * convention (back to `file = null`) does not apply with tabs: there is
     * always something else open to fall onto. */
    check("the deleted file's tab is gone",
          !ide.openTabs.has("Ventana.form") && !ide.openTabs.has("Ventana.js"),
          JSON.stringify([...ide.openTabs.keys()]));
    check("and a neighbour took its place",
          ide.activeFile !== null && ide.activeFile !== "Ventana.form" && ide.activeFile !== "Ventana.js",
          ide.activeFile);

    /* --- renaming a control -------------------------------------------------
     * What this tests: that the handlers move with the control.  Button10 exists
     * to verify that a name which merely shares a prefix is left alone. */
    File.Save(File.Join(TMP, "Refactor.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Refactor",
        properties: { Text: "Refactor", Width: 300, Height: 200 },
        children: [
            { type: "Button", name: "Btn1",
              properties: { X: 10, Y: 10, Width: 80, Height: 30, Text: "uno" } },
            { type: "Button", name: "Btn10",
              properties: { X: 10, Y: 50, Width: 80, Height: 30, Text: "diez" } },
        ],
    }, null, 2));

    File.Save(File.Join(TMP, "Refactor.js"),
              'class Refactor extends Form {\n' +
              '    Btn1_Click() {\n' +
              '        this.Btn1.Text = "ok";\n' +
              '        this.Btn10.Text = "otro";\n' +
              '    }\n' +
              '    Btn10_Click() {}\n' +
              '}\n');

    ide.listFiles();
    ide.openNamed("Refactor.form");
    yield;                 // let GTK allocate the design area
    eq("the refactor form is in the designer", ide.designing, true);

    ide.designer.select(byName(ide, "Btn1"));
    eq("Name is editable from the grid", editor(ide, "Name").Text, "Btn1");

    typeInto(ide, "Name", "BtnSave");

    check("the control took the new name", byName(ide, "BtnSave") !== undefined,
          JSON.stringify(ide.Surface.Children.map((c) => c.Name)));

    const refactored = File.Load(File.Join(TMP, "Refactor.js"));
    check("the handler moved with it",
          refactored.includes("BtnSave_Click()"), refactored);
    check("so did the property access",
          refactored.includes("this.BtnSave.Text"), refactored);
    check("and nothing is left under the old name",
          !/\bBtn1\b/.test(refactored), refactored);
    check("a control that merely shares a prefix is untouched",
          refactored.includes("Btn10_Click()") &&
          refactored.includes("this.Btn10.Text"), refactored);

    const committed = JSON.parse(File.Load(File.Join(TMP, "Refactor.form")));
    eq("the .form was committed to disk", committed.children[0].name, "BtnSave");
    eq("so nothing is left unsaved", ide.designer.dirty, false);

    /* The .js already changed on disk: undoing the tree would put the old name
     * back in the .form and leave the code mismatched. */
    eq("and the undo history is dropped", ide.designer.canUndo(), false);

    ide.designer.select(byName(ide, "BtnSave"));
    typeInto(ide, "Name", "Btn10");
    eq("a name already in use is refused", ide.designer.selected.Name, "BtnSave");

    typeInto(ide, "Name", "9vidas");
    eq("a name that is not an identifier is refused",
       ide.designer.selected.Name, "BtnSave");

    typeInto(ide, "Name", "BtnSave");
    eq("renaming to the same name is a no-op",
       ide.designer.selected.Name, "BtnSave");

    /* --- renaming from the control tree --------------------------------------
     *
     * Double clicking a node renames what it stands for.  It is not a second
     * implementation: it goes through renameControl like the grid's Name row,
     * so the handlers in the .js follow from here too.
     */
    ide.WidgetTree.Key = "BtnSave";
    yield;
    ide.WidgetTree_Activate();
    yield;

    const asking = ide.renameControlAsk;
    check("double clicking a node asks for a name", asking !== undefined);
    eq("starting from the one it has", asking.TxtValue.Text, "BtnSave");

    asking.TxtValue.Text = "BtnStore";
    asking.BtnOk.Click();
    yield;

    check("the control took the new name", byName(ide, "BtnStore") !== undefined,
          JSON.stringify(ide.Surface.Children.map((c) => c.Name)));
    eq("and the tree relabelled it", ide.WidgetTree.Text, "BtnStore (Button)");

    const fromTree = File.Load(File.Join(TMP, "Refactor.js"));
    check("with the handlers carried along, as from the grid",
          fromTree.includes("BtnStore_Click()") && !/\bBtnSave\b/.test(fromTree),
          fromTree);

    /* The form is not a control and is not renamed from here. */
    ide.WidgetTree.Key = "@form";
    yield;
    const lastPrompt = ide.renameControlAsk;
    ide.WidgetTree_Activate();
    check("the root offers no rename", ide.renameControlAsk === lastPrompt);
    ide.designer.select(byName(ide, "BtnStore"));
    typeInto(ide, "Name", "BtnSave");

    /* A new control has no handlers, and renaming it must not invent changes in
     * the code. */
    const untouched = File.Load(File.Join(TMP, "Refactor.js"));
    palette(ide, "Label").Click();
    yield;                 // a just-created control has no layout until the next frame
    typeInto(ide, "Name", "Titulo");
    eq("a fresh control renames fine", ide.designer.selected.Name, "Titulo");
    eq("without touching the code",
       File.Load(File.Join(TMP, "Refactor.js")), untouched);

    /* --- double click writes the handler ------------------------------------
     * The central gesture of a RAD: double click a control and you are writing
     * what it does. */
    ide.openNamed("Refactor.form");
    yield* settled(ide);   // GTK has to have laid it out
    eq("back in the designer", ide.designing, true);

    const target = byName(ide, "Btn10");
    ide.Glass_DblClick(target.X + 4, target.Y + 4);

    eq("it left the designer for the code", ide.designing, false);
    eq("in the form's own .js", ide.activeFile, "Refactor.js");
    /* And back in the editor the Notebook expands again: now its page is the
     * editor, and the editor is what has to fill the area. */
    eq("the tab strip expands again for the editor", ide.Tabs.VExpand, true);

    const withHandler = File.Load(File.Join(TMP, "Refactor.js"));
    eq("an existing handler is not duplicated",
       withHandler.split("Btn10_Click").length - 1, 1);
    check("and the cursor landed on it",
          ide.Editor.Text.split("\n")[ide.Editor.Line - 1].includes("Btn10_Click"),
          `linea ${ide.Editor.Line}`);

    /* A control with no handler: it has to be written. */
    ide.openNamed("Refactor.form");
    yield;                 // let GTK allocate the design area
    palette(ide, "Button").Click();
    yield* settled(ide);   // GTK has to have laid it out

    const fresh     = ide.designer.selected;
    const freshName = fresh.Name;
    ide.BtnSave_Click();

    /* Where it is drawn, not where it was asked to be: a click placed on the
     * request lands on whatever is really there, and the handler then gets
     * written for that control instead. */
    const freshAt = ide.designer.rectOf(fresh);
    ide.Glass_DblClick(freshAt.x + 4, freshAt.y + 4);

    const written = File.Load(File.Join(TMP, "Refactor.js"));
    check("a missing handler is created",
          written.includes(`${freshName}_Click() {`), written);
    check("inside the class, not after it",
          written.indexOf(`${freshName}_Click`) < written.lastIndexOf("}"), written);
    eq("the file still holds exactly one class",
       written.split("class Refactor").length - 1, 1);
    check("and is still valid JavaScript", parses(written), written);

    /* The cursor lands in the empty body, ready to type. */
    const lines = ide.Editor.Text.split("\n");
    eq("the cursor is inside the new body", lines[ide.Editor.Line - 1].trim(), "");
    check("right under its signature",
          lines[ide.Editor.Line - 2].includes(`${freshName}_Click`),
          `linea ${ide.Editor.Line}: ${JSON.stringify(lines.slice(ide.Editor.Line - 3, ide.Editor.Line + 1))}`);

    /* A file the IDE cannot repair is left alone: the handler is inserted into
     * text, and writing a broken .js would cost more than the handler is worth. */
    File.Save(File.Join(TMP, "Roto.form"), JSON.stringify({
        format: "bintana-form/1", class: "Roto",
        properties: { Text: "roto", Width: 200, Height: 120 },
        children: [{ type: "Button", name: "B",
                     properties: { X: 10, Y: 10, Width: 80, Height: 30, Text: "b" } }],
    }, null, 2));
    File.Save(File.Join(TMP, "Roto.js"), "class Roto extends Form {\n  (((\n}\n");

    ide.listFiles();
    ide.openNamed("Roto.form");
    yield;                 // let GTK allocate the design area

    const brokenBefore = File.Load(File.Join(TMP, "Roto.js"));
    eq("a broken file refuses the handler", ide.openHandler("B", "Click"), false);
    eq("and is left exactly as it was",
       File.Load(File.Join(TMP, "Roto.js")), brokenBefore);

    /* Double clicking the background opens the form's own event. */
    ide.openNamed("Refactor.form");
    yield* settled(ide);   // GTK has to have laid it out
    ide.Glass_DblClick(280, 180);
    const withOpen = File.Load(File.Join(TMP, "Refactor.js"));
    check("empty space opens the form's own event",
          withOpen.includes("Form_Open() {"), withOpen);
    check("and the file survives a second insertion", parses(withOpen), withOpen);

    /*
     * --- Form -> Write handler ----------------------------------------------
     *
     * The other consumer of `EventNames()`, and the one the deleted table was
     * costing. A double click writes the *default*; this offers every event the
     * control raises, marks the ones already written, and jumps to those rather
     * than writing them twice.
     */
    ide.openNamed("Refactor.form");
    yield* settled(ide);

    /* `select(null)` and not "whatever the last section left": the menu speaks
     * about the selection, so the assertion has to say what the selection is. */
    ide.designer.select(null);
    yield* settled(ide);
    check("with nothing selected there is nothing to write",
          !ide.MnuHandler.Enabled);
    eq("and it says so rather than opening onto nothing",
       ide.MnuHandler.Items.length, 1);

    const btn = byName(ide, "BtnSave");
    ide.designer.select(btn);
    yield* settled(ide);

    check("selecting a control offers its handlers", ide.MnuHandler.Enabled);
    eq("and the first offered is the one a double click writes",
       ide.handlerEvents[0], ide.designer.defaultEvent(btn));
    eq("which for a button is Click", ide.handlerEvents[0], "Click");
    check("with the ones it inherits offered too, after its own",
          ide.handlerEvents.includes("GotFocus") &&
          ide.handlerEvents.indexOf("Click") < ide.handlerEvents.indexOf("GotFocus"),
          JSON.stringify(ide.handlerEvents));

    /* One already in the .js is marked, so choosing it reads as going there
     * rather than as writing it again. */
    const marked = (ev) => ide.MnuHandler.Items[ide.handlerEvents.indexOf(ev)];
    check("an unwritten handler is offered plainly",
          marked("GotFocus").trim() === "GotFocus", marked("GotFocus"));

    /* Choose one that is not the default -- the whole point of the menu. */
    const beforeFocus = File.Load(File.Join(TMP, "Refactor.js"));
    check("GotFocus is not written yet",
          !beforeFocus.includes("BtnSave_GotFocus"));

    ide.MnuHandler_Click(ide.handlerEvents.indexOf("GotFocus"));
    const withFocus = File.Load(File.Join(TMP, "Refactor.js"));
    check("choosing an event writes that handler and no other",
          withFocus.includes("BtnSave_GotFocus() {"), withFocus);
    check("and the file is still valid JavaScript", parses(withFocus), withFocus);

    /* And now it is marked, and choosing it again goes there instead of writing
     * a second copy -- which is what `openHandler` already did, said in advance. */
    ide.openNamed("Refactor.form");
    yield* settled(ide);
    ide.designer.select(byName(ide, "BtnSave"));
    yield* settled(ide);

    check("a written handler is marked", marked("GotFocus").trim() !== "GotFocus",
          marked("GotFocus"));
    ide.MnuHandler_Click(ide.handlerEvents.indexOf("GotFocus"));
    eq("and choosing it again writes no second copy",
       File.Load(File.Join(TMP, "Refactor.js")).split("BtnSave_GotFocus").length - 1, 1);

    /* A form with unsaved changes is saved before the .js is touched, or the two
     * files would end up describing different things. */
    ide.openNamed("Refactor.form");
    yield* settled(ide);   // GTK has to have laid it out

    const toMove = byName(ide, "BtnSave");
    const fromX  = toMove.X;
    ide.Glass_MouseDown(toMove.X + 4, toMove.Y + 4);
    ide.Glass_MouseMove(toMove.X + 24, toMove.Y + 4, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp();
    eq("the drag moved it", byName(ide, "BtnSave").X, fromX + 20);
    eq("so the form is dirty", ide.designer.dirty, true);

    const other = byName(ide, "Btn10");
    ide.Glass_DblClick(other.X + 4, other.Y + 4);
    eq("the form was saved on the way out", ide.designing, false);

    const committed2 = JSON.parse(File.Load(File.Join(TMP, "Refactor.form")));
    const movedNode  = committed2.children.find((c) => c.name === "BtnSave");
    eq("and committed before jumping to the code",
       movedNode.properties.X, fromX + 20);

    /* --- components ---------------------------------------------------------
     * A component is a form that is not a window: the project's own control.
     * The IDE cannot instantiate one -- the class belongs to the project, not to
     * the IDE's process -- so what the designer places is a stand-in that saves
     * back as the component it stands for.
     */
    eq("the suggested component name has its own stem, and its own folder",
       ide.suggestFormName("Part"), "components/Part1");

    eq("creating a component succeeds", ide.createForm("Marcador", "Component"), true);
    yield;
    check("it wrote the .form", File.Exists(File.Join(TMP, "Marcador.form")));
    check("and the class extends Component",
          File.Load(File.Join(TMP, "Marcador.js")).includes("class Marcador extends Component"),
          File.Load(File.Join(TMP, "Marcador.js")));
    check("its source is registered like any other",
          JSON.parse(File.Load(File.Join(TMP, "project.json"))).sources.includes("Marcador.js"));

    const compForm = JSON.parse(File.Load(File.Join(TMP, "Marcador.form")));
    check("a component has no title: it is not a window",
          !("Text" in compForm.properties), JSON.stringify(compForm.properties));
    eq("but it does have a size", compForm.properties.Width, 200);

    const found = ide.componentsInProject();
    eq("the scan finds exactly one component", found.length, 1);
    eq("by name", found[0].name, "Marcador");
    eq("with the size its own .form declares", found[0].Height, 60);
    check("and a plain form is not one",
          !found.some((c) => c.name === "Refactor"), JSON.stringify(found));

    check("the tree groups it apart from the forms",
          ide.FileTree.Exists("cat:components") && ide.FileTree.Exists("form:Marcador"));

    /* The palette is what makes it usable: a component nobody can place is a
     * class the IDE happens to know about. */
    const palComp = palette(ide, "Marcador");
    check("the palette offers it", palComp !== undefined,
          JSON.stringify(Dictionary.Keys(ide.palette.buttons)));
    eq("and dragging it carries its type", palComp.DragData, "Marcador");
    check("the runtime's controls are still there", palette(ide, "Button") !== undefined);

    /* Designing the component itself: it is a form like any other, minus the
     * one thing it does not have. */
    ide.openNamed("Marcador.form");
    yield;                 // let GTK allocate the design area
    ide.designer.select(null);
    yield;
    check("a component's own form offers no Text",
          !ide.designer.grid.propKeys.includes("Text"),
          JSON.stringify(ide.designer.grid.propKeys));
    check("but does offer its size",
          ide.designer.grid.propKeys.includes("Width"),
          JSON.stringify(ide.designer.grid.propKeys));
    /* And the board says so: no title to show, and no window to show it on. */
    eq("nor is it drawn with a title bar", ide.designer.titlebar.Visible, false);

    ide.openNamed("Refactor.form");
    yield;                 // let GTK allocate the design area
    ide.designer.select(null);
    yield;
    check("while a form still has one", ide.designer.grid.propKeys.includes("Text"),
          JSON.stringify(ide.designer.grid.propKeys));

    const wasThere = ide.Surface.Children.length;

    palComp.Click();
    yield* settled(ide);   // GTK has to have laid it out

    eq("clicking it adds a control", ide.Surface.Children.length, wasThere + 1);
    const placed = ide.designer.selected;
    eq("named after the component", placed.Name, "Marcador1");
    eq("standing in for it", placed.__node.type, "Marcador");
    eq("at the size the component asked for", placed.Width, 200);
    eq("and its height", placed.Height, 60);

    ide.BtnSave_Click();
    const withComp = JSON.parse(File.Load(File.Join(TMP, "Refactor.form")));
    const compNode = withComp.children.find((c) => c.name === "Marcador1");
    check("the .form got the component and not a Label",
          compNode !== undefined && compNode.type === "Marcador",
          JSON.stringify(withComp.children.map((c) => c.type)));
    eq("with the geometry it was given", compNode.properties.Width, 200);

    /* Reopening is where a stand-in earns its keep: the designer still cannot
     * build a Marcador, and saving again must not turn it into something else. */
    ide.openNamed("Refactor.form");
    yield;                 // let GTK allocate the design area
    const reopened = byName(ide, "Marcador1");
    check("the component survived a reload", reopened !== undefined,
          JSON.stringify(ide.Surface.Children.map((c) => c.Name)));
    eq("still as itself", reopened.__node.type, "Marcador");

    ide.designer.select(reopened);
    typeInto(ide, "Name", "Marcador9");
    ide.BtnSave_Click();

    const renamedComp = JSON.parse(File.Load(File.Join(TMP, "Refactor.form")))
                            .children.find((c) => c.type === "Marcador");
    eq("renaming a stand-in reaches the file", renamedComp.name, "Marcador9");

    /*
     * **A component nested inside another control**, which is where a stand-in
     * used to cost the whole ancestor. `AddNode` builds a node *and its
     * children* in one call, so the throw for a class the IDE cannot
     * instantiate arrived while the panel around it was being built -- and the
     * panel became the stand-in, taking its siblings with it. Opening a form
     * whose component sat two levels down was a board with one grey `[Panel]`
     * on it, which is what the `qr` example's `QrView` did.
     */
    File.Save(File.Join(TMP, "Nested.js"), "class Nested extends Form {\n}\n");
    File.SaveJson(File.Join(TMP, "Nested.form"), {
        format: "bintana-form/1", class: "Nested",
        properties: { Text: "Nested", Width: 400, Height: 300 },
        children: [
            { type: "Panel", name: "Box",
              properties: { Arrangement: "Vertical", Spacing: 6 },
              children: [
                  { type: "Button", name: "BtnInside",
                    properties: { Text: "Inside" } },
                  { type: "Marcador", name: "CompInside" },
              ] },
        ],
    });
    ide.listFiles();
    ide.openNamed("Nested.form");
    yield* settled(ide);

    const box = byName(ide, "Box");
    check("a panel holding a component is still drawn as itself",
          box !== undefined && box.constructor.name === "Panel",
          ide.designer.allControls().map((c) => `${c.Name}:${c.constructor.name}`).join(" "));
    check("its own controls survive", byName(ide, "BtnInside") !== undefined,
          box ? box.Children.map((c) => c.Name).join(",") : "no panel");
    const inside = byName(ide, "CompInside");
    check("and the component is the stand-in",
          inside !== undefined && !!inside.__node && inside.__node.type === "Marcador",
          inside ? inside.constructor.name : "missing");

    ide.BtnSave_Click();
    const nestedFile = JSON.parse(File.Load(File.Join(TMP, "Nested.form")));
    const nestedBox  = (nestedFile.children || []).find((c) => c.name === "Box");
    check("a save keeps both of them under the panel",
          nestedBox !== undefined &&
          (nestedBox.children || []).some((c) => c.type === "Button") &&
          (nestedBox.children || []).some((c) => c.type === "Marcador"),
          JSON.stringify(nestedFile));

    /* And with no project open there is nothing of the project to offer. */
    ide.designer.setComponents([]);
    check("closing the project empties the component tab",
          palette(ide, "Marcador") === undefined);
    check("without taking the rest of the palette with it",
          palette(ide, "Button") !== undefined);
    ide.listFiles();
    check("and the scan puts it back", palette(ide, "Marcador") !== undefined);

}

function* p_nested(ide) {
    /* --- tabs: multiple files open -------------------------------------- */
    /* The tests above renamed and deleted files of the project.  A fresh one is
     * built so the tab tests do not depend on the state they left behind. */
    File.Save(File.Join(TMP, "project.json"),
              JSON.stringify({ name: "tabs", startup: "Tabs", sources: ["Tabs.js"] }));
    File.Save(File.Join(TMP, "Tabs.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Tabs",
        properties: { Text: "Tabs", Width: 300, Height: 200 },
        children: [
            { type: "Button", name: "Ok",
              properties: { X: 20, Y: 30, Width: 80, Height: 30, Text: "ok" } },
        ],
    }, null, 2));
    File.Save(File.Join(TMP, "Tabs.js"),
              'class Tabs extends Form {\n' +
              '    Form_Open() {\n' +
              '        print("hello from tabs");\n' +
              '        Application.Quit(0);\n' +
              '    }\n' +
              '    Ok_Click() {}\n' +
              '}\n');

    openFresh(ide, TMP);
    ide.openNamed("Tabs.js");
    eq("opening a file is a one-tab strip", ide.Tabs.Count, 1);
    eq("and the file is the active one", ide.activeFile, "Tabs.js");

    /* Open several files and check they show up in the strip. */
    ide.FileTree.Key = "project.json";
    eq("the second file becomes a new tab", ide.Tabs.Count, 2);
    eq("and is the active one", ide.activeFile, "project.json");

    ide.openNamed("Tabs.form");
    yield;                 // let GTK allocate the design area
    eq("the .form joins the strip", ide.Tabs.Count, 3);
    eq("and the designer takes over", ide.designing, true);

    /* Switching tabs preserves the editor's cursor. */
    ide.FileTree.Key = "Tabs.js";
    const savedLine = ide.Editor.Line;
    ide.Editor.GotoLine(3);
    neq("the cursor moved in Tabs.js", ide.Editor.Line, savedLine);

    ide.FileTree.Key = "project.json";
    ide.FileTree.Key = "Tabs.js";
    eq("the cursor is back where it was in Tabs.js",
       ide.Editor.Line, 3);

    /* An edit in one tab does not contaminate another. */
    ide.Editor.Text += "// solo en Tabs.js\n";
    eq("Tabs.js is dirty", ide.openTabs.get("Tabs.js").dirty, true);
    eq("project.json is still clean",
       ide.openTabs.get("project.json").dirty, false);

    ide.FileTree.Key = "project.json";
    check("switching files does not lose the dirty flag",
          !ide.Editor.Text.includes("// solo en Tabs.js"),
          ide.Editor.Text.slice(-40));

    ide.FileTree.Key = "Tabs.js";
    check("switching back restores the edit",
          ide.Editor.Text.includes("// solo en Tabs.js"),
          ide.Editor.Text.slice(-40));

    /* The active tab's label carries the file.  Tabs.js was left dirty by the
     * edit above, so the label carries the asterisk. */
    const activeLabel = ide.openTabs.get("Tabs.js").label.Text;
    ide.FileTree.Key = "project.json";
    const otherLabel  = ide.openTabs.get("project.json").label.Text;
    check("the active tab label carries the file name",
          activeLabel.startsWith("Tabs.js"),
          activeLabel);
    neq("and the other tab has a different name",
        activeLabel, otherLabel);

    /* Closing tabs: the order and which one becomes active both matter. */
    ide.FileTree.Key = "Tabs.form";          // tab 2
    yield;                 // showing the designer needs a frame before it can be clicked
    ide.closeTabByName("project.json", true);
    eq("closing a tab removes it from the strip", ide.Tabs.Count, 2);
    check("and the file is gone from the map",
          !ide.openTabs.has("project.json"), [...ide.openTabs.keys()]);
    check("but the close of an inactive tab keeps the active one",
          ide.activeFile === "Tabs.form", ide.activeFile);

    /* saveAllDirty saves what is dirty without touching what is clean. */
    ide.FileTree.Key = "Tabs.js";            // tab 1
    ide.Editor.Text += "// dirty for saveAll\n";
    eq("Tabs.js is dirty", ide.isDirty(), true);
    ide.saveAllDirty();
    check("saveAllDirty committed Tabs.js",
          File.Load(File.Join(TMP, "Tabs.js")).includes("// dirty for saveAll"),
          File.Load(File.Join(TMP, "Tabs.js")).slice(-60));
    eq("and cleared the in-memory flag",
       ide.openTabs.get("Tabs.js").dirty, false);

    /* Dirty in an inactive tab: saveAllDirty rescues it by activating it. */
    ide.FileTree.Key = "Tabs.form";          // tab 2
    yield* settled(ide);   // GTK has to have laid it out
    const okXBefore = byName(ide, "Ok").X;
    /* A real drag marks it dirty; calling Move() directly does not. */
    ide.Glass_MouseDown(byName(ide, "Ok").X + 4, byName(ide, "Ok").Y + 4);
    ide.Glass_MouseMove(byName(ide, "Ok").X + 24, byName(ide, "Ok").Y + 4, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp();
    eq("the drag made the form dirty", ide.designer.dirty, true);

    /* Back to Tabs.js: Tabs.form is left as a dirty inactive tab. */
    ide.FileTree.Key = "Tabs.js";
    eq("Tabs.form is still dirty in the tab map",
       ide.openTabs.get("Tabs.form").dirty, true);
    /* The drag's move lives on the surface, but saveAllDirty has to switch to
     * the .form, serialise it and come back. */
    ide.saveAllDirty();
    const formAfter = JSON.parse(File.Load(File.Join(TMP, "Tabs.form")));
    const movedOk = formAfter.children.find((c) => c.name === "Ok");
    neq("an inactive dirty .form is committed too",
        movedOk.properties.X, okXBefore);

    /*
     * What a per-tab editor is *for*.  There used to be one `SourceEditor` moved
     * between the pages, so switching assigned `Editor.Text` and GtkSourceView
     * threw the undo history away with it: the text came back and the history
     * did not.  A tab owning its own editor keeps the history, the caret and the
     * selection without anyone saving or restoring them, and costs the ~240 KB
     * that measuring said it costs.
     */
    const beforeUndoTabs = ide.activeFile;
    File.Save(File.Join(TMP, "Undo1.js"), "class Undo1 {\n}\n");
    File.Save(File.Join(TMP, "Undo2.js"), "class Undo2 {\n}\n");
    ide.listFiles();
    ide.openNamed("Undo1.js");
    ide.openNamed("Undo2.js");
    const codeTabs = ["Undo1.js", "Undo2.js"];
    {
        ide.switchToTab(codeTabs[0]);
        const mine = ide.Editor;
        mine.Insert("/* undo me */");
        mine.GotoLine(2);
        eq("typing marks the tab dirty", mine.Modified, true);

        ide.switchToTab(codeTabs[1]);
        check("each tab has an editor of its own", ide.Editor !== mine,
              `${ide.Editor === mine}`);

        ide.switchToTab(codeTabs[0]);
        eq("coming back is the same widget, not a reloaded one", ide.Editor, mine);
        eq("so the undo history survived the switch", ide.Editor.CanUndo, true);
        eq("and the caret is where it was left", ide.Editor.Line, 2);

        ide.Editor.Undo();
        check("and undo really undoes what was typed",
              !ide.Editor.Text.includes("/* undo me */"), ide.Editor.Text.slice(0, 40));

        /* Leave the strip as it was found: what follows counts tabs. */
        for (const n of codeTabs) ide.closeTabByName(n, true);
        if (beforeUndoTabs) ide.switchToTab(beforeUndoTabs);
    }

    /*
     * And the same for a form: a designer per open form, each with its own
     * canvas, its own selection and its own undo stack.  Switching used to
     * rebuild the surface from the tab's node tree and reset both stacks, so
     * leaving a form and coming back cost every step of history it had.
     */
    const beforeTwoForms = ide.activeFile;
    File.Save(File.Join(TMP, "Two.js"), "class Two extends Form {\n}\n");
    File.Save(File.Join(TMP, "Two.form"), JSON.stringify({
        format: "bintana-form/1", class: "Two",
        properties: { Text: "Two", Width: 320, Height: 200 },
        children: [{ type: "Button", name: "Solo",
                     properties: { X: 20, Y: 30, Width: 100, Height: 30, Text: "solo" } }],
    }, null, 2));
    ide.listFiles();
    ide.openNamed("Tabs.form");
    const designerOne = ide.designer;
    designerOne.select(byName(ide, "Ok"));
    designerOne.restack(true);                    /* an edit, and an undo step */
    const stepsOne = designerOne.undoStack.length;
    check("editing a form leaves it something to undo", stepsOne > 0, `${stepsOne}`);

    ide.openNamed("Two.form");
    yield* settled(ide);
    check("the second form has a designer of its own",
          ide.designer !== designerOne, `${ide.designer === designerOne}`);
    check("with a canvas of its own",
          ide.Surface !== designerOne.surface, `${ide.Surface === designerOne.surface}`);
    eq("and nothing to undo, because nobody touched it",
       ide.designer.undoStack.length, 0);
    eq("nor is it dirty from being looked at", ide.designer.dirty, false);

    ide.openNamed("Tabs.form");
    yield* settled(ide);
    check("coming back is the same designer", ide.designer === designerOne,
          `${ide.designer === designerOne}`);
    eq("so its undo history survived the switch",
       ide.designer.undoStack.length, stepsOne);

    ide.closeTabByName("Two.form", true);
    if (beforeTwoForms) ide.switchToTab(beforeTwoForms);

    /* Cycling tabs with Ctrl+Tab / Ctrl+Shift+Tab. */
    const order = [...ide.tabOrder];
    ide.Editor_KeyPress("Tab", true, false);
    eq("Ctrl+Tab advances to the next tab", ide.activeFile, order[1]);
    ide.Editor_KeyPress("Tab", true, true);
    eq("Ctrl+Shift+Tab goes back", ide.activeFile, order[0]);

    /* Walking through them all closes the last tab and leaves the IDE with no
     * file.  A page belongs to the file that opened it, so the strip empties
     * with them: a nameless page left behind is a tab that opens nothing. */
    for (let i = ide.Tabs.Count - 1; i >= 0; i--) {
        ide.closeTabByName(ide.tabOrder[i], true);
    }
    eq("the strip empties with the last file", ide.Tabs.Count, 0);
    eq("and the editor is blank", ide.activeFile, null);
    check("and there is none left: it went with the page that owned it",
          ide.Editor === null && ide.WorkArea.Children.every((c) => !c.Visible),
          `${ide.Editor} / ` +
          ide.WorkArea.Children.map((c) => `${c.Name}=${c.Visible}`).join(" "));

    /* openInTab vuelve a armar todo. */
    ide.openNamed("Tabs.form");
    yield;                 // let GTK allocate the design area
    eq("opening after a close works", ide.Tabs.Count, 1);
    eq("and the form is loaded", ide.Surface.Children.length, 1);

    /* --- a value the runtime refuses, on a container -------------------------
     *
     * `AddNode` parents a control *before* it applies its properties, so a Style
     * that is not a class name throws with the subtree already half built.  The
     * designer stands in for what it could not build, and a stand-in carries the
     * whole node -- so anything the failed attempt left in the container is
     * written to the file a second time.  The IDE's own MainForm went through a
     * save and came back with six controls duplicated.
     */
    File.Save(File.Join(TMP, "MalEstilo.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "MalEstilo",
        properties: { Text: "MalEstilo", Width: 360, Height: 260 },
        children: [
            { type: "Panel", name: "Caja",
              properties: { X: 10, Y: 10, Width: 300, Height: 200, Style: ".danger" },
              children: [
                  { type: "Button", name: "Dentro",
                    properties: { X: 10, Y: 10, Width: 100, Height: 30, Text: "dentro" } },
              ] },
        ],
    }, null, 2));
    File.Save(File.Join(TMP, "MalEstilo.js"), "class MalEstilo extends Form {\n}\n");

    ide.listFiles();
    ide.openNamed("MalEstilo.form");
    yield* settled(ide);

    eq("what could not be built leaves one control behind, not two",
       ide.Surface.Children.length, 1);
    check("and that one stands in for the node",
          ide.Surface.Children[0].__node !== undefined,
          ide.Surface.Children[0].constructor.name);

    ide.designer.save();
    const savedRefused = JSON.parse(File.Load(File.Join(TMP, "MalEstilo.form")));
    eq("so the save writes the subtree once", savedRefused.children.length, 1);
    eq("carrying the value that was refused",
       savedRefused.children[0].properties.Style, ".danger");
    eq("and the children under it",
       (savedRefused.children[0].children || []).length, 1);

    /* --- designer: nested containers ----------------------------------------
     * A Frame on purpose: it shifts its content by the border and the label, by
     * whatever the theme decides.  That is why the designer asks the layout where
     * things ended up instead of adding X up. */
    File.Save(File.Join(TMP, "Anidado.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Anidado",
        properties: { Text: "Anidado", Width: 360, Height: 260 },
        children: [
            { type: "Frame", name: "Group",
              properties: { X: 20, Y: 20, Width: 300, Height: 200, Text: "grupo" },
              children: [
                  { type: "Button", name: "Inner",
                    properties: { X: 20, Y: 20, Width: 100, Height: 30, Text: "inside" } },
              ] },
        ],
    }, null, 2));
    File.Save(File.Join(TMP, "Anidado.js"), "class Anidado extends Form {\n}\n");

    ide.listFiles();
    ide.openNamed("Anidado.form");
    yield* settled(ide);   // GTK has to have laid it out

    const grupo = byName(ide, "Group");
    eq("the container was built", grupo.Children.length, 1);

    const inside = grupo.Children[0];
    eq("with its child inside it", inside.Name, "Inner");
    eq("whose X stays relative to its container", inside.X, 20);

    /* The real position comes from the layout.  If it matched the naive sum this
     * test would prove nothing, so it asserts that they differ. */
    const at = inside.OriginIn(ide.Surface);
    check("the frame pushes its content down", at[1] > grupo.Y + inside.Y,
          `origen ${JSON.stringify(at)} vs suma ${grupo.Y + inside.Y}`);
    check("but only by a border and a label", at[1] - (grupo.Y + inside.Y) < 60,
          `${at[1] - (grupo.Y + inside.Y)}px`);
    check("and indents it", at[0] >= grupo.X + inside.X, JSON.stringify(at));

    /* --- selecting through the container ------------------------------- */
    ide.Glass_MouseDown(at[0] + 5, at[1] + 5);
    ide.Glass_MouseUp();
    eq("clicking a nested control selects the control", ide.designer.selected.Name,
       "Inner");

    const bar = ide.designer.chrome.outline[0];
    eq("the outline is drawn where the control really is", bar.X, at[0]);
    eq("in both axes", bar.Y, at[1]);
    neq("which is not the parent-relative sum", bar.Y, grupo.Y + inside.Y);

    const groupAt = grupo.OriginIn(ide.Surface);
    ide.Glass_MouseDown(groupAt[0] + grupo.Width - 6, groupAt[1] + grupo.Height - 6);
    ide.Glass_MouseUp();
    eq("clicking the container's own area selects the container",
       ide.designer.selected.Name, "Group");

    /* --- dragging a nested control ---------------------------------------
     * Before adding anything else: a new control lands at (16,16) of the group
     * and would cover this one. */
    const startX = inside.X;

    ide.Glass_MouseDown(at[0] + 5, at[1] + 5);
    ide.Glass_MouseMove(at[0] + 25, at[1] + 5, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp();
    eq("dragging moves it within its own container", inside.X, startX + 20);
    eq("and it stays inside", grupo.Children.length, 1);
    eq("the surface did not gain it", ide.Surface.Children.length, 1);

    /* --- adding into the selection -------------------------------------- */
    ide.designer.select(grupo);
    palette(ide, "Label").Click();
    yield;
    eq("a new control lands inside the selected container", grupo.Children.length, 2);
    eq("and comes out selected", ide.designer.selected.Name, "Label1");

    ide.designer.select(null);
    palette(ide, "Label").Click();
    yield;
    eq("with nothing selected it lands on the surface", ide.Surface.Children.length, 2);
    /* The name has to be unique across the whole form: handlers are Name_Event on
     * the form, whatever the depth. */
    eq("naming skips a name a nested control already took",
       ide.designer.selected.Name, "Label2");

    /* --- reparenting by dragging -------------------------------------------
     * Dropping on another container moves the control.  What matters is that it
     * does not teleport: X/Y are relative to the container, so they have to be
     * recomputed against the target. */
    const loose = byName(ide, "Label2");
    loose.Move(20, 228);                 /* below the Frame, unambiguously */
    yield;                               /* mover pide un cuadro */

    const before = loose.OriginIn(ide.Surface);
    ide.Glass_MouseDown(before[0] + 5, before[1] + 5);
    eq("the drag starts on the loose control", ide.designer.selected.Name, "Label2");

    /* Drop well inside the Frame, somewhere with no controls. */
    const dropX = 250, dropY = 190;
    ide.Glass_MouseMove(dropX, dropY);
    ide.Glass_MouseUp(dropX, dropY);
    yield* settled(ide);

    eq("the control left the surface", ide.Surface.Children.length, 1);
    eq("and joined the container", grupo.Children.length, 3);

    const adopted = grupo.Children.find((c) => c.Name === "Label2");
    check("it kept its identity", adopted !== undefined);
    check("with coordinates now local to its new parent",
          adopted.X > 0 && adopted.Y > 0, `${adopted.X},${adopted.Y}`);

    /* The proof it did not teleport: where it was dropped is where it stayed.
     * It has just changed parent, so its drawn origin means nothing until the
     * new container has laid it out. */
    yield* settled(ide);
    const landed = adopted.OriginIn(ide.Surface);
    check("and it stayed visually where it was dropped",
          Math.abs(landed[0] - (dropX - 5)) <= 4 &&
          Math.abs(landed[1] - (dropY - 5)) <= 4,
          `solto en ${dropX - 5},${dropY - 5} y quedo en ${JSON.stringify(landed)}`);

    /* The tree is rebuilt when the *shape* of the form changes -- which a
     * reparenting is and a property edit is not -- so the control is still on
     * it, a level deeper, and still selects from it.  This is the case the tree
     * earns its keep on: a control inside a container can be awkward to hit on
     * the canvas and is one click away here. */
    check("the control tree kept up with the reparenting",
          ide.WidgetTree.Count === ide.designer.allControls().length + 1,
          `${ide.WidgetTree.Count} nodes for ${ide.designer.allControls().length} controls`);
    check("and a control nested a level down is on it", ide.WidgetTree.Exists("Label2"));

    ide.designer.select(null);
    yield;
    ide.WidgetTree.Key = "Label2";
    yield;
    eq("selecting a nested control from the tree reaches it",
       ide.designer.selected.Name, "Label2");

    ide.designer.select(adopted);
    yield* settled(ide);

    /* Dragging within the same container does not move it out. */
    const stay = adopted.OriginIn(ide.Surface);
    ide.Glass_MouseDown(stay[0] + 5, stay[1] + 5);
    ide.Glass_MouseMove(stay[0] + 25, stay[1] + 5, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp(stay[0] + 25, stay[1] + 5);
    yield* settled(ide);   // GTK has to have laid it out
    eq("moving inside the same container does not reparent",
       grupo.Children.length, 3);
    eq("and the surface is unchanged", ide.Surface.Children.length, 1);

    /* And back out: dropping on the surface takes it out of the container. */
    const backOut = adopted.OriginIn(ide.Surface);
    ide.Glass_MouseDown(backOut[0] + 5, backOut[1] + 5);
    ide.Glass_MouseMove(120, 245, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp(120, 245);
    yield* settled(ide);   // GTK has to have laid it out
    eq("dropping on the surface takes it back out", grupo.Children.length, 2);
    eq("and the surface has it again", ide.Surface.Children.length, 2);
    check("still the same control", byName(ide, "Label2") !== undefined);

    /* A container cannot land inside itself. */
    const groupCorner = grupo.OriginIn(ide.Surface);
    ide.Glass_MouseDown(groupCorner[0] + grupo.Width - 6, groupCorner[1] + grupo.Height - 6);
    eq("the container is the one being dragged", ide.designer.selected.Name, "Group");
    ide.Glass_MouseMove(groupCorner[0] + grupo.Width - 6 + 8, groupCorner[1] + grupo.Height - 6);
    ide.Glass_MouseUp(groupCorner[0] + grupo.Width - 6 + 8, groupCorner[1] + grupo.Height - 6);
    yield* settled(ide);   // GTK has to have laid it out
    eq("a container cannot be dropped into itself", ide.Surface.Children.length, 2);
    check("and keeps its own children", grupo.Children.length === 2,
          `${grupo.Children.length}`);

    /* --- multiple selection ------------------------------------------------
     * At this point the surface holds Group and Label2, and Group holds Caption
     * and Inner. */
    const one = byName(ide, "Label2");
    ide.designer.select(one);
    eq("one control selected", ide.designer.selection.length, 1);

    const groupBox = grupo.OriginIn(ide.Surface);
    ide.Glass_MouseDown(groupBox[0] + grupo.Width - 6, groupBox[1] + grupo.Height - 6,
                        1, /* ctrl */ true);
    ide.Glass_MouseUp(groupBox[0] + grupo.Width - 6, groupBox[1] + grupo.Height - 6,
                      1, true);
    eq("ctrl+click adds to the selection", ide.designer.selection.length, 2);
    eq("and the last one clicked is the primary", ide.designer.selected.Name, "Group");

    /* Ctrl+click again takes it out. */
    ide.Glass_MouseDown(groupBox[0] + grupo.Width - 6, groupBox[1] + grupo.Height - 6,
                        1, true);
    ide.Glass_MouseUp(groupBox[0] + grupo.Width - 6, groupBox[1] + grupo.Height - 6,
                      1, true);
    eq("ctrl+click again removes it", ide.designer.selection.length, 1);
    eq("leaving the other one", ide.designer.selected.Name, "Label2");

    /* Handles only with one: resizing several has no single meaning. */
    check("one control gets resize handles", ide.designer.chrome.handles.se.Visible);
    ide.designer.setSelection([one, grupo]);
    eq("two are selected", ide.designer.selection.length, 2);
    eq("the handles go away with more than one",
       ide.designer.chrome.handles.se.Visible, false);
    check("but each one is outlined", ide.designer.chrome.extraOutlines[0][0].Visible);

    /* Selecting a container discards its children: moving them as well as the
     * parent would shift them twice. */
    const insideGroup = grupo.Children.find((c) => c.Name === "Inner");
    ide.designer.setSelection([grupo, insideGroup]);
    eq("a descendant is dropped when its container is selected",
       ide.designer.selection.length, 1);
    eq("keeping the container", ide.designer.selected.Name, "Group");

    /* --- moving several at once ------------------------------------------- */
    ide.designer.setSelection([one, byName(ide, "Group")]);
    yield* settled(ide);   // GTK has to have laid it out
    const looseBefore = { x: one.X, y: one.Y };
    const groupBefore = { x: grupo.X, y: grupo.Y };

    const grab = one.OriginIn(ide.Surface);
    ide.Glass_MouseDown(grab[0] + 5, grab[1] + 5, 1, false);
    ide.Glass_MouseMove(grab[0] + 25, grab[1] + 13, 1, false, /* shift: no snapping */ true);
    ide.Glass_MouseUp(grab[0] + 25, grab[1] + 13, 1, false);
    yield;

    eq("clicking one of several keeps the whole set",
       ide.designer.selection.length, 2);
    eq("the dragged one moved", one.X, looseBefore.x + 20);
    eq("and so did the other, by the same delta", grupo.X, groupBefore.x + 20);
    eq("in both axes", grupo.Y, groupBefore.y + 8);

    /* A set is not split across containers on drop. */
    eq("dragging a set does not reparent", ide.Surface.Children.length, 2);

    ide.MnuUndo_Click();
    eq("undo puts the whole move back", byName(ide, "Group").X, groupBefore.x);
    eq("all of it", byName(ide, "Label2").X, looseBefore.x);

    /* --- aligning ----------------------------------------------------------- */
    const anchor = byName(ide, "Group");
    const mover  = byName(ide, "Label2");
    mover.Move(200, 240);
    ide.designer.setSelection([mover, anchor]);   /* the anchor is the primary */
    eq("the anchor is the last one selected", ide.designer.selected.Name, "Group");

    yield* settled(ide);   // align and distribute read drawn geometry
    ide.MnuAlignLeft_Click();
    yield* settled(ide);

    /*
     * On the edges one can see, which is not the same as the same X.  A Frame
     * draws its border inside its box and a Label does not, so lining the two up
     * on screen takes requests that differ by exactly that inset -- and this
     * used to assert the requests were equal, which only held while the layout
     * had not been measured yet and every inset came back zero.
     */
    eq("align left puts their drawn edges on one line",
       ide.designer.rectOf(mover).x, ide.designer.rectOf(anchor).x);
    neq("which took different requests to achieve", mover.X, anchor.X);

    /*
     * And aligned on the edges one can see.  A Button's face sits inside its box
     * by whatever margin the theme gives it, a Label's does not, so aligning the
     * declared X would leave the two visibly out of line -- 17 px apart on this
     * desktop.  What has to match is what is drawn.
     */
    const alignBtn = new Button();
    const alignLbl = new Label();
    ide.Surface.Add(alignBtn);
    ide.Surface.Add(alignLbl);
    alignBtn.Name = "AlignBtn"; alignBtn.Text = "button";
    alignLbl.Name = "AlignLbl"; alignLbl.Text = "label";
    alignBtn.Move(40, 250); alignBtn.Resize(120, 34);
    alignLbl.Move(90, 290); alignLbl.Resize(120, 24);

    /* The inset is read from what was drawn against what was asked for, so
     * neither control can be measured until GTK has allocated it. */
    yield* until(() => ide.designer.rectOf(alignBtn).w > 0 &&
                       ide.designer.rectOf(alignLbl).w > 0);

    ide.designer.setSelection([alignLbl, alignBtn]);   /* the button is the anchor */
    yield* settled(ide);   // align and distribute read drawn geometry
    ide.MnuAlignLeft_Click();
    yield* until(() => ide.designer.rectOf(alignLbl).x ===
                       ide.designer.rectOf(alignBtn).x);

    const drawnBtn = ide.designer.rectOf(alignBtn);
    const drawnLbl = ide.designer.rectOf(alignLbl);
    eq("aligning matches the edges that are drawn", drawnLbl.x, drawnBtn.x);

    /* Same width means the same *drawn* width, which needs different requests
     * when the insets differ. */
    yield* settled(ide);   // align and distribute read drawn geometry
    ide.MnuSameWidth_Click();
    yield* settled(ide);   // GTK has to have laid it out
    eq("and same width matches what is drawn",
       ide.designer.rectOf(alignLbl).w, ide.designer.rectOf(alignBtn).w);

    /*
     * A control that does not fit says so.  Width is a request, so a label with
     * more text than room comes out wider and takes its window with it -- which
     * used to be invisible until something looked wrong on screen.
     */
    /* Through the grid, which is how a user does it: an edit is what tells the
     * designer to look again. */
    ide.designer.select(alignLbl);
    yield;
    typeInto(ide, "Text", "a line with far more text in it than the hundred and " +
                          "twenty pixels this label says it wants");
    yield* until(() => !!ide.designer.overflow(alignLbl));

    const over = ide.designer.overflow(alignLbl);
    check("a control that came out bigger is flagged", !!over,
          `${alignLbl.Width} asked, ${ide.designer.rectOf(alignLbl).w} drawn`);
    check("the status bar says how big it really is",
          ide.designer.overflowNote(alignLbl).includes("does not fit"),
          ide.designer.overflowNote(alignLbl));
    neq("and the outline stops being the selection colour",
        ide.designer.chrome.outline[0].Background, "");

    /*
     * **The colour of an overflowing control, once it really is that colour.**
     *
     * This used to be read straight off the chrome, one line after an assertion
     * that only said it was *not empty* -- so when the re-lay had not landed yet
     * it captured the selection colour instead, and the comparison below then
     * asked whether the selection colour differed from itself. That run went red
     * on a change that had nothing to do with the designer; it went red three
     * times in one afternoon and passed on every retry, which is what a flake
     * looks like from the outside and what an unsettled read looks like from in
     * here.
     */
    const selected = ide.designer.chrome.outline[0].Background;
    yield* until(() => ide.designer.chrome.outline[0].Background !== selected ||
                       !ide.designer.overflow(alignLbl));
    const fitting = ide.designer.chrome.outline[0].Background;
    ide.designer.select(alignBtn);
    yield* until(() => ide.designer.chrome.outline[0].Background !== fitting);
    check("a control that fits is not flagged", !ide.designer.overflow(alignBtn));
    neq("and its outline is the other colour", ide.designer.chrome.outline[0].Background, fitting);
    eq("with nothing to say about it", ide.designer.overflowNote(alignBtn), "");

    alignBtn.Delete();
    alignLbl.Delete();

    /* Back to the pair the assertions below are about: this section selected
     * two controls of its own and deleted them. */
    ide.designer.setSelection([mover, anchor]);
    eq("and leaves the anchor alone", anchor.X, groupBefore.x);

    yield* settled(ide);   // align and distribute read drawn geometry
    ide.MnuSameWidth_Click();
    yield* settled(ide);   // GTK has to have laid it out
    /* The same *drawn* width, which is not the same request when the two draw
     * their faces differently: a Frame's border is two pixels of it. */
    eq("same width matches what the anchor draws",
       ide.designer.rectOf(mover).w, ide.designer.rectOf(anchor).w);

    ide.MnuUndo_Click();
    neq("aligning is undoable", byName(ide, "Label2").Width, anchor.Width);

    check("aligning needs two", ide.MnuAlignLeft.Enabled);
    ide.designer.select(anchor);
    eq("with one selected there is nothing to align to",
       ide.MnuAlignLeft.Enabled, false);

    /* --- the form's own bounds --------------------------------------------------
     * The surface stretches with the window, so the drawn border is the only
     * thing that says where the form really ends. */
    ide.designer.select(null);
    yield* settled(ide);   // GTK has to have laid it out

    eq("the declared size comes from the form node",
       JSON.stringify(ide.designer.formSize()), JSON.stringify({ w: 360, h: 260 }));
    check("the boundary is drawn", ide.designer.chrome.bounds[0].Visible);
    eq("along the declared width", ide.designer.chrome.bounds[0].Width, 360);
    /*
     * What is outside the form is not drawn: it is the scroller's own
     * background, and the board covers itself with the theme's window colour.
     * It was two panels sized from the glass until the `Scroller` made the glass
     * the size of the *form* -- and `glass.Width - form.Width` is zero, so the
     * shading became a strip of nothing that only showed as a sliver when the
     * glass happened to come out a few pixels bigger.
     */
    check("what is outside the form is the scroller's own background",
          ide.CanvasScroll.Background !== "", ide.CanvasScroll.Background);
    eq("and the board paints itself, or that background would show through it",
       ide.Surface.Style, "background");
    check("so the board is exactly the form and the room around it is the view's",
          ide.Canvas.Bounds().Width === 360 &&
          ide.CanvasScroll.Bounds().Width > ide.Canvas.Bounds().Width,
          `board=${JSON.stringify(ide.Canvas.Bounds())} ` +
          `view=${JSON.stringify(ide.CanvasScroll.Bounds())}`);

    /* With nothing selected the grid switches to editing the form. */
    check("the grid switches to the form itself",
          ide.designer.grid.propKeys.includes("Width") &&
          ide.designer.grid.propKeys.includes("Text"),
          JSON.stringify(ide.designer.grid.propKeys));

    eq("showing its declared width", editor(ide, "Width").Value, 360);

    editor(ide, "Width").Value = 300;
    yield* settled(ide);   // GTK has to have laid it out
    eq("editing it changes the form", ide.designer.formSize().w, 300);
    eq("and the boundary follows", ide.designer.chrome.bounds[0].Width, 300);
    /* And so does what is around it, without anything being laid out: the board
     * shrank, so more of the scroller's background is what is left.  Not exactly
     * 300 -- the form's grips straddle its border, so the glass carrying them is
     * a few pixels wider than the form on purpose. */
    check("the board shrinks with it, and the room around it grows",
          ide.Canvas.Bounds().Width < 360 &&
          ide.Canvas.Bounds().Width < ide.CanvasScroll.Bounds().Width,
          `board=${ide.Canvas.Bounds().Width} view=${ide.CanvasScroll.Bounds().Width}`);

    /* A size of zero would leave the form with no surface: it is rejected, and
     * the grid goes back to showing what is really there. */
    editor(ide, "Width").Value = 0;
    eq("zero is refused", ide.designer.formSize().w, 300);
    eq("and the editor goes back to the real value", editor(ide, "Width").Value, 300);

    ide.MnuUndo_Click();
    yield* settled(ide);   // GTK has to have laid it out
    eq("resizing the form is undoable", ide.designer.formSize().w, 360);

    ide.BtnSave_Click();
    eq("and the size is what gets written",
       JSON.parse(File.Load(File.Join(TMP, "Anidado.form"))).properties.Width, 360);

    /* --- distributing --------------------------------------------------------- */
    /* Three controls squeezed to the left and one far away: distributing has to
     * leave the outer two where they are and share out the gap. */
    const spread = [];
    for (const [name, x] of [["S1", 10], ["S2", 20], ["S3", 300]]) {
        const b = new Button();
        b.Name = name;
        ide.Surface.Add(b);
        b.Move(x, 210);
        b.Resize(40, 20);
        spread.push(b);
    }
    yield;

    ide.designer.setSelection(spread);
    eq("three selected", ide.designer.selection.length, 3);
    check("distributing is offered with three", ide.MnuSpreadH.Enabled);

    yield* settled(ide);   // align and distribute read drawn geometry
    ide.MnuSpreadH_Click();
    eq("the left end stays put", byName(ide, "S1").X, 10);
    eq("and so does the right one", byName(ide, "S3").X, 300);

    /* With ends at 10 and 340 and three 40 wide, the gaps come to 105. */
    const gapA = byName(ide, "S2").X - (byName(ide, "S1").X + 40);
    const gapB = byName(ide, "S3").X - (byName(ide, "S2").X + 40);
    check("the gaps come out equal", Math.abs(gapA - gapB) <= 1,
          `${gapA} contra ${gapB}`);

    ide.MnuUndo_Click();
    eq("distributing is undoable", byName(ide, "S2").X, 20);

    ide.designer.setSelection([byName(ide, "S1"), byName(ide, "S2")]);
    eq("with only two there is no gap to share", ide.MnuSpreadH.Enabled, false);

    /* --- alignment guides ------------------------------------------------------
     * Dragging near another control's edge snaps and shows the guide. */
    const anchorCtl = byName(ide, "S1");
    const mobile    = byName(ide, "S3");
    ide.designer.select(mobile);
    yield* settled(ide);   // GTK has to have laid it out

    const from = mobile.OriginIn(ide.Surface);
    const anchorAt = anchorCtl.OriginIn(ide.Surface);

    /* Drop it three pixels right of S1's left edge: inside the snap radius, so it
     * has to end up exactly aligned. */
    ide.Glass_MouseDown(from[0] + 5, from[1] + 5, 1, false);
    ide.Glass_MouseMove(from[0] + 5 - (from[0] - anchorAt[0]) + 3, from[1] + 5);
    check("the vertical guide shows while dragging", ide.designer.chrome.guides.v.Visible);
    ide.Glass_MouseUp(from[0] + 5 - (from[0] - anchorAt[0]) + 3, from[1] + 5, 1, false);
    yield* settled(ide);   // GTK has to have laid it out

    /* The nearest edge wins, and there are several controls on the surface, so
     * what is asserted is not which one it snapped to but that it ended up aligned
     * with one: that is what the guide does. */
    const moved3 = ide.designer.rectOf(byName(ide, "S3"));
    const edgesOf = (r) => [r.x, r.x + r.w / 2, r.x + r.w];
    const aligned = ide.designer.allControls()
        .filter((c) => c.Name !== "S3")
        .map((c) => ide.designer.rectOf(c))
        .filter(Boolean)
        .some((r) => edgesOf(r).some((their) =>
            edgesOf(moved3).some((mine) => Math.abs(their - mine) < 1)));

    check("it landed exactly on some other control's line", aligned,
          `S3 en ${JSON.stringify(moved3)}`);
    eq("and the guide goes away when the drag ends",
       ide.designer.chrome.guides.v.Visible, false);

    /* With Shift the snap is suspended, so one can nudge by a single pixel. */
    const free = byName(ide, "S3");
    ide.designer.select(free);
    const at2 = free.OriginIn(ide.Surface);
    ide.Glass_MouseDown(at2[0] + 5, at2[1] + 5, 1, false);
    ide.Glass_MouseMove(at2[0] + 5 + 3, at2[1] + 5, 1, false, true);
    eq("no guide while Shift is held", ide.designer.chrome.guides.v.Visible, false);
    ide.Glass_MouseUp(at2[0] + 5 + 3, at2[1] + 5, 1, false, true);
    yield* settled(ide);   // GTK has to have laid it out
    neq("and it did not get pulled back into alignment",
        byName(ide, "S3").X, anchorCtl.X);

    for (const name of ["S1", "S2", "S3"]) {
        const c = byName(ide, name);
        if (c) c.Delete();
    }
    ide.designer.select(null);

    /* --- the rubber band ----------------------------------------------------- */
    ide.designer.select(null);
    /* A rectangle over the whole surface grabs everything at the top level, but
     * not the children of a container already selected. */
    ide.Glass_MouseDown(2, 2, 1, false);
    ide.Glass_MouseMove(340, 250);
    ide.Glass_MouseUp(340, 250, 1, false);
    yield* settled(ide);   // GTK has to have laid it out
    check("the band selects what it covers", ide.designer.selection.length >= 2,
          `${ide.designer.selection.length}`);

    /* Four bars per selected control and not one more: the rectangle is drawn
     * with the same spare bars, so one left switched on after the release would be
     * a visible leftover on the form. */
    const litBars = ide.designer.chrome.outline.filter((b) => b.Visible).length +
        ide.designer.chrome.extraOutlines.reduce(
            (n, bars) => n + bars.filter((b) => b.Visible).length, 0);
    eq("and leaves no leftover band on screen",
       litBars, 4 * ide.designer.selection.length);

    /* Counting bars is not enough: a bar reused from the rectangle could stay on
     * with its old geometry.  Every visible bar has to fall on the border of some
     * selected control. */
    const rects = ide.designer.selection.map((c) => ide.designer.rectOf(c));
    const allBars = [...ide.designer.chrome.outline,
                     ...ide.designer.chrome.extraOutlines.flat()].filter((b) => b.Visible);
    const stray = allBars.filter((b) => !rects.some(
        (r) => b.X >= r.x - 1 && b.X <= r.x + r.w + 1 &&
               b.Y >= r.y - 1 && b.Y <= r.y + r.h + 1));
    /* The chrome is placed in Glass with coordinates measured against Surface.
     * If the two layers do not share an origin, it is drawn offset. */
    eq("the glass and the surface share an origin",
       JSON.stringify(ide.Glass.OriginIn(ide.Surface)), "[0,0]");

    /* And a bar placed at (50,60) has to end up drawn there. */
    const probe = ide.designer.chrome.outline[0];
    probe.Move(50, 60);
    probe.Resize(10, 10);
    probe.Visible = true;
    yield* settled(ide);   // GTK has to have laid it out
    eq("a chrome bar lands where it was put",
       JSON.stringify(probe.OriginIn(ide.Surface)), "[50,60]");

    check("every outline bar sits on a selected control", stray.length === 0,
          `sueltas ${JSON.stringify(stray.map((b) => [b.X, b.Y, b.Width, b.Height]))} ` +
          `contra rects ${JSON.stringify(rects)}`);
    check("without doubling up on a container's children",
          !ide.designer.selection.some((c) => c.Name === "Inner"),
          JSON.stringify(ide.designer.selection.map((c) => c.Name)));

    /* A bare click on the background is not a rectangle: it deselects. */
    ide.Glass_MouseDown(340, 252, 1, false);
    ide.Glass_MouseUp(340, 252, 1, false);
    eq("a plain click on the background clears the selection",
       ide.designer.selection.length, 0);

    /* --- deleting several ----------------------------------------------------- */
    const beforeMulti = ide.Surface.Children.length;
    ide.designer.setSelection([byName(ide, "Label2")]);
    ide.ActDelCtl_Click();
    eq("deleting removes the selected control",
       ide.Surface.Children.length, beforeMulti - 1);
    ide.MnuUndo_Click();
    eq("and undo brings it back", ide.Surface.Children.length, beforeMulti);

    ide.designer.select(null);

    ide.BtnSave_Click();
    const savedNest = JSON.parse(File.Load(File.Join(TMP, "Anidado.form")));
    eq("the saved tree keeps its nesting", savedNest.children[0].children.length, 2);
    eq("with the nested move persisted, still parent-relative",
       savedNest.children[0].children.find((c) => c.name === "Inner").properties.X,
       startX + 20);

}

function* p_projects(ide) {
    /* --- creating a project ------------------------------------------------ */
    const NEWPROJ = "/tmp/bta-test-ide-nuevo";
    removeTree(NEWPROJ);
    Directory.Make(NEWPROJ);

    eq("creating a project succeeds", ide.createProject(NEWPROJ), true);
    yield;
    check("it has a project.json", File.Exists(File.Join(NEWPROJ, "project.json")));
    /* In `forms/` from the start: the shape a project would be tidied into
      * later anyway, and starting there is what keeps it from being a special
      * case that only later files follow. */
    check("and a startup form, in its own folder",
          File.Exists(File.Join(NEWPROJ, "forms", "Form1.form")));
    check("with its code beside it",
          File.Exists(File.Join(NEWPROJ, "forms", "Form1.js")));

    const newCfg = JSON.parse(File.Load(File.Join(NEWPROJ, "project.json")));
    eq("the startup class matches the form", newCfg.startup, "Form1");
    eq("the class is still the bare name, since a folder is not a namespace",
       newCfg.startup, "Form1");
    check("whose source is registered by its path",
          newCfg.sources.includes("forms/Form1.js"), JSON.stringify(newCfg.sources));

    eq("the IDE switched to it", ide.project, NEWPROJ);
    eq("and opened its form", ide.activeFile, "forms/Form1.form");
    eq("refusing to overwrite a project", ide.createProject(NEWPROJ), false);

    /* The folder does not have to exist: the dialog lets one type a new name, and
     * the IDE creates it. */
    const FRESH = "/tmp/bta-test-ide-fresco";
    removeTree(FRESH);      /* a run that failed here would leave one behind */
    check("the target does not exist yet", !File.Exists(FRESH));
    eq("creating a project makes the folder",
       ide.startProject(FRESH, "", false, "io.github.getbintana.Fresh"), true);
    check("the folder is there now", File.IsDir(FRESH));
    check("with a project inside", File.Exists(File.Join(FRESH, "project.json")));
    eq("and the application id it was created with",
       File.LoadJson(File.Join(FRESH, "project.json")).id,
       "io.github.getbintana.Fresh");

    /*
     * --- a project with no window -------------------------------------------
     *
     * The other kind: `main` instead of a startup form, one source, and **no
     * app.css** -- a stylesheet for a program with nothing on screen is a file
     * that can only ever be wrong. What is checked is that the runtime would
     * open what the IDE just wrote, which is the whole promise of creating it
     * through the record.
     */
    const CONSOLE = "/tmp/bta-test-ide-consola";
    removeTree(CONSOLE);
    eq("creating a console project succeeds",
       ide.startProject(CONSOLE, "", true), true);

    const consoleCfg = File.LoadJson(File.Join(CONSOLE, "project.json"));
    eq("it declares the function the runtime calls", consoleCfg.main, "Main");
    check("and no startup form to open", !consoleCfg.startup,
          JSON.stringify(consoleCfg.startup));
    check("its source is registered", consoleCfg.sources.includes("Main.js"),
          JSON.stringify(consoleCfg.sources));
    check("the file is there, at the root and not in forms/",
          File.Exists(File.Join(CONSOLE, "Main.js")));
    check("with no form beside it", !File.IsDir(File.Join(CONSOLE, "forms")));
    check("and no stylesheet it has no use for",
          !File.Exists(File.Join(CONSOLE, "app.css")));

    eq("the IDE switched to it", ide.project, CONSOLE);
    eq("and opened the one file there is", ide.activeFile, "Main.js");
    check("the manifest has nothing to report",
          Ide.ProjectFile.Load(consoleCfg).Problems.length === 0,
          JSON.stringify(Ide.ProjectFile.Load(consoleCfg).Problems));

    /* And it runs: what the IDE wrote is a project this runtime opens, prints
     * from and quits. Run as a child, because a console project of our own is
     * the one thing this suite can start without a display. */
    const said = [];
    let ran = null;
    Exec([Application.Executable, CONSOLE], (line) => said.push(line),
                                            (code) => { ran = code; });
    yield* until(() => ran !== null, 200);
    eq("what the IDE created runs", ran, 0);
    check("and prints what its Main says",
          said.some((l) => l.includes("Hello from")), JSON.stringify(said));

    /* But if a file already holds that name, it is not overwritten. */
    const CLASH = "/tmp/bta-test-ide-archivo";
    File.Save(CLASH, "not a folder at all");
    eq("an existing file is not turned into a project",
       ide.startProject(CLASH), false);
    eq("and it is left alone", File.Load(CLASH), "not a folder at all");
    File.Delete(CLASH);

    /* With no description the key is not written: a project does not carry empty
     * fields around. */
    check("a project without a description has no such key",
          !("description" in
            JSON.parse(File.Load(File.Join(FRESH, "project.json")))));
    removeTree(FRESH);

    /*
     * The rule the dialogs and the runtime share, checked where it lives.
     *
     * **An invalid id cannot be driven through `accept` from here**: the
     * refusal is a `Message.Error`, which is a modal dialog and nothing in a
     * test dismisses one -- the same trap the file dialogs set. What is
     * checked instead is the rule itself, and `tests/widgets` runs a project
     * with a bad id as a child, which is where the runtime's half is asserted.
     */
    check("the application id rule takes a reverse-DNS name",
          Ide.ProjectFile.idValid("io.github.getbintana.App"));
    check("...refuses one with no dot at all", !Ide.ProjectFile.idValid("App"));
    check("...and one whose element starts with a digit",
          !Ide.ProjectFile.idValid("io.github.2App"));
    check("...and one with a character the platform refuses",
          !Ide.ProjectFile.idValid("io.github.my app"));
    check("the manifest lint reports a bad id",
          new Ide.ProjectFile({ Name: "x", Startup: "F", Id: "nope" })
              .Validate().some((p) => p.includes("not an application id")));

    /* --- the new-project dialog ------------------------------------------- */
    let asked = null;
    const np = NewProjectForm.ask("/tmp", (info) => { asked = info; });

    eq("it opens on the base folder it was given", np.TxtBase.Text, "/tmp");
    eq("with a folder icon inside the field", np.TxtBase.Icon, "folder-open");
    eq("and nothing to create yet", np.BtnCreate.Enabled, false);

    np.TxtName.Text = "MiApp";
    /* Showing the path before accepting avoids finding it out afterwards. */
    check("it spells out the path it will create",
          np.LblHint.Text.includes("/tmp/MiApp"), np.LblHint.Text);
    eq("and now there is something to create", np.BtnCreate.Enabled, true);

    /*
     * Enter in the name field walks to the next one, and asks the *tab order*
     * which that is -- it used to name `TxtDesc`, which wrote the order down a
     * second time in the copy nobody updates when the form is redrawn. Driven
     * here because nothing else does: this handler had no test at all.
     */
    np.TxtName.SetFocus();
    yield* until(() => np.TxtName.Focused);
    np.TxtName_Activate();
    yield* until(() => np.TxtId.Focused);
    /* The row after the name is the application id, which the dialog gained so
     * a project declares its identity from the beginning. The handler asks the
     * tab order rather than naming a control, so it followed the form. */
    check("Enter in the name field walks to whatever the tab order has next",
          np.TxtId.Focused && !np.TxtName.Focused,
          `name ${np.TxtName.Focused}, id ${np.TxtId.Focused}`);

    np.TxtId_Activate();
    yield* until(() => np.CmbKind.Focused);
    check("...and from there to the kind", np.CmbKind.Focused,
          `id ${np.TxtId.Focused}, kind ${np.CmbKind.Focused}`);

    /*
     * --- and what it will create says which kind it is ---------------------
     *
     * **Nothing here calls the handler by name, and that is the point.**  These
     * assertions used to, and they were green while the feature was dead: the
     * combo's handler was written `CmbKind_Change` and a `ComboBox` raises
     * `Select`, so the runtime never dispatched it and the hint never followed
     * the kind.  A test that drives a handler itself cannot tell you whether
     * anything else does.  Assigning `Text` moves the selection, which is what
     * raises the event, which is the whole road being asserted.
     */
    eq("a new project is a form project unless asked otherwise",
       np.CmbKind.Text, "a form");
    check("the path it spells out says so",
          np.LblHint.Text.includes("forms/Form1.form"), np.LblHint.Text);

    np.CmbKind.Text = "a function";
    check("choosing a function says what that makes instead",
          np.LblHint.Text.includes("Main.js") && !np.LblHint.Text.includes("Form1"),
          np.LblHint.Text);

    np.CmbKind.Text = "a form";

    /* A name with a separator would escape the base folder. */
    np.TxtName.Text = "con/barra";
    np.BtnCreate_Click();
    eq("a name with a separator is refused", asked, null);

    np.TxtName.Text = "MiApp";
    np.TxtBase.Text = "/no/existe";
    np.BtnCreate_Click();
    eq("so is a base folder that is not there", asked, null);

    np.TxtBase.Text = "/tmp";
    np.TxtDesc.Text = "  a test  ";
    np.TxtId.Text   = "io.github.getbintana.MiApp";
    np.BtnCreate_Click();

    check("accepting answers with what was filled in", asked !== null);
    eq("the name", asked.name, "MiApp");
    eq("the base", asked.base, "/tmp");
    eq("and the description, trimmed", asked.description, "a test");
    eq("and which kind of project it is", asked.console, false);
    eq("and the application id it was given", asked.id,
       "io.github.getbintana.MiApp");

    /* And the kind travels with the rest: the dialog is what asks, and creating
     * is what obeys. */
    asked = null;
    const np2 = NewProjectForm.ask("/tmp", (info) => { asked = info; });
    np2.TxtName.Text = "MiHerramienta";
    np2.CmbKind.Text = "a function";
    np2.BtnCreate_Click();

    check("asking for a console project answers so", asked !== null);
    eq("and says which kind", asked.console, true);

    /* The description goes into project.json, and with no description the key is
     * not written: a project has no reason to carry empty fields. */
    const DESCED = "/tmp/bta-test-ide-desc";
    eq("creating with a description works",
       ide.startProject(DESCED, "a test project"), true);
    eq("and it lands in project.json",
       JSON.parse(File.Load(File.Join(DESCED, "project.json"))).description,
       "a test project");
    removeTree(DESCED);

    removeTree(NEWPROJ);


    /* Back to the project the rest of the test uses. */
    openFresh(ide, TMP);
    ide.openNamed("project.json");

    /* --- elastic containers -------------------------------------------------
     *
     * A form declared Vertical or Horizontal is a box, and a box gives its
     * children no coordinates at all.  The designer used to lay every form out
     * Fixed, so an elastic first arrived piled at the origin -- which is why the
     * IDE could not open its own MainForm, in a project whose whole premise is
     * that it is written in itself.
     */
    File.Save(File.Join(TMP, "Elastic.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Elastic",
        properties: { Text: "Elastic", Width: 400, Height: 300, Arrangement: "Vertical" },
        children: [
            { type: "Panel", name: "Bar", properties: { Arrangement: "Horizontal", Spacing: 4 }, children: [
                { type: "Button", name: "One",   properties: { Width: 80, Height: 30, Text: "first" } },
                { type: "Button", name: "Two",   properties: { Width: 80, Height: 30, Text: "two" } },
                { type: "Button", name: "Three", properties: { Width: 80, Height: 30, Text: "last" } },
            ] },
            { type: "Label", name: "Foot", properties: { Text: "foot" } },
        ],
    }, null, 2));
    File.Save(File.Join(TMP, "Elastic.js"), "class Elastic extends Form {\n}\n");

    ide.listFiles();
    ide.openNamed("Elastic.form");
    yield; yield;

    eq("the surface lays out the way the form declares", ide.Surface.Arrangement, "Vertical");

    const row   = ide.Surface.Children[0];
    const rowOrder = () => row.Children.map((c) => c.Name).join(",");
    eq("its children are where the box put them", rowOrder(), "One,Two,Three");

    /* Stacked, not piled at the origin: each below the first before. */
    yield* until(() => ide.designer.rectOf(row).w > 0);

    const rowAt  = ide.designer.rectOf(row);
    const footAt = ide.designer.rectOf(ide.Surface.Children[1]);
    check("a vertical form stacks its children",
          footAt.y >= rowAt.y + rowAt.h, `${JSON.stringify(rowAt)} ${JSON.stringify(footAt)}`);
    check("and the row spans the width", rowAt.w > 200, `${rowAt.w}`);

    /*
     * A row becomes a column from the grid, children and all.  With one class
     * per axis this was not an edit at all: it was deleting the box, building
     * the other one, and putting everything back.
     */
    ide.designer.select(row);
    yield* settled(ide);

    /*
     * **And in a box the other half of the pair is the inert one.** Where a
     * control sits is the parent's rule: on a fixed surface it keeps the place
     * it was given and the alignment does nothing; inside a box the box places
     * it and X/Y do nothing. The grid turns off whichever half is not in play,
     * with the reason on the row.
     */
    ide.designer.select(row.Children[0]);
    yield* settled(ide);

    check("a control in a box is not placed by coordinates",
          !editor(ide, "X").Enabled && !editor(ide, "Y").Enabled);
    check("and the row says who does place it",
          editor(ide, "X").Tooltip !== "", editor(ide, "X").Tooltip);
    check("while how it asks for room is live, which on a fixed surface it is not",
          editor(ide, "HExpand").Enabled && editor(ide, "HAlign").Enabled);

    ide.designer.select(row);
    yield* settled(ide);

    check("Arrangement is offered as a drop-down",
          editor(ide, "Arrangement") instanceof ComboBox);
    check("with the words it takes",
          JSON.stringify(row.PropertyOptions("Arrangement")) ===
          '["Fixed","Horizontal","Vertical"]',
          JSON.stringify(row.PropertyOptions("Arrangement")));

    const acrossAt = ide.designer.rectOf(row.Children[1]);
    editor(ide, "Arrangement").Text = "Vertical";
    yield* settled(ide);

    eq("turning it round keeps its children", row.Children.length, 3);
    eq("in the order they were in", rowOrder(), "One,Two,Three");
    check("and they are stacked now, not in a row",
          ide.designer.rectOf(row.Children[1]).y > acrossAt.y,
          `${JSON.stringify(acrossAt)} -> ${JSON.stringify(ide.designer.rectOf(row.Children[1]))}`);

    editor(ide, "Arrangement").Text = "Horizontal";
    yield* settled(ide);
    eq("and back", row.Arrangement, "Horizontal");

    /* Dragging in a box reorders: there is nothing else it could mean. */
    const first   = row.Children[0];
    const last = row.Children[2];
    ide.designer.select(first);
    yield* settled(ide);   // GTK has to have laid it out

    const grabAt = ide.designer.rectOf(first), dropAt = ide.designer.rectOf(last);
    ide.Glass_MouseDown(grabAt.x + 4, grabAt.y + 4);
    ide.Glass_MouseMove(dropAt.x + dropAt.w - 2, dropAt.y + 4);
    check("the insertion mark shows where it would land",
          ide.designer.chrome.guides.v.Visible || ide.designer.chrome.guides.h.Visible);
    ide.Glass_MouseUp(dropAt.x + dropAt.w - 2, dropAt.y + 4);
    yield;

    eq("dragging past a sibling reorders it", rowOrder(), "Two,Three,One");
    eq("and dirties the form", ide.designer.dirty, true);

    /* The arrows reach the same thing, since there is no coordinate to nudge. */
    ide.designer.keyPress("Left", false, false);
    yield* settled(ide);   // GTK has to have laid it out
    eq("the arrows reorder too", rowOrder(), "Two,One,Three");

    /* Dropping from the palette picks a place in the row, not a coordinate. */
    ide.Glass_Drop("Label", ide.designer.rectOf(row.Children[0]).x + 2,
                            ide.designer.rectOf(row.Children[0]).y + 4);
    yield;
    eq("a drop into a box inserts where the pointer is",
       row.Children.map((c) => c.Name)[0], ide.designer.selected.Name);
    eq("with no coordinates invented for it", ide.designer.selected.X, 0);

    /* Arrangement from the grid is the one form property the surface has to
     * answer to: it swaps the slot, and a slot refuses to change once it has
     * children -- so the tree comes off and goes back on rather than being
     * left behind.  Here, where rebuilding the surface is the subject. */
    ide.designer.select(null);
    yield;
    const elasticKids = ide.Surface.Children.length;

    check("the form's grid offers Arrangement",
          ide.designer.grid.propKeys.includes("Arrangement"),
          JSON.stringify(ide.designer.grid.propKeys));

    editor(ide, "Arrangement").Text = "Fixed";
    yield* settled(ide);
    eq("changing it relays the surface", ide.Surface.Arrangement, "Fixed");
    eq("without losing a control", ide.Surface.Children.length, elasticKids);

    ide.designer.undo();
    yield* settled(ide);
    eq("and it undoes like any other edit", ide.Surface.Arrangement, "Vertical");
    eq("with the controls still there", ide.Surface.Children.length, elasticKids);

    /* And what is saved has no X/Y for a box's children: the serialiser already
     * knew that, and now the designer agrees with it. */
    ide.BtnSave.Click();
    const elastic = JSON.parse(File.Load(File.Join(TMP, "Elastic.form")));

    eq("the form keeps its arrangement", elastic.properties.Arrangement, "Vertical");
    eq("the new order is what was written",
       elastic.children[0].children.map((c) => c.name).join(","),
       row.Children.map((c) => c.Name).join(","));
    check("and no child of a box carries coordinates",
          elastic.children[0].children.every((c) => !("X" in c.properties)),
          JSON.stringify(elastic.children[0].children.map((c) => c.properties)));

    /* Undo reaches an order the same as it reaches a position. */
    ide.MnuUndo.Click();
    yield;
    eq("undo puts the order back",
       ide.Surface.Children[0].Children.map((c) => c.Name).join(","), "Two,One,Three");

    /* --- notebooks and splits in the designer --------------------------------
     *
     * The two containers a form like the IDE's is built out of, and the two the
     * designer had no idea what to do with: a page is not a coordinate, and a
     * split has exactly two halves and no third place to put anything.
     */
    ide.designer.select(null);
    palette(ide, "Notebook").Click();
    yield;

    const book = ide.designer.selected;
    eq("the palette offers a notebook now", book.constructor.name, "Notebook");
    eq("with no pages yet", book.Count, 0);

    palette(ide, "Panel").Click();
    yield;
    ide.designer.select(book);
    palette(ide, "Frame").Click();
    yield;

    eq("adding to a notebook makes a page", book.Count, 2);
    check("and each page gets a tab that says which it is",
          book.Tabs.length === 2 && book.Tabs.every(Boolean), JSON.stringify(book.Tabs));
    eq("the page just added is the one shown", book.Current, 1);

    const paged = book.Children.map((c) => c.Name).join(",");
    book.Reorder(book.Children[0], 1);
    check("pages can be reordered, tab and all",
          book.Children.map((c) => c.Name).join(",") !== paged &&
          book.Tabs.join(",") === book.Children.map((c) => c.Name).join(","),
          `${book.Children.map((c) => c.Name)} ${book.Tabs}`);

    /*
     * A switcher is the same bargain with a different strip, so the designer
     * has to treat it as pages and not as a row: dropped onto, it makes a page
     * and names it, and it is reordered by taking the pages out and putting
     * them back -- which is all GTK leaves a stack.
     */
    ide.designer.select(null);
    palette(ide, "Switcher").Click();
    yield;

    const sw = ide.designer.selected;
    eq("the palette offers a switcher too", sw.constructor.name, "Switcher");
    eq("with no pages yet", sw.Count, 0);

    palette(ide, "Panel").Click();
    yield;
    ide.designer.select(sw);
    palette(ide, "Frame").Click();
    yield;

    eq("adding to a switcher makes a page", sw.Count, 2);
    check("each page gets a name on the strip",
          sw.Tabs.length === 2 && sw.Tabs.every(Boolean), JSON.stringify(sw.Tabs));
    eq("and the page just added is the one shown", sw.Current, 1);

    const swPaged = sw.Children.map((c) => c.Name).join(",");
    sw.Reorder(sw.Children[0], 1);
    check("its pages reorder, name and all",
          sw.Children.map((c) => c.Name).join(",") !== swPaged &&
          sw.Tabs.join(",") === sw.Children.map((c) => c.Name).join(","),
          `${sw.Children.map((c) => c.Name)} ${sw.Tabs}`);

    /* A split: two halves, and the third is refused rather than thrown. */
    ide.designer.select(null);
    palette(ide, "Split").Click();
    yield;
    const paned = ide.designer.selected;

    palette(ide, "Label").Click();
    yield;
    ide.designer.select(paned);
    palette(ide, "Label").Click();
    yield;
    eq("a split takes two children", paned.Children.length, 2);

    ide.designer.select(paned);
    palette(ide, "Label").Click();
    yield;
    eq("and a third is refused, not thrown", paned.Children.length, 2);

    /* All of it survives the round trip, which is what makes it designable at
     * all: tab names had nowhere to live in a .form until Tabs existed. */
    ide.BtnSave.Click();
    const withBoxes = JSON.parse(File.Load(File.Join(TMP, "Elastic.form")));
    const savedBook = withBoxes.children.find((n) => n.type === "Notebook");
    const savedPane = withBoxes.children.find((n) => n.type === "Split");

    eq("the notebook is saved with its pages", savedBook.children.length, 2);
    check("and with its tab names",
          Array.isArray(savedBook.properties.Tabs) && savedBook.properties.Tabs.length === 2,
          JSON.stringify(savedBook.properties));
    eq("the split with its two halves", savedPane.children.length, 2);

    /* Loaded back the way the runtime loads it: properties come before children,
     * so the tab names have to outlive the pages not existing yet. */
    const reload = new Panel();
    ide.Add(reload);
    reload.Visible = false;
    reload.BuildChildren(withBoxes);

    const back = reload.Children.find((c) => c.constructor.name === "Notebook");
    eq("reloading gives the pages back", back.Count, 2);
    eq("with the names they were saved with",
       back.Tabs.join(","), savedBook.properties.Tabs.join(","));
    reload.Delete();

    /* --- stacks, flows and lists in the designer ----------------------------
     *
     * Three containers that reached the palette while every gesture in the
     * designer treated them as boxes: `Overlay`, `Flow` and `RowList` read no
     * `Arrangement`, so the editor classified them as rows and reached for an
     * order the runtime refused -- *this container has no order to give*, raised
     * **after** the control had been added, so a drag read as failed and left
     * something behind: added, unselected, and the form not even dirty.
     *
     * The gestures are asserted per container, from the runtime's own answer to
     * how it places a child.
     */
    ide.designer.select(null);
    palette(ide, "Overlay").Click();
    yield;

    const tile = ide.designer.selected;
    eq("the palette offers an overlay", tile.constructor.name, "Overlay");
    eq("and the runtime says it stacks", tile.Placement, "Layers");

    /*
     * A base to stack over, dropped from the palette onto the overlay itself --
     * the gesture that used to raise. An `Image` and not a `Panel`: a container
     * that fills the stack is what the next drop would land *in*, which is
     * right and would be testing something else. This is the issue's own tile:
     * a picture with something floating over it.
     */
    /* **Measured again before every drop**, never once and reused: what is in a
     * container changes its own rectangle, so a point taken before the first
     * drop can be outside the stack by the second -- which is a test that
     * passes on a fast machine and fails under a sanitizer. */
    const middleOf = (c) => {
        const r = ide.designer.rectOf(c);
        return [r.x + r.w / 2, r.y + r.h / 2];
    };

    yield* until(() => ide.designer.rectOf(tile).h > 8);
    ide.Glass_Drop("Image", ...middleOf(tile));
    yield* settled(ide);

    eq("a drop into a stack lands in it", tile.Children.length, 1);
    check("and the control it left behind is the one selected",
          ide.designer.selected === tile.Children[0]);
    eq("and it dirties the form", ide.designer.dirty, true);

    yield* until(() => ide.designer.rectOf(tile).h > 8);
    ide.Glass_Drop("Spinner", ...middleOf(tile));
    yield* settled(ide);
    eq("a second drop is a second layer", tile.Children.length, 2);
    check("dropped over the one that was there", ide.designer.selected === tile.Children[1],
          `${ide.designer.selected && ide.designer.selected.Name}`);

    const layers = () => tile.Children.map((c) => c.Name).join(",");
    const stacked = layers();

    /* The arrows restack, which is what an order means in a stack -- and the
     * bottom of it is the layer that fills. */
    ide.designer.keyPress("Up", false, false);
    yield* settled(ide);
    check("the arrows move a layer", layers() !== stacked, layers());
    eq("and that dirties the form too", ide.designer.dirty, true);

    /* At the end of the stack a nudge that cannot happen is not an edit: it used
     * to push an undo step for every arrow that did nothing. */
    const steps = ide.designer.undoStack.length;
    ide.designer.keyPress("Up", false, false);
    yield;
    eq("a nudge with nowhere to go adds no undo step",
       ide.designer.undoStack.length, steps);

    /* X/Y are not the sentence to show here: an overlay is not a box, and
     * sending the author to look for one is worse than saying nothing. */
    ide.designer.select(tile.Children[1]);
    yield* settled(ide);
    check("a layer is not placed by coordinates",
          !editor(ide, "X").Enabled && !editor(ide, "Y").Enabled);
    check("and the reason names the stack rather than a box",
          editor(ide, "X").Tooltip.includes("overlay"), editor(ide, "X").Tooltip);
    check("while the alignment that does place it is live",
          editor(ide, "HAlign").Enabled && editor(ide, "VAlign").Enabled);

    /* A flow and a list of rows are sequences, so there the gesture is the box's
     * one and the same drop has to work. */
    for (const type of ["Flow", "RowList"]) {
        ide.designer.select(null);
        palette(ide, type).Click();
        yield;

        const seq = ide.designer.selected;
        eq(`the palette offers a ${type}`, seq.constructor.name, type);
        eq(`and the runtime says it has an order`, seq.Placement, "Order");

        /* One child first, through the path that always worked: both of these
         * are a scrolled window around an empty list, so until something is in
         * one there is no rectangle on screen to aim a drop at. */
        palette(ide, "Label").Click();
        yield;
        eq(`the palette button appends to a ${type}`, seq.Children.length, 1);

        yield* until(() => ide.designer.rectOf(seq).h > 8);
        ide.Glass_Drop("Button", ...middleOf(seq));
        yield* settled(ide);

        eq(`a drop into a ${type} lands in it`, seq.Children.length, 2);
        check(`and leaves it selected`, ide.designer.selected === seq.Children.at(-1),
              `${ide.designer.selected && ide.designer.selected.Name}`);
        eq(`and dirties the form`, ide.designer.dirty, true);

        const order = seq.Children.map((c) => c.Name).join(",");
        seq.Reorder(seq.Children[0], 1);
        check(`and a ${type} answers Reorder`,
              seq.Children.map((c) => c.Name).join(",") !== order,
              seq.Children.map((c) => c.Name).join(","));
    }

    /*
     * An `AspectFrame` is the sixth kind of container the designer has to know
     * about: one child, one place, and a proportion. Nothing to order, no
     * coordinate to give -- so a gesture there is *land*, and the two questions
     * are whether it lands and whether the grid says the truth about X/Y.
     */
    ide.designer.select(null);
    palette(ide, "AspectFrame").Click();
    yield;

    const shaped = ide.designer.selected;
    eq("the palette offers an aspect frame", shaped.constructor.name, "AspectFrame");
    eq("and the runtime says it has one place", shaped.Placement, "Single");

    yield* until(() => ide.designer.rectOf(shaped).h > 8);
    ide.Glass_Drop("Overlay", ...middleOf(shaped));
    yield* settled(ide);

    eq("a drop into it lands in it", shaped.Children.length, 1);
    check("and is selected", ide.designer.selected === shaped.Children[0]);
    eq("and dirties the form", ide.designer.dirty, true);

    /* A second is refused before anything is created, the way a split's third
     * is: the runtime would have thrown, and a throw mid-gesture is not an
     * answer a designer can give. */
    ide.designer.select(shaped);
    palette(ide, "Label").Click();
    yield;
    eq("a second child is refused rather than thrown", shaped.Children.length, 1);

    ide.designer.select(shaped.Children[0]);
    yield* settled(ide);
    check("its child is not placed by coordinates",
          !editor(ide, "X").Enabled && !editor(ide, "Y").Enabled);
    check("and the reason is its own, not the box's",
          editor(ide, "X").Tooltip.includes("one child"), editor(ide, "X").Tooltip);

    /* The proportion is an ordinary property, so it is in the grid and in the
     * file with no designer code at all -- which is the invariant this tree is
     * built on. */
    ide.designer.select(shaped);
    yield* settled(ide);
    check("the grid offers the proportion",
          ide.designer.grid.propKeys.includes("Ratio"),
          JSON.stringify(ide.designer.grid.propKeys));
    typeInto(ide, "Ratio", "16:9");
    yield* settled(ide);
    eq("set from the grid", shaped.Ratio, "16:9");

    /*
     * **Every container the palette offers answers the gesture the palette
     * makes**, asked of the runtime rather than of a second list here -- which
     * is the only version of this check worth having, because the version that
     * was not asked let three containers sit on the palette refusing it. Both
     * directions: a `Placement` that answered "Order" for everything would pass
     * the first half on its own.
     */
    const mismatched = [];
    for (const type of PALETTE) {
        const c = Widget.New(type);
        if (!("Placement" in c)) { c.Delete(); continue; }

        const places = c.Placement;
        try { c.Add(new Label()); c.Add(new Label()); } catch (e) { /* a split takes two */ }

        let ordered = true;
        try { c.Reorder(c.Children[0], 0); } catch (e) { ordered = false; }

        /* The two that have nothing to move a child *to*: a coordinate is a
         * position and not an order, and a container with one place has only
         * the one. Everything else answers. */
        const movable = places !== "Coordinates" && places !== "Single";

        if (ordered !== movable)
            mismatched.push(`${type}: ${places} but ${ordered ? "orders" : "refuses"}`);
        c.Delete();
    }
    eq("every container the palette offers answers what its placement promises",
       JSON.stringify(mismatched), "[]");

    /* All of it survives the round trip, and a layer carries no coordinates --
     * which is what the file already did silently and the grid now says. */
    ide.BtnSave.Click();
    const withStack = JSON.parse(File.Load(File.Join(TMP, "Elastic.form")));
    const savedTile = withStack.children.find((n) => n.type === "Overlay");

    const savedShaped = withStack.children.find((n) => n.type === "AspectFrame");

    eq("the aspect frame is saved with its one child", savedShaped.children.length, 1);
    eq("and with the proportion it was given", savedShaped.properties.Ratio, "16:9");
    eq("the overlay is saved with its layers", savedTile.children.length, 2);
    eq("in the order they are stacked in",
       savedTile.children.map((c) => c.name).join(","), layers());
    check("and no layer carries coordinates",
          savedTile.children.every((c) => !("X" in (c.properties || {}))),
          JSON.stringify(savedTile.children.map((c) => c.properties)));

    /* --- a component the IDE cannot build -------------------------------------
     *
     * A component is a class of the *project*, and the designer runs in the
     * IDE's process: it has the runtime's widgets and none of the project's.
     * Refusing the form would make components unusable with the IDE; building
     * something else in its place would rewrite the component out of the file on
     * the next save.  It is shown as itself and written back as it came.
     */
    /* A real one this time: a .form and a class declaring itself a Component,
     * which is what makes the IDE recognise it as one. */
    File.Save(File.Join(TMP, "Stepper.form"), JSON.stringify({
        format: "bintana-form/1", class: "Stepper",
        properties: { Width: 180, Height: 34 },
        children: [{ type: "Label", name: "Shown",
                     properties: { X: 0, Y: 0, Width: 60, Height: 24, Text: "0" } }],
    }, null, 2));
    /*
     * The three things a control written in C states next to its properties, in
     * a class the IDE cannot hold: what it raises, what one of its properties
     * accepts, which of its strings a person reads.  Nothing but the class can
     * say them, and until it could the IDE answered with Widget's mouse events,
     * a text field, and nothing for the translator.
     */
    File.Save(File.Join(TMP, "Stepper.js"),
              'class Stepper extends Component {\n' +
              '    static Events         = ["Change"];\n' +
              '    static Options        = { Step: ["1", "5", "10"] };\n' +
              '    static TextProperties = ["Caption"];\n' +
              '\n' +
              '    get Value()  { return this._value || 0; }\n' +
              '    set Value(v) { this._value = Number(v) || 0; }\n' +
              '    get Caption()  { return this._cap || ""; }\n' +
              '    set Caption(v) { this._cap = String(v); }\n' +
              '    get Step()  { return this._step || "1"; }\n' +
              '    set Step(v) { this._step = String(v); }\n' +
              '    get Readonly() { return !!this._ro; }\n' +
              '}\n');

    File.Save(File.Join(TMP, "WithComp.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "WithComp",
        properties: { Text: "WithComp", Width: 400, Height: 300 },
        children: [
            { type: "Stepper", name: "Step",
              properties: { X: 20, Y: 20, Width: 180, Height: 34,
                            Value: 5, Step: "5" } },
            { type: "Label", name: "Plain",
              properties: { X: 20, Y: 80, Width: 100, Height: 24, Text: "plain" } },
        ],
    }, null, 2));
    File.Save(File.Join(TMP, "WithComp.js"), "class WithComp extends Form {\n}\n");

    ide.listFiles();
    ide.openNamed("WithComp.form");
    yield; yield;

    eq("a form using a component still opens", ide.designing, true);
    eq("with something standing in for it", ide.Surface.Children.length, 2);

    const standIn = byName(ide, "Step");
    check("named after the control it stands for", !!standIn, "no stand-in");
    /*
     * **Which type it is, asked of the node and not of the drawing.** A
     * component whose `.form` can be read is now drawn rather than named, so
     * what says `Stepper` is the node it carries and the row the control tree
     * shows -- the grey `[Stepper]` box is what a type with nothing to draw
     * still falls back to.
     */
    eq("and carrying the type it stands for", standIn.__node.type, "Stepper");
    eq("which is what the control tree shows it as",
       ide.designer.tree.typeOf(standIn), "Stepper");

    /*
     * **A component that draws nothing one can read says what it is**, which is
     * the case the drawing replaced and had to give back: a type with no `.form`
     * here, a form with nothing in it, and the painted half -- a `Chart` is one
     * `DrawingArea` and everything one recognises about it is painted by code
     * the designer cannot run. All three are a tinted rectangle otherwise.
     *
     * The mark is the icon `Palette` and `ControlTree` already name a component
     * with -- the desktop's first and the project's own SVG behind it -- so the
     * canvas, the tree and the palette cannot come to disagree.
     */
    /* This one has a `.form` with a label in it, so what the canvas shows is the
     * component: its own `Shown`, reading what the file declares. */
    const drawn = standIn.Children.map((c) => c.Text).filter(Boolean);
    check("a component whose form can be read is drawn, not named",
          drawn.includes("0"), JSON.stringify(drawn));

    /*
     * **And one that draws nothing one can read says what it is instead**, which
     * is the case the drawing replaced and had to give back: a form with nothing
     * in it here, and in a real project the painted half -- a `Chart` is one
     * `DrawingArea`, and everything one recognises about it is painted by code
     * the designer cannot run. Both are a tinted rectangle otherwise.
     *
     * The mark is the icon `Palette` and `ControlTree` already name a component
     * with -- the desktop's first and the project's own SVG behind it -- so the
     * canvas, the tree and the palette cannot come to disagree about it.
     */
    File.Save(File.Join(TMP, "Blank.js"), "class Blank extends Component {\n}\n");
    File.SaveJson(File.Join(TMP, "Blank.form"), {
        format: "bintana-form/1", class: "Blank",
        properties: { Width: 120, Height: 30 }, children: [],
    });
    ide.listFiles();
    yield* settled(ide);

    ide.designer.addControl("Blank");
    yield* settled(ide);

    const blank = ide.designer.selected;
    const says  = blank.Children.map((c) => c.Text).filter(Boolean);
    check("a component with nothing to draw says what it is",
          says.includes("Blank"), JSON.stringify(says));
    check("...beside the mark the tree names a component with",
          blank.Children.some((c) => c.Icon), 
          JSON.stringify(blank.Children.map((c) => c.Icon)));

    /* Placing a component registers its source, so taking it away is three
     * steps and not one: the control, the files, and the line in project.json
     * that would otherwise make the project fail to load a class that is gone.
     * `p_running` runs this project for real, which is what catches it. */
    blank.Delete();
    ide.dropSource("Blank.js");
    File.Delete(File.Join(TMP, "Blank.js"));
    File.Delete(File.Join(TMP, "Blank.form"));
    ide.listFiles();
    yield* settled(ide);

    /*
     * Selectable and movable like anything else -- and its own properties are
     * editable, which took reading them out of its source.  The designer cannot
     * ask an instance: a component's class belongs to the project and the
     * designer runs without it.  So it applies the serialiser's rule to the
     * text instead: an accessor with *both* a getter and a setter.
     */
    ide.designer.select(standIn);
    yield;
    eq("the grid offers what the designer owns, then what the class declares",
       ide.designer.grid.propKeys.join(","),
       "Name,X,Y,Width,Height,Caption,Step,Value");
    check("a getter with no setter is left out, as everywhere else",
          !ide.designer.grid.propKeys.includes("Readonly"),
          JSON.stringify(ide.designer.grid.propKeys));
    check("and nothing of the Label standing in",
          !ide.designer.grid.propKeys.includes("Text"),
          JSON.stringify(ide.designer.grid.propKeys));

    /* The value comes from the node, with its type -- which is what gets it the
     * right editor: a number is a spin and not a text field. */
    eq("a component property reads from the node", ide.designer.grid.propertyValue("Value"), 5);
    check("and is edited as what it is", editor(ide, "Value") instanceof SpinBox);
    eq("one never set reads as empty", ide.designer.grid.propertyValue("Caption"), "");

    /*
     * --- what the class publishes -------------------------------------------
     *
     * A property is discoverable because it is *there* -- an accessor, in the
     * text or on the prototype.  The other three things a control says about
     * itself are not: what it raises, what a property accepts, which of its
     * strings hold prose are declarations, and a component had nowhere to put
     * them.  Now it does, and the answers arrive where the C table's do.
     */
    check("a declared list of values gets a drop-down, as a C control's does",
          editor(ide, "Step") instanceof ComboBox);
    eq("holding exactly what the class declared",
       editor(ide, "Step").Items.join(","), "1,5,10");
    check("while a property with no list keeps its text field",
          editor(ide, "Caption") instanceof TextBox);

    /*
     * The event a double click writes.  It was `MouseDown` for every component
     * ever written -- the stand-in is a Label, and a Label was answering.
     */
    eq("a component's own event leads what its class declares",
       ide.designer.eventsOf(standIn)[0], "Change");
    check("with what any widget raises after it",
          ide.designer.eventsOf(standIn).includes("MouseDown"),
          JSON.stringify(ide.designer.eventsOf(standIn)));
    eq("so a double click writes the component's event",
       ide.designer.defaultEvent(standIn), "Change");
    check("and nothing of the Label standing in",
          !ide.designer.eventsOf(standIn).includes("Activate"),
          JSON.stringify(ide.designer.eventsOf(standIn)));
    eq("while a control the runtime does build still answers for itself",
       ide.designer.defaultEvent(byName(ide, "Plain")), "MouseDown");

    /* Design mode is prose and nothing else, and a component now says which of
     * its properties that is instead of offering all of them. */
    eq("design mode offers the prose the class declares",
       ide.designer.grid.designKeys().join(","), "Caption,Tooltip");

    editor(ide, "Value").Value = 12;
    yield;
    eq("editing one writes it back to the node",
       standIn.__node.properties.Value, 12);

    /* Nothing says what type a property is until the node holds one, so the
     * text is read as the JSON it is about to become -- a .form is JSON, and 5
     * and "5" are not the same thing to the setter that will receive it. */
    editor(ide, "Caption").Text = "Hola";
    editor(ide, "Caption").Emit("Activate");
    eq("a first value that is not a number stays a string",
       standIn.__node.properties.Caption, "Hola");
    eq("one that is a number is stored as one",
       ide.designer.grid.componentValue("7", ""), 7);
    eq("and a boolean as one",
       ide.designer.grid.componentValue("true", ""), true);

    standIn.Move(60, 90);
    ide.designer.touch();
    ide.BtnSave.Click();

    const kept = JSON.parse(File.Load(File.Join(TMP, "WithComp.form")));
    eq("saved back as the component it is", kept.children[0].type, "Stepper");
    eq("keeping the value the grid gave it", kept.children[0].properties.Value, 12);
    eq("and the one it was given for the first time",
       kept.children[0].properties.Caption, "Hola");
    eq("and taking the position it was given", kept.children[0].properties.X, 60);
    eq("with the ordinary control untouched", kept.children[1].type, "Label");

    /*
     * And the editor proposes it.  `Widget.New("Stepper")` throws in this
     * process and always will, so the completion answered nothing for every
     * control the project itself wrote -- the one kind of control whose events
     * nobody can look up in the documentation either.
     */
    ide.openInTab("WithComp.js");
    yield;

    const compEvents = ide.Editor_Complete("Step_", 1, 1, "    ").map((p) => p.Text);
    eq("the editor proposes a component's own handler first",
       compEvents[0], "Step_Change");
    check("and the inherited ones after it",
          compEvents.includes("Step_MouseDown"), JSON.stringify(compEvents));

    const compProps = ide.Editor_Complete("", 1, 1, "        this.Step.")
                         .map((p) => p.Text);
    check("and its properties, off the same reading of the same source",
          compProps.includes("Value") && compProps.includes("Caption"),
          JSON.stringify(compProps));
    check("a getter with no setter is left out here too",
          !compProps.includes("Readonly"), JSON.stringify(compProps));

    /* --- the IDE's own window, in the IDE ------------------------------------
     *
     * The premise of the project is that the IDE is written in Bintana, and it
     * was not quite true: its own MainForm is elastic, and an elastic form could
     * not be designed.  This opens the real file -- boxes, splits, a notebook, an
     * overlay, a row list and a menu bar -- and asks the designer to lay it out.
     */
    const selfPath = File.Join(Application.Directory, "..", "..", "ide", "forms", "MainForm.form");
    File.Save(File.Join(TMP, "SelfDesign.form"),
              File.Load(selfPath).replace('"class": "MainForm"', '"class": "SelfDesign"'));
    File.Save(File.Join(TMP, "SelfDesign.js"), "class SelfDesign extends Form {\n}\n");

    ide.listFiles();
    ide.openNamed("SelfDesign.form");
    yield; yield;

    eq("the IDE's own form opens in the designer", ide.designing, true);
    /* Drawn in coordinates like any other form: what makes it survive a resize
     * is the anchors its controls carry, not a tree of boxes. */
    eq("laid out the way it declares", ide.Surface.Arrangement, "Fixed");

    /* One control at the top level, and the window inside it: what the IDE shows
     * is a welcome page or a workspace, and those are the two pages of a
     * `Switcher` with no strip. */
    const selfKids = ide.Surface.Children.map((c) => c.Name);
    eq("holding the stack its two faces live in", selfKids.join(","), "Pages");

    const selfDeep = ide.designer.allControls().map((c) => c.Name);
    check("with its own controls in there",
          selfDeep.includes("BtnOpen") && selfDeep.includes("Split") &&
          selfDeep.includes("WelcomeCol"),
          JSON.stringify(selfDeep));

    /*
     * The workspace is the stack's second page, and a page nobody is looking at
     * has no allocation at all -- the designer shows one at a time, exactly as
     * the running window does.  Switching to it is what a user editing this file
     * would do, and everything measured below is on it.
     */
    byName(ide, "Pages").Current = 1;
    yield* until(() => ide.designer.rectOf(byName(ide, "Split")).w > 0);

    const btn   = byName(ide, "BtnOpen");
    const split = byName(ide, "Split");
    const tbAt  = ide.designer.rectOf(btn);
    const spAt  = ide.designer.rectOf(split);

    check("the split spanning the width", spAt.w > 400, JSON.stringify(spAt));
    check("and below the toolbar, not on top of it", spAt.y >= tbAt.y + tbAt.h,
          `${JSON.stringify(tbAt)} ${JSON.stringify(spAt)}`);
    check("nothing pushed off to a negative corner", tbAt.x >= 0 && tbAt.y >= 0,
          JSON.stringify(tbAt));

    /* The anchors are ordinary properties, so the grid edits them and the
     * serialiser saves them -- which is the whole claim the invariant makes. */
    check("an anchored control offers its values",
          JSON.stringify(byName(ide, "LblStatus").PropertyOptions("HAlign")) ===
          '["Auto","Start","End","Center","Fill"]',
          JSON.stringify(byName(ide, "LblStatus").PropertyOptions("HAlign")));
    eq("and reports the one it was drawn with", byName(ide, "LblStatus").HAlign, "Fill");

    /*
     * The IDE's own window is 1100 wide and the canvas showing it is about half
     * that.  It has to be editable anyway, which is what the `Scroller` is for:
     * the board is as big as the form, the view is as big as the room, and the
     * difference scrolls.  Cutting the form off at the edge of the view would
     * leave most of this one -- Split is 1100 wide on its own -- unreachable.
     */
    const board = ide.Canvas.Bounds(), view = ide.CanvasScroll.Bounds();

    eq("the board is the size of the form being drawn", board.Width, 1100);
    eq("and the surface with it",                       ide.Surface.Bounds().Width, 1100);
    check("while the view is only the room there is",
          view.Width < board.Width, `view=${JSON.stringify(view)} board=${JSON.stringify(board)}`);
    /* The status label ends at the far edge of a form 1100 wide, which is well
     * past a view about half that: it is on the board, it is reachable by
     * scrolling, and cutting the form off at the edge of the view would have
     * made it -- and everything under it -- uneditable. */
    const statusAt = ide.designer.rectOf(byName(ide, "LblStatus"));
    check("so a control past the edge of the view still exists to be edited",
          statusAt.x + statusAt.w > view.Width, JSON.stringify(statusAt));

    /* Deep in there is the palette notebook and the property grid: the tree is
     * walked whole, not just its first level. */
    const deep = ide.designer.allControls().map((c) => c.Name);
    check("every control is reachable, however deep",
          deep.includes("PropGrid") && deep.includes("Palette") && deep.includes("LogView"),
          `${deep.length} controls`);

    /*
     * And it can be saved back with its menus, which is the other half of being
     * able to edit itself.
     *
     * The nudge is made on `Pages`, which is the one thing left on the form's
     * own surface: everything under it is in boxes now, and in a box the arrows
     * reorder rather than move because there is no coordinate to nudge. That has
     * walked outwards twice -- first off the toolbar's buttons, then off the
     * toolbar itself -- and each time for the same reason, which is that a part
     * of this window stopped being a drawing and became a layout.
     */
    ide.designer.select(byName(ide, "Pages"));
    ide.designer.keyPress("Down", false, false);
    ide.BtnSave.Click();

    const selfSaved = JSON.parse(File.Load(File.Join(TMP, "SelfDesign.form")));

    /* Deep, like byName above: this file keeps its controls two containers down
     * now, and what is being asked about is the control, not where it sits. */
    const savedNode = (name) => (function find(node) {
        for (const c of node.children || []) {
            if (c.name === name) return c;
            const hit = find(c);
            if (hit) return hit;
        }
        return null;
    })(selfSaved);
    const savedOf = (name) => savedNode(name).properties;

    /* Seven: File, Edit, Project, Git, Debug, Form, Help. The number is here
     * rather than a list because what is being asserted is that the bar
     * survived the round trip, not which menus the IDE happens to have. */
    eq("saving keeps its menu bar", selfSaved.menus.length, 7);
    /* Fixed is the default, so it is saved by being absent -- the same rule
     * that keeps an unanchored control from writing HAlign "Start". */
    eq("and its arrangement", selfSaved.properties.Arrangement, undefined);
    eq("with the nudge that was made", savedOf("Pages").Y, 1);
    check("and no coordinates on what a box holds",
          !("X" in savedOf("BtnOpen")) && !("Y" in savedOf("BtnOpen")) &&
          !("X" in savedOf("ToolBar")) && !("Y" in savedOf("ToolBar")),
          JSON.stringify(savedOf("ToolBar")));
    eq("and the anchors it was drawn with", savedOf("LblStatus").HAlign, "Fill");

    /*
     * And the tab strip's button, which is the case this was all for: a control
     * that is not a page, in a notebook, in the IDE's own window.  Before the
     * `.form` had a word for it, opening this file in the designer and saving
     * it deleted it -- silently, which is the worst kind.
     */
    const strip = (function find(node) {
        for (const c of node.children || []) {
            if (c.strip) return c;
            const hit = find(c);
            if (hit) return hit;
        }
        return null;
    })(selfSaved);

    check("the tab strip's button survives being saved", strip !== null,
          "the strip widget was dropped");
    eq("at the end it was put",       strip && strip.strip, "End");
    eq("as the control it is",        strip && strip.name, "TabActions");
    check("with the menu it carries",
          strip && Array.isArray(strip.properties.Menu) &&
          strip.properties.Menu.length === 5,
          JSON.stringify(strip && strip.properties.Menu));
    check("while a control that stays put writes none",
          !("HAlign" in savedOf("BtnOpen")) && !("VAlign" in savedOf("BtnOpen")),
          JSON.stringify(savedOf("BtnOpen")));

    /* --- saving keeps what the designer does not model ----------------------
     *
     * The designer rebuilds the file from the surface, so anything in the node it
     * has no widget for used to be dropped on save -- `menus` above all, which is
     * unreconstructable: a GMenu has no nesting left, and its separators are
     * section boundaries.  Losing them was silent, which is what made it bad. */
    File.Save(File.Join(TMP, "Menued.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Menued",
        properties: { Text: "Menued", Width: 300, Height: 200 },
        menus: [
            { name: "MnuF", text: "_File", children: [
                { name: "MnuA", text: "One", shortcut: "<Control>1" },
                { separator: true },
                { name: "MnuB", text: "Many", dynamic: true },
            ] },
        ],
        children: [
            { type: "Button", name: "Btn",
              properties: { X: 10, Y: 10, Width: 80, Height: 30, Text: "b" } },
        ],
    }, null, 2));
    File.Save(File.Join(TMP, "Menued.js"), "class Menued extends Form {\n}\n");

    ide.listFiles();
    ide.openNamed("Menued.form");
    yield;                 // let GTK allocate the design area
    eq("the menued form opens in the designer", ide.designing, true);

    /* A real edit, so the save is a real save. */
    ide.designer.select(byName(ide, "Btn"));
    ide.Glass_KeyPress("Right", false, true);          // one grid step
    eq("the form is dirty after the edit", ide.designer.dirty, true);

    ide.BtnSave.Click();
    const menued = JSON.parse(File.Load(File.Join(TMP, "Menued.form")));

    eq("the edit was saved", menued.children[0].properties.X, 14);
    check("and the menus are still there", Array.isArray(menued.menus), JSON.stringify(menued));
    eq("with their items", menued.menus[0].children.length, 3);
    eq("their shortcuts", menued.menus[0].children[0].shortcut, "<Control>1");
    check("their separators", menued.menus[0].children[1].separator === true);
    check("and what makes an item dynamic", menued.menus[0].children[2].dynamic === true);
    check("the key order of the file survives too",
          Dictionary.Keys(menued).join(",") === "format,class,properties,menus,children",
          Dictionary.Keys(menued).join(","));

}

function* p_menus(ide) {
    /* --- the bar on the board -----------------------------------------------
     *
     * A menu is a model wired to actions and not a widget, so there is nothing
     * of one to put on the canvas -- but a *preview* of one is ordinary widgets,
     * the same bargain the title bar above it makes, and the drop-downs are real
     * menus because every widget has a `Menu`.
     *
     * What it must not be is live: the board belongs to the IDE's own form, so a
     * previewed item built under its own name would land on `MainForm`, dispatch
     * to `MainForm`'s handler and register its shortcut application-wide. */
    const bar = ide.designer.menubar;

    check("the board shows the form's menu bar", bar.Visible);
    eq("an entry per top level menu", bar.items.length, 1);
    /* A control has no mnemonic, so `_File` would be shown with the marker in
     * it. The menu below keeps its own -- that one goes into a real GMenu. */
    eq("with the mnemonic resolved", bar.items[0].Text, "File");

    /* The bar is a real menu bar's height, asked of a real one: the IDE is
     * itself a form with menus, so its own window has one.  An entry is a Label
     * and not a Button so that the two can agree -- a Button's floor is eight
     * pixels over -- and this is what would say so if a desktop broke it. */
    check("its height was measured, not assumed", Ide.MenuBar.measured > 0,
          `${Ide.MenuBar.measured}`);
    eq("and the preview comes out at a real bar's height",
       bar.Drawn, Ide.MenuBar.measured);
    eq("which is what the canvas gives up", ide.designer.menuBarHeight(),
       Ide.MenuBar.measured);

    /* And it is where the runtime puts one: spanning the window, directly above
     * the surface -- a menu bar is a sibling of the surface, not something in
     * it. */
    {
        const at = bar.panel.Bounds(), on = ide.Surface.Bounds();
        eq("the bar spans the form", at.Width, on.Width);
        eq("and sits directly above the canvas", at.Y + at.Height, on.Y);
    }

    /* The half that was wrong before there was a bar to show: Width and Height
     * are the *window*, and the runtime prepends the bar inside it, so the form
     * has that much less room than it declares. */
    eq("the canvas gives the bar its room", ide.Surface.Height,
       200 - ide.designer.menuBarHeight());
    eq("while the form still measures the window", ide.designer.formSize().h, 200);

    /* None of it is live. */
    check("a previewed item does not land on the IDE by its own name",
          !("MnuA" in ide));
    check("so the IDE's own menu is still the IDE's",
          typeof ide.MnuOpen.Click === "function");

    const preview = bar.sanitise(ide.designer.menus()[0].children, "0", []);

    check("and no shortcut travels: an accelerator is application-wide",
          JSON.stringify(preview).indexOf("shortcut") < 0, JSON.stringify(preview));
    check("nor does dynamic, which nothing here would fill",
          JSON.stringify(preview).indexOf("dynamic") < 0, JSON.stringify(preview));
    check("the separator does", preview[1].separator === true);

    /* Clicking a previewed item writes its handler, which is what a double click
     * does on a control of the canvas and on a row of the editor's tree -- and
     * it is written under the item's *real* name, not the preview's. */
    const leaf = bar.owned.find((n) => n.endsWith("_0_0"));
    check("a leaf has a handler installed", typeof ide[`${leaf}_Click`] === "function");

    ide[`${leaf}_Click`]();
    yield;
    eq("clicking it opens the code", ide.activeFile, "Menued.js");
    check("with the handler of the item, under the name the form gave it",
          File.Load(File.Join(TMP, "Menued.js")).includes("MnuA_Click()"),
          File.Load(File.Join(TMP, "Menued.js")));

    ide.openNamed("Menued.form");
    yield;

    /* --- editing the menus --------------------------------------------------
     *
     * The bar is for looking at and clicking; what reorders and renames is still
     * a dialog, and it is itself a Bintana form.  What it produces has to be a
     * designer edit like any other: undoable, dirtying, and saved with the rest.
     */
    ide.MnuMenus.Click();
    yield;

    const menuDlg = ide.menuEditor;
    check("the menu editor opens", !!menuDlg);
    eq("it shows the bar, its items and its rule", menuDlg.Tree.Count, 4);
    check("addressed by path", menuDlg.Tree.Exists("0") && menuDlg.Tree.Exists("0/2"));

    /* Selecting fills the fields; a name is what the handler is called after. */
    menuDlg.Tree.Key = "0/0";
    eq("selecting an item shows its text", menuDlg.TxtText.Text, "One");
    eq("and its name", menuDlg.TxtName.Text, "MnuA");
    eq("and its shortcut", menuDlg.TxtShortcut.Text, "<Control>1");

    /* A separator has nothing to describe, and says so by being uneditable. */
    menuDlg.Tree.Key = "0/1";
    eq("a rule has no text to edit", menuDlg.TxtText.Enabled, false);

    /* Renaming applies on Enter, like the property grid. */
    menuDlg.Tree.Key = "0/0";
    menuDlg.TxtText.Text = "First";
    menuDlg.TxtText_Activate();
    eq("the tree follows the text", menuDlg.Tree.Text, "First");

    /* A name has to be usable as one: it is a method prefix. */
    menuDlg.TxtName.Text = "no valido";
    menuDlg.TxtName_Activate();
    eq("an unusable name is refused", menuDlg.TxtName.Text, "MnuA");

    menuDlg.TxtName.Text = "MnuB";
    menuDlg.TxtName_Activate();
    eq("a name already in use is refused", menuDlg.TxtName.Text, "MnuA");

    /* Adding: inside the submenu when one is selected. */
    menuDlg.Tree.Key = "0";
    menuDlg.BtnItem_Click();
    eq("adding with a submenu selected puts it inside", menuDlg.Tree.Count, 5);
    check("and selects what was added", menuDlg.Tree.Key.startsWith("0/"),
          menuDlg.Tree.Key);

    const addedPath = menuDlg.Tree.Key;
    menuDlg.TxtText.Text = "Second";
    menuDlg.TxtText_Activate();
    menuDlg.TxtName.Text = "MnuC";
    menuDlg.TxtName_Activate();
    menuDlg.TxtShortcut.Text = "<Control>2, F7";
    menuDlg.TxtShortcut_Activate();

    /*
     * What kind of item it is.  The three boxes carry the same rules the loader
     * does, so the dialog cannot hand back a spec the `.form` would refuse -- and
     * they read as fields going grey instead of as an error on OK.
     */
    const kind = menuDlg.nodeAt(menuDlg.selectedPath);

    eq("a new item is a plain command", menuDlg.ChkCheck.Active, false);
    eq("...and not a dynamic one",      menuDlg.ChkDynamic.Active, false);
    check("radio cannot be asked for on its own", !menuDlg.ChkRadio.Enabled);

    menuDlg.ChkCheck.Active = true;
    eq("ticking check makes it a check item", kind.check, true);
    check("a check item is one command, so it can still take a shortcut",
          menuDlg.TxtShortcut.Enabled);

    menuDlg.ChkDynamic.Active = true;
    check("asking for dynamic takes the tick away", !kind.check, JSON.stringify(kind));
    check("and dynamic is what makes radio possible", menuDlg.ChkRadio.Enabled);
    check("while a dynamic item has no single command to bind a key to",
          !menuDlg.TxtShortcut.Enabled);

    menuDlg.ChkRadio.Active = true;
    check("radio marks the entry chosen, and needs the entries",
          kind.radio === true && kind.dynamic === true, JSON.stringify(kind));

    /* Back to a plain command, which is what the rest of this test is about. */
    menuDlg.ChkDynamic.Active = false;
    check("dropping dynamic drops the mark with it",
          !kind.radio && !kind.dynamic, JSON.stringify(kind));
    check("and the shortcut it had is still there", Array.isArray(kind.shortcut) ||
          typeof kind.shortcut === "string", JSON.stringify(kind.shortcut));

    /* Moving reorders within the level it is in. */
    menuDlg.Tree.Key = addedPath;
    menuDlg.BtnUp_Click();
    check("moving up reorders it", menuDlg.Tree.Key !== addedPath, menuDlg.Tree.Key);

    menuDlg.BtnOk_Click();
    const edited = ide.designer.menus();

    eq("accepting hands the spec to the designer", edited[0].children.length, 4);
    eq("with the text that was typed", edited[0].children[0].text, "First");
    check("the new item is there, before the one it passed",
          edited[0].children.some((n) => n.name === "MnuC"),
          JSON.stringify(edited[0].children.map((n) => n.name)));
    check("a shortcut list is a list, which is what the format takes",
          Array.isArray(edited[0].children.find((n) => n.name === "MnuC").shortcut));
    eq("and editing the menus dirties the form", ide.designer.dirty, true);

    ide.BtnSave.Click();
    const withMenus = JSON.parse(File.Load(File.Join(TMP, "Menued.form")));
    eq("saving writes them", withMenus.menus[0].children.length, 4);

    /* Undo covers them: they live in the node, not on the surface, and a
     * snapshot that ignored them would restore the controls alone. */
    ide.MnuUndo.Click();
    eq("undo puts the menu bar back", ide.designer.menus()[0].children.length, 3);
    ide.MnuRedo.Click();
    eq("and redo brings the edit back", ide.designer.menus()[0].children.length, 4);

    /* Cancelling changes nothing: the dialog works on a copy. */
    ide.MnuMenus.Click();
    yield;
    ide.menuEditor.Tree.Key = "0/0";
    ide.menuEditor.TxtText.Text = "Thrown away";
    ide.menuEditor.TxtText_Activate();
    ide.menuEditor.BtnCancel_Click();
    eq("cancelling leaves the form untouched",
       ide.designer.menus()[0].children[0].text, "First");

    /* An item with no name has no action to raise: the loader would refuse it,
     * so the editor does instead. */
    ide.MnuMenus.Click();
    yield;
    const bad = ide.menuEditor;
    bad.Tree.Key = "0/0";
    bad.TxtName.Text = "";
    bad.TxtName_Activate();
    check("an item left without a name is refused", bad.problems().length > 0,
          JSON.stringify(bad.problems()));
    bad.BtnCancel_Click();

    ide.BtnSave.Click();

    /* The RAD gesture, the same one the canvas has: double click an item and you
     * are writing what it does.  The edit is applied first, so the handler is
     * never written for an item a Cancel would have taken away. */
    ide.MnuMenus.Click();
    yield;
    ide.menuEditor.Tree.Key = "0/0";
    ide.menuEditor.Tree_Activate();
    yield;

    const menuCode = File.Load(File.Join(TMP, "Menued.js"));
    check("double clicking an item writes its handler",
          menuCode.includes("MnuA_Click()"), menuCode);
    eq("and leaves the designer for the code", ide.activeFile, "Menued.js");
    check("with the cursor in it",
          ide.Editor.Text.split("\n")[ide.Editor.Line - 1].includes("MnuA_Click") ||
          ide.Editor.Line > 1, `line ${ide.Editor.Line}`);

    /* --- and what the preview has to give back ------------------------------
     *
     * The bar hangs its items and their handlers off the IDE's *own* form, which
     * is the one thing a closed page cannot take away with it.  Left there, a
     * stale item answers to a name the next form wanted, and the closure holds
     * the designer that was closed.
     */
    ide.openNamed("Menued.form");
    yield;

    const closing = ide.designer.menubar;
    const left    = closing.owned.slice();

    check("the preview is holding names on the IDE", left.length > 0);

    ide.closeTabByName("Menued.form", true);
    yield;

    check("closing the page takes every one of them back",
          left.every((n) => !(n in ide) && !(`${n}_Click` in ide) &&
                            !(`${n}_MouseDown` in ide)),
          left.filter((n) => n in ide).join(","));

    /* And back to the design, which is what the rest of the section left open. */
    ide.openNamed("Menued.form");
    yield;

}

function* p_folders(ide) {
    /* --- directories and namespaces -------------------------------------------
     *
     * A project grows out of one flat folder.  A folder that could be a
     * namespace becomes one -- the IDE writes the declaration, and from then on
     * the class answers to Folder.Class everywhere.  So what has to be right is
     * the tree, the pairs, "sources", the prologue, and every .form that names
     * the class when it moves.
     */
    /* A namespace is opted into: the same call without the flag writes a plain
     * class, because a folder is only a folder until someone says otherwise. */
    eq("a form can be created in a folder", ide.createForm("Suelto/Plano"), true);
    yield;
    const planoJs = File.Load(File.Join(TMP, "Suelto", "Plano.js"));
    check("with no namespace unless it was asked for",
          !planoJs.includes("Namespace("), planoJs);
    eq("so its class is the bare name",
       ide.qualifiedName("Suelto/Plano.form"), "Plano");
    /* **Nothing is offered where there is nothing to join**: the option names the
     * namespace the folder's other classes are in, and a folder whose classes are
     * bare has none. It is not a checkbox that starts unticked -- there is no
     * checkbox, because a *new* namespace is a decision and not a default. */
    eq("nothing is offered for a folder whose classes are bare",
       ide.namespaceOption("Suelto/X"), null);
    eq("nor at the top, where the same is true",
       ide.namespaceOption("Algo"), null);

    /*
     * **The first class of a namespace is told which one.** A folder's name is
     * not a namespace any more -- so `true` has nothing to name and the caller
     * says it: `"Widgets"`. Everything created there afterwards follows its
     * neighbours, which is the assertion further down.
     */
    eq("a form can be created in a namespace it is given",
       ide.createForm("Widgets/Marco", "Form", "Widgets"), true);
    yield;

    check("the files went into the folder",
          File.Exists(File.Join(TMP, "Widgets", "Marco.form")) &&
          File.Exists(File.Join(TMP, "Widgets", "Marco.js")));
    check("the scan lists it by path", ide.files.includes("Widgets/Marco.form"),
          JSON.stringify(ide.files));
    check("sources carries the folder too",
          JSON.parse(File.Load(File.Join(TMP, "project.json")))
              .sources.includes("Widgets/Marco.js"));

    /*
     * **And the node it grew is the namespace, not the folder.** The project
     * view groups by what a thing *is*, and what this class is is
     * `Widgets.Marco` -- the name a `.form` writes, `startup` names and the
     * runtime resolves. The directory it happens to sit in is the other view's
     * subject. Drawing both would say one thing twice, which is the rule the
     * tool-named folders already follow.
     */
    check("the tree grew a namespace, not a folder",
          ide.FileTree.Exists("ns:Widgets") && !ide.FileTree.Exists("dir:Widgets"));
    check("with the form inside it", ide.FileTree.Exists("form:Widgets/Marco"));
    check("and the categories under it are its own",
          ide.FileTree.Exists("cat:forms:ns:Widgets"));
    check("while the top level keeps its own", ide.FileTree.Exists("cat:forms"));

    /* A class in no namespace is at the top -- which is what the runtime says of
     * a bare name -- so the folder somebody made for it is still a folder. */
    check("a folder that is not a namespace is still drawn",
          ide.FileTree.Exists("dir:Suelto"), JSON.stringify(Dictionary.Keys(ide.byKey)));
    check("with its own class in it", ide.FileTree.Exists("form:Suelto/Plano"));

    eq("it opened in the designer", ide.activeFile, "Widgets/Marco.form");

    /* The folder became the namespace, which is a fact about the code and not
     * about the directory: the prologue is what makes it true. */
    const marcoJs = File.Load(File.Join(TMP, "Widgets", "Marco.js"));
    check("the code declares the namespace",
          marcoJs.includes('Namespace("Widgets")'), marcoJs);
    check("and assigns the class into it",
          marcoJs.includes("Widgets.Marco = class Marco extends Form"), marcoJs);
    check("which is still valid JavaScript", parses(marcoJs), marcoJs);

    eq("the .form is keyed by the qualified name",
       JSON.parse(File.Load(File.Join(TMP, "Widgets", "Marco.form"))).class,
       "Widgets.Marco");
    eq("and the IDE reads it back from the code",
       ide.qualifiedName("Widgets/Marco.form"), "Widgets.Marco");
    eq("while a form at the top has no namespace",
       ide.qualifiedName("Refactor.form"), "Refactor");

    /* The pair is the file *beside* it, which is what makes deleting and
     * renaming a form move both files and only those two. */
    eq("a form in a folder is still a pair", ide.pairOf("Widgets/Marco.form").length, 2);
    check("both in the folder",
          ide.pairOf("Widgets/Marco.form").every((f) => f.startsWith("Widgets/")),
          JSON.stringify(ide.pairOf("Widgets/Marco.form")));

    /* Asked once per folder: what the neighbours do is what the next class
     * gets, so a batch written in one place stays consistent. */
    eq("a folder that uses namespaces keeps using them",
       ide.namespaceDefault("Widgets"), true);
    eq("and one that does not, does not", ide.namespaceDefault("Suelto"), false);
    eq("which is what the dialog offers",
       ide.namespaceOption("Widgets/Otro").checked, true);
    eq("...naming the namespace, since that is the answer",
       ide.namespaceOption("Widgets/Otro").namespace, "Widgets");
    check("...and saying so where the name is typed",
          ide.namespaceOption("Widgets/Otro").text.includes("Widgets"),
          ide.namespaceOption("Widgets/Otro").text);
    /* Read from the neighbours' code and not from the folder's name, which is
     * the whole of the rule: a folder called Widgets whose classes said Parts
     * would answer Parts. */
    eq("the namespace of a folder is what its classes declare",
       ide.namespaceHere("Widgets"), "Widgets");
    eq("and a folder whose classes declare none has none",
       ide.namespaceHere("Suelto"), "");

    eq("so the next class there needs no flag", ide.createForm("Widgets/Segundo"), true);
    yield;
    eq("and joins the namespace anyway",
       ide.qualifiedName("Widgets/Segundo.form"), "Widgets.Segundo");

    /* The point of namespaces: the same short name in another folder is another
     * class, and both may exist. */
    eq("the same short name in another namespace is allowed",
       ide.createForm("Otros/Marco", "Form", "Otros"), true);
    yield;
    check("and it is a class of its own",
          ide.classExists("Otros.Marco") && ide.classExists("Widgets.Marco"),
          JSON.stringify(ide.classNames()));

    /* What is still refused is what the runtime could not tell apart. */
    eq("but the very same qualified name is refused",
       ide.createForm("Otros/Marco", "Form", "Otros"), false);
    eq("a path that climbs out of the project is refused",
       ide.createForm("../fuera/Marco2"), false);

    /* A new name is suggested in the folder being worked in, and it is free as
     * a class -- namespace included. */
    ide.openNamed("Widgets/Marco.form");
    yield;                 // let GTK allocate the design area
    check("the suggested name follows the open file",
          ide.suggestFormName().startsWith("Widgets/"), ide.suggestFormName());

    /* Double click still writes into the .js beside the form. */
    ide.openNamed("Widgets/Marco.form");
    yield;                 // let GTK allocate the design area
    palette(ide, "Button").Click();
    const folderBtn = ide.designer.selected;

    /* Where it is drawn, once it is drawn: a control created a moment ago has
     * no layout yet, and a double click on nothing opens the form's own event
     * instead of the button's. */
    yield* until(() => ide.designer.rectOf(folderBtn).w > 0);
    ide.BtnSave_Click();

    const btnAt = ide.designer.rectOf(folderBtn);
    ide.Glass_DblClick(btnAt.x + 4, btnAt.y + 4);

    eq("the handler went to the code beside the form", ide.activeFile, "Widgets/Marco.js");
    const handlerJs = File.Load(File.Join(TMP, "Widgets", "Marco.js"));
    check("and was written there",
          handlerJs.includes(`${folderBtn.Name}_Click`), handlerJs);
    check("inside the namespaced class, which is still valid",
          parses(handlerJs), handlerJs);

    /* Renaming: a bare name keeps the folder, and so the namespace. */
    ide.openNamed("Widgets/Marco.form");
    yield;                 // let GTK allocate the design area
    eq("renaming keeps the folder", ide.renameForm("Widgets.Marco", "Cuadro"), true);
    check("both files moved inside it",
          File.Exists(File.Join(TMP, "Widgets", "Cuadro.form")) &&
          File.Exists(File.Join(TMP, "Widgets", "Cuadro.js")) &&
          !File.Exists(File.Join(TMP, "Widgets", "Marco.form")));
    check("and sources followed",
          JSON.parse(File.Load(File.Join(TMP, "project.json")))
              .sources.includes("Widgets/Cuadro.js"));
    eq("the class kept its namespace",
       JSON.parse(File.Load(File.Join(TMP, "Widgets", "Cuadro.form"))).class,
       "Widgets.Cuadro");
    check("and so did its code",
          File.Load(File.Join(TMP, "Widgets", "Cuadro.js"))
              .includes("Widgets.Cuadro = class Cuadro"),
          File.Load(File.Join(TMP, "Widgets", "Cuadro.js")));

    /*
     * **A path in the rename moves the file and leaves the namespace alone.**
     *
     * It used to move it between namespaces, rewriting the class's own source to
     * match the new folder -- so dragging a file in the tree renamed a class and
     * every `.form` that placed it. A namespace is what the code declares, and a
     * file operation is not a way to declare anything: the class stays
     * `Widgets.Cuadro` in `Paneles/`, which reads oddly for exactly one second
     * and is the truth. Changing it is an edit to the `Namespace(...)` line.
     */
    eq("a path in the rename moves it",
       ide.renameForm("Widgets.Cuadro", "Paneles/Cuadro"), true);
    check("to the new folder",
          File.Exists(File.Join(TMP, "Paneles", "Cuadro.form")) &&
          File.Exists(File.Join(TMP, "Paneles", "Cuadro.js")));
    check("leaving the old one behind",
          !File.Exists(File.Join(TMP, "Widgets", "Cuadro.form")));
    check("with sources pointing at the move",
          JSON.parse(File.Load(File.Join(TMP, "project.json")))
              .sources.includes("Paneles/Cuadro.js"));

    const movedJs = File.Load(File.Join(TMP, "Paneles", "Cuadro.js"));
    check("the declaration did not move with the file",
          movedJs.includes('Namespace("Widgets")') && !movedJs.includes('"Paneles"'),
          movedJs);
    check("and neither did the assignment",
          movedJs.includes("Widgets.Cuadro = class Cuadro"), movedJs);
    check("still valid JavaScript", parses(movedJs), movedJs);
    eq("the .form still names the class it is",
       JSON.parse(File.Load(File.Join(TMP, "Paneles", "Cuadro.form"))).class,
       "Widgets.Cuadro");
    check("the namespace it was in is where the tree still files it",
          ide.FileTree.Exists("ns:Widgets"));
    check("and the folder it moved into is not a namespace",
          !ide.FileTree.Exists("ns:Paneles"));
    /* The folder is drawn as a folder in the *other* view -- which is the point:
     * a folder is where a file sits and a namespace is what a class is in, and
     * moving the file changed only the first. */
    eq("the class is what it always was", ide.qualifiedName("Paneles/Cuadro.form"),
       "Widgets.Cuadro");

    /* The tree is built from what the code says, so a namespace nobody is in
     * any more is not a node any more. Two classes are in `Widgets` now -- the
     * one that moved kept it -- so both have to go. */
    eq("removing one class of a namespace succeeds",
       ide.deleteFiles(ide.pairOf("Widgets/Segundo.form")), true);
    check("and the namespace stays while a class is still in it",
          ide.FileTree.Exists("ns:Widgets"));
    eq("removing the last one succeeds too",
       ide.deleteFiles(ide.pairOf("Paneles/Cuadro.form")), true);
    check("and the namespace goes with it",
          !ide.FileTree.Exists("ns:Widgets"));
    check("and so does the folder it was in, which is now empty",
          !ide.FileTree.Exists("dir:Widgets"));

    /* A component in a folder is a component all the same, and the palette
     * offers it by the name a .form will use. */
    eq("a component can live in a folder",
       ide.createForm("Partes/Chip", "Component", "Partes"), true);
    yield;
    check("the palette offers it by its qualified name",
          palette(ide, "Partes.Chip") !== undefined,
          JSON.stringify(Dictionary.Keys(ide.palette.buttons)));
    check("and the tree files it as a component of its namespace",
          ide.FileTree.Exists("cat:components:ns:Partes"));

    /* Placing a component has to leave a project that loads its class: whoever
     * edited "sources" by hand did not know a form was about to name it. */
    ide.dropSource("Partes/Chip.js");
    check("the source was dropped for the test",
          !JSON.parse(File.Load(File.Join(TMP, "project.json")))
               .sources.includes("Partes/Chip.js"));

    ide.openNamed("Refactor.form");
    yield;                 // let GTK allocate the design area
    palette(ide, "Partes.Chip").Click();
    yield;                 // a just-created control has no layout until the next frame

    check("placing a component registers its class again",
          JSON.parse(File.Load(File.Join(TMP, "project.json")))
              .sources.includes("Partes/Chip.js"));

    const chip = ide.designer.selected;
    eq("the control is named after the class, not the namespace", chip.Name, "Chip1");
    eq("but it stands in for the qualified type", chip.__node.type, "Partes.Chip");

    ide.BtnSave_Click();
    const chipNode = JSON.parse(File.Load(File.Join(TMP, "Refactor.form")))
                         .children.find((c) => c.name === "Chip1");
    eq("and the .form says the qualified type", chipNode.type, "Partes.Chip");

    /*
     * **Moving that component changes no name at all**, so there is nothing for
     * the form using it to follow. That is the difference between a move and a
     * rename now: a rename changes the class and every `.form` naming it is
     * rewritten; a move puts the same class in another directory.
     */
    eq("moving the component succeeds",
       ide.renameForm("Partes.Chip", "Otras/Chip"), true);
    const followed = JSON.parse(File.Load(File.Join(TMP, "Refactor.form")))
                         .children.find((c) => c.name === "Chip1");
    eq("and the form that places it needed no rewrite", followed.type, "Partes.Chip");
    eq("because the class is where its code put it, wherever the file is",
       ide.qualifiedName("Otras/Chip.form"), "Partes.Chip");

    /* --- tidying a project that was written before the convention -----------
     *
     * The folders arrived after this IDE had written a great many flat
     * projects, and they only ever applied to what was created next -- so a
     * project from before stayed thirty-five files in one directory, which is
     * the shape the convention exists to prevent.
     *
     * In a project of its own, because tidying moves everything: one written
     * the old way, which is exactly what this is for.
     */
    const FLAT = `${TMP}-flat`;
    removeTree(FLAT);
    Directory.Make(FLAT);

    File.SaveJson(File.Join(FLAT, "project.json"), {
        name: "flat", startup: "Main",
        sources: ["Util.js", "Chip.js", "Main.js"],
    });
    File.SaveJson(File.Join(FLAT, "Main.form"), {
        format: "bintana-form/1", class: "Main",
        properties: { Text: "Main", Width: 300, Height: 200 },
        children: [{ type: "Chip", name: "Chip1", properties: { X: 8, Y: 8 } }],
    });
    File.Save(File.Join(FLAT, "Main.js"), "class Main extends Form {\n}\n");
    File.SaveJson(File.Join(FLAT, "Chip.form"), {
        format: "bintana-form/1", class: "Chip",
        properties: { Width: 80, Height: 24 }, children: [],
    });
    File.Save(File.Join(FLAT, "Chip.js"), "class Chip extends Component {\n}\n");
    File.Save(File.Join(FLAT, "Util.js"), "class Util {\n}\n");
    File.Save(File.Join(FLAT, "app.css"), ".x { color: red; }\n");
    Directory.Make(File.Join(FLAT, "arte"));
    File.Save(File.Join(FLAT, "arte", "Suelto.js"), "class Suelto {\n}\n");

    openFresh(ide, FLAT);
    yield;

    const plan    = ide.tidyPlan();
    const planned = plan.map((m) => `${m.file}->${m.to}`);

    check("a form at the root is planned into forms/",
          planned.includes("Main.form->forms/Main"), JSON.stringify(planned));
    check("a component into components/",
          planned.includes("Chip.form->components/Chip"), JSON.stringify(planned));
    check("and a loose class into modules/",
          planned.includes("Util.js->modules/Util.js"), JSON.stringify(planned));

    check("a form's own .js is not planned twice: the pair moves as one",
          !planned.some((p) => p.startsWith("Main.js->")), JSON.stringify(planned));

    /*
     * **Only the root moves.** A file in a folder is where the programmer put
     * it, and `Widgets/Marco` is possibly `Widgets.Marco`: moving that would
     * rename the class, which is the IDE overruling a decision that was not
     * its to make. What is not a class file stays too -- the convention names
     * three kinds of class, not a place for everything.
     */
    check("what is already in a folder is left alone",
          !plan.some((m) => m.file.includes("/")), JSON.stringify(planned));
    check("and so is everything that is not a class",
          !planned.some((p) => p.startsWith("app.css")), JSON.stringify(planned));

    const flatFiles = ide.files.length;
    eq("every planned move is made", ide.tidy(plan), plan.length);
    yield;

    eq("and the project holds the same files", ide.files.length, flatFiles);
    check("the pair really moved, both halves",
          File.Exists(File.Join(FLAT, "forms", "Main.form")) &&
          File.Exists(File.Join(FLAT, "forms", "Main.js")) &&
          !File.Exists(File.Join(FLAT, "Main.form")));
    check("the component went to its own folder",
          File.Exists(File.Join(FLAT, "components", "Chip.form")));
    check("the loose class to modules/",
          File.Exists(File.Join(FLAT, "modules", "Util.js")));
    check("and what was in a folder of its own did not move",
          File.Exists(File.Join(FLAT, "arte", "Suelto.js")));

    const loads = JSON.parse(File.Load(File.Join(FLAT, "project.json"))).sources;
    check("sources followed: nothing it loads is at the root any more",
          !loads.some((f) => !f.includes("/")), JSON.stringify(loads));

    /* The name does **not** change: a folder a tool named is not a namespace,
     * which is what makes tidying safe to offer at all. */
    eq("the class is the name it always had",
       JSON.parse(File.Load(File.Join(FLAT, "forms", "Main.form"))).class, "Main");
    eq("so the startup form still names something",
       JSON.parse(File.Load(File.Join(FLAT, "project.json"))).startup, "Main");
    check("and the form placing the component still names it right",
          JSON.parse(File.Load(File.Join(FLAT, "forms", "Main.form")))
              .children[0].type === "Chip");

    eq("tidying again has nothing to do", ide.tidyPlan().length, 0);

    openFresh(ide, TMP);
    yield;
    removeTree(FLAT);

    /* --- a module: one class, one file, no window --------------------------
     *
     * The third thing a project is made of, and the only one that had no menu
     * item: a form and a component are two files each and the IDE wrote them
     * both, while a plain class was "make a file, then remember to put it in
     * `sources`" -- the step that is forgotten, and the failure that follows is
     * `X is not defined` at run time, far from the omission.
     */
    /* Beside whatever is open, which is the rule for all three; the folder
     * convention is the answer when there is nothing to be beside. */
    eq("with nothing open a module goes to modules/",
       ide.suggestFormName("Module"), "modules/Module1");

    ide.openNamed("Otras/Chip.form");
    yield;
    eq("and beside the file being worked on when there is one",
       ide.suggestFormName("Module"), "Otras/Module1");

    ide.closeAllTabs();
    yield;

    eq("a module can be created", ide.createModule("modules/Herramienta"), true);
    yield;

    const modFile = "modules/Herramienta.js";
    check("beside the other two conventions",
          File.Exists(File.Join(TMP, modFile)),
          JSON.stringify(ide.files));

    const modSource = File.Load(File.Join(TMP, modFile));
    eq("and it extends nothing, being neither a window nor a control",
       modSource, "class Herramienta {\n\n}\n");
    check("it is valid JavaScript", parses(modSource), modSource);

    check("the project loads it, which is the half nobody remembers",
          JSON.parse(File.Load(File.Join(TMP, "project.json")))
              .sources.includes(modFile));
    eq("and it opens in a tab", ide.activeFile, modFile);
    check("with no .form beside it", !File.Exists(File.Join(TMP, "modules/Herramienta.form")));

    eq("the same name twice is refused", ide.createModule("modules/Herramienta"), false);
    eq("nor one that is not a class name", ide.createModule("3d"), false);

    /* A folder in the name works the way it does everywhere else here -- and the
     * namespace is named rather than taken from the folder. */
    eq("a module can be created in a folder",
       ide.createModule("Lib/Auxiliar", "Auxiliares"), true);
    yield;
    const nsSource = File.Load(File.Join(TMP, "Lib", "Auxiliar.js"));
    check("and joins the namespace it was given, which is not the folder's name",
          nsSource.includes('Namespace("Auxiliares")') &&
          nsSource.includes("Auxiliares.Auxiliar = class Auxiliar {"), nsSource);
    check("still valid JavaScript", parses(nsSource), nsSource);

    ide.closeTabByName(modFile, true);
    File.Delete(File.Join(TMP, modFile));
    File.Delete(File.Join(TMP, "Lib", "Auxiliar.js"));
    Directory.Delete(File.Join(TMP, "Lib"));
    ide.dropSource(modFile);
    ide.dropSource("Lib/Auxiliar.js");
    ide.listFiles();
    yield;

    /*
     * **And a folder a tool named needs no exception any more.**
     *
     * `forms/`, `components/` and `modules/` are the IDE's own doing, and while a
     * folder's name was a namespace they had to be exempted from it -- or tidying
     * a project renamed somebody's class to `components.Chip` and rewrote every
     * `.form` that placed one. That exemption is gone with the rule that needed
     * it: no folder names a namespace, so there is nothing to exempt, and moving
     * a file into `components/` is a move like any other.
     */
    eq("moving into a folder the tool named succeeds",
       ide.renameForm("Partes.Chip", "components/Chip"), true);

    const tidied = File.Load(File.Join(TMP, "components", "Chip.js"));
    check("and the class is untouched -- neither renamed nor stripped",
          tidied.includes('Namespace("Partes")') &&
          tidied.includes("Partes.Chip = class Chip"), tidied);
    eq("the .form says the same",
       JSON.parse(File.Load(File.Join(TMP, "components", "Chip.form"))).class,
       "Partes.Chip");
    eq("and the form placing it was left alone",
       JSON.parse(File.Load(File.Join(TMP, "Refactor.form")))
           .children.find((c) => c.name === "Chip1").type, "Partes.Chip");
    /* Nothing is offered there, and now for the ordinary reason: no class in that
     * folder is in a namespace... except the one just moved in, which is. */
    eq("what is offered there is what its own classes declare",
       ide.namespaceOption("components/Otro").namespace, "Partes");

    /* Deleting a pair inside a folder takes both files and its source entry. */
    ide.openNamed("Paneles/Cuadro.form");
    yield;                 // let GTK allocate the design area
    eq("deleting a foldered pair succeeds",
       ide.deleteFiles(ide.pairOf("Paneles/Cuadro.form")), true);
    check("both files are gone",
          !File.Exists(File.Join(TMP, "Paneles", "Cuadro.form")) &&
          !File.Exists(File.Join(TMP, "Paneles", "Cuadro.js")));
    check("and so is its source entry",
          !JSON.parse(File.Load(File.Join(TMP, "project.json")))
               .sources.includes("Paneles/Cuadro.js"));
    /* --- what the IDE writes has to run --------------------------------------
     *
     * The component tests above prove the files round-trip through the designer.
     * This is the other half, and the one that matters: the child project really
     * starts below, loading the form the IDE wrote -- so if a component placed
     * from the palette were saved wrong, the child would fail to open its form
     * and neither its output nor a clean exit would arrive.
     */
    eq("a component can be created in the child project",
       ide.createForm("parts/Badge", "Component", "parts"), true);
    yield;

    ide.openNamed("Tabs.form");
    yield;                 // let GTK allocate the design area

    const badge = palette(ide, "parts.Badge");
    check("the new component reaches the palette", badge !== undefined,
          JSON.stringify(Dictionary.Keys(ide.palette.buttons)));

    badge.Click();
    yield;                 // a just-created control has no layout until the next frame
    ide.BtnSave_Click();

    const runnable = JSON.parse(File.Load(File.Join(TMP, "Tabs.form")));
    check("and the startup form carries it",
          runnable.children.some((c) => c.type === "parts.Badge"),
          JSON.stringify(runnable.children.map((c) => c.type)));
    check("with its class registered to load, folder and all",
          JSON.parse(File.Load(File.Join(TMP, "project.json")))
              .sources.includes("parts/Badge.js"));

}

/*
 * Resources: design values in the property grid, and extraction over the whole
 * project.
 *
 * It runs late on purpose -- the phases are a narrative, and by now the project
 * has forms, a folder, a component and a menu bar, which is what makes an
 * extraction worth measuring at all.
 */
function* p_strings(ide) {
    /* --- design values in the grid --------------------------------------- */
    ide.FileTree.Key = "Tabs.form";
    yield* settled(ide);

    check("a form is open in the designer", ide.designing);

    const lbl = new Label();
    ide.designer.surface.Add(lbl);
    lbl.Name = "LblSample";
    lbl.Text = "{0} archivos";
    yield;
    ide.designer.select(lbl);
    yield* settled(ide);

    const grid = ide.designer.grid;

    /* Normal mode offers everything the control has. */
    check("the grid offers the geometry in normal mode",
          grid.propKeys.includes("X") && grid.propKeys.includes("Text"),
          JSON.stringify(grid.propKeys));

    ide.PropDesign.Active = true;
    ide.PropDesign_Click();

    /*
     * Design mode is about prose and nothing else: where a control sits *is* the
     * design, so a geometry has no design value to speak of.  And the rows come
     * from the runtime's own answer, never from a list of names in the IDE.
     */
    check("design mode offers only what holds prose",
          grid.propKeys.includes("Text") && grid.propKeys.includes("Tooltip") &&
          !grid.propKeys.includes("X") && !grid.propKeys.includes("Width"),
          JSON.stringify(grid.propKeys));
    eq("as many rows as the control declares",
       grid.propKeys.length, lbl.TextProperties().length);

    /* An empty field means "no design value", and the placeholder says what the
     * real one is -- which is what stops the two states looking alike. */
    eq("the field starts empty", grid.editors.Text.Text, "");
    eq("with the real value showing through it",
       grid.editors.Text.Placeholder, "{0} archivos");

    grid.editors.Text.Text = "12 archivos";
    grid.applyEditor("Text");
    yield* settled(ide);

    eq("a design value is what the canvas shows", lbl.Text, "12 archivos");
    eq("while the declared one is untouched", lbl.Declared("Text"), "{0} archivos");

    const node = ide.designer.nodeOf(lbl, true);
    eq("saving writes the real value to properties", node.properties.Text,
       "{0} archivos");
    eq("and the design value to its own block", node.design.Text, "12 archivos");

    /* Clearing it is the way back. */
    grid.editors.Text.Text = "";
    grid.applyEditor("Text");
    yield* settled(ide);
    eq("clearing puts the declared value back", lbl.Text, "{0} archivos");
    eq("and writes no design block", ide.designer.nodeOf(lbl, true).design,
       undefined);

    /* The sample button fills the field with literal words, so the file ends up
     * holding text rather than a token the loader would have to understand. */
    grid.pickSample("Text");
    ide.PropSample3_Click();          /* "Name" */
    yield* settled(ide);
    check("a sample fills the design value with real words",
          lbl.Text.length > 4 && lbl.Text !== "{0} archivos", lbl.Text);
    eq("and it is a design value like any other",
       ide.designer.nodeOf(lbl, true).properties.Text, "{0} archivos");

    /*
     * --- and the design value that is not prose ------------------------------
     *
     * A table's rows are **counted, not named**: there is no sentence that can
     * stand in for three rows, and a table with none draws as an empty box with
     * headings over it. `Count` is settable -- it is the on-demand mode -- so a
     * design value for it puts that many rows on the canvas and nothing in the
     * running application.
     *
     * It is also the one row in this mode that does not come from
     * `TextProperties()`, which is why the two claims above are asserted
     * together: a `Label` gets no number and a `TableView` does.
     */
    ide.designer.addControl("TableView");
    yield* settled(ide);

    const tbl = ide.designer.selected;
    tbl.Name    = "TblSample";
    tbl.Columns = [["Nombre", 120], ["Ciudad", 120]];
    yield* settled(ide);

    ide.PropDesign.Active = true;
    ide.PropDesign_Click();
    yield* settled(ide);

    check("a table offers the count beside its prose",
          grid.propKeys.includes("Count") && grid.propKeys.includes("Columns.Text"),
          JSON.stringify(grid.propKeys));
    check("and still not the geometry",
          !grid.propKeys.includes("X") && !grid.propKeys.includes("Height"),
          JSON.stringify(grid.propKeys));

    grid.editors.Count.Text = "3";
    grid.applyEditor("Count");
    yield* settled(ide);

    eq("the canvas draws that many rows", tbl.Count, 3);

    const tnode = ide.designer.nodeOf(tbl, true);
    eq("written into the design block", tnode.design.Count, 3);
    eq("as a number and not as its digits", typeof tnode.design.Count, "number");
    check("while properties says nothing about it",
          !("Count" in (tnode.properties || {})),
          JSON.stringify(tnode.properties));

    /* Refused where it is written, like any other value the grid cannot use:
     * what must not happen is `"tres"` reaching the loader. */
    grid.editors.Count.Text = "tres";
    grid.applyEditor("Count");
    yield* settled(ide);
    eq("nonsense leaves the count where it was", tbl.Count, 3);
    eq("and writes nothing", ide.designer.nodeOf(tbl, true).design.Count, 3);

    grid.editors.Count.Text = "";
    grid.applyEditor("Count");
    yield* settled(ide);
    eq("clearing takes the rows away again", tbl.Count, 0);

    tbl.Delete();
    yield* settled(ide);

    /*
     * --- and what a list holds while it is being drawn -----------------------
     *
     * A list is filled by the program, so in a designer it is an empty box and a
     * form is laid out *around* one. `item` names a component and how many of it
     * to draw: Android's `tools:listitem`, pointing at a class rather than at a
     * layout file, which is what lets the form's own code build the same thing.
     *
     * Not a design *value*: a key that is not a property makes `AddNode` throw
     * and the control falls back to a stand-in, so it is a node key of its own
     * beside `design` -- the shape `strip` already has.
     */
    File.Save(File.Join(TMP, "Chip.js"),
              "class Chip extends Component {\n}\n");
    File.SaveJson(File.Join(TMP, "Chip.form"), {
        format: "bintana-form/1", class: "Chip",
        properties: { Width: 180, Height: 34, Arrangement: "Horizontal" },
        children: [
            { type: "Label", name: "ChipName",
              properties: { Width: 110, Height: 20, Text: "Ana María" } },
        ],
    });
    ide.listFiles();
    yield* settled(ide);

    ide.designer.addControl("RowList");
    yield* settled(ide);

    const list = ide.designer.selected;
    list.Name = "LstSample";
    yield* settled(ide);

    check("a list offers an item to draw, and a label does not",
          grid.propKeys.includes("Item.of") && grid.propKeys.includes("Item.count"),
          JSON.stringify(grid.propKeys));
    check("the component is picked from a list and not spelled",
          grid.editors["Item.of"].Items.includes("Chip"),
          JSON.stringify(grid.editors["Item.of"].Items));
    eq("and the count shows what it draws when the file does not say",
       grid.editors["Item.count"].Placeholder, "3");

    grid.editors["Item.of"].Text = "Chip";
    grid.applyEditor("Item.of");
    yield* settled(ide);

    eq("choosing one draws that many rows", list.Children.length, 3);
    eq("each built from the component's own .form",
       list.Children[0].Children[0].Text, "Ana María");

    grid.editors["Item.count"].Text = "5";
    grid.applyEditor("Item.count");
    yield* settled(ide);
    eq("and the count redraws them", list.Children.length, 5);

    /*
     * The rows are the designer's, so nothing that walks the form may see them:
     * not the control tree, not a click, and above all not the file.
     */
    const walked = ide.designer.allControls().map((c) => c.Name);
    check("the rows are not controls of the form",
          walked.includes("LstSample") && !walked.includes("ChipName"),
          JSON.stringify(walked));

    const where = ide.designer.rectOf(list);
    const hit   = ide.designer.hitTest(where.x + 8, where.y + 8);
    eq("and clicking one means the list", hit && hit.Name, "LstSample");
    neq("...which PickAt on its own does not answer",
        ide.designer.surface.PickAt(where.x + 8, where.y + 8).Name, "LstSample");

    const lnode = ide.designer.nodeOf(list, true);
    eq("saving writes the item", JSON.stringify(lnode.item),
       JSON.stringify({ of: "Chip", count: 5 }));
    check("and not one of the rows", !lnode.children,
          JSON.stringify(lnode.children));

    /* Clearing the name takes the drawing away and the key with it. */
    grid.editors["Item.of"].Text = "";
    grid.applyEditor("Item.of");
    yield* settled(ide);
    eq("clearing it empties the list", list.Children.length, 0);
    eq("and writes no item", ide.designer.nodeOf(list, true).item, undefined);

    list.Delete();
    File.Delete(File.Join(TMP, "Chip.js"));
    File.Delete(File.Join(TMP, "Chip.form"));
    ide.listFiles();

    ide.designer.select(lbl);
    yield* settled(ide);

    ide.PropDesign.Active = false;
    ide.PropDesign_Click();
    check("back in normal mode the whole grid is offered again",
          grid.propKeys.includes("X"), JSON.stringify(grid.propKeys));

    lbl.Delete();
    ide.designer.select(null);
    yield* settled(ide);

    /* --- extraction ------------------------------------------------------ */

    /*
     * A form and a source file with one of each thing the extractor is supposed
     * to find, and one of each thing the lint is supposed to complain about.
     *
     * Planted here rather than asserted against what earlier phases built: those
     * are a narrative and their captions are theirs to change, and a test that
     * reaches into them breaks for reasons that have nothing to do with it.
     */
    File.SaveJson(File.Join(TMP, "Strings.form"), {
        format: "bintana-form/1", class: "Strings",
        properties: { Text: "a window title" },
        menus: [{ name: "MnuS", text: "a menu", children: [
            { name: "MnuS1", text: "a menu item" }] }],
        children: [
            { type: "Label", name: "L", properties: { Text: "a caption" },
              design: { Text: "a sample nobody translates" } },
            { type: "ComboBox", name: "C", properties: { Items: ["one", "two"] } },
            { type: "TextBox", name: "T",
              properties: { Placeholder: "a hint", Text: "" } },
            { type: "SourceEditor", name: "E",
              properties: { Text: "not prose at all" } },
            /* A control of the project's own.  Its caption sits *here*, in the
             * form holding it, where nothing but the component's own class can
             * say the string is prose and the other one is a keyword. */
            { type: "Marca", name: "M",
              properties: { Caption: "a component caption", Kind: "Right" } },
        ],
    });

    File.SaveJson(File.Join(TMP, "Marca.form"), {
        format: "bintana-form/1", class: "Marca", properties: { Width: 80, Height: 24 },
    });
    File.Save(File.Join(TMP, "Marca.js"), [
        'class Marca extends Component {',
        '    static TextProperties = ["Caption"];',
        '    static Options        = { Kind: ["Left", "Right"] };',
        '',
        '    get Caption()  { return this._c || ""; }',
        '    set Caption(v) { this._c = String(v); }',
        '    get Kind()  { return this._k || "Left"; }',
        '    set Kind(v) { this._k = String(v); }',
        '}',
    ].join("\n"));

    /* The extractor walks the disk, but what a class declares comes from the
     * last listing -- so the project has to have been read since. */
    ide.listFiles();

    File.Save(File.Join(TMP, "Strings.js"), [
        '"use strict";',
        'class Strings {',
        '    a() { return Locale.Text("plain one"); }',
        '    b() { return Locale.Text("with {0} hole", 1); }',
        '    c() { return Locale.Plural("{0} file", "{0} files", 2); }',
        '    d() { return Locale.Context("verb", "Open"); }',
        '    e() { Message.Info("a message"); }',
        '    f() { Message.Error("cannot open {0}", "x"); }',
        '    g() { Message.Info(`punctuation ${1}: ${2}`); }',
        '    h() { Message.Info(`prose about ${1} here`); }',
        '    i() { this.Lbl.Text = "escaped caption"; }',
        '    j() { this.Lbl.Style = "heading"; }',
        '}',
    ].join("\n"));

    const found = ide.strings.collect();
    const ids   = found.map((e) => e.msgid);

    /*
     * **Extraction knows nothing about catalogues**, which is why it is a class
     * of its own: what comes out of here is a list of entries, and what a `.po`
     * does with them -- the header, the plural rules, the quoting, msgmerge --
     * is `Translations`. There is no `po/` in this project yet and this answers
     * anyway; the two meet in `update()` below and nowhere else.
     */
    check("what the project says is answered with no catalogue in sight",
          found.length > 0 && !File.IsDir(File.Join(TMP, "po")),
          `${found.length} strings`);

    check("a declared caption is extracted", ids.includes("a caption"),
          JSON.stringify(ids.slice(-14)));
    check("and a window title", ids.includes("a window title"));
    check("and a menu label, at both levels",
          ids.includes("a menu") && ids.includes("a menu item"));
    check("and every entry of a list of strings",
          ids.includes("one") && ids.includes("two"));
    check("and a placeholder", ids.includes("a hint"));

    /*
     * The one string in that form no list of widget types could reach: it
     * belongs to a class of the project, and only that class can say it is
     * prose.  `Kind` is the reason it has to be said rather than guessed --
     * collecting every string of a type nobody vouched for is how a keyword
     * ends up in front of a translator.
     */
    check("a component's declared caption is extracted",
          ids.includes("a component caption"), JSON.stringify(ids.slice(-14)));
    check("and a value of its own is not, being no more prose than an enum's",
          !ids.includes("Right"), JSON.stringify(ids));
    check("and a Locale.Text literal", ids.includes("plain one"));
    check("and one with a hole in it", ids.includes("with {0} hole"));
    check("and a message, which needs no helper", ids.includes("a message"));
    check("and a message with arguments", ids.includes("cannot open {0}"));

    const plural = found.find((e) => e.msgid === "{0} file");
    check("a plural carries both forms", plural && plural.plural === "{0} files",
          JSON.stringify(plural));

    const ctxt = found.find((e) => e.ctxt === "verb");
    check("a context is kept as one", ctxt && ctxt.msgid === "Open",
          JSON.stringify(ctxt));

    /*
     * The two negative cases, which are the point of asking the runtime instead
     * of matching names.
     */
    check("a design value is never offered to a translator",
          !ids.includes("a sample nobody translates"), JSON.stringify(ids));
    check("nor a SourceEditor's source text, because its class says it is not prose",
          !ids.includes("not prose at all"), JSON.stringify(ids));
    check("nor a Style that happens to look like prose",
          !ids.includes("heading"), JSON.stringify(ids));

    /* Every entry says where it came from, which is what a translator reads. */
    const first = found.find((e) => e.msgid === "plain one");
    check("an entry records where it was found",
          first.where.some((w) => w.includes("Strings.js")),
          JSON.stringify(first.where));

    /* --- the lint -------------------------------------------------------- */
    const warned = ide.strings.warnings.join("\n");

    check("a template literal in a text position is reported",
          warned.includes("prose about") ||
          /template literal in Message\.Info/.test(warned), warned);
    check("but not one that is only punctuation around values",
          !warned.includes("punctuation"), warned);
    check("a caption assigned from code is reported",
          warned.includes("escaped caption"), warned);
    check("and a Style assigned from code is not prose and is left alone",
          !warned.includes("heading"), warned);

    /*
     * **And the IDE's own source passes the lint that finds a joined msgid.**
     * The lint existed and the IDE is not a project anybody extracts from here,
     * so four messages sat built with `+` out of two literals -- the id error in
     * New project and Project settings, a class name in the style editor, a
     * hint in the style list -- each in the catalogue as its first half, which
     * no translation can ever match.  Asked of the real `ide/`, file by file.
     */
    const ideDir = File.Join(Application.Directory, "..", "..", "ide");
    const own    = new Ide.Strings({ project: ideDir });
    for (const path of own.projectFiles(".js", ideDir)) own.fromSource(path);
    const joined = own.warnings.filter((w) => w.includes("two literals joined"));
    check("no message in the IDE is two literals joined", joined.length === 0,
          joined.join("\n"));

    /* --- the template ---------------------------------------------------- */
    ide.catalogues.update();
    yield* until(() => File.Exists(File.Join(TMP, "po",
                                             `${File.Name(TMP)}.pot`)));

    const pot = File.Load(File.Join(TMP, "po", `${File.Name(TMP)}.pot`));
    check("the template is a .po file", pot.includes('msgid ""') &&
          pot.includes("Plural-Forms:"), pot.slice(0, 120));
    check("with the strings in it", pot.includes('msgid "plain one"'), pot.slice(0, 400));
    check("plural entries get both forms and two empty slots",
          pot.includes('msgid_plural "{0} files"') && pot.includes('msgstr[1] ""'));
    check("a context is written as msgctxt", pot.includes('msgctxt "verb"'));
    check("and every entry says where it came from", pot.includes("#: Strings.js:"));

    /* --- the catalogues in the tree -------------------------------------- */

    /*
     * A catalogue belongs to the project, so the tree shows it -- and it is not
     * opened here, so selecting one must open no tab and launch nothing.
     * Selection moves with the arrow keys; a tree that spawned Poedit once per
     * row walked through would be unusable.
     */
    Directory.Make(File.Join(TMP, "po"));
    File.Save(File.Join(TMP, "po", "es.po"),
              'msgid ""\nmsgstr ""\n\nmsgid "a caption"\nmsgstr "un rótulo"\n');
    ide.listFiles();
    yield* settled(ide);

    check("a catalogue is listed in the tree",
          ide.FileTree.Exists("po/es.po"),
          JSON.stringify(Dictionary.Keys(ide.byKey).slice(0, 20)));

    /*
     * ...under a category and not under a folder node. `po/` is a place the
     * *runtime* looks in rather than a shape the programmer chose, so showing it
     * would be a folder holding one category and saying the same thing twice --
     * which is not what the tree shows a folder for.
     */
    check("without the folder it lives in, which says nothing the category does not",
          !ide.FileTree.Exists("dir:po"),
          JSON.stringify(Dictionary.Keys(ide.byKey).filter((k) => k.startsWith("dir:"))));
    check("and so is the template", ide.FileTree.Exists("po/Strings.pot") ||
          ide.FileTree.Exists(`po/${File.Name(TMP)}.pot`),
          JSON.stringify(Dictionary.Keys(ide.byKey)));

    const openBefore = ide.activeFile;
    ide.FileTree.Key = "po/es.po";              /* fires FileTree_Select */
    yield* settled(ide);

    eq("selecting one opens no tab", ide.activeFile, openBefore);
    eq("but it is what the tree menu will act on", ide.selectedCatalogue,
       "po/es.po");
    check("and the status bar names the gesture",
          ide.LblStatus.Text.includes("po/es.po") &&
          (ide.LblStatus.Text.includes("double click") ||
           ide.LblStatus.Text.includes("no translation editor")),
          ide.LblStatus.Text);
    check("the menu item follows the selection", ide.MnuFtTranslate.Enabled);

    /* Selecting anything else lets go of it, so the menu item can never act on a
     * catalogue that is no longer what the left button pointed at. */
    ide.FileTree.Key = "Tabs.form";
    yield* settled(ide);
    eq("selecting another file releases it", ide.selectedCatalogue, null);
    check("and the menu item goes with it", !ide.MnuFtTranslate.Enabled);

    /* --- the round trip, which is what protects the file ----------------- */

    /*
     * Read a catalogue and write it straight back: it has to come out the same.
     *
     * This is the assertion the editor rests on. A `.po` holds a translator's
     * work, most of it in things this IDE has no model for -- their notes, the
     * extractor's comments, the flags, the `#~` blocks a merge left behind. An
     * editor that drops one line of that destroys work silently, which is worse
     * than not editing at all.
     *
     * The real zz.po from tests/widgets is the input on purpose: one written by
     * hand, with a fuzzy entry, a context, three plural forms, escapes, a msgid
     * split over lines and an obsolete tail.
     */
    const sample = File.Absolute(
        File.Join(Application.Directory, "..", "widgets", "po", "zz.po"));

    check("the hand-written catalogue is where the round trip expects it",
          File.Exists(sample), sample);

    const trip = File.Join(TMP, "po", "trip.po");
    Locale.Write(trip, Locale.Read(sample));

    /*
     * *Nothing lost* is the claim, and it is the one that matters: every entry,
     * comment, flag and obsolete line has to come back.
     *
     * Byte-identical is a stronger claim than this keeps, and deliberately: a
     * value the file happened to split across quoted chunks for line length
     * comes back on one line, because the split is spelling and not content.
     * gettext's own tools re-wrap the same way. Asserting bytes would be
     * asserting a formatter nobody wrote.
     */
    eq("a catalogue survives being read and written back",
       JSON.stringify(Locale.Read(trip)), JSON.stringify(Locale.Read(sample)));

    /* And the spelling settles at once rather than drifting: a second pass is
     * the same file, so an editor cannot churn a diff every time it saves. */
    const once = File.Load(trip);
    Locale.Write(trip, Locale.Read(trip));
    eq("and writing it again changes not one byte", File.Load(trip), once);

    check("the comments stay attached to their own entry, not adrift",
          !once.includes("word twice, told apart by its context and not by a key.\n\n"),
          once.slice(once.indexOf("word twice"), once.indexOf("word twice") + 90));
    File.Delete(trip);

    /* --- the editor ------------------------------------------------------ */
    const po = PoForm.edit(ide, "po/es.po");
    yield* settled(ide);

    try {
        check("the editor lists the translatable entries",
              po.LstEntries.Count >= 1, `${po.LstEntries.Count}`);
        check("and not the header, which is nobody's to translate",
              !po.LstEntries.Items.some((t) => t.trim() === ""),
              JSON.stringify(po.LstEntries.Items));
        check("it counts what is left", po.LblCount.Text.includes("translated"),
              po.LblCount.Text);

        po.LstEntries.Index = 0;
        po.LstEntries_Select();
        yield;

        eq("selecting one shows its source", po.LblSource.Text, "a caption");
        eq("and its translation", po.boxes[0].box.Text, "un rótulo");

        /*
         * **And the box is the plain editor**, which is the whole reason
         * `TextEditor` exists as a control: a translation may have newlines and a
         * `TextBox` cannot hold one, so this form used to be the source editor
         * with `Language = ""`, `ShowLineNumbers = false` and `Wrap = true` --
         * three lines of apology that a plain `GtkTextView` is by default.
         * Asserted so the apology cannot come back as a `SourceEditor`.
         */
        check("the translation box is a plain TextEditor",
              po.boxes[0].box instanceof TextEditor &&
              !(po.boxes[0].box instanceof SourceEditor),
              po.boxes[0].box.constructor.name);
        eq("so it wraps, which is what prose in a narrow pane needs",
           po.boxes[0].box.Wrap, true);
        check("with one box, since it has no plural", !po.boxes[1] ||
              !po.boxes[1].box.Visible);

        /* Typing goes into the model, and the file is not touched until Save. */
        po.boxes[0].box.Text = "otro rótulo";
        po.formChanged(0);

        eq("an edit reaches the entry", po.entries[po.current].forms[0],
           "otro rótulo");
        check("and marks the window", po.dirty);
        check("without touching the file yet",
              !File.Load(File.Join(TMP, "po", "es.po")).includes("otro rótulo"));

        check("saving writes it", po.save());
        check("and the file has it now",
              File.Load(File.Join(TMP, "po", "es.po")).includes("otro rótulo"));
        check("and the window is clean again", !po.dirty);

        /* Fuzzy is an edit like any other, and it is what the runtime reads to
         * decide the entry is not to be shown. */
        po.ChkFuzzy.Active = true;
        po.ChkFuzzy_Click();
        check("the fuzzy flag reaches the entry",
              po.entries[po.current].flags.includes("fuzzy"));
        po.save();
        check("and the file", File.Load(File.Join(TMP, "po", "es.po"))
              .includes("#, fuzzy"));

        /* ...and the runtime agrees about what that means. */
        const reread = Locale.Read(File.Join(TMP, "po", "es.po"));
        check("which the reader gives back",
              reread.some((e) => (e.flags || []).includes("fuzzy")));

        po.ChkFuzzy.Active = false;
        po.ChkFuzzy_Click();
        po.save();

        /* The filter narrows to what is left to do, and must not lose the
         * selection out from under whoever is typing. */
        po.ChkTodo.Active = true;
        po.ChkTodo_Click();
        yield;
        check("the filter shows only what is unfinished",
              po.LstEntries.Count < po.entries.filter(
                  (e) => po.isTranslatable(e)).length,
              `${po.LstEntries.Count}`);
        po.ChkTodo.Active = false;
        po.ChkTodo_Click();

        /* An extraction over an open editor would put the entries it is holding
         * back over the merge, so it refuses instead. */
        check("a catalogue being edited blocks an update", PoForm.busy);

        /*
         * The X asks now, exactly as the Close button does -- it used to save
         * behind the translator's back, because a form could not refuse to
         * close and keeping the work was the better of two surprises.
         */
        po.dirty = true;
        const ask = po.Form_Close();
        check("a dirty catalogue refuses to close on its own", ask);
        check("and says which file", ask.LblMessage.Text.includes("es.po"),
              ask.LblMessage.Text);
        ask.BtnNo.Click();
        po.dirty = false;
    } finally {
        po.closing = true;
        po.Close();
    }
    yield* settled(ide);
    check("closing lets go of it", !PoForm.busy);

    /* --- starting one from the template ---------------------------------- */

    /*
     * A `.pot` is a template: every msgstr in it is empty by definition, so
     * there is nothing in it to edit.  What it is *for* is starting a
     * translation, and that is what activating one does -- which is also the
     * only way to get a first catalogue without another program installed.
     */
    const potFile = ide.catalogues.templateFile();
    check("the project has a template to start from", !!potFile, potFile);
    check("and the IDE knows it is not a translation",
          Ide.Translations.isTemplate(potFile) &&
          !Ide.Translations.isTemplate("po/es.po"));

    /* The header a new catalogue gets: its own language, and its own plural
     * rule -- which is a property of the language and cannot be worked out. */
    const potHead = Locale.Read(File.Join(TMP, potFile))
                          .find((e) => e.msgid === "").forms[0];

    const ruHead = ide.catalogues.header(potHead, "ru");
    check("a new header names the language", ruHead.includes("Language: ru"), ruHead);
    check("and carries that language's plural rule",
          ruHead.includes("nplurals=3"), ruHead);
    eq("which decides how many msgstr slots a plural gets",
       ide.catalogues.formCount(ruHead), 3);

    check("the exact locale beats its base",
          ide.catalogues.header(potHead, "pt_BR").includes("plural=(n > 1)"));
    check("and one nobody listed starts at the English rule",
          ide.catalogues.header(potHead, "xx").includes("nplurals=2"));
    check("without the template's own header being disturbed",
          potHead.includes("Project-Id-Version") &&
          ruHead.includes("Project-Id-Version"));

    /* Now the whole thing, driven the way a hand drives it: the menu item, the
     * dialog it raises, and the catalogue that comes out. */
    ide.selectedCatalogue = potFile;
    ide.MnuFtNewTranslation_Click();
    yield;

    const asking = ide.newTranslationAsk;
    check("the template asks which language", !!asking);

    /* A name the runtime could never match is refused where it is typed, not
     * discovered as a catalogue that silently never loads. */
    asking.TxtValue.Text = "Ruso";
    asking.accept();
    check("a name that is not a locale is refused",
          !File.Exists(File.Join(TMP, "po", "Ruso.po")));

    asking.TxtValue.Text = "ru";
    asking.accept();
    yield* settled(ide);

    const made = File.Join(TMP, "po", "ru.po");
    check("a catalogue is made from the template", File.Exists(made));

    const fresh = Locale.Read(made);
    const head  = fresh.find((e) => e.msgid === "");
    check("with its own language in the header",
          head.forms[0].includes("Language: ru"), head.forms[0]);
    check("and its own plural rule", head.forms[0].includes("nplurals=3"));

    check("every string of the template is in it",
          fresh.filter((e) => e.msgid).length > 3, `${fresh.length}`);
    check("and none of them is translated yet",
          fresh.filter((e) => e.msgid).every((e) => e.forms.every((f) => f === "")),
          JSON.stringify(fresh.filter((e) => e.msgid && e.forms.some((f) => f))));

    const manyForms = fresh.find((e) => e.plural !== undefined);
    if (manyForms) {
        eq("a plural entry gets one slot per form this language has",
           manyForms.forms.length, 3);
    }

    check("it shows up in the tree", ide.FileTree.Exists("po/ru.po"),
          JSON.stringify(Dictionary.Keys(ide.byKey).filter((k) => k.startsWith("po/"))));
    check("and it opens in the editor, not the template",
          PoForm.openFiles.includes("po/ru.po"), JSON.stringify(PoForm.openFiles));

    /* Twice over the same locale is refused rather than silently overwriting a
     * translator's file. */
    ide.MnuFtNewTranslation_Click();
    yield;
    const again = ide.newTranslationAsk;
    again.TxtValue.Text = "ru";
    again.accept();
    check("a locale that already has one is refused",
          Locale.Read(made).length === fresh.length);
    again.Close();

    for (const open of [...PoForm.openFiles]) {
        const w = PoForm.edit(ide, open);
        w.closing = true;
        w.Close();
    }
    yield* settled(ide);
    File.Delete(made);
    ide.listFiles();

    /* --- which program opens one ----------------------------------------- */
    eq("a command that is not installed is not chosen",
       Application.HasCommand("no-such-program-xyz"), false);
    check("and one that is, is", Application.HasCommand("sh"));
    check("an absolute path is answered about the file",
          Application.HasCommand("/bin/sh") &&
          !Application.HasCommand("/bin/no-such-thing"));

    const hadEditor = Settings.Get("translationEditor", "");
    try {
        Settings.Set("translationEditor", "sh");
        eq("a configured editor is used", ide.catalogues.editor(), "sh");

        /* The setting is a preference, not a promise about the disk: one that
         * has since been uninstalled falls back rather than failing. */
        Settings.Set("translationEditor", "no-such-program-xyz");
        check("an uninstalled one falls back to whatever is there",
              ide.catalogues.editor() !== "no-such-program-xyz",
              ide.catalogues.editor());
    } finally {
        Settings.Set("translationEditor", hadEditor);
    }

    /* Dropped again: the project has to stay runnable for the `running` phase,
     * and neither of these is in `sources`. */
    File.Delete(File.Join(TMP, "Strings.js"));
    File.Delete(File.Join(TMP, "Strings.form"));
}

function* p_settings(ide) {
    /* --- project.json as a record ------------------------------------------
     *
     * The manifest is a `ProjectFile`, so what it may say is declared in one
     * place instead of checked by whoever trips over it.  What is asserted here
     * is the wiring: a mutation goes through the record's setters, a key the
     * record does not describe survives being written back, and what is wrong
     * with a manifest is said once instead of found later.
     */
    const manifestPath = File.Join(TMP, "project.json");

    /* A key from a version this IDE does not know about.  Saving the file must
     * not be how a project loses it. */
    const manifest = File.LoadJson(manifestPath);
    manifest.somethingNewer = { keep: true };
    File.SaveJson(manifestPath, manifest);

    ide.registerSource("Zzz.js");
    const added = File.LoadJson(manifestPath);
    check("a mutation writes what it was asked to",
          added.sources.includes("Zzz.js"), JSON.stringify(added.sources));
    eq("and keeps the key it does not describe",
       JSON.stringify(added.somethingNewer), JSON.stringify({ keep: true }));

    /* Dropped again, or the project would list a file that is not there and
     * would stop being able to run -- which the end of this test needs. */
    ide.dropSource("Zzz.js");
    const shrunk = File.LoadJson(manifestPath);
    check("dropping one takes it out",
          !shrunk.sources.includes("Zzz.js"), JSON.stringify(shrunk.sources));
    eq("and still keeps the stranger",
       JSON.stringify(shrunk.somethingNewer), JSON.stringify({ keep: true }));

    /* A value the runtime would refuse never reaches the file. */
    const sound = File.Load(manifestPath);
    ide.withConfig((config) => { config.Name = ""; });
    eq("a refused assignment leaves the file exactly as it was",
       File.Load(manifestPath), sound);

    /* What is wrong with a manifest goes to the console: these are things to
     * fix, not a dialog to dismiss before working. */
    const said = [];
    const realLog = ide.log.bind(ide);
    ide.log = (text) => { said.push(text); realLog(text); };

    ide.reportProject();
    eq("a sound manifest says nothing", said.length, 0);

    File.SaveJson(manifestPath, { name: "child", startup: 42, sources: ["Main.js"] });
    ide.reportProject();
    ide.log = realLog;

    check("a broken one is reported, naming the field",
          said.some((t) => t.includes("Startup")), JSON.stringify(said));
    check("...and it is still openable, or nothing could fix it",
          ide.withConfig(() => false) !== null);

    /*
     * **A project starts at a form or at a function**, and the manifest record
     * is where "one of the two" is said, because no single field can say it.
     *
     * A console project -- `main`, no window -- is an ordinary project to the
     * IDE: it opens, it runs, and it must not be told it is missing a `startup`
     * it was never going to have. Declaring both is the interesting mistake:
     * it *looks* like a project that draws, and the runtime calls `main` and
     * never opens the form.
     */
    const complaints = (manifest) => {
        const heard = [];
        File.SaveJson(manifestPath, manifest);
        ide.log = (text) => heard.push(text);
        ide.reportProject();
        ide.log = realLog;
        return heard.join("");
    };

    eq("a console project is a project: nothing to report",
       complaints({ name: "child", main: "Main", sources: ["Main.js"] }), "");

    check("with neither, it is told what is missing",
          complaints({ name: "child", sources: ["Main.js"] }).includes("nothing to start"),
          complaints({ name: "child", sources: ["Main.js"] }));

    const both = complaints({ name: "child", startup: "Tabs", main: "Main",
                              sources: ["Main.js"] });
    check("with both, it is told which one wins",
          both.includes("main") && both.includes("never opens the form"), both);

    File.Save(manifestPath, sound);          /* back to the one that runs */

    /* --- the startup form: marked in the tree, chosen from it ---------------
     *
     * Which form the project starts at is a fact about the project that used to
     * live only in a key of a file. The tree marks it, and the tree's own menu is
     * where it is chosen -- which is where one is looking when the thought
     * arrives. Whether the mark is *drawn* is checked by hand; that the icon
     * exists on this desktop, and that choosing writes the right name, is here.
     */
    check("the marker resolves to an icon that renders",
          Application.HasIcon(ide.treeIcon("startup")), ide.treeIcon("startup"));

    /* Read rather than assumed: by this point the project has been renamed and
     * rewritten several times, and what it starts at now is whatever the last
     * section left. Restored at the end of the block, because the run at the end
     * of this file needs a startup that quits by itself. */
    const startedAt = ide.startupClass;
    const named     = File.LoadJson(manifestPath).name;
    check("the listing knows which class the project starts at",
          startedAt !== "" && ide.classExists(startedAt), startedAt);

    const otherClass = ide.files
        .filter((f) => File.IsExtension(f, "form"))
        .map((f) => ide.qualifiedName(f))
        .find((n) => n !== ide.startupClass);
    check("the project has another form to point at", !!otherClass, otherClass);

    const otherFile = ide.formOfClass(otherClass);
    ide.FileTree.Key = `form:${otherFile.slice(0, -".form".length)}`;
    yield;

    check("with that form open, choosing it is offered", ide.MnuFtStartup.Enabled);

    /* Left over from a project that used to be a console one: choosing a form
     * is choosing *against* it, and the IDE must not be the thing that writes a
     * manifest declaring both. */
    ide.withConfig((config) => { config.Main = "Main"; });
    ide.MnuFtStartup.Click();

    eq("choosing it writes it, by the name the runtime looks a class up by",
       File.LoadJson(manifestPath).startup, otherClass);
    check("and drops the main it would never have called",
          !File.LoadJson(manifestPath).main,
          JSON.stringify(File.LoadJson(manifestPath).main));
    eq("and the listing follows, so the mark moves", ide.startupClass, otherClass);

    /*
     * The item follows the file that is **open**, not the row under the pointer:
     * a right click does not move a TreeView's selection, so an item aiming at
     * that row would act on a different one. With something open that is not a
     * form, there is nothing to start at.
     */
    ide.FileTree.Key = "project.json";
    yield;
    eq("the manifest is not a form to start at", ide.MnuFtStartup.Enabled, false);
    check("...while renaming it still is", ide.MnuFtRename.Enabled);

    /*
     * And renaming from a menu renames the **file**.
     *
     * It did not: `renameSelected` was the name of two methods -- this one and the
     * one that renames the selected control -- so the later definition won, F2
     * renamed a control, and the file rename was unreachable. Every assertion
     * about renaming passed anyway, because they all call `renameForm` directly.
     * This drives the menu instead, which is the part that was broken.
     */
    ide.MnuRename.Click();
    const asked = ide.renamePrompt;
    check("F2 asks about the file", !!asked);
    eq("...and says which kind it is", asked.Text, "Rename file");
    eq("starting from the name it has", asked.TxtValue.Text, "project.json");
    check("Escape leaves it alone", asked.CancelButton === asked.BtnCancel);
    asked.CancelButton.Click();

    /* The canvas's own item is the other one, and they are two methods now. */
    check("the two renames are two methods, not one shadowing the other",
          ide.renameSelectedFile !== ide.renameSelectedControl);

    /*
     * --- the version, which is two answers and not one -----------------------
     *
     * `Application.Version` is what *this* project declares, read out of its
     * project.json by the runtime; `BTA_VERSION` is the runtime's own, out of the
     * one place CMakeLists declares it. Confusing them is what the About dialog
     * did until there was a field to read.
     */
    eq("the runtime reads the project's declared version",
       Application.Version, "9.9.9");
    check("which is not the runtime's own",
          Application.Version !== BTA_VERSION,
          `${Application.Version} vs ${BTA_VERSION}`);

    /* --- the project's own settings ----------------------------------------- */
    ide.MnuProjectSettings.Click();

    const pdlg = ide.projectEditor;
    check("the project dialog opens", !!pdlg);
    eq("showing the name it has",     pdlg.TxtPrName.Text, named);
    eq("and the version, which it now has a row for", pdlg.TxtPrVersion.Text,
       File.LoadJson(manifestPath).version || "");
    eq("and no application id, which this project does not declare",
       pdlg.TxtPrId.Text, "");
    eq("and where it starts",         pdlg.CmbPrStartup.Text, otherClass);
    check("offered as a choice among the project's classes",
          pdlg.CmbPrStartup.Count > 1, `${pdlg.CmbPrStartup.Count} classes`);

    /*
     * **What it starts at, before which one.**
     *
     * A project declares `startup` or `main` and never both, so the dialog asks
     * the kind first: two independent fields would let a manifest be written
     * from here that looks like it draws and does not. Switching the kind
     * changes what the name may be -- a form is one of the project's classes,
     * a `main` is a function the IDE never sees, so there is nothing to offer
     * and the field is what the person types.
     */
    eq("a project with a startup form says so", pdlg.CmbPrKind.Text, "a form");

    pdlg.CmbPrKind.Text = "a function";
    check("choosing a function puts the name in a field one can type in",
          pdlg.TxtPrMain.Visible && !pdlg.CmbPrStartup.Visible);
    eq("carrying the name across the switch", pdlg.TxtPrMain.Text, otherClass);

    pdlg.CmbPrKind.Text = "a form";
    check("choosing a form offers the project's classes again",
          pdlg.CmbPrStartup.Visible && !pdlg.TxtPrMain.Visible);
    eq("and it is still the one it was", pdlg.CmbPrStartup.Text, otherClass);

    /* It works on a copy, so Cancel costs nothing. */
    pdlg.TxtPrDesc.Text = "thrown away";
    pdlg.BtnPrCancel_Click();
    check("cancelling writes nothing",
          !File.Load(manifestPath).includes("thrown away"));

    /* The load order, which is the part of a manifest worth arranging. */
    ide.MnuProjectSettings.Click();
    const pd2  = ide.projectEditor;
    const listed = pd2.LstPrSources.Items;

    check("the list is the project's own order", listed.length > 1, listed.join(","));
    check("and arranging it is offered, since this project decides it",
          pd2.BtnPrUp.Enabled);
    check("so it is not asked to decide again", !pd2.BtnPrDecide.Enabled);

    pd2.LstPrSources.Index = 1;
    pd2.BtnPrUp_Click();
    eq("moving one up swaps it with the one above",
       pd2.LstPrSources.Items.join(","),
       [listed[1], listed[0]].concat(listed.slice(2)).join(","));
    eq("and what moved stays selected", pd2.LstPrSources.Index, 0);

    pd2.BtnPrCancel_Click();
    eq("cancelling leaves the order on disk alone",
       File.LoadJson(manifestPath).sources.join(","), listed.join(","));

    /* Accepting goes through the record, so a refused field never reaches the
     * file -- and the message names the field, because the record named it. */
    ide.MnuProjectSettings.Click();
    const pd3   = ide.projectEditor;
    const intact = File.Load(manifestPath);

    pd3.TxtPrName.Text = "";
    pd3.BtnPrOk_Click();
    eq("a required field refused leaves the file exactly as it was",
       File.Load(manifestPath), intact);

    /* And the new field is checked by the record with nothing added here: the
     * dialog assigns and reports whichever field refused. Free text, but not
     * unbounded -- 40 is what the record says a version may be. */
    pd3.TxtPrName.Text    = named;
    pd3.TxtPrVersion.Text = "v".repeat(41);
    pd3.BtnPrOk_Click();
    eq("a version longer than the record allows is refused too",
       File.Load(manifestPath), intact);
    pd3.BtnPrCancel_Click();

    ide.MnuProjectSettings.Click();
    const pd4 = ide.projectEditor;
    pd4.TxtPrDesc.Text = "the child project";
    pd4.TxtPrVersion.Text = "  2.5  ";
    pd4.TxtPrId.Text = "io.github.getbintana.IdeChild";
    pd4.CmbPrStartup.Text = startedAt;       /* back to the one that quits */
    pd4.BtnPrOk_Click();

    const onDisk = File.LoadJson(manifestPath);
    eq("accepting writes what was edited", onDisk.description, "the child project");
    eq("and the version, trimmed",         onDisk.version, "2.5");
    eq("and the application id with it",   onDisk.id, "io.github.getbintana.IdeChild");
    eq("and the startup with it",          onDisk.startup, startedAt);
    eq("the tree follows",                 ide.startupClass, startedAt);

    /*
     * --- the application info ------------------------------------------------
     *
     * The metainfo is part of the project and not of a packaging step: the
     * dialog writes a minimal one when there is none, its `<id>` and `<name>`
     * are the project's own, and what it does not model -- translations above
     * all -- is what the raw XML tab is for.
     */
    ide.MnuMetainfo.Click();
    yield;

    const mf = ide.metainfoEditor;
    check("the application info dialog opens", !!mf);
    if (mf) {
        const mpath = Metainfo.find(ide.project);
        check("and writes the file, named after the id",
              mpath !== null &&
              File.Name(mpath) === "io.github.getbintana.IdeChild.metainfo.xml",
              mpath);
        eq("showing the id project.json declares", mf.TxtId.Text,
           "io.github.getbintana.IdeChild");
        eq("and its name", mf.TxtName.Text, named);
        eq("with nothing to complain about yet", mf.LblProblem.Text, "");

        /* An empty summary is refused in the dialog -- the sentence is next to
         * the field, which is also what makes the refusal testable. */
        mf.TxtSummary.Text = "";
        mf.BtnSave_Click();
        check("an empty summary is refused", mf.Visible && mf.LblProblem.Text !== "",
              mf.LblProblem.Text);

        mf.TxtSummary.Text = "A child project for the tests";
        mf.TxtDesc.Text    = "First paragraph.\n\nSecond paragraph.";
        mf.TxtDevId.Text   = "io.github.getbintana";
        mf.TxtDevName.Text = "Bintana";
        mf.TxtHome.Text    = "https://github.com/getbintana/bintana";
        mf.TxtCats.Text    = "Development, Utility";
        mf.BtnSave_Click();
        yield;

        check("saving closes the dialog", !mf.Visible);

        const info = Metainfo.read(File.LoadXml(mpath));
        eq("the summary landed", info.Summary, "A child project for the tests");
        eq("both paragraphs, in order", info.Description,
           "First paragraph.\n\nSecond paragraph.");
        eq("the developer", info.DeveloperName, "Bintana");
        eq("and its id", info.DeveloperId, "io.github.getbintana");
        eq("the categories as they were typed", info.Categories,
           "Development, Utility");
        eq("and the manifest agrees with the file",
           Metainfo.problems(File.LoadXml(mpath), mpath,
                                 ide.manifest.read()).length, 0);

        /* A hand-edit that disagrees is what `problems` is for: the form writes
         * the identity on every save, so the two cannot drift while it is the
         * writer. */
        const drifted = File.LoadXml(mpath);
        drifted.Root.Find("name").Text = "Something Else";
        check("a name that disagrees with project.json is reported",
              Metainfo.problems(drifted, mpath, ide.manifest.read())
                  .some((p) => p.includes("project.json")));

        /* And the raw road: the file is in the tree and opens as XML, which is
         * where translations (`xml:lang`) and everything else live. */
        ide.openInTab(File.Name(mpath));
        yield;
        eq("the metainfo opens as a tab", ide.activeFile, File.Name(mpath));
        eq("with XML highlighting", ide.Editor.Language, "xml");

        /* A new id takes the file with it: a metainfo named after the old one
         * is one nothing looks for, and the `<id>` inside has to agree. */
        ide.MnuProjectSettings.Click();
        const pd5 = ide.projectEditor;
        pd5.TxtPrId.Text = "io.github.getbintana.IdeChild2";
        pd5.BtnPrOk_Click();
        yield;

        check("a new id moves the metainfo",
              !File.Exists(File.Join(ide.project,
                                     "io.github.getbintana.IdeChild.metainfo.xml")));
        const moved = Metainfo.find(ide.project);
        eq("to the name the new id wants", moved && File.Name(moved),
           "io.github.getbintana.IdeChild2.metainfo.xml");
        eq("with its <id> rewritten", moved && Metainfo.read(File.LoadXml(moved)).Id,
           "io.github.getbintana.IdeChild2");

        /* And back, so the rest of the run works on the project it knows. */
        ide.MnuProjectSettings.Click();
        const pd6 = ide.projectEditor;
        pd6.TxtPrId.Text = "io.github.getbintana.IdeChild";
        pd6.BtnPrOk_Click();
        yield;
        eq("and back again", File.Name(Metainfo.find(ide.project)),
           "io.github.getbintana.IdeChild.metainfo.xml");

        /* **The open tab followed both moves.** It was opened above, before
         * the id changed, and used to go on answering for the old path: saving
         * it wrote the old file back beside the new one. */
        const metaName = "io.github.getbintana.IdeChild.metainfo.xml";
        check("the metainfo's tab followed the file",
              ide.openTabs.has(metaName) &&
              !ide.openTabs.has("io.github.getbintana.IdeChild2.metainfo.xml"),
              JSON.stringify([...ide.openTabs.keys()]));
        ide.switchToTab(metaName);
        yield;
        check("and holds the text the rename wrote",
              ide.Editor.Text.includes("<id>io.github.getbintana.IdeChild</id>"),
              ide.Editor.Text.slice(0, 200));
        ide.MnuProjectSettings.Click();
        const pdId = ide.projectEditor;
        pdId.TxtPrId.Text = "io.github.getbintana.IdeChild3";
        pdId.BtnPrOk_Click();
        yield;
        ide.tabs.save();
        yield;
        check("so saving the tab writes the file where it is now, and no other",
              !File.Exists(File.Join(ide.project, metaName)) &&
              File.Exists(File.Join(ide.project, "io.github.getbintana.IdeChild3.metainfo.xml")),
              Directory.List(ide.project).join(", "));

        /* **A new name keeps `<name>` in step**, which `Package.Write` compares
         * with project.json and refused on. */
        ide.MnuProjectSettings.Click();
        const pdName = ide.projectEditor;
        pdName.TxtPrId.Text   = "io.github.getbintana.IdeChild";
        pdName.TxtPrName.Text = `${named}Renamed`;
        pdName.BtnPrOk_Click();
        yield;
        const afterName = Metainfo.find(ide.project);
        eq("a new project name reaches the metainfo's <name>",
           afterName && Metainfo.read(File.LoadXml(afterName)).Name, `${named}Renamed`);
        eq("so the two still agree",
           afterName && Metainfo.problems(File.LoadXml(afterName), afterName,
                                          ide.manifest.read()).join("; "), "");

        /* **A metainfo that cannot follow costs the settings nothing.** The
         * rename used to run first and throw on a file it could not parse, with
         * the dialog already closed -- losing every edit in it. The refusal is
         * a `Message.Error`, a modal nothing here dismisses, so it is caught
         * for the length of the gesture. */
        const saidErr  = [];
        const realErr  = Message.Error;
        const goodText = File.Load(afterName);
        File.Save(afterName, "<component><id>not closed");
        Message.Error = (...args) => { saidErr.push(Locale.Text(...args)); };
        try {
            ide.MnuProjectSettings.Click();
            const pdBad = ide.projectEditor;
            pdBad.TxtPrName.Text = named;
            pdBad.TxtPrDesc.Text = "edited over a broken metainfo";
            pdBad.BtnPrOk_Click();
            yield;
        } finally {
            Message.Error = realErr;
        }
        eq("an unreadable metainfo does not lose the settings",
           File.LoadJson(manifestPath).description, "edited over a broken metainfo");
        check("and says the metainfo could not follow",
              saidErr.some((m) => m.includes("could not follow")), JSON.stringify(saidErr));
        File.Save(afterName, goodText.replace(`${named}Renamed`, named));
        ide.tabs.reloadFromDisk(File.Name(afterName));
    }

    /*
     * Turning this project into a console one and back, through the dialog.
     *
     * The manifest must never end up with both keys -- that is the whole reason
     * the kind is asked -- so what is checked is the file: `main` written and
     * `startup` emptied, then the other way around.
     */
    ide.MnuProjectSettings.Click();
    const pd5 = ide.projectEditor;
    pd5.CmbPrKind.Text = "a function";
    pd5.TxtPrMain.Text = "Main";
    pd5.BtnPrOk_Click();

    const asConsole = File.LoadJson(manifestPath);
    eq("a project can be made a console one from the dialog", asConsole.main, "Main");
    check("and the form it used to open is gone with it",
          !asConsole.startup, JSON.stringify(asConsole.startup));

    ide.MnuProjectSettings.Click();
    const pd6 = ide.projectEditor;
    eq("reopening says what kind it now is", pd6.CmbPrKind.Text, "a function");
    eq("showing the function it calls", pd6.TxtPrMain.Text, "Main");

    pd6.CmbPrKind.Text = "a form";
    pd6.CmbPrStartup.Text = startedAt;
    pd6.BtnPrOk_Click();

    const backToForm = File.LoadJson(manifestPath);
    eq("and back again", backToForm.startup, startedAt);
    check("with the function dropped", !backToForm.main,
          JSON.stringify(backToForm.main));

    /*
     * --- the libraries it uses -----------------------------------------------
     *
     * `uses` was the one thing in a manifest that could only be written in a
     * text editor: the runtime resolved it, the palette offered what it found,
     * and nothing in the IDE could add one. What made it possible is the other
     * direction of the same lookup -- `Application.Libraries`, the same six
     * places `LibraryPath` searches, which is why the IDE still owns no copy of
     * that path.
     */
    ide.MnuProjectSettings.Click();
    const pd7    = ide.projectEditor;
    const boxes  = pd7.useBoxes;
    const offered = boxes.map((b) => b.Text);

    check("what ships with the runtime is offered",
          offered.includes("charts") && offered.includes("report"),
          offered.join(","));
    check("with nothing ticked in a project that uses none",
          boxes.every((b) => !b.Active));
    check("and each says where it is",
          boxes.every((b) => b.Tooltip.includes("/lib/")),
          boxes.map((b) => b.Tooltip).join(" | "));

    /* It is a copy until OK, like every other field here. */
    boxes.find((b) => b.Text === "charts").Active = true;
    eq("a tick lands in the record", pd7.record.Uses.join(","), "charts");
    pd7.BtnPrCancel_Click();
    check("and cancelling writes none of it",
          !(File.LoadJson(manifestPath).uses || []).length,
          JSON.stringify(File.LoadJson(manifestPath).uses));

    ide.MnuProjectSettings.Click();
    const pd8 = ide.projectEditor;
    pd8.useBoxes.find((b) => b.Text === "charts").Active = true;
    pd8.BtnPrOk_Click();
    yield* settled(ide);

    eq("accepting writes it to the manifest",
       (File.LoadJson(manifestPath).uses || []).join(","), "charts");
    /* The payoff, and the reason this is worth a dialog at all: the library's
     * components are on the palette from the moment the box is ticked. */
    check("and the library's components are on the palette",
          ide.components.some((c) => c.library === "charts"),
          ide.components.map((c) => `${c.library}:${c.name}`).join(","));

    /*
     * A project that names a library nothing here has. It is shown, ticked, and
     * says it is missing -- the same argument the startup drop-down makes for a
     * class that is gone: the project being opened to find out why it will not
     * run is exactly the one a list that quietly dropped it would fail.
     */
    ide.withConfig((config) => { config.Uses = ["charts", "nosuchlib"]; });
    ide.MnuProjectSettings.Click();
    const pd9  = ide.projectEditor;
    const gone = pd9.useBoxes.find((b) => b.Text.includes("nosuchlib"));

    check("one the machine does not have is still shown", !!gone,
          pd9.useBoxes.map((b) => b.Text).join(","));
    check("...ticked, because the project names it", gone && gone.Active);
    check("...and saying so rather than reading like the others",
          gone && gone.Text !== "nosuchlib", gone && gone.Text);
    eq("the ones in use come first, in the order they load",
       pd9.useBoxes[0].Text, "charts");

    gone.Active = false;
    pd9.BtnPrOk_Click();
    yield* settled(ide);
    eq("unticking takes it out and leaves the rest in order",
       (File.LoadJson(manifestPath).uses || []).join(","), "charts");

    /* Back to a project that uses nothing, which is what the phases after this
     * one built and run. */
    ide.MnuProjectSettings.Click();
    const pd10 = ide.projectEditor;
    pd10.useBoxes.find((b) => b.Text === "charts").Active = false;
    pd10.BtnPrOk_Click();
    yield* settled(ide);
    check("and a project can stop using one",
          !(File.LoadJson(manifestPath).uses || []).length,
          JSON.stringify(File.LoadJson(manifestPath).uses));
}

/*
 * The column editor.
 *
 * The property grid can already edit `Columns` -- it is an array, so it offers
 * the JSON -- and that is why this exists: a column carries a heading, a width
 * and an alignment, and typing the JSON is not editing. Delphi has a collection
 * editor for the same reason, WinForms a column dialog, Qt an item editor.
 *
 * Driven through the dialog's own buttons, not its methods: what is being tested
 * is that the buttons reach the list and that OK goes back through the property
 * the way a typed value would.
 */
function* p_columns(ide) {
    ide.openNamed("Refactor.form");
    yield* settled(ide);

    /* A table to configure, added the way the palette adds one. */
    const tab = ide.designer.surface.AddNode({
        type: "TableView", name: "Grid9",
        properties: { X: 20, Y: 20, Width: 240, Height: 120 },
    }, true);
    ide.designer.select(tab);
    yield* settled(ide);

    check("a TableView offers Columns in the grid",
          ide.designer.grid.propKeys.includes("Columns"),
          JSON.stringify(ide.designer.grid.propKeys));

    /*
     * **Opened the way the button inside the field opens it**, and not by
     * calling the dialog directly: what is under test is the property grid's
     * road -- the editor is filled in, applied through `applyEditor`, and lands
     * on the undo stack like any other edit. Driving `ColumnForm` by hand tested
     * the dialog and left that road uncovered, which is how the undo assertion
     * below came to be passing on entries an earlier phase had left behind.
     */
    const undoneAt = ide.designer.undoStack.length;

    ide.designer.grid.editColumns("Columns");
    const dlg = ide.columnEditor;
    yield;

    check("the button inside the field opens the editor", dlg !== undefined);

    eq("it opens on the columns there are", dlg.ColList.Count, 0);

    /*
     * The alignment words come from the runtime, and it matters that they are not
     * in the .form: `ComboBox.Items` is a *prose* property, so a translator would
     * have rendered them and this dialog would have written "Derecha" into a
     * property that only accepts "Right". The extractor caught it by collecting
     * three keywords as prose.
     */
    eq("the alignments are the runtime's own words",
       dlg.CmbColAlign.Items.join(","),
       new Label().PropertyOptions("Alignment").join(","));
    check("with nothing to edit until there is a column", !dlg.TxtColText.Enabled);
    check("and nothing to delete",                        !dlg.BtnColDel.Enabled);

    dlg.BtnColAdd_Click();
    yield;
    eq("adding one shows it", dlg.ColList.Count, 1);
    eq("named so the row is never blank", dlg.ColList.Cell(0, 0), "Column");
    check("and now the fields are live", dlg.TxtColText.Enabled);

    dlg.TxtColText.Text = "Name";
    dlg.TxtColText_Change();
    eq("typing a heading reaches the list", dlg.ColList.Cell(0, 0), "Name");

    dlg.SpnColWidth.Value = 200;
    dlg.SpnColWidth_Change();
    eq("and a width", dlg.ColList.Cell(0, 1), "200");

    dlg.BtnColAdd_Click();
    dlg.TxtColText.Text = "Balance";
    dlg.TxtColText_Change();
    dlg.CmbColAlign.Text = "Right";
    dlg.CmbColAlign_Select();
    eq("a second column, aligned", dlg.ColList.Cell(1, 2), "Right");
    eq("and the first is untouched", dlg.ColList.Cell(0, 0), "Name");

    /* Reordering, which is why the list is a list and not two fields. */
    dlg.BtnColUp_Click();
    eq("Up moves it above", dlg.ColList.Cell(0, 0), "Balance");
    check("and the selection follows what moved", dlg.picked === 0);
    check("so there is nothing above it now", !dlg.BtnColUp.Enabled);
    dlg.BtnColDown_Click();
    eq("Down puts it back", dlg.ColList.Cell(1, 0), "Balance");

    /* A column with no heading is the one thing the dialog refuses: the runtime
     * accepts it, and the result is a table with a blank header. */
    dlg.BtnColAdd_Click();
    dlg.TxtColText.Text = "   ";
    dlg.TxtColText_Change();
    dlg.BtnColOk_Click();
    check("a blank heading is refused, and the dialog stays open",
          ide.columnEditor === dlg && dlg.ColList.Count === 3);
    dlg.BtnColDel_Click();
    eq("deleting it leaves the two good ones", dlg.ColList.Count, 2);

    dlg.BtnColOk_Click();
    yield* settled(ide);

    /*
     * What went back through the property, and the shape of it: a default is
     * *not written*, which is the serialiser's own rule -- a column that says
     * nothing about its width must not carry `"Width": 0` into the .form.
     */
    const cols = tab.Columns;
    eq("accepting writes the columns", cols.length, 2);
    eq("the heading",  cols[0].Text, "Name");
    eq("the width",    cols[0].Width, 200);
    check("and no alignment on the one that did not ask",
          !("Alignment" in cols[0]), JSON.stringify(cols[0]));
    eq("the second's alignment", cols[1].Alignment, "Right");
    check("and no width on it", !("Width" in cols[1]), JSON.stringify(cols[1]));

    /* Through the property means through the undo stack, like any other edit --
     * counted from where this phase started, so a leftover entry from an
     * earlier one cannot answer for it. */
    eq("it is one undoable edit, and one",
       ide.designer.undoStack.length, undoneAt + 1);
    check("which can be undone", ide.designer.canUndo());

    tab.Delete();
    yield* settled(ide);
}

/*
 * Exporting the project as one .tar.
 *
 * **Nothing here opens the chooser.** A file dialog is a modal surface nothing
 * in JS can close, so one left open sits on top of whatever the next phase
 * measures -- which is how a green suite turns red in code nobody touched (see
 * AGENTS.md). But *not* driving the menu item is the other trap in that file:
 * the handler nobody reaches, which every test of the method under it passes.
 *
 * `Dialog` is an ordinary object on the global, so both are had at once: put a
 * double in `Dialog.SaveFile`, press the real item, and read back the exact
 * arguments the chooser would have been given. Better than a screenshot of one,
 * which can only be looked at.
 */
function* p_export(ide) {
    check("with a project open, exporting is offered", ide.MnuExport.Enabled);
    eq("and the archive is named after the project's folder",
       ide.exporter.name, File.Name(TMP));

    /* --- the menu item, through to what it would ask ----------------------- */
    const real  = Dialog.SaveFile;
    let   asked = null;
    Dialog.SaveFile = (title, opts, cb) => { asked = { title, opts, cb }; };
    try {
        ide.MnuExport_Click();
    } finally {
        /* Restored on the way out however that goes: a double left in place
         * would silently disarm every dialog in the phases after this one. */
        Dialog.SaveFile = real;
    }

    check("the item reaches the chooser", asked !== null);
    eq("with the project's name suggested", asked.opts.Name, `${File.Name(TMP)}.tar`);
    /* Beside the project, because `write` refuses inside it: opening there
     * would be offering a folder it will not accept. */
    eq("opening beside the project, not inside it",
       asked.opts.Folder, File.Directory(File.Absolute(TMP)));
    eq("and the first filter is the one it writes",
       asked.opts.Filters[0][1], "*.tar");

    /* --- the one it refuses ------------------------------------------------
     *
     * Inside the tree it archives. tar would not fail on this -- it skips the
     * file it is writing -- so nothing but a refusal keeps a source tree from
     * collecting one tar per export.
     */
    const inside = File.Join(TMP, "self.tar");
    ide.exporter.write(inside);
    check("an archive inside the project is refused", !File.Exists(inside),
          inside);

    /* --- and the one it writes --------------------------------------------
     *
     * Through the callback the chooser would have called, so what is exercised
     * is the whole path from the menu item down -- with the one modal surface
     * on it replaced by the answer a person would have given it.
     */
    const out = `${TMP}-export.tar`;
    if (File.Exists(out)) File.Delete(out);

    asked.cb(out);
    yield* until(() => File.Exists(out), 200);
    check("the archive is written", File.Exists(out), out);

    /*
     * Read back with tar itself, because the assertion that matters is about
     * what is *inside*: one directory named after the project and every member
     * under it. Handed the project's path instead of `-C parent name`, tar would
     * have stored the components leading to it and unpacking would spill a tree
     * over whoever's current directory -- and the archive would still exist, be
     * the right size, and read back fine. Only the member names say which of the
     * two was built.
     */
    const members = [];
    let listed    = null;
    Exec(["tar", "-tf", out], (line) => members.push(line),
                              (code) => { listed = code; });
    yield* until(() => listed !== null, 200);
    eq("and tar reads it back", listed, 0);

    const top = File.Name(TMP);
    check("every member is under one directory named after the project",
          members.length > 0 && members.every((m) => m.startsWith(`${top}/`)),
          JSON.stringify(members.slice(0, 4)));
    check("and the manifest is in there",
          members.includes(`${top}/project.json`),
          JSON.stringify(members.slice(0, 8)));

    /* --- the extension it supplies ----------------------------------------
     *
     * A chooser does not force one, and an archive not called .tar is a file
     * nothing recognises. A name that already has an extension keeps it.
     */
    const bare = `${TMP}-noext`;
    if (File.Exists(`${bare}.tar`)) File.Delete(`${bare}.tar`);
    ide.exporter.write(bare);
    yield* until(() => File.Exists(`${bare}.tar`), 200);
    check("a name with no extension gets .tar", File.Exists(`${bare}.tar`));
    check("and not the name as it was typed",   !File.Exists(bare));

    File.Delete(out);
    File.Delete(`${bare}.tar`);
}

/*
 * --- installing the project as a user application -------------------------
 *
 * One `.desktop` file in the user's own applications directory, which is how an
 * application reaches the menu with no root and no package.  The runner points
 * `XDG_DATA_HOME` at a scratch directory (tests/runner/Main.js), so the entry
 * installed here is not one anybody's menu will offer; driven by hand with
 * `tests/try.sh` there is no such promise, and this removes whatever it
 * installed either way.
 *
 * The runtime's half -- the format, the escaping, the refusals, and a real
 * `gio launch` reading the command back -- is `tests/widgets`' `Desktop` test.
 * What is here is the IDE's: the dialog, the id the entry is installed under,
 * an entry that points at **this** executable and **this** project, and finding
 * it again to update or remove.  Driven through the menu item, because that is
 * the road a person takes.
 *
 * **And there are two ids now, which is the one thing this phase asserts
 * twice.**  A project that declares an application id installs under it, and
 * the entry claims that id as `StartupWMClass` -- the window really is classed
 * by it.  A project that declares none installs under a slug of the name and
 * claims no class, because its window is `bintana`'s.  The dialog road below is
 * the first; the second is driven straight through `Ide.Apps`, since what
 * changes between them is only which string names the file.
 */
function* p_apps(ide) {
    const at = () => Ide.Apps.installed(ide.project);

    /* Not a state this phase may inherit: a previous run stopped between the
     * install and the uninstall, or a hand-run with no runner to isolate it. */
    const old = at();
    if (old) Ide.Apps.uninstall(old.Id);
    check("this project is not installed yet", at() === null);

    /*
     * The id, which is a slug of the name and never the file's own: the
     * specification allows letters, digits, dashes, underscores and periods,
     * and the runtime refuses anything else by name.
     */
    eq("the id is a slug of the name", Ide.Apps.idFor("My App 2"), "my-app-2");
    eq("a name of punctuation still gets one",
       Ide.Apps.idFor("!!!"), "bintana-app");

    /*
     * A project with no application id takes that slug as the entry's name and
     * claims no window class -- its window really is `bintana`'s, and an entry
     * claiming otherwise is one the dock can never match.
     */
    const slugproj = "/tmp/bta-test-ide-slugproj";
    Ide.Apps.install(slugproj, { Name: "My App 2", AppId: "" });
    const slugged = Ide.Apps.installed(slugproj);
    check("a project with no id installs under the slug", !!slugged);
    if (slugged) {
        eq("...with the slug as the file's name", slugged.Id, "my-app-2");
        check("...and no window class claimed",
              !("StartupWMClass" in slugged.Entry), slugged.Entry.StartupWMClass);
    }
    Ide.Apps.uninstall("my-app-2");

    /* --- the dialog, through the menu item --------------------------------- */
    check("with a project open, installing is on offer", ide.MnuAppInstall.Enabled);
    ide.MnuAppInstall.Click();
    yield;

    const dlg = ide.appEditor;
    check("the item opens the dialog", !!dlg);
    if (!dlg) return;

    const config = ide.manifest.read();
    eq("which starts on the project's name", dlg.TxtAppName.Text, config.Name);
    eq("and on its description", dlg.TxtAppComment.Text, config.Description);
    check("and on an icon that draws", dlg.TxtAppIcon.Text !== "",
          dlg.TxtAppIcon.Text);

    /* The name picks the file, live -- which is what makes the state line say
     * where the thing is going before anybody commits to it. */
    dlg.TxtAppName.Text = "Bta Suite App";
    dlg.showState();
    check("the state line names the file to be written",
          dlg.LblAppWhere.Text.includes("io.github.getbintana.IdeChild.desktop"),
          dlg.LblAppWhere.Text);
    eq("the button says what it will do", dlg.BtnAppInstall.Text,
       Locale.Text("Install"));
    check("and there is nothing to uninstall yet", !dlg.BtnAppUninstall.Visible);

    dlg.BtnAppInstall.Click();
    yield;

    const installed = at();
    check("installing writes an entry this project owns", installed !== null);
    if (!installed) return;

    eq("under the project's own id", installed.Id, "io.github.getbintana.IdeChild");
    eq("named what was typed", installed.Entry.Name, "Bta Suite App");
    eq("and claiming the class the window really has",
       installed.Entry.StartupWMClass, "io.github.getbintana.IdeChild");
    eq("running this runtime on this project",
       installed.Entry.Exec,
       Desktop.Entries.Exec([Application.Executable, ide.project]));
    eq("which is how the IDE finds it again",
       installed.Entry["X-Bintana-Project"], ide.project);
    eq("and opening no terminal", installed.Entry.Terminal, "false");
    check("the dialog closed when it was done", !dlg.Visible);

    /* --- coming back to it -------------------------------------------------
     *
     * The second visit has to be an Update and not a second installation: the
     * fields come from the entry that is there, so what is shown is what the
     * menu shows.
     */
    ide.MnuAppInstall.Click();
    yield;

    const again = ide.appEditor;
    check("opening it again finds what is installed", !!again);
    if (!again) return;

    eq("with the entry's name", again.TxtAppName.Text, "Bta Suite App");
    eq("the button offering an update", again.BtnAppInstall.Text,
       Locale.Text("Update"));
    check("and something to remove", again.BtnAppUninstall.Visible);
    check("saying where it is",
          again.LblAppWhere.Text.includes("io.github.getbintana.IdeChild.desktop"),
          again.LblAppWhere.Text);

    /*
     * Renaming the *name* keeps the file, because the project's id is what
     * names it -- the id is identity and the name is what a menu shows.  A
     * project without an id is the other case, and there a rename moves the
     * file: two entries for one program is a menu that offers it twice.
     */
    again.TxtAppName.Text = "Bta Suite App Renamed";
    again.showState();
    again.BtnAppInstall.Click();
    yield;

    check("the slug was never a file", !Desktop.Entries.Installed().includes("bta-suite-app"));
    const renamed = at();
    eq("renaming the name keeps the id", renamed && renamed.Id,
       "io.github.getbintana.IdeChild");
    eq("and updates what the menu shows", renamed && renamed.Entry.Name,
       "Bta Suite App Renamed");

    /* --- and removing it --------------------------------------------------- */
    ide.MnuAppInstall.Click();
    yield;

    const last = ide.appEditor;
    check("the dialog opens once more to remove it", !!last);
    if (!last) return;

    last.BtnAppUninstall.Click();
    yield;

    check("uninstalling leaves nothing this project owns", at() === null);
    check("and the file is gone",
          !File.Exists(File.Join(Desktop.Entries.Directory,
                                 "io.github.getbintana.IdeChild.desktop")));
}

function* p_errors(ide) {
    /* --- the bottom panel --------------------------------------------------
     *
     * Three declared pages now, and they are three different things: the output
     * of a run is a **log**, which needs no pty and is an ordinary read-only
     * `TextEditor`; the debugger's is a panel of its own; and *Problems* is a
     * list of places, which is a table. A terminal is a fourth, for working in,
     * which is why `Terminal` was not removed when the console stopped being
     * one.
     *
     * The label over the pane went with the change -- a notebook's tab already
     * says what the page is, and two of them saying it would be the `forms`
     * folder with a `Formularios` inside it.
     */
    eq("the bottom panel is a notebook", ide.ConsoleBox.constructor.name, "Notebook");
    eq("whose first page is the log", ide.ConsoleBox.Children[0].Name, "LogView");
    eq("and it is a plain editor and not a terminal",
       ide.LogView.constructor.name, "TextEditor");
    eq("...read-only, so nothing the user types joins what a program printed",
       ide.LogView.ReadOnly, true);
    eq("...and the tab says what it is", ide.ConsoleBox.Tabs[0], "Output");

    /*
     * *Output*, *Debug* and *Problems* are declared in the `.form`; the terminal
     * is a fourth page that exists only where a child can be run in it, which is
     * `Widget.Available`'s question -- a runtime built without VTE gets no tab
     * promising a terminal that would refuse.  This build has VTE, so both
     * branches are stated and the one that holds here is checked.
     */
    eq("there is a terminal page exactly when this build can run one",
       ide.ConsoleBox.Count, Widget.Available("Terminal") ? 4 : 3);
    eq("...and a Shell to go with it", ide.Shell !== null, Widget.Available("Terminal"));

    if (Widget.Available("Terminal")) {
        eq("the terminal's tab says so", ide.ConsoleBox.Tabs[ide.shellPage], "Terminal");
        check("and it is a real Terminal", ide.Shell.Available);

        /*
         * **Started when the page is looked at, in the project's directory.**
         * Not at launch: a terminal nobody has turned to is a child process
         * nobody asked for, started in whatever directory the IDE happened to
         * be launched from.
         *
         * `SHELL` is what it runs, so this drives it with a command that says
         * where it is and ends -- the honest way to read a cwd back out of a
         * pty, and it leaves no child behind.
         */
        const hadShell = Environment.Get("SHELL");

        Environment.Set("SHELL", "/bin/pwd");
        ide.ConsoleBox.Current = ide.shellPage;
        yield* until(() => ide.Shell.Text.includes(TMP), 200);
        check("the terminal starts in the project's directory",
              ide.Shell.Text.includes(TMP), JSON.stringify(ide.Shell.Text));

        /*
         * **Waited for on its own**, because it is a second thing arriving down
         * the same pty: `/bin/pwd` prints the directory and *then* exits, and
         * what the IDE writes when it exits is a line of its own. Waiting only
         * for the first and reading the second was a race that the ordinary
         * build won and `tests/asan.sh` -- four times slower -- lost.
         */
        yield* until(() => ide.Shell.Text.includes("shell"), 200);
        check("...and says when the shell ended",
              ide.Shell.Text.includes("shell"), JSON.stringify(ide.Shell.Text));

        /*
         * And the child is this process's, so leaving asks it to end.
         *
         * `cat` and not a shell, because what this can assert is that the
         * SIGTERM arrives -- an interactive bash *ignores* it, and what ends
         * one is the pty being closed (the kernel hangs up the foreground
         * group, which VTE does when the widget goes). That half is not
         * answerable from here and was measured by hand: no shell is left
         * behind after the IDE quits.
         */
        Environment.Set("SHELL", "/bin/cat");
        ide.ConsoleBox.Current = 0;
        ide.ConsoleBox.Current = ide.shellPage;
        yield* until(() => ide.Shell.Running, 200);
        check("looking at the page again starts another", ide.Shell.Running);

        ide.stopShell();
        yield* until(() => !ide.Shell.Running, 200);
        check("and leaving asks the child to end", !ide.Shell.Running);

        ide.ConsoleBox.Current = 0;
        if (hadShell) Environment.Set("SHELL", hadShell);
    }

    /* --- from the error to the line ----------------------------------------
     *
     * Whether the pointer really lands where it was aimed is a pointer question
     * and is checked by hand.  Everything from the landing on is checked here:
     * that a line and a column of the log name the place written there, that a
     * traceback is read back to the frame that matters, and that going there
     * opens the file at the line.
     *
     * `linkAt` is where the reading lives now.  It used to be VTE's:
     * `LinkPattern` matched inside the terminal and handed the text over, so
     * there was nothing to assert but that the pattern had been assigned.
     */
    const TRACE_LINE = `    at Form_Open (${TMP}/Main.js:42:9)`;

    eq("a click on a place in the log names it",
       ide.runner.linkAt(1, 20, TRACE_LINE), `${TMP}/Main.js:42`);
    eq("...from either end of it",
       ide.runner.linkAt(1, TRACE_LINE.indexOf(":42"), TRACE_LINE),
       `${TMP}/Main.js:42`);
    eq("a click on the words before it names nothing",
       ide.runner.linkAt(1, 8, TRACE_LINE), "");
    /* The cursor clamps to the end of the line, so this is the one case a
     * column cannot tell apart on its own: a click in the empty space to the
     * right of a traceback reads as a click on its last character. */
    eq("and a click past the end of the line names nothing",
       ide.runner.linkAt(1, TRACE_LINE.length + 20, TRACE_LINE), "");
    /* ...while the space *inside* a line still points at the word before it,
     * which is where a click one pixel wide of a place lands. */
    const trailing = `${TMP}/Main.js:42 y`;
    eq("a click just past a place still names it",
       ide.runner.linkAt(1, trailing.indexOf(" y") + 1, trailing),
       `${TMP}/Main.js:42`);
    eq("a line with no place in it has none",
       ide.runner.linkAt(1, 4, "hello from tabs"), "");
    eq("nor does a line that is not there",
       ide.runner.linkAt(9, 1, "one\ntwo"), "");
    /* The right *line* of several, which is the half a column alone cannot do. */
    eq("the place read is the one on the line clicked",
       ide.runner.linkAt(2, 20, `nothing here\n${TRACE_LINE}`),
       `${TMP}/Main.js:42`);

    const traceback =
        "Bintana error: Error: boom\n" +
        "    at Deep (/usr/lib/bintana/other.js:9:1)\n" +
        `    at Form_Open (${TMP}/Main.js:2:9)\n` +
        "    at Show (native)\n";

    const spot = ide.errorLocation(traceback);
    check("a traceback names a place", spot !== null, JSON.stringify(spot));
    eq("and the frame taken is the project's own", spot.path, `${TMP}/Main.js`);
    eq("at the line it says",                      spot.line, 2);

    eq("a traceback with nothing of ours in it names nowhere",
       ide.errorLocation("Bintana error: boom\n    at X (/elsewhere/a.js:1:1)\n"), null);
    eq("and output with no traceback at all names nowhere",
       ide.errorLocation("hello from tabs\n"), null);

    /* Two of them: the one worth going to is the one that just happened. */
    eq("the last traceback is the one read",
       ide.errorLocation(`Bintana error: first\n    at A (${TMP}/project.json:1:1)\n` +
                         traceback).line, 2);

    /*
     * And what it died *of*, which is the other half of a row in the Problems
     * panel: a place with no sentence beside it is a jump, not a report.
     *
     * The escapes are taken off, and it is a defence rather than a correction
     * now: the runtime asks `isatty` before writing the red, so a child of this
     * IDE writes none. A child that colours *its own* output still can, and a
     * line of a traceback is not where that belongs.
     */
    eq("the message is the line the error was announced on",
       ide.runner.errorMessage(traceback), "Error: boom");
    eq("...with the colour the runtime writes taken off",
       ide.runner.errorMessage("\x1b[1;31mBintana error:\x1b[0m Error: boom\n"),
       "Error: boom");
    check("and output that announced nothing still says something",
          ide.runner.errorMessage("hello from tabs\n").length > 0);

    /*
     * And what this run *is*, as against what the project is.
     *
     * `--strict` makes a control refuse a property its class does not have, so
     * `this.Lbl.Txt = "x"` throws where it is written rather than doing nothing
     * forever. It is one argument to `bintana` and nothing in `project.json`,
     * because the same project is run both ways and what decides is whoever
     * pressed the button -- so what is asserted is that the tick and the
     * argument are the same fact.
     */
    const wasStrict = ide.MnuStrict.Value;

    ide.runner.chose(false);
    eq("with the tick off the run carries no argument", ide.runner.options().length, 0);

    ide.runner.chose(true);
    eq("with it on it carries one", ide.runner.options().join(" "), "--strict");

    ide.MnuStrict.Value = false;
    ide.runner.restore();
    eq("and it is remembered across a session", ide.MnuStrict.Value, true);

    ide.runner.chose(wasStrict);
    ide.runner.restore();

    /* A traceback writes an absolute path; everything in this IDE speaks the
     * name a tab is keyed by. */
    eq("a path of the project is made relative",
       ide.runner.relative(`${TMP}/Main.js`), "Main.js");
    eq("...and one that is not is left as it stands",
       ide.runner.relative("/usr/lib/bintana/other.js"), "/usr/lib/bintana/other.js");

    check("clicking a place goes there", ide.runner.clicked(`${TMP}/Main.js:2`));
    eq("...opening that file",           ide.activeFile, "Main.js");
    eq("...at that line",                ide.Editor.Line, 2);

    const stayPut = ide.activeFile;
    check("a place outside the project goes nowhere",
          !ide.runner.clicked("/usr/lib/bintana/other.js:9"));
    eq("...and nothing else opens", ide.activeFile, stayPut);

    /*
     * And a drag is not a click.  Selecting a traceback to copy it runs the
     * pointer across a place, and going there would be the wrong answer to a
     * gesture that meant *copy this*.  `Selection` is the guard, and it is
     * asked before anything is read.
     */
    ide.LogView.Append(`\n${TRACE_LINE}\n`);
    const traceRow = ide.LogView.Line - 1;    /* Append leaves the cursor past it */

    ide.LogView.Select(traceRow, 20, 6);
    check("a drag selects", ide.LogView.Selection !== "",
          JSON.stringify(ide.LogView.Selection));
    check("...and dragging across a place does not go there",
          !ide.runner.followClick());

    /* The same spot, with nothing selected, is a click -- and does. */
    ide.LogView.Select(traceRow, 20, 0);
    eq("the same spot clicked is on a place", ide.LogView.Selection, "");
    check("...and goes there", ide.runner.followClick());

}

/*
 * The Problems panel: what is wrong with the project, in one list.
 *
 * It finds nothing of its own, so what there is to test is the collecting --
 * that a source replaces its own rows and nobody else's, the order they come
 * out in, what the tab says, and that a row is a place one can go to.  The three
 * real sources are tested where they live: the syntax one in `p_search` beside
 * the gutter mark it shares a fact with, the lint in `p_strings`, and the failed
 * run in `p_running`.
 *
 * **It does not start empty, and that is the feature working.** `p_strings` ran
 * the extractor over this project several phases ago and the lint's warnings are
 * still listed -- which is the whole point of a panel rather than a line in a
 * console that scrolls away.  So everything here is measured against what was
 * already there, and every row this phase plants is taken back out.
 */
function* p_problems(ide) {
    const panel = ide.problems;

    /* What the earlier phases left, which this phase must neither disturb nor
     * assume anything about. */
    const before   = panel.all.length;
    const baseTab  = ide.ConsoleBox.Tabs[panel.page];
    const mine     = () => panel.all.filter((x) => x.file.startsWith("probe/"));

    eq("the panel is a table", ide.ProblemView.constructor.name, "TableView");
    eq("...on a page of the bottom notebook",
       ide.ConsoleBox.Children[panel.page].Name, "ProblemView");
    check("...and the lint's warnings are still on it, phases later",
          before > 0, String(before));

    /* --- a source replaces its own rows, and only its own -------------------- */

    panel.report("p1", [{ kind: "Error", file: "probe/A.js", line: 3, text: "first" }]);
    panel.report("p2", [{ kind: "Error", file: "probe/B.js", line: 1, text: "second" }]);
    eq("two sources are two rows", mine().length, 2);
    eq("...and nothing else moved", panel.all.length, before + 2);

    panel.report("p1", [{ kind: "Error", file: "probe/A.js", line: 9, text: "again" }]);
    eq("a source reporting again replaces itself", mine().length, 2);
    eq("...with what it now says",
       mine().filter((x) => x.file === "probe/A.js")[0].line, 9);
    eq("...and leaves the other alone",
       mine().filter((x) => x.file === "probe/B.js").length, 1);

    panel.clear("p1");
    eq("a source with nothing to say clears itself", mine().length, 1);
    eq("...and still not the other", mine()[0].file, "probe/B.js");

    /* --- worst first, then where ------------------------------------------- */

    panel.clear("p2");
    panel.report("p3", [
        { kind: "Info",    file: "probe/C.js", line: 1, text: "c" },
        { kind: "Warning", file: "probe/B.js", line: 2, text: "b2" },
        { kind: "Error",   file: "probe/Z.js", line: 5, text: "z" },
        { kind: "Warning", file: "probe/B.js", line: 1, text: "b1" },
    ]);
    eq("severity decides first, whatever order they were reported in",
       mine().map((x) => x.kind).join(","), "Error,Warning,Warning,Info");
    /* Within one severity, the file and then the line: the order one reads a
     * list of places in. */
    eq("then the line, inside one file",
       mine().filter((x) => x.kind === "Warning").map((x) => x.line).join(","), "1,2");

    eq("the table drew every one of them", ide.ProblemView.Count, panel.all.length);
    /* The table is the list, in the list's order: row 0 is the worst problem
     * there is, and the place column says where it is. */
    eq("and row 0 is the first of them",
       ide.ProblemView.Cell(0, 1), panel.place(panel.all[0]));

    /* --- what the tab says --------------------------------------------------- */

    check("the tab carries the count",
          ide.ConsoleBox.Tabs[panel.page].includes(String(panel.all.length)),
          ide.ConsoleBox.Tabs[panel.page]);

    panel.clear("p3");
    eq("and taking them back out puts the tab back", ide.ConsoleBox.Tabs[panel.page],
       baseTab);
    eq("...with the rows that were there before still there", panel.all.length, before);

    /* --- a row is a place ---------------------------------------------------- */

    ide.openInTab("Main.js");
    yield* settled(ide);
    ide.Editor.GotoLine(1);

    panel.report("p4", [{ kind: "Error", file: "Main.js", line: 3, text: "somewhere" }]);
    ide.ProblemView.Select(panel.rows.findIndex((x) => x.text === "somewhere"));
    check("activating a row goes to the place it names", panel.activated());
    eq("...moving the cursor there", ide.Editor.Line, 3);

    /* A row about a file that is not there goes nowhere rather than opening an
     * empty tab: `Runner.open` is what refuses, which is the point of every jump
     * going through it. */
    panel.report("p4", [{ kind: "Error", file: "probe/NoSuch.js", line: 1, text: "gone" }]);
    ide.ProblemView.Select(panel.rows.findIndex((x) => x.file === "probe/NoSuch.js"));
    check("a row about a file that is not there goes nowhere", !panel.activated());

    panel.clear("p4");
    eq("and the panel is left as it was found", panel.all.length, before);
}

/*
 * The names a file uses, checked while it is being written.
 *
 * The *timer* is not driven -- four hundred milliseconds of a run waiting for
 * one tick would be four hundred milliseconds of nothing, and what it does is
 * call `pass`, which is called here directly.  The same bargain `recovery` makes
 * with its snapshot timer.
 *
 * Nothing here hardcodes a control or a type: the phase asks the form on screen
 * what it has and builds the text from that, so it keeps working when an earlier
 * phase changes what it drew.  What it *does* hardcode is `Txt`, which no widget
 * in this language has and which is the exact mistake that started this --
 * `this.Lbl.Txt = "hola"` parses, runs, changes nothing, and until now said
 * nothing.
 */
function* p_names(ide) {
    ide.openInTab("Main.js");
    yield* settled(ide);

    const editor = ide.Editor;
    const kept   = editor.Text;

    /* Whatever the form beside this file actually holds. */
    const controls = ide.completion.controls();
    check("the file being edited has a form beside it", controls.length > 0,
          JSON.stringify(controls));

    const one    = controls[0];
    check("...and its first control is a class this process has",
          Widget.Types().includes(one.type), one.type);

    /* This phase's source and no other: the project pass has rows about `Main.js`
     * too -- the fixture plants files the manifest does not list -- and *which
     * check said it* is the question being asked here. */
    const mine = () => ide.problems.of("names:Main.js");

    /* --- a member the control does not have ---------------------------------- */

    editor.Text = `class Main extends Form {\n` +
                  `    Form_Open() {\n` +
                  `        this.${one.name}.Txt = "hola";\n` +
                  `    }\n}\n`;
    editor.GotoLine(5);            /* away from the line being judged */
    ide.live.pass();

    eq("a member the control does not have is reported", mine().length, 1);
    eq("...on its line",   mine()[0].line, 3);
    check("...naming the type and the member",
          mine()[0].text.includes(one.type) && mine()[0].text.includes("Txt"),
          mine()[0].text);
    eq("...and the gutter says so beside it",
       editor.Marks("Warning").map((m) => m.Line).join(","), "3");

    /*
     * And the answer to the objection that keeps a syntax check off the
     * keystroke: what the caret is inside is something still being typed.
     */
    editor.GotoLine(3);
    editor.Select(3, `        this.${one.name}.Txt`.length);
    ide.live.pass();
    eq("what the caret is inside is not reported", mine().length, 0);
    eq("...and nothing is marked either", editor.Marks("Warning").length, 0);

    /* A member every widget really has, from anywhere. */
    editor.Text = editor.Text.replace(".Txt", ".Name");
    editor.GotoLine(5);
    ide.live.pass();
    eq("a member it does have is not reported", mine().length, 0);

    /* --- an event the control does not raise --------------------------------- */

    const events = Widget.EventNames(one.type);
    check("the control raises something", events.length > 0, JSON.stringify(events));

    editor.Text = `class Main extends Form {\n` +
                  `    ${one.name}_${events[0]}() { }\n` +
                  `    ${one.name}_Clik() { }\n` +
                  `}\n`;
    editor.GotoLine(4);
    ide.live.pass();

    eq("a handler for an event it does not raise is reported", mine().length, 1);
    eq("...on its line", mine()[0].line, 3);
    check("...saying it will never be called",
          mine()[0].text.includes("Clik"), mine()[0].text);

    /*
     * A method with an underscore whose first half is not a control is left
     * alone: it cannot be told from any other method, and warning about those is
     * how a check gets switched off.
     */
    editor.Text = `class Main extends Form {\n` +
                  `    not_a_handler() { }\n` +
                  `}\n`;
    editor.GotoLine(4);
    ide.live.pass();
    eq("a method that is not about a control is left alone", mine().length, 0);

    /* --- and it cleans up after itself --------------------------------------- */

    editor.Text = kept;
    editor.GotoLine(1);
    ide.live.pass();
    eq("the file put back has nothing wrong with it", mine().length, 0);
    eq("...and no marks left over", editor.Marks("Warning").length, 0);

    /* The editor is dirty now and every phase after this one expects it clean:
     * the text is what it was, so saving writes the same bytes. */
    ide.save();
}

/*
 * The outline: what is in the file on screen, beside it.
 *
 * The side panel used to be hidden on every code tab, because what it held spoke
 * about a designer's selection.  It holds two things now, and which one is
 * showing is the question *what kind of file is this*.
 *
 * Like `names`, this drives `refresh` rather than the timer that calls it.
 */
function* p_outline(ide) {
    ide.openInTab("Main.js");
    yield* settled(ide);

    /* --- which half of the panel is showing ---------------------------------- */

    check("the side panel is showing over a code tab", ide.SidePanel.Visible);
    check("...with the outline in it",  ide.OutlineBox.Visible);
    check("...and not the switcher, which speaks about a selection",
          !ide.SideTabs.Visible);

    /* --- what is in it ------------------------------------------------------- */

    const editor = ide.Editor;
    const kept   = editor.Text;

    editor.Text = `class Main extends Form {\n` +      /* 1 */
                  `    Form_Open() {\n` +              /* 2 */
                  `        this.uno();\n` +            /* 3 */
                  `    }\n` +                          /* 4 */
                  `\n` +                               /* 5 */
                  `    uno() { }\n` +                  /* 6 */
                  `\n` +                               /* 7 */
                  `    dos() { }\n` +                  /* 8 */
                  `}\n`;
    ide.outline.refresh();

    eq("the outline lists what the file declares", ide.OutlineList.Count, 3);
    eq("...in the order they are written",
       ide.OutlineList.Items.join(","), "Form_Open,uno,dos");

    /* --- a row is a place ---------------------------------------------------- */

    ide.OutlineList.Index = 2;
    eq("choosing a row goes to its line", editor.Line, 8);

    ide.OutlineList.Index = 0;
    eq("...and another to another", editor.Line, 2);

    /* --- and it says where the cursor already is ----------------------------- */

    editor.GotoLine(3);
    ide.outline.follow();
    eq("standing inside a method marks it", ide.OutlineList.Index, 0);

    editor.GotoLine(6);
    ide.outline.follow();
    eq("...the one the cursor is in, not the one above it",
       ide.OutlineList.Index, 1);

    /*
     * And the pair does not eat the cursor.  Marking a row must not be read back
     * as somebody choosing it, or standing on a line inside a method would drag
     * the caret up to its declaration while one was reading.
     */
    editor.GotoLine(4);
    ide.outline.follow();
    eq("the row moves to the method the caret is in", ide.OutlineList.Index, 0);
    eq("...and the caret stays where it was", editor.Line, 4);

    /* Above every declaration there is no method to be in. */
    editor.GotoLine(1);
    ide.outline.follow();
    eq("above the first declaration nothing is marked", ide.OutlineList.Index, -1);

    /* --- a pass that found the same thing leaves the list alone -------------- */

    ide.OutlineList.Index = 1;
    ide.outline.refresh();
    eq("a refresh that changed nothing keeps the selection",
       ide.OutlineList.Index, 1);

    /* --- and a form tab gets the switcher back ------------------------------- */

    editor.Text = kept;
    ide.save();

    ide.openInTab("Main.form");
    yield* settled(ide);
    check("a form tab shows the switcher", ide.SideTabs.Visible);
    check("...and not the outline", !ide.OutlineBox.Visible);

    ide.openInTab("Main.js");
    yield* settled(ide);
}

/*
 * The pass over the whole project.
 *
 * Six checks, and each one is a thing the runtime was measured accepting in
 * silence, so each is planted here on purpose and then taken away again. What is
 * asserted is not only that they fire: it is that the pass **replaces its own
 * rows** -- running it twice must not double anything, and a project with the
 * mistakes taken out must end with nothing left over.
 *
 * It writes into the project the earlier phases built and puts every file back,
 * the way `p_search` does with its own.
 */
function* p_check(ide) {
    /* `pass` and not `check`: this file's own `check()` is the assertion, and
     * a local of that name would shadow it -- which it did, once. */
    const pass = ide.check;
    const rows  = () => ide.problems.of("project");

    /* What the fixture already has to answer for: the phases planted files by
     * hand, and a manifest with a `sources` is a whitelist. Measured rather
     * than assumed, because everything below is a delta from it. */
    pass.run();
    const before = rows().length;
    check("the pass says something about the project as it stands", before > 0,
          JSON.stringify(rows().slice(0, 3)));

    /* --- a .form the runtime would take without a word ---------------------- */

    File.Save(File.Join(TMP, "Bad.form"), JSON.stringify({
        format: "bintana-form/1",
        class: "Bad",
        properties: { Width: 300, Height: 200 },
        /*
         * A menu, because a `.form` binds what it names here on the form exactly
         * as it binds a control -- and until the flatteners were made one, this
         * whole block was invisible to the pass. The item named `Actions`
         * collides with a getter of `Form` -- the same silence a *control* of
         * that name had -- and the command declared twice loses the first.
         */
        actions: [{ name: "ActDup", text: "one" },
                  { name: "ActDup", text: "two" }],
        menus: [{ name: "MnuTop", text: "T",
                  children: [{ name: "Actions", text: "A" },
                             { name: "MnuOk", text: "O" }] }],
        children: [
            { type: "Label",  name: "Twice", properties: { Text: "uno" } },
            { type: "Label",  name: "Twice", properties: { Text: "dos" } },
            { type: "Panel",  name: "Close", properties: {} },
            { type: "Button", name: "Btn",   properties: { Txt: "nope" } },
        ],
    }, null, 2));

    File.Save(File.Join(TMP, "Bad.js"),
              "class Bad extends Form {\n" +
              "    Btn_Clik() { }\n" +                    /* Button raises Click */
              "    MnuOk_Chose() { }\n" +                 /* an item raises Click */
              "    Form_Open() { this.Btn.Txt = \"x\"; this.MnuOk.Enabld = 1; }\n" +
              "}\n");

    ide.listFiles();
    pass.run();

    const said = rows().filter((r) => r.file === "Bad.form" || r.file === "Bad.js");
    const has  = (needle) => said.some((r) => r.text.includes(needle));

    check("two controls of one name are reported", has("two controls are called Twice"),
          JSON.stringify(said));
    check("...as an error, because one of them is simply gone",
          said.some((r) => r.text.includes("Twice") && r.kind === "Error"));
    check("a control whose name is a member of Form is reported",
          has("Close is also a member of Form"), JSON.stringify(said));
    check("...as a warning, because a method is shadowed and the form still runs",
          said.some((r) => r.text.includes("Close is also") && r.kind === "Warning"),
          JSON.stringify(said));
    check("a property the class does not have is reported",
          has("Button has no Txt"), JSON.stringify(said));
    check("a handler for an event it does not raise is reported",
          has("does not raise Clik"), JSON.stringify(said));
    check("...and so is the member, in a file nobody has open",
          said.some((r) => r.file === "Bad.js" && r.text.includes("has no Txt")),
          JSON.stringify(said));

    /*
     * And the same three checks over what a `.form` names outside `children`,
     * which is the hole three flatteners shared. Every one of these is a real
     * silence: a command declared twice loses the first, a menu item called
     * `Actions` binds to nothing at all, and a handler for an event an item does
     * not raise is a method nothing will ever call.
     */
    check("two commands of one name are reported",
          has("two controls are called ActDup"), JSON.stringify(said));
    check("a menu item whose name is a member of Form is reported",
          has("Actions is also a member of Form"), JSON.stringify(said));
    /*
     * And as an **error**, which is the half that changed: `Actions` is
     * read-only, so the bind fails and the runtime refuses the form -- for a
     * control, a menu item and a command alike. A row that said "one of the two
     * is unreachable" about a program that will not start was the wrong
     * sentence, so the two futures are two rows now.
     */
    check("...as an error, since a read-only member stops the form loading",
          said.some((r) => r.text.includes("Actions is also") &&
                           r.text.includes("will not load") && r.kind === "Error"),
          JSON.stringify(said));
    check("a handler for an event a menu item does not raise is reported",
          has("does not raise Chose"), JSON.stringify(said));
    check("...and a member a menu item does not have",
          said.some((r) => r.file === "Bad.js" && r.text.includes("has no Enabld")),
          JSON.stringify(said));

    /* Running it again says the same thing once, not twice. */
    const again = rows().length;
    pass.run();
    eq("the pass replaces its own rows", rows().length, again);

    /* --- the manifest ------------------------------------------------------- */

    const manifestPath = File.Join(TMP, "project.json");
    const kept = File.Load(manifestPath);
    const cfg  = JSON.parse(kept);
    cfg.format = "bintana-project/1";              /* a key nothing reads */
    cfg.sources = (cfg.sources || []).concat(["NoEsta.js"]);
    File.SaveJson(manifestPath, cfg);

    pass.run();
    const about = rows().filter((r) => r.file === "project.json");
    check("a key nothing reads is reported",
          about.some((r) => r.text.includes('"format"')), JSON.stringify(about));
    check("a source that is not there is reported",
          about.some((r) => r.text.includes("NoEsta.js")), JSON.stringify(about));
    check("...as an error, since that one stops the program",
          about.some((r) => r.text.includes("NoEsta.js") && r.kind === "Error"));

    File.Save(manifestPath, kept);

    /* --- and it cleans up after itself -------------------------------------- */

    File.Delete(File.Join(TMP, "Bad.form"));
    File.Delete(File.Join(TMP, "Bad.js"));
    ide.listFiles();
    pass.run();

    eq("with the mistakes gone the pass is back where it started",
       rows().length, before);
    check("and nothing is left about the files that went",
          !rows().some((r) => r.file.startsWith("Bad.")),
          JSON.stringify(rows()));

    pass.forget();
    eq("forgetting takes the whole pass back", rows().length, 0);
    pass.run();                       /* the phases after this one see it as found */
}

/*
 * Quick open, and the palette: one window, a character apart.
 *
 * What is worth asserting is that it **invents nothing**.  The files are the
 * project's own listing and the commands are the menu bar read back out of
 * `Form.Menus`, with the enabled state `refresh()` has already decided -- so the
 * test drives the same two questions the window asks rather than a list of its
 * own.
 */
function* p_quick(ide) {
    /* --- the keys ------------------------------------------------------------ */

    const shortcutOf = (name) => {
        let found = "";
        const walk = (items) => {
            for (const item of items || []) {
                if (item.name === name && item.shortcut) found = item.shortcut;
                walk(item.children);
            }
        };
        walk(ide.Menus);
        return Array.isArray(found) ? found[0] : found;
    };

    eq("Ctrl+P is go to file",        shortcutOf("MnuGotoFile"), "<Control>p");
    eq("Ctrl+Shift+P is the palette", shortcutOf("MnuCommands"), "<Control><Shift>p");
    /* It used to be this, and gave it up: the reflex has to land on the thing it
     * means, and project settings is still two clicks away in its own menu. */
    eq("...which project settings no longer claims",
       shortcutOf("MnuProjectSettings"), "");

    /* --- the files ----------------------------------------------------------- */

    ide.MnuGotoFile.Click();
    yield* until(() => QuickForm.open !== null);

    const dlg = QuickForm.open;
    check("the window is up", dlg !== null);
    check("...on the files", !dlg.commanding);
    eq("...holding the project's own listing",
       dlg.entries.length, ide.classes.files.length);
    eq("...every one of them showing", dlg.List.Count, dlg.entries.length);

    /*
     * And the rows are **drawn**, which is a different question from what they
     * were told to say.
     *
     * Written with `Ellipsize` on both labels of a row, every row came out as
     * `...` and nothing else: it caps a label's natural width -- that is what it
     * is for, stopping a long string from stretching its container -- and a row
     * of a `RowList` is sized from what is in it, so two of them left the row
     * with no width to divide. The `Text` was right the whole time, which is why
     * this is measured off the allocation and not off the property.
     */
    const firstRow = dlg.List.Children[0];
    const nameLbl  = firstRow.Children[0];
    yield* until(() => nameLbl.Bounds().Width > 0);
    check("a row is drawn wide enough to read",
          nameLbl.Bounds().Width > 40,
          `${nameLbl.Text} drawn ${nameLbl.Bounds().Width}px wide`);

    dlg.TxtFind.Text = "main";
    dlg.TxtFind_Change();

    const showing = dlg.entries.filter((f, i) => dlg.matches(i));
    check("typing narrows it", showing.length > 0 && showing.length < dlg.entries.length,
          `${showing.length} of ${dlg.entries.length}`);
    check("...to the files that match",
          showing.every((f) => f.toLowerCase().includes("main")),
          JSON.stringify(showing));

    /* The whole path and not the name alone, so a folder narrows a name. */
    dlg.TxtFind.Text = "\u00f1o\u00f1o-no-such-file";
    dlg.TxtFind_Change();
    eq("a needle nothing matches leaves nothing", dlg.firstShowing(), null);
    check("...and the bar says none", dlg.LblCount.Text.includes("0"),
          dlg.LblCount.Text);

    /* --- and the same box holds the commands --------------------------------- */

    dlg.TxtFind.Text = ">";
    dlg.TxtFind_Change();

    check("a > turns it into the palette", dlg.commanding);
    check("...holding the menu bar", dlg.entries.length > 20, String(dlg.entries.length));
    check("...with the submenu each command is in",
          dlg.entries.every((c) => c.path !== ""),
          JSON.stringify(dlg.entries.slice(0, 3)));

    const run = dlg.entries.find((c) => c.name === "MnuRun");
    check("a command of the menu is in it", run !== undefined);
    eq("...with the accelerator it declares, as a person reads it",
       run.shortcut, "Ctrl+R");

    /* Nothing invented: every command answers to a menu item of the window. */
    check("every command is a menu item that exists",
          dlg.entries.every((c) => !!ide[c.name]));
    /* And a submenu is not a command: there is no row for the File menu itself. */
    check("a submenu is not a command",
          !dlg.entries.some((c) => c.name === "MnuFile"));

    dlg.TxtFind.Text = ">quit";
    dlg.TxtFind_Change();
    const quit = dlg.firstShowing();
    check("the palette finds a command by part of its name", quit !== null,
          dlg.LblCount.Text);
    eq("...and it is the one it says", quit.name, "MnuQuit");

    /*
     * And *Go* acts on the row that is chosen, not on the first one that
     * matches.
     *
     * With nothing picked the first match is the answer -- which is what makes
     * *type three letters and press Enter* the whole gesture -- but walking the
     * list with the arrows and then pressing the button has to act on what was
     * walked to. `SymbolForm` takes the first match unconditionally and gets
     * away with it because nothing there leaves a selection behind.
     */
    dlg.TxtFind.Text = ">";
    dlg.TxtFind_Change();
    dlg.List.Index = -1;
    eq("with nothing chosen, Go takes the first match",
       dlg.wanted().name, dlg.firstShowing().name);

    const third = dlg.entries[2];
    dlg.List.Index = 2;
    eq("with a row chosen, Go takes that one", dlg.wanted().name, third.name);
    check("...which is not the first", third.name !== dlg.firstShowing().name,
          third.name);

    /*
     * And typing again lets go of the row, which is `RowList`'s doing and not
     * this window's: `Refilter` leaves no selection behind. Measured, because
     * the guard in `wanted()` was written for the other answer -- it is kept as
     * the cheap defence it is, and this says which of the two actually happens.
     */
    dlg.TxtFind.Text = ">quit";
    dlg.TxtFind_Change();
    eq("filtering lets go of the chosen row", dlg.List.Index, -1);
    eq("...so Go is back to the first match", dlg.wanted().name, "MnuQuit");

    /* --- the enabled state is the IDE's, not a copy of it -------------------- */

    const anyCommand = dlg.entries.find((c) => ide[c.name]);
    ide[anyCommand.name].Enabled = false;
    check("a command the IDE has disabled is disabled here",
          !dlg.enabled(anyCommand));
    ide[anyCommand.name].Enabled = true;
    check("...and enabled when it is", dlg.enabled(anyCommand));

    dlg.BtnCancel.Click();
    yield* until(() => QuickForm.open === null);
    check("cancelling lets go of the window", QuickForm.open === null);

    /* --- Ctrl+Shift+P starts on the other half ------------------------------- */

    ide.MnuCommands.Click();
    yield* until(() => QuickForm.open !== null);
    check("the palette key opens it on the commands", QuickForm.open.commanding);

    /*
     * And it stays on them when one starts typing.
     *
     * `SetFocus` on a field selects what is in it -- right for a box one is
     * about to retype, and exactly wrong for one opened with a character already
     * in it: the `>` came up selected, so the first keystroke replaced it and
     * the palette turned back into the file picker while somebody was typing.
     */
    eq("...with nothing selected, so typing does not eat the >",
       QuickForm.open.TxtFind.Selection, "");

    QuickForm.open.BtnCancel.Click();
    yield* until(() => QuickForm.open === null);

    /* --- and choosing a file opens it ---------------------------------------- */

    ide.MnuGotoFile.Click();
    yield* until(() => QuickForm.open !== null);

    const picker = QuickForm.open;
    picker.TxtFind.Text = "Main.js";
    picker.TxtFind_Change();
    picker.BtnOk_Click();
    yield* settled(ide);

    eq("choosing a file opens it", ide.activeFile, "Main.js");
    check("...and the window is gone", QuickForm.open === null);
}

/*
 * Find in project, the syntax check a save does, and the question quitting asks.
 *
 * Late on purpose: it writes a file of its own into the project the earlier
 * phases built, and everything it touches it puts back -- `p_running` runs that
 * project for real at the end and must find it as it left it.
 */
function* p_search(ide) {
    /* --- find in project ---------------------------------------------------
     *
     * A fixture of its own rather than a term out of the project: what is being
     * asserted is *how many* and *where*, and both have to be known exactly.
     * "aguja" appears nowhere else in the tree.
     */
    const NEEDLE = [
        "class Needle extends Form {",
        "    Form_Open() {",
        "        const aguja = 1;      // aguja",
        "        print(aguja);",
        "    }",
        "}",
        "",
    ].join("\n");

    File.Save(File.Join(TMP, "Needle.js"), NEEDLE);
    ide.listFiles();

    /* Through the menu item, which is the road a person takes. */
    ide.MnuFindAll_Click();
    yield;

    const win = SearchForm.open;
    check("Ctrl+Shift+F opens a window of its own", win !== null);
    check("and the item is about the project, not the tab",
          ide.MnuFindAll.Enabled);

    win.TxtTerm.Text = "aguja";

    /*
     * Nothing in it hangs out of it, which is the one thing about a window
     * drawn sight-unseen that a screenshot would be the only other way to know.
     * Measured after a frame, since a window just shown has no allocation and a
     * 0x0 satisfies every inequality below while saying nothing at all.
     */
    yield* until(() => win.Results.Bounds().Height > 0);
    const room = win.Bounds();
    for (const c of [win.TxtTerm, win.BtnFind, win.ChkCase, win.ChkWord,
                     win.ChkRegex, win.CboFiles, win.Results, win.BtnClose]) {
        const r = c.Bounds();
        check(`${c.Name} stays inside the window`,
              r.X >= 0 && r.X + r.Width <= room.Width &&
              r.Y >= 0 && r.Y + r.Height <= room.Height,
              `${c.Name}=${JSON.stringify(r)} window=${JSON.stringify(room)}`);
    }

    /* And the room goes where the room is worth having: the list is most of the
     * window and the filter keeps the width it asked for. Containment alone is
     * satisfied by a control squeezed to nothing. */
    check("the results take most of the window",
          win.Results.Bounds().Height > room.Height / 2,
          `${win.Results.Bounds().Height} of ${room.Height}`);
    check("and the filter is not squeezed out by the switches",
          win.CboFiles.Bounds().Width >= 150,
          JSON.stringify(win.CboFiles.Bounds()));

    /* Opening it again raises the one that is up rather than stacking a second
     * answer to the same question. */
    check("asking twice raises the same window", SearchForm.find(ide, "") === win);
    eq("and an empty term leaves the last search alone", win.TxtTerm.Text, "aguja");

    /* Through the button and not the method under it: a handler that was never
     * wired up is exactly what driving the method hides. */
    win.BtnFind.Click();
    eq("the button searches", win.Results.Exists("f:Needle.js"), true);
    check("and Enter in the field does too, through the default button",
          win.BtnFind === win.DefaultButton);

    eq("every occurrence in every file", win.search(), 3);
    eq("the results show the file", win.Results.Exists("f:Needle.js"), true);
    eq("with a node per hit under it", win.Results.Exists("h:2"), true);
    eq("and no more than there were", win.Results.Exists("h:3"), false);
    check("the count is on the window", win.LblCount.Text.includes("3"),
          win.LblCount.Text);

    win.TxtTerm.Text = "hormiga";
    eq("a term nowhere in the project finds nothing", win.search(), 0);
    check("and the window says so", win.LblCount.Text.includes("hormiga"),
          win.LblCount.Text);

    /* The three switches mean here what they mean in the editor's own bar. */
    win.TxtTerm.Text = "AGUJA";
    eq("case is ignored by default", win.search(), 3);
    win.ChkCase.Active = true;
    eq("and honoured when asked", win.search(), 0);
    win.ChkCase.Active = false;

    win.TxtTerm.Text = "aguj";
    eq("half a word matches inside one", win.search(), 3);
    win.ChkWord.Active = true;
    eq("...and not when whole words were asked for", win.search(), 0);
    win.ChkWord.Active = false;

    /* A pattern that can only match the needle: this searches the *whole*
     * project, and one phase of this suite copies the IDE's own `MainForm.form`
     * into it -- so a loose pattern counts whatever the IDE happens to say this
     * month, which is a count that changes for reasons that are not the search. */
    win.TxtTerm.Text = "ag.ja";
    eq("a dot is a dot unless it is a pattern", win.search(), 0);
    win.ChkRegex.Active = true;
    eq("and a pattern when it is", win.search(), 3);

    /* A pattern that matches nothing at all is a frozen window if `lastIndex` is
     * not pushed past it -- `\b` and `x*` are the ones a person really types. */
    win.TxtTerm.Text = "a*";
    check("a pattern that can match nothing still returns", win.search() > 0);

    win.TxtTerm.Text = "(";
    eq("and one half typed is not an error to report", win.search(), 0);
    eq("the window says which it is", win.LblCount.Text, "bad regex");
    win.ChkRegex.Active = false;

    /* --- which files it looks in --------------------------------------------
     *
     * The list is the project's own extensions, so a project with no catalogues
     * is not offered `*.po` and one holding something new is.
     */
    check("the filter offers every file first",
          win.CboFiles.Index === 0 && win.filters[0].ext === "");
    check("and one entry per extension the project really has",
          win.filters.some((f) => f.label === "*.js"),
          JSON.stringify(win.filters.map((f) => f.label)));
    check("which is not a table written down here",
          win.filters.some((f) => f.label === "*.form"),
          JSON.stringify(win.filters.map((f) => f.label)));

    win.TxtTerm.Text = "Form";
    const everywhere = win.search();
    win.CboFiles.Index = win.filters.findIndex((f) => f.ext === "form");
    const onlyForms = win.search();
    check("narrowing to one kind of file finds fewer",
          onlyForms > 0 && onlyForms < everywhere, `${onlyForms} of ${everywhere}`);

    /* The list is rebuilt every time the window is raised, since files come and
     * go while it sits in the background -- and what was chosen has to survive
     * that, or coming back to it would silently widen the search. */
    SearchForm.find(ide, "");
    eq("raising it again keeps the kind of file one chose",
       win.filters[win.CboFiles.Index].ext, "form");
    win.CboFiles.Index = 0;

    /* --- and going to one ---------------------------------------------------- */
    win.TxtTerm.Text = "aguja";
    win.search();
    win.Results.Key = "h:0";
    win.Results_Activate();
    eq("activating a result opens its file", ide.activeFile, "Needle.js");
    eq("at the line it named",              ide.Editor.Line, 3);
    eq("with the match itself selected",    ide.Editor.Selection, "aguja");

    win.Results.Key = "f:Needle.js";
    win.Results_Activate();
    eq("and the file node opens the file without pretending to a line",
       ide.activeFile, "Needle.js");

    win.BtnClose.Click();
    yield;
    check("closing lets go of it, so the next one is a fresh window",
          SearchForm.open === null);

    /* And it opens on what one meant to look for, the way Ctrl+F does: a
     * selection is a search term, unless it spans lines -- that is a block
     * somebody highlighted rather than something to go looking for. */
    ide.openInTab("Needle.js");
    ide.Editor.Select(3, 15, 5);
    eq("the selection is the term", ide.Editor.Selection, "aguja");

    ide.MnuFindAll_Click();
    yield;
    eq("which is what the window opens on", SearchForm.open.TxtTerm.Text, "aguja");
    check("and it searched for it on the way up",
          SearchForm.open.Results.Exists("f:Needle.js"));
    SearchForm.open.BtnClose.Click();
    yield;

    /* --- what a save says about the file ------------------------------------
     *
     * `Application.CheckSource` compiles without running, so the IDE can say
     * where the file stopped making sense -- in the gutter, beside the line.
     */
    ide.openInTab("Needle.js");
    eq("a file that compiles is not marked", ide.Editor.Marks("Error").length, 0);

    ide.Editor.Text = NEEDLE.replace("const aguja = 1;", "const aguja = ;");
    ide.save();

    const marks = ide.Editor.Marks("Error");
    eq("saving something broken marks it", marks.length, 1);
    eq("on the line the compiler stopped at", marks[0].Line, 3);
    check("with what it said", marks[0].Text.length > 0, JSON.stringify(marks[0]));
    eq("and the gutter is showing", ide.Editor.ShowMarks, true);

    /* The mark is for the file one is looking at; the panel is for the file one
     * is not.  Same fact, two places, and the panel is the one that survives
     * closing the tab. */
    const said = ide.problems.all.filter((x) => x.file === "Needle.js");
    eq("and the panel says so too", said.length, 1);
    eq("...as an error",            said[0].kind, "Error");
    eq("...at the same line",       said[0].line, marks[0].Line);
    eq("...saying the same thing",  said[0].text, marks[0].Text);

    /* Refusing the save would be worse than the error: broken code is what one
     * writes on the way to looking something up. */
    check("the file was saved anyway",
          File.Load(File.Join(TMP, "Needle.js")).includes("const aguja = ;"));

    ide.Editor.Text = NEEDLE;
    ide.save();
    eq("fixing it and saving takes the mark off", ide.Editor.Marks("Error").length, 0);
    eq("...and takes the row out of the panel with it",
       ide.problems.all.filter((x) => x.file === "Needle.js").length, 0);

    /* --- quitting with unsaved work ------------------------------------------
     *
     * `Form_Close` is asked rather than told, so this is the one path out of the
     * IDE and every way of leaving goes through it.
     */
    check("with everything saved there is nothing to ask", !ide.confirmQuit());
    check("so closing the window would go through", !ide.Form_Close());

    ide.Editor.Text = NEEDLE + "/* sin guardar */\n";
    check("an edited tab is dirty", ide.hasDirtyTabs());
    check("and is named as such", ide.dirtyNames().includes("Needle.js"),
          JSON.stringify(ide.dirtyNames()));

    const asked = ide.confirmQuit();
    check("quitting with unsaved work asks first", asked !== null);
    check("naming the file", asked.LblMessage.Text.includes("Needle.js"),
          asked.LblMessage.Text);
    eq("and offering to save on the way out", asked.BtnOther.Visible, true);

    /* Dismissed here, and it matters: a modal left open sits over whatever the
     * next phase measures -- which is how a file chooser once turned an anchor
     * test red in code nobody had touched. */
    asked.BtnNo.Click();

    /* And the window's own X takes the same road: `Form_Close` is what the
     * runtime asks, and a true answer is what keeps the IDE open. */
    const vetoed = ide.Form_Close();
    check("the X asks the same question", vetoed);
    vetoed.BtnNo.Click();

    /* Put the project back the way `p_running` needs it. */
    ide.Editor.Text = NEEDLE;
    ide.Editor.Modified = false;
    ide.closeTabByName("Needle.js", true);
    File.Delete(File.Join(TMP, "Needle.js"));
    ide.listFiles();
    yield;
}

/*
 * Git, over a repository this phase makes.
 *
 * **Skipped and not failed where there is no git**, which is the rule every
 * optional tool in this suite follows: a machine without one is a machine this
 * cannot say anything about, and a red line there is a lie about the code.
 *
 * What it asserts is the parse and the doors, never a pixel: the porcelain read
 * with a name that has a space and an accent in it -- which is the case `-z`
 * was chosen for and the one that found a bug in `Exec.Wait` -- the two lists
 * meaning what they say, the before/after pair of a diff, and staging and
 * committing going through git rather than through a file written here.
 */
function* p_git(ide) {
    if (!Application.HasCommand("git")) {
        print("  (skipping git: not installed)");
        return;
    }

    const repo = File.Join(TMP, "gitrepo");
    const run  = (...args) => Exec.Wait(["git", "-C", repo, ...args], { Timeout: 8000 });

    /* Made and then emptied, in that order: `wipe` lists the directory and a
     * directory that has never existed cannot be listed. */
    Directory.Make(repo);
    wipe(repo);
    run("init", "-q");
    /* A repository with no identity cannot commit, and a machine running the
     * suite is not required to have one configured. */
    run("config", "user.email", "suite@bintana");
    run("config", "user.name", "Suite");

    File.Save(File.Join(repo, "project.json"),
              JSON.stringify({ name: "gitrepo", startup: "Uno", sources: ["Uno.js"] }));
    File.Save(File.Join(repo, "Uno.js"), "class Uno extends Form {\n}\n");
    /* The name the whole `-z` decision exists for. */
    File.Save(File.Join(repo, "con espacio y ñ.txt"), "viejo\n");
    run("add", "-A");
    run("commit", "-qm", "first");

    ide.openProject(repo);
    yield* settled(ide);

    const git = ide.git;

    check("git is available", git.available);
    check("and the project is a repository", git.isRepo);
    check("with a branch", git.branchName !== "", git.branchName);

    /* --- the parse ---------------------------------------------------------- */
    File.Save(File.Join(repo, "Uno.js"), "class Uno extends Form {\n    // dos\n}\n");
    File.Save(File.Join(repo, "con espacio y ñ.txt"), "nuevo\n");
    File.Save(File.Join(repo, "suelto.txt"), "sin seguir\n");
    run("add", "--", "con espacio y ñ.txt");

    ide.refreshGit();

    eq("a changed file is seen", git.stateOf("Uno.js"), "M");
    eq("a name with a space and an accent survives the parse",
       git.stateOf("con espacio y ñ.txt"), "M");
    eq("an untracked file is seen as one", git.stateOf("suelto.txt"), "?");
    eq("and something that is not there is nothing", git.stateOf("no.txt"), "");

    /*
     * The two lists are the two questions, and a file can be in both: this one
     * is staged and the others are not.
     */
    const split = git.split();
    const paths = (rows) => rows.map((r) => r.path).sort().join("|");

    eq("what is staged is in the staged list", paths(split.staged),
       "con espacio y ñ.txt");
    eq("and what is not, is not", paths(split.unstaged), "Uno.js|suelto.txt");

    /* The bar says where it is. */
    check("the status bar carries the branch",
          ide.LblStatus.Text.includes(git.branchName), ide.LblStatus.Text);
    check("...and that something is staged", ide.LblStatus.Text.includes("1"),
          ide.LblStatus.Text);

    /* The tree marks it. Read off the tree rather than off the state, which is
     * the thing being asserted. */
    const marked = [];
    for (const key of Dictionary.Keys(ide.projectTree.labels))
        if (ide.projectTree.labels[key] !== undefined) marked.push(key);
    check("the tree has rows to mark", marked.length > 0);

    /* --- the two halves of a diff ------------------------------------------- */
    eq("the index has what was staged", git.show("", "con espacio y ñ.txt"), "nuevo\n");
    eq("and the last commit has what came before",
       git.show("HEAD", "con espacio y ñ.txt"), "viejo\n");
    eq("a file the commit does not have answers nothing",
       git.show("HEAD", "suelto.txt"), null);

    const diff = git.diff("Uno.js", false);
    check("and git's own diff names the line", diff.includes("+    // dos"),
          JSON.stringify(diff.slice(0, 120)));

    /* --- staging and committing --------------------------------------------- */
    const win = GitForm.open(ide);
    yield* settled(ide);

    check("the Changes window opens", win !== undefined && win !== null);
    eq("with the unstaged files on its first page", win.paths[0].length, 2);
    eq("and the staged one on its second", win.paths[1].length, 1);

    /*
     * Asking for it twice raises the one there is rather than stacking two.
     *
     * `check` and not `eq`: `eq` builds its *expected/got* message whether or
     * not it passes, and a `Form` put through `JSON.stringify` is a circular
     * reference -- a window holds its children and they hold it back.
     */
    check("asking again raises the same window", GitForm.open(ide) === win);

    /*
     * --- and the panes take the window ---------------------------------------
     *
     * The bug this asserts against: the window was drawn as a `Fixed` -- every
     * region at an X, a Y and a height of its own -- so making it taller gave
     * the extra room to nothing, and the diff stayed the 430 pixels it had been
     * drawn at however big the screen was. Which is the general rule this repo
     * measured once and then broke anyway: **a window of regions is boxes.**
     *
     * Measured and not read off the `.form`: what is asserted is that the pane
     * really grew when the window did, which is the thing a person sees.
     */
    win.Show();
    yield* settled(ide);

    const wasTall = win.Before.Bounds().Height;
    const wasWide = win.Before.Bounds().Width;

    check("the diff pane has most of the window's height",
          wasTall > win.Bounds().Height / 2, `${wasTall} of ${win.Bounds().Height}`);

    win.Height = win.Bounds().Height + 220;
    yield* until(() => win.Before.Bounds().Height > wasTall, 60);
    yield* settled(ide);

    check("a taller window is a taller diff",
          win.Before.Bounds().Height > wasTall,
          `${wasTall} -> ${win.Before.Bounds().Height}`);

    win.Width = win.Bounds().Width + 200;
    yield* until(() => win.Before.Bounds().Width > wasWide, 60);
    yield* settled(ide);

    check("and a wider window a wider one",
          win.Before.Bounds().Width > wasWide,
          `${wasWide} -> ${win.Before.Bounds().Width}`);

    check("the file list is still there beside it", win.Unstaged.Bounds().Width > 100,
          JSON.stringify(win.Unstaged.Bounds()));
    check("and the buttons are still under it",
          win.BtnCommit.Bounds().Y > win.Before.Bounds().Y,
          `${win.BtnCommit.Bounds().Y} vs ${win.Before.Bounds().Y}`);

    /*
     * --- the diff is a diff and not two files ---------------------------------
     *
     * What was missing and is the whole point of the pane: the lines that
     * changed are **marked**, and the two columns **face each other** -- an
     * added line on the right has a gap opposite it on the left, so the pair
     * stays level and locked scrolling keeps showing the same place.
     *
     * `Uno.js` here is one line added to a two-line file, which is the smallest
     * case that can tell alignment from luck: without it the right column is one
     * line longer and everything below the change is off by one.
     */
    win.Which.Current = 0;
    win.table().Index = win.paths[0].indexOf("Uno.js");
    win.showChosen();
    yield* settled(ide);

    const leftLines  = win.Before.Text.split("\n");
    const rightLines = win.After.Text.split("\n");

    eq("the two columns are the same height", leftLines.length, rightLines.length);
    check("the added line is on the right", rightLines.includes("    // dos"),
          win.After.Text);

    const added = win.After.Marks("Added");
    eq("and it is marked as added", added.length, 1);
    eq("on the line it really is on",
       rightLines[added[0].Line - 1], "    // dos");

    const gaps = win.Before.Marks("Gap");
    eq("with a gap facing it on the left", gaps.length, 1);
    eq("on the same row, which is what keeps the two level",
       gaps[0].Line, added[0].Line);
    eq("and the gap's line is empty", leftLines[gaps[0].Line - 1], "");

    check("nothing is marked as removed here", win.Before.Marks("Removed").length === 0);
    check("and the lines that did not change are not marked",
          win.After.Marks().length === 1, JSON.stringify(win.After.Marks()));

    /*
     * A file git has never been told about has no diff at all -- `git diff` says
     * nothing about an untracked one -- and showing it unmarked would say
     * *nothing changed here* about a file that is entirely new.
     */
    win.table().Index = win.paths[0].indexOf("suelto.txt");
    win.showChosen();
    yield* settled(ide);

    check("an untracked file is all additions",
          win.After.Marks("Added").length > 0, JSON.stringify(win.After.Marks()));
    eq("with nothing to face them on the left",
       win.Before.Marks("Gap").length, win.After.Marks("Added").length);

    /* Choosing another file does not leave the last one's marks behind. */
    win.table().Index = win.paths[0].indexOf("Uno.js");
    win.showChosen();
    yield* settled(ide);
    eq("the marks are the chosen file's and not the last one's",
       win.After.Marks("Added").length, 1);

    /* Staging goes through git: assert it by asking git and not the window. */
    win.Unstaged.Index = win.paths[0].indexOf("Uno.js");
    win.BtnStage_Click();
    yield* settled(ide);

    eq("staging a file puts it in the index", git.split().staged.length, 2);
    eq("and takes it out of the other list",
       git.split().unstaged.map((r) => r.path).join(), "suelto.txt");

    win.Message.Text = "segundo";
    win.BtnCommit_Click();
    yield* settled(ide);

    eq("committing empties the index", git.split().staged.length, 0);
    check("and the commit is really there",
          run("log", "--oneline").Output.includes("segundo"));

    win.Close();
    yield* settled(ide);

    /* --- branches ------------------------------------------------------------ */
    const started = git.branchName;

    eq("there is one branch to start with", git.branches().length, 1);

    ide.MnuGitNewBranch_Click();
    ide.branchAsk.TxtValue.Text = "otra";
    ide.branchAsk.BtnOk_Click();
    yield* settled(ide);

    eq("a new branch is made and stood on", git.branchName, "otra");
    eq("and both are listed", git.branches().sort().join("|"),
       [started, "otra"].sort().join("|"));

    /* The menu marks the one you are on and keeps it in the list: a list that
     * dropped it would make *where am I* a question with no answer on screen. */
    const current = ide.MnuGitBranch.Items.filter((t) => t.startsWith("\u2022"));
    eq("the menu marks exactly one branch as current", current.length, 1);
    check("and it is the one we are on", current[0].includes("otra"), current[0]);
    check("the one you are on cannot be deleted from the menu",
          !ide.MnuGitDropBranch.Items.some((t) => t === "otra"),
          JSON.stringify(ide.MnuGitDropBranch.Items));

    /*
     * Switching back, through the menu rather than by calling git -- and it
     * **asks first**, because there are uncommitted changes here. A switch can
     * refuse halfway and leave the worktree spread across two branches, so the
     * guard is the point and answering it is part of the gesture.
     */
    ide.branchAsk = null;
    ide.MnuGitBranch_Click(ide.branchNames.indexOf(started));
    yield;

    check("switching with changes about asks first", ide.branchAsk !== null);
    ide.branchAsk.BtnYes_Click();
    yield* settled(ide);

    eq("and then goes to the other branch", git.branchName, started);

    /* And deleting the one we are no longer on. */
    ide.MnuGitDropBranch_Click(ide.dropNames.indexOf("otra"));
    yield;
    /* Yes, deliberately: this dialog focuses No and declares nothing default,
     * so that Enter cannot delete anything. */
    ide.branchAsk.BtnYes_Click();
    yield* settled(ide);
    eq("deleting one leaves the other", git.branches().join("|"), started);

    /* --- the history ---------------------------------------------------------- */
    const commits = git.log(10);
    check("the log has the commits", commits.length >= 2, `${commits.length}`);
    eq("newest first", commits[0].subject, "segundo");
    check("with who and when", commits[0].who !== "" && commits[0].when !== "",
          JSON.stringify(commits[0]));

    const touched = git.filesIn(commits[0].sha);
    check("and what each commit touched",
          touched.some((f) => f.path === "Uno.js"), JSON.stringify(touched));

    const win2 = LogForm.open(ide);
    yield* settled(ide);

    check("the History window opens", win2 !== undefined && win2 !== null);

    /* The same window of regions, and the same rule: taller window, taller
     * panes. It was drawn as a `Fixed` too. */
    const logTall = win2.Before.Bounds().Height;
    win2.Height = win2.Bounds().Height + 220;
    yield* until(() => win2.Before.Bounds().Height > logTall, 60);
    yield* settled(ide);

    check("the history's panes grow with it too",
          win2.Before.Bounds().Height > logTall,
          `${logTall} -> ${win2.Before.Bounds().Height}`);
    check("with the close button still under them",
          win2.BtnClose.Bounds().Y > win2.Before.Bounds().Y);

    eq("with a row per commit", win2.Commits.Count, commits.length);
    check("asking again raises the same one", LogForm.open(ide) === win2);
    check("choosing a commit lists what it touched", win2.Touched.Count > 0);

    /*
     * The two versions of one file: what the commit left, and what was there
     * before it. A file the commit *added* has no version before, which is the
     * empty pane and is exactly what "added" means.
     */
    win2.Touched.Index = 0;
    win2.showOne();
    check("and the after pane has the version it left", win2.After.Text !== "");
    check("with the diff beside it", win2.Unified.Text.includes("diff --git"),
          JSON.stringify(win2.Unified.Text.slice(0, 60)));

    win2.Close();
    yield* settled(ide);

    /*
     * --- the Changes page of the side bar ------------------------------------
     *
     * The same repository read in the narrow place. What is asserted is that it
     * is the *same* answer -- the rows are `split()`'s two lists and not a
     * second reading -- and the three gestures that are the point of it: stage
     * from the panel, commit from the box, and a double click landing on that
     * file's diff in the window that exists for it.
     */
    File.Save(File.Join(repo, "Uno.js"), "class Uno extends Form {\n    // tres\n}\n");
    File.Save(File.Join(repo, "cuatro.txt"), "nuevo\n");

    ide.CmbView.Index = Ide.Changes.view;
    ide.CmbView_Select();
    yield* settled(ide);

    check("choosing Changes puts the panel up", ide.ChangesBox.Visible);
    check("and takes the tree down", !ide.FileTree.Visible);

    /* The same rule as the window: the list takes the room, and the message box
     * and its buttons keep theirs. A panel whose table was its natural height
     * would be four rows in a column six hundred pixels tall. */
    const tree = ide.SideBar.Bounds().Height;
    check("the list takes the side bar's height",
          ide.ChangeTable.Bounds().Height > tree / 2,
          `${ide.ChangeTable.Bounds().Height} of ${tree}`);
    check("with the message box under it",
          ide.TxtCommit.Bounds().Y > ide.ChangeTable.Bounds().Y);
    check("and the buttons under that",
          ide.BtnChCommit.Bounds().Y > ide.TxtCommit.Bounds().Y);
    eq("the choice is written down like the tree's",
       Settings.Get("side.changes", false), true);

    const panel = ide.changes;
    const both  = git.split();

    eq("every changed file is a row",
       ide.ChangeTable.Count, both.staged.length + both.unstaged.length);
    check("with the path in it",
          panel.rows.some((r) => r.path === "cuatro.txt"), JSON.stringify(panel.rows));
    check("and an untracked file among them",
          panel.rows.some((r) => r.path === "cuatro.txt" && r.state === "?"));

    /* Staging from the panel, asserted by asking git. */
    ide.ChangeTable.Index = panel.rows.findIndex((r) => r.path === "Uno.js");
    ide.ChangeTable_Select();
    check("a row chosen offers to stage it", ide.MnuChStage.Enabled);
    check("and to throw it away", ide.MnuChDiscard.Enabled);
    check("but not to unstage what was never staged", !ide.MnuChUnstage.Enabled);

    ide.BtnChStage_Click();
    yield* settled(ide);

    eq("staging from the panel reaches git",
       git.split().staged.map((r) => r.path).join(), "Uno.js");
    check("and the row says so now",
          panel.rows.some((r) => r.path === "Uno.js" && r.staged),
          JSON.stringify(panel.rows));

    /* And back out again, through the menu the row offers. */
    ide.ChangeTable.Index = panel.rows.findIndex((r) => r.path === "Uno.js" && r.staged);
    ide.ChangeTable_Select();
    check("a staged row offers to unstage it", ide.MnuChUnstage.Enabled);
    ide.MnuChUnstage_Click();
    yield* settled(ide);

    eq("unstaging reaches git too", git.split().staged.length, 0);

    /* Everything at once, which is what a small commit is. `add -A`, so the
     * untracked file goes in too -- a number here would be a count of whatever
     * the phases above happened to leave, which is not what is being tested. */
    const loose = git.split().unstaged.length;
    ide.MnuChAll_Click();
    yield* settled(ide);

    check("stage everything stages the untracked one as well", loose > 0);
    eq("and leaves nothing outside the commit", git.split().unstaged.length, 0);

    /* The commit, from the one-line box: a message and Enter. */
    check("an empty message commits nothing", !ide.BtnChCommit.Enabled);
    ide.TxtCommit.Text = "tercero";
    ide.TxtCommit_Change();
    check("with a message and something staged it is on", ide.BtnChCommit.Enabled);

    ide.TxtCommit_Activate();
    yield* settled(ide);

    check("Enter in the box commits",
          run("log", "--oneline").Output.includes("tercero"));
    eq("and empties the box", ide.TxtCommit.Text, "");
    eq("leaving nothing staged", git.split().staged.length, 0);
    eq("nor anything else to show", ide.ChangeTable.Count, 0);

    /* A double click is the diff, in the window that reads one. */
    File.Save(File.Join(repo, "Uno.js"), "class Uno extends Form {\n    // cuatro\n}\n");
    ide.refreshGit();
    yield* settled(ide);

    eq("a new change comes back into the panel", ide.ChangeTable.Count, 1);

    ide.ChangeTable.Index = 0;
    ide.ChangeTable_Activate();
    yield* settled(ide);

    const opened = GitForm.open(ide);
    check("double clicking a row opens the window on that file",
          opened.chosen()[0] === "Uno.js", JSON.stringify(opened.chosen()));
    check("with its diff in the panes", opened.After.Text.includes("cuatro"),
          opened.After.Text);
    opened.Close();
    yield* settled(ide);

    /* Rollback, which is the one command with no undo and therefore asks. */
    ide.ChangeTable.Index = 0;
    ide.ChangeTable_Select();
    ide.MnuChDiscard_Click();
    yield;
    ide.changes.ask.BtnYes_Click();
    yield* settled(ide);

    check("discarding from the panel puts the file back",
          !File.Load(File.Join(repo, "Uno.js")).includes("cuatro"));
    eq("and leaves nothing to show", ide.ChangeTable.Count, 0);

    /* An empty table says which kind of empty it is: *nothing has changed* is
     * not the same news as *this is not a repository*. */
    check("an empty panel says so", ide.LblChanges.Visible);
    check("and says nothing has changed", ide.LblChanges.Text.includes("changed"),
          ide.LblChanges.Text);

    /*
     * --- and a save is what changes it -------------------------------------
     *
     * The commonest thing that happens in an IDE, and the panel did not hear
     * about it: the list, the tree's `[M]` and the counts in the status bar all
     * answered about the file as it was *before* it was written, which is the
     * moment somebody is most likely to look at them. Driven through the IDE's
     * own save, with nothing asking git again by hand.
     */
    ide.openInTab("Uno.js");
    yield* settled(ide);

    ide.Editor.Text = `${ide.Editor.Text}\n// desde el editor\n`;
    ide.save();
    yield* settled(ide);

    eq("saving puts the file in the list", ide.ChangeTable.Count, 1);
    check("under its own name",
          panel.rows.some((r) => r.path === "Uno.js"), JSON.stringify(panel.rows));
    eq("and the tree hears about it too", git.stateOf("Uno.js"), "M");
    check("so the panel has nothing left to apologise for", !ide.LblChanges.Visible);

    git.discard(["Uno.js"]);
    ide.closeTabByName("Uno.js", true);
    ide.refreshGit();
    yield* settled(ide);
    eq("and putting it back empties the list again", ide.ChangeTable.Count, 0);

    /* Back to the tree, which is where the phases after this one look. */
    ide.CmbView.Index = 0;
    ide.CmbView_Select();
    yield* settled(ide);
    check("the tree comes back", ide.FileTree.Visible && !ide.ChangesBox.Visible);

    /*
     * --- the remotes ---------------------------------------------------------
     *
     * A **bare repository beside this one**, which is what `origin` is as far
     * as git is concerned: push, fetch and pull are the real commands against a
     * real remote, and there is no network and nothing to authenticate against.
     * A test that needed a server would be a test that is skipped on the machine
     * that matters.
     *
     * The three are asynchronous -- `Exec` and not `Exec.Wait`, which is the
     * whole point of them -- so each is waited for by asking whether the job is
     * over, never by counting frames.
     */
    const bare = File.Join(TMP, "gitbare");
    Directory.Make(bare);
    wipe(bare);
    Exec.Wait(["git", "init", "-q", "--bare", bare], { Timeout: 8000 });

    eq("a repository with no remote has none", git.remoteNames.length, 0);
    check("so there is nothing to fetch from", !ide.MnuGitFetch.Enabled);
    eq("and no distance to anything", git.aheadBehind(), null);

    run("remote", "add", "origin", bare);
    ide.refreshGit();

    eq("the remote is listed once there is one", git.remoteNames.join(), "origin");
    check("and now the remotes are on", ide.MnuGitPush.Enabled);
    eq("a branch that follows nothing has no distance", git.distance, null);

    /* Pushing, which is also what makes the branch follow one: the plan's
     * `--set-upstream`, so git never answers with a command to retype. */
    ide.MnuGitPush_Click();
    check("a job is in flight", git.job !== null);
    check("and a second one is refused rather than queued", !ide.git.push());
    yield* until(() => git.job === null, 300);
    yield* settled(ide);

    check("pushing ends", git.job === null);
    check("and says so in the log", ide.LogView.Text.includes("[git ok]"),
          ide.LogView.Text.slice(-80));
    ide.refreshGit();
    check("the branch follows one afterwards", git.distance !== null,
          JSON.stringify(git.distance));
    eq("and is in step with it", `${git.distance.ahead}/${git.distance.behind}`, "0/0");

    /* Somebody else's commit, made the only honest way: another clone of the
     * same bare repository, pushing to it. */
    const other = File.Join(TMP, "gitother");
    Exec.Wait(["git", "clone", "-q", bare, other], { Timeout: 8000 });
    Exec.Wait(["git", "-C", other, "config", "user.email", "otro@bintana"], { Timeout: 8000 });
    Exec.Wait(["git", "-C", other, "config", "user.name", "Otro"], { Timeout: 8000 });
    File.Save(File.Join(other, "tres.txt"), "desde otro\n");
    Exec.Wait(["git", "-C", other, "add", "-A"], { Timeout: 8000 });
    Exec.Wait(["git", "-C", other, "commit", "-qm", "tercero"], { Timeout: 8000 });
    Exec.Wait(["git", "-C", other, "push", "-q"], { Timeout: 8000 });

    eq("what was not fetched is not counted yet", git.distance.behind, 0);

    ide.MnuGitFetch_Click();
    yield* until(() => git.job === null, 300);
    yield* settled(ide);

    eq("fetching finds the commit somebody else pushed", git.distance.behind, 1);
    check("and has not brought the file down", !File.Exists(File.Join(repo, "tres.txt")));

    ide.MnuGitPull_Click();
    yield* until(() => git.job === null, 300);
    yield* settled(ide);

    check("pulling brings it down", File.Exists(File.Join(repo, "tres.txt")));
    eq("and the branch is in step again", git.distance.behind, 0);
    check("which the status bar says", ide.LblStatus.Text.indexOf("\u2193") === -1,
          ide.LblStatus.Text);

    /*
     * Cloning, which is the one command that runs where there is no project --
     * driven from `cloneInto` because the two answers before it are a prompt and
     * the desktop's folder chooser, and neither is a thing a test can answer.
     */
    const into = File.Join(TMP, "clones");
    Directory.Make(into);
    wipe(into);

    ide.cloneInto(bare, into);
    yield* until(() => git.job === null, 300);
    yield* settled(ide);

    const landed = File.Join(into, "gitbare");
    check("cloning leaves a working tree", File.Exists(File.Join(landed, "Uno.js")));
    eq("named the way git would name it", ide.project, landed);
    check("and what landed is a repository", git.isRepo);

    /*
     * --- a project that is not the root of its repository ---------------------
     *
     * The shape that broke, and it broke completely and quietly: git answers in
     * paths from the **repository** root and every door in the IDE speaks paths
     * from the **project** root, so a project in a subdirectory -- which is what
     * `examples/clients` is in this very repository -- had the tree marking
     * nothing and the diff's right-hand pane empty, because the file it went
     * looking for was `<project>/examples/clients/Main.js`.
     *
     * Everything here is asserted in the IDE's spelling: a row says `Dos.js`,
     * never `sub/Dos.js`, and the worktree half of the diff has the line that
     * was actually written.
     */
    const sub = File.Join(repo, "sub");

    Directory.Make(sub);
    File.Save(File.Join(sub, "project.json"),
              JSON.stringify({ name: "sub", startup: "Dos", sources: ["Dos.js"] }));
    File.Save(File.Join(sub, "Dos.js"), "class Dos extends Form {\n}\n");
    run("add", "-A");
    run("commit", "-qm", "el subproyecto");

    ide.openProject(sub);
    yield* settled(ide);

    check("a project inside a repository is in one", git.isRepo);
    eq("and git says where it is", git.prefix, "sub/");

    File.Save(File.Join(sub, "Dos.js"),
              "class Dos extends Form {\n    // cambiado\n}\n");
    ide.refreshGit();

    eq("a change is seen under the project's own name", git.stateOf("Dos.js"), "M");
    eq("and not under git's", git.stateOf("sub/Dos.js"), "");

    /* What is above the project is not this project's business: the repository
     * root has files of its own, and none of them is in the list. */
    check("nothing from outside the project is listed",
          [...git.split().unstaged, ...git.split().staged]
              .every((r) => !r.path.includes("/") || r.path.startsWith("Otros/")),
          JSON.stringify(git.split()));

    /* The two halves of the diff, which is the failure as it was reported: the
     * original on the left and a blank editor on the right. */
    const winSub = GitForm.open(ide);
    yield* settled(ide);

    winSub.Which.Current = 0;
    winSub.table().Index = winSub.paths[0].indexOf("Dos.js");
    winSub.showChosen();
    yield* settled(ide);

    check("the before pane has the committed version",
          winSub.Before.Text.includes("class Dos"), winSub.Before.Text);
    check("and the after pane has what is on disk",
          winSub.After.Text.includes("cambiado"), winSub.After.Text);
    check("with git's own diff beside it",
          winSub.Unified.Text.includes("+    // cambiado"), winSub.Unified.Text);

    /* And the commands, which take the IDE's spelling and reach the right file. */
    winSub.BtnStage_Click();
    yield* settled(ide);

    eq("staging from a subdirectory stages the right file",
       git.split().staged.map((r) => r.path).join(), "Dos.js");

    winSub.Message.Text = "desde el subproyecto";
    winSub.BtnCommit_Click();
    yield* settled(ide);

    check("and committing commits it",
          run("log", "--oneline").Output.includes("desde el subproyecto"));
    winSub.Close();
    yield* settled(ide);

    /* The history, which reads the same paths back out of a commit. */
    eq("what a commit touched is named the project's way",
       git.filesIn(git.log(1)[0].sha).map((f) => f.path).join(), "Dos.js");
    check("and the file can be read out of it",
          (git.fileAt(git.log(1)[0].sha, "Dos.js") || "").includes("cambiado"));

    ide.openProject(repo);
    yield* settled(ide);
    eq("back at the root the prefix is empty", git.prefix, "");

    /*
     * --- two hunks, which is where a parser that guessed would drift ---------
     *
     * The alignment above is one change in a two-line file. This is a twelve
     * line file changed near the top *and* near the bottom, read through the
     * same call the window makes: if the second hunk's position were read
     * wrongly -- or the unchanged run between the two counted a line out -- the
     * columns would be different heights and the tail would not face itself.
     */
    const twelve = [];
    for (let i = 1; i <= 12; i++) twelve.push(`linea ${i}`);

    File.Save(File.Join(repo, "muchas.txt"), `${twelve.join("\n")}\n`);
    run("add", "-A");
    run("commit", "-qm", "doce lineas");

    const changed = twelve.slice();
    changed[1]  = "linea dos, cambiada";
    changed[10] = "linea once, cambiada";
    File.Save(File.Join(repo, "muchas.txt"), `${changed.join("\n")}\n`);
    ide.refreshGit();

    const pair = Ide.Diff.sideBySide(git.show("", "muchas.txt"),
                                     File.Load(File.Join(repo, "muchas.txt")),
                                     git.diff("muchas.txt", false));

    eq("two hunks keep the columns the same height",
       pair.left.length, pair.right.length);
    eq("and nothing is invented or lost", pair.left.length, 12);

    eq("the first change is a removal facing an addition",
       `${pair.left[1].kind}/${pair.right[1].kind}`, "Removed/Added");
    eq("the second one too, ten rows further down",
       `${pair.left[10].kind}/${pair.right[10].kind}`, "Removed/Added");
    eq("with the new text on the right", pair.right[10].text, "linea once, cambiada");

    const between = pair.left.slice(2, 10);
    check("everything between them is unchanged",
          between.every((r, i) => r.kind === "" && r.text === pair.right[i + 2].text),
          JSON.stringify(between));
    eq("and the last line still faces itself", pair.left[11].text, pair.right[11].text);

    /* Put it back, so what follows sees the repository it expects. */
    git.discard(["muchas.txt"]);
    ide.refreshGit();

    /*
     * --- a rename, which `-z` spells backwards from what one expects --------
     *
     * Measured: after `git mv Uno.js Dos.js`, `git status --porcelain=v1 -z`
     * answers `R  Dos.js\0Uno.js\0` -- the record's own path is the **new**
     * name and the old one is the next record. Read the other way round, the
     * new file was marked deleted and the old one was the row the panel offered
     * to open: a rename whose row goes nowhere.
     */
    run("mv", "Uno.js", "Dos.js");
    ide.refreshGit();
    yield* settled(ide);

    eq("a rename is seen on its new name", git.stateOf("Dos.js"), "R");
    eq("and the name it had is not a file any more", git.stateOf("Uno.js"), "");
    eq("the changes panel offers the new name",
       git.split().staged.map((r) => r.path).join(), "Dos.js");
    eq("with the rename's state", git.split().staged[0].state, "R");

    /* Committed, so nothing below finds the repository mid-gesture. */
    run("commit", "-qm", "renombrado");
    ide.refreshGit();
    yield* settled(ide);

    /*
     * --- a path is a path, not a pattern ------------------------------------
     *
     * `--` keeps a file called `-f` a file and does nothing about `[`: git
     * reads what follows it as a glob, so discarding `data[1].json` restored
     * `data1.json` too -- and the change somebody meant to keep was gone.
     */
    File.Save(File.Join(repo, "data[1].json"), "uno\n");
    File.Save(File.Join(repo, "data1.json"), "uno\n");
    run("add", "-A");
    run("commit", "-qm", "corchetes");
    File.Save(File.Join(repo, "data[1].json"), "cambiado\n");
    File.Save(File.Join(repo, "data1.json"), "cambiado\n");
    ide.refreshGit();
    yield* settled(ide);

    git.discard(["data[1].json"]);
    eq("discarding a file with brackets in its name restores it",
       File.Load(File.Join(repo, "data[1].json")), "uno\n");
    eq("and not the file its name would match as a pattern",
       File.Load(File.Join(repo, "data1.json")), "cambiado\n");
    git.stage(["data[1].json"]);
    eq("staging takes the name literally too",
       run("diff", "--cached", "--name-only").Output.trim(), "");
    run("checkout", "--", "data1.json");

    /*
     * And an untracked **folder**, which the porcelain names as one row
     * (`?? nueva/`): `File.Delete` takes an empty directory and nothing else,
     * so it threw -- after the restore beside it had run -- and the window was
     * left offering rows that were already gone.
     */
    Directory.Make(File.Join(repo, "nueva"));
    File.Save(File.Join(repo, "nueva", "a.txt"), "a\n");
    const dos = File.Load(File.Join(repo, "Dos.js"));
    File.Save(File.Join(repo, "Dos.js"), `${dos}// otra\n`);
    ide.refreshGit();
    yield* settled(ide);

    const fresh = git.split().unstaged.map((r) => r.path);
    check("an untracked folder is one row", fresh.some((p) => p.startsWith("nueva")),
          JSON.stringify(fresh));
    let threw = "";
    try {
        git.discard(fresh);
    } catch (e) {
        threw = e.message;
    }
    eq("discarding an untracked folder does not throw", threw, "");
    check("and the folder is gone", !File.Exists(File.Join(repo, "nueva")));
    eq("with the tracked change beside it restored",
       File.Load(File.Join(repo, "Dos.js")), dos);
    ide.refreshGit();
    yield* settled(ide);

    /*
     * --- back to what the phases after this one expect ----------------------
     *
     * This one opened a **project of its own**, which nothing else here does:
     * git needs a repository and the suite's project is not one. So it puts the
     * suite's project back, or every phase below would be looking at a
     * two-file repository instead of the tree they were written against.
     */
    ide.openProject(TMP);
    yield* settled(ide);
    eq("the suite's own project is back", ide.project, TMP);

    /* And the other kind of empty, which is this project: the panel over
     * something that is not a repository says that rather than nothing. */
    ide.CmbView.Index = Ide.Changes.view;
    ide.CmbView_Select();
    yield* settled(ide);

    eq("a project with no repository shows no rows", ide.ChangeTable.Count, 0);
    check("and says why", ide.LblChanges.Text.includes("repository"),
          ide.LblChanges.Text);
    check("with nothing to type a message into", !ide.TxtCommit.Enabled);

    ide.CmbView.Index = 0;
    ide.CmbView_Select();
    yield* settled(ide);
}

/*
 * The debugger, as far as the IDE owns it.
 *
 * **The whole loop is asserted in `tests/widgets` (`testDebugger`)**, where a
 * program really is stopped on a line, the stack really names its frames and an
 * argument is really read by name -- and where it also guards the third patch
 * in `vendor/`, whose absence builds fine and stops nothing. Driving a child
 * from here would say the same thing again, slower and through a window.
 *
 * What is the IDE's own is everything before the child starts: the commands
 * exist, `F9` puts a mark in the gutter, the gutter *is* the state, and a file
 * closed and opened again keeps its breakpoints. Those are what this asserts.
 */
function* p_debug(ide) {
    for (const name of ["MnuDebug", "MnuPause", "MnuStepInto", "MnuStepOver",
                        "MnuStepOut", "MnuBreakpoint"])
        check(`the Debug menu has ${name}`, ide[name] !== undefined);

    check("and the bottom panel has a page for it",
          ide.ConsoleBox.Tabs.includes("Debug"), JSON.stringify(ide.ConsoleBox.Tabs));
    check("with the stack and the values on it",
          ide.StackList !== undefined && ide.LocalList !== undefined);

    /* Nothing is stopped, so stepping is not offered and the stack is empty. */
    check("stepping is off until something stops", !ide.MnuStepInto.Enabled);
    eq("and the stack is empty", ide.StackList.Count, 0);

    /* The startup form's code, whatever the phases above renamed it to. */
    const startup = ide.manifest.read().Startup;
    const form    = ide.classes.formOfClass(startup);
    const js      = `${form.slice(0, form.length - 4)}js`;

    ide.openInTab(js);
    yield* settled(ide);
    eq("its code is open", ide.activeFile, js);

    const at = ide.navigator.find("Form_Open");
    check("the startup form answers Form_Open", at !== null);

    /* --- the gutter is the state ------------------------------------------- */
    ide.Editor.GotoLine(at.line);
    check("F9 puts a breakpoint down", ide.MnuBreakpoint_Click() !== false);

    /* `Marks` answers records and not line numbers, which is what the debugger
     * itself got wrong first -- so this reads them the way it now does. */
    const lines = () => ide.Editor.Marks("Bookmark").map((m) => m.Line);

    check("the gutter carries it", lines().includes(at.line), JSON.stringify(lines()));
    eq("and the debugger knows of exactly one", ide.debugger_.all().length, 1);
    eq("in the file it was set in", ide.debugger_.all()[0].file, js);
    eq("on the line the caret was on", ide.debugger_.all()[0].line, at.line);

    /* Twice is off again: there is one state and it is the mark. */
    ide.MnuBreakpoint_Click();
    check("pressing it again takes it off", !lines().includes(at.line));
    eq("and the debugger agrees", ide.debugger_.all().length, 0);

    /* --- and it outlives the tab -------------------------------------------- */
    ide.MnuBreakpoint_Click();
    ide.closeTabByName(js, true);
    yield* settled(ide);

    eq("closing the file does not lose it", ide.debugger_.all().length, 1);

    ide.openInTab(js);
    yield* settled(ide);
    check("and opening it again puts the mark back",
          lines().includes(at.line), JSON.stringify(lines()));

    /*
     * --- a mark moves with the editing, and the map has to hear about it -----
     *
     * GtkSourceView moves the mark when text is inserted above it, but the
     * debugger's map is only written when a tab is remembered -- so `all()`
     * read it for an open tab and a run armed the line the file had when it was
     * last remembered. Two lines above the breakpoint is a two-line move.
     */
    const moved = at.line + 2;

    ide.Editor.Select(1, 1, 0);
    ide.Editor.Insert("// una\n// dos\n");
    yield* settled(ide);

    check("the gutter moved the breakpoint with the text",
          lines().includes(moved), JSON.stringify(lines()));
    eq("and the debugger reports where it is now",
       ide.debugger_.all()[0].line, moved);

    /* Back the way it was, so the cleanup below acts on the line it expects. */
    ide.Editor.Undo();
    yield* settled(ide);
    check("undo puts it back", lines().includes(at.line), JSON.stringify(lines()));

    /* --- back to what the phase after this one expects ----------------------- */
    /* The caret went back to the top when the tab reopened, and F9 acts where
     * the caret is -- without this it would *add* a second one on line 1. */
    ide.Editor.GotoLine(at.line);
    ide.MnuBreakpoint_Click();
    eq("the breakpoint is gone", ide.debugger_.all().length, 0);
    ide.closeTabByName(js, true);
    yield* settled(ide);
}

/*
 * How this project is run: three places, and the rule that joins them.
 *
 * The rule is the one thing worth asserting hardest, because it is the one that
 * is easy to get wrong and impossible to see: the global suggestion is
 * **copied** when a configuration is made and never consulted again. A cascade
 * would look identical until somebody changed their own default and every
 * project they had ever configured changed with it.
 *
 * Nothing here spawns a child. What the runner does with a plan is proved by
 * `p_running`, which runs the real thing with the configuration this phase
 * leaves behind -- one child, two questions.
 */
function* p_launch(ide) {
    const launch = ide.launch;

    /* --- a project that declares none ---------------------------------------
     *
     * Which is most projects, and the state Run was in before any of this: the
     * project's own directory and nothing else. A feature everybody has to
     * learn before they can press Run would be a worse feature.
     */
    launch.save([]);
    launch.choose("");

    const bare = launch.plan();
    eq("with no configurations there is nothing to pass", bare.arguments.length, 0);
    eq("...and the child starts where it always did",
       bare.options.Directory, ide.project);
    eq("...with no environment of its own", bare.options.Environment, undefined);
    eq("...and nothing is chosen", launch.chosen, null);

    /* --- the suggestion is a template, not a cascade ------------------------- */

    launch.suggest({ Strict: true, StopOnThrow: true });

    const made = launch.make("Demo");
    eq("a new configuration starts from the suggestion", made.Strict, true);
    eq("...both of them", made.StopOnThrow, true);

    made.Arguments   = ["--data", "/tmp/facturas"];
    made.Environment = ["BTA_DEMO=1"];
    launch.save([made]);

    /* **The measurement that tells a template from a cascade.** */
    launch.suggest({ Strict: false, StopOnThrow: false });
    eq("changing the suggestion does not change what exists",
       launch.named("Demo").Strict, true);

    const plain = launch.make("Plain");
    eq("...and the next one made takes the new one", plain.Strict, false);

    /* --- what a run is made of ---------------------------------------------- */

    const plan = launch.plan();
    eq("the arguments reach the plan", plan.arguments.join(" "), "--data /tmp/facturas");
    eq("...and the environment, as an object Exec takes",
       plan.options.Environment.BTA_DEMO, "1");
    eq("an empty directory means the project's own",
       plan.options.Directory, ide.project);
    eq("and the configuration says this run is strict", plan.strict, true);

    /* A directory of its own is used as it stands. */
    const one = launch.named("Demo");
    one.Directory = "/tmp";
    launch.save([one]);
    eq("a directory that is given is the one used",
       launch.plan().options.Directory, "/tmp");
    one.Directory = "";
    launch.save([one]);

    /* --- the tick only ever adds -------------------------------------------- */

    ide.runner.chose(false);
    check("a configuration that says strict is enough",
          ide.runner.options().includes("--strict"));

    launch.save([launch.make("Loose")]);      /* the suggestion is off now */
    launch.choose("Loose");
    eq("a configuration that does not say so is not strict",
       ide.runner.options().length, 0);

    ide.runner.chose(true);
    check("...until the tick says so anyway",
          ide.runner.options().includes("--strict"));
    ide.runner.chose(false);

    /* --- choosing, which is yours and not the project's ---------------------- */

    const two = [launch.make("First"), launch.make("Second")];
    two[1].Name = "Second";
    launch.save(two);
    launch.choose("");

    eq("with nothing chosen the first one runs", launch.chosen.Name, "First");
    launch.choose("Second");
    eq("choosing one is remembered", launch.chosen.Name, "Second");

    /* A choice that no longer names anything falls back rather than sticking:
     * leaving it written down would make a later configuration of that name
     * silently become the choice. */
    launch.save([launch.make("First")]);
    eq("a choice whose configuration went falls back to the first",
       launch.chosen.Name, "First");

    /* --- the menu ------------------------------------------------------------ */

    launch.save(two);
    launch.choose("Second");
    ide.refresh();

    eq("the menu offers every configuration", ide.MnuLaunch.Items.length, 2);
    eq("...with the chosen one marked", ide.MnuLaunch.Value, 1);
    check("...and it is enabled", ide.MnuLaunch.Enabled);

    /* Choosing from the menu is what the radio item hands over: the entry, not
     * the index, because a name is what the choice is written down as. */
    ide.MnuLaunch_Click(0, "First");
    eq("choosing from the menu chooses it", launch.chosen.Name, "First");

    launch.save([]);
    ide.refresh();
    check("a project with none says so rather than offering an empty menu",
          !ide.MnuLaunch.Enabled);

    /* --- what a record refuses ----------------------------------------------- */

    const bad = launch.make("Bad");
    bad.Environment = ["PORT8080"];
    check("an environment line that is not NAME=value is reported",
          bad.Validate().some((w) => w.includes("NAME=value")),
          JSON.stringify(bad.Validate()));

    /* `check` and a `try`, because this file has `check`, `eq` and `neq` and no
     * `throws` -- reaching for one is how a phase stops in the middle and reads
     * as a hang rather than as a red line. */
    let refused = false;
    try { bad.Name = ""; } catch (e) { refused = true; }
    check("and a configuration with no name is refused where it is set", refused);

    /* --- the dialog, driven ---------------------------------------------------
     *
     * **Which is the half that was missing, and it is where the bug was.** This
     * phase tested `Ide.Launch` and not `LaunchForm`, so eight assignments to a
     * `CheckButton.Value` -- a property a `CheckButton` does not have; it is
     * `Active` -- went in green and blew up the first time a person opened the
     * window. Two other things would have caught it and neither was pointed at
     * this file: `bintana --strict`, which is what finally did and named the
     * property, and `Ide.Check`, which reads exactly this shape. A model without
     * its window is half a test.
     */
    launch.save([]);
    launch.suggest({ Strict: true, StopOnThrow: false });

    let saved = null;
    const dlg = LaunchForm.edit(launch.all, launch.suggestion(),
                                (list, seed) => { saved = { list, seed }; });

    check("the dialog opens on a project with none", dlg !== null);
    eq("...with nothing to edit", dlg.LstLcNames.Count, 0);
    eq("...the fields disabled", dlg.TxtLcName.Enabled, false);
    eq("...and the ticks showing the suggestion", dlg.ChkLcStrict.Active, true);

    dlg.BtnLcAdd_Click();
    eq("Add makes one", dlg.LstLcNames.Count, 1);
    eq("...selected", dlg.LstLcNames.Index, 0);
    eq("...named so it can be chosen", dlg.TxtLcName.Text.length > 0, true);
    eq("...with the fields enabled", dlg.TxtLcName.Enabled, true);
    eq("...and the suggestion copied in", dlg.ChkLcStrict.Active, true);

    dlg.TxtLcName.Text = "From the dialog";
    dlg.TxtLcName_Change();
    eq("renaming it renames the row", dlg.LstLcNames.Text, "From the dialog");
    eq("...without losing the selection", dlg.LstLcNames.Index, 0);

    dlg.TxtLcArgs.Text     = "uno\n\ndos";     /* a blank line is not an argument */
    dlg.TxtLcEnv.Text      = "A=1";
    dlg.ChkLcThrow.Active  = true;
    dlg.BtnLcOk_Click();

    check("Save hands the list back", saved !== null);
    eq("...with the name", saved.list[0].Name, "From the dialog");
    eq("...the arguments, blank lines dropped", saved.list[0].Arguments.join(","), "uno,dos");
    eq("...the environment", saved.list[0].Environment.join(","), "A=1");
    eq("...and both ticks", `${saved.list[0].Strict} ${saved.list[0].StopOnThrow}`,
       "true true");
    eq("and the suggestion for whatever is made next",
       `${saved.seed.Strict} ${saved.seed.StopOnThrow}`, "true true");

    /* Nothing was written: the dialog works on a copy, and this one was never
     * handed to `save`. */
    eq("the project is untouched until somebody saves it", launch.all.length, 0);

    /* --- and what `p_running` will start -------------------------------------
     *
     * `Tabs.js`, because `Tabs` is what this project starts at by now -- the
     * manifest says so and has since `p_views` rewrote it. Writing `Main.js`
     * instead cost a green run: the child started, printed what it always
     * printed, and the two questions this leaves for `p_running` were asked of a
     * file nothing loads.
     */
    File.Save(File.Join(TMP, "Tabs.js"),
              'class Tabs extends Form {\n' +
              '    Form_Open() {\n' +
              '        print("hello from tabs");\n' +
              '        print("args: " + Application.Arguments.join(","));\n' +
              '        print("env: " + Environment.Get("BTA_DEMO", "none"));\n' +
              '        Application.Quit(0);\n' +
              '    }\n' +
              '    Ok_Click() {}\n' +
              '}\n');

    const run = launch.make("With arguments");
    run.Arguments   = ["uno", "dos"];
    run.Environment = ["BTA_DEMO=si"];
    launch.save([run]);
    launch.choose("With arguments");
    ide.refresh();
    yield;
}

function* p_running(ide) {
    /* --- running -----------------------------------------------------------
     * By this point the child project has been renamed, rewritten and moved
     * about by a dozen phases, so running it in another process proves all of
     * that left something that really starts, not just files with other names.
     * What it starts at is `Tabs`, which the manifest has said since `p_views`;
     * `p_launch` writes that file and the configuration this run uses. */
    let out = "";
    const log = ide.log.bind(ide);

    /* From here on the run ends when the child does, not when this generator
     * does. */
    reportsItself = true;
    ide.log = (text) => {
        out += text;
        log(text);
        if (!text.includes("[finished")) return;

        /*
         * Nothing to wait for any more.  `Exec` calls the exit callback only
         * once both pipes have seen EOF and `Append` puts a line in the buffer
         * as it arrives, so everything the child printed is in `Text` by the
         * time this runs -- where a terminal was still digesting the last of
         * the pty output a quarter of a second later, and this probe had to
         * sit behind a `Timer.After(250)` to see it.
         *
         * It does still run *inside* the exit callback, before `finished` has
         * re-enabled the toolbar: one turn, not a delay.
         */
        Timer.After(0, () => {
            const shown = ide.LogView.Text;
            check("the child's output reaches the log",
                  shown.includes("hello from tabs"), JSON.stringify(shown));

            /*
             * And the chosen launch configuration really reached it: the
             * arguments after the project directory, and a variable added to
             * the environment. `p_launch` left them; this is the one child run
             * in the phase list, so it answers both questions.
             */
            check("the configuration's arguments reach the child",
                  shown.includes("args: uno,dos"), JSON.stringify(shown));
            check("...and so does its environment",
                  shown.includes("env: si"), JSON.stringify(shown));
            check("a clean exit is reported", out.includes("[finished ok]"),
                  JSON.stringify(out));
            eq("Run re-enables when the child exits", ide.BtnRun.Enabled, true);
            eq("Stop disables when the child exits", ide.BtnStop.Enabled, false);
            report();
        });
    };

    ide.BtnRun.Click();
    eq("Run disables while running", ide.BtnRun.Enabled, false);
    eq("Stop enables while running", ide.BtnStop.Enabled, true);
}

/*
 * The phases, in the order they have to run in.
 *
 * One scope each, which is the point: this was a single 4000-line generator where
 * every `const` shared one scope, so a name near the top collided with one added
 * at the bottom -- three times in one sitting, over declarations two thousand
 * lines apart.
 *
 * They are a *narrative*, not a set of independent cases: each one works on the
 * project the ones before it built, renamed and edited. So a run can stop early
 * but cannot start late -- which is exactly what selecting one is for, iterating
 * on a phase without paying for the ones after it.
 */

/* --- recovery: what a crash would have taken ------------------------------
 *
 * The net under the dirty tabs. What is asserted is the whole road and not the
 * timer: a snapshot is written aside, it holds what the *live* editor holds
 * rather than what the tab last saved, opening the project offers it, and
 * recovering puts the text back into a dirty tab -- with the file on disk
 * untouched at every step, which is the property the whole design rests on.
 *
 * The timer itself is not driven: thirty seconds of a run waiting for one tick
 * would be thirty seconds of nothing, and what it does is call `snapshot`,
 * which is called here directly.
 *
 * A fixture of its own, like `search`'s, because what is asserted is the exact
 * content on both sides of the crash.
 */
function* p_recovery(ide) {
    const SOURCE = [
        "class Recover extends Form {",
        "    Form_Open() {",
        "    }",
        "}",
        "",
    ].join("\n");
    const FORM = {
        format: "bintana-form/1",
        class: "Recover",
        properties: { Width: 300, Height: 120 },
        children: [],
    };

    /*
     * **The IDE's own tick is held for the phase**, and the snapshots below are
     * taken by hand. Recovering leaves the tab dirty on purpose, so a tick that
     * lands between answering the offer and asking whether the snapshot is gone
     * writes a new one -- which is correct behaviour and a red assertion. Every
     * thirty seconds is never under an ordinary run and was once under
     * `tests/asan.sh`, whose `ide` takes ten minutes. The phase re-arms it with
     * `start()` further down, which is what it tests about the interval.
     */
    if (ide.recovery.timer) ide.recovery.timer.Stop();

    const path = File.Join(TMP, "Recover.js");
    File.Save(path, SOURCE);
    File.SaveJson(File.Join(TMP, "Recover.form"), FORM);
    ide.listFiles();

    ide.openInTab("Recover.js");
    yield* settled(ide);

    const typed = `${SOURCE}/* a line nobody saved */\n`;
    ide.Editor.Text = typed;
    yield* settled(ide);

    check("the tab is dirty", ide.tabs.hasDirty(), ide.tabs.dirtyNames().join(","));

    const file = ide.recovery.fileFor(ide.project);
    check("a snapshot is written", ide.recovery.snapshot() && File.Exists(file), file);
    eq("and the project file is not touched", File.Load(path), SOURCE);

    const shot = ide.recovery.pending(ide.project);
    check("it names the project it came from",
          shot && shot.project === ide.project, JSON.stringify(shot && shot.project));
    const mine = shot.files.filter((f) => f.name === "Recover.js");
    eq("and holds the dirty file", mine.length, 1);
    /* The live editor and not `state.text`: the active tab is the one a crash
     * is most likely to take, and the one whose saved state is stalest. */
    eq("with what is on screen, not what was last switched away from",
       mine[0].text, typed);

    eq("a tick that changed nothing writes nothing", ide.recovery.snapshot(), false);

    /* What the user would have lost: the tab back to the file, as a fresh
     * session would open it. */
    ide.Editor.Text = SOURCE;
    ide.Editor.Modified = false;
    yield* settled(ide);

    const asked = ide.recovery.offer(ide.project);
    check("a project with one pending asks", !!asked);
    asked.BtnYes.Emit("Click");
    yield* settled(ide);

    ide.tabs.switchTo("Recover.js");
    yield* settled(ide);
    eq("recovering puts the work back", ide.Editor.Text, typed);
    check("in a tab that says it is unsaved",
          ide.tabs.dirtyNames().includes("Recover.js"),
          ide.tabs.dirtyNames().join(","));
    eq("and still without touching the file", File.Load(path), SOURCE);
    check("the answered snapshot is gone", !File.Exists(file));

    /* A form tab travels as its tree, which is the half of what the IDE edits
     * that a text snapshot could not have carried. */
    ide.openInTab("Recover.form");
    yield* settled(ide);
    const design = ide.tabs.contentOf("Recover.form");
    eq("a form tab snapshots as a design", design.mode, "design");
    eq("holding the tree the surface is drawing", design.root.class, "Recover");

    /* --- how often, which is the user's and not ours --------------------- */
    eq("thirty seconds until somebody says otherwise", ide.recovery.seconds(), 30);
    check("and the tick is running", ide.recovery.timer !== null);

    const askWin = ide.MnuRecovery_Click();
    yield;
    check("the menu item asks", !!askWin);
    eq("with what is in force now", askWin.TxtValue.Text, "30");

    askWin.TxtValue.Text = "120";
    askWin.BtnOk.Emit("Click");
    yield* settled(ide);
    eq("a new interval is remembered", ide.recovery.seconds(), 120);
    eq("...and is what the timer now waits", ide.recovery.timer.Delay, 120000);

    /* Below the floor is not a refusal: it is a person saying *as often as you
     * can*, and the floor is what that means. */
    Settings.Set("recovery.seconds", 1);
    eq("under the floor reads as the floor", ide.recovery.seconds(), 5);
    /* And a hand-edited setting file that says something else does not take the
     * IDE down with it. */
    Settings.Set("recovery.seconds", "often");
    eq("nonsense falls back to the default", ide.recovery.seconds(), 30);

    /* Turning it off must not delete what the last tick saw: it is somebody's
     * only copy of that work until they save it. */
    ide.recovery.snapshot();
    check("there is a snapshot to keep", File.Exists(file), file);

    Settings.Set("recovery.seconds", 0);
    ide.recovery.start();
    eq("zero is off", ide.recovery.timer, null);
    check("and turning it off leaves the snapshot where it was",
          File.Exists(file), file);

    Settings.Set("recovery.seconds", 30);
    ide.recovery.start();
    check("and it comes back on", ide.recovery.timer !== null);

    /* Nothing dirty means nothing to recover: a snapshot left behind would
     * offer to restore what is already in the project. */
    ide.tabs.switchTo("Recover.js");
    yield* settled(ide);
    ide.Editor.Text = SOURCE;
    ide.Editor.Modified = false;
    yield* settled(ide);
    ide.recovery.snapshot();
    check("a clean session leaves no snapshot", !File.Exists(file));
    check("and has nothing to offer", ide.recovery.offer(ide.project) === null);
}

/* --- unsaved: every road that used to drop it -----------------------------
 *
 * Five ways the IDE threw away typed and unsaved text without asking, each of
 * which went through a path that *forced* or *reloaded* rather than asked:
 * closing several tabs, leaving the project, writing a handler, renaming a
 * control, renaming a form -- plus the recovery snapshot that outlived a clean
 * close and offered old text back. Each assertion is the typed line surviving,
 * or the question being asked before anything moves.
 */
function* p_unsaved(ide) {
    ide.tabs.discardAll();
    yield* settled(ide);

    const SOURCE = [
        "class Keep extends Form {",
        "    Form_Open() {",
        "    }",
        "}",
        "",
    ].join("\n");
    File.Save(File.Join(TMP, "Keep.js"), SOURCE);
    File.SaveJson(File.Join(TMP, "Keep.form"), {
        format: "bintana-form/1", class: "Keep",
        properties: { Width: 300, Height: 160 },
        children: [{ type: "Button", name: "Btn",
                     properties: { X: 10, Y: 10, Width: 80, Height: 30, Text: "b" } }],
    });
    ide.listFiles();

    const TYPED = "    /* typed, never saved */\n";
    const typeInto = function* () {
        ide.openInTab("Keep.js");
        yield* settled(ide);
        ide.Editor.Text = ide.Editor.Text.replace("    Form_Open() {", TYPED + "    Form_Open() {");
        yield* settled(ide);
    };

    /* --- writing a handler into a dirty .js ------------------------------ */
    yield* typeInto();
    ide.openInTab("Keep.form");
    yield* settled(ide);
    check("a handler is written with the .js dirty",
          ide.formFiles.openHandler("Btn", "Click"));
    yield* settled(ide);
    const withHandler = ide.Editor.Text;
    check("the typed line survives the handler", withHandler.includes(TYPED), withHandler);
    check("and the handler is in the same text", withHandler.includes("Btn_Click() {"), withHandler);
    check("as an edit that undo can take back", ide.Editor.CanUndo);
    check("the tab is still unsaved, since it was before",
          ide.tabs.dirtyNames().includes("Keep.js"), ide.tabs.dirtyNames().join(","));
    check("and nothing typed reached the file",
          !File.Load(File.Join(TMP, "Keep.js")).includes(TYPED));

    /* --- renaming a control with its .js dirty --------------------------- */
    ide.openInTab("Keep.form");
    yield* settled(ide);
    ide.designer.select(byName(ide, "Btn"));
    yield* settled(ide);
    check("renaming the control works", ide.designer.renameControl("Ok"));
    yield* settled(ide);
    const jsState = ide.openTabs.get("Keep.js");
    check("the open tab follows the rename",
          jsState.editor.Text.includes("Ok_Click() {") &&
          !jsState.editor.Text.includes("Btn_Click"), jsState.editor.Text);
    check("keeping what was typed", jsState.editor.Text.includes(TYPED));
    check("and staying unsaved", ide.tabs.dirtyNames().includes("Keep.js"));
    /* The handler was only ever in the unsaved tab, so the file has none to
     * move; what it must not have is the old name. */
    check("while the file keeps no trace of the old name",
          !File.Load(File.Join(TMP, "Keep.js")).includes("Btn_"));

    /* A name the code still answers for is not free. */
    ide.designer.select(byName(ide, "Ok"));
    yield* settled(ide);
    jsState.editor.Text = jsState.editor.Text.replace(
        "    Form_Open() {", "    Gone_Click() {\n    }\n    Form_Open() {");
    yield* settled(ide);
    eq("renaming onto a name with handlers is refused",
       ide.designer.renameControl("Gone"), false);
    check("and the control keeps its name", !!byName(ide, "Ok"));

    /* --- closing several tabs asks ---------------------------------------- */
    ide.openInTab("Keep.form");
    yield* settled(ide);
    const asked = ide.MnuTabOthers_Click();
    check("Close others asks about the unsaved one", !!asked);
    check("and has closed nothing yet", ide.openTabs.has("Keep.js"));
    asked.BtnOther.Emit("Click");                 /* Save and close */
    yield* settled(ide);
    check("Save and close closes it", !ide.openTabs.has("Keep.js"));
    check("having saved what was typed",
          File.Load(File.Join(TMP, "Keep.js")).includes(TYPED));

    /* --- leaving the project asks ------------------------------------------ */
    yield* typeInto();
    let left = false;
    const leaving = ide.leaveProject(() => { left = true; });
    check("leaving with unsaved work asks", !!leaving && !left);
    leaving.BtnNo.Emit("Click");
    yield* settled(ide);
    check("and No stays", !left && ide.openTabs.has("Keep.js"));

    /* --- renaming a form with its .js dirty ------------------------------------ */
    eq("a form renames with its .js unsaved", ide.renameForm("Keep", "Kept"), true);
    yield* settled(ide);
    const kept = ide.openTabs.get("Kept.js");
    check("the open .js follows the class it holds",
          kept && kept.editor.Text.includes("class Kept extends Form") &&
          !kept.editor.Text.includes("class Keep "), kept && kept.editor.Text);
    check("keeping what was typed into it", kept && kept.editor.Text.includes(TYPED));
    check("still unsaved", ide.tabs.dirtyNames().includes("Kept.js"));
    check("while the file on disk has the new class",
          File.Load(File.Join(TMP, "Kept.js")).includes("class Kept extends Form"));
    ide.tabs.saveAllDirty();
    yield* settled(ide);

    /* --- a clean close forgets the snapshot ---------------------------------- */
    ide.openInTab("Kept.js");
    yield* settled(ide);
    ide.Editor.Text = ide.Editor.Text + "// dirty\n";
    yield* settled(ide);
    const file = ide.recovery.fileFor(ide.project);
    check("a snapshot is written for the dirty tab", ide.recovery.snapshot() && File.Exists(file));
    ide.tabs.saveAllDirty();
    yield* settled(ide);
    ide.leaving();
    check("saving and closing leaves no snapshot to offer", !File.Exists(file));

    /* And leaving the project is an answer too. */
    ide.Editor.Text = ide.Editor.Text + "// dirty again\n";
    yield* settled(ide);
    ide.recovery.snapshot();
    const discard = ide.leaveProject(() => { left = true; });
    discard.BtnYes.Emit("Click");                 /* Discard and continue */
    yield* settled(ide);
    check("discarding goes on", left);
    check("and takes the snapshot with it", !File.Exists(file));

    ide.tabs.discardAll();
    yield* settled(ide);
}

/*
 * The desk, as it was left: the window's own furniture, and the tabs of the
 * project that is open.
 *
 * The two are asserted apart because they are kept apart -- one entry for the
 * window, one per project -- and the reason is the whole design of `Session`:
 * how wide the tree is is an answer about a screen, and what is open is an
 * answer about the work.
 */
function* p_session(ide) {
    ide.tabs.discardAll();
    yield* settled(ide);

    /* --- the window ------------------------------------------------------- */

    const wasWide = ide.Width, wasTall = ide.Height;
    const home    = ide.Split.Position;
    const wasConsole = ide.RightSplit.Position;

    /* Down and not up: the pane over the console has a minimum height of its
     * own, and a divider asked for a position GTK will not give it is a test
     * asserting about the toolkit rather than about this file. */
    const console_ = wasConsole + 30;

    ide.Split.Position      = home + 40;
    ide.RightSplit.Position = console_;
    ide.session.noteSize(980, 640);
    ide.session.saveWindow();

    const win = Settings.Get("session.window", null);
    check("the window is written down", !!win, JSON.stringify(win));
    eq("with the size it was last seen at", win.width, 980);
    eq("and its height", win.height, 640);
    eq("and where the tree divider was", win.dividers.Split, home + 40);
    eq("and where the console one was", win.dividers.RightSplit, console_);

    /* A number that could not have come from a resize is a file somebody has
     * edited by hand, and the last real size stands. */
    ide.session.noteSize(12, 12);
    ide.session.saveWindow();
    eq("nonsense is not a size", Settings.Get("session.window", {}).width, 980);

    /*
     * The size, asked of the form itself: `Width` is what the window requests,
     * which is the same number a `.form` declares and the same one this puts
     * back -- and it is an answer no window manager has a vote in, which is
     * what makes it assertable on a virtual display.
     */
    Settings.Set("session.window", { width: 1200, height: 800, dividers: {} });
    ide.session.restoreWindow();
    yield* settled(ide);
    eq("the window asks for the size it was left at", ide.Width, 1200);
    eq("and the height", ide.Height, 800);

    /*
     * The dividers, put back where they were -- and with two names in the same
     * file that are not dividers at all. **The list is read in one direction**:
     * what the file holds is what each divider is worth, never which control to
     * touch, so `Tabs` and `FileTree` here name nothing and move nothing while
     * the two real ones are restored around them.
     */
    ide.Split.Position      = home;
    ide.RightSplit.Position = wasConsole;
    yield* settled(ide);
    eq("moved away", ide.Split.Position, home);

    Settings.Set("session.window",
                 { dividers: { Split: home + 40, RightSplit: console_,
                               Tabs: 3, FileTree: 7 } });
    ide.session.restoreWindow();
    yield* settled(ide);
    eq("a divider is put back where it was left", ide.Split.Position, home + 40);
    eq("...and so is the one under it", ide.RightSplit.Position, console_);

    /* --- what was open ---------------------------------------------------- */

    File.Save(File.Join(TMP, "Desk.js"),
              "class Desk {\n    one() {}\n    two() {}\n    three() {}\n}\n");
    ide.listFiles();

    ide.openInTab("Desk.js");
    yield* settled(ide);
    ide.Editor.Select(4, 5);
    yield* settled(ide);
    ide.openInTab("Recover.form");
    yield* settled(ide);

    eq("two tabs to remember", ide.Tabs.Count, 2);
    ide.session.saveTabs();

    const mine = ide.session.tabsOf(ide.project);
    check("the project has a session", !!mine, JSON.stringify(mine));
    eq("holding what was open, in the order the strip had it",
       mine.files.map((f) => f.name).join(","), "Desk.js,Recover.form");
    eq("and which one was in front", mine.active, "Recover.form");
    eq("with the line the caret was on", mine.files[0].line, 4);
    eq("and the column it was in, or half a caret comes back",
       mine.files[0].column, 5);
    check("and nothing about the form's, which has no line",
          mine.files[1].line === undefined, JSON.stringify(mine.files[1]));

    /* ...and back, which is what opening the project again does. */
    ide.closeAllTabs();
    yield* settled(ide);
    eq("the desk is clear", ide.Tabs.Count, 0);

    eq("both come back", ide.session.restoreTabs(ide.project), 2);
    yield* settled(ide);
    eq("in the strip", ide.Tabs.Count, 2);
    eq("with the one that was in front in front", ide.activeFile, "Recover.form");

    ide.tabs.switchTo("Desk.js");
    yield* settled(ide);
    eq("and the caret where it was left", ide.Editor.Line, 4);
    eq("and in the column it was left in", ide.Editor.Column, 5);

    /*
     * A file the project no longer has is skipped and nothing is said. Saying
     * something is right when a person asked for that file by name and wrong
     * six times over when a `git checkout` has taken half of them away -- and a
     * dialog here would be one nobody is in front of.
     */
    const all = ide.session.projects();
    all[ide.project] = { files: [{ name: "Desk.js" }, { name: "Gone.js" }],
                         active: "Gone.js" };
    Settings.Set("session.projects", all);

    ide.closeAllTabs();
    yield* settled(ide);
    eq("only what is still there is reopened",
       ide.session.restoreTabs(ide.project), 1);
    yield* settled(ide);
    eq("and it is the one that exists", ide.activeFile, "Desk.js");

    /*
     * And a file that is there and cannot be *read* is stepped over the same
     * way. Before a session there was no way for this to happen except to
     * somebody who had just clicked on the file; now it happens while a project
     * opens, with the recovery offer still to come, so one broken `.form` must
     * not take the rest of the desk -- or the project -- with it.
     */
    File.Save(File.Join(TMP, "Broken.form"), "{ this is not a form");
    const broken = ide.session.projects();
    broken[ide.project] = { files: [{ name: "Broken.form" }, { name: "Desk.js" }],
                            active: "Desk.js" };
    Settings.Set("session.projects", broken);

    ide.closeAllTabs();
    yield* settled(ide);
    eq("one that cannot be read does not take the others with it",
       ide.session.restoreTabs(ide.project), 1);
    yield* settled(ide);
    eq("and the one that can is open", ide.activeFile, "Desk.js");
    File.Delete(File.Join(TMP, "Broken.form"));

    /* Nothing open is not a session: the entry goes rather than being kept
     * empty. */
    ide.closeAllTabs();
    yield* settled(ide);
    ide.session.saveTabs();
    check("a project with nothing open is not remembered",
          ide.session.tabsOf(ide.project) === null);

    /*
     * And the map is bounded by the recent list: a project the menu no longer
     * offers to reopen takes its session with it, which is what keeps the file
     * from growing for ever.
     */
    const stale = ide.session.projects();
    stale["/tmp/a-project-nobody-remembers"] = { files: [{ name: "x.js" }] };
    Settings.Set("session.projects", stale);

    ide.openInTab("Desk.js");
    yield* settled(ide);
    ide.session.saveTabs();

    check("one the recent list has dropped is dropped here too",
          ide.session.projects()["/tmp/a-project-nobody-remembers"] === undefined,
          JSON.stringify(ide.session.projects()));
    check("and the one it still offers is kept",
          ide.session.tabsOf(ide.project) !== null);

    /*
     * And the door that is easy to miss: the window's own X. `Form_Close`
     * closes by *returning*, so it never reaches `quit()` -- which is why what
     * is owed on the way out is a list of its own (`leaving`) and not a step
     * inside one of the two ways of leaving. Found by reading the settings file
     * after a real session and seeing nothing in it.
     */
    Settings.Set("session.projects", {});
    check("nothing is remembered yet",
          ide.session.tabsOf(ide.project) === null);

    check("closing the window asks nothing with everything saved",
          !ide.Form_Close());
    check("and the desk is written down on the way out",
          ide.session.tabsOf(ide.project) !== null,
          JSON.stringify(ide.session.projects()));

    /* Back to what the phases after this one expect: the window the size it
     * was, a clear desk, and no session to reopen it from. */
    ide.closeAllTabs();
    ide.Resize(wasWide, wasTall);
    ide.Split.Position      = home;
    ide.RightSplit.Position = wasConsole;
    yield* settled(ide);
    Settings.Set("session.projects", {});
    Settings.Delete("session.window");
    File.Delete(File.Join(TMP, "Desk.js"));
    ide.listFiles();
}

const PHASES = [
    { name: "welcome", run: p_welcome },
    { name: "files", run: p_files },
    { name: "designer", run: p_designer },
    { name: "palette", run: p_palette },
    { name: "clipboard", run: p_clipboard },
    { name: "taborder", run: p_taborder },
    { name: "completion", run: p_completion },
    { name: "handlers", run: p_handlers },
    { name: "events", run: p_events },
    { name: "goto", run: p_goto },
    { name: "images", run: p_images },
    { name: "watch", run: p_watch },
    { name: "foreign", run: p_foreign },
    { name: "prefixes", run: p_prefixes },
    { name: "background", run: p_background },
    { name: "tooldirs", run: p_tooldirs },
    { name: "namespaces", run: p_namespaces },
    { name: "selfns", run: p_selfns },
    { name: "views", run: p_views },
    { name: "document", run: p_document },
    { name: "help", run: p_help },
    { name: "forms", run: p_forms },
    { name: "nested", run: p_nested },
    { name: "projects", run: p_projects },
    { name: "menus", run: p_menus },
    { name: "folders", run: p_folders },
    { name: "strings", run: p_strings },
    { name: "settings", run: p_settings },
    { name: "columns", run: p_columns },
    { name: "export", run: p_export },
    { name: "apps", run: p_apps },
    { name: "errors", run: p_errors },
    { name: "problems", run: p_problems },
    { name: "names", run: p_names },
    { name: "outline", run: p_outline },
    { name: "check", run: p_check },
    { name: "quick", run: p_quick },
    { name: "recovery", run: p_recovery },
    { name: "unsaved",  run: p_unsaved },
    { name: "session", run: p_session },
    { name: "search", run: p_search },
    { name: "git", run: p_git },
    { name: "debug", run: p_debug },
    { name: "launch", run: p_launch },
    { name: "running", run: p_running },
];

/* What ran, and whether that was all of it. A partial run must never read like a
 * whole one. */
const ran = [];
let partial = false;

/*
 * Set by whoever ends the run on its own.  The `running` phase reports from the
 * child's exit callback, and `list` has already quit -- everything else is over
 * when the generator is, which is what `drive` now acts on.  Without this, a run
 * that stopped before the last phase reported nothing and never exited: it hung
 * until the runner's timeout, which reads exactly like a test that froze.
 */
let reportsItself = false;

/*
 * `./tests/run.sh ide <name>` runs every phase up to and including the last one
 * whose name contains <name>; `list` prints the names.
 */
function chosenPhases() {
    const only = (Application.Arguments[1] || "").trim();
    if (!only) return PHASES;

    if (only === "list") {
        for (const p of PHASES) print(`  ${p.name}`);
        reportsItself = true;
        Application.Quit(0);
        return [];
    }

    let last = -1;
    for (let i = 0; i < PHASES.length; i++) {
        if (PHASES[i].name.includes(only)) last = i;
    }
    if (last < 0) {
        failures.push(`no phase matches "${only}" -- try one of: ` +
                      PHASES.map((p) => p.name).join(", "));
        return [];
    }
    return PHASES.slice(0, last + 1);
}

function* runIdeTests(ide) {
    const phases = chosenPhases();
    partial = phases.length !== PHASES.length;

    /*
     * **An uncaught error is a failure**, and until this it was a paragraph on
     * stderr that nothing read.
     *
     * The runtime prints one and carries on, which is right for an application
     * -- a handler that throws should not take the window with it -- and wrong
     * for a suite: `GitForm` shipped with a `Switcher` raising `Switch` during
     * its own `.form` load, threw six TypeErrors into a green run, and the
     * phase that opened it asserted the window existed and moved on. Every
     * assertion it made was true and the window was broken.
     *
     * `Application.OnError` takes them over, so what a handler throws lands
     * here with a name and a place instead of scrolling past.
     */
    Application.OnError = (message, stack) => {
        const where = (stack || "").split("\n")[1] || "";
        failures.push(`uncaught in a handler: ${message}${where ? ` (${where.trim()})` : ""}`);
    };

    for (const phase of phases) {
        ran.push(phase.name);
        yield* phase.run(ide);
    }
}


/* Wrap the IDE's own Form_Open rather than replacing it: the test exercises
 * the real startup path, then drives it. */
const originalFormOpen = MainForm.prototype.Form_Open;

/*
 * The designer places clicks by asking GTK's layout, and the layout does not
 * exist until the window is presented and allocated.  Form_Open runs before that,
 * so it has to wait: Glass has no size of its own, so its Width only stops being
 * zero once GTK has allocated it.
 */
function whenLaidOut(ide, run, tries) {
    /*
     * **This waits for a good deal less than it looks like.** `Width` reports
     * what was *requested*, falling back to the allocation only when nothing
     * was, and FileTree declares 260 -- so it answers before GTK has allocated
     * anything and this returns at once. Every assertion after it has been
     * getting by on the `yield`s in the phases themselves.
     *
     * Swapping in `Bounds()`, which is the allocation and nothing else, makes it
     * wait for real -- and then it times out, so something in the driver's
     * startup does not lay the window out when this runs. Worth chasing on its
     * own account; it is not what any current failure is about.
     */
    if (ide.FileTree.Width > 0) { run(); return; }
    if (tries > 80) {
        failures.push("the window was never allocated; the designer could not be tested");
        report();
        return;
    }
    Timer.After(25, () => whenLaidOut(ide, run, tries + 1));
}

/*
 * The test's `yield`s are the points where control has to go back to GTK: the
 * designer places clicks by asking the layout, and an area just shown has no
 * layout until the next frame.  A generator lets those be marked without
 * splitting the test into callbacks.
 */
function drive(steps) {
    const step = () => {
        let done;
        try {
            done = steps.next().done;
        } catch (e) {
            failures.push(`uncaught: ${e.message}\n${e.stack || ""}`);
            report();
            return;
        }
        if (!done) { Timer.After(40, step); return; }

        /* Done, and nobody else is going to say so. */
        if (!reportsItself) report();
    };
    step();
}

MainForm.prototype.Form_Open = function () {
    originalFormOpen.call(this);
    whenLaidOut(this, () => drive(runIdeTests(this)), 0);
};
