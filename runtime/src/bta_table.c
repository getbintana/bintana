/*
 * TableView -- a list with columns, which is the control this widget set was
 * missing and the one every tool in this family has.
 *
 * Named for its sibling: a `TreeView` is one column with disclosure, a
 * `TableView` is many columns without. Two views of a list, two names that say
 * so.
 *
 * `TreeView` is one column of text, `ListBox` is strings, `RowList` is widgets
 * and `Grid` is a layout. None of them is a table, so every program that had
 * rows and fields drew them by hand.
 *
 *   { "type": "Table", "name": "Customers",
 *     "properties": { "Columns": [ { "Text": "Name",  "Width": 200 },
 *                                  { "Text": "Balance", "Width": 90,
 *                                    "Alignment": "Right" } ] } }
 *
 *   this.Customers.Add(["Ana", "10.50"]);
 *
 * Built on GtkColumnView, the same list machinery `TreeView` uses (GtkListView
 * + a selection model + a signal factory), for the same reason: GtkTreeView has
 * been deprecated since 4.10 and a new toolkit should not be founded on it.
 *
 * **A column is declared, not built.** `Columns` is an ordinary array property,
 * so it serialises, the designer's grid edits it, and the headers go through the
 * catalogue -- which is why a column is an object with a `Text` and not a bare
 * string: `Width` and `Alignment` belong to the column and must never be
 * translated, and the only way to say which of them is prose is to name it
 * (`texts = "Columns.Text"`).
 */
#include "bta.h"

#include <string.h>

/* -------------------------------------------------------------------- row */

#define BTA_TYPE_TABLE_ROW (bta_table_row_get_type())
G_DECLARE_FINAL_TYPE(BtaTableRow, bta_table_row, BTA, TABLE_ROW, GObject)

/*
 * A row is one of two things, and `cells` says which.
 *
 *   held      `cells` is the values `Add` was given, and the icons `SetIcon` put
 *             on them: the table owns its data.
 *   virtual   `cells` is NULL and `index` is all there is: the table was told how
 *             many rows there are and asks `Data(row, column)` for each cell as
 *             it is drawn.
 *
 * One type for both because a cell is bound the same way either way -- the
 * factory asks `cell_of` and does not care which kind of row answered.
 */
struct _BtaTableRow {
    GObject    parent_instance;
    GPtrArray *cells;          /* of char*, one per column; NULL when virtual */
    GPtrArray *icons;          /* of char*, lazily made: most rows have none */
    guint      index;          /* virtual rows: which row this is */

    /*
     * A third kind of row: a **node**. `key` is what addresses it -- a tree is
     * addressed by key and not by index, because a position is of the *visible*
     * list and moves when something above it collapses.
     *
     * `parent` is borrowed: the parent's store holds this node, so the parent
     * outlives it. Expanding needs it, because a row only exists once its
     * ancestors are open and the chain has to be walked from the root.
     */
    char        *key;          /* NULL unless this table is a tree */
    GListStore  *children;     /* of BtaTableRow, made with the node */
    BtaTableRow *parent;       /* borrowed; NULL for a root */
};

G_DEFINE_FINAL_TYPE(BtaTableRow, bta_table_row, G_TYPE_OBJECT)

static void bta_table_row_finalize(GObject *object)
{
    BtaTableRow *self = BTA_TABLE_ROW(object);

    g_clear_pointer(&self->icons, g_ptr_array_unref);
    g_clear_pointer(&self->cells, g_ptr_array_unref);
    g_clear_pointer(&self->key, g_free);
    g_clear_object(&self->children);
    G_OBJECT_CLASS(bta_table_row_parent_class)->finalize(object);
}

static void bta_table_row_class_init(BtaTableRowClass *klass)
{
    G_OBJECT_CLASS(klass)->finalize = bta_table_row_finalize;
}

static void bta_table_row_init(BtaTableRow *self)
{
    /* Held by default; the virtual model clears it. */
    self->cells = g_ptr_array_new_with_free_func(g_free);
}

/*
 * A row keeps as many cells as it was given, which need not be as many as there
 * are columns: a row is data and the columns are a view of it. Reading past the
 * end is "" rather than an error, so adding a column does not invalidate every
 * row already in the table.
 */
static const char *row_cell(BtaTableRow *row, guint i)
{
    return row && row->cells && i < row->cells->len ? row->cells->pdata[i] : "";
}

static const char *row_icon(BtaTableRow *row, guint i)
{
    return row && row->icons && i < row->icons->len ? row->icons->pdata[i] : NULL;
}

/* Grows a lazily made list to reach `i`, so a table with one icon on one row
 * does not carry an empty string per cell. */
static void row_pad(GPtrArray **list, guint i)
{
    if (!*list)
        *list = g_ptr_array_new_with_free_func(g_free);
    while ((*list)->len <= i)
        g_ptr_array_add(*list, NULL);
}

/*
 * The sorter GTK is given never reorders anything: it exists to make the header
 * clickable and to carry the arrow. What a click *means* is reported through
 * `Sort` and nothing else -- see `Sortable`.
 */
static int sorter_keeps_order(gconstpointer a, gconstpointer b, gpointer u)
{
    return GTK_ORDERING_EQUAL;
}

/* --------------------------------------------------------- virtual model */

/*
 * A GListModel that holds a count and nothing else.
 *
 * `Count = 100000` is a table of a hundred thousand rows that costs a `guint`:
 * GTK only ever asks for the items it is about to draw, so `get_item` makes a
 * bare row carrying its index and the factory asks the application what belongs
 * in it. That is Gambas' `Data` event and WinForms' `VirtualMode`, and it is the
 * difference between a table that can be backed by a query and one that cannot.
 *
 * A fresh row object per asked-for item rather than a cached one: GTK holds it
 * only while the widget it built is alive, and two visible rows must not be the
 * same object or binding one would rebind the other.
 */
#define BTA_TYPE_TABLE_MODEL (bta_table_model_get_type())
G_DECLARE_FINAL_TYPE(BtaTableModel, bta_table_model, BTA, TABLE_MODEL, GObject)

struct _BtaTableModel {
    GObject parent_instance;
    guint   n;
};

static GType bta_table_model_item_type(GListModel *m)
{
    return BTA_TYPE_TABLE_ROW;
}

static guint bta_table_model_n_items(GListModel *m)
{
    return BTA_TABLE_MODEL(m)->n;
}

static gpointer bta_table_model_item(GListModel *m, guint position)
{
    if (position >= BTA_TABLE_MODEL(m)->n)
        return NULL;

    BtaTableRow *row = g_object_new(BTA_TYPE_TABLE_ROW, NULL);
    g_clear_pointer(&row->cells, g_ptr_array_unref);   /* virtual: no values */
    row->index = position;
    return row;
}

static void bta_table_model_iface(GListModelInterface *iface)
{
    iface->get_item_type = bta_table_model_item_type;
    iface->get_n_items   = bta_table_model_n_items;
    iface->get_item      = bta_table_model_item;
}

G_DEFINE_FINAL_TYPE_WITH_CODE(BtaTableModel, bta_table_model, G_TYPE_OBJECT,
                              G_IMPLEMENT_INTERFACE(G_TYPE_LIST_MODEL,
                                                    bta_table_model_iface))

static void bta_table_model_class_init(BtaTableModelClass *klass) { }
static void bta_table_model_init(BtaTableModel *self) { }

static void table_model_set_count(BtaTableModel *self, guint n)
{
    guint was = self->n;
    self->n = n;
    if (n != was)
        g_list_model_items_changed(G_LIST_MODEL(self), 0, was, n);
}

/* ----------------------------------------------------------------- state */

/*
 * What the widget keeps beyond GTK's own model, hung off the column view.
 *
 * **The declared columns are not in here**, and that is the interesting part.
 * They have to be kept -- the getter must hand back what the `.form` said, and a
 * GtkColumnViewColumn cannot be walked back into a width and an alignment
 * without losing which of them were defaulted.
 *
 * The reason given here for putting them on the *wrapper*, as an own property
 * called `__columns`, was that keeping a `JSValue` in C is a strong reference
 * the collector cannot see, and `JS_FreeRuntime` aborts on anything still alive
 * (`Assertion list_empty(&rt->gc_obj_list) failed`, which is how that was
 * found). True for a value **nobody marks** -- and this class has had a mark
 * function since controls needed to point back at their form. So they are on the
 * widget's own struct now (`w->columns`), reported by `widget_gc_mark` and
 * released by the finalizer, which is what `w->form` and `w->menu` already did.
 *
 * What that buys is in `docs/strict-plan.md`: the note was created **when an
 * application assigned `Columns`**, so it was an own property that appeared at
 * any moment in a program's life, and a widget whose own properties are exactly
 * its properties cannot have one of those.
 */
#define TABLE_STATE_KEY "bta-table-state"

typedef struct {
    GListStore    *rows;       /* held mode: the rows the table owns; tree mode:
                                * the roots */
    BtaTableModel *virt;       /* on-demand mode: a count and nothing else */
    GHashTable    *keys;       /* tree mode: key -> node, borrowed */
    bool           tree;       /* the rows nest, and are addressed by key */
    bool           autoexpand; /* a node comes open when it gains children */
    bool           multi;
    bool           sortable;
    bool           sort_hooked;   /* the view's sorter is being watched */
} TableState;

static void table_state_free(gpointer p)
{
    TableState *st = p;
    g_clear_pointer(&st->keys, g_hash_table_unref);
    g_clear_object(&st->virt);
    g_clear_object(&st->rows);
    g_free(st);
}

static TableState *table_state(BtaWidget *w)
{
    return g_object_get_data(G_OBJECT(w->inner), TABLE_STATE_KEY);
}

/* Puts the view on whichever model is live now, carrying the selection mode and
 * its handler across -- the one place that swap is written. */
static void table_use_model(BtaWidget *w, GListModel *model);

static GtkSelectionModel *table_model(BtaWidget *w)
{
    return gtk_column_view_get_model(GTK_COLUMN_VIEW(w->inner));
}

