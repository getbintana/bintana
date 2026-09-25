/*
 * Bintana runtime -- GTK4 widgets driven by QuickJS.
 *
 * Every widget visible from JS is one JS object carrying a BtaWidget in its
 * opaque slot.  All widget classes share a single JSClassID; the class
 * hierarchy (Widget -> Control -> Button, ...) lives entirely in the
 * prototype chain, which keeps the C side flat and table driven.
 */
#ifndef BTA_H
#define BTA_H

#include <gtk/gtk.h>
#include "quickjs.h"

typedef struct BtaWidget BtaWidget;
typedef struct BtaApp    BtaApp;

/*
 * The runtime's own release: `Application`'s `BTA_VERSION` global, and what
 * `bintana --version` prints.  CMake defines it from the one place it is
 * declared (`project(bintana VERSION ...)`), so the binary and this header
 * cannot disagree; the fallback is for a translation unit built outside that.
 */
#ifndef BTA_VERSION_STRING
#define BTA_VERSION_STRING "unknown"
#endif

/*
 * The runtime's own notes about a widget -- what it knows and the application
 * does not, kept on the struct rather than as own properties of the wrapper.
 * See the fields at the end of BtaWidget, and `docs/plans/strict-plan.md` for
 * why.
 *
 * `bta_widget_note` hands back the slot itself, so a caller reads it, frees it
 * and writes it in place. Four of them are also readable from JavaScript,
 * through accessors on `Widget.prototype` that this enum drives; `__declared` is
 * the one JavaScript writes too, because `rad.js` leaves the same note the
 * loader does.
 */
typedef enum {
    BTA_NOTE_DECLARED,   /* [declared, applied] per substituted property */
    BTA_NOTE_CHILDREN,   /* containers: the wrappers of what is inside */
    BTA_NOTE_MENUS,      /* forms: the menu spec, as read */
    BTA_NOTE_ACTIONS,    /* forms: the commands, as read */
    BTA_NOTE_COLUMNS,    /* tables: the declared columns */
    BTA_NOTE_PAINTER,    /* drawing areas: made on the first frame painted */
    BTA_NOTE_HANDLERS,   /* the handlers `On(event, fn)` installed, by event */
    BTA_NOTE_DECIMAL,    /* decimal boxes: the exact value, which the spin's
                          * double is only a view of */
} BtaNote;

JSValue *bta_widget_note(BtaWidget *w, BtaNote which);

/*
 * What becomes of a control when its container is not the size the
 * coordinates were written for.  GTK's own four words, because they mean the
 * same here as they do in a box -- and they are the same four cases WinForms
 * spells Anchor = Left / Right / Left,Right / None.
 */
/*
 * ...and in a box the same four words say where the child sits in the cell it
 * was given, which is what GTK's own halign/valign mean. One vocabulary, two
 * containers -- but the *default* cannot be one value, because the two
 * containers disagree about it: a drawn control stays where it was drawn, and a
 * child of a box fills its cell. `Auto` is that disagreement, named: whatever
 * the container does when nothing was asked for.
 */
typedef enum {
    BTA_ALIGN_AUTO,     /* whatever the container does by default */
    BTA_ALIGN_START,    /* keep the distance to the left/top edge: stays put */
    BTA_ALIGN_END,      /* keep the distance to the right/bottom edge: slides */
    BTA_ALIGN_CENTER,   /* keep the proportion: moves half the slack */
    BTA_ALIGN_FILL,     /* keep both distances: stretches */
} BtaAlign;

struct BtaWidget {
    GtkWidget *gtk;    /* outermost widget; this is what the parent lays out */
    GtkWidget *inner;  /* the control proper (differs when wrapped in a scroller) */
    GtkWidget *slot;   /* containers: where children go. NULL for leaf controls */

    JSContext *ctx;
    JSValue    form;   /* owning Form, duplicated -- reported via gc_mark */
    JSValue    self;   /* this widget's own wrapper, BORROWED (never freed):
                        * the wrapper owns us, so it always outlives us.
                        * Lets Children map GTK widgets back to JS objects. */
    /*
     * Forms: the keepalive a shown window holds.
     *
     * A form's wrapper is an ordinary object, and once it is shown nothing
     * else references it -- its children point back at it, which is a cycle
     * the collector is free to take away.  When it does, the window is left
     * on screen with every handler disconnected: a dialog that opens, looks
     * right, and stops answering at a moment that depends on when the
     * collector last ran.  Sixteen dialogs in the IDE kept a module-level
     * array alive by hand against exactly this.
     *
     * So `Show` takes a strong reference and the allowed close drops it --
     * the same claim `AudioPlayer.Play` makes for the length of a sound.
     * **Invisible to the collector on purpose**: `gc_mark` does not report
     * it, because a cycle detector that could see it would collect the very
     * object it protects.  What that costs is a release on every exit path,
     * `bta_forms_cleanup` included, or `JS_FreeRuntime` aborts at teardown.
     *
     * JS_UNDEFINED on anything that is not a form, and on a form that is not
     * currently shown.  `self` above is borrowed; this one is owned.
     */
    JSValue    held;
    char      *name;   /* control name; the "Button1" in Button1_Click */

    /*
     * Commands. On a **form**, the one action group its menu items, its actions
     * and its bound controls all live in -- created by whichever of the three
     * needs it first, and owned here because it outlives all of them.
     *
     * On any other widget, `action` is the path (`"form.ActDelete"`) of the
     * action this control is bound to, or NULL. A control that has one takes its
     * `Enabled` from the action and refuses to be told otherwise: two places
     * governing one command is the bug an `Action` exists to prevent, and the
     * IDE had it in two files with two different expressions.
     */
    GSimpleActionGroup *actions;   /* forms only */
    char               *action;    /* everything else */

    int        x, y, w, h;
    /* The floor a stretched control may not be squeezed below. 0 means none
     * was declared, and what GTK says the control needs is used instead. */
    int        min_w, min_h;
    /* Read by the surface this widget sits on; meaningless anywhere else,
     * the way Expand is meaningless here. Default Start, i.e. stay put. */
    BtaAlign   halign, valign;
    /*
     * Where Tab stops on this one, among the children of a `Fixed` surface.
     * Carried out by `bta_fixed_focus`, and meaningless in a box for the same
     * reason X/Y are: there the order Tab walks is the order things are drawn
     * in, and that is not a second thing to declare.
     *
     * 0 for everything until something says otherwise, and ties are broken by
     * the order the children are in -- so a form that declares nothing keeps
     * the order it was drawn in, which is every form written before this
     * existed. No renumbering of siblings: `TabIndex` is sparse on purpose, and
     * a setter that renumbered would be reaching into a form that may be a
     * drawing on the designer's canvas.
     */
    int        tab_index;
    /* How many of a Grid's columns this one takes. Meaningless in any other
     * container, exactly as X/Y are meaningless outside a Fixed. */
    int        span;
    /* Containers: do this one's children follow it when it is resized? Kept
     * here and not on the slot, because Arrangement replaces the slot and the
     * answer has to survive that. */
    bool       anchored;
    bool       is_form;
    bool       opened;  /* forms: has Form_Open already fired? */
    /* Forms: the window was destroyed by an allowed close, so `Show` can
     * never present it again (see HideOnClose) and must not take a keepalive
     * that nothing will ever release.  False under HideOnClose, which hides
     * instead of destroying. */
    bool       closed;

    /*
     * Forms: the size the `.form` declared, kept apart from the size the window
     * currently is.
     *
     * `w`/`h` are the current size, because `Resize` writes them -- so they stop
     * being the declaration the moment an application restores a remembered
     * window size, which is an ordinary thing for one to do. The anchors need
     * the *drawn* size and nothing else: it is what every coordinate in the file
     * was measured against, and that does not change because somebody made the
     * window smaller. See `bta_fixed.c`, where reading `w` instead of this put a
     * toolbar 68 pixels wider than its own window at every size.
     *
     * Zero on anything that is not a form, and on a form built from code with no
     * `.form` behind it -- there the first allocation is the only answer there is.
     */
    int        drawn_w, drawn_h;

