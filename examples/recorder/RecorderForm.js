/*
 * The microphone to a WAV -- and back again -- with the elements API and
 * nothing else: elements built by name, a chain of `Link`s, bus
 * subscriptions, and `Eos` where a writer is involved.
 *
 * ## What to read it for
 *
 *   - **`Eos()` and not `State = "Null"`.** A pipeline torn down without the
 *     end-of-stream event leaves `wavenc`'s header holding its placeholder
 *     sizes -- measured, ~2 GiB in a 300 kB file: every reader that trusts the
 *     header is told the wrong thing. `Stop` asks the graph to finish, and the
 *     `eos` handler is where the program learns it did. The same header is why
 *     the line under the file name is exact and not a guess: after `Eos`,
 *     `fmt ` carries the byte rate and `data` the count, and the seconds are
 *     arithmetic on the file itself.
 *   - the handler holds nothing the element does not need: `finished` releases
 *     the pipeline, and a subscription (`On`) is what kept the graph's own
 *     object alive for as long as the stream ran -- a documented rule, not an
 *     accident of the locals here.
 *   - `autoaudiosrc` is the desk's default microphone and `autoaudiosink` its
 *     default speaker; `pulsesrc` (or `pipewiresrc`) with `Set("device", …)`
 *     is how a program picks one. The file name is the second graph's button:
 *     four lines of `filesrc ! wavparse ! audioconvert ! autoaudiosink`, the
 *     same shape read the other way. It is a `Button` wearing the theme's
 *     `link` class -- a `LinkButton` would hand the file to the desktop
 *     instead of playing it here, and a `Label` cannot be pressed.
 *   - **where a recording goes is decided once and shown.** `~/Music` when the
 *     desktop has one under that name; the real answer lives in its
 *     `user-dirs.dirs`, which nothing here reads, so a desktop that localised
 *     the name gets the chooser instead -- one dialog, once, and `Settings`
 *     keeps the answer for the next run. *Folder…* asks again at any time,
 *     and the same chooser answers a Record with nowhere to put the file.
 *   - the meter is the `level` element talking: it passes the audio through
 *     untouched and posts an `element` message per interval -- `rms`, `peak`
 *     and `decay` in dB, one number per channel -- and
 *     `Bus.On("element", …)` is where that lands. The bar is arithmetic on
 *     `peak`, -60 dB at its left edge, and it disappears with the recording.
 *   - the name carries the date and the second it started, because `filesink`
 *     quietly writes over whatever is at a path and today's first recording
 *     should not be its last.
 *   - the clock during a recording is a `Stopwatch`, not a count of ticks:
 *     the timer says *when* to repaint and the watch says how long it has
 *     been running -- the pair `examples/stopwatch` argues for.
 *
 * The first run usually *errors*, and that is the example working: a desktop
 * that has not been asked before refuses the microphone, and the refusal
 * arrives as `kind` `"NotAuthorized"` with a sentence beside it.
 *
 * Run it with `./build/bintana examples/recorder`.
 */
"use strict";

/* kB and not KiB, as the desktop's own file manager says it. */
function size(n) {
    if (!(n > 0)) return "0 B";

    const units = ["B", "kB", "MB", "GB", "TB"];
    let   v = n, at = 0;

    while (v >= 1000 && at < units.length - 1) {
        v /= 1000;
        at++;
    }
    return at === 0 ? `${v} B` : `${Locale.Number(v, 1)} ${units[at]}`;
}

