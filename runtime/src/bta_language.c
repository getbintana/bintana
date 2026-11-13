/*
 * The language a Bintana program is written in, which every host shares.
 *
 * A context is made by `bta_new_context` and finished by `bta_close_hatches`,
 * and those two -- with the table of names taken away -- are what make the
 * language *this* one rather than quickjs-ng's. They used to live in
 * `bta_runtime.c`, which is the graphical host, and the console host made a
 * context of its own: a `main` run by `bintana` then had `Object.keys`, `eval`
 * and `globalThis` while the same project under `bintana-gui` did not, and a
 * `ReferenceError` for `setTimeout` named no replacement. One file, linked by
 * both hosts and by a `Task` worker in either, is what keeps them one
 * language.
 */
#include "bta.h"

#include <stdio.h>
#include <string.h>

/*
 * **The names this language took away, and what to write instead.**
 *
 * It used to be a list of names and a paragraph of prose above it, which meant
 * the whole of what a beginner got out of typing `setTimeout` was
 * `ReferenceError: setTimeout is not defined` -- while the replacement was
 * written out in full, a screen away in a comment nobody opens. `rad.js` already
 * refuses `localeCompare` by name, naming `Locale.Compare` in the sentence, and
 * the QuickJS patch in `vendor/` makes a refused property say which property it
 * was. This is the same bargain for the names themselves, and the same bargain
 * `close_hatches` was already paying for at the other end: the *deletion* has to
 * be refused out loud because the silent version is the expensive one.
 *
 * **One table, read by two.** `bta_close_hatches` deletes from it and
 * `Application.Replacements` publishes it, so a name that is taken and a name
 * that says what to use instead cannot disagree -- there is no second list to
 * keep in step, which is the whole of why this is a table and not a list plus a
 * getter with the same entries typed again.
 *
 * A `""` replacement is deliberate and says something: **there is no word for
 * that thing in this language**, which is more use to a reader than being
 * pointed at a neighbour that does a different job. Every entry that has a
 * replacement has one that exists -- `Timer` and `Stopwatch` are in `rad.js`,
 * `Namespace` and `CheckSource` and `Regex` are installed here -- and no entry
 * points at a thing this runtime has never heard of.
 */
/* A name that was taken away, and the sentence that says what to use instead.
 * The two halves are one row because the deletion and the sentence must not be
 * able to disagree: `bta_close_hatches` walks this, `reference_hint` reads it
 * when the engine reports a `ReferenceError`, and `Application.Replacements`
 * hands it out. */
typedef struct { const char *name; const char *use; } BtaReplacement;

/* The globals, and the raw scheduling primitives with them. */
static const BtaReplacement bta_replacements[] = {
    { "eval",  "Application.CheckSource(text) answers whether text would compile" },
    { "Function", "" },     /* the other way to turn a string into code */
    { "globalThis", "Namespace(\"Name\") publishes into the global scope" },
    { "Reflect", "" },      /* metaprogramming this language has no use for */
    { "Symbol", "" },       /* see the note in bta_close_hatches: no replacement
                             * can be reached without the name it needs */
    { "RegExp", "Regex(text, [options]) builds a pattern out of a string" },
    /* Timer is the published way to schedule: it has a name, a switch and hands
     * itself back, and these are the same thing said worse.  rad.js built Timer
     * out of them and holds what it needs. */
    { "setTimeout",    "Timer.After(delay, tick) — the delay comes first" },
    { "setInterval",   "Timer.Every(delay, tick) — the delay comes first" },
    { "clearTimeout",  "Timer.Stop()" },
    { "clearInterval", "Timer.Stop()" },
    /* And the forward-only clock, for the same reason one step further: a
     * reading of it is meaningless alone, so Stopwatch is not a convenience over
     * it but the only shape in which it says anything. */
    { "monotonic", "new Stopwatch().Start(), and .Elapsed for the answer" },
    /*
     * queueMicrotask goes with setTimeout and for the same sentence: it is
     * scheduling with no name of ours, no switch and no handle.  It does work --
     * bta_drain_jobs runs the queue after every event handler, and it was
     * measured running -- which is exactly what made it worth removing rather
     * than leaving: a second way to defer, undocumented, that nothing in this
     * tree ever asked for.  `Timer.After(0, fn)` is the published word, and the
     * day a program needs *before the next frame* rather than *on the next turn*
     * it gets a name instead of this one.
     */
    { "queueMicrotask", "Timer.After(0, tick) — the delay comes first" },
    /*
     * Annex B, and not even that any more: `escape` is a URL encoding no
     * standard recommends, with no caller anywhere here.  `Text.Escape` is markup
     * and `Http` builds its own query strings, so the name is free to mislead and
     * nothing else.
     */
    { "escape",   "" },
    { "unescape", "" },
};