    /*
     * Buttons: what Enter and Escape do on the form this one is on.
     *
     * Plain flags on the button, and **nothing is told to GTK here**. A window
     * has one default widget, so the obvious setter would call
     * `gtk_window_set_default_widget` -- and the designer builds the controls of
     * the form it is drawing inside the *IDE's* window, where every one of them
     * is bound to `MainForm` (see `bta_container_attach`), so that setter cannot
     * tell a drawing from an application and would hand the IDE's Enter key to a
     * button on a canvas. `form_show` resolves them instead: a drawing is never
     * shown as a form, so it can never reach the window.
     */
    bool       is_default;
    bool       is_cancel;

    /*
     * `Allocated`: the connection is made (or its realize handler is armed),
     * and the event has been raised -- once, the first time GTK gave this
     * widget a rectangle.  Kept here and not as JS state because the hook is a
     * GTK signal per widget; see `bta_widget_when_allocated` in bta_widget.c.
     */
    bool       alloc_watching;
    bool       alloc_fired;

    /* The application's own classes, as written in Style: the normal way to
     * dress a control, and the reason the three below are the exception.
     * A space separated list of CSS class names, NULL for none. */
    char      *style;

    /* Colours, applied through a CSS class unique to this widget. Allocated
     * lazily: most widgets never set one. */
    char      *style_class;
    char      *background;
    char      *foreground;
    char      *font;        /* a Pango description, re-serialised; NULL for none */
    char      *radius;      /* corner radii, "8" or "8 8 0 0"; NULL for square */
    char      *padding;     /* inner room, same shape; NULL for the theme's */
    /* The keys that press this control, as declared -- kept so the getter and
     * the serialiser answer with what the .form said. */
    char     **shortcuts;
    GtkEventController *shortcut_ctl;   /* owned by the widget, replaced on set */
    char      *shadow;      /* "x y blur spread colour"; NULL for none */
    char      *border;      /* "width style colour", normalised; NULL for none */
    /* Relative size and dimming, which is how a theme's own headings are
     * written: a factor of whatever font is in force, and an opacity. 0 and 1
     * are "nothing said". */
    double     font_scale;
    double     opacity;

    /* Objects that are not this widget but carry handlers of ours: a text
     * buffer, a selection model. Held so the finaliser can unhook them.
     * Allocated lazily; see bta_widget_watch. */
    GPtrArray *watched;

    /* Context menu: the popover, parented to `gtk` and so ours to unparent,
     * and the spec it was built from -- kept because a GMenu cannot be walked
     * back into one, exactly as a form keeps __menus. Duplicated, reported via
     * gc_mark. JS_UNDEFINED when the widget has no menu. */
    GtkWidget *popup;
    JSValue    menu;

    /*
     * A `TableView`'s heading menu: the spec, as declared -- no popover of
     * ours, because GTK builds the one a column shows from the model it is
     * given. Kept so the getter and the serialiser answer with what the .form
     * said, and built again for each heading click, because an item has to
     * know which column it was opened over.
     */
    JSValue    header_menu;

    /*
     * The runtime's own notes about this widget -- held **here** and not as own
     * properties of the wrapper, which is where they used to live.
     *
     * A widget's own properties ought to be its properties, and these were six
     * that were not: `__declared`, `__children`, `__menus`, `__actions`,
     * `__columns` and `__painter`, each defined on the object with the
     * enumerable bit off so that nothing which looked would find them.  The
     * argument for moving them, and what it buys, is
     * [`docs/plans/strict-plan.md`](../../docs/plans/strict-plan.md); the short
     * version is that a mode which refuses a property the widget does not have
     * cannot tell a note from a typo, and most of these are created *later*
     * than the widget -- `__columns` when an application assigns `Columns`,
     * `__painter` on the first frame a `DrawingArea` paints -- so pre-creating
     * them is not open either.
     *
     * The comment this reverses is in `bta_table.c`, and it was right about the
     * thing it warned of: keeping a `JSValue` in C is a strong reference the
     * collector cannot see, and `JS_FreeRuntime` aborts on anything still alive.
     * What makes it safe is the line below it -- `gc_mark` -- which this class
     * has had since `w->form` and `w->menu` needed it.  Every one of these is
     * reported there and freed in the finalizer, or the assertion says so at
     * teardown, loudly, and `tests/asan.sh` runs it on every project.
     *
     * JS_UNDEFINED until something writes one.  The four that JavaScript reads
     * are reached through accessors on `Widget.prototype` (`__declared` is the
     * only one it also writes), which are defined outside the published tables
     * because they are not published surface.
     */
    JSValue    declared;   /* [declared, applied] per property the loader
                            * substituted -- written by C and by rad.js both */
    JSValue    children;   /* containers: the wrappers of what is inside */
    JSValue    menus;      /* forms: the menu spec, as it was read */
    JSValue    actions_spec; /* forms: the commands, likewise -- not `actions`,
                              * which is the GSimpleActionGroup above */
    JSValue    columns;    /* tables: the declared columns */
    JSValue    painter;    /* drawing areas: made on the first frame painted */
    /*
     * `On(event, fn)`: this control's own handlers, keyed by event name.
     *
     * The seventh note, and the only one an application writes on purpose --
     * which is why it is here rather than as an own property of the wrapper.
     * A handler closes over the form, the form reaches the control through
     * `__children`, and the control reaches the handler through this: an
     * ordinary cycle that collects **because** `gc_mark` below reports it.
     */
    JSValue    handlers;
    /* decimal boxes: the exact value.  The eighth note, and the one that is a
     * strong reference to *the value the control shows* -- see bta_decimal.c's
     * `bta_decimal_new` and the control's own note in bta_controls.c. */
    JSValue    decimal;
};

struct BtaApp {
    JSRuntime      *rt;
    JSContext      *ctx;
    GtkApplication *gapp;

    char           *dir;      /* project directory */
    char           *name;
    /* What the project calls its own release, verbatim out of project.json;
     * "" when it declares none, which is an ordinary state and not a fault. */
    char           *version;
    /*
     * project.json's "id": the application's reverse-DNS identity, and the one
     * name its window class, its metainfo and its package all share.  "" when
     * the project declares none -- an ordinary project, whose window is classed
     * by the program's name as it always was.  `bta_app_new` refuses one that
     * is not an application id; see `bta_app_run` for where it becomes the
     * window's.
     */
    char           *id;
    char           *startup;  /* class name of the form to open first */
    /*
     * project.json's "main": the function to call instead of opening a form.
     * NULL for an ordinary application, and the whole of what makes a project a
     * console one -- there is no second switch, because a project either shows
     * a window or it does not.
     */
    char           *entry;
    GPtrArray      *sources;  /* absolute paths of .js files, in load order */
    /*
     * The libraries `project.json`'s "uses" named, resolved to absolute
     * directories in the order they were declared.  A library is a directory of
     * `.js` and `.form` files and nothing else: its sources load before the
     * project's own and its forms are indexed with them, which is the whole of
     * what makes its classes usable from a `.form`.
     */
    GPtrArray      *libs;
    /*
     * The native plugins the libraries carried and the runtime loaded, in load
     * order.  Empty (NULL) for the ordinary project, whose libraries are all
     * JavaScript.  `bta_plugins_load` fills it and `bta_plugins_cleanup`
     * releases it; the entries are bta_plugin.c's own, which is why the type
     * here is only GPtrArray.
     */
    GPtrArray      *plugins;
    GHashTable     *forms;    /* class name -> its .form, anywhere in the tree */
    char          **args;     /* NULL-terminated; argv after the project dir */

