/*
 * The worker testTask runs its modes against.
 *
 * A Task subclass like any application's: `Run` computes and answers, and
 * `Report` streams while it does.  Every branch below is one assertion in
 * testTask -- a round trip, the real `Decimal`, the prelude that came with
 * it, the two refusals, a throw, and a loop that never ends on its own (for
 * Timeout and for Stop).
 */
"use strict";

class TaskWork extends Task {

    Run(msg) {
        if (msg.mode === "echo")
            return { n: msg.n, list: msg.list, total: msg.total };

        /*
         * The whole point of the worker running the real init functions: this
         * is bta_decimal.c's Decimal, not a lookalike.  A lookalike is what
         * the abandoned version had, and it answered 9.999999999 here.
         */
        if (msg.mode === "exact") {
            const third = new Decimal("10") / new Decimal("3") * new Decimal("3");
            const price = msg.price * 3;

            return {
                third: `${third}`,
                price: `${price}`,
                round: msg.price.Round(1).toString(),
                split: Decimal.Split(new Decimal("10.00"), 3).map(String),
                cmp:   msg.price > new Decimal("19"),
                /* And it is the same class on the way back, not a shape. */
                back:  msg.price,
            };
        }

        /* A zip written in a worker and read back there: the writer holds a file
         * and a temporary, and neither leaves the thread that opened it. */
        if (msg.mode === "zipwrite") {
            const w = Zip.Create(msg.path);

            w.Add("a.txt", "written in a worker").AddFile("b.bin", msg.source);
            const n = w.Finish();
            const z = Zip.Open(msg.path);

            try {
                return { n, text: z.Read("a.txt").ToText(), size: z.Read("b.bin").Length };
            } finally {
                z.Close();
            }
        }

        /* A zip opened and read in a worker: reading an archive off the main
         * thread is what a worker is for, and the handle never leaves it. */
        if (msg.mode === "zip") {
            const z = Zip.Open(msg.path);

            try {
                return { names: z.Entries.map((e) => e.Name).join(","),
                         text: z.Read("a.txt").ToText() };
            } finally {
                z.Close();
            }
        }

        /* Pure computation with no callbacks: entropy, a keyed digest, gzip. */
        if (msg.mode === "entropy") {
            const sig = Hash.Hmac("Jefe", "what do ya want for nothing?");
            return {
                bytes:    Random.Bytes(8).Length,
                int:      Random.Int(1, 3),
                uuid:     Random.Uuid(),
                hmac:     sig,
                verified: Hash.Verify("Jefe", "what do ya want for nothing?", sig),
                gzip:     Gzip.Decompress(Gzip.Compress("in a worker")).ToText(),
            };
        }

        /* rad.js runs in here too, so the prelude's classes are the prelude's
         * classes -- and `Dictionary` is what walks the keys of a message,
         * since bta_close_hatches empties `Object` on both sides. */
        if (msg.mode === "prelude") {
            return {
                keys:      Dictionary.Keys(msg).sort().join(","),
                regex:     new Regex("^a(b+)c$").Match("abbbc").Groups[1],
                stopwatch: typeof Stopwatch,
                record:    typeof Record,
                table:     typeof Table,
                /* And the document: pure computation over a string, so a
                 * worker parses the big file off the main thread. */
                xml:       typeof Xml,
                xmlText:   (() => {
                    try { return Xml.Parse("<a><b>x</b></a>").Root.Find("b").Text; }
                    catch (e) { return `ERROR ${e.message}`; }
                })(),
                /* And a schema is compiled and used here: the same C, no
                 * window and no callback, so a worker checks a file while the
                 * window draws. */
                xmlSchema: (() => {
                    try {
                        const s = Xml.Schema(
                            `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
                               <xs:element name="x" type="xs:int"/>
                             </xs:schema>`);

                        return s.Validate(Xml.Parse("<x>1</x>")).length + "," +
                               s.Validate(Xml.Parse("<x>nope</x>")).length;
                    } catch (e) { return `ERROR ${e.message}`; }
                })(),
                /* Gone: they would fire on the main loop, or are the main
                 * thread's own state. */
                timer:     typeof Timer,
                settings:  typeof Settings,
                exec:      typeof Exec,
                /* **Locale is here whole, built on this thread**: the facts
                 * come from the process locale and the catalogue from the
                 * `.po` files, with the language the application had at
                 * `Start`.  Neither reads the main thread's table. */
                locale:      typeof Locale,
                localeCmp:   Locale.Compare("Ana", "Bruno"),
                localeFold:  Locale.Matches("Córdoba", "cordoba"),
                localeText:  typeof Locale.Text,
                localeRead:  typeof Locale.Read,
                localeWrite: typeof Locale.Write,
                /* Refused on this side too -- rad.js is evaluated entire here,
                 * so the curation crosses with it -- and pointing at
                 * `Locale.Compare`, which is now the right answer on both
                 * sides.  See testLocaleOrder for the main thread's half. */
                lc:        (() => {
                    try { "a".localeCompare("b"); return "NOT REFUSED"; }
                    catch (e) { return e.message; }
                })(),
            };
        }

        /*
         * The catalogue, on this thread.  `Run` starts after the main thread
         * has already changed `Locale.Current` again, so what this answers is
         * the language captured at `Start` -- the same bargain a form already
         * has with the words it was built with.  `Read`/`Write` are the
         * editor's pair and are pure file I/O; a worker gets them too.
         */
        if (msg.mode === "locale") {
            const path    = File.Join(Application.Directory, "po", "zz.po");
            const entries = Locale.Read(path);
            const out     = File.Join(msg.dir, "task-locale.po");

            Locale.Write(out, entries);
            const back = Locale.Read(out).length;
            File.Delete(out);

            const text    = Locale.Text("Name:");
            const plural  = Locale.Plural("{0} file", "{0} files", 2);
            const context = Locale.Context("verb", "Open");
            const started = Locale.Current;

            /* The setter is this worker's alone: it reloads this thread's
             * catalogue and must not move the main thread's. */
            Locale.Current = "";
            const bare = Locale.Text("Name:");

            return {
                text:      text,
                plural:    plural,
                context:   context,
                current:   started,
                bare:      bare,
                bareNow:   Locale.Current,
                available: Locale.Available.includes("zz"),
                read:      entries.length,
                writeBack: back,
            };
        }

        /*
         * A worker writes, and what is still refused is the callback.
         *
         * The eleven write verbs were refused once for want of a lock; they
         * are not, because `g_file_set_contents` renames a temporary over the
         * target and two threads saving one path cannot tear it. What a lock
         * is for is the lost update, which is a sequence and not a call --
         * see `Lock.Hold`. What stays refused is what would fire a callback
         * on the main loop holding this context.
         */
        if (msg.mode === "writes") {
            const said = (fn) => {
                try { fn(); return ""; } catch (e) { return e.message; }
            };
            const dir  = File.Join(msg.dir, "bta-task-writes");
            const file = File.Join(dir, "one.json");

            Directory.Make(dir);
            File.SaveJson(file, { n: msg.n });
            const back = File.LoadJson(file);

            File.Save(File.Join(dir, "two.txt"), "plain");
            const renamed = File.Join(dir, "three.txt");
            File.Rename(File.Join(dir, "two.txt"), renamed);
            const moved = File.Exists(renamed);

            File.Delete(renamed);
            const gone = !File.Exists(renamed);

            const watch = said(() => File.Watch(dir, () => {}));

            Directory.DeleteTree(dir);
            return { back: back.n, moved, gone, watch,
                     swept: !File.Exists(dir) };
        }

        /*
         * Read, change, write -- the sequence `Lock` is for.
         *
         * Every call in here is atomic on its own and the total still comes
         * out short without the hold, because the gap is *between* the read
         * and the write. Measured before this was written: four tasks, sixty
         * rounds each, answered 68 of 240 unlocked and 240 of 240 held.
         */
        if (msg.mode === "adds") {
            for (let i = 0; i < msg.rounds; i++)
                Lock.Hold(msg.lock, () => {
                    const book = File.LoadJson(msg.path);

                    book.total = book.total + 1;
                    File.SaveJson(msg.path, book);
                });
            return { rounds: msg.rounds };
        }

        if (msg.mode === "progress") {
            this.Report(1);
            this.Report(2);
            this.Report(3);
            return { ok: true };
        }
        /*
         * The cooperative half of Stop: a Run that watches `Stopping` gets to
         * hand back what it has.  Without it the interrupt would end this
         * loop where it stood and every count would be lost -- which is what
         * the assertion in testTask is really about.
         */
        if (msg.mode === "partial") {
            let n = 0;

            for (;;) {
                n++;
                if (n % 10000 === 0 && this.Stopping) {
                    this.Report({ saved: n });
                    return { n };
                }
            }
        }

        /* Process state a worker may read and must not write. */
        if (msg.mode === "process") {
            const cwd = Environment.CurrentDirectory;
            let cwdSet = null;

            try { Environment.CurrentDirectory = "/"; }
            catch (e) { cwdSet = e.message; }

            let settingsSet = null, settingsDelete = null, settingsClear = null;

            try { Settings.Set("bta-task-test", 1); }
            catch (e) { settingsSet = e.message; }
            try { Settings.Delete("bta-task-test"); }
            catch (e) { settingsDelete = e.message; }
            try { Settings.Clear(); }
            catch (e) { settingsClear = e.message; }

            return {
                home:       Environment.HomeDirectory,
                path:       Environment.Get("PATH") !== null,
                hasSet:     typeof Environment.Set,
                cwd:        typeof cwd,
                cwdSet:     cwdSet,
                settings:   Settings.Get("bta-task-missing", 7),
                settingsSet: settingsSet,
                settingsDelete: settingsDelete,
                settingsClear: settingsClear,
            };
        }

        /* Bytes cross as base64 under a tag, and come back a Bytes. */
        if (msg.mode === "bytes")
            return { n: msg.data.Length, back: msg.data, b64: msg.data.ToBase64() };

        /* A task whose work is its effect has nothing to answer. */
        if (msg.mode === "void")
            return;

        /* The blocking HTTP spelling, on this worker's own session. */
        if (msg.mode === "http") {
            const r = Http.GetWait(msg.url, { Timeout: 5000 });

            return { status: r.Status, body: r.Body.ToText() };
        }

        /* The blocking child only: callbacks belong to the main loop. */
        if (msg.mode === "exec") {
            const r = Exec.Wait(["/bin/sh", "-c", "printf hi"]);
            let   async = "";

            try { Exec(["/bin/true"]); }
            catch (e) { async = e.message; }

            return { code: r.ExitCode, out: String(r.Output), async: async };
        }

        /* JavaScript lets a program throw what it likes; both of these have a
         * sentence even though neither has a stack. */
        if (msg.mode === "throw-string")
            throw "task string " + msg.n;
        if (msg.mode === "throw-object")
            throw { code: msg.n };

        if (msg.mode === "boom")
            throw new Error("task boom " + msg.n);
        if (msg.mode === "spin") {
            for (;;) { /* Timeout or Stop is the only way out. */ }
        }
        return {};
    }
}
