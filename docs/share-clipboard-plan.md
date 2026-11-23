# Plan: share, clipboard and pause during calls

Status: planned on 2026-11-22. The user wants Kainos Talk to take over the KDE Connect features
they still use: clipboard, share, and pausing music during calls. Browsing the phone's files comes
later. Everything stays on the LAN link the texts and calls already use.

## What the user gets

- **Pause during calls (PC only).** When a call rings or starts on the phone, the PC pauses every
  media player that is playing. When the call ends, it resumes the ones it paused, unless the user
  has since played, paused or stopped them on their own.
- **Clipboard, PC to phone, automatic.** Text copied on the PC lands on the phone's clipboard. Text
  that a password manager marks as secret (`x-kde-passwordManagerHint: secret`) stays on the PC. An
  item in the PC's Kainos mark menu turns it off.
- **Clipboard, phone to PC, on request.** Android 10+ does not let a background app read the
  clipboard. The phone gets a Quick Settings tile, "Send clipboard to PC". Tapping it sends the copied
  text, and the PC puts it on its own clipboard.
- **Share, phone to PC.** "Kainos Talk" appears in Android's share sheet. A link opens on the PC as
  any link from a website does. Other text goes onto the PC's clipboard. Files go to the PC's
  Downloads folder. A notification on the PC says what arrived; clicking it opens the file or shows it
  in its folder.
- **Share, PC to phone.** "Send files to phone…" in the Kainos mark menu and the tray menu opens a
  file picker. The files go to the phone's Downloads folder, and a notification on the phone opens
  them.

## Wire format (protocol 6)

Both apps move to `SYNC_VERSION = 6` together, since an older peer closes the connection on a
frame type it does not know. Every frame below can travel either way except `shareText`, which only
the phone sends. Keys are written in the order shown.

- `{"t":"clip","text":…}`: the sender's clipboard text, 1 to 100 000 characters. The receiver puts it
  on its clipboard. Neither side sends text it just received from the other, so the two clipboards
  don't echo.
- `{"t":"shareText","text":…}`: text or a link shared from the phone, 1 to 100 000 characters. On the
  PC, text that is one `http:` or `https:` URL after trimming opens with the app's usual link
  handling. Anything else goes onto the clipboard.
- `{"t":"fileOffer","id":…,"name":…,"size":…,"mime":…}`: a file follows. `id` has at most 100
  characters, `name` 1 to 255 characters, `size` is a whole number of bytes from 0 to 2 147 483 648
  (2 GiB), and `mime` is a string of at most 255 characters or null. The receiver treats `name` as
  untrusted. It keeps only what follows the last `/` or `\`, drops control characters, trims spaces,
  and replaces a name that is then empty, `.` or `..` with `file` (`fileNames` in the vectors). It never overwrites a file and adds ` (1)`, ` (2)`… before the
  extension instead.
- `{"t":"fileChunk","id":…,"data":…}`: the next bytes of the file, in base64, at most 262 144 bytes
  (256 KiB) before encoding. Chunks arrive in order, and only chunks for the open file count.
- `{"t":"fileEnd","id":…}`: the last chunk was sent. The receiver checks that it got exactly `size`
  bytes, moves the file into place, and answers with `fileResult`.
- `{"t":"fileResult","id":…,"ok":…,"error":…}`: how a file the other side sent ended. `error` is null
  when `ok` is true, otherwise a short reason of at most 100 characters.
- `{"t":"fileCancel","id":…}`: either side stops a transfer. The receiver deletes the partial file.
  The sender treats it as a failed file and sends no more chunks for it.

Rules:

- **One file at a time in each direction.** A sender waits for `fileResult` before it offers the
  next file. A `fileOffer` that arrives while another file from the same side is still open discards
  the open one.
- **A dropped connection** fails every file in flight on both sides. Partial files are deleted and
  nothing resumes.
- **Writing** waits for the socket to drain between chunks, so a big file never fills the sender's
  memory and other frames (texts, calls, pings) still get through between chunks.
- **The frame cap** stays 1 500 000 bytes. A 256 KiB chunk is 349 528 bytes of base64.
- **Partial files** are written beside the target under a hidden temporary name and renamed when
  `fileEnd` checks out. On the PC, publishing is a hard link to the free name, which never
  replaces a file. A file system without hard links (FAT, exFAT) gets a copy that refuses an
  existing name instead, so there the final name shows a growing file while the copy runs. Node
  has no rename that refuses to replace a file, and replacing one of the user's files is worse.

`protocol/sms-sync-vectors.json` pins these frames (`transferFrames`). Both apps' tests parse each
one, and the side that builds a frame must produce exactly the string given.

## PC changes (`desktop/`)

- `shared/sync-protocol.ts`: the new frames, parsed field by field. The `SyncMessage` limits stay
  as they are.
- `main/sms-sync.ts`: sending and receiving transfers and clipboard text over the phone's
  connection, and ending them when it drops.
- Clipboard on Linux under Wayland goes through `wl-paste --watch` and `wl-copy`. Electron cannot
  read or write the clipboard there while its window does not have focus (checked on 2026-11-22 under
  Hyprland). Elsewhere (Windows, X11) the app polls Electron's `clipboard` once a second and writes
  with it. Without `wl-clipboard` on Wayland the app polls Electron and logs that only copies made
  while the window has focus reach the phone.
- Pause during calls: MPRIS over the session D-Bus (`dbus-next`, already a dependency). It does
  nothing on Windows.
- Menus: "Send files to phone…" and "Send copied text to the phone" (a checkbox, on by default).

## Phone changes (`android/`)

- A share target activity with no UI of its own (`ACTION_SEND` and `ACTION_SEND_MULTIPLE` for any
  type). It sends what was shared and shows a short toast. When the PC is not connected, the toast
  says so and nothing is sent.
- A Quick Settings tile that opens a see-through activity. That activity reads the clipboard once it
  has focus, sends it and closes.
- Receiving: `clip` sets the phone's clipboard. Files go to Downloads through `MediaStore`, which
  needs no storage permission. A notification opens the file when the app may post notifications.
  Connect to PC asks for that permission like the others.

## After both apps update

Turn off KDE Connect's `pausemusic` plugin, or both apps pause and resume the same players.
