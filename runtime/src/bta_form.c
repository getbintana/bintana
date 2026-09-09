/*
 * The .form loader.
 *
 * A .form file is JSON describing the widget tree.  Properties are applied by
 * ordinary JS assignment, so the file format needs no knowledge of any
 * particular control -- whatever a widget exposes as a property is settable
 * from the designer, and the designer can read it back the same way.
 */
#include "bta.h"

#include <stdio.h>
#include <string.h>

static int apply_properties(JSContext *ctx, JSValueConst target,
                            JSValueConst props, const char *where);

static int build_children(JSContext *ctx, JSValueConst form_obj,
                          BtaWidget *parent, JSValueConst children);

/* ---------------------------------------------------------------- helpers */

static char *spec_string(JSContext *ctx, JSValueConst spec, const char *key)
{
    JSValue v = JS_GetPropertyStr(ctx, spec, key);
    char   *out = NULL;

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        out = g_strdup(s);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, v);
    return out;
}

static bool is_identifier(const char *s)
{
    if (!s || !*s || (!g_ascii_isalpha(*s) && *s != '_' && *s != '$'))
        return false;
    for (const char *p = s; *p; p++)
        if (!g_ascii_isalnum(*p) && *p != '_' && *p != '$')
            return false;
    return true;
}

/*
 * A string the catalogue has something to say about, or JS_UNDEFINED when it
 * does not.  Arrays go through element by element, which is what `Items` and
 * `Tabs` are: a list of strings a person reads.
 *
 * Only the properties the class declares as prose (BtaClass.texts) get here, so
 * a `Style` that happens to match an entry, or the source file in a
 * SourceEditor's `Text`, is never looked up.
 */
/*
 * `field` is the member of an object that holds prose, for a declaration like
 * `TableView`'s `"Columns.Text"`; NULL when the value is prose all the way
 * down. Nothing else in an object is looked at -- a column's `Alignment` is the
 * word `Right`, and a catalogue that reached it would translate a keyword.
 */
static JSValue translate_value(JSContext *ctx, JSValueConst v, const char *field)
{
    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        if (!s)
            return JS_UNDEFINED;

        const char *found = bta_locale_lookup(NULL, s);
        JSValue     out   = found ? JS_NewString(ctx, found) : JS_UNDEFINED;

        JS_FreeCString(ctx, s);
        return out;
    }

    /*
     * An object, and a member named: a *copy* with that member translated. A
     * copy because the serialiser reads the current value back, so mutating
     * what the file handed us would write the translation into the .form on the
     * next save -- the trap that already cost this codebase a form saved in
     * Spanish with its msgids gone.
     */
    if (field && JS_IsObject(v) && !JS_IsArray(v)) {
        JSValue     inner = JS_GetPropertyStr(ctx, v, field);
        JSValue     t     = translate_value(ctx, inner, NULL);

        if (JS_IsUndefined(t)) {
            JS_FreeValue(ctx, inner);
            return JS_UNDEFINED;
        }
        JS_FreeValue(ctx, inner);

        JSPropertyEnum *tab = NULL;
        uint32_t        len = 0;
        JSValue         out = JS_NewObject(ctx);

        if (JS_GetOwnPropertyNames(ctx, &tab, &len, v,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
            for (uint32_t i = 0; i < len; i++)
                JS_SetProperty(ctx, out, JS_DupAtom(ctx, tab[i].atom),
                               JS_GetProperty(ctx, v, tab[i].atom));
            JS_FreePropertyEnum(ctx, tab, len);
        }
        JS_SetPropertyStr(ctx, out, field, t);
        return out;
    }

    if (!JS_IsArray(v))
        return JS_UNDEFINED;

    JSValue  lenv = JS_GetPropertyStr(ctx, v, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    JSValue out   = JS_NewArray(ctx);
    bool    any   = false;

    for (uint32_t i = 0; i < n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, v, i);
        JSValue t    = translate_value(ctx, item, field);

        if (JS_IsUndefined(t)) {
            JS_SetPropertyUint32(ctx, out, i, item);
        } else {
            any = true;
            JS_SetPropertyUint32(ctx, out, i, t);
            JS_FreeValue(ctx, item);
        }
    }

    /* A list nothing was translated in stays the list the file wrote, so
     * nothing downstream has to tell a rebuilt array from the original. */
    if (any)
        return out;
    JS_FreeValue(ctx, out);
    return JS_UNDEFINED;
}

