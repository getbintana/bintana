/*
 * A component whose .form declares one of everything the catalogue can reach:
 * prose, a tooltip, a list of strings, a placeholder, a template for Fill, and a
 * design value.
 *
 * A Component and not a Form so building it opens no window -- constructing it
 * is enough to run the loader, which is what the tests are about.
 *
 * Two of its controls are the negative cases, and they matter more than the
 * positive ones:
 *
 *   LblStyled  wears `Style: "Name:"` -- a class name that is also a msgid.
 *              Style is not prose, so nothing may happen to it.
 *   Ed         is a SourceEditor holding "Name:" as its *source text*.
 *              Translating a source editor's Text would rewrite the user's code,
 *              silently and only in some languages; its Tooltip is prose and is
 *              translated.
 *
 * And `Memo` is the same declaration on a plain `TextEditor`, which is the
 * *positive* case of the same question and the reason the two editors are
 * siblings under an abstract `Editor` rather than one extending the other: a
 * memo's starting text is a caption and goes through the catalogue, a source
 * file's never does. Both controls carry `Text: "Name:"` here, so the pair is
 * one assertion apart and neither can quietly become the other.
 */
"use strict";

class Translated extends Component {}