    /* The console loop, so Application.Quit can stop it. NULL while a form
     * application runs: there GtkApplication owns the loop. */
    GMainLoop      *loop;
    /* Quit was called. Its own flag because a console `main` can call it before
     * the loop exists, and a loop that has not started cannot be stopped. */
    bool            quitting;

    JSValue         startup_form;
    int             exit_code;
};

extern JSClassID bta_widget_class_id;

/* Set on every GtkWidget we create, so a GTK child can be mapped back to its
 * BtaWidget when walking a container. Cleared by the finalizer. */
#define BTA_WIDGET_QUARK "bta-widget"

/*
 * One entry per widget class.  bta_widgets_init() walks the table once,
 * chaining each prototype onto its parent's and exposing the constructor as a
 * global, so declaring a new control means adding a row plus a build function
 * -- no plumbing.
 */
typedef struct BtaClass {
    const char *name;
    const char *parent;                 /* NULL for the root class */
    void      (*build)(BtaWidget *w);   /* create the GTK side */
    const JSCFunctionListEntry *props;
    int         nprops;
    bool        is_form;

    /* The values one of this class's properties accepts, comma separated, or
     * NULL when it is free-form.  This is what turns a string property into a
     * drop-down in a property editor instead of a text field, and it belongs
     * next to the property so the two cannot disagree.  The returned string
     * must outlive the call (a literal, or a cached one). */
    const char *(*options)(const char *prop);

    /*
     * The properties of this class that hold text a person reads, comma
     * separated; NULL when it has none.  This is what the .form loader looks
     * up in the catalogue, what a property editor offers a sample value for,
     * and what an extractor collects -- one declaration, three consumers, so
     * none of them keeps a list that can drift.
     *
     * It is declared per class and not deduced from the name for a reason that
     * would otherwise be a disaster: `SourceEditor.Text` is source code and
     * `Terminal.Text` is a screen of output.  Translating either would be
     * silent and catastrophic, so a class says which of its strings are prose.
     *
     * Accumulated along the class chain rather than first-match, unlike
     * `options`: a Button's text properties are its own *plus* Widget's
     * Tooltip.
     */
    const char *texts;

    /*
     * The events this class raises, comma separated; NULL when it raises none of
     * its own.  **The first is the default** -- the one a double click in the
     * designer writes, which is the one you almost always want.
     *
     * Declared here for the same reason `texts` is: the answer belongs next to
     * the class, and the alternative is a list somewhere else that drifts the
     * first time a control is added. There was such a list -- `DEFAULT_EVENT` in
     * ide/Designer.js, fifteen types written by hand with `|| "MouseDown"` as the
     * fallback -- so `ColorButton`, `FontButton`, `Notebook`, `Switcher` and
     * `RowList` all double-clicked into a mouse handler nobody wanted.
     *
     * Accumulated along the class chain like `texts` and unlike `options`: a
     * Button's events are its own `Click` *plus* every one Widget raises.
     */
    const char *events;

    /*
     * Whether **this build** can run one.  True for all but the classes whose
     * engine is optional at build time, which declare their own answer.
     *
     * A separate question from whether the class is *there*: `Terminal`
     * without VTE still exists, still builds, still loads out of a `.form` and
     * still answers every property -- what it cannot do is start a child.  So
     * `Widget.Types()` keeps meaning *what classes there are* and this is
     * *what this build can run*, which is the one a palette wants: a control it
     * offers is a control the user can finish.
     *
     * Declared per class for the reason `texts` and `events` are: the answer
     * belongs beside the class, and the alternative is a list of the optional
     * ones somewhere else, drifting from the first `#ifdef` that moves.
     * Not accumulated along the chain -- availability is one class's own.
     */
    bool        available;

    /*
     * Whether **this machine** can run one right now, for a class whose answer
     * is not a build-time constant.  `available` is the default and this, when
     * set, is the answer: `Widget.Available(type)` and an instance's
     * `Available` both come through `bta_class_runnable`.
     *
     * `Video` is the class that needed it.  `Terminal`'s answer is whether VTE
     * was linked in, which is a constant of the build; a `Video` needs a
     * GStreamer base and the `gtk4paintablesink` element, and either can be
     * missing on a machine whose runtime has GStreamer -- and the program that
     * asks is the palette, before anything is played.
     *
     * **The probe caches its own answer.**  It runs on the first question and
     * the answer cannot change while the process lives; `Video`'s asks the
     * GStreamer registry, which is 6 ms with the cache warm and 573 ms cold
     * (measured), and that bill is why this is asked lazily rather than at
     * start-up.
     */
    bool      (*probe)(void);

    JSValue     proto;                  /* filled in by bta_widgets_init */
    JSValue     ctor;
} BtaClass;

/*
 * Widgets are declared per module and gathered here.  Modules register in
 * dependency order (see bta_class_table), because a class's parent prototype
 * has to exist before the child can chain onto it.
 */
void      bta_register_classes(const BtaClass *rows, int n);
BtaClass *bta_class_table(int *count);
BtaClass *bta_class_find(const char *name);

void bta_core_register(void);      /* bta_controls.c */
/* A radio button's group is the container it is in, so the set changes whenever
 * a child is added or taken out. GTK's group is a chain and not a name, so it is
 * rebuilt from the slot's children; `child` is the one that arrived or left, and
 * anything that is not a radio returns at once. */
void bta_radio_regroup(GtkWidget *slot, GtkWidget *child);
void bta_layout_register(void);    /* bta_layout.c   */
void bta_notebook_register(void);  /* bta_notebook.c */
/* A page just added: give it the tab name the .form promised, if any. Properties
 * are applied before children exist, so the promise outlives the assignment. */
void bta_notebook_page_added(GtkWidget *notebook, GtkWidget *page);
void bta_switcher_register(void);  /* bta_switcher.c */
/* The same promise a Switcher's Tabs makes, kept as each page arrives; a page
 * nothing named gets one anyway, because a nameless button is a blank one. */
void bta_switcher_page_added(GtkWidget *stack, GtkWidget *page);
/* Moves a page among its siblings. GTK has no reorder for a stack, so this is
 * where the pages are taken out and put back; false when it is not one. */
bool bta_switcher_reorder(BtaWidget *w, GtkWidget *child, int index);
void bta_paint_register(void);     /* bta_paint.c: DrawingArea */
/* One frame of a control's handler against a surface somebody else owns, and
 * whether one is already running. `page` is the sheet, 1-based; `DrawPage`
 * is raised when the form declared one. What `Printer` draws through. */
bool bta_paint_page(BtaWidget *w, cairo_t *cr, int width, int height, int page);
bool bta_paint_busy(JSContext *ctx, BtaWidget *w);
bool bta_paint_draws(BtaWidget *w);
void bta_printer_init(JSContext *ctx, JSValue global);
/* The Painter class, which is not a widget: registered with the runtime's
 * other non-widget classes rather than in the widget table. */
void bta_painter_init(JSContext *ctx, JSValue global);
/* `Text`: what a string measures, asked where there is no painter -- the same
 * font map and the same resolution a Painter's TextWidth answers with. */
void bta_metrics_init(JSContext *ctx, JSValue global);
void bta_text_register(void);      /* bta_text.c: Editor and TextEditor */
/* The plumbing both editors need over whichever view they built: the scroller
 * that becomes `gtk`, the buffer's `Change` and `Cursor`, and the watch without
 * which those handlers outlive the widget. */
void bta_text_view_setup(BtaWidget *w, GtkWidget *view);
/* The line a JS caller means, 1-based and clamped, as an iter at its start --
 * shared because a SourceEditor's marks are placed by line too. */
