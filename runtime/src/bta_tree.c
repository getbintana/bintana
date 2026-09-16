/*
 * TreeView.
 *
 * Built on GTK4's list machinery (GtkListView + GtkTreeListModel), not on
 * GtkTreeView, which has been deprecated since 4.10 -- a new toolkit should
 * not be founded on something already on its way out.
 *
 * The API is Gambas-shaped: nodes are addressed by string key, and a child is
 * placed by naming its parent's key.
 *
 *   this.Tree1.Add("forms", "Forms");
 *   this.Tree1.Add("Form1.form", "Form1", "forms", "text-x-generic");
 *
 * The fourth argument is an icon name from the desktop's theme (or the
 * project's own icons/), like Button.Icon.
 */
#include "bta.h"

#include <string.h>

/* ------------------------------------------------------------------ node */

#define BTA_TYPE_TREE_NODE (bta_tree_node_get_type())
G_DECLARE_FINAL_TYPE(BtaTreeNode, bta_tree_node, BTA, TREE_NODE, GObject)

struct _BtaTreeNode {
    GObject     parent_instance;
    char       *key;
    char       *text;
    char       *icon;          /* icon name, or NULL for a node with none */
    GListStore *children;      /* of BtaTreeNode, created lazily */
    /* Borrowed: the parent's store holds this node, so the parent outlives it.
     * Expanding needs it, because a row only exists once its ancestors are
     * open -- the chain has to be walked from the root, not from the node. */
    BtaTreeNode *parent;
};

G_DEFINE_FINAL_TYPE(BtaTreeNode, bta_tree_node, G_TYPE_OBJECT)

static void bta_tree_node_finalize(GObject *object)
{
    BtaTreeNode *self = BTA_TREE_NODE(object);

    g_free(self->key);
    g_free(self->text);
    g_free(self->icon);
    g_clear_object(&self->children);

    G_OBJECT_CLASS(bta_tree_node_parent_class)->finalize(object);
}

static void bta_tree_node_class_init(BtaTreeNodeClass *klass)
{
    G_OBJECT_CLASS(klass)->finalize = bta_tree_node_finalize;
}

static void bta_tree_node_init(BtaTreeNode *self) { }

static BtaTreeNode *tree_node_new(const char *key, const char *text,
                                  const char *icon)
{
    BtaTreeNode *node = g_object_new(BTA_TYPE_TREE_NODE, NULL);
    node->key      = g_strdup(key);
    node->text     = g_strdup(text);
    node->icon     = icon && *icon ? g_strdup(icon) : NULL;
    node->children = g_list_store_new(BTA_TYPE_TREE_NODE);
    return node;
}

/* ------------------------------------------------------------- the widget */

/* Kept on the list view: the roots, and a key -> node index so Add() and the
 * Key property do not have to walk the tree. */
#define ROOT_KEY  "bta-tree-root"
#define INDEX_KEY "bta-tree-index"
/* Whether a node added now comes open. On by default: a project tree wants to
 * be readable at a glance, and that is what this widget always did. */
#define AUTOEXPAND_KEY "bta-tree-autoexpand"

static GListStore *tree_roots(BtaWidget *w)
{
    return g_object_get_data(G_OBJECT(w->inner), ROOT_KEY);
}

static GHashTable *tree_index(BtaWidget *w)
{
    return g_object_get_data(G_OBJECT(w->inner), INDEX_KEY);
}

static GtkSingleSelection *tree_selection(BtaWidget *w)
{
    return GTK_SINGLE_SELECTION(
        gtk_list_view_get_model(GTK_LIST_VIEW(w->inner)));
}

static GtkTreeListModel *tree_model(BtaWidget *w)
{
    return GTK_TREE_LIST_MODEL(
        gtk_single_selection_get_model(tree_selection(w)));
}

static bool tree_autoexpands(BtaWidget *w)
{
    return g_object_get_data(G_OBJECT(w->inner), AUTOEXPAND_KEY) != NULL;
}

/*
 * What this widget's nodes are, for the walk that reaches their rows.
 *
 * The walk itself is `bta_treerows.c`, shared with `TableView` -- the two had a
 * copy each of the same scan, down to the comment, and the scan is what made
 * filling a tree quadratic. All that differs between them is the node type, so
 * all that is declared here is the node type.
 */