/*
 * What the file said, against what was applied.
 *
 * The serialiser reads the *current* value of a property, which is what makes
 * translation dangerous in a way that has bitten this codebase before: a form
 * loaded in Spanish and saved would come back with the Spanish in it, and the
 * original would be gone -- the same shape as writing an allocation down as a
 * size request.  So a substitution leaves a note of both values, and
 * collectProperties in rad.js writes the declared one back **as long as the
 * applied one is still what is there**.  Anything that assigned since -- the
 * property grid, application code -- makes the note stale, and being able to
 * see that is the point of keeping `applied` rather than only the original.
 */
static void record_declared(JSContext *ctx, JSValueConst target, JSAtom key,
                            JSValueConst declared, JSValueConst applied)
{
    JSValue bag = JS_GetPropertyStr(ctx, target, "__declared");

    if (!JS_IsObject(bag)) {
        JS_FreeValue(ctx, bag);
        bag = JS_NewObject(ctx);

        /*
         * Defined and not assigned, so the note is **not enumerable**: a
         * `JS_SetPropertyStr` makes it an own enumerable property, and then
         * `Dictionary.Keys(control)` and `for...in` report `__declared` beside
         * whatever the loader assigned by name -- bookkeeping showing up as
         * data.  The same reason a form's `__menus` and a container's
         * `__children` are defined rather than set.  Writable and configurable,
         * because rad.js's SetDesign deletes the note again.
         */
        JS_DefinePropertyValueStr(ctx, target, "__declared",
                                  JS_DupValue(ctx, bag),
                                  JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE);
    }

    JSValue pair = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, pair, 0, JS_DupValue(ctx, declared));
    JS_SetPropertyUint32(ctx, pair, 1, JS_DupValue(ctx, applied));

    /* JS_SetProperty consumes the value but not the atom, which is the
     * caller's -- it frees the whole table when the walk is done. */
    JS_SetProperty(ctx, bag, key, pair);
    JS_FreeValue(ctx, bag);
}

/*
 * The same note by name rather than by atom, for whoever is not the loader.
 *
 * `bta_action_dress` is the caller: a control that takes its label from a
 * command has to serialise as having declared **nothing**, or the command's
 * label is baked into all four copies on the first save and the command stops
 * being the one place it lives.
 */
void bta_note_declared(JSContext *ctx, JSValueConst target, const char *key,
                       JSValueConst declared, JSValueConst applied)
{
    JSAtom atom = JS_NewAtom(ctx, key);

    record_declared(ctx, target, atom, declared, applied);
    JS_FreeAtom(ctx, atom);
}

static int apply_properties(JSContext *ctx, JSValueConst target,
                            JSValueConst props, const char *where)
{
    if (!JS_IsObject(props))
        return 0;

    JSPropertyEnum *tab = NULL;
    uint32_t        len = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &len, props,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return -1;

    /*
     * **`Action` is applied last**, whatever order the file lists it in.
     *
     * A command lends its label and its icon to a control that declared
     * neither, so binding before the control's own `Icon` had been set made a
     * 34-pixel toolbar button take the command's *words* as well -- and it grew
     * until it pushed the tab strip under half the window. Found exactly that
     * way, by the IDE's own layout test, the first time three of its buttons
     * were converted: the serialiser writes properties sorted, and `Action`
     * sorts before `Icon`.
     *
     * The mirror of `Arrangement`, which is applied *first* for the same reason
     * turned around: a container refuses to be re-arranged once it has
     * children. Both are properties whose meaning depends on what has been set
     * already, and the loader is where that is settled rather than in every
     * file.
     */
    int rc = 0;
    for (uint32_t pass = 0; pass < 2 && rc == 0; pass++)
    for (uint32_t i = 0; i < len; i++) {
        const char *nm    = JS_AtomToCString(ctx, tab[i].atom);
        bool        is_it = nm && !strcmp(nm, "Action");

        JS_FreeCString(ctx, nm);
        if (is_it != (pass == 1))
            continue;

        JSValue v = JS_GetProperty(ctx, props, tab[i].atom);
        if (JS_IsException(v)) {
            rc = -1;
            break;
        }

        /*
         * Prose goes through the catalogue on its way in.  Nothing is written
         * in the file to ask for this -- a `.form` cannot call a function, so
         * the alternative would be no translated forms at all -- and which
         * properties are prose is the class's own declaration.
         */
        JSValue     applied = JS_UNDEFINED;
        const char *k       = JS_AtomToCString(ctx, tab[i].atom);
        char       *field   = NULL;
        bool        is_text = k && bta_widget_text_prop_field(ctx, target, k, &field);

        if (is_text)
            applied = translate_value(ctx, v, field);
        g_free(field);

        bool substituted = !JS_IsUndefined(applied);

        /* JS_SetProperty consumes what it is given, and runs the real setter. */
        if (JS_SetProperty(ctx, target, tab[i].atom,
                           substituted ? JS_DupValue(ctx, applied)
                                       : JS_DupValue(ctx, v)) < 0) {
            fprintf(stderr, "bintana: %s: cannot set property '%s'\n", where,
                    k ? k : "?");
            JS_FreeCString(ctx, k);
            JS_FreeValue(ctx, applied);
            JS_FreeValue(ctx, v);
            rc = -1;
            break;
        }
        /*
         * Every declared piece of prose leaves a note, translated or not.  It
         * is not only the serialiser that needs one: `Declared()` has to be
         * able to answer *what the file said* for a control whose text has
         * since been filled in, which is what `Fill()` re-reads its template
         * from -- and with no note, a second Fill would take the first one's
         * output as the template.
         */
        if (is_text)
            record_declared(ctx, target, tab[i].atom, v,
                            substituted ? applied : v);

        JS_FreeCString(ctx, k);
        JS_FreeValue(ctx, applied);
        JS_FreeValue(ctx, v);
    }

    for (uint32_t i = 0; i < len; i++)
        JS_FreeAtom(ctx, tab[i].atom);
    js_free(ctx, tab);
    return rc;
}

