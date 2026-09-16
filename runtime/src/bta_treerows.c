/*
 * Reaching the row a node is showing as -- for the two widgets that nest.
 *
 * `TreeView` and `TableView` in tree mode are the same three pieces: a
 * `GListStore` of roots, a `GtkTreeListModel` flattening it on demand, and
 * nodes that know their parent. Both need the same answer to the same question
 * -- *which row is this node, if any* -- and both had their own copy of it,
 * down to the comment. This is the one copy.
 *
 * **What it replaces was quadratic, and the comment it carried was wrong.**
 * Both copies scanned the whole flattened list looking for the row whose item
 * was the node, saying:
 *
 *   > Scanning is the only way: the tree model flattens on demand and has no
 *   > node-to-row map.
 *
 * There is no map, and scanning is not the only way. GTK3 addressed a row by
 * `GtkTreePath` -- a path of indices, `"2:0:5"` -- and GTK4 did not take that
 * away, it only spelled it differently: `gtk_tree_list_model_get_child_row` for
 * a root and `gtk_tree_list_row_get_child_row` for a child. Descending those
 * from the root *is* a `GtkTreePath`, and it costs one indexed step per level
 * instead of one pass over everything on screen.
 *
 * It mattered because `AutoExpand` is **on unless turned off**, so filling a tree
 * was a scan per node and the fill was quadratic in a widget nobody had told to
 * be clever. Measured before, a folder of nine files repeated, filling with
 * `AutoExpand` on:
 *
 *       nodes    TreeView    TableView
 *         400      29 ms       25 ms
 *         800     133 ms       79 ms
 *        1600     578 ms      317 ms      <- doubling quadrupled it
 *
 * 57 ms and 67 ms after, and the whole table -- including the flat shape, where
 * the other half of the fix is -- is in `docs/widgets.md`.
 *
 * **The semantics are unchanged, which is what makes it a replacement and not a
 * feature.** Both GTK calls answer NULL when the row above is closed, which is
 * exactly what the two callers already promised: a node whose ancestors are
 * collapsed is not in the flattened list, so it has no row, and `Expanded(key)`
 * reads that as false.
 */
#include "bta.h"

/*
 * Which of the levels to open on the way down.
 *
 * Opening happens *during* the descent and not in a pass of its own, because a
 * row only comes into existence once the one above it is open -- so the descent
 * has to open as it goes, and doing it in the same walk is free.
 */
typedef enum {
    REACH_FIND,       /* open nothing: just find the row */
    REACH_PATH,       /* open every ancestor, leave the node as it is */
    REACH_NODE,       /* open every ancestor and the node itself */
} Reach;

/*
 * Where a node sits among its siblings, or G_MAXUINT. The store is the parent's
 * children, or the roots for a node that has no parent.
 *
 * **Backwards**, because what asks for a row is usually `AutoExpand` opening
 * the parent of a node that has *just been appended* -- and that parent is
 * itself the last thing added at its own level. Worth about a tenth on a filled
 * tree (1600 nodes, 65 ms forwards against 57) and nothing at all on one with
 * no nesting, where no row is ever looked up. A node in the middle costs the
 * same either way, so there is no case this loses.
 */
static guint index_in(GListModel *store, gpointer node)
{
    guint n = store ? g_list_model_get_n_items(store) : 0;

    for (guint i = n; i-- > 0;) {
        gpointer at  = g_list_model_get_item(store, i);
        bool     hit = (at == node);

        g_clear_object(&at);
        if (hit)
            return i;
    }
    return G_MAXUINT;
}

/*
 * The descent, which is the whole of this file.
 *
 * Root first, one indexed step per level. The chain is built from the node
 * upwards and walked downwards, because that is the only direction in which the
 * rows exist yet.
 */
static GtkTreeListRow *reach(BtaWidget *w, GtkTreeListModel *tree,
                             gpointer node, Reach how, const BtaTreeShape *shape)
{
    if (!tree || !node)
        return NULL;

    GPtrArray *chain = g_ptr_array_new();
    for (gpointer at = node; at; at = shape->parent(at))
        g_ptr_array_insert(chain, 0, at);

    GtkTreeListRow *row = NULL;

    for (guint i = 0; i < chain->len; i++) {
        gpointer    here  = chain->pdata[i];
        gpointer    up    = shape->parent(here);
        GListModel *store = up ? shape->children(up) : shape->roots(w);
        guint       at    = index_in(store, here);

        GtkTreeListRow *next =
            at == G_MAXUINT  ? NULL
            : row            ? gtk_tree_list_row_get_child_row(row, at)
                             : gtk_tree_list_model_get_child_row(tree, at);

        g_clear_object(&row);
        if (!next)
            break;                  /* an ancestor is closed: there is no row */
        row = next;

        const bool last = (i + 1 == chain->len);
        if (how == REACH_PATH ? !last : how == REACH_NODE)
            gtk_tree_list_row_set_expanded(row, TRUE);
    }

    g_ptr_array_free(chain, TRUE);
    return row;                     /* the caller owns it */
}

GtkTreeListRow *bta_tree_row_of(BtaWidget *w, GtkTreeListModel *tree,
                                gpointer node, const BtaTreeShape *shape)
{
    return reach(w, tree, node, REACH_FIND, shape);
}

void bta_tree_set_expanded(BtaWidget *w, GtkTreeListModel *tree, gpointer node,
                           bool open, const BtaTreeShape *shape)
{
    GtkTreeListRow *row = reach(w, tree, node, REACH_FIND, shape);

    if (!row)
        return;
    gtk_tree_list_row_set_expanded(row, open);
    g_object_unref(row);
}

void bta_tree_reveal(BtaWidget *w, GtkTreeListModel *tree, gpointer node,
                     bool with_node, const BtaTreeShape *shape)
{
    GtkTreeListRow *row = reach(w, tree, node,
                                with_node ? REACH_NODE : REACH_PATH, shape);
    g_clear_object(&row);
}
