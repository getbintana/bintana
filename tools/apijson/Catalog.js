/*
 * `api.json`: the runtime's public surface as data.
 *
 * **This is the one artifact the documentation repositories read.** A page of
 * `docs/reference` is verified against it, a library's page and an event's
 * arity with it, and the guide under `bintana-llm` gets its tables from it --
 * without any of them needing the C, the parser, or the runtime running. The
 * descriptions in it are the ones written beside each member in the code,
 * collected by the public verbs: `Widget.Members` as `Doc`, `Widget.EventDoc`
 * for an event.
 *
 * **It is generated and never edited**, and `tests/api.sh` fails when the file
 * is not what this would write, so a member whose description moved cannot
 * leave the manifest behind. `tools/apijson.sh` writes it; the same function
 * is sourced by the check, which is why there is one builder and not two.
 *
 * Three things about the set it covers:
 *
 * - **Widgets** are `Widget.Types()`, and each carries `Members` -- **what it
 *   declares itself**, which is what a reference page is written around, since
 *   what a class inherits is documented where it is declared -- and `Parent`,
 *   the class it inherits from. A consumer that wants the whole surface
 *   follows the chain; repeating it per class made the file 2 MB of the same
 *   seventy names.
 * - **Globals** are `Application.Globals()` minus the widget classes and minus
 *   everything that has no members, which is every builtin of the language and
 *   every helper the prelude installs. `Desktop.Entries` is the one nested
 *   owner and it is declared below, because finding it would mean reading a
 *   property -- and a property may run code: `Printer.Names` enumerates
 *   printers through GTK, which a project with a `main` does not have.
 * - **Libraries** are read out of the repository's own `lib/`, through
 *   `Sources`, so the manifest does not depend on which libraries a machine
 *   happens to have installed. Their events come from the code that raises
 *   them, the comment above the `static Events` line being the description.
 */

/* The nested owners, by their full name. **Not discovered by asking**: the
 * same reason `Application.Globals()` answers names and not values -- and
 * `tests/api` holds this list to the dotted names `GLOBAL_VARS` knows. */
const NESTED_OWNERS = ["Desktop.Entries"];

/* The type comments naming a prototype no global holds -- a client, a node, a
 * connection -- which is the only way to enumerate them: no verb lists them. */
const API_NAMED_TYPE = new Regex("^\\s*/\\*\\s*type\\s+([A-Za-z_][\\w.]*)\\s*\\*/",
                                 { Multiline: true });

/*
 * The two objects a C table describes and neither a global nor a `type X`
 * name holds: a menu item and a command.  Their tables are installed on
 * objects made per item, so `Widget.Members("MenuItem")` refuses, and the
 * documentation has been writing them down by hand -- `docs/llm/forms.md`
 * documents every one of these names in prose.  The manifest carries the
 * names, so the docs check can hold that prose to the code; there are no
 * signatures and no descriptions, because there is no entry to hang one on.
 */
/*
 * **The options a machine answers and a manifest must not freeze.** Two of
 * `SourceEditor`'s properties list what the installed GtkSourceView has -- its
 * languages and its style schemes -- so the list changes with the package, and
 * with the version of it: frozen into the manifest, the file generated on one
 * machine would never equal the file generated on another, and CI would fail
 * for a reason that is nobody's mistake. `Widget.PropertyOptions` answers them
 * live, which is where they belong.
 */
const API_RUNTIME_OPTIONS = { SourceEditor: ["Language", "Theme"] };

const API_TABLE_TYPES = { menuitem_props: "MenuItem", action_props: "Action",
                          /* And the player, whose accessors are handed to each
                           * instance rather than hung on a prototype: the
                           * class answers with no members, and the table is
                           * what the page documents. */
                          audioplayer_props: "AudioPlayer" };
const API_TABLE_BODY  = new Regex(
    "static const JSCFunctionListEntry (\\w+)\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};");
const API_TABLE_ENTRY = new Regex(
    "JS_C(GETSET|FUNC)(?:_MAGIC)?_DEF\\(\\s*\"(\\w+)\"");

