/*
 * Task -- a class that runs in a thread of its own.
 *
 *     class Sizer extends Task {
 *         Run(msg) { ...; return { size, files }; }
 *     }
 *     const t = new Sizer();
 *     t.Progress = (p) => count(p);
 *     t.Done     = (r) => show(r);
 *     t.Start({ root: dir });
 *
 * One shot: a Task runs once, answers exactly once (`Done` xor `Error`), and
 * is done.  Work that repeats is a new Task, the way a child that runs again
 * is a new `Exec`.  The surface is docs/reference/globals/Task.md and the
 * argument is docs/plans/task-plan.md; what is here is how.
 *
 * ## Why threads, and why shaped like this
 *
 * The language has no `Promise` and no `async`, deliberately, and `Exec.Wait`
 * freezes the window -- so a long computation had two shapes: chopped into
 * `Timer` slices in-process, or a child process through `Exec`.  A Task is the
 * third: real parallelism without serialising through a pipe, for the program
 * that totals a hundred thousand rows while the window stays alive.  Gambas
 * names it `Task` too, Qt watches a `QFuture`, .NET cancels cooperatively; this
 * one speaks Bintana -- a class extended, instantiated to start, callbacks by
 * property like `Timer.Tick`.
 *
 * ## A worker is this language, not a subset of it
 *
 * QuickJS runtimes are not thread-safe, so each task gets a runtime and a
 * context of its own.  What it does *not* get is a second implementation of
 * anything: `task_build_worker` below runs the same `init` functions
 * `install_globals` runs and evaluates the same `rad.js`, so the worker holds
 * the real `Decimal` out of bta_decimal.c, the real `Bytes`, the real
 * `Dictionary`, `Regex`, `Record` and `Table`.
 *
 * That is possible because a class id crosses runtimes, which a first attempt
 * at this file assumed it could not.  `JS_NewClassID` allocates out of
 * `rt->js_class_id_alloc` (per runtime), and `JS_NewClass1` accepts any id
 * under 65536 and grows `rt->class_array` to fit -- so an id the main runtime
 * assigned registers verbatim here.  The module-level `static JSClassID`
 * variables are process-global C storage, but `install_globals` finishes
 * before any thread exists, which makes every one of them written once at boot
 * and read-only forever after.
 *
 * ## What it does not get, and the rule that decides
 *
 * **Whether it would leave a callback hanging off an event loop.**  Not
 * whether it writes: `File.Save` is `g_file_set_contents` and is no less safe
 * from a thread than the `Exec` that already writes beside the window.  What
 * cannot cross is a `GFileMonitor` or a `GSource`, because it would fire on
 * the main thread holding this context -- and GTK, because GTK off the main
 * thread is a crash and not an error (`bta_ctor` refuses it where widgets are
 * built).  A worker computes and reports; what is drawn stays where the
 * answer arrives.
 *
 * Measured against the tree, every piece of mutable process-global state in
 * the modules a worker runs is five variables, all in bta_sys.c --
 * `watch_jobs`, `exec_jobs`, `timers`, `paste_jobs`, `dialog_jobs` -- and the
 * rule already takes all five.  That is not luck: what keeps a global list is
 * what has work in flight, and what has work in flight is what has callbacks.
 *
 * ## A worker writes, and what that costs is not what it looks like
 *
 * The eleven verbs that change the disk were refused here once, on the
 * grounds that two writers need a lock to order them.  That named a real gap
 * and pointed it at the wrong danger: `g_file_set_contents` writes a
 * temporary and renames over the target, so two threads saving one path
 * produce one of the two whole files and never a torn one, and `unlink` and
 * `rename` are a syscall each.
 *
 * The cost of concurrency here is the **lost update** -- read, change, write
 * from two threads, and the first thread's change never happened -- and no
 * automatic lock reaches it, because the gap is *between* two calls and only
 * the program knows which two.  `Lock.Hold(name, fn)` is the tool for that,
 * and it is something to reach for rather than a condition of writing at all,
 * which is why the verbs came back before it arrived.
 *
 * ## Stopping is asked, and only then forced
 *
 * `Stop()` raises a flag the worker can read as `this.Stopping`, and the
 * engine's interrupt handler deliberately ignores it: a `Run` that watches
 * gets to `Report` what it has and return, so the nine subtrees it already
 * measured arrive instead of being thrown away.  `KillAfter` milliseconds
 * later, a `Run` that was not watching is ended where it stands.  Two stages
 * and the same two names as `Exec`'s guard, because it is the same bargain --
 * ask, then insist.  Delphi spells the flag `Terminated`, BackgroundWorker
 * `CancellationPending`, Qt `isCanceled()`; every runtime with threads has
 * one, because a thread cannot be shot the way a child can.
 *
 * ## What crosses
 *
 * Nothing is shared: the argument, the progress reports and the answer cross
 * as **text**, serialised on one side and parsed on the other, so no JS value
 * is ever touched from two threads.  That is also what makes teardown
 * joinable rather than hopeful.
 *
 * A message is a tree of plain data -- objects, arrays, strings, numbers,
 * booleans, null -- plus `Decimal`, which travels as `{$decimal: "19.90"}` and
 * is rebuilt through the same class on the far side.  Both directions run the
 * same two functions, because both sides have the same classes.  Anything else
 * (functions, class instances, cycles, `undefined`, non-finite numbers,
 * `Bytes`) is **refused out loud**, because `JSON.stringify` would drop or
 * null half of that list in silence, and a silent subset is how a total goes
 * wrong on exactly one machine.
 */
#include "bta.h"
#include "bta_prelude.h"

#include <string.h>

/* The tag a decimal travels under, both ways.  An object with a string
 * `$decimal` *is* a decimal -- own it explicitly and nothing collides with it
 * by accident. */
#define TASK_DEC_TAG "$decimal"

/* ------------------------------------------------------------------ mode */

/* Which runtimes are workers, and which jobs are live: process-global lists
 * under one mutex.  A flag on the context would not do -- the question is
 * asked about contexts (`bta_task_is_worker`) and the runtimes are what come
 * and go.  Entries are added before a worker evaluates anything and removed
 * before its runtime is freed; join orders all of it. */
static GMutex task_lock;
static GList *task_rts;
static GList *task_jobs;

/* Signalled by a worker on its way out, waited on by teardown.  `g_thread_join`
 * has no bounded form, and a join that cannot end is how a program stops
 * closing; see bta_task_cleanup. */
static GCond task_ended;

/* The thread bta_task_init ran on: every delivery below must run there.  The
 * worker registers its own class through task_install(), which is why the
 * thread is recorded in bta_task_init and not in the shared half -- a worker
 * calling it would overwrite the answer with its own thread. */
static GThread *task_main_thread;

static bool task_on_main(void)
{
    return g_thread_self() == task_main_thread;
}

bool bta_task_is_worker(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    bool       found;

    g_mutex_lock(&task_lock);
    found = g_list_find(task_rts, rt) != NULL;
    g_mutex_unlock(&task_lock);
    return found;
}

/* ------------------------------------------------------------------ jobs */

typedef struct BtaTaskJob BtaTaskJob;

