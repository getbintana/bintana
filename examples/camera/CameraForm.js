/*
 * A camera in a form: choose it, see it, take a photograph, record it with
 * sound -- what Windows.Media.Capture is for, built from the elements API
 * and two pieces of the runtime: `Media.Devices`, which lists the cameras,
 * and `Video.Attach`, which shows a pipeline the program built.
 *
 * ## What to read it for
 *
 *   - **`Media.Devices("Video/Source")`** is the list, each camera once,
 *     named the way the desktop names it. A camera's `Element()` is a source
 *     already pointed at it -- `pipewiresrc` here, `mfvideosrc` on Windows,
 *     `avfvideosrc` on a Mac -- so nothing below names a platform. A machine
 *     with no camera says so, and Photo and Record stay off.
 *   - **`Modes` chooses the size.** A camera lists what it can produce, and
 *     its larger sizes are often JPEG only (raw 1920x1080 at 5 frames a
 *     second is common on a laptop's). `bestCaps` takes the largest that is
 *     no wider than 1280, and a `capsfilter` asks the camera for it; a
 *     `decodebin` after it turns JPEG or raw into frames alike.
 *   - **The preview is a `gtk4paintablesink`, and `Preview.Attach(sink)` puts
 *     its frames in the Video.** The Video does not drive the pipeline: its
 *     state and its errors are the pipeline's `State` and `Bus`.
 *   - **A photograph is `Preview.Save(path)`**: the frame on screen, as a PNG.
 *   - **A recording is the same graph with a `tee`.** One branch is the
 *     preview, the other a `vp8enc` into a WebM file, each after a `queue`
 *     (a tee without them never finishes -- GStreamer's rule). Recording
 *     builds the pipeline again with the second branch rather than adding it
 *     to a running tee, which would need pad probes this surface does not
 *     carry: the preview blinks once at Record and once at Stop.
 *   - **Stop is `Eos()`, and the `eos` on the bus is what says the file is
 *     whole** -- `webmmux` writes its index at the end, exactly as `wavenc`
 *     writes its header in `examples/recorder`.
 *   - the sound is the desk's default microphone (`autoaudiosrc`) through
 *     `opusenc` into the same muxer; *With sound* off leaves that branch out.
 *
 * The first run may answer `NotAuthorized`: a desktop that has not been asked
 * before can refuse the camera, and the refusal arrives on the bus with a
 * sentence beside it.
 *
 * Run it with `./build/bintana examples/camera`.
 */
"use strict";

