# Plan: the PC mirrors the phone's inbox; web apps open on demand

Superseded on 2026-11-15. The phone app now syncs only texts (SMS and RCS from the messages
app), and the PC's Inbox became the Texts page. The four websites load at startup and never
sleep, the source board, mail actions, "Keep running" and "Sleep now" are gone, and the PC no
longer drops a website's own notifications while the phone is connected. The reason: the user found the phone
app less appealing than the PC app and wanted to keep only the ability to answer texts from the
PC. Protocol 3's mail and other-app frames are ignored by the PC. The text below is the plan as
it was chosen on 2026-11-14.

Status: chosen on 2026-11-14 ("go with A"); steps 1 to 4 built the same day.

## Why

Kainos Talk on the PC kept five websites open all the time so they could notify: about 900 MB
(PSS), 90 to 210 MB per website, growing with each service. The phone already gathers every
service into one inbox. The PC can show that inbox, drawn by Kainos itself, and open a website
only when the user wants it.

## What the user gets

- **Inbox**, the first entry in the bar: every conversation and mail from the phone, one list,
  filtered by source like the phone's board (All, WhatsApp, Discord, Messenger, SMS, Mail).
  Threads with replies; mail with sender, subject and Archive, Trash, Mark read.
- **Desktop notifications** for new messages come from the inbox, for every source, whether or
  not the website is open.
- **The websites** (Proton Mail, Discord, WhatsApp, Messenger) stay in the bar. A website loads
  when its button is clicked and is put to sleep (unloaded) after 15 minutes out of sight, unless
  set to "Keep running". Its unread badge comes from the inbox while it sleeps.
- **At rest**: Electron's core plus the inbox page, about 150 MB instead of about 900 MB.

The inbox has the phone's limits: chats and mail only from the time the phone app was installed
(SMS has its full history), replies only while the phone still has the app's notification (SMS
always), pictures but no calls. The website is one click away for anything else.

## Protocol 3

- `conversation` carries `source` (`whatsapp`, `whatsapp-business`, `discord`, `messenger`,
  `sms`) and `sourceLabel`.
- `mail` (new, phone to PC): key, source, sender (or hidden), subject, account, time, read,
  available actions, requested action. `mailRemoved` when it goes.
- `mailAction` (new, PC to phone): key and action (archive, trash, markRead).
- `reply` and `read` work for every chat source, not only SMS.
- The phone sends everything its hub shows; nothing new leaves the local network.

## Steps

1. Protocol 3 on both sides, with the shared vectors; the phone sends every chat and mail.
2. The PC's SMS page becomes the Inbox page: source jacks, the source board, mail view.
3. Websites load on first click and sleep after 15 minutes hidden; per-service "Keep running".
   Badges and notifications come from the inbox.
4. Smoke test with the fake phone sending chats from several sources and a mail; memory measured
   before and after.