/*
 * What `Object` gave up, keyed as `Object.name` so the two tables cannot collide
 * on a bare word -- `keys` on its own would say nothing about which object it
 * went from.
 *
 * **Only the ones a person plausibly reaches for.** The rest of the statics are
 * in `bta_close_hatches`' own list with the reasoning; a row saying `""` for
 * every one of them would be a list of names nobody wanted rather than a
 * sentence anybody used. `Object.assign` is here because it is the first thing a
 * JavaScript-trained hand types in this language -- and its absence has cost this
 * repository a silent bug of its own (`examples/clients` built an object with it
 * and the `TypeError` landed in a dialog, on a headless run, with nothing on the
 * terminal).
 */
static const BtaReplacement bta_object_replacements[] = {
    { "Object.keys",     "Dictionary.Keys(bag)" },
    { "Object.values",   "Dictionary.Values(bag)" },
    { "Object.entries",  "Dictionary.Entries(bag), as [{ Key, Value }, …]" },
    { "Object.hasOwn",   "Dictionary.Has(bag, key)" },
    { "Object.fromEntries", "a Map, which Dictionary reads the same way" },
    { "Object.assign",   "{ ...a, ...b }" },
    { "Object.defineProperty", "a get/set pair declared in a class" },
    /* Nothing in this language can be locked, and saying so is the answer:
     * there are no imports, so the only code that could write to
     * Object.prototype is the project's own and its libraries'. */
    { "Object.freeze",            "" },
    { "Object.seal",              "" },
    { "Object.preventExtensions", "" },
    { "Object.isFrozen",          "" },
    { "Object.isSealed",          "" },
    { "Object.isExtensible",      "" },
};

/*
 * The suffix a `ReferenceError` carries for a name this language took away.
 *
 * The engine asks it while it builds the error, so a `catch` that shows
 * `e.message` gets the sentence that used to arrive only on the terminal. The
 * table is the same one `Application.Replacements` publishes and
 * `bta_close_hatches` deletes from -- a name and what to write instead cannot
 * disagree. A `""` use is a deliberate answer, not a gap.
 */
static bool bta_reference_hint(JSContext *ctx, const char *name,
                               char *buf, size_t len, void *opaque)
{
    (void)ctx;
    (void)opaque;

    const char *use = bta_replacement_for(name);
    if (!use)
        return false;

    if (*use)
        g_snprintf(buf, len, ": use %s", use);
    else
        g_snprintf(buf, len, ", and nothing here replaces it");
    return true;
}

/* What to write instead of a global the language took away: the row's
 * sentence, `""` when nothing here replaces it, and NULL for a name that was
 * never taken. The error dump of each host reads the same rows the engine's
 * hint does. */
const char *bta_replacement_for(const char *name)
{
    if (!name)
        return NULL;
    for (size_t i = 0; i < G_N_ELEMENTS(bta_replacements); i++)
        if (!strcmp(name, bta_replacements[i].name))
            return bta_replacements[i].use;
    return NULL;
}

/* The bag `Application.Replacements` answers with, built from the two tables.
 * A **verb** and not a read-only property, and it is the shape every "give me
 * the list this runtime has" answer already has -- `Application.Globals()`,
 * `Application.Libraries()`, `Widget.Types()`, `Widget.EventNames()`. */
