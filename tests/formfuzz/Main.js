/*
 * Mutation fuzzing for the `.form` loader.
 *
 * A console project, so it needs no display and can be driven by
 * `tests/formfuzz.sh`. Every case writes a complete project -- `project.json`,
 * a form class that prints `OPEN` and quits, and the mutated `.form` -- and
 * runs the runtime on it as a child, because the loader runs at startup and a
 * crash there is what the fuzzing is for.
 *
 * **One defect per case, and every case is reachable by its number.** The
 * mutator is chosen by `case % MUTATORS.length` and the node by a small
 * deterministic generator seeded with the case, so a failure prints the case
 * that reproduces it and nothing depends on wall-clock time. The seed form is
 * the one every example has: a few containers, a list and a label, with the
 * properties the format documents.
 *
 * What counts as a good answer:
 *
 * - the child loaded the form and printed `OPEN` (`ExitCode` 0);
 * - or it refused with a `Bintana error:` sentence (`ExitCode` 1);
 * - or it was cut off, printed a sanitizer report, or died without either --
 *   which is the failure this exists to find, printed with the form that did
 *   it.
 *
 * A timeout is a failure too: the loader hung, and a hang is worse than a
 * sentence. `Form_Open` throwing is *not* a loader failure -- `tests/widgets`
 * documents that an uncaught throw in a test form hangs by design -- so the
 * template form has no throwing code of its own.
 */
"use strict";

const CASES_DEFAULT = 40;
const MAX_FAILURES   = 5;
const TIMEOUT        = 30000;

/* A 32-bit xorshift, so a case number is the whole seed. `Random` reads the
 * operating system, which is right for a token and wrong for a reproduction. */
class Rng {
    constructor(seed) {
        this.s = (seed * 2654435761) | 0;
        if (this.s === 0) this.s = 1;
    }
    next() {
        let x = this.s;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.s = x | 0;
        return (x >>> 0) / 4294967296;
    }
    int(n) { return Math.floor(this.next() * n) % n; }
    pick(list) { return list[this.int(list.length)]; }
}

function nodesOf(root) {
    const out = [];
    const walk = (n) => {
        if (!n || typeof n !== "object" || Array.isArray(n)) return;
        out.push(n);
        if (Array.isArray(n.children))
            for (const c of n.children) walk(c);
    };
    walk(root);
    return out;
}

function pickNode(rng, doc) {
    const nodes = nodesOf(doc);
    return nodes.length ? nodes[rng.int(nodes.length)] : null;
}

/*
 * The seed. Every property here is one the format documents; the mutations
 * below break one of them at a time.
 */
function seed() {
    return {
        format: "bintana-form/1",
        class: "F",
        properties: { Width: 300, Height: 200 },
        children: [
            { type: "Panel", name: "P",
              properties: { X: 0, Y: 0, Width: 300, Height: 200 },
              children: [
                  { type: "Button", name: "B",
                    properties: { Text: "ok", X: 10, Y: 10 } },
              ] },
            { type: "ListBox", name: "L",
              properties: { Items: ["a", "b"], Index: 1 } },
            { type: "Label", name: "Lbl", properties: { Text: "hi" } },
        ],
    };
}

const VALUES = ["x", null, true, 1e100];

/*
 * One mutation per case. `bag.doc` may be replaced, and `bag.raw` is written
 * as the file when a case is not JSON at all.
 */
