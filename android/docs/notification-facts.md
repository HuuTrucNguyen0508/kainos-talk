# Notification facts

Kainos Talk for Android reads only the notifications that WhatsApp, Discord, Messenger, the default SMS app and Proton Mail post on the phone. This page lists what the code assumes about those notifications, and what to check on a real phone to confirm or correct each assumption.

None of the app-specific facts below were seen on a signed-in phone. They come from open-source projects that read the same notifications, user reports, Discord's community-documented push format, and Proton Mail's own source code. Confidence is the research team's rating: high, medium or low.

When an assumption is wrong, the code is meant to degrade, not drop the message: an unknown layout becomes a plain-text chat or a mail item with only "Open".

## How to check: the dump tab

1. Install the debug build and turn on notification access (see the access tab).
2. Let a few real notifications arrive, or ask someone to message you.
3. Open the **Dump** tab. Each row is one notification from a watched app, newest first, with what the hub did with it (`chat (messaging_style, 2 message(s))`, `mail (expected, 3 action(s))`, `ignored: group summary`, and so on).
4. Tap a row to see its structure: key, id, tag, channel id, category, template, flags, group key, sort key, shortcut id, every extras key with its type, every action with its title, semantic action and RemoteInput result key, and whether a content intent exists.
5. Text is hidden as `<N chars>` and identifiers as a shape (`###############@lid`) until you turn on **Show content**.
6. **Export** saves the redacted structure as a JSON file you can share. Action titles stay readable in the export, because they are needed to settle the questions below; check them before sharing if an app puts a name in a button.

The dump is kept in memory only and holds the last 100 notifications since the app started.

## What the code assumes

### All sources (Android platform)

| Assumption | Confidence | Where it matters |
|---|---|---|
| The listener sees only notifications posted while it is connected, plus the ones still showing when it connects. There is no history before install. | high | Backfill with `getActiveNotifications()` on connect. |
| A reply works by filling the reply action's `RemoteInput` result key and sending its PendingIntent. The source app must have made it mutable. | high | `DefaultTalkHub.sendReply` |
| A reply is only possible while the source app's notification is still posted. | high | Reply fails with `NOTIFICATION_GONE` after removal. |
| Opening another app's activity PendingIntent needs the sender's background-start opt-in on Android 14+, and works only while Kainos Talk is visible. A blocked launch fails silently. | high | `openInApp` sends `ALLOW_IF_VISIBLE` (36+) or `ALLOWED` (34–35). |
| Android 15+ hides the text of notifications that the system thinks contain a one-time code. A normal chat message is not affected. | medium | Such messages arrive with a system placeholder text. |
| Content URIs in a notification (for example a photo) are readable only while it is posted. | medium | The hub does not copy images yet; it shows a media label. |
| `adb install` and `adb shell cmd notification allow_listener` are not restricted. An APK opened from a file manager or browser needs "Allow restricted settings" first. | high (code), medium (OEM variations) | Access tab instructions. |

### WhatsApp (`com.whatsapp`) and WhatsApp Business (`com.whatsapp.w4b`)