struct BtaTaskJob {
    JSContext *ctx;             /* main context, borrowed */
    JSValue    self;            /* the proxy, Dup'd: it outlives being dropped */
    /*
     * 0 run, 1 asked to stop, 2 timed out, 3 forced -- atomic.
     *
     * **Two stages, like Exec's.**  1 is cooperative: the interrupt handler
     * leaves it alone, so `Run` sees `this.Stopping` and can report what it
     * has and return.  3 is what happens `KillAfter` milliseconds later if it
     * did not, and 2 is the guard doing the same for a different reason --
     * which is why they are separate numbers: the ending has to say which.
     */
    volatile gint stop;
    bool       dead;            /* teardown owns it; deliver touches no JS */
    bool       ended;           /* the thread is on its way out, under task_lock */
    GThread   *thread;
    guint      timeout_src;
    guint      force_src;       /* the second stage of a Stop */
    long       timeout_ms;
    char      *class_name;
    char      *file_text;
    char      *file_path;
    char      *msg_json;
    char      *app_name;
    char      *app_version;
    char      *app_dir;
    char      *app_config;
    char      *app_exe;         /* "" where the platform will not say */
    char     **app_args;        /* NULL-terminated copy */
    GQueue    *reports;         /* char* JSON, FIFO, under task_lock */
    bool       drain_queued;    /* one idle source per batch, not per report */
    char      *result_json;     /* written before the final invoke */
    int        fail;            /* 0 ok, 1 error, 2 cancelled, 3 timeout */
    char      *fail_msg;
    char      *fail_stack;
};

guint bta_task_pending(void)
{
    guint n;

    g_mutex_lock(&task_lock);
    n = g_list_length(task_jobs);
    g_mutex_unlock(&task_lock);
    return n;
}

/* The live job this proxy belongs to, or NULL.  Compared by object identity:
 * a wrapper is one object, and two proxies never share one.  The caller holds
 * task_lock. */
static BtaTaskJob *task_find_locked(JSValueConst self)
{
    if (!JS_IsObject(self))
        return NULL;
    for (GList *l = task_jobs; l; l = l->next) {
        BtaTaskJob *job = l->data;

        if (JS_VALUE_GET_PTR(job->self) == JS_VALUE_GET_PTR(self))
            return job;
    }
    return NULL;
}

static void task_job_free(BtaTaskJob *job)
{
    g_free(job->class_name);
    g_free(job->file_text);
    g_free(job->file_path);
    g_free(job->msg_json);
    g_free(job->app_name);
    g_free(job->app_version);
    g_free(job->app_dir);
    g_free(job->app_config);
    g_free(job->app_exe);
    g_strfreev(job->app_args);
    g_queue_free_full(job->reports, g_free);
    g_free(job->result_json);
    g_free(job->fail_msg);
    g_free(job->fail_stack);
    g_free(job);
}

/* ------------------------------------------------------------------ class */

/* One id for the process, registered into every runtime that needs it: see the
 * header note.  A worker's `class Sizer extends Task` resolves to this same
 * class, which is why the worker needs no wrapper of its own. */
static JSClassID task_class_id;

static JSClassDef task_class = {
    "Task",
    /* No finalizer: a proxy holds no native state of its own.  The job lives
     * in the live list and is freed at delivery or teardown. */
    .finalizer = NULL,
};

/* The per-worker environment, hung off the worker runtime as its opaque.
 * Nothing else in the runtime reads that slot -- the main thread writes its
 * BtaApp there and no module asks for it back -- so a worker is free to use
 * it, and `Report` finds its job without a lookup. */
typedef struct {
    BtaTaskJob *job;
} BtaTaskEnv;

static BtaTaskEnv *task_env(JSContext *ctx)
{
    if (!bta_task_is_worker(ctx))
        return NULL;
    return JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
}

static JSValue task_start(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv);
static JSValue task_stop(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv);
static JSValue task_report(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv);
static JSValue task_get_stopping(JSContext *ctx, JSValueConst this_val);
static gboolean task_deliver(gpointer data);

/* One table for every runtime: it is constant data, and what differs per
 * runtime is nothing at all.  It is also what tests/api.sh reads, so a member
 * here without a row in docs/llm/library.md fails the build. */
static const JSCFunctionListEntry task_props[] = {
    JS_CFUNC_DEF("Start",  2, task_start),
    JS_CFUNC_DEF("Stop",   1, task_stop),
    JS_CFUNC_DEF("Report", 1, task_report),
    JS_CGETSET_DEF("Stopping", task_get_stopping, NULL),
};

static JSValue task_construct(JSContext *ctx, JSValueConst new_target,
                              int argc, JSValueConst *argv)
{
    JSValue     name;
    const char *s;
    bool        direct;
    JSValue     proto, obj;

    /* Abstract, the way Widget's own abstract classes are: `new Task()` is a
     * base with no work in it, and the name on new_target is what tells it
     * apart from `new Sizer()` without keeping the constructor around. */
    name = JS_GetPropertyStr(ctx, new_target, "name");
    s = JS_ToCString(ctx, name);
    direct = s && g_str_equal(s, "Task");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, name);
    if (direct)
        return JS_ThrowTypeError(ctx, "Task is abstract: extend it with a class "
                                      "of your own");

    proto = JS_GetPropertyStr(ctx, new_target, "prototype");
    if (JS_IsException(proto))
        return proto;
    obj = JS_NewObjectProtoClass(ctx, proto, task_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;

    /* Inside a worker this is the real thing, built by the thread below to run
     * `Run` on: no handlers, no state, and `Start` refuses there. */
    if (bta_task_is_worker(ctx))
        return obj;

    /* Plain values, the way an Exec handle carries its state: what the proxy
     * is doing is read off it, and `__started` is what keeps a Task to one
     * run -- the `__` spelling widget wrappers already use for what is ours
     * and not the program's. */
    JS_SetPropertyStr(ctx, obj, "Running", JS_FALSE);
    /*
     * Two flags and not one, because `Error` carries three endings and a
     * program that had to tell them apart could only match on the message --
     * which is what the suite was doing, and a test reaching into a sentence
     * is the API saying it has no answer.  `e.Cancelled` and `e.Error` are
     * separate in BackgroundWorker for exactly this reason.
     */
    JS_SetPropertyStr(ctx, obj, "TimedOut", JS_FALSE);
    JS_SetPropertyStr(ctx, obj, "Cancelled", JS_FALSE);
    JS_SetPropertyStr(ctx, obj, "Done", JS_NULL);
    JS_SetPropertyStr(ctx, obj, "Error", JS_NULL);
    JS_SetPropertyStr(ctx, obj, "Progress", JS_NULL);
    JS_SetPropertyStr(ctx, obj, "__started", JS_FALSE);
    return obj;
}

/* The half both sides run.  Registering the same id into a second runtime is
 * the whole trick this file turns on; see the header. */
static void task_install(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSValue    proto, ctor;

    JS_NewClassID(rt, &task_class_id);
    JS_NewClass(rt, task_class_id, &task_class);

    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, task_props, G_N_ELEMENTS(task_props));
    JS_SetClassProto(ctx, task_class_id, proto);

    ctor = JS_NewCFunction2(ctx, task_construct, "Task", 0,
                            JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Task", ctor);
}

void bta_task_init(JSContext *ctx, JSValue global)
{
    /* install_globals runs on the main thread, in every kind of project. */
    task_main_thread = g_thread_self();
    task_install(ctx, global);
}

/* ----------------------------------------------- the .js index (workers) */

/* Which file declares a task class: `<name>.js` anywhere in the project or
 * its libraries, the project shadowing a library, the nearer file winning and
 * two at one depth meaning neither.  The same bargain index_forms makes for
 * `.form` files, over `.js` instead -- reading the other index would have
 * meant reaching through statics that are only true about forms. */
typedef struct {
    char *path;                 /* NULL = two files claimed this name */
    int   depth;
} JsEntry;

static GHashTable *js_index;
static char       *js_index_dir;

static void js_entry_free(gpointer p)
{
    JsEntry *e = p;

    g_free(e->path);
    g_free(e);
}

static void js_add(GHashTable *out, const char *key, const char *path, int depth)
{
    JsEntry *had = g_hash_table_lookup(out, key);

    if (!had) {
        JsEntry *e = g_new0(JsEntry, 1);

        e->path  = g_strdup(path);
        e->depth = depth;
        g_hash_table_insert(out, g_strdup(key), e);
        return;
    }
    if (had->path && depth < had->depth) {
        g_free(had->path);
        had->path  = g_strdup(path);
        had->depth = depth;
    } else if (depth == had->depth) {
        g_free(had->path);
        had->path = NULL;
    }
}

