/*
 * A Pomodoro timer whose window is only its settings.
 *
 * Press Start and the window goes to the tray; from then on the program talks
 * through a notification at each change of phase, and the tray's tooltip says
 * how long is left. Click the icon to get the window back, or use its menu.
 *
 * What is worth reading in it:
 *
 *   - **The window is put away, not closed.** `HideOnClose` in the `.form`
 *     means the close button hides the window instead of taking it apart, so
 *     `Show` brings the same one back. A visible `Tray` also holds the
 *     application alive, which is what lets a program with no window run.
 *   - **The clock is a `Stopwatch`, the tick only repaints** -- the same
 *     separation as `examples/stopwatch`. A timer asked for a second fires a
 *     little late every time; counting ticks would make every phase longer.
 *   - **The tray menu is data**: `OnMenu` is handed the `Action` of the item.
 *   - **Without a tray there is no way back**, so when `Tray.Available` is
 *     false (GNOME without the AppIndicator extension) the window is minimised
 *     instead of hidden.
 *
 * Run it with `./build/bintana examples/pomodoro`.
 */
"use strict";

/* How often the tooltip is refreshed, in milliseconds -- not how time is read. */
const REPAINT = 1000;

/* The long break comes after this many work phases. */
const ROUNDS = 4;

class PomodoroForm extends Form {

    phase   = "Stopped";     /* "Stopped", "Work", "Break" or "Long break" */
    round   = 0;             /* work phases finished in this set */
    length  = 0;             /* the phase's length, ms */
    paused  = false;
    watch   = new Stopwatch();
    ticker  = null;
    tray    = null;

    Form_Open() {
        this.tray = new Tray();
        this.tray.Icon = "alarm-symbolic";
        this.tray.Tooltip = Locale.Text("Pomodoro");
        this.tray.OnClick = () => this.showWindow();
        this.tray.OnMenu = (action) => this.menu(action);
        this.setMenu();
        Notification.OnActivate = () => this.showWindow();
    }

    Form_Close() {
        /* HideOnClose puts the window away, and the program goes on in the
         * tray while a phase is running. Closing while stopped would leave an
         * icon with nothing to do, so it ends the program instead -- on the
         * next turn, never inside the close that brought us here. */
        if (this.phase === "Stopped")
            Timer.After(0, () => Application.Quit());
    }

    BtnStart_Click() {
        if (this.phase === "Stopped") this.begin();
        else this.stop();
    }

    /* ---- the cycle ------------------------------------------------- */

    begin() {
        this.round = 0;
        this.enter("Work");
        this.BtnStart.Text = Locale.Text("Stop");
        this.BtnStart.Style = "destructive-action";
        for (const s of [this.SpnWork, this.SpnBreak, this.SpnLong]) s.Enabled = false;
        this.putAway();
    }

    stop() {
        this.ticker?.Stop();
        this.ticker = null;
        this.watch.Reset();
        this.phase = "Stopped";
        this.paused = false;
        this.LblStatus.Text = Locale.Text("Stopped.");
        this.BtnStart.Text = Locale.Text("Start");
        this.BtnStart.Style = "suggested-action";
        for (const s of [this.SpnWork, this.SpnBreak, this.SpnLong]) s.Enabled = true;
        this.tray.Tooltip = Locale.Text("Pomodoro");
        this.setMenu();
    }

    /* Starts a phase and says so; the minutes are read now, so a setting
     * changed while stopped applies to the next Start and no sooner. */
    enter(phase) {
        const minutes = phase === "Work"  ? this.SpnWork.Value
                      : phase === "Break" ? this.SpnBreak.Value
                      :                     this.SpnLong.Value;
        this.phase  = phase;
        this.length = minutes * 60000;
        this.watch.Reset();
        this.watch.Start();
        this.paused = false;

        this.ticker?.Stop();
        this.ticker = Timer.Every(REPAINT, () => this.tick());
        this.refresh();
        this.setMenu();

        const text = phase === "Work"
            ? Locale.Text("Time to focus")
            : Locale.Text("Time to rest");
        Notification.Send(Locale.Text("Pomodoro"), `${text}: ${minutes} min`);
    }

    tick() {
        if (this.watch.Elapsed >= this.length) {
            this.next();
            return;
        }
        this.refresh();
    }

    next() {
        if (this.phase === "Work") {
            this.round++;
            this.enter(this.round % ROUNDS === 0 ? "Long break" : "Break");
        } else {
            this.enter("Work");
        }
    }

    phaseName() {
        return this.phase === "Work" ? Locale.Text("Work")
             : this.phase === "Break" ? Locale.Text("Break")
             : Locale.Text("Long break");
    }

    /* Everything the program shows while the window is away. */
    refresh() {
        const left = Math.max(0, Math.ceil((this.length - this.watch.Elapsed) / 1000));
        const mm = String(Math.floor(left / 60)).padStart(2, "0");
        const ss = String(left % 60).padStart(2, "0");
        const text = `${this.phaseName()} ${mm}:${ss}`;
        this.LblStatus.Text = text;
        this.tray.Tooltip = this.paused ? `${text} (${Locale.Text("paused")})` : text;
    }

    pause() {
        if (this.phase === "Stopped") return;
        if (this.paused) { this.watch.Start(); this.ticker = Timer.Every(REPAINT, () => this.tick()); }
        else { this.watch.Stop(); this.ticker?.Stop(); this.ticker = null; }
        this.paused = !this.paused;
        this.refresh();
        this.setMenu();
    }

    /* ---- the window and the tray ----------------------------------- */

    putAway() {
        /* Without a status-notifier host there is no icon to come back from,
         * so the window waits minimised instead. The host can also go away
         * between Form_Open and now, which is what the catch is for. */
        if (!Tray.Available) {
            this.Minimize();
            return;
        }
        try {
            this.tray.Show();
            this.Visible = false;
        } catch (e) {
            this.Minimize();
        }
    }

    showWindow() {
        this.Show();
    }

    setMenu() {
        this.tray.Menu = [
            { Text: Locale.Text("Show window"), Action: "show" },
            { Text: this.paused ? Locale.Text("Resume") : Locale.Text("Pause"),
              Action: "pause", Enabled: this.phase !== "Stopped" },
            { Text: Locale.Text("Skip phase"), Action: "skip", Enabled: this.phase !== "Stopped" },
            { Separator: true },
            { Text: Locale.Text("Quit"), Action: "quit" },
        ];
    }

    menu(action) {
        if (action === "show") this.showWindow();
        else if (action === "pause") this.pause();
        else if (action === "skip") this.next();
        else if (action === "quit") Application.Quit();
    }
}
