/*
 * Raster tiles with a local cache, under OpenStreetMap's tile usage policy.
 *
 * The policy (https://operations.osmfoundation.org/policies/tiles/) is short,
 * and every line of it is a decision in this file:
 *
 *   - **the URL, exactly** `https://tile.openstreetmap.org/{z}/{x}/{y}.png`,
 *     HTTPS and no other subdomain.  It is a `Settings` value so a provider can
 *     be switched without a new build -- `gpx.tiles` -- which is the policy's
 *     own recommendation, and the default is the OSM standard layer.
 *   - **a User-Agent that names the application**, never the library's default
 *     and never a browser's.  The policy blocks generic identities, so this is
 *     not a courtesy.
 *   - **at most two connections to the host** (`MaxConns`/`MaxPerHost`), which
 *     is the policy's number.
 *   - **the local cache is the point.**  Server caching headers are honoured:
 *     `Cache-Control: max-age` first, `Expires` next, and -- when neither can
 *     be read -- the policy's own floor of **seven days**.  A tile that has
 *     expired is revalidated with `If-None-Match` (the stored `ETag`) or
 *     `If-Modified-Since` (the file's own mtime), and a `304` keeps the bytes
 *     that are already here.  A repeat view asks for nothing.
 *   - **no prefetch and no offline.**  Only the tiles the current view needs
 *     are requested, which is what the policy permits; there is deliberately no
 *     "download this area" button, no background job and no zoom stack fetched
 *     "just in case".
 *   - **attribution is visible** when a tile is drawn -- the window shows
 *     `© OpenStreetMap contributors` over the map, linked to the copyright
 *     page, and it is not hidden behind a toggle.
 *   - **`Cache-Control: no-cache` is never sent**, and neither is `Pragma`.
 *
 * The cache lives under `Application.ConfigDirectory/tiles/<z>/<x>/<y>.png`,
 * with a `<y>.png.json` beside it holding the `ETag` and when it expires next.
 * The PNG's presence on disk is also what makes the drawing fast:
 * `Painter.Image` caches decoded images **by path** and decodes bytes on every
 * call, so a tile is painted from its file and decoded once per run.
 */
"use strict";

const TILE_PX = 256;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/* The policy forbids the plain-http URL and requires this host, so the default
 * is written out in full; another provider is one setting away. */
const TILE_URL = Settings.Get("gpx.tiles",
                              "https://tile.openstreetmap.org/{z}/{x}/{y}.png");

/* --- the projection, in world pixels at a zoom -----------------------------
 *
 * Web Mercator: z0 is one 256-pixel tile for the whole world and every zoom
 * doubles it.  **The track and the raster tiles have to be the same
 * projection** or the ride floats beside the roads, so this is the only one in
 * the example -- which is also why the earlier `cos(lat)` equirectangular
 * version is gone.
 */
function mercatorX(lon, z) {
    return (lon + 180) / 360 * TILE_PX * Math.pow(2, z);
}

function mercatorY(lat, z) {
    const phi = lat * Math.PI / 180;

    return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2 *
           TILE_PX * Math.pow(2, z);
}

class Tiles {

    dir     = File.Join(Application.ConfigDirectory, "tiles");
    client  = Http.Client({
        UserAgent:  "Bintana-GPX-example/1.0 (+https://github.com/getbintana/bintana)",
        MaxConns:   2,
        MaxPerHost: 2,
        Timeout:    15000,
    });

    /* "z/x/y" -> "ok" | "pending" | "failed".  A tile that is not here yet is
     * asked for once; a failed one is not asked again this run. */
    states  = {};
    blocked = false;
    reason  = "";
    made    = 0;    /* requested from the network this run */
    kept    = 0;    /* answered by the cache without a request */
    checked = 0;    /* answered 304 and kept */
    missing = 0;    /* network or status failure */

    key(z, x, y)  { return `${z}/${x}/${y}`; }
    path(z, x, y) { return File.Join(this.dir, String(z), String(x), `${y}.png`); }
    meta(z, x, y) { return `${this.path(z, x, y)}.json`; }