static bool js_is_ident(const char *name)
{
    if (!name || (!g_ascii_isalpha(name[0]) && name[0] != '_' && name[0] != '$'))
        return false;
    for (const char *p = name + 1; *p; p++)
        if (!g_ascii_isalnum(*p) && *p != '_' && *p != '$')
            return false;
    return true;
}

static void js_walk(GHashTable *out, const char *dir, const char *prefix,
                    int depth)
{
    GDir       *d = g_dir_open(dir, 0, NULL);
    const char *name;

    if (!d)
        return;
    while ((name = g_dir_read_name(d))) {
        char *path;

        if (name[0] == '.')
            continue;
        path = g_build_filename(dir, name, NULL);
        if (g_file_test(path, G_FILE_TEST_IS_DIR)) {
            /* A folder the code cannot name is not a namespace either: what is
             * underneath stays findable by its bare name, like index_forms. */
            if (js_is_ident(name)) {
                char *sub = prefix ? g_strjoin(".", prefix, name, NULL)
                                   : g_strdup(name);

                js_walk(out, path, sub, depth + 1);
                g_free(sub);
            } else {
                js_walk(out, path, prefix, depth + 1);
            }
        } else if (g_str_has_suffix(name, ".js")) {
            char *base = g_strndup(name, strlen(name) - 3);

            js_add(out, base, path, depth);
            if (prefix) {
                char *qual = g_strjoin(".", prefix, base, NULL);

                js_add(out, qual, path, depth);
                g_free(qual);
            }
            g_free(base);
        }
        g_free(path);
    }
    g_dir_close(d);
}

/* The path of the file declaring this class: a path, "" when two files claim
 * the name, NULL when none does.  Borrowed -- the table owns it.  One project
 * per process, so one cache keyed by its directory, rebuilt on a miss the way
 * form_path rebuilds on one.  Main thread only: Start is where it is read. */
static const char *task_class_file(BtaApp *app, const char *class_name)
{
    const char *dot;
    char       *bare = NULL;
    JsEntry    *e;

    if (!js_index || !js_index_dir || !g_str_equal(js_index_dir, app->dir)) {
        g_clear_pointer(&js_index, g_hash_table_unref);
        g_free(js_index_dir);
        js_index_dir = g_strdup(app->dir);
        js_index     = g_hash_table_new_full(g_str_hash, g_str_equal,
                                             g_free, js_entry_free);
        js_walk(js_index, app->dir, NULL, 0);
        if (app->libs)
            for (guint i = 0; i < app->libs->len; i++)
                js_walk(js_index, app->libs->pdata[i], NULL, 0);
    }

    e = g_hash_table_lookup(js_index, class_name);
    if (!e && (dot = strrchr(class_name, '.'))) {
        bare = g_strdup(dot + 1);
        e = g_hash_table_lookup(js_index, bare);
    }
    g_free(bare);
    if (!e)
        return NULL;
    return e->path ? e->path : "";
}

/* -------------------------------------------------------- crossing values */

/* `Decimal.prototype` in this context, or JS_UNDEFINED.  Both sides have the
 * class, so both sides ask the same question of their own global -- which is
 * what makes pack and unpack symmetric and this file short. */
static JSValue task_dec_proto(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue dec    = JS_GetPropertyStr(ctx, global, "Decimal");
    JSValue proto;

    JS_FreeValue(ctx, global);
    if (!JS_IsObject(dec)) {
        JS_FreeValue(ctx, dec);
        return JS_UNDEFINED;
    }
    proto = JS_GetPropertyStr(ctx, dec, "prototype");
    JS_FreeValue(ctx, dec);
    if (JS_IsException(proto)) {
        JS_FreeValue(ctx, proto);
        return JS_UNDEFINED;
    }
    return proto;
}

static bool task_is_dec(JSContext *ctx, JSValueConst dec_proto, JSValueConst v)
{
    JSValue proto;
    bool    is;

    if (!JS_IsObject(v) || !JS_IsObject(dec_proto))
        return false;
    proto = JS_GetPrototype(ctx, v);
    is = !JS_IsException(proto) &&
         JS_VALUE_GET_PTR(proto) == JS_VALUE_GET_PTR(dec_proto);
    JS_FreeValue(ctx, proto);
    return is;
}

typedef struct {
    void  **seen;               /* the path from the root, for cycles */
    size_t  nseen;
    size_t  cap;
    int     depth;
    JSValue dec_proto;          /* borrowed */
} TaskWalk;

/* Plain data, or false.  What JSON would silently drop, null or mangle --
 * functions, class instances, cycles, `undefined`, non-finite numbers -- is
 * refused here instead, because a total computed from a quietly subsetted
 * message is wrong on exactly one machine.  The caller throws the one
 * sentence; this only answers. */
static bool task_check(JSContext *ctx, TaskWalk *w, JSValueConst v)
{
    bool  ok = true;
    void *ptr;

    if (w->depth > 200)
        return false;

    if (JS_IsString(v) || JS_IsBool(v) || JS_IsNull(v))
        return true;
    if (JS_IsNumber(v)) {
        double d = 0;

        JS_ToFloat64(ctx, &d, v);
        return isfinite(d);
    }
    if (!JS_IsObject(v))
        return false;

    /* A decimal is terminal: it crosses as its own digits. */
    if (task_is_dec(ctx, w->dec_proto, v))
        return true;

    ptr = JS_VALUE_GET_PTR(v);
    for (size_t i = 0; i < w->nseen; i++)
        if (w->seen[i] == ptr)
            return false;
    if (w->nseen == w->cap) {
        w->cap  = w->cap ? w->cap * 2 : 16;
        w->seen = g_realloc(w->seen, w->cap * sizeof(void *));
    }
    w->seen[w->nseen++] = ptr;

    if (JS_IsArray(v)) {
        int64_t len = 0;

        if (JS_GetLength(ctx, v, &len) < 0)
            ok = false;
        w->depth++;
        for (int64_t i = 0; i < len && ok; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, v, (uint32_t)i);

            ok = !JS_IsException(item) && task_check(ctx, w, item);
            JS_FreeValue(ctx, item);
        }
        w->depth--;
    } else {
        JSValue proto = JS_GetPrototype(ctx, v);
        JSValue object_proto;
        bool    plain = false;

        {
            JSValue global = JS_GetGlobalObject(ctx);
            JSValue object = JS_GetPropertyStr(ctx, global, "Object");

            object_proto = JS_GetPropertyStr(ctx, object, "prototype");
            JS_FreeValue(ctx, object);
            JS_FreeValue(ctx, global);
        }
        if (!JS_IsException(proto) && !JS_IsException(object_proto) &&
            (JS_IsNull(proto) ||
             JS_VALUE_GET_PTR(proto) == JS_VALUE_GET_PTR(object_proto)))
            plain = true;
        JS_FreeValue(ctx, proto);
        JS_FreeValue(ctx, object_proto);

        if (!plain) {
            /* Anything with a class of its own -- a Record, a Day, a widget --
             * does not cross.  A record crosses as what Serialize writes. */
            ok = false;
        } else {
            JSPropertyEnum *tab = NULL;
            uint32_t        len = 0;

            w->depth++;
            if (JS_GetOwnPropertyNames(ctx, &tab, &len, v,
                                       JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
                ok = false;
            } else {
                for (uint32_t i = 0; i < len && ok; i++) {
                    JSValue item = JS_GetProperty(ctx, v, tab[i].atom);

                    ok = !JS_IsException(item) && task_check(ctx, w, item);
                    JS_FreeValue(ctx, item);
                }
                JS_FreePropertyEnum(ctx, tab, len);
            }
            w->depth--;
        }
    }

    w->nseen--;
    return ok;
}