static gpointer tree_shape_parent(gpointer node)
{
    return BTA_TREE_NODE(node)->parent;
}

static GListModel *tree_shape_children(gpointer node)
{
    return G_LIST_MODEL(BTA_TREE_NODE(node)->children);
}

static GListModel *tree_shape_roots(BtaWidget *w)
{
    return G_LIST_MODEL(tree_roots(w));
}

static const BtaTreeShape tree_shape = {
    tree_shape_parent, tree_shape_children, tree_shape_roots,
};

static GtkTreeListRow *tree_row_of(BtaWidget *w, BtaTreeNode *node)
{
    return bta_tree_row_of(w, tree_model(w), node, &tree_shape);
}

static void tree_set_expanded(BtaWidget *w, BtaTreeNode *node, bool open)
{
    bta_tree_set_expanded(w, tree_model(w), node, open, &tree_shape);
}

static void tree_reveal(BtaWidget *w, BtaTreeNode *node, bool with_node)
{
    bta_tree_reveal(w, tree_model(w), node, with_node, &tree_shape);
}

/*
 * Always hand back the store, even when empty.  Returning NULL for a childless
 * node marks it a leaf permanently: GtkTreeListModel asks once, and a child
 * added afterwards would never appear.  Since Add() takes a parent by key, a
 * parent is routinely inserted before its children.
 *
 * The cost is that GTK would draw a disclosure arrow on every node, which
 * on_bind_row hides for the ones that have nothing under them.
 */
static GListModel *tree_child_model(gpointer item, gpointer user_data)
{
    BtaTreeNode *node = item;
    return G_LIST_MODEL(g_object_ref(node->children));
}

/*
 * A row is an icon and a label in a box, even for the nodes that have no icon:
 * rows are recycled, so building one shape and hiding what a given node does
 * not use costs nothing and keeps the labels of a tree lined up with each
 * other whether or not its nodes all carry one.
 */
#define ROW_ICON_KEY "bta-row-icon"

static void on_setup_row(GtkSignalListItemFactory *f, GtkListItem *item, gpointer u)
{
    GtkWidget *box      = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    GtkWidget *icon     = gtk_image_new();
    GtkWidget *label    = gtk_label_new("");
    GtkWidget *expander = gtk_tree_expander_new();

    gtk_label_set_xalign(GTK_LABEL(label), 0.0f);
    gtk_box_append(GTK_BOX(box), icon);
    gtk_box_append(GTK_BOX(box), label);

    /* The label is what on_bind_row wants most, so it stays reachable as the
     * box's last child; the image is tagged rather than found by position. */
    g_object_set_data(G_OBJECT(box), ROW_ICON_KEY, icon);

    gtk_tree_expander_set_child(GTK_TREE_EXPANDER(expander), box);
    gtk_list_item_set_child(item, expander);
}

/* Watched per bound row: a parent is normally added before its children, so
 * whether it has anything to disclose is only known later. */
#define WATCH_MODEL_KEY   "bta-watched-children"
#define WATCH_HANDLER_KEY "bta-watch-handler"

static void update_expander(GListModel *children, guint pos, guint removed,
                            guint added, gpointer expander)
{
    gtk_tree_expander_set_hide_expander(GTK_TREE_EXPANDER(expander),
                                        g_list_model_get_n_items(children) == 0);
}

