/*
 * <id>.metainfo.xml: the AppStream file a project carries.
 *
 * **It is the project's identity written for whoever installs it.** The file
 * is named after `project.json`'s `id` and its `<id>` and primary `<name>` are
 * the same two strings -- the window's class, the package's name and what a
 * software centre shows all come from here. That is why the pair is *checked*
 * and not merely copied: a metainfo whose id disagrees with the manifest is a
 * package that installs under one name and claims another, and nothing says so
 * until somebody's dock shows the wrong icon.
 *
 * **The format is AppStream's and not ours.** This module reads and writes the
 * common fields through the `Xml` DOM and leaves everything else -- releases,
 * screenshots, translations, `<provides>`, anything a person added by hand --
 * exactly where it was: the DOM keeps what it is not asked about, so the file
 * is lossless in both directions. Translations are `xml:lang` attributes, which
 * is what `Xml.SetAttrNS` and `Xml.AttrNS` are for; the form edits the primary
 * fields, and the raw XML tab is the road for the rest.
 *
 * **The primary name and id are not editable here.** They belong to
 * `project.json`, and `write` takes them from the record on every save, so the
 * two files cannot drift while this is the writer; `problems` is what reports
 * a hand-edit that did.
 *
 * **It lives in `lib/package` and not in the IDE**, because the packaging tool
 * reads and writes the same file and two implementations of one format is the
 * copy that drifts. The IDE reaches it through `uses`, like any application.
 */
"use strict";

class Metainfo {

    /* The XML namespace, which is how `xml:lang` is spelled. */
    static XMLNS = "http://www.w3.org/XML/1998/namespace";

    /* What the file is called for a project's id. */
    static fileName(id) { return `${id}.metainfo.xml`; }

    /*
     * The project's metainfo file, or `null`.
     *
     * Found by suffix in the project root rather than by rebuilding the name
     * from the id: the id may have changed since the file was written, and a
     * project that has one has one whatever it is called -- which is exactly
     * the state `problems` is for.
     */
    static find(project) {
        const found = Directory.Files(project, "*.metainfo.xml");
        return found.length ? found.sort()[0] : null;
    }

    static load(path) { return File.LoadXml(path); }

    /* --- what does not agree with project.json ---------------------------- */

    static problems(doc, path, config) {
        const out  = [];
        const root = doc.Root;

        if (!root)
            return ["the file has no root element"];

        const seen = Metainfo.read(doc);

        if (config.Id && seen.Id !== config.Id)
            out.push(`<id> is "${seen.Id}" and project.json says "${config.Id}"`);
        if (!config.Id)
            out.push("the project declares no id, so the metainfo has nothing to agree with");
        if (seen.Name !== config.Name)
            out.push(`<name> is "${seen.Name}" and project.json says "${config.Name}"`);

        const wanted = config.Id ? Metainfo.fileName(config.Id) : "";
        if (wanted && File.Name(path) !== wanted)
            out.push(`the file is named ${File.Name(path)} and the id wants ${wanted}`);

        /* **And what `appstreamcli validate` refuses, said here first.**  The
         * file `create` used to write had an empty `<summary>` when the project
         * had no description, a multi-line one when it had a long one, and an
         * empty `<p/>` -- three errors the validator reports and a package
         * would ship, since nothing between here and a software centre asks. */
        if (seen.Summary.trim() === "")
            out.push("the <summary> is empty -- it is the line a software centre shows under the name");
        else if (/[\r\n]/.test(seen.Summary))
            out.push("the <summary> has a line break in it -- it is one line");
        if (seen.Description.trim() === "")
            out.push("the <description> has no text -- AppStream wants at least one paragraph");

        return out;
    }

    /* --- the fields the form edits ---------------------------------------- */

    /*
     * The common fields, as data. A missing element answers `""` and not
     * `null`, because that is what the form's empty text box is: the two
     * states are one to whoever is about to type in it.
     */
    static read(doc) {
        const root = doc.Root;
        const url  = (kind) => {
            for (const u of root.FindAll("url"))
                if (u.Attr("type") === kind) return u.Text;
            return "";
        };
        const dev  = root.Find("developer");
        const cats = root.Find("categories");
        const desc = root.Find("description");

        return {
            Id:              Metainfo.textOf(root, "id"),
            Name:            Metainfo.textOf(root, "name"),
            Summary:         Metainfo.textOf(root, "summary"),
            Description:     desc ? desc.FindAll("p")
                                      .filter((p) => p.AttrNS(Metainfo.XMLNS, "lang") === null)
                                      .map((p) => p.Text).join("\n\n")
                                  : "",
            DeveloperId:     dev ? dev.Attr("id") : "",
            DeveloperName:   dev ? Metainfo.textOf(dev, "name") : "",
            MetadataLicense: Metainfo.textOf(root, "metadata_license"),
            ProjectLicense:  Metainfo.textOf(root, "project_license"),
            Homepage:        url("homepage"),
            Bugtracker:      url("bugtracker"),
            Categories:      cats ? cats.FindAll("category").map((c) => c.Text).join(", ")
                                  : "",
        };
    }

