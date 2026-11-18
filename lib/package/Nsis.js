/*
 * A project as a Windows installer: an NSIS script out of its metainfo.
 *
 * **Nsis is Windows-only, and says so in its name.** It is not "the
 * installer" -- Flatpak is `Package`'s -- it is the NSIS one, for the open
 * project as a Windows application: the Windows runtime tree, the project
 * itself and a `.cmd` launcher, installed per-user with an uninstaller.
 *
 * **The shortcuts do not start the `.cmd`.** Windows runs every `.cmd` in a
 * console, and `bintana.exe` is a console program besides, so either one opens
 * a black window behind the application's. The shortcuts, and the finish
 * page's "Run", start `bintana-gui.exe` -- the graphical host, built with the
 * GUI subsystem (see `CMakeLists.txt`) -- on the project; the `.cmd` starts
 * the console core `bintana.exe` for a terminal, where seeing what the program
 * prints is the point.
 *
 * Three verbs, one build context. `Script` writes `<out>/<id>.nsi` (and
 * `<out>/<id>.ico` when the project ships a PNG icon) out of the metainfo;
 * `Stage` copies the payload into `<out>/payload`; `Build` verifies that
 * payload runs and compiles the script beside it with `makensis`. The context
 * is a directory that can be thrown away -- like `Package.Write`'s, everything
 * the step names is beside the script, including the payload.
 *
 * **Only `Build` needs Windows, and only `Build` refuses anywhere else.**
 * `Script` is text and works wherever it is written -- the IDE writes it on
 * any desktop and says compiling is Windows -- and `Stage` copies whatever
 * tree it is pointed at, which is what lets the suite try it on Linux. What
 * cannot happen anywhere else is running a Windows `bintana.exe` to prove the
 * payload, or compiling it: `makensis` builds a Windows installer out of a
 * Windows tree, and both halves of that sentence are load-bearing.
 */
"use strict";

class Nsis {

    /*
     * Nsis.Script(project, out, [options]) -- the installer script, from the
     * metainfo.
     *
     * Answers `{ Id, Command, Version, Script, Icon, Payload, Note }`: the
     * script's path, the `.ico` beside it (or `null` when the project has no
     * PNG icon, with `Note` saying which file would change that), and where
     * `Stage` will put the payload the script compiles in.
     *
     * `options.Files` and `options.Schemes` are what the installed application
     * opens -- see `associations` below. **Windows only, and on purpose**: the
     * project format has no word for them, so they are the installer's
     * options and not the project's.
     *
     * **Every refusal comes before the first write**, `Package.Write`'s rule:
     * no id, no metainfo, a metainfo that disagrees with `project.btp`, a
     * broken icon, an association that cannot be registered and an output
     * inside the project all stop here with a sentence, and `out` is left as
     * it was.
     */
    /**
     * writes the installer script from the metainfo, and answers where
     * everything went: `{ Id, Command, Version, Script, Icon, Payload, Note }`.
     * `options.Files` -- `[{ Extension, Description }]` -- are the file types
     * the installed application opens, and `options.Schemes` -- `["myapp"]` --
     * the URL schemes; both are registered for the user and removed by the
     * uninstaller, and the file or URL reaches the program as the first of
     * `Application.Arguments`
     */
    static Script(project, out, options) {
        const config = Package.configOf(project);
        const assoc  = Nsis.associations(options);

        const metaPath = Metainfo.find(project);
        if (!metaPath)
            throw new Error(`the project has no ${config.Id}.metainfo.xml -- ` +
                            `Application info in the IDE writes one`);

        const doc      = File.LoadXml(metaPath);
        const problems = Metainfo.problems(doc, metaPath, config);
        if (problems.length)
            throw new Error(`${File.Name(metaPath)} does not agree with ` +
                            `project.btp: ${problems.join("; ")}`);

        const info    = Metainfo.read(doc);
        const id      = config.Id;
        const command = Package.commandName(id);

        /* The icon, which is optional here and mandatory in `Package.Write`:
         * an installer without one is an installer with NSIS's own, while a
         * package without one is one AppStream will not compose. A PNG becomes
         * the installer's `.ico`; an svg cannot -- nothing here rasterizes one
         * -- so that project keeps the default and is told which file would
         * change it. Two drawings with none named after the id is refused, the
         * same refusal `Package.Write` makes: not guessing which drawing is
         * the application. */
        const icon = Nsis.icon(project, id);

        /* Decided before anything is written, because it can refuse too: the
         * context may not live inside the project it stages. */
        Package.topLevel(project, out);

        const script = File.Join(out, `${id}.nsi`);
        let ico = null;
        Directory.Make(out);
        if (icon.Png) {
            ico = File.Join(out, `${id}.ico`);
            File.SaveBytes(ico, Nsis.Ico(icon.Png));
        }
        File.Save(script, Nsis.script({ Id:      id,
                                        Command: command,
                                        Version: config.Version,
                                        Info:    info,
                                        Icon:    ico ? File.Name(ico) : null,
                                        Files:   assoc.Files,
                                        Schemes: assoc.Schemes }));

        return { Id:      id,
                 Command: command,
                 Version: config.Version,
                 Script:  script,
                 Icon:    ico,
                 Payload: File.Join(out, "payload"),
                 Note:    icon.Note };
    }

