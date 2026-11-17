/*
 * The open project as a Windows installer: `Nsis` behind one menu item.
 *
 * *Project → Windows installer…* stages the project the way `Package` packs
 * it -- metainfo first, refusals before anything is written -- and compiles
 * the result with `makensis`. **The item is Windows only** (`MainForm` hides
 * it elsewhere): the payload is a Windows runtime tree and proving it runs
 * means running it. It used to write the bare `.nsi` on Linux and say
 * "compile it on Windows", but that script installs a `payload/` only `Stage`
 * on Windows makes, so nothing could compile it.
 *
 * The halves are separate methods because a chooser is a modal surface nothing
 * can close from JS: `run` asks, and everything worth asserting -- the script
 * out of a project, the refusal without a metainfo -- lives on this side of
 * it, where a test can reach it. The `Exporter` shape, one menu item down.
 */
"use strict";

export class Installer {

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
}