JSValue bta_application_replacements(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    JSValue out = JS_NewObject(ctx);

    for (size_t i = 0; i < G_N_ELEMENTS(bta_replacements); i++)
        JS_SetPropertyStr(ctx, out, bta_replacements[i].name,
                          JS_NewString(ctx, bta_replacements[i].use));
    for (size_t i = 0; i < G_N_ELEMENTS(bta_object_replacements); i++)
        JS_SetPropertyStr(ctx, out, bta_object_replacements[i].name,
                          JS_NewString(ctx, bta_object_replacements[i].use));
    return out;
}

/*
 * The ways back into the raw language, closed once rad.js has what it needs.
 *
 * Deleting a global does not take away what it reached -- a project's classes
 * are still there, Namespace still publishes, and rad.js still schedules -- it
 * takes away the *name*.  Whatever needs one of these captured it in a closure
 * while it still existed, which is why this runs after the prelude and before
 * the first line of any project.
 *
 * What goes, and why:
 *
 *   eval, Function   the two ways to turn a string into code.  Nothing in
 *                    Bintana does that; Application.CheckSource covers the one
 *                    honest use, which is asking whether text would compile.
 *                    Function.prototype.constructor is the same function by
 *                    another road, so it goes too.
 *   globalThis       the language's own back door to everything at once.  A
 *                    project publishes with Namespace(), which is the name for
 *                    that here.
 *   Reflect          metaprogramming this language has no use for, and the
 *                    remaining way to poke at objects by name.
 *   setTimeout &c    the raw scheduling primitives, replaced by Timer --
 *                    Timer.After and Timer.Every say the same in one line and
 *                    hand back something that can still be stopped.
 *   monotonic        the forward-only clock, replaced by Stopwatch.  A single
 *                    reading of it counts from the machine's boot and means
 *                    nothing on its own; leaving the name would invite it being
 *                    printed or stored as if it were a time.
 *
 * The compiler itself stays: JS_Eval() is how a project is loaded at all.
 * This is curation of the surface, not a sandbox -- a project still holds every
 * capability the runtime gave it, and Terminal.Run is Exec by another name.
 */
/*
 * A refusal is said out loud, because the silent version is the expensive one.
 * `delete` answers true for a name that was never there, so the only way this
 * comes back false is an engine that made one of these non-configurable -- at
 * which point `close_hatches` is theatre, the hatch is open, and the only
 * alarm left is a list in `tests/widgets` somebody has to keep in step by hand.
 */
static void delete_named(JSContext *ctx, JSValueConst obj, const char *name)
{
    JSAtom atom = JS_NewAtom(ctx, name);
    int    gone = JS_DeleteProperty(ctx, obj, atom, 0);

    JS_FreeAtom(ctx, atom);
    if (gone <= 0) {
        fprintf(stderr, "bintana: '%s' would not be deleted -- the hatch is "
                        "still open\n", name);
        if (gone < 0)
            JS_FreeValue(ctx, JS_GetException(ctx));
    }
}

