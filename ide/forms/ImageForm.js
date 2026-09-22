/*
 * The project's images, shown.
 *
 * A `.png` in the tree used not to be in the tree at all: the IDE lists what it
 * can *open*, and an image is not something one edits here. But a project has
 * images -- the icons it ships, the picture on its about box -- and "the IDE
 * cannot show you your own file" is a worse answer than a window that shows it.
 *
 * Modal, and that is the decision rather than the default: a viewer one can
 * leave open behind the designer is a second thing to keep track of for a
 * gesture that is *look at this and go back*. The catalogue editor is the
 * opposite case and is not modal -- one edits in it for an hour.
 *
 * It is a Bintana form like every other dialog here, and what it shows is a
 * `Picture` in a `Scroller`: the runtime's own control, in the IDE, doing what
 * an application would do with it.
 */
"use strict";

/* The viewers that are up, so the same file is not shown twice and the driver
 * can reach the one on screen.  The runtime holds a shown form alive on its
 * own, so this is a registry and not a workaround for the collector. */
const openImages = [];

/* What `Zoom` does per press. A quarter is small enough to aim with and large
 * enough to be worth a press. */
const ZOOM_STEP = 1.25;
const ZOOM_MIN  = 0.05;
const ZOOM_MAX  = 20;

/* Which files this can show. `GdkTexture` reads these; **SVG is not among
 * them** -- that is the pixbuf loaders' business, which is how `Image` draws
 * scalable icons and a `Picture` does not. A project's `icons/` therefore stays
 * out of the tree rather than offering a viewer that would fail on every file
 * in it. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "tiff", "tif", "bmp"];

function isImageFile(name) {
    return IMAGE_EXTS.includes(File.Extension(name || "").toLowerCase());
}

class ImageForm extends Form {

    /* ImageForm.show(ide, "art/logo.png") */
    static show(ide, file) {
        const already = openImages.find((w) => w.file === file);
        if (already) {
            already.Show();
            return already;
        }

        const dlg = new ImageForm();
        dlg.ide   = ide;
        dlg.file  = file;
        dlg.Modal = true;
        dlg.Text  = file;

        try {
            dlg.Shown.File = File.Join(ide.project, file);
        } catch (e) {
            /* A file the tree lists and GdkTexture will not read: said once,
             * rather than opening a window with an empty frame in it. */
            Message.Error("Cannot show {0}:\n{1}", file, e.message);
            return null;
        }

        openImages.push(dlg);
        dlg.Show();
        dlg.fit();
        return dlg;
    }

    /* The one that is up, or null -- what a driver asks, and what keeps a second
     * viewer for the same file from being opened. */
    static get open() { return openImages.length ? openImages[openImages.length - 1] : null; }

    Form_Close() {
        const at = openImages.indexOf(this);
        if (at >= 0) openImages.splice(at, 1);
    }

    BtnClose_Click() { this.Close(); }

    /*
     * **Fit is a zoom worked out from the room**, which is what every image
     * viewer does and the reason `Picture` publishes `SourceWidth`: inside a
     * `Scroller` the picture is the size its zoom makes it, so "fit" is not a
     * mode the widget has -- it is a number this works out and sets.
     *
     * **And the room is waited for, not timed.** A window on its way up has no
     * allocation, and a fit computed then divides by nothing and leaves the
     * zoom at zero -- which inside a `Scroller` is a picture drawn at nothing
     * at all, an empty window that looks like a file that failed to load.
     * `Allocated` is the frame GTK gives the view a rectangle, where this used
     * to be a bounded retry that could give up before the window was up. The
     * image's own size is `Picture`'s to report and may not have decoded yet,
     * so that half still asks again.
     */
    fit(tries = 25) {
        const room = this.View.Bounds();
        if (room.Width && room.Height) {
            this.fitImage(tries);
            return;
        }
        this.View.On("Allocated", () => this.fitImage(tries));
    }

    fitImage(tries) {
        const room = this.View.Bounds();
        const w = this.Shown.SourceWidth, h = this.Shown.SourceHeight;

        if (!w || !h) {
            if (tries > 0) Timer.After(20, () => this.fitImage(tries - 1));
            return;
        }
        this.zoomTo(Math.min(room.Width / w, room.Height / h));
    }

    zoomTo(zoom) {
        this.Shown.Zoom = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
        this.retitle();
    }

    /* What it is and how it is being shown, which is the whole of what a viewer
     * has to say. */
    retitle() {
        const pct = Math.round(this.Shown.Zoom * 100);
        this.LblAbout.Text = Locale.Text("{0} x {1}  ·  {2}%",
                                         this.Shown.SourceWidth,
                                         this.Shown.SourceHeight, pct);
    }

    BtnFit_Click() { this.fit(); }
    BtnOne_Click() { this.zoomTo(1); }
    BtnIn_Click()  { this.zoomTo(this.Shown.Zoom * ZOOM_STEP); }
    BtnOut_Click() { this.zoomTo(this.Shown.Zoom / ZOOM_STEP); }

    /* The keys a viewer has: +/- zoom, 0 is one to one, F fits. */
    Form_KeyPress(key, ctrl) {
        switch (key) {
        case "plus": case "equal": case "KP_Add":      this.BtnIn_Click();  return true;
        case "minus": case "KP_Subtract":              this.BtnOut_Click(); return true;
        case "0": case "KP_0":                         this.BtnOne_Click(); return true;
        case "f": case "F":                            this.fit();          return true;
        default: return false;
        }
    }
}