| Assumption | Confidence | Where it matters |
|---|---|---|
| The two packages are separate accounts. | high | Separate sources `whatsapp` and `whatsapp-business`. |
| Each chat is its own child notification in one group, plus a group summary. The summary is skipped. | medium | `ignored: group summary` |
| The notification's shortcut id is the chat JID: `@g.us` for a group, `@lid` for one-to-one. It is stable across updates. | medium | The conversation key is `whatsapp|<user>|s:<shortcut id>`. Without a shortcut id the key falls back to the title, which breaks if a chat is renamed. |
| Chats use MessagingStyle, with each message's sender, time and text. | low on a current build | `chat (messaging_style, …)`. Older layouts are read from title and text: `Group: Sender`, `Sender @ Group`, and text `Sender: message`. |
| Each update repeats all unread messages. Messages are de-duplicated by conversation, time, sender and text. | medium | A changed timestamp on a repeated message would duplicate it. |
| Group titles may carry a counter such as `Family (3 messages)`; it is removed. | medium | Group name in the inbox. |
| Media shows as an emoji label (`📷`, `🎥`, `🎤`, `📄`, `📍`, `👤`, `📊`, `👾`) or as an empty text with a MIME type. | low | Media label in the thread. |
| A reply sent from the hub comes back in the next update as the user's own message. | medium | The reply turns from "Sent" to "Shown by the app". If WhatsApp never echoes it, it stays "Sent". |
| There is a reply action with a free-form RemoteInput and, probably, a mark-as-read action (semantic action 2). | high (reply), low (mark read) | Reply box; "Mark read in WhatsApp" menu item. |
| Non-message notifications use categories such as `progress` and `call`, or texts like "Checking for new messages". | medium | `ignored: category …` |
| Notification channel ids end in a number that changes; the code never matches them in full. | medium | Nothing depends on the channel id. |

### Discord (`com.discord`)

This is the least certain source. No public source documents Discord's Android notification.

| Assumption | Confidence | Where it matters |
|---|---|---|
| Chats arrive on notification channels `directMessages` (DMs and group DMs) and `messages` (servers). Other channel ids (`calls`, `friendRequests`, `reactions`, `social`, …) are not chats. | medium | `ignored: channel …`. An unknown channel id is kept as `chat (fallback, …)`. |
| One notification per Discord channel, updated as messages arrive. | medium | One conversation per notification. |
| Discord uses MessagingStyle. | unknown | If not, each notification becomes one plain-text message from the title: readable, but not split by sender. |
| A shortcut id, if present, identifies the channel. | unknown | Without one, the key is the channel id plus the title. |
| Server and channel names are not parsed out of titles. The title is shown as Discord wrote it. | by design | Inbox title. |
| A reply action exists on some message notifications, but not all. | low | Reply box shows why it is unavailable. |

### Proton Mail (`ch.protonmail.android`)

Read from Proton Mail's open-source Android app (7.x), so the most certain source.

| Assumption | Confidence | Where it matters |
|---|---|---|
| New mail is on channel `v7_email_channel_id`. Login alerts (`v7_login_channel_id`) and the ongoing search and sending notifications are skipped. | high | `mail (expected, …)` or `ignored: channel …`. An unknown channel becomes a mail item with only "Open". |
| Title is the sender, text is the subject, subText is your Proton address. There is no message body. | high | Mail screen. |
| With "Extended notifications" off, the title is the literal `New message` and the sender is lost. | high (English only) | Shown as "Sender hidden". In another language the literal differs and the code would show it as the sender name. |
| The notification group is your Proton user id; the id is a hash of the message id. | high | Mail key and account. |
| There are exactly three actions: Archive, Trash, Mark read. No reply. | high | Buttons, under Proton's own titles. English titles map by name; a fully non-English set maps by position; anything else gets no buttons. |
| The actions report no result, and Proton removes the notification even when the action failed. | high | The hub says "requested", not "done". |
| The summary notification has the text "New messages" and is skipped. | high | `ignored: group summary` |

### Messenger (`com.facebook.orca`) and SMS (the default SMS app)

Both are read by `ChatAppAdapter`, which assumes Android's own conversation guidelines. Nothing here was seen on a signed-in phone.

| Assumption | Confidence | Where it matters |
|---|---|---|
| SMS is read from the default SMS app (`Telephony.Sms.getDefaultSmsPackage`) plus Google Messages, Samsung Messages and AOSP Messaging. Only the default app posts message notifications. Kainos Talk asks for no SMS permission. | high | `defaultWatchedApps`. Changing the default SMS app takes effect after Kainos Talk restarts. |
| RCS chats in Google Messages arrive the same way as SMS and show under SMS. | medium | The SMS socket. |
| One notification per conversation, in MessagingStyle, with a shortcut id that identifies the conversation. | medium | The conversation key is `messenger|<user>|s:<shortcut id>` or `sms|…`. Without a shortcut id it falls back to the title. |
| A notification without MessagingStyle is one message from title and text. | by design | `chat (fallback, …)` in the dump. |
| There is a reply action with a free-form RemoteInput, and maybe a mark-as-read action. | medium | Reply box; "Mark read" menu item. |
| Calls, missed calls, sending progress and other system categories are not messages. | medium | `ignored: category …`. |
| Android 15+ hides one-time codes in SMS notifications from listeners. | medium | Such texts arrive with a system placeholder. |

