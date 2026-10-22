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

#include <math.h>
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
    GPtrArray *uris;           /* of char*, lazily made: what `SetUri` put on a link cell */
    GPtrArray *styles;         /* of char*, lazily made: the theme class `SetStyle`
                                * put on a cell */
    GByteArray *locked;        /* one per column, lazily made: what `SetEditable`
                                * took away from an editing column */
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
    g_clear_pointer(&self->uris, g_ptr_array_unref);
    g_clear_pointer(&self->styles, g_ptr_array_unref);
    g_clear_pointer(&self->locked, g_byte_array_unref);
    g_clear_pointer(&self->cells, g_ptr_array_unref);
    g_clear_pointer(&self->key, g_free);
    g_clear_object(&self->children);
    G_OBJECT_CLASS(bta_table_row_parent_class)->finalize(object);
}

/*
 * **A row says it changed, and the cells drawn for it listen.** Telling the
 * store is not enough for a flat table: GTK keeps the widgets of an item that is
 * still the same object across `items-changed` and does not bind them again --
 * measured on 4.22, where `SetCell` on a flat table changed `Cell()` and left
 * the screen saying what it said. A tree gets new `GtkTreeListRow` wrappers and
 * is rebound either way; this is for the shape that is not.
 */
static guint row_changed_signal;

