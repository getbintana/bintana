"use strict";

/* `outer` is found on BINTANA_LIB_PATH and names `inner` in its own uses; the
 * project carries its own `inner`. A name is one library per program, so
 * `outer` gets the project's copy and the shared one is never loaded -- two
 * copies of one class are a redeclaration before Main runs. */
function Main() {
    print(`outer sees the ${Outer.InnerFrom} inner`);
}
