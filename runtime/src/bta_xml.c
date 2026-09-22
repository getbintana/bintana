/*
 * Xml -- XML as a **document**, at JSON's level.
 *
 * ## Why this is a DOM and not a value mapping
 *
 * JSON and JavaScript are the same value model -- object, list, scalar -- which
 * is the whole reason `JSON.parse` can answer one and `Record.Serialize` can
 * write one. XML is a different model: attributes, order (an MSPDI schema is an
 * `xsd:sequence`), namespaces and mixed content are structure that no plain
 * object has somewhere to keep, so a value mapping has to decide arbitrarily
 * what an attribute is and where an element went.
 *
 * So the C is a document: parse, walk, edit, write. The mapping from a
 * `Record` onto an element is a *declaration* and lives in `rad.js`, beside
 * `Table` and for the same reason -- a record's values are in a private bag
 * scoped to `Record`. See docs/plans/xml-plan.md.
 *
 * ## The three things worth knowing before reading
 *
 * **A node wrapper holds a tree, not a document.** A parsed file, a value from
 * `Xml.Element(name)` and a `Copy()` are all a tree: a `xmlDocPtr` for the
 * first, a detached root for the others. Wrappers reference the tree, the tree
 * is reference counted, and it frees itself when the last wrapper dies -- so a
 * `Children` array that outlives its document still reads valid memory.
 *
 * **A removed subtree is orphaned, not freed.** `Remove()`, and a `Text`
 * assignment that replaces children, unlink the nodes into the tree's orphan
 * list: a wrapper somebody is still holding keeps answering, and the tree frees
 * them when it dies. Freeing them there and then would leave the next read of a
 * `Children` entry as use-after-free, which is the trap this repository keeps
 * writing down.
 *
 * **A node from another tree is copied in, never moved.** Moving a subtree
 * between documents would have to repoint every wrapper under it, and a wrapper
 * that was not repointed is a dangling pointer. `Add` copies across trees and
 * answers the node that is in *this* tree; within one tree it moves, as a DOM
 * does. The rule the record mapper uses is `const el = parent.Add(Xml.Element("X"))`.
 *
 * ## Security, and it is a negative
 *
 * Parsed with `XML_PARSE_NONET` and without `NOENT`/`DTDLOAD`/`HUGE`: external
 * entities, a billion laughs and a 2 GB text node are not configurations to get
 * right, they are things this parser does not do. `NOERROR`/`NOWARNING` keep
 * libxml2's default handler from printing to stderr, so the only thing a bad
 * document does is throw with its line and column.
 *
 * Optional at build time, the sqlite mould: without libxml2 `Xml` still exists,
 * `Available` is false, and the verbs refuse with a sentence rather than a
 * class that is not there.
 */
#include "bta.h"

#include <limits.h>
#include <string.h>

#ifdef BTA_HAVE_LIBXML

#include <libxml/parser.h>
#include <libxml/tree.h>

/* --------------------------------------------------------------------- trees */

/*
 * One document or one detached root, with everything that points at it.
 *
 * `doc` and `root` are two spellings of "the tree this belongs to": a parsed
 * document has the first, a value built by `Xml.Element` or `Copy` has the
 * second. `orphans` is where `Remove()` puts a subtree -- unlinked from the
 * tree but still referenced by wrappers -- and the whole list is freed when the
 * last wrapper lets the tree go.
 */
typedef struct {
    xmlDocPtr  doc;
    xmlNodePtr root;
    GList     *orphans;
    int        refs;
} BtaXmlTree;

typedef struct {
    BtaXmlTree *tree;
    xmlNodePtr  node;   /* NULL once the node was removed */
} BtaXmlNode;

static JSClassID bta_xml_doc_class_id;
static JSClassID bta_xml_node_class_id;

static BtaXmlTree *xml_tree_doc(xmlDocPtr doc)
{
    BtaXmlTree *t = g_new0(BtaXmlTree, 1);

    t->doc  = doc;
    t->refs = 1;
    return t;
}

static BtaXmlTree *xml_tree_root(xmlNodePtr root)
{
    BtaXmlTree *t = g_new0(BtaXmlTree, 1);

    t->root = root;
    t->refs = 1;
    return t;
}

