/*
 * The examples that come with the runtime, offered from the welcome page and
 * the File menu.
 *
 * **What it opens is a copy.** The examples are installed beside the IDE
 * (`<prefix>/share/bintana/examples`), under a prefix nobody writes to, so the
 * first save of an example opened in place failed; and in the source tree they
 * are the repository's own, where a stray drag and a save edit them for real.
 * The copy goes in the folder New project uses, named after the example, and
 * is an ordinary project from then on.
 *
 * **Where they are is asked, not assumed.** The examples sit beside `lib/` in
 * every layout the runtime has -- the tree, an install, the Windows zip -- so
 * the folder is found from where a shipped library is (`Application.
 * LibraryPath`), and from the IDE's own directory before that. With neither,
 * `folder()` answers `""` and the IDE does not offer the command at all.
 */
"use strict";

export class ExampleForm extends Form {

    /* The examples folder this installation has, or `""`. */
    static folder() {
        const places = [File.Join(File.Directory(Application.Directory), "examples")];
        const lib = Application.LibraryPath("dialog");
        if (lib) places.push(File.Join(File.Directory(File.Directory(lib)), "examples"));

        for (const dir of places)
            if (File.IsDir(dir) && ExampleForm.list(dir).length) return File.Absolute(dir);
        return "";
    }

    /* Every example in `dir`: a folder with a `project.btp`, its name and what
     * it says it is. A manifest that does not read is left out rather than
     * offered broken. */
    static list(dir) {
        const out = [];
        for (const name of Directory.List(dir).sort()) {
            const path = File.Join(dir, name);
            const btp  = File.Join(path, "project.btp");
            if (!File.IsDir(path) || !File.Exists(btp)) continue;

            let config;
            try { config = File.LoadJson(btp); } catch (e) { continue; }
            out.push({ name, path,
                       description: typeof config.description === "string"
                                    ? config.description : "",
                       console: typeof config.main === "string" });
        }
        return out;
    }

    /* A folder under `base` that does not exist yet: the example's name, then
     * `-2`, `-3` -- a second copy of `hello` must not land on the first. */
    static freshTarget(base, name) {
        let target = File.Join(base, name);
        for (let n = 2; File.Exists(target); n++) target = File.Join(base, `${name}-${n}`);
        return target;
    }

    /*
     * ExampleForm.ask(folder, base, onOpened)
     *
     * `onOpened(dir)` runs with the copy once it is written. Answers the
     * dialog, which `tests/ide` drives.
     */
    static ask(folder, base, onOpened) {
        const dlg = new ExampleForm();

        dlg.base     = base;
        dlg.onOpened = onOpened;
        dlg.examples = ExampleForm.list(folder);
        /* **The one every tutorial starts from goes first**, selected: chosen
         * in its alphabetical place it was selected out of sight, under a
         * dozen rows the list had not scrolled past. */
        const hello = dlg.examples.findIndex((e) => e.name === "hello");
        if (hello > 0) dlg.examples.unshift(...dlg.examples.splice(hello, 1));
        dlg.Modal    = true;

        dlg.LstExamples.Items = dlg.examples.map((e) => e.console
            ? Locale.Text("{0} (console)", e.name) : e.name);
        dlg.LstExamples.Index = 0;
        dlg.describe();

        dlg.Show();
        dlg.LstExamples.SetFocus();
        return dlg;
    }

    chosen() {
        const at = this.LstExamples.Index;
        return at >= 0 && at < this.examples.length ? this.examples[at] : null;
    }

    /* What the selected one is, and where its copy will go: said before
     * accepting, as New project says the folder it will create. */
    describe() {
        const ex = this.chosen();

        this.LblExAbout.Text = ex
            ? (ex.description || Locale.Text("No description."))
            : "";
        this.LblExWhere.Text = ex
            ? Locale.Text("Will copy it to {0}", ExampleForm.freshTarget(this.base, ex.name))
            : "";
        this.LblExWhere.Tooltip = this.LblExWhere.Text;
        this.BtnExOpen.Enabled  = ex !== null;
    }

    accept() {
        const ex = this.chosen();
        if (!ex) return;

        if (!File.IsDir(this.base)) {
            Message.Error("The base folder does not exist:\n{0}", this.base);
            return;
        }
        const target = ExampleForm.freshTarget(this.base, ex.name);
        try {
            Directory.Copy(ex.path, target);
        } catch (e) {
            Message.Error("Could not copy {0} to {1}:\n{2}", ex.name, target, e.message);
            return;
        }

        this.Close();
        if (this.onOpened) this.onOpened(target);
    }

    /* --- events ------------------------------------------------------------ */

    LstExamples_Select()   { this.describe(); }
    LstExamples_Activate() { this.accept(); }

    BtnExOpen_Click()   { this.accept(); }
    BtnExCancel_Click() { this.Close(); }
}
