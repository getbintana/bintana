/*
 * Lock -- taking turns, by name.
 *
 *     Lock.Hold("accounts", () => {
 *         const book = File.LoadJson(path);
 *         File.SaveJson(path, add(book, row));
 *     });
 *
 * ## What it is for, which is narrower than it looks
 *
 * Not for keeping a file whole: `File.Save` is `g_file_set_contents`, which
 * writes a temporary and renames over the target, so two threads saving one
 * path produce one of the two whole files and never a mixture.  What
 * concurrency costs here is the **lost update** -- read, change, write from
 * two threads, and the first thread's change never happened -- and that is a
 * *sequence*.  Only the program knows which two calls belong together, which
 * is why the name is the program's to choose and why no lock the runtime
 * could put on a call would reach it.
 *
 * ## Why a name and not an object
 *
 * A `Task` runs in a runtime of its own and the two share no JS heap, so no
 * object can cross in a message -- `TCriticalSection`, `QMutex` and .NET's
 * `lock (obj)` are all shared instances and all assume a common heap.  The
 * tradition that applies is the other one: Win32's
 * `CreateMutex(NULL, FALSE, "Global\\Accounts")` and POSIX's
 * `sem_open("/accounts")`.  Only text crosses, and the table below is
 * process-global, which is exactly the scope the two runtimes share.
 *
 * It pays twice.  A name is the indirection that lets what is behind it change
 * without a call site moving -- a timed wait means swapping `GRecMutex` for a
 * `GMutex` and a `GCond`, and no program notices.  And a name is what a stuck
 * program can be asked about: *waiting on "accounts"* is an answer where an
 * anonymous mutex can only say *waiting*.
 *
 * ## Why a callback, which is not a matter of taste here
 *
 * `Enter`/`Leave` would be a correctness bug in this runtime.  A forced
 * `Stop()` on a task ends it at an arbitrary opcode (see bta_task.c), so the
 * `Leave` would never run, the lock would stay held for the life of the
 * process, and every other thread asking for that name would block until
 * teardown cast it adrift.  Here the unlock is in C after the `JS_Call`, so it
 * runs whether the function returned, threw, or was interrupted.
 *
 * ## Why it answers nothing
 *
 * `lock` in .NET, `synchronized` in Java, `with` in Python, `QMutexLocker`,
 * Delphi's `try`/`finally` and Go's `defer` are all **statements**: a critical
 * section is a block and not an expression.  That this one is spelled as a
 * function is an accident of having no block syntax, not an invitation -- and
 * leaving the return value unspoken is what lets a future `Lock.Try(name, fn)`
 * answer a plain boolean without inventing a sentinel for *it did not run*.
 *
 * ## Recursive
 *
 * `lock` is reentrant in .NET because `Monitor` is, `synchronized` is in Java,
 * and Delphi's `TCriticalSection` is because Win32's `CRITICAL_SECTION` is.
 * Qt and pthreads are not by default and both ship the variant, because people
 * deadlock.  In a language where a function calls a function that saves
 * something, a nested `Hold` of one name would otherwise be an instant and
 * silent deadlock -- and silent is the thing this codebase spends its comments
 * avoiding.
 */
#include "bta.h"

/*
 * The table, and the one mutex that guards the table itself.
 *
 * Process-global on purpose: a worker runtime runs `bta_lock_init` of its own
 * and reaches these same locks, which is the whole point of naming them.
 * Created on demand and **never destroyed** -- there are as many as there are
 * names in the program, which is a handful, and freeing one while a thread
 * waits on it is the bug not worth writing.  The keys are leaked with them.
 */
static GMutex      lock_table;
static GHashTable *locks;

static GRecMutex *lock_named(const char *name)
{
    GRecMutex *m;

    g_mutex_lock(&lock_table);
    if (!locks)
        locks = g_hash_table_new(g_str_hash, g_str_equal);
    m = g_hash_table_lookup(locks, name);
    if (!m) {
        m = g_new0(GRecMutex, 1);
        g_rec_mutex_init(m);
        g_hash_table_insert(locks, g_strdup(name), m);
    }
    g_mutex_unlock(&lock_table);
    return m;
}

/*
 * `Lock.Hold(name, fn)` -- run `fn` with the named lock held.
 *
 * On the main thread this blocks the window exactly as `Exec.Wait` does, and
 * is honest for the same reason: no nested loop runs, so nobody can close the
 * form the caller is standing in.  The rule that goes with it is documented
 * rather than enforced -- a `Hold` on the main thread is short, or it does not
 * belong there.
 */
static JSValue lock_hold(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    const char *name;
    GRecMutex  *m;
    JSValue     r;

    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Lock.Hold(name, fn): the name is text, "
                                      "and it is what two threads share");
    if (argc < 2 || !JS_IsFunction(ctx, argv[1]))
        return JS_ThrowTypeError(ctx, "Lock.Hold(name, fn) needs the function "
                                      "to run while it holds");

    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    if (!*name) {
        JS_FreeCString(ctx, name);
        return JS_ThrowTypeError(ctx, "Lock.Hold: \"\" is not a name, and a "
                                      "lock nobody can name twice is no lock");
    }

    m = lock_named(name);
    JS_FreeCString(ctx, name);

    /* The three lines this whole file exists for.  Nothing between the lock
     * and the unlock may return early. */
    g_rec_mutex_lock(m);
    r = JS_Call(ctx, argv[1], JS_UNDEFINED, 0, NULL);
    g_rec_mutex_unlock(m);

    if (JS_IsException(r))
        return r;
    JS_FreeValue(ctx, r);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry lock_props[] = {
    JS_CFUNC_DEF("Hold", 2, lock_hold),
};

void bta_lock_init(JSContext *ctx, JSValue global)
{
    JSValue lock = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, lock, lock_props, G_N_ELEMENTS(lock_props));
    JS_SetPropertyStr(ctx, global, "Lock", lock);
}