static void xml_free_node(gpointer node)
{
    xmlFreeNode((xmlNodePtr)node);
}

static void xml_tree_unref(JSRuntime *rt, BtaXmlTree *t)
{
    if (!t || --t->refs > 0)
        return;

    if (t->orphans)
        g_list_free_full(t->orphans, xml_free_node);
    if (t->doc)
        xmlFreeDoc(t->doc);
    else if (t->root)
        xmlFreeNode(t->root);
    g_free(t);
}

static void xml_tree_ref(BtaXmlTree *t)
{
    t->refs++;
}

/*
 * The two doors of the orphan list, and the invariant they keep: a node is on
 * it **at most once**, and **only while it has no parent**. Either half broken
 * is a double free at teardown -- once from the list and once from wherever
 * else the node is reachable -- and both were reachable, because wrappers are
 * not unique: two `Find`s of one element are two wrappers, so the second
 * `Remove()` found a node the first had already orphaned, and a wrapper kept
 * over a `Text` assignment could `Add` its orphan back into the tree.
 */
static void xml_orphan(BtaXmlTree *t, xmlNodePtr node)
{
    if (!g_list_find(t->orphans, node))
        t->orphans = g_list_prepend(t->orphans, node);
}

static void xml_adopt(BtaXmlTree *t, xmlNodePtr node)
{
    t->orphans = g_list_remove(t->orphans, node);
}

static void xml_doc_finalizer(JSRuntime *rt, JSValue val)
{
    BtaXmlTree *t = JS_GetOpaque(val, bta_xml_doc_class_id);

    if (t)
        xml_tree_unref(rt, t);
}

static void xml_node_finalizer(JSRuntime *rt, JSValue val)
{
    BtaXmlNode *n = JS_GetOpaque(val, bta_xml_node_class_id);

    if (!n)
        return;
    if (n->tree)
        xml_tree_unref(rt, n->tree);
    js_free_rt(rt, n);
}

static const JSClassDef xml_doc_class = {
    "XmlDocument",
    .finalizer = xml_doc_finalizer,
};

static const JSClassDef xml_node_class = {
    "XmlNode",
    .finalizer = xml_node_finalizer,
};

/* --------------------------------------------------------------- wrappers */

/* Takes over the tree's first reference -- the caller built it and owns it. */
static JSValue xml_doc_new(JSContext *ctx, BtaXmlTree *t)
{
    JSValue proto = JS_GetClassProto(ctx, bta_xml_doc_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_xml_doc_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        xml_tree_unref(JS_GetRuntime(ctx), t);
        return obj;
    }
    JS_SetOpaque(obj, t);
    return obj;
}

/*
 * `owns` is the difference between the two callers: a wrapper around a node
 * that is already in a tree borrows that tree, and one around a node just built
 * hands its own reference over.
 */
static JSValue xml_node_new(JSContext *ctx, BtaXmlTree *t, xmlNodePtr node,
                            bool owns)
{
    JSValue proto = JS_GetClassProto(ctx, bta_xml_node_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_xml_node_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        if (owns)
            xml_tree_unref(JS_GetRuntime(ctx), t);
        return obj;
    }

    BtaXmlNode *n = js_mallocz(ctx, sizeof *n);
    if (!n) {
        if (owns)
            xml_tree_unref(JS_GetRuntime(ctx), t);
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }

    n->tree = t;
    n->node = node;
    if (!owns)
        xml_tree_ref(t);
    JS_SetOpaque(obj, n);
    return obj;
}

/* ---------------------------------------------------------------- helpers */

static const int XML_FLAGS = XML_PARSE_NONET | XML_PARSE_NOBLANKS |
                             XML_PARSE_NOERROR | XML_PARSE_NOWARNING;

/*
 * Whether a string can be written as an element name.
 *
 * Stricter than "no spaces in it" on purpose: `xmlNewNode` accepts anything and
 * the serialiser will happily write `<1 a>`, which is a document no parser can
 * read back -- a refusal at the call, where the programmer can see it, and not
 * a file that fails somewhere else. A byte past ASCII is left alone, because
 * Unicode names are legal XML and this is not a Unicode table.
 *
 * `:` is refused: a name here is a local name, and a prefix is what
 * `SetNamespace` is for. Matching by local name is the rest of the API, so a
 * node whose `Name` carried a colon would be findable by a name nothing else
 * accepted.
 */
