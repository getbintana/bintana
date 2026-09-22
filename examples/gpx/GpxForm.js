/*
 * A GPX track over a cached map, with a Save that proves what `SaveXml` is for.
 *
 * The first sample is a **real marathon** -- 42,364 m of Buenos Aires, 696
 * points -- anonymised: the author, the links and the metadata date are gone
 * and the point times had already been carried to a neutral 2010-01-01 by the
 * site that exported it, keeping the elapsed 4h14.  The second is the synthetic
 * track with the watch extensions that Save writes around.
 *
 * The shapes are in [`Gpx.js`](Gpx.js) and the tiles -- the cache, the policy,
 * the fetch -- in [`Tiles.js`](Tiles.js); this file draws them and measures
 * them.  What it is worth reading for:
 *
 *   - **one projection for both.** The track and the raster tiles are Web
 *     Mercator, because a ride drawn in another projection floats beside the
 *     roads it was ridden on.
 *   - **the line is a halo and a colour**, because one line over a map has to
 *     read over streets, water and parks; and the pointer over it answers what
 *     is true there -- kilometres run, metres climbed, time and pace -- from
 *     marks computed once per file, not per movement.
 *   - **the view follows the track.** The fit shows the whole course; the
 *     buttons and the wheel zoom -- the wheel about the pointer, so the street
 *     under the cursor stays under it -- zooming in from the fit re-centres on
 *     the line, because a loop's middle is empty city, and dragging pans. Once
 *     you have dragged or wheeled, nothing re-centres: the view is yours.
 *   - **the cache is the map.** A tile that is on disk is painted from its
 *     file, which is also what makes it fast: `Painter.Image` caches decoded
 *     images by path and decodes bytes on every call.  A repeat view asks the
 *     network for nothing until the tile's own headers say it expired.
 *   - **nothing is fetched that is not on screen**, and nothing is fetched
 *     twice: the drawer asks for the visible grid, `Tiles` answers `ok`,
 *     `pending` or `failed`, and a pending tile draws as a gap until it lands.
 *     There is deliberately no prefetch and no "download this area".
 *   - **Save writes around what the shape does not know.** The record is loaded
 *     from the document, the name is changed, and `SaveXml` writes only the
 *     fields it models -- the watch's `<extensions>`, the schema location and
 *     everything else stay exactly where they were.
 */
"use strict";

const MAX_ZOOM  = 17;
/*
 * The track's own colour, not the theme's: it is data, and it has to read over
 * the base map.  **Purple, and not the orange a sports app reaches for** --
 * measured on this map, that orange is what OSM Carto paints its avenues with,
 * its secondary roads are a paler one, its parks are green and its water blue.
 * Purple is the hue the base map does not use, so the line is the only purple
 * thing on the screen.
 */
const TRACK_INK = "#c061cb";

class GpxForm extends Form {

    doc        = null;
    record     = null;
    track      = null;
    points     = [];
    problems   = [];
    bounds     = null;
    marks      = [];
    hover      = -1;
    path       = "";
    zoom       = -1;
    fit        = -1;
    /* The view's centre, in world pixels at z0 -- one number pair for every
     * zoom, so zooming is arithmetic on the same centre and panning is a
     * difference.  `panned` is what tells a view the user moved from the one
     * the fit chose. */
    cx0        = 0;
    cy0        = 0;
    panned     = false;
    drag       = null;
    pointer    = null;
    wheel      = 0;
    frameW     = 0;
    frameH     = 0;
    originX    = 0;
    originY    = 0;
    painted    = 0;
    tiles      = new Tiles();

    Form_Open() {
        const given = Application.Arguments[0];
        const first = given && File.Exists(given)
                    ? given
                    : Directory.Files(File.Join(Application.Directory, "samples"),
                                      "*.gpx")[0];

        if (first) this.load(first);
    }