/* ---------------------------------------------------------------- the tree
 *
 * A table whose rows nest. The pieces are the ones `TreeView` already uses --
 * a `GtkTreeListModel` over a store of roots, and a `GtkTreeExpander` in the
 * first column -- put under the `GtkColumnView` this control already is.
 *
 * **Why here and not columns on `TreeView`.** The column machinery (widths,
 * alignment, headings, the sorter, `Cell`/`SetCell`/`SetIcon`) exists once, in
 * this file. Growing it on the other control would be a second copy of it, and
 * a fact written twice goes stale in one. What that costs is a third *mode*
 * here -- and this control already has modes, with a table of refusals to say
 * so.
 *
 * **And the line between the two controls is GTK's, not ours**: a
 * `GtkColumnView` cannot hide its heading row (there is no `show-header`; the
 * only header call is `set_header_factory`, which is for section headings). So
 * a hierarchy *without* headings is still `TreeView`, and always will be.
 */

/*
 * Always the store, even when it is empty. Returning NULL for a childless node
 * marks it a leaf permanently -- `GtkTreeListModel` asks once, and a child added
 * afterwards would never appear. `Add` takes a parent by key, so a parent is
 * routinely inserted before its children. `on_bind_cell` hides the arrow on the
 * ones that turned out to have nothing under them.
 */
static GListModel *table_child_model(gpointer item, gpointer user_data)
{
    BtaTableRow *node = item;

    /* A row added with `Add(values)` has no children store: it is not a node.
     * That combination is refused where it is written, and answering NULL here
     * is the honest reading of it rather than a crash in GTK's asking. */
    return node->children ? G_LIST_MODEL(g_object_ref(node->children)) : NULL;
}

/* The tree model under the selection, or NULL when this table is not a tree. */
static GtkTreeListModel *table_tree_model(BtaWidget *w)
{
    GtkSelectionModel *sel = table_model(w);

    if (!table_state(w)->tree || !GTK_IS_SINGLE_SELECTION(sel))
        return NULL;
    return GTK_TREE_LIST_MODEL(
        gtk_single_selection_get_model(GTK_SINGLE_SELECTION(sel)));
}

/*
 * The row a node is showing as, or NULL when an ancestor is collapsed and it is
 * therefore not in the flattened list at all. Scanning is the only way: the tree
 * model flattens on demand and has no node-to-row map. It is what `TreeView`
 * does, for the same reason.
 */
static GtkTreeListRow *table_row_of(BtaWidget *w, BtaTableRow *node)
{
    GtkTreeListModel *tree = table_tree_model(w);
    if (!tree)
        return NULL;

    GListModel *model = G_LIST_MODEL(tree);
    guint       n     = g_list_model_get_n_items(model);

    for (guint i = 0; i < n; i++) {
        GtkTreeListRow *row  = g_list_model_get_item(model, i);
        BtaTableRow    *item = row ? gtk_tree_list_row_get_item(row) : NULL;
        bool            hit  = (item == node);

        g_clear_object(&item);
        if (hit)
            return row;                      /* the caller owns it */
        g_clear_object(&row);
    }
    return NULL;
}

static void table_set_expanded(BtaWidget *w, BtaTableRow *node, bool open)
{
    GtkTreeListRow *row = table_row_of(w, node);

    if (!row)
        return;
    gtk_tree_list_row_set_expanded(row, open);
    g_object_unref(row);
}

/* Opens everything between the root and this node, and the node itself when
 * asked. Top down, because each ancestor's row only comes into existence once
 * the one above it is open. */
static void table_reveal(BtaWidget *w, BtaTableRow *node, bool with_node)
{
    GPtrArray *chain = g_ptr_array_new();

    for (BtaTableRow *at = node->parent; at; at = at->parent)
        g_ptr_array_insert(chain, 0, at);

    for (guint i = 0; i < chain->len; i++)
        table_set_expanded(w, chain->pdata[i], true);
    g_ptr_array_free(chain, TRUE);

    if (with_node)
        table_set_expanded(w, node, true);
}

/* The node a key names, or NULL. */
static BtaTableRow *table_node(BtaWidget *w, const char *key)
{
    TableState *st = table_state(w);

    return st->keys ? g_hash_table_lookup(st->keys, key) : NULL;
}

/* The store this node sits in -- its parent's children, or the roots. What
 * `items_changed` has to be told about when one of its cells changes. */
static GListStore *table_store_of(BtaWidget *w, BtaTableRow *node)
{
    return node->parent ? node->parent->children : table_state(w)->rows;
}

/* Where it sits in that store, or -1. Siblings only, so this is short. */
static int table_index_in(GListStore *store, BtaTableRow *node)
{
    guint at = 0;

    return g_list_store_find(store, node, &at) ? (int)at : -1;
}

/* One node's cells changed: tell the store that holds it, which is what makes
 * the visible row rebind. */
static void table_node_changed(BtaWidget *w, BtaTableRow *node)
{
    GListStore *store = table_store_of(w, node);
    int         at    = table_index_in(store, node);

    if (at >= 0)
        g_list_model_items_changed(G_LIST_MODEL(store), (guint)at, 1, 1);
}

/* Every node under this one, and itself, so removing a node takes its subtree
 * out of the key index with it. */
static void table_forget(BtaWidget *w, BtaTableRow *node)
{
    TableState *st = table_state(w);
    GListModel *kids = G_LIST_MODEL(node->children);

    for (guint i = g_list_model_get_n_items(kids); i > 0; i--) {
        BtaTableRow *child = g_list_model_get_item(kids, i - 1);
        table_forget(w, child);
        g_object_unref(child);
    }
    if (st->keys && node->key)
        g_hash_table_remove(st->keys, node->key);
}

/* How many nodes, at every level -- which is what `Count` means for a tree, the
 * same as `TreeView`'s. */
static guint table_node_count(GListModel *store)
{
    guint n = g_list_model_get_n_items(store);
    guint total = n;

    for (guint i = 0; i < n; i++) {
        BtaTableRow *node = g_list_model_get_item(store, i);
        total += table_node_count(G_LIST_MODEL(node->children));
        g_object_unref(node);
    }
    return total;
}

/*
 * The row an argument names -- and **which kind of argument that is depends on
 * the mode**: an index in a flat table, a key in a tree.
 *
 * That is not a convenience; it is the only thing that can be true. A position
 * in a tree is a position in the *visible* list, so it moves when a node above
 * it collapses and means something else a moment later. The key is what the
 * application chose and what stays put.
 *
 * Answers an owned reference, or NULL when there is no such row -- without
 * throwing, because the callers disagree about what a missing row is: `Cell`
 * answers "", `Row` answers null, `SetCell` refuses. `*bad` is the other case:
 * an argument that could not be read at all, with an exception already pending.
 */
static BtaTableRow *table_row_arg(JSContext *ctx, BtaWidget *w, JSValueConst v,
                                  bool *bad)
{
    TableState *st = table_state(w);

    *bad = false;

    if (st->tree) {
        const char *key = JS_ToCString(ctx, v);
        if (!key) {
            *bad = true;
            return NULL;
        }
        BtaTableRow *node = table_node(w, key);
        JS_FreeCString(ctx, key);
        return node ? g_object_ref(node) : NULL;
    }

    int32_t i;
    if (JS_ToInt32(ctx, &i, v)) {
        *bad = true;
        return NULL;
    }

    GListModel *rows = G_LIST_MODEL(st->rows);
    if (i < 0 || (guint)i >= g_list_model_get_n_items(rows))
        return NULL;
    return g_list_model_get_item(rows, (guint)i);
}

/* What a row is called in a message, so one sentence serves both modes. */
static const char *table_what(BtaWidget *w)
{
    return table_state(w)->tree ? "node" : "row";
}

/* The node the highlight is on, or NULL. An owned reference. */
static BtaTableRow *table_selected_node(BtaWidget *w)
{
    GtkSelectionModel *sel = table_model(w);

    if (!table_state(w)->tree || !GTK_IS_SINGLE_SELECTION(sel))
        return NULL;

    gpointer item = gtk_single_selection_get_selected_item(GTK_SINGLE_SELECTION(sel));
    return GTK_IS_TREE_LIST_ROW(item) ? gtk_tree_list_row_get_item(item) : NULL;
}

/* Put the highlight on this node, opening the way to it first: a node under a
 * closed parent has no row to select. */
static void table_select_node(BtaWidget *w, BtaTableRow *node)
{
    table_reveal(w, node, false);

    GtkTreeListRow *row = table_row_of(w, node);
    if (!row)
        return;

    GListModel *model = G_LIST_MODEL(table_tree_model(w));
    guint       n     = g_list_model_get_n_items(model);

    for (guint i = 0; i < n; i++) {
        GtkTreeListRow *at = g_list_model_get_item(model, i);
        bool            is = (at == row);

        g_clear_object(&at);
        if (is) {
            gtk_selection_model_select_item(table_model(w), i, TRUE);
            break;
        }
    }
    g_object_unref(row);
}

/*
 * One row's cells changed, whichever mode: the tree tells the store the node
 * sits in, the flat table tells the one store there is.
 *
 * **And a tree puts its selection back.** Telling a store an item changed costs
 * the selection there -- the tree model answers with fresh `GtkTreeListRow`
 * wrappers and the highlight was on one of those -- while a flat list keeps it,
 * because GTK's selection model follows the item. Changing a cell is not moving
 * the selection, in either mode, so the difference is paid here.
 */
static void table_row_changed(BtaWidget *w, BtaTableRow *row, int at)
{
    if (!table_state(w)->tree) {
        if (at >= 0)
            g_list_model_items_changed(G_LIST_MODEL(table_state(w)->rows),
                                       (guint)at, 1, 1);
        return;
    }

    BtaTableRow *was = table_selected_node(w);

    table_node_changed(w, row);
    if (was) {
        if (!table_selected_node(w))
            table_select_node(w, was);
        g_object_unref(was);
    }
}

/* ------------------------------------------------------------- the cells */

/*
 * One factory per column, told which column it is. The index is the whole of
 * what a cell needs to know: the row carries its own values and a column is a
 * view of one of them.
 */
