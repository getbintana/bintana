/*
 * Privilege: a helper project run with the operating system's consent.
 *
 * **The application never elevates itself.**  What a privileged task is here is
 * a separate `main` project -- no window, no GTK -- that the runtime starts
 * through the platform's launcher: `pkexec` on Linux, where polkit's agent asks
 * for the password, and the `--elevate` mode on Windows, which calls
 * `ShellExecuteEx("runas")` and lets UAC ask.  The helper prints its result and
 * exits; the job object `Privilege.Run` answers is `Exec`'s, so the output,
 * the timeout, `Stop` and `Kill` are the ones the language already has.
 *
 * **The password is never the runtime's.**  Neither launcher exposes it, and
 * nothing here reads it.  `Privilege.Invoker` is the one fact the helper needs
 * that the OS does not hand it directly: on Linux `pkexec` runs the helper as
 * root with `HOME=/root`, so the invoking user comes from `PKEXEC_UID`.
 *
 * **The helper must be declared.**  `project.btp`'s `"privileged"` names the
 * helper projects; `Run` accepts nothing outside that list and nothing outside
 * the application's own directory.  This is a guard against a typo, not a
 * sandbox: the application is trusted, and the consent dialog is the boundary.
 */
#include "bta.h"

#include <stdio.h>
#include <string.h>

#ifdef G_OS_WIN32
#include <windows.h>
#include <glib/gstdio.h>
#else
#include <unistd.h>
#include <pwd.h>
#include <sys/types.h>
#endif

static bool privilege_same_path(const char *a, const char *b)
{
#ifdef G_OS_WIN32
    return !g_ascii_strcasecmp(a, b);
#else
    return !strcmp(a, b);
#endif
}

bool bta_privilege_elevated(void)
{
#ifdef G_OS_WIN32
    HANDLE token = NULL;
    TOKEN_ELEVATION elevation;
    DWORD  size = 0;
    bool   yes  = false;

    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        if (GetTokenInformation(token, TokenElevation, &elevation,
                               sizeof elevation, &size))
            yes = elevation.TokenIsElevated != 0;
        CloseHandle(token);
    }
    return yes;
#else
    return geteuid() == 0;
#endif
}

bool bta_privilege_can_elevate(void)
{
    if (bta_privilege_elevated())
        return true;

#ifdef G_OS_WIN32
    /* The console launcher beside this executable is what ShellExecuteEx
     * starts; the installed tree always has it. */
    return true;
#else
    /* A sandboxed application has no way to ask: the portal, not pkexec, is
     * the road there. */
    if (g_file_test("/.flatpak-info", G_FILE_TEST_EXISTS))
        return false;

    char *pkexec = g_find_program_in_path("pkexec");
    bool  yes    = pkexec != NULL;

    g_free(pkexec);
    return yes;
#endif
}

static bool privilege_declared(BtaApp *app, const char *path)
{
    for (guint i = 0; app && app->privileged && i < app->privileged->len; i++)
        if (privilege_same_path(app->privileged->pdata[i], path))
            return true;
    return false;
}

/*
 * A helper is a project with a `main`: a `startup` one would open a window as
 * root, which is the thing this API exists not to do.  The manifest is parsed
 * here, before the launcher is reached, so an ordinary application gets the
 * refusal at the call and not in an elevated process.
 */
static bool privilege_has_main(JSContext *ctx, const char *dir, char **why)
{
    char  *path = g_build_filename(dir, "project.btp", NULL);
    size_t len  = 0;
    char  *src  = bta_read_file(path, &len);
    bool   ok   = false;

    if (!src) {
        *why = g_strdup_printf("cannot read %s", path);
        g_free(path);
        return false;
    }

    JSValue cfg = JS_ParseJSON(ctx, src, len, path);

    g_free(src);
    if (JS_IsException(cfg)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        *why = g_strdup_printf("%s is not valid JSON", path);
    } else {
        JSValue main = JS_GetPropertyStr(ctx, cfg, "main");

        if (JS_IsString(main)) {
            const char *s = JS_ToCString(ctx, main);

            if (s) {
                ok = *s;
                JS_FreeCString(ctx, s);
            } else {
                JS_FreeValue(ctx, JS_GetException(ctx));
            }
        }
        JS_FreeValue(ctx, main);
        JS_FreeValue(ctx, cfg);
        if (!ok)
            *why = g_strdup_printf("%s declares no \"main\": a privileged "
                                   "helper is a console project and has no "
                                   "window", path);
    }

    g_free(path);
    return ok;
}

