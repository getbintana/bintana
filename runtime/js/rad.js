/*
 * rad.js -- the JS half of the Bintana runtime.
 *
 * Baked into the binary and evaluated once, after the native widget classes
 * are installed as globals.  Anything expressible in JS belongs here rather
 * than in C.
 */
"use strict";

/*
 * The global object, held before the name is taken away.
 *
 * `globalThis` is not part of the language a Bintana project sees: it is the
 * back door to everything at once, and Namespace() is the way to publish here.
 * The runtime deletes the name once this file has run, so anything below that
 * still needs the object has to have captured it -- which is what this is.
 */
const GLOBAL = globalThis;

/*
 * The raw scheduling primitives, held for the same reason and on the same terms.
 *
 * Timer is what a project schedules with; these are what Timer is built out of,
 * and once it exists they are the low-level way of saying the same thing worse.
 * The runtime deletes their names too, so this is the last place they are
 * spelled.
 */
const setTimer     = setInterval;
const setOnceTimer = setTimeout;
const clearTimer   = clearInterval;

/*
 * The forward-only clock, held on exactly the same terms.
 *
 * `Stopwatch` below is what a project measures a duration with; this is what it
 * is built out of, and a bare reading of it counts from the machine's boot and
 * means nothing on its own -- so the runtime takes the name away and this is the
 * last place it is spelled.
 */
const monotonicNow = monotonic;

/*
 * The two hooks a `.record` file needs, held on the same terms.
 *
 * A record's shape may live in a file beside its class, the way a form's tree
 * lives in a `.form`, and finding that file is the runtime's own index -- the
 * one that finds a class's `.form`, with the other extension (`bta_form.c`).
 * What the file's `of` names -- another Record class -- has to resolve the way
 * the rest of the runtime resolves a name, and JavaScript cannot evaluate one
 * (`eval` is not part of this language), so the runtime hands both over.
 * `Record.File` is the first one's public face; the names go with the hatches.
 */
const findRecordFile = recordFile;
const resolveName    = classOfName;

/*
 * The reflection this file is built out of, held on the same terms.
 *
 * Discovering what a control can be asked for is the runtime's job, and the
 * answer it publishes is Widget.PropertyNames() -- so the poking underneath is
 * an implementation detail, and the names for it are taken away with the rest.
 */
const defineProperty = Object.defineProperty;
const prototypeOf    = Object.getPrototypeOf;
const ownNames       = Object.getOwnPropertyNames;
const ownDescriptor  = Object.getOwnPropertyDescriptor;

/*
 * Reading a dictionary, held on the same terms -- and this one is not
 * reflection.  What a plain object holds is data, which is why `Object.keys` is
 * part of the language while `getOwnPropertyNames` is not; `Dictionary` is the
 * name a project reads a bag with, and these two are what it is built out of and
 * what this file reads its own bags with.  Held so that taking the names away is
 * a line in close_hatches() rather than a rewrite here.
 */
const ownKeys     = Object.keys;
const objectProto = Object.prototype;
const hasOwn      = objectProto.hasOwnProperty;

/* BTA_VERSION is set from C, out of the one number CMakeLists declares. It was
 * a literal here while `project()` had no version at all, so the two could
 * differ and nothing would ever say so. */

/* ------------------------------------------------------------------------
 * localeCompare, refused by name.
 *
 * QuickJS is built without ICU, so there is no `Intl` and this falls back to
 * comparing code units -- which is not a rough alphabetical order but a
 * different one, in the language this runtime is commented in.  Measured:
 *
 *     "Álvarez".localeCompare("Zapata")                  ->  1
 *     ["Zapata","Álvarez","acosta","Ñandú"].sort(cmp)    ->  Zapata, acosta,
 *                                                            Álvarez, Ñandú
 *
 * **It answers exactly what no comparator at all answers**, which is what makes
 * it worse than missing: the name is right, the arguments are right, it returns
 * -1/0/1, it never throws, and the list comes out sorted wrongly.  Five
 * documents warned about it and nothing ever argued for keeping it, so it is a
 * refusal now, and the refusal names the answer -- the same bargain as the
 * QuickJS patch that made *"no 'Txt' to assign"* say which property.
 *
 * **Here and not in close_hatches** because a deletion would say only *not a
 * function*, and this can say what to use instead.  Either place would have
 * reached both sides -- a worker evaluates this file entire, and it calls
 * bta_close_hatches too -- so the choice is about the message and nothing else.
 *
 * **One sentence on both sides now.** It used to send a worker to the main
 * thread, because `bta_locale_init` was not called there and `Locale.Compare`
 * was missing along with the catalogue half that genuinely must not cross a
 * thread; `bta_locale_init_facts` gives a worker the half that needs no
 * catalogue (ISSUE-worker-locale-order), so pointing at `Locale.Compare` is
 * right wherever this is read.
 * ---------------------------------------------------------------------- */

defineProperty(String.prototype, "localeCompare", {
    configurable: true,
    writable:     true,
    value() {
        throw new TypeError(
            "localeCompare compares code units on this engine, so it is " +
            "refused -- use Locale.Compare");
    },
});

/* ------------------------------------------------------------------------
 * JSON files, which is what JSON is for here.
 *
 * A .form is JSON, project.json is JSON, settings are JSON: reading one was
 * always `JSON.parse(File.Load(path))` and writing one always the same
 * stringify with the same indent and the same trailing newline.  Two names for
 * the pair, so neither the ceremony nor the choice comes up again.
 *
 * **Here and not in forms.js**, although the .form loader is its heaviest
 * caller: a worker thread runs this file and not that one, and JSON on a disk
 * is not a widget.  `Settings` below is the other caller, and it is right
 * here.
 * ---------------------------------------------------------------------- */

/**
 * the file, parsed. **The error names the file**, which is the whole reason to
 * use it over `JSON.parse(File.Load(p))` — a syntax error in *something* is not
 * an answer
 */
File.LoadJson = function (path) {
    const text = File.Load(path);
    try {
        return JSON.parse(text);
    } catch (e) {
        /* Whose fault it is, which a bare SyntaxError never says. */
        throw new SyntaxError(`${path}: ${e.message}`);
    }
};

/*
 * What JSON cannot hold is refused rather than written as something else.
 * `JSON.stringify` turns NaN and both infinities into `null`, and `undefined`
 * in a list into `null` too, and says nothing: a `0 / 0` in a setting came back
 * from the file as a null the program never stored.  The walk is the replacer,
 * so it sees each value after its `toJSON` (a Decimal, a Record) exactly as the
 * text will, and a WeakMap from each holder to its path is what lets the
 * refusal say `items[3].x` rather than `x`.  `JSON.stringify` itself stays the
 * language's, and is the way to write the nulls on purpose.
 */
function jsonRefusal(path, where, what) {
    const at = where === "" ? "the value itself" : `'${where}'`;
    return new RangeError(`File.SaveJson: ${path}: ${at} is ${what}, which JSON cannot hold`
                          + ` -- JSON.stringify writes it as null, if that is what is meant`);
}

/**
 * one canonical shape: indented by two, one trailing newline. Every `.form` and
 * every `project.json` in this tree is written by it, which is why a file saved
 * by the IDE and one written by hand look the same. **What JSON cannot hold is
 * refused**, naming where it is: `NaN`, `Infinity` and `-Infinity`, and
 * `undefined` inside a list -- all of which `JSON.stringify` writes as `null`
 * without a word. To write those nulls on purpose, `File.Save(path,
 * JSON.stringify(value, null, 2))`
 */
File.SaveJson = function (path, value) {
    const paths = new WeakMap();
    const text  = JSON.stringify(value, function (key, v) {
        const above = paths.get(this);
        const here  = above === undefined ? ""
                    : Array.isArray(this) ? `${above}[${key}]`
                    : above === "" ? key : `${above}.${key}`;

        if (typeof v === "number" && !Number.isFinite(v))
            throw jsonRefusal(path, here, String(v));
        if (v === undefined && Array.isArray(this))
            throw jsonRefusal(path, here, "undefined in a list");
        if (v !== null && typeof v === "object") paths.set(v, here);
        return v;
    }, 2);
    File.Save(path, `${text}\n`);
};

/* ------------------------------------------------------------------------
 * XML files, the same pair one medium over.
 *
 * A `.form` and `project.json` are JSON; the formats other programs write are
 * XML -- MSPDI, SOAP, SVG -- and reading one was
 * `Xml.ParseBytes(File.LoadBytes(path))` with the path lost from the message.
 * The two names carry the two decisions: the error names the file, and what is
 * written is the canonical shape the DOM defines (declaration, indented by
 * two, one trailing newline).
 *
 * **Bytes and not `File.Load`**, because XML declares its own encoding: reading
 * it as UTF-8 text first would destroy a file written in ISO-8859-1 before the
 * declaration that says so could be honoured.  A worker runs this file and not
 * forms.js, and `Xml` is installed there too; see docs/plans/xml-plan.md.
 * ---------------------------------------------------------------------- */

/**
 * the file as a [`Xml`](docs/reference/globals/Xml.md) document. **The error
 * names the file**, and the document's own declaration says what encoding it is
 * in: this reads bytes, unlike `Load`
 */
File.LoadXml = function (path) {
    try {
        return Xml.ParseBytes(File.LoadBytes(path));
    } catch (e) {
        /* Whose fault it is, which the parser never says. */
        throw new SyntaxError(`${path}: ${e.message}`);
    }
};

/**
 * the canonical XML shape, atomically, honouring neither locale nor encoding
 * guesses
 */
File.SaveXml = function (path, node) {
    File.Save(path, Xml.Stringify(node));
};

/* ------------------------------------------------------------------------
 * Csv -- rows of text, the way spreadsheets and other programs exchange them.
 *
 * RFC 4180 and what is written in practice: a value in double quotes may hold
 * the separator, a line break or a quote written twice; a line ends in LF or
 * CRLF; a UTF-8 byte-order mark at the start is not part of the first heading.
 * **The separator is found when it is not given**: the one of `,` `;` tab `|`
 * that the first line holds most of, outside quotes. That is the case that
 * matters here: a spreadsheet in a locale whose decimal comma is the comma
 * writes `;`, and a reader that assumed `,` would see one column per line and
 * say nothing.
 *
 * **Every value is text.** What a column means -- a number, a date, a decimal
 * comma -- is the application's to decide, and a parser that guessed would
 * turn the code "00123" into 123 for everybody. Rows may have different
 * lengths; nothing is padded.
 *
 * Here and not in C because it is a loop over a string, and a worker runs this
 * file too.
 * ---------------------------------------------------------------------- */

const CSV_SEPARATORS = [",", ";", "\t", "|"];

function csvOptions(options, verb) {
    const o = options || {};
    if (typeof o !== "object") throw new TypeError(`Csv.${verb}: options are an object, got ${typeof o}`);
    const sep = o.Separator === undefined ? "" : String(o.Separator);
    if (sep.length > 1) throw new TypeError(`Csv.${verb}: Separator is one character, got ${JSON.stringify(sep)}`);
    const quote = o.Quote === undefined ? "\"" : String(o.Quote);
    if (quote.length !== 1) throw new TypeError(`Csv.${verb}: Quote is one character, got ${JSON.stringify(quote)}`);
    return { Separator: sep, Quote: quote, LineEnd: o.LineEnd === undefined ? "\n" : String(o.LineEnd) };
}

/* The separator the first record uses most, counted outside quotes. */
function csvDetect(text, quote) {
    const count = new Map(CSV_SEPARATORS.map((c) => [c, 0]));
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === quote) quoted = !quoted;
        else if (!quoted && (c === "\n" || c === "\r")) break;
        else if (!quoted && count.has(c)) count.set(c, count.get(c) + 1);
    }
    let best = ",", most = 0;
    for (const c of CSV_SEPARATORS) if (count.get(c) > most) { best = c; most = count.get(c); }
    return best;
}

GLOBAL.Csv = {

    /**
     * the rows of a CSV text, each an array of strings. `options`:
     * `Separator` (one character; `""` or absent finds it among `,` `;` tab
     * `|`), `Quote` (default `"`). A last line break makes no empty row
     */
    Parse(text, options) {
        const o = csvOptions(options, "Parse");
        let t = String(text === undefined || text === null ? "" : text);
        if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
        const sep = o.Separator || csvDetect(t, o.Quote);
        const q = o.Quote;
        const rows = [];
        let row = [], value = "", quoted = false, started = false;
        for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (quoted) {
                if (c === q) {
                    if (t[i + 1] === q) { value += q; i++; }
                    else quoted = false;
                } else value += c;
                continue;
            }
            if (c === q && value === "") { quoted = true; started = true; continue; }
            if (c === sep) { row.push(value); value = ""; started = true; continue; }
            if (c === "\r" || c === "\n") {
                if (c === "\r" && t[i + 1] === "\n") i++;
                row.push(value);
                rows.push(row);
                row = []; value = ""; started = false;
                continue;
            }
            value += c;
            started = true;
        }
        if (quoted) throw new SyntaxError("Csv.Parse: a quoted value is not closed");
        if (started || value !== "" || row.length) { row.push(value); rows.push(row); }
        return rows;
    },

    /**
     * the rows of a CSV file, as `Parse` reads them. **The error names the
     * file**
     */
    Load(path, options) {
        const text = File.Load(path);
        try {
            return Csv.Parse(text, options);
        } catch (e) {
            throw new SyntaxError(`${path}: ${e.message}`);
        }
    },

    /**
     * rows (arrays of values) as CSV text. A value is quoted when it holds
     * the separator, the quote, a line break or space at either end;
     * `null` and `undefined` are empty, and a number is written as the
     * language writes it, never in the desktop's format. `options`:
     * `Separator` (default `,`), `Quote`, `LineEnd` (default LF)
     */
    Format(rows, options) {
        const o = csvOptions(options, "Format");
        if (!Array.isArray(rows)) throw new TypeError(`Csv.Format: rows are an array, got ${typeof rows}`);
        const sep = o.Separator || ",", q = o.Quote;
        const one = (v) => {
            const s = v === null || v === undefined ? "" : String(v);
            const needs = s.indexOf(sep) >= 0 || s.indexOf(q) >= 0 || /[\r\n]/.test(s) ||
                          (s.length && (s[0] === " " || s[s.length - 1] === " "));
            return needs ? q + s.split(q).join(q + q) + q : s;
        };
        return rows.map((r, i) => {
            if (!Array.isArray(r)) throw new TypeError(`Csv.Format: row ${i} is not an array`);
            return r.map(one).join(sep);
        }).join(o.LineEnd) + (rows.length ? o.LineEnd : "");
    },

    /** writes rows as a CSV file, as `Format` writes them */
    Save(path, rows, options) {
        File.Save(path, Csv.Format(rows, options));
    },
};

/* ------------------------------------------------------------------------
 * Settings -- what an application remembers between runs.
 *
 * Application.ConfigDirectory is a directory; this is the file everybody was going to
 * write in it anyway.  Values are whatever JSON carries, read once and written
 * on every change: a setting lost because the application crashed before some
 * flush would be a poor trade for the writes it saves.
 *
 * A file that cannot be read counts as empty.  Settings are the last thing that
 * should stop an application from starting.
 * ---------------------------------------------------------------------- */

const SETTINGS_FILE = File.Join(Application.ConfigDirectory, "settings.json");

let settingsCache = null;

function settingsAll() {
    if (settingsCache) return settingsCache;

    settingsCache = {};
    try {
        const saved = File.LoadJson(SETTINGS_FILE);
        if (saved && typeof saved === "object") settingsCache = saved;
    } catch (e) {
        /* First run, or a half-written file. */
    }
    return settingsCache;
}

function settingsFlush() {
    try {
        File.SaveJson(SETTINGS_FILE, settingsAll());
        return true;
    } catch (e) {
        /* A read-only home is not a reason to fall over. */
        return false;
    }
}

GLOBAL.Settings = {
    /**
     * the value under `key`, or `fallback` when there is none — which is what
     * tells a missing setting from one that is `false`
     */
    Get(key, fallback) {
        const all = settingsAll();
        return hasOwn.call(all, key) ? all[key] : fallback;
    },

    /**
     * stores `value` under `key`, anything JSON carries, and writes the file at
     * once
     */
    Set(key, value) {
        settingsAll()[key] = value;
        return settingsFlush();
    },

    /* Own keys only, the same rule and for the same reason as Dictionary.Has:
     * `"toString" in {}` is true, and a settings file nobody wrote a toString
     * into must not answer about Object.prototype. */
    /** whether there is a value under `key` */
    Has(key)    { return hasOwn.call(settingsAll(), key); },
    /** every key there is a value under */
    Keys()      { return ownKeys(settingsAll()); },
    /** forgets the value under `key`, and writes the file */
    Delete(key) { delete settingsAll()[key]; return settingsFlush(); },
    /** forgets every value, and writes the file */
    Clear()     { settingsCache = {}; return settingsFlush(); },

    /** where the settings are kept: `Application.ConfigDirectory/settings.json` */
    get Path()  { return SETTINGS_FILE; },
};

/* ------------------------------------------------------------------------
 * Timer -- scheduling with a name and a switch.
 *
 * The same thing every application was writing around the timer ids: what it
 * does, how often, and whether it is running right now.
 *
 *   const clock = new Timer(1000, () => this.Lbl.Text = new Date().toString());
 *   clock.Start();
 *   ...
 *   clock.Enabled = false;
 * ---------------------------------------------------------------------- */

GLOBAL.Timer = class Timer {

    constructor(delay = 1000, tick = null) {
        this.Delay = delay;
        this.Tick  = tick;
        this._id   = null;
    }

    /** whether it is running; assigning starts or stops it */
    get Enabled() { return this._id !== null; }

    set Enabled(on) {
        if (on) this.Start();
        else    this.Stop();
    }

    /**
     * starts it, after `delay` when one is given, else after its own `Delay`;
     * answers the timer
     */
    Start(delay) {
        if (delay !== undefined) this.Delay = delay;
        this.Stop();
        this._id = setTimer(() => this.fire(), Math.max(0, this.Delay));
        return this;
    }

    /** stops it; answers the timer */
    Stop() {
        if (this._id !== null) clearTimer(this._id);
        this._id = null;
        return this;
    }

    /* Fires once and does not repeat: the other half of what timers are for. */
    /** fire one more time and stop */
    Once(delay) {
        if (delay !== undefined) this.Delay = delay;
        this.Stop();
        this._id = setOnceTimer(() => { this._id = null; this.fire(); },
                                Math.max(0, this.Delay));
        return this;
    }

    fire() {
        if (typeof this.Tick === "function") this.Tick();
    }

    /*
     * The two things anyone actually wants, said in one line.
     *
     *   Timer.After(250, () => this.Lbl.Text = "listo");
     *   const clock = Timer.Every(1000, () => this.tick());
     *
     * Both hand back the Timer, so what was started can still be stopped --
     * which a bare id never let you do without keeping it somewhere.
     */
    /**
     * runs `tick` once after `delay` milliseconds, and answers the `Timer`, so
     * what was started can be stopped. `Timer.After(0, fn)` is how GTK is given
     * a frame
     */
    static After(delay, tick) { return new Timer(delay, Timer.ticking(tick, "After")).Once(); }
    /**
     * runs `tick` every `delay` milliseconds until it is stopped, and answers
     * the `Timer`
     */
    static Every(delay, tick) { return new Timer(delay, Timer.ticking(tick, "Every")).Start(); }

    /* A timer started with nothing to call is a mistake nothing reports:
     * `fire` skips a tick that is not a function, so `Timer.After(fn, 300)` --
     * the arguments the wrong way round -- ran nothing, forever. */
    static ticking(tick, verb) {
        if (typeof tick !== "function")
            throw new TypeError(`Timer.${verb}(delay, tick) needs a function as its second argument`);
        return tick;
    }
};

/* ------------------------------------------------------------------------
 * Stopwatch -- how long something took.
 *
 * `Timer` says *when*; this says *how long*, and they are not the same question
 * measured on the same clock.
 *
 *   const watch = new Stopwatch();
 *   watch.Start();
 *   ...
 *   watch.Elapsed          // milliseconds, running or not
 *   watch.Stop();          // and Start() again picks up where it left off
 *
 * **`Date` cannot answer this, and the reason is not precision.** A `Date` reads
 * the wall clock, and a wall clock is a setting: NTP steps it, a timezone change
 * moves it, somebody corrects it by hand.  Any of those during a measurement
 * makes the answer wrong, and a step backwards makes it *negative* -- a lap that
 * took minus four seconds.  This reads the clock that only goes forward, which
 * is the one GLib already schedules every `Timer` against.
 *
 * **And counting ticks is the other wrong answer**, the one that looks right:
 * a timer asked for 100 ms fires a little late every time, so a display that
 * adds 100 to a counter drifts away from the truth and never comes back.  A tick
 * is for deciding *when to repaint*; what is painted comes from here.  Set the
 * repaint to once a second and the reading stays exact -- that is the test of
 * whether a stopwatch was written correctly.
 *
 * Milliseconds, with the fraction, so it is the same unit a `Timer` delay is in.
 * ---------------------------------------------------------------------- */