static bool xml_name_ok(const char *s)
{
    if (!s || !*s)
        return false;

    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c     = *p;
        bool          first = p == (const unsigned char *)s;

        if (c >= 0x80)
            continue;
        if (c == '_')
            continue;
        if (c >= 'A' && c <= 'Z')
            continue;
        if (c >= 'a' && c <= 'z')
            continue;
        if (!first && c >= '0' && c <= '9')
            continue;
        if (!first && (c == '-' || c == '.'))
            continue;
        return false;
    }
    return true;
}

static JSValue xml_throw_last(JSContext *ctx)
{
    const xmlError *e = xmlGetLastError();

    if (!e || !e->message)
        return JS_ThrowSyntaxError(ctx, "the XML could not be parsed");

    char *msg = g_strdup(e->message);
    g_strchomp(msg);

    JSValue out;
    if (e->line > 0)
        out = JS_ThrowSyntaxError(ctx, "%d:%d: %s", e->line, e->int2, msg);
    else
        out = JS_ThrowSyntaxError(ctx, "%s", msg);
    g_free(msg);
    return out;
}

static JSValue xml_doc_dump(JSContext *ctx, xmlDocPtr doc)
{
    xmlChar *mem  = NULL;
    int      size = 0;

    xmlDocDumpFormatMemoryEnc(doc, &mem, &size, "UTF-8", 1);
    if (!mem)
        return JS_ThrowInternalError(ctx, "Xml.Stringify: the document could "
                                          "not be written");

    JSValue out;
    if (size > 0 && mem[size - 1] == '\n') {
        out = JS_NewStringLen(ctx, (const char *)mem, size);
    } else {
        /* One canonical shape, the same bargain `File.SaveJson` makes: indented
         * by two, ending in a newline. */
        char *joined = g_strconcat((const char *)mem, "\n", NULL);

        out = JS_NewString(ctx, joined);
        g_free(joined);
    }
    xmlFree(mem);
    return out;
}

static BtaXmlNode *node_this(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = JS_GetOpaque(this_val, bta_xml_node_class_id);

    if (!n || !n->node) {
        JS_ThrowTypeError(ctx, "this node is no longer in a document");
        return NULL;
    }
    return n;
}

static xmlNodePtr nth_element(xmlNodePtr parent, int index)
{
    int i = 0;

    for (xmlNodePtr c = parent->children; c; c = c->next) {
        if (c->type != XML_ELEMENT_NODE)
            continue;
        if (i == index)
            return c;
        i++;
    }
    return NULL;
}

static bool xml_is_inside(xmlNodePtr node, xmlNodePtr ancestor)
{
    for (xmlNodePtr p = node; p; p = p->parent)
        if (p == ancestor)
            return true;
    return false;
}

/*
 * Puts `node` at `index` among the parent's element children, -1 for the end.
 * The node must already belong to the parent's tree (or have been copied into
 * it), which is what `xml_place_child` below decides.
 */
static void xml_place(xmlNodePtr parent, int index, xmlNodePtr node)
{
    xmlNodePtr before = index >= 0 ? nth_element(parent, index) : NULL;

    /* Asking for the place a node already occupies is an answer, and not
     * `xmlAddPrevSibling(node, node)` -- which the record mapper asks for every
     * item that is already in order. */
    if (before == node)
        return;
    if (before)
        xmlAddPrevSibling(before, node);
    else {
        /* `xmlAddPrevSibling` unlinks what it moves and `xmlAddChild` is not
         * promised to in every libxml2 this builds against, so a node moved
         * to the end leaves its old place first. */
        xmlUnlinkNode(node);
        xmlAddChild(parent, node);
    }
}

/*
 * The one road a child comes in by, and the rule from this file's head: the
 * same tree moves, another tree copies, and the wrapper that comes back is
 * always the one in the parent's tree.
 */
