/*
 * The open project as a Windows installer: `Nsis` behind one menu item.
 *
 * *Project → Windows installer…* stages the project the way `Package` packs
 * it -- metainfo first, refusals before anything is written -- and compiles
 * the result with `makensis` on Windows. Anywhere else the script is still
 * written (it is text) and the second half is named: compiling is Windows,
 * because the payload is a Windows tree and proving it runs means running it.
 *
 * The halves are separate methods because a chooser is a modal surface nothing
 * can close from JS: `run` asks, and everything worth asserting -- the script
 * out of a project, the refusal without a metainfo -- lives on this side of
 * it, where a test can reach it. The `Exporter` shape, one menu item down.
 */
"use strict";

Namespace("Ide");

Ide.Installer = class Installer {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    run() {
        const ide = this.ide;
        if (!ide.project) {
            Message.Info("Open a project first.");
            return;
        }

        /* A .form and its .js travel together, and an installer of what is on
         * disk while something is unsaved installs a project other than the
         * one on screen. The same reason Run and Export save first. */
        ide.saveAllDirty();

        /* Outside Windows there is no payload to stage and no compiler to
         * run: the script is written into a chosen folder, and the sentence
         * with it says where it compiles. */
        if (Environment.OS !== "Windows") {
            Dialog.SelectFolder(Locale.Text("Write installer script"),
                                { Folder: File.Directory(File.Absolute(ide.project)) },
                                (dir) => this.scriptTo(dir));
            return;
        }

        /* The suggestion is best-effort: a project with no id yet still
         * reaches the chooser, and `Script` refuses with the sentence when it
         * is asked to write. */
        let command = "bintana-app", version = "0.0";
        try {
            const config = Package.configOf(ide.project);
            command = Package.commandName(config.Id);
            version = config.Version || "0.0";
        } catch (e) { /* named where it is refused */ }

        Dialog.SaveFile(Locale.Text("Windows installer"), {
            /* Beside the project: the build context is a temporary directory,
             * so starting inside it would be offering a folder whose contents
             * do not matter. */
            Folder:  File.Directory(File.Absolute(ide.project)),
            Name:    `${command}-${version}-windows-x86_64.exe`,
            Filters: [[Locale.Text("Windows installers"), "*.exe"],
                      [Locale.Text("All files"), "*"]],
        }, (path) => this.writeInstaller(path));
    }

    /*
     * The Windows half: script, payload and compiler, in a temporary build
     * context that is deleted when the installer is written. A failure keeps
     * the context and says where, because a staging that stopped halfway is
     * what the next question is about.
     */
    writeInstaller(chosen) {
        const ide = this.ide;
        const exe = File.Extension(chosen) ? chosen : `${chosen}.exe`;
        const out = File.Join(Environment.TempDirectory,
                              `bta-nsis-${Environment.ProcessId}`);
        if (File.IsDir(out)) Directory.DeleteTree(out);

        let ctx;
        try {
            ctx = Nsis.Script(ide.project, out);
            Nsis.Stage(ide.project, out);
            Nsis.Build(ctx.Script, File.Absolute(exe));
        } catch (e) {
            ide.log(`Windows installer: ${e.message}\n`);
            Message.Error(e.message);
            return null;
        }

        Directory.DeleteTree(out);
        ide.log(`Windows installer: ${exe}\n`);
        Message.Info("Installer written to {0}", exe);
        return exe;
    }

    /*
     * The script half, on any desktop: the `.nsi` (and the `.ico`, when the
     * project ships a PNG icon) into a chosen folder, without staging and
     * without compiling. `project` is the open one unless a caller hands one
     * over, which is what lets a test try this on a scratch project instead
     * of the one on screen.
     */
    scriptTo(dir, project) {
        const ide = this.ide;
        let ctx;
        try {
            ctx = Nsis.Script(project || ide.project, dir);
        } catch (e) {
            Message.Error(e.message);
            return null;
        }

        ide.log(`Installer script: ${ctx.Script}\n`);
        Message.Info("Installer script written to {0} -- compile it on Windows with makensis.",
                     ctx.Script);
        return ctx;
    }
};
