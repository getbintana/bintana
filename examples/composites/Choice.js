/*
 * One row of a `RichSelect`: a picture, a name, a line of detail and a tick.
 *
 * It is a component, so the row is drawn in the designer and the running list
 * builds the same class (`RichSelect.fill`), and it publishes the four things
 * the selector sets on it.  `Chosen` is the tick -- and it is a *property of
 * the row* rather than something the selector reaches inside it for, which is
 * what keeps the row a black box with a small face.
 */
"use strict";

class Choice extends Component {

    /* No icon is no room taken: the image starts hidden in the `.form`, and an
     * empty `GtkImage` is not nothing. */
    get Icon() { return this.Img.Visible ? this.Img.Icon : ""; }
    set Icon(v) {
        this.Img.Icon    = String(v || "");
        this.Img.Visible = !!v;
    }

    get Title()  { return this.LblTitle.Text; }
    set Title(v) { this.LblTitle.Text = String(v); }

    get Detail() { return this.LblDetail.Text; }
    set Detail(v) {
        this.LblDetail.Text    = String(v || "");
        this.LblDetail.Visible = !!v;
    }

    get Chosen()  { return this.ImgCheck.Visible; }
    set Chosen(v) { this.ImgCheck.Visible = !!v; }

}