/* ----------------------------------------------------------------- children */

static int build_one(JSContext *ctx, JSValueConst form_obj,
                     BtaWidget *parent, JSValueConst spec)
{
    char *type = spec_string(ctx, spec, "type");
    char *name = spec_string(ctx, spec, "name");
    int   rc   = -1;

    if (!type) {
        JS_ThrowTypeError(ctx, "form: a child is missing its \"type\"");
        goto out;
    }
    if (name && !is_identifier(name)) {
        JS_ThrowTypeError(ctx, "form: '%s' is not a usable control name", name);
        goto out;
    }

    JSValue obj = bta_widget_new(ctx, type);
    if (JS_IsException(obj))
        goto out;

    BtaWidget *w = bta_widget_of(obj);
    if (!w) {
        JS_FreeValue(ctx, obj);
        JS_ThrowInternalError(ctx, "form: '%s' did not produce a widget", type);
        goto out;
    }

    bta_widget_bind(w, form_obj, name);

    /*
     * `strip` puts the control in a Notebook's tab strip instead of making it a
     * page.  A notebook's children *are* its pages, so without a word for it
     * there is no way to declare the one other thing a notebook can hold -- and
     * a strip widget put there from code was lost by the next save.
     */
    char *strip = spec_string(ctx, spec, "strip");
    bool  ok;

    if (strip && *strip) {
        /* Through the public method, so the loader gains no way of its own to
         * put a control there: whatever SetAction does about adoption and
         * lifetimes it does here too. */
        JSValue fn = JS_GetPropertyStr(ctx, parent->self, "SetAction");

        if (!JS_IsFunction(ctx, fn)) {
            JS_ThrowTypeError(ctx,
                "form: \"strip\" needs a container with a tab strip, and %s has none",
                parent->name ? parent->name : "that one");
            ok = false;
        } else {
            JSValue      where   = JS_NewString(ctx, strip);
            JSValueConst args[2] = { obj, where };
            JSValue      r       = JS_Call(ctx, fn, parent->self, 2, args);

            ok = !JS_IsException(r);
            JS_FreeValue(ctx, r);
            JS_FreeValue(ctx, where);
        }
        JS_FreeValue(ctx, fn);
    } else {
        /* Parent it before applying properties, so X/Y reach a live layout. */
        ok = bta_container_attach(ctx, parent, w);
    }
    g_free(strip);

    if (!ok) {
        JS_FreeValue(ctx, obj);
        goto out;
    }

    JSValue props = JS_GetPropertyStr(ctx, spec, "properties");
    int prc = apply_properties(ctx, obj, props, name ? name : type);
    JS_FreeValue(ctx, props);
    if (prc < 0) {
        JS_FreeValue(ctx, obj);
        goto out;
    }

    JSValue kids = JS_GetPropertyStr(ctx, spec, "children");
    int crc = 0;
    if (JS_IsArray(kids)) {
        if (!w->slot) {
            JS_ThrowTypeError(ctx, "form: %s is not a container but has children",
                              type);
            crc = -1;
        } else {
            crc = build_children(ctx, form_obj, w, kids);
        }
    }
    JS_FreeValue(ctx, kids);
    if (crc < 0) {
        JS_FreeValue(ctx, obj);
        goto out;
    }

    /* form.Button1 = <widget>: how handlers reach it, and what keeps it alive. */
    if (name)
        JS_SetPropertyStr(ctx, form_obj, name, obj);
    else
        JS_FreeValue(ctx, obj);

    rc = 0;
out:
    g_free(type);
    g_free(name);
    return rc;
}

