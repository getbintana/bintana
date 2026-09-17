/*
 * bta_plugin.h -- what a native plugin sees, and the whole of what it needs.
 *
 * A plugin is a shared object that lives **inside a library directory**:
 * `uses: ["taglib"]` resolves to a directory, and if that directory holds
 * `taglib.so` (the extension is `G_MODULE_SUFFIX`), the runtime loads it before
 * it loads the library's `.js`.  The plugin can then install globals with the
 * host's table, and the library's JavaScript wraps them the way a project wraps
 * anything else.  The convention is `<name>/<name>.<suffix>` and this header
 * never mentions the runtime, GTK or QuickJS.
 *
 * **The contract is a table of callbacks, and that is the design rather than a
 * detail of it.**  A plugin links nothing -- not the runtime, not QuickJS -- and
 * the host exports nothing: it passes a `BtaHost` whose function pointers are
 * the entire surface, and the plugin reaches JavaScript only through them.  So
 * the ABI is as big as this file, the host does not need `-rdynamic`, symbol
 * collisions between the host and a plugin cannot happen, and the same plugin
 * builds and loads on Linux, macOS and Windows with no linker flags.  The price
 * is that a capability not listed here does not exist, and adding one is a
 * deliberate line in this header.
 *
 * ## What a plugin can install
 *
 * A global object (`TagLib.Read(path)`), or anything built out of `object`,
 * `array` and `function`.  **Not a native widget class**: the class table and
 * the `BtaWidget` layout are the runtime's implementation, and freezing them
 * into this contract would make every internal change a breaking one.  A widget
 * written for a library is a `Component` its `.js` declares, which is ordinary
 * Bintana code and already works.
 *
 * ## The ABI number
 *
 * `BTA_PLUGIN_ABI` identifies this contract as a whole.  It goes up when
 * `BtaPlugin` or any signature here changes, or when the semantics below do.
 * **Adding a function to the end of `BtaHost` does not bump it**: a plugin
 * compiled against an older header reads only the prefix of the table it was
 * handed, so it keeps working.  Reordering or removing a field does bump it,
 * because the same plugin would then be reading the wrong slot.
 *
 * ## Values and ownership
 *
 * A `BtaValue` is an opaque JavaScript value.  The plugin never inspects it,
 * allocates one of its own, or keeps one: it gets values from the host and
 * hands them back, and that is the whole of their life.  The rules:
 *
 *   - every value a host function *returns* is owned by the caller;
 *   - every value passed *into* `set`, `push` or a callback's return is handed
 *     over to the host, which owns it from then on -- do not release it;
 *   - `release` drops one you decided not to use, and is safe on any value,
 *     including `undefined` and `null`.
 *
 * A callback's `argv` is **borrowed**: those values are valid until the callback
 * returns and must not be released or stored.  A string from `text()` is
 * borrowed in the same way and for the same length of time -- the host frees
 * its conversions when the callback returns.
 *
 * ## Reporting an error
 *
 * There is no return code: call `fail(message)` and return `undefined()`.  The
 * host asks the engine whether an exception is pending after every callback and
 * raises it into JavaScript; `kind()` answers `BTA_KIND_ERROR` for any value
 * while one is pending.  `init` returning non-zero is the same statement made
 * once at startup, and stops the program -- a library whose native half could
 * not install itself is not a state to carry on in.
 */
#ifndef BTA_PLUGIN_H
#define BTA_PLUGIN_H

#include <stdint.h>

/* The version of this whole contract.  See the note above. */
#define BTA_PLUGIN_ABI 1

typedef struct BtaHost BtaHost;

/*
 * A JavaScript value, opaque.
 *
 * Two words, because that is the widest a value is in any engine configuration:
 * the host copies its own representation in and out and zeroes what is left
 * over, so this type does not change when the engine's boxing does -- which is
 * one fewer reason for `BTA_PLUGIN_ABI` to move.  Nothing here depends on what
 * the bits mean, and a plugin that looks inside one is relying on something
 * this contract does not promise.
 */
