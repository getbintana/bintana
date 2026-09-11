/*
 * Elastic containers.
 *
 * The RAD model is absolute coordinates in a GtkFixed, which is right for
 * forms a user draws.  An application window that has to survive being
 * resized -- the IDE, for one -- needs boxes and splitters instead, so both
 * kinds of container coexist and bta_container_attach() packs into whichever
 * it is handed.
 */
#include "bta.h"

#include <math.h>        /* isfinite, for the ratio a string may carry */

/* ------------------------------------------------------------------ Split */

/*
 * Which way a Split is split.  Spelled Arrangement, like every other container:
 * one word for one question.  A Split has no Fixed to offer -- two halves and a
 * divider is what it is -- so it declares only the two it takes, and the
 * designer's grid offers exactly those.
 */
static JSValue split_get_arrangement(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx,
        gtk_orientable_get_orientation(GTK_ORIENTABLE(w->gtk))
            == GTK_ORIENTATION_HORIZONTAL ? "Horizontal" : "Vertical");
}

static JSValue split_set_arrangement(JSContext *ctx, JSValueConst this_val,
                                     JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkOrientation want;
    if (!g_ascii_strcasecmp(s, "Horizontal"))    want = GTK_ORIENTATION_HORIZONTAL;
    else if (!g_ascii_strcasecmp(s, "Vertical")) want = GTK_ORIENTATION_VERTICAL;
    else {
        JSValue e = JS_ThrowRangeError(ctx,
            "a Split is arranged Horizontal or Vertical, not '%s'", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    /* Free, and it keeps both halves: the whole point of the property being a
     * value rather than a choice of class. */
    gtk_orientable_set_orientation(GTK_ORIENTABLE(w->gtk), want);
    return JS_UNDEFINED;
}

static void build_split(BtaWidget *w)
{
    w->gtk  = gtk_paned_new(GTK_ORIENTATION_HORIZONTAL);
    w->slot = w->gtk;

    /*
     * Neither half may be squeezed below what it needs, which GTK's own default
     * allows and this runtime does not agree with anywhere else: a `Fixed`
     * surface keeps a floor under every child for exactly this reason, and a box
     * refuses to go under the sum of its children.
     *
     * Left as GTK has it, a split reports a minimum of nothing -- so a window
     * holding one can be dragged smaller than its own contents, and what happens
     * then is not clipping but *overlap*: the halves keep the size they need and
     * are drawn over each other and over whatever is beside them. The catalogue
     * editor made 760x200 and came out with its buttons across its own list.
     *
     * The divider can still be dragged the whole way; what it cannot do any more
     * is take room that is not there.
     */
    gtk_paned_set_shrink_start_child(GTK_PANED(w->gtk), FALSE);
    gtk_paned_set_shrink_end_child(GTK_PANED(w->gtk), FALSE);
}

static JSValue split_get_position(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, gtk_paned_get_position(GTK_PANED(w->gtk)));
}

static JSValue split_set_position(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Position", &n))
        return JS_EXCEPTION;
    gtk_paned_set_position(GTK_PANED(w->gtk), n);
    return JS_UNDEFINED;
}

/*
 * Which half takes the room when the window grows.
 *
 * `Position` says where the divider is *now*; this says what happens to it when
 * there is more space than there was, and without it a split could only be
 * drawn -- every layout where one side is a fixed sidebar and the other is the
 * work had to be got by luck or by moving the divider from code on every
 * resize.
 *
 * One enum rather than GTK's two booleans, because the four combinations have
 * names one already thinks in: the *sidebar* case is "the other one grows".
 *
 * **And it is `Grows` and not `Resize`**, which was the first name and lasted
 * one test run: `Widget.Resize(w, h)` is a *method* every control has, and a
 * property of that name on a subclass shadows it on the prototype -- so
 * `split.Resize(320, 200)` stopped being callable and the designer went down
 * with `cannot read property 'Children' of null`. Check a new name against
 * `bta_widget_base_props` first; it costs nothing and this is the third time.
 * `Neither` pins the divider to where it was put, which is what a pair of
 * panels that are both content wants.
 */
enum { SPLIT_BOTH, SPLIT_START, SPLIT_END, SPLIT_NEITHER };

static const char *const SPLIT_RESIZE[] = { "Both", "Start", "End", "Neither" };

static JSValue split_get_grows(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkPaned *paned = GTK_PANED(w->gtk);
    bool start = gtk_paned_get_resize_start_child(paned);
    bool end   = gtk_paned_get_resize_end_child(paned);

    int which = start && end ? SPLIT_BOTH
              : start        ? SPLIT_START
              : end          ? SPLIT_END
                             : SPLIT_NEITHER;
    return JS_NewString(ctx, SPLIT_RESIZE[which]);
}

static JSValue split_set_grows(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;

    int which = -1;
    for (int i = 0; i < 4; i++)
        if (!g_ascii_strcasecmp(name, SPLIT_RESIZE[i]))
            which = i;

    if (which < 0) {
        JSValue e = JS_ThrowTypeError(ctx,
            "Grows: \"%s\" is not one of Both, Start, End, Neither", name);
        JS_FreeCString(ctx, name);
        return e;
    }
    JS_FreeCString(ctx, name);

    GtkPaned *paned = GTK_PANED(w->gtk);
    gtk_paned_set_resize_start_child(paned, which == SPLIT_BOTH || which == SPLIT_START);
    gtk_paned_set_resize_end_child(paned,   which == SPLIT_BOTH || which == SPLIT_END);
    return JS_UNDEFINED;
}

/* A divider one can aim at: the theme's wide grip rather than the hairline,
 * which on a touchpad is the difference between resizing and clicking. */
static JSValue split_get_wide(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_paned_get_wide_handle(GTK_PANED(w->gtk)));
}