void bta_text_iter_at_line(GtkTextBuffer *buf, GtkTextIter *it, int32_t line);
/*
 * The two string bridges `Editor` and `Text` share, over a plain UTF-8 buffer.
 *
 * **A character offset and a JavaScript index are not the same number**, and
 * neither side may answer with the other's: `Offset`/`OffsetAt` count
 * characters, as `Column` and `Select` do; `LineOf` receives the index a
 * search produced (`Regex.Index`, `indexOf`), which counts UTF-16 units.  See
 * `bta_line_of_utf16` for why the conversion cannot be the identity.
 */
int  bta_line_of_utf16(const char *utf8, int index);
int  bta_chars_at_position(const char *utf8, int line, int column);
void bta_editor_register(void);    /* bta_editor.c: SourceEditor */
void bta_terminal_register(void);  /* bta_terminal.c */
void bta_tree_register(void);
void bta_table_register(void);      /* bta_tree.c     */

/*
 * Convenience for the module tables.  Designated initialisers, so a field
 * added to BtaClass costs nothing here -- `texts` arrived that way.
 *
 * With one exception, which is why there is an inner macro: a field whose
 * sensible default is **not** the zero value cannot be left out.  `available`
 * is `true` for every class but one, and a `bool` omitted from a designated
 * initialiser is `false` -- so `BTA_CLASS_FULL` fills it in and
 * `BTA_CLASS_OPTIONAL` is how the exception says otherwise.
 */
#define BTA_CLASS_AT(cname, parent_, build_, props_, nprops_, is_form_,   \
                     options_, texts_, available_, probe_, events_)       \
    { .name = cname, .parent = parent_, .build = build_,                  \
      .props = props_, .nprops = nprops_, .is_form = is_form_,            \
      .options = options_, .texts = texts_, .events = events_,            \
      .available = available_, .probe = probe_,                           \
      .proto = JS_UNDEFINED, .ctor = JS_UNDEFINED }

/* Available, which all but the optional-engine classes are (see the field). */
#define BTA_CLASS_FULL(cname, parent_, build_, props_, nprops_, is_form_, \
                       options_, texts_, events_)                         \
    BTA_CLASS_AT(cname, parent_, build_, props_, nprops_, is_form_,       \
                 options_, texts_, true, NULL, events_)

/*
 * Every variant takes `events` last, so a class states what it raises where it
 * states everything else about itself.  NULL for the containers that raise
 * nothing of their own -- which is most of them, and saying so is the point.
 */
#define BTA_CLASS(cname, parent, build, props, is_form, events) \
    BTA_CLASS_FULL(cname, parent, build, props, (int)G_N_ELEMENTS(props), \
                   is_form, NULL, NULL, events)
#define BTA_CLASS_BARE(cname, parent, build, is_form, events) \
    BTA_CLASS_FULL(cname, parent, build, NULL, 0, is_form, NULL, NULL, events)
/* Same, for a class that has enumerated properties (see BtaClass.options). */
#define BTA_CLASS_ENUM(cname, parent, build, props, is_form, options, events) \
    BTA_CLASS_FULL(cname, parent, build, props, (int)G_N_ELEMENTS(props), \
                   is_form, options, NULL, events)
/* ...and for one that has properties holding prose (see BtaClass.texts). */
#define BTA_CLASS_TEXT(cname, parent, build, props, is_form, texts, events) \
    BTA_CLASS_FULL(cname, parent, build, props, (int)G_N_ELEMENTS(props), \
                   is_form, NULL, texts, events)
#define BTA_CLASS_ENUM_TEXT(cname, parent, build, props, is_form, options, texts, events) \
    BTA_CLASS_FULL(cname, parent, build, props, (int)G_N_ELEMENTS(props), \
                   is_form, options, texts, events)
/*
 * ...and for a class whose engine is optional at build time, which says so
 * itself: `Terminal` is the one, and `#ifdef BTA_HAVE_VTE true #else false` is
 * the whole of the declaration.  `available` comes before `events` because
 * every variant takes `events` last.
 */
#define BTA_CLASS_OPTIONAL(cname, parent, build, props, is_form, available, events) \
    BTA_CLASS_AT(cname, parent, build, props, (int)G_N_ELEMENTS(props), \
                 is_form, NULL, NULL, available, NULL, events)

/*
 * ...and for the class whose answer is **asked of the machine**, not declared
 * at build time: `probe` is what `Widget.Available(type)` and the instance's
 * `Available` answer with (see BtaClass.probe).  It takes `options` because
 * `Video` -- the one class that needed this -- has enumerated properties.
 */
#define BTA_CLASS_ENUM_PROBE(cname, parent, build, props, is_form, options,  \
                             probe, events)                                  \
    BTA_CLASS_AT(cname, parent, build, props, (int)G_N_ELEMENTS(props),      \
                 is_form, options, NULL, true, probe, events)

/* The answer for a class, whichever way it declares it. */
bool bta_class_runnable(const BtaClass *cls);

BtaApp *bta_current_app(void);

/* --- runtime ------------------------------------------------------------ */
BtaApp *bta_app_new(const char *project_dir);
void    bta_app_free(BtaApp *app);
int     bta_app_run(BtaApp *app, int argc, char **argv);

char   *bta_read_file(const char *path, size_t *len);
int     bta_eval_file(JSContext *ctx, const char *path);
void    bta_dump_error(JSContext *ctx);
/* The language without any project: the intrinsics build_context installs,
 * exposed so a worker thread starts from the same language. Paired with
 * bta_close_hatches below, which is the same closing. */
JSContext *bta_new_context(JSRuntime *rt);
void       bta_close_hatches(JSContext *ctx);
/*
 * A fatal error raised from C, before any project code has run: it always goes
 * to stderr, and -- when there is a display and an application to own it -- into
 * the same alert a JavaScript error gets.  A form project started from a menu
 * has no terminal to read, and `bta_plugins_load` is the caller that made this
 * necessary: a shared object that will not load stopped the program with
 * nothing on screen.
 *
 * It returns once the alert has been dismissed, so the caller can quit knowing
 * it was seen.  A console project is unaffected: stderr is where its reader
 * already is.
 */
void    bta_report_fatal(BtaApp *app, const char *message);
void    bta_drain_jobs(JSRuntime *rt);   /* run pending promise callbacks */

/* A Debug line from C, where there is no argv to join: threshold, Handler,
 * sink -- everything Logger.Debug does once the line exists. The plain one
 * skips the Handler, for a context where JS must not run (a Wait's traffic,
 * whose caller is blocked mid-call). */
void    bta_log_debug(JSContext *ctx, const char *text);
void    bta_log_debug_plain(const char *text);

/* Resolves a top-level class by name, including `class X {}` bindings that
 * live in the global lexical scope rather than on globalThis. */
JSValue bta_lookup_global(JSContext *ctx, const char *name);

/* --- widgets ------------------------------------------------------------ */
void       bta_widgets_init(JSContext *ctx, JSValue global);
/* Releases the class table's prototypes/constructors before the context dies. */
void       bta_widgets_cleanup(JSContext *ctx);
/* Drops the keepalive every shown form holds.  A strong reference the collector
 * cannot see, so it has to go before JS_FreeRuntime -- see `BtaWidget.held`. */
void       bta_forms_cleanup(void);
BtaWidget *bta_widget_of(JSValueConst v);
/* Unwraps `this`, throwing a TypeError when it is not a widget. */
BtaWidget *bta_this(JSContext *ctx, JSValueConst this_val);
/*
 * Hold the appearance stylesheet's rebuild while a whole tree is built, and
 * rebuild once on release.  Counted, so a component with a `.form` of its own
 * nests.  **Only for a stretch with no JavaScript in it**: the sheet is read
 * back -- a DrawingArea takes its ink from its control's style context -- so a
 * hold that is open when something draws answers with the theme's colour.
 */
void       bta_widget_styles_hold(void);
void       bta_widget_styles_release(void);