/* Rewrite decimals as tagged text in a shadow tree, so the stringify
 * afterwards sees only plain data.  Mirrors the check above, and anything it
 * does not recognise is a bug in the check -- both walk the same values, so
 * the shadow never throws where the check passed.
 *
 * Properties are copied by **atom** and never through `JS_ToCString`: the
 * first version of this file leaked one C string per property of every message
 * it sent, because `JS_SetPropertyStr` does not take ownership of its name. */
static JSValue task_shadow(JSContext *ctx, JSValueConst dec_proto,
                           JSValueConst v)
{
    JSPropertyEnum *tab = NULL;
    uint32_t        len = 0;
    JSValue         out;

    if (JS_IsArray(v)) {
        int64_t n = 0;

        JS_GetLength(ctx, v, &n);
        out = JS_NewArray(ctx);
        if (JS_IsException(out))
            return out;
        for (int64_t i = 0; i < n; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
            JSValue copy = JS_IsException(item)
                         ? JS_EXCEPTION : task_shadow(ctx, dec_proto, item);

            JS_FreeValue(ctx, item);
            if (JS_IsException(copy)) {
                JS_FreeValue(ctx, out);
                return JS_EXCEPTION;
            }
            JS_SetPropertyUint32(ctx, out, (uint32_t)i, copy);
        }
        return out;
    }
    if (!JS_IsObject(v))
        return JS_DupValue(ctx, v);

    if (task_is_dec(ctx, dec_proto, v)) {
        /* Written down the way a file writes one: its own digits, exactly. */
        JSValue str = JS_ToString(ctx, v);
        JSValue tag;

        if (JS_IsException(str))
            return str;
        tag = JS_NewObject(ctx);
        if (JS_IsException(tag)) {
            JS_FreeValue(ctx, str);
            return tag;
        }
        JS_SetPropertyStr(ctx, tag, TASK_DEC_TAG, str);
        return tag;
    }

    out = JS_NewObject(ctx);
    if (JS_IsException(out))
        return out;
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, v,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        JS_FreeValue(ctx, out);
        return JS_EXCEPTION;
    }
    for (uint32_t i = 0; i < len; i++) {
        JSValue item = JS_GetProperty(ctx, v, tab[i].atom);
        JSValue copy = JS_IsException(item)
                     ? JS_EXCEPTION : task_shadow(ctx, dec_proto, item);

        JS_FreeValue(ctx, item);
        if (JS_IsException(copy)) {
            JS_FreePropertyEnum(ctx, tab, len);
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_SetProperty(ctx, out, tab[i].atom, copy);
    }
    JS_FreePropertyEnum(ctx, tab, len);
    return out;
}

/* Pack across: validate, turn decimals into tagged text, answer JSON.  The
 * stringify cannot surprise us afterwards -- whatever it drops was refused
 * above.  NULL with an exception pending.  The same function on both sides,
 * because both sides have the same `Decimal`. */
static char *task_pack(JSContext *ctx, JSValueConst v)
{
    TaskWalk w = { 0 };
    JSValue  dec_proto = task_dec_proto(ctx);
    JSValue  shadow = JS_UNDEFINED;
    char    *out = NULL;

    w.dec_proto = dec_proto;
    if (!task_check(ctx, &w, v)) {
        JS_ThrowTypeError(ctx, "Task: messages carry plain data -- objects, "
                               "arrays, strings, numbers, booleans, null and "
                               "decimals.  Functions, class instances, cycles, "
                               "`undefined` and `Bytes` do not cross; a Record "
                               "crosses as what Serialize writes");
        goto done;
    }

    shadow = task_shadow(ctx, dec_proto, v);
    if (JS_IsException(shadow))
        goto done;
    {
        JSValue global = JS_GetGlobalObject(ctx);
        JSValue json   = JS_GetPropertyStr(ctx, global, "JSON");
        JSValue str    = JS_GetPropertyStr(ctx, json, "stringify");
        JSValue r      = JS_Call(ctx, str, json, 1, (JSValueConst *)&shadow);

        if (!JS_IsException(r)) {
            const char *s = JS_ToCString(ctx, r);

            if (s)
                out = g_strdup(s);
            JS_FreeCString(ctx, s);
        }
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, str);
        JS_FreeValue(ctx, json);
        JS_FreeValue(ctx, global);
    }

done:
    JS_FreeValue(ctx, shadow);
    JS_FreeValue(ctx, dec_proto);
    g_free(w.seen);
    return out;
}

/* Tagged text back into decimals, in place.  What arrives was validated before
 * it was stringified, so anything unshaped here is an internal error and not a
 * refusal.  Takes ownership of `v`. */