static JSValue xml_place_child(JSContext *ctx, BtaXmlNode *parent,
                               int index, JSValueConst value)
{
    if (JS_IsString(value)) {
        size_t      len  = 0;
        const char *name = JS_ToCStringLen(ctx, &len, value);

        if (!name)
            return JS_EXCEPTION;
        if (!xml_name_ok(name)) {
            JSValue e = JS_ThrowTypeError(ctx, "Add: '%s' is not an XML "
                                               "element name", name);
            JS_FreeCString(ctx, name);
            return e;
        }

        xmlNodePtr el = xmlNewNode(NULL, BAD_CAST name);
        JS_FreeCString(ctx, name);
        if (!el)
            return JS_EXCEPTION;

        /* The new element belongs to the detached half of the tree, so it takes
         * the parent's document if it has one. */
        if (parent->tree->doc)
            xmlSetTreeDoc(el, parent->tree->doc);
        xml_place(parent->node, index, el);

        JSValue w = xml_node_new(ctx, parent->tree, el, false);
        if (JS_IsException(w)) {
            xmlUnlinkNode(el);
            xmlFreeNode(el);
        }
        return w;
    }

    BtaXmlNode *child = JS_GetOpaque(value, bta_xml_node_class_id);
    if (!child)
        return JS_ThrowTypeError(ctx, "Add: expected a node or an element name");
    if (!child->node)
        return JS_ThrowTypeError(ctx, "Add: that node was removed");
    if (xml_is_inside(parent->node, child->node))
        return JS_ThrowTypeError(ctx, "Add: a node cannot contain itself");

    if (child->tree == parent->tree) {
        /* A node coming back from the orphan list leaves it, or it would be
         * freed as an orphan and again with whatever it now sits in.  And the
         * root of a detached tree can only be moved under one of its orphans
         * -- everything else is inside it -- so it stops being the root, the
         * same answer `Remove()` gives. */
        xml_adopt(child->tree, child->node);
        if (child->tree->root == child->node)
            child->tree->root = NULL;
        xml_place(parent->node, index, child->node);
        return JS_DupValue(ctx, value);
    }

    xmlNodePtr copy = xmlDocCopyNode(child->node, parent->tree->doc, 1);
    if (!copy)
        return JS_EXCEPTION;
    if (parent->tree->doc)
        xmlSetTreeDoc(copy, parent->tree->doc);
    xml_place(parent->node, index, copy);

    JSValue w = xml_node_new(ctx, parent->tree, copy, false);
    if (JS_IsException(w)) {
        xmlUnlinkNode(copy);
        xmlFreeNode(copy);
    }
    return w;
}

/* ------------------------------------------------------------- Xml.Parse */

static JSValue xml_doc_from_memory(JSContext *ctx, const char *data, size_t len)
{
    if (len > (size_t)INT_MAX)
        return JS_ThrowRangeError(ctx, "Xml: %zu bytes is more than XML can be "
                                       "read in one piece", len);

    xmlResetLastError();
    xmlDocPtr doc = xmlReadMemory(data, (int)len, NULL, NULL, XML_FLAGS);

    if (!doc)
        return xml_throw_last(ctx);
    return xml_doc_new(ctx, xml_tree_doc(doc));
}

/* Parse(text) */
static JSValue xml_parse(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Xml.Parse(text) expects text");

    size_t      len = 0;
    const char *s   = JS_ToCStringLen(ctx, &len, argv[0]);

    if (!s)
        return JS_EXCEPTION;

    JSValue out = xml_doc_from_memory(ctx, s, len);
    JS_FreeCString(ctx, s);
    return out;
}

/* ParseBytes(bytes) */
static JSValue xml_parse_bytes(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    size_t            len  = 0;
    const uint8_t    *data = argc >= 1 ? bta_bytes_get(argv[0], &len) : NULL;

    if (!data)
        return JS_ThrowTypeError(ctx, "Xml.ParseBytes(bytes) expects a Bytes");
    return xml_doc_from_memory(ctx, (const char *)data, len);
}

