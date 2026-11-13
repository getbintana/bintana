"use strict";

/*
 * `Drawing` is the document half of `DrawingArea`: no widget, no display.
 * This fixture asks for the three ways out -- a PNG in memory, a PNG file and
 * a PDF -- plus a picture and a text measurement, and prints only what is
 * stable across hosts (lengths and sizes, not pixels or font metrics).
 */
function Main() {
    const dir = File.Join(Environment.TempDirectory,
                           `bta-draw-${Environment.ProcessId}`);
    Directory.Make(dir);
    const png = Drawing.ToPng(200, 100, (p, w, h) => {
        p.Color = "#336699";
        p.Rectangle(0, 0, w, h);
        p.Fill();
        p.Color = "rgba(255,255,255,0.5)";
        p.MoveTo(0, 0);
        p.LineTo(w, h);
        p.Stroke();
        p.Image(File.Join(Application.Directory, "mark.png"), 8, 8, 40, 24);
        p.Text("draw", 12, 70);
    });
    print(`png-bytes ${png.Length > 100}`);

    const file = File.Join(dir, "out.png");
    Drawing.Save(file, 200, 100, (p, w, h) => {
        p.Color = "blue";
        p.Rectangle(0, 0, w, h);
        p.Fill();
    });
    const picture = Bitmap.Load(file);
    print(`png-size ${picture.Width}x${picture.Height}`);

    const pdf = File.Join(dir, "out.pdf");
    Drawing.SavePdf(pdf, 200, 100, 1, (p, page, w, h) => {
        p.Color = "black";
        p.Text(`page ${page}`, 10, 20);
        p.Image(File.Join(Application.Directory, "mark.png"), 10, 30, 40, 24);
    });
    print(`pdf ${File.Info(pdf).Type}`);
    print(`text ${Text.Width("draw") > 0}`);
    Directory.DeleteTree(dir);
}