static JSValue task_revive(JSContext *ctx, JSValueConst dec_ctor, JSValue v)
{
    JSPropertyEnum *tab = NULL;
    uint32_t        len = 0;

    if (!JS_IsObject(v))
        return v;

    if (!JS_IsArray(v)) {
        JSValue tagged = JS_GetPropertyStr(ctx, v, TASK_DEC_TAG);

        if (JS_IsString(tagged)) {
            JSValue dec = JS_CallConstructor(ctx, dec_ctor, 1,
                                             (JSValueConst *)&tagged);

            JS_FreeValue(ctx, tagged);
            JS_FreeValue(ctx, v);
            return dec;
        }
        JS_FreeValue(ctx, tagged);

        if (JS_GetOwnPropertyNames(ctx, &tab, &len, v,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
            JS_FreeValue(ctx, v);
            return JS_EXCEPTION;
        }
        for (uint32_t i = 0; i < len; i++) {
            JSValue item = JS_GetProperty(ctx, v, tab[i].atom);
            JSValue copy;

            if (JS_IsException(item)) {
                JS_FreePropertyEnum(ctx, tab, len);
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            copy = task_revive(ctx, dec_ctor, item);
            if (JS_IsException(copy)) {
                JS_FreePropertyEnum(ctx, tab, len);
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            JS_SetProperty(ctx, v, tab[i].atom, copy);
        }
        JS_FreePropertyEnum(ctx, tab, len);
        return v;
    }

    {
        int64_t n = 0;

        if (JS_GetLength(ctx, v, &n) < 0) {
            JS_FreeValue(ctx, v);
            return JS_EXCEPTION;
        }
        for (int64_t i = 0; i < n; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
            JSValue copy;

            if (JS_IsException(item)) {
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            copy = task_revive(ctx, dec_ctor, item);
            if (JS_IsException(copy)) {
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            JS_SetPropertyUint32(ctx, v, (uint32_t)i, copy);
        }
        return v;
    }
}

static JSValue task_unpack(JSContext *ctx, const char *json)
{
    JSValue v = JS_ParseJSON(ctx, json, strlen(json), "<task>");
    JSValue global, dec, out;

    if (JS_IsException(v))
        return v;
    global = JS_GetGlobalObject(ctx);
    dec    = JS_GetPropertyStr(ctx, global, "Decimal");
    JS_FreeValue(ctx, global);
    if (!JS_IsObject(dec)) {
        JS_FreeValue(ctx, dec);
        JS_FreeValue(ctx, v);
        return JS_ThrowInternalError(ctx, "Task: no Decimal to unpack with");
    }
    out = task_revive(ctx, dec, v);
    JS_FreeValue(ctx, dec);
    return out;
}

/* ---------------------------------------------------------- worker setup */

static JSValue task_print(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);

        printf("%s%s", i ? " " : "", s ? s : "?");
        JS_FreeCString(ctx, s);
    }
    putchar('\n');
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue task_log(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv, int magic)
{
    static const char *const levels[] = { "Debug", "Info", "Warning", "Error" };
    GString *line = g_string_new(NULL);

    g_string_append_printf(line, "Task %s:", levels[magic]);
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);

        g_string_append_printf(line, " %s", s ? s : "?");
        JS_FreeCString(ctx, s);
    }
    fprintf(stderr, "%s\n", line->str);
    g_string_free(line, TRUE);
    return JS_UNDEFINED;
}

/*
 * **A worker writes, and the eleven verbs that used to be refused are not.**
 *
 * They were refused with "two writers need a lock to order them", which named
 * a real gap and then pointed it at the wrong danger.  `File.Save` is
 * `g_file_set_contents`, which writes a temporary and renames over the target:
 * two threads saving one path cannot produce a torn file, only one of the two
 * whole ones.  `File.Delete` and `File.Rename` are `unlink` and `rename`, a
 * syscall each.  What is left -- `File.Copy`, `Directory.Copy`, `DeleteTree` --
 * leaves an intermediate state a reader can see, and so does the
 * `Exec(["cp", ...])` nobody ever proposed to refuse.
 *
 * What concurrency actually costs here is the **lost update**: read, change,
 * write from two threads and the second one wins, so the first one's change
 * never happened.  No automatic lock fixes that, because the gap is *between*
 * two calls and only the program knows which two.  That is what `Lock.Hold`
 * is for, and it is a tool to reach for rather than a condition of writing at
 * all -- which is why these came back before it arrived.
 */

/* A verb that would hang a callback off the main loop, which is the one thing
 * a worker can never do: the source fires on the main thread holding this
 * context, and two threads in one runtime is not an error, it is corruption. */
static const char *const task_loopers[] = { "File.Watch", "File.Open" };

static JSValue task_no_loop(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic)
{
    return JS_ThrowTypeError(ctx, "%s: a task cannot hand work back to the "
                                  "main loop -- report it, and let the answer "
                                  "do it", task_loopers[magic]);
}

static void task_delete(JSContext *ctx, JSValue global, const char *name)
{
    JSAtom atom = JS_NewAtom(ctx, name);

    JS_DeleteProperty(ctx, global, atom, 0);
    JS_FreeAtom(ctx, atom);
}

/* Replace `<object>.<verb>` with a refusal, keeping the verb's name so the
 * error says what was called rather than what replaced it. */
static void task_refuse(JSContext *ctx, JSValue global, const char *dotted,
                        JSCFunctionMagic *fn, int magic)
{
    const char *dot    = strchr(dotted, '.');
    char       *object = g_strndup(dotted, dot - dotted);
    JSValue     holder = JS_GetPropertyStr(ctx, global, object);

    if (JS_IsObject(holder))
        JS_SetPropertyStr(ctx, holder, dot + 1,
                          JS_NewCFunctionMagic(ctx, fn, dot + 1, 0,
                                               JS_CFUNC_generic_magic, magic));
    JS_FreeValue(ctx, holder);
    g_free(object);
}

/*
 * The worker's globals: this language, built the way install_globals builds
 * it, minus what the rule takes.
 *
 * The order matters and mirrors the main thread's: the classes first, then
 * rad.js (which captures what it needs), then the deletions, then the
 * hatches.  `Timer` and `Settings` are deleted *after* rad.js rather than
 * before, because rad.js is what creates them -- Timer out of the captured
 * `setTimeout`, which would fire on the main loop, and Settings out of a file
 * the main thread owns.
 */
static bool task_build_worker(JSContext *ctx, BtaTaskJob *job)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue r;

    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, task_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));

    JSValue logger = JS_NewObject(ctx);
    static const char *const levels[] = { "Debug", "Info", "Warning", "Error" };
    for (int i = 0; i < 4; i++)
        JS_SetPropertyStr(ctx, logger, levels[i],
                          JS_NewCFunctionMagic(ctx, task_log, levels[i], 1,
                                               JS_CFUNC_generic_magic, i));
    JS_SetPropertyStr(ctx, global, "Logger", logger);

    /* Application answers facts.  The verbs (Quit, OnError) and the questions
     * that render (the icon ones, DecorationLayout) do not cross threads, and
     * the lookups that walk the library path are the main thread's to answer. */
    JSValue application = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, application, "Name", JS_NewString(ctx, job->app_name));
    JS_SetPropertyStr(ctx, application, "Version",
                      JS_NewString(ctx, job->app_version));
    JS_SetPropertyStr(ctx, application, "Directory",
                      JS_NewString(ctx, job->app_dir));
    JS_SetPropertyStr(ctx, application, "ConfigDirectory",
                      JS_NewString(ctx, job->app_config));
    JS_SetPropertyStr(ctx, application, "Executable",
                      JS_NewString(ctx, job->app_exe));
    JSValue args = JS_NewArray(ctx);
    for (int i = 0; job->app_args && job->app_args[i]; i++)
        JS_SetPropertyUint32(ctx, args, (uint32_t)i,
                             JS_NewString(ctx, job->app_args[i]));
    JS_SetPropertyStr(ctx, application, "Arguments", args);
    JS_SetPropertyStr(ctx, global, "Application", application);

    /*
     * The real ones, out of the real files.  A class id registers into this
     * runtime exactly as it did into the main one, so `Decimal` here is
     * bta_decimal.c's `Decimal` -- same nine places, same `Round`, same
     * thirds -- and not a lookalike that rounds differently.
     *
     * Not here: bta_locale_init (the catalogue is a process-global hash table
     * the main thread filled, and prose is assembled where it is shown),
     * bta_painter_init / bta_metrics_init (cairo and pango, which is drawing),
     * bta_http_init and bta_media_init (callbacks on the loop), and every GTK
     * one.  Each is named in docs/plans/task-plan.md with the reason.
     */
    bta_bytes_init(ctx, global);
    bta_decimal_init(ctx, global);
    bta_day_init(ctx, global);
    bta_database_init(ctx, global);
    bta_sqlite_init(ctx, global);
    bta_sys_init(ctx, global);
    task_install(ctx, global);

    /* rad.js, the same text the main thread runs: Dictionary, Regex,
     * Stopwatch, Record, Field, Table and Namespace come from here, and
     * without it a worker would have no way to walk the keys of the plain
     * object a message is defined to be -- bta_close_hatches empties `Object`
     * and rad.js is what republishes the equivalent.  forms.js is the half
     * that is about widgets, and it is not evaluated here. */
    r = JS_Eval(ctx, bta_prelude_js, strlen(bta_prelude_js),
                "<rad.js>", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r)) {
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, global);
        return false;
    }
    JS_FreeValue(ctx, r);

    /* Gone because they hang a callback off the main loop, or draw, or are
     * process state the main thread owns.  Taken away rather than inherited:
     * a name that answered here would be a cross-thread answer wearing a safe
     * name. */
    task_delete(ctx, global, "Exec");
    task_delete(ctx, global, "Dialog");
    task_delete(ctx, global, "Clipboard");
    task_delete(ctx, global, "Screen");
    task_delete(ctx, global, "Message");
    task_delete(ctx, global, "Environment");
    task_delete(ctx, global, "Timer");      /* rad.js built it on setTimeout */
    task_delete(ctx, global, "Settings");   /* writes, and the main thread's */

    for (size_t i = 0; i < G_N_ELEMENTS(task_loopers); i++)
        task_refuse(ctx, global, task_loopers[i], task_no_loop, (int)i);

    JS_FreeValue(ctx, global);
    bta_close_hatches(ctx);
    return true;
}

/* ------------------------------------------------------------ the thread */

static int task_interrupt(JSRuntime *rt, void *opaque)
{
    volatile gint *stop = opaque;

    /* 1 is a request and not an abort: a worker that watches `Stopping` gets
     * to finish its sentence.  2 (timed out) and 3 (forced) are the ones that
     * end it where it stands. */
    return g_atomic_int_get(stop) >= 2;
}

/* The error out of an exception: the message, and the stack when there is one
 * -- the two halves Application.OnError takes, so a worker's failure reads
 * like any other uncaught one. */