static void bta_table_row_class_init(BtaTableRowClass *klass)
{
    G_OBJECT_CLASS(klass)->finalize = bta_table_row_finalize;
    row_changed_signal = g_signal_new("changed", G_TYPE_FROM_CLASS(klass),
                                      G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
                                      G_TYPE_NONE, 0);
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

static const char *row_uri(BtaTableRow *row, guint i)
{
    return row && row->uris && i < row->uris->len ? row->uris->pdata[i] : NULL;
}

static const char *row_style(BtaTableRow *row, guint i)
{
    return row && row->styles && i < row->styles->len ? row->styles->pdata[i] : NULL;
}

static bool row_locked(BtaTableRow *row, guint i)
{
    return row && row->locked && i < row->locked->len && row->locked->data[i];
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
 * What that buys is in `docs/plans/strict-plan.md`: the note was created **when
 * an application assigned `Columns`**, so it was an own property that appeared
 * at any moment in a program's life, and a widget whose own properties are
 * exactly its properties cannot have one of those.
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
    int            header_min;    /* a floor for the row of column headings */

    /* **The current cell**: the row the reader is on, held, and its column.
     * `NULL` when there is none. The row is held so the address survives the
     * store telling its cells changed; the verbs that empty a table -- `Clear`,
     * `RemoveRow`, `RemoveNode`, `Count` -- drop it first, so a removed row is
     * not kept alive by this. */
    BtaTableRow   *cell;
    guint          cell_col;

    /* **How many times the table was remade**: `Clear`, `Count`, `Columns`,
     * a model of another shape (on demand, a tree, multiple selection). A verb
     * that raises an event and goes on working reads it before the emit and
     * gives up if it moved -- the one question that has an answer in every
     * mode, since an on-demand row is only an index and the index survives a
     * `Count = 0; Count = 50` that made it another row. See `cell_refind`. */
    guint          epoch;
} TableState;

static void table_state_free(gpointer p)
{
    TableState *st = p;
    g_clear_pointer(&st->keys, g_hash_table_unref);
    g_clear_object(&st->virt);
    g_clear_object(&st->rows);
    g_clear_object(&st->cell);
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
 * What this widget's nodes are, for the walk that reaches their rows.
 *
 * The walk is `bta_treerows.c`, shared with `TreeView`: the two are the same
 * three pieces -- a store of roots, a `GtkTreeListModel` over it, and nodes that
 * know their parent -- and each had its own copy of the same scan, comment and
 * all. All that differs is the node type, so that is all this declares.
 */
static gpointer table_shape_parent(gpointer node)
{
    return ((BtaTableRow *)node)->parent;
}

static GListModel *table_shape_children(gpointer node)
{
    return G_LIST_MODEL(((BtaTableRow *)node)->children);
}

static GListModel *table_shape_roots(BtaWidget *w)
{
    return G_LIST_MODEL(table_state(w)->rows);
}

static const BtaTreeShape table_shape = {
    table_shape_parent, table_shape_children, table_shape_roots,
};

static GtkTreeListRow *table_row_of(BtaWidget *w, BtaTableRow *node)
{
    return bta_tree_row_of(w, table_tree_model(w), node, &table_shape);
}

static void table_set_expanded(BtaWidget *w, BtaTableRow *node, bool open)
{
    bta_tree_set_expanded(w, table_tree_model(w), node, open, &table_shape);
}

static void table_reveal(BtaWidget *w, BtaTableRow *node, bool with_node)
{
    bta_tree_reveal(w, table_tree_model(w), node, with_node, &table_shape);
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
    if (!bta_to_int(ctx, v, "row", &i)) {
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
 * One row's cells changed, whichever mode: the store the node sits in is told,
 * and the row's own signal is emitted so the cells drawn for it fill themselves
 * again -- **both halves in both shapes**, because GTK keeps the widgets of an
 * item it already has and the repaint has to be asked for (see the comment
 * inside on the tree half, which was missing it).
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
        /* The cells drawn for it fill themselves again (see
         * `row_changed_signal`); the store is told too, for whoever else
         * watches it. */
        if (at >= 0)
            g_list_model_items_changed(G_LIST_MODEL(table_state(w)->rows),
                                       (guint)at, 1, 1);
        g_signal_emit(row, row_changed_signal, 0);
        return;
    }

    BtaTableRow *was = table_selected_node(w);

    table_node_changed(w, row);
    /*
     * **And the cells drawn for it fill themselves again, exactly as the flat
     * table's do.** Telling the store rebuilds the tree's wrappers, and GTK
     * 4.22 keeps the widgets of an item it already had -- measured: locking a
     * tree's header cell after it was drawn left the label exactly as it was,
     * while the same call on a flat row repainted it. The row's own signal is
     * what the bound cells listen to, so it is emitted here too.
     */
    g_signal_emit(row, row_changed_signal, 0);
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
static gboolean on_cell_link(GtkLabel *label, const char *uri, gpointer user_data);

/* ------------------------------------------------------------ the editors */

/*
 * **A column's editor is a kind with options**, and the kinds are a table:
 * adding one is a row here, a case in `cell_open` and one in `cell_value`.
 * Every kind reads the cell's text and hands text back -- a cell is text, so
 * `Add`, `Cell`, `Data`, `SortBy` and the `.form` know nothing of editors.
 *
 *   Text     a field
 *   Number   a spin with `Min`, `Max`, `Step`, `Decimals`; answers the number
 *            with a point, whatever the desktop writes
 *   Date     a field with a calendar beside it; a day picked is `YYYY-MM-DD`,
 *            and what is typed is the program's to read
 *   Check    a tick drawn in the cell, which holds `ActiveText` or
 *            `InactiveText` (`"true"`/`"false"`)
 *   Combo    a list of `Items` that opens under the cell
 *   Custom   nothing of its own: the cell shows `…` and the gesture raises
 *            `CellEditor`, which is where the program opens its own dialog
 *
 * The prior art is the same five everywhere -- GTK3's `CellRenderer` set,
 * WinForms' `DataGridView` columns, DevExpress' `Properties`, AG Grid's
 * editors -- plus Delphi's ellipsis button, which is `Custom`.
 */
typedef enum {
    ED_NONE = 0, ED_TEXT, ED_NUMBER, ED_DATE, ED_CHECK, ED_COMBO, ED_CUSTOM
} EdKind;

static const struct {
    const char *name;
    const char *options;     /* what it takes beside `Kind`, comma separated */
} ED_KINDS[] = {
    [ED_NONE]   = { "",       ""                        },
    [ED_TEXT]   = { "Text",   ""                        },
    [ED_NUMBER] = { "Number", "Min,Max,Step,Decimals"   },
    [ED_DATE]   = { "Date",   ""                        },
    [ED_CHECK]  = { "Check",  "ActiveText,InactiveText" },
    [ED_COMBO]  = { "Combo",  "Items"                   },
    [ED_CUSTOM] = { "Custom", ""                        },
};

#define ED_KIND_LIST "Text, Number, Date, Check, Combo or Custom"

/* A column's editor, shared by every cell of it and copied for an edit that
 * `CellEditor` adjusted -- so it is reference counted. */
typedef struct {
    EdKind  kind;
    double  min, max, step;
    int     decimals;
    char  **items;
    char   *active, *inactive;
} EdSpec;

static void ed_spec_clear(gpointer p)
{
    EdSpec *s = p;

    g_strfreev(s->items);
    g_free(s->active);
    g_free(s->inactive);
}

static void ed_spec_unref(gpointer s)
{
    g_rc_box_release_full(s, ed_spec_clear);
}

static EdSpec *ed_spec_new(EdKind kind)
{
    EdSpec *s = g_rc_box_new0(EdSpec);

    s->kind     = kind;
    s->min      = -1e15;
    s->max      = 1e15;
    s->step     = 1;
    s->active   = g_strdup("true");
    s->inactive = g_strdup("false");
    return s;
}

static EdSpec *ed_spec_copy(const EdSpec *src)
{
    EdSpec *s = g_rc_box_new0(EdSpec);

    *s          = *src;
    s->items    = g_strdupv(src->items);
    s->active   = g_strdup(src->active);
    s->inactive = g_strdup(src->inactive);
    return s;
}

static EdKind ed_kind_named(const char *name)
{
    for (guint k = ED_TEXT; k < G_N_ELEMENTS(ED_KINDS); k++)
        if (name && !strcmp(name, ED_KINDS[k].name))
            return (EdKind)k;
    return ED_NONE;
}

static bool ed_takes(EdKind k, const char *key)
{
    char **opts = g_strsplit(ED_KINDS[k].options, ",", -1);
    bool   in   = g_strv_contains((const char *const *)opts, key);

    g_strfreev(opts);
    return in;
}

/* One option's number, refused when it is not one or not finite. */
static bool ed_number(JSContext *ctx, JSValueConst o, const char *key,
                      const char *where, double *out)
{
    JSValue v = JS_GetPropertyStr(ctx, o, key);
    bool    ok = true;

    if (!JS_IsUndefined(v)) {
        char name[96];

        g_snprintf(name, sizeof name, "%s: %s", where, key);
        ok = bta_to_number(ctx, v, name, out);
        if (ok && !isfinite(*out)) {
            JS_ThrowRangeError(ctx, "%s is not a finite number", name);
            ok = false;
        }
    }
    JS_FreeValue(ctx, v);
    return ok;
}

/* One option's text: a string or nothing, because these are the very values a
 * cell will hold -- a `true` here would be stored as the word "true". */
static bool ed_text(JSContext *ctx, JSValueConst o, const char *key,
                    const char *where, char **out)
{
    JSValue v  = JS_GetPropertyStr(ctx, o, key);
    bool    ok = true;

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);

        ok = s != NULL;
        if (s) {
            g_free(*out);
            *out = g_strdup(s);
            JS_FreeCString(ctx, s);
        }
    } else if (!JS_IsUndefined(v)) {
        JS_ThrowTypeError(ctx, "%s: %s is the text the cell holds, as a string",
                          where, key);
        ok = false;
    }
    JS_FreeValue(ctx, v);
    return ok;
}

/*
 * An editor out of a declaration (`base` NULL: a column's `Editor`, a kind's
 * name or `{ Kind, ... }`) or out of `CellEditor`'s answer (`base` the
 * column's: `{ ... }` over it, `Kind` optional).
 *
 * **A misspelt option is refused by name**, which is `Popover.Show`'s rule:
 * `Itmes` quietly ignored is a combo with nothing in it, and that reads as the
 * feature not working. Answers NULL with the exception pending.
 */
static EdSpec *ed_spec_read(JSContext *ctx, JSValueConst v, const char *where,
                            const EdSpec *base)
{
    if (!base && JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        EdKind      k = ed_kind_named(s);

        if (!k)
            JS_ThrowRangeError(ctx, "%s: Editor is " ED_KIND_LIST ", not '%s'",
                               where, s ? s : "?");
        JS_FreeCString(ctx, s);
        return k ? ed_spec_new(k) : NULL;
    }
    if (!JS_IsObject(v) || JS_IsArray(v)) {
        JS_ThrowTypeError(ctx, base
            ? "%s: the answer is false, or { Kind, ... } for this edit"
            : "%s: Editor is a kind's name, or { Kind, ... }", where);
        return NULL;
    }

    /* The kind first: what the other keys may be depends on it. */
    JSValue kv = JS_GetPropertyStr(ctx, v, "Kind");
    EdKind  k  = base ? base->kind : ED_NONE;

    if (JS_IsString(kv)) {
        const char *s = JS_ToCString(ctx, kv);

        k = ed_kind_named(s);
        if (!k)
            JS_ThrowRangeError(ctx, "%s: Kind is " ED_KIND_LIST ", not '%s'",
                               where, s ? s : "?");
        JS_FreeCString(ctx, s);
    } else if (!JS_IsUndefined(kv) || !base) {
        JS_ThrowTypeError(ctx, "%s: Kind is " ED_KIND_LIST, where);
        k = ED_NONE;
    }
    JS_FreeValue(ctx, kv);
    if (!k)
        return NULL;

    /* **A tick is drawn in every cell of its column**, where the others draw a
     * label and open a field on demand: a cell cannot become one, nor stop
     * being one, for the length of one edit. */
    if (base && k != base->kind && (k == ED_CHECK || base->kind == ED_CHECK)) {
        JS_ThrowTypeError(ctx, "%s: a Check column stays a Check, and no other "
                               "column becomes one", where);
        return NULL;
    }

    JSPropertyEnum *tab;
    uint32_t        n;

    if (JS_GetOwnPropertyNames(ctx, &tab, &n, v,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return NULL;
    for (uint32_t i = 0; i < n; i++) {
        const char *key = JS_AtomToCString(ctx, tab[i].atom);
        bool        ok  = key && (!strcmp(key, "Kind") || ed_takes(k, key));

        if (!ok) {
            const char *opts = ED_KINDS[k].options;

            JS_ThrowTypeError(ctx, "%s: '%s' is not an option of a %s editor%s%s%s",
                              where, key ? key : "?", ED_KINDS[k].name,
                              *opts ? " (" : "", opts, *opts ? ")" : "");
        }
        JS_FreeCString(ctx, key);
        if (!ok) {
            JS_FreePropertyEnum(ctx, tab, n);
            return NULL;
        }
    }
    JS_FreePropertyEnum(ctx, tab, n);

    EdSpec *s = base && base->kind == k ? ed_spec_copy(base) : ed_spec_new(k);

    if (!ed_number(ctx, v, "Min", where, &s->min) ||
        !ed_number(ctx, v, "Max", where, &s->max) ||
        !ed_number(ctx, v, "Step", where, &s->step) ||
        !ed_text(ctx, v, "ActiveText", where, &s->active) ||
        !ed_text(ctx, v, "InactiveText", where, &s->inactive))
        goto refuse;

    JSValue dv = JS_GetPropertyStr(ctx, v, "Decimals");
    if (!JS_IsUndefined(dv)) {
        char    name[96];
        int32_t d;

        g_snprintf(name, sizeof name, "%s: Decimals", where);
        if (!bta_to_int(ctx, dv, name, &d)) {
            JS_FreeValue(ctx, dv);
            goto refuse;
        }
        if (d < 0 || d > 9) {
            JS_FreeValue(ctx, dv);
            JS_ThrowRangeError(ctx, "%s is 0 to 9, not %d", name, d);
            goto refuse;
        }
        s->decimals = d;
    }
    JS_FreeValue(ctx, dv);

    JSValue iv = JS_GetPropertyStr(ctx, v, "Items");
    if (!JS_IsUndefined(iv)) {
        if (!JS_IsArray(iv)) {
            JS_FreeValue(ctx, iv);
            JS_ThrowTypeError(ctx, "%s: Items is a list of strings", where);
            goto refuse;
        }

        JSValue  lv = JS_GetPropertyStr(ctx, iv, "length");
        uint32_t len = 0;
        GStrvBuilder *b = g_strv_builder_new();

        JS_ToUint32(ctx, &len, lv);
        JS_FreeValue(ctx, lv);
        for (uint32_t i = 0; i < len; i++) {
            JSValue     e = JS_GetPropertyUint32(ctx, iv, i);
            const char *t = JS_IsString(e) ? JS_ToCString(ctx, e) : NULL;

            if (!t) {
                JS_FreeValue(ctx, e);
                JS_FreeValue(ctx, iv);
                g_strv_builder_unref(b);
                JS_ThrowTypeError(ctx, "%s: Items[%u] is not a string", where, i);
                goto refuse;
            }
            g_strv_builder_add(b, t);
            JS_FreeCString(ctx, t);
            JS_FreeValue(ctx, e);
        }
        g_strfreev(s->items);
        s->items = g_strv_builder_end(b);
        g_strv_builder_unref(b);
    }
    JS_FreeValue(ctx, iv);

    /* The numbers in a refusal are spelt with a point on every desktop:
     * the printf under `JS_Throw*` writes the locale's decimal comma. */
    char n1[G_ASCII_DTOSTR_BUF_SIZE], n2[G_ASCII_DTOSTR_BUF_SIZE];

    if (s->min > s->max) {
        JS_ThrowRangeError(ctx, "%s: Min %s is above Max %s", where,
                           g_ascii_dtostr(n1, sizeof n1, s->min),
                           g_ascii_dtostr(n2, sizeof n2, s->max));
        goto refuse;
    }
    if (s->step <= 0) {
        JS_ThrowRangeError(ctx, "%s: Step is above zero, not %s", where,
                           g_ascii_dtostr(n1, sizeof n1, s->step));
        goto refuse;
    }
    if (!strcmp(s->active, s->inactive)) {
        JS_ThrowRangeError(ctx, "%s: ActiveText and InactiveText are both '%s', "
                                "so a cell could not say which it is",
                           where, s->active);
        goto refuse;
    }
    return s;

refuse:
    ed_spec_unref(s);
    return NULL;
}

/* -------------------------------------------------------------- the cell */

/*
 * A cell of a column that edits. The box holds it (`CELL_KEY`), so it lives as
 * long as the list item's widgets do, across every row they are bound to.
 *
 * **It shows a `GtkLabel` and opens a field on demand**, rather than being a
 * `GtkEditableLabel`: that one was the only editor there could be, it was not a
 * label (no ellipsis, an alignment of its own), and the other kinds -- a spin,
 * a calendar, a list -- have no such widget at all. One road for every kind is
 * what makes them behave alike: the same gesture opens each, Enter and the
 * focus leaving commit each, Escape cancels each, and each reports the same
 * `CellEdit`.
 */
#define CELL_KEY "bta-cell"

typedef struct {
    GWeakRef     table;     /* the TableView's w->gtk: asked, never trusted */
    guint        col;
    EdSpec      *spec;      /* the column's, held */
    float        xalign;
    GtkWidget   *box;       /* borrowed: it holds this */
    GtkWidget   *view;      /* the label, or the tick */
    GtkWidget   *more;      /* Custom: the `…`, else NULL */
    BtaTableRow *row;       /* bound, borrowed; NULL between unbind and bind */
    char        *text;      /* what the bound cell says */
    bool         locked;    /* this row's cell is not to be edited */

    /* While an edit is open. */
    GtkWidget   *editor;    /* what replaced the label in the box */
    GtkWidget   *field;     /* the part holding the text: an entry or a spin */
    BtaTableRow *erow;      /* held for the length of the edit */
    EdSpec      *espec;     /* this edit's: the column's, or CellEditor's over it */
    char        *was;       /* the text the edit began from */
    char        *chosen;    /* Combo: the item picked */
    guint        gen;       /* which edit a queued end is about */
    bool         pointer;   /* Date: the calendar's day is a press, not a key */
    gint64       pressed;   /* when a press last landed inside the editor */
} BtaCell;

static void cell_free(gpointer p)
{
    BtaCell *c = p;

    g_weak_ref_clear(&c->table);
    g_clear_pointer(&c->spec, ed_spec_unref);
    g_clear_pointer(&c->espec, ed_spec_unref);
    g_clear_object(&c->erow);
    g_free(c->text);
    g_free(c->was);
    g_free(c->chosen);
    g_free(c);
}

static BtaCell *cell_get(GtkWidget *box)
{
    return box ? g_object_get_data(G_OBJECT(box), CELL_KEY) : NULL;
}

/*
 * **The table a cell belongs to, or NULL once it is gone.** A queued end runs a
 * turn later, and by then the control may have been deleted: the cell keeps a
 * weak reference to the scroller and asks it for its `BtaWidget`, which the
 * finaliser clears -- the shape `Terminal.Run` settled on, and the reason no
 * queued job here holds a `JSValue` that teardown would have to find.
 */
static BtaWidget *cell_table(BtaCell *c)
{
    GObject   *g = g_weak_ref_get(&c->table);
    BtaWidget *w = g ? g_object_get_data(g, BTA_WIDGET_QUARK) : NULL;

    if (g)
        g_object_unref(g);
    return w;
}

/* How a row is named to the program: an index in a flat table, a key in a tree,
 * as every verb and event of this control names one. */
static JSValue table_address(JSContext *ctx, BtaWidget *w, BtaTableRow *row)
{
    if (table_state(w)->tree)
        return JS_NewString(ctx, row->key ? row->key : "");

    int at = row->cells ? table_index_in(table_store_of(w, row), row)
                        : (int)row->index;
    return JS_NewInt32(ctx, at);
}

/*
 * Whether a row is still the table's, asked after a handler that may have
 * emptied it. **A tree is asked through its key index and never through
 * `table_store_of`**, which walks `row->parent` -- a parent a `Clear()` in the
 * handler freed, while the row itself is held here. A flat table's store is the
 * control's own and cannot go. Answers the index for a flat row, 0 for a node,
 * -1 for neither.
 */
static int table_still_holds(BtaWidget *w, BtaTableRow *row)
{
    TableState *st = table_state(w);

    if (!row->cells)
        return -1;
    if (st->tree)
        return st->keys && row->key &&
               g_hash_table_lookup(st->keys, row->key) == row ? 0 : -1;
    return table_index_in(st->rows, row);
}

/*
 * The edit is over and changed something: report it and let the program decide.
 *
 * `CellEdit(row, column, text, how)`. **`false` refuses it** and the cell says
 * what it said; **a string is what to keep instead** -- the program's spelling of
 * what was typed, `"2"` kept as `"2d"`; anything else keeps the text. A held row
 * is written here, after the handler, so a `SetCell` inside it used to be
 * overwritten by the typed text -- the string answer is the way to say it. A
 * handler that throws has not accepted anything, so it refuses.
 *
 * **`how` says what ended the edit**: `"enter"`, `"tab"` and `"shift-tab"` are
 * the grid's move-on keys (the keys themselves are consumed, and an edit that
 * ends with one is reported even when nothing changed, because the program
 * reads the reason and moves); `"pick"` is a day, an item or a tick chosen;
 * `"focus"` is the keyboard leaving; `"code"` is `EndEdit`; `"left"` is the row
 * unbound -- scrolled away -- with the edit committed. The empty string is an
 * old caller that ended it without saying.
 *
 * Answers what the cell should say now. Everything the handler could change is
 * taken before it runs: the row and the table's wrapper are held, both texts
 * are copied.
 */
static char *table_report_edit(BtaWidget *w, BtaTableRow *row, guint col,
                               const char *old, const char *now,
                               const char *how)
{
    JSContext *ctx   = w->ctx;
    JSValue    self  = JS_DupValue(ctx, w->self);
    char      *was   = g_strdup(old ? old : "");
    char      *typed = g_strdup(now ? now : "");
    char      *out   = NULL;
    bool       threw = false;

    g_object_ref(row);

    /*
     * **A held flat row the program removed is not asked about.** The commit
     * is queued (`cell_finish`, `CellReport`), so the row may be gone by the
     * time it runs -- and the address a flat table has is its position, which
     * is `-1` once it has none: a `CellEdit(-1, ...)` names no row at all. A
     * tree keeps its key, and an on-demand row is the program's to store, so
     * both are reported as ever; this is the one shape whose row can be gone
     * *and* whose name for it goes with it. Asked again after the handler
     * below, which may empty the table under it.
     */
    bool gone = row->cells && !table_state(w)->tree &&
                table_still_holds(w, row) < 0;

    if (!gone) {
        JSValue argv[4] = { table_address(ctx, w, row), JS_NewInt32(ctx, (int)col),
                            JS_NewString(ctx, typed),
                            JS_NewString(ctx, how ? how : "") };
        JSValue r = bta_emit_answer(w, "CellEdit", 4, argv, &threw);

        if (threw || JS_IsStrictEqual(ctx, r, JS_FALSE)) {
            out = g_steal_pointer(&was);
        } else {
            if (JS_IsString(r)) {
                const char *s = JS_ToCString(ctx, r);
                out = g_strdup(s ? s : typed);
                JS_FreeCString(ctx, s);
            } else {
                out = g_strdup(typed);
            }

            int here = table_still_holds(w, row);
            if (here >= 0) {
                while (row->cells->len <= col)
                    g_ptr_array_add(row->cells, g_strdup(""));
                g_free(row->cells->pdata[col]);
                row->cells->pdata[col] = g_strdup(out);
                table_row_changed(w, row, table_state(w)->tree ? -1 : here);
            }
        }

        JS_FreeValue(ctx, r);
        for (int i = 0; i < 4; i++)
            JS_FreeValue(ctx, argv[i]);
    } else {
        out = g_steal_pointer(&was);
    }

    g_free(was);
    g_free(typed);
    g_object_unref(row);
    JS_FreeValue(ctx, self);
    return out;
}

static void on_check_toggled(GtkCheckButton *b, gpointer data);

/* Whether the bound cell is locked. **A held row is asked itself**: what the
 * cell remembers is from its last bind, and the rebind a `SetEditable` asks for
 * comes on GTK's next frame -- so `EditCell` right after it would read the old
 * answer. An on-demand row has only what `Data` said. */
static bool cell_locked(BtaCell *c)
{
    return c->row && c->row->cells ? row_locked(c->row, c->col) : c->locked;
}

/* What the cell shows when it is not being edited. */
static void cell_show(BtaCell *c)
{
    const char *t = c->text ? c->text : "";

    if (c->spec->kind == ED_CHECK) {
        g_signal_handlers_block_by_func(c->view, on_check_toggled, c);
        gtk_check_button_set_active(GTK_CHECK_BUTTON(c->view),
                                    !strcmp(t, c->spec->active));
        g_signal_handlers_unblock_by_func(c->view, on_check_toggled, c);
        gtk_widget_set_sensitive(c->view, !c->locked);
        return;
    }

    gtk_label_set_text(GTK_LABEL(c->view), t);
    /* **A cell that will not edit says so before it is clicked**, which is the
     * whole of what the per-cell answer is for: a summary's dates are its
     * children's, and Project greys them. */
    if (c->locked)
        gtk_widget_add_css_class(c->view, "dim-label");
    else
        gtk_widget_remove_css_class(c->view, "dim-label");
    if (c->more)
        gtk_widget_set_visible(c->more, !c->locked);
}

/* Whether the window's focus is in `w` or under it -- a popover counts, since
 * its parent is the button that opened it. */
static bool focus_inside(GtkWidget *w)
{
    GtkRoot   *root = w ? gtk_widget_get_root(w) : NULL;
    GtkWidget *f    = root ? gtk_root_get_focus(root) : NULL;

    return f && (f == w || gtk_widget_is_ancestor(f, w));
}

/*
 * Takes the editor out and puts the label back, reporting nothing. `gen` moves
 * first, so whatever the removal itself raises -- a focus that leaves, a popover
 * that closes -- is about an edit that is over.
 *
 * **The focus goes back to the table only if it was in the editor**: after an
 * Enter or an Escape it was, and the keyboard should stay in the grid; after a
 * click somewhere else it is where the click put it, and taking it back would
 * undo the click.
 */
/* GTK's own cell widget around a cell's box (a tree has an expander between),
 * which is the node whose padding the theme sets. It carries
 * `bta-cell-editing` only while an editor is open in it, so the row keeps its
 * height when nothing is being edited. */
static void cell_editing_class(GtkWidget *box, bool on)
{
    for (GtkWidget *x = box; x; x = gtk_widget_get_parent(x)) {
        if (g_str_equal(G_OBJECT_TYPE_NAME(x), "GtkColumnViewCellWidget")) {
            if (on)
                gtk_widget_add_css_class(x, "bta-cell-editing");
            else
                gtk_widget_remove_css_class(x, "bta-cell-editing");
            return;
        }
    }
}

static void cell_take_editor(BtaCell *c, BtaWidget *w)
{
    GtkWidget *ed = c->editor;

    if (!ed)
        return;

    bool inside = focus_inside(ed);

    c->gen++;
    c->editor = NULL;
    c->field  = NULL;
    cell_editing_class(c->box, false);
    gtk_box_remove(GTK_BOX(c->box), ed);
    gtk_widget_set_visible(c->view, TRUE);
    g_clear_pointer(&c->espec, ed_spec_unref);
    g_clear_pointer(&c->chosen, g_free);
    cell_show(c);

    if (inside && w)
        gtk_widget_grab_focus(w->inner);
}

/*
 * A number as a cell's text, at `places` decimals, **rounded as a person rounds**.
 *
 * `%.1f` of 12.25 is `12.2`: printf rounds the double half to even, and 12.25
 * is exact in binary, so a spin set to 12.25 came out a tenth short -- measured
 * typing it into a `Decimals: 1` cell. And 1.005 is not exact at all, so
 * printf sees 1.00499... So the double's **shortest text** is taken -- the first
 * `%.Ng` that reads back as the same double, `1.005` -- and rounded as a
 * decimal, a half away from zero, which is `Decimal`'s own default. The point
 * and not the desktop's comma: this is data the program reads back, and `%f`
 * follows LC_NUMERIC.
 */
static char *number_text(double v, int places)
{
    char    buf[G_ASCII_DTOSTR_BUF_SIZE];
    char    fmt[8];
    int64_t units;
    int     scale;

    for (int p = 1; p <= 17; p++) {
        g_snprintf(fmt, sizeof fmt, "%%.%dg", p);
        g_ascii_formatd(buf, sizeof buf, fmt, v);
        if (g_ascii_strtod(buf, NULL) == v)
            break;
    }

    /* Past what a scaled 64-bit count holds -- an exponent in the shortest
     * text -- the double's own rounding is all there is. */
    if (strchr(buf, 'e') || fabs(v) >= pow(10, 17 - places) ||
        !bta_decimal_from_text(buf, &units, &scale) || scale > 17) {
        g_snprintf(fmt, sizeof fmt, "%%.%df", places);
        g_ascii_formatd(buf, sizeof buf, fmt, v);
        return g_strdup(buf);
    }

    for (; scale < places; scale++)
        units *= 10;
    if (scale > places) {
        int64_t div = 1;

        for (int i = places; i < scale; i++)
            div *= 10;

        int64_t q = units / div, r = units % div;

        if ((r < 0 ? -r : r) * 2 >= div)
            q += units < 0 ? -1 : 1;
        units = q;
        scale = places;
    }
    return bta_decimal_to_text(units, scale);
}

/* What the open editor holds, as the cell's text; NULL when nothing was chosen. */
static char *cell_value(BtaCell *c)
{
    switch (c->espec->kind) {
    case ED_NUMBER: {
        GtkSpinButton *sp = GTK_SPIN_BUTTON(c->field);

        /* What was typed and not yet taken by the spin, taken now. */
        gtk_spin_button_update(sp);
        return number_text(gtk_spin_button_get_value(sp), c->espec->decimals);
    }
    case ED_COMBO:
        return c->chosen ? g_strdup(c->chosen) : NULL;
    default:
        return g_strdup(gtk_editable_get_text(GTK_EDITABLE(c->field)));
    }
}

/* The keys that mean "and go on": an edit that ends with one is reported even
 * when nothing changed, because the program reads the reason and moves. */
static bool cell_move_key(const char *how)
{
    return how && (!strcmp(how, "enter") || !strcmp(how, "tab") ||
                   !strcmp(how, "shift-tab"));
}

/*
 * Ends the open edit: commits what it holds, or not. Runs outside GTK's own
 * signals -- from an idle, or from code -- because reporting runs the program,
 * and the program may empty the table this cell is drawn in.
 *
 * `how` is what ended it and is passed to `CellEdit`; NULL is a cancel, which
 * reports nothing.
 */
static void cell_finish(BtaCell *c, const char *how)
{
    if (!c->editor)
        return;

    BtaWidget   *w   = cell_table(c);
    char        *now = how ? cell_value(c) : NULL;
    BtaTableRow *row = g_steal_pointer(&c->erow);
    char        *was = g_steal_pointer(&c->was);
    GtkWidget   *box = g_object_ref(c->box);
    bool         inside = focus_inside(c->editor);

    cell_take_editor(c, w);

    if (w && now && row && (strcmp(now, was ? was : "") || cell_move_key(how))) {
        char *shown = table_report_edit(w, row, c->col, was, now, how);

        /* A held row is redrawn by the write; an on-demand one is the
         * program's, and the label says what it answered until `Data` is asked
         * again. */
        if (c->row == row) {
            g_free(c->text);
            c->text = g_steal_pointer(&shown);
            cell_show(c);
        }
        g_free(shown);
    }

    /*
     * **The focus is put back after the report.** A report tells the row's
     * store it changed, and a tree answers with fresh `GtkTreeListRow`
     * wrappers -- the widget the focus had just been handed to is destroyed
     * with the old ones, so the keyboard ended on nothing and F2 after a commit
     * reached no control at all. Only when the edit ended with the keyboard
     * inside it: a click somewhere else left the focus where the click put it.
     */
    if (w && inside) {
        GtkRoot   *root = gtk_widget_get_root(w->inner);
        GtkWidget *f    = root ? gtk_root_get_focus(root) : NULL;

        if (!f || !(f == w->inner || gtk_widget_is_ancestor(f, w->inner)))
            gtk_widget_grab_focus(w->inner);
    }

    g_free(now);
    g_free(was);
    g_clear_object(&row);
    g_object_unref(box);
}

/*
 * **An end asked for inside a GTK signal is queued**: Enter arrives in the
 * entry's own key handler and the focus leaving in the middle of a focus
 * change, and taking the entry out of its box there is taking a widget out
 * from under its own emission. The idle holds the box and the edit's `gen`;
 * nothing else, so a teardown that never runs it frees nothing it should.
 */
enum { SETTLE_COMMIT, SETTLE_CANCEL, SETTLE_BLUR, SETTLE_LEFT };

typedef struct {
    GtkWidget *box;
    guint      gen;
    int        how;
    const char *reason;   /* what ended it, for `CellEdit`; a static string */
} CellSettle;

static gboolean cell_settle_cb(gpointer p)
{
    CellSettle *s = p;
    BtaCell    *c = cell_get(s->box);

    if (!c || !c->editor || c->gen != s->gen)
        return G_SOURCE_REMOVE;

    switch (s->how) {
    case SETTLE_BLUR: {
        /* The focus went somewhere inside the editor -- its own popover --
         * or the window stopped being the active one: the edit goes on. */
        if (focus_inside(c->editor))
            break;

        /*
         * **A press inside the editor gives the focus to the row**: GTK's row
         * widget takes it at the press, before the button under the pointer
         * has done anything -- measured, the focus was the
         * `GtkColumnViewRowWidget` holding the cell. The release that opens the
         * calendar comes later, and a hand leaves a tenth of a second between
         * the two where `xdotool click` leaves none: the edit was committed and
         * the button taken away first, so the calendar never showed. So focus
         * on an ancestor of the editor, right after a press inside it, is not
         * leaving: the field gets it back, and the press goes on to what it was
         * on. Anywhere else, it is.
         */
        GtkRoot   *root = gtk_widget_get_root(c->editor);
        GtkWidget *f    = root ? gtk_root_get_focus(root) : NULL;
        bool       ours = c->pressed &&
                          g_get_monotonic_time() - c->pressed < 2 * G_USEC_PER_SEC &&
                          (!f || gtk_widget_is_ancestor(c->editor, f));

        c->pressed = 0;
        if (ours)
            gtk_widget_grab_focus(c->field ? c->field : c->editor);
        else
            cell_finish(c, "focus");
        break;
    }
    case SETTLE_LEFT:
        /* Unbound for good, not rebound to the same row a moment later: what
         * was typed is committed, not lost to a scroll. */
        if (c->row != c->erow)
            cell_finish(c, "left");
        break;
    default:
        cell_finish(c, s->how == SETTLE_COMMIT ? s->reason : NULL);
    }
    return G_SOURCE_REMOVE;
}

static void cell_settle_free(gpointer p)
{
    CellSettle *s = p;

    g_object_unref(s->box);
    g_free(s);
}

static void cell_settle(BtaCell *c, int how, const char *reason)
{
    CellSettle *s = g_new0(CellSettle, 1);

    s->box = g_object_ref(c->box);
    s->gen = c->gen;
    s->how = how;
    s->reason = reason;
    g_idle_add_full(G_PRIORITY_DEFAULT, cell_settle_cb, s, cell_settle_free);
}

/*
 * A report that cannot wait for the cell: the cell was bound to another row
 * with an edit open, so the label belongs to that row now. The edit's row,
 * texts and column travel on their own, and the table is asked again when it
 * runs.
 */
typedef struct {
    GWeakRef     table;
    BtaTableRow *row;
    guint        col;
    char        *was, *now;
} CellReport;

static gboolean cell_report_cb(gpointer p)
{
    CellReport *r = p;
    GObject    *g = g_weak_ref_get(&r->table);
    BtaWidget  *w = g ? g_object_get_data(g, BTA_WIDGET_QUARK) : NULL;

    if (w)
        g_free(table_report_edit(w, r->row, r->col, r->was, r->now, "left"));
    if (g)
        g_object_unref(g);
    return G_SOURCE_REMOVE;
}

static void cell_report_free(gpointer p)
{
    CellReport *r = p;

    g_weak_ref_clear(&r->table);
    g_object_unref(r->row);
    g_free(r->was);
    g_free(r->now);
    g_free(r);
}

/* The editor comes out now, inside a bind, and the report follows. */
static void cell_detach_later(BtaCell *c)
{
    char        *now = cell_value(c);
    BtaTableRow *row = g_steal_pointer(&c->erow);
    char        *was = g_steal_pointer(&c->was);
    GObject     *g   = g_weak_ref_get(&c->table);

    cell_take_editor(c, NULL);

    if (g && row && now && strcmp(now, was ? was : "")) {
        CellReport *r = g_new0(CellReport, 1);

        g_weak_ref_init(&r->table, g);
        r->row = g_steal_pointer(&row);
        r->col = c->col;
        r->was = g_steal_pointer(&was);
        r->now = g_steal_pointer(&now);
        g_idle_add_full(G_PRIORITY_DEFAULT, cell_report_cb, r, cell_report_free);
    }
    if (g)
        g_object_unref(g);
    g_clear_object(&row);
    g_free(was);
    g_free(now);
}

/* ---- the editors' own signals: each queues, none ends anything itself */

static gboolean on_editor_key(GtkEventControllerKey *k, guint keyval,
                              guint keycode, GdkModifierType state, gpointer data)
{
    BtaCell *c = data;

    if (!c->editor)
        return FALSE;
    if (keyval == GDK_KEY_Escape) {
        cell_settle(c, SETTLE_CANCEL, NULL);
        return TRUE;
    }
    /* Enter commits from the field; on the calendar's button or a combo's it
     * is the button's own, which opens its list. */
    if ((keyval == GDK_KEY_Return || keyval == GDK_KEY_KP_Enter ||
         keyval == GDK_KEY_ISO_Enter) && c->field && focus_inside(c->field)) {
        cell_settle(c, SETTLE_COMMIT, "enter");
        return TRUE;
    }
    /*
     * **Tab commits and is consumed**, so the program hears `how` and moves the
     * current cell itself. Left alone it would walk the focus -- out of the
     * grid and into whatever is next -- and the edit would end as a blur that
     * says nothing about where the reader meant to go. Consumed, the focus goes
     * back to the table when the edit is taken out (`cell_take_editor`), which
     * is where the next cell's frame is drawn.
     */
    if ((keyval == GDK_KEY_Tab || keyval == GDK_KEY_KP_Tab ||
         keyval == GDK_KEY_ISO_Left_Tab) && c->field && focus_inside(c->field)) {
        bool back = keyval == GDK_KEY_ISO_Left_Tab ||
                    (state & GDK_SHIFT_MASK) != 0;
        cell_settle(c, SETTLE_COMMIT, back ? "shift-tab" : "tab");
        return TRUE;
    }
    return FALSE;
}

static void on_editor_leave(GtkEventControllerFocus *f, gpointer data)
{
    BtaCell *c = data;

    if (c->editor)
        cell_settle(c, SETTLE_BLUR, "focus");
}

/* Date: the day picked, into the field, and the edit committed. */
static void cell_date_pick(BtaCell *c, GtkCalendar *cal)
{
    GDateTime *d   = gtk_calendar_get_date(cal);
    char      *iso = g_date_time_format(d, "%Y-%m-%d");
    GtkWidget *pop = gtk_widget_get_ancestor(GTK_WIDGET(cal), GTK_TYPE_POPOVER);

    gtk_editable_set_text(GTK_EDITABLE(c->field), iso);
    g_free(iso);
    g_date_time_unref(d);
    if (pop)
        gtk_popover_popdown(GTK_POPOVER(pop));
    cell_settle(c, SETTLE_COMMIT, "pick");
}

/*
 * **A day is picked by a press, or by Enter -- not by an arrow key.** A press
 * in the capture phase is seen before the calendar's own, which is where the
 * day changes; Enter is marked the same way below. An arrow raises nothing to
 * commit on, and a `day-selected` with no mark is not a pick.
 */
static void on_cal_press(GtkGestureClick *g, int n, double x, double y,
                         gpointer data)
{
    ((BtaCell *)data)->pointer = true;
}

static void on_cal_day(GtkCalendar *cal, gpointer data)
{
    BtaCell *c = data;

    if (!c->pointer || !c->editor)
        return;
    c->pointer = false;
    cell_date_pick(c, cal);
}

static void cal_select(GtkCalendar *cal, GDateTime *date);

/*
 * The calendar's keys. **In GTK 4 an arrow moves a focus ring over the days and
 * leaves the selection where it was, and Enter does not select the day under
 * the ring** -- only Space does, and nothing public says which day the ring is
 * on. Measured on 4.22: three arrows and Enter committed the day the calendar
 * opened on. So the arrows here move the *selection*, as GTK 3's did, a day or
 * a week at a time and across months, and Enter commits what is selected --
 * what is highlighted is what is picked.
 */
static gboolean on_cal_key(GtkEventControllerKey *k, guint keyval, guint keycode,
                           GdkModifierType state, gpointer data)
{
    BtaCell     *c   = data;
    GtkCalendar *cal = GTK_CALENDAR(gtk_event_controller_get_widget(
                                        GTK_EVENT_CONTROLLER(k)));
    int          by  = 0;

    c->pointer = false;           /* a press on a month arrow picked no day */
    if (!c->editor)
        return FALSE;

    switch (keyval) {
    case GDK_KEY_Return: case GDK_KEY_KP_Enter: case GDK_KEY_ISO_Enter:
    case GDK_KEY_space:  case GDK_KEY_KP_Space:
        cell_date_pick(c, cal);
        return TRUE;
    case GDK_KEY_Left:  case GDK_KEY_KP_Left:  by = -1; break;
    case GDK_KEY_Right: case GDK_KEY_KP_Right: by =  1; break;
    case GDK_KEY_Up:    case GDK_KEY_KP_Up:    by = -7; break;
    case GDK_KEY_Down:  case GDK_KEY_KP_Down:  by =  7; break;
    default:
        return FALSE;
    }

    GDateTime *now  = gtk_calendar_get_date(cal);
    GDateTime *then = g_date_time_add_days(now, by);

    /* Past 9999-12-31 or before year one there is no day to go to. */
    if (then) {
        cal_select(cal, then);
        g_date_time_unref(then);
    }
    g_date_time_unref(now);
    return TRUE;
}

static void on_combo_pick(GtkListBox *list, GtkListBoxRow *row, gpointer data)
{
    BtaCell *c  = data;
    int      at = gtk_list_box_row_get_index(row);

    if (!c->editor || !c->espec->items || at < 0 ||
        (guint)at >= g_strv_length(c->espec->items))
        return;
    g_free(c->chosen);
    c->chosen = g_strdup(c->espec->items[at]);
    gtk_popover_popdown(GTK_POPOVER(gtk_widget_get_ancestor(GTK_WIDGET(list),
                                                            GTK_TYPE_POPOVER)));
}

/* The list closed: with an item picked that is the edit, and without one --
 * Escape, a click elsewhere -- it is the edit given up. */
static void on_combo_closed(GtkPopover *pop, gpointer data)
{
    BtaCell *c = data;

    if (c->editor && GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(pop), "bta-gen"))
                         == c->gen)
        cell_settle(c, c->chosen ? SETTLE_COMMIT : SETTLE_CANCEL, "pick");
}

/*
 * The list opens once the button has a size: a popover presented against a
 * parent with no allocation is the `width > 0` assertion the completion popover
 * taught this tree. The button was put in the box a moment ago, so this waits
 * for the frame that lays it out.
 */
static gboolean combo_popup_tick(GtkWidget *mb, GdkFrameClock *clock, gpointer data)
{
    if (gtk_widget_get_width(mb) <= 0)
        return G_SOURCE_CONTINUE;

    gtk_menu_button_popup(GTK_MENU_BUTTON(mb));

    GtkListBox    *list = data;
    GtkListBoxRow *sel  = gtk_list_box_get_selected_row(list);
    GtkListBoxRow *row  = sel ? sel : gtk_list_box_get_row_at_index(list, 0);

    if (row)
        gtk_widget_grab_focus(GTK_WIDGET(row));
    return G_SOURCE_REMOVE;
}

/*
 * **The calendar takes the focus when it opens**, and not the popover's first
 * focusable child -- which is the month's back arrow, so the arrow keys walked
 * the heading's buttons and never moved the day. Measured with a real pointer:
 * Left did nothing, Enter picked the day the calendar opened on.
 */
static void on_cal_shown(GtkWidget *pop, gpointer cal)
{
    gtk_widget_grab_focus(GTK_WIDGET(cal));
}

/* Selects a day, whichever GTK this is: `set_day`/`_month`/`_year` are 4.14,
 * and the day goes to 1 first so the 31st does not clamp on the way through. */
static void cal_select(GtkCalendar *cal, GDateTime *date)
{
#if GTK_CHECK_VERSION(4, 14, 0)
    gtk_calendar_set_day(cal, 1);
    gtk_calendar_set_year(cal, g_date_time_get_year(date));
    gtk_calendar_set_month(cal, g_date_time_get_month(date) - 1);
    gtk_calendar_set_day(cal, g_date_time_get_day_of_month(date));
#else
    gtk_calendar_select_day(cal, date);
#endif
}

/* Date's first guess at a day: the cell's own `YYYY-MM-DD`, or today. */
static void cell_calendar_from(GtkCalendar *cal, const char *text)
{
    int y = 0, m = 0, d = 0;

    if (!text || sscanf(text, "%4d-%2d-%2d", &y, &m, &d) != 3 ||
        !g_date_valid_dmy((GDateDay)d, (GDateMonth)m, (GDateYear)y))
        return;

    GDateTime *date = g_date_time_new_local(y, m, d, 0, 0, 0);

    if (date) {
        cal_select(cal, date);
        g_date_time_unref(date);
    }
}

/*
 * Opens the editor `spec` says over the bound row's cell. A Check has none --
 * the tick is the editor, so opening one is turning it -- and a Custom has none
 * either: asking was the whole of it.
 */
/*
 * **An editor must not make its row taller.** A theme gives an entry, a spin
 * button and a menu button a `min-height` of their own (34 here) beyond what a
 * cell's label asks for, so opening any cell grew its row by two pixels and the
 * whole table shifted under the pointer. The class takes that floor off the
 * editor, so the row keeps the height the label gave it.
 *
 * **And the current cell has no frame.** It had an `outline`, and it drew a
 * black square around the editor it was editing -- the only style an editor
 * wears is `linked`, and the only thing played with is the padding
 * (`bta-cell-editing`). `bta-cell-current` is still on the cell, as a class
 * and nothing more, so an application's `app.css` can style it if it wants one.
 */
static void table_style_once(void)
{
    static GtkCssProvider *provider;

    if (provider)
        return;
    provider = gtk_css_provider_new();
    const char *css =
        "cell.bta-cell-editing { padding: 2px 6px; }"
        "spinbutton.bta-cell-editor:not(.vertical), "
        "spinbutton.bta-cell-editor:not(.vertical) > text, "
        "spinbutton.bta-cell-editor:not(.vertical) > button, "
        "entry.bta-cell-editor, entry.bta-cell-editor > text, "
        ".bta-cell-editor button, .bta-cell-editor entry, .bta-cell-editor text "
        "{ min-height: 0; margin-top: 0; margin-bottom: 0; "
        "padding-top: 0; padding-bottom: 0; }"
;
#if GTK_CHECK_VERSION(4, 12, 0)
    gtk_css_provider_load_from_string(provider, css);
#else
    gtk_css_provider_load_from_data(provider, css, -1);
#endif
    gtk_style_context_add_provider_for_display(gdk_display_get_default(),
        GTK_STYLE_PROVIDER(provider), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
}

static void cell_editor_style(GtkWidget *ed)
{
    table_style_once();
    gtk_widget_add_css_class(ed, "bta-cell-editor");
}

static bool cell_open(BtaCell *c, BtaWidget *w, BtaTableRow *row, EdSpec *spec)
{
    if (spec->kind == ED_CUSTOM) {
        ed_spec_unref(spec);
        return true;
    }
    if (spec->kind == ED_CHECK) {
        char *was = g_strdup(c->text ? c->text : "");
        const char *now = strcmp(was, spec->active) ? spec->active : spec->inactive;
        char *shown = table_report_edit(w, row, c->col, was, now, "pick");

        if (c->row == row) {
            g_free(c->text);
            c->text = g_steal_pointer(&shown);
            cell_show(c);
        }
        g_free(shown);
        g_free(was);
        ed_spec_unref(spec);
        return true;
    }

    const char *text = c->text ? c->text : "";
    GtkWidget  *ed   = NULL;

    c->espec = spec;
    c->erow  = g_object_ref(row);
    c->was   = g_strdup(text);

    switch (spec->kind) {
    case ED_TEXT:
        ed = c->field = gtk_entry_new();
        gtk_editable_set_text(GTK_EDITABLE(ed), text);
        break;

    case ED_NUMBER: {
        GtkAdjustment *adj = gtk_adjustment_new(0, spec->min, spec->max,
                                                spec->step, spec->step * 10, 0);
        char          *end = NULL;
        double         v   = g_ascii_strtod(text, &end);

        /* `2d` is two: the number the text starts with, which is how a
         * duration or a percentage is spelled. Nothing to read is the floor. */
        if (end == text)
            v = spec->min > 0 ? spec->min : 0;

        /* **The spin rounds what it shows with printf**, a half to even, and
         * then reads its own text back as the value: 12.25 at one decimal
         * opened as 12.2. It is handed the number already rounded our way. */
        char *shown = number_text(CLAMP(v, spec->min, spec->max), spec->decimals);
        v = g_ascii_strtod(shown, NULL);
        g_free(shown);
        ed = c->field = gtk_spin_button_new(adj, spec->step, (guint)spec->decimals);
        gtk_spin_button_set_value(GTK_SPIN_BUTTON(ed), CLAMP(v, spec->min, spec->max));
        break;
    }

    case ED_DATE: {
        GtkWidget *cal = gtk_calendar_new();
        GtkWidget *pop = gtk_popover_new();
        GtkWidget *mb  = gtk_menu_button_new();      /* no label: GTK's arrow */

        /* `linked`, with no spacing: the field and its button read as one
         * control, the way GTK draws an entry with a button joined to it. */
        ed = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
        gtk_widget_add_css_class(ed, "linked");
        c->field = gtk_entry_new();
        gtk_editable_set_text(GTK_EDITABLE(c->field), text);
        gtk_widget_set_hexpand(c->field, TRUE);

        cell_calendar_from(GTK_CALENDAR(cal), text);
        g_signal_connect(cal, "day-selected", G_CALLBACK(on_cal_day), c);

        GtkGesture *press = gtk_gesture_click_new();
        gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(press),
                                                   GTK_PHASE_CAPTURE);
        g_signal_connect(press, "pressed", G_CALLBACK(on_cal_press), c);
        gtk_widget_add_controller(cal, GTK_EVENT_CONTROLLER(press));

        GtkEventController *keys = gtk_event_controller_key_new();
        gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
        g_signal_connect(keys, "key-pressed", G_CALLBACK(on_cal_key), c);
        gtk_widget_add_controller(cal, keys);

        gtk_popover_set_child(GTK_POPOVER(pop), cal);
        g_signal_connect_after(pop, "map", G_CALLBACK(on_cal_shown), cal);
        gtk_menu_button_set_popover(GTK_MENU_BUTTON(mb), pop);
        gtk_box_append(GTK_BOX(ed), c->field);
        gtk_box_append(GTK_BOX(ed), mb);
        break;
    }

    case ED_COMBO: {
        GtkWidget *list   = gtk_list_box_new();
        GtkWidget *scroll = gtk_scrolled_window_new();
        GtkWidget *pop    = gtk_popover_new();

        ed = gtk_menu_button_new();
        gtk_menu_button_set_label(GTK_MENU_BUTTON(ed), text);
        gtk_list_box_set_selection_mode(GTK_LIST_BOX(list), GTK_SELECTION_BROWSE);
        for (int i = 0; spec->items && spec->items[i]; i++) {
            GtkWidget *lbl = gtk_label_new(spec->items[i]);

            gtk_label_set_xalign(GTK_LABEL(lbl), 0);
            gtk_list_box_append(GTK_LIST_BOX(list), lbl);
            if (!strcmp(spec->items[i], text))
                gtk_list_box_select_row(GTK_LIST_BOX(list),
                    gtk_list_box_get_row_at_index(GTK_LIST_BOX(list), i));
        }
        g_signal_connect(list, "row-activated", G_CALLBACK(on_combo_pick), c);

        gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll),
                                       GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
        gtk_scrolled_window_set_propagate_natural_height(GTK_SCROLLED_WINDOW(scroll), TRUE);
        gtk_scrolled_window_set_max_content_height(GTK_SCROLLED_WINDOW(scroll), 320);
        gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scroll), list);
        gtk_popover_set_child(GTK_POPOVER(pop), scroll);
        g_object_set_data(G_OBJECT(pop), "bta-gen", GUINT_TO_POINTER(c->gen));
        g_signal_connect(pop, "closed", G_CALLBACK(on_combo_closed), c);
        gtk_menu_button_set_popover(GTK_MENU_BUTTON(ed), pop);
        gtk_widget_add_tick_callback(ed, combo_popup_tick, list, NULL);
        break;
    }

    default:
        break;
    }

    if (c->field) {
        gtk_editable_set_alignment(GTK_EDITABLE(c->field), c->xalign);
        /* A field asks for a width of its own, which would widen a column
         * that sizes itself the moment the cell opens: it takes the cell's. */
        gtk_editable_set_width_chars(GTK_EDITABLE(c->field), 1);
    }
    gtk_widget_set_hexpand(ed, TRUE);
    cell_editor_style(ed);

    GtkEventController *keys = gtk_event_controller_key_new();
    gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
    g_signal_connect(keys, "key-pressed", G_CALLBACK(on_editor_key), c);
    gtk_widget_add_controller(ed, keys);

    GtkEventController *focus = gtk_event_controller_focus_new();
    g_signal_connect(focus, "leave", G_CALLBACK(on_editor_leave), c);
    gtk_widget_add_controller(ed, focus);

    c->editor = ed;
    cell_editing_class(c->box, true);
    gtk_widget_set_visible(c->view, FALSE);
    if (c->more)
        gtk_widget_set_visible(c->more, FALSE);
    gtk_box_append(GTK_BOX(c->box), ed);

    if (c->field) {
        gtk_widget_grab_focus(c->field);
        gtk_editable_select_region(GTK_EDITABLE(c->field), 0, -1);
    } else {
        gtk_widget_grab_focus(ed);
    }
    return true;
}