## Checklist for your phone

Ordered by how much each answer changes the app. Do the first five before the product UI is built on top.

1. **WhatsApp chat shape.** Get a one-to-one message and a group message. In the dump, check: `template` is `…MessagingStyle`, `shortcut id` ends in `@lid` or `@g.us`, `messages` is at least 1, and `android.messages` has `sender_person` entries. If the template is missing or there is no shortcut id, conversation identity and sender names depend on fallbacks and need rework.
2. **WhatsApp reply.** Open the chat in Kainos Talk, send a short reply, and check that it arrives in WhatsApp. In the dump, note the reply action's `resultKey`, `allowFreeFormInput` and `semantic`. Then check whether the message in Kainos Talk changes to "Shown by the app" (WhatsApp echoed it) or stays "Sent".
3. **Discord shape.** Get a DM and a server message. Check `channel id` (`directMessages`, `messages`?), `template`, `shortcut id`, `android.conversationTitle`, and whether an action has a RemoteInput. If the outcome says `fallback`, record the channel id and template so the adapter can learn the real shape.
4. **Proton Mail shape.** Get one mail. Check the outcome says `mail (expected, 3 action(s))`, the action titles in your language, and that `android.title`, `android.text` and `android.subText` hold sender, subject and address.
5. **Open in the real app.** From a WhatsApp chat, a Discord chat and a Proton mail, use "Open in …" while the notification is still showing. Note whether it lands on the exact chat or mail. If nothing opens, run `adb logcat | grep "Background activity launch"` and send the line.
6. **What removes a notification.** Read a WhatsApp chat in WhatsApp, read one on WhatsApp Web, and swipe one away. In the dump, note the `removed reason` for each (8 means the app removed it, 2 means you dismissed it). This decides whether "read in WhatsApp" can clear Kainos Talk's unread count.
7. **WhatsApp group summary.** With two chats unread, check that one notification has `GROUP_SUMMARY` in its flags and is ignored, and that each chat arrives as its own notification.
8. **WhatsApp mark as read.** Check whether a chat notification has an action with `semantic=2` or titled "Mark as read", and whether it has `showsUI=false`. Firing it sends read receipts.
9. **Media.** Receive a photo without caption, a voice note, a sticker and a document in WhatsApp. Note `android.text` length and each message's `type` and `uri` in `android.messages`.
10. **Muted and archived chats.** Message yourself from a muted WhatsApp chat and from a muted Discord server channel. Note whether a notification arrives at all.
11. **Proton sender hidden.** Turn off "Extended notifications" in Proton Mail, receive a mail, and with **Show content** on, note the exact title in your language.
12. **Discord limits.** Check whether a busy server channel stops notifying after about three messages, and whether notifications stop while Discord is open on your computer.
13. **Non-message notifications.** During a WhatsApp call, a WhatsApp backup and a Discord call, check that the outcome is `ignored`.
14. **Staying connected.** After a night with the screen off and after a reboot, open the access tab and check "Connected since" and "Last notification". If the listener dropped, the phone's battery settings for Kainos Talk need to allow background use.
15. **Messenger and SMS shape.** Get a Messenger message and a text. Check `template` is `…MessagingStyle`, there is a `shortcut id`, and the reply action has a RemoteInput. Reply to each from Kainos Talk and check it arrives.
16. **Sideload flow.** Install the APK from a file instead of `adb`, and check whether Android asks for "Allow restricted settings" and where your phone puts that menu.