static JSValue split_set_wide(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_paned_set_wide_handle(GTK_PANED(w->gtk), b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry split_props[] = {
    /* Shadows Container's, which offers a Fixed a Split cannot be. */
    JS_CGETSET_DEF("Arrangement", split_get_arrangement, split_set_arrangement),
    JS_CGETSET_DEF("Position",    split_get_position,    split_set_position),
    JS_CGETSET_DEF("Grows",       split_get_grows,       split_set_grows),
    JS_CGETSET_DEF("WideHandle",  split_get_wide,        split_set_wide),
};

static const char *split_options(const char *prop)
{
    if (!strcmp(prop, "Arrangement")) return "Horizontal,Vertical";
    if (!strcmp(prop, "Grows"))       return "Both,Start,End,Neither";
    return NULL;
}

/* -------------------------------------------------------------- Expander
 *
 * A `Frame` that folds: a caption one presses, and everything under it appears
 * or goes away. What it is for is the half of a dialog nobody needs until they
 * do -- the advanced options, the details of an error -- and the reason it is a
 * container and not a `Visible` toggled from code is that the *window* has to
 * know: folding it takes its height back, which a hidden panel inside a fixed
 * surface would not.
 *
 * Its slot is a `BtaFixed`, like a Frame's, so what goes inside still lays out
 * the RAD way.
 */
static void on_expander_toggled(GObject *obj, GParamSpec *pspec, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Toggle", 0, NULL);
}

static void build_expander(BtaWidget *w)
{
    w->gtk  = gtk_expander_new(NULL);
    w->slot = bta_fixed_new();

    gtk_expander_set_child(GTK_EXPANDER(w->gtk), w->slot);

    /* It is the caption that gives the widget its height when folded, so the
     * slot must not ask for room it is not showing. */
    gtk_widget_set_hexpand(w->slot, TRUE);

    g_signal_connect(w->gtk, "notify::expanded",
                     G_CALLBACK(on_expander_toggled), w);
}

static JSValue expander_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = gtk_expander_get_label(GTK_EXPANDER(w->gtk));
    return JS_NewString(ctx, s ? s : "");
}

static JSValue expander_set_text(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    gtk_expander_set_label(GTK_EXPANDER(w->gtk), s);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/*
 * **`Expanded` and not `Expand`**, which is the layout boolean every widget
 * already has -- a property of that name here would shadow it and the two would
 * be told apart by nothing but which class you were looking at. The tree made
 * the same choice for the same reason and calls its method `ExpandNode`.
 */
static JSValue expander_get_open(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_expander_get_expanded(GTK_EXPANDER(w->gtk)));
}

static JSValue expander_set_open(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_expander_set_expanded(GTK_EXPANDER(w->gtk), b);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry expander_props[] = {
    JS_CGETSET_DEF("Text",     expander_get_text, expander_set_text),
    JS_CGETSET_DEF("Expanded", expander_get_open, expander_set_open),
};

/* ----------------------------------------------------------------- Frame */

/* A titled group box: GtkFrame wrapping a GtkFixed, so its contents still lay
 * out the RAD way. */
static void build_frame(BtaWidget *w)
{
    w->gtk  = gtk_frame_new(NULL);
    w->slot = bta_fixed_new();
    gtk_frame_set_child(GTK_FRAME(w->gtk), w->slot);
}

static JSValue frame_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *t = gtk_frame_get_label(GTK_FRAME(w->gtk));
    return JS_NewString(ctx, t ? t : "");
}

static JSValue frame_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    gtk_frame_set_label(GTK_FRAME(w->gtk), *s ? s : NULL);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry frame_props[] = {
    JS_CGETSET_DEF("Text", frame_get_text, frame_set_text),
};

/* --------------------------------------------------------------- Overlay */

/* Stacks children: the first fills the space, the rest float above it. This
 * is how the designer puts a transparent input layer over a live form. */
static void build_overlay(BtaWidget *w)
{
    w->gtk  = gtk_overlay_new();
    w->slot = w->gtk;
}

/* -------------------------------------------------------- AspectFrame */

/*
 * A rectangle of a given proportion, centred in the room there is.
 *
 * What it exists for is not the picture -- `Picture` and `Video` already letter-
 * box inside themselves with `Fit: "Contain"` -- but **the rectangle the picture
 * really occupies**, so that something else can be put on it: a camera's name in
 * the corner of its image, not out on the black beside it. The picture goes in
 * here, an `Overlay` over the picture, and `HAlign`/`VAlign` then mean what they
 * say, with no measuring and no timer.
 *
 * `GtkAspectFrame` and not arithmetic of ours, and the two numbers that decide
 * it were measured (GTK 4.22) rather than assumed:
 *
 *   a child asking 200x100, ratio 16:9   -> the frame's minimum is 200x113
 *   a child asking nothing               -> the frame's minimum is 0x0
 *   ratio 0, i.e. the child's own        -> 200x100, the child's exactly
 *   in a 640x480 box                     -> the child gets 640x360 at (0,60)
 *
 * That `0x0` is the whole reason this is a container and not a size computed in
 * the application: a wall of twenty tiles must not carry twenty minimums. The
 * application that asked for it sized the video widget from code instead, and
 * the largest frame a full screen ever needed became the window's floor.
 *
 * It is **not** a `GtkFrame` -- it descends straight from `GtkWidget` and has no
 * caption -- so `GTK_IS_FRAME` does not catch it and `bta_container_attach` and
 * `bta_container_detach` need a branch each of their own. Its CSS node is
 * `aspectframe`.
 */
static void build_aspect_frame(BtaWidget *w)
{
    /* Centred, and obeying the child until something says otherwise: a frame
     * with no ratio yet must not squeeze what is in it. */
    w->gtk  = gtk_aspect_frame_new(0.5f, 0.5f, 1.0f, TRUE);
    w->slot = w->gtk;
}

/*
 * Ratio: the proportion to keep, as `"16:9"` or as a number, and `0` for the
 * child's own.
 *
 * Two spellings for one property because the number is unreadable and the
 * written ratio is what anybody means: `1.7778` in a property grid is a value
 * nobody recognises, `"16:9"` is the thing itself. `Radius` and `Padding` made
 * the same bargain with their composite strings, and like them this keeps the
 * text it was given so the getter and the `.form` answer with what was written
 * rather than with a rounded reconstruction of it.
 *
 * `0` or `""` is GTK's `obey-child` said once instead of as a second property --
 * the same trade `Scrollbars` makes with GTK's two policies. It is the default,
 * because a frame that does not know the proportion yet has no business
 * imposing one: a stream's shape is known when the server answers, which is
 * after the form is built.
 */
#define ASPECT_RATIO_KEY "bta-ratio"

static bool aspect_parse(JSContext *ctx, JSValueConst val, double *ratio,
                         char **text)
{
    char *given = NULL;

    if (JS_IsNumber(val)) {
        double n = 0;
        if (JS_ToFloat64(ctx, &n, val) < 0)
            return false;
        if (!isfinite(n) || n < 0) {
            JS_ThrowRangeError(ctx, "Ratio must be a positive number, \"16:9\" or 0");
            return false;
        }
        *ratio = n;

        /*
         * `g_ascii_dtostr` and **not** `g_strdup_printf("%g")`: printf writes
         * the decimal separator of the locale, and this machine writes a comma
         * -- so a `Ratio = 1.5` came back `"1,5"`, which is what the `.form`
         * would then carry and what `JSON.parse` would read as nothing. The
         * same fault the QuickJS number patch exists for, one layer up.
         */
        if (n > 0) {
            char buf[G_ASCII_DTOSTR_BUF_SIZE];
            *text = g_strdup(g_ascii_dtostr(buf, sizeof buf, n));
        } else {
            *text = NULL;
        }
        return true;
    }

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return false;
    given = g_strstrip(g_strdup(s));
    JS_FreeCString(ctx, s);

    if (!*given) {                       /* "" is "the child's own", like 0 */
        g_free(given);
        *ratio = 0;
        *text  = NULL;
        return true;
    }

    /* "16:9", and "16/9" for whoever writes it that way. */
    char **parts = g_strsplit_set(given, ":/", -1);
    double num = 0, den = 1;
    bool   ok  = true;

    for (int i = 0; parts[i] && ok; i++) {
        char  *end = NULL;
        double v   = g_ascii_strtod(g_strstrip(parts[i]), &end);

        if (end == parts[i] || (end && *end) || i > 1 || !isfinite(v))
            ok = false;
        else if (i == 0)
            num = v;
        else
            den = v;
    }
    g_strfreev(parts);

    if (!ok || num <= 0 || den <= 0) {
        JS_ThrowRangeError(ctx,
            "Ratio must be a positive number, \"16:9\" or 0, not '%s'", given);
        g_free(given);
        return false;
    }

    *ratio = num / den;
    *text  = given;                      /* as written: "16:9" comes back "16:9" */
    return true;
}

static JSValue aspect_get_ratio(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *text = g_object_get_data(G_OBJECT(w->gtk), ASPECT_RATIO_KEY);
    return JS_NewString(ctx, text ? text : "");
}

static JSValue aspect_set_ratio(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double ratio = 0;
    char  *text  = NULL;
    if (!aspect_parse(ctx, val, &ratio, &text))
        return JS_EXCEPTION;

    GtkAspectFrame *af = GTK_ASPECT_FRAME(w->gtk);

    /* Settable while the program runs, which is the case it was asked for: the
     * proportion arrives with the stream. */
    gtk_aspect_frame_set_obey_child(af, ratio <= 0);
    if (ratio > 0)
        gtk_aspect_frame_set_ratio(af, (float)ratio);

    g_object_set_data_full(G_OBJECT(w->gtk), ASPECT_RATIO_KEY, text, g_free);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry aspect_props[] = {
    JS_CGETSET_DEF("Ratio", aspect_get_ratio, aspect_set_ratio),
};

/* ------------------------------------------------------------------- Flow */

/*
 * A gallery: children laid side by side, wrapping into as many columns as fit.
 *
 * A box makes one line and a grid makes a table; neither reflows.  What a wall
 * of equally sized things wants -- icons to pick from, images, templates -- is
 * to answer the width it is given, and that is what this does.  The IDE's icon
 * chooser is the case that asked for it: hand-rolled out of a row of Panels it
 * stayed ten across in a window twice as wide, wasting half of it.
 *
 * GtkFlowBox wraps each child in a cell of its own, so a child's GTK parent is
 * that cell and not the slot -- bta_slot_child() and bta_container_detach()
 * look through it, exactly as they do for a RowList's rows.
 *
 * Selection is off: this is a layout, and the things in it answer for
 * themselves. It can be turned into a list that selects when something needs
 * one, which is the same bargain every other property here was added under.
 */
/* GtkFlowBox caps a line at seven by default, which for a gallery is not
 * "as many as fit" but "seven".  High enough that the width is what decides,
 * and MaxPerLine is there for whoever wants a shape instead. */
#define FLOW_UNCAPPED 100

/* What a grid is if nobody says: two columns, which is the shape of every
 * label-and-field form there has ever been. */
#define GRID_COLUMNS 2

static void build_flow(BtaWidget *w)
{
    w->inner = gtk_flow_box_new();
    w->slot  = w->inner;

    gtk_flow_box_set_selection_mode(GTK_FLOW_BOX(w->inner), GTK_SELECTION_NONE);
    /* Left to itself a GtkFlowBox stretches its children to share the line.
     * A gallery wants them their own size and the line filled with as many as
     * fit, which is the whole point. */
    gtk_flow_box_set_homogeneous(GTK_FLOW_BOX(w->inner), FALSE);
    gtk_flow_box_set_max_children_per_line(GTK_FLOW_BOX(w->inner), FLOW_UNCAPPED);
    gtk_widget_set_valign(w->inner, GTK_ALIGN_START);

    /*
     * It scrolls itself, the way a RowList does -- a wall of things is long by
     * nature, and a gallery that needed to be put inside something to be
     * scrolled would be a gallery nobody could use without knowing that.
     *
     * A GtkFlowBox is scrollable in its own right, so the scroller takes it
     * directly with no viewport in between.  Never sideways: reflowing to the
     * width is the point, and a horizontal scrollbar would mean it had given up
     * on that.
     */
    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);
}

enum { FLOW_MIN, FLOW_MAX };

/* How many go on a line at least, and at most.  Left alone it fits what it can,
 * which is what reflowing means; saying a maximum is how a gallery is held to a
 * shape when the room would allow more. */
static JSValue flow_get_per_line(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkFlowBox *f = GTK_FLOW_BOX(w->inner);
    return JS_NewInt32(ctx, magic == FLOW_MIN
        ? (int)gtk_flow_box_get_min_children_per_line(f)
        : (int)gtk_flow_box_get_max_children_per_line(f));
}

static JSValue flow_set_per_line(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, magic == FLOW_MIN ? "MinPerLine" : "MaxPerLine", &n))
        return JS_EXCEPTION;
    if (n < 1)
        return JS_ThrowRangeError(ctx, "a line holds at least one child");

    GtkFlowBox *f = GTK_FLOW_BOX(w->inner);
    if (magic == FLOW_MIN) gtk_flow_box_set_min_children_per_line(f, (guint)n);
    else                   gtk_flow_box_set_max_children_per_line(f, (guint)n);
    return JS_UNDEFINED;
}

