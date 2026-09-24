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
        root.Add("summary").Text = config.Description || "";
        root.Add("description").Add("p").Text = "";

        const launch = root.Add("launchable");
        launch.SetAttr("type", "desktop-id");
        launch.Text = `${config.Id}.desktop`;

        if (Metainfo.shipsIcon(project)) {
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
     * The file follows the id: renamed, and its `<id>`, `<launchable>` and
     * `<icon>` with it. Answers the path it is at now, or `null` when the
     * project has no metainfo to move.
     */
    static rename(project, newId) {
        const path = Metainfo.find(project);
        if (!path || !newId) return path;

        const doc  = File.LoadXml(path);
        const root = doc.Root;

        const id = root.Find("id");
        if (id) id.Text = newId;

        const launch = root.Find("launchable");
        if (launch) launch.Text = `${newId}.desktop`;

        const icon = root.Find("icon");
        if (icon) icon.Text = newId;

        const wanted = File.Join(project, Metainfo.fileName(newId));
        if (wanted === path) {
            File.SaveXml(path, doc);
            return path;
        }
        File.SaveXml(wanted, doc);
        File.Delete(path);
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
     * `<icon>` honest: a theme name cannot travel in a package. */
    static shipsIcon(project) {
        const dir = File.Join(project, "icons");
        if (!File.IsDir(dir)) return false;

        return Directory.Files(dir)
            .some((f) => ["svg", "png"].includes(File.Extension(f).toLowerCase()));
    }
};