/* The console runtime to start.  On Windows `bintanaw.exe` is a copy of it
 * with the console subsystem cleared, and a helper launched by UAC has no
 * console for `print`; the sibling `bintana.exe` is the launcher that can
 * capture and forward the helper's output. */
static char *privilege_console_exe(void)
{
    char *exe = bta_exe_path();

#ifdef G_OS_WIN32
    char *base = g_path_get_basename(exe);

    if (!g_ascii_strcasecmp(base, "bintanaw.exe")) {
        char *dir = g_path_get_dirname(exe);
        char *alt = g_build_filename(dir, "bintana.exe", NULL);

        g_free(dir);
        g_free(base);
        if (g_file_test(alt, G_FILE_TEST_IS_EXECUTABLE)) {
            g_free(exe);
            return alt;
        }
        g_free(alt);
        return exe;
    }
    g_free(base);
#else
    /* A helper is a `main`, and a `main` is the console core's: the graphical
     * host can run one, but then a process running as root has GTK mapped
     * for nothing. The core sits beside `bintana-gui` wherever both are
     * installed or built; without it the graphical host still runs it. */
    char *base = g_path_get_basename(exe);

    if (!strcmp(base, "bintana-gui")) {
        char *dir  = g_path_get_dirname(exe);
        char *core = g_build_filename(dir, "bintana", NULL);

        g_free(dir);
        if (g_file_test(core, G_FILE_TEST_IS_EXECUTABLE)) {
            g_free(base);
            g_free(exe);
            return core;
        }
        g_free(core);
    }
    g_free(base);
#endif
    return exe;
}

/*
 * The argv the platform launcher takes.  `--privileged` is the child's own
 * mode; `--elevate` is the unelevated launcher that calls ShellExecuteEx and
 * forwards the helper's output.  Once this process is already elevated there
 * is nobody to ask, so the helper runs directly.
 */
static GPtrArray *privilege_argv(JSContext *ctx, const char *helper,
                                 JSValueConst args, const char *who)
{
    GPtrArray *out = g_ptr_array_new_with_free_func(g_free);
    char      *exe = privilege_console_exe();

    if (bta_privilege_elevated()) {
        g_ptr_array_add(out, g_strdup(exe));
        g_ptr_array_add(out, g_strdup("--privileged"));
    } else {
#ifdef G_OS_WIN32
        g_ptr_array_add(out, g_strdup(exe));
        g_ptr_array_add(out, g_strdup("--elevate"));
#else
        char *pkexec = g_find_program_in_path("pkexec");

        if (!pkexec) {
            g_free(exe);
            g_ptr_array_unref(out);
            JS_ThrowPlainError(ctx, "%s: this system has no pkexec to ask "
                                    "with", who);
            return NULL;
        }
        g_ptr_array_add(out, pkexec);
        g_ptr_array_add(out, g_strdup(exe));
        g_ptr_array_add(out, g_strdup("--privileged"));
#endif
    }
    g_free(exe);
    g_ptr_array_add(out, g_strdup(helper));

    if (!JS_IsUndefined(args) && !JS_IsNull(args)) {
        if (!JS_IsArray(args)) {
            g_ptr_array_unref(out);
            JS_ThrowTypeError(ctx, "%s: args must be an array of strings", who);
            return NULL;
        }
        JSValue lenv = JS_GetPropertyStr(ctx, args, "length");
        uint32_t n   = 0;

        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);
        for (uint32_t i = 0; i < n; i++) {
            JSValue     v = JS_GetPropertyUint32(ctx, args, i);
            const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;

            if (!s) {
                JS_FreeValue(ctx, v);
                g_ptr_array_unref(out);
                JS_ThrowTypeError(ctx, "%s: args[%u] is not a string", who, i);
                return NULL;
            }
            g_ptr_array_add(out, g_strdup(s));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, v);
        }
    }
    return out;
}

/* Call the `Exec` the runtime installed, so the job, the pipes and the
 * process-group lifetime stay in one place. */
