/*
 * A project as the files a package is built from.
 *
 * The packaging step is three artefacts and a manifest, and this is the one
 * place that knows all four:
 *
 *   <out>/<id>.metainfo.xml    the project's metainfo, validated
 *   <out>/<id>.desktop         the menu entry, written by `Desktop.Entries.Write`
 *   <out>/<id>.svg|png         the icon, when the project ships one
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

        /* The icon, when the project ships one.  A theme name cannot travel in
         * a package, so an application that has no drawing gets no `<icon>` in
         * its metainfo and none here -- and a software centre shows a blank
         * rather than a lie. */
        const icon = Package.iconOf(project);
        if (!icon)
            throw new Error("the project ships no icon -- put an svg or png " +
                            "in icons/, because AppStream will not compose an " +
                            "application without one");

        /* **Named after the id**, whatever the project called it: that is the
         * name the desktop's `Icon=` asks the theme for and the one AppStream
         * looks for -- a package whose drawing is called something else is one
         * whose icon is not found, half a build later and by another program. */
        const iconOut = File.Join(out, `${id}.${File.Extension(icon).toLowerCase()}`);
        File.Copy(icon, iconOut);

        /* The project itself, so the manifest is a directory that can be built
         * from anywhere.  Hidden entries are left out -- `.git` and `.cache`
         * are not the program -- and everything else travels, including a
         * `lib/` of its own. */
        const projectOut = File.Join(out, "project");
        if (File.IsDir(projectOut))
            Directory.DeleteTree(projectOut);
        Package.copyProject(project, projectOut);

        const manifestOut = File.Join(out, `${id}.json`);
        File.SaveJson(manifestOut, Package.manifest({
            Id: id, Command: command, Config: config, Opts: opts,
            Names: Package.topLevel(project), Icon: iconOut,
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
     * **The command gets `%f` appended and not through `Exec`.**  `Exec` is for
     * a command line, where a `%` is a literal that has to be doubled; a field
     * code is the format's own and is written as it is -- so the quoting is
     * `Exec`'s and the field code is this line's.
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
            Exec:           Desktop.Entries.Exec([command]) + " %f",
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
            const dir  = File.Extension(name).toLowerCase() === "svg"
                             ? "scalable" : "128x128";

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

    /* The project's top-level entries, hidden ones left out: what the build
     * command copies into the package. */
    static topLevel(project) {
        return Directory.List(project).filter((name) => !name.startsWith("."));
    }

    static copyProject(project, dest) {
        Directory.Make(dest);

        for (const name of Package.topLevel(project)) {
            const from = File.Join(project, name);
            const to   = File.Join(dest, name);

            if (File.IsDir(from))
                Directory.Copy(from, to);
            else
                File.Copy(from, to);
        }
    }

    static iconOf(project) {
        const dir = File.Join(project, "icons");
        if (!File.IsDir(dir))
            return null;

        const drawn = Directory.Files(dir)
            .filter((f) => ["svg", "png"].includes(File.Extension(f).toLowerCase()));

        return drawn.length ? drawn.sort()[0] : null;
    }

    /* One argument of a build command, as the shell will read it. */
    static quote(text) {
        return `'${String(text).replace(/'/g, "'\\''")}'`;
    }
}