GLOBAL.Stopwatch = class Stopwatch {

    /* What earlier runs added up to, and the reading this run started at.
     * Private because they are the two halves of one number: anything that could
     * set one without the other would make `Elapsed` a lie. */
    #held = 0;
    #from = 0;
    #on   = false;

    /** whether it is going */
    get Running() { return this.#on; }

    /* Running or stopped, the same question and the same answer -- so nothing
     * has to stop the watch in order to read it. */
    /** milliseconds, **with the fraction**, running or not */
    get Elapsed() {
        return this.#on ? this.#held + (monotonicNow() - this.#from) : this.#held;
    }

    /* Starting one that is already running is not an error and must not restart
     * it: a Start button pressed twice is one intention said twice. */
    /** starts measuring, or goes on from where it stopped; answers the watch */
    Start() {
        if (!this.#on) {
            this.#from = monotonicNow();
            this.#on   = true;
        }
        return this;
    }

    /** stops measuring and keeps `Elapsed`; answers the watch */
    Stop() {
        if (this.#on) {
            this.#held += monotonicNow() - this.#from;
            this.#on    = false;
        }
        return this;
    }

    /* Back to zero, and stopped -- what the button next to Start means. */
    /** back to zero, running or not; answers the watch */
    Reset() {
        this.#held = 0;
        this.#from = 0;
        this.#on   = false;
        return this;
    }

    /* All three hand the watch back, so `new Stopwatch().Start()` is one line. */
};

/* ------------------------------------------------------------------------
 * UndoStack -- what Edit > Undo takes back.
 *
 * Every editor an application writes -- a drawing, a board of cards, a sheet --
 * needs the same twenty lines, and gets three of them wrong: a redo list that
 * survives a new edit, a step whose undo threw and left half of itself on the
 * list, and "modified" worked out by comparing against a copy of the document.
 * The IDE keeps its own for the designer; this is the same idea for everyone.
 *
 *   const undo = new UndoStack();
 *   undo.Do("Move card", () => card.Move(x, y), () => card.Move(oldX, oldY));
 *   undo.Undo();                 // and Redo()
 *   undo.Group("Paste", () => { ...several Do... });   // one step
 *
 * **A step is two functions, not a snapshot.** A snapshot of the whole
 * document per edit is what the designer pays for, and it costs the size of
 * the document every time; a pair costs what the edit costs.
 *
 * **Undo is honest about failure.** A step whose function throws stays where
 * it was, so the list never says something happened that did not.
 * ---------------------------------------------------------------------- */

GLOBAL.UndoStack = class UndoStack {

    #done    = [];
    #undone  = [];
    #group   = null;      /* the step being gathered by `Group`, or null */
    #limit   = 100;
    #cleanAt = 0;         /* how many steps were done at `MarkClean`; -1: gone */
    #busy    = false;
    #change  = null;

    /** @param {number} [limit] how many steps it keeps, `0` for no limit; default `100` */
    constructor(limit) {
        if (limit !== undefined) this.Limit = limit;
    }

    /** whether there is a step to take back */
    get CanUndo() { return this.#done.length > 0; }
    /** whether there is a step to do again */
    get CanRedo() { return this.#undone.length > 0; }
    /** the text of the step `Undo` takes back, or `""` -- for a menu's "Undo Move card" */
    get UndoText() { return this.#done.length ? this.#done[this.#done.length - 1].text : ""; }
    /** the text of the step `Redo` does again, or `""` */
    get RedoText() { return this.#undone.length ? this.#undone[this.#undone.length - 1].text : ""; }

    /** whether what is done now differs from what it was at `MarkClean` -- the asterisk in a title bar */
    get Modified() { return this.#cleanAt !== this.#done.length; }

    /** how many steps it keeps, the oldest going first; `0` for no limit. Default `100` */
    get Limit() { return this.#limit; }
    set Limit(n) {
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
            throw new RangeError(`UndoStack.Limit: expected a whole number of steps, 0 or more, got ${n}`);
        this.#limit = n;
        this.#trim();
    }

    /** assign `() => …`, called after every change to what can be undone or redone; `null` takes it off */
    get OnChange() { return this.#change; }
    set OnChange(fn) {
        if (fn !== null && typeof fn !== "function")
            throw new TypeError("UndoStack.OnChange: expected a function, or null");
        this.#change = fn;
    }

    /**
     * runs `redo` and records the step, so `Undo` runs `undo`. If `redo` throws,
     * nothing is recorded and the error goes on. Answers the stack
     * @param {string} text what the step is called
     * @param {function} redo
     * @param {function} undo
     */
    Do(text, redo, undo) {
        this.#check("Do", text, redo, undo);
        this.#busy = true;
        try { redo(); } finally { this.#busy = false; }
        this.#record({ text, redo, undo });
        return this;
    }

    /**
     * records a step that **has already happened** -- text typed, a drag that
     * ended -- without running it. Answers the stack
     * @param {string} text
     * @param {function} redo
     * @param {function} undo
     */
    Add(text, redo, undo) {
        this.#check("Add", text, redo, undo);
        this.#record({ text, redo, undo });
        return this;
    }

    /**
     * runs `fn`, and every `Do` and `Add` inside it becomes **one** step called
     * `text`, undone last-first. A group inside a group joins the outer one.
     * If `fn` throws, what it had done is taken back and the error goes on
     * @param {string} text
     * @param {function} fn
     */
    Group(text, fn) {
        if (typeof text !== "string")
            throw new TypeError("UndoStack.Group(text, fn): text is what the step is called");
        if (typeof fn !== "function")
            throw new TypeError("UndoStack.Group(text, fn): fn is a function");
        if (this.#group) { fn(); return this; }

        const parts = [];
        this.#group = parts;
        try {
            fn();
        } catch (e) {
            this.#group = null;
            for (let i = parts.length - 1; i >= 0; i--) parts[i].undo();
            throw e;
        }
        this.#group = null;
        if (parts.length)
            this.#record({ text,
                           redo: () => { for (const p of parts) p.redo(); },
                           undo: () => { for (let i = parts.length - 1; i >= 0; i--) parts[i].undo(); } });
        return this;
    }

    /** takes the last step back; `false` when there was none */
    Undo() {
        if (this.#busy) throw new Error("UndoStack.Undo: called from inside a step");
        if (!this.#done.length) return false;
        const step = this.#done[this.#done.length - 1];
        this.#busy = true;
        try { step.undo(); } finally { this.#busy = false; }
        this.#undone.push(this.#done.pop());
        this.#changed();
        return true;
    }

    /** does again the last step taken back; `false` when there was none */
    Redo() {
        if (this.#busy) throw new Error("UndoStack.Redo: called from inside a step");
        if (!this.#undone.length) return false;
        const step = this.#undone[this.#undone.length - 1];
        this.#busy = true;
        try { step.redo(); } finally { this.#busy = false; }
        this.#done.push(this.#undone.pop());
        this.#changed();
        return true;
    }

    /** forgets every step, both ways; what is done now counts as clean */
    Clear() {
        this.#done    = [];
        this.#undone  = [];
        this.#cleanAt = 0;
        this.#changed();
    }

    /** what is done now is what was saved: `Modified` reads `false` until the next step, an `Undo` or a `Redo` */
    MarkClean() {
        this.#cleanAt = this.#done.length;
        this.#changed();
    }

    #check(verb, text, redo, undo) {
        if (this.#busy)
            throw new Error(`UndoStack.${verb}: called from inside a step, which would record the undo itself`);
        if (typeof text !== "string")
            throw new TypeError(`UndoStack.${verb}(text, redo, undo): text is what the step is called`);
        if (typeof redo !== "function" || typeof undo !== "function")
            throw new TypeError(`UndoStack.${verb}(text, redo, undo): redo and undo are functions`);
    }

    #record(step) {
        if (this.#group) { this.#group.push(step); return; }
        this.#done.push(step);
        /* A new step after an undo is a new future: what was undone cannot be
         * redone over it, and a clean point that was among it is gone. */
        if (this.#cleanAt > this.#done.length - 1 && this.#undone.length) this.#cleanAt = -1;
        this.#undone = [];
        this.#trim();
        this.#changed();
    }

    #trim() {
        if (!this.#limit) return;
        const over = this.#done.length - this.#limit;
        if (over <= 0) return;
        this.#done.splice(0, over);
        this.#cleanAt = this.#cleanAt >= over ? this.#cleanAt - over : -1;
    }

    #changed() {
        if (this.#change) this.#change();
    }
};

/* ------------------------------------------------------------------------
 * Test -- what `bintana test` runs.
 *
 * A project's tests live in `tests/`, one class per file named like it,
 * extending this:
 *
 *   class InvoiceTest extends Test {
 *       testTotal()  { this.Eq(new Invoice([10, 5]).Total, 15); }
 *       testRefuse() { this.Throws(() => new Invoice([-1])); }
 *   }
 *
 * `bintana test <project>` loads the project's sources, then every
 * `tests/*Test.js`, and calls each method whose name starts with `test`, in the
 * order written, on a new instance -- `Setup()` before, `Teardown()` after.
 * The run ends `0` when every test passed and `1` when one did not, which is
 * what CI reads; `--json` writes a line per test, which is what the IDE reads.
 *
 * **A test fails alone.** An assertion throws, and so may the code under test;
 * either way that test is marked and the next one runs. An error nobody caught
 * in a callback while a test is running -- a `Timer`, an `Http` answer -- is
 * that test's too, through `Application.OnError`, which the run holds for its
 * length.
 *
 * **Waiting is counted, never assumed.** `Until(cond, then)` asks `cond` every
 * 10 ms and runs `then` when it holds; a test is over when its last wait is.
 * One that never holds fails the test by name -- a smaller total with nothing
 * red is the failure a suite cannot afford, and `tests/widgets`' own `until`
 * says why at length.
 *
 * The folder is fixed: a normal run never loads `tests/`, with or without a
 * `sources` list, and the IDE's check knows it.
 * ---------------------------------------------------------------------- */

/* The test that is running, so an uncaught error and a wait know whose they
 * are. Module-level because there is one run per process. */
let testCurrent = null;

class TestFailure extends Error {
    constructor(message) { super(message); this.name = "TestFailure"; }
}

/* How a value reads in a failure message: what was got, against what was
 * wanted. JSON for data, so `[1,2]` against `[1,3]` says which. */
function testShow(v) {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === undefined) return "undefined";
    if (typeof v === "function") return `function ${v.name || ""}`.trim();
    try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function testPlain(v) {
    const proto = prototypeOf(v);
    return proto === objectProto || proto === null;
}

/* The value type whose text is its value.  The test is by class and not by
 * "has a toString": every class inherits one, and `String(pair)` is
 * `[object Object]` for every instance -- two different pairs would then be
 * the same value, which is the one false green a test framework cannot have.
 * A class of the project's own is compared by identity. */
function testTextValue(v) {
    return GLOBAL.Decimal && typeof GLOBAL.Decimal === "function" &&
           v instanceof GLOBAL.Decimal;
}

function testSame(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
        return Number.isNaN(a) && Number.isNaN(b);
    if (a instanceof Date && b instanceof Date)
        return a.getTime() === b.getTime();
    if (a.constructor === b.constructor && testTextValue(a) && testTextValue(b))
        return String(a) === String(b);       /* a Decimal: its text */
    if ((Array.isArray(a) && Array.isArray(b)) ||
        (testPlain(a) && testPlain(b))) {
        try { return JSON.stringify(a) === JSON.stringify(b); }
        catch (e) { return false; }
    }
    return false;
}

GLOBAL.Test = class Test {

    /** runs before each test method, on the instance it runs on; override it */
    Setup() {}

    /** runs after each test method, passed or not; override it */
    Teardown() {}

    /**
     * fails the test unless `got` equals `want` -- the same value, or for
     * arrays and plain objects the same JSON, a `Date` with the same instant,
     * or a `Decimal` with the same text (a `Day` is already a string, so it
     * compares as one). A class of the project's own is compared by identity.
     * `what` names the check in the message
     * @param {*} got
     * @param {*} want
     * @param {string} [what]
     */
    Eq(got, want, what) {
        if (!testSame(got, want))
            this.Fail(`${what ? `${what}: ` : ""}expected ${testShow(want)}, got ${testShow(got)}`);
    }

    /**
     * fails the test unless `cond` is true
     * @param {boolean} cond
     * @param {string} [what]
     */
    Check(cond, what) {
        if (cond !== true) this.Fail(what || `expected true, got ${testShow(cond)}`);
    }

    /**
     * fails the test unless `fn` throws, and answers what it threw -- so the
     * message can be checked too
     * @param {function} fn
     * @param {string} [what]
     */
    Throws(fn, what) {
        try {
            fn();
        } catch (e) {
            if (e instanceof TestFailure) throw e;
            return e;
        }
        this.Fail(what || "expected a throw, none happened");
    }

    /** fails the test now, with that message */
    Fail(message) {
        throw new TestFailure(String(message));
    }

    /**
     * waits: asks `cond` every 10 ms and runs `then` once it holds. The test
     * is not over until it has; if it never holds within `ms` (default
     * `5000`) the test fails, saying `what`
     * @param {function} cond
     * @param {function} then
     * @param {{Ms?: number, What?: string}} [options]
     */
    Until(cond, then, options) {
        const run = testCurrent;
        if (!run) throw new Error("Test.Until: called outside a running test");
        const opts  = options || {};
        const limit = opts.Ms === undefined ? 5000 : opts.Ms;
        const from  = monotonicNow();
        /* Where the wait was asked for, so a wait that never holds points at
         * its own line and not at the timer that gave up on it. */
        const where = new Error().stack;
        run.waits++;
        const step = () => {
            if (run.over) return;
            let held = false;
            try { held = !!cond(); } catch (e) { run.fail(e); return run.waited(); }
            if (!held && monotonicNow() - from < limit) { Timer.After(10, step); return; }
            if (!held) {
                const e = new TestFailure(`${opts.What || "Until"}: never became true in ${limit} ms`);
                e.stack = where;
                run.fail(e);
                return run.waited();
            }
            try { then(); } catch (e) { run.fail(e); }
            run.waited();
        };
        Timer.After(0, step);
    }
};

/* Where in the test's own file an error was raised: the first frame of the
 * stack that is in it. */
function testLine(e, file) {
    const stack = String((e && e.stack) || "");
    for (const line of stack.split("\n")) {
        const at = line.lastIndexOf(file);
        if (at < 0) continue;
        const m = /:(\d+)(?::\d+)?\)?\s*$/.exec(line.slice(at + file.length));
        if (m) return Number(m[1]);
    }
    return 0;
}

/* The test methods of a class, in the order written, a base class's after the
 * class's own -- and each name once, so an override runs once. */
function testMethods(klass) {
    const out  = [];
    const seen = new Set();
    for (let p = klass.prototype; p && p !== Test.prototype && p !== objectProto; p = prototypeOf(p)) {
        for (const name of ownNames(p)) {
            if (seen.has(name)) continue;
            seen.add(name);
            const d = ownDescriptor(p, name);
            if (/^test/.test(name) && d && typeof d.value === "function") out.push(name);
        }
    }
    return out;
}

/*
 * The run: called by the runtime with the classes it found, never by a project.
 * A name in the prelude that C looks up, as `showError` is.
 */
function runTests(found, filter, json) {
    const queue  = [];
    let passed   = 0, failed = 0;
    const say    = (o) => print(JSON.stringify(o));
    const rel    = (f) => File.Within(f, Application.Directory)
                         ? f.slice(Application.Directory.length).replace(/^[\\/]/, "") : f;

    for (const t of found) {
        if (!t.Class) {
            if (filter && !t.Name.includes(filter)) continue;
            failed++;
            if (json) say({ Event: "Test", Class: t.Name, Name: "", Ok: false, File: rel(t.File),
                            Line: 0, Ms: 0, Message: t.Error });
            else print(`  FAIL  ${t.Name}: ${t.Error}`);
            continue;
        }
        for (const name of testMethods(t.Class)) {
            const full = `${t.Name}.${name}`;
            if (!filter || full.includes(filter)) queue.push({ ...t, Method: name, Full: full });
        }
    }

    const was = Application.OnError;
    Application.OnError = (message, stack) => {
        if (testCurrent) testCurrent.fail({ message, stack });
        else print(`uncaught: ${message}`);
    };

    const finish = () => {
        Application.OnError = was;
        if (json) say({ Event: "Done", Passed: passed, Failed: failed });
        else print(`tests: ${passed} passed, ${failed} failed`);
        Application.Quit(failed ? 1 : 0);
    };

    const next = () => {
        const t = queue.shift();
        if (!t) return finish();

        const run = {
            waits: 0, over: false, error: null, from: monotonicNow(),
            fail(e) { if (!this.error) this.error = e; },
            waited() { this.waits--; if (this.waits === 0) done(); },
        };
        let instance = null;
        let ended = false;
        const done = () => {
            if (ended) return;
            ended = true;
            try { if (instance) instance.Teardown(); } catch (e) { run.fail(e); }
            run.over = true;
            testCurrent = null;

            const ms  = Math.round(monotonicNow() - run.from);
            const e   = run.error;
            const msg = e ? String(e.message || e) : "";
            const line = e ? testLine(e, t.File) : 0;
            if (e) failed++; else passed++;
            if (json) {
                say({ Event: "Test", Class: t.Name, Name: t.Method, Ok: !e, File: rel(t.File),
                      Line: line, Ms: ms, Message: msg });
            } else if (e) {
                print(`  FAIL  ${t.Full}: ${msg}${line ? ` (${rel(t.File)}:${line})` : ""}`);
            } else {
                print(`  ok    ${t.Full} (${ms} ms)`);
            }
            Timer.After(0, next);
        };

        testCurrent = run;
        try {
            instance = new t.Class();
            instance.Setup();
            instance[t.Method]();
        } catch (e) {
            run.fail(e);
        }
        if (run.waits === 0) done();
    };

    next();
}

/* ------------------------------------------------------------------------
 * Network.Probe -- finding a captive portal by asking, the way NetworkManager,
 * Android, Apple and Windows do.
 *
 * `Network.Connectivity` can say `"Portal"` only through NetworkManager with
 * its connectivity check on (docs/plans/network-plan.md, stage 0): netlink,
 * Windows and macOS cannot say it at all, and NM with the check off reports
 * FULL. This is the check itself, as a verb: a plain-HTTP request to a URL
 * that answers `204 No Content` and nothing else. A portal answers it with a
 * redirect to its sign-in page, or with that page; the internet answers 204.
 *
 * **A verb the program calls, never something done behind its back**: it
 * costs a request and it asks a third party. Google's `generate_204` is the
 * default because it answered fastest from the machine it was measured on;
 * `Url` takes any other endpoint that answers 204
 * (`http://connectivity-check.ubuntu.com/`, for one). Plain HTTP on purpose:
 * a portal cannot intercept HTTPS without breaking it, which is the point.
 * ---------------------------------------------------------------------- */
const PROBE_URL = "http://connectivitycheck.gstatic.com/generate_204";

/* A `Task` worker runs this file too and has no `Network` -- nor `Http` --
 * so the verb is put on it only where it exists. */
if (typeof Network !== "undefined") {

/**
 * asks whether the internet answers or a captive portal does instead, and
 * calls `callback({ Connectivity, Url, Why })`: `"Full"` (it answered 204),
 * `"Portal"` with `Url` the sign-in page (a redirect, or another page in its
 * place), `"Limited"` (an error status where the internet would have said
 * 204) or `"None"` with `Why` the `Http` error kind (`Dns`, `Timeout`,
 * `Refused`…). A plain-HTTP request to `Url` (default Google's
 * `generate_204`), which must answer `204`; `Timeout` in ms, default `5000`.
 * Needs `Http`
 * @param {function} callback
 * @param {{Url?: string, Timeout?: number}} [options]
 */
Network.Probe = function (callback, options) {
    if (typeof callback !== "function")
        throw new TypeError("Network.Probe(callback, [options]): callback is a function");
    const opts = options === undefined ? {} : options;
    if (opts === null || typeof opts !== "object")
        throw new TypeError("Network.Probe: options is an object, { Url, Timeout }");
    for (const k of ownKeys(opts))
        if (k !== "Url" && k !== "Timeout")
            throw new TypeError(`Network.Probe: no option called '${k}'; there are Url and Timeout`);
    const url     = opts.Url === undefined ? PROBE_URL : opts.Url;
    const timeout = opts.Timeout === undefined ? 5000 : opts.Timeout;
    if (typeof url !== "string" || !/^http:\/\//.test(url))
        throw new TypeError("Network.Probe: Url is a plain http:// address that answers 204 -- a portal cannot answer https");
    if (typeof timeout !== "number" || !(timeout >= 1))
        throw new RangeError("Network.Probe: Timeout is milliseconds, 1 or more");

    /* Its own client, because the one thing it must not do is follow the
     * redirect: the redirect is the answer. */
    const client = Http.Client({ FollowRedirects: false, Timeout: timeout });
    client.Get(url, {}, (r) => {
        if (r.Status === 204)
            return callback({ Connectivity: "Full", Url: "", Why: "" });
        if (r.Status >= 300 && r.Status < 400)
            return callback({ Connectivity: "Portal", Url: (r.Headers && r.Headers.location) || url, Why: "" });
        if (r.Status >= 200 && r.Status < 300)
            return callback({ Connectivity: "Portal", Url: url, Why: "" });
        callback({ Connectivity: "Limited", Url: "", Why: `HTTP ${r.Status}` });
    }, (e) => {
        callback({ Connectivity: "None", Url: "", Why: e.Kind || "Error" });
    });
};

}

/* ------------------------------------------------------------------------
 * Dictionary -- what a bag of data holds.
 *
 * `Object.keys` is the only member of the curated surface that reads like the
 * language underneath rather than like this one, and it is static for a reason
 * that has nothing to do with taste: **in JavaScript a dictionary and an object
 * are the same thing**, so the keys of the data and the names of the methods
 * share one namespace.  A `Keys` method would be inherited by every object in
 * the program and would collide with a bag that has an entry called `Keys` --
 * which is why Lua answers with `pairs(t)`, Perl with `keys %h`, and Clojure
 * with `(keys m)`.  Every language in which the dictionary *is* the general
 * object arrived at a function rather than a method.  The name is the only part
 * that was ours to choose.
 *
 * So: a module, the way Elixir's `Map.keys/1` and Tcl's `dict keys` are one.
 * `Dictionary` next to `Directory` is .NET's own arrangement -- it ships
 * `System.IO.Directory` and `System.Collections.Generic.Dictionary`, both in
 * view at once, and nobody has ever confused them.
 *
 * **The rule is that `for...in` recites and this counts.**  Reciting needs no
 * intermediary and allocates nothing, and it is what a `.form`'s properties are
 * applied with.  `Object.keys` was only ever written when an *array* was next:
 * a `.sort()`, a `.filter()`, a `.length`, a `new Set`.  Those are what this is
 * for, and `for (const key of Dictionary.Keys(o))` says the same thing twice.
 *
 * It answers about what an object **holds**, which is not what its class
 * declares.  A `Record`'s fields live in a private bag behind accessors on the
 * prototype, so a record holds nothing and answers `PropertyNames()`; the same
 * is true of a control.  That is the distinction a `.form` already makes between
 * `properties` -- held -- and `PropertyNames()` -- declared.
 *
 * Absent is empty, because `for...in` over nothing is already zero turns and
 * `Object.keys(null)` is a `TypeError`.  That asymmetry is where every
 * `Object.keys(node.properties || {})` in this repository came from, and it is
 * the ceremony this ends.  A number or a text, on the other hand, is refused:
 * `Object.keys("hola")` quietly answers `["0","1","2","3"]`, and a dictionary
 * that agreed to that would be wrong further downstream than here.
 *
 * One thing it cannot fix, so it is said out loud: a key that looks like a whole
 * number is not kept where it was put.  `{"10": …, "2": …, "Text": …}` recites
 * as `2, 10, Text` -- integer-like keys sort numerically and come first -- and
 * that happens in the object model, before anything here looks: `JSON.parse`
 * already hands the keys over moved.  When the keys are numbers the dictionary
 * is not the place, and `Map` is.
 * ---------------------------------------------------------------------- */

/*
 * The bag, or `null` for one that is not there -- and a complaint for something
 * that was never a bag at all, naming what it got, as every setter here does.
 *
 * A function passes: a class is an object that holds properties like any other,
 * and the IDE's completion asks exactly that of `File` and of `Timer`.
 */
function dictionaryBag(bag, verb) {
    if (bag === null || bag === undefined) return null;

    if (typeof bag !== "object" && typeof bag !== "function") {
        throw new TypeError(`Dictionary.${verb}: a dictionary is an object, got ` +
                            `${typeof bag} (${JSON.stringify(bag)})`);
    }
    return bag;
}

GLOBAL.Dictionary = {

    /** the keys */
    Keys(bag) {
        const held = dictionaryBag(bag, "Keys");
        return held ? ownKeys(held) : [];
    },

    /** the values */
    Values(bag) {
        const held = dictionaryBag(bag, "Values");
        return held ? ownKeys(held).map((key) => held[key]) : [];
    },

    /*
     * The pairs, each with its halves named -- `{ Key, Value }` and not
     * `[key, value]`.
     *
     * Which is what .NET's `KeyValuePair`, Java's `Map.Entry` and Smalltalk's
     * `Association` all are, and what this runtime already does everywhere it
     * hands back more than one thing: `File.Info`, `Bounds()`, `CheckSource`.
     * The cost is that it does not destructure, and it is paid in exactly one
     * place in this repository.
     */
    /** `[{ Key, Value }, …]` */
    Entries(bag) {
        const held = dictionaryBag(bag, "Entries");
        if (!held) return [];
        return ownKeys(held).map((key) => ({ Key: key, Value: held[key] }));
    },

    /** how many keys */
    Count(bag) {
        const held = dictionaryBag(bag, "Count");
        return held ? ownKeys(held).length : 0;
    },

    /*
     * Own keys only, which `key in bag` is not: `"toString" in {}` is true, and
     * a dictionary that answered that about a bag nobody put a `toString` in
     * would be answering about the prototype instead of about the data.
     */
    /** whether that key is there */
    Has(bag, key) {
        const held = dictionaryBag(bag, "Has");
        return held ? hasOwn.call(held, key) : false;
    },
};

/* ------------------------------------------------------------------------
 * Regex -- a pattern, with nothing remembered between questions.
 *
 * The engine is the engine's own `RegExp` -- `RegularExpression` below is the
 * capture that outlives the name, since `close_hatches` takes `RegExp` out of
 * the language -- and this is the only door to it.  `/x/g` is still syntax and
 * still produces one, which is why the name could go at all; what it buys is
 * that a pattern **built from strings** has one spelling and it is this one,
 * with the options below and not a flags string.  The same bargain Timer makes
 * with setInterval, completed.
 *
 * Three things change, and each one is a bug this repository has actually
 * written:
 *
 *   No lastIndex.  A `/g` pattern remembers where it stopped, so one object
 *   answers `test` true and then false depending on who asked before, and every
 *   walk over matches is a `while ((m = re.exec(text)))` that only holds
 *   together while nothing else touches the pattern.  `Matches()` hands back
 *   the whole list at once and nothing here remembers anything, which is why the
 *   same Regex can be a `const` at the top of a file -- the shape the IDE keeps
 *   rebuilding inside its loops to stay out of trouble.
 *
 *   Replace replaces all, as .NET's does.  The `g` that had to be remembered is
 *   not a flag any more.
 *
 *   Options are words: `{ IgnoreCase: true }` rather than `"gi"`, in the options
 *   object Exec, Dialog and SourceEditor.Search already take.  Two of them are
 *   not a plain flag.  `IgnorePatternWhitespace` is .NET's free spacing, which
 *   lets a pattern be laid out over several lines with comments in it, and is
 *   the only reason the long ones in the IDE have to be read as one string.
 *   `Unicode` is `u`: without it `\p{L}` does not fail, it matches the literal
 *   text `p{L}`, and `.` matches one half of an emoji -- the two answers worth
 *   having a word for.
 *
 * And `Escape`, which is the one that was missing rather than merely awkward:
 * the IDE builds patterns out of control names -- `\bBtnSave\b` -- and a control
 * is named by whoever draws the form, not by a compiler.
 *
 * What this is not is a second engine.  .NET's balancing groups, conditionals,
 * character-class subtraction and the `\A`/`\z` anchors are grammar RegExp does
 * not have, and inventing them here would be a parser rather than a word.
 * ---------------------------------------------------------------------- */

/* The engine, held the way GLOBAL and the timers are: whatever the language
 * decides to call itself, this file still needs the thing underneath. */
const RegularExpression = RegExp;

/* The options that are a flag, and what each one is.  `Unicode` is the `u` the
 * language's own `new RegExp(p, "u")` used to be the only way to reach -- and
 * it matters here beyond `.` on an astral character: `\p{L}` **compiles** in a
 * pattern without it and matches the literal text `p{L}`, which is a wrong
 * answer rather than a missing one. */
const REGEX_FLAGS = {
    IgnoreCase: "i",
    Multiline:  "m",
    Singleline: "s",
    Unicode:    "u",
};

/* ...and the one that is not: RegExp has no free-spacing mode, so it is done
 * here, to the pattern, before it is ever compiled. */
const REGEX_REWRITES = ["IgnorePatternWhitespace"];

/* Everything RegExp reads as syntax.  `/` is in it because a pattern escaped
 * here may well be written into a regular expression literal by hand. */
const REGEX_SYNTAX = ".*+?^$()[]{}|\\/";

/* Asked of one character at a time by Escape, so it carries no state to reset. */
const WHITESPACE = /\s/;

function regexFlags(options) {
    /* Always global: Matches walks with it and every method resets lastIndex
     * before it reads, so it is an implementation detail rather than a mode. */
    let flags = "g";

    /* `new Regex("x", "i")` is RegExp's spelling, and a string walked by
     * `for...in` is its indices -- so the refusal below used to say that '0'
     * is not an option, which named nothing the program wrote. */
    if (options !== undefined && options !== null
        && (typeof options !== "object" || Array.isArray(options)))
        throw new TypeError(`Regex: the options are an object, such as { IgnoreCase: true }, `
                            + `not ${JSON.stringify(options)}`);

    for (const key in options || {}) {
        /* Own keys: `"constructor" in REGEX_FLAGS` is true through
         * `Object.prototype`, and then `REGEX_FLAGS.constructor` -- which is a
         * function -- got appended to the flags, so the refusal the line below
         * exists for came out as a syntax error about garbage flags. */
        if (!hasOwn.call(REGEX_FLAGS, key) && !REGEX_REWRITES.includes(key)) {
            const takes = ownKeys(REGEX_FLAGS).concat(REGEX_REWRITES).join(", ");
            throw new RangeError(`Regex: '${key}' is not one of its options (${takes})`);
        }
        if (options[key] && REGEX_FLAGS[key]) flags += REGEX_FLAGS[key];
    }
    return flags;
}

/*
 * Free spacing: whitespace and `# comments` dropped from the pattern.
 *
 * Inside a character class a space is a space -- that is what .NET does too,
 * and a class is short enough to read without help.  An escape carries its next
 * character through untouched, so `\ ` and `\#` are how either is meant
 * literally.
 */
function freeSpacing(pattern) {
    let out     = "";
    let inClass = false;

    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];

        if (c === "\\" && i + 1 < pattern.length) {
            out += c + pattern[i + 1];
            i++;
            continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;

        if (!inClass) {
            if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
            if (c === "#") {
                while (i < pattern.length && pattern[i] !== "\n") i++;
                continue;
            }
        }
        out += c;
    }
    return out;
}

function escapedChar(c) {
    if (REGEX_SYNTAX.includes(c)) return `\\${c}`;

    /*
     * `#` and whitespace as a hex escape rather than a backslash: an escaped
     * name has to survive being dropped into an IgnorePatternWhitespace pattern,
     * where both would otherwise be thrown away -- and `\ ` is not something
     * every position in a pattern accepts.
     */
    const code = c.charCodeAt(0);
    return code < 256 ? `\\x${code.toString(16).padStart(2, "0")}`
                      : `\\u${code.toString(16).padStart(4, "0")}`;
}

/* A group by number, longest run of digits that names one -- `$12` where there
 * are two groups is group 1 followed by a literal 2, which is what .NET reads
 * and what anyone writing it meant. */
function numberedGroup(spec, at, match) {
    let digits = "";
    for (let i = at; i < spec.length && spec[i] >= "0" && spec[i] <= "9"; i++) {
        digits += spec[i];
    }
    while (digits.length > 1 && Number(digits) >= match.Groups.length) {
        digits = digits.slice(0, -1);
    }
    return digits;
}

/*
 * A replacement, filled in: `$1`, `${name}`, `$&`, `` $` ``, `$'` and `$$`.
 *
 * .NET's spelling and not JavaScript's -- `${name}` rather than `$<name>` --
 * which is why this is expanded here rather than handed to String.replace: a
 * translation between the two would be a second syntax to get wrong, and the
 * matches are already in hand.
 */
function expandReplacement(spec, match, subject) {
    let out = "";

    for (let i = 0; i < spec.length; i++) {
        const c    = spec[i];
        const next = spec[i + 1];

        if (c !== "$") { out += c; continue; }

        if (next === "$")  { out += "$";                                    i++; continue; }
        if (next === "&")  { out += match.Value;                            i++; continue; }
        if (next === "`")  { out += subject.slice(0, match.Index);          i++; continue; }
        if (next === "'")  { out += subject.slice(match.Index + match.Length); i++; continue; }

        if (next === "{") {
            const end = spec.indexOf("}", i + 2);
            if (end > 0) {
                out += match.Group(spec.slice(i + 2, end));
                i = end;
                continue;
            }
        }
        if (next >= "0" && next <= "9") {
            const digits = numberedGroup(spec, i + 1, match);
            out += match.Group(Number(digits));
            i += digits.length;
            continue;
        }

        /* A `$` that names nothing is a `$`. */
        out += c;
    }
    return out;
}

/*
 * One match: what was found, where, and what its groups caught.
 *
 * Not a global -- the language gains one name here, and it is `Regex`.  This is
 * what its answers look like, the way `File.Info` hands back a record nobody has
 * to name either.
 *
 * A group that did not take part reads `""`, which is the same answer this
 * runtime gives everywhere else for *there is none* (`Locale.Current`,
 * `Application.Version`, `File.Extension`).  Telling that apart from a group
 * that matched nothing is a question about the pattern, not about the match.
 */
class Match {

    #named;

    constructor(found) {
        this.Value  = found[0];
        this.Index  = found.index;
        this.Length = found[0].length;

        /* Numbered as .NET numbers them: Groups[0] is the whole match, so
         * Groups[1] is the first thing in parentheses. */
        this.Groups = [];
        for (let i = 0; i < found.length; i++) {
            this.Groups.push(found[i] === undefined ? "" : found[i]);
        }
        this.#named = found.groups || {};
    }

    /* By number or by name -- `(?<name>...)` -- since both are groups and a
     * caller should not need a different door for each. */
    /**
     * a group's text, by number or by name; `""` for one that did not take part
     */
    Group(which) {
        if (typeof which === "number") {
            return which >= 0 && which < this.Groups.length ? this.Groups[which] : "";
        }
        const found = this.#named[which];
        return found === undefined ? "" : found;
    }
}

GLOBAL.Regex = class Regex {

    #re;
    #pattern;
    #unicode;

    constructor(pattern, options) {
        const written = String(pattern);
        const flags   = regexFlags(options);
        const source  = options && options.IgnorePatternWhitespace
            ? freeSpacing(written) : written;

        try {
            this.#re = new RegularExpression(source, flags);
        } catch (e) {
            /* The pattern as it was *written*: under free spacing the text that
             * failed to compile is not the text anyone can go and look at. */
            throw new SyntaxError(`Regex: ${e.message} -- in ${JSON.stringify(written)}`);
        }
        this.#pattern = written;
        this.#unicode = flags.includes("u");
    }

    /* What it was built from, for whoever has to report it. */
    /** the pattern, as it was written */
    get Pattern() { return this.#pattern; }

    /** whether it matches at all */
    IsMatch(text) {
        this.#re.lastIndex = 0;
        return this.#re.test(String(text));
    }

    /* The first match at or after `start`, or `null`. */
    /** the first match at or after `start`, or `null` */
    Match(text, start = 0) {
        this.#re.lastIndex = Math.max(0, start);
        const found = this.#re.exec(String(text));
        return found ? new Match(found) : null;
    }

    /** every match, for a `for…of` */
    Matches(text) {
        const subject = String(text);
        const out     = [];

        this.#re.lastIndex = 0;
        for (let found = this.#re.exec(subject); found; found = this.#re.exec(subject)) {
            out.push(new Match(found));

            /* A pattern that can match nothing ("x*") would otherwise never
             * move -- the same step bta_editor.c takes when it counts.  Under
             * `u` it moves by a **code point**, which is what
             * `Symbol.matchAll` does: stepping onto a low surrogate would ask
             * the next match to start in the middle of a character. */
            if (found[0] === "") {
                const at = this.#re.lastIndex;
                const hi = subject.charCodeAt(at);
                const lo = subject.charCodeAt(at + 1);

                this.#re.lastIndex += this.#unicode &&
                                      hi >= 0xD800 && hi <= 0xDBFF &&
                                      lo >= 0xDC00 && lo <= 0xDFFF ? 2 : 1;
            }
        }
        return out;
    }

    /*
     * Every match replaced, by a text or by what a function makes of each one.
     *
     * All of them by default, with no flag to say so, because a Replace that did
     * one was never what anybody meant by the word -- and `count` when one is
     * exactly what was meant, which is .NET's own overload.  The IDE moves a
     * class between namespaces by rewriting its *declaration*, and a comment
     * further down that happens to name it is not a second declaration.
     *
     * The function is handed the `Match` rather than JavaScript's list of
     * arguments, whose shape depends on how many groups the pattern happens to
     * have.  So a function declaring a second parameter -- `(m, g1) =>`, which
     * is the habit JavaScript teaches -- is refused before anything runs: its
     * `g1` would be `undefined` and the word would be written into the result,
     * once per match and with nothing said.  And an answer that is not text or
     * a number is refused naming the match, for the same reason: `(m) => {}`
     * wrote "undefined" in place of every one.
     */
    /**
     * the text with the matches replaced. **All of them** unless a count says
     * how many. The replacement is a text (`$1`, `${name}`, `$&`, `$$`) or a
     * function handed **one argument, the `Match`** -- a group is
     * `m.Groups[1]`, not a second parameter -- that answers text or a number;
     * a function declaring more parameters, or answering anything else, is
     * refused
     */
    Replace(text, replacement, count) {
        const subject = String(text);
        let   matches = this.Matches(subject);
        if (count !== undefined) matches = matches.slice(0, Math.max(0, count));
        if (matches.length === 0) return subject;

        const evaluate = typeof replacement === "function"
            ? replacement : null;
        if (evaluate && evaluate.length > 1)
            throw new TypeError("Regex.Replace: the function is handed one argument, the Match "
                                + "-- a group is m.Groups[1], not a second parameter");
        const spec = evaluate ? "" : String(replacement);

        let out = "";
        let at  = 0;

        for (const match of matches) {
            out += subject.slice(at, match.Index);
            if (evaluate) {
                const made = evaluate(match);
                if (typeof made !== "string" && typeof made !== "number")
                    throw new TypeError(`Regex.Replace: the function answered ${made === null ? "null" : typeof made} `
                                        + `for '${match.Value}' at ${match.Index}; it answers text or a number`);
                out += String(made);
            } else {
                out += expandReplacement(spec, match, subject);
            }
            at = match.Index + match.Length;
        }
        return out + subject.slice(at);
    }

    /* What the matches separate.  Captured groups land in the result too, which
     * is .NET's answer and the useful one: it is how a split keeps what it split
     * on. */
    /** the pieces between the matches */
    Split(text) {
        const subject = String(text);
        const out     = [];
        let   at      = 0;

        for (const match of this.Matches(subject)) {
            out.push(subject.slice(at, match.Index));
            for (let i = 1; i < match.Groups.length; i++) out.push(match.Groups[i]);
            at = match.Index + match.Length;
        }
        out.push(subject.slice(at));
        return out;
    }

    /*
     * A text as a literal inside a pattern.
     *
     * The one that was missing.  Every pattern built around a name the program
     * did not choose needs this -- the IDE renames a control by looking for
     * `\bButton1\b` in its source, and a control called `a.b` is a pattern that
     * matches something else, while one called `Btn(` does not compile at all.
     */
    /** the text as a **literal** inside a pattern */
    static Escape(text) {
        let out = "";
        for (const c of String(text)) {
            out += REGEX_SYNTAX.includes(c) || c === "#" || WHITESPACE.test(c)
                ? escapedChar(c) : c;
        }
        return out;
    }
};

/* ------------------------------------------------------------------------
 * Namespaces -- a folder's worth of classes under one name.
 *
 *   Namespace("Widgets");
 *   Widgets.Stepper = class Stepper extends Component { ... };
 *
 * A namespace is an ordinary object on the global object and nothing more: no module
 * system, no imports, no compile step.  What it buys is that two folders may
 * each have a Stepper, since what a .form names is "Widgets.Stepper" and the
 * loader walks those properties.
 *
 * The namespace is declared by the code and not deduced from the directory:
 * the runtime obeys what the file says.  The IDE keeps folder and namespace in
 * step because that is a sane convention, not because anything requires it.
 * ---------------------------------------------------------------------- */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/* Every namespace object ever declared, with the name it goes by.  Small by
 * construction -- one entry per namespace, not per class. */
const namespaces = [];

/**
 * the object at that dotted path, created level by level when it is not there:
 * `Namespace("A.B")` makes both
 */
GLOBAL.Namespace = function (path) {
    const parts = String(path).split(".");
    if (!parts.length || !parts.every((p) => IDENTIFIER.test(p))) {
        throw new TypeError(`"${path}" is not usable as a namespace`);
    }

    let here = GLOBAL;
    let name = "";

    for (const part of parts) {
        if (!here[part]) here[part] = {};
        here = here[part];
        name = name ? `${name}.${part}` : part;

        /* Every level, not just the last: `Namespace("A.B")` also makes A a
         * place where a class can legitimately be put. */
        if (!namespaces.some((ns) => ns.obj === here)) namespaces.push({ name, obj: here });
    }
    return here;
};

/*
 * One bare instance per class, to compare against.  Keyed by the constructor
 * itself and not by its name: two namespaces may each hold a Stepper, and
 * keying by name would hand one class the other's defaults.
 */
const defaultsByClass = new Map();

function defaultsFor(ctor) {
    let bare = defaultsByClass.get(ctor);
    if (!bare) {
        bare = new ctor();
        defaultsByClass.set(ctor, bare);
    }
    return bare;
}

function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    /*
     * Two decimals are the same when they say the same thing.  `===` on them is
     * object identity -- the one operator the engine patch deliberately does not
     * touch, since giving it a meaning would change what identity is for every
     * object -- so the serialiser would otherwise write every decimal field on
     * every save, each one "different" from its own default.
     */
    if (a instanceof Decimal || b instanceof Decimal) {
        return a instanceof Decimal && b instanceof Decimal &&
               `${a}` === `${b}`;
    }
    return a === b;
}

/* What a bytes field starts from: no bytes at all, shared because a `Bytes` is
 * immutable. Declared before the table that uses it: a `const` is not hoisted,
 * and `FIELD_KINDS` is built the moment this file is read. */
const EMPTY_BYTES = new Bytes();

const FIELD_KINDS = {
    text:   { def: "",    takes: ["required", "max"] },
    int:    { def: 0,     takes: ["required", "min", "max"] },
    number: { def: 0,     takes: ["required", "min", "max", "decimals"] },
    /* `def` is filled in by Field.Decimal, which is the only one that knows how
     * many places this field has. */
    decimal: { def: null, takes: ["required", "min", "max"] },
    bool:   { def: false, takes: [] },
    date:   { def: "",    takes: ["required"] },
    /*
     * A file, held as bytes. `max` is in bytes, which is what an attachment
     * field means by a limit -- and the default is **one shared empty value**,
     * which is safe because a `Bytes` cannot be changed: there is no `Set`, no
     * resize, and every operation answers a new one. A mutable default would
     * have to be built per field, per record, the way `list` is.
     */
    bytes:  { def: EMPTY_BYTES, takes: ["required", "max"] },
    /* A time of day, and `min`/`max` because a schedule is exactly where a
     * range means something: an appointment field that opens at 08:00 and
     * closes at 20:00 is two options rather than two lines of handwritten
     * validation. They compare as text, which is what "HH:MM" is for. */
    time:   { def: "",    takes: ["required", "min", "max"] },
    /*
     * A date and a time together, which is what an XML `dateTime` is and what
     * neither of the two above can say: `2026-09-01T08:00:00`. It holds
     * `YYYY-MM-DDTHH:MM` or `...:SS`, seconds optional, compared as text the
     * way `time` is; an offset or a fraction is refused rather than half-kept,
     * and arrives with the first format that has one.
     */
    datetime: { def: "",  takes: ["required", "min", "max"] },
    list:   { def: [],    takes: ["required", "max"] },
    enum:   { def: "",    takes: ["required"] },
    /*
     * A record inside a record.  It starts at **null** -- absent -- and not at
     * an empty one, which is what lets a shape contain itself: a menu item
     * whose children are menu items would otherwise build one forever, at the
     * declaration and again at every construction.  Null is also what a file
     * means, where absent and empty are different things: a `.form` node
     * without `children` has none.
     *
     * `def` is how a record that always has one says so, and it is the ordinary
     * common option doing its ordinary job -- see Field.Record.
     */
    record: { def: null,  takes: ["required"] },
};

/*
 * `as` is the name in the file when it differs; `def` the value it starts at;
 * `key` marks a field as the record's identity.
 *
 * `key` is on the **shape** and not on the source, because identity belongs to
 * the customer and not to the table it happens to be stored in: the same
 * `Customer` read from `customers` and from `customers_archive` is identified
 * the same way, and a JSON file of customers has an id too.  More than one
 * marked is a compound key, in declaration order.
 *
 * And one thing falls out of it rather than needing to be said: for `Table`, an
 * `int` key at **0** -- what the kind starts from -- is a row that has not been
 * saved yet, so nothing needs a flag to tell an INSERT from an UPDATE.  XML is
 * the other medium and does not share it: there is no INSERT to assign a key,
 * so `<UID>0</UID>` is an item with key 0 and `#xmlKeyText` matches it.
 */
const FIELD_COMMON = ["as", "def", "key"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/* `YYYY-MM-DDTHH:MM` or `...:SS`, with `Z` or `±HH:MM` when the moment has a
 * zone.  A fraction of a second is not accepted: nothing here reads one and
 * half a value is worse than none. */
const ISO_DATETIME =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
/* And the zone alone, because min/max compare as text and a text order over
 * moments is a wrong answer that looks right. */
const ZONED = /(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/* What XML spells a number with: a dot and never the desktop's comma, since
 * this reads a file and not a person. */
const XML_WHOLE = /^-?\d+$/;
const XML_DEC   = /^-?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
/* `"HH:MM"` or `"HH:MM:SS"`, and nothing looser: a value that is sometimes five
 * characters and sometimes four does not sort, and sorting is most of what a
 * time held as text is for. The same rule the `Time` global parses by. */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;


/*
 * What a field is called in a file.  One name per field and the *convention* per
 * record: JSON in camelCase and SQL in snake_case is a rule about a codec, not a
 * decision about a field, so it is said once instead of on every line.  `as` is
 * the exception, for the field the rule does not fit.
 *
 * `snake` has no user yet: it is SQL's spelling, and reading records out of a
 * database is designed but not built (docs/plans/data-plan.md).  Kept rather
 * than removed because it is one line of the rule it belongs to, and it is what
 * says the rule was meant to hold more than one codec.
 */
const NAMINGS = {
    same:  (name) => name,
    lower: (name) => name.toLowerCase(),
    snake: (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
};

/* A fresh array per record: one shared between them is a bug that surfaces as
 * two records quietly editing each other.  A record field's `def` is the same
 * hazard one step further -- it is a *seed*, built into its own record here
 * rather than handed out. */
function freshDefault(field) {
    if (field.kind === "record") {
        return field.def === null || field.def === undefined
             ? null : new (recordClass(field))(field.def);
    }
    return Array.isArray(field.def) ? field.def.slice() : field.def;
}

/* A Record subclass, told apart from anything else by the chain it hangs on --
 * the same walk #fieldsOf makes to merge a subclass's fields into its parent's.
 * A thunk is a function too, and this is what distinguishes the two. */
function isRecordClass(v) {
    if (typeof v !== "function") return false;
    for (let c = v; c; c = prototypeOf(c)) if (c === GLOBAL.Record) return true;
    return false;
}

/*
 * The class a record field holds.
 *
 * Written as the class itself, or as a thunk for a shape that contains itself:
 * inside a class body the class is not bound yet, so `Field.List(MenuItem)`
 * within `MenuItem` is a ReferenceError and `Field.List(() => MenuItem)` is
 * not.  A thunk is resolved the first time the field is used -- always after
 * the declaration finished -- and remembered.
 */
function recordClass(field) {
    if (field.of) return field.of;

    const got = field.make();
    if (!isRecordClass(got))
        throw new TypeError("Field.Record: the thunk answered with something " +
                            "that is not a Record");
    field.of = got;
    return got;
}

function fieldName(kind) {
    return `Field.${kind[0].toUpperCase()}${kind.slice(1)}`;
}

/* The same field minus one of its rules, for the one check that has to ignore
 * `required`: what a field *starts from* is empty by definition, and a required
 * field that complained about its own default could never be declared. */
function fieldWithout(field, rule) {
    const out = {};
    for (const key in field) if (key !== rule) out[key] = field[key];
    return out;
}

function makeField(kind, opts, extra) {
    const spec  = FIELD_KINDS[kind];
    const field = { __field: true, kind, def: spec.def };

    /*
     * The XML mapping's four options live where they can mean something:
     * `attribute` and `always` on a value, and `in`/`element` on a list.  A
     * record's element name is its class's `Xml.Root` (`as` overrides it), and
     * a list of records takes its item name from the same place, so neither is
     * an option here.
     */
    const common = FIELD_COMMON.slice();
    if (kind !== "record" && kind !== "list") common.push("attribute", "always");
    if (kind === "list") common.push("in", "element");

    for (const key in opts || {}) {
        if (!common.includes(key) && !spec.takes.includes(key)) {
            const takes = common.concat(spec.takes).join(", ");
            throw new RangeError(`${fieldName(kind)}: '${key}' is not one of ` +
                                 `its options (${takes})`);
        }
        field[key] = opts[key];
    }

    if (field.attribute !== undefined && field.attribute !== true)
        throw new TypeError(`${fieldName(kind)}: 'attribute' is true or it is ` +
                            `not written`);
    if (field.always !== undefined && field.always !== true)
        throw new TypeError(`${fieldName(kind)}: 'always' is true or it is ` +
                            `not written`);
    if (field.in !== undefined && (typeof field.in !== "string" || !field.in))
        throw new TypeError(`${fieldName(kind)}: 'in' is the wrapper element's ` +
                            `name`);
    if (field.element !== undefined &&
        (typeof field.element !== "string" || !field.element))
        throw new TypeError(`${fieldName(kind)}: 'element' is the item ` +
                            `element's name`);

    for (const key in extra || {}) field[key] = extra[key];
    return field;
}

/*
 * The value a field accepts, or a throw saying what is wrong with the one it was
 * given -- the same bargain every setter in this runtime makes, and the reason a
 * record can be trusted by whoever reads it next.
 */
/*
 * `notes`, when given, collects what was taken and changed on the way in --
 * which is only ever a decimal rounded to its field's places.  Load passes one
 * and reports them; an assignment passes none, since a program that assigns a
 * sum to a two-place field means the rounding, and a file did not decide it.
 */
function fieldValue(field, name, v, mayBeEmpty, notes) {
    /* Absent is not a value: it is the field at what it starts from, which is
     * also what a file without the key means. */
    if (v === undefined || v === null) {
        if (field.required && !mayBeEmpty) throw new RangeError(`${name} is required`);
        return freshDefault(field);
    }
    if (mayBeEmpty) field = fieldWithout(field, "required");

    switch (field.kind) {
    case "text":
        if (typeof v !== "string")
            throw new TypeError(`${name}: expected text, got ${typeof v}`);
        if (field.required && v === "")
            throw new RangeError(`${name} is required`);
        if (field.max !== undefined && v.length > field.max)
            throw new RangeError(`${name}: ${field.max} characters at most, ` +
                                 `got ${v.length}`);
        return v;

    case "int":
    case "number": {
        if (typeof v !== "number" || !Number.isFinite(v))
            throw new TypeError(`${name}: expected a number, got ${JSON.stringify(v)}`);
        if (field.kind === "int" && !Number.isInteger(v))
            throw new RangeError(`${name}: expected a whole number, got ${v}`);

        /* Rounded to what it holds, as a SpinBox is: a value read back has to
         * agree with the value that was set.  The double is what is rounded,
         * on purpose -- 1.005 comes out 1 -- and the JSDoc on Field.Number
         * says so; Field.Decimal is the field that rounds what was written. */
        let out = v;
        if (field.decimals !== undefined) {
            const scale = Math.pow(10, field.decimals);
            out = Math.round(v * scale) / scale;
        }
        if (field.min !== undefined && out < field.min)
            throw new RangeError(`${name}: ${field.min} at least, got ${out}`);
        if (field.max !== undefined && out > field.max)
            throw new RangeError(`${name}: ${field.max} at most, got ${out}`);
        return out;
    }

    case "decimal": {
        /*
         * Text, a number or a decimal, and all three end up exact at the
         * field's own scale.  Text is the one that matters: it is what a
         * `TextBox` hands over and what a file holds, and it is the only road
         * into a decimal that never passes through a double -- which is where
         * `1.005` would stop being 1.005.
         */
        let out;
        try {
            out = new Decimal(v, field.places);
        } catch (e) {
            throw new RangeError(`${name}: ${e.message.replace("Decimal: ", "")}`);
        }
        /* Comparisons on decimals are the operators, which is the whole point of
         * the type: `min` and `max` may be written as text in the declaration
         * and still read as numbers here. */
        if (field.required && out.Sign === 0)
            throw new RangeError(`${name} is required`);
        if (field.min !== undefined && out < new Decimal(field.min))
            throw new RangeError(`${name}: ${field.min} at least, got ${out}`);
        if (field.max !== undefined && out > new Decimal(field.max))
            throw new RangeError(`${name}: ${field.max} at most, got ${out}`);
        /* A value with more places than the field is rounded to them, which
         * is the field's scale doing its job -- and a file that said 19.999
         * now says 20.00 at the next save.  Said, so Problems keeps its
         * promise; kept rounded, since 20.00 is a thousandth away and the
         * default is not.  The exact value can always be made here: what
         * would refuse it (past nine places, not a number) refused above. */
        if (notes) {
            const exact = new Decimal(v);
            if ((exact - out).Sign !== 0)
                notes.push(`${name}: ${v} has ${exact.Scale} decimal places, the field `
                           + `${field.places} -- rounded to ${out}`);
        }
        return out;
    }

    case "bool":
        /* The two spellings a boolean really has: JSON writes one, and SQL --
         * which has no boolean at all -- writes the other. */
        if (typeof v === "boolean") return v;
        if (v === 0 || v === 1)     return v === 1;
        throw new TypeError(`${name}: expected true or false, ` +
                            `got ${JSON.stringify(v)}`);

    case "date": {
        if (typeof v !== "string")
            throw new TypeError(`${name}: expected a date as text, got ${typeof v}`);
        if (v === "") {
            if (field.required) throw new RangeError(`${name} is required`);
            return v;
        }
        const parts = ISO_DATE.exec(v);
        if (!parts)
            throw new RangeError(`${name}: '${v}' is not a date (expected YYYY-MM-DD)`);

        /* A date that reads as one and is not: February the 30th parses and then
         * comes back as March. */
        const y = +parts[1], m = +parts[2], d = +parts[3];
        const when = new Date(y, m - 1, d);
        if (when.getFullYear() !== y || when.getMonth() !== m - 1 ||
            when.getDate() !== d)
            throw new RangeError(`${name}: '${v}' is not a date`);
        return v;
    }

    case "time": {
        if (typeof v !== "string")
            throw new TypeError(`${name}: expected a time as text, got ${typeof v}`);
        if (v === "") {
            if (field.required) throw new RangeError(`${name} is required`);
            return v;
        }
        if (!CLOCK.test(v))
            throw new RangeError(`${name}: '${v}' is not a time ` +
                                 `(expected HH:MM or HH:MM:SS)`);
        /* Compared as text, which is the whole reason the shape is fixed:
         * "09:30" < "17:00" is true by the same string order a `Day` uses, so
         * `min`/`max` need no parsing and no clock arithmetic. */
        if (field.min !== undefined && v < field.min)
            throw new RangeError(`${name}: ${field.min} at the earliest, got ${v}`);
        if (field.max !== undefined && v > field.max)
            throw new RangeError(`${name}: ${field.max} at the latest, got ${v}`);
        return v;
    }

    case "datetime": {
        if (typeof v !== "string")
            throw new TypeError(`${name}: expected a date and time as text, ` +
                                `got ${typeof v}`);
        if (v === "") {
            if (field.required) throw new RangeError(`${name} is required`);
            return v;
        }

        const parts = ISO_DATETIME.exec(v);
        if (!parts)
            throw new RangeError(`${name}: '${v}' is not a date and time ` +
                                 `(expected YYYY-MM-DDTHH:MM[:SS], with an ` +
                                 `optional Z or ±HH:MM)`);

        /* A timestamp that reads as one and is not: February the 30th parses
         * and then comes back as March, exactly as `date` says. */
        const y = +parts[1], m = +parts[2], d = +parts[3];
        const when = new Date(y, m - 1, d);
        if (when.getFullYear() !== y || when.getMonth() !== m - 1 ||
            when.getDate() !== d)
            throw new RangeError(`${name}: '${v}' is not a date`);

        /*
         * Text order, and without a zone it holds across the optional
         * seconds: "08:00" is before "08:00:01" as a string and as a moment.
         * **With one it does not** -- 09:00+02:00 is 07:00Z, which is earlier
         * than 08:00Z and later than 08:00 as text -- so a range and a zone
         * are refused together rather than answered wrongly.  Comparing
         * instants is the program's, where the value means something.
         */
        if (field.min !== undefined || field.max !== undefined) {
            if (ZONED.test(v) ||
                (field.min !== undefined && ZONED.test(field.min)) ||
                (field.max !== undefined && ZONED.test(field.max)))
                throw new RangeError(`${name}: min/max compare local text, and ` +
                                     `'${v}' is a moment -- a text order is not ` +
                                     `a time order, so keep the range in the ` +
                                     `program`);
            if (field.min !== undefined && v < field.min)
                throw new RangeError(`${name}: ${field.min} at the earliest, ` +
                                     `got ${v}`);
            if (field.max !== undefined && v > field.max)
                throw new RangeError(`${name}: ${field.max} at the latest, ` +
                                     `got ${v}`);
        }
        return v;
    }

    case "bytes": {
        /*
         * **A string here is base64**, and that is not a convenience: it is what
         * this field wrote. `Serialize` puts a `Bytes` out as base64 because
         * that is the one shape a JSON file can carry, so reading the file back
         * hands a string to the field that produced it, and it has to be the
         * same value again. Anything else is refused rather than coerced --
         * `new Bytes(text)` is how text becomes bytes, and it says so.
         */
        let bytes = v;

        if (typeof v === "string") {
            if (v === "") {
                if (field.required) throw new RangeError(`${name} is required`);
                return EMPTY_BYTES;
            }
            try {
                bytes = Bytes.FromBase64(v);
            } catch (e) {
                throw new RangeError(`${name}: that is not base64`);
            }
        }

        if (!(bytes instanceof Bytes))
            throw new TypeError(`${name}: expected a Bytes, got ${typeof v}`);
        if (field.required && bytes.Length === 0)
            throw new RangeError(`${name} is required`);
        if (field.max !== undefined && bytes.Length > field.max)
            throw new RangeError(`${name}: ${field.max} bytes at most, ` +
                                 `got ${bytes.Length}`);
        return bytes;
    }

    case "enum":
        if (!field.options.includes(v))
            throw new RangeError(`${name}: '${v}' is not one of ` +
                                 `${field.options.join(", ")}`);
        return v;

    case "record": {
        const of = recordClass(field);

        if (v instanceof of) return v;
        if (typeof v === "object" && !Array.isArray(v)) {
            /*
             * A plain object goes in through the child's own setters, so
             * `q.Address = { City: "" }` is refused here with the sentence
             * `City` wrote: **assignment is strict**, one level down exactly as
             * it is one level up.  The lenient road into a child is Load, and
             * it is Load that takes it.
             */
            try {
                return new of(v);
            } catch (e) {
                e.message = `${name}.${e.message}`;
                throw e;
            }
        }
        throw new TypeError(`${name}: expected ${of.name}, got ${typeof v}`);
    }

    default: {                                     /* list */
        if (!Array.isArray(v))
            throw new TypeError(`${name}: expected a list, got ${typeof v}`);
        if (field.required && v.length === 0)
            throw new RangeError(`${name} is required`);
        if (field.max !== undefined && v.length > field.max)
            throw new RangeError(`${name}: ${field.max} entries at most, ` +
                                 `got ${v.length}`);
        return v.map((item, i) => {
            /*
             * A list of records has no absent entries -- it has fewer.  Null
             * would leave a hole in the array that every loop over it trips
             * on, whereas a null *text* is harmless because a text field
             * starts at "".  The asymmetry is not invented here: it falls out
             * of the defaults, since a record field is the one whose own
             * starting value is null.
             */
            if (field.item.kind === "record" && (item === null || item === undefined))
                throw new TypeError(`${name}[${i}]: expected ` +
                                    `${recordClass(field.item).name}, got ` +
                                    `${item === null ? "null" : "nothing"}`);
            return fieldValue(field.item, `${name}[${i}]`, item, false, notes);
        });
    }
    }
}

GLOBAL.Field = {
    /*
     * The kinds a field can be, by the name a `.record` file spells: `text`,
     * `int`, `number`, `decimal`, `bool`, `date`, `time`, `datetime`, `bytes`,
     * `list`, `enum`, `record`.  A dialog that edits a shape offers them from
     * here, so a kind added to this table appears there with no other change --
     * and this is the same list a refusal names when a spec misspells one.
     */
    /**
     * every kind a field can be, by name
     */
    Kinds: () => ownKeys(FIELD_KINDS).slice(),

    /*
     * A field from the object a `.record` file holds for one -- the same road
     * the file's loader takes (`fieldOfSpec`), published so a program can build
     * or check a spec, and so a dialog that edits a shape asks the runtime
     * rather than keeping a second copy of the rules.
     */
    /**
     * a field from the object a `.record` file holds for one, refusing what a
     * class body refuses
     */
    Spec: (spec) => fieldOfSpec(spec, "Field.Spec"),

    /** a string. Options: `required`, `max` (characters) */
    Text:     (opts) => makeField("text",     opts),
    /** a whole number. Options: `required`, `min`, `max` */
    Int:      (opts) => makeField("int",      opts),
    /**
     * a number. Options: `required`, `min`, `max`, `decimals`. **`decimals`
     * rounds the double**, as `Math.round(v * 10^n) / 10^n` does, so a value
     * whose double sits below the half rounds down: `1.005` comes out `1` and
     * `8.575` comes out `8.57`, where `Decimal("1.005").Round(2)` is `1.01`. An
     * amount that has to round the way it is written is a `Field.Decimal`
     */
    Number:   (opts) => makeField("number",   opts),
    /** `"YYYY-MM-DD"`, checked against the calendar. Options: `required` */
    Date:     (opts) => makeField("date",     opts),
    /** `"HH:MM"` or `"HH:MM:SS"`. Options: `required`, `min`, `max` */
    Time:     (opts) => makeField("time",     opts),
    /**
     * `"YYYY-MM-DDTHH:MM"` or `"...:SS"` — a date and a time — with `Z` or
     * `+HH:MM` when the moment has a zone, kept as written. Options:
     * `required`, `min`, `max` (local time only)
     */
    DateTime: (opts) => makeField("datetime", opts),
    /**
     * a [`Bytes`](docs/reference/globals/Bytes.md) — a file in a record.
     * Options: `required`, `max` (bytes)
     */
    Bytes:    (opts) => makeField("bytes",    opts),

    /* The default first, because it is the whole of what a boolean field says. */
    /** `true`/`false`, and SQL's `0`/`1`; `def` is where it starts */
    Bool: (def, opts) => makeField("bool", opts, { def: def === true }),

    /* The values it accepts, which is also what PropertyOptions hands to
     * whoever is editing it -- the same thing BTA_CLASS_ENUM does in C, and for
     * the same reason: the list cannot drift from what the setter takes. */
    /** one of `values`, starting at `def`. Options: `required` */
    Enum: (values, def, opts) => {
        if (!Array.isArray(values) || values.length === 0)
            throw new TypeError("Field.Enum: expected a list of values");
        /* A default outside the list is a field nothing can read without
         * complaining, and it would go unnoticed until something did. */
        if (def !== undefined && !values.includes(def))
            throw new RangeError(`Field.Enum: '${def}' is not one of ` +
                                 `${values.join(", ")}`);
        return makeField("enum", opts, {
            options: values.slice(),
            def: def !== undefined ? def : values[0],
        });
    },

    /*
     * A field with a fixed number of decimal places, held exactly.
     *
     * `Field.Decimal({ decimals: 2 })` is a money field -- there is no separate
     * `Money`, because money *is* a decimal with two places and saying so is one
     * word rather than a second name for the same thing.
     *
     * The places are the field's and not the value's: a column of prices all
     * show two, so `19.9` arriving from anywhere becomes `19.90` and a total is
     * not a ragged column.  It is what `NUMERIC(12,2)` means in a database and
     * what the `decimals` of a `.form` will mean when a control is bound to one.
     */
    /**
     * a [`Decimal`](docs/reference/globals/Decimal.md) at a fixed scale.
     * Options: `required`, `min`, `max`, `decimals` (2 by default), `def`
     * (rounded to those places). A value
     * with more places is **rounded** to them, away from zero: an assignment
     * does it in silence, and `Load` says so in `Problems` (`Price: 19.999
     * has 3 decimal places, the field 2 -- rounded to 20.00`), since the next
     * save writes the rounded value over the file's
     */
    Decimal: (opts) => {
        const places = opts && opts.decimals !== undefined ? opts.decimals : 2;
        const rest   = {};

        for (const key in opts || {})
            if (key !== "decimals" && key !== "def") rest[key] = opts[key];

        /*
         * `def` is what it starts from, at its own scale, like every other
         * kind's: `new Decimal(def, places)` rounds the value to those places,
         * which is this field's own rule applied to its start.  It used to be
         * dropped in silence -- the extra below overwrote whatever was given
         * with a zero -- and a `.record` file with a decimal default is what
         * needed it.
         */
        const def = opts && opts.def !== undefined
                  ? new Decimal(opts.def, places)
                  : new Decimal("0", places);

        const field = makeField("decimal", rest, { places, def });
        return field;
    },

    /*
     * A record inside a record: an address in a customer, and -- through
     * `Field.List` -- the lines of an invoice.
     *
     *     Address: Field.Record(Address),                  // starts at null
     *     Billing: Field.Record(Address, { def: {} }),     // starts empty
     *     Origin:  Field.Record(Address, { def: { City: "CABA" } }),
     *     Parent:  Field.Record(() => Category),           // contains itself
     *
     * It starts at **null**, which is what lets a shape contain itself and what
     * a file means by a key that is not there.  `def` is how a record that
     * always has one says so, and it is not a special option -- every kind
     * takes `def`, and a Field.Record that ignored it would be the odd one out.
     * Do not ask for it on a shape that contains itself: that is the forever
     * this default exists to avoid.
     *
     * The class, or a thunk for the recursive case; see recordClass for why the
     * thunk cannot be avoided.
     */
    /**
     * another record: the class, or `() => the class` for a shape that contains
     * itself. Starts at `null`. Options: `required`
     */
    Record: (of, opts) => {
        const field = makeField("record", opts);

        if (isRecordClass(of))             field.of   = of;
        else if (typeof of === "function") field.make = of;
        else throw new TypeError("Field.Record: expected a Record class, or " +
                                 "() => the class for a shape that contains " +
                                 "itself");
        return field;
    },

    /**
     * an array, each entry through `item` — a `Field` or a `Record` class.
     * Options: `required`, `max`
     */
    List: (item, opts) => {
        /*
         * A Record class is accepted where a field is expected, so a detail is
         * `Field.List(Line)` and not `Field.List(Field.Record(Line))`.  The
         * long spelling stays legal -- a record field *is* a field, and
         * refusing it here would be arbitrary -- but the short one is the one
         * to write: it loses nothing, since a `def` on the entries of a list
         * means nothing and `max` and `required` belong to the list.
         */
        if (typeof item === "function") item = GLOBAL.Field.Record(item);
        if (!item || item.__field !== true)
            throw new TypeError("Field.List: expected a Field or a Record " +
                                "class for its entries");
        return makeField("list", opts, { item });
    },
};

/* ------------------------------------------------------------ .record files
 *
 * **A record's shape as a file**, beside the class, the way a form's tree is a
 * `.form` beside its class: `Customer.record` next to a `Customer.js` that
 * declares `class Customer extends Record {}` and the behaviours, if any.  The
 * `static Fields` block stays the code-only path -- a record with no file is
 * legal and built in code, exactly as a form with no `.form` is -- and a class
 * with **both** is refused: two shapes that can disagree is what the file
 * exists to avoid.
 *
 * The document is a `bta-record/1` object:
 *
 *     { "format": "bta-record/1", "class": "Customer", "naming": "snake",
 *       "fields": {
 *         "Name":     { "kind": "text",   "required": true, "max": 80 },
 *         "Balance":  { "kind": "number", "decimals": 2, "min": 0 },
 *         "Category": { "kind": "enum",   "values": ["Retail", "Wholesale"] },
 *         "Lines":    { "kind": "list",   "of": "Line" },
 *         "Since":    { "kind": "date" }
 *       } }
 *
 * A field's options are the ones its `Field.*` constructor takes, spelled the
 * same -- and they are read **through** those constructors and not beside
 * them, so a file refuses what a class body refuses, with the same sentence.
 * The two arguments that are positional in code are named here: `values` for
 * an enum and `of` for what a record or a list holds -- a Record class's name,
 * or a field of its own for the entries of a list of simple values.  A name
 * resolves the way any name does and **at first use of the class**, which is
 * what lets a shape contain itself: `of` naming the class being declared is
 * legal.
 */
const RECORD_FORMAT = "bta-record/1";

/* The field a spec builds, with `where` in front of whatever it refuses, so
 * the sentence names the file and the field and not only the option. */
function fieldOfSpec(spec, where) {
    try {
        return buildFieldOfSpec(spec, where);
    } catch (e) {
        const said = e && e.message !== undefined ? e.message : String(e);
        const Type = e instanceof TypeError ? TypeError
                   : e instanceof RangeError ? RangeError : Error;
        throw new Type(`${where}: ${said}`);
    }
}

/* Everything that is not the kind or one of the two named arguments: exactly
 * what the constructor's `opts` is.  `values` and `of` are named arguments
 * *only for the kinds that take them* -- on any other kind they are what they
 * are, an option nobody declared, and the constructor refuses them by name. */
function optionsOfSpec(spec, kind) {
    const out = {};
    for (const key in spec) {
        if (key === "kind") continue;
        if (key === "values" && kind === "enum") continue;
        if (key === "of" && (kind === "record" || kind === "list")) continue;
        out[key] = spec[key];
    }
    return out;
}

function withoutDef(opts) {
    const out = {};
    for (const key in opts) if (key !== "def") out[key] = opts[key];
    return out;
}

/* The class a name holds, resolved lazily and checked: `of` is a Record class
 * here, and a typo names the file and the field it was written in. */
function recordOfSpecName(name, where) {
    let got;
    try {
        got = resolveName(name);
    } catch (e) {
        throw new TypeError(`${where}: '${name}' is not a class`);
    }
    if (!isRecordClass(got))
        throw new TypeError(`${where}: '${name}' is not a Record class`);
    return got;
}

function buildFieldOfSpec(spec, where) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec))
        throw new TypeError("expected an object with a kind");

    const kind = spec.kind;
    if (typeof kind !== "string" || !hasOwn.call(FIELD_KINDS, kind))
        throw new RangeError(`'${kind}' is not one of ` +
                             ownKeys(FIELD_KINDS).join(", "));

    const opts = optionsOfSpec(spec, kind);

    const simple = { text: Field.Text, int: Field.Int, number: Field.Number,
                     decimal: Field.Decimal, date: Field.Date, time: Field.Time,
                     datetime: Field.DateTime, bytes: Field.Bytes };
    if (hasOwn.call(simple, kind)) return simple[kind](opts);

    if (kind === "bool") {
        if (opts.def !== undefined && typeof opts.def !== "boolean")
            throw new TypeError("'def' is true or it is false");
        return Field.Bool(opts.def === true, withoutDef(opts));
    }

    if (kind === "enum")
        return Field.Enum(spec.values, opts.def, withoutDef(opts));

    if (kind === "record") {
        if (typeof spec.of !== "string" || !spec.of)
            throw new TypeError("'of' is the class's name");
        return Field.Record(() => recordOfSpecName(spec.of, where), opts);
    }

    /* list */
    if (typeof spec.of === "string" && spec.of)
        return Field.List(() => recordOfSpecName(spec.of, where), opts);
    if (spec.of && typeof spec.of === "object" && !Array.isArray(spec.of))
        return Field.List(buildFieldOfSpec(spec.of, where), opts);
    throw new TypeError("'of' is what the entries are: a Record class's name, " +
                        "or a field for the entries");
}

/* What a kind starts from by itself: what a `def` equal to this is not a
 * decision, and is not written down. */
function specStart(field) {
    if (field.kind === "enum")    return field.options[0];
    if (field.kind === "decimal") return new Decimal("0", field.places);
    return FIELD_KINDS[field.kind].def;
}

function sameSpecValue(a, b) {
    if (a === b) return true;
    if (a instanceof Decimal && b instanceof Decimal) return `${a}` === `${b}`;
    if (Array.isArray(a) && Array.isArray(b))
        return a.length === b.length && a.every((v, i) => sameSpecValue(v, b[i]));
    if (a && b && typeof a === "object" && typeof b === "object")
        return JSON.stringify(a) === JSON.stringify(b);
    return false;
}

/* A `def` as the document writes it: the plain value, and a **refusal** for
 * what a document cannot hold -- a `Bytes` default has no JSON spelling, and a
 * silent `null` would be a shape that changed when it was saved. */
function writableSpecValue(v, where) {
    if (v === null || typeof v === "string" || typeof v === "number" ||
        typeof v === "boolean")
        return v;
    if (Array.isArray(v)) return v.map((x) => writableSpecValue(x, where));
    if (v instanceof Decimal) return `${v}`;
    if (typeof v === "object" && !(v instanceof Bytes)) {
        const out = {};
        for (const key in v) out[key] = writableSpecValue(v[key], where);
        return out;
    }
    throw new TypeError(`${where}: its default cannot be written in a ` +
                        `.record file`);
}

/* The name a document spells a record's class with; an anonymous one cannot be
 * written down, and a shape that cannot be read back is not written. */
function recordNameOf(field, where) {
    const name = recordClass(field).name;
    if (!name)
        throw new TypeError(`${where}: its Record class has no name, so a ` +
                            `.record file cannot name it`);
    return name;
}

/* A field as the document writes it -- the inverse of `fieldOfSpec`, and the
 * reason a shape built in code can become a file. */
function specOfField(field, where) {
    const spec = { kind: field.kind };

    for (const key in field) {
        if (key === "__field" || key === "kind" || key === "def" ||
            key === "places" || key === "options" || key === "item" ||
            key === "of" || key === "make")
            continue;
        spec[key] = field[key];
    }

    if (field.kind === "enum")
        spec.values = field.options.slice();
    else if (field.kind === "record")
        spec.of = recordNameOf(field, where);
    else if (field.kind === "list")
        spec.of = field.item.kind === "record"
                ? recordNameOf(field.item, `${where}.of`)
                : specOfField(field.item, `${where}.of`);
    else if (field.kind === "decimal" && field.places !== 2)
        spec.decimals = field.places;      /* `places` is the field's, `decimals` the file's */

    if (!sameSpecValue(field.def, specStart(field)))
        spec.def = writableSpecValue(field.def, where);
    return spec;
}

GLOBAL.Record = class Record {
    /* The values, by property name.  Private is the point: the setter is the
     * only way in. */
    #d = {};
    /* What Load could not accept... */
    #p = [];
    /* ...and the keys of the file this record does not describe, kept so writing
     * it back does not throw away what it did not understand.  A config file
     * carrying a key from a newer version must survive being saved by an older
     * one. */
    #x = {};

    /* Constructor -> its fields, merged down the class chain.  Prepared on the
     * first construction, because nothing else knows when a class was declared;
     * cached the way defaultsFor caches, and keyed by the constructor for the
     * same reason -- two classes may share a name. */
    static #ready = new Map();

    static #fieldsOf(ctor) {
        const done = Record.#ready.get(ctor);
        if (done) return done;

        /* Parent first, so a subclass *adds* to its parent's fields rather than
         * hiding them, which is what a plain static would do. */
        const chain = [];
        for (let c = ctor; c && c !== Record; c = prototypeOf(c)) chain.unshift(c);

        const fields = {};
        for (const c of chain) {
            const own  = ownDescriptor(c, "Fields");
            let   path = "";

            /* A class that declares its fields in code is only asked whether
             * a file claims it too; two files claiming the name are not its
             * problem, since it reads neither. */
            if (own) {
                try { path = Record.#fileOf(c); } catch (e) { path = ""; }
            } else {
                path = Record.#fileOf(c);
            }

            /* Two shapes that can disagree: the file is where the shape lives
             * when there is one, and a class that declares both is told so
             * rather than one of them silently winning. */
            if (own && path)
                throw new Error(`${c.name} declares Fields and has ${path}: ` +
                                `the shape lives in one place`);

            let declared = null;

            if (own) {
                /* `static get Fields()` used to declare **nothing, silently**:
                 * a getter's descriptor has no `value`, so the loop below ran
                 * over `undefined` and the class came out with no fields at
                 * all.  It is a tempting way to write a shape that contains
                 * itself -- the getter defers the class body's own name until
                 * it is bound -- so it is refused out loud rather than found
                 * later.  The thunk is the way: `Field.List(() => MenuItem)`. */
                if (!own.value || typeof own.value !== "object")
                    throw new TypeError(`${c.name}.Fields must be a static ` +
                                        `object of Fields; a getter (or ` +
                                        `anything else) here declares nothing`);
                declared = own.value;
            } else if (path) {
                declared = Record.#fieldsFromFile(c, path);
            }

            /* Inherited: already taken. */
            if (!declared) continue;

            for (const name in declared) fields[name] = declared[name];
        }

        const naming = ctor.Naming || "same";
        if (typeof naming !== "string" || !hasOwn.call(NAMINGS, naming))
            throw new RangeError(`${ctor.name}.Naming: '${naming}' is not one of ` +
                                 `${ownKeys(NAMINGS).join(", ")}`);

        for (const name in fields) {
            const field = fields[name];
            if (!field || field.__field !== true)
                throw new TypeError(`${ctor.name}.Fields.${name} is not a Field`);

            /* A field declared twice -- once in `Fields` or its `.record`, and
             * once as a hand-written accessor -- would have one of them
             * silently win.  Say so instead. */
            if (ownDescriptor(ctor.prototype, name))
                throw new Error(`${ctor.name}.${name} is declared (Fields or ` +
                                `its .record) and also written by hand: pick one`);

            /*
             * A thunk is resolved **here** and not when data first flows through
             * the field.  `Field.List(() => Nde)` is a typo, and the rule in
             * this class is that a declaration answers for itself when the class
             * is first used; an empty list never touches its entries' shape, so
             * without this a mistyped thunk waited for the first entry.
             *
             * Safe at this point, which is the whole reason the thunk exists:
             * #fieldsOf runs on the first *construction*, so the class body has
             * finished and its own name is bound.
             */
            if (field.kind === "record") recordClass(field);
            if (field.kind === "list" && field.item.kind === "record")
                recordClass(field.item);

            /*
             * A default the field itself would refuse -- `Field.Int({min: 1})`,
             * which starts at 0 -- is a record that is invalid before anyone
             * touches it, and nothing would say so until something read it.
             * `required` is the exception: what a field starts from is empty by
             * definition.
             */
            let start;
            try {
                start = freshDefault(field);
                fieldValue(field, name, start, true);
            } catch (e) {
                /*
                 * Built once and named from `start`, because for a record field
                 * `freshDefault` is where the seed is *constructed* -- so it can
                 * be the very thing that threw, and asking for it a second time
                 * inside this catch threw again and carried the wrapping away.
                 * The raw message came out with no class and no field in it.
                 */
                const said = start === undefined ? "" : ` ${JSON.stringify(start)}`;
                throw new RangeError(`${ctor.name}.${name}: its default${said} ` +
                                     `is not a value it accepts -- ${e.message}`);
            }

            defineProperty(ctor.prototype, name, {
                configurable: true,
                get()  { return this.#d[name]; },
                set(v) { this.#d[name] = fieldValue(field, name, v); },
            });
        }

        Record.#ready.set(ctor, fields);
        return fields;
    }

    /* The class's `.record` file, "" when it is built in code: the runtime's
     * own index, keyed the way a `.form` is (qualified name, then the bare
     * one), and its own table per thread. */
    static #fileOf(ctor) {
        return ctor.name ? findRecordFile(ctor.name) : "";
    }

    /*
     * The fields the class's file declares.
     *
     * Everything a document may say wrong is refused here, with the file and
     * the field in the sentence: the format, the class it claims to be, the
     * naming, and then each field -- through the constructors above, which is
     * where a misspelt option is refused by name.
     */
    static #fieldsFromFile(ctor, path) {
        let src;
        try {
            src = File.Load(path);
        } catch (e) {
            throw new Error(`${path}: ${e.message}`);
        }

        let doc;
        try {
            doc = JSON.parse(src);
        } catch (e) {
            throw new Error(`${path}: ${e.message}`);
        }

        if (!doc || typeof doc !== "object" || Array.isArray(doc))
            throw new TypeError(`${path}: expected an object`);

        if (doc.format !== RECORD_FORMAT)
            throw new RangeError(`${path}: format is '${doc.format}', expected ` +
                                 `'${RECORD_FORMAT}'`);
        if (doc.class !== ctor.name)
            throw new RangeError(`${path}: declares class '${doc.class}'`);

        if (doc.naming !== undefined) {
            if (typeof doc.naming !== "string" || !hasOwn.call(NAMINGS, doc.naming))
                throw new RangeError(`${path}: naming '${doc.naming}' is not one ` +
                                     `of ${ownKeys(NAMINGS).join(", ")}`);
            const own = ownDescriptor(ctor, "Naming");
            if (own && own.value !== doc.naming)
                throw new Error(`${ctor.name} declares Naming '${own.value}' and ` +
                                `${path} says '${doc.naming}'`);
            if (!own) ctor.Naming = doc.naming;
        }

        if (!doc.fields || typeof doc.fields !== "object" ||
            Array.isArray(doc.fields))
            throw new TypeError(`${path}: 'fields' is an object of fields`);

        const out = {};
        for (const name in doc.fields)
            out[name] = fieldOfSpec(doc.fields[name], `${path}: ${name}`);
        return out;
    }

    #fields() { return Record.#fieldsOf(this.constructor); }

    #naming() { return NAMINGS[this.constructor.Naming || "same"]; }

    #fileKey(name, field) {
        return field.as || this.#naming()(name);
    }

    constructor(values) {
        const fields = this.#fields();
        for (const name in fields) this.#d[name] = freshDefault(fields[name]);
        if (values) this.Apply(values);
    }

    /*
     * A bag of values, assigned -- through the setters, so every one of them is
     * checked.  Keyed by **property** name; `Load` is the one that reads a file's
     * names.
     */
    /**
     * assigns each property of a plain object to the field of the same name,
     * through the fields' own checks
     */
    Apply(values) {
        for (const key in values) this[key] = values[key];
        return this;
    }

    /*
     * The record as a plain object, ready for JSON.  Fields left at what they
     * start from are omitted -- a file records decisions, which is the same rule
     * a .form follows -- and `Serialize(true)` writes every one of them, for the
     * reader who is a contract rather than this class.
     *
     * Keys the file had and this record does not describe come back out, after
     * the ones it does.
     */
    /* The records this serialisation has already passed through.  A record
     * that actually holds itself would recurse forever, and JSON cannot hold a
     * cycle anyway -- so it becomes a sentence.  Here rather than a parameter
     * of Serialize because the public surface is `Serialize(all)` and a
     * bookkeeping argument would be part of it. */
    static #open = null;

    /**
     * a plain object — **what differs from the start**, or everything with
     * `true`
     */
    Serialize(all) {
        const fields = this.#fields();
        const out    = {};
        const top    = !Record.#open;

        if (top) Record.#open = new Set();
        try {
            if (Record.#open.has(this))
                throw new RangeError(`${this.constructor.name} contains itself`);
            Record.#open.add(this);

            for (const name in fields) {
                const field = fields[name];
                const v     = this.#d[name];
                if (!all && Record.#atDefault(v, field)) continue;

                out[this.#fileKey(name, field)] = Record.#plain(v, all);
            }
            for (const key in this.#x) out[key] = this.#x[key];

            Record.#open.delete(this);
            return out;
        } finally {
            if (top) Record.#open = null;
        }
    }

    /*
     * One value, as JSON holds it: a child record serialises itself, keeping
     * its own naming rule and its own unknown keys, and a decimal goes out as
     * its own text -- the one shape it reads back from exactly, since a JSON
     * number would be a double again.
     *
     * A list goes through element by element rather than being copied whole,
     * which it used to be: `slice()` handed a list of decimals out as decimal
     * *objects*, and only a list of plain values ever survived the trip.
     */
    static #plain(v, all) {
        if (v instanceof Record)  return v.Serialize(all);
        if (v instanceof Decimal) return `${v}`;
        /* Base64, because a JSON file has no other way to hold a file -- and
         * because `Field.Bytes` reads that string back as the same bytes.
         * Explicit here for the same reason a decimal is: `Serialize` answers a
         * plain object, and a `Bytes` in it would not be one. */
        if (v instanceof Bytes)   return v.ToBase64();
        if (Array.isArray(v))     return v.map((x) => Record.#plain(x, all));
        return v;
    }

    /* Is this what the field starts from, and so not a decision the file has to
     * record?  Records compare by what they say: `sameValue` would fall to
     * identity on them, and a seeded `def` builds a new record every time it is
     * asked for -- so an untouched child would be written on every save, each
     * one "different" from its own default. */
    static #atDefault(v, field) {
        const def = freshDefault(field);

        if (v instanceof Record || def instanceof Record) {
            return v instanceof Record && def instanceof Record &&
                   JSON.stringify(v) === JSON.stringify(def);
        }
        /* Empty is what a bytes field starts from, whoever built the empty:
         * `sameValue` would fall to identity, so a field assigned its own kind
         * of nothing would be written into every file. */
        if (v instanceof Bytes || def instanceof Bytes)
            return v instanceof Bytes && v.Length === 0;
        /*
         * A list starts empty, and comparing it through `sameValue` would
         * `JSON.stringify` **every item** -- for a plan of eight thousand tasks
         * that was a full `Serialize` of the shape on every save, to answer a
         * question `length` answers. A non-empty `def` is still compared by
         * value below.
         */
        if (Array.isArray(def) && def.length === 0)
            return Array.isArray(v) && v.length === 0;
        return sameValue(v, def);
    }

    /* So JSON.stringify(record) and File.SaveJson(path, record) are the record
     * and not the empty object the private bag would otherwise show. */
    toJSON() { return this.Serialize(); }

    /*
     * A copy, for the dialog that edits one: working on a copy is what makes
     * Cancel cost nothing, and it is what every editor here does with what it was
     * handed.  Written and read back rather than reaching into the bag, so a copy
     * is exactly what saving and loading the file would have produced -- keys this
     * record does not describe included.
     */
    /** a copy, which is what a dialog edits so that Cancel costs nothing */
    Clone() { return this.constructor.Load(this.Serialize(true)); }

    /*
     * What is wrong with what it holds, as a list of complaints, without
     * throwing.  Assigning is checked one field at a time and stops at the first
     * bad one; a file wants all of them at once, and so does anything showing a
     * form's worth of errors.
     */
    /**
     * what is wrong with what the record holds **now** — a different question,
     * and the one a form asks before saving
     */
    Validate() { return Record.#complaints(this, ""); }

    /*
     * The recursive half.  `fieldValue` stops at the first bad member, which is
     * what a *setter* should do and the opposite of what a report should: a
     * quote with three bad lines has to answer with three, so a child answers
     * for itself and its complaints arrive with the path in front of them --
     * `Lines[2].Price: 0 at least, got -5`.
     *
     * The path is the **property** name and not the file's spelling, because it
     * is what whoever wrote the record reads, and what a bound control will
     * name.  The shape of it is `Columns[2]` in `bta_table.c`, which validates
     * a list of records by hand for one property; this is that, once.
     */
    static #complaints(rec, path) {
        const fields = rec.#fields();
        const out    = [];

        for (const name in fields) {
            const field = fields[name];
            const v     = rec.#d[name];
            const at    = path + name;

            if (v instanceof Record) {
                out.push(...Record.#complaints(v, `${at}.`));
                continue;
            }
            if (field.kind === "list" && field.item.kind === "record") {
                /* The list's own rules first: they are about the list, and a
                 * complaint about an entry is not one of them. */
                if (field.required && v.length === 0)
                    out.push(`${at} is required`);
                if (field.max !== undefined && v.length > field.max)
                    out.push(`${at}: ${field.max} entries at most, ` +
                             `got ${v.length}`);

                v.forEach((entry, i) => {
                    if (entry instanceof Record)
                        out.push(...Record.#complaints(entry, `${at}[${i}].`));
                    else
                        out.push(`${at}[${i}] is not a ` +
                                 `${recordClass(field.item).name}`);
                });
                continue;
            }
            try {
                fieldValue(field, at, v);
            } catch (e) {
                out.push(e.message);
            }
        }
        return out;
    }

    /*
     * **The report of one `Load`**: what the file said that could not be taken.
     * Read-only, so no serialiser will ever try to write it back.
     *
     * It is not the state of the record and it does not become it. Ask it once,
     * after `Load`, and act on it then -- a value the file lost is a value that
     * gets written over by the next save, and this is the only place that says
     * so. Nothing clears it afterwards: not assigning to the field, not saving,
     * not saving successfully. It is a record of an act of reading, and that act
     * is over.
     *
     * **`Validate()` is the state**, recomputed every time, and it is what a
     * Save button and an error marked beside a field must ask. This used to be
     * `Problems` *plus* `Validate()`, and the two ways that was wrong are worth
     * keeping written down:
     *
     *   - a form that validated with `Problems` refused to save a record the
     *     user had already fixed, and showed `Name is required` against a field
     *     with a name in it;
     *   - and the same complaint arrived twice whenever both halves spoke about
     *     one field, which nesting multiplied -- a hundred bad rows, two hundred
     *     sentences.
     *
     * A caller that wants both says so: `rec.Problems.concat(rec.Validate())`.
     * Two of the three in this tree do, and being able to see which is the point.
     */
    /**
     * **the report of one `Load`**: what the file said that could not be taken
     */
    get Problems() { return Record.#fileProblems(this, ""); }

    /*
     * The file's half, reaching through children.  A child's `#p` is private to
     * the class and this is inside it, which is the whole reason the mapping
     * lives here rather than in a library: nothing outside `Record` can see
     * what a nested record could not take from its file.
     *
     * The path in front of a child's complaint is what makes it findable at all:
     * `Lines[2].Price: 0 at least, got -5 -- left at "0.00"` says which entry of
     * which field the file could not be read into.
     */
    static #fileProblems(rec, path) {
        const fields = rec.#fields();
        const out    = rec.#p.map((p) => `${path}${p}`);

        for (const name in fields) {
            const v = rec.#d[name];

            if (v instanceof Record) {
                out.push(...Record.#fileProblems(v, `${path}${name}.`));
            } else if (Array.isArray(v)) {
                v.forEach((entry, i) => {
                    if (entry instanceof Record)
                        out.push(...Record.#fileProblems(
                            entry, `${path}${name}[${i}].`));
                });
            }
        }
        return out;
    }

    /** the fields, as a widget answers its properties */
    PropertyNames() { return ownKeys(this.#fields()); }

    /* The values a field accepts, or none -- the same answer a widget gives, so
     * a property grid can edit a record without being told it is one. */
    /**
     * the values a field accepts, as a widget answers them — an `Enum`'s list
     */
    PropertyOptions(name) {
        const field = this.#fields()[name];
        return field && field.options ? field.options.slice() : [];
    }

    /*
     * What a field is, for whoever has to map it onto something else.
     *
     *   Kind    the field's kind, as `Field.<Kind>` spelled in lower case
     *   Column  what it is called in a file -- and so in a row, which is the
     *           same question: `as`, or the record's `Naming` rule applied
     *   Key     whether it is part of the record's identity
     *
     * Three, because three is what `Table` reads.  It is the generalisation of
     * `PropertyOptions`, and the two coexist rather than one replacing the
     * other: a property grid asks what a field *accepts*, and a mapper asks what
     * it *is*.
     *
     * `undefined` for a name that is not a declared field, which is the honest
     * answer for a hand-written accessor: it is a field a program can read and
     * not one this class knows the shape of.
     */
    /**
     * `{ Kind, Column, Key }`: what a field *is*, for whoever maps it onto
     * something else
     */
    PropertyInfo(name) {
        const field = this.#fields()[name];

        if (!field)
            return undefined;
        return {
            Kind:   field.kind,
            Column: this.#fileKey(name, field),
            Key:    field.key === true,
        };
    }

    /* One line per field, for reading with eyes rather than with a parser. */
    /** prints what it holds */
    Dump() {
        const fields = this.#fields();
        const lines  = [`${this.constructor.name}`];

        for (const name in fields) {
            lines.push(`  ${name} = ${JSON.stringify(this.#d[name])}`);
        }
        for (const complaint of this.Problems) lines.push(`  ! ${complaint}`);
        return lines.join("\n");
    }

    /*
     * Where the class's shape is declared, when it is declared in a file: the
     * index is the one that finds a class's `.form`, with the other extension,
     * so a project's folders spell a qualified name the same way in both.
     *
     * It is also what the loader above asks, which is why a `Task` worker
     * installs the same hook: a record whose shape lives in a file is read on
     * whichever thread constructs one.
     */
    /**
     * the `.record` file that declares this type's fields, or `""` when the
     * shape is built in code. **The file**, because it is a document like a
     * `.form`: what the tree shows and a dialog edits. Two files claiming the
     * class refuse by name
     */
    static File(type) {
        if (!isRecordClass(type))
            throw new TypeError("Record.File(type) expects a Record class");
        return Record.#fileOf(type);
    }

    /*
     * The shape as the document a `.record` file holds -- the inverse of what
     * a file loads, so a class built in code can be written to a file, and a
     * file read back, without either losing anything.
     *
     * A `def` equal to what its kind starts from is left out, the way the
     * serialiser leaves out a field at its start: the document records the
     * decisions.
     */
    /**
     * the type's shape as the document a `.record` file holds, ready for
     * `JSON.stringify`
     */
    static Shape(type) {
        if (!isRecordClass(type))
            throw new TypeError("Record.Shape(type) expects a Record class");

        const fields = Record.#fieldsOf(type);
        const out    = { format: RECORD_FORMAT, class: type.name };
        const naming = type.Naming || "same";

        if (naming !== "same")
            out.naming = naming;

        out.fields = {};
        for (const name in fields)
            out.fields[name] = specOfField(fields[name], name);
        return out;
    }

    /*
     * A file, read.  Lenient on purpose: a value it cannot accept leaves the
     * field at what it starts from and goes on the record's Problems, so one bad
     * key does not cost the other twenty -- and a project.json with a broken
     * `startup` can still be opened and fixed.
     *
     * This is the only door past the setters, and it is in here: an application
     * holds no key to the bag.
     */
    /**
     * a record from a file's object, read **leniently**: what fits is taken and
     * what does not is reported in `Problems`
     */
    static Load(json) {
        const rec = new this();

        if (!json || typeof json !== "object" || Array.isArray(json)) {
            const got = json === null ? "null" : typeof json;
            rec.#p.push(`expected an object, got ${got}`);
            return rec;
        }

        const fields = rec.#fields();
        const taken  = {};

        for (const name in fields) {
            const field = fields[name];
            const key   = rec.#fileKey(name, field);

            taken[key] = true;
            /* Own keys only: a field whose file key is `toString` would
             * otherwise read Object.prototype's function for a file that does
             * not carry the key, and complain about one nobody wrote. */
            if (!hasOwn.call(json, key)) continue;

            /*
             * A child is **loaded and not assigned**: assigning would go through
             * its setters and stop at its first bad member, so one bad price
             * would cost the rest of that line -- the same leniency this method
             * exists for, one level down.  A child that could not take
             * something keeps its own complaint, and Problems reaches it.
             */
            const v = json[key];

            if (field.kind === "record") {
                if (v === null || v === undefined) continue;
                if (typeof v !== "object" || Array.isArray(v)) {
                    rec.#p.push(`${name}: expected an object, got ${typeof v}`);
                    continue;
                }
                rec.#d[name] = recordClass(field).Load(v);
                continue;
            }
            if (field.kind === "list" && field.item.kind === "record") {
                if (!Array.isArray(v)) {
                    rec.#p.push(`${name}: expected a list, got ${typeof v}`);
                    continue;
                }
                const of = recordClass(field.item);

                /* An entry that is not an object is answered here rather than
                 * inside the child, so every sentence in `#p` is already
                 * `Something: complaint` and the parent can put a path in front
                 * of it without producing `Lines[1].expected an object`. */
                rec.#d[name] = v.map((entry, i) => {
                    if (!entry || typeof entry !== "object" ||
                        Array.isArray(entry)) {
                        rec.#p.push(`${name}[${i}]: expected an object, got ` +
                                    `${entry === null ? "null" : typeof entry}`);
                        return new of();
                    }
                    return of.Load(entry);
                });
                continue;
            }

            try {
                const notes = [];
                rec.#d[name] = fieldValue(field, name, v, false, notes);
                rec.#p.push(...notes);
            } catch (e) {
                rec.#p.push(`${e.message} -- left at ` +
                            `${JSON.stringify(rec.#d[name])}`);
            }
        }

        /* `taken` is a plain object, so a plain read of it answers about
         * Object.prototype too: `taken["toString"]` is a function, which is
         * truthy, which dropped every unknown key named after one of those --
         * exactly the keys this loop exists to carry through untouched. */
        for (const key in json)
            if (!hasOwn.call(taken, key)) rec.#x[key] = json[key];
        return rec;
    }

    /* --------------------------------------------------------------- XML
     *
     * A shape and an element, declared once.  `static Xml` names the element
     * this record is, and every field names its own -- the same `as`/`Naming`
     * pair a column uses, plus three options for the places XML differs:
     * `attribute` for a value kept as one, `in` for the wrapper a list lives
     * under, and `element` for the item name of a list of values.
     *
     * Three verbs, and the difference between them is the difference between
     * JSON and XML.  `ToXml` is `Serialize`: a new element, what differs from
     * the field's start (or everything, with `true`).  `LoadXml` is `Load`: a
     * document read leniently, with `Problems`.  `SaveXml` is neither -- it
     * writes into the element it is handed and touches **only** what it
     * models, which is the road an interchange round trip needs: everything
     * the shape does not know about stays exactly where it was.
     *
     * What is not modelled is **reported and left alone**: `LoadXml` puts it
     * in `Problems`, `ToXml` does not write it, and `SaveXml` does not see it.
     * There is no raw-node bag, because re-emitting an unknown element at the
     * end of an `xsd:sequence` is a wrong answer that looks right.
     *
     * **A shape that models only part of an `xsd:sequence` declares `Order`**:
     * the type's element names in the schema's order, anchors included, with
     * **every element the shape writes** among them.  Without it the order is
     * the fields' declaration order, which can only place a new element
     * relative to the modelled siblings -- one whose successors are all
     * unmodelled lands at the end, past elements the schema puts later, and
     * the document stops validating with nothing said.  With it, `SaveXml`
     * inserts before the first sibling the sequence puts after the new
     * element, modelled or not, and `ToXml` writes in that order rather than
     * in declaration order.
     *
     * `static Xml` merges down the class chain the way `Fields` does, a string
     * `Namespace` or a list: the first is written, all of them are accepted on
     * read -- an official schema and the files it describes can disagree about
     * the URI and both be right, which is exactly what MSPDI does.
     */

    static #xmlReady = new Map();
    static #xmlOrderReady = new Map();
    static #xmlNamesReady = new Map();

    static #namingOf(ctor) {
        return NAMINGS[ctor.Naming || "same"];
    }

    static #xmlOf(ctor) {
        let shape = Record.#xmlReady.get(ctor);
        if (shape) return shape;

        const chain = [];
        for (let c = ctor; c && c !== Record; c = prototypeOf(c)) chain.unshift(c);

        const out = {};
        for (const c of chain) {
            const own = ownDescriptor(c, "Xml");
            if (!own) continue;
            if (!own.value || typeof own.value !== "object" ||
                Array.isArray(own.value))
                throw new TypeError(`${c.name}.Xml must be a static object of ` +
                                    `{ Root, Namespace, Order, Booleans }`);

            for (const key in own.value) {
                if (key !== "Root" && key !== "Namespace" && key !== "Order" &&
                    key !== "Booleans")
                    throw new RangeError(`${c.name}.Xml: '${key}' is not an ` +
                                         `XML option (Root, Namespace, Order, ` +
                                         `Booleans)`);
                out[key] = own.value[key];
            }
        }

        if (out.Root !== undefined &&
            (typeof out.Root !== "string" || !out.Root))
            throw new TypeError(`${ctor.name}.Xml.Root must be an element name`);

        /* **How a boolean is spelled** when this shape writes one: the XML
         * Schema's `true`/`false` unless it says `"digits"`, which is `1`/`0`
         * -- MS Project's spelling, and the only one Project 2108 reads right:
         * it took `<IsNull>false</IsNull>` for a blank row.  Both are read
         * either way. */
        if (out.Booleans !== undefined && out.Booleans !== "digits")
            throw new RangeError(`${ctor.name}.Xml.Booleans is "digits" (1/0) ` +
                                 `or left out (true/false)`);

        if (out.Order !== undefined) {
            if (!Array.isArray(out.Order) || !out.Order.length)
                throw new TypeError(`${ctor.name}.Xml.Order must be a non-empty ` +
                                    `list of the type's element names, in the ` +
                                    `schema's order`);

            const seen = new Set();

            for (let i = 0; i < out.Order.length; i++) {
                const entry = out.Order[i];

                if (typeof entry !== "string" || !entry)
                    throw new TypeError(`${ctor.name}.Xml.Order[${i}] must be an ` +
                                        `element name`);
                if (seen.has(entry))
                    throw new RangeError(`${ctor.name}.Xml.Order names '${entry}' ` +
                                         `twice, so where an element goes cannot ` +
                                         `be answered`);
                seen.add(entry);
            }
        }

        const uris = out.Namespace === undefined ? []
                   : Array.isArray(out.Namespace) ? out.Namespace
                   : [out.Namespace];
        if (!uris.length && out.Namespace !== undefined)
            throw new TypeError(`${ctor.name}.Xml.Namespace must be a URI or a ` +
                                `list of them`);
        if (!uris.every((u) => typeof u === "string" && u))
            throw new TypeError(`${ctor.name}.Xml.Namespace must be a URI or a ` +
                                `list of them`);
        out.Uris = uris;

        Record.#xmlReady.set(ctor, out);
        return out;
    }

    /* The element a field is written as: `as` first, then the class's own Root
     * for a record, then the naming rule for a value. */
    static #xmlFieldName(ctor, name, field) {
        if (field.as) return field.as;
        if (field.kind === "record") return Record.#xmlRootOf(recordClass(field));
        return Record.#namingOf(ctor)(name);
    }

    static #xmlRootOf(of) {
        const root = Record.#xmlOf(of).Root;
        if (!root)
            throw new RangeError(`${of.name} has no Xml.Root, so there is no ` +
                                 `element to write it as -- declare one, or ` +
                                 `give the field an 'as'`);
        return root;
    }

    static #xmlItemName(field) {
        if (field.element) return field.element;
        if (field.item.kind === "record")
            return Record.#xmlRootOf(recordClass(field.item));
        throw new RangeError(`Field.List needs { element: "Name" } for a list ` +
                             `of values: only a record knows its own element`);
    }

    /* The element a field is written as, or `null` for an attribute -- which
     * is not an element and has no place in an order.  One place, so the order
     * the fields declare and the order `ToXml` writes in cannot disagree. */
    static #xmlEntry(ctor, name, field) {
        if (field.attribute) return null;
        if (field.kind === "list")
            return field.in || Record.#xmlItemName(field);
        return Record.#xmlFieldName(ctor, name, field);
    }

    /* The child element names a parent writes, in the order it writes them --
     * what `SaveXml` keeps a missing element's insertion in step with.  Built
     * once per class: it depends on the declaration and not on the record, and
     * a save of eight thousand tasks asked for it eight thousand times.
     *
     * `Xml.Order` replaces the derived list with the type's own sequence, so
     * an element added among children the shape does **not** model still lands
     * before the first sibling the sequence puts after it.  Every element the
     * shape writes has to be in it: an anchor list missing one of those would
     * place that field by accident, and nothing would say so. */
    static #xmlOrder(ctor, fields) {
        const done = Record.#xmlOrderReady.get(ctor);

        if (done) return done;

        const write = [];

        for (const name in fields) {
            const entry = Record.#xmlEntry(ctor, name, fields[name]);

            if (entry !== null) write.push(entry);
        }

        const shape = Record.#xmlOf(ctor);

        if (shape.Order)
            for (const entry of write)
                if (!shape.Order.includes(entry))
                    throw new RangeError(`${ctor.name}.Xml.Order does not name ` +
                                         `'${entry}', which the shape writes -- ` +
                                         `the sequence has to name every element ` +
                                         `it places`);

        const out = shape.Order || write;

        Record.#xmlOrderReady.set(ctor, out);
        return out;
    }

    /* The fields' own names in the order their elements are written: the
     * declaration's order, or `Order`'s when the shape declares one.  Cached
     * like the order it comes from -- `ToXml` asks once per record. */
    static #xmlNames(ctor, fields) {
        const done = Record.#xmlNamesReady.get(ctor);

        if (done) return done;

        const names = [];

        for (const name in fields) names.push(name);

        const shape = Record.#xmlOf(ctor);

        if (shape.Order) {
            const rank = new Map();

            Record.#xmlOrder(ctor, fields);   /* and its check, once */
            for (const name of names) {
                const entry = Record.#xmlEntry(ctor, name, fields[name]);

                rank.set(name, entry === null ? -1 : shape.Order.indexOf(entry));
            }
            names.sort((a, b) => rank.get(a) - rank.get(b));
        }

        Record.#xmlNamesReady.set(ctor, names);
        return names;
    }

    /* One value as XML spells it.  A boolean is `true`/`false`, which is the
     * XML Schema spelling, or `1`/`0` in a shape that declares `Booleans:
     * "digits"` (MS Project's); both are read back either way. `shape` is
     * the record's, from `#xmlOf`. */
    static #xmlText(field, v, shape) {
        switch (field.kind) {
        case "bool":    return shape && shape.Booleans === "digits"
                             ? (v ? "1" : "0") : (v ? "true" : "false");
        case "int":
        case "number":
        case "decimal": return `${v}`;
        case "bytes":   return v.ToBase64();
        default:        return v;
        }
    }

    /* And the other way: what XML spells, as the type the field's setter
     * takes.  A value this cannot read is handed over as the text it was, so
     * the field's own check writes the sentence -- one place composes them. */
    static #xmlValue(field, text) {
        switch (field.kind) {
        case "int":    return XML_WHOLE.test(text) ? Number(text) : text;
        case "number": return XML_DEC.test(text) ? Number(text) : text;
        case "bool":
            if (text === "true" || text === "1")  return true;
            if (text === "false" || text === "0") return false;
            return text;
        default:
            return text;
        }
    }

    static #xmlSource(source, who) {
        const el = source && typeof source === "object" &&
                   typeof source.Name === "string"
                 ? source
                 : source && typeof source === "object" && source.Root
                 ? source.Root : null;

        if (!el)
            throw new TypeError(`${who}: expected an XML document or element, ` +
                                `from Xml.Parse or File.LoadXml`);
        return el;
    }

    /*
     * One element, as the plain object `Load` reads -- recursively, so a child
     * keeps its own mapping and its own problems.  `unknown` collects what the
     * shape does not model, with the path in front of it; `Load` is what
     * validates every value.
     */
    static #xmlRead(ctor, el, path, unknown) {
        const fields = Record.#fieldsOf(ctor);
        const naming = Record.#namingOf(ctor);
        const values = {};
        const seen   = new Set();

        for (const name in fields) {
            const field = fields[name];
            /* The object `Load` reads is keyed by the **file's** spelling and
             * not by the property name -- `Load` looks a field up by
             * `as`/`Naming` -- and the element name is a third thing for a
             * record or a list, where the class or the option names it. */
            const fileKey = field.as || naming(name);

            if (field.attribute) {
                seen.add(`@${fileKey}`);
                const v = el.Attr(fileKey);
                if (v !== null) values[fileKey] = Record.#xmlValue(field, v);
                continue;
            }

            if (field.kind === "list") {
                const itemName = Record.#xmlItemName(field);
                const holder   = field.in ? el.Find(field.in) : el;

                if (field.in) {
                    seen.add(field.in);
                    if (!holder) continue;
                    for (const c of holder.Children)
                        if (c.Name !== itemName)
                            unknown.push(`${path}${name}: <${c.Name}> is not ` +
                                         `modelled`);
                } else {
                    seen.add(itemName);
                }

                values[fileKey] = holder.FindAll(itemName).map((item, i) =>
                    field.item.kind === "record"
                        ? Record.#xmlRead(recordClass(field.item), item,
                                          `${path}${name}[${i}].`, unknown)
                        : Record.#xmlValue(field.item, item.Text));
                continue;
            }

            if (field.kind === "record") {
                const childName = Record.#xmlFieldName(ctor, name, field);
                const kids      = el.FindAll(childName);

                seen.add(childName);
                if (kids.length > 1)
                    unknown.push(`${path}<${el.Name}>: ${kids.length} ` +
                                 `<${childName}> elements, and the shape reads one`);
                if (kids.length)
                    values[fileKey] = Record.#xmlRead(recordClass(field), kids[0],
                                                      `${path}${name}.`, unknown);
                continue;
            }

            /*
             * A scalar field reads its element's **text**, so anything else
             * that element carries is content the shape is dropping -- and it
             * is said rather than lost: a repetition (two `<Name>` elements,
             * which is how a prefixed name in another namespace looks from
             * here), attributes (`<guid isPermaLink="false">`, whose own text
             * is the value), and child elements (`<description>` with real
             * markup inside, which is read as the text between the tags).
             */
            seen.add(fileKey);
            const kids = el.FindAll(fileKey);

            if (kids.length > 1)
                unknown.push(`${path}<${el.Name}>: ${kids.length} <${fileKey}> ` +
                             `elements, and the shape reads one`);
            if (!kids.length) continue;

            if (kids[0].Children.length)
                unknown.push(`${path}<${fileKey}>: mixed content is read as ` +
                             `its text`);
            for (const a of kids[0].AttributeNames())
                unknown.push(`${path}<${fileKey}>: attribute '${a}' is not ` +
                             `modelled`);
            values[fileKey] = Record.#xmlValue(field, kids[0].Text);
        }

        for (const a of el.AttributeNames())
            if (!seen.has(`@${a}`))
                unknown.push(`${path}<${el.Name}>: attribute '${a}' is not ` +
                             `modelled`);
        for (const c of el.Children)
            if (!seen.has(c.Name))
                unknown.push(`${path}<${el.Name}>: <${c.Name}> is not modelled`);
        return values;
    }

    /*
     * A document or element, read leniently -- `Load`'s bargain one medium
     * over.  The root's element and namespace are checked, everything the
     * shape does not model is reported, and nothing throws: an element read
     * from somebody else's file is a file.
     */
    /**
     * the same as `Load`, from an XML document or element, by the shape's
     * `static Xml`
     */
    static LoadXml(source) {
        const el    = Record.#xmlSource(source, "LoadXml");
        const ctor  = this;
        const shape = Record.#xmlOf(ctor);
        const pre   = [];

        if (!shape.Root)
            pre.push(`${ctor.name} has no Xml.Root, so there is no element it ` +
                     `reads from`);
        else if (el.Name !== shape.Root)
            pre.push(`expected <${shape.Root}>, got <${el.Name}>`);
        if (shape.Uris.length && !shape.Uris.includes(el.Namespace))
            pre.push(`expected namespace ${shape.Uris.join(" or ")}, got ` +
                     `'${el.Namespace}'`);

        const unknown = [];
        const values  = Record.#xmlRead(ctor, el, "", unknown);
        const rec     = ctor.Load(values);

        rec.#p.unshift(...pre);
        for (const u of unknown) rec.#p.push(u);
        return rec;
    }

    /*
     * A new element, the way `Serialize` is a new object: what differs from
     * the field's start, or every field with `true` -- which is what a schema
     * with elements that are not `minOccurs="0"` needs.  A `key` is written
     * either way: identity is not a value the file may drop.
     */
    /** a new element: what differs from the start, or every field */
    ToXml(all) {
        const shape = Record.#xmlOf(this.constructor);

        if (!shape.Root)
            throw new RangeError(`${this.constructor.name} has no Xml.Root, ` +
                                 `so there is no element to write it as`);
        const el = Xml.Element(shape.Root);

        Record.#xmlWrite(this, el, all === true);
        return el;
    }

    static #xmlWrite(rec, el, all) {
        const ctor   = rec.constructor;
        const shape  = Record.#xmlOf(ctor);
        const fields = Record.#fieldsOf(ctor);

        if (shape.Uris.length) el.SetNamespace(shape.Uris[0]);

        for (const name of Record.#xmlNames(ctor, fields)) {
            const field = fields[name];
            const v     = rec.#d[name];

            /* A key, and a field declared `always`, are written either way --
             * see `#xmlWritten`. */
            if (!all && !Record.#xmlWritten(field) &&
                Record.#atDefault(v, field)) continue;

            if (field.attribute) {
                el.SetAttr(Record.#xmlFieldName(ctor, name, field),
                           Record.#xmlText(field, v, shape));
                continue;
            }

            if (field.kind === "list") {
                const itemName = Record.#xmlItemName(field);
                const holder   = field.in ? el.Add(field.in) : el;

                for (const item of v) {
                    if (field.item.kind === "record") {
                        const child = Xml.Element(itemName);

                        Record.#xmlWrite(item, child, all);
                        holder.Add(child);
                    } else {
                        holder.Add(itemName).Text =
                            Record.#xmlText(field.item, item, shape);
                    }
                }
                continue;
            }

            if (field.kind === "record") {
                if (v === null) continue;
                const child = Xml.Element(Record.#xmlFieldName(ctor, name, field));

                Record.#xmlWrite(v, child, all);
                el.Add(child);
                continue;
            }

            el.Add(Record.#xmlFieldName(ctor, name, field)).Text =
                Record.#xmlText(field, v, shape);
        }
    }

    /*
     * The record's state, written **into** an element: only what it models,
     * with everything else -- unknown elements, foreign namespaces, comments
     * -- exactly where it was.
     *
     * A field at what it starts from is removed rather than written, which is
     * `ToXml`'s omission with a tree to keep in step -- except a `key`, which
     * is identity and is written whatever it holds.  A list is reconciled:
     * an item is matched to an element by the record's `key` (declared as
     * ever) where there is one and by position where there is not, unmatched
     * elements are taken out, new ones are added, and the order of the list is
     * the order of the elements afterwards.
     */
    /** writes into that element, touching **only** what the shape models */
    SaveXml(source) {
        const el    = Record.#xmlSource(source, "SaveXml");
        const ctor  = this.constructor;
        const shape = Record.#xmlOf(ctor);

        if (!shape.Root)
            throw new RangeError(`${ctor.name} has no Xml.Root, so there is no ` +
                                 `element to write into`);
        if (el.Name !== shape.Root)
            throw new TypeError(`SaveXml: expected <${shape.Root}>, got ` +
                                `<${el.Name}>`);

        Record.#xmlSave(this, el);
        return el;
    }

    static #xmlSave(rec, el) {
        const ctor   = rec.constructor;
        const fields = Record.#fieldsOf(ctor);
        const order  = Record.#xmlOrder(ctor, fields);
        const shape  = Record.#xmlOf(ctor);

        for (const name in fields) {
            const field = fields[name];
            const v     = rec.#d[name];
            const dflt  = !Record.#xmlWritten(field) &&
                          Record.#atDefault(v, field);

            if (field.attribute) {
                const key  = Record.#xmlFieldName(ctor, name, field);
                const text = Record.#xmlText(field, v, shape);

                if (dflt)             el.RemoveAttr(key);
                else if (el.Attr(key) !== text) el.SetAttr(key, text);
                continue;
            }

            if (field.kind === "list") {
                if (dflt) Record.#xmlDropList(el, field);
                else      Record.#xmlSaveList(el, field, v, order, shape);
                continue;
            }

            if (field.kind === "record") {
                const childName = Record.#xmlFieldName(ctor, name, field);
                const child     = el.Find(childName);

                if (v === null) {
                    if (child) child.Remove();
                    continue;
                }
                Record.#xmlSave(v, child || Record.#xmlInsert(el, childName, order));
                continue;
            }

            const key   = Record.#xmlFieldName(ctor, name, field);
            const child = el.Find(key);

            if (dflt) {
                if (child) child.Remove();
                continue;
            }

            const text = Record.#xmlText(field, v, shape);

            /*
             * **An edit that changes nothing is not an edit**, here as in the
             * property grid: writing the text the element already holds would
             * orphan the old text node -- `Text =` sends the children to the
             * tree's orphan list so a wrapper keeps answering -- and
             * `xml_orphan` walks that list, so a save of an unchanged document
             * made the next save slower, without bound. Measured on an
             * 8000-task plan: four identical saves took 458, 1388, 2347 and
             * 3807 ms. A child with element children is still written, because
             * its text is a reading of them.
             */
            if (child && child.Children.length === 0 && child.Text === text)
                continue;
            (child || Record.#xmlInsert(el, key, order)).Text = text;
        }
    }

    /* A missing element goes where the declaration says it goes, relative to
     * the modelled siblings -- before the first one declared after it -- and
     * never moves anything the shape does not know about. */
    static #xmlInsert(el, name, order) {
        const at = Record.#xmlSlot(el, name, order);

        /* The answer is the node that is **in this tree**: a `Xml.Element` is
         * detached, so `Insert`/`Add` copy it in and the caller writing the
         * value has to write the copy -- the original stays where it was. */
        const made = Xml.Element(name);
        return at >= 0 ? el.Insert(at, made) : el.Add(made);
    }

    /* Where an element of `name` goes when there is none: before the first
     * child the declaration puts after it, -1 for the end. */
    static #xmlSlot(el, name, order) {
        const later = order.slice(order.indexOf(name) + 1);
        const kids  = el.Children;

        for (let i = 0; i < kids.length; i++)
            if (later.includes(kids[i].Name)) return i;
        return -1;
    }

    /* An empty list takes its items out -- and the wrapper with them when
     * nothing else is left in it, since the wrapper was modelled too.  A
     * wrapper holding something the shape does not know about stays. */
    static #xmlDropList(el, field) {
        const itemName = Record.#xmlItemName(field);

        if (field.in) {
            const holder = el.Find(field.in);

            if (!holder) return;
            for (const child of holder.Children)
                if (child.Name === itemName) child.Remove();
            if (!holder.Children.length) holder.Remove();
            return;
        }

        for (const child of el.FindAll(itemName)) child.Remove();
    }

    static #xmlSaveList(el, field, v, order, shape) {
        const itemName = Record.#xmlItemName(field);
        const holder   = field.in
                       ? (el.Find(field.in) || Record.#xmlInsert(el, field.in, order))
                       : el;
        const existing = holder.FindAll(itemName);
        const key      = field.item.kind === "record"
                       ? Record.#xmlKeyName(recordClass(field.item)) : null;
        const used     = new Array(existing.length).fill(false);
        const wanted   = [];
        const where    = [];   /* the `existing` index each item matched, or -1 */

        /*
         * Matching is a map when the list is keyed and a cursor when it is not,
         * and **neither asks the document a question per item**. The first
         * version looked for each item's key among the unmatched elements --
         * `Find` builds a wrapper and walks the holder's children every call --
         * and the positional road asked `used.indexOf(false)` per item, so both
         * were the square in `ISSUE-xml-list-cost`: an 8000-task plan was a
         * two-and-a-half-minute save against a 3-second read. The key of each
         * existing element is read **once**, here.
         */
        let byKey = null;
        let next  = 0;

        if (key) {
            byKey = new Map();
            for (let i = 0; i < existing.length; i++) {
                const got = key.attribute
                          ? existing[i].Attr(key.name)
                          : (existing[i].Find(key.name) || {}).Text;

                /* An element with no key of its own matches nothing -- its
                 * `undefined` is not a key text, which is always a string. */
                if (got === null || got === undefined) continue;
                const queue = byKey.get(got);

                if (queue) queue.push(i); else byKey.set(got, [i]);
            }
        }

        for (const item of v) {
            let found = null;
            let at    = -1;

            if (key) {
                const queue = byKey.get(Record.#xmlKeyText(item, key));

                if (queue && queue.length) {
                    at = queue.shift();
                    found = existing[at];
                    used[at] = true;
                }
            } else {
                while (next < existing.length && used[next]) next++;
                if (next < existing.length) {
                    at = next++;
                    found = existing[at];
                    used[at] = true;
                }
            }

            if (!found)
                found = Xml.Element(itemName);
            wanted.push(found);
            where.push(at);

            if (field.item.kind === "record") Record.#xmlSave(item, found);
            else found.Text = Record.#xmlText(field.item, item, shape);
        }

        existing.forEach((node, i) => { if (!used[i]) node.Remove(); });

        /*
         * **The items that survived, renumbered**, which is what lets the
         * placement compare positions instead of wrappers: `FindAll` and
         * `Children` hand out *different wrappers for the same node*, so the
         * first version of this fix asked `nodes[i] === wanted[i]` and was
         * false for every item already in place -- every save paid a move per
         * item and the square came back. What is the same across the two walks
         * is the **order**, so an item's place is an index and not an object.
         */
        const alive = [];
        let   k     = 0;

        for (let i = 0; i < existing.length; i++)
            if (used[i]) alive[i] = k++;
        Record.#xmlPlace(holder, itemName, wanted,
                         field.in ? null : order,
                         where.map((i) => (i < 0 ? -1 : alive[i])));
    }

    /*
     * The list's order is the array's order afterwards.  New items are
     * detached elements, and `Insert` copies what comes from another tree,
     * which is exactly what putting one here means; an item already in
     * position is a no-op at the C level.
     *
     * An item past the last one there is goes **after** that one, never to
     * the end of the holder: with no `in` the holder is the record's own
     * element, and its end is past every field declared later and everything
     * the shape does not model -- `<Line/><Total/><Line/>`, which an
     * `xsd:sequence` refuses.  With none there at all, `order` (the record's
     * own element only) says where the first one goes.
     */
    static #xmlPlace(holder, itemName, wanted, order, from) {
        /*
         * The ordinary save is the round trip: every item matched the element
         * in the same place, so `from[i] === i` and there is nothing to place
         * -- the children are not even read. That is the case
         * `ISSUE-xml-list-cost` measured at two and a half minutes, and it is
         * a comparison per item now.
         */
        let same = true;

        for (let i = 0; i < from.length; i++)
            if (from[i] !== i) { same = false; break; }
        if (same)
            return;

        /*
         * The children are read **once**, and the arrays that describe the
         * tree are kept in step with what each `Insert` does. The first version
         * asked `holder.Children` inside the loop -- a fresh array with a fresh
         * wrapper per child, per item -- which was the other half of the square
         * in `ISSUE-xml-list-cost`.
         *
         * `nodes` is the items there now and `from` says, per wanted item,
         * which of those it is (`-1` for one being added). Both walks see the
         * same nodes **in the same order**, which is the fact this rests on:
         * wrappers are not unique, so position is what can be compared.
         */
        const kids  = holder.Children;
        const nodes = [];

        for (const child of kids)
            if (child.Name === itemName) nodes.push(child);

        const cur = nodes.slice();      /* the items in the tree, in order */

        for (let i = 0; i < wanted.length; i++) {
            const item = from[i] >= 0 ? nodes[from[i]] : wanted[i];

            if (cur[i] === item)
                continue;               /* already where it belongs */

            /* Before the item at position `i` if there is one, after the last
             * one otherwise; with none there at all, where the declaration
             * says. `-1` is the end. */
            let at;

            if (i < cur.length)
                at = kids.indexOf(cur[i]);
            else if (cur.length)
                at = kids.indexOf(cur[cur.length - 1]) + 1;
            else
                at = order ? Record.#xmlSlot(holder, itemName, order) : -1;

            if (at < 0) holder.Add(item);
            else        holder.Insert(at, item);

            /* The same move, in the arrays: a node already in the list leaves
             * its place first, and everything after it shifts down by one. */
            const old = kids.indexOf(item);

            if (old >= 0) {
                kids.splice(old, 1);
                if (old < at) at--;
            }
            if (at < 0) kids.push(item);
            else        kids.splice(at, 0, item);

            const seen = cur.indexOf(item);

            if (seen >= 0) cur.splice(seen, 1);
            cur.splice(i, 0, item);
        }
    }

    /* A scalar `key` is identity and not a value: both XML verbs write it
     * whatever it holds, because `<UID>0</UID>` is a UID.  `Table`'s "an int
     * key of 0 is a row never saved" is a statement about having an INSERT
     * that assigns one, and XML has none -- which is also why a key at its
     * default still matches its element. */
    static #xmlKeyed(field) {
        return field.key === true &&
               field.kind !== "record" && field.kind !== "list";
    }

    /* **What is written even at its default**: a key, and a value declared
     * `always: true`.  Everything else at its default has its element removed,
     * which is right for a format whose absent element *means* the default --
     * and wrong for one where it means something else: MSPDI's resource
     * `<Type>` absent is Work, so a Material one (0, the int's default) lost
     * its element and came back Work, and Project refused the file.  `def`
     * says what an absent element reads as; `always` says the field is written
     * all the same. */
    static #xmlWritten(field) {
        return Record.#xmlKeyed(field) ||
               (field.always === true &&
                field.kind !== "record" && field.kind !== "list");
    }

    /* The field a list is keyed by, if the item shape declares one: the same
     * `key` `Table` reads.  Unlike `Table`, a key at what it starts from is
     * matched like any other value -- an XML key of 0 is an item whose key is
     * 0 -- because no INSERT here assigns one. */
    static #xmlKeyName(ctor) {
        const fields = Record.#fieldsOf(ctor);
        const naming = Record.#namingOf(ctor);

        for (const name in fields) {
            const field = fields[name];

            if (field.key !== true) continue;
            if (field.kind === "record" || field.kind === "list") continue;
            return {
                prop:      name,
                name:      field.as || naming(name),
                attribute: field.attribute === true,
                field,
            };
        }
        return null;
    }

    /* The key as the file spells it -- never `null`, because the default is a
     * value like any other here: `<UID>0</UID>` is a key of 0.  `Table`'s "an
     * int key at 0 is a row never saved" is about having an INSERT to assign
     * one, and `#xmlSave` is what writes it. */
    static #xmlKeyText(item, key) {
        return Record.#xmlText(key.field, item.#d[key.prop],
                               Record.#xmlOf(item.constructor));
    }
};