/*
 * Begins an edit of the bound cell, answering whether one began.
 *
 * `CellEditor(row, column)` is asked first, when a handler is there to ask:
 * **`false` refuses**, and an object is this edit's editor over the column's --
 * `{ Items: plan.Calendars }`, `{ Max: 1000 }`, or `{ Kind: "Date" }` for a
 * cell whose kind depends on its row. It is also the whole of a `Custom` cell.
 * The handler runs the program, so the row and the box are held across it and
 * the cell is asked again afterwards: a handler that moved things ends nothing
 * it did not mean to.
 */
static bool cell_begin(BtaCell *c)
{
    if (c->editor)
        return true;

    BtaWidget   *w   = cell_table(c);
    BtaTableRow *row = c->row;

    if (!w || !row || cell_locked(c) || c->spec->kind == ED_NONE)
        return false;

    JSContext *ctx   = w->ctx;
    JSValue    self  = JS_DupValue(ctx, w->self);
    EdSpec    *spec  = NULL;
    bool       go    = true;
    bool       threw = false;

    g_object_ref(row);
    g_object_ref(c->box);

    JSValue argv[2] = { table_address(ctx, w, row), JS_NewInt32(ctx, (int)c->col) };
    JSValue r       = bta_emit_answer(w, "CellEditor", 2, argv, &threw);

    if (threw || JS_IsStrictEqual(ctx, r, JS_FALSE)) {
        go = false;
    } else if (JS_IsObject(r)) {
        spec = ed_spec_read(ctx, r, "CellEditor", c->spec);
        if (!spec) {
            bta_dump_error(ctx);
            go = false;
        }
    } else {
        spec = g_rc_box_acquire(c->spec);
    }
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);

    if (go && (c->row != row || c->editor || cell_locked(c)))
        go = false;
    if (go)
        go = cell_open(c, w, row, g_steal_pointer(&spec));
    if (spec)
        ed_spec_unref(spec);

    g_object_unref(c->box);
    g_object_unref(row);
    JS_FreeValue(ctx, self);
    return go;
}

/*
 * A gesture asked for an edit: it begins a turn later, outside the gesture.
 *
 * **The job names the row and the column, not the widget.** Between the press
 * and the turn that serves it, the edit open elsewhere may have been committed
 * -- the press moved the focus -- and a commit tells the store, which may hand
 * this box to another row. So the cell is looked for again, by what it was
 * asked about.
 */
typedef struct {
    GtkWidget   *box;
    BtaTableRow *row;
    guint        col;
    guint        epoch;   /* the table's when it was asked; see cell_refind */
} CellBegin;

static BtaCell *table_find_cell(GtkWidget *x, BtaTableRow *row, int index, int col);
static BtaCell *cell_refind(BtaWidget *w, guint epoch, BtaTableRow *row, guint col);

static gboolean cell_begin_cb(gpointer p)
{
    CellBegin *b = p;
    BtaCell   *c = cell_get(b->box);
    BtaWidget *w = c ? cell_table(c) : NULL;

    /* A turn later, a commit's `CellEdit` may have remade the table, and the
     * box may draw another row: asked again by the address, as after any
     * emit -- which is also what finds an on-demand row, whose object a
     * rebind replaced. */
    if (!w)
        return G_SOURCE_REMOVE;
    if (c->row != b->row)
        c = cell_refind(w, b->epoch, b->row, b->col);
    else if (table_state(w)->epoch != b->epoch)
        c = NULL;


    if (c)
        cell_begin(c);
    return G_SOURCE_REMOVE;
}

static void cell_begin_free(gpointer p)
{
    CellBegin *b = p;

    g_object_unref(b->box);
    g_object_unref(b->row);
    g_free(b);
}

/*
 * **The drawn cell for an address, asked again after a handler ran.**
 * `CellChange` and `Select` run the program, and a handler that clears, refills
 * or reshapes the table makes GTK unbind -- and destroy -- the drawn rows at
 * once: the `BtaCell` in hand before the emit may be freed, or bound to another
 * row. So the caller holds the row (and the wrapper) and reads the table's
 * `epoch` before the emit, and asks after it: nothing if the table was remade
 * or left its window, else the cell drawn for the row -- a held row only while
 * the table still holds it, an on-demand one by its index. **Nothing found is
 * the gesture given up**, never handed to whatever row is there now.
 */
static BtaCell *cell_refind(BtaWidget *w, guint epoch, BtaTableRow *row, guint col)
{
    /* Remade, or taken out of its window (`Delete`, the form closed): the
     * gesture's target is gone, and it is not handed to whatever is there now. */
    if (!w->inner || !row || table_state(w)->epoch != epoch ||
        !gtk_widget_get_root(w->inner))
        return NULL;
    if (!row->cells)
        return table_find_cell(w->inner, NULL, (int)row->index, (int)col);
    if (table_still_holds(w, row) < 0)
        return NULL;
    return table_find_cell(w->inner, row, -1, (int)col);
}

static void cell_begin_later(BtaCell *c)
{
    CellBegin *b;
    BtaWidget *w;

    if (!c->row)
        return;
    b      = g_new0(CellBegin, 1);
    b->box = g_object_ref(c->box);
    b->row = g_object_ref(c->row);
    b->col = c->col;
    if ((w = cell_table(c)))
        b->epoch = table_state(w)->epoch;
    g_idle_add_full(G_PRIORITY_DEFAULT, cell_begin_cb, b, cell_begin_free);
}

/* The tick turned under the pointer or the space bar: it goes back to what the
 * cell says, and the edit decides what it becomes -- a refused one stays. */
static void on_check_toggled(GtkCheckButton *b, gpointer data)
{
    BtaCell *c = data;

    g_signal_handlers_block_by_func(b, on_check_toggled, c);
    gtk_check_button_set_active(b, !gtk_check_button_get_active(b));
    g_signal_handlers_unblock_by_func(b, on_check_toggled, c);
    if (c->row && !c->locked)
        cell_begin_later(c);
}