/* Stringify(node) -- a document or an element, canonical either way. */
static JSValue xml_stringify(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Xml.Stringify(node) expects a document "
                                      "or an element");

    BtaXmlTree *t = JS_GetOpaque(argv[0], bta_xml_doc_class_id);
    if (t)
        return xml_doc_dump(ctx, t->doc);

    BtaXmlNode *n = JS_GetOpaque(argv[0], bta_xml_node_class_id);
    if (!n || !n->node)
        return JS_ThrowTypeError(ctx, "Xml.Stringify(node) expects a document "
                                      "or an element");

    /* A detached element is written by copying it into a document of its own:
     * the declaration is part of the canonical shape, and a node has none. */
    xmlDocPtr  tmp  = xmlNewDoc(BAD_CAST "1.0");
    xmlNodePtr copy = xmlDocCopyNode(n->node, tmp, 1);

    if (!copy) {
        xmlFreeDoc(tmp);
        return JS_EXCEPTION;
    }
    xmlDocSetRootElement(tmp, copy);

    JSValue out = xml_doc_dump(ctx, tmp);
    xmlFreeDoc(tmp);
    return out;
}

/* Element(name) -- a detached element, the building block. */
static JSValue xml_element(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Xml.Element(name) expects a name");

    size_t      len  = 0;
    const char *name = JS_ToCStringLen(ctx, &len, argv[0]);

    if (!name)
        return JS_EXCEPTION;

    if (!xml_name_ok(name)) {
        JSValue e = JS_ThrowTypeError(ctx, "Xml.Element: '%s' is not an XML "
                                           "element name", name);
        JS_FreeCString(ctx, name);
        return e;
    }

    xmlNodePtr el = xmlNewNode(NULL, BAD_CAST name);
    JS_FreeCString(ctx, name);
    if (!el)
        return JS_EXCEPTION;
    return xml_node_new(ctx, xml_tree_root(el), el, true);
}

/* ---------------------------------------------------------------- document */

/* Root */
static JSValue xml_doc_get_root(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlTree *t = JS_GetOpaque(this_val, bta_xml_doc_class_id);

    if (!t)
        return JS_EXCEPTION;

    xmlNodePtr root = t->doc ? xmlDocGetRootElement(t->doc) : t->root;
    if (!root)
        return JS_NULL;
    return xml_node_new(ctx, t, root, false);
}

static const JSCFunctionListEntry xml_doc_props[] = {
    JS_CGETSET_DEF("Root", xml_doc_get_root, NULL),
};

/* ------------------------------------------------------------------- nodes */

/* Name */
static JSValue xml_node_get_name(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = node_this(ctx, this_val);

    return n ? JS_NewString(ctx, (const char *)n->node->name) : JS_EXCEPTION;
}

/* Prefix */
static JSValue xml_node_get_prefix(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = node_this(ctx, this_val);

    if (!n)
        return JS_EXCEPTION;
    return JS_NewString(ctx, n->node->ns && n->node->ns->prefix
                             ? (const char *)n->node->ns->prefix : "");
}

/* Namespace -- the URI, or "" for one in no namespace. */
static JSValue xml_node_get_namespace(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = node_this(ctx, this_val);

    if (!n)
        return JS_EXCEPTION;
    return JS_NewString(ctx, n->node->ns && n->node->ns->href
                             ? (const char *)n->node->ns->href : "");
}

/* Text, which is all the character data under it. */
static JSValue xml_node_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = node_this(ctx, this_val);

    if (!n)
        return JS_EXCEPTION;

    xmlChar *content = xmlNodeGetContent(n->node);
    if (!content)
        return JS_NewString(ctx, "");

    JSValue out = JS_NewString(ctx, (const char *)content);
    xmlFree(content);
    return out;
}

static JSValue xml_node_set_text(JSContext *ctx, JSValueConst this_val,
                                 JSValueConst val)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;

    size_t      len = 0;
    const char *s   = JS_ToCStringLen(ctx, &len, val);
    if (!s)
        return JS_EXCEPTION;

    /*
     * The children go to the orphan list rather than being freed, because a
     * wrapper somebody is holding has to keep answering. `xmlNodeSetContent`
     * would free them where they stand, which is use-after-free one `Children`
     * read later.
     */
    xmlNodePtr c = n->node->children;
    while (c) {
        xmlNodePtr next = c->next;

        xmlUnlinkNode(c);
        xml_orphan(n->tree, c);
        c = next;
    }
    xmlNodeAddContentLen(n->node, BAD_CAST s, (int)len);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* Attr(name) -- the value, "" for one that is there and empty, null for none. */
