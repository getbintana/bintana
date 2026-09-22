/*
 * A window over RSS and Atom.
 *
 * The shapes are in [`Feed.js`](Feed.js) -- two of them, one per format, both
 * over the same XML -- and this file is only the reader: a list of items on the
 * left, the selected one's summary on the right, and the date and the link
 * under it. Start it and it opens one of the two feeds it ships with;
 * **Open…**, a file dropped on the window, or a path on the command line takes
 * the other one -- or any `.xml` feed.
 *
 * ## What is worth reading here
 *
 *   - **the list is a `RowList` whose rows are a component**, so the row is
 *     drawn rather than assembled: `FeedItem.form` is the row, `new FeedItem()`
 *     is what the program builds, and the two cannot drift.
 *   - **`load` is the whole of the program**: read, fill, select the first
 *     item. What a feed *is* was answered once, in the declaration, and this
 *     file never looks at an element.
 *   - **the status line counts what the shape could not take.** `LoadXml` is
 *     lenient -- a feed written tomorrow has to open today -- and the count is
 *     there rather than hidden: the tooltip has the sentences. A reader that
 *     showed a feed with half its fields quietly missing would be lying about
 *     having read it.
 *   - **the date is shown as the file wrote it.** RSS's is RFC 822 and Atom's
 *     is ISO: they are different calendars and one of them is not ISO at all,
 *     so nothing here reformats them. Turning either into the desktop's date
 *     would need a parse per format, and the reader does not need it.
 */
"use strict";

class Feeds extends Form {

    /* One entry per row, in row order: `List_Select` gives a row index, and a
     * row of two labels says nothing about which item it draws. */
    items = [];
    problems = [];

    Form_Open() {
        const given = Application.Arguments[0];
        const first = given && File.Exists(given)
                    ? given
                    : Directory.Files(File.Join(Application.Directory, "samples"),
                                      "*.xml")[0];

        if (first) this.load(first);
    }

    load(path) {
        let feed;

        try {
            feed = readFeed(path);
        } catch (e) {
            Message.Error("Cannot read {0}: {1}", path, e.message);
            return;
        }

        this.items    = feed.Items;
        this.problems = feed.Problems;

        this.LblFeed.Text = feed.Title || File.Name(path);
        this.List.Clear();
        for (const item of this.items) this.List.Add(this.row(item));
        this.List.Index = this.items.length ? 0 : -1;
        this.showSelected();
        this.showStatus();
    }

    row(item) {
        const row = new FeedItem();

        row.Title = item.Title;
        row.When  = item.Date;
        return row;
    }

    List_Select() {
        this.showSelected();
    }

    showSelected() {
        const at   = this.List.Index;
        const item = at < 0 || at >= this.items.length ? null : this.items[at];
        const link = item && item.Link ? item.Link : "";

        this.Summary.Text = item ? item.Summary : "";
        this.LblWhen.Text = item ? item.Date : "";
        this.LnkItem.Text = link;
        this.LnkItem.Uri  = link;
    }

    showStatus() {
        let text = Locale.Plural("{0} item", "{0} items", this.items.length);

        if (this.problems.length)
            text += " · " +
                Locale.Text("{0} things the shape does not model",
                            this.problems.length);

        this.LblStatus.Text    = text;
        this.LblStatus.Tooltip = this.problems.slice(0, 20).join("\n");
    }

    BtnOpen_Click() {
        Dialog.OpenFile(Locale.Text("Open a feed"),
            { Folder: Application.Directory,
              Filters: [[Locale.Text("Feeds"), "*.xml *.rss *.atom"],
                        [Locale.Text("All files"), "*"]] },
            (path) => this.load(path));
    }

    /* A feed dragged from the file manager.  `AcceptFiles` is in the `.form`;
     * what arrives is full paths, and only those that have one. */
    Form_FileDrop(paths) {
        if (paths.length) this.load(paths[0]);
    }
}
