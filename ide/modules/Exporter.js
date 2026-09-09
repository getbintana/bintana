/*
 * Exporting a project: the whole directory, as one `.tar` beside it.
 *
 * Not the packaging on the README's list -- that is an application *without* its
 * project tree, and this is the tree itself. What this answers is the smaller
 * question that comes before it: handing a project to somebody, or keeping a
 * copy of one, without either end needing the IDE to do it.
 *
 * **Plain tar and nothing else.** A Bintana project is text -- `.form`, `.js`,
 * `.po`, `.css`, a handful of SVGs -- so what an archive of one is *for* is
 * holding the tree together, and which compressor to use is a question nobody
 * asked. One format is one code path, one filter in the chooser and one sentence
 * here; a menu of them would be three of each and the same file at the end.
 *
 * It is also the first caller of `Dialog.SaveFile`, and reads the way that call
 * was meant to: a name to suggest, a folder to start in, and a filter whose
 * label is the caller's own prose.
 */
"use strict";

Namespace("Ide");

Ide.Exporter = class Exporter {

    constructor(ide) {
        this.ide = ide;
    }

    /*
     * The project's folder name. It is both what the archive is called and the
     * single directory the archive holds -- see `write` for why the second one
     * matters more than the first.
     */
    get name() { return File.Name(this.ide.project); }

    run() {
        const ide = this.ide;
        if (!ide.project) {
            Message.Info("Open a project first.");
            return;
        }

        /*
         * Asked before trying rather than after failing, so "tar is not
         * installed" is a sentence and not three error lines -- the same bargain
         * `msgmerge` makes in Translations.
         */
        if (!Application.HasCommand("tar")) {
            Message.Error("tar is not installed, so there is nothing to export with.");
            return;
        }

        /* A .form and its .js travel together, and an archive of what is on disk
         * while something is unsaved hands over a project other than the one on
         * screen. The same reason Run saves first. */
        ide.saveAllDirty();

        Dialog.SaveFile(Locale.Text("Export project"), {
            /* Beside the project and not inside it: `write` refuses inside, so
             * starting there would be offering a folder it will not accept. */
            Folder:  File.Directory(File.Absolute(ide.project)),
            Name:    `${this.name}.tar`,
            Filters: [[Locale.Text("tar archives"), "*.tar"],
                      [Locale.Text("All files"), "*"]],
        }, (path) => this.write(path));
    }

    /*
     * The half that does the work, and the half a test can reach: the chooser
     * is a separate modal surface nothing can close from JS, so everything worth
     * asserting lives on this side of it.
     */
    write(chosen) {
        const project = File.Absolute(this.ide.project);
        const parent  = File.Directory(project);

        /* A name with no extension gets the one the filter promised: an archive
         * not called `.tar` is a file nothing recognises. An extension somebody
         * did choose is theirs and stays -- including a wrong one, which is a
         * choice and not a slip. */
        const out = File.Extension(chosen) ? chosen : `${chosen}.tar`;
        const abs = File.Absolute(out);

        /*
         * Writing the archive inside the tree it archives is refused rather than
         * worked around. It would not *fail*: GNU tar notices the file it is
         * writing and skips it, so what comes out is an archive quietly missing
         * something, and every later export packs the earlier ones. Refusing is
         * the only answer that does not leave a growing pile of tars in a source
         * tree.
         */
        if (abs === project || abs.startsWith(`${project}/`)) {
            /* One literal, however long: joined with `+` only the first piece is
             * extracted, and the IDE's own lint says so -- which is how this
             * line was found. */
            Message.Error("Choose a folder outside the project: an archive written inside it would be archiving itself.");
            return;
        }

        /*
         * `-C parent name`, never the project's path: what the archive *holds*
         * has to be one directory named after the project. Handed the path, tar
         * would store the components leading to it, and unpacking it would spill
         * a tree over whoever's current directory -- the difference between an
         * archive somebody can open and one that is a small accident.
         */
        this.ide.log(`> tar -cf ${abs} -C ${parent} ${this.name}\n`);
        Exec(["tar", "-cf", abs, "-C", parent, this.name],
             (line) => this.ide.log(`${line}\n`),
             (code) => this.finished(code, abs));
    }

    finished(code, path) {
        if (code !== 0) {
            /* What tar reported is already in the console, which is where a
             * message this short has to point. */
            Message.Error("tar failed ({0}); the console says what it reported.", code);
            return;
        }
        this.ide.log(`Exported ${File.Name(path)}\n`);
        Message.Info("Exported to {0}", path);
    }
};