/* Puts the highlight on the row a cell belongs to, whichever shape. */
static void cell_select_row(BtaWidget *w, BtaTableRow *row)
{
    /* A tree opens the way to the node first, since a node under a closed
     * parent has no row to select. */
    if (table_state(w)->tree) {
        table_select_node(w, row);
        return;
    }

    /*
     * **An on-demand row is addressed by the index it stands for**, because
     * the model makes a fresh object per asked-for row: the one in hand is
     * never in a store to be found.
     */
    if (row && !row->cells) {
        gtk_selection_model_select_item(table_model(w), row->index, TRUE);
        return;
    }

    GListStore *store = table_store_of(w, row);
    int         at    = table_index_in(store, row);

    if (at >= 0)
        gtk_selection_model_select_item(table_model(w), (guint)at, TRUE);
}

/* The current cell: the press and F2 move it, and the verbs below draw it.
 * Defined after `table_find_cell`, which is what finds the drawn cell. */
static void table_current_set(BtaWidget *w, BtaTableRow *row, guint col);

/* The cell the focused widget is in: the box is an **ancestor** of whatever
 * holds the focus inside it -- the label, the tick, an editor's field -- so
 * this walks *up*. The first-child walk down this used to do found only leaves
 * (a `GtkBuiltinIcon`, a `GtkLabel`) and F2 did nothing on a tree -- and on a
 * clicked non-editable cell either. */
static BtaCell *cell_under(GtkWidget *x)
{
    for (; x; x = gtk_widget_get_parent(x)) {
        BtaCell *c = cell_get(x);
        if (c)
            return c;
    }
    return NULL;
}

/*
 * The first cell with an editor in the row the table has selected, or NULL.
 *
 * The keyboard is on the view after a commit -- there is no focused cell --
 * and F2 then means the row the reader is on. The walk is per column and stops
 * at the first found: the name column, in a table whose first column edits,
 * which is where a rename starts.
 */
static BtaCell *cell_of_selection(BtaWidget *w)
{
    GtkSelectionModel *sel = table_model(w);

    if (!GTK_IS_SINGLE_SELECTION(sel))
        return NULL;

    gpointer     item  = gtk_single_selection_get_selected_item(GTK_SINGLE_SELECTION(sel));
    BtaTableRow *row   = NULL;
    int          index = -1;
    bool         owned = false;

    if (!item)
        return NULL;
    if (table_state(w)->tree) {
        if (!GTK_IS_TREE_LIST_ROW(item))
            return NULL;
        row   = gtk_tree_list_row_get_item(item);
        owned = true;
    } else if (!((BtaTableRow *)item)->cells) {
        /* An on-demand row: the model made this object for the selection,
         * and the drawn cell holds another -- found by the index. */
        index = (int)((BtaTableRow *)item)->index;
    } else {
        row   = item;
        index = table_index_in(table_state(w)->rows, row);
    }

    GListModel *cols  = gtk_column_view_get_columns(GTK_COLUMN_VIEW(w->inner));
    BtaCell    *found = NULL;

    for (guint col = 0; !found && col < g_list_model_get_n_items(cols); col++)
        found = table_find_cell(w->inner, row, index, (int)col);

    if (owned)
        g_object_unref(row);
    return found;
}

/*
 * A press on a cell that edits: the row is selected and the edit begins.
 *
 * **It is heard on the column view, in the capture phase, and not on the
 * cell.** With an edit open in one row, GTK's own gesture on another row claims
 * that row's press in its capture phase, before a gesture on the cell under it
 * ever runs -- measured with a real pointer: the second row was selected and
 * never opened, while a cell of the same row opened fine. Above the rows, the
 * press is seen first, and the cell is found under the point.
 *
 * **The press is claimed**: an unclaimed press goes on to the row, which takes
 * the focus and would take it back from the field about to open. So the
 * selection is made here. **It begins on the press and not the release**: the
 * press moves the focus, the edit open elsewhere commits and the store is told,
 * and the release of a gesture whose widgets moved is not always delivered.
 *
 * A tick is not claimed -- its own gesture turns it -- nor a locked cell, which
 * is then an ordinary cell: it selects, and a double click activates. A press
 * inside an open editor is the editor's.
 */
static void on_view_pressed(GtkGestureClick *g, int n, double x, double y,
                            gpointer data)
{
    BtaWidget *w = data;
    GtkWidget *at = gtk_widget_pick(w->inner, x, y, GTK_PICK_DEFAULT);
    BtaCell   *c = NULL;

    /* Up from what is under the point, and down from it as well: a press in a
     * cell's padding picks GTK's cell widget, whose child is ours. */
    for (GtkWidget *up = at; up && up != w->inner && !c; up = gtk_widget_get_parent(up))
        c = cell_get(up);
    /* Down, first child by first child, and not `cell_under`, which walks
     * up for F2's sake: the cell widget a padding press picks is *above* our
     * box, one level further in a tree's expander. */
    for (GtkWidget *down = at; down && !c; down = gtk_widget_get_first_child(down))
        c = cell_get(down);
    /* A press inside the open editor is the editor's -- noted, so the focus
     * GTK hands the row for it is not taken for the edit being left. */
    if (c && c->editor && at && (at == c->editor || gtk_widget_is_ancestor(at, c->editor)))
        c->pressed = g_get_monotonic_time();

    if (!c || !c->row || c->editor ||
        gtk_gesture_single_get_current_button(GTK_GESTURE_SINGLE(g)) != GDK_BUTTON_PRIMARY)
        return;

    /* **The press is also what chooses the cell**, before the lock and the
     * kind decide whether it opens: a locked cell is read and a tick turns,
     * but both are the reader's cell as much as an editable one. */
    BtaTableRow *row   = g_object_ref(c->row);
    guint        col   = c->col;
    guint        epoch = table_state(w)->epoch;
    JSValue      self  = JS_DupValue(w->ctx, w->self);

    table_current_set(w, row, col);
    c = cell_refind(w, epoch, row, col);

    if (!c || cell_locked(c))
        goto out;
    cell_select_row(w, row);
    c = cell_refind(w, epoch, row, col);
    if (!c || c->editor || c->spec->kind == ED_CHECK)
        goto out;
    gtk_gesture_set_state(GTK_GESTURE(g), GTK_EVENT_SEQUENCE_CLAIMED);
    if (n == 1)
        cell_begin_later(c);
out:
    g_object_unref(row);
    JS_FreeValue(w->ctx, self);
}

/* F2 on the focused cell: the editing key every grid has. Off a cell -- the
 * keyboard is on the view after a commit -- it is the selected row's first
 * field.
 *
 * **And Enter is offered to the program before the view claims it.** GTK's
 * column view activates the row on Return -- a double click's other half -- and
 * it does so before the bubble phase, where a control's `KeyPress` is heard: a
 * grid whose Enter moves the cell, which is the first thing every sheet does,
 * could never hear it. So Return is raised as `KeyPress` here, where the event
 * is still ours: **a handler that returns true consumes it** and the activation
 * does not happen; anything else falls through and the row activates as it
 * always did. With an edit open it is the editor's Enter (to commit), not the
 * view's.
 */
static gboolean on_table_key(GtkEventControllerKey *k, guint keyval, guint keycode,
                             GdkModifierType state, gpointer data)
{
    BtaWidget *w = data;

    if (keyval == GDK_KEY_Return || keyval == GDK_KEY_KP_Enter ||
        keyval == GDK_KEY_ISO_Enter) {
        if (table_find_cell(w->inner, NULL, -1, -1))
            return FALSE;

        JSContext  *ctx  = w->ctx;
        const char *name = gdk_keyval_name(keyval);
        JSValue     argv[4] = {
            JS_NewString(ctx, name ? name : "Return"),
            JS_NewBool(ctx, (state & GDK_CONTROL_MASK) != 0),
            JS_NewBool(ctx, (state & GDK_SHIFT_MASK) != 0),
            JS_NewBool(ctx, (state & GDK_ALT_MASK) != 0),
        };
        JSValue r = bta_emit_answer(w, "KeyPress", 4, argv, NULL);
        bool    handled = JS_ToBool(ctx, r) > 0;

        JS_FreeValue(ctx, r);
        for (int i = 0; i < 4; i++)
            JS_FreeValue(ctx, argv[i]);
        return handled;
    }

    if (keyval != GDK_KEY_F2)
        return FALSE;

    GtkRoot *root = gtk_widget_get_root(w->inner);
    BtaCell *c    = cell_under(root ? gtk_root_get_focus(root) : NULL);

    if (!c)
        c = cell_of_selection(w);
    if (!c || c->editor || c->locked || !c->row)
        return FALSE;

    BtaTableRow *row   = g_object_ref(c->row);
    guint        col   = c->col;
    guint        epoch = table_state(w)->epoch;
    JSValue      self  = JS_DupValue(w->ctx, w->self);

    table_current_set(w, row, col);
    if ((c = cell_refind(w, epoch, row, col)) && !c->editor && !c->locked)
        cell_begin_later(c);
    g_object_unref(row);
    JS_FreeValue(w->ctx, self);
    return TRUE;
}

/*
 * The cell drawn for a row and a column -- a held row by itself, an on-demand
 * one (`row` NULL) by the index it is drawn for -- or, with `col` -1, the one
 * with an edit open. A walk of what GTK drew: a few dozen cells, and only when
 * code asks.
 */
static BtaCell *table_find_cell(GtkWidget *x, BtaTableRow *row, int index, int col)
{
    BtaCell *c = cell_get(x);

    if (c && (col < 0 ? c->editor != NULL
                      : (int)c->col == col && c->row &&
                        (row ? c->row == row
                             : !c->row->cells && (int)c->row->index == index)))
        return c;
    for (GtkWidget *k = gtk_widget_get_first_child(x); k;
         k = gtk_widget_get_next_sibling(k))
        if ((c = table_find_cell(k, row, index, col)))
            return c;
    return NULL;
}

/* ---------------------------------------------------------- the current cell
 *
 * **The cell the reader is on**, kept as an address -- a row and a column --
 * and drawn: a thin frame around it, and the corner the fill drag will take.
 * It is what F2 and `EditCell` mean by "this cell", what a program moves to
 * walk the grid, and what `CellChange` says moved.
 *
 * **The frame is a class on the cell's box, applied at every bind**
 * (`cell_fill`): a row scrolled back into view is drawn current with no
 * bookkeeping, and moving the cell takes the class off one drawn cell and puts
 * it on another -- a walk of the drawn widgets that happens once per move and
 * never per frame. The row is held so the address survives the store telling
 * its cells changed; the verbs that empty a table drop it first.
 */
#define CELL_CURRENT_CLASS "bta-cell-current"

/* Whether this drawn cell is the current one. **An on-demand row is compared
 * by the index it stands for**: every bind makes a fresh row object, so the
 * held one would never match it. */
static bool table_cell_is_current(BtaWidget *w, BtaTableRow *row, guint col)
{
    TableState *st = table_state(w);

    if (!st->cell || !row || st->cell_col != col)
        return false;
    if (!row->cells || !st->cell->cells)
        return !row->cells && !st->cell->cells && row->index == st->cell->index;
    return st->cell == row;
}

/* The drawn cell of the current one, or NULL when it is not on screen. */
static BtaCell *table_current_drawn(BtaWidget *w)
{
    TableState *st = table_state(w);

    if (!st->cell)
        return NULL;
    if (!st->cell->cells)
        return table_find_cell(w->inner, NULL, (int)st->cell->index,
                               (int)st->cell_col);
    return table_find_cell(w->inner, st->cell, 0, (int)st->cell_col);
}

/* One drawn cell, marked or unmarked as the current one. */
static void table_cell_mark(BtaCell *c, bool on)
{
    if (!c || !c->box)
        return;
    if (on)
        gtk_widget_add_css_class(c->box, CELL_CURRENT_CLASS);
    else
        gtk_widget_remove_css_class(c->box, CELL_CURRENT_CLASS);
}

/*
 * Moves the current cell to (row, col), or clears it with `row` NULL, raising
 * `CellChange` with the address and the column -- `null` and `-1` when it is
 * cleared. The same address twice is not a move and raises nothing.
 *
 * **It does not select the row**: the press selects where it claims and GTK
 * selects where it does not, `Key` and `Select` are the selection's own verbs,
 * and the current cell is the finer address inside the row already chosen. The
 * verbs that move it *from code* -- `EditCell`, `CurrentCell` -- select as a
 * press would, because a program pointing at a cell means the row too.
 */
static void table_current_set(BtaWidget *w, BtaTableRow *row, guint col)
{
    TableState *st = table_state(w);

    if (row && !row->cells && st->cell && !st->cell->cells &&
        st->cell->index == row->index && st->cell_col == col)
        return;
    if (st->cell == row && (!row || st->cell_col == col))
        return;

    table_cell_mark(table_current_drawn(w), false);

    g_clear_object(&st->cell);
    st->cell = row ? g_object_ref(row) : NULL;
    st->cell_col = row ? col : 0;

    table_cell_mark(table_current_drawn(w), true);

    /*
     * The handler runs the program, which may take the widget -- or the table
     * -- apart: the wrapper is held across the emit, the same bargain
     * `table_report_edit` makes.
     */
    JSContext *ctx  = w->ctx;
    JSValue    self = JS_DupValue(ctx, w->self);
    JSValue    argv[2] = {
        row ? table_address(ctx, w, row) : JS_NULL,
        JS_NewInt32(ctx, row ? (int)col : -1),
    };

    bta_emit(w, "CellChange", 2, argv);

    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
    JS_FreeValue(ctx, self);
}

/* The current cell cleared, for the verbs that take rows away. */
static void table_current_clear(BtaWidget *w)
{
    table_current_set(w, NULL, 0);
}

static void on_setup_cell(GtkSignalListItemFactory *f, GtkListItem *item,
                          gpointer user_data)
{
    BtaWidget *w     = user_data;
    GtkWidget *box   = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    GtkWidget *image = gtk_image_new();
    EdSpec    *spec  = g_object_get_data(G_OBJECT(f), "bta-editor");
    bool       link  = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(f), "bta-link"));
    GtkWidget *view;

    /* Left by default and right for numbers, which is what `Alignment` says;
     * the factory carries it because a cell is made here and bound there. */
    float x = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(f), "bta-xalign")) / 100.0f;

    gtk_box_append(GTK_BOX(box), image);
    gtk_widget_set_visible(image, FALSE);

    if (spec && spec->kind == ED_CHECK) {
        view = gtk_check_button_new();
        gtk_widget_set_halign(view, x < 0.25f ? GTK_ALIGN_START
                                  : x > 0.75f ? GTK_ALIGN_END : GTK_ALIGN_CENTER);
    } else {
        view = gtk_label_new("");
        gtk_label_set_xalign(GTK_LABEL(view), x);
        gtk_label_set_ellipsize(GTK_LABEL(view), PANGO_ELLIPSIZE_END);
        /* **A link cell is a `GtkLabel` with a link in it**, and not a
         * `GtkLinkButton`: the label keeps `Alignment` and the ellipsis, and
         * what GTK gives a link in a label -- the underline, the pointer, the
         * focus stop and Enter -- is the whole affordance. Its default
         * `activate-link` hands the address to the desktop, which is all
         * `LinkButton` does too; ours only reports it first. */
        if (link)
            g_signal_connect(view, "activate-link", G_CALLBACK(on_cell_link), w);
    }
    gtk_widget_set_hexpand(view, TRUE);
    gtk_box_append(GTK_BOX(box), view);

    if (spec) {
        BtaCell *c = g_new0(BtaCell, 1);

        g_weak_ref_init(&c->table, w->gtk);
        c->col    = GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(f), COLUMN_INDEX_KEY));
        c->spec   = g_rc_box_acquire(spec);
        c->xalign = x;
        c->box    = box;
        c->view   = view;

        if (spec->kind == ED_CHECK) {
            g_signal_connect(view, "toggled", G_CALLBACK(on_check_toggled), c);
        } else if (spec->kind == ED_CUSTOM) {
            /* **A cell that opens something shows that it does**, which is
             * Delphi's ellipsis button: without it nobody knows the cell is
             * more than its text. It is a picture of the gesture and not a
             * target -- the press on the cell is what opens. */
            c->more = gtk_label_new("…");
            /* A label and not a button: a frameless `GtkButton` still has a
             * button's floor, and measured a row 51 high against 36. */
            gtk_widget_set_can_target(c->more, FALSE);
            gtk_box_append(GTK_BOX(box), c->more);
        }
        g_object_set_data_full(G_OBJECT(box), CELL_KEY, c, cell_free);

    }

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
 * answer: a string, or `{ Text, Icon, Uri, Style, Editable }` when the cell
 * carries more. Returning it rather than assigning into a side channel is what
 * this runtime already does with `KeyPress`, and it means a handler is a
 * function of its arguments.
 *
 * It runs while the row is being drawn, so the rule is the same one the
 * completion provider will have: **a lookup, and nothing that is not a lookup.**
 * GTK only asks about the rows on screen, so this is a few dozen calls a scroll
 * and not one per row in the table.
 */
static void cell_of(BtaWidget *w, BtaTableRow *row, guint col,
                    char **text, char **icon, char **uri, char **style,
                    bool *locked)
{
    *text   = NULL;
    *icon   = NULL;
    *uri    = NULL;
    *style  = NULL;
    *locked = false;

    if (row && row->cells) {
        *text   = g_strdup(row_cell(row, col));
        *icon   = g_strdup(row_icon(row, col));
        *uri    = g_strdup(row_uri(row, col));
        *style  = g_strdup(row_style(row, col));
        *locked = row_locked(row, col);
        return;
    }
    if (!row)
        return;

    JSContext *ctx     = w->ctx;
    JSValue    argv[2] = { JS_NewInt32(ctx, (int)row->index),
                           JS_NewInt32(ctx, (int)col) };
    JSValue    r       = bta_emit_answer(w, "Data", 2, argv, NULL);

    if (JS_IsString(r)) {
        const char *s = JS_ToCString(ctx, r);
        *text = g_strdup(s ? s : "");
        JS_FreeCString(ctx, s);
    } else if (JS_IsObject(r)) {
        JSValue     tv = JS_GetPropertyStr(ctx, r, "Text");
        JSValue     iv = JS_GetPropertyStr(ctx, r, "Icon");
        JSValue     uv = JS_GetPropertyStr(ctx, r, "Uri");
        JSValue     sv = JS_GetPropertyStr(ctx, r, "Style");
        JSValue     ev = JS_GetPropertyStr(ctx, r, "Editable");
        bool        no_t = JS_IsUndefined(tv) || JS_IsNull(tv);
        bool        no_i = JS_IsUndefined(iv) || JS_IsNull(iv);
        bool        no_u = JS_IsUndefined(uv) || JS_IsNull(uv);
        bool        no_s = JS_IsUndefined(sv) || JS_IsNull(sv);
        const char *ts = no_t ? NULL : JS_ToCString(ctx, tv);
        const char *is = no_i ? NULL : JS_ToCString(ctx, iv);
        const char *us = no_u ? NULL : JS_ToCString(ctx, uv);
        const char *ss = no_s ? NULL : JS_ToCString(ctx, sv);

        /* A `Text` or `Icon` whose conversion throws (a `toString` that throws,
         * a Symbol) is reported the way a `Data` handler that throws is: this
         * runs inside a bind, with nobody to hand it to, and left pending it
         * landed on whatever called into JavaScript next. `null` is no icon,
         * not the icon called "null". */
        if ((!no_t && !ts) || (!no_i && !is) || (!no_u && !us) || (!no_s && !ss))
            bta_dump_error(ctx);

        *text = g_strdup(ts ? ts : "");
        *icon = is && *is ? g_strdup(is) : NULL;
        /* Unlike an icon, an empty `Uri` is an answer: it is *no link on this
         * row*, where an absent one means *the text is the address*. */
        *uri  = us ? g_strdup(us) : NULL;
        *style = ss && *ss ? g_strdup(ss) : NULL;
        /* Only a `false` locks: a cell is as editable as its column unless the
         * row says otherwise. */
        *locked = JS_IsStrictEqual(ctx, ev, JS_FALSE);

        JS_FreeCString(ctx, ts);
        JS_FreeCString(ctx, is);
        JS_FreeCString(ctx, us);
        JS_FreeCString(ctx, ss);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, iv);
        JS_FreeValue(ctx, uv);
        JS_FreeValue(ctx, sv);
        JS_FreeValue(ctx, ev);
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

static void cell_unwatch_row(GtkListItem *item);

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
    cell_unwatch_row(item);

    /* A row being recycled must not answer for the one that had this cell: the
     * edit that finishes after the rebind would be reported with a stale
     * address. The widget is the same, which is the whole recycling contract. */
    GtkWidget *box = gtk_list_item_get_child(item);

    if (GTK_IS_TREE_EXPANDER(box))
        box = gtk_tree_expander_get_child(GTK_TREE_EXPANDER(box));
    if (!box)
        return;

    BtaCell *c = cell_get(box);

    if (!c) {
        GtkWidget *lbl = gtk_widget_get_last_child(box);
        if (lbl)
            g_object_set_data(G_OBJECT(lbl), "bta-link-row", NULL);
        return;
    }

    /*
     * **An unbind with an edit open is not the end of it yet.** Telling a store
     * that a row changed unbinds and binds it again at once, with the same row,
     * and that must not close a field somebody is typing in. So the question is
     * put off a turn: still unbound, or bound to another row, and the edit is
     * committed -- what was typed is not lost to a scroll.
     */
    c->row = NULL;
    if (c->editor)
        cell_settle(c, SETTLE_LEFT, "left");
}