static void on_bind_row(GtkSignalListItemFactory *f, GtkListItem *item, gpointer u)
{
    GtkTreeExpander *expander = GTK_TREE_EXPANDER(gtk_list_item_get_child(item));
    GtkTreeListRow  *row      = gtk_list_item_get_item(item);

    gtk_tree_expander_set_list_row(expander, row);

    BtaTreeNode *node  = gtk_tree_list_row_get_item(row);
    GtkWidget   *box   = gtk_tree_expander_get_child(expander);
    GtkWidget   *icon  = g_object_get_data(G_OBJECT(box), ROW_ICON_KEY);
    GtkWidget   *label = gtk_widget_get_last_child(box);

    gtk_label_set_text(GTK_LABEL(label), node ? node->text : "");

    /* An icon the theme does not really have is dropped rather than shown as
     * the broken-image glyph -- the same bargain Button.Icon makes, and for the
     * same reason: a name that resolves to nothing is worse than no name. */
    bool has_icon = node && node->icon && bta_icon_available(box, node->icon);
    if (has_icon)
        bta_image_set_icon(icon, node->icon);
    gtk_widget_set_visible(icon, has_icon);

    if (node) {
        GListModel *children = G_LIST_MODEL(node->children);
        update_expander(children, 0, 0, 0, expander);

        gulong id = g_signal_connect(children, "items-changed",
                                     G_CALLBACK(update_expander), expander);
        g_object_set_data(G_OBJECT(item), WATCH_HANDLER_KEY, GSIZE_TO_POINTER(id));
        g_object_set_data_full(G_OBJECT(item), WATCH_MODEL_KEY,
                               g_object_ref(children), g_object_unref);
    }
    g_clear_object(&node);
}

/* Rows are recycled, so the watch has to come off with the row. */
static void on_unbind_row(GtkSignalListItemFactory *f, GtkListItem *item, gpointer u)
{
    GObject *model = g_object_get_data(G_OBJECT(item), WATCH_MODEL_KEY);
    gulong   id    = GPOINTER_TO_SIZE(g_object_get_data(G_OBJECT(item),
                                                        WATCH_HANDLER_KEY));
    if (model && id)
        g_signal_handler_disconnect(model, id);

    g_object_set_data(G_OBJECT(item), WATCH_HANDLER_KEY, NULL);
    g_object_set_data(G_OBJECT(item), WATCH_MODEL_KEY, NULL);
}

static void on_tree_selection(GtkSelectionModel *model, guint pos, guint n,
                              gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Select", 0, NULL);
}

static void on_tree_activate(GtkListView *view, guint position, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Activate", 0, NULL);
}

static void build_tree(BtaWidget *w)
{
    GListStore *roots = g_list_store_new(BTA_TYPE_TREE_NODE);

    GtkTreeListModel *tree = gtk_tree_list_model_new(
        G_LIST_MODEL(roots),          /* takes ownership */
        FALSE,                        /* rows are GtkTreeListRow, not passthrough */
        TRUE,                         /* autoexpand: the model's, as TableView's
                                       * has always been -- see below */
        tree_child_model, NULL, NULL);

    GtkSingleSelection *selection =
        gtk_single_selection_new(G_LIST_MODEL(tree));
    gtk_single_selection_set_autoselect(selection, FALSE);
    gtk_single_selection_set_can_unselect(selection, TRUE);

    GtkListItemFactory *factory = gtk_signal_list_item_factory_new();
    g_signal_connect(factory, "setup",  G_CALLBACK(on_setup_row),  NULL);
    g_signal_connect(factory, "bind",   G_CALLBACK(on_bind_row),   NULL);
    g_signal_connect(factory, "unbind", G_CALLBACK(on_unbind_row), NULL);

    w->inner = gtk_list_view_new(GTK_SELECTION_MODEL(selection), factory);

    /* The roots outlive the tree model only through this reference. */
    g_object_set_data_full(G_OBJECT(w->inner), ROOT_KEY, g_object_ref(roots),
                           g_object_unref);
    g_object_set_data_full(G_OBJECT(w->inner), INDEX_KEY,
                           g_hash_table_new(g_str_hash, g_str_equal),
                           (GDestroyNotify)g_hash_table_destroy);
    /* On unless turned off, which is what this widget always did. */
    g_object_set_data(G_OBJECT(w->inner), AUTOEXPAND_KEY, GINT_TO_POINTER(1));

    w->gtk = gtk_scrolled_window_new();
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), w->inner);

    /* The selection model is not the widget: the finaliser has to be told, or
     * this handler outlives us and fires into freed memory. */
    g_signal_connect(selection, "selection-changed",
                     G_CALLBACK(on_tree_selection), w);
    bta_widget_watch(w, selection);
    g_signal_connect(w->inner, "activate", G_CALLBACK(on_tree_activate), w);
}

/* ------------------------------------------------------------------- API */

