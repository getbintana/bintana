; The messages a `Logger` line becomes in the Windows Event Log.
;
; The text of the log line arrives as the first insertion string, so each level
; has a message of its own -- the event type (Information, Warning, Error) says
; how much it matters and the viewer shows the line as it was written.  The
; table is compiled into `bintana.exe`, which `bintana --register-event-source`
; names as the source's EventMessageFile.
;
; **No Severity= line**: windmc would fold the severity and the Application
; facility into the high bits of the id (0x40001000), and the Event Log looks a
; message up by the event id itself.  The event's type comes from ReportEvent,
; not from the table.
;
; The .mc is turned into a message-table resource by `windmc` and `windres` at
; build time; CMake picks the generated binary up.  The ids match
; BTA_EVENT_*_ID in `bta_eventlog.c`.

MessageId=0x1000
SymbolicName=BTA_EVENT_DEBUG
Language=English
%1
.

MessageId=0x1001
SymbolicName=BTA_EVENT_INFO
Language=English
%1
.

MessageId=0x1002
SymbolicName=BTA_EVENT_WARNING
Language=English
%1
.

MessageId=0x1003
SymbolicName=BTA_EVENT_ERROR
Language=English
%1
.
