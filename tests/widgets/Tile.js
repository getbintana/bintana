/*
 * The component `ISSUE-fixed-fill-child` was filed with: its own surface is
 * drawn at one size, its `Fill` child is drawn as big as that surface, and a
 * host that gives the component more room has to hand it to the child.  The
 * design comes from `Tile.form`'s declared `Width`/`Height` -- `drawn_w`/
 * `drawn_h` -- and not from the cell the box gives it.
 */
class Tile extends Component {
}