/*
 * A link cell was activated: a click, or Enter with the focus on it.
 *
 * `CellLink(row, column, uri)`, the row addressed as every other event of this
 * table addresses one. **A handler that answers `false` refuses it** -- nothing
 * is opened -- which is `CellEdit`'s veto in the same control; anything else
 * lets the desktop open it. The answer to GTK is inverted, since for
 * `activate-link` TRUE means *handled, do not open*.
 *
 * The handler may empty the table, which unbinds this label under the emit, so
 * the row is read and the arguments built before it runs and nothing after it
 * touches the cell.
 */
static gboolean on_cell_link(GtkLabel *label, const char *uri, gpointer user_data)
{
    BtaWidget   *w   = user_data;
    BtaTableRow *row = g_object_get_data(G_OBJECT(label), "bta-link-row");
    guint        col = GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(label),
                                                          "bta-link-col"));

    if (!w || !row)
        return FALSE;

    JSContext *ctx  = w->ctx;
    JSValue    self = JS_DupValue(ctx, w->self);
    int        at   = row->cells ? table_index_in(table_store_of(w, row), row)
                                  : (int)row->index;
    JSValue    argv[3];

    argv[0] = table_state(w)->tree
                  ? JS_NewString(ctx, row->key ? row->key : "")
                  : JS_NewInt32(ctx, at);
    argv[1] = JS_NewInt32(ctx, (int)col);
    argv[2] = JS_NewString(ctx, uri ? uri : "");

    JSValue  r      = bta_emit_answer(w, "CellLink", 3, argv, NULL);
    gboolean refuse = JS_IsStrictEqual(ctx, r, JS_FALSE);

    JS_FreeValue(ctx, r);
    for (int i = 0; i < 3; i++)
        JS_FreeValue(ctx, argv[i]);
    JS_FreeValue(ctx, self);
    return refuse;
}

/*
 * The theme class a cell wears, applied at the fill.
 *
 * **The widget is recycled, so what it wore last has to come off or the next
 * row keeps it**: the class applied is remembered on the label itself, which is
 * the only thing that outlives one fill and belongs to no row.
 */
#define CELL_STYLE_KEY "bta-cell-style"

static void cell_style_apply(GtkWidget *lbl, const char *style)
{
    const char *was = g_object_get_data(G_OBJECT(lbl), CELL_STYLE_KEY);
    const char *now = style && *style ? style : NULL;

    if (was && (!now || strcmp(was, now) != 0))
        gtk_widget_remove_css_class(lbl, was);
    if (now && (!was || strcmp(was, now) != 0))
        gtk_widget_add_css_class(lbl, now);

    if (!was || !now || strcmp(was, now) != 0)
        g_object_set_data_full(G_OBJECT(lbl), CELL_STYLE_KEY,
                               now ? g_strdup(now) : NULL, g_free);
}

/*
 * What a cell shows for a row: its text, its icon, its link, the class it wears
 * and its editor's state. Asked by the bind and again whenever the row says it
 * changed.
 */
static void cell_fill(BtaWidget *w, GtkWidget *box, BtaTableRow *row, guint col,
                      bool link)
{
    GtkWidget *img = gtk_widget_get_first_child(box);
    BtaCell   *c   = cell_get(box);
    GtkWidget *lbl = c ? c->view : gtk_widget_get_next_sibling(img);

    char *text = NULL, *icon = NULL, *uri = NULL, *style = NULL;
    bool  locked = false;
    cell_of(w, row, col, &text, &icon, &uri, &style, &locked);

    if (c) {
        /* Rebound to its own row -- a store told the row changed -- an open
         * edit goes on; bound to another, the edit is that row's no longer and
         * its report goes on without the label. */
        if (c->editor && c->erow != row)
            cell_detach_later(c);
        c->row = row;
        g_free(c->text);
        c->text   = g_strdup(text ? text : "");
        c->locked = locked;
        if (!c->editor)
            cell_show(c);
    } else if (link) {
        /* The address is the cell's own text unless `SetUri` or `Data` said
         * another; an empty one is a cell that is not a link. */
        const char *target = uri ? uri : text;

        g_object_set_data(G_OBJECT(lbl), "bta-link-row", row);
        g_object_set_data(G_OBJECT(lbl), "bta-link-col", GUINT_TO_POINTER(col));
        if (target && *target && text && *text) {
            char *markup = g_markup_printf_escaped("<a href=\"%s\">%s</a>",
                                                   target, text);
            gtk_label_set_markup(GTK_LABEL(lbl), markup);
            g_free(markup);
        } else {
            gtk_label_set_text(GTK_LABEL(lbl), text ? text : "");
        }
    } else {
        gtk_label_set_text(GTK_LABEL(lbl), text ? text : "");
    }

    /*
     * **A locked cell with no editor still says so.** `SetEditable` promises
     * *the cell reads dim and does not open*, and that was only kept in the
     * columns that declare an editor -- a cell without one has no `BtaCell` to
     * remember the lock, and the columns a header or a summary row lives in are
     * exactly those. `Data`'s `Editable: false` sets the same flag, so an
     * on-demand table's plain cells say it too.
     */
    if (!c) {
        if (locked)
            gtk_widget_add_css_class(lbl, "dim-label");
        else
            gtk_widget_remove_css_class(lbl, "dim-label");
    }

    /* The class the program asked for -- `SetStyle`, or a `Data` answer's
     * `Style` -- beside the ones the cell's state carries. */
    cell_style_apply(lbl, style);

    /* An icon the theme cannot really draw is dropped rather than shown as the
     * broken-image glyph -- the same bargain Button.Icon and a TreeView node
     * make, and for the same reason. */
    bool show = icon && bta_icon_available(box, icon);
    if (show)
        bta_image_set_icon(img, icon);
    gtk_widget_set_visible(img, show);

    /* **The current cell's frame is applied at the bind**, so a row scrolled
     * back into view is drawn current and one no longer current loses it --
     * no bookkeeping and nothing to run per frame. */
    if (table_cell_is_current(w, row, col))
        gtk_widget_add_css_class(box, CELL_CURRENT_CLASS);
    else
        gtk_widget_remove_css_class(box, CELL_CURRENT_CLASS);

    g_free(text);
    g_free(icon);
    g_free(uri);
    g_free(style);
}

#define FILL_ROW_KEY     "bta-fill-row"
#define FILL_HANDLER_KEY "bta-fill-handler"

/* The row a list item is drawn for changed: fill its cell again. */
static void on_row_changed(BtaTableRow *row, gpointer item)
{
    GtkWidget *box = gtk_list_item_get_child(item);
    BtaWidget *w   = g_object_get_data(G_OBJECT(item), "bta-fill-widget");

    if (GTK_IS_TREE_EXPANDER(box))
        box = gtk_tree_expander_get_child(GTK_TREE_EXPANDER(box));
    if (w && box)
        cell_fill(w, box, row,
                  GPOINTER_TO_UINT(g_object_get_data(G_OBJECT(item), "bta-fill-col")),
                  GPOINTER_TO_INT(g_object_get_data(G_OBJECT(item), "bta-fill-link")));
}

/* Lets go of the row a list item listened to -- the half of the recycling
 * contract that is easy to miss. */
static void cell_unwatch_row(GtkListItem *item)
{
    GObject *row = g_object_get_data(G_OBJECT(item), FILL_ROW_KEY);
    gulong   id  = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(item),
                                                     FILL_HANDLER_KEY));

    if (row && id)
        g_signal_handler_disconnect(row, id);
    g_object_set_data(G_OBJECT(item), FILL_HANDLER_KEY, NULL);
    g_object_set_data(G_OBJECT(item), FILL_ROW_KEY, NULL);
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

    bool link = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(f), "bta-link"));

    cell_fill(w, box, row, col, link);

    /* A held row says when it changes; one asked of `Data` is asked again by
     * the rebind a `Count` brings. */
    cell_unwatch_row(item);
    if (row && row->cells) {
        gulong id = g_signal_connect(row, "changed", G_CALLBACK(on_row_changed), item);

        g_object_set_data(G_OBJECT(item), "bta-fill-widget", w);
        g_object_set_data(G_OBJECT(item), "bta-fill-col", GUINT_TO_POINTER(col));
        g_object_set_data(G_OBJECT(item), "bta-fill-link", GINT_TO_POINTER(link));
        g_object_set_data(G_OBJECT(item), FILL_HANDLER_KEY, GSIZE_TO_POINTER(id));
        g_object_set_data_full(G_OBJECT(item), FILL_ROW_KEY, g_object_ref(row),
                               g_object_unref);
    }

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
 * "" takes it off. A virtual table answers with `{ Text, Icon, Uri }` from `Data`
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
    if (argc < 3 || !bta_to_int(ctx, argv[1], "SetIcon", &c))
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

/*
 * SetUri(row, column, uri) -- where a link cell goes, when that is not what it
 * says.
 *
 * The same shape as `SetIcon` and for the same reason: a cell is text, and an
 * address is a second thing that hangs on it. With none, a `Link` column opens
 * the cell's own text. `""` makes the cell *not* a link and `null` takes the
 * address off again -- the two answers `Data` gives with `Uri` empty and
 * absent. A virtual table answers `{ Text, Uri }` from `Data` instead.
 */
static JSValue table_set_uri(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    if (st->virt)
        return JS_ThrowTypeError(ctx,
            "SetUri: a table that answers Data holds no cells; "
            "return { Text, Uri } from the handler instead");

    int32_t c;
    if (argc < 3 || !bta_to_int(ctx, argv[1], "SetUri", &c))
        return JS_ThrowTypeError(ctx, st->tree
            ? "SetUri(key, column, uri) expects a key, a column and an address"
            : "SetUri(row, column, uri) expects two numbers and an address");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);
    int          at  = st->tree ? -1 : 0;

    if (bad)
        return JS_EXCEPTION;
    if (!row) {
        const char *name = JS_ToCString(ctx, argv[0]);
        JSValue     e    = JS_ThrowRangeError(ctx, "SetUri: there is no %s %s",
                                              table_what(w), name ? name : "");
        JS_FreeCString(ctx, name);
        return e;
    }
    if (c < 0) {
        g_object_unref(row);
        return JS_ThrowRangeError(ctx, "SetUri: %d is not a column", c);
    }

    /* Converted before anything is touched: a refusal leaves the row as it was. */
    const char *s = NULL;
    if (!JS_IsNull(argv[2])) {
        if (!JS_IsString(argv[2])) {
            g_object_unref(row);
            return JS_ThrowTypeError(ctx,
                "SetUri: the address is text, or null to take it off");
        }
        s = JS_ToCString(ctx, argv[2]);
        if (!s) {
            g_object_unref(row);
            return JS_EXCEPTION;
        }
    }
    if (!st->tree)
        JS_ToInt32(ctx, &at, argv[0]);

    row_pad(&row->uris, (guint)c);
    g_free(row->uris->pdata[c]);
    row->uris->pdata[c] = s ? g_strdup(s) : NULL;

    JS_FreeCString(ctx, s);
    table_row_changed(w, row, at);
    g_object_unref(row);
    return JS_UNDEFINED;
}

/*
 * SetStyle(row, column, style) -- the theme class a cell wears.
 *
 * The same shape as `SetIcon`, and for a kindred reason: what a cell says is
 * its text, and *what kind of row this is* is said with a class the theme
 * already paints -- a group node wearing `"heading"`, a warning wearing
 * `"error"`. **It is a class name and not a colour**, exactly like `Style` on a
 * control: the theme decides what it looks like, and a theme that does not
 * paint it is a theme saying no. The one class the runtime adds on its own is
 * `dim-label`, for a cell `SetEditable` locked, and the two can be worn at
 * once.
 *
 * `""` takes it off -- and a class is taken off by the runtime when the cell is
 * recycled for another row, since the widget outlives the row it was drawn for.
 * A virtual table answers `{ Text, Style }` from `Data` instead.
 */
static JSValue table_set_style(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    if (st->virt)
        return JS_ThrowTypeError(ctx,
            "SetStyle: a table that answers Data holds no cells; "
            "return { Text, Style } from the handler instead");

    int32_t c;
    if (argc < 3 || !bta_to_int(ctx, argv[1], "SetStyle", &c))
        return JS_ThrowTypeError(ctx, st->tree
            ? "SetStyle(key, column, style) expects a key, a column and a style"
            : "SetStyle(row, column, style) expects two numbers and a style");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);
    int          at  = st->tree ? -1 : 0;

    if (bad)
        return JS_EXCEPTION;
    if (!row) {
        const char *name = JS_ToCString(ctx, argv[0]);
        JSValue     e    = JS_ThrowRangeError(ctx, "SetStyle: there is no %s %s",
                                              table_what(w), name ? name : "");
        JS_FreeCString(ctx, name);
        return e;
    }
    if (c < 0) {
        g_object_unref(row);
        return JS_ThrowRangeError(ctx, "SetStyle: %d is not a column", c);
    }
    if (!JS_IsString(argv[2])) {
        g_object_unref(row);
        return JS_ThrowTypeError(ctx, "SetStyle: style is a theme class name");
    }
    if (!st->tree)
        JS_ToInt32(ctx, &at, argv[0]);

    const char *s = JS_ToCString(ctx, argv[2]);

    row_pad(&row->styles, (guint)c);
    g_free(row->styles->pdata[c]);
    row->styles->pdata[c] = s && *s ? g_strdup(s) : NULL;

    JS_FreeCString(ctx, s);
    table_row_changed(w, row, at);
    g_object_unref(row);
    return JS_UNDEFINED;
}

/*
 * SetEditable(row, column, editable) -- whether this row's cell edits, in a
 * column that does.
 *
 * **A column says what kind of editor a cell has; a row says whether there is
 * one.** A summary task's dates are its children's, so they are not a field --
 * on that row, while the same column is a field on every other. Saying so
 * before anything is typed is the point: the cell reads dim and does not open,
 * where a refusal in `CellEdit` comes after the typing. A virtual table answers
 * `{ Text, Editable: false }` from `Data` instead.
 */
static JSValue table_set_editable(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    if (st->virt)
        return JS_ThrowTypeError(ctx,
            "SetEditable: a table that answers Data holds no cells; "
            "return { Text, Editable } from the handler instead");

    int32_t c;
    if (argc < 3 || !bta_to_int(ctx, argv[1], "SetEditable", &c))
        return JS_ThrowTypeError(ctx, st->tree
            ? "SetEditable(key, column, editable) expects a key, a column and a boolean"
            : "SetEditable(row, column, editable) expects two numbers and a boolean");
    if (!JS_IsBool(argv[2]))
        return JS_ThrowTypeError(ctx, "SetEditable: editable is true or false");

    bool         bad = false;
    BtaTableRow *row = table_row_arg(ctx, w, argv[0], &bad);
    int          at  = st->tree ? -1 : 0;

    if (bad)
        return JS_EXCEPTION;
    if (!row) {
        const char *name = JS_ToCString(ctx, argv[0]);
        JSValue     e    = JS_ThrowRangeError(ctx, "SetEditable: there is no %s %s",
                                              table_what(w), name ? name : "");
        JS_FreeCString(ctx, name);
        return e;
    }
    if (c < 0) {
        g_object_unref(row);
        return JS_ThrowRangeError(ctx, "SetEditable: %d is not a column", c);
    }
    if (!st->tree)
        JS_ToInt32(ctx, &at, argv[0]);

    if (!row->locked)
        row->locked = g_byte_array_new();
    while (row->locked->len <= (guint)c) {
        guint8 none = 0;
        g_byte_array_append(row->locked, &none, 1);
    }
    row->locked->data[c] = !JS_ToBool(ctx, argv[2]);

    table_row_changed(w, row, at);
    g_object_unref(row);
    return JS_UNDEFINED;
}

/*
 * EditCell(row, column) -- the gesture, from code: opens that cell's editor, or
 * turns a `Check`, or asks a `Custom` cell's `CellEditor`. Answers whether it
 * did. **The cell has to be on screen** -- an editor is a widget in the cell
 * GTK drew -- so a row out of view answers `false`; `Reveal` first.
 *
 * The verb every grid has (`BeginEdit`, `editCellAt`, `startEditingCell`), and
 * the reason it is here besides a program's own F2: the edit is a pointer
 * gesture and this is the one road the suite can take through it, which is
 * what `SortColumn` is to a heading.
 */
static JSValue table_edit_cell(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t c;
    if (argc < 2 || !bta_to_int(ctx, argv[1], "EditCell", &c))
        return JS_ThrowTypeError(ctx, table_state(w)->tree
            ? "EditCell(key, column) expects a key and a column"
            : "EditCell(row, column) expects two numbers");

    bool         bad   = false;
    BtaTableRow *row   = NULL;
    int32_t      index = -1;

    /* An on-demand row is not held, so it is found by the index it is drawn
     * for. */
    if (table_state(w)->virt) {
        if (!bta_to_int(ctx, argv[0], "EditCell", &index))
            return JS_EXCEPTION;
    } else {
        row = table_row_arg(ctx, w, argv[0], &bad);
        if (bad)
            return JS_EXCEPTION;
        if (!row) {
            const char *name = JS_ToCString(ctx, argv[0]);
            JSValue     e    = JS_ThrowRangeError(ctx, "EditCell: there is no %s %s",
                                                  table_what(w), name ? name : "");
            JS_FreeCString(ctx, name);
            return e;
        }
    }
    if (c < 0) {
        g_clear_object(&row);
        return JS_ThrowRangeError(ctx, "EditCell: %d is not a column", c);
    }

    BtaCell *cell = table_find_cell(w->inner, row, index, c);

    /* **The click from code is a click**: the row is selected and the cell
     * becomes the current one, so `EditCell` and a pointer leave the reader in
     * the same place. */
    /* Both raise events, and a handler may take the drawn cell away: the row
     * is held and the cell asked for again after each. */
    BtaTableRow *at    = cell && cell->row ? g_object_ref(cell->row) : NULL;
    guint        epoch = table_state(w)->epoch;

    if (at) {
        cell_select_row(w, at);
        if (cell_refind(w, epoch, at, (guint)c))
            table_current_set(w, at, (guint)c);
        cell = cell_refind(w, epoch, at, (guint)c);
        g_object_unref(at);
    } else {
        cell = NULL;
    }

    g_clear_object(&row);
    return JS_NewBool(ctx, cell && cell_begin(cell));
}

/*
 * EndEdit([commit]) -- ends the edit that is open: committed, as Enter would,
 * or with `false` given up, as Escape would. Answers whether there was one.
 * What a Save button wants before it reads the rows.
 */
static JSValue table_end_edit(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    bool commit = true;
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!JS_IsBool(argv[0]))
            return JS_ThrowTypeError(ctx, "EndEdit: commit is true or false");
        commit = JS_ToBool(ctx, argv[0]) > 0;
    }

    BtaCell *cell = table_find_cell(w->inner, NULL, -1, -1);

    if (!cell)
        return JS_NewBool(ctx, false);
    cell_finish(cell, commit ? "code" : NULL);
    return JS_NewBool(ctx, true);
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
    JSValue r = bta_emit_answer(w, "Sort", 2, argv, NULL);

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
 * SortBy(column, [ascending], [compare]) -- reorder the rows the table holds.
 *
 * What a `Sort` handler calls when the table owns its data. On a table that
 * answers `Data` there is nothing here to sort, and saying so beats quietly
 * doing nothing.
 *
 * **What a cell holds is the text it shows**, so the order is an order of text
 * -- and it used to be the plainest one, `g_utf8_collate`, which put `"10"`
 * before `"9"` in every column of numbers anybody sorted. Two answers now:
 *
 *   - **By default, natural order** (`g_utf8_collate_key_for_filename`): the
 *     locale's collation, with runs of digits compared as numbers -- `9` before
 *     `10`, `Factura 9` before `Factura 10`. It is what a file manager does, and
 *     it covers most columns of numbers with no declaration at all.
 *   - **`compare(a, b)` when it does not**: the two cells' text, answered with a
 *     number like `Array.sort`'s comparator. A minus sign, a thousands
 *     separator (`1.234,56` against `999,00`) or a `d/m/Y` date are the cases
 *     natural order reads wrongly, and only the program knows which the column
 *     holds. It is also why this is not a per-column type: parsing the text a
 *     cell shows is guessing a format, which this runtime does not do.
 *
 * **Stable**, by a tie broken on the position the row had: `g_list_store_sort`
 * promised nothing about equal rows, so a second sort could shuffle what the
 * first had ordered. Sorting by one column and then another now gives the
 * second column's order with the first's inside it.
 */
