/*
 * `Message`, which both hosts install.
 *
 * The catalogue lookup and the `{0}` holes are the language's half and live
 * here once; how a message is *shown* is the host's (`bta_message_show`): the
 * graphical host raises an alert when it has a display, and every host prints
 * to stderr when it has none -- which is the whole of what the console host
 * ever does. A `main` that reports with `Message.Error` says the same words
 * under `bintana` and under `bintana-gui`.
 */
#include "bta.h"

#include <stdio.h>

/*
 * Message.Info / .Warning / .Error -- GTK4 alert dialogs are fire-and-forget,
 * so these show and return rather than blocking like VB's MsgBox.
 *
 * **The first argument is a declared position for prose**, so it goes through
 * the catalogue and takes `{0}`-style arguments of its own:
 *
 *     Message.Info("Saved");
 *     Message.Error("Cannot open {0}: {1}", path, e.message);
 *
 * Which is why a message needs no `Locale.Text` around it.  The idea is the same
 * one `BtaClass.texts` carries for properties -- *this position holds text a
 * person reads* -- and a position is a position whether it is a property or an
 * argument.  Interpolating here rather than at the call site is what keeps the
 * msgid a literal an extractor can find; a template literal would have arrived
 * already filled in, and no catalogue could ever match it.
 *
 * The residual risk, stated rather than hidden: a string is a string at
 * runtime, so `Message.Error(e.message)` is looked up too, and would be
 * translated if an exception's text happened to equal a UI label exactly.  That
 * is a far smaller population than the one flowing through a Label's Text --
 * which is why a *setter* doing this was refused and an argument doing it was
 * not.
 */
static JSValue js_message(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv, int magic)
{
    char *text = NULL;

    (void)this_val;
    if (argc > 0) {
        const char *msgid = JS_ToCString(ctx, argv[0]);
        if (!msgid)
            return JS_EXCEPTION;

        const char *found = bta_locale_lookup(NULL, msgid);
        text = bta_locale_format(ctx, found ? found : msgid,
                                 argc - 1, argv + 1);
        JS_FreeCString(ctx, msgid);
        if (!text)
            return JS_EXCEPTION;       /* an argument could not become text */
    }
    if (!bta_message_show(magic, text ? text : ""))
        fprintf(stderr, "message: %s\n", text ? text : "");
    g_free(text);
    return JS_UNDEFINED;
}

void bta_message_init(JSContext *ctx, JSValueConst global)
{
    /* One line each and not a loop over the names, because the signature
     * comment above a line is what `Widget.Members` answers with -- a loop
     * leaves nowhere to write one. The magic is the index `js_message` reads. */
    JSValue message = JS_NewObject(ctx);
    /* Info(text, ...args)
     *   something happened. **It shows and returns**: it does not block and
     *   there is no answer. The text goes through the catalogue with `{0}`
     *   holes filled from the arguments -- never a template literal -- and
     *   with no display it prints to stderr
     */
    JS_SetPropertyStr(ctx, message, "Info",
                      JS_NewCFunctionMagic(ctx, js_message, "Info", 1,
                                           JS_CFUNC_generic_magic, 0));
    /* Warning(text, ...args)
     *   something is not right; the same as `Info` in every other respect
     */
    JS_SetPropertyStr(ctx, message, "Warning",
                      JS_NewCFunctionMagic(ctx, js_message, "Warning", 1,
                                           JS_CFUNC_generic_magic, 1));
    /* Error(text, ...args)
     *   something failed; the same as `Info` in every other respect
     */
    JS_SetPropertyStr(ctx, message, "Error",
                      JS_NewCFunctionMagic(ctx, js_message, "Error", 1,
                                           JS_CFUNC_generic_magic, 2));
    JS_SetPropertyStr(ctx, global, "Message", message);
}