static void task_exc_text(JSContext *ctx, char **msg, char **stack)
{
    JSValue     exc = JS_GetException(ctx);
    JSValue     m   = JS_GetPropertyStr(ctx, exc, "message");
    JSValue     st  = JS_GetPropertyStr(ctx, exc, "stack");
    const char *s;

    s = JS_ToCString(ctx, m);
    *msg = g_strdup(s ? s : "error");
    JS_FreeCString(ctx, s);
    s = JS_ToCString(ctx, st);
    *stack = g_strdup(s ? s : "");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, m);
    JS_FreeValue(ctx, st);
    JS_FreeValue(ctx, exc);
}

/* Which ending this was, once `Run` has returned or thrown.  The flag is the
 * answer and not the timing: a stop that landed between the last opcode and
 * the return still counts, and a run that saw `Stopping` and returned politely
 * is still a cancelled run -- the caller asked, and it stopped. */
static void task_ending(BtaTaskJob *job, JSContext *ctx, bool threw)
{
    gint stop = g_atomic_int_get(&job->stop);

    if (stop == 2) {
        job->fail       = 3;
        job->fail_msg   = g_strdup_printf("Task: timed out after %ld ms",
                                          job->timeout_ms);
        job->fail_stack = g_strdup("");
    } else if (stop == 1 || stop == 3) {
        job->fail       = 2;
        job->fail_msg   = g_strdup("Task: cancelled");
        job->fail_stack = g_strdup("");
    } else if (threw) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
    }
}

static gpointer task_thread(gpointer data)
{
    BtaTaskJob *job = data;
    JSRuntime  *rt;
    JSContext  *ctx;
    BtaTaskEnv  env = { 0 };
    JSValue     r, cls, inst, run, msg, ans;

    rt = JS_NewRuntime();
    /* The budget is bytes and buys levels -- the same numbers the main runtime
     * uses, since a worker walks the same shapes.  `JS_NewRuntime` records the
     * stack top of the thread that calls it, which is why this is here and not
     * in Start.  Well under the thread's 8 MB either way. */
#if defined(__SANITIZE_ADDRESS__)
    JS_SetMaxStackSize(rt, 6 * 1024 * 1024);
#else
    JS_SetMaxStackSize(rt, 2 * 1024 * 1024);
#endif
    ctx = bta_new_context(rt);
    if (!ctx) {
        job->fail       = 1;
        job->fail_msg   = g_strdup("Task: the worker context would not start");
        job->fail_stack = g_strdup("");
        JS_FreeRuntime(rt);
        goto done;
    }

    env.job = job;
    JS_SetRuntimeOpaque(rt, &env);
    /* Listed before anything is evaluated: bta_task_is_worker is what the
     * widget constructor and Report ask, and both can be reached from the
     * first line of the file below. */
    g_mutex_lock(&task_lock);
    task_rts = g_list_prepend(task_rts, rt);
    g_mutex_unlock(&task_lock);
    JS_SetInterruptHandler(rt, task_interrupt, (void *)&job->stop);

    if (!task_build_worker(ctx, job)) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
        goto unwind;
    }

    r = JS_Eval(ctx, job->file_text, strlen(job->file_text), job->file_path,
                JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r)) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
        JS_FreeValue(ctx, r);
        goto unwind;
    }
    JS_FreeValue(ctx, r);

    /* A top-level `class` lives in the global lexical scope and not on
     * globalThis -- the reason bta_lookup_global exists -- so the class is
     * looked up the way the runtime looks up a form's class. */
    cls = bta_lookup_global(ctx, job->class_name);
    if (JS_IsException(cls)) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
        goto unwind;
    }
    if (!JS_IsConstructor(ctx, cls)) {
        job->fail_msg   = g_strdup_printf("Task: '%s' is not a class",
                                          job->class_name);
        job->fail_stack = g_strdup("");
        job->fail       = 1;
        JS_FreeValue(ctx, cls);
        goto unwind;
    }
    inst = JS_CallConstructor(ctx, cls, 0, NULL);
    JS_FreeValue(ctx, cls);
    if (JS_IsException(inst)) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
        goto unwind;
    }
    run = JS_GetPropertyStr(ctx, inst, "Run");
    if (!JS_IsFunction(ctx, run)) {
        job->fail_msg   = g_strdup_printf("Task: '%s' has no Run(msg)",
                                          job->class_name);
        job->fail_stack = g_strdup("");
        job->fail       = 1;
        JS_FreeValue(ctx, run);
        JS_FreeValue(ctx, inst);
        goto unwind;
    }
    msg = task_unpack(ctx, job->msg_json);
    if (JS_IsException(msg)) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
        JS_FreeValue(ctx, run);
        JS_FreeValue(ctx, inst);
        goto unwind;
    }

    ans = JS_Call(ctx, run, inst, 1, (JSValueConst *)&msg);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, run);
    JS_FreeValue(ctx, inst);

    task_ending(job, ctx, JS_IsException(ans));
    if (job->fail) {
        JS_FreeValue(ctx, ans);
        goto unwind;
    }
    job->result_json = task_pack(ctx, ans);
    JS_FreeValue(ctx, ans);
    if (!job->result_json) {
        task_exc_text(ctx, &job->fail_msg, &job->fail_stack);
        job->fail = 1;
    }

unwind:
    g_mutex_lock(&task_lock);
    task_rts = g_list_remove(task_rts, rt);
    g_mutex_unlock(&task_lock);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);

done:
    /* Said before the idle source, so teardown's bounded wait ends as soon as
     * the runtime is gone rather than when the loop gets around to it. */
    g_mutex_lock(&task_lock);
    job->ended = true;
    g_cond_broadcast(&task_ended);
    g_mutex_unlock(&task_lock);

    /*
     * Last: the main thread joins, drains and answers from here.
     *
     * An idle source and not `g_main_context_invoke`: with no loop running an
     * invoke dispatches synchronously **in the caller**, so a task that
     * finished between `Main` returning and the console loop starting had its
     * delivery run on its own thread, which then joined itself and hung
     * forever -- green in every suite run, because the loop is always up
     * there, and a hang in the one program that quit early.  An idle source
     * simply waits for a loop that may still start, and teardown joins what
     * never got delivered.
     */
    g_idle_add_full(G_PRIORITY_DEFAULT, task_deliver, job, NULL);
    return NULL;
}

/* ------------------------------------------------------------- delivery */

/* Call one handler, the way Exec calls its line callbacks: an exception is
 * reported where it was raised and the run goes on. */
static void task_emit(JSContext *ctx, JSValueConst self, const char *handler,
                      int argc, JSValueConst *argv)
{
    JSValue fn = JS_GetPropertyStr(ctx, self, handler);

    if (JS_IsFunction(ctx, fn)) {
        JSValue r = JS_Call(ctx, fn, self, argc, argv);

        if (JS_IsException(r))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
    }
    JS_FreeValue(ctx, fn);
}

/* Drain queued progress reports, in order.  A report with no Progress handler
 * is dropped -- an event nobody handles is an event that never happened,
 * which is also what the main side does with a Click nobody wrote. */
static void task_pump(JSContext *ctx, BtaTaskJob *job)
{
    for (;;) {
        char   *json;
        JSValue v;

        g_mutex_lock(&task_lock);
        json = g_queue_pop_head(job->reports);
        if (!json)
            job->drain_queued = false;
        g_mutex_unlock(&task_lock);
        if (!json)
            return;

        v = task_unpack(ctx, json);
        g_free(json);
        if (JS_IsException(v)) {
            bta_dump_error(ctx);
            continue;
        }
        task_emit(ctx, job->self, "Progress", 1, (JSValueConst *)&v);
        JS_FreeValue(ctx, v);
    }
}