typedef struct {
    guint      col;
    bool       up;
    JSContext *ctx;
    JSValue    compare;   /* a function, or undefined for natural order */
    bool       failed;    /* the comparator threw or answered nothing usable */
} SortKey;

typedef struct {
    BtaTableRow *row;
    char        *natural; /* the collation key, when there is no comparator */
    guint        was;     /* where it sat, the tie-break */
} SortEntry;

static int compare_entries(gconstpointer pa, gconstpointer pb, gpointer user_data)
{
    const SortEntry *a = pa, *b = pb;
    SortKey         *k = user_data;
    int              cmp = 0;

    if (JS_IsUndefined(k->compare)) {
        cmp = strcmp(a->natural, b->natural);
    } else if (!k->failed) {
        JSValue argv[2] = {
            JS_NewString(k->ctx, row_cell(a->row, k->col)),
            JS_NewString(k->ctx, row_cell(b->row, k->col)),
        };
        JSValue r = JS_Call(k->ctx, k->compare, JS_UNDEFINED, 2, argv);
        double  d = 0;

        JS_FreeValue(k->ctx, argv[0]);
        JS_FreeValue(k->ctx, argv[1]);
        if (JS_IsException(r)) {
            k->failed = true;          /* it stands, and the sort is abandoned */
        } else if (!JS_IsNumber(r) || JS_ToFloat64(k->ctx, &d, r) || isnan(d)) {
            JS_ThrowTypeError(k->ctx, "SortBy: compare(a, b) has to answer a "
                                      "number, as Array.sort's does");
            k->failed = true;
        } else {
            cmp = d < 0 ? -1 : d > 0 ? 1 : 0;
        }
        JS_FreeValue(k->ctx, r);
    }

    if (!k->up)
        cmp = -cmp;
    /* The tie is broken the same way in both directions: a descending sort
     * keeps equal rows in the order they were, as an ascending one does. */
    return cmp ? cmp : (a->was < b->was ? -1 : a->was > b->was ? 1 : 0);
}

/* One store in its new order, or untouched if the comparator failed. */
static bool table_sort_store(GListStore *store, SortKey *key)
{
    GListModel *model = G_LIST_MODEL(store);
    guint       n     = g_list_model_get_n_items(model);

    if (n < 2)
        return true;

    SortEntry *e = g_new0(SortEntry, n);

    for (guint i = 0; i < n; i++) {
        e[i].row = g_list_model_get_item(model, i);
        e[i].was = i;
        if (JS_IsUndefined(key->compare))
            e[i].natural = g_utf8_collate_key_for_filename(row_cell(e[i].row, key->col), -1);
    }

#if GLIB_CHECK_VERSION(2, 82, 0)
    g_sort_array(e, n, sizeof *e, compare_entries, key);
#else
    g_qsort_with_data(e, (gint)n, sizeof *e, compare_entries, key);
#endif

    if (!key->failed) {
        gpointer *rows = g_new(gpointer, n);

        for (guint i = 0; i < n; i++)
            rows[i] = e[i].row;
        g_list_store_splice(store, 0, n, rows, n);
        g_free(rows);
    }

    for (guint i = 0; i < n; i++) {
        g_object_unref(e[i].row);
        g_free(e[i].natural);
    }
    g_free(e);
    return !key->failed;
}

/* Each level in its own order: the roots, then every node's children. */
static bool table_sort_levels(GListStore *store, SortKey *key)
{
    GListModel *model = G_LIST_MODEL(store);

    if (!table_sort_store(store, key))
        return false;
    for (guint i = 0, n = g_list_model_get_n_items(model); i < n; i++) {
        BtaTableRow *node = g_list_model_get_item(model, i);
        bool         ok   = !node->children || table_sort_levels(node->children, key);

        g_object_unref(node);
        if (!ok)
            return false;
    }
    return true;
}

static JSValue table_sort_by(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t col;
    if (argc < 1 || !bta_to_int(ctx, argv[0], "SortBy", &col))
        return JS_ThrowTypeError(ctx, "SortBy(column, [ascending], [compare]) expects a column");
    if (col < 0)
        return JS_ThrowRangeError(ctx, "SortBy: %d is not a column", col);

    TableState *st = table_state(w);
    if (st->virt)
        return JS_ThrowTypeError(ctx,
            "SortBy: a table that answers Data holds no rows to sort; "
            "sort what the handler reads instead");

    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsFunction(ctx, argv[2]))
        return JS_ThrowTypeError(ctx, "SortBy: compare has to be a function "
                                      "(a, b) answering a number");

    SortKey key = {
        (guint)col,
        argc < 2 || JS_IsUndefined(argv[1]) || JS_ToBool(ctx, argv[1]) > 0,
        ctx,
        argc > 2 ? argv[2] : JS_UNDEFINED,
        false,
    };

    /* **In a tree, siblings are sorted within each parent** -- sorting the
     * flattened list would put a child above its own parent, which is not an
     * order, it is a different tree. That is also why GTK's own
     * `GtkTreeListRowSorter` exists; it is not needed here because the sorter
     * the columns carry never reorders anything (see `Sortable`) and this is
     * the reordering. */
    if (!st->tree)
        return table_sort_store(st->rows, &key) ? JS_UNDEFINED : JS_EXCEPTION;

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

    bool ok = table_sort_levels(st->rows, &key);
    if (was) {
        table_select_node(w, was);
        g_object_unref(was);
    }
    return ok ? JS_UNDEFINED : JS_EXCEPTION;
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
    if (argc < 1 || !bta_to_int(ctx, argv[0], "SortColumn", &col))
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

/* ---------------------------------------------------------- header menus */

/*
 * `HeaderMenu` -- the menu a column heading offers, and `HeaderClick(column,
 * button, ctrl, shift)` -- the heading's press.
 *
 * **The heading is the one surface of a column view that reports nothing.**
 * GTK's own title gesture claims the press (`click_pressed_cb` in
 * `gtkcolumnviewtitle.c`), so the bubble-phase controllers every other control
 * has never see it; measured before this existed: a secondary click on a
 * heading arrived as no `MouseDown` at all. So the press is caught in the
 * **capture** phase, which runs first, and it is deliberately **not claimed**:
 * GTK's gesture stays alive to sort on the primary release and to present the
 * model below on the secondary one.
 *
 * The model is built for each click rather than kept, because an item has to
 * know which column it was opened over -- see `bta_menu_header_build`.
 */

static JSValue table_get_header_menu(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_DupValue(ctx, w->header_menu);
}

static JSValue table_set_header_menu(JSContext *ctx, JSValueConst this_val,
                                     JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (!JS_IsArray(val) && !JS_IsNull(val) && !JS_IsUndefined(val))
        return JS_ThrowTypeError(ctx, "HeaderMenu takes an array of items, or null");

    /*
     * Built once here and thrown away, and that is what refuses a bad spec
     * where it is written: an item with no name fails while the .form is being
     * loaded and not when somebody right-clicks a heading. It also binds the
     * item names on the form, exactly as assigning `Menu` does. The menu that
     * is shown is built again per click, with the column.
     */
    if (JS_IsArray(val) && !JS_IsObject(w->form))
        return JS_ThrowTypeError(ctx,
            "HeaderMenu names handlers on the form: add %s to a form before "
            "assigning it", w->name ? w->name : "the table");

    if (JS_IsArray(val)) {
        GMenu *model = bta_menu_header_build(ctx, w->form, w, val, -1);
        if (!model)
            return JS_EXCEPTION;
        g_object_unref(model);
    }

    JS_FreeValue(ctx, w->header_menu);
    w->header_menu = JS_IsArray(val) ? JS_DupValue(ctx, val) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

/*
 * The n-th column that is shown, and its own index among the columns of the
 * view -- or -1.
 *
 * The columns keep their places whether they are shown or not, so this is the
 * walk that turns "the third title there is" into "the third column", which is
 * the number the program knows: the columns are the ones it declared, in the
 * order it declared them.
 */
static int table_shown_column(BtaWidget *w, int nth)
{
    GListModel *cols = gtk_column_view_get_columns(GTK_COLUMN_VIEW(w->inner));
    int         seen = 0;

    for (guint i = 0; i < g_list_model_get_n_items(cols); i++) {
        GtkColumnViewColumn *c = g_list_model_get_item(cols, i);
        bool                 shown = gtk_column_view_column_get_visible(c);

        g_object_unref(c);
        if (!shown)
            continue;
        if (seen == nth)
            return (int)i;
        seen++;
    }
    return -1;
}

/*
 * Which heading is under a point of the view, or -1.
 *
 * The heading row is the column view's **first child** and the titles are its
 * children **in column order** -- GTK's own structure, checked in 4.10 and
 * 4.22, and there is no public accessor for either.
 *
 * **A column that is not shown has no title among them** -- or a hidden one,
 * and the walk cannot tell which without looking -- so the child's own index
 * is the column's index no more. The walk counts the titles that are there
 * and asks which column each one is: the n-th title is the n-th column that is
 * shown, because a title is only there for a column that is.
 *
 * `x` and not the whole point for the column: the titles are allocated at
 * their column's x, so the first whose range contains the point is the one
 * drawn under it.
 */
static int table_heading_at(BtaWidget *w, double x, double y)
{
    GtkWidget *header = gtk_widget_get_first_child(w->inner);
    if (!header || !gtk_widget_is_visible(header))
        return -1;

    graphene_rect_t r;
    if (!gtk_widget_compute_bounds(header, w->inner, &r))
        return -1;
    if (y < r.origin.y || y >= r.origin.y + r.size.height)
        return -1;

    int shown = 0;
    for (GtkWidget *ch = gtk_widget_get_first_child(header); ch;
         ch = gtk_widget_get_next_sibling(ch)) {
        if (!gtk_widget_is_visible(ch))
            continue;

        graphene_rect_t cr;
        if (gtk_widget_compute_bounds(ch, w->inner, &cr) &&
            x >= cr.origin.x && x < cr.origin.x + cr.size.width)
            return table_shown_column(w, shown);

        shown++;
    }
    return -1;
}

static void on_header_pressed(GtkGestureClick *g, int n_press,
                              double x, double y, gpointer user_data)
{
    BtaWidget *w = user_data;

    int column = table_heading_at(w, x, y);
    if (column < 0)
        return;

    int button = (int)gtk_gesture_single_get_current_button(GTK_GESTURE_SINGLE(g));
    GdkModifierType state =
        gtk_event_controller_get_current_event_state(GTK_EVENT_CONTROLLER(g));

    JSContext *ctx = w->ctx;
    JSValue    argv[4] = {
        JS_NewInt32(ctx, column),
        JS_NewInt32(ctx, button),
        JS_NewBool(ctx, (state & GDK_CONTROL_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_SHIFT_MASK) != 0),
    };

    guint   epoch  = table_state(w)->epoch;
    JSValue holder = JS_DupValue(ctx, w->self);
    JSValue answer = bta_emit_answer(w, "HeaderClick", 4, argv, NULL);

    for (int i = 0; i < 4; i++)
        JS_FreeValue(ctx, argv[i]);

    /*
     * Only the secondary click asks for a menu, and that is GTK's rule as much
     * as ours: `click_released_cb` presents the column's model for the
     * secondary button and sorts for the primary. The others are told and
     * that is all. **And a handler that remade the table** (`Columns = …`
     * is the usual one) or took it out of its window leaves no heading that
     * was clicked: the menu is not hung on whichever column now has the index.
     */
    if (button != GDK_BUTTON_SECONDARY || table_state(w)->epoch != epoch ||
        !gtk_widget_get_root(w->inner)) {
        JS_FreeValue(ctx, answer);
        JS_FreeValue(ctx, holder);
        return;
    }
    JS_FreeValue(ctx, holder);   /* still in its window: someone else holds it */

    /* Both owned: the answer may *be* the spec, so it is duplicated rather than
     * taken, and freed once below. */
    JSValue spec = JS_IsArray(answer) ? JS_DupValue(ctx, answer)
                                      : JS_DupValue(ctx, w->header_menu);
    JS_FreeValue(ctx, answer);

    GListModel *cols = gtk_column_view_get_columns(GTK_COLUMN_VIEW(w->inner));
    if (column >= (int)g_list_model_get_n_items(cols)) {
        JS_FreeValue(ctx, spec);
        return;
    }
    GtkColumnViewColumn *c = g_list_model_get_item(cols, (guint)column);

    uint32_t n = 0;
    if (JS_IsArray(spec)) {
        JSValue lenv = JS_GetPropertyStr(ctx, spec, "length");
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);
    }

    /*
     * Nothing to offer -- no answer, no declaration, or an empty array -- and
     * the column is cleared rather than left with whatever an earlier click
     * put on it.
     */
    if (n == 0) {
        gtk_column_view_column_set_header_menu(c, NULL);
        JS_FreeValue(ctx, spec);
        g_object_unref(c);
        return;
    }

    GMenu *model = bta_menu_header_build(ctx, w->form, w, spec, column);
    JS_FreeValue(ctx, spec);

    if (!model) {
        /* A spec the walker refused. Reported, and no stale menu is left
         * standing in its place. */
        bta_dump_error(ctx);
        gtk_column_view_column_set_header_menu(c, NULL);
        g_object_unref(c);
        return;
    }

    gtk_column_view_column_set_header_menu(c, G_MENU_MODEL(model));
    g_object_unref(model);
    g_object_unref(c);
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
    /* The table's own rules -- the current cell's frame, the editors' floor --
     * once per display, before any cell is drawn. */
    table_style_once();

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

    /* The rows scrolled, and the watch that keeps the handlers from firing into
     * a freed widget: the same two adjustments and the same `Scroll` a
     * `Scroller` reports, which is what two panes beside each other lock on. */
    bta_scroll_watch(w);

    /* The model is not the widget, so the finaliser's sweep cannot find this
     * on its own -- bta_widget_watch is how it is told. */
    g_signal_connect(sel, "selection-changed",
                     G_CALLBACK(on_selection_changed), w);
    bta_widget_watch(w, sel);
    g_signal_connect(w->inner, "activate", G_CALLBACK(on_row_activated), w);

    /*
     * The heading's press, in the **capture** phase and for any button: GTK's
     * title gesture claims it before the bubble phase ever runs, and claiming
     * ours would be what stopped GTK from sorting on the primary release and
     * from showing the menu on the secondary one. See the header-menu section.
     */
    GtkGesture *header = gtk_gesture_click_new();
    gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(header), 0);
    gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(header),
                                               GTK_PHASE_CAPTURE);
    g_signal_connect(header, "pressed", G_CALLBACK(on_header_pressed), w);
    gtk_widget_add_controller(w->inner, GTK_EVENT_CONTROLLER(header));

    /* A press on a cell that edits; see `on_view_pressed` for why here. */
    GtkGesture *cells = gtk_gesture_click_new();
    gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(cells),
                                               GTK_PHASE_CAPTURE);
    g_signal_connect(cells, "pressed", G_CALLBACK(on_view_pressed), w);
    gtk_widget_add_controller(w->inner, GTK_EVENT_CONTROLLER(cells));

    /* F2 opens the focused cell's editor, in the capture phase so a cell that
     * would take the key for itself does not get it first. */
    GtkEventController *keys = gtk_event_controller_key_new();
    gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
    g_signal_connect(keys, "key-pressed", G_CALLBACK(on_table_key), w);
    gtk_widget_add_controller(w->inner, keys);
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
    /*
     * **`Columns.Editor` answers the kinds there are**, out of `ED_KINDS`, so
     * the designer's column dialog offers exactly what `ed_spec_read` accepts
     * and a kind added here reaches it with no other change -- the rule
     * `Alignment` set: the list a setter accepts is asked of the runtime, never
     * kept beside it.
     */
    if (!strcmp(prop, "Columns.Editor")) {
        static gsize  once  = 0;
        static char  *kinds = NULL;

        if (g_once_init_enter(&once)) {
            GString *b = g_string_new(NULL);

            for (guint k = ED_TEXT; k < G_N_ELEMENTS(ED_KINDS); k++)
                g_string_append_printf(b, "%s%s", b->len ? "," : "",
                                       ED_KINDS[k].name);
            kinds = g_string_free(b, FALSE);
            g_once_init_leave(&once, 1);
        }
        return kinds;
    }
    return NULL;
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
     * has to leave the table exactly as it was, not half rebuilt. Each column's
     * editor is read once, here, and handed to its factory below. */
    EdSpec **specs = g_new0(EdSpec *, n ? n : 1);

    for (uint32_t i = 0; i < n; i++) {
        JSValue col = JS_GetPropertyUint32(ctx, list, i);
        char    where[48];
        g_snprintf(where, sizeof where, "Columns[%u]", i);

        if (!JS_IsObject(col)) {
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s is not a { Text, ... }", where);
            goto refuse;
        }

        JSValue text = JS_GetPropertyStr(ctx, col, "Text");
        bool    ok   = JS_IsString(text) || JS_IsUndefined(text);
        JS_FreeValue(ctx, text);
        if (!ok) {
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s: Text is the heading, as a string", where);
            goto refuse;
        }

        JSValue wv = JS_GetPropertyStr(ctx, col, "Width");
        int32_t px = 0;
        if (!JS_IsUndefined(wv) && !bta_to_int(ctx, wv, "Columns.Width", &px)) {
            JS_FreeValue(ctx, wv);
            JS_FreeValue(ctx, col);
            goto refuse;
        }
        JS_FreeValue(ctx, wv);
        if (px < 0) {
            JS_FreeValue(ctx, col);
            JS_ThrowRangeError(ctx, "%s: %d is not a width", where, px);
            goto refuse;
        }

        JSValue ev = JS_GetPropertyStr(ctx, col, "Editable");
        if (!JS_IsUndefined(ev) && !JS_IsBool(ev)) {
            JS_FreeValue(ctx, ev);
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s: Editable is a boolean", where);
            goto refuse;
        }
        bool editable_said = JS_IsBool(ev);
        bool editable_decl = JS_ToBool(ctx, ev) > 0;
        JS_FreeValue(ctx, ev);

        /*
         * **`Editable: true` is `Editor: "Text"`**, which is all it ever was;
         * `Editor` names the kind. Saying `Editable: false` beside an editor is
         * two answers to one question and is refused rather than one of them
         * being picked.
         */
        JSValue dv = JS_GetPropertyStr(ctx, col, "Editor");
        if (!JS_IsUndefined(dv) && !JS_IsNull(dv)) {
            if (editable_said && !editable_decl) {
                JS_FreeValue(ctx, dv);
                JS_FreeValue(ctx, col);
                JS_ThrowTypeError(ctx, "%s: Editable is false and an Editor is "
                                       "declared", where);
                goto refuse;
            }
            specs[i] = ed_spec_read(ctx, dv, where, NULL);
            if (!specs[i]) {
                JS_FreeValue(ctx, dv);
                JS_FreeValue(ctx, col);
                goto refuse;
            }
        } else if (editable_decl) {
            specs[i] = ed_spec_new(ED_TEXT);
        }
        JS_FreeValue(ctx, dv);

        JSValue lv = JS_GetPropertyStr(ctx, col, "Link");
        if (!JS_IsUndefined(lv) && !JS_IsBool(lv)) {
            JS_FreeValue(ctx, lv);
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s: Link is a boolean", where);
            goto refuse;
        }
        /* A cell is a field or it is a link; the one control cannot be both. */
        if (specs[i] && JS_ToBool(ctx, lv) > 0) {
            JS_FreeValue(ctx, lv);
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx,
                "%s: a column cannot be both edited and a Link", where);
            goto refuse;
        }
        JS_FreeValue(ctx, lv);

        /*
         * `Visible` says whether the column is shown at all. It is a boolean
         * or it is nothing: a word is a refusal, because a column that is
         * "sort of visible" is a column nobody can rely on.
         */
        JSValue vv = JS_GetPropertyStr(ctx, col, "Visible");
        if (!JS_IsUndefined(vv) && !JS_IsBool(vv)) {
            JS_FreeValue(ctx, vv);
            JS_FreeValue(ctx, col);
            JS_ThrowTypeError(ctx, "%s: Visible is a boolean", where);
            goto refuse;
        }
        JS_FreeValue(ctx, vv);

        bool bad = false;
        alignment_of(ctx, col, where, &bad);
        JS_FreeValue(ctx, col);
        if (bad)
            goto refuse;
    }

    /* Out with the old. Walked backwards because removing shortens the list. */
    table_state(w)->epoch++;
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
        /* Validated above, so this cannot fail; and if it ever did, the pending
         * exception is the refusal and not something to swallow. */
        if (!JS_IsUndefined(wv))
            bta_to_int(ctx, wv, "Columns.Width", &px);
        JS_FreeValue(ctx, wv);

        bool  bad = false;
        float x   = alignment_of(ctx, col, "Columns", &bad);

        EdSpec *spec = g_steal_pointer(&specs[i]);

        JSValue lv   = JS_GetPropertyStr(ctx, col, "Link");
        bool    link = JS_ToBool(ctx, lv) > 0;

        JS_FreeValue(ctx, lv);

        /* Validated above, so this cannot fail; and if it ever did, the pending
         * exception is the refusal and not something to swallow. */
        JSValue vv     = JS_GetPropertyStr(ctx, col, "Visible");
        bool    visible = JS_IsUndefined(vv) ? true : (JS_ToBool(ctx, vv) > 0);

        JS_FreeValue(ctx, vv);

        GtkListItemFactory *f = gtk_signal_list_item_factory_new();
        g_object_set_data(G_OBJECT(f), COLUMN_INDEX_KEY, GUINT_TO_POINTER(i));
        if (i == 0 && table_state(w)->tree)
            g_object_set_data(G_OBJECT(f), TREE_COLUMN_KEY, GINT_TO_POINTER(1));
        g_object_set_data(G_OBJECT(f), "bta-xalign",
                          GINT_TO_POINTER((int)(x * 100)));
        if (spec)
            g_object_set_data_full(G_OBJECT(f), "bta-editor", spec, ed_spec_unref);
        g_object_set_data(G_OBJECT(f), "bta-link", GINT_TO_POINTER(link));
        g_signal_connect(f, "setup", G_CALLBACK(on_setup_cell), w);
        g_signal_connect(f, "bind",  G_CALLBACK(on_bind_cell),  w);
        /* Every cell listens to the row it is bound to, so every column lets
         * go of it; the expander's watch and an editor's or a link's address
         * come off in the same place. */
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

        /*
         * **A column that is not shown stays in the view.** GTK hides the
         * title and the cells with it, so the column keeps its place in the
         * list -- the indices the program uses (`Cell`, `SetCell`,
         * `SortColumn`, `HeaderClick`) are the ones it declared, and a column
         * that comes back does not shift the ones after it. Hiding it here
         * rather than leaving it out of the view is what keeps that true.
         */
        gtk_column_view_column_set_visible(c, visible);

        gtk_column_view_append_column(view, c);
        g_object_unref(c);

        JS_FreeCString(ctx, title);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, col);
    }
    g_free(specs);
    return true;