const MUTATORS = [
    function root(rng, bag) {
        bag.doc = rng.pick([null, 42, "x", [], true]);
        return "root is not an object";
    },
    function childrenShape(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.children = rng.pick([null, 42, "x", {},
                               [null], [42], ["x"], [[]], [{ name: "NoType" }]]);
        return "children shape";
    },
    function propertiesShape(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.properties = rng.pick([null, 42, "x", [], [1]]);
        return "properties shape";
    },
    function typeShape(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.type = rng.pick([null, 42, "", "NoSuchWidget"]);
        return "type shape";
    },
    function nameShape(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.name = rng.pick(["", "a b", 42, "Actions", "Menus", "Close"]);
        return "name shape";
    },
    function menusShape(rng, bag) {
        bag.doc.menus = rng.pick([42, {}, [null], [42],
                                  [{ name: 1 }], [{ text: "x" }]]);
        return "menus shape";
    },
    function actionsShape(rng, bag) {
        bag.doc.actions = rng.pick([42, {}, [null], [42],
                                    [{ name: 1 }], [{ text: "x" }]]);
        return "actions shape";
    },
    function menuChildren(rng, bag) {
        bag.doc.menus = [{ name: "M", text: "x",
                           children: rng.pick([42, {}, "x", null]) }];
        return "menu children";
    },
    function menuName(rng, bag) {
        bag.doc.menus = [{ name: rng.pick(["a b", "Peón", "", 42]), text: "x" }];
        return "menu item name";
    },
    function actionName(rng, bag) {
        bag.doc.actions = [{ name: rng.pick(["a b", "Peón", "", 42]), text: "x" }];
        return "command name";
    },
    function propertyValue(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.properties = n.properties || {};
        n.properties.X = rng.pick(VALUES);
        return "X value";
    },
    function textValue(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.properties = n.properties || {};
        n.properties.Text = rng.pick([{}, [], 42, null]);
        return "Text value";
    },
    function extraChild(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        const kids = Array.isArray(n.children) ? n.children : [];
        kids.push(rng.pick([null, 42, [],
                            { type: "NoSuchWidget", name: "Z" },
                            { type: "Button" }]));
        n.children = kids;
        return "extra child";
    },
    function strip(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.strip = rng.pick(["Start", "End", "Middle", 42]);
        return "strip";
    },
    function proto(rng, bag) {
        const n = pickNode(rng, bag.doc);
        if (!n) return "no node";
        n.properties = { "__proto__": { Evil: 1 } };
        return "proto";
    },
    function selfContained(rng, bag) {
        bag.doc = { format: "bintana-form/1", class: "F",
                    children: [{ type: "F", name: "Inner" }] };
        return "self-contained form";
    },
    function tooDeep(rng, bag) {
        let node = { type: "Panel" };
        for (let i = 0; i < 129; i++)
            node = { type: "Panel", children: [node] };
        bag.doc = { format: "bintana-form/1", class: "F", children: [node] };
        return "too deep";
    },
    function headerFields(rng, bag) {
        bag.doc.format = rng.pick([42, "bintana-form/2", null]);
        bag.doc.class  = rng.pick([42, [], null]);
        return "header fields";
    },
    function truncated(rng, bag) {
        const text = JSON.stringify(bag.doc);
        bag.raw = text.slice(0, rng.int(text.length));
        return "truncated JSON";
    },
    function hugeArray(rng, bag) {
        const kids = [];
        for (let i = 0; i < 5000; i++) kids.push({ type: "Button" });
        bag.doc.children = kids;
        return "a very wide form";
    },
];

function write(text, path) {
    File.Save(path, text);
}

function main() {
    const args  = Application.Arguments;
    const cases = Math.max(1, Number(args[0]) || CASES_DEFAULT);
    const dir   = File.Join(Environment.TempDirectory,
                            `bta-formfuzz-${Environment.ProcessId}`);
    let   failures = 0;

    if (File.IsDir(dir))
        Directory.DeleteTree(dir);
    Directory.Make(dir);

    File.SaveJson(File.Join(dir, "project.json"),
                  { name: "formfuzz", startup: "F", sources: ["F.js"] });
    write("class F extends Form {\n" +
          "    Form_Open() { print('OPEN ' + this.Controls.length); Application.Quit(0); }\n" +
          "}\n", File.Join(dir, "F.js"));

    const started = Time.Seconds(Time.Now);

    for (let i = 0; i < cases; i++) {
        const rng  = new Rng(i + 1);
        const bag  = { doc: seed(), raw: null };
        const what = MUTATORS[i % MUTATORS.length](rng, bag);

        write(bag.raw !== null ? bag.raw : JSON.stringify(bag.doc),
              File.Join(dir, "F.form"));

        const bad = [];
        const runHalf = (half, argv, ok) => {
            try {
                const ran = Exec.Wait(argv, { Timeout: TIMEOUT });

                if (ran.TimedOut)
                    bad.push(`${half}: timed out after ${TIMEOUT} ms`);
                else if (!ok(ran))
                    bad.push(`${half}: exit ${ran.ExitCode}, output ` +
                             JSON.stringify(ran.Output.slice(0, 300)));
            } catch (e) {
                bad.push(`${half}: Exec.Wait: ${e.message}`);
            }
        };

        /* The loader: it either built the form or refused with a sentence. */
        runHalf("loader", [Application.Executable, dir], (r) =>
            (r.ExitCode === 0 && r.Output.includes("OPEN")) ||
            (r.ExitCode !== 0 && r.Output.includes("Bintana error:")));

        /* And `bintana check`, the path the IDE uses: a malformed file is a
         * finding (exit 1) and never a thrown pass. */
        runHalf("check", [Application.Executable, "check", dir], (r) =>
            (r.ExitCode === 0 || r.ExitCode === 1) &&
            !r.Output.includes("Bintana error:"));

        if (!bad.length)
            continue;

        failures++;
        print(`\nFAIL case ${i}: ${what} (seed ${i + 1})\n` +
              bad.map((line) => `  ${line}`).join("\n") + "\n" +
              `  the form was ${JSON.stringify(bag.raw !== null ? bag.raw : bag.doc).slice(0, 1200)}`);

        if (failures >= MAX_FAILURES) {
            print(`\nstopping after ${MAX_FAILURES} failures`);
            break;
        }
    }

    /* Whole seconds, and the wrap at midnight is not a case this runs near. */
    const took = (Time.Seconds(Time.Now) - started + 86400) % 86400;

    print(`formfuzz: ${cases} cases in ${took}s, ${failures} unexplained`);

    Directory.DeleteTree(dir);

    if (failures > 0)
        Application.Quit(1);
}