static BtaTreeNode *selected_node(BtaWidget *w)
{
    GtkSingleSelection *sel  = tree_selection(w);
    gpointer            item = gtk_single_selection_get_selected_item(sel);

    if (!item)
        return NULL;
    /* Borrowed: the row owns its item, and the model owns the row. */
    BtaTreeNode *node = gtk_tree_list_row_get_item(GTK_TREE_LIST_ROW(item));
    if (node)
        g_object_unref(node);
    return node;
}

static JSValue tree_add(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *key  = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!key || !*key) {
        JS_FreeCString(ctx, key);
        return JS_ThrowTypeError(ctx, "Add(key, text, [parentKey], [icon]) needs a key");
    }

    GHashTable *index = tree_index(w);
    if (g_hash_table_contains(index, key)) {
        JSValue e = JS_ThrowRangeError(ctx, "the tree already has a '%s'", key);
        JS_FreeCString(ctx, key);
        return e;
    }

    const char *text   = argc > 1 && JS_IsString(argv[1])
                             ? JS_ToCString(ctx, argv[1]) : NULL;
    const char *parent = argc > 2 && JS_IsString(argv[2])
                             ? JS_ToCString(ctx, argv[2]) : NULL;
    const char *icon   = argc > 3 && JS_IsString(argv[3])
                             ? JS_ToCString(ctx, argv[3]) : NULL;

    GListStore *into = tree_roots(w);
    if (parent && *parent) {
        BtaTreeNode *pnode = g_hash_table_lookup(index, parent);
        if (!pnode) {
            JSValue e = JS_ThrowRangeError(ctx, "no node '%s' to hang '%s' from",
                                           parent, key);
            JS_FreeCString(ctx, key);
            JS_FreeCString(ctx, text);
            JS_FreeCString(ctx, parent);
            JS_FreeCString(ctx, icon);
            return e;
        }
        into = pnode->children;
    }

    BtaTreeNode *node = tree_node_new(key, text ? text : key, icon);
    node->parent = (into == tree_roots(w)) ? NULL
                                           : g_hash_table_lookup(index, parent);
    g_list_store_append(into, node);          /* the store takes its own ref */

    /* The index borrows; the key string belongs to the node. */
    g_hash_table_insert(index, node->key, node);

    /*
     * **Opening is the model's job, which is what `TableView` always did.**
     *
     * This used to open the node by hand on every `Add`, under a comment saying
     * the model's own autoexpand *"would undo every Collapse"*. `TableView` has
     * passed `autoexpand` to `gtk_tree_list_model_new` since it grew a tree, and
     * measured side by side the two answer the same on all three questions a
     * mechanism can differ on: a childless node reads open, an explicit
     * `CollapseNode` survives until the node gains another child, and with
     * `AutoExpand` off nothing opens itself. `tests/widgets` pins all three
     * against both controls.
     *
     * So the fear was of something neither does, and the hand-rolled version
     * cost a reveal per node -- which, before the descent in `bta_treerows.c`,
     * was a scan of everything on screen per node. Filling 1600 flat nodes was
     * 328 ms and is 53; the table is in `docs/widgets.md`.
     *
     * **Both halves, because each answers a different one of the three.** The
     * model's autoexpand opens a row as it arrives, which is what makes a
     * childless node read open; it does *not* reopen a row that was collapsed
     * by hand and then gained a child -- measured -- and this line is what
     * does, exactly as `table_add_node` does it. One without the other is a
     * behaviour change, which is how this was found.
     */
    if (node->parent && tree_autoexpands(w))
        tree_reveal(w, node->parent, true);

    g_object_unref(node);

    JS_FreeCString(ctx, key);
    JS_FreeCString(ctx, text);
    JS_FreeCString(ctx, parent);
    JS_FreeCString(ctx, icon);
    return JS_UNDEFINED;
}

static void tree_clear_children(BtaTreeNode *node)
{
    guint n = g_list_model_get_n_items(G_LIST_MODEL(node->children));
    for (guint i = 0; i < n; i++) {
        BtaTreeNode *child = g_list_model_get_item(G_LIST_MODEL(node->children), i);
        tree_clear_children(child);
        g_object_unref(child);
    }
    g_list_store_remove_all(node->children);
}