#define COLUMN_INDEX_KEY "bta-column-index"
/* Set on the factory of the column that carries the disclosure: the first one,
 * and only while the table is a tree. */
#define TREE_COLUMN_KEY  "bta-tree-column"
/* The children store a bound row is watching, and the handler on it. Rows are
 * recycled, so both have to come off in `unbind`. */
#define WATCH_MODEL_KEY   "bta-watch-model"
#define WATCH_HANDLER_KEY "bta-watch-handler"

/*
 * A cell is an icon and a label in a box, even for the cells that have no icon:
 * rows are recycled, so building one shape and hiding what a given cell does
 * not use costs nothing. `TreeView` builds its rows the same way.
 *
 * **A hidden image takes no room, so a column where only some rows carry an
 * icon is ragged** -- the text of the ones without starts further left. This
 * comment used to claim the opposite. Keeping the image visible and empty would
 * line them up and would put a 16px gutter in every cell of every table that has
 * no icons at all, which is most of them; both controls make the same choice, so
 * at least they agree. Give a column an icon on every row or on none.
 */
static void on_setup_cell(GtkSignalListItemFactory *f, GtkListItem *item,
                          gpointer user_data)
{
    GtkWidget *box   = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    GtkWidget *image = gtk_image_new();
    GtkWidget *label = gtk_label_new("");

    /* Left by default and right for numbers, which is what `Alignment` says;
     * the factory carries it because a label is made here and bound there. */
    float x = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(f), "bta-xalign")) / 100.0f;
    gtk_label_set_xalign(GTK_LABEL(label), x);
    gtk_label_set_ellipsize(GTK_LABEL(label), PANGO_ELLIPSIZE_END);
    gtk_widget_set_hexpand(label, TRUE);

    gtk_box_append(GTK_BOX(box), image);
    gtk_box_append(GTK_BOX(box), label);
    gtk_widget_set_visible(image, FALSE);

    /* **The first column of a tree carries the disclosure**, and the indent
     * with it -- that is what a `GtkTreeExpander` is. It is built here, when
     * the columns are, so a table that becomes a tree rebuilds its columns
     * rather than growing an expander onto rows already made. */
    if (g_object_get_data(G_OBJECT(f), TREE_COLUMN_KEY)) {
        GtkWidget *expander = gtk_tree_expander_new();

        gtk_tree_expander_set_child(GTK_TREE_EXPANDER(expander), box);
        gtk_list_item_set_child(item, expander);
        return;
    }
    gtk_list_item_set_child(item, box);
}

/*
 * What goes in a cell, whichever kind of row it is.
 *
 * A held row answers from its own values. A virtual one has none, so the
 * application is asked -- `Data(row, column)`, whose **return value** is the
 * answer: a string, or `{ Text, Icon }` when the cell carries both. Returning it
 * rather than assigning into a side channel is what this runtime already does
 * with `KeyPress`, and it means a handler is a function of its arguments.
 *
 * It runs while the row is being drawn, so the rule is the same one the
 * completion provider will have: **a lookup, and nothing that is not a lookup.**
 * GTK only asks about the rows on screen, so this is a few dozen calls a scroll
 * and not one per row in the table.
 */
static void cell_of(BtaWidget *w, BtaTableRow *row, guint col,
                    char **text, char **icon)
{
    *text = NULL;
    *icon = NULL;

    if (row && row->cells) {
        *text = g_strdup(row_cell(row, col));
        *icon = g_strdup(row_icon(row, col));
        return;
    }
    if (!row)
        return;

    JSContext *ctx     = w->ctx;
    JSValue    argv[2] = { JS_NewInt32(ctx, (int)row->index),
                           JS_NewInt32(ctx, (int)col) };
    JSValue    r       = bta_emit_on(ctx, w->form, w->name, "Data", 2, argv);

    if (JS_IsString(r)) {
        const char *s = JS_ToCString(ctx, r);
        *text = g_strdup(s ? s : "");
        JS_FreeCString(ctx, s);
    } else if (JS_IsObject(r)) {
        JSValue     tv = JS_GetPropertyStr(ctx, r, "Text");
        JSValue     iv = JS_GetPropertyStr(ctx, r, "Icon");
        const char *ts = JS_IsUndefined(tv) ? NULL : JS_ToCString(ctx, tv);
        const char *is = JS_IsUndefined(iv) ? NULL : JS_ToCString(ctx, iv);

        *text = g_strdup(ts ? ts : "");
        *icon = is && *is ? g_strdup(is) : NULL;

        JS_FreeCString(ctx, ts);
        JS_FreeCString(ctx, is);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, iv);
    }

    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
}

/*
 * **Whether a node shows an arrow is not decidable once.** The child-model
 * callback always hands back the store (see `table_child_model`), so GTK would
 * draw a disclosure on every row; the bind hides it on the ones with nothing
 * under them. But a parent is routinely added *before* its children -- `Add`
 * takes a parent by key -- so the row was bound when the answer was still "no
 * children", and nothing rebinds it when they arrive: the arrow never appears
 * and the folder cannot be opened.
 *
 * So the bound row watches its own children store. That is the half of the
 * recycling contract that is easy to miss -- what a `bind` connects, an
 * `unbind` has to disconnect, or the next node to use this row keeps the
 * previous one's watch. `TreeView` learned it first.
 */
static void update_expander(GListModel *children, guint pos, guint removed,
                            guint added, gpointer expander)
{
    gtk_tree_expander_set_hide_expander(GTK_TREE_EXPANDER(expander),
                                        g_list_model_get_n_items(children) == 0);
}

static void on_unbind_cell(GtkSignalListItemFactory *f, GtkListItem *item,
                           gpointer user_data)
{
    GObject *model = g_object_get_data(G_OBJECT(item), WATCH_MODEL_KEY);
    gulong   id    = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(item),
                                                        WATCH_HANDLER_KEY));

    if (model && id)
        g_signal_handler_disconnect(model, id);
    g_object_set_data(G_OBJECT(item), WATCH_HANDLER_KEY, NULL);
    g_object_set_data(G_OBJECT(item), WATCH_MODEL_KEY, NULL);
}

static void on_bind_cell(GtkSignalListItemFactory *f, GtkListItem *item,
                         gpointer user_data)
{
    guint        col  = GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(f),
                                                           COLUMN_INDEX_KEY));
    BtaWidget   *w    = user_data;
    gpointer     what = gtk_list_item_get_item(item);
    GtkWidget   *box  = gtk_list_item_get_child(item);
    BtaTableRow *row;
    bool         owned = false;

    /*
     * **In a tree every column's item is a `GtkTreeListRow`**, not only the one
     * with the expander in it: the model wraps each node once and every column
     * binds against the same wrapper. So the unwrapping is here, and
     * `gtk_tree_list_row_get_item` hands over a reference this has to drop.
     */
    if (GTK_IS_TREE_LIST_ROW(what)) {
        GtkTreeListRow *tr = what;

        row   = gtk_tree_list_row_get_item(tr);
        owned = true;

        if (GTK_IS_TREE_EXPANDER(box)) {
            GtkTreeExpander *exp = GTK_TREE_EXPANDER(box);

            gtk_tree_expander_set_list_row(exp, tr);
            box = gtk_tree_expander_get_child(exp);

            /* No children, no arrow -- now, and again whenever that changes. */
            if (row && row->children) {
                GListModel *kids = G_LIST_MODEL(row->children);
                gulong      id;

                update_expander(kids, 0, 0, 0, exp);
                id = g_signal_connect(kids, "items-changed",
                                      G_CALLBACK(update_expander), exp);
                g_object_set_data(G_OBJECT(item), WATCH_HANDLER_KEY,
                                  GSIZE_TO_POINTER(id));
                g_object_set_data_full(G_OBJECT(item), WATCH_MODEL_KEY,
                                       g_object_ref(kids), g_object_unref);
            }
        }
    } else {
        row = what;
    }

    GtkWidget *img = gtk_widget_get_first_child(box);
    GtkWidget *lbl = gtk_widget_get_last_child(box);

    char *text = NULL, *icon = NULL;
    cell_of(w, row, col, &text, &icon);

    gtk_label_set_text(GTK_LABEL(lbl), text ? text : "");

    /* An icon the theme cannot really draw is dropped rather than shown as the
     * broken-image glyph -- the same bargain Button.Icon and a TreeView node
     * make, and for the same reason. */
    bool show = icon && bta_icon_available(box, icon);
    if (show)
        bta_image_set_icon(img, icon);
    gtk_widget_set_visible(img, show);

    g_free(text);
    g_free(icon);
    if (owned)
        g_clear_object(&row);
}

/*
 * SetIcon(row, column, name) -- a picture beside a cell's text.
 *
 * A separate call and not a second kind of value, because a cell is text and an
 * icon is a name from the theme: `Add(["Ana", "10.50"])` stays the way a row is
 * written, and the exception says it is one. Every tool in this family has this
 * -- VB6's ListView through an ImageList, Gambas' `.Picture`, Qt's item -- and
 * it is what makes a list of files look like a list of files.
 *
 * "" takes it off. A virtual table answers with `{ Text, Icon }` from `Data`
 * instead: it holds no cells to hang one on.
 */
static JSValue table_set_icon(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    if (st->virt)
        return JS_ThrowTypeError(ctx,
            "SetIcon: a table that answers Data holds no cells; "
            "return { Text, Icon } from the handler instead");

    int32_t c;
    if (argc < 3 || JS_ToInt32(ctx, &c, argv[1]))
        return JS_ThrowTypeError(ctx, st->tree
            ? "SetIcon(key, column, name) expects a key, a column and a name"
            : "SetIcon(row, column, name) expects two numbers and a name");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);
    int          at  = st->tree ? -1 : 0;

    if (bad)
        return JS_EXCEPTION;
    if (!row) {
        const char *name = JS_ToCString(ctx, argv[0]);
        JSValue     e    = JS_ThrowRangeError(ctx, "SetIcon: there is no %s %s",
                                              table_what(w), name ? name : "");
        JS_FreeCString(ctx, name);
        return e;
    }
    if (c < 0) {
        g_object_unref(row);
        return JS_ThrowRangeError(ctx, "SetIcon: %d is not a column", c);
    }
    if (!st->tree)
        JS_ToInt32(ctx, &at, argv[0]);

    const char *s = JS_ToCString(ctx, argv[2]);

    row_pad(&row->icons, (guint)c);
    g_free(row->icons->pdata[c]);
    row->icons->pdata[c] = s && *s ? g_strdup(s) : NULL;

    JS_FreeCString(ctx, s);
    table_row_changed(w, row, at);
    g_object_unref(row);
    return JS_UNDEFINED;
}

