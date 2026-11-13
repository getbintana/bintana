"use strict";

/* The shared copy of `inner`, which a project that carries its own must not
 * see loaded beside it. */
class Inner {
    static get From() { return "shared"; }
}
