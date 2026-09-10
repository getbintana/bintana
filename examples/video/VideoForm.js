/*
 * Video and AudioPlayer, against lorem.video (https://lorem.video -- free
 * placeholder clips, no key): picking a clip, transport buttons, volume,
 * loop, a live HLS stream, and an audio-only cue through AudioPlayer.
 *
 * The clips are URL values, so they are filled from code: an `Items` written
 * in the `.form` would go through the catalogue, and a translated URL is one
 * the server does not know -- the same reason the IDE fills `PropertyOptions`
 * lists and the jokes example fills its categories from code.
 *
 * What has no event is polled: a `Timer` reads `Position`/`Duration` and
 * `Buffering` four times a second, which is how the position line stays
 * current and how the bar beside it appears while a stream is refilling. A
 * live HLS stream answers `Duration -1`, which is what the line says ("live")
 * rather than a number. Failures arrive as `Vid_Error` -- no network, a host that
 * refuses, a URL the service rejects -- and land in the status line, which is
 * what makes this example runnable offline: it opens, it says why, and
 * nothing throws out of a handler.
 *
 * The cue is kept in `_cue` to be able to *stop* it, not to keep it alive: a
 * player holds itself up while it plays, so a cue nobody keeps is still heard
 * to its end. What a closing form has to do is stop it, which is why
 * `Form_Close` does.
 *
 * Run it with `./build/bintana examples/video`.
 */
"use strict";

const CLIPS = [
    ["Bunny (10 s)",  "https://lorem.video/480p_h264_10s"],
    ["Cat (10 s)",    "https://lorem.video/cat_480p_h264_10s"],
    ["Corgi (10 s)",  "https://lorem.video/corgi_480p_h264_10s"],
    ["Test (10 s)",   "https://lorem.video/test_480p_h264_10s"],
    ["Bunny, live",   "https://lorem.video/hls/bunny"],
];
const CUE = "https://lorem.video/bunny_novideo_10s.mp4";

class VideoForm extends Form {
    Form_Open() {
        for (const [label] of CLIPS) this.CmbClips.Add(label);
        this.CmbClips.Index = 0;

        this._cue   = null;
        this._clock = Timer.Every(250, () => this.tick());
        this.playSelected();
    }

    Form_Close() {
        if (this._clock) this._clock.Stop();
        this.Vid.Stop();
        /* Forgotten, not just stopped: a cue ending after this touches a
         * control on a closed form, which is the crash. */
        if (this._cue) {
            this._cue.Stop();
            this._cue = null;
        }
    }

    playSelected() {
        const i = this.CmbClips.Index;
        if (i < 0) return;

        this.Vid.Uri = CLIPS[i][1];
        this.LblStatus.Text = `Loading ${CLIPS[i][0]}…`;
        try {
            this.Vid.Play();
        } catch (e) {
            this.LblStatus.Text = e.message;
        }
    }

    tick() {
        const pos = this.Vid.Position.toFixed(1);
        const dur = this.Vid.Duration;

        this.LblPos.Text = dur < 0 ? `${pos} / live` : `${pos} / ${dur.toFixed(1)}`;

        /*
         * Buffering is polled like the position, and for the same reason: it
         * changes per cent and has no event. `100` means there is nothing to
         * wait for, so the bar is only there while there is -- a clip over
         * HTTP that has run its queue dry holds the frame it had, and this is
         * the only thing that says why the picture stopped.
         *
         * `Buffering` is `0`…`100`, which is `ProgressBar.Value`'s own range.
         */
        const buffered = this.Vid.Buffering;

        this.PrgBuf.Visible = buffered < 100;
        if (buffered < 100) {
            this.PrgBuf.Value = buffered;
            this.PrgBuf.Text  = `Buffering ${buffered}%`;
        }
    }

    CmbClips_Select() {
        this.playSelected();
    }

    BtnPlay_Click() {
        try {
            this.Vid.Play();
        } catch (e) {
            this.LblStatus.Text = e.message;
        }
    }

    BtnPause_Click() {
        this.Vid.Pause();
    }

    BtnStop_Click() {
        /* The bar is the tick's business and nobody else's: Stop drops the
         * buffer with the state, so `Buffering` reads 100 again and the next
         * tick hides it. */
        this.Vid.Stop();
        this.LblStatus.Text = "Stopped.";
    }

    ChkLoop_Click() {
        this.Vid.Loop = this.ChkLoop.Active;
    }

    ChkMuted_Click() {
        this.Vid.Muted = this.ChkMuted.Active;
    }

    SldVol_Change() {
        /* The .form's own Value fires this while the form is still loading,
         * and this.SldVol does not exist yet -- every control does it. */
        if (!this.SldVol) return;
        this.Vid.Volume = this.SldVol.Value / 100;
    }

    BtnAudio_Click() {
        if (this._cue) this._cue.Stop();

        const cue = new AudioPlayer();
        cue.Uri = CUE;
        cue.OnEnded = () => { this.LblStatus.Text = "Cue finished."; };
        cue.OnError = (msg, kind) => { this.LblStatus.Text = `Cue (${kind}): ${msg}`; };
        this._cue = cue;
        try {
            cue.Play();
            this.LblStatus.Text = "Playing audio cue…";
        } catch (e) {
            this.LblStatus.Text = e.message;
        }
    }

    Vid_Ended() {
        this.LblStatus.Text = "Finished — replaying needs only Play.";
    }

    /* `kind` is what a program can branch on -- `NotAuthorized` is a password
     * to ask for, `Unreachable` is a camera to retry -- while the message is
     * the sentence to show. Here the line shows both. */
    Vid_Error(msg, kind) {
        this.LblStatus.Text = `${kind}: ${msg}`;
    }
}