/* --------------------------------------------------------------- sorting */

/*
 * `Sortable` makes the headers clickable and raises `Sort(column, ascending)`.
 * **The table does not reorder itself**, and that is the whole design: a table
 * that answers `Data` does not have the data, so it could not -- and one that
 * does can be told to, in one line, by the handler:
 *
 *     Table1_Sort(col, up) { this.Table1.SortBy(col, up); }
 *
 * Gambas draws the same line between `Sorted` (the indicator) and the `Sort`
 * event (who actually reorders). Sorting silently in one mode and not the other
 * would be the same word meaning two things.
 *
 * The sorter GTK is given never reorders anything: it exists to make the header
 * clickable and to carry the arrow. What it means is reported and nothing else.
 */


static void on_sort_changed(GtkSorter *sorter, GtkSorterChange change,
                            gpointer user_data)
{
    BtaWidget           *w    = user_data;
    GtkColumnViewSorter *cs   = GTK_COLUMN_VIEW_SORTER(sorter);
    GtkColumnViewColumn *col  = gtk_column_view_sorter_get_primary_sort_column(cs);
    if (!col)
        return;

    GListModel *cols = gtk_column_view_get_columns(GTK_COLUMN_VIEW(w->inner));
    int         idx  = -1;

    for (guint i = 0; idx < 0 && i < g_list_model_get_n_items(cols); i++) {
        GtkColumnViewColumn *c = g_list_model_get_item(cols, i);
        if (c == col)
            idx = (int)i;
        g_object_unref(c);
    }
    if (idx < 0)
        return;

    JSContext *ctx     = w->ctx;
    JSValue    argv[2] = {
        JS_NewInt32(ctx, idx),
        JS_NewBool(ctx, gtk_column_view_sorter_get_primary_sort_order(cs)
                            == GTK_SORT_ASCENDING),
    };
    JSValue r = bta_emit_on(ctx, w->form, w->name, "Sort", 2, argv);

    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
}

/*
 * Watches the view's own sorter, once.
 *
 * Not in `build_table`: asking for the sorter before the view is furnished
 * answers NULL, so connecting there connected to nothing, silently -- and a
 * header click did exactly what it did before `Sortable` existed.
 */
static void table_hook_sorter(BtaWidget *w)
{
    TableState *st = table_state(w);
    if (st->sort_hooked)
        return;

    GtkSorter *sorter = gtk_column_view_get_sorter(GTK_COLUMN_VIEW(w->inner));
    if (!sorter)
        return;

    g_signal_connect(sorter, "changed", G_CALLBACK(on_sort_changed), w);
    bta_widget_watch(w, sorter);
    st->sort_hooked = true;
}

static JSValue table_get_sortable(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, table_state(w)->sortable);
}

static JSValue table_set_sortable(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    TableState *st = table_state(w);
    st->sortable = b;

    /*
     * **Watched here and not in `build_table`.** The view's own
     * `GtkColumnViewSorter` is what a header click changes, and asking for it
     * before the view is furnished answers NULL -- so connecting at build time
     * connected to nothing, silently, and clicking a header did exactly what it
     * did before `Sortable` existed. Which is how it was found: `SortBy` was
     * tested and worked, the flag was tested and worked, and the one path a
     * suite cannot click was the one that was broken.
     */
    if (b)
        table_hook_sorter(w);

    /*
     * The columns there are *now*. `table_build_columns` applies the flag to the
     * ones it makes, so both orders work -- and both happen: a `.form` lists
     * `Sortable` before `Columns` (alphabetically, so usually) and code sets it
     * after. Neither is the odd one out, so neither may be the one that breaks.
     */
    GListModel *cols = gtk_column_view_get_columns(GTK_COLUMN_VIEW(w->inner));
    for (guint i = 0; i < g_list_model_get_n_items(cols); i++) {
        GtkColumnViewColumn *c = g_list_model_get_item(cols, i);
        GtkSorter *s = b ? GTK_SORTER(gtk_custom_sorter_new(sorter_keeps_order,
                                                            NULL, NULL))
                         : NULL;
        gtk_column_view_column_set_sorter(c, s);
        g_clear_object(&s);
        g_object_unref(c);
    }
    return JS_UNDEFINED;
}

/*
 * SortBy(column, ascending) -- reorder the rows the table holds.
 *
 * What a `Sort` handler calls when the table owns its data. On a table that
 * answers `Data` there is nothing here to sort, and saying so beats quietly
 * doing nothing.
 */
typedef struct { guint col; bool up; } SortKey;

static int compare_rows(gconstpointer a, gconstpointer b, gpointer user_data)
{
    const SortKey *k = user_data;
    int cmp = g_utf8_collate(row_cell((BtaTableRow *)a, k->col),
                             row_cell((BtaTableRow *)b, k->col));
    return k->up ? cmp : -cmp;
}

/* Each level in its own order: the roots, then every node's children. */
static void table_sort_levels(GListStore *store, SortKey *key)
{
    GListModel *model = G_LIST_MODEL(store);

    g_list_store_sort(store, compare_rows, key);
    for (guint i = 0, n = g_list_model_get_n_items(model); i < n; i++) {
        BtaTableRow *node = g_list_model_get_item(model, i);

        if (node->children)
            table_sort_levels(node->children, key);
        g_object_unref(node);
    }
}

static JSValue table_sort_by(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t col;
    if (argc < 1 || JS_ToInt32(ctx, &col, argv[0]))
        return JS_ThrowTypeError(ctx, "SortBy(column, [ascending]) expects a column");
    if (col < 0)
        return JS_ThrowRangeError(ctx, "SortBy: %d is not a column", col);

    TableState *st = table_state(w);
    if (st->virt)
        return JS_ThrowTypeError(ctx,
            "SortBy: a table that answers Data holds no rows to sort; "
            "sort what the handler reads instead");

    SortKey key = { (guint)col, argc < 2 || JS_ToBool(ctx, argv[1]) > 0 };

    /* **In a tree, siblings are sorted within each parent** -- sorting the
     * flattened list would put a child above its own parent, which is not an
     * order, it is a different tree. That is also why GTK's own
     * `GtkTreeListRowSorter` exists; it is not needed here because the sorter
     * the columns carry never reorders anything (see `Sortable`) and this is
     * the reordering. */
    if (!st->tree) {
        g_list_store_sort(st->rows, compare_rows, &key);
        return JS_UNDEFINED;
    }

    /*
     * **And the selection is put back, which a flat table gets for free.** GTK's
     * selection model follows the *item* across a reorder, so sorting a flat
     * table leaves the same row highlighted. A tree cannot: sorting a level
     * makes the tree model build fresh `GtkTreeListRow` wrappers, and the
     * selection was on one of those. Remembering the node and selecting it
     * again is what makes the two modes behave the same -- and it is only
     * possible because a node has a key.
     */
    BtaTableRow *was = table_selected_node(w);

    table_sort_levels(st->rows, &key);
    if (was) {
        table_select_node(w, was);
        g_object_unref(was);
    }
    return JS_UNDEFINED;
}

/*
 * SortColumn(column, [ascending]) -- the header, clicked from code.
 *
 * Two calls that sound alike and are not, so the difference is worth stating:
 *
 *   SortBy(col, asc)      reorders the rows the table *holds*. Data, not chrome.
 *   SortColumn(col, asc)  asks the header to sort, exactly as a click does --
 *                         the arrow moves and `Sort` is raised, so whatever the
 *                         handler does about it happens too.
 *
 * Which makes it what an application restoring a saved sort on startup wants:
 * one call, and the indicator and the rows end up agreeing. It also makes the
 * click path testable, which a pointer on a GTK header is not.
 */
static JSValue table_sort_column(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t col;
    if (argc < 1 || JS_ToInt32(ctx, &col, argv[0]))
        return JS_ThrowTypeError(ctx,
            "SortColumn(column, [ascending]) expects a column");

    GListModel *cols = gtk_column_view_get_columns(GTK_COLUMN_VIEW(w->inner));
    if (col < 0 || (guint)col >= g_list_model_get_n_items(cols))
        return JS_ThrowRangeError(ctx, "SortColumn: there is no column %d", col);
    if (!table_state(w)->sortable)
        return JS_ThrowTypeError(ctx,
            "SortColumn: the headings are not sortable; set Sortable first");

    GtkColumnViewColumn *c  = g_list_model_get_item(cols, (guint)col);
    bool                 up = argc < 2 || JS_ToBool(ctx, argv[1]) > 0;

    gtk_column_view_sort_by_column(GTK_COLUMN_VIEW(w->inner), c,
                                   up ? GTK_SORT_ASCENDING : GTK_SORT_DESCENDING);
    g_object_unref(c);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------- selection */

static void on_selection_changed(GtkSelectionModel *model, guint pos, guint n,
                                 gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Select", 0, NULL);
}

/* Double click, or Enter: the row is meant, not merely pointed at. */
static void on_row_activated(GtkColumnView *view, guint position,
                             gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Activate", 0, NULL);
}

/* ---------------------------------------------------------------- build */

static void build_table(BtaWidget *w)
{
    TableState *st = g_new0(TableState, 1);
    st->rows = g_list_store_new(BTA_TYPE_TABLE_ROW);
    /* On, which is what a tree of folders wants and what `TreeView` does. It
     * means nothing until this table is one. */
    st->autoexpand = true;

    /* `g_object_ref` because the selection takes ownership of what it is given
     * (transfer full) and the state keeps the store too: without it the model
     * had one reference and two owners, and freeing the state was the second
     * unref -- `g_object_unref: assertion 'G_IS_OBJECT (object)' failed`. */
    GtkSingleSelection *sel =
        gtk_single_selection_new(g_object_ref(G_LIST_MODEL(st->rows)));
    gtk_single_selection_set_autoselect(sel, FALSE);
    gtk_single_selection_set_can_unselect(sel, TRUE);

    w->inner = gtk_column_view_new(GTK_SELECTION_MODEL(sel));
    gtk_column_view_set_show_row_separators(GTK_COLUMN_VIEW(w->inner), TRUE);
    gtk_column_view_set_reorderable(GTK_COLUMN_VIEW(w->inner), FALSE);

    g_object_set_data_full(G_OBJECT(w->inner), TABLE_STATE_KEY, st,
                           table_state_free);

    /* Content whose size is not its parent's business, like every other list
     * here: the view is the room there is and the rows scroll inside it. */
    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);

    /* The model is not the widget, so the finaliser's sweep cannot find this
     * on its own -- bta_widget_watch is how it is told. */
    g_signal_connect(sel, "selection-changed",
                     G_CALLBACK(on_selection_changed), w);
    bta_widget_watch(w, sel);
    g_signal_connect(w->inner, "activate", G_CALLBACK(on_row_activated), w);

}