/* A number from a property setter, or false with a TypeError naming the value.
 * Every numeric setter goes through these: JS_ToInt32 turns a string that is not
 * a number into 0 without failing, which is how `Margin = "0 0 0 12"` was a
 * silent zero. */
bool       bta_to_number(JSContext *ctx, JSValueConst val, const char *name,
                         double *out);
bool       bta_to_int(JSContext *ctx, JSValueConst val, const char *name,
                      int32_t *out);
/* Calls form.<Name>_<event>() if the form defines it. */
void       bta_emit(BtaWidget *w, const char *event, int argc, JSValueConst *argv);
/* The same, answering whether the handler threw -- which only an exporter needs:
 * a frame that died halfway must not become a file that reports success. */
bool       bta_emit_ok(BtaWidget *w, const char *event, int argc, JSValueConst *argv);
/* An event asked a question: the handler's answer, and whether it threw.
 * Only for an event whose value the runtime needs -- see bta_widget.c. */
JSValue    bta_emit_answer(BtaWidget *w, const char *event, int argc,
                           JSValueConst *argv, bool *threw);
/* Whether the form declared a handler for it -- asked only where there is a
 * second event to fall back on. See bta_widget.c. */
bool       bta_has_handler(BtaWidget *w, const char *event);
/* Same as bta_emit, for event sources that are not widgets (menu items).
 * Returns what the handler returned, so an event can be consumed;
 * JS_UNDEFINED when there is no handler. The caller owns the result. */
JSValue    bta_emit_on(JSContext *ctx, JSValueConst form, const char *name,
                       const char *event, int argc, JSValueConst *argv);
/* Instantiates a widget class by name, as the .form loader does. */
JSValue    bta_widget_new(JSContext *ctx, const char *type);
/* Binds a control to its owning form: sets the name used for event lookup. */
void       bta_widget_bind(BtaWidget *w, JSValueConst form, const char *name);
/* Same, for every descendant that has no form yet: a subtree assembled before
 * being attached would otherwise dispatch no events. */
void       bta_widget_bind_tree(BtaWidget *w, JSValueConst form);
/* "I connected a handler on this object, and it carries `w`." Anything that is
 * not the widget itself (a GtkTextBuffer, a selection model) has to say so, or
 * its handlers outlive the widget and fire into freed memory. */
void       bta_widget_watch(BtaWidget *w, gpointer object);
/* The other half, for a connection that has done its job: unhook it and let the
 * object go. A window that is realized again gets a *new* surface each time, and
 * a watch kept past its surface is one dead object per opening. */
void       bta_widget_forget(BtaWidget *w, gpointer object);
/* The inverse of adopting: drop the parent's JS reference to a child. Every way
 * of removing one has to call it, or the wrappers pile up. */
void       bta_widget_release(JSContext *ctx, JSValueConst parent_val,
                             JSValueConst child_val);
/* Both halves of adding a child, whatever the container: hold a JS reference to
 * it (the wrapper owns the BtaWidget) and bind it to the form. */
void       bta_widget_adopt(JSContext *ctx, JSValueConst parent_val,
                            BtaWidget *parent, JSValueConst child_val,
                            BtaWidget *child);
/* Would this adoption hand the child two handlers for one event -- its own,
 * from `On`, and a `<Name>_<Event>` the form it is joining already answers?
 * **Asked before the child is put into GTK**, and throws when it answers true:
 * `bta_widget_adopt` runs after the attach and so cannot refuse anything. Every
 * verb that brings an *unbound* control into a container asks it first. */
bool       bta_widget_adopt_refused(JSContext *ctx, JSValueConst parent_val,
                                    BtaWidget *parent, BtaWidget *child);
/* Everything asked before a child goes into a container: not into itself, the
 * handler pair above, and -- with `move` -- out of wherever it was (so `Add`
 * moves). Answers false with an exception pending. See its note in
 * bta_widget.c. */
bool       bta_widget_bring_in(JSContext *ctx, JSValueConst parent_val,
                               BtaWidget *parent, BtaWidget *child, bool move);
/* Re-applies x/y/width/height to the GTK layout. */
void       bta_widget_relayout(BtaWidget *w);
/*
 * The first control under `w` carrying `Default` or `Cancel`, in tree order, or
 * NULL when there is none.
 *
 * Walked rather than remembered on purpose: a pointer to a button is a pointer
 * that outlives it -- the family of bug that bit `Notebook.Append` -- and there
 * is nothing here worth a weak reference for. A dialog is a dozen widgets and
 * this runs on a keypress.
 */
BtaWidget *bta_widget_flagged(BtaWidget *w, bool cancel);
/* Puts `child` into `parent`'s slot, however that slot packs its children
 * (GtkFixed by coordinates, GtkBox appended, GtkPaned start-then-end).
 * Returns false and throws when the slot is full or absent. */
bool       bta_container_attach(JSContext *ctx, BtaWidget *parent, BtaWidget *child);
/* Takes `child` out of whatever container holds it, dropping the parent's
 * lifetime reference too. Safe on an already-detached widget. */
bool       bta_container_detach(JSContext *ctx, BtaWidget *child);
/* Empties a container, however its slot holds its children. */
JSValue    bta_container_clear(JSContext *ctx, JSValueConst this_val);
/* The Bintana widget behind one direct GTK child of a slot, or NULL when that
 * child is not ours. A GtkListBox wraps each child in a row of its own, so the
 * widget can be one level below what the slot reports. */
BtaWidget *bta_slot_child(GtkWidget *child);
/* The direct GTK child of the slot that carries `child`: itself, or the row or
 * cell a RowList or a Flow wrapped it in. The inverse of bta_slot_child(). */
GtkWidget *bta_child_holder(GtkWidget *child);
/* What a slot reports as its first content widget, which is not always GTK's
 * first child: a `GtkPopover` wraps its content in a `GtkPopoverContent` of its
 * own, and the widget an application means is `gtk_popover_get_child`. Every
 * walk over a slot starts here, so the wrapper stays out of `Children`, `Clear`
 * and the binding cascade. */
GtkWidget *bta_slot_first_child(GtkWidget *slot);
/* How many of ours a slot holds, wrappers looked through -- what an index in
 * `Reorder` is counted against. */
int        bta_container_count(GtkWidget *slot);
/* Whether this slot has an order to give: a box, a grid, a notebook, a stack, a
 * split, a flow, a list of rows or a stack of layers. A drawing surface has
 * none -- there the order is the painting order, which is `Raise`/`Lower`. */
bool       bta_container_order(GtkWidget *slot);
/* Moves `child` to that position among its siblings, however this slot keeps
 * their order. `index` counts them *without* the one being moved; in an
 * `Overlay` index 0 is the base layer, the child that fills. Returns false and
 * throws when the slot has no order or the child is not in it. */
bool       bta_container_reorder(JSContext *ctx, BtaWidget *parent,
                                 BtaWidget *child, int index);
/* An image out of bytes in memory: what `Http` answers with and `File.LoadBytes`
 * reads, decoded by GDK the way a file is. NULL with an exception pending when
 * the value is not `Bytes`, is empty, or holds no image `gdk-pixbuf` knows;
 * `who` names the caller in that complaint. The caller owns the texture. */
GdkTexture *bta_texture_from_bytes(JSContext *ctx, JSValueConst val, const char *who);
/* Whether this widget is drawn on a dark ground, derived from the ink its text
 * uses -- the one answer GTK really has (see the definition; the two settings
 * that look like this question answer wrongly). Takes a GtkWidget rather than a
 * BtaWidget because a Painter asks it about the surface it is painting. */
bool bta_widget_dark(GtkWidget *at);
/* Scroll a row into view inside whatever scrolled window holds it -- the
 * arithmetic `GtkListBox` has no call for. */
