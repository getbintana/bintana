/*
 * The plugin the test suite loads, and the reference implementation of the
 * contract in runtime/include/bta_plugin.h.
 *
 * It is deliberately written the way a real plugin is: it links nothing -- no
 * runtime, no QuickJS, no GTK -- and every JavaScript value it touches arrives
 * through the host table.  The build target beside it in CMakeLists carries no
 * link libraries at all, so a capability accidentally reached through a symbol
 * is a link error rather than something that happens to work.
 *
 * It exercises one verb per function, because the suite's job is to hold the
 * table to what the header says: `Describe` asks `kind`, `Add` reads a number
 * with `value`, `Echo` reads text, `Pair` builds an array with `push`, `Fields`
 * builds an object with `set`, `Length` reads a property with `get`, `Boom`
 * reports through `fail`, `Drop` drops a value with `release`, and `Apply`
 * invokes a JavaScript function with `call`.  `Arity` is
 * declared with two arguments and called with none, which is how the suite
 * pins the claim that the engine pads to the declared arity.
 *
 * `DOCS` in docs/plugins.md points at this file instead of quoting it, so the
 * reference cannot drift from the thing that is tested.
 */
#include "bta_plugin.h"

#include <stdio.h>
#include <string.h>

#ifndef TESTPLUG_ABI
#define TESTPLUG_ABI BTA_PLUGIN_ABI
#endif

static BtaValue echo_fn(const BtaHost *h, void *user, int argc,
                        const BtaValue *argv)
{
    if (argc < 1 || h->kind(h, argv[0]) != BTA_KIND_STRING) {
        h->fail(h, "TestPlug.Echo(text) expects a string");
        return h->undefined(h);
    }
    return h->string(h, h->text(h, argv[0]));
}

static BtaValue add_fn(const BtaHost *h, void *user, int argc,
                       const BtaValue *argv)
{
    if (argc < 2 || h->kind(h, argv[0]) != BTA_KIND_NUMBER ||
        h->kind(h, argv[1]) != BTA_KIND_NUMBER) {
        h->fail(h, "TestPlug.Add(a, b) expects two numbers");
        return h->undefined(h);
    }
    return h->number(h, h->value(h, argv[0]) + h->value(h, argv[1]));
}

/*
 * What `kind` answers, as a word.  The suite asks this about both a value it
 * passed in and one the plugin made, so the two directions are one assertion
 * apart.
 */
static const char *kind_name(BtaKind kind)
{
    static const char *names[] = {
        "error", "undefined", "null", "bool", "number", "string", "object",
    };

    return kind >= 0 && (size_t)kind < sizeof(names) / sizeof(names[0])
               ? names[kind] : "?";
}

static BtaValue describe_fn(const BtaHost *h, void *user, int argc,
                            const BtaValue *argv)
{
    if (argc < 1) {
        h->fail(h, "TestPlug.Describe(value) expects a value");
        return h->undefined(h);
    }
    return h->string(h, kind_name(h->kind(h, argv[0])));
}

static BtaValue pair_fn(const BtaHost *h, void *user, int argc,
                        const BtaValue *argv)
{
    BtaValue out = h->array(h);

    h->push(h, out, h->number(h, argc > 0 ? h->value(h, argv[0]) : 0));
    h->push(h, out, h->number(h, argc > 1 ? h->value(h, argv[1]) : 0));
    return out;
}

static BtaValue fields_fn(const BtaHost *h, void *user, int argc,
                          const BtaValue *argv)
{
    BtaValue out = h->object(h);

    h->set(h, out, "Name", h->string(h, "testplug"));
    h->set(h, out, "Abi", h->number(h, BTA_PLUGIN_ABI));
    h->set(h, out, "Native", h->boolean(h, 1));
    h->set(h, out, "Nil", h->null(h));
    h->set(h, out, "Nested", h->object(h));
    return out;
}

static BtaValue length_fn(const BtaHost *h, void *user, int argc,
                          const BtaValue *argv)
{
    BtaValue len;

    if (argc < 1 || h->kind(h, argv[0]) != BTA_KIND_OBJECT) {
        h->fail(h, "TestPlug.Length(array) expects an array");
        return h->undefined(h);
    }
    len = h->get(h, argv[0], "length");
    return h->number(h, h->value(h, len));
}

static BtaValue boom_fn(const BtaHost *h, void *user, int argc,
                        const BtaValue *argv)
{
    h->fail(h, argc > 0 ? h->text(h, argv[0]) : "TestPlug.Boom");
    return h->undefined(h);
}