static int build_children(JSContext *ctx, JSValueConst form_obj,
                          BtaWidget *parent, JSValueConst children)
{
    JSValue  lenv = JS_GetPropertyStr(ctx, children, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    for (uint32_t i = 0; i < n; i++) {
        JSValue spec = JS_GetPropertyUint32(ctx, children, i);
        int     rc   = JS_IsObject(spec) ? build_one(ctx, form_obj, parent, spec) : 0;
        JS_FreeValue(ctx, spec);
        if (rc < 0)
            return -1;
    }
    return 0;
}

/* ------------------------------------------------------- where a .form lives
 *
 * A project may organise its classes in directories, so <Class>.form is not
 * simply a file in the project root.  The tree is indexed once, by name: a
 * class declaration and a .form node both name a class and neither carries a
 * path, so the name is what there is to look up.
 *
 * Two files with the same name are an error and not a choice -- the classes
 * would collide as well -- but only when one of them is asked for: a project
 * with an unused leftover somewhere still runs.
 */

typedef struct {
    char *path;    /* NULL once more than one file claims this name */
    int   depth;   /* how many directories below the project root it sits */
} FormEntry;

static void form_entry_free(gpointer p)
{
    FormEntry *e = p;
    g_free(e->path);
    g_free(e);
}

/*
 * Takes ownership of `key`; `path` is copied, since one file is indexed under
 * both its bare name and its qualified one and the table frees its values.
 *
 * Nearer the root wins.  A bare class name is the name of a class in no
 * namespace, and a class in no namespace lives at the top -- so a project that
 * has both `Stepper.form` and `Widgets/Stepper.form` still resolves a plain
 * Stepper to the first, and Widgets.Stepper to the second.  Without that,
 * putting one class in a namespace would break the one that was already there.
 *
 * Two files at the same depth is a genuine ambiguity: neither is "the" one.
 */
static void index_add(GHashTable *out, char *key, const char *path, int depth)
{
    FormEntry *have = g_hash_table_lookup(out, key);

    if (!have) {
        FormEntry *e = g_new0(FormEntry, 1);
        e->path  = g_strdup(path);
        e->depth = depth;
        g_hash_table_insert(out, key, e);
        return;
    }
    g_free(key);   /* the table keeps the key it already has */

    if (!have->path)
        return;                        /* already ambiguous; nothing wins */

    if (depth < have->depth) {
        g_free(have->path);
        have->path  = g_strdup(path);
        have->depth = depth;
    } else if (depth == have->depth) {
        g_clear_pointer(&have->path, g_free);
    }
}

/*
 * `prefix` is the namespace the folders walked so far spell out -- "" at the
 * project root, "Widgets" inside Widgets/ -- or NULL once a directory has a
 * name no namespace could have, since nothing below it is qualifiable either.
 */
static void index_forms(GHashTable *out, const char *dir, const char *prefix,
                        int depth)
{
    GDir *d = g_dir_open(dir, 0, NULL);
    if (!d)
        return;

    const char *name;
    while ((name = g_dir_read_name(d))) {
        /* .git, .cache and whatever else a project keeps to itself. */
        if (name[0] == '.')
            continue;

        char *path = g_build_filename(dir, name, NULL);

        if (g_file_test(path, G_FILE_TEST_IS_DIR)) {
            char *deeper = NULL;
            if (prefix && is_identifier(name))
                deeper = *prefix ? g_strdup_printf("%s.%s", prefix, name)
                                 : g_strdup(name);

            index_forms(out, path, deeper, depth + 1);
            g_free(deeper);
            g_free(path);
            continue;
        }
        if (!g_str_has_suffix(name, ".form")) {
            g_free(path);
            continue;
        }

        char *base = g_strndup(name, strlen(name) - strlen(".form"));
        index_add(out, g_strdup(base), path, depth);

        /* Also under the name its folders spell out, which is what a project
         * using namespaces asks for.  A path is unique, so this key cannot
         * collide the way a bare name can. */
        if (prefix && *prefix && is_identifier(base))
            index_add(out, g_strdup_printf("%s.%s", prefix, base), path, depth);

        g_free(base);
        g_free(path);
    }
    g_dir_close(d);
}

/*
 * Qualified name first, then the bare one it ends with.
 *
 * The fallback is what keeps the namespace a property of the *code*: a class
 * that calls itself Widgets.Stepper is still found when its file sits
 * somewhere else, as long as only one folder has a Stepper.  When two do, the
 * bare key is marked ambiguous and saying which one is exactly what qualifying
 * the name is for.
 */
static const FormEntry *index_find(GHashTable *forms, const char *class_name)
{
    const FormEntry *hit = g_hash_table_lookup(forms, class_name);
    if (hit)
        return hit;

    const char *dot = strrchr(class_name, '.');
    return dot ? g_hash_table_lookup(forms, dot + 1) : NULL;
}

/*
 * The file, "" when the name is ambiguous, NULL when there is none.
 *
 * A miss is not believed until the index has been rebuilt: it means either a
 * class built entirely in code -- which is legal -- or a file that appeared
 * since, which is the normal state of affairs while an IDE is writing forms in
 * the same directory it is running from.  Walking a project costs far less than
 * a form that does not load.
 */
static const FormEntry *form_path(BtaApp *app, const char *class_name)
{
    if (!app->forms) {
        app->forms = g_hash_table_new_full(g_str_hash, g_str_equal,
                                           g_free, form_entry_free);
    } else {
        const FormEntry *hit = index_find(app->forms, class_name);
        if (hit)
            return hit;
        g_hash_table_remove_all(app->forms);
    }

    /*
     * **A library's forms are indexed with the project's**, which is what lets a
     * `.form` say `"type": "Chart"` about a class that lives in `lib/charts`.
     * The project goes first, so a project that keeps its own copy of a form
     * shadows the library's rather than being shadowed by it -- the same order
     * the library search itself has.
     */
    index_forms(app->forms, app->dir, "", 0);
    for (guint i = 0; app->libs && i < app->libs->len; i++)
        index_forms(app->forms, g_ptr_array_index(app->libs, i), "", 0);

    return index_find(app->forms, class_name);
}

/* -------------------------------------------------------------------- entry */

int bta_form_build(JSContext *ctx, JSValueConst form_obj, const char *class_name)
{
    BtaApp *app = bta_current_app();
    if (!app)
        return 0;

    const FormEntry *found = form_path(app, class_name);

    /* A form with no .form file is legal: it is simply built in code. */
    if (!found)
        return 0;

    if (!found->path) {
        JS_ThrowInternalError(ctx, "more than one %s.form in the project",
                              class_name);
        return -1;
    }
    char *path = g_strdup(found->path);

    size_t len;
    char  *src = bta_read_file(path, &len);
    if (!src) {
        JS_ThrowInternalError(ctx, "cannot read %s", path);
        g_free(path);
        return -1;
    }

    JSValue root = JS_ParseJSON(ctx, src, len, path);
    g_free(src);
    if (JS_IsException(root)) {
        g_free(path);
        return -1;
    }

    int rc = -1;
    BtaWidget *w = bta_widget_of(form_obj);
    if (!w) {
        JS_ThrowInternalError(ctx, "%s: not a form", class_name);
        goto out;
    }

    JSValue props = JS_GetPropertyStr(ctx, root, "properties");
    rc = apply_properties(ctx, form_obj, props, class_name);
    JS_FreeValue(ctx, props);
    if (rc < 0)
        goto out;

    /* Commands first: a menu item and a control may both name one, and a name
     * that is not there is refused where it is written. */
    JSValue actions = JS_GetPropertyStr(ctx, root, "actions");
    rc = bta_actions_build(ctx, form_obj, w, actions);
    JS_FreeValue(ctx, actions);
    if (rc < 0)
        goto out;

    /* Menus before children: the bar takes its place at the top of the window
     * and the slot keeps whatever room is left. */
    JSValue menus = JS_GetPropertyStr(ctx, root, "menus");
    rc = bta_menus_build(ctx, form_obj, w, menus);
    JS_FreeValue(ctx, menus);
    if (rc < 0)
        goto out;

    JSValue kids = JS_GetPropertyStr(ctx, root, "children");
    if (JS_IsArray(kids))
        rc = build_children(ctx, form_obj, w, kids);
    JS_FreeValue(ctx, kids);

    /*
     * The size the file drew against, before any code can have changed it.
     *
     * This is the moment it is knowable and the only one: the properties have
     * been applied, so `w`/`h` are what the `.form` said, and `Form_Open` has
     * not run yet -- so an application restoring a remembered window size has
     * not yet overwritten them. Every coordinate in this file was measured
     * against these two numbers, whatever size the window is later shown at.
     */
    w->drawn_w = w->w;
    w->drawn_h = w->h;

out:
    JS_FreeValue(ctx, root);
    g_free(path);
    return rc;
}