void bta_widget_reveal(GtkWidget *target);
/* The Widget prototype's own accessors, shared by the class table. */
const JSCFunctionListEntry *bta_widget_base_props(int *count);
/* The values `Cursor` accepts, comma separated, for Widget's `options`. Built
 * from the same table the setter checks against, so the drop-down cannot drift
 * from what is allowed. */
const char *bta_widget_cursor_options(void);
/* Whether `prop` is one of the properties holding prose for this object's class
 * or any it inherits from (see BtaClass.texts).  Answers about the prototype
 * chain, so it works on anything the loader is applying properties to. */
bool bta_widget_text_prop(JSContext *ctx, JSValueConst obj, const char *prop);
/* Same, and says *where* in the property the prose is: `field` comes back newly
 * allocated for a declaration like `"Columns.Text"`, NULL when the whole value
 * is prose. See the definition. */
bool bta_widget_text_prop_field(JSContext *ctx, JSValueConst obj,
                                const char *prop, char **field);

/* --- the RAD surface ---------------------------------------------------- */
/*
 * The container behind Arrangement = "Fixed": absolute coordinates that
 * survive a resize, because each child's HAlign/VAlign says what to do with
 * the slack. See bta_fixed.c.
 */
#define BTA_TYPE_FIXED (bta_fixed_get_type())
G_DECLARE_FINAL_TYPE(BtaFixed, bta_fixed, BTA, FIXED, GtkWidget)
GtkWidget *bta_fixed_new(void);
/*
 * The same layout, as a manager one can hand to any widget.
 *
 * What a container is and how it arranges its children are two questions, and
 * GTK4 keeps them apart: this is what lets `Arrangement` swap the arrangement
 * *in place*, leaving the widget the parent lays out -- with its CSS node, its
 * handlers and its place among its siblings -- exactly where it was.
 */
GtkLayoutManager *bta_fixed_layout_new(void);
/*
 * Which arrangement a surface is wearing at the moment.
 *
 * `BTA_IS_FIXED(w)` is the other question -- is this one of our surfaces, i.e.
 * can it be re-arranged at all -- and the two must not be confused: a `Panel`
 * arranged `Horizontal` is still a `BtaFixed`, and treating it as a coordinate
 * surface is what would take `HAlign` away from every child of a box. Anything
 * that is not one of our surfaces answers false to both.
 */
bool              bta_surface_is_fixed(GtkWidget *widget);
bool              bta_surface_is_box(GtkWidget *widget);
/* Off for a surface that is a drawing board rather than a window: children sit
 * exactly where they were drawn, whatever size the surface grew to. Harmless
 * on anything that is not one of ours. */
void       bta_fixed_set_anchored(GtkWidget *fixed, bool on);
bool       bta_fixed_get_anchored(GtkWidget *fixed);

/* --- native plugins -----------------------------------------------------
 *
 * A library named by `uses` may carry `<name>/<name>.<G_MODULE_SUFFIX>` beside
 * its `.js`, and the runtime loads it before the library's sources so the
 * native half can install a global the JavaScript half wraps.  The contract a
 * plugin is written against is `runtime/include/bta_plugin.h`, which is the
 * only header a plugin needs and the only thing this installs.
 *
 * Loaded from `install_globals`, after the runtime's own globals and before
 * `rad.js`.  `bta_plugins_load` answers false when a shared object is there and
 * cannot be used -- not a plugin file at all, another ABI, an init that failed
 * -- and the caller stops the program, because half a library is not a state to
 * run in.  `bta_plugins_cleanup` runs the plugins' own cleanup and closes them,
 * after the context is gone.
 */
bool bta_plugins_load(BtaApp *app, JSContext *ctx, JSValue global);
void bta_plugins_cleanup(BtaApp *app);

/* --- Http ------------------------------------------------------------- */
void  bta_http_init(JSContext *ctx, JSValue global);
void  bta_http_cleanup(void);   /* cancels requests still in flight */
guint bta_http_pending(void);   /* requests owed an answer */

/* --- media: Video and AudioPlayer --------------------------------------
 *
 * Playback over GStreamer, one playbin3 per player. The Video widget shows
 * its frames through the gtk4paintablesink in a GtkPicture; an AudioPlayer
 * is the same pipeline with the video branch switched off and no window.
 * Optional at build time (BTA_HAVE_GST); without it both exist and say which
 * package is missing when asked to play -- the bta_sqlite.c mold.
 */
void  bta_media_register(void); /* the Video widget row */
void  bta_media_init(JSContext *ctx, JSValue global);
void  bta_media_cleanup(void);  /* stops players still going */
void  bta_printer_cleanup(void); /* cancels print dialogs still waiting */
guint bta_media_pending(void);  /* players owed an answer (console loop) */

/* --- Scrolling, shared by Scroller and Editor -------------------------- */
/*
 * Where a widget is scrolled to, for the two that can answer.
 *
 * A `Scroller` *is* a GtkScrolledWindow and an `Editor` *builds* one around its
 * view (`bta_text_view_setup`), so both have the same thing underneath and both
 * publish the same four names and the same `Scroll` event.  One implementation,
 * in `bta_layout.c`, because two would be two answers to one question -- and
 * because `ScrollY` has to mean the same number in both places for a caller
 * that keeps two of them in step.
 */
enum { BTA_SCROLL_X, BTA_SCROLL_Y, BTA_SCROLL_MAX_X, BTA_SCROLL_MAX_Y };
JSValue bta_scroll_get(JSContext *ctx, JSValueConst this_val, int magic);
JSValue bta_scroll_set(JSContext *ctx, JSValueConst this_val, JSValueConst val,
                       int magic);
/* Both adjustments, reporting through one `Scroll(x, y)`. */
void bta_scroll_watch(BtaWidget *w);

/* --- File / Dir / Exec -------------------------------------------------- */
void bta_sys_init(JSContext *ctx, JSValue global);
/* Where this binary is -- `/proc/self/exe` or `GetModuleFileName`, one answer
 * for the two callers that need it (`Application.Executable` and the library
 * search). Newly allocated, or NULL where the platform will not say. */
char *bta_exe_path(void);

/* --- Desktop -------------------------------------------------------------
 *
 * The session a program is running in: the XDG directories a user's own data
 * goes in, and `Desktop.Entries` -- the `.desktop` files of
 * `$XDG_DATA_HOME/applications`, read and written through `GKeyFile`, which
 * is the platform's implementation of that format.  See bta_desktop.c.
 */
void bta_desktop_init(JSContext *ctx, JSValue global);

/*
 * The debugger (`runtime/src/bta_debug.c`), which exists only under `--debug`.
 *
 * `bta_debug_want` is the flag the command line sets; `bta_debug_start` installs
 * the hook and waits for the IDE to say what it wants stopped at, before a line
 * of the project has run.  With no `--debug` all three are no-ops and QuickJS
 * never gets a handler, which is the whole of what an ordinary run pays.
 */
void bta_debug_want(void);
bool bta_debug_enabled(void);

/*
 * Strict checks (`--strict`): a control refuses a property it does not have.
 *
 * `widget.Txt = "x"` on a widget whose class has no `Txt` creates an own
 * property and does nothing, forever -- the quietest failure this language has,
 * and the one `Ide.Live` and `Ide.Check` answer statically. This is the other
 * half: a control that has been built is made **non-extensible**, so the same
 * line throws where it is written, with a traceback, in a file nobody has open
 * and through a name nothing could have read (`this[which].Txt`).
 *
 * `preventExtensions` and not `freeze`: a widget's properties are accessors on
 * its prototype, so assigning one is a setter call and creates nothing, while
 * assigning a name the class lacks is an attempt to *add* an own property --
 * which is exactly the one to refuse. Freezing would refuse both.
 *
 * It works because every project source is evaluated with `JS_EVAL_FLAG_STRICT`
 * (see `bta_runtime.c`): in sloppy mode the refusal would be silent, which is
 * the state it exists to end.
 *
 * Off unless asked for, and named for development: an application storing state
 * on a control is ordinary JavaScript and would start throwing.
 * `docs/plans/strict-plan.md` has the whole argument, including why a *form* is
 * never sealed -- it is the application's own object, and `Form_Open` assigning
 * `this.anything` is what every program here does.
 */
