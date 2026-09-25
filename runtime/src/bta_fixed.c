/*
 * The RAD surface: absolute coordinates that survive a resize.
 *
 * GtkFixed places its children once and stops there, so a form drawn at
 * 420x260 keeps every control exactly where it was put when the window grows.
 * That is the whole of the complaint this file answers.
 *
 * Saying what "resize" means is a supported thing for a GTK4 widget to do --
 * measure() and size_allocate() are the same two vfuncs every layout in the
 * library is written with -- and doing it ourselves is what lets each child
 * declare the answer with HAlign/VAlign:
 *
 *   Start   keep the distance to the left/top edge       (the default: no move)
 *   End     keep the distance to the right/bottom edge   (slides)
 *   Fill    keep both                                    (stretches)
 *   Center  keep the proportion                          (moves half the slack)
 *
 * Those are GTK's four words, and they are the four cases WinForms spells as
 * Anchor. Using them here rather than a flag set is what keeps the property a
 * single value: one drop-down in the designer's grid, no bespoke editor.
 *
 * Positions come from each child's own BtaWidget (x/y/w/h), which was already
 * the authority -- GtkFixed's per-child layout data only ever mirrored it.
 * Not keeping that second copy is why Raise/Lower is an ordinary sibling
 * reorder here, instead of taking every child out and putting it back.
 */
/*
 * **The layout is a GtkLayoutManager and the widget is a widget**, which is
 * GTK4's own division and not a refactoring for its own sake.
 *
 * What a container *is* and how it arranges its children are two questions, and
 * keeping them apart is what lets one widget answer the second one differently
 * over its life: `Arrangement` swaps the manager and the widget -- with its CSS
 * node, its handlers, its place among its siblings and everything hanging off it
 * -- stays exactly where it was. A `Panel` used to be two boxes for want of
 * this, an outer one that stayed put and an inner one that got replaced, and the
 * outer one is where a theme class then landed: `Style = "linked"` did nothing at
 * all, because Adwaita's rule is `.linked:not(.vertical) > button` and the
 * buttons were one box further in.
 *
 * `measure` and `allocate` are the manager's, verbatim what they were as widget
 * vfuncs. `focus` cannot be: it is a `GtkWidget` vfunc, and it is what carries
 * out `TabIndex` -- so the surface stays a widget of ours rather than becoming a
 * plain GtkWidget with a manager bolted on.
 */
#include "bta.h"

#define BTA_TYPE_FIXED_LAYOUT (bta_fixed_layout_get_type())
G_DECLARE_FINAL_TYPE(BtaFixedLayout, bta_fixed_layout, BTA, FIXED_LAYOUT,
                     GtkLayoutManager)

struct _BtaFixedLayout {
    GtkLayoutManager parent_instance;

    /* The size the coordinates were written against. Latched from the first
     * real allocation: at that moment nothing has moved yet, so it is the
     * origin every anchor is measured from. */
    int design_w, design_h;

    /* Off for a surface that is a drawing board rather than a window: every
     * child sits exactly where it was drawn, whatever size this grew to. */
    bool anchored;
};

G_DEFINE_FINAL_TYPE(BtaFixedLayout, bta_fixed_layout, GTK_TYPE_LAYOUT_MANAGER)

struct _BtaFixed {
    GtkWidget parent_instance;
};

G_DEFINE_TYPE(BtaFixed, bta_fixed, GTK_TYPE_WIDGET)

/* The layout of a surface, or NULL when that widget is arranged some other way.
 * Every reader below goes through it, so a widget whose manager has been swapped
 * for a box's answers honestly rather than reporting a stale design size. */
static BtaFixedLayout *layout_of(GtkWidget *widget)
{
    GtkLayoutManager *lm = widget ? gtk_widget_get_layout_manager(widget) : NULL;
    return lm && BTA_IS_FIXED_LAYOUT(lm) ? BTA_FIXED_LAYOUT(lm) : NULL;
}

/*
 * A fixed surface asks for enough room to hold every child at its own
 * coordinates: the bounding box, the way GtkFixed reported it.
 *
 * What each child contributes is its *floor*, not the size it was drawn at,
 * and the difference only shows on a stretched one -- its request is already
 * its floor rather than its drawn size (see bta_widget_relayout), so nothing
 * here has to know which is which. That is what keeps a window with a
 * stretching control in it from having its design size as a hard minimum.
 */
