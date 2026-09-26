/*
 * A project as a Windows installer: an NSIS script out of its metainfo.
 *
 * **Nsis is Windows-only, and says so in its name.** It is not "the
 * installer" -- Flatpak is `Package`'s -- it is the NSIS one, for the open
 * project as a Windows application: the Windows runtime tree, the project
 * itself and a `.cmd` launcher, installed per-user with an uninstaller.
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
     * Nsis.Script(project, out) -- the installer script, from the metainfo.
     *
     * Answers `{ Id, Command, Version, Script, Icon, Payload, Note }`: the
     * script's path, the `.ico` beside it (or `null` when the project has no
     * PNG icon, with `Note` saying which file would change that), and where
     * `Stage` will put the payload the script compiles in.
     *
     * **Every refusal comes before the first write**, `Package.Write`'s rule:
     * no id, no metainfo, a metainfo that disagrees with `project.json`, a
     * broken icon and an output inside the project all stop here with a
     * sentence, and `out` is left as it was.
     */
    static Script(project, out) {
        const config = Package.configOf(project);

        const metaPath = Metainfo.find(project);
        if (!metaPath)
            throw new Error(`the project has no ${config.Id}.metainfo.xml -- ` +
                            `Application info in the IDE writes one`);

        const doc      = File.LoadXml(metaPath);
        const problems = Metainfo.problems(doc, metaPath, config);
        if (problems.length)
            throw new Error(`${File.Name(metaPath)} does not agree with ` +
                            `project.json: ${problems.join("; ")}`);

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
                                        Icon:    ico ? File.Name(ico) : null }));

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
     * `bin/bintana.exe` and its DLLs, the data GTK opens by name, the shipped
     * libraries the project's `uses` resolve from -- and the project itself
     * under `share/bintana/apps/<command>`, with a `.cmd` launcher beside the
     * executable. Answers the payload directory.
     *
     * The tree is copied by name and not collected by link: a development
     * checkout is not a shippable tree, and `ldd` is an MSYS2 program no
     * Windows user has. What is refused is a prefix with no `bin/bintana.exe`
     * in it -- staging from one of those is how an installer quietly misses
     * its own runtime.
     */
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
                           "share/icons/hicolor",
                           "share/gtksourceview-5",
                           "lib/gtksourceview-5",
                           "share/mime",
                           "share/bintana/lib"])
            Nsis.copyTree(prefix, payload, dir);
        Nsis.copyFile(prefix, payload, File.Join("etc", "gtk-4.0", "settings.ini"));

        /* The project itself, the way `Package.Write` copies it: everything
         * but the hidden entries, so `.git` does not travel. */
        const command = Package.commandName(config.Id);
        const appDir  = File.Join(payload, "share", "bintana", "apps", command);
        Package.copyProject(project, appDir, names);

        /* The launcher: the Windows spelling of the manifest's script -- the
         * runtime on its own project, resolved from the launcher's own
         * location so the tree installs anywhere. */
        const launcher =
            "@echo off\r\n" +
            `rem ${config.Name}, from wherever this was installed to.\r\n` +
            "setlocal\r\n" +
            "set \"HERE=%~dp0\"\r\n" +
            `"%HERE%bintana.exe" "%HERE%..\\share\\bintana\\apps\\${command}" %*\r\n`;
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
        const built = Exec.Wait([makensis, "-NOCONFIG", "-V2",
                                 `-DOUTFILE=${exe}`, script],
                                { Timeout: 300000, Stderr: "separate" });
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
     * the real compiler, `Include`, the stubs, `COPYING`) -- so building an
     * installer needs nothing installed; a tree without one falls back to a
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
            if (info.Summary)
                L.push(`VIAddVersionKey "FileDescription" "${e(info.Summary)}"`);
            if (info.DeveloperName)
                L.push(`VIAddVersionKey "CompanyName" "${e(info.DeveloperName)}"`);
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
        L.push(`!define MUI_FINISHPAGE_RUN "$INSTDIR\\bin\\${cmd}.cmd"`);
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

        L.push(`Section "Application" SEC_APP`);
        L.push(`  SectionIn RO`);
        L.push(`  SetOutPath "$INSTDIR"`);
        L.push(`  File /r "payload\\*"`);
        if (o.Icon)
            L.push(`  File "${e(o.Icon)}"`);
        L.push(`  WriteUninstaller "$INSTDIR\\Uninstall.exe"`);
        L.push(``);
        L.push(`  CreateDirectory "$SMPROGRAMS\\${e(info.Name)}"`);
        L.push(`  CreateShortCut "$SMPROGRAMS\\${e(info.Name)}\\${e(info.Name)}.lnk" ` +
               `"$INSTDIR\\bin\\${cmd}.cmd"${o.Icon ? ` "" "$INSTDIR\\${e(o.Icon)}"` : ``}`);
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
        L.push(`SectionEnd`);
        L.push(``);
        L.push(`Section "Desktop shortcut" SEC_DESK`);
        L.push(`  CreateShortCut "$DESKTOP\\${e(info.Name)}.lnk" ` +
               `"$INSTDIR\\bin\\${cmd}.cmd"${o.Icon ? ` "" "$INSTDIR\\${e(o.Icon)}"` : ``}`);
        L.push(`SectionEnd`);
        L.push(``);
        L.push(`Section "Uninstall"`);
        L.push(`  Delete "$SMPROGRAMS\\${e(info.Name)}\\*.lnk"`);
        L.push(`  RMDir "$SMPROGRAMS\\${e(info.Name)}"`);
        L.push(`  Delete "$DESKTOP\\${e(info.Name)}.lnk"`);
        if (o.Icon)
            L.push(`  Delete "$INSTDIR\\${e(o.Icon)}"`);
        L.push(`  RMDir /r "$INSTDIR"`);
        L.push(`  DeleteRegKey HKCU "${e(key)}"`);
        L.push(`SectionEnd`);
        L.push(``);

        return L.join("\r\n") + "\r\n";
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

    /* `bin/bintana.exe` and every DLL beside it -- the link closure a staged
     * tree already collected. What is deliberately not copied is any `.cmd`
     * beside them: those launch the IDE, and an application installer has no
     * business shipping them. */
    static copyBin(prefix, payload) {
        const bin = File.Join(prefix, "bin");
        const to  = File.Join(payload, "bin");
        Nsis.makeDir(to);

        File.Copy(File.Join(bin, "bintana.exe"), File.Join(to, "bintana.exe"));
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

    static makeDir(path) {
        if (!File.IsDir(path)) Directory.Make(path);
    }
}
