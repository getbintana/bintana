# UPSTREAM: GtkSourceView 5.20 offers a word only five seconds after it was written

## What the application needed

`SourceEditor.Completion` offers the buffer's own words while typing. A word
written a moment ago -- the identifier declared on the line above -- should be
among them the next time its first letters are typed.

## What happens

It is not, for about five seconds, and longer while the person keeps typing.
Measured on Xvfb with xfwm4 and xdotool: a buffer of `alphabet alpine alpha`,
then `alp` typed on the next line, shows no completion 1.5 or 2.5 seconds after
the words were written, and the list 6 seconds after. Nothing in the runtime is
involved: a 20-line C program with a `GtkSourceView` and only the words
provider (registered as `bta_editor.c` registers it) does the same.

## Why

`gtksourceview/completion-providers/words/gtksourcecompletionwordsbuffer.c`,
5.20.0:

```c
#define INITIATE_SCAN_TIMEOUT 5                       /* line 29: seconds */

static void
install_initiate_scan (GtkSourceCompletionWordsBuffer *buffer)   /* line 363 */
{
	if (buffer->batch_scan_id == 0 &&
	    buffer->initiate_scan_id == 0)
	{
		buffer->initiate_scan_id =
			g_timeout_add_seconds_full (G_PRIORITY_LOW,
			                            INITIATE_SCAN_TIMEOUT, ...);
```

A change to the buffer adds its lines to a region to scan and installs that
timeout (lines 491, 582); the index only learns the words when it fires. And
every proposal list the words provider builds locks the library
(`gtksourcecompletionwordsmodel.c:203`), whose `lock` handler removes the
pending scan (`on_library_lock`, line 616) and whose `unlock` installs it again
from zero (`on_library_unlock`, line 632). So while lists keep being built --
which is while somebody types -- the new words keep waiting.

There is no property for the delay and no public call that scans now:
`gtk_source_completion_words_register` goes through the same timeout, and the
`scan-batch-size` the runtime sets (1000 lines a batch) is how much is indexed
once the scan starts, not when it starts.

## What I wrote instead

Nothing in the runtime: the words are offered, five seconds late, and a file
that was open before the typing is indexed by the time anybody types. The
documentation of `SourceEditor.Completion` says so. A provider of the runtime's
own that indexed as text is inserted would remove the delay, and would
replace a library component that works to do it.

## The code I wish I could have written

```c
g_object_set (words, "scan-delay", 0, NULL);   /* or: scan the region now */
```

## Why the existing words do not cover it

`scan-batch-size` reads as the knob, and is the one the runtime's own comment
blamed for "the first time is slow". It is the smaller half of it.

## Seen on

gtksourceview-5 5.20.0, gtk4 4.22, Fedora 44, X11 (Xfce) and Xvfb with xfwm4.