/* The same two axes a grid has, for the same reason: a gallery whose items touch
 * reads as one block of pictures rather than as several. */
enum { FLOW_ROW_SPACING, FLOW_COL_SPACING, FLOW_HOMOGENEOUS };

static JSValue flow_get_spacing(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkFlowBox *box = GTK_FLOW_BOX(w->slot);
    switch (magic) {
    case FLOW_ROW_SPACING: return JS_NewInt32(ctx, gtk_flow_box_get_row_spacing(box));
    case FLOW_COL_SPACING: return JS_NewInt32(ctx, gtk_flow_box_get_column_spacing(box));
    default:               return JS_NewBool(ctx, gtk_flow_box_get_homogeneous(box));
    }
}

static JSValue flow_set_spacing(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkFlowBox *box = GTK_FLOW_BOX(w->slot);

    if (magic == FLOW_HOMOGENEOUS) {
        int b = JS_ToBool(ctx, val);
        if (b < 0)
            return JS_EXCEPTION;
        gtk_flow_box_set_homogeneous(box, b);
        return JS_UNDEFINED;
    }

    int32_t px;
    if (!bta_to_int(ctx, val,
                    magic == FLOW_ROW_SPACING ? "RowSpacing" : "ColumnSpacing",
                    &px))
        return JS_EXCEPTION;
    if (px < 0)
        return JS_ThrowRangeError(ctx, "spacing cannot be negative");

    if (magic == FLOW_ROW_SPACING) gtk_flow_box_set_row_spacing(box, px);
    else                           gtk_flow_box_set_column_spacing(box, px);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry flow_props[] = {
    JS_CGETSET_MAGIC_DEF("MinPerLine", flow_get_per_line, flow_set_per_line, FLOW_MIN),
    JS_CGETSET_MAGIC_DEF("MaxPerLine", flow_get_per_line, flow_set_per_line, FLOW_MAX),
    JS_CGETSET_MAGIC_DEF("RowSpacing",    flow_get_spacing, flow_set_spacing,
                         FLOW_ROW_SPACING),
    JS_CGETSET_MAGIC_DEF("ColumnSpacing", flow_get_spacing, flow_set_spacing,
                         FLOW_COL_SPACING),
    JS_CGETSET_MAGIC_DEF("Homogeneous",   flow_get_spacing, flow_set_spacing,
                         FLOW_HOMOGENEOUS),
};

/* --------------------------------------------------------------- RowList */

/*
 * A scrolling column of rows, each row a widget of its own.
 *
 * A ListBox holds strings; this holds controls, which is what a property
 * editor, a settings page or a list of results needs: the row is built out of
 * ordinary widgets and GTK gives the scrolling, the row highlight and the
 * keyboard navigation for free.
 *
 * GtkListBox wraps whatever is appended in a GtkListBoxRow of its own, so a
 * child's GTK parent is that row rather than the slot -- bta_slot_child() and
 * bta_container_detach() look through it.
 */
static void on_rowlist_selected(GtkListBox *lb, GtkListBoxRow *row, gpointer user_data)
{
    if (row)
        bta_emit((BtaWidget *)user_data, "Select", 0, NULL);
}

static void on_rowlist_rows_changed(GtkListBox *lb, gpointer user_data)
{
    if (gtk_list_box_get_selection_mode(lb) == GTK_SELECTION_MULTIPLE)
        bta_emit((BtaWidget *)user_data, "Select", 0, NULL);
}

static void on_rowlist_activated(GtkListBox *lb, GtkListBoxRow *row,
                                 gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Activate", 0, NULL);
}

/*
 * Which rows are shown, asked of the application one row at a time.
 *
 * `Filter(control, index)` -- the widget in the row, and where it sits -- whose
 * **return value** is the answer: `false` hides the row, and a form with no
 * handler shows every one of them, which is what every list written before this
 * did. The same shape as `TableView`'s `Data` and `Form_Close`: a handler that is
 * a function of its arguments rather than one that reaches into the widget.
 *
 * **This is what a search box over a list of controls has to be.** The
 * alternative -- and what the IDE's property grid did until this existed -- is to
 * rebuild the rows on every keystroke: forty widgets destroyed and forty built
 * per letter typed, to answer a question GTK was going to ask anyway. GTK asks
 * when a row is added and when `Refilter()` says the answer may have changed, and
 * not on every layout, so a filter is one call per row per edit of the field.
 *
 * **A hidden row is still a row.** `Count` counts it and `Index` numbers by it,
 * because what a filter changes is what is on screen and not what the list holds
 * -- and an index that meant one thing while nothing was typed and another
 * afterwards would make every list that keeps rows and data side by side wrong
 * exactly when someone starts searching.
 *
 * It runs while GTK is laying the list out, so the rule is `Data`'s rule: **a
 * lookup, and nothing that is not a lookup.** Adding or removing rows from in
 * here is asking GTK to walk a list that is being changed under it.
 */
static gboolean rowlist_filter(GtkListBoxRow *row, gpointer user_data)
{
    /*
     * The widget is looked up and not carried: the finaliser clears this tag
     * before it drops the list, so a filter that runs while the thing is being
     * taken apart asks nothing of a freed wrapper.
     */
    BtaWidget *w  = g_object_get_data(G_OBJECT(user_data), BTA_WIDGET_QUARK);
    BtaWidget *cw = w ? bta_slot_child(GTK_WIDGET(row)) : NULL;

    if (!cw)
        return TRUE;

    JSContext *ctx     = w->ctx;
    JSValue    argv[2] = { JS_DupValue(ctx, cw->self),
                           JS_NewInt32(ctx, gtk_list_box_row_get_index(row)) };
    JSValue    r       = bta_emit_on(ctx, w->form, w->name, "Filter", 2, argv);
    /* Nothing answered is not "hide it". */
    gboolean   show    = JS_IsUndefined(r) || JS_ToBool(ctx, r) != 0;

    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
    return show;
}

/*
 * "The answer may have changed": ask again.
 *
 * A method and not something the runtime works out, for the reason every
 * filter in every toolkit is: what a handler answers from -- a search field, a
 * checkbox, the time of day -- is the application's, and nothing here can see it
 * change. This is the whole of the API on this side, and it is `Refilter` and not
 * `Invalidate` because what one wants is the verb, not GTK's word for the cache.
 */
static JSValue rowlist_refilter(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    gtk_list_box_invalidate_filter(GTK_LIST_BOX(w->slot));
    return JS_UNDEFINED;
}

static void build_rowlist(BtaWidget *w)
{
    w->inner = gtk_list_box_new();
    w->slot  = w->inner;
    gtk_list_box_set_selection_mode(GTK_LIST_BOX(w->inner), GTK_SELECTION_SINGLE);
    /* One click is where the highlight goes and two are a decision -- the same
     * default `ListBox` sets, and GTK's own is the other one. */
    gtk_list_box_set_activate_on_single_click(GTK_LIST_BOX(w->inner), FALSE);

    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);

    g_signal_connect(w->inner, "row-selected", G_CALLBACK(on_rowlist_selected), w);
    /* **`row-selected` says nothing in multiple mode** -- GTK reports a set
     * changing through its own signal, and without this `Select` would simply
     * stop firing the moment `MultiSelect` was turned on. `ListBox` connects
     * both for the same reason. */
    g_signal_connect(w->inner, "selected-rows-changed",
                     G_CALLBACK(on_rowlist_rows_changed), w);
    g_signal_connect(w->inner, "row-activated",
                     G_CALLBACK(on_rowlist_activated), w);

    /* Installed once and for good: with no `Filter` handler it answers TRUE for
     * everything, which is a list that filters nothing -- so there is no state
     * here saying whether filtering is "on", and nothing to turn on. */
    gtk_list_box_set_filter_func(GTK_LIST_BOX(w->inner), rowlist_filter,
                                 w->inner, NULL);
}

