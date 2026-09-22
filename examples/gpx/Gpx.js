/*
 * A track, and the four things GPX is that a JSON file could not be.
 *
 *   - **the position is an attribute**: `<trkpt lat="-34.6037" lon="-58.3816">`
 *     -- two attributes on every point, which is where a value mapping has
 *     nowhere to put them and a declaration has `attribute: true`;
 *   - **there are two namespaces**: GPX 1.1 is
 *     `http://www.topografix.com/GPX/1/1` and 1.0 is `.../GPX/1/0`, and a file
 *     is either -- so `Namespace` is a list, the same shape MSPDI's schema
 *     taught;
 *   - **lists inside lists**: a `<trk>` holds `<trkseg>` and a segment holds
 *     `<trkpt>`, so the points the window draws are two loops deep;
 *   - **`<time>` is a moment**: `2026-09-01T08:00:00Z`, zone and all, which is
 *     `Field.DateTime`.
 *
 * And one thing a reader must not do: **touch the extensions**. A real track
 * carries `<extensions>` from whichever watch or phone recorded it, in a
 * namespace this program has never heard of. The shape does not model them,
 * `LoadXml` reports them, and `SaveXml` writes around them -- which is the
 * whole argument for a document over a value, and what **Save** in the window
 * demonstrates: rename the track, save, and the watch's data is still there.
 *
 * `gpxtpx`, `gpxx` and the schema location are attributes and elements of
 * namespaces nothing here knows: they come back as `Problems`, counted in the
 * status line, and preserved on save.
 */
"use strict";

class GpxPoint extends Record {
    static Naming = "lower";
    static Xml = { Root: "trkpt" };
    static Fields = {
        Lat:  Field.Number({ attribute: true, decimals: 7 }),
        Lon:  Field.Number({ attribute: true, decimals: 7 }),
        Ele:  Field.Number({ decimals: 1 }),
        Time: Field.DateTime(),
    };
}

class GpxSegment extends Record {
    static Naming = "lower";
    static Xml = { Root: "trkseg" };
    static Fields = {
        Points: Field.List(GpxPoint),
    };
}

class GpxTrack extends Record {
    static Naming = "lower";
    static Xml = { Root: "trk" };
    static Fields = {
        Name:     Field.Text(),
        Type:     Field.Text(),
        Segments: Field.List(GpxSegment),
    };
}

class GpxMetadata extends Record {
    static Naming = "lower";
    static Xml = { Root: "metadata" };
    static Fields = {
        Name: Field.Text(),
        Time: Field.DateTime(),
    };
}

class Gpx extends Record {
    static Naming = "lower";
    static Xml = { Root: "gpx",
                   Namespace: ["http://www.topografix.com/GPX/1/1",
                               "http://www.topografix.com/GPX/1/0"] };
    static Fields = {
        Version:  Field.Text({ attribute: true }),
        Creator:  Field.Text({ attribute: true }),
        Metadata: Field.Record(GpxMetadata),
        Track:    Field.Record(GpxTrack),
    };
}

/*
 * A file, as the window wants it: the document it came from (to save back
 * into), the record over it (to edit), and the points flattened out of the two
 * list levels for drawing and arithmetic.
 */
function readTrack(path) {
    const doc   = File.LoadXml(path);
    const gpx   = Gpx.LoadXml(doc);
    const track = gpx.Track;
    const points = [];

    if (track)
        for (const segment of track.Segments)
            for (const point of segment.Points) points.push(point);

    return {
        Doc:      doc,
        Record:   gpx,
        Track:    track,
        Points:   points,
        Problems: gpx.Problems,
    };
}

/* --- what a track measures -------------------------------------------------
 *
 * Great-circle distance, because a track is over a sphere and not a sheet of
 * graph paper: subtracting degrees is right near the equator and wrong enough
 * to notice in Buenos Aires, where a degree of longitude is 8% shorter than a
 * degree of latitude. The mean radius is the one everybody uses.
 */
function legDistance(a, b) {
    const EARTH = 6371000;
    const rad   = (d) => d * Math.PI / 180;
    const dLat  = rad(b.Lat - a.Lat);
    const dLon  = rad(b.Lon - a.Lon);
    const h     = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(rad(a.Lat)) * Math.cos(rad(b.Lat)) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);

    return 2 * EARTH * Math.asin(Math.sqrt(h));
}

/*
 * What is true **at** each point: how far along the track it is, how much has
 * been climbed by then, and how long it took.  One walk, computed once per
 * file, which is what lets the status line and the pointer read rather than
 * recompute; `Elapsed` is `null` when the file does not carry times.
 *
 * **The climb has a threshold, and the marathon is why.**  Summing every
 * positive elevation delta of this file gives **733 m** where the site that
 * exported it says 434: a GPS elevation moves up and down a metre or two at
 * every point, and those wobbles are not a climb.  The usual filter is a step:
 * a rise counts only once it has gone past `CLIMB_STEP` since the last
 * reference, and a fall moves the reference without counting.  **Measured on
 * the file**: raw 733, step 3 → 486, step 4 → 410, step 5 → 383, against the
 * exporter's 434 -- which has a filter of its own and is no more a fact than
 * this is.  Three is the usual smallest step and the one that loses least on a
 * rolling course; it is a decision the program makes, and the raw sum is not
 * an answer.
 */
const CLIMB_STEP = 3;

function trackMarks(points) {
    const start = points.length && points[0].Time
                ? new Date(points[0].Time).getTime() : null;
    const out   = [];
    let   km    = 0;
    let   up    = 0;
    let   ref   = points.length ? points[0].Ele : 0;

    for (let i = 0; i < points.length; i++) {
        if (i) {
            km += legDistance(points[i - 1], points[i]);

            const ele = points[i].Ele;
            if (ele - ref > CLIMB_STEP) {
                up += ele - ref;
                ref = ele;
            } else if (ref - ele > CLIMB_STEP) {
                ref = ele;
            }
        }

        const when = points[i].Time ? new Date(points[i].Time).getTime() : NaN;
        out.push({
            Distance: km,
            Climb:    up,
            Elapsed:  start !== null && Number.isFinite(when)
                    ? (when - start) / 1000 : null,
        });
    }
    return out;
}