    /*
     * The translated names and summaries, by language code: `<name xml:lang="es">`
     * is the Spanish one.  What a `.desktop` needs to say `Name[es]` -- the
     * primary elements are the ones without a `lang`, and they are `read`'s.
     */
    static translations(doc) {
        const root = doc.Root;
        const out  = { Names: {}, Summaries: {} };

        for (const el of root.FindAll("name")) {
            const lang = el.AttrNS(Metainfo.XMLNS, "lang");
            if (lang) out.Names[lang] = el.Text;
        }
        for (const el of root.FindAll("summary")) {
            const lang = el.AttrNS(Metainfo.XMLNS, "lang");
            if (lang) out.Summaries[lang] = el.Text;
        }
        return out;
    }

    /*
     * Writes those fields into the document, and the identity from the record.
     *
     * **Only the primary elements are touched.** A `<name xml:lang="es">` is a
     * translation and stays; so does a `<p xml:lang="es">` under the
     * description. That is the whole reason this walks and matches by hand
     * instead of replacing a subtree: the file belongs to whoever wrote it, and
     * an editor that ate the translations would do it silently.
     */
    static write(doc, fields, config) {
        const root = doc.Root;

        /* Identity, from project.json: not edited here, and written on every
         * save so the two files cannot drift while this is the writer. */
        Metainfo.setTextOf(root, "id", config.Id);
        Metainfo.setTextOf(root, "name", config.Name);

        const launch = Metainfo.ensure(root, "launchable");
        launch.SetAttr("type", "desktop-id");
        launch.Text = `${config.Id}.desktop`;

        Metainfo.setTextOf(root, "summary", fields.Summary);
        Metainfo.setTextOf(root, "metadata_license", fields.MetadataLicense);
        Metainfo.setTextOf(root, "project_license", fields.ProjectLicense);

        Metainfo.setDescription(root, fields.Description);
        Metainfo.setCategories(root, fields.Categories);
        Metainfo.setDeveloper(root, fields.DeveloperId, fields.DeveloperName);
        Metainfo.setUrl(root, "homepage", fields.Homepage);
        Metainfo.setUrl(root, "bugtracker", fields.Bugtracker);
    }

    /*
     * A fresh metainfo for a project, written beside its `project.json`.
     *
     * It is deliberately minimal and valid: what is required, the release the
     * manifest declares, and the icon only when the project ships one -- an
     * `<icon>` naming a theme icon that is not there is worse than none,
     * because the package then claims something it cannot draw.
     */
    static create(project, config) {
        const path = File.Join(project, Metainfo.fileName(config.Id));
        const root = Xml.Element("component");

        root.SetAttr("type", "desktop-application");
        root.Add("id").Text = config.Id;
        root.Add("metadata_license").Text = "MIT";
        root.Add("project_license").Text = "MIT";
        root.Add("name").Text = config.Name;
        root.Add("summary").Text = Metainfo.summaryOf(config);
        Metainfo.setDescription(root, config.Description ||
                                      `${config.Name} is an application made with Bintana.`);

        const launch = root.Add("launchable");
        launch.SetAttr("type", "desktop-id");
        launch.Text = `${config.Id}.desktop`;

        if (Metainfo.shipsIcon(project, config.Id)) {
            const icon = root.Add("icon");
            icon.SetAttr("type", "stock");
            icon.Text = config.Id;
        }

        root.Add("categories").Add("category").Text = "Utility";
        root.Add("content_rating").SetAttr("type", "oars-1.1");

        const release = root.Add("releases").Add("release");
        release.SetAttr("version", config.Version || "0.1.0");
        release.SetAttr("date", Day.Today);

        File.SaveXml(path, root);
        return path;
    }

    /*
     * One line for `<summary>`, out of the project's description: its first
     * line, without the full stop AppStream asks a summary not to end in -- and
     * something that says what the thing is when the project has none, because
     * an empty summary is one the validator refuses.
     */
    static summaryOf(config) {
        const first = String(config.Description || "").split(/\r?\n/)
                          .map((l) => l.trim()).find((l) => l !== "") || "";
        const line  = first.replace(/\.+$/, "").trim();
        return line || `${config.Name}, made with Bintana`;
    }