/* ------------------------------------------------------------- Scroller */

/*
 * A coordinate surface bigger than the room it is given, with scrollbars.
 *
 * Every other container answers "there is not enough room" by making its parent
 * bigger, which is right for a window and wrong for a view onto something whose
 * size is not the window's business.  The IDE's designer is the case that asked
 * for it: a form drawn 1100 wide has to be editable in a 520 wide canvas, and
 * neither pushing the IDE's layout around nor cutting the form off at the edge
 * is an answer -- the first spills over the panel beside it, the second makes
 * half the form unreachable.
 *
 * The slot is an ordinary fixed surface, so X/Y mean here what they mean
 * everywhere, and a GtkViewport in between is what lets it be larger than what
 * is on screen.
 */
static void on_scroller_moved(GtkAdjustment *a, gpointer user_data);

static void build_scroller(BtaWidget *w)
{
    w->slot  = bta_fixed_new();
    w->inner = w->slot;

    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->slot);

    /* The adjustments are not the widget, so the finaliser's sweep over
     * gtk/inner/slot cannot find these handlers: they have to be watched, or
     * they fire into a freed `BtaWidget` after the scroller is gone. */
    GtkAdjustment *h = gtk_scrolled_window_get_hadjustment(GTK_SCROLLED_WINDOW(w->gtk));
    GtkAdjustment *v = gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(w->gtk));

    g_signal_connect(h, "value-changed", G_CALLBACK(on_scroller_moved), w);
    g_signal_connect(v, "value-changed", G_CALLBACK(on_scroller_moved), w);
    bta_widget_watch(w, h);
    bta_widget_watch(w, v);
}