static JSValue privilege_exec(JSContext *ctx, bool wait,
                              int argc, JSValueConst *argv)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue exec   = JS_GetPropertyStr(ctx, global, "Exec");
    JSValue fn;
    JSValue r;

    if (wait) {
        fn = JS_IsObject(exec) ? JS_GetPropertyStr(ctx, exec, "Wait")
                               : JS_UNDEFINED;
        JS_FreeValue(ctx, exec);
    } else {
        fn = JS_DupValue(ctx, exec);
        JS_FreeValue(ctx, exec);
    }
    if (JS_IsFunction(ctx, fn))
        r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
    else
        r = JS_ThrowTypeError(ctx, "Privilege: this runtime has no Exec%s",
                              wait ? ".Wait" : "");

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    return r;
}

static JSValue privilege_launch(JSContext *ctx, int argc, JSValueConst *argv,
                                bool wait)
{
    const char *who = wait ? "Privilege.Wait" : "Privilege.Run";
    BtaApp     *app = bta_current_app();

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "%s(helper, [args], [options]): a helper "
                                      "project is required", who);
    if (!app)
        return JS_ThrowTypeError(ctx, "%s: there is no application", who);

    const char *given = bta_file_path(ctx, argv[0], who);

    if (!given)
        return JS_EXCEPTION;

    char *helper = g_canonicalize_filename(given, app->dir);

    JS_FreeCString(ctx, given);

    if (!bta_path_inside(helper, app->dir)) {
        JSValue e = bta_throw_text(ctx, "%s: '%s' is not a directory inside "
                                        "the application", who, helper);

        g_free(helper);
        return e;
    }
    if (!privilege_declared(app, helper)) {
        JSValue e = bta_throw_text(ctx, "%s: '%s' is not one of project.btp's "
                                        "\"privileged\" helpers", who, helper);

        g_free(helper);
        return e;
    }

    char *why = NULL;

    if (!privilege_has_main(ctx, helper, &why)) {
        JSValue e = bta_throw_text(ctx, "%s: %s", who, why);

        g_free(why);
        g_free(helper);
        return e;
    }
    if (!bta_privilege_can_elevate() && !bta_privilege_elevated()) {
        JSValue e = JS_ThrowPlainError(ctx, "%s: this system has no way to ask "
                                            "for permission", who);

        g_free(helper);
        return e;
    }

    GPtrArray *child = privilege_argv(ctx, helper,
                                      argc > 1 ? argv[1] : JS_UNDEFINED, who);

    g_free(helper);
    if (!child)
        return JS_EXCEPTION;

    JSValue arr = JS_NewArray(ctx);

    if (JS_IsException(arr)) {
        g_ptr_array_unref(child);
        return arr;
    }
    for (guint i = 0; i < child->len; i++)
        JS_SetPropertyUint32(ctx, arr, i,
                             JS_NewString(ctx, child->pdata[i]));
    g_ptr_array_unref(child);

    JSValue call[4];
    int     n = 0;

    call[n++] = arr;
    if (wait) {
        call[n] = argc > 2 ? JS_DupValue(ctx, argv[2]) : JS_UNDEFINED;
        n++;
    } else {
        call[n] = argc > 2 ? JS_DupValue(ctx, argv[2]) : JS_UNDEFINED;
        n++;
        call[n] = argc > 3 ? JS_DupValue(ctx, argv[3]) : JS_UNDEFINED;
        n++;
        call[n] = argc > 4 ? JS_DupValue(ctx, argv[4]) : JS_UNDEFINED;
        n++;
    }

    JSValue r = privilege_exec(ctx, wait, n, call);

    for (int i = 0; i < n; i++)
        JS_FreeValue(ctx, call[i]);
    return r;
}

static JSValue js_privilege_run(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    (void)this_val;
    return privilege_launch(ctx, argc, argv, false);
}

static JSValue js_privilege_wait(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    (void)this_val;
    return privilege_launch(ctx, argc, argv, true);
}

static JSValue js_privilege_worker(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowTypeError(ctx, "Privilege: a Task cannot ask for "
                                  "permission; run the helper from the main "
                                  "thread");
}

static JSValue js_privilege_get_elevated(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return JS_NewBool(ctx, bta_privilege_elevated());
}

static JSValue js_privilege_get_can(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return JS_NewBool(ctx, bta_privilege_can_elevate());
}