/* One member, in the shape everything downstream reads.  Sorted by name: the
 * runtime's order is the chain's, and a file that changes with the order of a
 * walk is a file that cannot be diffed.
 *
 * **A name with an underscore in it is a handler** -- `BtnOk_Click`,
 * `Canvas_Draw` -- and nobody's business but the class's own; the runtime's
 * own checks skip them and the documentation never wrote one down.  They are
 * in what `Widget.Members` answers for a class read out of its source, since
 * that walk filters on the capital and not on the underscore, so they are
 * dropped here rather than demanded of a page. */
function apiMemberList(members) {
    members = members.filter((m) => m.Name.indexOf("_") < 0);
    return members.map((m) => ({
        Name:      m.Name,
        Kind:      m.Kind,
        Params:    m.Params,
        Signature: m.Signature,
        Returns:   m.Returns,
        Doc:       m.Doc,
        Native:    !!m.Native,
    })).sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);
}

function apiOptions(options, own) {
    const out = {};
    if (options && options.Sources) out.Sources = options.Sources;
    if (own) out.Own = true;
    return out;
}

/* The events a class answers, each with the comment beside its declaration. */
function apiEvents(name, options) {
    const out = [];
    for (const event of Widget.EventNames(name, options))
        out.push({
            Name:      event,
            Signature: Widget.EventSignature(name, event, options) || "",
            Doc:       Widget.EventDoc(name, event, options) || "",
        });
    return out;
}

/* Everything one class of the runtime or of a library publishes: what it
 * declares itself, from where, and the events it raises. */
function apiClass(name, options, parent) {
    return {
        Name:    name,
        Parent:  parent || "",
        Members: apiMemberList(Widget.Members(name, apiOptions(options, true))),
        Events:  apiEvents(name, options),
    };
}

/* Which class each registered one inherits from.  The registration is the only
 * place those two facts are together, and `\s` crosses the lines a registration
 * wraps over. */
const API_CLASS_PARENT = new Regex(
    "BTA_CLASS(?:_\\w+)?\\s*\\(\\s*\"(\\w+)\"\\s*,\\s*(?:\"(\\w+)\"|NULL)");

function apiParents(root) {
    const out = {};
    for (const file of Directory.Files(File.Join(root, "runtime/src"), "*.c").sort())
        for (const m of API_CLASS_PARENT.Matches(File.Load(file)))
            if (!out[m.Group(1)])
                out[m.Group(1)] = m.Group(2) || "";
    return out;
}

/* The same, plus the two class-level lists a form designer reads: the exact
 * strings a property accepts, and which of them hold prose.  A widget's
 * options can be computed -- `SourceEditor` asks GtkSourceView which languages
 * it has -- so this is asked and not read.
 */
function apiWidget(name, parent) {
    const out     = apiClass(name, undefined, parent);
    const options = {};
    const runtime = API_RUNTIME_OPTIONS[name] || [];

    for (const m of Widget.Members(name))
        if (m.Kind === "Property" && !runtime.includes(m.Name)) {
            const got = Widget.PropertyOptions(name, m.Name);
            if (got && got.length) options[m.Name] = got;
        }

    /* Sorted, because `JSON.stringify` writes an object in insertion order and
     * the order the members came back in is not this file's business. */
    const sorted = {};
    for (const key of Dictionary.Keys(options).sort())
        sorted[key] = options[key];
    out.Options = sorted;
    out.Texts   = Widget.TextProperties(name);
    return out;
}

function apiWidgets(root) {
    const parent = apiParents(root);
    return Widget.Types().slice().sort()
                  .map((name) => apiWidget(name, parent[name] || ""));
}

/*
 * Every global the runtime installs that has members.
 *
 * **A name with no members is not part of the surface**: the language's own
 * builtins (`Math`, `JSON`, `Map`) and the helpers the prelude installs
 * (`defaultsFor`, `applyNode`) are names on the global object with nothing a
 * caller may write, and the scalar globals (`BTA_VERSION`) are not objects at
 * all.  What is left is what an application can call, and `tests/api` asks the
 * same question of the same list.
 */