    /*
     * Nsis.Stage(project, out, [options]) -- the payload the script installs.
     *
     * The Windows runtime tree the caller points at (`options.Prefix`, or the
     * tree this runtime runs from), without the IDE and without the compiler:
     * `bin/bintana.exe`, `bin/bintana-gui.exe`, `bin/bintana-exec.exe` and
     * their DLLs, the data GTK opens by name, the shipped
     * libraries the project's `uses` resolve from -- and the project itself
     * under `share/bintana/apps/<command>`, with a `.cmd` launcher beside the
     * executable: the core for a `main` project, the graphical host for one
     * that opens a form. Answers the payload directory.
     *
     * The tree is copied by name and not collected by link: a development
     * checkout is not a shippable tree, and `ldd` is an MSYS2 program no
     * Windows user has. What is refused is a prefix with no `bin/bintana.exe`
     * in it -- staging from one of those is how an installer quietly misses
     * its own runtime.
     */
    /** copies the payload the script installs into `<out>/payload` */
    static Stage(project, out, options) {
        const config = Package.configOf(project);

        /* Before the prefix is even looked at: an output inside the project
         * would be staged into itself, and the caller's own mistake is
         * reported before the environment's. */
        const names = Package.topLevel(project, out);

        const prefix  = (options && options.Prefix) || Nsis.ownPrefix();
        const payload = File.Join(out, "payload");

        if (!File.Exists(File.Join(prefix, "bin", "bintana.exe")))
            throw new Error(`${prefix} has no bin/bintana.exe -- stage from a ` +
                            `Windows runtime tree (the portable build), not a ` +
                            `development checkout`);
        /* What every shortcut the script writes starts: a tree from before it
         * existed would install an application whose menu entry is broken. */
        if (!File.Exists(File.Join(prefix, "bin", "bintana-gui.exe")))
            throw new Error(`${prefix} has no bin/bintana-gui.exe, which the ` +
                            `shortcuts start -- stage from a runtime tree built ` +
                            `with it (a newer portable build)`);
        /* What `Exec` starts a child through.  Without it, the console tools
         * an application runs (`git`, a compiler) would each get a console
         * window. */
        if (!File.Exists(File.Join(prefix, "bin", "bintana-exec.exe")))
            throw new Error(`${prefix} has no bin/bintana-exec.exe, which ` +
                            `Exec starts its children through -- stage from ` +
                            `a runtime tree built with it (a newer portable ` +
                            `build)`);
        /* GLib's spawn helpers: every `Exec` with its output piped is started
         * through one, found beside GLib's DLL -- or on the PATH, which is why
         * a build machine never notices them missing and an installed
         * application answers "it could not be started". */
        for (const helper of Nsis.spawnHelpers)
            if (!File.Exists(File.Join(prefix, "bin", helper)))
                throw new Error(`${prefix} has no bin/${helper}, which every ` +
                                `Exec that reads a program's output starts through ` +
                                `-- stage from a runtime tree that carries it`);

        /* What the caller asked for besides the runtime (`options.With`):
         * paths of the tree, relative to it -- the IDE's installer carries the
         * examples, the runtime's documentation and the bundled NSIS, which is
         * what makes it the portable zip's equal. **Each one has to be
         * there**, and is checked before anything is copied: a piece that was
         * asked for and quietly left out is an installer that looks complete
         * and is not, found by whoever installs it. */
        const extra = (options && options.With) || [];
        for (const rel of extra) {
            if (!rel || /^([\\/]|[A-Za-z]:)/.test(rel) || rel.split(/[\\/]/).includes(".."))
                throw new Error(`${rel} is not a path inside the runtime tree -- ` +
                                `name it relative to ${prefix}`);
            if (!File.Exists(File.Join(prefix, rel)))
                throw new Error(`${prefix} has no ${rel}, which this installer ` +
                                `was asked to carry`);
        }

        if (File.IsDir(payload)) Directory.DeleteTree(payload);
        Directory.Make(payload);

        /* The runtime, piece by piece: the same data
         * `tools/windows-portable.sh` lays down, minus the IDE, the examples
         * and the compiler. Each piece travels when it is there and is skipped
         * when it is not -- an installed tree and a staged one agree on the
         * names, and a missing piece is a smaller payload rather than a
         * refusal, because only the executable is load-bearing. */
        Nsis.copyBin(prefix, payload);
        for (const dir of ["share/glib-2.0/schemas",
                           "lib/gdk-pixbuf-2.0",
                           "lib/gio/modules",
                           "lib/gtk-4.0",
                           "share/icons/Adwaita",
                           "share/icons/AdwaitaLegacy",
                           "share/icons/hicolor",
                           "share/gtksourceview-5",
                           "lib/gtksourceview-5",
                           "share/mime",
                           /* The third-party licences the runtime tree
                            * carries (CMake installs them outside `share/doc`
                            * so a Flatpak cleanup cannot take them): the zip
                            * and this setup are what redistribute the DLLs. */
                           "share/licenses",
                           "share/bintana/lib",
                           /* The optional halves the portable tree carries:
                            * without the plugins Video has no sink, and without
                            * poppler's data a PDF with a CMap fails even though
                            * the DLL is there. */
                           "lib/gstreamer-1.0",
                           "libexec/gstreamer-1.0",
                           "share/gstreamer-1.0",
                           "share/poppler"])
            Nsis.copyTree(prefix, payload, dir);
        Nsis.copyFile(prefix, payload, File.Join("etc", "gtk-4.0", "settings.ini"));
        for (const rel of extra) {
            if (File.IsDir(File.Join(prefix, rel)))
                Nsis.copyTree(prefix, payload, rel);
            else
                Nsis.copyFile(prefix, payload, rel);
        }

        /* The project itself, the way `Package.Write` copies it: everything
         * but the hidden entries, so `.git` does not travel. */
        const command = Package.commandName(config.Id);
        const appDir  = File.Join(payload, "share", "bintana", "apps", command);
        Package.copyProject(project, appDir, names);

        /* The launcher: the Windows spelling of the manifest's script -- the
         * runtime on its own project, resolved from the launcher's own
         * location so the tree installs anywhere.
         *
         * **Which host, and whether it waits**, is the project's kind. A
         * project with a `main` is the console core's, and the window the
         * `.cmd` is run in is its output. Everything else opens a form and is
         * the graphical host's; `start ""` is what keeps a double-clicked
         * launcher from leaving a `cmd.exe` behind the application for as long
         * as it runs -- the console the shortcut exists to avoid. The rule is
         * the runtime's own (`bta_project_has_main`, and the core's dispatch),
         * and the shortcut is the graphical host either way. */
        const gui = !config.HasMain;
        const launch = gui ? `start "" "%HERE%bintana-gui.exe"`
                           : `"%HERE%bintana.exe"`;
        const launcher =
            "@echo off\r\n" +
            `rem ${config.Name}, from wherever this was installed to.\r\n` +
            "setlocal\r\n" +
            "set \"HERE=%~dp0\"\r\n" +
            `${launch} "%HERE%..\\share\\bintana\\apps\\${command}" %*\r\n`;
        File.Save(File.Join(payload, "bin", `${command}.cmd`), launcher);

        return payload;
    }

