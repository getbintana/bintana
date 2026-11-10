/*
 * The Windows notification backend: a WinRT toast with actions.
 *
 * WinRT toasts need an AppUserModelID registered by a Start Menu shortcut; the
 * first `Send` writes one under the user's Start Menu and points it at this
 * runtime and the project directory.  The toast's `Activated` event carries
 * the action, which is marshalled back to the main loop and handed to
 * `Notification.OnActivate`.
 */
#ifndef BTA_NOTIFICATION_WIN32_H
#define BTA_NOTIFICATION_WIN32_H

#include "bta.h"

typedef struct {
    const char *label;
    const char *action;
} BtaNotificationButton;

bool bta_notification_win32_available(void);
int  bta_notification_win32_max_buttons(void);

/* Answers false when WinRT or the shortcut could not be used; the caller then
 * falls back to the text-only GNotification path. `error` is a sentence for the
 * debug log, or NULL. */
bool bta_notification_win32_send(JSContext *ctx, const char *aumid,
                                 const char *id, const char *title,
                                 const char *body, const char *urgency,
                                 const BtaNotificationButton *buttons,
                                 int n_buttons, const char *project_dir);

void bta_notification_win32_withdraw(const char *id);
void bta_notification_win32_cleanup(void);

#endif
