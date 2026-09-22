/*
 * RSS and Atom, two shapes and one list.
 *
 * A feed reader is the smallest thing that is *about* XML: the file is not a
 * configuration that could have been JSON, it is somebody else's format, with
 * attributes, two namespaces, CDATA and dates in two different calendars. What
 * this file shows is that a `Record` can say what such a file is without
 * parsing it by hand:
 *
 *   - **attributes** are fields too: `enclosure url=…` is
 *     `Field.Text({ attribute: true })`, and Atom's `<link>` has no text at all
 *     -- `href` and `rel` are the whole element;
 *   - **one shape does not fit two formats**, so there are two: `Rss` and
 *     `Atom`, each with its own `static Xml`, and `readFeed` normalises them
 *     into the one list the window draws;
 *   - `Naming = "lower"` is said **once** per format, because RSS and Atom
 *     spell every element lower-case; `as` is the exception for `pubDate`,
 *     which is the one that is not;
 *   - `LoadXml` does not stop at what the shape does not know. It reports it,
 *     and the window counts it -- a feed written tomorrow must still open
 *     today.
 *
 * ## The four things this file found, which are worth knowing
 *
 *   - **RSS dates are not ISO and Atom's are.** `<pubDate>` is RFC 822
 *     (`Mon, 21 Sep 2026 18:04:00 -0300`) and stays a `Field.Text` because no
 *     date type here would read it as one; Atom's `<updated>` is
 *     `2026-09-21T21:04:00Z`, which is `Field.DateTime` and is kept exactly as
 *     written, zone and all.
 *   - **A record cannot model its own element's text *and* its attributes.**
 *     RSS's `<guid isPermaLink="false">bintana-xml-1</guid>` is that shape:
 *     the value is the element's text and `isPermaLink` an attribute of the
 *     same element. Modelling `Guid` as a scalar reads the text, and the
 *     attribute is reported rather than dropped -- the mapping says what it
 *     could not take instead of pretending.
 *   - **A scalar reads its element's *text*, so markup inside it flattens.**
 *     A `<description>` with real `<p>` elements arrives as the text between
 *     the tags, and `LoadXml` reports `mixed content is read as its text`.
 *     CDATA -- which is what most feeds use -- is not mixed content and reads
 *     as itself, tags and all; `feedText` is what this reader does about it.
 *   - **Matching is by local name, so `<link>` and `<atom:link>` look alike
 *     from here.** RSS feeds announce themselves with an `atom:link` beside
 *     their own `link`; the shape reads the first and the repetition is
 *     reported. Nothing here needs the difference, and a format where it
 *     mattered would need namespaces in the mapping.
 */
"use strict";

/* --- RSS 2.0 -------------------------------------------------------------
 * The elements are lower-case throughout; the one that is not is `pubDate`,
 * and `as` is the word for it.  `rss` itself carries the version as an
 * attribute and the feed as a `channel` child. */
class RssEnclosure extends Record {
    static Naming = "lower";
    static Xml = { Root: "enclosure" };
    static Fields = {
        Url:    Field.Text({ attribute: true }),
        Length: Field.Int({ attribute: true }),
        Type:   Field.Text({ attribute: true }),
    };
}

class RssItem extends Record {
    static Naming = "lower";
    static Xml = { Root: "item" };
    static Fields = {
        Title:       Field.Text(),
        Link:        Field.Text(),
        Guid:        Field.Text(),
        PubDate:     Field.Text({ as: "pubDate" }),
        Description: Field.Text(),
        Enclosure:   Field.Record(RssEnclosure),
    };
}

class RssChannel extends Record {
    static Naming = "lower";
    static Xml = { Root: "channel" };
    static Fields = {
        Title:         Field.Text(),
        Link:          Field.Text(),
        Description:   Field.Text(),
        Language:      Field.Text(),
        LastBuildDate: Field.Text({ as: "lastBuildDate" }),
        Items:         Field.List(RssItem),          // <item> repeated, no wrapper
    };
}