/*
 * Which way it may scroll.
 *
 * One property and not GTK's two policies, because what one wants to say is
 * "this is a list, it grows downwards" -- and `Vertical` says that, while
 * `hscrollbar-policy = never, vscrollbar-policy = automatic` says it twice in
 * the language of the toolkit. The RAD word for this is `ScrollBars` and it has
 * meant exactly these four values since VB.
 *
 * An axis that may not scroll is not a hidden scrollbar: GTK gives the child the
 * width of the view instead of the width it asked for, which is what makes a
 * list of long lines wrap or ellipsize rather than run off the side.
 */
static JSValue scroller_get_bars(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkPolicyType h, v;
    gtk_scrolled_window_get_policy(GTK_SCROLLED_WINDOW(w->gtk), &h, &v);

    bool across = h != GTK_POLICY_NEVER;
    bool down   = v != GTK_POLICY_NEVER;

    return JS_NewString(ctx, across && down ? "Both"
                           : across         ? "Horizontal"
                           : down           ? "Vertical"
                                            : "None");
}

static JSValue scroller_set_bars(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkPolicyType h, v;
    if      (!strcmp(s, "Both"))       { h = GTK_POLICY_AUTOMATIC; v = GTK_POLICY_AUTOMATIC; }
    else if (!strcmp(s, "Horizontal")) { h = GTK_POLICY_AUTOMATIC; v = GTK_POLICY_NEVER;     }
    else if (!strcmp(s, "Vertical"))   { h = GTK_POLICY_NEVER;     v = GTK_POLICY_AUTOMATIC; }
    else if (!strcmp(s, "None"))       { h = GTK_POLICY_NEVER;     v = GTK_POLICY_NEVER;     }
    else {
        JSValue e = JS_ThrowRangeError(ctx, "Scrollbars: '%s' is not Both, "
                                            "Horizontal, Vertical or None", s);
        JS_FreeCString(ctx, s);
        return e;
    }
    JS_FreeCString(ctx, s);

    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk), h, v);
    return JS_UNDEFINED;
}

/*
 * Where it is scrolled to, and how far it can go.
 *
 * A list that remembers where the user was, one that loads another page when
 * they near the bottom, a log pinned to its newest line: none of them was
 * expressible, because the position could not be read, could not be set, and
 * said nothing when it moved.
 *
 * **The maximum is `upper - page_size` and not `upper`.** A `GtkAdjustment`'s
 * upper is the size of the *content*, so scrolling to it would ask for a
 * position where the last screenful is already off the bottom; what a caller
 * means by "the end" is the largest value that still shows something, which is
 * the content minus one view. It is also what makes `ScrollY === ScrollMaxY` the
 * honest test for *am I at the bottom*, which is the whole of infinite scroll.
 */
static GtkAdjustment *scroller_adjustment(BtaWidget *w, bool vertical)
{
    GtkScrolledWindow *sw = GTK_SCROLLED_WINDOW(w->gtk);

    return vertical ? gtk_scrolled_window_get_vadjustment(sw)
                    : gtk_scrolled_window_get_hadjustment(sw);
}

enum { SCROLL_X, SCROLL_Y, SCROLL_MAX_X, SCROLL_MAX_Y };

