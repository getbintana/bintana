/*
 * Profiling with Sysprof (`docs/installing.md`), and what is paid when nobody
 * is listening.
 *
 * A sampled profile of this runtime shows `JS_CallInternal` and never which
 * function a `.js` file declared, because QuickJS interprets.  The answer is
 * marks: named spans on the Sysprof timeline, raised by the runtime at the
 * places where time really goes (a form being built, a script loading, a frame
 * drawn, a `Task` running, an event's handler) and by an application for its
 * own code (`Profile.Begin`/`End`/`Mark`).  A Sysprof capture also carries the
 * samples and GTK's frame marks, so the two views are one timeline.
 *
 * ## Two ways in, and the difference between them
 *
 * - **The collector** (`SYSPROF_CONTROL_FD`): Sysprof launched this process --
 *   `sysprof-cli -- ./build/bintana ide` or the application's *Profile a new
 *   process* -- and the marks are written into a ring buffer Sysprof mapped for
 *   us.  This is the same road GTK takes, so its frame marks ride along.
 * - **A file** (`--profile <file>`, or `SYSPROF_TRACE_FD` handed by
 *   `sysprof-cli --use-trace-fd`): `SysprofCaptureWriter` writes the capture
 *   directly.  No Sysprof is needed at run time, and the `.syscap` is opened in
 *   the Sysprof application later; what it does not carry is samples, because
 *   those are Sysprof's.
 *
 * **With neither, nothing here is initialised at all.**  No collector, no
 * writer, no clock: `bta_profile_start` looks at the environment once, and
 * every instrumented point is `bta_profile_begin()`, which answers 0 and costs
 * a load of a bool.  The marks an application writes through `Profile` are
 * no-ops in the same state, so a program instrumented for a capture runs
 * unchanged without one.
 *
 * ## The tables both writers want, which are not the same table
 *
 * `sysprof_collector_mark(time, duration, group, name, message)` and
 * `sysprof_capture_writer_add_mark(w, time, cpu, pid, duration, group, name,
 * message)` disagree about where `duration` sits and about its signedness, and
 * a mark's `group`/`name` are truncated by the capture format (24 and 40
 * characters).  One `profile_emit` writes both, so the two roads cannot drift.
 *
 * **The writer is not thread-safe and the collector is.**  A `Task` marks from
 * its own thread, so the writer is held under one mutex; the collector keeps a
 * buffer per thread and needs nothing from us.
 *
 * ## What the calls cost
 *
 * All times are `g_get_monotonic_time()` -- microseconds on `CLOCK_MONOTONIC`,
 * which is the clock Sysprof's own marks use.
 */
#include "bta.h"

#include <stdio.h>
#include <string.h>

#ifdef BTA_HAVE_SYSPROF
# include <sysprof-capture.h>
# include <unistd.h>
#endif

static bool profile_on;         /* marks are going somewhere */
static bool profile_collector;  /* ...through the collector */
static int64_t profile_started; /* when `bta_profile_start` ran, for Startup */

#ifdef BTA_HAVE_SYSPROF
static SysprofCaptureWriter *profile_writer;
/* The capture writer is not thread-safe; a Task marks from its own thread. */
static GMutex profile_writer_lock;
#endif

/*
 * `Profile.Begin`'s open spans, per thread: a `Task` worker runs its own
 * runtime on its own thread and can nest its own spans, and the language has no
 * async, so a thread's spans nest strictly and LIFO.  Freed when the thread
 * ends, and emptied at `bta_profile_finish` for the main one.
 */
typedef struct {
    char   *name;
    int64_t begin;
} ProfileSpan;

static void profile_span_free(gpointer data)
{
    ProfileSpan *s = data;

    g_free(s->name);
    g_free(s);
}

static void profile_stack_free(gpointer data)
{
    g_ptr_array_unref(data);
}

static GPrivate profile_stack_key = G_PRIVATE_INIT(profile_stack_free);

static GPtrArray *profile_spans(void)
{
    GPtrArray *stack = g_private_get(&profile_stack_key);

    if (!stack) {
        stack = g_ptr_array_new_with_free_func(profile_span_free);
        g_private_set(&profile_stack_key, stack);
    }
    return stack;
}