/*
 * A declared column type as the affinity sqlite gives it.
 *
 * Sqlite's own five rules, in sqlite's own order -- the order is the whole of
 * it, since `INT` is checked before `TEXT` and so `INTEGER` is not a text
 * column, and an unrecognised type is `NUMERIC` rather than an error. Written
 * out because `Table` has one question that depends on it: a decimal is held as
 * text, and a column that converts text to a number loses the exactness without
 * saying so.
 */
function sqliteAffinity(declared) {
    const t = `${declared || ""}`.toUpperCase();

    if (t.includes("INT"))                             return "INTEGER";
    if (t.includes("CHAR") || t.includes("CLOB") ||
        t.includes("TEXT"))                            return "TEXT";
    if (t === "" || t.includes("BLOB"))                return "BLOB";
    if (t.includes("REAL") || t.includes("FLOA") ||
        t.includes("DOUB"))                            return "REAL";
    return "NUMERIC";
}

/*
 * Table -- a shape, a place to keep it, and the statements between them.
 *
 * This is the **portable half** of the data story, and it is here rather than in
 * C for two reasons.  `docs/extending.md`'s rule -- *"prefer JS: if it can go in
 * rad.js, it should"* -- and a harder one: a record's values live in a private
 * bag scoped to `Record`, so nothing outside this file can read what a record
 * holds.  A driver is C (`bta_sqlite.c`); what a row *means* is here.
 *
 * ## What it needs from a connection, and nothing more
 *
 *     Query(sql, params)   Execute(sql, params)   Transaction(fn)
 *     Dialect -> { Placeholder, Quote, NewKey }
 *
 * So a `Database.Postgres` written later changes nothing in this class: the
 * three facts known to differ between engines -- how a bound value is spelled,
 * how a name is quoted, how the key of a new row comes back -- are read off
 * `Dialect` instead of assumed.
 *
 * ## The two things it does not have to invent
 *
 * **A row is a file.** `Record.Load` reads an object keyed by whatever the
 * record's `Naming` rule spells, and a row is exactly that -- which is what
 * `Naming = "snake"` was written for, years of a plan before there was any SQL.
 * So reading is `Load(row)`, leniently, and a column today's rules would refuse
 * lands on `Problems` instead of costing the other nineteen.
 *
 * **And `Serialize` is a row.** It answers a plain object keyed the same way,
 * with decimals already text. So writing is `Serialize(true)` and **nothing in
 * here converts a value** -- a `Table` uses sqlite's own types and no format of
 * its own.
 *
 * ## The one thing sqlite cannot do, said as sqlite's limitation
 *
 * A decimal is held as **TEXT**, because that is the standard type that keeps it
 * exactly: `NUMERIC` and `DECIMAL(12,2)` are *affinities*, and a column declared
 * either turns `'19.90'` into the REAL `19.9` -- measured, and it is what every
 * ORM that declares a `decimal` column gets.
 *
 * The consequence is that **sqlite cannot order or total such a column**, since
 * text compares byte by byte and `'9.00'` follows `'10.00'`. That is a
 * limitation of sqlite and not of this runtime, and the answer is the one this
 * runtime already gives everywhere else: **the program filters and orders**, the
 * way `Locale.Compare` already has to for names. A second driver over an engine
 * with a real `NUMERIC` maps the same field to a real numeric column and none of
 * this applies -- which is why the driver is named for the library it is.
 *
 * There is an opt-in [extension](../src/bta_sqlite.c) -- a `DECIMAL` collation
 * and `decimal_sum` -- for a program that wants the database to do it anyway.
 * Naming it in a **schema** makes the file unreadable by every client that has
 * not registered it, so it is documented as the trade it is rather than
 * recommended.
 *
 * A key the record does not describe survives both trips, and here that earns
 * its keep twice: a column this shape says nothing about is read, kept and
 * written back rather than being emptied by the first program that saves a row.
 *
 * ## What it is not
 *
 * No lazy loading, no identity map, no session.  A detail is loaded when its
 * master is or not at all: the machinery those things exist for is machinery to
 * make lazy loading safe, and lazy loading is what turns one screen into a
 * thousand statements and hides it.  See `docs/plans/data-plan.md`.
 */
