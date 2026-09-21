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
 * The worker gets a different sentence because it is in a different position:
 * `bta_locale_init` is deliberately not called there, so `Locale.Compare` --
 * which needs no catalogue, only g_utf8_collate -- is missing along with the
 * half that does.  Pointing a worker at a name it has not got would be the
 * second wrong answer in a row.
 * ---------------------------------------------------------------------- */

defineProperty(String.prototype, "localeCompare", {
    configurable: true,
    writable:     true,
    value() {
        throw new TypeError(
            typeof Locale === "undefined"
                ? "localeCompare compares code units on this engine, so it is " +
                  "refused -- and a worker has no Locale either, so order the " +
                  "list on the main thread with Locale.Compare"
                : "localeCompare compares code units on this engine, so it is " +
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

File.LoadJson = function (path) {
    const text = File.Load(path);
    try {
        return JSON.parse(text);
    } catch (e) {
        /* Whose fault it is, which a bare SyntaxError never says. */
        throw new SyntaxError(`${path}: ${e.message}`);
    }
};

File.SaveJson = function (path, value) {
    File.Save(path, `${JSON.stringify(value, null, 2)}\n`);
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
    /* The value, or `fallback` when there is none -- so a caller never has to
     * tell "missing" from "false". */
    Get(key, fallback) {
        const all = settingsAll();
        return hasOwn.call(all, key) ? all[key] : fallback;
    },

    Set(key, value) {
        settingsAll()[key] = value;
        return settingsFlush();
    },

    /* Own keys only, the same rule and for the same reason as Dictionary.Has:
     * `"toString" in {}` is true, and a settings file nobody wrote a toString
     * into must not answer about Object.prototype. */
    Has(key)    { return hasOwn.call(settingsAll(), key); },
    Keys()      { return ownKeys(settingsAll()); },
    Delete(key) { delete settingsAll()[key]; return settingsFlush(); },
    Clear()     { settingsCache = {}; return settingsFlush(); },

    /* Where they live, for an application that wants to say so. */
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

    get Enabled() { return this._id !== null; }

    set Enabled(on) {
        if (on) this.Start();
        else    this.Stop();
    }

    Start(delay) {
        if (delay !== undefined) this.Delay = delay;
        this.Stop();
        this._id = setTimer(() => this.fire(), Math.max(0, this.Delay));
        return this;
    }

    Stop() {
        if (this._id !== null) clearTimer(this._id);
        this._id = null;
        return this;
    }

    /* Fires once and does not repeat: the other half of what timers are for. */
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
    static After(delay, tick) { return new Timer(delay, tick).Once(); }
    static Every(delay, tick) { return new Timer(delay, tick).Start(); }
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

    get Running() { return this.#on; }

    /* Running or stopped, the same question and the same answer -- so nothing
     * has to stop the watch in order to read it. */
    get Elapsed() {
        return this.#on ? this.#held + (monotonicNow() - this.#from) : this.#held;
    }

    /* Starting one that is already running is not an error and must not restart
     * it: a Start button pressed twice is one intention said twice. */
    Start() {
        if (!this.#on) {
            this.#from = monotonicNow();
            this.#on   = true;
        }
        return this;
    }

    Stop() {
        if (this.#on) {
            this.#held += monotonicNow() - this.#from;
            this.#on    = false;
        }
        return this;
    }

    /* Back to zero, and stopped -- what the button next to Start means. */
    Reset() {
        this.#held = 0;
        this.#from = 0;
        this.#on   = false;
        return this;
    }

    /* All three hand the watch back, so `new Stopwatch().Start()` is one line. */
};

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

    Keys(bag) {
        const held = dictionaryBag(bag, "Keys");
        return held ? ownKeys(held) : [];
    },

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
    Entries(bag) {
        const held = dictionaryBag(bag, "Entries");
        if (!held) return [];
        return ownKeys(held).map((key) => ({ Key: key, Value: held[key] }));
    },

    Count(bag) {
        const held = dictionaryBag(bag, "Count");
        return held ? ownKeys(held).length : 0;
    },

    /*
     * Own keys only, which `key in bag` is not: `"toString" in {}` is true, and
     * a dictionary that answered that about a bag nobody put a `toString` in
     * would be answering about the prototype instead of about the data.
     */
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

    for (const key in options || {}) {
        if (!(key in REGEX_FLAGS) && !REGEX_REWRITES.includes(key)) {
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
    get Pattern() { return this.#pattern; }

    IsMatch(text) {
        this.#re.lastIndex = 0;
        return this.#re.test(String(text));
    }

    /* The first match at or after `start`, or `null`. */
    Match(text, start = 0) {
        this.#re.lastIndex = Math.max(0, start);
        const found = this.#re.exec(String(text));
        return found ? new Match(found) : null;
    }

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
     * have.
     */
    Replace(text, replacement, count) {
        const subject = String(text);
        let   matches = this.Matches(subject);
        if (count !== undefined) matches = matches.slice(0, Math.max(0, count));
        if (matches.length === 0) return subject;

        const evaluate = typeof replacement === "function"
            ? replacement : null;
        const spec = evaluate ? "" : String(replacement);

        let out = "";
        let at  = 0;

        for (const match of matches) {
            out += subject.slice(at, match.Index);
            out += evaluate ? String(evaluate(match))
                            : expandReplacement(spec, match, subject);
            at = match.Index + match.Length;
        }
        return out + subject.slice(at);
    }

    /* What the matches separate.  Captured groups land in the result too, which
     * is .NET's answer and the useful one: it is how a split keeps what it split
     * on. */
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
 * And one thing falls out of it rather than needing to be said: an `int` key at
 * **0** -- what the kind starts from -- is a row that has not been saved yet, so
 * nothing needs a flag to tell an INSERT from an UPDATE.
 */
const FIELD_COMMON = ["as", "def", "key"];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
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

    for (const key in opts || {}) {
        if (!FIELD_COMMON.includes(key) && !spec.takes.includes(key)) {
            const takes = FIELD_COMMON.concat(spec.takes).join(", ");
            throw new RangeError(`${fieldName(kind)}: '${key}' is not one of ` +
                                 `its options (${takes})`);
        }
        field[key] = opts[key];
    }
    for (const key in extra || {}) field[key] = extra[key];
    return field;
}

/*
 * The value a field accepts, or a throw saying what is wrong with the one it was
 * given -- the same bargain every setter in this runtime makes, and the reason a
 * record can be trusted by whoever reads it next.
 */
function fieldValue(field, name, v, mayBeEmpty) {
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
         * agree with the value that was set. */
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
            return fieldValue(field.item, `${name}[${i}]`, item);
        });
    }
    }
}

GLOBAL.Field = {
    Text:   (opts) => makeField("text",   opts),
    Int:    (opts) => makeField("int",    opts),
    Number: (opts) => makeField("number", opts),
    Date:   (opts) => makeField("date",   opts),
    Time:   (opts) => makeField("time",   opts),
    Bytes:  (opts) => makeField("bytes",  opts),

    /* The default first, because it is the whole of what a boolean field says. */
    Bool: (def, opts) => makeField("bool", opts, { def: def === true }),

    /* The values it accepts, which is also what PropertyOptions hands to
     * whoever is editing it -- the same thing BTA_CLASS_ENUM does in C, and for
     * the same reason: the list cannot drift from what the setter takes. */
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
    Decimal: (opts) => {
        const places = opts && opts.decimals !== undefined ? opts.decimals : 2;
        const rest   = {};

        for (const key in opts || {}) if (key !== "decimals") rest[key] = opts[key];

        const field = makeField("decimal", rest, {
            places,
            def: new Decimal("0", places),
        });
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
    Record: (of, opts) => {
        const field = makeField("record", opts);

        if (isRecordClass(of))             field.of   = of;
        else if (typeof of === "function") field.make = of;
        else throw new TypeError("Field.Record: expected a Record class, or " +
                                 "() => the class for a shape that contains " +
                                 "itself");
        return field;
    },

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
            const own = ownDescriptor(c, "Fields");
            if (!own) continue;                    /* inherited: already taken */

            /* `static get Fields()` used to declare **nothing, silently**:
             * a getter's descriptor has no `value`, so the loop below ran over
             * `undefined` and the class came out with no fields at all.  It is
             * a tempting way to write a shape that contains itself -- the
             * getter defers the class body's own name until it is bound -- so
             * it is refused out loud rather than found later.  The thunk is the
             * way: `Field.List(() => MenuItem)`. */
            if (!own.value || typeof own.value !== "object")
                throw new TypeError(`${c.name}.Fields must be a static object ` +
                                    `of Fields; a getter (or anything else) ` +
                                    `here declares nothing`);

            for (const name in own.value) fields[name] = own.value[name];
        }

        const naming = ctor.Naming || "same";
        if (!NAMINGS[naming])
            throw new RangeError(`${ctor.name}.Naming: '${naming}' is not one of ` +
                                 `${ownKeys(NAMINGS).join(", ")}`);

        for (const name in fields) {
            const field = fields[name];
            if (!field || field.__field !== true)
                throw new TypeError(`${ctor.name}.Fields.${name} is not a Field`);

            /* A field declared twice -- once here and once as a hand-written
             * accessor -- would have one of them silently win.  Say so instead. */
            if (ownDescriptor(ctor.prototype, name))
                throw new Error(`${ctor.name}.${name} is both declared in Fields ` +
                                `and written by hand: pick one`);

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
    Clone() { return this.constructor.Load(this.Serialize(true)); }

    /*
     * What is wrong with what it holds, as a list of complaints, without
     * throwing.  Assigning is checked one field at a time and stops at the first
     * bad one; a file wants all of them at once, and so does anything showing a
     * form's worth of errors.
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

    PropertyNames() { return ownKeys(this.#fields()); }

    /* The values a field accepts, or none -- the same answer a widget gives, so
     * a property grid can edit a record without being told it is one. */
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
     * A file, read.  Lenient on purpose: a value it cannot accept leaves the
     * field at what it starts from and goes on the record's Problems, so one bad
     * key does not cost the other twenty -- and a project.json with a broken
     * `startup` can still be opened and fixed.
     *
     * This is the only door past the setters, and it is in here: an application
     * holds no key to the bag.
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
                rec.#d[name] = fieldValue(field, name, v);
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

    get Name()       { return this.#name; }
    get Connection() { return this.#conn; }
    /* The class, so `table.Shape` is what a program constructs a fresh row
     * from without having to have imported the name a second time. */
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
    Where(sql, ...params) {
        this.#fit();

        const where = sql ? ` WHERE ${sql}` : "";
        const rows  = this.#conn.Query(
            `SELECT * FROM ${this.#quote(this.#name)}${where}`, params);

        return rows.map((row) => this.#of.Load(row));
    }

    All() { return this.Where(null); }

    /*
     * One row by its key, or `null`.
     *
     * Several arguments for a compound key, in the order the fields are
     * declared -- which is the order `#keys` answers in, so the two cannot
     * disagree.
     */
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
    Insert(rec) {
        this.#fit();
        this.#mine(rec);

        const keys    = this.#keys();
        const row     = rec.Serialize(true);
        const decided = rec.Serialize();
        const blanks  = keys.filter((k) => !(k.Column in decided));

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
    Save(rec) {
        this.#fit();
        this.#mine(rec);

        const decided = rec.Serialize();
        const fresh   = this.#keys().some((k) => !(k.Column in decided));

        return fresh ? this.Insert(rec) : this.Update(rec);
    }

    /* By key, and a row that was not there is a throw for the same reason an
     * Update that changed nothing is. */
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
    GLOBAL.Connection.prototype.Table = function (name, of) {
        return new GLOBAL.Table(this, name, of);
    };
}