/*
 * The one place a mark is written, however it was asked for.  `begin` is 0 for
 * "nobody is listening" -- what `bta_profile_begin` answers -- so a call site
 * that forgot its own guard writes nothing rather than a mark at time zero.
 *
 * `end` is a parameter and not read here on purpose: a call site that builds the
 * mark's name after the work passes the end it read *before* building it, or
 * the profiler's own `g_strdup_printf` would be charged to the handler.  See
 * `bta_profile_end_at`.
 */
static void profile_emit(int64_t begin, int64_t end, const char *group,
                         const char *name, const char *message)
{
#ifdef BTA_HAVE_SYSPROF
    if (!begin || !profile_on)
        return;

    int64_t duration = end - begin;

    if (profile_writer) {
        g_mutex_lock(&profile_writer_lock);
        sysprof_capture_writer_add_mark(profile_writer, begin, -1,
                                        (int32_t)getpid(), (uint64_t)duration,
                                        group, name, message ? message : "");
        g_mutex_unlock(&profile_writer_lock);
    }

    if (profile_collector)
        sysprof_collector_mark(begin, duration, group, name,
                               message ? message : "");
#else
    (void)begin;
    (void)group;
    (void)name;
    (void)message;
#endif
}

/*
 * What `--profile` asked for and what the environment says, in one place.
 *
 * The collector handshake happens here -- `sysprof_collector_is_active` is what
 * connects to `SYSPROF_CONTROL_FD` -- rather than on the first mark, so
 * `Profile.Active` answers before any code runs and a run under Sysprof whose
 * handshake failed is a run with no marks rather than a hang on the first one.
 */
bool bta_profile_start(const char *file)
{
#ifndef BTA_HAVE_SYSPROF
    if (file) {
        fprintf(stderr, "bintana: --profile needs the sysprof-capture library "
                        "-- install sysprof-capture-devel (Fedora) or "
                        "libsysprof-capture-4-dev (Debian/Ubuntu) and rebuild\n");
        return false;
    }
    return true;
#else
    const char *trace = g_getenv("SYSPROF_TRACE_FD");

    if (file) {
        profile_writer = sysprof_capture_writer_new(file, 0);
        if (!profile_writer) {
            fprintf(stderr, "bintana: --profile cannot write '%s'\n", file);
            return false;
        }
        /* A run that exits through `bta_app_new`'s refusal still leaves a
         * capture that ends cleanly, rather than a truncated file. */
        atexit(bta_profile_finish);
    } else if (trace && *trace) {
        profile_writer = sysprof_capture_writer_new_from_env(0);
    }

    if (g_getenv("SYSPROF_CONTROL_FD")) {
        sysprof_collector_init();
        profile_collector = sysprof_collector_is_active();
    }

    profile_on        = profile_writer != NULL || profile_collector;
    profile_started   = profile_on ? g_get_monotonic_time() : 0;
    return true;
#endif
}

void bta_profile_finish(void)
{
#ifdef BTA_HAVE_SYSPROF
    profile_on = false;

    if (profile_writer) {
        g_mutex_lock(&profile_writer_lock);
        sysprof_capture_writer_flush(profile_writer);
        sysprof_capture_writer_unref(profile_writer);
        profile_writer = NULL;
        g_mutex_unlock(&profile_writer_lock);
    }
#endif
    /* The spans `Profile.Begin` left open, if any: the thread's own storage. */
    g_private_replace(&profile_stack_key, NULL);
}

bool bta_profile_active(void)
{
    return profile_on;
}

int64_t bta_profile_begin(void)
{
    return profile_on ? g_get_monotonic_time() : 0;
}

void bta_profile_end(int64_t begin, const char *group, const char *name,
                     const char *message)
{
    profile_emit(begin, g_get_monotonic_time(), group, name, message);
}

void bta_profile_end_at(int64_t begin, int64_t end, const char *group,
                        const char *name, const char *message)
{
    profile_emit(begin, end, group, name, message);
}

void bta_profile_startup_done(const char *project)
{
    if (!profile_started)
        return;

    int64_t begin   = profile_started;
    int64_t end     = g_get_monotonic_time();
    profile_started = 0;
    profile_emit(begin, end, "Bintana", "Startup", project ? project : "");
}