    /*
     * Nsis.Build(script, exe, [options]) -- the script compiled, on Windows.
     *
     * Refused anywhere else: the payload is a Windows tree, and proving it
     * runs means running it. On Windows the staged `bintana.exe --version` is
     * asked first -- the same proof the CI gives the portable build -- and a
     * payload that does not run stops here instead of becoming an installer
     * that installs something broken. `options.Makensis` names the compiler;
     * without it the tree's own `share/bintana/tools/nsis` is tried first and
     * then the PATH, and neither is a sentence naming both.
     */
    /**
     * compiles the script into the setup executable. Windows only, and it says
     * so anywhere else
     */
    static Build(script, exe, options) {
        if (Environment.OS !== "Windows")
            throw new Error("compiling an installer is Windows -- the script is " +
                            "written anywhere, and compiled where its payload runs");

        const dir     = File.Directory(script);
        const payload = File.Join(dir, "payload");
        const staged  = File.Join(payload, "bin", "bintana.exe");

        if (!File.Exists(staged))
            throw new Error(`${payload} holds no staged runtime -- run Nsis.Stage first`);

        const probe = Exec.Wait([staged, "--version"],
                                { Timeout: 30000, Stderr: "separate" });
        if (probe.ExitCode !== 0)
            throw new Error(`the staged runtime does not run (${staged} --version ` +
                            `exited ${probe.ExitCode}): ${probe.Output}${probe.Errors}`);

        const makensis = (options && options.Makensis) || Nsis.makensis();
        /* A 460 MB payload is 124 MB of LZMA and takes minutes on a slow or
         * loaded machine; five minutes was enough for the CI runner and not
         * for a developer's laptop. */
        const built = Exec.Wait([makensis, "-NOCONFIG", "-V2",
                                 `-DOUTFILE=${exe}`, script],
                                { Timeout: 900000, Stderr: "separate" });
        if (built.ExitCode !== 0)
            throw new Error(`makensis failed (exit ${built.ExitCode}): ` +
                            `${built.Output}${built.Errors}`);

        return exe;
    }

    /*
     * Nsis.Ico(pngPath) -- the PNG as a `.ico` NSIS can wear, as `Bytes`.
     *
     * An ICO that holds a PNG (valid since Vista): the 6-byte directory, one
     * 16-byte entry and the file's own bytes verbatim -- nothing is decoded
     * and nothing is scaled, so what the installer shows is the drawing the
     * project ships. A 256-pixel side is written as 0, which is how the format
     * spells it.
     */
    /** the PNG as a `.ico`, as `Bytes` */
    static Ico(pngPath) {
        const png  = File.LoadBytes(pngPath);
        const word = (at) => ((png.At(at) * 256 + png.At(at + 1)) * 256 +
                              png.At(at + 2)) * 256 + png.At(at + 3);
        const w = word(16), h = word(20);

        const le = (n) => [n & 255, (n >>> 8) & 255,
                           (n >>> 16) & 255, (n >>> 24) & 255];
        const head = [0, 0, 1, 0, 1, 0,
                      w >= 256 ? 0 : w, h >= 256 ? 0 : h,
                      0, 0, 1, 0, 32, 0]
            .concat(le(png.Length), le(6 + 16));

        return new Bytes(head).Concat(png);
    }