static JSValue js_privilege_get_invoker(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;

    const char *name = "";
    const char *home = "";
    char       *id   = NULL;

    /* `pkexec` and `sudo` keep the invoking uid in the environment and run the
     * helper as root.  In the parent there is no variable and the current uid
     * is the answer. */
#ifdef G_OS_WIN32
    name = g_get_user_name();
    home = g_get_home_dir();
    id   = g_strdup(name && *name ? name : "");
#else
    uid_t uid = getuid();
    const char *env = g_getenv("PKEXEC_UID");

    if (!env || !*env)
        env = g_getenv("SUDO_UID");
    if (env && *env)
        uid = (uid_t)g_ascii_strtoull(env, NULL, 10);

    struct passwd  pw;
    struct passwd *found = NULL;
    char           buf[4096];

    if (getpwuid_r(uid, &pw, buf, sizeof buf, &found) == 0 && found) {
        name = found->pw_name ? found->pw_name : "";
        home = found->pw_dir ? found->pw_dir : "";
    } else {
        name = g_get_user_name();
        home = g_get_home_dir();
    }
    id = g_strdup_printf("%lu", (unsigned long)uid);
#endif

    JSValue out = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, out, "Id", JS_NewString(ctx, id ? id : ""));
    JS_SetPropertyStr(ctx, out, "Name", JS_NewString(ctx, name ? name : ""));
    JS_SetPropertyStr(ctx, out, "Home", JS_NewString(ctx, home ? home : ""));
    g_free(id);
    return out;
}

static const JSCFunctionListEntry privilege_props[] = {
    /* Elevated
     *   whether this process already has root/administrator rights: true in a
     *   helper, false in the application that asked for one
     */
    JS_CGETSET_DEF("Elevated", js_privilege_get_elevated, NULL),
    /* CanElevate
     *   whether the OS can ask: `pkexec` on Linux, UAC on Windows, and false in
     *   a sandbox or a Task.  `Run` still works when `Elevated` is true, since
     *   there is nobody left to ask
     */
    JS_CGETSET_DEF("CanElevate", js_privilege_get_can, NULL),
    /* Invoker
     *   `{ Id, Name, Home }` of the user who asked for the helper.  Inside a
     *   helper this is the person at the desktop, not `root`: on Linux it comes
     *   from `PKEXEC_UID`/`SUDO_UID`, and on Windows it is the same user with
     *   an elevated token
     */
    JS_CGETSET_DEF("Invoker", js_privilege_get_invoker, NULL),
    /* Run(helper, [args], [options], [onLine], [onExit]) -> Exec
     *   runs a helper project declared in `project.btp`'s `"privileged"` list,
     *   with the platform's consent dialog.  `helper` is a project directory
     *   with a `main`; `args` are its `Application.Arguments`; `options` are
     *   `Exec`'s (`Timeout`, `Env`, `Dir`).  Answers the same job handle `Exec`
     *   does, so `Stop`/`Kill` and the callbacks are the ones the language
     *   already has.  On Windows the helper's output arrives when it exits,
     *   because the unelevated launcher forwards the file UAC let it write
     */
    JS_CFUNC_DEF("Run", 5, js_privilege_run),
    /* Wait(helper, [args], [options]) -> { ExitCode, Output }
     *   the same, run to the end.  It blocks the main loop: use `Run` from a
     *   window, and `Wait` from a console project or a place that can wait
     */
    JS_CFUNC_DEF("Wait", 3, js_privilege_wait),
};

void bta_privilege_init(JSContext *ctx, JSValueConst global, bool worker)
{
    JSValue privilege = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, privilege, privilege_props,
                               G_N_ELEMENTS(privilege_props));
    if (worker) {
        /* Facts are still facts; asking is the main thread's, because a
         * worker has no display for the OS dialog and no main loop for its
         * answer. */
        JS_SetPropertyStr(ctx, privilege, "CanElevate", JS_FALSE);
        JS_SetPropertyStr(ctx, privilege, "Run",
                          JS_NewCFunction(ctx, js_privilege_worker, "Run", 5));
        JS_SetPropertyStr(ctx, privilege, "Wait",
                          JS_NewCFunction(ctx, js_privilege_worker, "Wait", 3));
    }
    JS_SetPropertyStr(ctx, global, "Privilege", privilege);
}