/* --------------------------------------------------------------- columns */

/*
 * A declared column: `{ Text, Width, Alignment }`, and only `Text` is required.
 *
 * `Width` is a request in pixels and 0 means the column sizes itself, which is
 * what a column with nothing to say should do. `Alignment` is the three words a
 * Label already answers to, because a column heading and a label are the same
 * question about the same kind of value -- one vocabulary and no new drop-down
 * for the designer to learn.
 */
static const char *table_options(const char *prop)
{
    return !strcmp(prop, "Columns") ? NULL : NULL;
}

static float alignment_of(JSContext *ctx, JSValueConst col, const char *where,
                          bool *bad)
{
    JSValue v = JS_GetPropertyStr(ctx, col, "Alignment");
    float   x = 0.0f;

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        if (!s)                                  x = 0.0f;
        else if (!g_ascii_strcasecmp(s, "Left"))   x = 0.0f;
        else if (!g_ascii_strcasecmp(s, "Center")) x = 0.5f;
        else if (!g_ascii_strcasecmp(s, "Right"))  x = 1.0f;
        else {
            JS_ThrowRangeError(ctx, "%s: Alignment must be Left, Center or "
                                    "Right, not '%s'", where, s);
            *bad = true;
        }
        JS_FreeCString(ctx, s);
    } else if (!JS_IsUndefined(v)) {
        JS_ThrowTypeError(ctx, "%s: Alignment is a word, not a number", where);
        *bad = true;
    }
    JS_FreeValue(ctx, v);
    return x;
}

/* Builds the GtkColumnViewColumns from the declaration. Every existing column
 * goes first: this is a declaration of what the table *has*, not an append. */
static bool table_build_columns(JSContext *ctx, BtaWidget *w, JSValueConst list)
{
    GtkColumnView *view = GTK_COLUMN_VIEW(w->inner);

    if (!JS_IsArray(list)) {
        JS_ThrowTypeError(ctx, "Columns is a list of { Text, Width, Alignment }");
        return false;
    }

    JSValue  lenv = JS_GetPropertyStr(ctx, list, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    /* Everything is checked before anything is torn down: a refused declaration
     * has to leave the table exactly as it was, not half rebuilt. */
    for (uint32_t i = 0; i < n; i++) {
        JSValue col = JS_GetPropertyUint32(ctx, list, i);
        char    where[48];
        g_snprintf(where, sizeof where, "Columns[%u]", i);

        if (!JS_IsObject(col)) {
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s is not a { Text, ... }", where);
            return false;
        }

        JSValue text = JS_GetPropertyStr(ctx, col, "Text");
        bool    ok   = JS_IsString(text) || JS_IsUndefined(text);
        JS_FreeValue(ctx, text);
        if (!ok) {
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s: Text is the heading, as a string", where);
            return false;
        }

        JSValue wv = JS_GetPropertyStr(ctx, col, "Width");
        int32_t px = 0;
        if (!JS_IsUndefined(wv) && JS_ToInt32(ctx, &px, wv)) {
            JS_FreeValue(ctx, wv);
            JS_FreeValue(ctx, col);
            return false;
        }
        JS_FreeValue(ctx, wv);
        if (px < 0) {
            JS_FreeValue(ctx, col);
            JS_ThrowRangeError(ctx, "%s: %d is not a width", where, px);
            return false;
        }

        bool bad = false;
        alignment_of(ctx, col, where, &bad);
        JS_FreeValue(ctx, col);
        if (bad)
            return false;
    }

    /* Out with the old. Walked backwards because removing shortens the list. */
    GListModel *have = gtk_column_view_get_columns(view);
    for (guint i = g_list_model_get_n_items(have); i > 0; i--) {
        GtkColumnViewColumn *c = g_list_model_get_item(have, i - 1);
        gtk_column_view_remove_column(view, c);
        g_object_unref(c);
    }

    for (uint32_t i = 0; i < n; i++) {
        JSValue     col   = JS_GetPropertyUint32(ctx, list, i);
        JSValue     tv    = JS_GetPropertyStr(ctx, col, "Text");
        const char *title = JS_IsString(tv) ? JS_ToCString(ctx, tv) : NULL;

        JSValue wv = JS_GetPropertyStr(ctx, col, "Width");
        int32_t px = 0;
        JS_ToInt32(ctx, &px, wv);
        JS_FreeValue(ctx, wv);

        bool  bad = false;
        float x   = alignment_of(ctx, col, "Columns", &bad);

        GtkListItemFactory *f = gtk_signal_list_item_factory_new();
        g_object_set_data(G_OBJECT(f), COLUMN_INDEX_KEY, GUINT_TO_POINTER(i));
        if (i == 0 && table_state(w)->tree)
            g_object_set_data(G_OBJECT(f), TREE_COLUMN_KEY, GINT_TO_POINTER(1));
        g_object_set_data(G_OBJECT(f), "bta-xalign",
                          GINT_TO_POINTER((int)(x * 100)));
        g_signal_connect(f, "setup", G_CALLBACK(on_setup_cell), w);
        g_signal_connect(f, "bind",  G_CALLBACK(on_bind_cell),  w);
        /* Only the column that carries the expander watches anything, and it is
         * the only one that has to let go. */
        if (i == 0 && table_state(w)->tree)
            g_signal_connect(f, "unbind", G_CALLBACK(on_unbind_cell), w);

        GtkColumnViewColumn *c =
            gtk_column_view_column_new(title ? title : "", f);

        /* 0 is "size yourself", which is GTK's -1. A width that was asked for
         * is still draggable: the number is where it starts, not a cage. */
        gtk_column_view_column_set_fixed_width(c, px > 0 ? px : -1);
        gtk_column_view_column_set_resizable(c, TRUE);

        /*
         * **Applied here, because this is the only place a column is made.**
         * `Sortable` used to be a loop over the columns there were at the time,
         * and a `.form` that lists it before `Columns` -- which is alphabetical,
         * so most of them -- set it when there were none and then rebuilt them
         * without a sorter. The flag read back true and the headers were dead.
         */
        if (table_state(w)->sortable)
            gtk_column_view_column_set_sorter(
                c, GTK_SORTER(gtk_custom_sorter_new(sorter_keeps_order, NULL, NULL)));
        /* The last column takes the slack, so a table never ends in a gap. */
        gtk_column_view_column_set_expand(c, i + 1 == n);

        gtk_column_view_append_column(view, c);
        g_object_unref(c);

        JS_FreeCString(ctx, title);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, col);
    }
    return true;
}

static JSValue table_get_columns(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget  *w  = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* What was declared, not what GTK made of it: a column that asked for no
     * width must not come back asking for the one it happens to be drawn at --
     * the same trap `Width` on a control had, where saving an allocation turned
     * today's measurement into tomorrow's floor. */
    JSValue held = *bta_widget_note(w, BTA_NOTE_COLUMNS);
    if (JS_IsArray(held))
        return JS_DupValue(ctx, held);

    return JS_NewArray(ctx);
}

static JSValue table_set_columns(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (!table_build_columns(ctx, w, val))
        return JS_EXCEPTION;

    JSValue *slot = bta_widget_note(w, BTA_NOTE_COLUMNS);
    JS_FreeValue(ctx, *slot);
    *slot = JS_DupValue(ctx, val);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------ rows */

/*
 * Add(values) -- one row, its cells in column order.
 *
 * A bare string is a row of one cell, because a table of one column is a
 * perfectly ordinary table and making the caller wrap it would be ceremony.
 */
/*
 * Turning a table into a tree, which happens on the first row that carries a
 * `Key`.
 *
 * Three things move: the model becomes a `GtkTreeListModel` over the same store
 * of roots, the columns are rebuilt so the first one carries the expander, and
 * the key index comes into being. It happens once -- `Clear` puts it back --
 * and it is the only place the mode changes.
 */
static bool table_become_tree(JSContext *ctx, BtaWidget *w)
{
    TableState *st = table_state(w);

    if (st->tree)
        return true;

    if (st->virt)
        return JS_ThrowTypeError(ctx, "Add: this table answers Data(row, "
                                      "column), which is a flat list of Count "
                                      "rows -- Clear() it first"), false;
    if (g_list_model_get_n_items(G_LIST_MODEL(st->rows)))
        return JS_ThrowTypeError(ctx, "Add: this table already holds rows with "
                                      "no Key. A table is flat or a tree -- "
                                      "Clear() it first"), false;
    if (st->multi)
        return JS_ThrowTypeError(ctx, "Add: a tree is selected one node at "
                                      "a time; turn MultiSelect off"), false;

    st->tree = true;
    st->keys = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);

    GtkTreeListModel *tree =
        gtk_tree_list_model_new(G_LIST_MODEL(g_object_ref(st->rows)),
                                FALSE,                 /* not passthrough */
                                st->autoexpand,
                                table_child_model, w, NULL);

    table_use_model(w, G_LIST_MODEL(tree));
    g_object_unref(tree);

    /* The expander lives in a factory, and factories are made with the
     * columns. Rebuilt from what was declared, which is kept on the struct.
     *
     * Duplicated for the length of the call, because reading a spec can run a
     * getter of the caller's and a getter can assign `Columns` -- which would
     * free the very array being walked. */
    JSValue held = JS_DupValue(ctx, *bta_widget_note(w, BTA_NOTE_COLUMNS));
    bool    ok   = !JS_IsArray(held) || table_build_columns(ctx, w, held);

    JS_FreeValue(ctx, held);
    return ok;
}