static JSValue scroller_get_scroll(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkAdjustment *a = scroller_adjustment(w, magic == SCROLL_Y || magic == SCROLL_MAX_Y);
    if (!a)
        return JS_NewInt32(ctx, 0);

    if (magic == SCROLL_X || magic == SCROLL_Y)
        return JS_NewInt32(ctx, (int)(gtk_adjustment_get_value(a) + 0.5));

    double room = gtk_adjustment_get_upper(a) - gtk_adjustment_get_page_size(a);
    return JS_NewInt32(ctx, (int)(room > 0 ? room + 0.5 : 0));
}

/*
 * Setting it clamps rather than refuses, and that is the point of it: `ScrollY =
 * ScrollMaxY` is how a log follows its own tail, and a caller that has just
 * appended a line does not yet know how much taller the content became. A number
 * past the end means *the end*.
 *
 * **The content has to have been laid out for the end to exist.** A row added in
 * this turn has no allocation yet, so the adjustment's upper is still the old
 * one and scrolling to the bottom lands one row short; `Timer.After(0, …)` --
 * the next turn -- is where that belongs, which is the same rule every
 * measurement in this runtime follows.
 */
static JSValue scroller_set_scroll(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double to;
    if (JS_ToFloat64(ctx, &to, val))
        return JS_EXCEPTION;
    if (!isfinite(to))
        return JS_ThrowRangeError(ctx, "%s expects a number of pixels",
                                  magic == SCROLL_Y ? "ScrollY" : "ScrollX");

    GtkAdjustment *a = scroller_adjustment(w, magic == SCROLL_Y);
    if (!a)
        return JS_UNDEFINED;

    double room = gtk_adjustment_get_upper(a) - gtk_adjustment_get_page_size(a);
    if (room < 0)
        room = 0;
    gtk_adjustment_set_value(a, CLAMP(to, 0, room));
    return JS_UNDEFINED;
}

/* Both adjustments report through here, so a diagonal move is one `Scroll` and
 * not two -- GTK moves one axis at a time and the other's value is already the
 * new one by the time either of them says so. */
static void on_scroller_moved(GtkAdjustment *a, gpointer user_data)
{
    BtaWidget *w = user_data;
    GtkAdjustment *h = gtk_scrolled_window_get_hadjustment(GTK_SCROLLED_WINDOW(w->gtk));
    GtkAdjustment *v = gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(w->gtk));

    JSValueConst argv[2] = {
        JS_NewInt32(w->ctx, (int)(gtk_adjustment_get_value(h) + 0.5)),
        JS_NewInt32(w->ctx, (int)(gtk_adjustment_get_value(v) + 0.5)),
    };
    bta_emit(w, "Scroll", 2, argv);
}

static const JSCFunctionListEntry scroller_props[] = {
    JS_CGETSET_DEF("Scrollbars", scroller_get_bars, scroller_set_bars),
    JS_CGETSET_MAGIC_DEF("ScrollX", scroller_get_scroll, scroller_set_scroll, SCROLL_X),
    JS_CGETSET_MAGIC_DEF("ScrollY", scroller_get_scroll, scroller_set_scroll, SCROLL_Y),
    JS_CGETSET_MAGIC_DEF("ScrollMaxX", scroller_get_scroll, NULL, SCROLL_MAX_X),
    JS_CGETSET_MAGIC_DEF("ScrollMaxY", scroller_get_scroll, NULL, SCROLL_MAX_Y),
};

static const char *scroller_options(const char *prop)
{
    return !strcmp(prop, "Scrollbars") ? "Both,Horizontal,Vertical,None" : NULL;
}

static GtkListBoxRow *rowlist_row(BtaWidget *w, int i)
{
    return gtk_list_box_get_row_at_index(GTK_LIST_BOX(w->slot), i);
}

static JSValue rowlist_get_index(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkListBoxRow *row = gtk_list_box_get_selected_row(GTK_LIST_BOX(w->slot));
    return JS_NewInt32(ctx, row ? gtk_list_box_row_get_index(row) : -1);
}

static JSValue rowlist_set_index(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (!bta_to_int(ctx, val, "Index", &i))
        return JS_EXCEPTION;

    GtkListBoxRow *row = i < 0 ? NULL : rowlist_row(w, i);
    if (row)
        gtk_list_box_select_row(GTK_LIST_BOX(w->slot), row);
    else
        gtk_list_box_unselect_all(GTK_LIST_BOX(w->slot));
    return JS_UNDEFINED;
}

static JSValue rowlist_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int n = 0;
    while (rowlist_row(w, n))
        n++;
    return JS_NewInt32(ctx, n);
}

/* ------------------------------------------------------ the list vocabulary
 *
 * A `RowList` is a `GtkListBox`, which is what a `ListBox` is -- the difference
 * between them is what goes in a row, a widget against a string, and nothing
 * else. So the words for *selecting* in one are the words for selecting in the
 * other: `MultiSelect`, `Selection`, `Select`, `Deselect`, `SelectAll`,
 * `DeselectAll`, `Remove`, `Activate` and `ActivateOnSingleClick` are the same
 * members with the same meanings, and this is the same code.
 *
 * They were missing here and nowhere else, which is the only reason this is
 * being written: a program that moved a list from strings to widgets lost half
 * its vocabulary and had to invent replacements for it.
 */

static JSValue rowlist_get_multi(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_list_box_get_selection_mode(GTK_LIST_BOX(w->slot))
                           == GTK_SELECTION_MULTIPLE);
}

static JSValue rowlist_set_multi(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    /* Not NONE for the off case: a list nobody can select in is a different
     * control, and `Index` would stop answering. */
    gtk_list_box_set_selection_mode(GTK_LIST_BOX(w->slot),
                                    b ? GTK_SELECTION_MULTIPLE
                                      : GTK_SELECTION_SINGLE);
    return JS_UNDEFINED;
}

static JSValue rowlist_get_selection(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    JSValue  arr = JS_NewArray(ctx);
    uint32_t k   = 0;

    for (int i = 0; ; i++) {
        GtkListBoxRow *row = rowlist_row(w, i);
        if (!row)
            break;
        if (gtk_list_box_row_is_selected(row))
            JS_SetPropertyUint32(ctx, arr, k++, JS_NewInt32(ctx, i));
    }
    return arr;
}

enum { RL_SELECT, RL_DESELECT };