    /*
     * The file follows the identity: renamed with the id, and its `<id>`,
     * `<launchable>`, stock `<icon>` and primary `<name>` with it. Answers the
     * path it is at now, or `null` when the project has no metainfo to move.
     *
     * **A file already at the new name is refused**, not overwritten: it is
     * somebody's metainfo, and the one being moved is not the only candidate
     * for being the right one.  **Only a stock icon follows the id** -- a
     * `remote` one is a URL and a `local` one a path, and rewriting either to
     * an id would be writing a name into a field that holds something else.
     * `newName` is optional; given, the primary `<name>` takes it, which is
     * what `problems` compares with `project.json`.
     */
    static rename(project, newId, newName) {
        const path = Metainfo.find(project);
        if (!path || !newId) return path;

        const wanted = File.Join(project, Metainfo.fileName(newId));
        if (wanted !== path && File.Exists(wanted))
            throw new Error(`${File.Name(wanted)} already exists, so ` +
                            `${File.Name(path)} was not moved over it`);

        const doc  = File.LoadXml(path);
        const root = doc.Root;

        const id = root.Find("id");
        if (id) id.Text = newId;

        const launch = root.Find("launchable");
        if (launch) launch.Text = `${newId}.desktop`;

        for (const icon of root.FindAll("icon")) {
            const type = icon.Attr("type");
            if (type === null || type === "" || type === "stock") icon.Text = newId;
        }

        if (newName !== undefined && newName !== null)
            for (const el of root.FindAll("name"))
                if (el.AttrNS(Metainfo.XMLNS, "lang") === null) { el.Text = newName; break; }

        File.SaveXml(wanted, doc);
        if (wanted !== path) File.Delete(path);
        return wanted;
    }

    static save(path, doc) { File.SaveXml(path, doc); }

    /* --- small pieces of the document ------------------------------------- */

    static textOf(root, name) {
        const el = root.Find(name);
        return el ? el.Text : "";
    }

    /* Sets the element's text, or creates it. An empty value keeps the element
     * -- the form is what decides whether empty is allowed. */
    static setTextOf(root, name, text) {
        const el = Metainfo.ensure(root, name);
        el.Text = text || "";
        return el;
    }

    /* The first child by that name, created at the end when there is none. */
    static ensure(root, name) {
        return root.Find(name) || root.Add(name);
    }

    /*
     * The primary paragraphs, replaced; the translated ones are left alone.
     * They are `<p xml:lang="es">`, and an editor that removed every `<p>`
     * would take them with it.
     */
    static setDescription(root, text) {
        const desc = Metainfo.ensure(root, "description");

        for (const p of desc.FindAll("p"))
            if (p.AttrNS(Metainfo.XMLNS, "lang") === null)
                p.Remove();

        const paragraphs = (text || "").split(/\n\s*\n/).map((p) => p.trim())
                                                      .filter((p) => p !== "");
        if (!paragraphs.length) paragraphs.push("");

        /* Inserted at the front, so the primary text stays where a reader
         * expects it and the translations keep their order after it. */
        paragraphs.forEach((p, i) => {
            const made = Xml.Element("p");
            made.Text = p;
            desc.Insert(i, made);
        });
    }

    static setCategories(root, text) {
        const cats  = Metainfo.ensure(root, "categories");
        const names = (text || "").split(",").map((c) => c.trim())
                                             .filter((c) => c !== "");

        for (const c of cats.FindAll("category"))
            c.Remove();
        for (const name of names.length ? names : ["Utility"])
            cats.Add("category").Text = name;
    }

    static setDeveloper(root, id, name) {
        const dev = root.Find("developer");

        if (!name && !id) {
            if (dev) dev.Remove();
            return;
        }
        const made = dev || root.Add("developer");
        if (id) made.SetAttr("id", id);
        Metainfo.setTextOf(made, "name", name);
    }

    static setUrl(root, kind, value) {
        for (const u of root.FindAll("url"))
            if (u.Attr("type") === kind) {
                if (!value) { u.Remove(); return; }
                u.Text = value;
                return;
            }
        if (!value) return;

        const made = root.Add("url");
        made.SetAttr("type", kind);
        made.Text = value;
    }

    /* Whether the project ships a drawing of its own, which is what makes an
     * `<icon>` honest: a theme name cannot travel in a package.  The same
     * answer `Package` packages by, so the two cannot disagree about which
     * file in `icons/` is the application's. */
    static shipsIcon(project, id) {
        return Package.iconOf(project, id).Path !== null;
    }
};