/* The values into a row's cells. Everything is text once it is in one: a number
 * formatted by whoever knows how it should read beats this guessing. */
static void table_fill_cells(JSContext *ctx, BtaTableRow *row, JSValueConst values)
{
    if (JS_IsArray(values)) {
        JSValue  lenv = JS_GetPropertyStr(ctx, values, "length");
        uint32_t n    = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < n; i++) {
            JSValue     v = JS_GetPropertyUint32(ctx, values, i);
            const char *s = JS_ToCString(ctx, v);

            g_ptr_array_add(row->cells, g_strdup(s ? s : ""));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, v);
        }
        return;
    }

    const char *s = JS_ToCString(ctx, values);
    g_ptr_array_add(row->cells, g_strdup(s ? s : ""));
    JS_FreeCString(ctx, s);
}

/*
 * `Add(values, { Key, Parent })` -- a row that can have rows under it.
 *
 * **One verb, and the options say which shape this is.** A second verb was the
 * first design and `AddNode` was its name; `Container.AddNode(node)` already
 * means *build a widget from a `.form` node*, and a word that means two things
 * is the thing this vocabulary is small in order to avoid. An options object is
 * what this runtime already reaches for when the same call has more said about
 * it -- `Directory.Files(dir, { Pattern, Recursive })`, `Exec(argv, { Timeout })`
 * -- and it keeps `Add(values)` exactly as it was.
 *
 * The key is the application's -- a path, an id -- and it is what everything
 * else takes from then on: `Cell`, `SetCell`, `SetIcon`, `Row` and `Remove` all
 * address a node by key, because a *position* in a tree is of the visible list
 * and moves when something above it collapses.
 */
static JSValue table_add_node(JSContext *ctx, BtaWidget *w, JSValueConst values,
                              const char *key, const char *pkey, const char *icon)
{
    if (!*key)
        return JS_ThrowTypeError(ctx, "Add: Key is what addresses a node, so it "
                                      "cannot be empty");
    if (!table_become_tree(ctx, w))
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    if (g_hash_table_contains(st->keys, key))
        return JS_ThrowRangeError(ctx, "Add: there is already a node with the "
                                       "key '%s'", key);

    /* The parent has to be there already: a node under a key nobody added is a
     * subtree nothing would ever draw. */
    BtaTableRow *parent = NULL;

    if (pkey && *pkey) {
        parent = table_node(w, pkey);
        if (!parent)
            return JS_ThrowRangeError(ctx, "Add: there is no node with the key "
                                           "'%s' to put '%s' under", pkey, key);
    }

    BtaTableRow *node = g_object_new(BTA_TYPE_TABLE_ROW, NULL);

    node->key      = g_strdup(key);
    node->children = g_list_store_new(BTA_TYPE_TABLE_ROW);
    node->parent   = parent;
    table_fill_cells(ctx, node, values);

    /* The icon goes in with the node, the way `TreeView.Add` takes one: a
     * `SetIcon` per node afterwards is a second call for something that was
     * known at the first. `SetIcon` is still there for changing it. */
    if (icon && *icon) {
        row_pad(&node->icons, 0);
        g_free(node->icons->pdata[0]);
        node->icons->pdata[0] = g_strdup(icon);
    }

    g_hash_table_insert(st->keys, g_strdup(key), node);
    g_list_store_append(parent ? parent->children : st->rows, node);

    /* A node that gains children opens, if that is what the table was told --
     * and the parent has to be reachable first, or setting it does nothing. */
    if (parent && st->autoexpand)
        table_reveal(w, parent, true);

    g_object_unref(node);
    return JS_UNDEFINED;
}

static JSValue table_add(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Add(values) expects the row's cells");

    /* `{ Key, Parent }` is what makes this a node. Read first, because
     * everything about the call depends on whether it is there. */
    if (argc > 1 && JS_IsObject(argv[1]) && !JS_IsArray(argv[1])) {
        JSValue kv = JS_GetPropertyStr(ctx, argv[1], "Key");
        JSValue pv = JS_GetPropertyStr(ctx, argv[1], "Parent");
        JSValue iv = JS_GetPropertyStr(ctx, argv[1], "Icon");

        if (JS_IsUndefined(kv)) {
            JS_FreeValue(ctx, kv);
            JS_FreeValue(ctx, pv);
            JS_FreeValue(ctx, iv);
            return JS_ThrowTypeError(ctx, "Add: the options are "
                                          "{ Key, Parent, Icon } -- a node is a "
                                          "row with a Key");
        }

        const char *key  = JS_ToCString(ctx, kv);
        const char *pkey = JS_IsUndefined(pv) || JS_IsNull(pv)
                               ? NULL : JS_ToCString(ctx, pv);
        const char *icon = JS_IsUndefined(iv) || JS_IsNull(iv)
                               ? NULL : JS_ToCString(ctx, iv);
        JSValue     out  = key ? table_add_node(ctx, w, argv[0], key, pkey, icon)
                               : JS_EXCEPTION;

        JS_FreeCString(ctx, icon);
        JS_FreeCString(ctx, pkey);
        JS_FreeCString(ctx, key);
        JS_FreeValue(ctx, kv);
        JS_FreeValue(ctx, pv);
        JS_FreeValue(ctx, iv);
        return out;
    }

    BtaTableRow *row = g_object_new(BTA_TYPE_TABLE_ROW, NULL);

    table_fill_cells(ctx, row, argv[0]);

    TableState *st = table_state(w);

    if (st->tree) {
        g_object_unref(row);
        return JS_ThrowTypeError(ctx, "Add: this table is a tree -- every row in "
                                      "one is a node, so it needs a key: "
                                      "Add(values, { Key, Parent })");
    }

    /* Adding a row is saying the table holds its own again. */
    if (st->virt) {
        g_clear_object(&st->virt);
        table_use_model(w, G_LIST_MODEL(st->rows));
    }

    g_list_store_append(st->rows, row);
    g_object_unref(row);
    return JS_UNDEFINED;
}

static JSValue table_clear(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    g_list_store_remove_all(st->rows);

    /*
     * **And it is the way back out of the tree.** A table is flat or a tree,
     * decided by the first row put in it; emptying it is what makes that
     * decision again -- the same door `Add` opens on a table that was answering
     * `Data`.
     */
    if (st->tree) {
        st->tree = false;
        g_clear_pointer(&st->keys, g_hash_table_unref);
        table_use_model(w, G_LIST_MODEL(st->rows));

        JSValue held = JS_DupValue(ctx, *bta_widget_note(w, BTA_NOTE_COLUMNS));
        bool    ok   = !JS_IsArray(held) || table_build_columns(ctx, w, held);

        JS_FreeValue(ctx, held);
        if (!ok)
            return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

static JSValue table_remove(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    /* A tree is addressed by key, and removing a node removes what is under
     * it: a subtree with no parent is not a thing this control can show. */
    if (st->tree) {
        const char *key = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
        if (!key)
            return JS_ThrowTypeError(ctx, "Remove(key) expects a node's key");

        BtaTableRow *node = table_node(w, key);
        if (!node) {
            JSValue e = JS_ThrowRangeError(ctx, "Remove: there is no node '%s'", key);
            JS_FreeCString(ctx, key);
            return e;
        }
        JS_FreeCString(ctx, key);

        GListStore *store = table_store_of(w, node);
        int         at    = table_index_in(store, node);

        table_forget(w, node);
        if (at >= 0)
            g_list_store_remove(store, (guint)at);
        return JS_UNDEFINED;
    }

    int32_t i;
    if (argc < 1 || JS_ToInt32(ctx, &i, argv[0]))
        return JS_ThrowTypeError(ctx, "Remove(index) expects a row");

    GListStore *rows = st->rows;
    if (i < 0 || (guint)i >= g_list_model_get_n_items(G_LIST_MODEL(rows)))
        return JS_ThrowRangeError(ctx, "Remove: there is no row %d", i);

    g_list_store_remove(rows, (guint)i);
    return JS_UNDEFINED;
}

/*
 * Count -- how many rows there are, and **setting it is how a table stops
 * holding its own data**.
 *
 *   t.Add([...])   the table owns the row: held mode
 *   t.Count = 5000 there are five thousand rows and the table will ask about
 *                  each one it draws, through `Data(row, column)`
 *
 * Two ways to say what a table holds, and setting one clears the other -- the
 * bargain `Image.Icon` and `Image.File` already make, for the same reason: the
 * widget holds one thing at a time, and remembering the other would be state
 * nothing can be true about.
 */
static GListModel *table_live_model(BtaWidget *w)
{
    TableState *st = table_state(w);
    return st->virt ? G_LIST_MODEL(st->virt) : G_LIST_MODEL(st->rows);
}

static JSValue table_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    /* In a tree, every node at every level -- what `TreeView.Count` means, and
     * not the number of rows that happen to be visible. */
    if (table_state(w)->tree)
        return JS_NewInt32(ctx, (int)table_node_count(G_LIST_MODEL(table_state(w)->rows)));

    return JS_NewInt32(ctx, (int)g_list_model_get_n_items(table_live_model(w)));
}

static JSValue table_set_count(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "Count", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "Count: %d is not a number of rows", n);

    TableState *st = table_state(w);

    if (st->tree)
        return JS_ThrowTypeError(ctx, "Count: a tree counts its own nodes -- "
                                      "the on-demand mode is a flat list, so "
                                      "Clear() this table first");

    if (!st->virt) {
        /* Going on demand: what the table held is dropped, because it is no
         * longer what it shows and keeping it would be two answers to Count. */
        g_list_store_remove_all(st->rows);
        st->virt = g_object_new(BTA_TYPE_TABLE_MODEL, NULL);
        table_use_model(w, G_LIST_MODEL(st->virt));
    }
    table_model_set_count(st->virt, (guint)n);
    return JS_UNDEFINED;
}