static JSValue rowlist_select_one(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (argc < 1 || JS_ToInt32(ctx, &i, argv[0]))
        return JS_EXCEPTION;

    GtkListBoxRow *row = i < 0 ? NULL : rowlist_row(w, i);
    if (!row)
        return JS_NewBool(ctx, false);      /* no such row: not an error */

    if (magic == RL_SELECT)
        gtk_list_box_select_row(GTK_LIST_BOX(w->slot), row);
    else
        gtk_list_box_unselect_row(GTK_LIST_BOX(w->slot), row);
    return JS_NewBool(ctx, true);
}

enum { RL_ALL, RL_NONE };

static JSValue rowlist_select_every(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkListBox *lb = GTK_LIST_BOX(w->slot);

    if (magic == RL_NONE) {
        gtk_list_box_unselect_all(lb);
        return JS_UNDEFINED;
    }
    if (gtk_list_box_get_selection_mode(lb) != GTK_SELECTION_MULTIPLE)
        return JS_ThrowTypeError(ctx, "SelectAll needs MultiSelect");

    gtk_list_box_select_all(lb);
    return JS_UNDEFINED;
}

static JSValue rowlist_get_single(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx,
        gtk_list_box_get_activate_on_single_click(GTK_LIST_BOX(w->slot)));
}

static JSValue rowlist_set_single(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;
    gtk_list_box_set_activate_on_single_click(GTK_LIST_BOX(w->slot), b != 0);
    return JS_UNDEFINED;
}

/*
 * `Activate([index])` -- what a double click does, from code.
 *
 * Selected first, because that is what the double click did: `Activate` carries
 * no row of its own, so the handler asks the list which one and the list has to
 * already know. The same shape `ListBox.Activate` has.
 */
static JSValue rowlist_activate(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t index = -1;

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (JS_ToInt32(ctx, &index, argv[0]))
            return JS_EXCEPTION;
    } else {
        GtkListBoxRow *at = gtk_list_box_get_selected_row(GTK_LIST_BOX(w->slot));
        index = at ? gtk_list_box_row_get_index(at) : -1;
    }

    GtkListBoxRow *row = index >= 0 ? rowlist_row(w, index) : NULL;

    /* Nothing there is nothing to choose, and not an error. */
    if (!row)
        return JS_UNDEFINED;

    gtk_list_box_select_row(GTK_LIST_BOX(w->slot), row);
    g_signal_emit_by_name(w->slot, "row-activated", row);
    return JS_UNDEFINED;
}

/*
 * `Remove(index)` -- and it goes through the container, not through GTK.
 *
 * A row here holds a **widget of the application's**, which the container is
 * holding a JS reference to. Unparenting the `GtkListBoxRow` would leave that
 * reference behind and the wrapper alive for as long as the list is, which is
 * the leak `bta_widget_release` exists to prevent -- so what this does is detach
 * the child, and GTK drops the row it was wrapped in.
 */
static JSValue rowlist_remove(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (argc < 1 || JS_ToInt32(ctx, &i, argv[0]))
        return JS_EXCEPTION;

    GtkListBoxRow *row   = i < 0 ? NULL : rowlist_row(w, i);
    BtaWidget     *child = row ? bta_slot_child(GTK_WIDGET(row)) : NULL;

    if (!child)
        return JS_NewBool(ctx, false);
    if (!bta_container_detach(ctx, child))
        return JS_EXCEPTION;
    return JS_NewBool(ctx, true);
}

static const JSCFunctionListEntry rowlist_props[] = {
    JS_CGETSET_DEF("Index", rowlist_get_index, rowlist_set_index),
    JS_CGETSET_DEF("Count", rowlist_get_count, NULL),
    JS_CGETSET_DEF("MultiSelect", rowlist_get_multi,     rowlist_set_multi),
    JS_CGETSET_DEF("Selection",   rowlist_get_selection, NULL),
    JS_CGETSET_DEF("ActivateOnSingleClick",
                   rowlist_get_single, rowlist_set_single),
    JS_CFUNC_DEF("Refilter", 0, rowlist_refilter),
    JS_CFUNC_DEF("Remove",   1, rowlist_remove),
    JS_CFUNC_DEF("Activate", 1, rowlist_activate),
    JS_CFUNC_MAGIC_DEF("Select",      1, rowlist_select_one,   RL_SELECT),
    JS_CFUNC_MAGIC_DEF("Deselect",    1, rowlist_select_one,   RL_DESELECT),
    JS_CFUNC_MAGIC_DEF("SelectAll",   0, rowlist_select_every, RL_ALL),
    JS_CFUNC_MAGIC_DEF("DeselectAll", 0, rowlist_select_every, RL_NONE),
};

/* ---------------------------------------------------------- registration */

/* -------------------------------------------------------------------- Grid
 *
 * Rows and columns whose sizes come from what is in them -- the thing a form
 * drawn in coordinates cannot do, and the reason a caption that grew in
 * translation pushes a dialog out of shape instead of widening a column.
 *
 * **Children flow into it in order**, left to right, wrapping at `Columns`.
 * There is no per-child row and column to fill in: a grid's order *is* its
 * layout, which is what makes it the same thing to add to as a box -- `Add`,
 * `Reorder` and dragging one in the designer all mean what they already meant.
 * `ColumnSpan` is the one exception, for the note that runs the width of the
 * form and the row of buttons that sits under both columns.
 *
 * **And there is no new vocabulary for sizing.** A column is as wide as its
 * widest child needs; a child that says `HExpand` makes its column take the
 * slack; `HAlign` says what it does inside its cell. Those are the words a box
 * already uses and they mean the same here, so a grid is a thing to reach for
 * rather than a thing to learn.
 */

/* Where a child sits, without taking it out. GtkGrid keeps the answer on the
 * layout child, so a reflow is a handful of property writes rather than the
 * remove-and-re-add dance a GtkStack needs -- and nothing has to be referenced
 * across it, because nothing is ever unparented. */
static void grid_place(GtkWidget *grid, GtkWidget *child, int col, int row, int span)
{
    GtkLayoutManager *lm = gtk_widget_get_layout_manager(grid);
    GtkLayoutChild   *lc = lm ? gtk_layout_manager_get_layout_child(lm, child) : NULL;

    if (!lc)
        return;

    GtkGridLayoutChild *gc = GTK_GRID_LAYOUT_CHILD(lc);
    gtk_grid_layout_child_set_column(gc, col);
    gtk_grid_layout_child_set_row(gc, row);
    gtk_grid_layout_child_set_column_span(gc, span);
}