static JSValue xml_node_attr(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Attr(name) expects the attribute name");

    const char  *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    xmlChar *v = xmlGetProp(n->node, BAD_CAST name);
    JS_FreeCString(ctx, name);

    if (!v)
        return JS_NULL;
    JSValue out = JS_NewString(ctx, (const char *)v);
    xmlFree(v);
    return out;
}

/* SetAttr(name, value) */
static JSValue xml_node_set_attr(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsString(argv[1]))
        return JS_ThrowTypeError(ctx, "SetAttr(name, value) expects the name "
                                      "and the value as text");

    const char *name = JS_ToCString(ctx, argv[0]);
    const char *v    = JS_ToCString(ctx, argv[1]);
    if (!name || !v) {
        if (name) JS_FreeCString(ctx, name);
        if (v)    JS_FreeCString(ctx, v);
        return JS_EXCEPTION;
    }
    if (!xml_name_ok(name)) {
        JSValue e = JS_ThrowTypeError(ctx, "SetAttr: '%s' is not an XML "
                                           "attribute name", name);
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, v);
        return e;
    }

    xmlAttrPtr made = xmlSetProp(n->node, BAD_CAST name, BAD_CAST v);
    JS_FreeCString(ctx, name);
    JS_FreeCString(ctx, v);
    if (!made)
        return JS_EXCEPTION;
    return JS_UNDEFINED;
}

/* RemoveAttr(name) */
static JSValue xml_node_remove_attr(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "RemoveAttr(name) expects the attribute "
                                      "name");

    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    xmlUnsetProp(n->node, BAD_CAST name);
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

/*
 * AttributeNames()
 *
 * Local names, because that is what `Attr` and `SetAttr` take. An `xmlns`
 * declaration is not an attribute in libxml2's tree and is not in this list --
 * it is the namespace, which `Namespace` and `SetNamespace` are for.
 */
static JSValue xml_node_attribute_names(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;

    JSValue out = JS_NewArray(ctx);
    uint32_t i  = 0;

    for (xmlAttrPtr a = n->node->properties; a; a = a->next) {
        JSValue name = JS_NewString(ctx, (const char *)a->name);

        if (JS_IsException(name)) {
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32(ctx, out, i++, name);
    }
    return out;
}

/* Children -- the element children, which is what a record mapper walks. */
static JSValue xml_node_children(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;

    JSValue  out = JS_NewArray(ctx);
    uint32_t i   = 0;

    for (xmlNodePtr c = n->node->children; c; c = c->next) {
        if (c->type != XML_ELEMENT_NODE)
            continue;
        JSValue w = xml_node_new(ctx, n->tree, c, false);

        if (JS_IsException(w)) {
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32(ctx, out, i++, w);
    }
    return out;
}

static bool xml_named(xmlNodePtr node, const char *name)
{
    return node->type == XML_ELEMENT_NODE &&
           strcmp((const char *)node->name, name) == 0;
}

/* Find(name) -- the first direct child element called that, or null. */
static JSValue xml_node_find(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Find(name) expects an element name");

    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;

    for (xmlNodePtr c = n->node->children; c; c = c->next) {
        if (!xml_named(c, name))
            continue;
        JS_FreeCString(ctx, name);
        return xml_node_new(ctx, n->tree, c, false);
    }
    JS_FreeCString(ctx, name);
    return JS_NULL;
}

/* FindAll(name) -- every direct child element called that. */
static JSValue xml_node_find_all(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "FindAll(name) expects an element name");

    const char *name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;

    JSValue  out = JS_NewArray(ctx);
    uint32_t i   = 0;

    for (xmlNodePtr c = n->node->children; c; c = c->next) {
        if (!xml_named(c, name))
            continue;
        JSValue w = xml_node_new(ctx, n->tree, c, false);

        if (JS_IsException(w)) {
            JS_FreeCString(ctx, name);
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32(ctx, out, i++, w);
    }
    JS_FreeCString(ctx, name);
    return out;
}

/* Add(child) -- a node or an element name. */
static JSValue xml_node_add(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Add(child) expects a node or an "
                                      "element name");
    return xml_place_child(ctx, n, -1, argv[0]);
}

/* Insert(index, child) */
static JSValue xml_node_insert(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Insert(index, child) expects the "
                                      "position and the node");

    int32_t index = 0;
    if (JS_ToInt32(ctx, &index, argv[0]))
        return JS_EXCEPTION;
    if (index < 0)
        return JS_ThrowRangeError(ctx, "Insert: %d is not a position", index);
    return xml_place_child(ctx, n, index, argv[1]);
}