/* Declared with two arguments; called with none, which is the padding claim. */
static BtaValue arity_fn(const BtaHost *h, void *user, int argc,
                         const BtaValue *argv)
{
    BtaValue out = h->array(h);

    h->push(h, out, h->number(h, argc));
    h->push(h, out, h->string(h, kind_name(h->kind(h, argv[1]))));
    return out;
}

static BtaValue values_fn(const BtaHost *h, void *user, int argc,
                          const BtaValue *argv)
{
    BtaValue out = h->array(h);

    h->push(h, out, h->undefined(h));
    h->push(h, out, h->null(h));
    h->push(h, out, h->boolean(h, 0));
    h->push(h, out, h->number(h, 2.5));
    h->push(h, out, h->string(h, "hecho"));
    h->push(h, out, h->object(h));
    h->push(h, out, h->array(h));
    return out;
}

static BtaValue drop_fn(const BtaHost *h, void *user, int argc,
                        const BtaValue *argv)
{
    BtaValue v = h->string(h, "nobody keeps this");

    h->release(h, v);
    return h->boolean(h, 1);
}

static BtaValue log_fn(const BtaHost *h, void *user, int argc,
                       const BtaValue *argv)
{
    h->log(h, argc > 0 ? h->text(h, argv[0]) : "testplug: no line");
    return h->undefined(h);
}

/*
 * The other direction: a function the caller handed in, invoked from C.  The
 * answer is passed straight through, which is what makes a throw inside it come
 * back to JavaScript -- the host raises the pending exception at this plugin
 * function's caller.
 *
 * Guarded, because this one source is also compiled against the frozen
 * version-1 header for `testplug-abi1` -- and `call` is a later field, which is
 * exactly what that header not having it means.  A plugin built against the
 * runtime itself needs no guard; see BTA_PLUGIN_HAS_CALL.
 */
#ifdef BTA_PLUGIN_HAS_CALL
static BtaValue apply_fn(const BtaHost *h, void *user, int argc,
                         const BtaValue *argv)
{
    if (argc < 2 || h->kind(h, argv[0]) != BTA_KIND_OBJECT) {
        h->fail(h, "TestPlug.Apply(fn, value) expects a function");
        return h->undefined(h);
    }
    return h->call(h, argv[0], h->undefined(h), 1, &argv[1]);
}
#endif

static int testplug_init(const BtaHost *h, BtaValue global)
{
    BtaValue api = h->object(h);

    h->set(h, api, "Echo", h->function(h, "Echo", 1, echo_fn, NULL));
    h->set(h, api, "Add", h->function(h, "Add", 2, add_fn, NULL));
    h->set(h, api, "Describe", h->function(h, "Describe", 1, describe_fn, NULL));
    h->set(h, api, "Pair", h->function(h, "Pair", 2, pair_fn, NULL));
    h->set(h, api, "Fields", h->function(h, "Fields", 0, fields_fn, NULL));
    h->set(h, api, "Length", h->function(h, "Length", 1, length_fn, NULL));
    h->set(h, api, "Boom", h->function(h, "Boom", 1, boom_fn, NULL));
    h->set(h, api, "Arity", h->function(h, "Arity", 2, arity_fn, NULL));
    h->set(h, api, "Values", h->function(h, "Values", 0, values_fn, NULL));
    h->set(h, api, "Drop", h->function(h, "Drop", 1, drop_fn, NULL));
    h->set(h, api, "Log", h->function(h, "Log", 1, log_fn, NULL));
#ifdef BTA_PLUGIN_HAS_CALL
    h->set(h, api, "Apply", h->function(h, "Apply", 2, apply_fn, NULL));
#endif

    /* Handed over, not released: `set` owns it from here. */
    h->set(h, global, "TestPlug", api);
    return 0;
}

/*
 * Printed, so the suite can see that a plugin that was loaded is a plugin that
 * was let go.  The context is already gone when this runs, which is why the
 * line is C and not JavaScript (the header says so where `cleanup` is
 * declared).
 */
static void testplug_cleanup(void)
{
    fprintf(stderr, "testplug: cleanup\n");
}

BTA_PLUGIN_EXPORT BtaPlugin BTA_PLUGIN_ENTRY = {
    TESTPLUG_ABI,
    testplug_init,
    testplug_cleanup,
};