/* Row(i) -- the cells of one row, as they were added. */
static JSValue table_row(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /*
     * A table that answers `Data` holds nothing to be asked about: the rows
     * exist -- `Count` says so -- but their values live wherever the handler
     * reads them from. Asking the table is the wrong question, and refusing it
     * says so where returning "" or null would look like an answer. Same rule as
     * `SetIcon` and `SortBy`.
     */
    if (table_state(w)->virt)
        return JS_ThrowTypeError(ctx,
            "%s: a table that answers Data holds no rows; "
            "read them where the handler does", "Row");

    if (argc < 1)
        return JS_ThrowTypeError(ctx, table_state(w)->tree
            ? "Row(key) expects a node's key" : "Row(index) expects a row");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);

    if (bad)
        return JS_EXCEPTION;
    if (!row)
        return JS_NULL;      /* asking about a row that is not there */

    JSValue out = JS_NewArray(ctx);

    for (guint c = 0; c < row->cells->len; c++)
        JS_SetPropertyUint32(ctx, out, c,
                             JS_NewString(ctx, row->cells->pdata[c]));

    g_object_unref(row);
    return out;
}

/*
 * Cell(row, column) -- one cell.
 *
 * The other half of `SetCell`, and it exists because every tool in this family
 * addresses a cell by the pair: `GridView1[col, row].Text` in Gambas,
 * `Cells[ACol, ARow]` in Delphi, `Rows[i].Cells[j].Value` in WinForms. `Row(i)`
 * answers with the whole row, which is the right thing when the row is what you
 * are after and a waste when one field is.
 *
 * "" for a cell that is not there, matching what a row shorter than the columns
 * reads as -- a table is asked about cells that do not exist all the time, and
 * an exception per miss would make every caller check first.
 */
static JSValue table_cell(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /*
     * A table that answers `Data` holds nothing to be asked about: the rows
     * exist -- `Count` says so -- but their values live wherever the handler
     * reads them from. Asking the table is the wrong question, and refusing it
     * says so where returning "" or null would look like an answer. Same rule as
     * `SetIcon` and `SortBy`.
     */
    if (table_state(w)->virt)
        return JS_ThrowTypeError(ctx,
            "%s: a table that answers Data holds no rows; "
            "read them where the handler does", "Cell");

    int32_t c;
    if (argc < 2 || JS_ToInt32(ctx, &c, argv[1]))
        return JS_ThrowTypeError(ctx, table_state(w)->tree
            ? "Cell(key, column) expects a key and a column"
            : "Cell(row, column) expects two numbers");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);

    if (bad)
        return JS_EXCEPTION;
    if (!row || c < 0)
        return JS_NewString(ctx, "");

    JSValue out = JS_NewString(ctx, row_cell(row, (guint)c));

    g_object_unref(row);
    return out;
}

/*
 * SetCell(row, column, value) -- one cell, in place.
 *
 * `items-changed` on the one row and not a rebuild: the selection, the scroll
 * position and every other row's widgets survive, which is the whole reason a
 * table has a cell setter instead of asking the caller to Clear and re-Add.
 */
static JSValue table_set_cell(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t c;
    if (argc < 3 || JS_ToInt32(ctx, &c, argv[1]))
        return JS_ThrowTypeError(ctx, table_state(w)->tree
            ? "SetCell(key, column, value) expects a key, a column and a value"
            : "SetCell(row, column, value) expects two numbers and a value");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);
    int          at  = table_state(w)->tree ? -1 : 0;

    if (bad)
        return JS_EXCEPTION;
    if (!row) {
        const char *what = table_what(w);
        const char *name = JS_ToCString(ctx, argv[0]);
        JSValue     e    = JS_ThrowRangeError(ctx, "SetCell: there is no %s %s",
                                              what, name ? name : "");
        JS_FreeCString(ctx, name);
        return e;
    }
    if (c < 0) {
        g_object_unref(row);
        return JS_ThrowRangeError(ctx, "SetCell: %d is not a column", c);
    }
    if (!table_state(w)->tree)
        JS_ToInt32(ctx, &at, argv[0]);

    const char *s = JS_ToCString(ctx, argv[2]);

    /* A row shorter than the column being written grows to reach it, filled
     * with empties: the alternative is refusing a cell the table plainly has. */
    while (row->cells->len <= (guint)c)
        g_ptr_array_add(row->cells, g_strdup(""));

    g_free(row->cells->pdata[c]);
    row->cells->pdata[c] = g_strdup(s ? s : "");

    JS_FreeCString(ctx, s);
    table_row_changed(w, row, at);
    g_object_unref(row);
    return JS_UNDEFINED;
}



static JSValue table_get_index(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSelectionModel *model = table_model(w);
    guint              n     = g_list_model_get_n_items(G_LIST_MODEL(model));

    /* Walked rather than asked, for the reason ListBox.Index is: a multiple
     * selection answers NULL to "the selected one", and the first selected row
     * is the honest answer in both modes. */
    for (guint i = 0; i < n; i++)
        if (gtk_selection_model_is_selected(model, i))
            return JS_NewInt32(ctx, (int)i);
    return JS_NewInt32(ctx, -1);
}

static JSValue table_set_index(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (!bta_to_int(ctx, val, "Index", &i))
        return JS_EXCEPTION;

    GtkSelectionModel *model = table_model(w);
    guint              n     = g_list_model_get_n_items(G_LIST_MODEL(model));

    if (i < 0 || (guint)i >= n)
        gtk_selection_model_unselect_all(model);
    else
        gtk_selection_model_select_item(model, (guint)i, TRUE);
    return JS_UNDEFINED;
}

/* Every selected row, in order: what MultiSelect is for. */
static JSValue table_get_selection(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSelectionModel *model = table_model(w);
    guint              n     = g_list_model_get_n_items(G_LIST_MODEL(model));
    JSValue            out   = JS_NewArray(ctx);
    uint32_t           k     = 0;

    for (guint i = 0; i < n; i++)
        if (gtk_selection_model_is_selected(model, i))
            JS_SetPropertyUint32(ctx, out, k++, JS_NewInt32(ctx, (int)i));
    return out;
}

/*
 * MultiSelect swaps the selection model, which is the only way GTK4 offers --
 * and the swap has to carry the handler with it, or a table that changes mode
 * stops reporting Select.
 */
static void table_use_model(BtaWidget *w, GListModel *model)
{
    TableState        *st  = table_state(w);
    GtkSelectionModel *old = table_model(w);
    GtkSelectionModel *sel;

    if (st->multi) {
        sel = GTK_SELECTION_MODEL(gtk_multi_selection_new(g_object_ref(model)));
    } else {
        GtkSingleSelection *s = gtk_single_selection_new(g_object_ref(model));
        gtk_single_selection_set_autoselect(s, FALSE);
        gtk_single_selection_set_can_unselect(s, TRUE);
        sel = GTK_SELECTION_MODEL(s);
    }

    /*
     * The old model is about to be dropped by the view; unhook first, or it
     * reports a selection nobody made while it is being torn down.
     *
     * **And let go of it**, which is not tidiness. `bta_widget_watch` holds a
     * reference so the pointer is certainly valid when the handlers are
     * unhooked -- so watching every selection this ever made would keep them
     * all alive, and with them whatever they wrap. A tree that outlived its
     * `Clear()` went on asking a flat row for its children and died on
     * `g_object_ref: assertion 'G_IS_OBJECT (object)' failed`, which is a
     * sentence about a NULL store and says nothing about where it came from.
     */
    if (old) {
        g_signal_handlers_disconnect_by_data(old, w);
        for (guint i = 0; w->watched && i < w->watched->len; i++) {
            if (w->watched->pdata[i] == old) {
                g_ptr_array_remove_index_fast(w->watched, i);
                break;
            }
        }
    }

    gtk_column_view_set_model(GTK_COLUMN_VIEW(w->inner), sel);
    g_signal_connect(sel, "selection-changed",
                     G_CALLBACK(on_selection_changed), w);
    bta_widget_watch(w, sel);
    g_object_unref(sel);
}

static JSValue table_get_multi(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, table_state(w)->multi);
}

static JSValue table_set_multi(JSContext *ctx, JSValueConst this_val,
                               JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    /* A tree is selected one node at a time, which is what `TreeView` has
     * always been: `Selection` answers positions, and in a tree a position is
     * of the visible list -- a set of them would name different nodes a moment
     * later. It can be granted when something asks for it; the other way round
     * cannot be taken back. */
    if (st->tree && JS_ToBool(ctx, val))
        return JS_ThrowTypeError(ctx, "MultiSelect: a tree is selected one node "
                                      "at a time");
    if (st->multi == (bool)b)
        return JS_UNDEFINED;
    st->multi = b;

    table_use_model(w, table_live_model(w));
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------- appearance */

enum { TAB_HEADERS, TAB_SEPARATORS };

static JSValue table_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkColumnView *v = GTK_COLUMN_VIEW(w->inner);
    return JS_NewBool(ctx, magic == TAB_HEADERS
                           ? gtk_column_view_get_show_column_separators(v)
                           : gtk_column_view_get_show_row_separators(v));
}