static void bta_fixed_layout_measure(GtkLayoutManager *manager, GtkWidget *widget,
                                     GtkOrientation orientation,
                                     int for_size, int *minimum, int *natural,
                                     int *min_baseline, int *nat_baseline)
{
    BtaFixedLayout *self = BTA_FIXED_LAYOUT(manager);
    bool      horiz = orientation == GTK_ORIENTATION_HORIZONTAL;
    int       design = horiz ? self->design_w : self->design_h;
    int       wanted = 0;

    /*
     * Whether this surface is a window's own, which decides one term below.
     *
     * The same limit the design size is latched under, for the same reason: a
     * window's size is nobody else's business, and a `Panel`'s is its parent's.
     */
    BtaWidget *own     = g_object_get_data(G_OBJECT(widget), BTA_WIDGET_QUARK);
    bool       is_form = own && own->is_form;

    for (GtkWidget *c = gtk_widget_get_first_child(widget); c;
         c = gtk_widget_get_next_sibling(c)) {

        if (!gtk_widget_should_layout(c))
            continue;

        int child_min = 0;
        gtk_widget_measure(c, orientation, -1, &child_min, NULL, NULL, NULL);

        BtaWidget *cw  = g_object_get_data(G_OBJECT(c), BTA_WIDGET_QUARK);
        int offset     = !cw ? 0 : (horiz ? cw->x : cw->y);
        int declared   = !cw ? 0 : (horiz ? cw->w : cw->h);
        BtaAlign align = !cw ? BTA_ALIGN_START : (horiz ? cw->halign : cw->valign);

        /*
         * A stretched control was drawn with a gap on the far side too, and
         * `Fill` is the promise to keep *both*. So the room it needs is its own
         * minimum plus that gap -- otherwise a control whose text outgrew its
         * declared width pushes the surface out by exactly its own growth and
         * ends up flush against the edge, while every control beside it keeps
         * the margin. That is the IDE's own "New translation" dialog: the label
         * that did the pushing was the one with no margin left.
         *
         * Only once the design size is known, which is after the first
         * allocation -- latching it queues a resize so this runs again with the
         * answer. And only for `Fill`: nothing is promised about the far edge of
         * a control anchored `Start`, and adding its trailing gap would grow the
         * surface by the whole width of the margin it was drawn inside.
         *
         * **And only on a form's own surface**, which is the same limit the
         * design size is latched under and the same reason. A gap is a thing to
         * *keep* and not a floor: on a window it has to reach the minimum,
         * because a window opens at the size it declared and nothing above it
         * will make room. A `Panel` has a parent that decides its size, and its
         * declared width is a minimum rather than a size -- so counting the far
         * margin of a stretched child into what the panel may not be squeezed
         * below is how a form drawn 200 wide refuses to be shown at 180, with a
         * `Fill` control that would have given the room back happily.
         *
         * That was invisible while a `Panel` was two boxes: the outer one had the
         * size request and the surface inside it was squeezed past its own
         * minimum, so the term did nothing here and nobody was any the wiser.
         */
        if (is_form && align == BTA_ALIGN_FILL && design > 0 && declared > 0) {
            /*
             * A *gap*, so never negative. It comes out negative for a control
             * drawn past the edge of the surface it is on, which a `.form` can
             * say and which the fault above used to manufacture -- and adding a
             * negative number here would ask the window to be smaller than its
             * own contents. Nothing is owed to the far side of a control that
             * has already run off it.
             */
            int trailing = design - (offset + declared);
            if (trailing > 0)
                child_min += trailing;
        }

        wanted = MAX(wanted, offset + child_min);
    }

    *minimum = *natural = wanted;
    *min_baseline = *nat_baseline = -1;
}