#ifdef G_OS_WIN32
/* Windows argument quoting, as `CommandLineToArgvW` reads it back. */
static void privilege_quote(GString *out, const char *arg)
{
    size_t slashes = 0;

    g_string_append_c(out, '"');
    for (const char *p = arg; *p; p++) {
        if (*p == '\\') {
            slashes++;
            continue;
        }
        if (*p == '"') {
            for (size_t i = 0; i < slashes * 2 + 1; i++)
                g_string_append_c(out, '\\');
            g_string_append_c(out, '"');
            slashes = 0;
            continue;
        }
        for (size_t i = 0; i < slashes; i++)
            g_string_append_c(out, '\\');
        g_string_append_c(out, *p);
        slashes = 0;
    }
    for (size_t i = 0; i < slashes * 2; i++)
        g_string_append_c(out, '\\');
    g_string_append_c(out, '"');
}

int bta_privilege_elevate(int argc, char **argv)
{
    if (argc < 3) {
        fputs("bintana: --elevate needs a helper project\n", stderr);
        return 2;
    }

    GError *err = NULL;
    char   *out = NULL;
    int     fd  = g_file_open_tmp("bintana-priv-XXXXXX", &out, &err);

    if (fd < 0) {
        fputs("bintana: cannot make a temporary file\n", stderr);
        g_clear_error(&err);
        return 1;
    }
    /* The descriptor is kept open until the helper is done: while it is, the
     * path cannot be deleted and replaced by a junction to a system file that
     * the elevated helper would then truncate.  `_open` shares read/write, so
     * the helper can open the same file. */

    char *launcher = privilege_console_exe();
    char *dir      = g_path_get_dirname(launcher);
    char *helper   = g_build_filename(dir, "bintanaw.exe", NULL);

    if (!g_file_test(helper, G_FILE_TEST_IS_EXECUTABLE)) {
        g_free(helper);
        helper = g_strdup(launcher);
    }
    g_free(dir);

    GString *params = g_string_new("--privileged --out ");

    privilege_quote(params, out);
    g_string_append_c(params, ' ');
    privilege_quote(params, argv[2]);
    for (int i = 3; i < argc; i++) {
        g_string_append_c(params, ' ');
        privilege_quote(params, argv[i]);
    }

    wchar_t *helper_w = g_utf8_to_utf16(helper, -1, NULL, NULL, NULL);
    wchar_t *params_w = g_utf8_to_utf16(params->str, -1, NULL, NULL, NULL);
    bool     ok        = helper_w && params_w;

    if (ok) {
        SHELLEXECUTEINFOW sei = { 0 };

        sei.cbSize       = sizeof sei;
        sei.fMask        = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI;
        sei.lpVerb       = L"runas";
        sei.lpFile       = helper_w;
        sei.lpParameters = params_w;
        sei.nShow        = SW_HIDE;

        if (!ShellExecuteExW(&sei)) {
            DWORD code = GetLastError();

            if (code == ERROR_CANCELLED)
                fputs("bintana: the permission request was cancelled\n", stderr);
            else
                fprintf(stderr, "bintana: cannot ask for permission (Windows "
                                "error %lu)\n", (unsigned long)code);
            ok = false;
        } else if (!sei.hProcess) {
            fputs("bintana: the elevated helper did not start\n", stderr);
            ok = false;
        } else {
            DWORD code = 1;

            WaitForSingleObject(sei.hProcess, INFINITE);
            GetExitCodeProcess(sei.hProcess, &code);
            CloseHandle(sei.hProcess);

            gsize   len  = 0;
            char   *text = NULL;

            if (g_file_get_contents(out, &text, &len, NULL)) {
                if (len)
                    fwrite(text, 1, len, stdout);
                g_free(text);
            }
            fflush(stdout);
            int rc = (int)code;

            g_free(helper_w);
            g_free(params_w);
            g_free(helper);
            g_free(launcher);
            g_string_free(params, TRUE);
            g_close(fd, NULL);
            g_unlink(out);
            g_free(out);
            return rc;
        }
    }

    g_free(helper_w);
    g_free(params_w);
    g_free(helper);
    g_free(launcher);
    g_string_free(params, TRUE);
    g_close(fd, NULL);
    g_unlink(out);
    g_free(out);
    return 1;
}
#endif /* G_OS_WIN32 */