static gboolean task_deliver(gpointer data)
{
    BtaTaskJob *job = data;
    bool        dead;

    /* The guardrail for the hang described in task_thread: if this ever ran
     * anywhere but the main thread, the join below would be a self-join. */
    if (!task_on_main())
        return G_SOURCE_REMOVE;

    g_mutex_lock(&task_lock);
    dead = job->dead;
    task_jobs = g_list_remove(task_jobs, job);
    g_mutex_unlock(&task_lock);

    /* The thread packed everything before invoking: joining only collects. */
    g_thread_join(job->thread);
    job->thread = NULL;
    if (job->timeout_src) {
        g_source_remove(job->timeout_src);
        job->timeout_src = 0;
    }
    if (job->force_src) {
        g_source_remove(job->force_src);
        job->force_src = 0;
    }
    if (!dead) {
        task_pump(job->ctx, job);
        JS_SetPropertyStr(job->ctx, job->self, "Running", JS_FALSE);
        if (job->fail == 0) {
            JSValue v = task_unpack(job->ctx,
                                    job->result_json ? job->result_json : "null");

            if (JS_IsException(v)) {
                bta_dump_error(job->ctx);
            } else {
                task_emit(job->ctx, job->self, "Done", 1, (JSValueConst *)&v);
                JS_FreeValue(job->ctx, v);
            }
        } else {
            JSValue msg   = JS_NewString(job->ctx,
                                         job->fail_msg ? job->fail_msg : "error");
            JSValue stack = JS_NewString(job->ctx,
                                         job->fail_stack ? job->fail_stack : "");
            JSValue args[2] = { msg, stack };

            /* Which ending it was, said as a flag rather than in a sentence
             * the caller would have to match on. */
            if (job->fail == 3)
                JS_SetPropertyStr(job->ctx, job->self, "TimedOut", JS_TRUE);
            if (job->fail == 2)
                JS_SetPropertyStr(job->ctx, job->self, "Cancelled", JS_TRUE);
            task_emit(job->ctx, job->self, "Error", 2, (JSValueConst *)args);
            JS_FreeValue(job->ctx, msg);
            JS_FreeValue(job->ctx, stack);
        }
        JS_FreeValue(job->ctx, job->self);
        bta_drain_jobs(JS_GetRuntime(job->ctx));
    }
    task_job_free(job);
    return G_SOURCE_REMOVE;
}

/* One of these is queued per *batch* and not per report: the pump empties the
 * whole queue, so a second source would find nothing, and a hundred thousand
 * reports would be a hundred thousand GSources allocated to do nothing.  The
 * flag is cleared by the pump, under the same lock that guards the queue. */
static gboolean task_progress_drain(gpointer data)
{
    BtaTaskJob *job = data;
    bool        live;

    g_mutex_lock(&task_lock);
    live = task_find_locked(job->self) != NULL && !job->dead;
    g_mutex_unlock(&task_lock);
    if (live && task_on_main())
        task_pump(job->ctx, job);
    return G_SOURCE_REMOVE;
}

static gboolean task_timeout(gpointer data)
{
    BtaTaskJob *job = data;

    g_mutex_lock(&task_lock);
    if (task_find_locked(job->self) && !job->dead) {
        job->timeout_src = 0;
        g_atomic_int_set(&job->stop, 2);
    }
    g_mutex_unlock(&task_lock);
    return G_SOURCE_REMOVE;
}

/* The second stage of a Stop: the worker was asked and did not go, so now it
 * is ended where it stands.  `Exec`'s `on_exec_force`, with a flag where that
 * one has a signal. */
static gboolean task_force(gpointer data)
{
    BtaTaskJob *job = data;

    g_mutex_lock(&task_lock);
    if (task_find_locked(job->self) && !job->dead) {
        job->force_src = 0;
        g_atomic_int_set(&job->stop, 3);
    }
    g_mutex_unlock(&task_lock);
    return G_SOURCE_REMOVE;
}

/* ------------------------------------------------------------- the verbs */

static bool task_opt_timeout(JSContext *ctx, JSValueConst opts, long *out)
{
    JSValue t = JS_GetPropertyStr(ctx, opts, "Timeout");
    double  ms = 0;

    *out = 0;
    if (!JS_IsUndefined(t) && !JS_IsNull(t)) {
        if (!JS_IsNumber(t)) {
            JS_ThrowTypeError(ctx, "Task: Timeout is milliseconds, a number");
            JS_FreeValue(ctx, t);
            return false;
        }
        JS_ToFloat64(ctx, &ms, t);
        *out = ms <= 0 ? 0 : ms >= (double)G_MAXUINT ? G_MAXUINT : (long)ms;
    }
    JS_FreeValue(ctx, t);
    return true;
}

static JSValue task_start(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    JSValue     started;
    bool        was;
    long        timeout = 0;
    JSValue     ctor, name;
    const char *s;
    char       *class_name, *text, *path;
    const char *found;
    size_t      len = 0;
    BtaApp     *app;
    BtaTaskJob *job;
    char       *msg_json;

    if (bta_task_is_worker(ctx))
        return JS_ThrowTypeError(ctx, "Task: a task cannot start another task");

    started = JS_GetPropertyStr(ctx, this_val, "__started");
    was = JS_ToBool(ctx, started);
    JS_FreeValue(ctx, started);
    if (was)
        return JS_ThrowTypeError(ctx, "Task: a Task runs once -- start a new "
                                      "one for the next job");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Task.Start needs the message to send");
    if (argc > 1 && !task_opt_timeout(ctx, argv[1], &timeout))
        return JS_EXCEPTION;

    ctor = JS_GetPropertyStr(ctx, this_val, "constructor");
    name = JS_GetPropertyStr(ctx, ctor, "name");
    s = JS_ToCString(ctx, name);
    class_name = g_strdup(s ? s : "");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, name);
    JS_FreeValue(ctx, ctor);

    app   = bta_current_app();
    found = app ? task_class_file(app, class_name) : NULL;
    if (!found) {
        JSValue r = JS_ThrowTypeError(ctx, "Task: cannot find task class '%s'",
                                      class_name);
        g_free(class_name);
        return r;
    }
    if (!*found) {
        JSValue r = JS_ThrowTypeError(ctx, "Task: more than one file declares "
                                           "'%s'", class_name);
        g_free(class_name);
        return r;
    }
    text = bta_read_file(found, &len);
    path = g_strdup(found);
    if (!text) {
        JSValue r = JS_ThrowTypeError(ctx, "Task: cannot read %s", path);
        g_free(class_name);
        g_free(path);
        return r;
    }

    msg_json = task_pack(ctx, argv[0]);
    if (!msg_json) {
        g_free(class_name);
        g_free(path);
        g_free(text);
        return JS_EXCEPTION;
    }

    job = g_new0(BtaTaskJob, 1);
    job->ctx        = ctx;
    job->self       = JS_DupValue(ctx, this_val);
    job->reports    = g_queue_new();
    job->class_name = class_name;
    job->file_text  = text;
    job->file_path  = path;
    job->msg_json   = msg_json;
    job->timeout_ms = timeout;
    if (app) {
        char *exe = bta_exe_path();

        job->app_name    = g_strdup(app->name);
        job->app_version = g_strdup(app->version);
        job->app_dir     = g_strdup(app->dir);
        job->app_config  = g_build_filename(g_get_user_config_dir(), "bintana",
                                            app->name, NULL);
        job->app_exe     = exe ? exe : g_strdup("");
        if (app->args) {
            int n = 0;

            while (app->args[n])
                n++;
            job->app_args = g_new0(char *, n + 1);
            for (int i = 0; i < n; i++)
                job->app_args[i] = g_strdup(app->args[i]);
        }
    } else {
        job->app_name    = g_strdup("");
        job->app_version = g_strdup("");
        job->app_dir     = g_strdup("");
        job->app_config  = g_strdup("");
        job->app_exe     = g_strdup("");
    }

    JS_SetPropertyStr(ctx, this_val, "__started", JS_TRUE);
    JS_SetPropertyStr(ctx, this_val, "Running", JS_TRUE);

    g_mutex_lock(&task_lock);
    task_jobs = g_list_prepend(task_jobs, job);
    g_mutex_unlock(&task_lock);

    job->thread = g_thread_new("bta-task", task_thread, job);
    if (timeout > 0)
        job->timeout_src = g_timeout_add((guint)timeout, task_timeout, job);
    return JS_DupValue(ctx, this_val);
}