void bta_strict_want(void);
bool bta_strict(void);
/* Seal one object, if the mode is on. Silent and cheap when it is not. */
void bta_strict_seal(JSContext *ctx, JSValueConst obj);
void bta_debug_start(JSContext *ctx);
void bta_debug_stopping(JSContext *ctx, int code);
/* A project file just compiled: what lines it can stop on. */
void bta_debug_compiled(JSContext *ctx, const char *path, JSValueConst compiled);
void bta_sys_cleanup(void);   /* cancels children still running */
/*
 * How much of the program is still owed an answer: children running, timers
 * armed, files watched.  A console project ends when this reaches zero -- the
 * same bargain node makes, and the only one that lets a `main` that only prints
 * return without hanging and a `main` that spawns something wait for it.
 */
guint bta_sys_pending(void);

/* --- Task ----------------------------------------------------------------
 *
 * A class that runs in a thread of its own: `class Sizer extends Task` with a
 * `Run(msg)` method, `new Sizer()` as the handle, `Start(data)` as the trigger
 * and `Done`/`Error`/`Progress` as the answers. One shot -- a Task runs once.
 * See runtime/src/bta_task.c, which is the whole of it.
 */
void bta_task_init(JSContext *ctx, JSValue global);
/* True when this context runs inside a worker thread. Widgets (and anything
 * else that touches GTK) ask this before constructing, because GTK off the
 * main thread is a crash and not an error. */
bool bta_task_is_worker(JSContext *ctx);
/* A Task still owed an answer, for the console loop's pending sum. */
guint bta_task_pending(void);
void bta_task_cleanup(void);   /* stops and joins workers still running */

/* --- Lock ----------------------------------------------------------------
 *
 * `Lock.Hold(name, fn)`: run `fn` with a named lock held, so two threads take
 * turns over a sequence. Named rather than held because a `Task` runs in a
 * runtime of its own and no object crosses a message; the table is
 * process-global, which is the scope the two share. See runtime/src/bta_lock.c.
 */
void bta_lock_init(JSContext *ctx, JSValue global);

/* --- commands: actions and menus ---------------------------------------- */

/*
 * The form's action group, made on the first call and inserted on its widget.
 * Menus, actions and bound controls share one: an accelerator, a menu item and a
 * button naming the same command have to resolve it in the same place.
 */
GSimpleActionGroup *bta_form_actions(BtaWidget *form);

/*
 * Builds the form's commands from a .form "actions" array, exposing each on the
 * form by name. Called **before** the menus and the children, both of which may
 * name one.
 */
int bta_actions_build(JSContext *ctx, JSValueConst form_obj, BtaWidget *w,
                      JSValueConst actions);

/* Whether that name is a command of this form, so a control can refuse to bind
 * to one that is not there rather than doing nothing when it is pressed. */
bool bta_action_exists(BtaWidget *form, const char *name);

/* How GTK spells the group a form's commands live in: `form.ActDelete`. */
#define BTA_ACTION_GROUP "form"

/*
 * Puts the action's label and icon on a control that has just bound to it --
 * and only where the control declared neither, so a toolbar button stays
 * icon-only while the menu shows the label.
 */
void bta_action_dress(JSContext *ctx, BtaWidget *form, const char *name,
                      JSValueConst control);

/*
 * A note that `key` was *declared* as one value and *applied* as another, which
 * is what the serialiser writes back while the applied one is still there. The
 * loader's own use is a substituted `Width`; a control dressed by a command uses
 * it to serialise as having declared nothing.
 */
void bta_note_declared(JSContext *ctx, JSValueConst target, const char *key,
                       JSValueConst declared, JSValueConst applied);

/* --- menus -------------------------------------------------------------- */
void bta_menu_init(JSContext *ctx);
/* Builds the form's menu bar from a .form "menus" array, exposing each item on
 * the form by name and registering its accelerator. */
int  bta_menus_build(JSContext *ctx, JSValueConst form_obj, BtaWidget *w,
                     JSValueConst menus);
/* The same spec, as a context menu on one widget: the items are exposed on the
 * form by name and dispatch as Name_Click like any other. Replaces whatever
 * menu the widget had; a NULL or empty spec leaves it with none. */
int  bta_menu_popup_build(JSContext *ctx, JSValueConst form_obj, BtaWidget *w,
                          JSValueConst menus);
/*
 * The same spec again, for a table's column heading.  Built with `column` so
 * every item's Click handler is told which heading it was opened over -- the
 * trailing argument, after whatever the item's kind already carries.
 *
 * The model is the caller's: a table sets it on the column, which is what GTK
 * shows.  The action group is inserted on the widget's `inner` and left there,
 * because the popover GTK builds is parented to the column's title and has to
 * reach it.  NULL with a pending exception when the spec is refused, which the
 * caller reports with bta_dump_error; `column` of -1 is a spec being checked,
 * not one being opened.
 */
GMenu *bta_menu_header_build(JSContext *ctx, JSValueConst form_obj,
                             BtaWidget *w, JSValueConst menus, int column);
/* Pops the widget's context menu up at a point in its own coordinates. */
void bta_menu_popup_show(BtaWidget *w, double x, double y);
/* Drops it: called from the widget finaliser, which owns the popover. */
void bta_menu_popup_free(BtaWidget *w);

/*
 * Reaching the row a node shows as, for the two widgets that nest
 * (`runtime/src/bta_treerows.c`).
 *
 * `TreeView` and `TableView` in tree mode are the same three pieces -- a store
 * of roots, a `GtkTreeListModel` over it, and nodes that know their parent --
 * and they had one copy each of the same walk. What differs between them is
 * only the node type, so that is all a caller declares: three one-line
 * accessors, and the walk is shared.
 *
 * `children` is the node's own child store and `roots` the top-level one, which
 * is what a node with no parent lives in.
 */
typedef struct {
    gpointer    (*parent)(gpointer node);     /* NULL for a root */
    GListModel *(*children)(gpointer node);
    GListModel *(*roots)(BtaWidget *w);
} BtaTreeShape;

/* The row, or NULL when an ancestor is collapsed and it is therefore not in the
 * flattened list at all. The caller owns what comes back. */
GtkTreeListRow *bta_tree_row_of(BtaWidget *w, GtkTreeListModel *tree,
                                gpointer node, const BtaTreeShape *shape);
/* Open or close one node, if it has a row to open. */
void bta_tree_set_expanded(BtaWidget *w, GtkTreeListModel *tree, gpointer node,
                           bool open, const BtaTreeShape *shape);
/* Open everything between the root and this node -- and the node itself when
 * asked, which is what makes a node added later show its own children. */
void bta_tree_reveal(BtaWidget *w, GtkTreeListModel *tree, gpointer node,
                     bool with_node, const BtaTreeShape *shape);

/* Whether the icon search path (the desktop's, plus <project>/icons) has an
 * icon by that name. `widget` may be NULL for the default display. */
bool bta_icon_available(GtkWidget *widget, const char *name);
/* Show a named icon on a GtkImage by whichever route is safe: GTK rasterises an
 * SVG icon on a thread pool, and two icons whose SVG carries text race there, so
 * those are resolved here and handed over as a paintable instead.  Every icon
 * the runtime draws goes through this. */
void bta_image_set_icon(GtkWidget *image, const char *name);
/* The same answer for a widget that takes a paintable rather than a GtkImage:
 * NULL means "use the icon name, it is fine". Transfer full. */
