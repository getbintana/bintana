/*
 * A project as the files a package is built from.
 *
 * The packaging step is three artefacts and a manifest, and this is the one
 * place that knows all four:
 *
 *   <out>/<id>.metainfo.xml    the project's metainfo, validated
 *   <out>/<id>.desktop         the menu entry, written by `Desktop.Entries.Write`
 *   <out>/<id>.svg|png         the icon, which it must ship
 *   <out>/project/             the project itself, as the manifest builds from
 *   <out>/<id>.json            the Flatpak manifest
 *
 * **The manifest is JSON and not YAML**, because flatpak-builder reads both and
 * the runtime already writes JSON -- a YAML writer would be a second format
 * implemented for one caller.  It is a *build context*: everything it names is
 * beside it, so the directory can be copied anywhere and built.
 *
 * **Nothing here installs anything.**  The output is input for
 * `flatpak-builder`, and `docs/installing.md` is where the command lives.  What
 * this owns is what the two files must say and what the manifest must carry --
 * and the refusals, which are the point: a project with no id, a metainfo that
 * disagrees with `project.json`, an entry the format would refuse, all stop
 * here with a sentence instead of becoming a package that installs under one
 * name and claims another.
 */
"use strict";

class Package {

    /*
     * What the generated manifest carries when the caller says nothing.
     *
     * `BaseVersion` is the Bintana release, from the one number `CMakeLists.txt`
     * declares: the BaseApp's branch *is* the runtime's version, so a package
     * built by this runtime asks for the base it was built with.  The rest is
     * the GNOME runtime the base was built against and the sandbox permissions
     * an ordinary windowed application needs -- a program that wants more (the
     * network, the user's files) passes them in, because only its author knows.
     */
    static defaults = {
        Runtime:        "org.gnome.Platform",
        RuntimeVersion: "50",
        Sdk:            "org.gnome.Sdk",
        Base:           "io.github.getbintana.BaseApp",
        BaseVersion:    BTA_VERSION.split(".").slice(0, 2).join("."),
        Branch:         "stable",
        FinishArgs:     ["--share=ipc", "--socket=wayland",
                         "--socket=fallback-x11", "--device=dri"],
    };

    /*
     * Package.Write(project, out, [options]) -- the four files and the manifest,
     * answering where each one went.
     *
     * The options are `Package.defaults` with whatever the caller passes laid
     * over them, one key at a time.
     */
    static Write(project, out, options) {
        const opts   = Package.options(options);
        const config = Package.configOf(project);

        /*
         * **Every refusal comes before the first write.**  The icon used to be
         * checked after the metainfo and the entry were already in `out`, so a
         * refused project left a half-written build context behind -- one that
         * looks, to whoever lists it, like a packaging step that got most of the
         * way.
         */
        const metaPath = Metainfo.find(project);
        if (!metaPath)
            throw new Error(`the project has no ${config.Id}.metainfo.xml -- ` +
                            `Application info in the IDE writes one`);

        const doc      = File.LoadXml(metaPath);
        const problems = Metainfo.problems(doc, metaPath, config);
        if (problems.length)
            throw new Error(`${File.Name(metaPath)} does not agree with ` +
                            `project.json: ${problems.join("; ")}`);

        /* The icon, which a package must have: a theme name cannot travel in
         * one, and AppStream will not compose an application without one. */
        const icon = Package.iconOf(project, config.Id);
        if (icon.Problem)
            throw new Error(icon.Problem);

        /* What is copied, decided now, because it can refuse too. */
        const names = Package.topLevel(project, out);

        const info    = Metainfo.read(doc);
        const id      = config.Id;
        const command = Package.commandName(id);

        Directory.Make(out);

        /* The metainfo, rewritten canonically: what a package ships is the
         * document, not the bytes somebody's editor left. */
        const metaOut = File.Join(out, Metainfo.fileName(id));
        File.SaveXml(metaOut, doc);

        /* The entry, through the runtime's writer -- the format's quoting is
         * not something to spell here. */
        const deskOut = File.Join(out, `${id}.desktop`);
        Desktop.Entries.Write(deskOut, Package.entry(info, Metainfo.translations(doc),
                                                     id, command));

        /* **Named after the id**, whatever the project called it: that is the
         * name the desktop's `Icon=` asks the theme for and the one AppStream
         * looks for -- a package whose drawing is called something else is one
         * whose icon is not found, half a build later and by another program. */
        const iconOut = File.Join(out, `${id}.${File.Extension(icon.Path).toLowerCase()}`);
        if (File.Exists(iconOut)) File.Delete(iconOut);   /* Copy refuses to clobber */
        File.Copy(icon.Path, iconOut);

        /* The project itself, so the manifest is a directory that can be built
         * from anywhere.  Hidden entries are left out -- `.git` and `.cache`
         * are not the program -- and so is the output directory when it is
         * inside the project; everything else travels, including a `lib/` of
         * its own. */
        const projectOut = File.Join(out, "project");
        if (File.IsDir(projectOut))
            Directory.DeleteTree(projectOut);
        Package.copyProject(project, projectOut, names);

        const manifestOut = File.Join(out, `${id}.json`);
        File.SaveJson(manifestOut, Package.manifest({
            Id: id, Command: command, Config: config, Opts: opts,
            Names: names, Icon: iconOut, IconDir: icon.Dir,
        }));

        return {
            Id:       id,
            Command:  command,
            Manifest: manifestOut,
            Metainfo: metaOut,
            Desktop:  deskOut,
            Icon:     iconOut,
            Project:  projectOut,
        };
    }