typedef struct BtaValue {
    uint64_t opaque[2];
} BtaValue;

/* What `kind()` answers about a value. */
typedef enum {
    /* An exception is pending (`fail` was called), or the value is the one a
     * failing host function returned. */
    BTA_KIND_ERROR = 0,
    BTA_KIND_UNDEFINED,
    BTA_KIND_NULL,
    BTA_KIND_BOOL,
    BTA_KIND_NUMBER,
    BTA_KIND_STRING,
    /* An object, an array or a function: the engine has one object kind, and a
     * plugin that cares which calls `get(value, "length")` or checks a
     * property. */
    BTA_KIND_OBJECT,
} BtaKind;

/*
 * A C function as a JavaScript one.  `argc` is **at least the declared
 * arity**: a missing argument arrives as `undefined` and never as a short call,
 * so a function declared with two arguments can read both however it was
 * called.  Extra arguments JavaScript passed are at the end, and `argc` says
 * how many there were.
 */
typedef BtaValue (*BtaPluginFn)(const BtaHost *host, void *user, int argc,
                                const BtaValue *argv);

/*
 * The host, as the plugin sees it.  **Read-only**: the runtime owns this table,
 * and writing through the pointer would corrupt it for every other plugin.
 */
struct BtaHost {
    int abi;

    /* Values.  Each returns a value the caller owns. */
    BtaValue (*undefined)(const BtaHost *host);
    BtaValue (*null)(const BtaHost *host);
    BtaValue (*boolean)(const BtaHost *host, int value);
    BtaValue (*number)(const BtaHost *host, double value);
    /* UTF-8, copied. */
    BtaValue (*string)(const BtaHost *host, const char *utf8);
    BtaValue (*object)(const BtaHost *host);
    BtaValue (*array)(const BtaHost *host);

    /*
     * Objects and arrays.  `set` and `push` take the value over; `get` returns
     * one the caller owns -- `undefined` for a key that is not there, which is
     * what JavaScript does.
     */
    void     (*set)(const BtaHost *host, BtaValue obj, const char *key,
                    BtaValue value);
    BtaValue (*get)(const BtaHost *host, BtaValue obj, const char *key);
    void     (*push)(const BtaHost *host, BtaValue array, BtaValue value);

    /*
     * A C function as a JS one.  `length` is the declared arity (see
     * BtaPluginFn).  `user` is handed to every call and never looked at by the
     * host; the function object keeps its own reference to it, and nothing here
     * frees it for you.
     */
    BtaValue (*function)(const BtaHost *host, const char *name, int length,
                         BtaPluginFn fn, void *user);

    /* What a value is. */
    BtaKind (*kind)(const BtaHost *host, BtaValue v);

    /*
     * What a value says, converted the way JavaScript converts (`String(v)`,
     * `Number(v)`), so a number read as text is its digits and a string read as
     * a number is parsed.  `text` is **borrowed until the callback returns**;
     * a value that does not convert answers `NULL` or `NaN`.
     */
    const char *(*text)(const BtaHost *host, BtaValue v);
    double      (*value)(const BtaHost *host, BtaValue v);

    /* Drop a value.  Safe on any value, including `undefined`/`null`. */
    void (*release)(const BtaHost *host, BtaValue v);

    /* Raise a JavaScript error carrying `message`, then return undefined(). */
    void (*fail)(const BtaHost *host, const char *message);

    /*
     * A line for a person, at Debug level: it goes through the runtime's
     * logger, so `Logger.Level` and `Logger.Handler` decide whether the
     * application sees it.  Debug is the level that says "the plugin is
     * telling you what it is doing" rather than anything the application
     * asked for.
     */
    void (*log)(const BtaHost *host, const char *text);

