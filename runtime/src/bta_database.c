/*
 * Database and Connection -- the part that is not any one engine.
 *
 * There is very little here, and that is the honest amount. What every database
 * driver shares is an **interface** and not code: `Query`, `Execute`,
 * `Transaction`, `Columns`, `Tables` and a `Dialect`, each of which only a
 * driver can implement. So this file owns exactly the two things that would
 * otherwise have to be duplicated by the second driver:
 *
 *   Connection   a base class with an empty prototype.  `rad.js` hangs `Table`
 *                on it, so every driver's connections answer `conn.Table(...)`
 *                without knowing that Table exists.
 *   Database     the object each driver adds itself to, so the extension point
 *                is visible in the API rather than documented beside it.
 *
 * **`Connection` is deliberately not a way in.** There is no `Connection.Open`,
 * because opening is the one operation that belongs to a driver and not to a
 * connection: `Database.Sqlite(path)` opens one, and a `Database.Postgres`
 * would take a host and a database name rather than a path. Naming the generic
 * class and the specific opener the same thing is what made the first version
 * of this promise portability it did not have -- see the head of
 * [bta_sqlite.c](bta_sqlite.c) for the table of what actually differs between
 * engines.
 *
 * ## What a driver does with this
 *
 * Three calls, and `bta_sqlite.c` is the worked example:
 *
 *   1. `bta_connection_proto()` for the base prototype, and build its own on
 *      top of it with `JS_NewObjectProto` -- which is what puts `Table` in the
 *      chain and makes `conn instanceof Connection` mean something.
 *   2. its own `JSClassID`, so the opaque pointer on a connection is *its*
 *      struct and a handle from another driver cannot be mistaken for one.
 *   3. `bta_database_driver()` to add its opener.
 *
 * Nothing here knows how many drivers there are, and none of them knows about
 * another.
 */

#include "bta.h"

static JSClassID bta_connection_class_id;

/* No finalizer: the base holds nothing.  A driver's own class has its own, which
 * is where a handle is closed. */
static JSClassDef connection_class = {
    "Connection",
    .finalizer = NULL,
};

static JSValue connection_construct(JSContext *ctx, JSValueConst new_target,
                                    int argc, JSValueConst *argv)
{
    return JS_ThrowTypeError(ctx, "a Connection is not constructed: a driver "
                                  "opens one -- Database.Sqlite(path)");
}

/*
 * The base prototype.  A fresh reference each time, which the caller owns:
 * a driver takes one at startup, builds its own prototype on top of it and
 * frees it.
 */
JSValue bta_connection_proto(JSContext *ctx)
{
    return JS_GetClassProto(ctx, bta_connection_class_id);
}

/* One driver's opener, onto `Database`.  Looked up from the global object rather
 * than kept in a static, so this file holds no state at all and the order of
 * two drivers' registrations cannot matter. */
void bta_database_driver(JSContext *ctx, const char *name,
                         JSCFunction *open, int nargs)
{
    JSValue global   = JS_GetGlobalObject(ctx);
    JSValue database = JS_GetPropertyStr(ctx, global, "Database");

    JS_SetPropertyStr(ctx, database, name,
                      JS_NewCFunction(ctx, open, name, nargs));
    JS_FreeValue(ctx, database);
    JS_FreeValue(ctx, global);
}

void bta_database_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_connection_class_id);
    JS_NewClass(rt, bta_connection_class_id, &connection_class);

    /* Empty on purpose. What fills it is `rad.js`, with `Table` -- the portable
     * half of the mapping, which is JS because a record's values are in a
     * private bag scoped to `Record` and nothing outside that file can read
     * them. */
    JSValue proto = JS_NewObject(ctx);
    JS_SetClassProto(ctx, bta_connection_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, connection_construct, "Connection", 0,
                                    JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Connection", ctor);

    /* `Database` is the theme; each driver is a member. Created empty here even
     * in a build with no driver at all, so `typeof Database` never answers
     * `"undefined"` -- which would send whoever hit it looking for a spelling
     * mistake instead of for a missing package. */
    JS_SetPropertyStr(ctx, global, "Database", JS_NewObject(ctx));
}