    load(path) {
        let track;

        try {
            track = readTrack(path);
        } catch (e) {
            Message.Error("Cannot read {0}: {1}", path, e.message);
            return;
        }

        this.doc      = track.Doc;
        this.record   = track.Record;
        this.track    = track.Track;
        this.points   = track.Points;
        this.problems = track.Problems;
        this.path     = path;
        this.zoom     = -1;
        this.fit      = -1;
        this.hover    = -1;
        this.panned   = false;
        this.drag     = null;
        this.bounds   = this.boundsOf(track.Points);
        this.marks    = trackMarks(track.Points);

        /* The fit's own centre: the middle of what the track covers.  The
         * course is a loop and the middle of the loop is not on it, which is
         * why a zoomed view is re-centred on the line below. */
        this.cx0 = (mercatorX(this.bounds.MinLon, 0) +
                    mercatorX(this.bounds.MaxLon, 0)) / 2;
        this.cy0 = (mercatorY(this.bounds.MinLat, 0) +
                    mercatorY(this.bounds.MaxLat, 0)) / 2;

        const named = this.track
                    ? (this.track.Name || (this.record.Metadata || {}).Name || "")
                    : "";

        this.LblTitle.Text   = named || File.Name(path);
        this.TxtName.Text    = named;
        this.TxtName.Enabled = this.track !== null;
        this.BtnSave.Enabled = this.track !== null;

        this.Area.Redraw();
        this.showStats();
    }

    boundsOf(points) {
        const out = { MinLat: Infinity, MaxLat: -Infinity,
                      MinLon: Infinity, MaxLon: -Infinity };

        for (const point of points) {
            out.MinLat = Math.min(out.MinLat, point.Lat);
            out.MaxLat = Math.max(out.MaxLat, point.Lat);
            out.MinLon = Math.min(out.MinLon, point.Lon);
            out.MaxLon = Math.max(out.MaxLon, point.Lon);
        }
        return out;
    }

    /* --- the drawing ------------------------------------------------------- */

    Area_Draw(p, width, height) {
        if (!this.points.length) return;
        if (width < 16 || height < 16) return;

        this.frameW = width;
        this.frameH = height;
        this.fit    = this.fitZoom(width, height);
        if (this.zoom < 0) this.zoom = this.fit;

        const painted = this.drawMap(p, width, height);

        this.drawTrack(p);
        this.drawHover(p);

        /* The attribution is on screen exactly when a tile is: the licence is
         * for the map, and there is no map to credit without one. */
        if (this.Credits.Visible !== (painted > 0))
            this.Credits.Visible = painted > 0;
        this.painted = painted;

        /* The status counts what the cache did, and a cache hit happens in
         * here -- so this is where the line is brought up to date.  Only when
         * the text changes, so a frame does not relayout a label for saying
         * the same thing. */
        this.showStats();
    }

    /* The largest zoom whose tile grid still shows the whole track. */
    fitZoom(width, height) {
        const pad = 16;
        const b   = this.bounds;

        for (let z = MAX_ZOOM; z > 0; z--) {
            const spanX = mercatorX(b.MaxLon, z) - mercatorX(b.MinLon, z);
            const spanY = mercatorY(b.MinLat, z) - mercatorY(b.MaxLat, z);

            if (spanX <= width - 2 * pad && spanY <= height - 2 * pad)
                return z;
        }
        return 0;
    }

    /* The visible grid, centred on the track: cached tiles are painted, the
     * rest are asked for once and left as a gap until they answer. */
    drawMap(p, width, height) {
        const z = this.zoom;
        const k = Math.pow(2, z);

        this.originX = this.cx0 * k - width / 2;
        this.originY = this.cy0 * k - height / 2;

        const count  = Math.pow(2, z);
        const firstX = Math.max(0, Math.floor(this.originX / TILE_PX));
        const lastX  = Math.min(count - 1, Math.floor((this.originX + width) / TILE_PX));
        const firstY = Math.max(0, Math.floor(this.originY / TILE_PX));
        const lastY  = Math.min(count - 1, Math.floor((this.originY + height) / TILE_PX));
        let   painted = 0;

        for (let ty = firstY; ty <= lastY; ty++) {
            for (let tx = firstX; tx <= lastX; tx++) {
                const state = this.tiles.get(z, tx, ty, () => {
                    this.showStats();
                    this.Area.Redraw();
                });

                if (state !== "ok") continue;

                p.Image(this.tiles.path(z, tx, ty),
                        tx * TILE_PX - this.originX,
                        ty * TILE_PX - this.originY,
                        TILE_PX, TILE_PX);
                painted++;
            }
        }
        return painted;
    }

