"use strict";

/*
 * No `uses: ["drawing"]`, and it draws. The core maps cairo the first time
 * the program touches what the drawing module brings, and not before: a
 * `main` that never draws pays nothing, and one that does is the same program
 * as under `bintana-gui`, where the drawing half is always there.
 */
function cairoMapped() {
    return File.Load("/proc/self/maps").includes("libcairo");
}

function Main() {
    /* What stands in for the module before it loads: `Text`'s own names, which
     * tests/headless.sh holds to the graphical host's `Text`. Listing them
     * touches nothing. */
    print(`Text names: ${Dictionary.Keys(Text).sort().join(" ")}`);
    print(`cairo before: ${cairoMapped()}`);

    const t = new Thumb();
    t.Done = (size) => {
        print(`a worker loaded a Bitmap: ${size}`);
        print(`Text.Width: ${Text.Width("draw") > 0}`);
        const png = Drawing.ToPng(20, 10, (p) => {
            p.Color = "red";
            p.Rectangle(0, 0, 20, 10);
            p.Fill();
        });
        print(`Drawing.ToPng: ${png.Length > 0}`);
        print(`cairo after: ${cairoMapped()}`);
    };
    t.Error = (e) => print(`the worker failed: ${e}`);
    t.Start(File.Join(Application.Directory, "..", "draw", "mark.png"));
}
