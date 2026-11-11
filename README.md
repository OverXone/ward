# Ward

Control your League of Legends client from your phone over your home Wi-Fi. From the phone you can:
- accept or decline ready checks
- start or cancel the queue
- hover, ban and lock in champions

There's no cloud and no accounts. Everything stays on your local network.

> **Status:** the connector (step 2) is done. The phone UI (step 3) and the single `.exe` (step 4) are next.
> Until then, the phone page at `http://<pc-ip>:47800` is only a placeholder.

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
npm run dev
```

The connector prints a QR code and a pairing code. Your phone must be on the same Wi-Fi.
- **Scan the QR code** with your phone camera, or
- **open `http://<pc-ip>:47800`** on the phone and type the 8-character code. The code works once and lasts 5 minutes; press Enter in the connector window for a new one.

Options:
- `--host <ip>` picks the network adapter.
- `--port <n>` changes the port (default 47800).
- `--league-dir <dir>` uses only the lockfile in that folder.

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

`npm run mock-lcu -- --no-complete` simulates a client without `POST …/complete`, to test the lock-in fallback.

## Security model (short)

- **New 32-byte token every launch.** The phone gets it through the QR code or a one-time pairing code, then sends it on every API call and in the first websocket frame. Comparisons are constant-time. After 10 failed attempts, that IP is locked out for 60 s.
- **LAN only.** The connector listens on one private LAN IPv4 address, never `0.0.0.0`, and rejects any client whose IP isn't private (10/8, 172.16/12, 192.168/16). The `Host` and `Origin` checks block DNS rebinding.
- **Not a proxy.** The phone can trigger only these actions: accept, decline, start queue, cancel queue, hover, lock. Inputs are validated against the client's current pickable or bannable lists. The connector decides which champ-select action is yours; the phone never sends an action id.
- **TLS verification is skipped for 127.0.0.1 only.** It's turned off on one HTTPS agent that only talks to the local League client. It's never turned off globally.
- **No secrets in the console.** The token and the League client password are never printed. The token only appears encoded inside the QR code.
- **Plain HTTP on your LAN.** That's fine on your own home Wi-Fi. Don't use it on public or shared Wi-Fi.

This uses the League client's unofficial local API, the same way Mimic, Blitz and Porofessor do. It's not endorsed by Riot.