refuse:
    for (uint32_t i = 0; i < n; i++)
        if (specs[i])
            ed_spec_unref(specs[i]);
    g_free(specs);
    return false;
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
 * formatted by whoever knows how it should read beats this guessing.
 *
 * A value that cannot become text is a refusal and not an empty cell: `s ? s :
 * ""` swallowed the failure with the conversion's exception still pending, so
 * the row went in looking filled and the error landed on whoever asked next. */
static bool table_fill_cells(JSContext *ctx, BtaTableRow *row, JSValueConst values)
{
    if (JS_IsArray(values)) {
        JSValue  lenv = JS_GetPropertyStr(ctx, values, "length");
        uint32_t n    = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < n; i++) {
            JSValue     v = JS_GetPropertyUint32(ctx, values, i);
            const char *s = JS_ToCString(ctx, v);

            if (!s) {
                JS_FreeValue(ctx, v);
                return false;   /* it threw on the way; that stands */
            }
            g_ptr_array_add(row->cells, g_strdup(s));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, v);
        }
        return true;
    }

    const char *s = JS_ToCString(ctx, values);
    if (!s)
        return false;
    g_ptr_array_add(row->cells, g_strdup(s));
    JS_FreeCString(ctx, s);
    return true;
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
 * else takes from then on: `Cell`, `SetCell`, `SetIcon`, `Row` and `RemoveNode`
 * all address a node by key, because a *position* in a tree is of the visible list
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
    if (!table_fill_cells(ctx, node, values)) {
        g_object_unref(node);
        return JS_EXCEPTION;
    }

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

    if (!table_fill_cells(ctx, row, argv[0])) {
        g_object_unref(row);
        return JS_EXCEPTION;
    }

    TableState *st = table_state(w);

    if (st->tree) {
        g_object_unref(row);
        return JS_ThrowTypeError(ctx, "Add: this table is a tree -- every row in "
                                      "one is a node, so it needs a key: "
                                      "Add(values, { Key, Parent })");
    }

    /* Adding a row is saying the table holds its own again. */
    if (st->virt) {
        table_current_clear(w);
        g_clear_object(&st->virt);
        table_use_model(w, G_LIST_MODEL(st->rows));
    }

    g_list_store_append(st->rows, row);
    g_object_unref(row);
    return JS_UNDEFINED;
}

/*
 * `AddRows(rows)` -- the row `Add` takes, many times, in one change to the
 * list.
 *
 * **What it is for is a cost nobody could guess from `Add`.** An append to a
 * `GListStore` raises `items-changed`, which GTK's list item manager walks, so
 * a loop of `Add` calls is not a loop of cheap calls but a quadratic curve:
 * 10 000 rows took 0.65 s, 20 000 took 2.3 s and 40 000 took 17.4 s (D3 of the
 * October audit), and filling a table from a query is exactly that loop. Here
 * the rows are built first and enter the store with one `splice`, so the view
 * is told once whatever the count.
 *
 * **Built first, because a refusal must leave the table as it was** -- a
 * half-added batch is a table showing rows the program never meant to write.
 * A tree is refused for the reason `Add` gives: its rows are nodes with keys,
 * and a batch of those is a different call with a different shape (one has not
 * been needed yet).
 */
static JSValue table_add_rows(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (argc < 1 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx, "AddRows(rows) expects an array of rows, "
                                      "each the array Add(values) takes");

    TableState *st = table_state(w);

    if (st->tree)
        return JS_ThrowTypeError(ctx, "AddRows: this table is a tree -- every "
                                      "row in one is a node, so it needs a key: "
                                      "Add(values, { Key, Parent })");

    JSValue  lenv = JS_GetPropertyStr(ctx, argv[0], "length");
    uint32_t n    = 0;
    int      ok   = JS_ToUint32(ctx, &n, lenv);

    JS_FreeValue(ctx, lenv);
    if (ok < 0)
        return JS_EXCEPTION;

    if (!n)
        return JS_UNDEFINED;

    /* A sparse array can claim four billion rows: refused, not an abort. */
    gpointer *items = g_try_new(gpointer, n);
    guint     made  = 0;

    if (!items)
        return JS_ThrowRangeError(ctx, "AddRows: %u rows is more than "
                                       "there is memory for", (unsigned)n);

    for (; made < n; made++) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[0], made);

        if (JS_IsException(v))
            break;

        BtaTableRow *row = g_object_new(BTA_TYPE_TABLE_ROW, NULL);

        if (!table_fill_cells(ctx, row, v)) {
            g_object_unref(row);
            JS_FreeValue(ctx, v);
            break;
        }

        JS_FreeValue(ctx, v);
        items[made] = row;
    }

    if (made < n) {
        for (guint i = 0; i < made; i++)
            g_object_unref(items[i]);
        g_free(items);
        return JS_EXCEPTION;   /* the conversion's own exception stands */
    }

    /* **Asked again after the conversion**, which runs the program (a
     * `toString`, a getter): one that made the table a tree mid-batch would
     * have flat rows spliced among its roots. `Add` asks after it too. */
    if (st->tree) {
        for (guint i = 0; i < n; i++)
            g_object_unref(items[i]);
        g_free(items);
        return JS_ThrowTypeError(ctx, "AddRows: this table became a tree while "
                                      "its rows were read -- every row in one "
                                      "is a node, so it needs a key: "
                                      "Add(values, { Key, Parent })");
    }

    /* Adding rows is saying the table holds its own again, as one `Add` is. */
    if (st->virt) {
        table_current_clear(w);
        g_clear_object(&st->virt);
        table_use_model(w, G_LIST_MODEL(st->rows));
    }

    g_list_store_splice(st->rows,
                        g_list_model_get_n_items(G_LIST_MODEL(st->rows)),
                        0, items, n);

    for (guint i = 0; i < n; i++)
        g_object_unref(items[i]);
    g_free(items);
    return JS_UNDEFINED;
}

static JSValue table_clear(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);

    st->epoch++;

    /* **The current cell goes with the rows**, and the frame comes off while
     * the cell is still drawn. */
    table_current_clear(w);

    g_list_store_remove_all(st->rows);

    /*
     * **And out of on-demand mode.** `Count` then `Clear()` left the table
     * answering `Data` with its `Count` intact, and `Add(values, { Key })` then
     * refused with *"a flat list of Count rows -- Clear() it first"*, which
     * `Clear()` could not satisfy: the door the refusal named went nowhere.
     * Emptying a table is emptying it, whichever way it was filled.
     */
    if (st->virt) {
        g_clear_object(&st->virt);
        table_use_model(w, G_LIST_MODEL(st->rows));
    }

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

/*
 * `RemoveNode(key)` and `RemoveRow(index)`, and not one `Remove` that means the
 * index here and the key there: the control is flat or a tree, so which address
 * a call wants is a fact about the table, and a program reading `t.Remove(x)`
 * cannot tell which one it wrote. Each says which mode it belongs to and what
 * the other verb is.
 */
static JSValue table_remove_node(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);
    if (!st->tree)
        return JS_ThrowTypeError(ctx, "RemoveNode(key) is for a table that is a "
                                      "tree; this one is flat, and a row is "
                                      "addressed by its index: RemoveRow(index)");

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "RemoveNode(key) expects a node's key");

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key)
        return JS_EXCEPTION;

    BtaTableRow *node = table_node(w, key);
    if (!node) {
        JSValue e = JS_ThrowRangeError(ctx, "RemoveNode: there is no node '%s'", key);
        JS_FreeCString(ctx, key);
        return e;
    }
    JS_FreeCString(ctx, key);

    /* Removing a node removes what is under it: a subtree with no parent is not
     * a thing this control can show. */
    GListStore *store = table_store_of(w, node);
    int         at    = table_index_in(store, node);

    table_forget(w, node);
    if (at >= 0)
        g_list_store_remove(store, (guint)at);

    /* **A row taken away is not the reader's cell any more** -- and the walk
     * is the question, because the node may have been an ancestor of the
     * current one. */
    if (st->cell && table_still_holds(w, st->cell) < 0)
        table_current_clear(w);
    return JS_UNDEFINED;
}

static JSValue table_remove_row(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    TableState *st = table_state(w);
    if (st->tree)
        return JS_ThrowTypeError(ctx, "RemoveRow(index) is for a flat table; "
                                      "this one is a tree, where a node is "
                                      "addressed by its key: RemoveNode(key)");

    int32_t i;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "RemoveRow(index) expects a row");
    if (!bta_to_int(ctx, argv[0], "RemoveRow", &i))
        return JS_EXCEPTION;

    GListStore *rows = st->rows;
    if (i < 0 || (guint)i >= g_list_model_get_n_items(G_LIST_MODEL(rows)))
        return JS_ThrowRangeError(ctx, "RemoveRow: there is no row %d", i);

    g_list_store_remove(rows, (guint)i);

    if (st->cell && table_still_holds(w, st->cell) < 0)
        table_current_clear(w);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------ geometry
 *
 * Three questions a table drawn *beside* something else has to be able to
 * answer, and GTK answers none of them: where the rows are scrolled to, how
 * tall one row is, and how tall the heading row above them is. This is where
 * the three answers come from, and it is what lets an application put a chart
 * next to a task list with the rows lined up and one scroll between them.
 *
 * **The scroll is the `GtkScrolledWindow` this control already wraps its
 * `GtkColumnView` in**, so the getter and the setter are the ones a `Scroller`
 * uses (`bta_scroll_get`/`bta_scroll_set`, and `bta_scroll_watch` for the
 * `Scroll` event) rather than a second implementation of the same arithmetic
 * and the same clamping.
 *
 * **A row's height is the rows' natural height over the rows that are
 * *drawn*.** In a tree, `Count` is every node at every level and a folded
 * subtree's rows are neither in `Count` nor in the height, so dividing by
 * `Count` would answer a shorter row the more of them were folded away -- and a
 * chart beside a folded tree is exactly when the answer has to be right. The
 * column view's own model is the flattened list in tree mode, so its item count
 * is what is on screen.
 *
 * **And it is the *natural* height, not the adjustment's `upper`.** `upper` is
 * `max(content, page_size)`: three tasks in a tall window are three rows of 36
 * pixels inside an `upper` of the whole viewport, and dividing that by three
 * answers 102 for a row that is 36. That is what this did first, and
 * `bintana-project`'s own view check caught it on the fixture with three tasks
 * -- the plan that always fits is the plan that was wrong. Measured on that
 * case: `nat` is 133, the heading is 25, three rows are 36 each, and `upper` is
 * the 575 the viewport is. `gtk_widget_measure` asks what the rows *want*,
 * which a viewport does not change, and what it answers carries the heading,
 * which is the other thing to take off.
 *
 * **The heading is what the list's viewport leaves of the column view.** GTK has
 * no getter for it, and walking `gtk_widget_get_first_child` for the header
 * would be reading a child list that is an implementation detail; the viewport's
 * page size says the same number without naming what sits above it.
 */
static GtkAdjustment *table_vadjustment(BtaWidget *w)
{
    return gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(w->gtk));
}

/* The list's viewport, which is `0` while the scrolled window around it has no
 * size -- and the reason both numbers here are `0` before a table has been laid
 * out rather than a division that quietly includes the heading. */
static int table_viewport(BtaWidget *w)
{
    GtkAdjustment *a = table_vadjustment(w);
    return a ? (int)(gtk_adjustment_get_page_size(a) + 0.5) : 0;
}

static int table_header_height(BtaWidget *w)
{
    int page = table_viewport(w);
    if (page <= 0)
        return 0;

    int above = (int)gtk_widget_get_allocated_height(w->inner) - page;

    return above > 0 ? above : 0;
}

static JSValue table_get_row_height(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GListModel *rows = G_LIST_MODEL(
        gtk_column_view_get_model(GTK_COLUMN_VIEW(w->inner)));
    guint n = rows ? g_list_model_get_n_items(rows) : 0;
    if (!n || table_viewport(w) <= 0)
        return JS_NewInt32(ctx, 0);

    int min = 0, nat = 0, alloc = 0, base = 0;
    gtk_widget_measure(w->inner, GTK_ORIENTATION_VERTICAL, -1,
                       &min, &nat, &alloc, &base);

    int wanted = nat - table_header_height(w);

    return JS_NewInt32(ctx, wanted > 0 ? (int)(wanted / (double)n + 0.5) : 0);
}

/*
 * A floor for the row of column headings.
 *
 * **The heading does not follow the widget's font**, which is what an
 * application reaching for a taller heading tries first: measured here, a table
 * at 10, 11, 12 and 13 points has rows of 36, 37, 39 and 41 pixels and a
 * heading of 25 in every one, because the theme sizes the `header` node and not
 * the control. So the floor is set on the heading itself, which is the same
 * walk `table_heading_at` already does over GTK's own structure (checked in
 * 4.10 and 4.22) and the same request every other floor in this runtime is.
 *
 * What it is for: a chart drawn *beside* a table has to put its own heading in
 * the same band, and two rows of axis type in a 25-pixel band is 7-point type.
 * A heading with a floor is the honest way to buy the room -- and the height it
 * reaches is what `HeaderHeight` answers.
 */
static JSValue table_get_header_min(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    return JS_NewInt32(ctx, table_state(w)->header_min);
}

static JSValue table_set_header_min(JSContext *ctx, JSValueConst this_val,
                                    JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t n;
    if (!bta_to_int(ctx, val, "HeaderMinHeight", &n))
        return JS_EXCEPTION;
    if (n < 0)
        return JS_ThrowRangeError(ctx, "HeaderMinHeight: %d is not a height", n);

    table_state(w)->header_min = n;

    GtkWidget *header = gtk_widget_get_first_child(w->inner);
    if (header)
        gtk_widget_set_size_request(header, -1, n > 0 ? n : -1);

    return JS_UNDEFINED;
}

static JSValue table_get_header_height(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    return JS_NewInt32(ctx, table_header_height(w));
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

    /* Assigned at all is remade: a program sets `Count` to say the data is
     * new, even at the same number. */
    st->epoch++;

    if (!st->virt) {
        /* Going on demand: what the table held is dropped, because it is no
         * longer what it shows and keeping it would be two answers to Count. */
        table_current_clear(w);
        g_list_store_remove_all(st->rows);
        st->virt = g_object_new(BTA_TYPE_TABLE_MODEL, NULL);
        table_use_model(w, G_LIST_MODEL(st->virt));
    }
    table_model_set_count(st->virt, (guint)n);

    /* A count that shrank past the current cell leaves it outside. */
    if (st->cell && !st->cell->cells &&
        st->cell->index >= g_list_model_get_n_items(G_LIST_MODEL(st->virt)))
        table_current_clear(w);
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
    if (argc < 2 || !bta_to_int(ctx, argv[1], "Cell", &c))
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
    if (argc < 3 || !bta_to_int(ctx, argv[1], "SetCell", &c))
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



/*
 * Clears the selection, one selected row at a time.
 *
 * **`gtk_selection_model_unselect_all` is not enough, and it fails silently.**
 * A `GtkSingleSelection` did not implement `unselect_all` before GTK 4.22, and
 * the interface's default goes through `set_selection`, which it does not
 * implement either -- so on 4.14 the call did *nothing* and `Index = -1` left
 * the row selected.  This machine (4.22) passed and the ubuntu-24.04 runner
 * (4.14) did not, which is the shape of half the traps in `AGENTS.md`.
 * `unselect_item` is implemented by both selection models, and this goes
 * through it.
 */
static void table_clear_selection(BtaWidget *w)
{
    GtkSelectionModel *model = table_model(w);
    guint              n     = g_list_model_get_n_items(G_LIST_MODEL(model));

    for (guint i = 0; i < n; i++)
        if (gtk_selection_model_is_selected(model, i))
            gtk_selection_model_unselect_item(model, i);
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
        table_clear_selection(w);
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

    st->epoch++;

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

    /* "" selects nothing, which is how a program clears the selection. */
    if (!*key) {
        table_clear_selection(w);
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
 * `CurrentCell` -- the cell the reader is on, as `{ Row, Column }`, and
 * assigning moves it.
 *
 * `Row` is the address every verb uses: a key in a tree, an index in a flat
 * table. `Column` is a column's index, the same one `Cell`/`EditCell` take.
 * Assigning `null` clears it, and **assigning also selects the row** and opens
 * the way to it, as a press would: pointing a program at a cell means the row
 * too. The address it is already on is not a move and raises nothing;
 * `CellChange` is what says it moved, whichever way it moved.
 */
static JSValue table_get_current(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget  *w = bta_this(ctx, this_val);
    TableState *st;

    if (!w)
        return JS_EXCEPTION;
    st = table_state(w);
    if (!st->cell)
        return JS_NULL;

    JSValue out = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, out, "Row", table_address(ctx, w, st->cell));
    JS_SetPropertyStr(ctx, out, "Column", JS_NewInt32(ctx, (int)st->cell_col));
    return out;
}

static JSValue table_set_current(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (JS_IsNull(val) || JS_IsUndefined(val)) {
        table_current_clear(w);
        return JS_UNDEFINED;
    }
    if (!JS_IsObject(val))
        return JS_ThrowTypeError(ctx, "CurrentCell: { Row, Column }, or null");

    JSValue cv  = JS_GetPropertyStr(ctx, val, "Column");
    int32_t col = 0;

    if (JS_IsUndefined(cv) || !bta_to_int(ctx, cv, "CurrentCell.Column", &col)) {
        JS_FreeValue(ctx, cv);
        return JS_EXCEPTION;
    }
    JS_FreeValue(ctx, cv);
    if (col < 0)
        return JS_ThrowRangeError(ctx, "CurrentCell: %d is not a column", col);

    JSValue      rv  = JS_GetPropertyStr(ctx, val, "Row");
    TableState  *st  = table_state(w);
    bool         bad = false;
    BtaTableRow *row = NULL;

    /*
     * **An on-demand row is made here**, since there is no store to find it
     * in: a bare row carrying the index, which is how the model names one.
     */
    if (st->virt) {
        int32_t index;

        if (!bta_to_int(ctx, rv, "CurrentCell.Row", &index))
            bad = true;
        else if (index >= 0 &&
                 (guint)index < g_list_model_get_n_items(G_LIST_MODEL(st->virt))) {
            row = g_object_new(BTA_TYPE_TABLE_ROW, NULL);
            g_clear_pointer(&row->cells, g_ptr_array_unref);
            row->index = (guint)index;
        }
    } else {
        row = table_row_arg(ctx, w, rv, &bad);
    }

    if (bad) {
        JS_FreeValue(ctx, rv);
        return JS_EXCEPTION;
    }
    if (!row) {
        const char *name = JS_ToCString(ctx, rv);
        JSValue     e    = JS_ThrowRangeError(ctx, "CurrentCell: there is no %s %s",
                                              table_what(w), name ? name : "");
        JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, rv);
        return e;
    }
    JS_FreeValue(ctx, rv);

    /* `Select` runs the program first, and a handler that remade the table
     * or took the row away leaves nothing to be current. */
    guint epoch = st->epoch;

    cell_select_row(w, row);
    if (st->epoch == epoch && (!row->cells || table_still_holds(w, row) >= 0))
        table_current_set(w, row, (guint)col);
    g_clear_object(&row);
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
    if (argc < 1)
        return JS_ThrowTypeError(ctx,
            "Select(index)/Deselect(index) needs a row index");
    if (!bta_to_int(ctx, argv[0], "Select", &i))
        return JS_EXCEPTION;        /* it threw on the way; that stands */

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
        table_clear_selection(w);
        return JS_UNDEFINED;
    }
    if (!table_state(w)->multi)
        return JS_ThrowTypeError(ctx, "SelectAll needs MultiSelect");

    gtk_selection_model_select_all(table_model(w));
    return JS_UNDEFINED;
}