/*
 * `Remove(key)` -- the node and everything under it.
 *
 * A tree that could only be emptied whole was the one gap the four list controls
 * did not share: `ListBox` and `TableView` both take a row out, and this had to
 * be rebuilt from nothing to lose one branch. Removing the subtree with it is
 * not a convenience either -- a node whose parent is gone is not something this
 * control can show, so the alternative would be orphans nothing draws.
 */
static void tree_forget(BtaWidget *w, BtaTreeNode *node)
{
    GListModel *kids = G_LIST_MODEL(node->children);

    for (guint i = g_list_model_get_n_items(kids); i > 0; i--) {
        BtaTreeNode *child = g_list_model_get_item(kids, i - 1);
        tree_forget(w, child);
        g_object_unref(child);
    }
    if (node->key)
        g_hash_table_remove(tree_index(w), node->key);
}

static JSValue tree_remove(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *key = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!key)
        return JS_ThrowTypeError(ctx, "Remove(key) expects a node's key");

    BtaTreeNode *node = g_hash_table_lookup(tree_index(w), key);
    if (!node) {
        JSValue e = JS_ThrowRangeError(ctx, "Remove: there is no node '%s'", key);
        JS_FreeCString(ctx, key);
        return e;
    }
    JS_FreeCString(ctx, key);

    /* Held across the removal: the store's is the only reference, and dropping
     * it first would finalise the node while its own subtree is being walked. */
    g_object_ref(node);

    GListStore *store = node->parent ? node->parent->children : tree_roots(w);
    guint       at    = 0;

    tree_forget(w, node);
    if (g_list_store_find(store, node, &at))
        g_list_store_remove(store, at);
    g_object_unref(node);
    return JS_UNDEFINED;
}

/*
 * Put the highlight back on a node, opening the way to it first.
 *
 * Needed because **telling a store one of its items changed loses the
 * selection**: the tree model answers with fresh `GtkTreeListRow` wrappers and
 * the selection was on one of those. A flat list does not have the problem --
 * GTK's selection model follows the item across a change -- so this is the
 * price of the hierarchy, and it is paid here rather than by the caller, who
 * did not ask to move anything.
 */
static void tree_reselect(BtaWidget *w, BtaTreeNode *node)
{
    if (!node)
        return;

    GtkSingleSelection *sel   = tree_selection(w);
    GListModel         *model = G_LIST_MODEL(gtk_single_selection_get_model(sel));
    guint               n     = g_list_model_get_n_items(model);

    tree_reveal(w, node, false);
    for (guint i = 0; i < n; i++) {
        GtkTreeListRow *row  = g_list_model_get_item(model, i);
        BtaTreeNode    *item = gtk_tree_list_row_get_item(row);
        bool            hit  = (item == node);

        g_clear_object(&item);
        g_object_unref(row);
        if (hit) {
            gtk_single_selection_set_selected(sel, i);
            return;
        }
    }
}

/*
 * `SetText(key, text)` and `SetIcon(key, name)` -- a node after it was added.
 *
 * **A node used to be write-once.** Its text and its icon were arguments to
 * `Add` and there was no way to change either: renaming a file in a project tree
 * meant rebuilding the branch, and marking one as modified could not be done at
 * all. `TableView` has had `SetCell` and `SetIcon` since it existed, and these
 * are the same two members for the control that has one column instead of many
 * -- so no column argument, and that is the whole of the difference.
 */
enum { NODE_TEXT, NODE_ICON };