void bta_close_hatches(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);

    JSValue fn = JS_GetPropertyStr(ctx, global, "Function");
    if (JS_IsObject(fn)) {
        JSValue proto = JS_GetPropertyStr(ctx, fn, "prototype");
        delete_named(ctx, proto, "constructor");
        JS_FreeValue(ctx, proto);
    }
    JS_FreeValue(ctx, fn);

    /*
     * GeneratorFunction is the same hatch by a side door: it has no global name,
     * but every generator's prototype carries it and it compiles strings just as
     * Function does.  (AsyncFunction needs Promise, which is not installed.)
     *
     * That parenthesis is true and answers only half of what the same absence
     * decides.  JS_AddIntrinsicPromise builds the AsyncFunction constructor --
     * so there is no hatch here -- **and** is the only thing that registers the
     * engine's async classes, without which an async function object can never
     * be collected and JS_FreeRuntime aborts at exit.  That is why `async` is
     * refused in the parser now; see patch 5 in AGENTS.md.
     */
    JSValue gen = JS_Eval(ctx, "(function* () {})", 17, "<hatches>",
                          JS_EVAL_TYPE_GLOBAL);
    if (!JS_IsException(gen)) {
        JSValue proto = JS_GetPrototype(ctx, gen);
        delete_named(ctx, proto, "constructor");
        JS_FreeValue(ctx, proto);
    }
    JS_FreeValue(ctx, gen);

    /*
     * Object, emptied.
     *
     * What a control can be asked for is answered by Widget.PropertyNames(),
     * what a plain object holds by Dictionary, and a property is written by
     * declaring `get`/`set` in a class -- so every static here either has a word
     * of its own in this language or is machinery rad.js is built out of, and
     * rad.js captured what it needs before this runs.
     *
     * **Emptied and not trimmed, because trimming it was wrong twice.** The
     * singulars were taken and the *plurals* left behind: `defineProperties`
     * wrote the accessors `defineProperty` was removed to withhold, and
     * `getOwnPropertyDescriptors` read what its singular could not -- enough to
     * replace the setter on a Record's field with one that validates nothing.
     * A list of what to keep is a list somebody has to get right again every
     * time the engine grows a member, and quickjs-ng grew `groupBy` and `hasOwn`
     * after that list was written.  So the rule runs the other way: nothing
     * here, and an equivalent is published when something actually needs one.
     * Nothing in this repository called any of these but `keys`.
     *
     * `prototype` is absent from the list because it cannot be taken: it is
     * non-configurable, and rad.js walks the chain up to it.
     */
    JSValue object = JS_GetPropertyStr(ctx, global, "Object");
    static const char *statics[] = {
        /* Choosing or reading a prototype. */
        "create", "getPrototypeOf", "setPrototypeOf",
        /* Writing properties: what Record does, and only Record. */
        "defineProperty", "defineProperties",
        /* Reading them back, which PropertyNames() answers. */
        "getOwnPropertyNames", "getOwnPropertyDescriptor",
        "getOwnPropertyDescriptors", "getOwnPropertySymbols",
        /* Reading a dictionary, which is Dictionary. */
        "keys", "values", "entries", "hasOwn", "fromEntries", "assign",
        /* And the rest, which nothing here has ever asked for.  When something
         * does, it gets a name in this language rather than this one back. */
        "groupBy", "is", "freeze", "isFrozen", "seal", "isSealed",
        "preventExtensions", "isExtensible",
    };
    for (size_t i = 0; i < G_N_ELEMENTS(statics); i++)
        delete_named(ctx, object, statics[i]);

    /*
     * And the same two capabilities spelled on the prototype, where every object
     * in the program carries them: `__defineGetter__` is defineProperty and
     * `__lookupGetter__` is getOwnPropertyDescriptor walking the chain, so
     * `c.__lookupGetter__("Name")` handed out a Record's own accessor and
     * `__defineSetter__` replaced it.  Leaving these while taking the statics
     * would be theatre -- they reach the same prototype -- which is the reason
     * __proto__ went with getPrototypeOf in the first place.
     *
     * hasOwnProperty, isPrototypeOf, propertyIsEnumerable, toString and valueOf
     * stay: they ask about an object rather than rewriting it, and the last two
     * are how a value becomes a string at all.
     */
    JSValue object_proto = JS_GetPropertyStr(ctx, object, "prototype");
    static const char *proto_hatches[] = {
        "__proto__",
        "__defineGetter__", "__defineSetter__",
        "__lookupGetter__", "__lookupSetter__",
    };
    for (size_t i = 0; i < G_N_ELEMENTS(proto_hatches); i++)
        delete_named(ctx, object_proto, proto_hatches[i]);
    JS_FreeValue(ctx, object_proto);
    JS_FreeValue(ctx, object);

    /*
     * `Array.fromAsync`, which is an async function the engine builds lazily on
     * first read -- and patch 5's reason, arriving by a door the parser cannot
     * guard. Without `JS_AddIntrinsicPromise` the async classes are never
     * registered, so the object that read builds can never be collected: one
     * `typeof Array.fromAsync` (which answered "object") was enough to make
     * `JS_FreeRuntime` abort at exit, 134, after the program had done its work.
     * Found through `Widget.Members("Array")`, which reads every own property
     * of the constructor. It cannot work without promises anyway, so it goes.
     * The async classes are registered now (see bta_new_context), so it would
     * be collected -- and it answers a promise, which is reason enough.
     */
    /*
     * `Promise`, whose intrinsic is installed for one reason -- a module is
     * evaluated through a promise -- and whose name is not part of the
     * language.  Nothing a program writes can reach one: patches 5 and 13
     * refuse `async`, `await` and `import()`, which are the only syntax that
     * makes or hands back a promise.
     */
    delete_named(ctx, global, "Promise");

    JSValue array = JS_GetPropertyStr(ctx, global, "Array");
    if (JS_IsObject(array))
        delete_named(ctx, array, "fromAsync");
    JS_FreeValue(ctx, array);

    /*
     * RegExp, whose name goes the way Function's did -- and this is the half of
     * the bargain Timer's removal needed.  `/x/g` is syntax and still produces
     * one, which is why taking the name was once judged to buy little: what
     * goes is `new RegExp(p, flags)`, so a pattern **built from strings** has
     * exactly one spelling now and it is `Regex` (rad.js captured the
     * constructor before this runs, and `Regex` is built on it).
     *
     * The prototype's own `constructor` goes first, the same side door
     * GeneratorFunction arrived by: `(/(?:)/).constructor` hands the function
     * straight back, and leaving it while deleting the global would be theatre.
     * Nothing here reads it -- `instanceof` walks the prototype chain and does
     * not ask.
     */
    JSValue regexp = JS_GetPropertyStr(ctx, global, "RegExp");
    if (JS_IsObject(regexp)) {
        JSValue proto = JS_GetPropertyStr(ctx, regexp, "prototype");
        delete_named(ctx, proto, "constructor");
        JS_FreeValue(ctx, proto);
    }
    JS_FreeValue(ctx, regexp);

    /*
     * The list the table above replaced, walked for the deletion itself. The
     * second column is not read here: it is published by
     * `Application.Replacements`, off the same rows.
     */
    for (size_t i = 0; i < G_N_ELEMENTS(bta_replacements); i++)
        delete_named(ctx, global, bta_replacements[i].name);

    /*
     * And the two hooks `rad.js` captured, which were never language names and
     * so have no row in the table above: where a class's `.record` shape is
     * declared, and what a bare name resolves to.  Gone from here on, which is
     * what keeps them out of `Application.Globals()` and out of the published
     * surface. `formsHooks` is the graphical host's: the door forms.js hands C
     * its three hooks through, and a host that has no forms.js deletes a name
     * that is not there, which is not an error.
     */
    delete_named(ctx, global, "recordFile");
    delete_named(ctx, global, "classOfName");
    delete_named(ctx, global, "strictSeal");
    delete_named(ctx, global, "formsHooks");

    JS_FreeValue(ctx, global);
}