    /* --- small pieces ----------------------------------------------------- */

    /*
     * The tree this runtime runs from: the executable is
     * `<prefix>/bin/bintana`, so the prefix is two directories up. On a
     * development checkout that is the checkout itself -- which is why `Stage`
     * refuses a prefix with no staged executable in it rather than staging
     * whatever happens to be there.
     */
    static ownPrefix() {
        return File.Directory(File.Directory(Application.Executable));
    }

    /*
     * The compiler: the tree's own NSIS first, the PATH after it. A Windows
     * runtime tree may carry `share/bintana/tools/nsis` -- the subset of the
     * official NSIS distribution `makensis` needs beside itself (`Bin` with
     * the real compiler, `Include`, `Contrib` with the Modern UI, the stubs,
     * `COPYING`) -- so building an installer needs nothing installed; a tree without one falls back to a
     * `makensis` on the PATH, and neither is the sentence below.
     */
    static makensis() {
        const own = File.Join(Nsis.ownPrefix(), "share", "bintana",
                              "tools", "nsis", "makensis.exe");
        if (File.Exists(own)) return own;
        if (Application.HasCommand("makensis")) return "makensis";
        throw new Error("no makensis -- install NSIS (MSYS2 UCRT64: " +
                        "pacman -S mingw-w64-ucrt-x86_64-nsis) or run from a " +
                        "runtime tree that ships share/bintana/tools/nsis");
    }

    /*
     * Which drawing becomes the installer's icon, as `{ Png, Note }`.
     *
     * `icons/<id>.png` by name, measured the way `Package` measures it -- a
     * broken one is refused rather than wrapped. Anything else keeps NSIS's
     * own icon: an svg cannot be worn, and no drawing at all is the ordinary
     * state of a project that never needed one for the desktop either.
     */
    static icon(project, id) {
        const named = File.Join(project, "icons", `${id}.png`);
        if (File.Exists(named)) {
            const measured = Package.measureIcon(named);
            if (measured.Problem) throw new Error(measured.Problem);
            return { Png: named, Note: "" };
        }

        const found = Package.iconOf(project, id);
        if (found.Path)
            return { Png:  null,
                     Note: `icons/${File.Name(found.Path)} is an svg, which NSIS ` +
                           `cannot wear -- ship icons/${id}.png for the ` +
                           `installer's own icon` };

        /* No drawing at all is the default icon and a note; several drawings
         * with none named after the id is the refusal `Package.Write` makes --
         * staging an installer over an undecided icon is how the application
         * ends up wearing nothing anywhere. */
        if (!found.Problem.startsWith("the project ships no icon"))
            throw new Error(found.Problem);
        return { Png:  null,
                 Note: `the project ships no icon -- put icons/${id}.png beside ` +
                       `its sources for the installer's own icon` };
    }

    /*
     * What the metainfo becomes in NSIS. The mapping, since a second reader of
     * this file should not have to derive it:
     *
     *   Name           the installer, the Start Menu folder, DisplayName
     *   Summary        FileDescription, the branding line
     *   Description    the welcome page's text
     *   DeveloperName  Publisher, CompanyName
     *   Homepage       URLInfoAbout, the finish page's link
     *   ProjectLicense nowhere: it is a license id, not copyright text
     *   Categories     nowhere: Windows has no categories
     *   Bugtracker     nowhere: the installer is not the place for it
     *
     * Per-user throughout (`RequestExecutionLevel user`,
     * `$LOCALAPPDATA\Programs\<command>`), so installing needs no elevation --
     * the same user an `Install as user application` installs for. The payload
     * is `payload/` beside the script, which is the only path the script
     * names: `Build` compiles it in place, and the directory is a build
     * context that can be thrown away afterwards.
     */
    static script(o) {
        const e    = Nsis.escape;
        const id   = o.Id;
        const cmd  = o.Command;
        const info = o.Info;
        const key  = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`;
        const L    = [];

        /* What a shortcut starts: the runtime with no console, on the project
         * -- its directory quoted inside the single-quoted NSIS string, since
         * `$INSTDIR` may hold spaces. `cmd` is `[a-z0-9-]`, nothing to escape. */
        const gui  = `$INSTDIR\\bin\\bintana-gui.exe`;
        const app  = `"$INSTDIR\\share\\bintana\\apps\\${cmd}"`;
        const icon = o.Icon ? ` "$INSTDIR\\${e(o.Icon)}"` : ``;

        L.push(`; ${info.Name} -- generated by Nsis.Script from ${id}.metainfo.xml.`);
        L.push(`; Regenerate it rather than editing it: the next Script writes it again.`);
        L.push(`Unicode true`);
        L.push(`SetCompressor /SOLID lzma`);
        L.push(`!include "MUI2.nsh"`);
        L.push(``);
        L.push(`Name "${e(info.Name)}"`);
        L.push(`!ifndef OUTFILE`);
        L.push(`!define OUTFILE "${cmd}-${Nsis.setupVersion(o.Version)}-windows-x86_64.exe"`);
        L.push(`!endif`);
        L.push(`OutFile "\${OUTFILE}"`);
        L.push(`InstallDir "$LOCALAPPDATA\\Programs\\${cmd}"`);
        L.push(`InstallDirRegKey HKCU "${e(key)}" "InstallLocation"`);
        L.push(`RequestExecutionLevel user`);
        if (o.Icon) {
            L.push(`Icon "${e(o.Icon)}"`);
            L.push(`!define MUI_ICON "${e(o.Icon)}"`);
            L.push(`!define MUI_UNICON "${e(o.Icon)}"`);
        }

        const vi = Nsis.viVersion(o.Version);
        if (vi) {
            L.push(`VIProductVersion "${vi}"`);
            L.push(`VIAddVersionKey "ProductName" "${e(info.Name)}"`);
            if (o.Version)
                L.push(`VIAddVersionKey "FileVersion" "${e(o.Version)}"`);
            if (info.Summary)
                L.push(`VIAddVersionKey "FileDescription" "${e(info.Summary)}"`);
            if (info.DeveloperName)
                L.push(`VIAddVersionKey "CompanyName" "${e(info.DeveloperName)}"`);
            /* NSIS warns when one standard key is set and these two are not;
             * the setup's own Properties page should also say both. */
            L.push(`VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 ${e(info.DeveloperName || "Bintana")}"`);
        }
        L.push(``);