static JSValue tree_set_one(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *who = magic == NODE_TEXT ? "SetText" : "SetIcon";

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "%s(key, %s) needs both", who,
                                 magic == NODE_TEXT ? "text" : "name");

    const char *key = JS_ToCString(ctx, argv[0]);
    if (!key)
        return JS_EXCEPTION;

    BtaTreeNode *node = g_hash_table_lookup(tree_index(w), key);
    if (!node) {
        JSValue e = JS_ThrowRangeError(ctx, "%s: there is no node '%s'", who, key);
        JS_FreeCString(ctx, key);
        return e;
    }
    JS_FreeCString(ctx, key);

    const char *value = JS_ToCString(ctx, argv[1]);
    if (!value)
        return JS_EXCEPTION;

    if (magic == NODE_TEXT) {
        g_free(node->text);
        node->text = g_strdup(value);
    } else {
        /* "" takes it off, and a name the theme cannot draw is dropped the same
         * way `Add` drops one -- better no icon than the broken-image glyph. */
        g_free(node->icon);
        node->icon = *value ? g_strdup(value) : NULL;
    }
    JS_FreeCString(ctx, value);

    /* The row is rebound by telling the store that holds this node, which is
     * the parent's children or the roots -- and that costs the selection, so
     * whatever was selected is put back. Renaming a node is not moving it. */
    BtaTreeNode *was   = selected_node(w);
    GListStore  *store = node->parent ? node->parent->children : tree_roots(w);
    guint        at    = 0;

    if (g_list_store_find(store, node, &at))
        g_list_model_items_changed(G_LIST_MODEL(store), at, 1, 1);
    if (was && !selected_node(w))
        tree_reselect(w, was);
    return JS_UNDEFINED;
}

static JSValue tree_clear(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget  *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GListStore *roots = tree_roots(w);
    guint       n     = g_list_model_get_n_items(G_LIST_MODEL(roots));

    for (guint i = 0; i < n; i++) {
        BtaTreeNode *node = g_list_model_get_item(G_LIST_MODEL(roots), i);
        tree_clear_children(node);
        g_object_unref(node);
    }
    g_list_store_remove_all(roots);
    g_hash_table_remove_all(tree_index(w));
    return JS_UNDEFINED;
}

static JSValue tree_get_key(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    BtaTreeNode *node = selected_node(w);
    return JS_NewString(ctx, node ? node->key : "");
}

static JSValue tree_set_key(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *key = JS_ToCString(ctx, val);
    if (!key)
        return JS_EXCEPTION;

    GtkSingleSelection *sel = tree_selection(w);
    if (!*key) {
        gtk_single_selection_set_selected(sel, GTK_INVALID_LIST_POSITION);
        JS_FreeCString(ctx, key);
        return JS_UNDEFINED;
    }

    /* A collapsed node is not in the flattened list at all, so selecting one
     * has to open the way to it first -- otherwise Key would silently do
     * nothing for a node that exists. */
    BtaTreeNode *want = g_hash_table_lookup(tree_index(w), key);
    if (want)
        tree_reveal(w, want, false);

    /* Rows are flattened by the tree model, so the position of a key is only
     * knowable by scanning. */
    GListModel *model = G_LIST_MODEL(gtk_single_selection_get_model(sel));
    guint       n     = g_list_model_get_n_items(model);
    bool        found = false;

    for (guint i = 0; i < n && !found; i++) {
        GtkTreeListRow *row  = g_list_model_get_item(model, i);
        BtaTreeNode    *node = gtk_tree_list_row_get_item(row);

        if (node && !strcmp(node->key, key)) {
            gtk_single_selection_set_selected(sel, i);
            found = true;
        }
        g_clear_object(&node);
        g_object_unref(row);
    }

    JSValue e = found ? JS_UNDEFINED
                      : JS_ThrowRangeError(ctx, "the tree has no '%s'", key);
    JS_FreeCString(ctx, key);
    return e;
}

static JSValue tree_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    BtaTreeNode *node = selected_node(w);
    return JS_NewString(ctx, node ? node->text : "");
}

static JSValue tree_get_count(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, (int)g_hash_table_size(tree_index(w)));
}

static JSValue tree_exists(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *key = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    bool        has = key && g_hash_table_contains(tree_index(w), key);
    JS_FreeCString(ctx, key);
    return JS_NewBool(ctx, has);
}


/* ------------------------------------------------------- expand / collapse */

/*
 * A node is opened by name, like everything else here.  Opening one opens the
 * way to it as well: asking for a node buried under closed ancestors and being
 * handed nothing visible would be a promise half kept.
 */
static JSValue tree_expand(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *key = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!key)
        return JS_ThrowTypeError(ctx, "ExpandNode(key) expects a key");

    BtaTreeNode *node = g_hash_table_lookup(tree_index(w), key);
    if (!node) {
        JSValue e = JS_ThrowRangeError(ctx, "the tree has no '%s'", key);
        JS_FreeCString(ctx, key);
        return e;
    }
    JS_FreeCString(ctx, key);

    if (magic)
        tree_reveal(w, node, true);
    else
        tree_set_expanded(w, node, false);
    return JS_UNDEFINED;
}