/*
 * One axis of the anchor rule.
 *
 * `pos` comes in as the coordinate the .form drew and goes out as where the
 * control really goes; `declared` is the size the .form asked for (0 when it
 * asked for none); `slack` is how much bigger the surface is now than when
 * those numbers were written; `floor` is the child's own measured minimum.
 *
 * **The anchor is applied to the *design* rect, and the floor is honoured
 * afterwards.** That order is the whole of it, and getting it the other way
 * round is a real bug rather than a nicety: a control whose text outgrew its
 * declared width would otherwise start from the grown size *and* take the whole
 * slack on top, counting its own growth twice and ending up past the edge it is
 * anchored to. Translation is what makes a control outgrow its declared width,
 * so this only ever showed once there were catalogues.
 *
 * And the floor grows **away from the edge the control is anchored to**, so the
 * gap the anchor promises to keep is the one that is kept.
 */
static void anchor_axis(BtaAlign align, int slack, int declared, int floor,
                        int *pos, int *size)
{
    *size = declared > 0 ? declared : floor;

    switch (align) {
    case BTA_ALIGN_END:    *pos  += slack;      break;
    case BTA_ALIGN_CENTER: *pos  += slack / 2;  break;
    case BTA_ALIGN_FILL:   *size += slack;      break;
    /* Nothing asked for is "stay where it was drawn", which is what every form
     * did before there was a choice. */
    case BTA_ALIGN_AUTO:
    case BTA_ALIGN_START:  break;
    }

    if (*size < floor) {
        int growth = floor - *size;

        if (align == BTA_ALIGN_END)         *pos -= growth;
        else if (align == BTA_ALIGN_CENTER) *pos -= growth / 2;

        *size = floor;
    }
}

