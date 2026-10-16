/*
 * The microphone to a WAV, with the elements API and nothing else: five
 * elements built by name, a chain of `Link`s, one property, two bus
 * subscriptions -- and `Eos` to stop.
 *
 * ## What to read it for
 *
 *   - **`Eos()` and not `State = "Null"`.** A pipeline torn down without the
 *     end-of-stream event leaves `wavenc`'s header holding its placeholder
 *     sizes -- measured, ~2 GiB in a 300 kB file: every reader that trusts the
 *     header is told the wrong thing. `Stop` asks the graph to finish, and the
 *     `eos` handler is where the program learns it did.
 *   - the handler holds nothing the element does not need: `finished` releases
 *     the pipeline, and a subscription (`On`) is what kept the graph's own
 *     object alive for as long as the stream ran -- a documented rule, not an
 *     accident of the locals here.
 *   - `autoaudiosrc` is the desk's default microphone; `pulsesrc` (or
 *     `pipewiresrc`) with `Set("device", …)` is how a program picks one.
 *   - the first run usually *errors*, and that is the example working: a
 *     desktop that has not been asked before refuses the microphone, and the
 *     refusal arrives as `kind` `"NotAuthorized"` with a sentence beside it.
 *
 * Run it with `./build/bintana examples/recorder`.
 */
"use strict";

class RecorderForm extends Form {
    Form_Open() {
        this._pipe = null;
        this._path = File.Join(Application.Directory, "recording.wav");
        this.LblPath.Text = this._path;
    }

    BtnRecord_Click() {
        if (this._pipe)
            return;

        const pipe = Media.Element("pipeline", { name: "recorder" });
        const src  = pipe.Add(Media.Element("autoaudiosrc"));
        const conv = pipe.Add(Media.Element("audioconvert"));
        const enc  = pipe.Add(Media.Element("wavenc"));
        const sink = pipe.Add(Media.Element("filesink", { location: this._path }));

        src.Link(conv).Link(enc).Link(sink);
        pipe.Bus.On("error", (message, kind) => this.failed(message, kind));
        pipe.Bus.On("eos", () => this.finished());

        this._pipe = pipe;
        pipe.State = "Playing";
        this.BtnRecord.Enabled = false;
        this.BtnStop.Enabled   = true;
        this.LblStatus.Text    = "Recording…";
    }

    BtnStop_Click() {
        if (!this._pipe)
            return;
        this.BtnStop.Enabled = false;
        this.LblStatus.Text  = "Finishing…";
        this._pipe.Eos();
    }

    Form_Close() {
        /* Closing mid-recording still asks the writer to flush; what it
         * cannot promise is that the process outlives the answer. */
        if (this._pipe)
            this._pipe.Eos();
    }

    failed(message, kind) {
        const pipe = this._pipe;

        this._pipe = null;
        if (pipe)
            pipe.State = "Null";
        this.BtnRecord.Enabled = true;
        this.BtnStop.Enabled   = false;
        this.LblStatus.Text    = message + (kind ? " (" + kind + ")" : "");
    }

    finished() {
        const pipe = this._pipe;

        this._pipe = null;
        if (pipe)
            pipe.State = "Null";
        this.BtnRecord.Enabled = true;
        this.BtnStop.Enabled   = false;
        this.LblStatus.Text    = "Saved " + File.Name(this._path);
    }
}