    /* --- the pieces ------------------------------------------------------- */

    /*
     * `project.json` as this needs it, and the refusal when it has no identity:
     * a package is installed under the id and the metainfo is named after it,
     * so there is nothing to fall back to.
     */
    static configOf(project) {
        const path = File.Join(project, "project.json");
        if (!File.Exists(path))
            throw new Error(`${project} has no project.json`);

        const config = File.LoadJson(path);
        if (!config || !config.id)
            throw new Error("the project declares no id -- a package is " +
                            "installed under it, and the metainfo is named after it");
        if (!config.name)
            throw new Error("the project declares no name");

        return { Id: config.id, Name: config.name,
                 Version: config.version || "", Dir: project };
    }

    /*
     * The command a menu runs: `bintana-` and the last element of the id, which
     * is the part that names the application and not its author.
     */
    static commandName(id) {
        const last = String(id).split(".").pop().toLowerCase()
                                .replace(/[^a-z0-9]+/g, "-")
                                .replace(/^-+|-+$/g, "");
        return `bintana-${last || "app"}`;
    }

    /*
     * The entry, as `Desktop.Entries.Write` takes it.
     *
     * **The command is written bare, and `%f` after it.**  It is a name
     * `commandName` composed out of `[a-z0-9-]`, so it needs no quoting -- and
     * `flatpak build-export` reads the first word of `Exec` to check the binary
     * and looks for one whose *name* carries the quotes, so a quoted command
     * gets a warning that `"bintana-project"` is missing.  The field code is
     * appended and not passed through `Desktop.Entries.Exec` either: `Exec` is
     * for a command line, where a `%` is a literal that has to be doubled.
     *
     * `StartupWMClass` is the project's id, which is the class the window really
     * has, and the translations of the name and the summary travel as
     * `Name[es]`/`Comment[es]` so the menu and the software centre say the same
     * thing.
     */
    static entry(info, translations, id, command) {
        const entry = {
            Type:           "Application",
            Name:           info.Name,
            Exec:           `${command} %f`,
            Icon:           id,
            StartupWMClass: id,
            Terminal:       "false",
        };

        if (info.Summary) entry.Comment = info.Summary;

        for (const lang of Dictionary.Keys(translations.Names))
            entry[`Name[${lang}]`] = translations.Names[lang];
        for (const lang of Dictionary.Keys(translations.Summaries))
            entry[`Comment[${lang}]`] = translations.Summaries[lang];

        return { "Desktop Entry": entry };
    }