/* m:ss, and h:mm:ss only once there is an hour to say. */
function clock(seconds) {
    const s  = Math.max(0, Math.round(seconds));
    const h  = Math.floor(s / 3600);
    const mm = h ? String(Math.floor((s % 3600) / 60)).padStart(2, "0")
                 : String(Math.floor(s / 60));

    return `${h ? h + ":" : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

/* The largest mode no wider than 1280, as caps a `capsfilter` takes -- or
 * `null`, which lets the camera choose. Only modes with one width and one
 * height count (a list or a range is a family, not a size), and a raw one
 * only in a format a `videoconvert` reads: `DMA_DRM` is a buffer on the GPU
 * that this graph has nothing to do with. At the same size the faster one
 * wins, which is usually the JPEG. */
function bestCaps(device) {
    const rate = (m) => Array.isArray(m.framerate) ? Math.max(...m.framerate)
                                                   : (m.framerate || 0);
    let best = null;

    for (const m of device.Modes) {
        if (typeof m.width !== "number" || typeof m.height !== "number")
            continue;
        if (m.width > 1280)
            continue;
        if (m.Type === "video/x-raw") {
            if (typeof m.format !== "string" || m.format === "DMA_DRM")
                continue;
        } else if (m.Type !== "image/jpeg") {
            continue;
        }

        const area = m.width * m.height;
        const was  = best ? best.width * best.height : 0;

        if (!best || area > was || (area === was && rate(m) > rate(best)))
            best = m;
    }
    if (!best)
        return null;
    return best.Type === "video/x-raw"
        ? `video/x-raw, format=${best.format}, width=${best.width}, height=${best.height}`
        : `image/jpeg, width=${best.width}, height=${best.height}`;
}

class CameraForm extends Form {

    _devices = [];      /* Media.Devices("Video/Source"), as listed */
    _pipe    = null;    /* the pipeline running now, or null */
    _rec     = null;    /* { path, watch, tick } while recording */
    _dir     = null;    /* where photographs and recordings go */
    _last    = null;    /* the last file written */

    Form_Open() {
        this._dir = this.remembered() || this.picturesFolder();
        if (!Media.Available || !Widget.Available("Video")) {
            this.LblStatus.Text = Locale.Text(
                "This machine cannot show video: GStreamer and its GTK4 sink are needed.");
            this.showButtons();
            return;
        }
        if (this.list())
            this.preview();
        else
            this.showButtons();
    }

    /* ---------------------------------------------------------- the list */

    /* The cameras now, asked once at open: asking takes a probe of the
     * system, tens of milliseconds, and a camera plugged in later is what
     * reopening the form is for. Setting `Index` raises no `Select`, so the
     * caller starts the preview itself -- and answers `false` when there is
     * nothing to start. */
    list() {
        this._devices = Media.Devices("Video/Source");
        this.CmbCamera.Items = this._devices.map((d) => d.Name);
        if (!this._devices.length) {
            this.LblStatus.Text = Locale.Text("No camera found.");
            return false;
        }
        this.CmbCamera.Index = 0;
        return true;
    }

    CmbCamera_Select() {
        if (this._rec)
            return;
        this.preview();
    }

    /* The chosen camera's source, with the caps that pick its size. */
    source(pipe) {
        const device = this._devices[this.CmbCamera.Index];
        const src    = pipe.Add(device.Element());
        const caps   = bestCaps(device);

        if (!caps)
            return src;
        return src.Link(pipe.Add(Media.Element("capsfilter", { caps: caps })));
    }

    /* ------------------------------------------------------ the pipeline */

    /*
     *   source ! decodebin ~ videoconvert ! tee ! queue ! gtk4paintablesink
     *                                           tee ! queue ! videoconvert ! vp8enc ! webmmux ! filesink
     *   autoaudiosrc ! audioconvert ! audioresample ! opusenc ! queue ! webmmux
     *
     * The second line and the third only while recording to `path`. The `~`
     * is `pad-added`: a decoder's output appears once it has seen the stream.
     */
    build(path) {
        const pipe = Media.Element("pipeline", { name: path ? "recording" : "preview" });
        const from = this.source(pipe);
        const dec  = pipe.Add(Media.Element("decodebin"));
        const conv = pipe.Add(Media.Element("videoconvert"));
        const tee  = pipe.Add(Media.Element("tee"));
        const sink = pipe.Add(Media.Element("gtk4paintablesink"));

        from.Link(dec);
        dec.On("pad-added", (pad) => {
            if (pad.Caps.startsWith("video/"))
                pad.Link(conv);
        });
        conv.Link(tee);
        tee.Link(pipe.Add(Media.Element("queue"))).Link(sink);

        if (path) {
            const mux = pipe.Add(Media.Element("webmmux"));

            /* `deadline` 1 is libvpx's real time: the default is "best",
             * which falls behind a camera and stalls the whole graph. */
            tee.Link(pipe.Add(Media.Element("queue")))
               .Link(pipe.Add(Media.Element("videoconvert")))
               .Link(pipe.Add(Media.Element("vp8enc", { deadline: 1 })))
               .Link(mux)
               .Link(pipe.Add(Media.Element("filesink", { location: path })));
            if (this.ChkSound.Active) {
                pipe.Add(Media.Element("autoaudiosrc"))
                    .Link(pipe.Add(Media.Element("audioconvert")))
                    .Link(pipe.Add(Media.Element("audioresample")))
                    .Link(pipe.Add(Media.Element("opusenc")))
                    .Link(pipe.Add(Media.Element("queue")))
                    .Link(mux);
            }
            pipe.Bus.On("eos", () => this.recorded());
        }
        pipe.Bus.On("error", (message, kind) => this.failed(message, kind));

        this.Preview.Attach(sink);
        this._pipe = pipe;
        pipe.State = "Playing";
    }

    /* The one way a pipeline goes: to Null, and forgotten. What it showed
     * stays on screen until the next one has a frame. */
    drop() {
        const pipe = this._pipe;

        this._pipe = null;
        if (pipe)
            pipe.State = "Null";
    }

    preview() {
        this.drop();
        try {
            this.build(null);
            this.LblStatus.Text = this.where();
        } catch (e) {
            /* A missing element (no decodebin, no GTK4 sink) is a throw, and
             * a camera that fails once it runs is an `error` on the bus. */
            this.drop();
            this.LblStatus.Text = e.message;
        }
        this.showButtons();
    }

    failed(message, kind) {
        const recording = this._rec !== null;

        this.drop();
        this.stopClock();
        this.showButtons();
        this.LblStatus.Text = message + (kind ? " (" + kind + ")" : "");
        /* A recording that failed leaves the preview to come back; a preview
         * that failed is left failed, with its reason on screen. */
        if (recording)
            Timer.After(0, () => {
                const said = this.LblStatus.Text;

                this.preview();
                this.LblStatus.Text = said;
            });
    }

    /* -------------------------------------------------------- photograph */

    BtnPhoto_Click() {
        if (!this._pipe || this._rec)
            return;
        if (!this._dir) {
            this.askFolder(() => this.photograph());
            return;
        }
        this.photograph();
    }

    photograph() {
        const path = File.Join(this._dir, this.fileName("Photo", "png"));

        try {
            this.Preview.Save(path);
        } catch (e) {
            this.LblStatus.Text = e.message;     /* no frame yet, or no disk */
            return;
        }
        this.wrote(path);
        this.LblStatus.Text = Locale.Text("Photograph saved.");
    }

    /* --------------------------------------------------------- recording */

    BtnRecord_Click() {
        if (this._rec) {
            this.stop();
            return;
        }
        if (!this._dir) {
            this.askFolder(() => this.record());
            return;
        }
        this.record();
    }

    record() {
        const path = File.Join(this._dir, this.fileName("Video", "webm"));

        this.drop();
        try {
            this.build(path);
        } catch (e) {
            /* No vp8enc, opusenc or webmmux is a throw here: say which, and
             * go back to the preview, which needs none of them. */
            const said = e.message;

            this.preview();
            this.LblStatus.Text = said;
            return;
        }
        this._rec = { path: path, watch: new Stopwatch().Start(),
                      tick: Timer.Every(250, () => this.tick()) };
        this.tick();
        this.showButtons();
    }

    tick() {
        if (this._rec)
            this.LblStatus.Text = Locale.Text("Recording… {0}",
                                              clock(this._rec.watch.Elapsed / 1000));
    }

    /* Not `State = "Null"`: the muxer writes its index when the stream ends,
     * and only `Eos` ends it. `recorded` is the answer. */
    stop() {
        if (!this._pipe)
            return;
        this.BtnRecord.Enabled = false;
        this.LblStatus.Text    = Locale.Text("Finishing…");
        this._pipe.Eos();
    }

    recorded() {
        const path = this._rec ? this._rec.path : null;

        this.stopClock();
        this.preview();
        if (path) {
            this.wrote(path);
            this.LblStatus.Text = Locale.Text("Recording saved.");
        }
    }

    stopClock() {
        if (!this._rec)
            return;
        this._rec.tick.Stop();
        this._rec.watch.Stop();
        this._rec = null;
    }

    /* ----------------------------------------------------------- the files */

    remembered() {
        const dir = Settings.Get("folder", null);
        return dir && File.IsDir(dir) ? dir : null;
    }

    /* ~/Pictures when the desktop has one by that name, and the chooser
     * otherwise -- `examples/recorder`'s bargain, for the same reasons. */
    picturesFolder() {
        const dir = File.Join(Environment.HomeDirectory, "Pictures");
        return File.IsDir(dir) ? dir : null;
    }

    where() {
        return this._dir ? Locale.Text("Saving to {0}", this._dir)
                         : Locale.Text("Photo or Record will ask where to save.");
    }

    askFolder(then) {
        Dialog.SelectFolder(Locale.Text("Where photographs and recordings go"),
                            { Folder: this._dir || Environment.HomeDirectory },
                            (path) => {
                                this._dir = path;
                                Settings.Set("folder", path);
                                this.LblStatus.Text = this.where();
                                if (then)
                                    then();
                            });
    }

    BtnFolder_Click() {
        this.askFolder(null);
    }

    /* A name no later file takes, with the colon spelled out: a Windows disk
     * has no place for it. */
    fileName(what, ext) {
        return `${what} ${Day.Today} ${Time.Now.split(":").join(".")}.${ext}`;
    }

    wrote(path) {
        this._last = path;
        this.BtnLast.Text    = File.Name(path);
        this.BtnLast.Tooltip = path;
        this.showButtons();
    }

    /* The desktop's viewer or player, whichever it has for the kind. */
    BtnLast_Click() {
        if (this._last)
            File.Open(this._last);
    }

    /* ------------------------------------------------------------ the rest */

    /* One place decides what each control can do. */
    showButtons() {
        const live = this._pipe !== null;
        const rec  = this._rec !== null;

        this.BtnPhoto.Enabled  = live && !rec;
        this.BtnRecord.Enabled = live;
        this.BtnRecord.Text    = rec ? Locale.Text("Stop") : Locale.Text("Record");
        this.BtnRecord.Style   = rec ? "destructive-action" : "";
        this.CmbCamera.Enabled = !rec && this._devices.length > 0;
        this.ChkSound.Enabled  = !rec;
        this.BtnFolder.Enabled = !rec;
        this.BtnLast.Enabled   = !rec && this._last !== null;
    }

    Form_Close() {
        /* Closing mid-recording still asks the muxer to finish; what it
         * cannot promise is that the process outlives the answer. */
        if (this._rec && this._pipe)
            this._pipe.Eos();
        else
            this.drop();
    }
}