    drawTrack(p) {
        const z = this.zoom;
        const x = (point) => mercatorX(point.Lon, z) - this.originX;
        const y = (point) => mercatorY(point.Lat, z) - this.originY;

        p.Antialias = true;

        /*
         * One polyline per segment -- a pause in recording is a gap in the
         * drawing, which is the truth about the file -- and each drawn **three
         * times**: a white halo, a dark border, then the colour.
         *
         * Two passes were not enough and a screenshot said so: white is what
         * the base map paints its streets with, so a white edge disappears
         * over half the city and the purple looked like another road marking.
         * The border is what carries a route over streets, water and parks,
         * and the white outside it is what keeps the whole thing from touching
         * a dark tile if the provider is ever changed.
         *
         * **And the three widths grow with the zoom**, because the map's own
         * roads do: a 3-pixel line crosses half a block at the fit and is one
         * street three levels in, where the avenues are drawn 10 pixels wide
         * and the route stops being the subject.  The whole line scales
         * together, so the border keeps its proportion.
         *
         * The base is the **fit's**, not a zoom's: at whatever zoom shows the
         * whole track the line is 6/4/3, and it doubles by three levels in.
         * Tying it to a fixed zoom made the line twice as wide as it should be
         * on a window whose fit happens to be higher.
         */
        const grow   = Math.min(2, Math.pow(2, Math.max(0, z - this.fit) * 0.35));
        const widths = [["#ffffff", 6 * grow],
                        ["#3d3846", 4 * grow],
                        [TRACK_INK, 3 * grow]];

        for (const segment of this.track.Segments) {
            const line = [];

            for (const point of segment.Points) line.push(x(point), y(point));
            if (line.length < 4) continue;

            for (const [ink, width] of widths) {
                p.Color = ink;
                p.LineWidth = width;
                p.Polyline(line);
                p.Stroke();
            }
        }

        /* Where it started and where it ended, which is the first thing anyone
         * looks for in a track -- each with the same white ring the pointer
         * gets, so a green dot over a park is still a dot. */
        const first = this.points[0];
        const last  = this.points[this.points.length - 1];

        for (const [point, ink] of [[first, "#2ec27e"], [last, "#e01b24"]]) {
            p.Color = "#ffffff";
            p.Arc(x(point), y(point), 7.5, 0, 360);
            p.Fill();

            p.Color = "#3d3846";
            p.Arc(x(point), y(point), 5.5, 0, 360);
            p.Fill();

            p.Color = ink;
            p.Arc(x(point), y(point), 4, 0, 360);
            p.Fill();
        }
    }

    /* The pointer's point: a white ring and a dot in the track's colour, so it
     * reads as *this point of this line* and not as a third marker. */
    drawHover(p) {
        if (this.hover < 0) return;

        const point = this.points[this.hover];
        const x = mercatorX(point.Lon, this.zoom) - this.originX;
        const y = mercatorY(point.Lat, this.zoom) - this.originY;

        p.LineWidth = 3;
        p.Color = "#ffffff";
        p.Arc(x, y, 10, 0, 360);
        p.Stroke();

        p.Color = "#3d3846";
        p.LineWidth = 2;
        p.Arc(x, y, 7.5, 0, 360);
        p.Stroke();

        p.Color = TRACK_INK;
        p.Arc(x, y, 5, 0, 360);
        p.Fill();
    }

    /* --- the pointer over the line -----------------------------------------
     *
     * A lookup and not an event: `MouseMove` carries the point, the nearest
     * track point within a few pixels is what the pointer *means*, and the
     * panel says what is true there.  The scan is over the points rather than
     * a spatial index -- a marathon is 700 of them and the hit is a comparison.
     */
    Area_MouseMove(x, y) {
        /* Where the pointer is, for the wheel: `MouseWheel` carries the turn
         * and not the position, so the position is the last one seen. */
        this.pointer = { X: x, Y: y };

        /* Dragging the map: the pointer moves, the world under it does not.
         * `cx0` is in world pixels at z0 -- the whole world is 256 of them --
         * so a screen pixel at zoom z is `1 / 2^z` of one. */
        if (this.drag) {
            const k = Math.pow(2, this.zoom);

            this.panned = true;
            this.cx0 = this.drag.CX - (x - this.drag.X) / k;
            this.cy0 = this.drag.CY - (y - this.drag.Y) / k;

            if (this.hover >= 0) {
                this.hover = -1;
                this.showHover();
            }
            this.Area.Redraw();
            return;
        }

        if (!this.points.length || this.zoom < 0) return;

        const at = this.nearest(x, y);
        if (at === this.hover) return;

        this.hover = at;
        this.showHover();
        this.Area.Redraw();
    }

