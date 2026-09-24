/*
 * `lib/package`, tried the way the packaging step uses it.
 *
 *   ./tests/pack.sh
 *
 * It builds a scratch project -- a manifest, a metainfo with a translation, an
 * icon, a source and a `.git` that must not travel -- packages it, and reads
 * every file back: the manifest as JSON, the entry as the desktop format, the
 * metainfo and the icon where the manifest says they are.
 *
 * **No display and no flatpak.**  What is under test is the output; the program
 * that consumes it is `flatpak-builder`, and `tests/install.sh` is the shape a
 * consumer test takes.  A console project, so this needs nothing but the
 * runtime.
 */
"use strict";

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
    } else {
        failures.push(detail ? `${name}: ${detail}` : name);
    }
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function throws(name, fn, includes) {
    let said = "";
    try { fn(); } catch (e) { said = e.message; }

    check(name, said !== "" && (!includes || said.includes(includes)),
          said || "did not throw");
}

function Main() {
    const root = File.Join(Environment.TempDirectory, `bta-pack-${Environment.ProcessId}`);
    if (File.IsDir(root)) Directory.DeleteTree(root);

    const project = File.Join(root, "Notes");
    Directory.Make(File.Join(project, "icons"));
    Directory.Make(File.Join(project, ".git"));
    File.Save(File.Join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
    File.Save(File.Join(project, "app.css"), "/* notes */\n");
    File.Save(File.Join(project, "Main.js"), "\"use strict\";\nfunction Main() {}\n");
    File.Save(File.Join(project, "icons", "notes.svg"),
              "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"></svg>\n");

    const config = { id: "io.github.getbintana.Notes", name: "Notes", version: "2.1" };
    File.SaveJson(File.Join(project, "project.json"), config);

    /* The shape the library speaks, out of the file's spelling -- the same call
     * the packaging step makes. */
    const shape = Package.configOf(project);
    eq("the manifest's id is read", shape.Id, "io.github.getbintana.Notes");

    Metainfo.create(project, shape);

    const metaPath = Metainfo.find(project);
    check("the metainfo is named after the id",
          metaPath !== null &&
          File.Name(metaPath) === "io.github.getbintana.Notes.metainfo.xml", metaPath);

    /* Filled in, including a translation -- which is what the entry carries
     * over as `Name[es]`. */
    const doc = File.LoadXml(metaPath);
    Metainfo.write(doc, {
        Summary:         "Notes, kept simply",
        Description:     "One paragraph.",
        DeveloperId:     "io.github.getbintana",
        DeveloperName:   "Bintana",
        MetadataLicense: "MIT",
        ProjectLicense:  "MIT",
        Homepage:        "https://example.org/notes",
        Bugtracker:      "",
        Categories:      "Utility",
    }, shape);

    const nameEs = doc.Root.Add("name");
    nameEs.SetAttrNS(Metainfo.XMLNS, "lang", "es");
    nameEs.Text = "Notas";
    File.SaveXml(metaPath, doc);

    /* --- the four files and the manifest ----------------------------------- */
    const out     = File.Join(root, "out");
    const written = Package.Write(project, out);

    eq("the command is the id's last element", written.Command, "bintana-notes");

    const manifest = File.LoadJson(written.Manifest);
    eq("the manifest is the application's", manifest.id, "io.github.getbintana.Notes");
    eq("built on the shared base", manifest.base, "io.github.getbintana.BaseApp");
    eq("at the runtime's own release", manifest["base-version"],
       BTA_VERSION.split(".").slice(0, 2).join("."));
    eq("running one command", manifest.command, "bintana-notes");
    check("with sandbox permissions of its own",
          Array.isArray(manifest["finish-args"]) && manifest["finish-args"].length > 0,
          JSON.stringify(manifest["finish-args"]));
    eq("and one module", manifest.modules.length, 1);
    check("whose sources are all beside the manifest",
          manifest.modules[0].sources.every((s) => s.type !== "archive"),
          JSON.stringify(manifest.modules[0].sources));
    check("including the project copy",
          manifest.modules[0].sources.some((s) => s.path === "project"));
    check("and a script that is the command",
          manifest.modules[0].sources.some((s) => s.type === "script" &&
                                              s["dest-filename"] === "bintana-notes"));
    check("the metainfo goes where AppStream looks for it",
          manifest.modules[0]["build-commands"].some((c) => c.includes("/app/share/metainfo/")),
          JSON.stringify(manifest.modules[0]["build-commands"]));

    const desk = File.Load(written.Desktop);
    check("the entry names the application", desk.includes("Name=Notes"), desk);
    check("with the translated name the metainfo carries",
          desk.includes("Name[es]=Notas"), desk);
    check("and the class the window really has",
          desk.includes("StartupWMClass=io.github.getbintana.Notes"), desk);
    /* The command is bare -- it needs no quoting, and a quoted first word
     * makes `flatpak build-export` look for a binary whose name has the quotes
     * in it -- and the field code is appended, because `Exec` would double its
     * `%` as a literal. */
    check("running the command, with a field code and not through Exec",
          desk.includes("Exec=bintana-notes %f"), desk);

    if (Application.HasCommand("desktop-file-validate")) {
        const r = Exec.Wait(["desktop-file-validate", written.Desktop],
                            { Timeout: 20000, Stderr: "separate" });
        eq("and the specification's own checker accepts the entry", r.ExitCode, 0,
           r.Output + r.Errors);
    } else {
        print("no desktop-file-validate: the entry is written but unvalidated");
    }

    check("the metainfo travels", File.Exists(written.Metainfo));
    check("the icon travels", File.Exists(written.Icon));
    check("the project travels", File.Exists(File.Join(written.Project, "Main.js")));
    check("with its own files", File.Exists(File.Join(written.Project, "app.css")));
    check("and not its history",
          !File.Exists(File.Join(written.Project, ".git", "HEAD")));

    /* --- what it refuses ---------------------------------------------------- */

    /* No id: there is nothing to install under and no name for the metainfo. */
    const noid = File.Join(root, "noid");
    Directory.Make(noid);
    File.SaveJson(File.Join(noid, "project.json"), { name: "NoId", main: "Main" });
    throws("a project with no id is refused",
           () => Package.Write(noid, File.Join(root, "out-noid")), "no id");

    /* No metainfo: a package without one is a package nothing can describe. */
    const nometa = File.Join(root, "nometa");
    Directory.Make(nometa);
    File.SaveJson(File.Join(nometa, "project.json"),
                  { name: "NoMeta", id: "io.github.getbintana.NoMeta", main: "Main" });
    throws("a project with no metainfo is refused",
           () => Package.Write(nometa, File.Join(root, "out-nometa")),
           "metainfo.xml");

    /* No icon: AppStream will not compose an application without one, and the
     * failure arrives from `appstreamcli` half a build later, naming a file
     * nobody wrote. */
    const noicon = File.Join(root, "noicon");
    Directory.Make(noicon);
    File.SaveJson(File.Join(noicon, "project.json"),
                  { name: "NoIcon", id: "io.github.getbintana.NoIcon", main: "Main" });
    Metainfo.create(noicon, { Id: "io.github.getbintana.NoIcon", Name: "NoIcon" });
    throws("a project with no icon is refused",
           () => Package.Write(noicon, File.Join(root, "out-noicon")), "no icon");

    /* A metainfo that disagrees with the manifest: the one failure a package
     * must not be built over, because it installs under one name and claims
     * another. */
    const drifted = File.Join(root, "drifted");
    Directory.Make(drifted);
    File.SaveJson(File.Join(drifted, "project.json"),
                  { name: "Drifted", id: "io.github.getbintana.Drifted", main: "Main" });
    Metainfo.create(drifted, { Id: "io.github.getbintana.Drifted", Name: "Drifted" });
    const ddoc = File.LoadXml(Metainfo.find(drifted));
    ddoc.Root.Find("name").Text = "Something Else";
    File.SaveXml(Metainfo.find(drifted), ddoc);
    throws("a metainfo that disagrees with project.json is refused",
           () => Package.Write(drifted, File.Join(root, "out-drifted")),
           "does not agree");

    eq("and the command name is derived from the last element",
       Package.commandName("org.example.My App"), "bintana-my-app");

    report(root);
}

function report(root) {
    print("");
    print(`${passed} passed, ${failures.length} failed`);
    for (const f of failures) print(`  FAIL ${f}`);

    if (failures.length) {
        print(`\nthe scratch project is still at ${root}`);
    } else {
        Directory.DeleteTree(root);
    }

    Application.Quit(failures.length ? 1 : 0);
}