function apiGlobals() {
    const out      = [];
    const widgets  = new Set(Widget.Types());
    const names    = Application.Globals().slice().sort();

    for (const name of names) {
        if (widgets.has(name)) continue;
        let members = [];
        try { members = Widget.Members(name); } catch (e) { continue; }
        if (!members.length) continue;
        out.push({ Name: name, Members: apiMemberList(members) });
    }
    for (const name of NESTED_OWNERS) {
        let members = [];
        try { members = Widget.Members(name); } catch (e) { continue; }
        if (members.length) out.push({ Name: name, Members: apiMemberList(members) });
    }
    return out.sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);
}

/* The prototypes no global holds, named by the `type X` comment above the
 * table that declares them. */
function apiTypes(root) {
    const names = new Set();
    for (const file of Directory.Files(File.Join(root, "runtime/src"), "*.c").sort())
        for (const m of API_NAMED_TYPE.Matches(File.Load(file)))
            names.add(m.Group(1));

    const out = [];
    for (const name of [...names].sort()) {
        let members = [];
        try { members = Widget.Members(name); } catch (e) { continue; }
        out.push({ Name: name, Members: apiMemberList(members) });
    }

    /* And the two a table describes with no name anywhere else. */
    for (const file of Directory.Files(File.Join(root, "runtime/src"), "*.c").sort()) {
        for (const t of API_TABLE_BODY.Matches(File.Load(file))) {
            const type = API_TABLE_TYPES[t.Group(1)];
            if (!type)
                continue;
            const members = [];
            for (const e of API_TABLE_ENTRY.Matches(t.Group(2)))
                members.push({ Name: e.Group(2),
                               Kind: e.Group(1) === "FUNC" ? "Method" : "Property",
                               Params: -1, Signature: "", Returns: "",
                               Doc: "", Native: true });
            out.push({ Name: type, Members: apiMemberList(members) });
        }
    }

    return out.sort((a, b) => a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);
}

/* Every library the repository ships, and what each of its classes publishes.
 * The classes are the parser's -- the same `Application.Symbols` an editor
 * asks -- and the sources are handed to the verbs, so nothing here is run. */
function apiLibraries(root) {
    const out = [];
    const dir = File.Join(root, "lib");

    if (!File.IsDir(dir))
        return out;

    for (const lib of Directory.List(dir).sort()) {
        if (!File.IsDir(File.Join(dir, lib)))
            continue;
        const texts = Directory.Files(File.Join(dir, lib), { Pattern: "*.js" })
                               .sort().map((f) => File.Load(f));
        const sources = { Sources: texts };
        const classes = [];
        const seen    = new Set();

        for (const text of texts)
            for (const s of Application.Symbols(text))
                if (s.Kind === "Class" && !seen.has(s.Name)) {
                    seen.add(s.Name);
                    classes.push(apiClass(s.Name, sources, s.Super || ""));
                }
        out.push({ Name: lib,
                   Classes: classes.sort((a, b) => a.Name < b.Name ? -1 : 1) });
    }
    return out;
}

/*
 * The manifest.  `commit` is informational: the documentation repositories pin
 * a ref (`bintana-ref.txt`), and a field that changes with every commit would
 * make the file stale in every working tree for no answer.
 */
function apiCatalog(root, commit) {
    const libraries = apiLibraries(root);
    return {
        Format:    1,
        Version:   BTA_VERSION,
        Commit:    commit || "",
        Widgets:   apiWidgets(root),
        Globals:   apiGlobals(),
        Types:     apiTypes(root),
        Libraries: libraries,
    };
}

/* The file, byte for byte: two-space indentation and one trailing newline,
 * which is what every JSON file of this tree is written with. */
function apiJson(root, commit) {
    return `${JSON.stringify(apiCatalog(root, commit), null, 2)}\n`;
}