    /*
     * The Flatpak manifest, as the JSON flatpak-builder reads.
     *
     * The module is `simple` and its sources are all beside the manifest: the
     * project directory, the entry, the icon when there is one, and a script
     * that is the command -- a package runs the runtime on its own project, and
     * the launcher is the whole of what makes that one word.
     */
    static manifest(o) {
        const id      = o.Id;
        const names   = o.Names.map(Package.quote).join(" ");
        const commands = [];

        commands.push(`mkdir -p /app/share/${id}`);
        if (names)
            commands.push(`cp -r ${names} /app/share/${id}/`);
        commands.push(`install -Dm755 ${o.Command} /app/bin/${o.Command}`);
        commands.push(`install -Dm644 ${id}.desktop ` +
                      `/app/share/applications/${id}.desktop`);
        /* The metainfo goes where AppStream looks for it -- `/app/share/metainfo`
         * is what flatpak exports an application's metadata from -- and not only
         * beside the project it describes. */
        commands.push(`install -Dm644 ${Metainfo.fileName(id)} ` +
                      `/app/share/metainfo/${Metainfo.fileName(id)}`);

        const sources = [
            { "type": "dir", "path": "project" },
            { "type": "file", "path": `${id}.desktop` },
            { "type": "file", "path": Metainfo.fileName(id) },
            {
                "type": "script",
                "dest-filename": o.Command,
                "commands": [`exec /app/bin/bintana /app/share/${id} "$@"`],
            },
        ];

        if (o.Icon) {
            const name = File.Name(o.Icon);
            /* `scalable` for a drawing and the PNG's **own** size for a
             * picture: a 256-pixel PNG installed as `128x128` is one the theme
             * serves at the wrong size and AppStream measures and refuses. */
            const dir  = o.IconDir ||
                         (File.Extension(name).toLowerCase() === "svg" ? "scalable" : "128x128");

            commands.push(`install -Dm644 ${name} ` +
                          `/app/share/icons/hicolor/${dir}/apps/${name}`);
            sources.push({ "type": "file", "path": name });
        }

        return {
            "id":              id,
            "branch":          o.Opts.Branch,
            "runtime":         o.Opts.Runtime,
            "runtime-version": o.Opts.RuntimeVersion,
            "sdk":             o.Opts.Sdk,
            "base":            o.Opts.Base,
            "base-version":    o.Opts.BaseVersion,
            "command":         o.Command,
            "finish-args":     o.Opts.FinishArgs,
            "modules": [
                {
                    "name":           id,
                    "buildsystem":    "simple",
                    "build-commands": commands,
                    "sources":        sources,
                },
            ],
        };
    }

    /* --- small pieces ----------------------------------------------------- */

    /* `Dictionary.Keys` and not `Object.keys`: most of `Object` is not in this
     * language, which is a fact about it and not a preference. */
    static options(given) {
        const merged = {};
        for (const key of Dictionary.Keys(Package.defaults))
            merged[key] = Package.defaults[key];
        if (given)
            for (const key of Dictionary.Keys(given))
                if (given[key] !== undefined)
                    merged[key] = given[key];
        return merged;
    }

    /*
     * The project's top-level entries, hidden ones left out: what the build
     * command copies into the package.
     *
     * **And the output directory, when it is one of them.**  `tools/pack h
     * h/dist` copied `dist` into `dist/project/dist`, which copied itself into
     * that, without end -- the copy is taken while it is being written.  The
     * comparison is of absolute paths, so `h/./dist` and `dist` from inside `h`
     * are the same directory.  An output *deeper* inside one entry (`h/build/pkg`)
     * is refused rather than carved out of it: the entry would have to be copied
     * all but one of its descendants, and the ordinary place for a build context
     * is beside the project or at its top.
     */
    static topLevel(project, out) {
        const root  = File.Absolute(project);
        const where = out ? File.Absolute(out) : "";

        if (where && File.Within(root, where))
            throw new Error(`the output directory ${out} holds the project -- ` +
                            `write the package beside it or under it`);

        const names = [];
        for (const name of Directory.List(project)) {
            if (name.startsWith(".")) continue;

            const path = File.Join(root, name);
            if (where && path === where) continue;        /* the output itself */
            if (where && File.Within(where, path))
                throw new Error(`the output directory ${out} is inside the project's ` +
                                `${name}/, which would be copied into itself -- ` +
                                `use ${File.Join(project, File.Name(out))} or a ` +
                                `directory outside the project`);
            names.push(name);
        }
        return names;
    }