        /* The welcome page carries the description AppStream shows -- the one
         * text about the application that already exists. */
        L.push(`!define MUI_WELCOMEPAGE_TITLE "Welcome to ${e(info.Name)}"`);
        if (info.Description)
            L.push(`!define MUI_WELCOMEPAGE_TEXT "${e(info.Description)}"`);
        L.push(`!insertmacro MUI_PAGE_WELCOME`);
        L.push(`!insertmacro MUI_PAGE_DIRECTORY`);
        L.push(`!insertmacro MUI_PAGE_INSTFILES`);
        /* "Run" through a function of the script's own, and not through
         * `MUI_FINISHPAGE_RUN_PARAMETERS`: the Modern UI pastes those inside a
         * double-quoted `Exec` string (`Pages/Finish.nsh`), where the quotes
         * around a path with spaces would end it. */
        L.push(`!define MUI_FINISHPAGE_RUN`);
        L.push(`!define MUI_FINISHPAGE_RUN_FUNCTION RunApplication`);
        L.push(`!define MUI_FINISHPAGE_RUN_TEXT "Run ${e(info.Name)}"`);
        if (info.Homepage) {
            L.push(`!define MUI_FINISHPAGE_LINK "Visit ${e(info.Homepage)}"`);
            L.push(`!define MUI_FINISHPAGE_LINK_LOCATION "${e(info.Homepage)}"`);
        }
        L.push(`!insertmacro MUI_PAGE_FINISH`);
        L.push(`!insertmacro MUI_UNPAGE_CONFIRM`);
        L.push(`!insertmacro MUI_UNPAGE_INSTFILES`);
        L.push(`!insertmacro MUI_LANGUAGE "English"`);
        L.push(``);

        /* The directory page may not point at somebody else's folder: an
         * existing install is recognised by its marker and may be upgraded,
         * an empty folder is fine, and a folder with anything else in it is
         * refused before `File /r` can write into it. The uninstaller checks
         * the same marker before `RMDir /r`, so a folder that was never ours
         * is left as it was. */
        L.push(`Function .onVerifyInstDir`);
        L.push(`  IfFileExists "$INSTDIR\\bintana-installed" bta_verify_done`);
        /* An install from before the marker existed is still ours when the
         * runtime is where this setup puts it: an upgrade must not be blocked
         * by the marker it is about to write. */
        L.push(`  IfFileExists "$INSTDIR\\bin\\bintana.exe" bta_verify_done`);
        L.push(`  FindFirst $0 $1 "$INSTDIR\\*.*"`);
        L.push(`  bta_verify_loop:`);
        L.push(`    StrCmp $1 "" bta_verify_empty`);
        L.push(`    StrCmp $1 "." bta_verify_next`);
        L.push(`    StrCmp $1 ".." bta_verify_next`);
        L.push(`    FindClose $0`);
        L.push(`    Abort "Choose an empty folder, or the folder this application installed."`);
        L.push(`  bta_verify_next:`);
        L.push(`    FindNext $0 $1`);
        L.push(`    Goto bta_verify_loop`);
        L.push(`  bta_verify_empty:`);
        L.push(`    FindClose $0`);
        L.push(`  bta_verify_done:`);
        L.push(`FunctionEnd`);
        L.push(``);