static JSValue table_set_flag(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    GtkColumnView *v = GTK_COLUMN_VIEW(w->inner);
    if (magic == TAB_HEADERS) gtk_column_view_set_show_column_separators(v, b);
    else                      gtk_column_view_set_show_row_separators(v, b);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------ class */

/* ------------------------------------------------------- the tree's members
 *
 * Nine, and eight of them are `TreeView`'s words with `TreeView`'s meanings --
 * `Key`, `AutoExpand`, `ExpandNode`, `CollapseNode`, `ExpandAll`,
 * `CollapseAll`, `Expanded`, `Exists`. Somebody who has used the one control
 * has nothing new to learn about the other, which is the whole reason they are
 * not new words.
 */

/* Every member here answers the same way on a flat table: this is not a tree,
 * and the sentence says what would have made it one. */
static JSValue table_not_a_tree(JSContext *ctx, const char *who)
{
    return JS_ThrowTypeError(ctx, "%s: this table is flat -- rows added with "
                                  "Add(values, { Key }) is what makes it a "
                                  "tree", who);
}

/* The node a key names, or a throw. The one door the members below share. */
static BtaTableRow *table_named(JSContext *ctx, BtaWidget *w, const char *who,
                                int argc, JSValueConst *argv)
{
    if (!table_state(w)->tree) {
        table_not_a_tree(ctx, who);
        return NULL;
    }
    if (argc < 1) {
        JS_ThrowTypeError(ctx, "%s(key) needs a node's key", who);
        return NULL;
    }

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key)
        return NULL;

    BtaTableRow *node = table_node(w, key);
    if (!node)
        JS_ThrowRangeError(ctx, "%s: there is no node '%s'", who, key);
    JS_FreeCString(ctx, key);
    return node;
}

enum { NODE_EXPAND, NODE_COLLAPSE };

static JSValue table_expand_node(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char  *who  = magic == NODE_EXPAND ? "ExpandNode" : "CollapseNode";
    BtaTableRow *node = table_named(ctx, w, who, argc, argv);

    if (!node)
        return JS_EXCEPTION;

    /* Opening a node means opening the way to it: a row only exists once its
     * ancestors are open, so setting the flag on an unreachable one does
     * nothing at all. Closing needs no such walk. */
    if (magic == NODE_EXPAND)
        table_reveal(w, node, true);
    else
        table_set_expanded(w, node, false);
    return JS_UNDEFINED;
}

static void table_expand_all(BtaWidget *w, GListModel *store, bool open)
{
    guint n = g_list_model_get_n_items(store);

    for (guint i = 0; i < n; i++) {
        BtaTableRow *node = g_list_model_get_item(store, i);

        /* Top down when opening, because a child's row does not exist until its
         * parent's is open; the order does not matter when closing. */
        if (open)
            table_set_expanded(w, node, true);
        table_expand_all(w, G_LIST_MODEL(node->children), open);
        if (!open)
            table_set_expanded(w, node, false);
        g_object_unref(node);
    }
}

static JSValue table_expand_every(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!table_state(w)->tree)
        return table_not_a_tree(ctx, magic == NODE_EXPAND ? "ExpandAll"
                                                          : "CollapseAll");

    table_expand_all(w, G_LIST_MODEL(table_state(w)->rows), magic == NODE_EXPAND);
    return JS_UNDEFINED;
}

static JSValue table_expanded(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    BtaTableRow *node = table_named(ctx, w, "Expanded", argc, argv);
    if (!node)
        return JS_EXCEPTION;

    GtkTreeListRow *row  = table_row_of(w, node);
    bool            open = row && gtk_tree_list_row_get_expanded(row);

    g_clear_object(&row);
    return JS_NewBool(ctx, open);
}

/* Whether that node is there -- an answer and not a refusal, because "is it
 * there" is the question you ask *before* you know. */
static JSValue table_exists(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Exists(key) needs a key");

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key)
        return JS_EXCEPTION;

    bool there = table_state(w)->tree && table_node(w, key) != NULL;
    JS_FreeCString(ctx, key);
    return JS_NewBool(ctx, there);
}

/*
 * `Key` -- the selected node's key, and assigning selects.
 *
 * This is what `Index` cannot be in a tree. A position is of the visible list:
 * it moves when something above collapses, so a program that remembered one is
 * pointing at a different node a moment later. `Index` still answers -- it is
 * where the highlight is right now -- and `Key` is what to keep.
 */
static JSValue table_get_key(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    BtaTableRow *node = table_selected_node(w);
    JSValue      out  = JS_NewString(ctx, node && node->key ? node->key : "");

    g_clear_object(&node);
    return out;
}

static JSValue table_set_key(JSContext *ctx, JSValueConst this_val,
                             JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    if (!table_state(w)->tree)
        return table_not_a_tree(ctx, "Key");

    const char *key = JS_ToCString(ctx, val);
    if (!key)
        return JS_EXCEPTION;

    GtkSelectionModel *sel = table_model(w);

    /* "" selects nothing, which is how a program clears the selection. */
    if (!*key) {
        gtk_selection_model_unselect_all(sel);
        JS_FreeCString(ctx, key);
        return JS_UNDEFINED;
    }

    BtaTableRow *node = table_node(w, key);
    if (!node) {
        JSValue e = JS_ThrowRangeError(ctx, "Key: there is no node '%s'", key);
        JS_FreeCString(ctx, key);
        return e;
    }
    JS_FreeCString(ctx, key);

    table_select_node(w, node);
    return JS_UNDEFINED;
}

/*
 * `AutoExpand` -- whether a node comes open when it gains children. On by
 * default, which is what a tree of folders wants and what `TreeView` does.
 */
static JSValue table_get_autoexpand(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    return w ? JS_NewBool(ctx, table_state(w)->autoexpand) : JS_EXCEPTION;
}

static JSValue table_set_autoexpand(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);
    st->autoexpand = JS_ToBool(ctx, val) != 0;

    GtkTreeListModel *tree = table_tree_model(w);
    if (tree)
        gtk_tree_list_model_set_autoexpand(tree, st->autoexpand);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------ the list vocabulary
 *
 * `MultiSelect` and `Selection` were here without the four verbs that move a
 * selection -- so a table could be told it takes several rows and then had no
 * way to select one from code, which `ListBox` has had all along. Same words,
 * same meanings, over a `GtkSelectionModel` instead of a `GtkListBox`.
 */

enum { TB_SELECT, TB_DESELECT };

static JSValue table_select_one(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t i;
    if (argc < 1 || JS_ToInt32(ctx, &i, argv[0]))
        return JS_EXCEPTION;

    GtkSelectionModel *sel = table_model(w);
    guint              n   = g_list_model_get_n_items(G_LIST_MODEL(sel));

    if (i < 0 || (guint)i >= n)
        return JS_NewBool(ctx, false);      /* no such row: not an error */

    if (magic == TB_SELECT)
        /* FALSE: leave the rest alone, which is what `Select` means where
         * several are allowed. In single mode GTK unselects the other one
         * anyway, because there is only ever one. */
        gtk_selection_model_select_item(sel, (guint)i, FALSE);
    else
        gtk_selection_model_unselect_item(sel, (guint)i);
    return JS_NewBool(ctx, true);
}

enum { TB_ALL, TB_NONE };

static JSValue table_select_every(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (magic == TB_NONE) {
        gtk_selection_model_unselect_all(table_model(w));
        return JS_UNDEFINED;
    }
    if (!table_state(w)->multi)
        return JS_ThrowTypeError(ctx, "SelectAll needs MultiSelect");

    gtk_selection_model_select_all(table_model(w));
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry table_props[] = {
    JS_CGETSET_DEF("Columns",     table_get_columns,   table_set_columns),
    JS_CGETSET_DEF("Count",       table_get_count,     table_set_count),
    JS_CGETSET_DEF("Index",       table_get_index,     table_set_index),
    JS_CGETSET_DEF("Selection",   table_get_selection, NULL),
    JS_CGETSET_DEF("MultiSelect", table_get_multi,     table_set_multi),
    JS_CGETSET_MAGIC_DEF("RowLines",    table_get_flag, table_set_flag, TAB_SEPARATORS),
    JS_CGETSET_MAGIC_DEF("ColumnLines", table_get_flag, table_set_flag, TAB_HEADERS),
    JS_CGETSET_DEF("Key",        table_get_key,        table_set_key),
    JS_CGETSET_DEF("AutoExpand", table_get_autoexpand, table_set_autoexpand),
    JS_CFUNC_DEF("Add",     2, table_add),
    JS_CFUNC_MAGIC_DEF("ExpandNode",   1, table_expand_node,  NODE_EXPAND),
    JS_CFUNC_MAGIC_DEF("CollapseNode", 1, table_expand_node,  NODE_COLLAPSE),
    JS_CFUNC_MAGIC_DEF("ExpandAll",    0, table_expand_every, NODE_EXPAND),
    JS_CFUNC_MAGIC_DEF("CollapseAll",  0, table_expand_every, NODE_COLLAPSE),
    JS_CFUNC_DEF("Expanded", 1, table_expanded),
    JS_CFUNC_DEF("Exists",   1, table_exists),
    JS_CFUNC_DEF("Clear",   0, table_clear),
    JS_CFUNC_DEF("Remove",  1, table_remove),
    JS_CFUNC_DEF("Row",     1, table_row),
    JS_CFUNC_DEF("Cell",    2, table_cell),
    JS_CFUNC_DEF("SetCell", 3, table_set_cell),
    JS_CFUNC_DEF("SetIcon", 3, table_set_icon),
    JS_CGETSET_DEF("Sortable", table_get_sortable, table_set_sortable),
    JS_CFUNC_MAGIC_DEF("Select",      1, table_select_one,   TB_SELECT),
    JS_CFUNC_MAGIC_DEF("Deselect",    1, table_select_one,   TB_DESELECT),
    JS_CFUNC_MAGIC_DEF("SelectAll",   0, table_select_every, TB_ALL),
    JS_CFUNC_MAGIC_DEF("DeselectAll", 0, table_select_every, TB_NONE),
    JS_CFUNC_DEF("SortBy",  2, table_sort_by),
    JS_CFUNC_DEF("SortColumn", 2, table_sort_column),
};

void bta_table_register(void)
{
    const BtaClass rows[] = {
        /*
         * `Columns.Text` and not `Columns`: a column carries a heading, a width
         * and an alignment, and only the first is prose. Translating `Right`
         * would be the permissive mistake this declaration exists to prevent.
         */
        BTA_CLASS_ENUM_TEXT("TableView", "Control", build_table, table_props, false,
                            table_options, "Columns.Text", "Select,Activate,Data,Sort"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