    Area_MouseDown(x, y, button) {
        if (button !== 1 || !this.points.length) return;

        this.drag = { X: x, Y: y, CX: this.cx0, CY: this.cy0 };
    }

    Area_MouseUp() {
        this.drag = null;
    }

    /*
     * The wheel zooms **about the pointer**: the street under the cursor stays
     * under the cursor, which is what every map does and the reason the turn
     * is worth consuming.  `MouseWheel` carries the turn and not the position,
     * so the anchor is the last `MouseMove` -- updated even while dragging, or
     * a wheel after a pan would zoom about wherever the pointer used to be.
     *
     * GTK says a notch is 1 and up is **negative**, and a touchpad gives
     * fractions: they accumulate, so a slow two-finger drag zooms one level
     * and not one per event.
     */
    Area_MouseWheel(dx, dy) {
        if (!this.points.length || !dy) return false;

        this.wheel += dy;
        if (Math.abs(this.wheel) < 1) return true;

        this.zoomBy(this.wheel > 0 ? -1 : 1, this.pointer);
        this.wheel = 0;
        return true;
    }

    Area_MouseLeave() {
        this.drag    = null;
        this.pointer = null;

        if (this.hover < 0) return;

        this.hover = -1;
        this.showHover();
        this.Area.Redraw();
    }

    nearest(x, y) {
        const z    = this.zoom;
        const near = 18 * 18;          /* squared: past this the pointer is off */
        let   best = -1;
        let   at   = near;

        for (let i = 0; i < this.points.length; i++) {
            const dx = mercatorX(this.points[i].Lon, z) - this.originX - x;
            const dy = mercatorY(this.points[i].Lat, z) - this.originY - y;
            const d  = dx * dx + dy * dy;

            if (d < at) {
                at   = d;
                best = i;
            }
        }
        return best;
    }

    showHover() {
        if (this.hover < 0) {
            this.Hover.Visible = false;
            return;
        }

        const point = this.points[this.hover];
        const mark  = this.marks[this.hover];
        const pace  = mark.Elapsed !== null && mark.Distance > 1000
                    ? ` · ${this.pace(mark.Elapsed / (mark.Distance / 1000))} /km`
                    : "";

        this.put(this.LblHoverAt,
                 `${Locale.Number(mark.Distance / 1000, 2)} km · ` +
                 `${Locale.Number(point.Ele, 0)} m`);
        this.put(this.LblHoverWhen, mark.Elapsed === null
                 ? ""
                 : `${this.hms(mark.Elapsed)}${pace}`);
        this.Hover.Visible = true;
    }

    /* hh:mm:ss for the clock, m:ss for a pace. */
    hms(seconds) {
        const s = Math.round(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);

        return `${h}:${String(m).padStart(2, "0")}:` +
               `${String(s % 60).padStart(2, "0")}`;
    }

    pace(secondsPerKm) {
        const s = Math.round(secondsPerKm);

        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }

    /* --- what it measures -------------------------------------------------- */

    showStats() {
        if (!this.points.length) {
            this.LblStats.Text = Locale.Text("No track in this file");
            this.LblMap.Text   = "";
            return;
        }

        /* What the last mark says: the walk that fills the hover fills this
         * too, and a frame does not measure the track again. */
        const last = this.marks[this.marks.length - 1];
        const km   = last.Distance / 1000;
        const up   = last.Climb;
        const secs = last.Elapsed;
        const bits = [`${Locale.Number(km, 2)} km`,
                      `+${Locale.Number(up, 0)} m`,
                      Locale.Plural("{0} point", "{0} points", this.points.length)];

        if (secs !== null) bits.push(this.clock(secs));
        if (this.problems.length)
            bits.push(Locale.Text("{0} things the shape does not model",
                                  this.problems.length));

        this.put(this.LblStats, bits.join(" · "));
        this.LblStats.Tooltip = this.problems.slice(0, 20).join("\n");

        this.put(this.LblMap, `z${this.zoom < 0 ? "–" : this.zoom} · ` +
                              this.tiles.summary());
        this.LblMap.Tooltip = this.tiles.blocked
            ? this.tiles.reason
            : `gpx.tiles · cached in ${this.tiles.dir}`;
    }

