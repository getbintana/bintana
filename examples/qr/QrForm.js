/*
 * QR codes, from the `qr` library: any text in, the symbol out.
 *
 * The whole of drawing one is a `QrView` in the `.form` and a line of code:
 *
 *     this.TextCode.Text = this.Input.Text;
 *
 * The status line shows what the encoder decided -- the version, the mode, the
 * mask -- because those are the three things that change under the text and
 * that a person picking a level of error correction wants to see move. The
 * symbol leaves by three roads and they are the same symbol: the clipboard as
 * a PNG, a file as a PNG, a file as an SVG document.
 *
 * Everything is wired with `On` in `Form_Open`: three fields answer to one
 * function, and a handler per field named `Input_Change` would be three methods
 * saying the same line.
 */
class QrForm extends Form {

    Form_Open() {
        for (const [key, text] of [["L", "L — 7 % can be lost"], ["M", "M — 15 %"],
                                    ["Q", "Q — 25 %"], ["H", "H — 30 %"]])
            this.Ecc.Add(text, key);
        this.Ecc.Key = "M";

        const text = () => this.showText();
        this.Input.On("Change", text);
        this.Ecc.On("Select", text);
        this.Quiet.On("Change", text);

        this.showText();
    }

    showText() {
        const view = this.TextCode;
        view.Ecc = this.Ecc.Key || "M";
        view.QuietZone = this.Quiet.Value;
        view.Text = this.Input.Text;

        const code = view.Code;
        this.LblInfo.Text = code
            ? `Version ${code.Version} (${code.Size}×${code.Size} modules), ` +
              `${code.Mode.toLowerCase()} mode, mask ${code.Mask}`
            : view.Problem || "Nothing to encode";
        this.BtnCopy.Enabled = this.BtnPng.Enabled = this.BtnSvg.Enabled = code !== null;
    }

    BtnCopy_Click() {
        Clipboard.CopyImage(this.TextCode.ToPng(600));
        this.LblInfo.Text = "Copied to the clipboard as a PNG.";
    }

    BtnPng_Click() {
        Dialog.SaveFile("Save the code as PNG", { Name: "qr.png" },
            (path) => this.TextCode.Save(path, 600));
    }

    BtnSvg_Click() {
        Dialog.SaveFile("Save the code as SVG", { Name: "qr.svg" },
            (path) => File.Save(path, this.TextCode.ToSvg()));
    }
}