static void bta_fixed_layout_allocate(GtkLayoutManager *manager, GtkWidget *widget,
                                      int width, int height, int baseline)
{
    BtaFixedLayout *self = BTA_FIXED_LAYOUT(manager);

    /*
     * The size the coordinates were written against.
     *
     * Normally the first real allocation, because at that moment nothing has
     * moved yet. **A form is the exception**, and it is the one that matters: a
     * window's declared `Width`/`Height` *are* the numbers every coordinate in
     * its `.form` was measured from, and a control whose text outgrew its
     * declared width makes the window open wider than that. Latching the wider
     * size would make the design size whatever the translation happened to
     * need, so every anchor would be inert and the extra room would sit dead
     * against the far edge -- an input that never stretches, buttons that never
     * reach the corner.
     *
     * **Only a form**, and that limit is the rule this codebase already states:
     * a `Width` inside a box is a *minimum*, not a size, so a `Panel` arranged
     * `Fixed` that a box stretched to 280 has no business calling its declared
     * 60 the design. A window's size is nobody else's business, which is what
     * makes its declaration authoritative.
     *
     * Capped by the allocation **on the height and not on the width**, and the
     * asymmetry is the whole of the fix rather than an oversight: a form's own
     * height covers its menu bar and the slot's does not, so vertically the
     * slot's first allocation is the smaller of the two and is the right answer.
     * There is no such thing horizontally -- nothing sits beside the slot -- so
     * the only way the first allocation comes out *narrower* than the
     * declaration is that the window was opened smaller than the form was drawn
     * at, and capping to that is exactly wrong.
     *
     * It cost a window with its buttons off the right edge. A form declared 760
     * wide restored a remembered 680 before it was shown, so this latched 680,
     * and a strip drawn at `12..748` then had a trailing gap of **minus 68** --
     * which `Fill` faithfully kept at every size afterwards, so the strip was 68
     * pixels wider than its window whether that window was 680 or maximised to
     * 1920. Every anchored control in every form opened narrower than it was
     * drawn had the same fault; restoring a size is only the commonest way to
     * arrive at one.
     *
     * The declaration is what the coordinates in the file were measured against.
     * That is true whichever size the window happens to open at, which is what
     * makes it the design size and not the allocation.
     *
     * Guarded against the degenerate first pass GTK sometimes makes before a
     * window has a real size: latching 1x1 would send every anchored control
     * flying on the next frame.
     */
    if (self->design_w <= 0 && width > 1 && height > 1) {
        BtaWidget *own = g_object_get_data(G_OBJECT(widget), BTA_WIDGET_QUARK);
        /* `drawn_w`/`drawn_h` and **not** `w`/`h`: the second pair is the size
         * the window is now, which `Resize` writes, and a form that restores a
         * remembered size has already changed it by the time this runs. */
        bool       declared = own && own->is_form;

        /*
         * The `.form`'s size when there was a `.form`, and the size code gave it
         * otherwise -- and the fallback is not a compromise. A form built from
         * code has no file of coordinates to protect, so the `Resize` before it
         * was shown *is* its declaration; a form with a file has one, and the
         * file's numbers keep meaning what they meant however the window is
         * resized afterwards.
         */
        int dw = own && own->drawn_w > 0 ? own->drawn_w : (own ? own->w : 0);
        int dh = own && own->drawn_h > 0 ? own->drawn_h : (own ? own->h : 0);

        /*
         * **The declared height, less what the window puts above the surface
         * and around it** -- a menu bar, and a form's `Margin` -- and not
         * `MIN(dh, height)`, which was that subtraction guessed from the
         * allocation. The guess is right only when the window opens at the
         * size it declares: a form declared 400 tall and opened at 300 (a
         * remembered size, a `Resize` in `Form_Open`) latched 300 as its
         * design, and a `Fill` panel drawn 380 tall inside it kept its
         * negative gap at every size after -- 560 tall in a 480 window,
         * measured. What is subtracted is read off the widgets, so it is the
         * same number whatever size the window happens to be.
         */
        int chrome = gtk_widget_get_margin_top(widget) +
                     gtk_widget_get_margin_bottom(widget);
        GtkWidget *holder = gtk_widget_get_parent(widget);

        if (holder && !GTK_IS_WINDOW(holder)) {
            for (GtkWidget *c = gtk_widget_get_first_child(holder); c;
                 c = gtk_widget_get_next_sibling(c))
                if (c != widget && gtk_widget_get_visible(c))
                    chrome += gtk_widget_get_height(c);
        }

        self->design_w = (declared && dw > 0) ? dw : width;
        self->design_h = (declared && dh > 0) ? MAX(dh - chrome, 1) : height;

        /*
         * Measuring needs the design size to know what gap a stretched control
         * was drawn with on its far side, and until this moment there was none
         * to have. So the first pass measured without it; ask for another now
         * that there is one.
         *
         * Only when it turns out to differ from what was allocated, which is
         * only on a form whose contents pushed it past what it declared -- every
         * other surface latches exactly what it was given and has nothing to
         * reconsider.
         */
        if (self->design_w != width || self->design_h != height)
            gtk_widget_queue_resize(widget);
    }

    /* No slack means no anchor does anything, which is the whole of what
     * turning anchoring off has to mean. */
    int dx = (self->anchored && self->design_w > 0) ? width  - self->design_w : 0;
    int dy = (self->anchored && self->design_h > 0) ? height - self->design_h : 0;

    for (GtkWidget *c = gtk_widget_get_first_child(widget); c;
         c = gtk_widget_get_next_sibling(c)) {

        if (!gtk_widget_should_layout(c))
            continue;

        BtaWidget *cw = g_object_get_data(G_OBJECT(c), BTA_WIDGET_QUARK);

        /*
         * Two numbers per axis, and the difference between them is the point:
         *
         *  - the *design* size is what the .form drew, and is what the gaps an
         *    anchor keeps were measured from;
         *  - the *floor* is what the control may not be squeezed below --
         *    MinWidth/MinHeight when it declares one, and what GTK says it
         *    needs when it does not.
         *
         * They are the same on an axis that does not stretch, because there
         * the drawn size *is* the request (see bta_widget_relayout). On one
         * that does, keeping them apart is what lets a window be made smaller
         * than the form was designed at.
         */
        int floor_w = 0;
        gtk_widget_measure(c, GTK_ORIENTATION_HORIZONTAL, -1,
                           &floor_w, NULL, NULL, NULL);

        GtkAllocation a = { cw ? cw->x : 0, cw ? cw->y : 0, 0, 0 };
        anchor_axis(cw ? cw->halign : BTA_ALIGN_START, dx,
                    cw ? cw->w : 0, floor_w, &a.x, &a.width);

        /* Height for the width it actually got: a wrapped Label needs fewer
         * lines once stretching has made it wider. */
        int floor_h = 0;
        gtk_widget_measure(c, GTK_ORIENTATION_VERTICAL, a.width,
                           &floor_h, NULL, NULL, NULL);

        anchor_axis(cw ? cw->valign : BTA_ALIGN_START, dy,
                    cw ? cw->h : 0, floor_h, &a.y, &a.height);

        gtk_widget_size_allocate(c, &a, -1);
    }
}

