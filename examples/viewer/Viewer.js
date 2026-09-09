/*
 * An image viewer: a folder on the left, one picture on the right.
 *
 * What it is here to show is `Picture`, and in particular the one thing that is
 * not obvious about it -- **`Fit` and `Zoom` answer two different questions**:
 *
 *   Fit    what to do with the room there is       (a picture on a form)
 *   Zoom   how big to be, whatever the room is     (a picture in a Scroller)
 *
 * A viewer needs the second, because scrolling around a photograph means the
 * picture is bigger than the window. So *fit to window* here is not a mode the
 * widget has: it is a zoom this works out from the room, which is what every
 * image viewer does and the reason `Picture` publishes `SourceWidth`.
 *
 * Run it with no arguments and it shows the folder it ships with; pass a folder
 * on the command line, press the button, or **drop a file or a folder on the
 * window** (`AcceptFiles` in the `.form`, `Form_FileDrop` below), and it shows
 * that one instead.
 */
"use strict";

/* What GdkTexture reads. SVG is not among them -- that is the pixbuf loaders'
 * business, which is how an `Image` draws a scalable icon and a `Picture`
 * does not. */
const SHOWS = ["png", "jpg", "jpeg", "webp", "tiff", "tif", "bmp"];

const ZOOM_STEP = 1.25;
const ZOOM_MIN  = 0.05;
const ZOOM_MAX  = 20;

class Viewer extends Form {

    files = [];
    at    = -1;

    Form_Open() {
        /* Values and not prose: `PropertyOptions` is the runtime's own answer to
         * what `Fit` accepts, so this list cannot drift from what the setter
         * takes -- and putting the words in the .form would have sent them
         * through the catalogue, where a translated "Cover" is a value the
         * runtime refuses. */
        this.CmbFit.Items = this.Shown.PropertyOptions("Fit");
        this.CmbFit.Text  = "Contain";

        this.open(Application.Arguments[0] || File.Join(Application.Directory, "images"));
    }

    /* --- the folder -------------------------------------------------------- */

    open(folder) {
        if (!File.IsDir(folder)) {
            Message.Error("{0} is not a folder.", folder);
            return;
        }
        this.folder = folder;
        /* `Locale.Compare` and not a bare `sort()`: these names go straight into
         * a list somebody reads, and a plain sort files every accented one after
         * Z. See `examples/contacts`. */
        this.files  = Directory.List(folder)
                         .filter((f) => SHOWS.includes(File.Extension(f).toLowerCase()))
                         .sort(Locale.Compare);

        this.Files.Items = this.files;
        this.Text = File.Name(folder);

        if (!this.files.length) {
            this.Shown.File = "";
            this.LblAbout.Text = Locale.Text("No images in {0}", File.Name(folder));
            return;
        }
        this.showAt(0);
    }

    BtnOpen_Click() {
        Dialog.SelectFolder(Locale.Text("Choose a folder of images"),
                            (folder) => this.open(folder));
    }

    /*
     * **A file dropped on the window, which is the gesture people try first.**
     * `AcceptFiles` is on the form itself, in the `.form`, so anywhere in the
     * window takes it -- and dropping a *picture* means its folder, positioned on
     * that picture, because a viewer with one image in it is not a viewer. A
     * folder means itself.
     *
     * Only the first of several is used: dropping a selection of twenty photos
     * onto a viewer means "show me these", and what this shows is a folder, so
     * the honest reading is the folder they are in.
     */
    Form_FileDrop(paths) {
        const first = paths[0];

        if (File.IsDir(first)) {
            this.open(first);
            return;
        }

        this.open(File.Directory(first));

        const at = this.files.indexOf(File.Name(first));
        if (at >= 0) this.showAt(at);
        else this.LblAbout.Text = Locale.Text("{0} is not an image this can show",
                                              File.Name(first));
    }

    /* --- one image --------------------------------------------------------- */

    showAt(index) {
        if (index < 0 || index >= this.files.length) return;

        this.at = index;
        this.Files.Index = index;      /* the list follows, whoever moved */

        try {
            this.Shown.File = File.Join(this.folder, this.files[index]);
        } catch (e) {
            /* A file this cannot read is not a reason to stop: say so, leave the
             * frame empty, and let the next one be chosen. */
            this.Shown.File = "";
            this.LblAbout.Text = e.message;
            return;
        }
        this.fit();
    }

    Files_Select() {
        if (this.Files.Index >= 0 && this.Files.Index !== this.at)
            this.showAt(this.Files.Index);
    }

    BtnPrev_Click() { this.showAt(this.at - 1); }
    BtnNext_Click() { this.showAt(this.at + 1); }

    /* --- fit, which is a zoom ---------------------------------------------- */

    /*
     * Asked again until there is a room to fit into: a window on its way up has
     * no allocation, and a fit worked out then divides by nothing. Inside a
     * `Scroller` a zoom of zero is a picture drawn at nothing at all, so getting
     * this wrong looks like a file that failed to load.
     */
    fit(tries = 25) {
        Timer.After(20, () => {
            const room = this.View.Bounds();
            const w = this.Shown.SourceWidth, h = this.Shown.SourceHeight;

            if (!room.Width || !room.Height || !w || !h) {
                if (tries > 0) this.fit(tries - 1);
                return;
            }
            this.zoomTo(Math.min(room.Width / w, room.Height / h));
        });
    }

    zoomTo(zoom) {
        this.Shown.Zoom = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
        this.retitle();
    }

    retitle() {
        if (!this.Shown.SourceWidth) return;

        this.LblAbout.Text = Locale.Text("{0}  ·  {1} x {2}  ·  {3}%",
                                         this.files[this.at] || "",
                                         this.Shown.SourceWidth,
                                         this.Shown.SourceHeight,
                                         Math.round(this.Shown.Zoom * 100));
    }

    BtnFit_Click() { this.fit(); }
    BtnOne_Click() { this.zoomTo(1); }
    BtnIn_Click()  { this.zoomTo(this.Shown.Zoom * ZOOM_STEP); }
    BtnOut_Click() { this.zoomTo(this.Shown.Zoom / ZOOM_STEP); }

    /*
     * `Fit` matters only while there is no zoom -- with one, the picture is the
     * size the zoom makes it and there is nothing left to fit. So choosing a fit
     * gives the room back its say.
     */
    CmbFit_Select() {
        this.Shown.Zoom = 0;
        this.Shown.Fit  = this.CmbFit.Text;
        this.retitle();
    }

    Form_KeyPress(key) {
        switch (key) {
        case "Left":  case "Up":    this.BtnPrev_Click(); return true;
        case "Right": case "Down":  this.BtnNext_Click(); return true;
        case "plus":  case "equal": this.BtnIn_Click();   return true;
        case "minus":               this.BtnOut_Click();  return true;
        case "0":                   this.BtnOne_Click();  return true;
        case "f":                   this.fit();           return true;
        default: return false;
        }
    }
}