GLOBAL.Table = class Table {
    #conn;
    #name;
    #of;
    /* Whether the shape has been checked against the table. Once, lazily: see
     * #fit. */
    #fitted = false;

    constructor(conn, name, of) {
        if (!conn || typeof conn.Query !== "function")
            throw new TypeError("Table: expected a connection -- one a driver " +
                                "opened, like Database.Sqlite(path)");
        if (typeof name !== "string" || name === "")
            throw new TypeError("Table: expected the name of a table");
        if (!isRecordClass(of))
            throw new TypeError("Table: expected a Record class for its shape");

        this.#conn = conn;
        this.#name = name;
        this.#of   = of;
    }

    /** the table's name */
    get Name()       { return this.#name; }
    /** the connection it came from */
    get Connection() { return this.#conn; }
    /* The class, so `table.Shape` is what a program constructs a fresh row
     * from without having to have imported the name a second time. */
    /** the record class it maps */
    get Shape()      { return this.#of; }

    /* --- the dialect, applied ------------------------------------------- */

    /* An identifier, quoted the way this engine quotes one -- doubled inside,
     * which is how every SQL dialect escapes its own quote. */
    #quote(name) {
        const q = this.#conn.Dialect.Quote;
        return q + `${name}`.split(q).join(q + q) + q;
    }

    /* One placeholder. `%d` in it is the one-based position, so sqlite's `?`
     * ignores it and PostgreSQL's `$%d` uses it. */
    #mark(at) {
        const p = this.#conn.Dialect.Placeholder;
        return p.includes("%d") ? p.replace("%d", `${at}`) : p;
    }

    /*
     * Does this shape fit this table?  Asked once, on the first statement.
     *
     * **This exists because of a silent failure that is worth the paragraph.**
     * SQL identifiers are case-insensitive, so a record whose `Naming` produces
     * `Code` against a column called `code` *writes perfectly* -- sqlite accepts
     * `"Code"` as naming the same column -- and *reads empty*: `Load` matches a
     * file's keys exactly, so `code` is a key the shape does not describe and
     * goes into the bag of unknown keys, where it is faithfully kept and handed
     * back on the next save.  The record comes out at every default with the
     * real values hidden inside it, nothing throws, and the first thing anybody
     * notices is a form full of blanks.
     *
     * So the shape is compared with the table and the answer is a sentence. It
     * catches two more things on the way, for nothing: a field with no column at
     * all, and a table that is not there -- which is a better message than
     * sqlite's `no such table` arriving from the middle of a generated
     * statement.
     *
     * A column the *shape* says nothing about is not a complaint: that is the
     * round trip working, and keeping it is the point.
     *
     * Lazily, and not in the constructor, so building a Table costs nothing and
     * a program may declare one before the schema exists.
     */
    #fit() {
        if (this.#fitted)
            return;
        /* Set first: a shape that does not fit throws on every statement, and
         * asking the database again each time would add a PRAGMA to each of
         * them. */
        this.#fitted = true;

        const blank = this.#blank();

        /*
         * The shape on its own, first, because it is the true diagnosis: a
         * nested record and a list both serialise to something a column cannot
         * hold, and comparing them against the table would report a *missing
         * column* -- which sends whoever reads it looking for the wrong thing.
         */
        for (const name of blank.PropertyNames()) {
            const kind = blank.PropertyInfo(name).Kind;

            if (kind === "record" || kind === "list")
                throw new TypeError(
                    `${this.#of.name}.${name} is a ${kind} and a column holds ` +
                    `one value: a detail is its own table, and saving one with ` +
                    `its master is not built yet (docs/plans/data-plan.md)`);
        }

        const columns = this.#conn.Columns(this.#name);
        if (!columns.length)
            throw new Error(`there is no table called ${this.#name} in ` +
                            `${this.#conn.Path || "this database"}`);

        const lower = {}, declared = {};
        for (const col of columns) {
            lower[`${col.Name}`.toLowerCase()]    = col.Name;
            declared[`${col.Name}`.toLowerCase()] = `${col.Type}`;
        }

        for (const name of blank.PropertyNames()) {
            const info  = blank.PropertyInfo(name);
            const want  = info.Column;
            const found = lower[`${want}`.toLowerCase()];

            if (found === undefined)
                throw new Error(
                    `${this.#of.name}.${name} wants a column '${want}' and ` +
                    `${this.#name} has ${columns.map((c) => c.Name).join(", ")}`);

            if (found !== want)
                throw new Error(
                    `${this.#of.name}.${name} spells its column '${want}' and ` +
                    `${this.#name} spells it '${found}'. SQL would accept ` +
                    `either and reading would silently find neither -- fix the ` +
                    `record's Naming rule, or give the field ` +
                    `as: "${found}"`);

            /*
             * **A decimal needs a column that keeps text, and getting this
             * wrong loses the exactness in silence.**
             *
             * sqlite has no exact numeric type. `NUMERIC` and `DECIMAL(12,2)`
             * are *affinities*, not types, and a column declared either turns
             * `'19.90'` into the REAL `19.9` -- the scale gone and the value
             * binary, which is the one thing `Decimal` exists to prevent.
             * Nothing throws; the money is simply approximate from then on.
             *
             * So the column has to have TEXT affinity (or none at all). Judged
             * by sqlite's own rules, in sqlite's own order.
             */
            const declaredType = declared[`${want}`.toLowerCase()] || "";
            if (info.Kind === "decimal") {
                const affinity = sqliteAffinity(declaredType);

                if (affinity !== "TEXT" && affinity !== "BLOB")
                    throw new Error(
                        `${this.#of.name}.${name} is a decimal, which sqlite ` +
                        `can only hold exactly as text -- and ` +
                        `${this.#name}.${found} is declared ` +
                        `'${declaredType}', which has ${affinity} affinity, so ` +
                        `sqlite would store 19.90 as the double 19.9. Declare ` +
                        `the column TEXT`);
            }
        }
    }

    /* --- the shape, asked once per call --------------------------------- */

    /*
     * A blank record of this shape, for the questions that are about the class
     * and not about a value. `PropertyInfo` is an instance member because that
     * is the family it belongs to (`PropertyNames`, `PropertyOptions`), and a
     * record with no values is what a class looks like from here.
     */
    #blank() { return new this.#of(); }

    /* The properties that are the identity, and what they are called in a row.
     * Refused rather than answered when there are none: a record with no key
     * can be read and cannot be written, and that is a sentence rather than an
     * `UPDATE` with no `WHERE`. */
    #keys() {
        const blank = this.#blank();
        const out   = [];

        for (const name of blank.PropertyNames()) {
            const info = blank.PropertyInfo(name);
            if (info && info.Key)
                out.push(info);
        }
        if (!out.length)
            throw new Error(`${this.#of.name} has no key, so a row of it cannot ` +
                            `be found, changed or removed -- mark one field ` +
                            `\'key: true\'`);
        return out;
    }

    /* --- reading -------------------------------------------------------- */

    /*
     * The rows a filter matches, as records.
     *
     * The filter is **SQL**, because SQL is the filter language and sqlite
     * already says what is wrong with one -- a grammar of our own inside a value
     * is what `docs/plans/data-plan.md` refused twice. Values are parameters
     * and are never pasted in; there is no way from here to ask for that.
     *
     *     customers.Where("balance > ? ORDER BY name", 0)
     *
     * Anything that follows the filter follows it into the statement, so
     * ordering and a limit need no words of their own.
     */
    /**
     * the filter is **SQL**; anything after it (`ORDER BY`, `LIMIT`) goes too
     */
    Where(sql, ...params) {
        this.#fit();

        const where = sql ? ` WHERE ${sql}` : "";
        const rows  = this.#conn.Query(
            `SELECT * FROM ${this.#quote(this.#name)}${where}`, params);

        return rows.map((row) => this.#of.Load(row));
    }

    /** every row, as records */
    All() { return this.Where(null); }

    /*
     * One row by its key, or `null`.
     *
     * Several arguments for a compound key, in the order the fields are
     * declared -- which is the order `#keys` answers in, so the two cannot
     * disagree.
     */
    /** one record or `null`; one value per key field, in declaration order */
    Find(...key) {
        this.#fit();

        const keys = this.#keys();

        if (key.length !== keys.length)
            throw new RangeError(
                `${this.#of.name} is identified by ${keys.length} ` +
                `field${keys.length === 1 ? "" : "s"} ` +
                `(${keys.map((k) => k.Column).join(", ")}), ` +
                `and Find was given ${key.length}`);

        const where = keys.map((k, i) => `${this.#quote(k.Column)} = ${this.#mark(i + 1)}`)
                          .join(" AND ");
        const rows  = this.#conn.Query(
            `SELECT * FROM ${this.#quote(this.#name)} WHERE ${where}`, key);

        return rows.length ? this.#of.Load(rows[0]) : null;
    }

    /* How many, which is a number and not a list of records nobody asked to
     * build. The same filter `Where` takes. */
    /** a number, building no records */
    Count(sql, ...params) {
        this.#fit();

        const where = sql ? ` WHERE ${sql}` : "";
        const rows  = this.#conn.Query(
            `SELECT count(*) AS n FROM ${this.#quote(this.#name)}${where}`,
            params);

        return rows[0].n;
    }

    /* --- writing -------------------------------------------------------- */

    /*
     * A new row, and **the record is told its key**.
     *
     * The key columns are left out of the statement when they are at what the
     * field starts from, so the engine assigns one; a key the program chose is
     * written like any other column.
     */
    /** INSERT, and tells the record its new key */
    Insert(rec) {
        this.#fit();
        this.#mine(rec);

        const keys    = this.#keys();
        const row     = rec.Serialize(true);
        const decided = rec.Serialize();
        const blanks  = keys.filter((k) => !hasOwn.call(decided, k.Column));

        for (const k of blanks) delete row[k.Column];

        const cols = ownKeys(row);
        if (!cols.length)
            throw new Error(`${rec.constructor.name} has nothing to insert: ` +
                            `every field is at what it starts from`);

        const marks = cols.map((c, i) => this.#mark(i + 1)).join(", ");
        const done  = this.#conn.Execute(
            `INSERT INTO ${this.#quote(this.#name)} ` +
            `(${cols.map((c) => this.#quote(c)).join(", ")}) VALUES (${marks})`,
            cols.map((c) => row[c]));

        /*
         * The generated key, back into the record -- through its setter, so it
         * is checked like anything else. Only when the engine reports one and
         * only for a single key it was asked to generate: a compound key or one
         * the program chose has nothing to learn here.
         */
        if (blanks.length === 1 && keys.length === 1) {
            if (this.#conn.Dialect.NewKey !== "LastId")
                throw new Error(
                    `this driver reports a new key by ` +
                    `'${this.#conn.Dialect.NewKey}', which Table does not do ` +
                    `yet -- give ${rec.constructor.name} its key before ` +
                    `inserting`);
            rec[this.#property(blanks[0])] = done.LastId;
        }
        return rec;
    }

    /*
     * An existing row, by its key.
     *
     * A statement that matched nothing is a **throw** and not a quiet zero: a
     * save that saved nothing and said so is the shape of bug that is found
     * days later by somebody looking for the value they typed.
     */
    /** UPDATE by key; **throws** when it matched no row */
    Update(rec) {
        this.#fit();
        this.#mine(rec);

        const keys = this.#keys();
        const row  = rec.Serialize(true);
        const cols = ownKeys(row).filter(
            (c) => !keys.some((k) => k.Column === c));

        if (!cols.length)
            throw new Error(`${rec.constructor.name} is all key, so there is ` +
                            `nothing to update`);

        let at    = 0;
        const set = cols.map((c) => `${this.#quote(c)} = ${this.#mark(++at)}`)
                        .join(", ");
        const on  = keys.map((k) => `${this.#quote(k.Column)} = ${this.#mark(++at)}`)
                        .join(" AND ");
        const done = this.#conn.Execute(
            `UPDATE ${this.#quote(this.#name)} SET ${set} WHERE ${on}`,
            cols.map((c) => row[c]).concat(keys.map((k) => row[k.Column])));

        if (!done.Changes)
            throw new Error(
                `no row in ${this.#name} with ` +
                `${keys.map((k) => `${k.Column} = ${row[k.Column]}`).join(" and ")}`);
        return rec;
    }

    /*
     * Insert or update, decided by the key.
     *
     * **A key at what its field starts from is a row that was never saved** --
     * an `int` key at 0 -- so nothing needs a flag. The corollary is worth
     * knowing: a key the *program* chooses (a code somebody types) is never at
     * its starting value once it is filled, so `Save` will try to update a row
     * that is not there and say so. Insert that one with `Insert`.
     */
    /** `Insert` when the key is at its starting value, else `Update` */
    Save(rec) {
        this.#fit();
        this.#mine(rec);

        const decided = rec.Serialize();
        const fresh   = this.#keys().some((k) => !hasOwn.call(decided, k.Column));

        return fresh ? this.Insert(rec) : this.Update(rec);
    }

    /* By key, and a row that was not there is a throw for the same reason an
     * Update that changed nothing is. */
    /** DELETE by key; **throws** when it matched no row */
    Delete(rec) {
        this.#fit();
        this.#mine(rec);

        const keys = this.#keys();
        const row  = rec.Serialize(true);
        const on   = keys.map((k, i) => `${this.#quote(k.Column)} = ${this.#mark(i + 1)}`)
                         .join(" AND ");
        const done = this.#conn.Execute(
            `DELETE FROM ${this.#quote(this.#name)} WHERE ${on}`,
            keys.map((k) => row[k.Column]));

        if (!done.Changes)
            throw new Error(
                `no row in ${this.#name} with ` +
                `${keys.map((k) => `${k.Column} = ${row[k.Column]}`).join(" and ")}`);
        return rec;
    }

    /* --- the two small ones --------------------------------------------- */

    /* The property a column belongs to, which is the map read the other way
     * round. Only ever asked about a key, so a scan of a handful of names. */
    #property(info) {
        const blank = this.#blank();

        for (const name of blank.PropertyNames()) {
            const it = blank.PropertyInfo(name);
            if (it && it.Column === info.Column)
                return name;
        }
        /* Unreachable: `info` came from this same walk. */
        throw new Error(`${this.#of.name} has no field for ${info.Column}`);
    }

    /* A record of some other shape, caught before its fields become a
     * statement about the wrong table. */
    #mine(rec) {
        if (!(rec instanceof this.#of))
            throw new TypeError(
                `${this.#name} holds ${this.#of.name}, and that is ` +
                `${rec && rec.constructor ? `a ${rec.constructor.name}`
                                          : `${typeof rec}`}`);
    }
};

/*
 * `conn.Table(name, of)` -- on the prototype from here, because a Table is JS
 * and a connection is C, and this is the seam.  Hung on `Connection` itself
 * rather than on the sqlite driver's own object, so every driver gets it for
 * nothing.
 */
if (GLOBAL.Connection) {
    /**
     * a [`Table`](docs/reference/globals/Database.md): the rows of `name` as
     * records of `Shape`
     */
    GLOBAL.Connection.prototype.Table = function (name, of) {
        return new GLOBAL.Table(this, name, of);
    };
}