/* m:ss, and h:mm:ss only once there is an hour to say. */
function clock(seconds) {
    const s  = Math.max(0, Math.round(seconds));
    const h  = Math.floor(s / 3600);
    const mm = h ? String(Math.floor((s % 3600) / 60)).padStart(2, "0")
                 : String(Math.floor(s / 60));

    return `${h ? h + ":" : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

/* The seconds inside the WAV `wavenc` just wrote: RIFF's own arithmetic --
 * the byte rate out of `fmt `, the bytes out of `data`, one division. It is
 * exact because `Eos` was what made the header true; before that the two
 * sizes are placeholders and this would be answered something enormous.
 *
 * The whole file goes through memory to read four numbers off its top, which
 * a recording can afford and an hour of audio could not; a program that
 * minded would want a prefix of a file, and `File.LoadBytes` is what the
 * runtime answers with today. */
function wavSeconds(path) {
    const b   = File.LoadBytes(path);
    const u32 = (at) => b.At(at) + b.At(at + 1) * 256 +
                        b.At(at + 2) * 65536 + b.At(at + 3) * 16777216;
    let rate = 0, bytes = 0;

    /* Chunk by chunk from the top: an id, its size, the payload, and a pad
     * byte when the size is odd. */
    for (let at = 12; at + 8 <= b.Length; ) {
        const chunk = u32(at + 4);

        if (at + 20 <= b.Length && b.Slice(at, 4).ToText() === "fmt ")
            rate = u32(at + 16);            /* ByteRate: bytes a second */
        else if (b.Slice(at, 4).ToText() === "data")
            bytes = chunk;

        at += 8 + chunk + (chunk & 1);
    }
    return rate > 0 ? bytes / rate : 0;
}

class RecorderForm extends Form {

    _rec   = null;      /* the recording pipeline, or null */
    _play  = null;      /* the playback pipeline, or null */
    _tick  = null;      /* the timer repainting while it records */
    _watch = null;      /* and the watch the seconds come from */
    _path  = null;      /* the last file saved, or null */
    _dir   = null;      /* where the next recording goes, or null */

    Form_Open() {
        this._dir = this.remembered() || this.musicFolder();
        this.showWhere();
    }

    /* What the chooser answered in an earlier run, while it is still there:
     * one dialog, once. A folder moved or unmounted since reads as never
     * chosen, and Record asks again -- which is the right failure. */
    remembered() {
        const dir = Settings.Get("folder", null);
        return dir && File.IsDir(dir) ? dir : null;
    }

    /* ~/Music when the desktop has one by that name. Its own answer is in
     * `~/.config/user-dirs.dirs` and nothing here reads it, so a desktop
     * that calls the folder something else gets the chooser instead -- the
     * right failure, and `remembered` has it from then on. */
    musicFolder() {
        const music = File.Join(Environment.HomeDirectory, "Music");
        return File.IsDir(music) ? music : null;
    }

    showWhere() {
        this.LblWhere.Text = this._dir
            ? Locale.Text("Saving to {0}", this._dir)
            : Locale.Text("No Music folder: Record will ask where to save.");
    }

    /* The chooser, once for both roads into it: Record with nowhere to put
     * the file, and *Folder…* whenever the answer should change. What comes
     * back is kept for the next run; cancelling calls nothing, which is how
     * everything stays as it was. */
    askFolder(then) {
        Dialog.SelectFolder(Locale.Text("Where the recordings go"),
                            { Folder: this._dir || Environment.HomeDirectory },
                            (path) => {
                                this._dir = path;
                                Settings.Set("folder", path);
                                this.showWhere();
                                if (then)
                                    then();
                            });
    }

    BtnFolder_Click() {
        this.askFolder(null);
    }

    BtnRecord_Click() {
        if (this._rec || this._play)
            return;
        if (!this._dir) {
            this.askFolder(() => this.start());    /* async: it answers later */
            return;
        }
        this.start();
    }

    /* ------------------------------------------------------------ recording */

    start() {
        const path = File.Join(this._dir, this.fileName());
        const pipe = Media.Element("pipeline", { name: "recorder" });
        const src  = pipe.Add(Media.Element("autoaudiosrc"));
        const conv = pipe.Add(Media.Element("audioconvert"));
        const lvl  = pipe.Add(Media.Element("level", { "post-messages": true }));
        const enc  = pipe.Add(Media.Element("wavenc"));
        const sink = pipe.Add(Media.Element("filesink", { location: path }));

        src.Link(conv).Link(lvl).Link(enc).Link(sink);
        pipe.Bus.On("error", (message, kind) => this.failed(message, kind));
        pipe.Bus.On("eos", () => this.finished(path));
        pipe.Bus.On("element", (name, fields) => this.level(name, fields));

        this._rec   = pipe;
        this._watch = new Stopwatch().Start();
        this._tick  = Timer.Every(200, () => this.tick());
        this.showButtons();
        this.tick();
        pipe.State = "Playing";
    }

    /* The meter, from the `level` element's own bus message: `peak` is the
     * loudest sample of the last interval, in dB, one number per channel. A
     * one-bar meter shows the loudest channel; the arithmetic maps the bar's
     * range, -60 dB to 0, and `ProgressBar` clamps what `peak` overshoots. */
    level(name, fields) {
        if (name !== "level" || !this._rec)
            return;

        const peak = Math.max(...fields.peak);

        this.Meter.Value = (peak + 60) / 60 * 100;
    }

    /* A name no later recording takes -- `recording.wav` would be written
     * over in silence -- with the colon spelled out, a Windows disk having
     * no place for it. */
    fileName() {
        return `Recording ${Day.Today} ${Time.Now.split(":").join(".")}.wav`;
    }

    /* How long it has been recording, from the clock and not from the count
     * of ticks: a timer asked for 200 ms fires a little late every time. */
    tick() {
        this.LblStatus.Text =
            Locale.Text("Recording… {0}", clock(this._watch.Elapsed / 1000));
    }

    BtnStop_Click() {
        if (this._rec) {
            this.BtnStop.Enabled = false;
            this.LblStatus.Text  = Locale.Text("Finishing…");
            this._rec.Eos();
            return;
        }
        if (this._play)
            this.stopPlayback();
    }

    finished(path) {
        const pipe = this._rec;

        this._rec = null;
        if (pipe)
            pipe.State = "Null";
        this.stopClock();
        this.Meter.Value = 0;
        this._path = path;
        this.showButtons();
        this.showFile();
        this.LblStatus.Text = Locale.Text("Saved.");
    }

    failed(message, kind) {
        const pipe = this._rec;

        this._rec = null;
        if (pipe)
            pipe.State = "Null";
        this.stopClock();
        this.Meter.Value = 0;
        this.showButtons();
        this.LblStatus.Text = message + (kind ? " (" + kind + ")" : "");
    }

    /* The timer repaints, the watch is what is read: stopping either without
     * the other would leave a clock running on nothing. */
    stopClock() {
        if (this._tick)  { this._tick.Stop();  this._tick = null; }
        if (this._watch) { this._watch.Stop(); this._watch = null; }
    }

    /* ------------------------------------------------------------- playback */

    BtnPlay_Click() {
        if (!this._path || this._play || this._rec)
            return;

        const pipe = Media.Element("pipeline", { name: "player" });
        const src  = pipe.Add(Media.Element("filesrc", { location: this._path }));
        const par  = pipe.Add(Media.Element("wavparse"));
        const conv = pipe.Add(Media.Element("audioconvert"));
        const sink = pipe.Add(Media.Element("autoaudiosink"));

        src.Link(par).Link(conv).Link(sink);
        pipe.Bus.On("error", (message, kind) => this.playFailed(message, kind));
        pipe.Bus.On("eos", () => this.stopPlayback());

        this._play = pipe;
        this.showButtons();
        this.LblStatus.Text = Locale.Text("Playing…");
        pipe.State = "Playing";
    }

    /* A player needs no `Eos`: nothing is writing, so there is no header left
     * half true, and dropping it is the whole of stopping one. */
    stopPlayback() {
        const pipe = this._play;

        this._play = null;
        if (pipe)
            pipe.State = "Null";
        this.showButtons();
        this.LblStatus.Text = Locale.Text("Ready.");
    }

    playFailed(message, kind) {
        this.stopPlayback();
        this.LblStatus.Text = message + (kind ? " (" + kind + ")" : "");
    }

    /* ------------------------------------------------------------- the file */

    /* What came out of the recording: the name to press, and how long it runs
     * and how big it is, read back off the file `Eos` flushed. */
    showFile() {
        if (!this._path)
            return;

        const info = File.Info(this._path);

        this.BtnPlay.Text    = File.Name(this._path);
        this.BtnPlay.Tooltip = this._path;
        this.LblInfo.Text    = `${clock(wavSeconds(this._path))} · ${size(info.Size)}`;
    }

    /* One place decides what each button can do: four handlers and the two
     * asynchronous answers all move the same three answers, and the meter
     * lives exactly as long as the recording does. */
    showButtons() {
        const busy = this._rec !== null || this._play !== null;

        this.BtnRecord.Enabled = !busy;
        this.BtnStop.Enabled   = busy;
        this.BtnFolder.Enabled = !busy;
        this.BtnPlay.Enabled   = !busy && this._path !== null;
        this.Meter.Visible     = this._rec !== null;
    }

    Form_Close() {
        /* Closing mid-recording still asks the writer to flush; what it
         * cannot promise is that the process outlives the answer. A player
         * has nothing to flush and is simply dropped. */
        if (this._rec)
            this._rec.Eos();
        if (this._play)
            this._play.State = "Null";
    }
}
