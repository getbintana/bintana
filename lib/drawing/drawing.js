/*
 * `uses: ["drawing"]` is what loads the core's drawing module:
 * `bintana-drawing.so` brings `Painter`, `Bitmap`, `Drawing` and `Text`'s measurements
 * before this file. There is no JavaScript half, because those are the
 * runtime's own classes, not a wrapper.
 *
 * A project that draws must name it -- directly, or through `report`/`charts`,
 * which declare it themselves. A `main` without it never maps cairo, Pango or
 * GdkPixbuf.
 */