/* --------------------------------------------------------- the JS surface */

/* The name an argument has to be, or NULL with a TypeError pending. */
static const char *profile_name(JSContext *ctx, JSValueConst val,
                                const char *who)
{
    if (!JS_IsString(val)) {
        JS_ThrowTypeError(ctx, "%s: the name has to be text", who);
        return NULL;
    }
    return JS_ToCString(ctx, val);   /* NULL with the conversion's own error */
}

static JSValue js_profile_active(JSContext *ctx, JSValueConst this_val)
{
    return JS_NewBool(ctx, bta_profile_active());
}

static JSValue js_profile_begin(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Profile.Begin(name) expects a name");

    const char *name = profile_name(ctx, argv[0], "Profile.Begin");
    if (!name)
        return JS_EXCEPTION;

    if (bta_profile_active()) {
        ProfileSpan *span = g_new0(ProfileSpan, 1);
        span->name  = g_strdup(name);
        span->begin = g_get_monotonic_time();
        g_ptr_array_add(profile_spans(), span);
    }
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue js_profile_end(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Profile.End(name) expects a name");

    const char *name = profile_name(ctx, argv[0], "Profile.End");
    if (!name)
        return JS_EXCEPTION;

    if (bta_profile_active()) {
        GPtrArray   *stack = profile_spans();
        ProfileSpan *top   = stack->len
                                 ? g_ptr_array_index(stack, stack->len - 1)
                                 : NULL;

        if (!top || strcmp(top->name, name) != 0) {
            JSValue thrown = JS_ThrowTypeError(
                ctx, "Profile.End('%s') has no matching Begin -- the innermost "
                     "span is '%s'", name, top ? top->name : "none");
            JS_FreeCString(ctx, name);
            /* An `End` with nothing open built the stack just to ask: let it
             * go rather than keep an empty one for the life of the thread. */
            if (stack->len == 0)
                g_private_replace(&profile_stack_key, NULL);
            return thrown;
        }

        profile_emit(top->begin, g_get_monotonic_time(), "App", name, "");
        g_ptr_array_remove_index(stack, stack->len - 1);
        if (stack->len == 0)
            g_private_replace(&profile_stack_key, NULL);
    }
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

static JSValue js_profile_mark(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Profile.Mark(name) expects a name");

    const char *name = profile_name(ctx, argv[0], "Profile.Mark");
    if (!name)
        return JS_EXCEPTION;

    if (bta_profile_active()) {
        int64_t now = g_get_monotonic_time();
        profile_emit(now, now, "App", name, "");
    }

    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

/*
 * The members, and what each is for, in the shape the extractor and the
 * documentation read: the comment above the entry, its signature on the first
 * line and its description after.
 */
static const JSCFunctionListEntry profile_props[] = {
    /* Active -> boolean
     *   whether the marks are going anywhere: true while this run is under
     *   Sysprof or was started with `--profile`. False in an ordinary run,
     *   where `Begin`/`End`/`Mark` do nothing at all
     */
    JS_CGETSET_DEF("Active", js_profile_active, NULL),
    /* Begin(name)
     *   opens a span on the timeline. `End(name)` closes it and the pair
     *   becomes one mark of the whole stretch — what an application uses
     *   around its own work (loading, computing, laying out), since a sampled
     *   profile cannot say which of its functions was running. Inert when
     *   `Active` is false
     */
    JS_CFUNC_DEF("Begin", 1, js_profile_begin),
    /* End(name)
     *   closes the innermost `Begin`, which has to be the same name. A `name`
     *   that does not match is refused naming both, since a span closed in the
     *   wrong order would put one name's time on another's. Inert when
     *   `Active` is false
     */
    JS_CFUNC_DEF("End",   1, js_profile_end),
    /* Mark(name)
     *   one instant on the timeline with no duration — a point in the program
     *   rather than a stretch. Inert when `Active` is false
     */
    JS_CFUNC_DEF("Mark",  1, js_profile_mark),
};

void bta_profile_init(JSContext *ctx, JSValue global)
{
    JSValue profile = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, profile, profile_props,
                               G_N_ELEMENTS(profile_props));
    JS_SetPropertyStr(ctx, global, "Profile", profile);
}