void bta_grid_reflow(GtkWidget *slot)
{
    if (!GTK_IS_GRID(slot))
        return;

    int columns = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(slot), "bta-columns"));
    if (columns < 1)
        columns = 1;

    int col = 0, row = 0;

    for (GtkWidget *c = gtk_widget_get_first_child(slot); c;
         c = gtk_widget_get_next_sibling(c)) {

        BtaWidget *cw   = g_object_get_data(G_OBJECT(c), BTA_WIDGET_QUARK);
        int        span = cw && cw->span > 1 ? cw->span : 1;

        /* A span wider than the grid is the grid's width, not an error: what it
         * means is "all of them", and refusing it would make a note that runs
         * the whole width break the moment a column is added. */
        if (span > columns)
            span = columns;

        /* It does not fit in what is left of this row, so it starts the next
         * one -- which is what a person drawing it would expect, and what keeps
         * a spanning child from being split across two rows. */
        if (col + span > columns) {
            col = 0;
            row++;
        }

        grid_place(slot, c, col, row, span);

        col += span;
        if (col >= columns) {
            col = 0;
            row++;
        }
    }
}

static void build_grid(BtaWidget *w)
{
    w->gtk  = gtk_grid_new();
    w->slot = w->gtk;

    g_object_set_data(G_OBJECT(w->slot), "bta-columns", GINT_TO_POINTER(GRID_COLUMNS));
}

static JSValue grid_get_columns(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int n = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(w->slot), "bta-columns"));
    return JS_NewInt32(ctx, n < 1 ? GRID_COLUMNS : n);
}

static JSValue grid_set_columns(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Columns", &n))
        return JS_EXCEPTION;
    if (n < 1)
        return JS_ThrowRangeError(ctx, "Columns: %d is not a number of columns", n);

    g_object_set_data(G_OBJECT(w->slot), "bta-columns", GINT_TO_POINTER(n));
    bta_grid_reflow(w->slot);
    return JS_UNDEFINED;
}

/*
 * The room between the cells, on each axis.
 *
 * A grid had none at all, which is not a shortcoming one notices until the
 * first form is laid out on one and every control touches its neighbour. A
 * `Panel` has `Spacing` because a box has one axis; a grid has two, so it says
 * which -- and the two names are GTK's own.
 *
 * `Homogeneous` is the other half of what makes a grid a grid: with it on,
 * every column is as wide as the widest and every row as tall as the tallest,
 * which is what a form of labelled fields wants and what a keypad needs. One
 * property rather than GTK's two, because a grid that is even one way and
 * ragged the other is a shape nobody has asked for -- and if somebody does, the
 * two can be split then without moving what this means.
 */
enum { GRID_ROW_SPACING, GRID_COL_SPACING, GRID_HOMOGENEOUS };

static JSValue grid_get_spacing(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkGrid *grid = GTK_GRID(w->slot);
    switch (magic) {
    case GRID_ROW_SPACING: return JS_NewInt32(ctx, gtk_grid_get_row_spacing(grid));
    case GRID_COL_SPACING: return JS_NewInt32(ctx, gtk_grid_get_column_spacing(grid));
    default:
        return JS_NewBool(ctx, gtk_grid_get_row_homogeneous(grid) &&
                               gtk_grid_get_column_homogeneous(grid));
    }
}

static JSValue grid_set_spacing(JSContext *ctx, JSValueConst this_val,
                                JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkGrid *grid = GTK_GRID(w->slot);

    if (magic == GRID_HOMOGENEOUS) {
        int b = JS_ToBool(ctx, val);
        if (b < 0)
            return JS_EXCEPTION;
        gtk_grid_set_row_homogeneous(grid, b);
        gtk_grid_set_column_homogeneous(grid, b);
        return JS_UNDEFINED;
    }

    int32_t px;
    if (!bta_to_int(ctx, val,
                    magic == GRID_ROW_SPACING ? "RowSpacing" : "ColumnSpacing",
                    &px))
        return JS_EXCEPTION;
    if (px < 0)
        return JS_ThrowRangeError(ctx, "spacing cannot be negative");

    if (magic == GRID_ROW_SPACING) gtk_grid_set_row_spacing(grid, px);
    else                           gtk_grid_set_column_spacing(grid, px);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry grid_props[] = {
    JS_CGETSET_DEF("Columns", grid_get_columns, grid_set_columns),
    JS_CGETSET_MAGIC_DEF("RowSpacing",    grid_get_spacing, grid_set_spacing,
                         GRID_ROW_SPACING),
    JS_CGETSET_MAGIC_DEF("ColumnSpacing", grid_get_spacing, grid_set_spacing,
                         GRID_COL_SPACING),
    JS_CGETSET_MAGIC_DEF("Homogeneous",   grid_get_spacing, grid_set_spacing,
                         GRID_HOMOGENEOUS),
};

void bta_layout_register(void)
{
    const BtaClass rows[] = {
        BTA_CLASS_ENUM("Split", "Container", build_split, split_props, false, split_options, NULL),
        /* A frame's Text is the caption drawn into its border. */
        BTA_CLASS_TEXT("Frame",  "Container", build_frame,  frame_props, false, "Text", NULL),
        /* And an expander's is the caption one presses to fold it. */
        BTA_CLASS_TEXT("Expander", "Container", build_expander, expander_props,
                       false, "Text", "Toggle"),
        BTA_CLASS_BARE("Overlay", "Container", build_overlay,            false, NULL),
        /* `Select` first: it is the default event, the one a double click in the
         * designer writes. `Filter` is asked of the form, never raised by it. */
        BTA_CLASS     ("RowList", "Container", build_rowlist, rowlist_props, false,
                       "Select,Activate,Filter"),
        BTA_CLASS_ENUM("Scroller", "Container", build_scroller, scroller_props,
                       false, scroller_options, "Scroll"),
        /* A proportion to keep, and a rectangle for whatever rides on it. */
        BTA_CLASS     ("AspectFrame", "Container", build_aspect_frame,
                       aspect_props, false, NULL),
        BTA_CLASS     ("Flow",     "Container", build_flow,    flow_props,   false, NULL),
        BTA_CLASS     ("Grid",     "Container", build_grid,    grid_props,   false, NULL),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