/* GTK4 insists a widget unparents its children itself. */
static void bta_fixed_dispose(GObject *object)
{
    GtkWidget *child;
    while ((child = gtk_widget_get_first_child(GTK_WIDGET(object))))
        gtk_widget_unparent(child);

    G_OBJECT_CLASS(bta_fixed_parent_class)->dispose(object);
}

/*
 * Tab order.
 *
 * GTK4 walks the focus in child-list order and **removed GtkContainer's focus
 * chain**, so on a surface the order controls were drawn in *is* the order Tab
 * takes them in -- and that list is already spoken for: children paint in it,
 * which is exactly what `Raise`/`Lower` say. One list cannot be both orders,
 * which is why VB, Delphi and Gambas all keep ZOrder and TabIndex apart.
 *
 * So the order is declared per child (`Widget.TabIndex`) and this is where it is
 * carried out. `focus` is the supported place for a GTK4 widget to say what its
 * focus order is -- the same standing `measure` and `size_allocate` have in this
 * file -- and choosing it over intercepting the key is what keeps the rest
 * working: a focused editor or `Terminal` takes Tab for indentation and
 * shell completion long before GTK asks a container for the next target, so
 * neither has to be special-cased here or anywhere.
 *
 * Only the two Tab directions. The arrows are GTK's *spatial* navigation, and
 * `TabIndex` says nothing about where a control sits.
 */
typedef struct { GtkWidget *child; int index, seq; } TabStop;

static int tab_stop_cmp(const void *a, const void *b)
{
    const TabStop *x = a, *y = b;
    if (x->index != y->index)
        return x->index - y->index;
    /* The declared order is sparse, so ties are the common case rather than the
     * exception: a surface where nothing was declared is all zeroes, and this is
     * what makes it come out in the order it was drawn. */
    return x->seq - y->seq;
}

/* Whether asking this child again can lead anywhere: only a container has
 * somewhere further inside to go. */
static bool tab_stop_is_container(GtkWidget *child)
{
    BtaWidget *cw = bta_slot_child(child);
    return cw && cw->slot;
}

static gboolean bta_fixed_focus(GtkWidget *widget, GtkDirectionType direction)
{
    if (direction != GTK_DIR_TAB_FORWARD && direction != GTK_DIR_TAB_BACKWARD)
        return GTK_WIDGET_CLASS(bta_fixed_parent_class)->focus(widget, direction);

    GArray *stops = g_array_new(FALSE, FALSE, sizeof(TabStop));
    int     seq   = 0;

    for (GtkWidget *c = gtk_widget_get_first_child(widget);
         c; c = gtk_widget_get_next_sibling(c)) {
        /*
         * **A popover is not a stop**, and leaving it out of the list is also
         * what keeps the walk from starting in the wrong place: GTK sets the
         * surface's `focus_child` to the popover while it is open, and a closed
         * one goes on naming it -- so the walk began *after* the popover it
         * could not focus and found nothing left, and `FocusNext()` answered
         * `false` on a form full of focusable controls. Its content is modal
         * while the popover is up, and the program puts the focus where it
         * wants when it comes down.
         */
        if (GTK_IS_POPOVER(c))
            continue;

        BtaWidget *cw = bta_slot_child(c);
        TabStop    s  = { c, cw ? cw->tab_index : 0, seq++ };
        g_array_append_val(stops, s);
    }
    g_array_sort(stops, tab_stop_cmp);

    /* Where we are now: GTK keeps the direct child that holds the focus. */
    GtkWidget *cur   = gtk_widget_get_focus_child(widget);
    guint      start = 0;
    bool       found = false;

    for (guint i = 0; !found && i < stops->len; i++)
        if (g_array_index(stops, TabStop, i).child == cur)
            start = i, found = true;

    /*
     * `gtk_widget_child_focus` is the primitive GTK's own default is built on:
     * it refuses what is hidden or insensitive and recurses into what is a
     * container, so neither has to be decided here.
     *
     * **The child that already holds the focus is asked again only if it is a
     * container**, and that is not an optimisation. A container may have
     * somewhere further to go inside, and skipping it would jump the remaining
     * fields of a panel. But a *leaf* that already has the focus answers **true**
     * to being asked -- it takes the focus it already has -- so the walk stops on
     * the control it started from and nothing moves, while the return value says
     * something did. Three assertions read exactly like a broken sort order.
     */
    bool moved = false;

    if (direction == GTK_DIR_TAB_FORWARD) {
        for (guint i = found ? start : 0; !moved && i < stops->len; i++) {
            GtkWidget *c = g_array_index(stops, TabStop, i).child;
            if (i == start && found && !tab_stop_is_container(c))
                continue;
            moved = gtk_widget_child_focus(c, direction);
        }
    } else {
        for (int i = found ? (int)start : (int)stops->len - 1; !moved && i >= 0; i--) {
            GtkWidget *c = g_array_index(stops, TabStop, i).child;
            if (i == (int)start && found && !tab_stop_is_container(c))
                continue;
            moved = gtk_widget_child_focus(c, direction);
        }
    }

    g_array_unref(stops);

    /* False means the focus leaves this surface, which is the answer that lets
     * Tab walk out of a panel and on to whatever is beside it. */
    return moved;
}