        L.push(`Section "Application" SEC_APP`);
        L.push(`  SectionIn RO`);
        L.push(`  SetOutPath "$INSTDIR"`);
        L.push(`  File /r "payload\\*"`);
        if (o.Icon)
            L.push(`  File "${e(o.Icon)}"`);
        L.push(`  WriteUninstaller "$INSTDIR\\Uninstall.exe"`);
        L.push(`  FileOpen $0 "$INSTDIR\\bintana-installed" w`);
        L.push(`  FileWrite $0 "${e(info.Name)}"`);
        L.push(`  FileClose $0`);
        L.push(``);
        L.push(`  CreateDirectory "$SMPROGRAMS\\${e(info.Name)}"`);
        L.push(`  CreateShortCut "$SMPROGRAMS\\${e(info.Name)}\\${e(info.Name)}.lnk" ` +
               `"${gui}" '${app}'${icon}`);
        L.push(`  CreateShortCut "$SMPROGRAMS\\${e(info.Name)}\\Uninstall.lnk" ` +
               `"$INSTDIR\\Uninstall.exe"`);
        L.push(``);
        L.push(`  WriteRegStr HKCU "${e(key)}" "DisplayName" "${e(info.Name)}"`);
        if (o.Version)
            L.push(`  WriteRegStr HKCU "${e(key)}" "DisplayVersion" "${e(o.Version)}"`);
        if (info.DeveloperName)
            L.push(`  WriteRegStr HKCU "${e(key)}" "Publisher" "${e(info.DeveloperName)}"`);
        L.push(`  WriteRegStr HKCU "${e(key)}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'`);
        L.push(`  WriteRegStr HKCU "${e(key)}" "InstallLocation" "$INSTDIR"`);
        if (o.Icon)
            L.push(`  WriteRegStr HKCU "${e(key)}" "DisplayIcon" "$INSTDIR\\${e(o.Icon)}"`);
        if (info.Homepage)
            L.push(`  WriteRegStr HKCU "${e(key)}" "URLInfoAbout" "${e(info.Homepage)}"`);
        L.push(`  WriteRegDWORD HKCU "${e(key)}" "NoModify" 1`);
        L.push(`  WriteRegDWORD HKCU "${e(key)}" "NoRepair" 1`);
        Nsis.registerOpen(L, o, gui, app);
        L.push(`SectionEnd`);
        L.push(``);
        L.push(`Section "Desktop shortcut" SEC_DESK`);
        L.push(`  CreateShortCut "$DESKTOP\\${e(info.Name)}.lnk" ` +
               `"${gui}" '${app}'${icon}`);
        L.push(`SectionEnd`);
        L.push(``);
        L.push(`Section "Uninstall"`);
        L.push(`  Delete "$SMPROGRAMS\\${e(info.Name)}\\*.lnk"`);
        L.push(`  RMDir "$SMPROGRAMS\\${e(info.Name)}"`);
        L.push(`  Delete "$DESKTOP\\${e(info.Name)}.lnk"`);
        Nsis.unregisterOpen(L, o, gui, app);
        if (o.Icon)
            L.push(`  Delete "$INSTDIR\\${e(o.Icon)}"`);
        L.push(`  IfFileExists "$INSTDIR\\bintana-installed" bta_uninstall_ours`);
        /* `/SD IDOK`: a silent uninstall must not sit on a dialog nobody can
         * see, which is exactly what the first version did. */
        L.push(`  MessageBox MB_ICONEXCLAMATION|MB_OK "The folder $INSTDIR was not installed by ${e(info.Name)}. Its files were left alone." /SD IDOK`);
        L.push(`  Goto bta_uninstall_done`);
        L.push(`  bta_uninstall_ours:`);
        L.push(`  RMDir /r "$INSTDIR"`);
        L.push(`  bta_uninstall_done:`);
        L.push(`  DeleteRegKey HKCU "${e(key)}"`);
        L.push(`SectionEnd`);
        L.push(``);
        L.push(`Function RunApplication`);
        L.push(`  Exec '"${gui}" ${app}'`);
        L.push(`FunctionEnd`);
        L.push(``);