/* `KillAfter`, in milliseconds: how long a stop waits to be honoured before it
 * stops asking.  The same name, the same default and the same two stages as
 * `Exec`'s guard, because it is the same bargain -- and `0` means force at
 * once, which is what this used to do always. */
#define TASK_KILL_AFTER 5000

static JSValue task_stop(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaTaskJob *job;
    bool        running = false;
    double      after = TASK_KILL_AFTER;

    /* In a worker, stopping is suicide with an answer: `Run` returning is how
     * a task stops itself, and `this.Stopping` is how it knows to. */
    if (bta_task_is_worker(ctx))
        return JS_ThrowTypeError(ctx, "Task: a task stops itself by returning "
                                      "-- read this.Stopping and come back");

    if (argc > 0 && JS_IsObject(argv[0])) {
        JSValue v = JS_GetPropertyStr(ctx, argv[0], "KillAfter");

        if (!JS_IsUndefined(v) && !JS_IsNull(v)) {
            if (!JS_IsNumber(v)) {
                JS_FreeValue(ctx, v);
                return JS_ThrowTypeError(ctx, "Task: KillAfter is "
                                              "milliseconds, a number");
            }
            JS_ToFloat64(ctx, &after, v);
            if (after < 0)
                after = 0;
            if (after > (double)G_MAXUINT)
                after = (double)G_MAXUINT;
        }
        JS_FreeValue(ctx, v);
    }

    g_mutex_lock(&task_lock);
    job = task_find_locked(this_val);
    if (job && !job->dead && g_atomic_int_get(&job->stop) == 0) {
        /*
         * **Asked, not ended.**  The flag the worker reads goes up here and
         * the interrupt handler leaves it alone, so a `Run` that watches
         * `Stopping` can `Report` what it has and return -- the nine subtrees
         * it already measured arrive instead of being thrown away.  A `Run`
         * that does not watch is ended by task_force, so `Stop()` still means
         * the run ends; what it stopped meaning is *ends this instant*.
         */
        g_atomic_int_set(&job->stop, 1);
        if (after <= 0)
            g_atomic_int_set(&job->stop, 3);
        else
            job->force_src = g_timeout_add((guint)after, task_force, job);
        running = true;
    } else if (job && !job->dead) {
        /* Asked already: saying it twice does not restart the clock, and the
         * answer is still yes -- there is a live job here. */
        running = true;
    }
    g_mutex_unlock(&task_lock);
    return JS_NewBool(ctx, running);
}

/*
 * `this.Stopping` inside `Run`, and `t.Stopping` on the handle.
 *
 * **A worker could be stopped and never told.**  `Stop()` used to raise a flag
 * the interrupt handler read at once, which ended the run where it stood -- so
 * a job that had measured nine subtrees out of ten lost all nine.  Every
 * environment with threads answers this the same way and makes it the central
 * idiom: Delphi's `while not Terminated`, BackgroundWorker's
 * `if (worker.CancellationPending)`, Qt's `promise.isCanceled()`.
 *
 * It does not change what the ending *is*: a run that saw the flag and
 * returned still answers `Error` with `Cancelled` set, because the caller
 * asked it to stop and it stopped.  What changes is how much of the work
 * survives -- whatever it managed to `Report` on the way out.
 */
static JSValue task_get_stopping(JSContext *ctx, JSValueConst this_val)
{
    BtaTaskEnv *env = task_env(ctx);
    bool        stopping;

    if (env)
        return JS_NewBool(ctx, g_atomic_int_get(&env->job->stop) != 0);

    /* On the handle it answers the same question from the other end: asked to
     * stop, and not yet ended.  A job that is gone was not asked. */
    g_mutex_lock(&task_lock);
    {
        BtaTaskJob *job = task_find_locked(this_val);

        stopping = job && g_atomic_int_get(&job->stop) != 0;
    }
    g_mutex_unlock(&task_lock);
    return JS_NewBool(ctx, stopping);
}

static JSValue task_report(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaTaskEnv *env = task_env(ctx);
    char       *json;
    bool        queue;

    /* On a proxy this is the worker's voice arriving at the wrong end. */
    if (!env)
        return JS_ThrowTypeError(ctx, "Task.Report runs inside the worker -- "
                                      "call it from Run, read it as Progress");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Task.Report needs the value to send");

    json = task_pack(ctx, argv[0]);
    if (!json)
        return JS_EXCEPTION;

    g_mutex_lock(&task_lock);
    g_queue_push_tail(env->job->reports, json);
    queue = !env->job->drain_queued;
    env->job->drain_queued = true;
    g_mutex_unlock(&task_lock);
    if (queue)
        g_idle_add_full(G_PRIORITY_DEFAULT, task_progress_drain, env->job, NULL);
    return JS_UNDEFINED;
}

/*
 * How long teardown waits for a worker that will not come back.
 *
 * A forced stop reaches JS at the next opcode, which is immediate; this budget
 * is for the other case -- a thread inside a native call that never returns, a
 * filesystem that stopped answering.  Long enough that a real ending is never
 * cut short, short enough that a program still closes.
 */
#define TASK_JOIN_GRACE (2 * G_TIME_SPAN_SECOND)

void bta_task_cleanup(void)
{
    GList *jobs;
    guint  adrift = 0;

    g_mutex_lock(&task_lock);
    jobs = task_jobs;
    task_jobs = NULL;
    for (GList *l = jobs; l; l = l->next)
        ((BtaTaskJob *)l->data)->dead = true;
    g_mutex_unlock(&task_lock);

    /* Forced outright and all at once: teardown has no time to ask politely,
     * and asking N threads one at a time would serialise N waits that could
     * have overlapped. */
    for (GList *l = jobs; l; l = l->next)
        g_atomic_int_set(&((BtaTaskJob *)l->data)->stop, 3);

    for (GList *l = jobs; l; l = l->next) {
        BtaTaskJob *job = l->data;
        gint64      deadline = g_get_monotonic_time() + TASK_JOIN_GRACE;
        bool        ended;

        /*
         * **A bounded join, because `g_thread_join` has no bounded form.**
         * The interrupt aborts worker JS promptly and this ends at once; what
         * it is here for is the thread blocked in native code, which no flag
         * reaches -- a thread cannot be shot the way a child can, and every
         * runtime that offered to (`Thread.Abort`, `Thread.stop`,
         * `pthread_cancel`) withdrew it.  So the wait has an end, and a thread
         * still running when it passes is **cast adrift rather than joined**:
         * its job is deliberately left unfreed, because the one thing worse
         * than leaking it on the last line before exit is freeing memory a
         * live thread still writes to.
         */
        g_mutex_lock(&task_lock);
        while (!job->ended)
            if (!g_cond_wait_until(&task_ended, &task_lock, deadline))
                break;
        ended = job->ended;
        g_mutex_unlock(&task_lock);

        if (!ended) {
            adrift++;
            continue;
        }
        g_thread_join(job->thread);
        if (job->timeout_src)
            g_source_remove(job->timeout_src);
        if (job->force_src)
            g_source_remove(job->force_src);
        JS_FreeValue(job->ctx, job->self);
        task_job_free(job);
    }
    g_list_free(jobs);

    /* Said out loud: a program that closes while something of it is still
     * running should not do so silently, and the sentence names the shape of
     * the cause rather than blaming the task. */
    if (adrift)
        fprintf(stderr, "bintana: %u task%s still inside a native call at exit "
                        "(a filesystem that stopped answering, most likely); "
                        "closing anyway\n",
                adrift, adrift == 1 ? "" : "s");
}
