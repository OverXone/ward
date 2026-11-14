# Ward

Control your League of Legends client from your phone over your home Wi-Fi. Step away from your desk without missing the queue pop. From the phone you can:
- accept or decline ready checks
- start or cancel the queue
- hover, ban and lock in champions
- in ARAM, reroll and swap with the bench; in modes that offer you a few champions, pick one of them
- accept, decline or ask for role swaps, pick-order swaps and champion trades
- choose your summoner spells, skin and chroma
- join or decline lobby invitations, and invite online friends to your lobby
- read and write in the lobby chat and your team's champ select chat

There's no cloud and no accounts. Everything stays on your local network. The only thing Ward fetches from the internet is its own updates, from this GitHub repository.

**[Download the latest Ward.exe](https://github.com/OverXone/ward/releases/latest)** (Windows)

## Install and use (Windows)

1. **Download `Ward.exe`** from the [Releases page](https://github.com/OverXone/ward/releases/latest) and put it anywhere, for example on your desktop. It's a single file (about 90 MB) with nothing to install.
2. **Double-click it.** Windows may warn you first:
   - **"Windows protected your PC" (SmartScreen):** click **More info**, then **Run anyway**. It appears because the exe isn't code-signed.
   - **Windows Firewall:** the app shows up as **Ward**. Tick **Private networks** only and **untick Public networks**, then click **Allow**. Your phone can't connect without this.
3. **Connect your phone** (same Wi-Fi as the PC). You only do this once per phone:
   - **Scan the QR code** in the window with your phone camera. That signs the phone in, with nothing to type. Or
   - open the address the window shows (like `http://192.168.1.20:47800`) and type the 8-character code.
4. **That's it.** Once your phone is paired, the window hides and Ward keeps running in the tray (the icon near the clock). Start League whenever you like; Ward finds it on its own.

Good to know:
- **Ward lives in the tray.** Closing the window doesn't quit Ward; it keeps running in the background so your phone stays connected. Click the Ward icon in the tray to open the window again, or right-click it and choose **Quit Ward**. You can also type `quit` or press Ctrl+C in the window. Windows 11 may hide new tray icons behind the **^** arrow next to the clock; drag the Ward icon onto the taskbar to keep it in sight. Double-clicking `Ward.exe` while it's running just opens its window. The tray icon is drawn by Windows PowerShell, so Windows may list it under that name in its notification settings. If the tray icon can't be shown, closing the window quits Ward, as in older versions. To run Ward in its window only, without the tray, start it with `Ward.exe --no-tray`.
- **Ward updates itself.** Each time you start it, it checks GitHub for a newer version. If there is one, it downloads it, replaces `Ward.exe` and restarts. Phones reconnect and load the new version by themselves. While it runs, it checks every few hours and tells you when an update is out: type `update` in the window, or right-click the tray icon and choose **Update**. Every update is signed, and Ward installs only files signed with its release key. To turn this off, start it with `Ward.exe --no-update-check`. Versions before 0.4.0 don't update themselves, so download 0.4.0 once by hand.
- **The PC remembers your phone.** After you pair once, the phone connects by itself every time you start Ward. The window lists remembered phones at startup. To remove one, type `forget 1` (its number) or `forget all` in the window, or tap **Unpair this phone** on the phone. A phone that hasn't connected for 30 days is forgotten.
- **Pairing another phone:** the QR code works once, and the typed code works once for 5 minutes. Press **Enter** in the window for new ones. Type `phones` to list remembered phones.
- **If your PC's address changes** (rare: your router usually gives the PC the same one each time), the window says so. Scan the QR code once more, and add the home-screen icon again, because the old icon points to the old address.
- **Add it to your home screen** (browser menu, "Add to Home Screen") so it opens like an app. On iPhone the icon doesn't share Safari's login, so open the icon and type the code there once.
- **Favorite champions:** long-press a champion in the grid to star it. When you're picking, starred champions come first.
- **Swaps:** a teammate's swap request pops up with Accept and Decline. To ask someone, tap a teammate with the ⇄ badge.
- **ARAM:** a **Bench** panel lists the bench champions (tap one to swap) and a **Reroll** button shows how many rerolls you have left. When League offers you only a few champions, the phone shows just those as big tiles.
- **Spells and skin:** tap a spell under the teams to change it (choosing the other slot's spell swaps them). After you lock in, a **Skin** button lists the skins and chromas you own.
- **Runes** aren't on the phone; set them in the PC client or with a tool like Mobalytics. (The last version with a rune page picker is tagged `with-runes` in git.)
- **Invitations:** when someone invites you, a card with **Join** and **Decline** appears on every screen. In your lobby, **Invite friends** lists friends who are online in League.
- **Chat:** in the lobby and while queued, **Lobby chat** shows the latest message; in champ select, the chat button sits next to the timer. A red number counts unread messages and the phone buzzes briefly when a teammate writes. Messages are up to 200 characters. In champ select, teammates whose names League hides show as "Ally 2" and so on, the same as in the team list.
- **Don't show the window on stream or screen share.** Until it's used, the QR code signs in whoever scans it on your Wi-Fi.

### Phone can't open the page?

- **Firewall:** if you clicked the wrong option or Cancel, Windows saved a **Block** rule and won't ask again. To fix it:
  1. Press Start, type **Windows Defender Firewall with Advanced Security**, open it and click **Inbound Rules**.
  2. Delete every rule named **Ward**, **ward.exe** or **Node.js JavaScript Runtime** (older versions) whose program path ends in `Ward.exe` (usually one for TCP, one for UDP).
  3. Start `Ward.exe` again and answer the prompt: **Private** ticked, **Public** unticked.
- **Wi-Fi set to Public:** if Windows treats your home Wi-Fi as a public network, the Private rule doesn't apply. Open **Settings → Network & internet → Wi-Fi → (your network)** and set **Network profile type** to **Private**.
- Type `http://`, not `https://`. The connector logs a warning when a phone tries `https`.
- The phone must be on the same home Wi-Fi (not guest Wi-Fi, not mobile data).
- **Brave:** allow the site's local network permission when Brave asks (or in the site settings).
- **PC with several networks** (VPN, virtual adapters): the window lists the other addresses it found. Start it from a terminal with `Ward.exe --host <ip>` to pick one.
- The connector logs every connection attempt and every refused request, so check its window.

## Developer quick start

Requires Node 24+.

```bash
npm install
npm test               # unit + LAN server tests
npm run smoke          # end-to-end against the mock League client
```

### Test mode against your real client (read-only)

```bash
npm run events               # prints discovery, probes every endpoint, then live events
npm run events -- --dump     # also saves events to lcu-events-*.jsonl (ids, names, chat creds scrubbed)
npm run events -- --all      # also lists every other LCU event URI
npm run api-list -- received-invitations lol-chat/v1/friends   # endpoints + types from the client's own API list (GET /help)
npm run api-list -- --save   # also saves the whole list to lcu-help.json (gitignored)
```

`--events` only reads from the client (it sends GETs). It never queues, accepts or picks.

### Run the phone server

```bash
npm run build:web      # build the phone UI once (or: npm run watch:web while editing)
npm run dev
```

While `watch:web` is running, reloading the page on the phone picks up a fresh build. You don't need to restart the connector.

The connector prints a QR code and a pairing code. Your phone must be on the same Wi-Fi.
- **Scan the QR code** with your phone camera. The link carries a one-time ticket after `#` (`/#p=…`), which the phone trades for its own key. Or
- **open `http://<pc-ip>:47800`** on the phone and type the 8-character code. The code works once and lasts 5 minutes; press Enter in the connector window for a new one.

Each paired phone gets its own random key. The connector saves only a SHA-256 hash of it, in `%APPDATA%\Ward\phones.json`. Set `WARD_DATA_DIR` to use another folder (the smoke test does). Commands in the window: Enter (new QR code and code), `phones`, `forget <number>`, `forget all`, `update`, `quit`.

`Ward.exe` runs in two parts, because Windows ends a console program a few seconds after its window is closed, whatever the program does. The background Ward (started with `--background`, no window) runs the phone server, the League connection and the tray icon. Each window is a separate `Ward.exe` that shows the background Ward's output and passes typed commands to it, over a named pipe whose name and secret are in `%APPDATA%\Ward\instance.json`. See `connector/src/instance.ts` and `connector/src/tray.ts`. Run from source (`npm run dev`), Ward is one console program without a tray icon.

Options:
- `--no-update-check` doesn't look for updates (only `Ward.exe` updates itself; from source it never does).
- `--no-tray` runs `Ward.exe` in its window only, like older versions: closing the window quits it.
- `--host <ip>` picks the network adapter.
- `--port <n>` changes the port (default 47800).
- `--league-dir <dir>` uses only the lockfile in that folder.

When run from source, the firewall prompt and rule are for `node.exe` instead. Allow it on Private networks only, as above.

### Build the exe

```bash
npm run build:exe      # -> dist/Ward.exe
```

This builds the phone UI and bundles the connector with esbuild. Then it embeds both into a copy of your `node.exe` as a Node single executable application (SEA). Before that, `resedit` replaces the copy's version info and icon, so Windows shows "Ward" instead of "Node.js JavaScript Runtime". It also drops Node's code signature, which the injection would break anyway. Build on Windows with Node 24. The exe isn't signed.

### Release a version

Releases are built by GitHub Actions (`.github/workflows/release.yml`), so every user gets the update:

1. Bump `version` in `package.json` (and in `connector/package.json` and `web/package.json`), then commit.
2. Tag and push: `git tag v0.4.0`, then `git push origin main v0.4.0`.
3. The workflow checks that the tag matches `package.json`, runs the tests, builds `Ward.exe`, signs it and attaches `Ward.exe` and `ward-update.json` to a **draft** release.
4. On GitHub, write the notes and click **Publish**. Running copies of Ward see the update only once it's published.

The signature: `ward-update.json` holds the version, SHA-256 and size of `Ward.exe`, signed with an ed25519 key. The public half is `UPDATE_PUBLIC_KEY` in `connector/src/update.ts`. The private half is the repository secret `WARD_UPDATE_KEY` (the PEM text), and only the workflow uses it. Keep an offline copy: if it's lost, installed copies can't verify updates any more, and users have to download the next version by hand. To sign a local build: `npm run sign:exe -- --key <file.pem>`.

The logo is `branding/ward.svg`. `scripts/logo.mjs` draws the same artwork for the exe icon and the phone icons (`npm run icons -w web` rewrites the ones in `web/public`).

### Without the game: mock client

```bash
npm run mock-lcu
```

Then, in another terminal, run the `npm run dev -- --league-dir "<dir it prints>"` command it shows.

Keys in the mock window:
- `l` lobby
- `q` queue
- `r` ready check
- `c` champ select
- `n` finish the current turn
- `g` in game
- `0` client idle
- `s` / `o` / `t` a teammate asks you for a role swap / pick-order swap / champion trade
- `i` a friend invites you to their Ranked Flex lobby
- `w` a teammate writes in the lobby or champ select chat (in a solo lobby, a friend joins first); whatever you send gets a reply
- `f` freeze (stop answering, like a hung client); `f` again to unfreeze

`npm run mock-lcu -- --no-complete` simulates a client without `POST …/complete`, to test the lock-in fallback.

## Security model (short)

- **New 32-byte token every launch.** The phone gets it through the QR code or a one-time pairing code, then sends it on every API call and in the first websocket frame. Comparisons are constant-time. After 10 failed attempts, that IP is locked out for 60 s.
- **LAN only.** The connector listens on one private LAN IPv4 address, never `0.0.0.0`, and rejects any client whose IP isn't private (10/8, 172.16/12, 192.168/16). The `Host` and `Origin` checks block DNS rebinding.
- **Not a proxy.** The phone can trigger only these actions: accept, decline, start queue, cancel queue, hover, lock, set spells, set skin, accept/decline/request/cancel a swap, accept/decline an invitation and invite a friend. Inputs are validated against the client's own current lists (pickable or bannable champions, spells for this mode that you own, skins you've unlocked, pending invitations, online friends). The connector decides which champ-select action or swap is yours; the phone never sends an action or swap id. Invitations and friends reach the phone as random per-launch handles, never as League ids, and every handle is checked against a fresh list from the client before anything is sent.
- **TLS verification is skipped for 127.0.0.1 only.** It's turned off on one HTTPS agent that only talks to the local League client. It's never turned off globally.
- **No secrets in the console.** The token and the League client password are never printed. The token only appears encoded inside the QR code.
- **Plain HTTP on your LAN.** That's fine on your own home Wi-Fi. Don't use it on public or shared Wi-Fi.
- **Signed updates.** `Ward.exe` installs an update only if its version, SHA-256 and size are signed by the release key built into it. A newer version number is required, so an old release can't be passed off as an update.

This uses the League client's unofficial local API, the same way Mimic, Blitz and Porofessor do.

## License

Ward is free for any **noncommercial** use: play with it, change it, share it, fork it. You can't sell it or use it to make money. The exact terms are the [PolyForm Noncommercial License 1.0.0](LICENSE.md). If you'd like to use it commercially, open an issue and ask.

## Credits

Ward's champion select logic is adapted from [Mimic](https://github.com/molenzwiebel/Mimic) by Thijs Molendijk (MIT License). See [NOTICE](NOTICE).

## Legal

Ward isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