/*
 * The JavaScript a Bintana project gets.
 *
 * JS_NewContext() installs the whole standard library; this installs what the
 * language actually uses, which is not the same thing.  Measured on the largest
 * Bintana program there is -- the IDE, its dialogs, its designer and the test
 * projects -- Proxy, Reflect, the typed arrays, Promise, WeakRef, atob/btoa and
 * performance are used exactly zero times.  A smaller language is easier to
 * learn and easier to keep promises about; what is not there cannot drift.
 *
 * Promise is the deliberate one: this is a RAD language with events, not
 * continuations, and leaving it out makes that a fact rather than advice.
 * **Its intrinsic is installed all the same, and the name deleted after boot**
 * (bta_close_hatches): a module is evaluated through a promise, and the
 * intrinsic is the only thing that registers the engine's async classes --
 * without which an object of one of them is never collected and
 * JS_FreeRuntime aborts at exit, the mechanism behind patch 5 and audit D1.
 * The language still has no promise: `async`, `await` and `import()` are
 * refused by the parser (patches 5 and 13), so nothing a program writes can
 * make or receive one.
 *
 * Eval is *not* optional, and not for the reason it looks.  JS_AddIntrinsicEval
 * does not install the global `eval` -- base objects does that -- it sets the
 * compiler that JS_Eval() itself runs on, so without it the runtime could not
 * load a single project file.  The global one is deleted after boot instead;
 * see bta_close_hatches().
 */
