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

    checkRefusalsWriteNothing(root);
    checkCreateIsValid(root);
    checkOutputInside(root);
    checkIconChoice(root);
    checkRename(root);
    checkBaseVersion();
    checkNsis(root);

    report(root);
}

/* A scratch project: a manifest, a metainfo that agrees with it, and whatever
 * drawings are named. */
function scratch(root, name, drawings) {
    const dir = File.Join(root, name);
    const id  = `io.github.getbintana.${name}`;
    Directory.Make(File.Join(dir, "icons"));
    File.SaveJson(File.Join(dir, "project.json"), { name, id, main: "Main" });
    File.Save(File.Join(dir, "Main.js"), "\"use strict\";\nfunction Main() {}\n");
    for (const d of drawings || []) {
        if (typeof d === "string")
            File.Save(File.Join(dir, "icons", d),
                      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"16\" height=\"16\"></svg>\n");
        else
            File.SaveBytes(File.Join(dir, "icons", d.name), png(d.w, d.h));
    }
    Metainfo.create(dir, { Id: id, Name: name, Description: "A scratch project." });
    return { dir, id };
}

/* The first 33 bytes of a PNG -- the signature and the IHDR chunk -- which is
 * all the packaging step reads of one. */
function png(w, h) {
    const be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return new Bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]
                         .concat(be(w), be(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]));
}

/* A refusal leaves nothing behind: the no-icon check used to come after the
 * metainfo and the entry were already written into the output. */
function checkRefusalsWriteNothing(root) {
    const p   = scratch(root, "Bare", []);
    const out = File.Join(root, "out-bare");
    throws("a project with no drawing is refused",
           () => Package.Write(p.dir, out), "no icon");
    check("and the refusal wrote nothing", !File.IsDir(out),
          File.IsDir(out) ? Directory.List(out).join(", ") : "");
}

/* What `create` writes is what AppStream's validator accepts, and `problems`
 * refuses what it would not. */
function checkCreateIsValid(root) {
    const p = scratch(root, "Made", ["app.svg"]);
    Directory.DeleteTree(p.dir);
    Directory.Make(p.dir);
    const path = Metainfo.create(p.dir, { Id: p.id, Name: "Made",
                                          Description: "The first line.\nAnd a second." });
    const doc  = File.LoadXml(path);
    const info = Metainfo.read(doc);

    eq("a summary is the description's first line, without its full stop",
       info.Summary, "The first line");
    check("and has text in its description", info.Description.trim() !== "",
          JSON.stringify(info.Description));
    eq("so problems has nothing to say about a fresh file",
       Metainfo.problems(doc, path, { Id: p.id, Name: "Made" }).join("; "), "");

    const bare = Metainfo.read(File.LoadXml(
        Metainfo.create(File.Join(root, "Made"), { Id: `${p.id}2`, Name: "Made" })));
    check("a project with no description still gets a summary and a paragraph",
          bare.Summary !== "" && bare.Description !== "", JSON.stringify(bare));

    if (Application.HasCommand("appstreamcli")) {
        const r = Exec.Wait(["appstreamcli", "validate", "--no-net", "--no-color", path],
                            { Timeout: 30000, Stderr: "separate" });
        const errors = (r.Output + r.Errors).split("\n").filter((l) => /^E:/.test(l));
        eq("and appstreamcli validate reports no error in it", errors.join("\n"), "");
    } else {
        print("no appstreamcli: the created metainfo is unvalidated");
    }

    const cfg = { Id: p.id, Name: "Made" };
    const broken = (edit) => { const d = File.LoadXml(path); edit(d.Root); return d; };
    check("an empty summary is a problem",
          Metainfo.problems(broken((r) => { r.Find("summary").Text = ""; }), path, cfg)
              .some((x) => x.includes("<summary> is empty")));
    check("so is one with a line break",
          Metainfo.problems(broken((r) => { r.Find("summary").Text = "a\nb"; }), path, cfg)
              .some((x) => x.includes("line break")));
    check("and a description with no text",
          Metainfo.problems(broken((r) => {
              for (const q of r.Find("description").FindAll("p")) q.Text = "";
          }), path, cfg).some((x) => x.includes("<description> has no text")));
}

