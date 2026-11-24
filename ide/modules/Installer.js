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

        /*
         * **No id is said before the chooser, and where to give one.** The id
         * is optional when a project is made, so a new project usually has
         * none -- and the chooser used to come first, suggest
         * `bintana-app-0.0-windows-x86_64.exe` for a project called something
         * else, and refuse only once a file had been picked. Now the sentence
         * comes first and Project settings opens on the field.
         */
        /* The manifest's own reading and not `Package.configOf`, which
         * throws on exactly this: what is wanted here is the answer. */
        const manifest = ide.manifest.read();
        if (manifest && !manifest.Id) {
            Message.Info("A Windows installer is installed under the application's id, and this project has none yet. Give it one in Project settings (a reverse-DNS name like io.github.you.App), then choose Windows installer again.");
            ide.editProject();
            if (ide.projectEditor) ide.projectEditor.TxtPrId.SetFocus();
            return;
        }

        /* The suggestion is best-effort: a manifest that will not read still
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

        /* **The installer is written by now**, so a build context that will
         * not go is a line in the log and not a failure: it threw out of here
         * once, past the sentence below, and the person was told nothing about
         * the setup that was sitting there finished. */
        try {
            Directory.DeleteTree(out);
        } catch (e) {
            ide.log(`Windows installer: the build folder was left behind: ${e.message}\n`);
        }
        ide.log(`Windows installer: ${exe}\n`);

        /* **The databases it carries are named**, at the moment someone is
         * looking at what ships: a project may ship one on purpose, and one
         * Run left in the project folder looks the same (`Package.dataFiles`).
         * Information, so the person decides -- not a warning. */
        let data = [];
        try { data = Package.dataFiles(ide.project); } catch (e) { data = []; }
        if (data.length) {
            ide.log(`Windows installer: it carries ${data.join(", ")}\n`);
            Message.Info("Installer written to {0}\n\nIt carries these databases from the project: {1}",
                         exe, data.join(", "));
            return exe;
        }
        Message.Info("Installer written to {0}", exe);
        return exe;
    }
}