        return L.join("\r\n") + "\r\n";
    }

    /*
     * The file types and URL schemes, registered for this user only
     * (`HKCU\Software\Classes`, which Windows merges into `HKCR`), so
     * installing them needs no elevation either.
     *
     * - An extension gets a ProgID of its own, `<command>.<extension>`, with
     *   the description, the icon and an `open` verb that starts the
     *   application on `"%1"`. The extension lists it in `OpenWithProgids`,
     *   which is what puts the application in *Open with*. **It becomes the
     *   default only when the extension had none**: an installer that takes
     *   `.txt` away from the editor somebody chose is the installer people
     *   learn to fear, and Windows 10+ asks the user anyway when a second
     *   program offers itself (the `UserChoice` key belongs to the user and no
     *   installer may write it).
     * - A scheme is a key named after it, `URL Protocol` empty, and the same
     *   verb: the whole URL arrives as the argument.
     * - `FriendlyAppName` names the verb with the application's name: every
     *   Bintana application is `bintana-gui.exe`, whose own description would
     *   otherwise be what *Open with* says.
     *
     * Then `SHChangeNotify(SHCNE_ASSOCCHANGED)`, so Explorer shows the icons
     * without a restart.
     */
    static registerOpen(L, o, gui, app) {
        const e = Nsis.escape;
        const cls = `Software\\Classes`;
        const run = `'"${gui}" ${app} "%1"'`;
        const files = o.Files || [], schemes = o.Schemes || [];
        if (!files.length && !schemes.length) return;

        L.push(``);
        files.forEach((f, i) => {
            const progid = `${o.Command}.${f.Extension}`;
            const desc   = f.Description || `${o.Info.Name} ${f.Extension} file`;
            L.push(`  ; .${f.Extension}, opened by ${e(o.Info.Name)}`);
            L.push(`  WriteRegStr HKCU "${cls}\\${progid}" "" "${e(desc)}"`);
            if (o.Icon)
                L.push(`  WriteRegStr HKCU "${cls}\\${progid}\\DefaultIcon" "" ` +
                       `"$INSTDIR\\${e(o.Icon)}"`);
            L.push(`  WriteRegStr HKCU "${cls}\\${progid}\\shell\\open" ` +
                   `"FriendlyAppName" "${e(o.Info.Name)}"`);
            L.push(`  WriteRegStr HKCU "${cls}\\${progid}\\shell\\open\\command" "" ${run}`);
            L.push(`  WriteRegStr HKCU "${cls}\\.${f.Extension}\\OpenWithProgids" "${progid}" ""`);
            L.push(`  ReadRegStr $0 HKCR ".${f.Extension}" ""`);
            L.push(`  StrCmp $0 "" 0 bta_ext${i}_taken`);
            L.push(`  WriteRegStr HKCU "${cls}\\.${f.Extension}" "" "${progid}"`);
            L.push(`  bta_ext${i}_taken:`);
        });
        for (const s of schemes) {
            L.push(`  ; ${s}: links, opened by ${e(o.Info.Name)}`);
            L.push(`  WriteRegStr HKCU "${cls}\\${s}" "" "URL:${e(o.Info.Name)}"`);
            L.push(`  WriteRegStr HKCU "${cls}\\${s}" "URL Protocol" ""`);
            if (o.Icon)
                L.push(`  WriteRegStr HKCU "${cls}\\${s}\\DefaultIcon" "" ` +
                       `"$INSTDIR\\${e(o.Icon)}"`);
            L.push(`  WriteRegStr HKCU "${cls}\\${s}\\shell\\open" ` +
                   `"FriendlyAppName" "${e(o.Info.Name)}"`);
            L.push(`  WriteRegStr HKCU "${cls}\\${s}\\shell\\open\\command" "" ${run}`);
        }
        L.push(`  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'`);
    }

    /*
     * The inverse, and **only what is still ours**: the ProgID is the
     * application's alone, but an extension's default and a scheme may have
     * been taken by another program since, and the uninstaller leaves those
     * as it finds them. A scheme is ours while its command is the one this
     * installer wrote.
     */
    static unregisterOpen(L, o, gui, app) {
        const cls = `Software\\Classes`;
        const run = `'"${gui}" ${app} "%1"'`;
        const files = o.Files || [], schemes = o.Schemes || [];
        if (!files.length && !schemes.length) return;

        files.forEach((f, i) => {
            const progid = `${o.Command}.${f.Extension}`;
            const ext    = `${cls}\\.${f.Extension}`;
            L.push(`  DeleteRegKey HKCU "${cls}\\${progid}"`);
            L.push(`  DeleteRegValue HKCU "${ext}\\OpenWithProgids" "${progid}"`);
            L.push(`  DeleteRegKey /ifempty HKCU "${ext}\\OpenWithProgids"`);
            L.push(`  ReadRegStr $0 HKCU "${ext}" ""`);
            L.push(`  StrCmp $0 "${progid}" 0 bta_unext${i}_kept`);
            L.push(`  DeleteRegValue HKCU "${ext}" ""`);
            L.push(`  bta_unext${i}_kept:`);
            L.push(`  DeleteRegKey /ifempty HKCU "${ext}"`);
        });
        schemes.forEach((s, i) => {
            L.push(`  ReadRegStr $0 HKCU "${cls}\\${s}\\shell\\open\\command" ""`);
            L.push(`  StrCmp $0 ${run} 0 bta_unscheme${i}_kept`);
            L.push(`  DeleteRegKey HKCU "${cls}\\${s}"`);
            L.push(`  bta_unscheme${i}_kept:`);
        });
        L.push(`  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'`);
    }

    /*
     * What the application opens, checked and normalised: `{ Files, Schemes }`.
     *
     * An extension is taken with or without its dot and kept lower case, since
     * Windows matches it either way and a registry key spelled twice is two
     * keys. **What would take over a program or a link is refused** -- an
     * installer that registers `.exe` or `.lnk` for an application breaks the
     * machine it was installed on -- and so are the schemes the system and the
     * browser own (`http`, `file`, `ms-…`). A one-letter scheme is a drive
     * (`C:`), so a scheme has two letters at least.
     */
    static associations(options) {
        const files   = (options && options.Files)   || [];
        const schemes = (options && options.Schemes) || [];
        const taken   = ["exe", "com", "bat", "cmd", "lnk", "url", "msi", "msp",
                         "scr", "pif", "cpl", "dll", "sys", "reg", "ps1", "vbs"];
        const owned   = ["http", "https", "file", "ftp", "mailto", "javascript",
                         "data", "about", "shell", "res"];

        if (!Array.isArray(files) || !Array.isArray(schemes))
            throw new Error("Files and Schemes are arrays -- " +
                            "[{ Extension, Description }] and [\"myapp\"]");

        const outFiles = [], seen = [];
        for (const f of files) {
            const raw = f && typeof f === "object" ? f.Extension : f;
            const ext = String(raw || "").replace(/^\./, "").toLowerCase();
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(ext))
                throw new Error(`'${raw}' is not a file extension an installer can ` +
                                `register -- letters, digits, '-' and '_', as in "invoice"`);
            if (taken.includes(ext))
                throw new Error(`.${ext} is Windows' own -- an application that took it ` +
                                `over would break every program or shortcut of that kind`);
            if (seen.includes(ext))
                throw new Error(`.${ext} is named twice`);
            seen.push(ext);
            const desc = f && typeof f === "object" && f.Description
                ? String(f.Description) : "";
            outFiles.push({ Extension: ext, Description: desc });
        }

        const outSchemes = [];
        for (const s of schemes) {
            const scheme = String(s || "").replace(/:(\/\/)?$/, "").toLowerCase();
            if (!/^[a-z][a-z0-9+.-]+$/.test(scheme))
                throw new Error(`'${s}' is not a URL scheme -- a letter, then letters, ` +
                                `digits, '+', '-' or '.', as in "myapp"`);
            if (owned.includes(scheme) || scheme.startsWith("ms-"))
                throw new Error(`${scheme}: belongs to the system or the browser -- ` +
                                `an application registers a scheme of its own`);
            if (outSchemes.includes(scheme))
                throw new Error(`${scheme}: is named twice`);
            outSchemes.push(scheme);
        }
        return { Files: outFiles, Schemes: outSchemes };
    }

    /*
     * What an NSIS string may hold: `$` opens a variable and `"` closes the
     * string, so both are escaped, and a line break becomes the `\r\n` the
     * script spells literally. A backslash is ordinary -- Windows paths pass
     * through untouched, which is the whole reason the payload is named with
     * them.
     *
     * **The dollar is replaced with four in the source for two in the
     * answer**: `$` is special in a replacement string too (`$$` writes one),
     * so `"$$"` here would be the no-op this used to be -- every `$` in the
     * prose reaching NSIS unescaped, where it opens a variable that is not
     * there.
     */
    static escape(text) {
        return String(text || "").replace(/\$/g, "$$$$").replace(/"/g, `$\\"`)
                                 .replace(/\t/g, `$\\t`)
                                 .replace(/\r?\n/g, `\\r\\n`);
    }

    /*
     * `VIProductVersion` wants four numbers: the version's numeric head,
     * padded with zeroes -- "2.1" becomes "2.1.0.0". Anything else (empty, or
     * text where the numbers go) leaves the version resource out rather than
     * writing one makensis would refuse the script over.
     */
    static viVersion(version) {
        const nums = [];
        for (const part of String(version || "").split(".")) {
            if (!/^\d+$/.test(part)) break;
            nums.push(String(parseInt(part, 10)));
            if (nums.length === 4) break;
        }
        if (!nums.length) return null;
        while (nums.length < 4) nums.push("0");
        return nums.join(".");
    }

    /* The setup file's own name: the version with nothing outside file names
     * in it. */
    static setupVersion(version) {
        const clean = String(version || "0.0").replace(/[^A-Za-z0-9.]+/g, "-");
        return clean || "0.0";
    }

    /* Both hosts, the `Exec` helper and every DLL beside them -- the link
     * closure a staged tree already collected. What is deliberately not
     * copied is any `.cmd` beside them: those launch the IDE, and an
     * application installer has no business shipping them. */
    static copyBin(prefix, payload) {
        const bin = File.Join(prefix, "bin");
        const to  = File.Join(payload, "bin");
        Nsis.makeDir(to);

        for (const exe of ["bintana.exe", "bintana-gui.exe", "bintana-exec.exe",
                            ...Nsis.spawnHelpers])
            File.Copy(File.Join(bin, exe), File.Join(to, exe));
        for (const dll of Directory.Files(bin, "*.dll"))
            File.Copy(dll, File.Join(to, File.Name(dll)));
    }

    /* One data directory, when the tree has it. Missing pieces are skipped --
     * only the executable above is load-bearing -- and the parent is made
     * first, because a copy does not invent the directories above it. */
    static copyTree(prefix, payload, rel) {
        const from = File.Join(prefix, rel);
        if (!File.IsDir(from)) return;

        const to = File.Join(payload, rel);
        Nsis.makeDir(File.Directory(to));
        Directory.Copy(from, to);
    }

    static copyFile(prefix, payload, rel) {
        const from = File.Join(prefix, rel);
        if (!File.Exists(from) || File.IsDir(from)) return;

        const to = File.Join(payload, rel);
        Nsis.makeDir(File.Directory(to));
        File.Copy(from, to);
    }

    /* GLib's, beside its DLL: the one a process with no console starts a
     * piped child through, and the one a console process does. */
    static spawnHelpers = ["gspawn-win64-helper.exe", "gspawn-win64-helper-console.exe"];

    static makeDir(path) {
        if (!File.IsDir(path)) Directory.Make(path);
    }
}