static JSValue tree_expanded(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *key = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!key)
        return JS_ThrowTypeError(ctx, "Expanded(key) expects a key");

    BtaTreeNode *node = g_hash_table_lookup(tree_index(w), key);
    JS_FreeCString(ctx, key);

    /* A node whose ancestors are closed has no row, and answering false for it
     * is the honest reading: nothing under it is on screen. */
    GtkTreeListRow *row = node ? tree_row_of(w, node) : NULL;
    bool            on  = row && gtk_tree_list_row_get_expanded(row);

    g_clear_object(&row);
    return JS_NewBool(ctx, on);
}

/* Every node, opened or closed. Collapsing is done by rescanning rather than
 * by walking a list: closing one row takes its descendants out of the model,
 * so any positions gathered beforehand would be stale by the second one. */
static JSValue tree_expand_all(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    if (magic) {
        GHashTableIter it;
        gpointer       key, value;

        g_hash_table_iter_init(&it, tree_index(w));
        while (g_hash_table_iter_next(&it, &key, &value))
            tree_reveal(w, value, true);
        return JS_UNDEFINED;
    }

    for (;;) {
        GListModel *model = G_LIST_MODEL(tree_model(w));
        guint       n     = g_list_model_get_n_items(model);
        bool        any   = false;

        for (guint i = 0; i < n && !any; i++) {
            GtkTreeListRow *row = g_list_model_get_item(model, i);
            if (row && gtk_tree_list_row_get_expanded(row)) {
                gtk_tree_list_row_set_expanded(row, FALSE);
                any = true;
            }
            g_clear_object(&row);
        }
        if (!any)
            break;
    }
    return JS_UNDEFINED;
}

static JSValue tree_get_autoexpand(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, tree_autoexpands(w));
}

static JSValue tree_set_autoexpand(JSContext *ctx, JSValueConst this_val,
                                   JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int on = JS_ToBool(ctx, val);
    if (on < 0)
        return JS_EXCEPTION;

    g_object_set_data(G_OBJECT(w->inner), AUTOEXPAND_KEY,
                      on ? GINT_TO_POINTER(1) : NULL);
    gtk_tree_list_model_set_autoexpand(tree_model(w), on != 0);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry tree_props[] = {
    JS_CGETSET_DEF("Key",   tree_get_key,   tree_set_key),
    JS_CGETSET_DEF("Text",  tree_get_text,  NULL),
    JS_CGETSET_DEF("Count", tree_get_count, NULL),
    JS_CFUNC_DEF("Add",    4, tree_add),
    JS_CFUNC_DEF("Clear",  0, tree_clear),
    JS_CFUNC_DEF("Remove", 1, tree_remove),
    JS_CFUNC_MAGIC_DEF("SetText", 2, tree_set_one, NODE_TEXT),
    JS_CFUNC_MAGIC_DEF("SetIcon", 2, tree_set_one, NODE_ICON),
    JS_CFUNC_DEF("Exists", 1, tree_exists),
    JS_CGETSET_DEF("AutoExpand", tree_get_autoexpand, tree_set_autoexpand),
    /* Not "Expand": Widget already has one, the boolean that decides who
     * absorbs slack in a box.  A method of that name would shadow it on the
     * prototype and then be shadowed right back the moment a .form set the
     * layout property on the instance -- which is how this was found. */
    JS_CFUNC_MAGIC_DEF("ExpandNode",   1, tree_expand,     1),
    JS_CFUNC_MAGIC_DEF("CollapseNode", 1, tree_expand,     0),
    JS_CFUNC_DEF("Expanded",          1, tree_expanded),
    JS_CFUNC_MAGIC_DEF("ExpandAll",   0, tree_expand_all, 1),
    JS_CFUNC_MAGIC_DEF("CollapseAll", 0, tree_expand_all, 0),
};

void bta_tree_register(void)
{
    const BtaClass rows[] = {
        BTA_CLASS("TreeView", "Control", build_tree, tree_props, false, "Select,Activate"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