    /*
     * Call a JavaScript function the plugin was handed -- an option callback,
     * a per-item handler.  `fn` must be a function (anything else raises a
     * TypeError), `this_val` is what the call sees as `this` (`undefined` is
     * the usual answer), `argv` is **borrowed** for the length of the call, and
     * the answer is owned by the caller.
     *
     * **An exception thrown by the called function is not the plugin's to
     * handle unless it wants to.**  It stays pending on the context, so the
     * shape that propagates it is: do nothing with the answer beyond asking
     * `kind()`, and return `undefined()` from the callback -- the host raises
     * the pending exception at the plugin's own caller.  What must not happen
     * is carrying on as if nothing did: while one is pending every value
     * answers `BTA_KIND_ERROR`, and the call to use is
     *
     *     BtaValue r = host->call(host, fn, host->undefined(host), 1, &v);
     *     if (host->kind(host, r) == BTA_KIND_ERROR)
     *         return host->undefined(host);
     *
     * Appended to this table after version 1 was published, and it is why the
     * rule above exists: a plugin compiled against the older header never
     * reads this field, so it keeps working and `BTA_PLUGIN_ABI` did not move.
     */
    BtaValue (*call)(const BtaHost *host, BtaValue fn, BtaValue this_val,
                     int argc, const BtaValue *argv);
};

/*
 * What the plugin declares.  The runtime looks for one symbol, named
 * `bta_plugin`, of this type:
 *
 *   BTA_PLUGIN_EXPORT BtaPlugin BTA_PLUGIN_ENTRY = {
 *       BTA_PLUGIN_ABI, my_init, NULL,
 *   };
 */
typedef struct BtaPlugin {
    /* Must equal BTA_PLUGIN_ABI; the runtime refuses a plugin that says
     * otherwise, naming both numbers. */
    int abi;

    /*
     * Called once, before `rad.js` and before any source of the project, with
     * the global object -- **borrowed**, so set properties on it and do not
     * release it.  Install what the library publishes here.  Return 0 on
     * success; on failure call `host->fail(...)` and return non-zero, and the
     * program stops with that message.
     *
     * The runtime's own globals are installed by this point (`Application`,
     * `Logger`, ...), so `host->get(global, "Application")` answers -- but the
     * JavaScript half of the runtime, `rad.js`, has not run yet: `Dictionary`,
     * `Record` and the prototype conveniences do not exist.  Put anything that
     * needs them in the library's `.js`, which loads after this returns.
     */
    int (*init)(const BtaHost *host, BtaValue global);

    /*
     * Called once at teardown, after the JavaScript context is gone.  For C
     * resources of the plugin's own -- a cache, a handle.  **It must not call
     * the host**: there is no context left to build a value in.  Optional.
     */
    void (*cleanup)(void);
} BtaPlugin;

/*
 * Capabilities appended to `BtaHost` since version 1 was published.  The field
 * is at the end of the table and needs no ABI bump -- a plugin built against the
 * old header never reads it -- and the macro is what lets *source* that must
 * build against either header ask whether it is there:
 *
 *     #ifdef BTA_PLUGIN_HAS_CALL
 *         ... use host->call ...
 *     #endif
 *
 * A plugin built against this runtime has it unconditionally; only a source
 * that is deliberately compiled against an older header (the suite's golden
 * `testplug-abi1` is the one in this tree) needs the guard.
 */
#define BTA_PLUGIN_HAS_CALL 1

/* The symbol's name, spelled once so a plugin and the loader cannot disagree. */
#define BTA_PLUGIN_ENTRY bta_plugin
#define BTA_PLUGIN_ENTRY_SYMBOL "bta_plugin"

/* A shared object's symbols are not exported on Windows unless they say so;
 * elsewhere the attribute is what keeps an explicit `-fvisibility=hidden` build
 * from hiding the one symbol the runtime needs. */
#if defined(_WIN32)
#define BTA_PLUGIN_EXPORT __declspec(dllexport)
#elif defined(__GNUC__) || defined(__clang__)
#define BTA_PLUGIN_EXPORT __attribute__((visibility("default")))
#else
#define BTA_PLUGIN_EXPORT
#endif

#endif /* BTA_PLUGIN_H */
