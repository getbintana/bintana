/*
 * Installing the open project as a user application.
 *
 * A user application is one `.desktop` file in the directory
 * `Desktop.Entries.Directory` names, and the runtime reads and writes that
 * format -- `docs/llm/library.md`.  What is left is the IDE's own three
 * decisions, and they are the whole of this module: **what the entry says**,
 * **where it points**, and **how it is found again**.
 *
 * **Why `X-Bintana-Project` rather than the file name.**  An installed
 * application has to be recognisable as *this* project's in order to be offered
 * for update or removal, and the id is a slug of the name a person typed -- one
 * rename and the old entry would look like somebody else's.  The key is the
 * project's absolute path, which is what the entry really points at; the scan
 * is over the entries the user has, and an entry without it is not ours to
 * touch.
 *
 * **Why `Application.Executable` and not the word `bintana`.**  The runtime the
 * IDE is running on is the one that can open this project -- which under a build
 * tree is `./build/bintana`, a path no `PATH` search will find.  It is written
 * quoted by `Desktop.Entries.Exec`, so a path with a space in it is one
 * argument and not two.
 *
 * **The window's identity is the project's id, and that is what makes
 * `StartupWMClass` writable here.**  A project that declares an id is classed
 * by it -- the runtime hands it to `GtkApplication` and to the program name --
 * so the entry carries the same string and a dock groups the running window
 * under this entry.  A project without an id gets no `StartupWMClass`, which is
 * the honest answer: its window is `bintana`'s, and claiming otherwise would be
 * an entry that matches nothing.
 *
 * That is also why the entry is installed under the project's id when there is
 * one: the file name and the window's class are then the same name, which is
 * what the desktop entry specification means by an application id.
 */
"use strict";

Namespace("Ide");

Ide.Apps = class Apps {

    /*
     * The id an entry is installed under when the project declares none: the
     * file's name without `.desktop`, made of a slug of the name it was given.
     *
     * Letters, digits, `-`, `_` and `.` are what the specification allows and
     * what the runtime checks, so everything else becomes a dash -- and a name
     * that was all punctuation falls back to a word rather than installing a
     * `.desktop` with no name at all.
     *
     * A project that *does* declare an id installs under `<id>.devel` --
     * see `entryId`.
     */
    static idFor(name) {
        const slug = String(name || "")
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-.]+|[-.]+$/g, "");

        return slug || "bintana-app";
    }

    /*
     * The name the entry is installed under: `<id>.devel` for a project that
     * declares an id, a slug of the name otherwise.
     *
     * **Not `<id>` itself**, which it was: a desktop file's name is its
     * desktop-file id, and `<id>.desktop` is exactly what a Flatpak of the same
     * application exports -- a user-level entry of that name takes precedence,
     * so installing from the IDE hid the packaged application from the menu
     * and the menu launched the source tree instead. `.devel` is the suffix
     * GNOME's own development builds use. The window's class is still the id
     * (`StartupWMClass`), which is a different key and what the dock matches.
     */
    static entryId(appId, name) {
        return appId ? `${appId}.devel` : Apps.idFor(name);
    }

    /*
     * The entry, as `Desktop.Entries.Install` takes it.
     *
     * The two optional keys are left out when they were left empty rather than
     * written with nothing in them: a `Comment=` of `""` is a menu tooltip that
     * is an empty box, which is worse than no tooltip.
     */
    static entry(project, fields) {
        const entry = {
            Type:               "Application",
            Name:               fields.Name,
            Exec:               Desktop.Entries.Exec([Application.Executable, project]),
            Terminal:           "false",
            "X-Bintana-Project": project,
        };

        if (fields.Comment) entry.Comment = fields.Comment;
        if (fields.Icon)    entry.Icon    = fields.Icon;

        /* The class the running window really has, which is the project's id
         * when it declares one. Written only then: an entry claiming a class
         * nothing will ever have is worse than no claim, because the dock goes
         * on showing a generic icon with the entry looking correct. */
        if (fields.AppId) entry.StartupWMClass = fields.AppId;

        return { "Desktop Entry": entry };
    }

    /*
     * The installed entry that points at this project, or `null`.
     *
     * Walking the ids rather than asking for a path: the user may have renamed
     * the project or edited the entry by hand, and what says an entry is ours
     * is the path it carries, not the name it was installed under.
     */
    static installed(project) {
        for (const id of Desktop.Entries.Installed()) {
            const data = Desktop.Entries.Read(id);
            const held = data && data["Desktop Entry"];
            if (held && held["X-Bintana-Project"] === project)
                return { Id: id, Entry: held };
        }
        return null;
    }

    /*
     * Installs, replacing an entry that is already this project's under another
     * id -- which is what a rename produces, and leaving the old one behind
     * would offer the same application in the menu twice.
     */
    static install(project, fields) {
        const id  = Apps.entryId(fields.AppId, fields.Name);
        const was = Apps.installed(project);

        if (was && was.Id !== id)
            Desktop.Entries.Uninstall(was.Id);

        return Desktop.Entries.Install(id, Apps.entry(project, fields));
    }

    static uninstall(id) {
        return Desktop.Entries.Uninstall(id);
    }

    /*
     * What the icon field starts on: the project's own drawing when it ships
     * one, and otherwise a name from the desktop's theme.
     *
     * **A project's icon is written as an absolute path and not as a name.**
     * `<project>/icons` is on the runtime's search path -- that is how a form
     * draws it -- but the desktop drawing a menu is another process and knows
     * nothing about this project's directory; the specification allows an
     * absolute path for `Icon`, and GIO resolves it to a file icon (measured
     * with `GDesktopAppInfo`).  A theme name stays a name, because it is one
     * every desktop has.
     */
    static defaultIcon(project, id) {
        /* **Which drawing is the application's is `lib/package`'s answer**,
         * the one a package ships: `icons/<id>.svg` or `.png`, or the only
         * drawing there that is not a control's `-symbolic` glyph.  This used
         * to take the alphabetically first file in `icons/`, which in a project
         * with glyphs of its own is a glyph. */
        const own = Package.iconOf(project, id || "");
        if (own.Path) return own.Path;
        return Application.HasIcon("application-x-executable")
                   ? "application-x-executable" : "";
    }
};