JSContext *bta_new_context(JSRuntime *rt)
{
    JSContext *ctx = JS_NewContextRaw(rt);
    if (!ctx)
        return NULL;

    JS_SetReferenceHintHandler(rt, bta_reference_hint, NULL);

    if (JS_AddIntrinsicBaseObjects(ctx) ||
        JS_AddIntrinsicEval(ctx) ||        /* the compiler, not the global */
        JS_AddIntrinsicDate(ctx) ||
        JS_AddIntrinsicRegExp(ctx) ||      /* renaming a control is a regexp */
        JS_AddIntrinsicJSON(ctx) ||        /* a .form is JSON */
        JS_AddIntrinsicMapSet(ctx) ||
        JS_AddIntrinsicPromise(ctx)) {     /* modules; the name goes, see above */
        JS_FreeContext(ctx);
        return NULL;
    }
    return ctx;
}

/*
 * ProtectPrototype(): close `Object.prototype` to new names.
 *
 * `for...in` recites the prototype chain, so a plugin that polyfills
 * `Object.prototype.currency` changes every enumeration in the host -- the
 * total of an invoice among them. The language has no `Object.preventExtensions`
 * (it went with the rest of `Object`), so the defence is a runtime verb: after
 * this, an assignment or a `defineProperty` that would add a name to
 * `Object.prototype` is refused, and the program's own `for...in` loops are
 * stable again.
 *
 * **Existing members can still be replaced**: this is `preventExtensions`, not
 * `freeze`. A host that wants the stronger promise can say so later; a plugin
 * that patches `toString` is a different problem from one that adds a key.
 * Calling it twice is harmless, and it answers `true` both times.
 */
JSValue bta_application_protect_prototype(JSContext *ctx, JSValueConst this_val,
                                         int argc, JSValueConst *argv)
{
    (void)this_val;
    (void)argc;
    (void)argv;

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue object = JS_GetPropertyStr(ctx, global, "Object");
    JS_FreeValue(ctx, global);

    if (JS_IsException(object))
        return object;

    JSValue proto = JS_GetPropertyStr(ctx, object, "prototype");
    JS_FreeValue(ctx, object);

    if (JS_IsException(proto))
        return proto;

    int ok = JS_PreventExtensions(ctx, proto);
    JS_FreeValue(ctx, proto);

    if (!ok)
        return JS_ThrowPlainError(ctx,
            "ProtectPrototype: Object.prototype is not an object");
    return JS_TRUE;
}

/* ------------------------------------------------ names, as the language binds them */

/* Every dot-separated segment an identifier, and at least one segment. */
static bool is_class_path(const char *s)
{
    if (!s || !*s)
        return false;

    char **parts = g_strsplit(s, ".", -1);
    bool   ok    = true;

    for (int i = 0; parts[i]; i++)
        if (!bta_is_identifier(parts[i]))
            ok = false;

    g_strfreev(parts);
    return ok;
}

/*
 * A class by name, which is how a .form names a type and how project.btp names
 * the startup form.
 *
 * Two ways a class can be reachable, and both have to work:
 *
 *   Form1            `class Form1 {}` at the top level of a script binds into
 *                    the global lexical scope and *not* onto globalThis, so a
 *                    plain property read misses it.  Evaluating the bare
 *                    identifier is what makes Gambas-style "every class is
 *                    visible everywhere, no imports" work.
 *
 *   Widgets.Stepper  a namespace is an ordinary object on globalThis, so a
 *                    qualified name is a walk down properties -- no eval, which
 *                    is the point: nothing here needs the compiler.
 */