/* Remove() -- out of the tree, and the wrapper stops answering. */
static JSValue xml_node_remove(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;

    xmlUnlinkNode(n->node);

    /* A detached tree whose root is the node being removed has no root any
     * more, and saying so is what keeps it from being freed twice -- once from
     * the orphan list and once as the root. */
    if (n->tree->root == n->node)
        n->tree->root = NULL;
    xml_orphan(n->tree, n->node);
    n->node = NULL;
    return JS_UNDEFINED;
}

/* Parent -- null for a root, and for a node whose parent is not an element. */
static JSValue xml_node_get_parent(JSContext *ctx, JSValueConst this_val)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;

    xmlNodePtr p = n->node->parent;
    if (!p || p->type != XML_ELEMENT_NODE)
        return JS_NULL;
    return xml_node_new(ctx, n->tree, p, false);
}

/* Copy() -- a detached subtree of its own. */
static JSValue xml_node_copy(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;

    xmlNodePtr copy = xmlCopyNode(n->node, 1);
    if (!copy)
        return JS_EXCEPTION;
    return xml_node_new(ctx, xml_tree_root(copy), copy, true);
}

/* SetNamespace(uri, [prefix]) */
static JSValue xml_node_set_namespace(JSContext *ctx, JSValueConst this_val,
                                      int argc, JSValueConst *argv)
{
    BtaXmlNode *n = node_this(ctx, this_val);
    if (!n)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "SetNamespace(uri, [prefix]) expects "
                                      "the URI");

    const char *uri    = JS_ToCString(ctx, argv[0]);
    const char *prefix = argc > 1 && JS_IsString(argv[1])
                       ? JS_ToCString(ctx, argv[1]) : NULL;

    if (!uri) {
        if (prefix) JS_FreeCString(ctx, prefix);
        return JS_EXCEPTION;
    }

    /*
     * The element's own declarations first, because `xmlNewNs` refuses a
     * prefix the element already declares -- answering NULL with nothing said.
     * The same URI again is the declaration there is; another URI for a prefix
     * already declared here is refused in words, since rewriting it would move
     * every descendant that uses it along with this element.
     */
    xmlNsPtr ns = NULL;
    for (xmlNsPtr d = n->node->nsDef; d; d = d->next) {
        bool same = prefix ? d->prefix && !strcmp((const char *)d->prefix, prefix)
                           : !d->prefix;
        if (!same)
            continue;
        if (!d->href || strcmp((const char *)d->href, uri)) {
            JSValue e = JS_ThrowTypeError(ctx, "SetNamespace: <%s> already "
                                          "declares %s%s%s as '%s'",
                                          (const char *)n->node->name,
                                          prefix ? "the prefix '" : "the default "
                                                                    "namespace",
                                          prefix ? prefix : "",
                                          prefix ? "'" : "",
                                          d->href ? (const char *)d->href : "");
            JS_FreeCString(ctx, uri);
            if (prefix)
                JS_FreeCString(ctx, prefix);
            return e;
        }
        ns = d;
        break;
    }

    /* Then the one in reach, or it would be written twice.  A detached element
     * has no document and so no ancestors to search, which is why that search
     * is skipped rather than handed a NULL. */
    if (!ns && n->node->doc) {
        ns = xmlSearchNs(n->node->doc, n->node, prefix ? BAD_CAST prefix : NULL);
        if (ns && (!ns->href || strcmp((const char *)ns->href, uri)))
            ns = NULL;
    }
    if (!ns)
        ns = xmlNewNs(n->node, BAD_CAST uri, prefix ? BAD_CAST prefix : NULL);

    JS_FreeCString(ctx, uri);
    if (prefix)
        JS_FreeCString(ctx, prefix);
    if (!ns)
        return JS_ThrowTypeError(ctx, "SetNamespace: libxml2 refused the "
                                      "declaration");

    xmlSetNs(n->node, ns);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry xml_node_props[] = {
    JS_CGETSET_DEF("Name",      xml_node_get_name,      NULL),
    JS_CGETSET_DEF("Prefix",    xml_node_get_prefix,    NULL),
    JS_CGETSET_DEF("Namespace", xml_node_get_namespace, NULL),
    JS_CGETSET_DEF("Text",      xml_node_get_text,      xml_node_set_text),
    JS_CGETSET_DEF("Parent",    xml_node_get_parent,    NULL),
    JS_CGETSET_DEF("Children",  xml_node_children,      NULL),
    JS_CFUNC_DEF("Attr",           1, xml_node_attr),
    JS_CFUNC_DEF("SetAttr",        2, xml_node_set_attr),
    JS_CFUNC_DEF("RemoveAttr",     1, xml_node_remove_attr),
    JS_CFUNC_DEF("AttributeNames", 0, xml_node_attribute_names),
    JS_CFUNC_DEF("Find",           1, xml_node_find),
    JS_CFUNC_DEF("FindAll",        1, xml_node_find_all),
    JS_CFUNC_DEF("Add",            1, xml_node_add),
    JS_CFUNC_DEF("Insert",         2, xml_node_insert),
    JS_CFUNC_DEF("Remove",         0, xml_node_remove),
    JS_CFUNC_DEF("Copy",           0, xml_node_copy),
    JS_CFUNC_DEF("SetNamespace",   2, xml_node_set_namespace),
};