class Rss extends Record {
    static Naming = "lower";
    static Xml = { Root: "rss" };
    static Fields = {
        Version: Field.Text({ attribute: true }),
        Channel: Field.Record(RssChannel),
    };
}

/* --- Atom 1.0 ------------------------------------------------------------
 * One namespace on the root, `<link>` elements that are all attributes, and a
 * list of entries with no wrapper. */
class AtomLink extends Record {
    static Naming = "lower";
    static Xml = { Root: "link" };
    static Fields = {
        Href: Field.Text({ attribute: true }),
        Rel:  Field.Text({ attribute: true }),
        Type: Field.Text({ attribute: true }),
    };
}

class AtomEntry extends Record {
    static Naming = "lower";
    static Xml = { Root: "entry" };
    static Fields = {
        Title:   Field.Text(),
        Id:      Field.Text(),
        Updated: Field.DateTime(),
        Summary: Field.Text(),
        Links:   Field.List(AtomLink),
    };
}

class Atom extends Record {
    static Naming = "lower";
    static Xml = { Root: "feed", Namespace: "http://www.w3.org/2005/Atom" };
    static Fields = {
        Title:    Field.Text(),
        Subtitle: Field.Text(),
        Updated:  Field.DateTime(),
        Links:    Field.List(AtomLink),
        Entries:  Field.List(AtomEntry),
    };
}

/*
 * A file, whichever of the two it is, as one list the window can draw.
 *
 * The root's name is the whole dispatch -- RSS says `<rss>` and Atom says
 * `<feed>` -- and what comes back carries `Problems`: everything either shape
 * could not take, which the window shows rather than hides.
 */
function readFeed(path) {
    const root = File.LoadXml(path).Root;

    if (root.Name === "rss") {
        const rss     = Rss.LoadXml(root);
        const channel = rss.Channel;

        return {
            Title: channel ? channel.Title : "",
            Link:  channel ? channel.Link : "",
            Items: (channel ? channel.Items : []).map((item) => ({
                Title:   item.Title,
                Link:    item.Link,
                Date:    item.PubDate,
                Summary: feedText(item.Description),
            })),
            Problems: rss.Problems,
        };
    }

    if (root.Name === "feed") {
        const feed = Atom.LoadXml(root);

        return {
            Title: feed.Title,
            Link:  feed.Links.length ? feed.Links[0].Href : "",
            Items: feed.Entries.map((entry) => ({
                Title:   entry.Title,
                Link:    ((entry.Links.find((l) => l.Rel === "alternate") ||
                           entry.Links[0]) || {}).Href || "",
                Date:    entry.Updated,
                Summary: feedText(entry.Summary),
            })),
            Problems: feed.Problems,
        };
    }

    throw new TypeError(`<${root.Name}> is neither an RSS nor an Atom feed`);
}

/*
 * The summary as prose, with the parser this program already has.
 *
 * Both spellings arrive here as the text the file carries -- Atom's escapes
 * `&lt;p&gt;`, which the DOM decodes to `<p>`, and RSS's CDATA holds `<p>`
 * literally, which the DOM hands over untouched -- so the markup is still in
 * the string.  **A feed's summary is XML in the common case**, so the child is
 * a parse away: `Xml.Parse("<p>…</p>")` and the root's `Text` is the prose,
 * which flattens `<p>a <b>b</b></p>` exactly the way a scalar field flattens
 * markup inside an element.  Rendering it is a browser's job; returning the
 * child's text is the half a reader is for, and it is the parser's answer
 * rather than a regular expression's guess.
 *
 * What does not parse is not XML -- an HTML fragment with a bare `<br>` --
 * and is shown as it came rather than mangled.
 */
function feedText(markup) {
    const text = String(markup).trim();

    if (!/<[A-Za-z/!]/.test(text)) return text;
    try {
        return Xml.Parse(text).Root.Text.replace(/\s+/g, " ").trim();
    } catch (e) {
        return text;
    }
}