/* An output directory inside the project is left out of the copy -- it used
 * to copy itself into itself without end -- and one deeper inside an entry is
 * refused before anything is written. */
function checkOutputInside(root) {
    const p   = scratch(root, "Inner", ["app.svg"]);
    const out = File.Join(p.dir, "dist");
    let written = null;
    try { written = Package.Write(p.dir, out); } catch (e) { check("an output inside the project is written", false, e.message); }
    if (written) {
        check("an output inside the project is not copied into itself",
              !File.Exists(File.Join(written.Project, "dist")),
              Directory.List(written.Project).join(", "));
        const cmds = File.LoadJson(written.Manifest).modules[0]["build-commands"].join("\n");
        check("nor named in the build commands", !cmds.includes("'dist'"), cmds);
    }

    const deep = File.Join(p.dir, "icons", "out");
    throws("an output deeper inside one of its folders is refused",
           () => Package.Write(p.dir, deep), "inside the project");
    check("before anything is written", !File.IsDir(deep));
    throws("and so is the project itself as the output",
           () => Package.Write(p.dir, p.dir), "holds the project");
}

/* Which drawing is the application's: the one named after the id, else the
 * only one that is not a control's glyph -- and a PNG goes where its size says. */
function checkIconChoice(root) {
    const named = scratch(root, "Named", ["aaa-symbolic.svg", "zz.svg"]);
    File.Save(File.Join(named.dir, "icons", `${named.id}.svg`), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
    eq("the drawing named after the id is the icon",
       File.Name(Package.iconOf(named.dir, named.id).Path || ""), `${named.id}.svg`);

    const one = scratch(root, "One", ["aaa-symbolic.svg", "app.svg"]);
    eq("one drawing beside the glyphs is unambiguous, and the glyph is not it",
       File.Name(Package.iconOf(one.dir, one.id).Path || ""), "app.svg");

    const two = scratch(root, "Two", ["a.svg", "b.svg"]);
    throws("two drawings and none named after the id is refused",
           () => Package.Write(two.dir, File.Join(root, "out-two")), `${two.id}.svg`);

    const big = scratch(root, "Big", [{ name: "app.png", w: 256, h: 256 }]);
    const w   = Package.Write(big.dir, File.Join(root, "out-big"));
    const cmds = File.LoadJson(w.Manifest).modules[0]["build-commands"].join("\n");
    check("a 256 pixel PNG is installed as 256x256", cmds.includes("hicolor/256x256/apps/"), cmds);

    const wide = scratch(root, "Wide", [{ name: "app.png", w: 128, h: 64 }]);
    throws("a PNG that is not square is refused",
           () => Package.Write(wide.dir, File.Join(root, "out-wide")), "square");
    const tiny = scratch(root, "Tiny", [{ name: "app.png", w: 32, h: 32 }]);
    throws("and one too small for AppStream",
           () => Package.Write(tiny.dir, File.Join(root, "out-tiny")), "32x32");
}

/* The file follows the identity: the stock icon and the primary name with it,
 * anything else left alone, and nobody's file overwritten. */
function checkRename(root) {
    const p   = scratch(root, "Moving", ["app.svg"]);
    const doc = File.LoadXml(Metainfo.find(p.dir));
    const remote = doc.Root.Add("icon");
    remote.SetAttr("type", "remote");
    remote.Text = "https://example.org/icon.png";
    const es = doc.Root.Add("name");
    es.SetAttrNS(Metainfo.XMLNS, "lang", "es");
    es.Text = "Moviendo";
    File.SaveXml(Metainfo.find(p.dir), doc);

    const moved = Metainfo.rename(p.dir, "io.github.getbintana.Moved", "Moved");
    eq("renaming moves the file", File.Name(moved), "io.github.getbintana.Moved.metainfo.xml");
    const after = File.LoadXml(moved).Root;
    const icons = after.FindAll("icon");
    eq("the stock icon follows the id",
       icons.filter((i) => i.Attr("type") === "stock").map((i) => i.Text).join(),
       "io.github.getbintana.Moved");
    eq("a remote one is left alone",
       icons.filter((i) => i.Attr("type") === "remote").map((i) => i.Text).join(),
       "https://example.org/icon.png");
    eq("the primary name follows", Metainfo.read(File.LoadXml(moved)).Name, "Moved");
    eq("and a translated one is left alone",
       after.FindAll("name").filter((n) => n.AttrNS(Metainfo.XMLNS, "lang") === "es")
            .map((n) => n.Text).join(), "Moviendo");

    File.Save(File.Join(p.dir, "io.github.getbintana.Taken.metainfo.xml"), "<component/>\n");
    throws("a file already at the new name is refused",
           () => Metainfo.rename(p.dir, "io.github.getbintana.Taken"), "already exists");
    check("and the one being moved is still there", File.Exists(moved));
}

/* The BaseApp's branch is written by hand in the manifests and the manual,
 * and `Package` derives it from `BTA_VERSION`: the two have to agree, or a
 * package asks for a base nobody built. */
function checkBaseVersion() {
    const tree = File.Join(Application.Directory, "..", "..");
    const want = Package.defaults.BaseVersion;
    const seen = [];

    const grab = (rel, re) => {
        const path = File.Join(tree, rel);
        if (!File.Exists(path)) { seen.push(`${rel}: missing`); return; }
        const found = new Regex(re, { Multiline: true }).Matches(File.Load(path)).map((m) => m.Group(1));
        if (!found.length) seen.push(`${rel}: no version found`);
        for (const v of found) if (v !== want) seen.push(`${rel}: ${v}`);
    };

    grab("flatpak/io.github.getbintana.BaseApp.yml", "^branch: *'?([0-9.]+)'?");
    for (const f of Directory.Files(File.Join(tree, "flatpak"), "*.yml"))
        if (!f.endsWith("BaseApp.yml"))
            grab(`flatpak/${File.Name(f)}`, "^base-version: *'?([0-9.]+)'?");
    grab("docs/installing.md", "BaseApp//([0-9.]+)");

    eq(`the hand-written BaseApp versions are the runtime's ${want}`, seen.join("; "), "");
}

/* `Nsis`: the script out of the metainfo, the payload out of a tree, and the
 * refusals before either is written. Compiling is Windows -- `Build` says so
 * anywhere else -- so what is tried here is everything up to it. */
function checkNsis(root) {
    const dir = File.Join(root, "Setup");
    const id  = "io.github.getbintana.Setup";
    Directory.Make(File.Join(dir, "icons"));
    File.SaveJson(File.Join(dir, "project.json"),
                  { name: "Setup", id, version: "2.1", main: "Main" });
    File.Save(File.Join(dir, "Main.js"), "\"use strict\";\nfunction Main() {}\n");
    File.SaveBytes(File.Join(dir, "icons", `${id}.png`), png(256, 256));

    Metainfo.create(dir, { Id: id, Name: "Setup",
                           Description: "Sets things up.\n\nA second paragraph." });
    const doc = File.LoadXml(Metainfo.find(dir));
    Metainfo.write(doc, {
        Summary:         "Sets things up",
        Description:     "First $pecial paragraph.\n\nA \"quoted\" second.",
        DeveloperId:     "io.github.getbintana",
        DeveloperName:   "Bintana",
        MetadataLicense: "MIT",
        ProjectLicense:  "MIT",
        Homepage:        "https://example.org/setup",
        Bugtracker:      "",
        Categories:      "Utility",
    }, { Id: id, Name: "Setup" });
    File.SaveXml(Metainfo.find(dir), doc);

    const out = File.Join(root, "out-nsis");
    const ctx = Nsis.Script(dir, out);

    eq("the installer command is the id's last element", ctx.Command, "bintana-setup");
    eq("the payload is beside the script", ctx.Payload, File.Join(out, "payload"));
    check("with no note when the icon is a PNG", ctx.Note === "", ctx.Note);

    const nsi = File.Load(ctx.Script);
    check("the script names the application", nsi.includes(`Name "Setup"`), nsi);
    check("installed per-user, with no elevation",
          nsi.includes("RequestExecutionLevel user") &&
          nsi.includes(`InstallDir "$LOCALAPPDATA\\Programs\\bintana-setup"`), nsi);
    check("registered for uninstall under the id",
          nsi.includes("CurrentVersion\\Uninstall\\io.github.getbintana.Setup"), nsi);
    check("described by the metainfo",
          nsi.includes(`VIAddVersionKey "FileDescription" "Sets things up"`) &&
          nsi.includes(`WriteRegStr HKCU`) &&
          nsi.includes(`"Publisher" "Bintana"`) &&
          nsi.includes(`"URLInfoAbout" "https://example.org/setup"`), nsi);
    eq("with the version's numeric head as the version resource",
       new Regex(`^VIProductVersion "(.*)"`, { Multiline: true }).Matches(nsi)
           .map((m) => m.Group(1)).join(), "2.1.0.0");
    check("welcoming with the description",
          nsi.includes("MUI_WELCOMEPAGE_TEXT"), nsi);
    check("with the prose escaped for NSIS",
          nsi.includes("First $$pecial paragraph.") &&
          nsi.includes(`A $\\"quoted$\\" second.`), nsi);
    check("installing the payload beside the script",
          nsi.includes(`File /r "payload\\*"`), nsi);
    check("wearing the wrapped icon",
          nsi.includes(`Icon "io.github.getbintana.Setup.ico"`), nsi);
    eq("named after the command and the version by default",
       new Regex(`^!define OUTFILE "(.*)"`, { Multiline: true }).Matches(nsi)
           .map((m) => m.Group(1)).join(),
       "bintana-setup-2.1-windows-x86_64.exe");

    check("the icon travels beside the script", File.Exists(ctx.Icon), ctx.Icon || "");
    const ico = File.LoadBytes(ctx.Icon);
    eq("as an ICO holding the PNG",
       ico.Slice(0, 6).ToHex(), "000001000100");
    eq("a 256-pixel side spelled the format's way",
       ico.At(6) * 256 + ico.At(7), 0);
    eq("directory, one entry and the file's own bytes",
       ico.Length, 6 + 16 + png(256, 256).Length);

    /* An svg-only project keeps NSIS's own icon, and is told which file would
     * change that. */
    const svg = scratch(root, "SvgSetup", ["app.svg"]);
    const sctx = Nsis.Script(svg.dir, File.Join(root, "out-nsis-svg"));
    eq("with no PNG there is no .ico", sctx.Icon, null);
    check("and the script claims none",
          !new Regex("^Icon ", { Multiline: true }).IsMatch(File.Load(sctx.Script)));
    check("but names the file that would change it",
          sctx.Note.includes(`${svg.id}.png`), sctx.Note);

    /* --- what it refuses -------------------------------------------------- */
    const nometa = File.Join(root, "nsis-nometa");
    Directory.Make(nometa);
    File.SaveJson(File.Join(nometa, "project.json"),
                  { name: "NoMeta", id: "io.github.getbintana.NoMeta", main: "Main" });
    throws("a project with no metainfo is refused",
           () => Nsis.Script(nometa, File.Join(root, "out-nsis-nometa")),
           "metainfo.xml");

    const drifted = File.Join(root, "nsis-drifted");
    Directory.Make(drifted);
    File.SaveJson(File.Join(drifted, "project.json"),
                  { name: "Drifted", id: "io.github.getbintana.Drifted", main: "Main" });
    Metainfo.create(drifted, { Id: "io.github.getbintana.Drifted", Name: "Drifted",
                               Description: "Drifted." });
    const ddoc = File.LoadXml(Metainfo.find(drifted));
    ddoc.Root.Find("name").Text = "Something Else";
    File.SaveXml(Metainfo.find(drifted), ddoc);
    throws("a metainfo that disagrees with project.json is refused",
           () => Nsis.Script(drifted, File.Join(root, "out-nsis-drifted")),
           "does not agree");

    const two = scratch(root, "TwoSetup", ["a.svg", "b.svg"]);
    throws("two drawings and none named after the id is refused",
           () => Nsis.Script(two.dir, File.Join(root, "out-nsis-two")),
           "none is named");

    /* --- the payload, out of a pointed-at tree ------------------------------ */
    const prefix = File.Join(root, "prefix");
    const put = (rel, text) => {
        Directory.Make(File.Directory(File.Join(prefix, rel)));
        File.Save(File.Join(prefix, rel), text);
    };
    put(File.Join("bin", "bintana.exe"), "MZ");
    put(File.Join("bin", "libgtk-4.dll"), "DLL");
    put(File.Join("bin", "bintana-ide.cmd"), "the IDE's launcher");
    put(File.Join("share", "glib-2.0", "schemas", "x.schema"), "schemas");
    put(File.Join("share", "bintana", "lib", "x.js"), "a shipped library");
    put(File.Join("share", "bintana", "ide", "Main.js"), "the IDE");
    put(File.Join("etc", "gtk-4.0", "settings.ini"), "font");

    const staged = Nsis.Stage(dir, File.Join(root, "out-stage"), { Prefix: prefix });
    check("the executable travels",
          File.Exists(File.Join(staged, "bin", "bintana.exe")));
    check("and its DLLs",
          File.Exists(File.Join(staged, "bin", "libgtk-4.dll")));
    check("but not the IDE's launcher",
          !File.Exists(File.Join(staged, "bin", "bintana-ide.cmd")));
    check("with the data GTK opens by name",
          File.Exists(File.Join(staged, "share", "glib-2.0", "schemas", "x.schema")) &&
          File.Exists(File.Join(staged, "etc", "gtk-4.0", "settings.ini")));
    check("and the shipped libraries the project's uses resolve from",
          File.Exists(File.Join(staged, "share", "bintana", "lib", "x.js")));
    check("without the IDE beside them",
          !File.IsDir(File.Join(staged, "share", "bintana", "ide")));
    check("the project travels as the application",
          File.Exists(File.Join(staged, "share", "bintana", "apps",
                                "bintana-setup", "Main.js")));
    const launcher = File.Load(File.Join(staged, "bin", "bintana-setup.cmd"));
    check("with a launcher that runs the runtime on it",
          launcher.includes("bintana.exe") &&
          launcher.includes("share\\bintana\\apps\\bintana-setup"), launcher);

    throws("a prefix with no staged executable is refused",
           () => Nsis.Stage(dir, File.Join(root, "out-stage-bare"),
                            { Prefix: File.Join(root, "nsis-nometa") }),
           "no bin/bintana.exe");
    throws("the project itself as the output is refused",
           () => Nsis.Stage(dir, dir), "holds the project");

    /* Compiling is Windows: anywhere else the refusal names where it happens,
     * and on Windows the payload is verified before any compiler is asked. */
    if (Environment.OS === "Windows")
        throws("an unstaged script is refused before any compiler",
               () => Nsis.Build(ctx.Script, File.Join(root, "setup.exe")), "Stage");
    else
        throws("compiling anywhere else is refused",
               () => Nsis.Build(ctx.Script, File.Join(root, "setup.exe")), "Windows");
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