GtkIconPaintable *bta_icon_paintable(GtkWidget *widget, const char *name, int size);

/* Re-places a Grid's children: they flow in order, wrapping at `Columns`, so
 * anything that changes the order or the spans has to say so. Harmless on a slot
 * that is not one. */
void bta_grid_reflow(GtkWidget *slot);

/* --- Locale -------------------------------------------------------------
 *
 * Translation, from the project's own po/<lang>.po.  The .po and not the .mo:
 * a project directory holds sources, nothing in it is generated or compiled,
 * and .po is the interchange format every translation tool already speaks.
 */
/* `libs` are the library directories from project.json's `uses`: their `po/`
 * is read before the project's, so the project's wording wins. */
void bta_locale_init(JSContext *ctx, JSValue global, const char *project_dir,
                    GPtrArray *libs);

/* Decimal: exact base-10 arithmetic with the ordinary operators, which needs
 * the JS_SetArithHandler patch in vendor/quickjs. */
void bta_decimal_init(JSContext *ctx, JSValue global);

/*
 * `Connection` -- the base class every driver's connections inherit from, whose
 * prototype rad.js hangs `Table` on -- and `Database`, the object a driver adds
 * its opener to.  Everything a driver shares, which is an interface and not an
 * implementation.  Registered before any driver.
 */
void bta_database_init(JSContext *ctx, JSValue global);

/* The base prototype, for a driver to build its own on with JS_NewObjectProto.
 * A fresh reference: the caller frees it. */
JSValue bta_connection_proto(JSContext *ctx);

/* One driver's opener onto `Database` -- `bta_database_driver(ctx, "Sqlite",
 * open, 1)` makes `Database.Sqlite(path)`. */
void bta_database_driver(JSContext *ctx, const char *name,
                         JSCFunction *open, int nargs);

/*
 * The sqlite driver.  Optional at build time (BTA_HAVE_SQLITE); without it
 * `Database.Sqlite` says which package is missing.  The mapping from a row to a
 * `Record` is in rad.js -- see the head of bta_sqlite.c for why it cannot be
 * anywhere else.
 */
void bta_sqlite_init(JSContext *ctx, JSValue global);

/*
 * Xml: XML as a **document** -- parse, walk, edit, write -- at JSON's level.
 * Optional at build time (BTA_HAVE_LIBXML), the sqlite mould: without it `Xml`
 * exists, `Available` is false and every verb refuses with a sentence.  A
 * record's mapping onto an element -- `static Xml`, `LoadXml`/`ToXml`/
 * `SaveXml` -- is in rad.js, beside `Table`; docs/plans/xml-plan.md is the
 * design.
 */
void bta_xml_init(JSContext *ctx, JSValue global);

/*
 * Bytes: the value a file is when it is not text. One class, immutable, with the
 * operations an application actually performs on a file it read.
 */
void bta_bytes_init(JSContext *ctx, JSValue global);
/* A new Bytes over a **copy** of this memory -- the callers all hand over
 * something whose lifetime is not ours (a GLib buffer, a sqlite BLOB). */
JSValue bta_bytes_new(JSContext *ctx, const void *data, size_t len);
/* The bytes this value holds, or NULL when it is not a Bytes. Never NULL for
 * one that is: an empty Bytes points at nothing rather than being nothing. */
const uint8_t *bta_bytes_get(JSValueConst v, size_t *len);

/* Day: a calendar date as "YYYY-MM-DD" text -- the value DatePicker and
 * Field.Date already hold -- with the arithmetic JavaScript's instant cannot do
 * correctly. */
void bta_day_init(JSContext *ctx, JSValue global);

/*
 * A Decimal's digits, for Locale to format without a double in the way: `units`
 * in the smallest place and `scale` places, e.g. 1999 and 2 for 19.99.  `want`
 * asks for a particular number of places, or -1 for the value's own.
 *
 * Three answers and not two, because "not a decimal" and "a decimal that would
 * not fit" are different things and only the second leaves an exception behind:
 *   1  written
 *   0  not a Decimal -- nothing written, nothing thrown
 *  -1  a Decimal, but it could not be scaled; an exception is pending
 */
int bta_decimal_parts(JSContext *ctx, JSValueConst v, int want,
                      int64_t *units, int *scale);

/*
 * A decimal held as **text**, for whoever has to order, compare or total one
 * where there is no JS context to complain to -- which is a sqlite callback in
 * the middle of a statement.  `false` when the text is not a decimal; nothing is
 * ever thrown.
 *
 * Two integers rather than a value, because a decimal *written down* is always
 * exactly `units` at `scale` places: `10/3` has no text.
 */
bool bta_decimal_from_text(const char *text, int64_t *units, int *scale);

/* And the other way into the language: a Decimal value from whole units at a
 * scale.  An exception is pending on failure. */
JSValue bta_decimal_new(JSContext *ctx, int64_t units, int scale);

/* And back -- `199` at 2 places is `"1.99"`.  A fresh string, g_free'd by the
 * caller. */
char *bta_decimal_to_text(int64_t units, int scale);

/*
 * How a number is written: what `Locale.Number`/`Locale.Currency` take as their
 * options object, and what a `DecimalBox` reads off its properties.  One struct
 * because the control, a label and a report must spell the same amount the same
 * way -- and `bta_locale_format_number` below is the one place that knows how.
 */
typedef struct {
    int         places;        /* -1: the value's own, or the currency's */
    bool        group;         /* thousands separators */
    const char *prefix;        /* outside the number: "aprox. " */
    const char *suffix;        /* and outside it: " kg", " h" */
    bool        currency;      /* the locale's symbol and its side */
    const char *symbol;        /* an override, or NULL for the locale's */
    bool        symbol_before; /* an override's side, and its gap */
    bool        symbol_space;
} BtaNumberFmt;

/* `places` -1 and grouping on, which is what `Locale.Number(v)` means. */
void bta_number_fmt_default(BtaNumberFmt *f);

/* Render `v` -- a Decimal, a number or numeric text -- with `f`.  NULL with an
 * exception pending when `v` is not a number. */
char *bta_locale_format_number(JSContext *ctx, JSValueConst v,
                               const BtaNumberFmt *f);

/* The way back: text into whole units at a scale, honouring the affixes and the
 * locale's grouping and decimal point.  `false` when it is not a number, and
 * **nothing is thrown** -- a field being typed into is not an error. */
bool bta_locale_parse_number(const char *text, const BtaNumberFmt *f,
                             int64_t *units, int *scale);

void bta_locale_cleanup(void);
/*
 * The catalogue's version of `msgid`, or NULL when there is no catalogue or no
 * entry for it.  `ctxt` disambiguates a word that is not translated the same
 * way twice (gettext's msgctxt); NULL for none.
 *
 * The caller does not own the result: it lives in the catalogue.
 */
const char *bta_locale_lookup(const char *ctxt, const char *msgid);
/* `{0}`, `{1}`... replaced by argv[0..].  Positional and not `%s`, because a
 * translator has to be able to reorder them.  Always a fresh string. */
char *bta_locale_format(JSContext *ctx, const char *text,
                        int argc, JSValueConst *argv);

/* --- .form loader ------------------------------------------------------- */
/* Reads <project>/<class_name>.form and populates `form_obj` with the widget
 * tree, wiring each control to its Name_Event handlers. */
int bta_form_build(JSContext *ctx, JSValueConst form_obj, const char *class_name);

/*
 * Platform log backends.  The runtime logs to stdout and stderr on its own;
 * these are what a system that has something better offers instead, and a build
 * without one answers false and is none the worse for it.  Levels are the
 * runtime's own order: 0 Debug, 1 Info, 2 Warning, 3 Error.
 */
bool bta_journal_available(void);
bool bta_journal_send(int level, const char *text);

#endif /* BTA_H */