    url(z, x, y) {
        if (!TILE_URL.startsWith("https://"))
            throw new TypeError("gpx.tiles must be an HTTPS URL -- the tile " +
                                "policy forbids the plain-http one");
        if (!TILE_URL.includes("{z}") || !TILE_URL.includes("{x}") ||
            !TILE_URL.includes("{y}"))
            throw new TypeError("gpx.tiles needs {z}, {x} and {y} in it");

        return TILE_URL
            .replace("{z}", String(z))
            .replace("{x}", String(x))
            .replace("{y}", String(y));
    }

    /*
     * Asks for one tile and answers what the drawer should do with it right
     * now: `"ok"` paint it, `"pending"` leave a gap until it lands, `"failed"`
     * leave a gap.  `onReady` runs when something changed and a redraw is due.
     */
    get(z, x, y, onReady) {
        const key = this.key(z, x, y);

        if (this.states[key]) return this.states[key];

        const path  = this.path(z, x, y);
        const file  = File.Exists(path);
        let   saved = null;

        try { saved = File.LoadJson(this.meta(z, x, y)); } catch (e) { saved = null; }

        /* Inside the server's own max-age: the file is the answer. */
        if (file && saved && saved.Expires > Date.now()) {
            this.states[key] = "ok";
            this.kept++;
            return "ok";
        }

        if (this.blocked) {
            this.states[key] = "failed";
            return "failed";
        }

        /*
         * Expired, or no record of it: ask, and ask **conditionally**.  The
         * ETag is the server's own answer to "has it changed"; a file without
         * one is dated by its mtime, which is the `If-Modified-Since` half the
         * policy names.  Never a `no-cache` header.
         */
        const headers = {};

        if (file && saved && saved.Etag)
            headers["If-None-Match"] = saved.Etag;
        else if (file)
            headers["If-Modified-Since"] = File.Info(path).Modified.toUTCString();

        this.states[key] = "pending";
        this.made++;

        this.client.Get(this.url(z, x, y), { Headers: headers }, (r) => {
            if (r.Headers["x-blocked"]) {
                this.stop(`the tile server refused this client: ` +
                          `${r.Headers["x-blocked"]}`);
                return;
            }

            if (r.Status === 304 && File.Exists(path)) {
                saved.Expires = this.expiry(r.Headers);
                File.SaveJson(this.meta(z, x, y), saved);
                this.states[key] = "ok";
                this.checked++;
            } else if (r.Status === 200) {
                Directory.Make(File.Directory(path));
                File.SaveBytes(path, r.Body);
                File.SaveJson(this.meta(z, x, y), {
                    Etag:    r.Headers["etag"] || "",
                    Expires: this.expiry(r.Headers),
                    Saved:   Date.now(),
                });
                this.states[key] = "ok";
            } else if (r.Status === 403 || r.Status === 418 || r.Status === 429) {
                this.stop(`the tile server answered ${r.Status}: ` +
                          `${r.Status === 429 ? "too many requests" : "the policy was not met"}`);
                return;
            } else {
                this.states[key] = "failed";
                this.missing++;
            }
            onReady();
        }, (e) => {
            this.states[key] = "failed";
            this.missing++;
            onReady();
        });

        return "pending";
    }

    /*
     * The server has said no.  Every tile in flight becomes a gap, nothing new
     * is asked for, and the window says so: retrying a refused client is the
     * behaviour the policy's enforcement exists for.
     */
    stop(reason) {
        this.blocked = true;
        this.reason  = reason;
        this.missing++;

        for (const key in this.states)
            if (this.states[key] === "pending")
                this.states[key] = "failed";
    }

    expiry(headers) {
        const cache = headers["cache-control"] || "";
        const age   = /(?:^|,)\s*max-age=(\d+)/.exec(cache);

        if (age)
            return Date.now() + Number(age[1]) * 1000;

        const at = Date.parse(headers["expires"] || "");
        if (Number.isFinite(at))
            return at;

        /* The policy's floor for a cache that cannot read them. */
        return Date.now() + WEEK_MS;
    }

    /* What the status line says: the cache at work, and not a count of bytes. */
    summary() {
        const bits = [`${this.kept} cache`, `${this.made} asked`,
                      `${this.checked} 304`];

        if (this.missing) bits.push(`${this.missing} missing`);
        if (this.blocked) bits.push("map off");
        return bits.join(" · ");
    }
}
