"use strict";

/* The bare host does not link a widget file, and it loads the metadata document
 * only for `check`: a `main` sees no `Widget` at all. */
function Main() {
    print(typeof Widget);
}