    /* A label written every frame with the same words is a relayout every
     * frame; the comparison is what keeps the status line free. */
    put(label, text) {
        if (label.Text !== text) label.Text = text;
    }

    clock(seconds) {
        const minutes = Math.round(seconds / 60);
        const hours   = Math.floor(minutes / 60);

        return hours
             ? `${hours} h ${String(minutes % 60).padStart(2, "0")} min`
             : `${minutes} min`;
    }

    /* --- zoom -------------------------------------------------------------- */

    BtnZoomIn_Click()  { this.zoomBy(1); }
    BtnZoomOut_Click() { this.zoomBy(-1); }

    /*
     * One level, optionally **about a point on the screen**: the world point
     * under `anchor` is the same one after the zoom, which is what makes a
     * wheel feel like a map and not like a slider.  The buttons pass no
     * anchor and keep the centre they had.
     */
    zoomBy(delta, anchor) {
        if (!this.points.length) return;

        if (this.zoom < 0) {
            const box = this.Area.Bounds();

            this.fit  = this.fitZoom(box.Width > 1 ? box.Width : 876,
                                     box.Height > 1 ? box.Height : 440);
            this.zoom = this.fit;
        }

        const from = this.zoom;
        this.zoom  = Math.max(0, Math.min(MAX_ZOOM, from + delta));
        if (this.zoom === from) return;

        if (anchor && this.frameW > 1) {
            const kFrom = Math.pow(2, from);
            const wx0   = (this.originX + anchor.X) / kFrom;
            const wy0   = (this.originY + anchor.Y) / kFrom;
            const kTo   = Math.pow(2, this.zoom);

            this.cx0 = wx0 + (this.frameW / 2 - anchor.X) / kTo;
            this.cy0 = wy0 + (this.frameH / 2 - anchor.Y) / kTo;

            /* The pointer chose the view, so nothing re-centres it later. */
            this.panned = true;
        } else if (this.zoom > this.fit && !this.panned) {
            /*
             * Zooming in from the fit centres on the **line**, not on the
             * middle of the loop: the course is a ring, its middle is empty
             * city, and a view that kept the centre would zoom into a place
             * the track does not go.  Once the user has dragged the view is
             * theirs, and `panned` is what says so.
             */
            this.centerOnCourse();
        }

        this.showStats();
        this.Area.Redraw();
    }

    centerOnCourse() {
        const z = this.zoom < 1 ? 1 : this.zoom;
        const k = Math.pow(2, z);
        let   best = 0;
        let   at   = Infinity;

        for (let i = 0; i < this.points.length; i++) {
            const dx = mercatorX(this.points[i].Lon, z) - this.cx0 * k;
            const dy = mercatorY(this.points[i].Lat, z) - this.cy0 * k;
            const d  = dx * dx + dy * dy;

            if (d < at) { at = d; best = i; }
        }
        this.cx0 = mercatorX(this.points[best].Lon, 0);
        this.cy0 = mercatorY(this.points[best].Lat, 0);
    }

    /* --- open and save ----------------------------------------------------- */

    BtnOpen_Click() {
        Dialog.OpenFile(Locale.Text("Open a track"),
            { Folder: Application.Directory,
              Filters: [[Locale.Text("GPX tracks"), "*.gpx"],
                        [Locale.Text("All files"), "*"]] },
            (path) => this.load(path));
    }

    Form_FileDrop(paths) {
        if (paths.length) this.load(paths[0]);
    }

    /*
     * The one write, and the reason the example exists: change a modelled field
     * and write the document back.  Everything the shape did not model -- the
     * extensions, the schema location, another namespace's elements -- is where
     * it was, because `SaveXml` never rebuilt the file.
     */
    BtnSave_Click() {
        if (!this.track || !this.path) return;

        this.track.Name = this.TxtName.Text;

        try {
            this.record.SaveXml(this.doc);
            File.SaveXml(this.path, this.doc);
        } catch (e) {
            Message.Error("Cannot save {0}: {1}", this.path, e.message);
            return;
        }

        this.LblTitle.Text = this.track.Name || File.Name(this.path);
        this.LblStats.Text = Locale.Text("Saved — the extensions are still there");
        Timer.After(3000, () => this.showStats());
    }
}