#else  /* no libxml2 at build time */

static JSValue xml_missing(JSContext *ctx, const char *what)
{
    return JS_ThrowInternalError(ctx,
        "this runtime was built without libxml2, so Xml.%s cannot read XML. "
        "Install libxml2's development package and build again -- CMake finds "
        "it with pkg-config and prints which it found", what);
}

static JSValue xml_parse(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    return xml_missing(ctx, "Parse");
}

static JSValue xml_parse_bytes(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return xml_missing(ctx, "ParseBytes");
}

static JSValue xml_stringify(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    return xml_missing(ctx, "Stringify");
}

static JSValue xml_element(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    return xml_missing(ctx, "Element");
}

#endif

/* ------------------------------------------------------------------ global */

void bta_xml_init(JSContext *ctx, JSValue global)
{
#ifdef BTA_HAVE_LIBXML
    JSRuntime *rt = JS_GetRuntime(ctx);

    /*
     * Once, on the thread this is first called from -- which is the main thread,
     * because `install_globals` runs before any `Task` exists. A worker calls
     * this again and it is a no-op there; libxml2 is thread-safe per document
     * once its parser tables are up, and this is what puts them up.
     */
    xmlInitParser();

    JS_NewClassID(rt, &bta_xml_doc_class_id);
    JS_NewClass(rt, bta_xml_doc_class_id, &xml_doc_class);
    JS_NewClassID(rt, &bta_xml_node_class_id);
    JS_NewClass(rt, bta_xml_node_class_id, &xml_node_class);

    JSValue doc_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, doc_proto, xml_doc_props,
                               G_N_ELEMENTS(xml_doc_props));
    JS_SetClassProto(ctx, bta_xml_doc_class_id, doc_proto);

    JSValue node_proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, node_proto, xml_node_props,
                               G_N_ELEMENTS(xml_node_props));
    JS_SetClassProto(ctx, bta_xml_node_class_id, node_proto);
#endif

    JSValue xml = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, xml, "Parse",
                      JS_NewCFunction(ctx, xml_parse, "Parse", 1));
    JS_SetPropertyStr(ctx, xml, "ParseBytes",
                      JS_NewCFunction(ctx, xml_parse_bytes, "ParseBytes", 1));
    JS_SetPropertyStr(ctx, xml, "Stringify",
                      JS_NewCFunction(ctx, xml_stringify, "Stringify", 1));
    JS_SetPropertyStr(ctx, xml, "Element",
                      JS_NewCFunction(ctx, xml_element, "Element", 1));
#ifdef BTA_HAVE_LIBXML
    JS_SetPropertyStr(ctx, xml, "Available", JS_NewBool(ctx, true));
#else
    JS_SetPropertyStr(ctx, xml, "Available", JS_NewBool(ctx, false));
#endif
    JS_SetPropertyStr(ctx, global, "Xml", xml);
}