static void bta_fixed_layout_class_init(BtaFixedLayoutClass *klass)
{
    GtkLayoutManagerClass *lm = GTK_LAYOUT_MANAGER_CLASS(klass);

    lm->measure  = bta_fixed_layout_measure;
    lm->allocate = bta_fixed_layout_allocate;
}

static void bta_fixed_layout_init(BtaFixedLayout *self)
{
    self->design_w = 0;
    self->design_h = 0;
    self->anchored = TRUE;
}

GtkLayoutManager *bta_fixed_layout_new(void)
{
    return g_object_new(BTA_TYPE_FIXED_LAYOUT, NULL);
}

/*
 * What a surface does with its children **right now**.
 *
 * `BTA_IS_FIXED` says the widget is one of ours, which is the question
 * `Arrangement` asks: only a surface of ours can be re-arranged. These two say
 * which arrangement it is wearing, and that is a different question -- the same
 * widget answers `Fixed` in the morning and `Horizontal` in the afternoon, which
 * is the whole point of the manager being swappable. Anything that is not one of
 * our surfaces answers false to both.
 */
bool bta_surface_is_fixed(GtkWidget *widget)
{
    return layout_of(widget) != NULL;
}

bool bta_surface_is_box(GtkWidget *widget)
{
    if (!widget || !BTA_IS_FIXED(widget))
        return false;
    return GTK_IS_BOX_LAYOUT(gtk_widget_get_layout_manager(widget));
}

static void bta_fixed_class_init(BtaFixedClass *klass)
{
    GObjectClass   *object_class = G_OBJECT_CLASS(klass);
    GtkWidgetClass *widget_class = GTK_WIDGET_CLASS(klass);

    object_class->dispose = bta_fixed_dispose;
    widget_class->focus   = bta_fixed_focus;

    /* Measuring and allocating are the manager's; GtkWidget's own vfuncs
     * delegate to it, so there is nothing to override here any more. */
    gtk_widget_class_set_layout_manager_type(widget_class, BTA_TYPE_FIXED_LAYOUT);

    /* Themes address a plain surface as "fixed"; keeping the name means a
     * stylesheet that reached ours before still does. */
    gtk_widget_class_set_css_name(widget_class, "fixed");
}

static void bta_fixed_init(BtaFixed *self)
{
}

GtkWidget *bta_fixed_new(void)
{
    return g_object_new(BTA_TYPE_FIXED, NULL);
}

/*
 * Anchoring is the layout's, so these ask the widget's manager rather than the
 * widget: a surface whose `Arrangement` made it a box has no anchoring to speak
 * of, and answering `true` for it -- the default -- is the honest reading of
 * "do the children follow a resize", since in a box they always do.
 */
void bta_fixed_set_anchored(GtkWidget *fixed, bool on)
{
    BtaFixedLayout *layout = layout_of(fixed);

    if (!layout || layout->anchored == on)
        return;
    layout->anchored = on;
    gtk_widget_queue_allocate(fixed);
}

bool bta_fixed_get_anchored(GtkWidget *fixed)
{
    BtaFixedLayout *layout = layout_of(fixed);
    return layout ? layout->anchored : true;
}