JSValue bta_lookup_global(JSContext *ctx, const char *name)
{
    if (!is_class_path(name))
        return JS_ThrowTypeError(ctx, "'%s' is not a valid class name", name);

    /*
     * **A bare name is evaluated, and that is JavaScript's own order**: the
     * global lexical scope -- where a project's `class Timer {}` lives -- before
     * the global object, where the runtime's `Timer` is a property. Reading the
     * object first made every installed global beat the project's own class:
     * `startup class 'File' not found` for a C global, and a `TypeError: not a
     * function` from inside `Form` for a prelude one (`Timer`, `Record`), with
     * the class there, loaded and evaluated. An identifier that names nothing
     * at all is a ReferenceError, which is what the fallback below always threw.
     */
    if (!strchr(name, '.'))
        return JS_Eval(ctx, name, strlen(name), "<class-lookup>", JS_EVAL_TYPE_GLOBAL);

    char  **parts = g_strsplit(name, ".", -1);
    JSValue v     = JS_GetGlobalObject(ctx);

    for (int i = 0; parts[i]; i++) {
        JSValue next = JS_GetPropertyStr(ctx, v, parts[i]);
        JS_FreeValue(ctx, v);

        if (JS_IsException(next)) {
            g_strfreev(parts);
            return next;
        }
        /* A qualified name that goes nowhere is an error and not a miss: there
         * is no lexical scope to fall back to for `A.B`, and pretending the
         * class is merely "built in code" would hide the typo. */
        if (JS_IsUndefined(next) || JS_IsNull(next)) {
            JS_FreeValue(ctx, next);
            v = JS_UNDEFINED;
            break;
        }
        v = next;
    }

    g_strfreev(parts);
    return v;
}

/*
 * The value a bare name resolves to, for `rad.js` and for nothing else.
 *
 * A `.record` file names the classes its fields hold, and a name has to resolve
 * the way the rest of the runtime resolves one -- a project's `class Line`, or
 * a library's -- which is `bta_lookup_global` above.  JavaScript cannot
 * evaluate a name itself (`eval` is not part of this language), so the rule is
 * handed over as this hook; `Record`'s loader captures it and the hatch below
 * takes the name away.
 */
static JSValue js_class_of_name(JSContext *ctx, JSValueConst this_val, int argc,
                                JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "the name lookup needs a name");

    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;

    JSValue out = bta_lookup_global(ctx, name);
    JS_FreeCString(ctx, name);
    return out;
}

/* Installed by the main thread and by every worker; deleted with the hatches. */
void bta_class_of_name_init(JSContext *ctx, JSValueConst global)
{
    JS_SetPropertyStr(ctx, global, "classOfName",
                      JS_NewCFunction(ctx, js_class_of_name, "classOfName", 1));
}

#ifndef BTA_META_ONLY
/* The global object, as a real property enumeration.
 *
 * **The point of it is that nothing else can answer.** The globals are installed
 * one `JS_SetPropertyStr` at a time across this file and four others, and the
 * very same shape builds half the runtime's *return values* -- `Exec`'s handle,
 * `File.Info`'s answer, a table row -- so a list kept beside the installs would
 * be a second list to drift, and the one that drifts is the one no program runs.
 * `tests/api/Check.js` reads those same call sites out of the C to hold the
 * documentation to the same surface; this is the same answer, asked at run time,
 * for a program that wants to know rather than a check that wants to prove.
 *
 * It is deliberately **not** a curated list of the runtime's own names: the answer
 * is what is on the global object, which is also `Math`, `JSON`, `Date`, `Map`,
 * `Timer`, `Confirm` and whatever a library installed. A completion engine wants
 * all of them, and a caller that wanted only the runtime's own can ask
 * `Application.Libraries()` beside it.
 */
JSValue bta_application_globals(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    JSValue     global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab = NULL;
    uint32_t    len = 0;
    JSValue     out  = JS_NewArray(ctx);
    uint32_t    n    = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, global, JS_GPN_STRING_MASK) == 0) {
        for (uint32_t i = 0; i < len; i++) {
            const char *name = JS_AtomToCString(ctx, tab[i].atom);
            /* `globalThis` went with the hatches, and so did every name they
             * took: what is left here is what a program may actually write. */
            if (name && *name && !bta_module_exported(ctx, name))
                JS_SetPropertyUint32(ctx, out, n++, JS_NewString(ctx, name));
            if (name) JS_FreeCString(ctx, name);
        }
        JS_FreePropertyEnum(ctx, tab, len);
    }
    JS_FreeValue(ctx, global);
    return out;
}
#endif /* !BTA_META_ONLY */