    static copyProject(project, dest, names) {
        Directory.Make(dest);

        for (const name of names || Package.topLevel(project)) {
            const from = File.Join(project, name);
            const to   = File.Join(dest, name);

            if (File.IsDir(from))
                Directory.Copy(from, to);
            else
                File.Copy(from, to);
        }
    }

    /* The sizes the hicolor theme has a directory for, from 64 up: below that
     * AppStream will not use a picture as an application's icon. */
    static iconSizes = [64, 72, 96, 128, 192, 256, 384, 480, 512];

    /*
     * The application's own drawing, as `{ Path, Dir, Problem }`.
     *
     * **`icons/<id>.svg`, then `icons/<id>.png`**: the name the desktop's
     * `Icon=` asks the theme for.  `icons/` is also where a project keeps the
     * glyphs its controls draw (`bta-button-symbolic.svg`), so "the first
     * drawing in the folder" -- which is what this used to answer -- was the
     * alphabetically first glyph as often as it was the application.  With no
     * file by the id's name, **one** drawing that is not a `-symbolic` glyph is
     * unambiguous and is taken; more than one is refused, naming the file that
     * would settle it.
     *
     * A PNG is measured, because where it is installed is its size: the IHDR
     * chunk carries the width and the height as big-endian numbers at bytes 16
     * to 23 of every PNG.
     */
    static iconOf(project, id) {
        const dir    = File.Join(project, "icons");
        const wanted = `icons/${id}.svg or icons/${id}.png`;
        const none   = { Path: null, Dir: "",
                         Problem: `the project ships no icon -- put ${wanted} in ` +
                                  `the project, because AppStream will not compose ` +
                                  `an application without one` };

        if (!File.IsDir(dir))
            return none;

        for (const ext of ["svg", "png"]) {
            const named = File.Join(dir, `${id}.${ext}`);
            if (File.Exists(named)) return Package.measureIcon(named);
        }

        const drawn = Directory.Files(dir)
            .filter((f) => ["svg", "png"].includes(File.Extension(f).toLowerCase()))
            .filter((f) => !/-symbolic$/i.test(File.BaseName(f)));

        if (drawn.length === 1) return Package.measureIcon(drawn[0]);
        if (!drawn.length)      return none;

        return { Path: null, Dir: "",
                 Problem: `icons/ holds ${drawn.length} drawings ` +
                          `(${drawn.map((f) => File.Name(f)).join(", ")}) and none ` +
                          `is named after the id -- name the application's own ` +
                          `${wanted}, which is what the desktop's Icon= asks for` };
    }

    static measureIcon(path) {
        if (File.Extension(path).toLowerCase() === "svg")
            return { Path: path, Dir: "scalable", Problem: "" };

        const b    = File.LoadBytes(path);
        const name = File.Name(path);
        if (b.Length < 24 || b.Slice(0, 8).ToHex() !== "89504e470d0a1a0a" ||
            b.Slice(12, 4).ToText() !== "IHDR")
            return { Path: null, Dir: "", Problem: `icons/${name} is not a PNG` };

        const word = (at) => ((b.At(at) * 256 + b.At(at + 1)) * 256 + b.At(at + 2)) * 256
                             + b.At(at + 3);
        const w = word(16), h = word(20);

        if (w !== h)
            return { Path: null, Dir: "",
                     Problem: `icons/${name} is ${w}x${h} -- an application's icon ` +
                              `is square` };
        if (!Package.iconSizes.includes(w))
            return { Path: null, Dir: "",
                     Problem: `icons/${name} is ${w}x${h}, which is not a size the ` +
                              `icon theme has a place for -- use one of ` +
                              `${Package.iconSizes.join(", ")}, or an svg` };

        return { Path: path, Dir: `${w}x${h}`, Problem: "" };
    }

    /* One argument of a build command, as the shell will read it. */
    static quote(text) {
        return `'${String(text).replace(/'/g, "'\\''")}'`;
    }
}
