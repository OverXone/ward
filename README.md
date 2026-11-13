# Ward

Control your League of Legends client from your phone over your home Wi-Fi. From the phone you can:
- accept or decline ready checks
- start or cancel the queue
- hover, ban and lock in champions
- accept, decline or ask for role swaps, pick-order swaps and champion trades

There's no cloud and no accounts. Everything stays on your local network.

## Install and use (Windows)

1. **Get `Ward.exe`** and put it anywhere, for example on your desktop. It's a single file (about 90 MB) with nothing to install.
2. **Double-click it.** Windows may warn you first:
   - **"Windows protected your PC" (SmartScreen):** click **More info**, then **Run anyway**. It appears because the exe isn't code-signed.
   - **Windows Firewall:** the app shows up as **"Node.js JavaScript Runtime"**. Tick **Private networks** only and **untick Public networks**, then click **Allow**. Your phone can't connect without this.
3. **Connect your phone** (same Wi-Fi as the PC):
   - **Scan the QR code** in the window with your phone camera, or
   - open the address the window shows (like `http://192.168.1.20:47800`) and type the 8-character code.
4. **Keep the window open while you play.** Start League whenever you like; the connector finds it on its own.

Good to know:
- **Each launch is a new session.** After you restart the connector, scan the QR code or enter a code again. A code works once and lasts 5 minutes. Press **Enter** in the window for a new one.
- **Add it to your home screen** (browser menu, "Add to Home Screen") so it opens like an app.
- **Favorite champions:** long-press a champion in the grid to star it. When you're picking, starred champions come first.
- **Swaps:** a teammate's swap request pops up with Accept and Decline. To ask someone, tap a teammate with the ⇄ badge.
- **Don't show the window on stream or screen share.** The QR code is your phone's login key for that session.

### Phone can't open the page?

- **Firewall:** if you clicked the wrong option or Cancel, Windows saved a **Block** rule and won't ask again. To fix it:
  1. Press Start, type **Windows Defender Firewall with Advanced Security**, open it and click **Inbound Rules**.
  2. Delete every rule named **ward.exe** or **Node.js JavaScript Runtime** whose program path ends in `Ward.exe` (usually one for TCP, one for UDP).
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
```

`--events` only reads from the client (it sends GETs). It never queues, accepts or picks.

### Run the phone server

```bash
npm run build:web      # build the phone UI once (or: npm run watch:web while editing)
npm run dev
```

While `watch:web` is running, reloading the page on the phone picks up a fresh build. You don't need to restart the connector.

The connector prints a QR code and a pairing code. Your phone must be on the same Wi-Fi.
- **Scan the QR code** with your phone camera, or
- **open `http://<pc-ip>:47800`** on the phone and type the 8-character code. The code works once and lasts 5 minutes; press Enter in the connector window for a new one.

Options:
- `--host <ip>` picks the network adapter.
- `--port <n>` changes the port (default 47800).
- `--league-dir <dir>` uses only the lockfile in that folder.

When run from source, the firewall prompt and rule are for `node.exe` instead. Allow it on Private networks only, as above.

### Build the exe

```bash
npm run build:exe      # -> dist/Ward.exe
```

This builds the phone UI and bundles the connector with esbuild. Then it embeds both into a copy of your `node.exe` as a Node single executable application (SEA). Build on Windows with Node 24. The exe isn't signed; `postject` warns that the copied `node.exe` signature is now invalid, which is expected.

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
- `f` freeze (stop answering, like a hung client); `f` again to unfreeze

`npm run mock-lcu -- --no-complete` simulates a client without `POST …/complete`, to test the lock-in fallback.

## Security model (short)

- **New 32-byte token every launch.** The phone gets it through the QR code or a one-time pairing code, then sends it on every API call and in the first websocket frame. Comparisons are constant-time. After 10 failed attempts, that IP is locked out for 60 s.
- **LAN only.** The connector listens on one private LAN IPv4 address, never `0.0.0.0`, and rejects any client whose IP isn't private (10/8, 172.16/12, 192.168/16). The `Host` and `Origin` checks block DNS rebinding.
- **Not a proxy.** The phone can trigger only these actions: accept, decline, start queue, cancel queue, hover, lock, and accept/decline/request/cancel a swap. Inputs are validated against the client's current pickable or bannable lists. The connector decides which champ-select action or swap is yours; the phone never sends an action or swap id.
- **TLS verification is skipped for 127.0.0.1 only.** It's turned off on one HTTPS agent that only talks to the local League client. It's never turned off globally.
- **No secrets in the console.** The token and the League client password are never printed. The token only appears encoded inside the QR code.
- **Plain HTTP on your LAN.** That's fine on your own home Wi-Fi. Don't use it on public or shared Wi-Fi.

This uses the League client's unofficial local API, the same way Mimic, Blitz and Porofessor do. It's not endorsed by Riot.
