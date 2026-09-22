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
                /* Gone: they would fire on the main loop, or are the main
                 * thread's own state. */
                timer:     typeof Timer,
                settings:  typeof Settings,
                exec:      typeof Exec,
                /* Refused on this side too -- rad.js is evaluated entire here,
                 * so the curation crosses with it -- and with a sentence of its
                 * own, because `Locale` is not installed in a worker and
                 * pointing at `Locale.Compare` would be a second wrong answer.
                 * See testLocaleOrder for the main thread's half. */
                locale:    typeof Locale,
                lc:        (() => {
                    try { "a".localeCompare("b"); return "NOT REFUSED"; }
                    catch (e) { return e.message; }
                })(),
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

        if (msg.mode === "boom")
            throw new Error("task boom " + msg.n);
        if (msg.mode === "spin") {
            for (;;) { /* Timeout or Stop is the only way out. */ }
        }
        return {};
    }
}