/*
 * `ActivateOnSingleClick` and `Activate([index])`, the same two members every
 * other list has. A `GtkColumnView` raises `activate` on a double click, or on
 * one when told to; the verb is what a double click does without one, and the
 * position is the visible one -- which is what `Index` answers and what a click
 * lands on, in both the flat and the tree shape.
 */
static JSValue table_get_single_click(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, gtk_column_view_get_single_click_activate(
                               GTK_COLUMN_VIEW(w->inner)));
}

static JSValue table_set_single_click(JSContext *ctx, JSValueConst this_val,
                                      JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int on = JS_ToBool(ctx, val);
    if (on < 0)
        return JS_EXCEPTION;

    gtk_column_view_set_single_click_activate(GTK_COLUMN_VIEW(w->inner), on);
    return JS_UNDEFINED;
}

static JSValue table_activate(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSelectionModel *sel = table_model(w);
    guint              n   = g_list_model_get_n_items(G_LIST_MODEL(sel));
    int32_t            index = -1;

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!bta_to_int(ctx, argv[0], "Activate", &index))
            return JS_EXCEPTION;
    } else {
        for (guint i = 0; i < n; i++) {
            if (gtk_selection_model_is_selected(sel, i)) {
                index = (int32_t)i;
                break;
            }
        }
    }

    /* Nothing there is nothing to choose, and not an error: it answers
     * `false`. */
    if (index < 0 || (guint)index >= n)
        return JS_NewBool(ctx, false);

    gtk_selection_model_select_item(sel, (guint)index, TRUE);
    g_signal_emit_by_name(w->inner, "activate", (guint)index);
    return JS_NewBool(ctx, true);
}

/*
 * `Reveal(index)` -- that visible row into view, the same verb every list has.
 * `gtk_column_view_scroll_to` is 4.12 and the floor is 4.10, so the older GTK
 * gets the action the function wraps.
 */
static JSValue table_reveal_row(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t index;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Reveal(index) needs a row index");
    if (!bta_to_int(ctx, argv[0], "Reveal", &index))
        return JS_EXCEPTION;

    GtkSelectionModel *sel = table_model(w);
    guint              n   = g_list_model_get_n_items(G_LIST_MODEL(sel));

    if (index < 0 || (guint)index >= n)
        return JS_NewBool(ctx, false);

#if GTK_CHECK_VERSION(4, 12, 0)
    gtk_column_view_scroll_to(GTK_COLUMN_VIEW(w->inner), (guint)index, NULL,
                              GTK_LIST_SCROLL_NONE, NULL);
#else
    gtk_widget_activate_action(w->inner, "list.scroll-to-item", "u",
                               (guint)index);
#endif
    return JS_NewBool(ctx, true);
}

static const JSCFunctionListEntry table_props[] = {
    /* Columns
     *   an array of `{ Text, Width, Alignment, Editor, Link, Visible }`. `Text`
     *   is **translated**; `Width: 0` sizes itself and the last column takes
     *   the slack. **`Visible: false` hides the column** -- and it keeps its
     *   place in the list, so the numbers the program uses (`Cell`, `SetCell`,
     *   `SortColumn`, `HeaderClick`) are the ones it declared, and a column
     *   that comes back does not shift the ones after it. **`Editor` makes the
     *   cells fields**, and is a kind's name or
     *   `{ Kind, ... }`: `"Text"`; `{ Kind: "Number", Min, Max, Step,
     *   Decimals }`, answering with a point and rounding a half away from
     *   zero; `"Date"`, a field with a calendar whose day is `YYYY-MM-DD` (the
     *   arrows move the day, Enter or Space picks it); `{ Kind: "Check",
     *   ActiveText, InactiveText }`, a tick holding one of the two
     *   (`"true"`/`"false"`); `{ Kind: "Combo", Items }`; and `"Custom"`, which
     *   opens nothing and raises `CellEditor`. The kinds are
     *   `Widget.PropertyOptions("TableView", "Columns.Editor")`. A click or F2
     *   opens a cell, Enter or the focus leaving commits, Escape gives up, and
     *   `CellEdit` decides. **A cell is still text** -- every
     *   kind reads it and writes it back. `Editable: true` is `Editor:
     *   "Text"`. `Link: true` makes each cell a link -- underlined, a pointer
     *   over it, a focus stop, Enter -- whose address is the cell's text unless
     *   `SetUri` or `Data` says another, and a cell with no text is plain.
     *   **A column is edited or a link, never both**, and a misspelt option is
     *   refused by name
     */
    JS_CGETSET_DEF("Columns",     table_get_columns,   table_set_columns),
    /* Count
     *   how many rows — **settable**, which is the on-demand mode: the table
     *   then asks `Data(row, column)` for each cell it draws. **Settable**,
     *   and setting it is the on-demand shape. Assigning it puts the table in
     *   this shape and clears any rows it held
     */
    JS_CGETSET_DEF("Count",       table_get_count,     table_set_count),
    /* Index
     *   the selected row, `-1` for none. Assigning selects it. Default `-1`
     */
    JS_CGETSET_DEF("Index",       table_get_index,     table_set_index),
    /* Selection
     *   every selected row, as an array of indices in order
     */
    JS_CGETSET_DEF("Selection",   table_get_selection, NULL),
    /* ScrollY
     *   how far down the rows are scrolled, in pixels -- the wheel, a
     *   scrollbar, the keyboard or an assignment. Assigning **clamps** to
     *   `[0, ScrollMaxY]`, so a number past the end means the end
     */
    JS_CGETSET_MAGIC_DEF("ScrollY",    bta_scroll_get, bta_scroll_set, BTA_SCROLL_Y),
    /* ScrollMaxY
     *   the largest `ScrollY` that still shows a row: the rows' height less
     *   one view. `0` when there is nothing to scroll
     */
    JS_CGETSET_MAGIC_DEF("ScrollMaxY", bta_scroll_get, NULL, BTA_SCROLL_MAX_Y),
    /* RowHeight
     *   how tall one row is, as GTK measured it. `0` while the table holds no
     *   row or has not been laid out
     */
    JS_CGETSET_DEF("RowHeight",    table_get_row_height, NULL),
    /* HeaderHeight
     *   how tall the row of column headings is. `0` before the first
     *   allocation
     */
    JS_CGETSET_DEF("HeaderHeight", table_get_header_height, NULL),
    /* HeaderMinHeight
     *   a floor for the row of column headings, in pixels. **The heading does
     *   not follow the control's font** -- the theme sizes it -- so this is
     *   what makes a taller one. `0`, nothing said
     */
    JS_CGETSET_DEF("HeaderMinHeight", table_get_header_min, table_set_header_min),
    /* MultiSelect
     *   more than one row at a time. Refused on a tree
     */
    JS_CGETSET_DEF("MultiSelect", table_get_multi,     table_set_multi),
    /* RowLines
     *   rules between the rows. Default `true`
     */
    JS_CGETSET_MAGIC_DEF("RowLines",    table_get_flag, table_set_flag, TAB_SEPARATORS),
    /* ColumnLines
     *   rules between the columns. Default `false`
     */
    JS_CGETSET_MAGIC_DEF("ColumnLines", table_get_flag, table_set_flag, TAB_HEADERS),
    /* Key
     *   the selected node's key; assigning selects, opening the way to it.
     *   `""` selects nothing. A tree only
     */
    JS_CGETSET_DEF("Key",        table_get_key,        table_set_key),
    /* CurrentCell
     *   the cell the reader is on, as `{ Row, Column }` — the row is a key in
     *   a tree and an index in a flat table, the column is an index — or
     *   `null` for none. **Assigning moves it and selects the row**, opening
     *   the way to it; `null` clears it. A cell that is not editable is a
     *   cell all the same: it can be current, and F2 is what opens it
     */
    JS_CGETSET_DEF("CurrentCell", table_get_current, table_set_current),
    /* AutoExpand
     *   opens a node as it arrives, and again when it gains a child after
     *   being closed by hand. Default `true`. A tree only. The same mechanism
     *   `TreeView` uses, answering the same
     */
    JS_CGETSET_DEF("AutoExpand", table_get_autoexpand, table_set_autoexpand),
    /* ActivateOnSingleClick
     *   raise `Activate` on one click instead of two. Default `false`
     */
    JS_CGETSET_DEF("ActivateOnSingleClick",
                   table_get_single_click, table_set_single_click),
    /* Activate([index])
     *   raises `Activate` for that visible position, as a double click would;
     *   the selected row with no argument. Answers whether there was one. In
     *   both the flat and the tree shape, because a click lands on a position
     */
    JS_CFUNC_DEF("Activate", 1, table_activate),
    /* Reveal(index)
     *   brings that visible row into view with the least scrolling it takes,
     *   and answers whether there was one
     */
    JS_CFUNC_DEF("Reveal",   1, table_reveal_row),
    /* Add(values, [options])
     *   one row, as an array of strings. A row shorter than there are columns
     *   reads `""` for the rest. Clears an on-demand `Count`. **`options` is
     *   `{ Key, Parent, Icon }`, and a row with a `Key` is a node**: the
     *   first one makes this table a tree, `Parent` is the key of the node it
     *   goes under (absent is a root), and `Icon` is the picture for its
     *   first column — the same one `TreeView.Add` takes, so a node need not
     *   be added and then decorated. **For many rows at once, `AddRows`**:
     *   one change to the list instead of one per row
     */
    JS_CFUNC_DEF("Add",     2, table_add),
    /* AddRows(rows)
     *   many rows in one call, each the array `Add` takes. **The whole batch
     *   is one change to the list**, which is what makes filling a table from
     *   a query linear: `Add` appends one item and raises `items-changed` per
     *   call, so the ordinary loop was quadratic — 40 000 rows took 17 s (D3
     *   of the October audit), and this is a `splice`. Refused on a tree,
     *   whose rows are nodes with keys, and it clears an on-demand `Count` as
     *   one `Add` does
     */
    JS_CFUNC_DEF("AddRows", 1, table_add_rows),
    /* ExpandNode(key)
     *   opens or closes it. Opening opens the way to it too, since a row only
     *   exists once its ancestors are open. Not `Expand`, which is `Widget`'s
     *   layout property
     */
    JS_CFUNC_MAGIC_DEF("ExpandNode",   1, table_expand_node,  NODE_EXPAND),
    /* CollapseNode(key)
     *   closes it
     */
    JS_CFUNC_MAGIC_DEF("CollapseNode", 1, table_expand_node,  NODE_COLLAPSE),
    /* ExpandAll()
     *   opens every node
     */
    JS_CFUNC_MAGIC_DEF("ExpandAll",    0, table_expand_every, NODE_EXPAND),
    /* CollapseAll()
     *   closes every node
     */
    JS_CFUNC_MAGIC_DEF("CollapseAll",  0, table_expand_every, NODE_COLLAPSE),
    /* Expanded(key)
     *   whether it is open
     */
    JS_CFUNC_DEF("Expanded", 1, table_expanded),
    /* Exists(key)
     *   whether that node is there. `false` on a flat table rather than a
     *   refusal: it is the question you ask *before* you know
     */
    JS_CFUNC_DEF("Exists",   1, table_exists),
    /* Clear()
     *   empties it — **and forgets which of the three shapes this table was**
     */
    JS_CFUNC_DEF("Clear",   0, table_clear),
    /* RemoveRow(index)
     *   takes that row out. **Flat only** — a tree says `RemoveNode(key)`,
     *   and this one refuses with that sentence
     */
    JS_CFUNC_DEF("RemoveRow",  1, table_remove_row),
    /* RemoveNode(key)
     *   takes that node out, **and the subtree with it**. **Tree only** — a
     *   flat table says `RemoveRow(index)`
     */
    JS_CFUNC_DEF("RemoveNode", 1, table_remove_node),
    /* Row(index)
     *   that row's values, as the array it was given — including any it was
     *   given beyond the columns declared. Refused on an on-demand table
     */
    JS_CFUNC_DEF("Row",     1, table_row),
    /* Cell(row, column)
     *   one value. Refused on an on-demand table, which has no cells to
     *   answer about
     */
    JS_CFUNC_DEF("Cell",    2, table_cell),
    /* SetCell(row, column, value)
     *   one cell, in place. The selection stays where it is
     */
    JS_CFUNC_DEF("SetCell", 3, table_set_cell),
    /* SetIcon(row, column, name)
     *   an icon from the theme beside a cell's text. `""` takes it off.
     *   Refused on an on-demand table
     */
    JS_CFUNC_DEF("SetIcon", 3, table_set_icon),
    /* SetUri(row, column, uri)
     *   where a `Link` cell goes when that is not its text. `""` makes the
     *   cell not a link, `null` goes back to opening its text. Refused on an
     *   on-demand table
     */
    JS_CFUNC_DEF("SetUri", 3, table_set_uri),
    /* SetStyle(row, column, style)
     *   the theme class a cell wears -- a name like `"heading"`, the way
     *   `Style` takes one on a control, not a colour. `""` takes it off, and
     *   recycling a cell takes it off too. Refused on an on-demand table,
     *   whose `Data` answers `{ Text, Style }`
     */
    JS_CFUNC_DEF("SetStyle", 3, table_set_style),
    /* SetEditable(row, column, editable)
     *   whether this row's cell edits, in a column with an `Editor`: `false`
     *   draws it dim and opens nothing, **before** anything is typed -- a
     *   summary's dates, which are its children's. Refused on an on-demand
     *   table, whose `Data` answers `{ Text, Editable: false }`
     */
    JS_CFUNC_DEF("SetEditable", 3, table_set_editable),
    /* EditCell(row, column)
     *   the click, from code: opens that cell's editor, turns a `Check`, or
     *   raises a `Custom` cell's `CellEditor`. Answers whether it did -- `false`
     *   for a cell that is not on screen (`Reveal` first), not editable, or
     *   refused by `CellEditor`
     */
    JS_CFUNC_DEF("EditCell", 2, table_edit_cell),
    /* EndEdit([commit])
     *   ends the open edit: committed as Enter would, or with `false` given up
     *   as Escape would. Answers whether one was open
     */
    JS_CFUNC_DEF("EndEdit", 1, table_end_edit),
    /* HeaderMenu
     *   the menu a column heading offers on a secondary click, as the same
     *   array of items `Menu` takes. Built for each click, and every item's
     *   handler is told the column, last: `MnuHide_Click(column)`. Like
     *   `Menu`, refused on a table that is not in a form yet
     */
    JS_CGETSET_DEF("HeaderMenu", table_get_header_menu, table_set_header_menu),
    /* Sortable
     *   makes the headers clickable. **The table does not reorder itself** —
     *   it raises `Sort`. Default `false`
     */
    JS_CGETSET_DEF("Sortable", table_get_sortable, table_set_sortable),
    /* Select(index)
     *   move the selection from code. `Select` leaves the others alone where
     *   several are allowed
     */
    JS_CFUNC_MAGIC_DEF("Select",      1, table_select_one,   TB_SELECT),
    /* Deselect(index)
     *   unselects it
     */
    JS_CFUNC_MAGIC_DEF("Deselect",    1, table_select_one,   TB_DESELECT),
    /* SelectAll()
     *   with `MultiSelect`
     */
    JS_CFUNC_MAGIC_DEF("SelectAll",   0, table_select_every, TB_ALL),
    /* DeselectAll()
     *   selects nothing
     */
    JS_CFUNC_MAGIC_DEF("DeselectAll", 0, table_select_every, TB_NONE),
    /* SortBy(column, [ascending], [compare])
     *   actually reorders the rows it holds, **by the text the cells show**:
     *   natural order by default (`9` before `10`, the locale's collation
     *   otherwise), or `compare(a, b)` — the two cells' text, answering a
     *   number as `Array.sort`'s does — for what natural order reads wrongly:
     *   a minus sign, grouped thousands, a `d/m/Y` date. **Stable**: equal
     *   cells keep the order they had, so sorting by one column and then
     *   another nests them. A comparator that throws leaves the rows as they
     *   were
     */
    JS_CFUNC_DEF("SortBy",  3, table_sort_by),
    /* SortColumn(column, [ascending])
     *   the same as clicking that heading from code: the arrow moves and
     *   `Sort` is raised
     */
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
        /* Select()
         *   the selection moved — by the user or by an assignment. Ask
         *   `Index` for where it is and `Cell`/`Row` for what is there; `Key`
         *   when the table is a tree
         */
        /* Activate()
         *   a double click on a row, or Enter on it. The gesture for *open
         *   this one*
         */
        /* Data(row, column)
         *   the table needs a cell. **The return value is the answer**: a
         *   string, or `{ Text, Icon, Uri, Style, Editable }` for a cell with
         *   a picture, an address or a theme class of its own, or one that
         *   does not edit in a column that does (`Editable: false`). In a
         *   `Link` column an absent `Uri` means the text is the address and
         *   `""` means this cell is not a link
         */
        /* Sort(column, ascending)
         *   a sortable header was clicked. **The handler decides** — `SortBy`
         *   is what actually reorders
         */
        /* CellEditor(row, column)
         *   an edit is about to begin -- a click, F2 or `EditCell`. `row` is an
         *   index in a flat table and a key in a tree. **Returning `false`
         *   refuses it**; an object is this edit's editor over the column's --
         *   `{ Items: [...] }` for a list that is the row's, `{ Max: 1000 }`, or
         *   `{ Kind: "Date" }` for a cell whose kind depends on its row (a
         *   `Check` column stays one). For a `Custom` column this is the whole
         *   edit: open the dialog here and write with `SetCell`
         */
        /* CellEdit(row, column, text, how)
         *   an edit ended. **`how` says what ended it**: `"enter"`, `"tab"` and
         *   `"shift-tab"` are the grid's move-on keys, and an edit that ends
         *   with one is reported even when nothing changed, because the program
         *   reads the reason and moves; `"pick"` is a day, an item or a tick
         *   chosen; `"focus"` is the keyboard leaving; `"code"` is `EndEdit`;
         *   `"left"` is the row unbound, scrolled away. Every other reason
         *   reports a text that changed. `row` is an index in a flat table and
         *   a key in a tree. **Returning `false` refuses it** and the cell goes
         *   back to what it said; **a string is kept instead of
         *   the text** -- the program's own spelling of what was typed; anything
         *   else keeps the text. A handler that throws refuses. An on-demand
         *   table holds no cells, so there the handler stores it. **A held flat
         *   row the program removed while the edit was open is not raised at
         *   all**: its index went with it, and `-1` names no row; a tree keeps
         *   its key
         */
        /* CellChange(row, column)
         *   the current cell moved — a press, `EditCell`, F2, or an assignment
         *   to `CurrentCell`. `row` is an index in a flat table and a key in a
         *   tree; **`null` and `-1` say it was cleared**. `CurrentCell` is
         *   where it is now
         */
        /* CellLink(row, column, uri)
         *   a `Link` cell was activated — a click, or Enter on it. `row` is an
         *   index in a flat table and a key in a tree. **Returning `false`
         *   refuses it** and nothing is opened, as in `CellEdit`; anything else
         *   lets the desktop open `uri`
         */
        /* HeaderClick(column, button, ctrl, shift)
         *   a column heading was pressed — the one pointer event a heading
         *   raises, because GTK claims its press before the bubble phase.
         *   `button` is `1` primary, `2` middle, `3` secondary. **The return
         *   value is the menu of the secondary click**: an array replaces
         *   `HeaderMenu` for that click, anything else falls back to it. A
         *   primary click also raises `Sort` when `Sortable`, on the release
         */
        /* Scroll(x, y)
         *   the position moved — the wheel, a scrollbar, the keyboard or an
         *   assignment. **Both axes are reported together**, so a diagonal
         *   move is one event
         */
        BTA_CLASS_ENUM_TEXT("TableView", "Control", build_table, table_props, false,
                            table_options, "Columns.Text",
                            "Select,Activate,Data,Sort,CellEditor,CellEdit,CellChange,CellLink,HeaderClick,Scroll"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
