# Ward — Plan (v1, for review)

Control the League client from a phone over the local Wi-Fi. One Windows `.exe` (the connector) plus a phone web UI that the exe serves. No cloud, no accounts.

---

## 1. What I took from Mimic (and the port-or-rewrite decision)

I read `molenzwiebel/Mimic/web` (Vue 2.6, class components, `vue-property-decorator`, Stylus, about 4.9k lines across 30 components).

**Decision: write it fresh in Vue 3 + Vite, and copy Mimic's *logic* (not its components), with MIT attribution.** Reasons:

1. **The architecture is the opposite of what we need.** Every Mimic component calls `$root.request(anyPath, anyMethod, body)` and `$root.observe(anyRegex)`. That is a generic LCU proxy, which your security rules forbid. Each component would need its data layer rewritten anyway.
2. **A port to Vue 3 is still a rewrite.** Class components, decorators and `$parent` coupling (champion-picker reads `$parent.championDetails`) don't carry over to Vue 3's `<script setup>`. Each file changes almost line by line.
3. **It gets assets from the internet.** Mimic loads champion data and icons from ddragon. We proxy `/lol-game-data` through the connector instead.
4. **The MVP is small.** It needs 6 screens and maybe 800 lines of UI. Writing them fresh is faster than adapting 4.9k lines.

**What I reuse (credited in `NOTICE` and in file headers):**
- How to compute the current turn: the first entry in `actions[][]` with an uncompleted action, but only during phase `BAN_PICK`.
- During `PLANNING`, hovering a champion means patching your *first uncompleted pick action* (this is pick intent).
- The selectable list: pickable or bannable ids (depending on the action type), minus champions already banned.
- Ready-check UX: a sound plus `navigator.vibrate`, and the iOS trick that unlocks audio on the first touch. The progress bar is based on `timer`.
- Queue screen: `/lol-matchmaking/v1/search` for `timeInQueue` and `estimatedQueueTime`, plus the penalty and dodge-timer errors.
- Mimic locks in with `PATCH actions/{id} {championId, completed:true}`. You listed `POST actions/{id}/complete`. I'll use `/complete` first and fall back to the PATCH form only if the client returns 404. **You need to verify which one works.**

Vue 3 rather than Preact or vanilla JS: later features (runes, skins, summoner spells, lobby and invites) can follow Mimic's component structure more closely.

## 2. Stack

| Part | Choice | Why |
|---|---|---|
| Runtime | Node 24 LTS (you have 24.22.1) | The same runtime is used in dev and in the exe |
| Language | TypeScript everywhere | |
| Connector HTTP | Node built-in `http` with a small hand-written router | No Express. The attack surface is only routes I wrote. |
| Connector WS | `ws` (pure JS) | Used for both the LCU socket and the phone socket |
| QR | `qrcode` (`toString({type:'terminal'})`) | Maintained and pure JS |
| Bundler | `esbuild` → one CJS file | Node SEA needs a single script |
| Web UI | Vue 3 + Vite, no router, one reactive store | Screens follow gameflow phase, not URLs |
| Tests | `vitest` with recorded LCU JSON fixtures | Lets me test champ-select logic without a client |
| **Packaging** | **Node SEA** (`--experimental-sea-config` + `postject`) | See below |

**Why Node SEA:**
- **`pkg`** (Vercel) is archived. The `yao-pkg` fork works, but it patches Node with its own toolchain, and new Node versions arrive late.
- **`bun build --compile`** works, but it changes the runtime. Bun's `https`/`ws`/TLS behaviour on Windows has edge cases, and LCU TLS behaviour is exactly the fragile part of this app. Bun also isn't installed here.
- **Node SEA** is official and built into Node 24. The exe runs the same Node I test with. Embedded files (the built web UI) go in through the `assets` field of `sea-config.json` and are read with `sea.getAsset()`. The cost: the exe is about 80 MB, and it's unsigned. An unsigned exe means Windows SmartScreen shows "unknown publisher", and some antiviruses flag it. All three tools have the unsigned-exe problem.

## 3. File structure

```
Ward/
  package.json            npm workspaces: connector, web; scripts: dev, test, build, build:exe
  NOTICE                  Mimic MIT attribution
  README.md
  connector/
    src/
      main.ts             CLI entry: flags --events (test mode), --host <ip>, --port <n>
      log.ts              logger that redacts token / password / ?t= values
      lcu/discovery.ts    1) PowerShell Get-CimInstance → LeagueClientUx.exe cmdline (--app-port, --remoting-auth-token)
                          2) fallback: lockfile (install dir from process path, Riot product_settings.yaml, default C:\Riot Games\League of Legends)
      lcu/http.ts         request() to https://127.0.0.1:<port>; a dedicated https.Agent with rejectUnauthorized:false used ONLY here
      lcu/socket.ts       WAMP: send [5,"OnJsonApiEvent"], parse [8,...], filter by URI whitelist
      lcu/manager.ts      lifecycle: poll every 2 s while disconnected → connect → on close/err go back to polling
      state/champ-select.ts  pure: findMyAction(session), currentTurn, bans, teams → tested with fixtures
      state/store.ts      derived PhoneState (sanitised; no puuids/summoner ids sent to the phone) + change events
      actions.ts          registry of whitelisted actions {name, validate(input, state), run(lcu)}
      server/net.ts       pick LAN IPv4 (RFC1918, skip vEthernet/WSL/VirtualBox/VMware/Hyper-V), isPrivate(ip)
      server/auth.ts      32-byte token, timingSafeEqual on SHA-256 digests, per-IP failure rate limit
      server/http.ts      static UI + /api routes; Host-header check (DNS-rebinding guard); security headers
      server/phone-ws.ts  phone socket: first message must be {auth: token} within 3 s, then state pushes
      assets.ts           web UI from sea.getAsset() in the exe, from web/dist in dev
    test/                 vitest specs + fixtures/*.json (champ select sessions: draft, blind, ARAM, planning)
  web/
    index.html  vite.config.ts  public/manifest.webmanifest  public/icons/*
    src/
      main.ts  App.vue  store.ts  api.ts        api.ts: token from ?t= → localStorage, strip URL, auth header, WS reconnect
      screens/  NotConnected.vue  Pair.vue  Lobby.vue  Queue.vue  ReadyCheck.vue  ChampSelect.vue  InGame.vue
      components/ ChampGrid.vue  TeamColumn.vue  BanRow.vue  PhaseTimer.vue
  scripts/build-exe.mjs   vite build → esbuild bundle → sea-config (assets = web/dist/**) → node --experimental-sea-config → postject
```

The design leaves room for later features. A new feature (summoner spells, runes, skins, lobby) means a new entry in `actions.ts`, a new derived slice in `store.ts`, and a new component. The core doesn't change.

## 4. LCU endpoints used (all of them; nothing else is reachable)

Every endpoint below needs to be **verified against your current client**. I'll provide a test mode that hits each GET endpoint and prints the status and payload shape.

| Purpose | Method + path | Notes |
|---|---|---|
| Phase | `GET /lol-gameflow/v1/gameflow-phase` | WS: same URI |
| Lobby (can I start?) | `GET /lol-lobby/v2/lobby` | `canStartActivity`, `localMember.isLeader`, queue id |
| Queue name | `GET /lol-game-queues/v1/queues/{id}` | display only |
| Queue state | `GET /lol-matchmaking/v1/search` | timer, estimate, penalty errors |
| Start queue | `POST /lol-lobby/v2/lobby/matchmaking/search` | |
| Cancel queue | `DELETE /lol-lobby/v2/lobby/matchmaking/search` | |
| Ready check | `GET /lol-matchmaking/v1/ready-check` | `state`, `timer`, `playerResponse` |
| Accept / decline | `POST /lol-matchmaking/v1/ready-check/accept` · `/decline` | |
| Champ select | `GET /lol-champ-select/v1/session` | WS: same URI (Create/Update/Delete) |
| Pickable / bannable | `GET /lol-champ-select/v1/pickable-champion-ids` · `/bannable-champion-ids` | re-fetched on every hover/lock for validation |
| Hover | `PATCH /lol-champ-select/v1/session/actions/{id}` `{championId}` | id chosen **by the server**, never sent by the phone |
| Lock | `POST /lol-champ-select/v1/session/actions/{id}/complete` | fallback `PATCH {championId, completed:true}` on 404 |
| Champion list | `GET /lol-game-data/assets/v1/champion-summary.json` | cached per LCU session; filtered to `{id,name,alias}` |
| Icons | `GET /lol-game-data/assets/v1/champion-icons/{id}.png` | id must be an integer present in the champion summary; cached in memory |

LCU websocket subscription: `OnJsonApiEvent`. Events are dropped unless their `uri` is one of: gameflow-phase, lobby, matchmaking/search, ready-check, champ-select/session, and the pickable and bannable id lists.

## 5. Phone ⇄ connector API (the whole surface)

Every route except the static UI shell needs `Authorization: Bearer <token>`. The UI shell is the HTML/JS/CSS, which contains no secrets.

```
GET  /api/state                   → PhoneState snapshot
GET  /api/champions               → [{id, name, alias}]
GET  /api/champions/:id/icon      → image/png  (fetched as blob by the UI so the header can be sent)
POST /api/ready-check/accept | /api/ready-check/decline
POST /api/queue/start | /api/queue/cancel
POST /api/champ-select/hover  {championId:int}
POST /api/champ-select/lock   {}   (locks whatever is hovered on my active action)
WS   /ws   first frame {type:"auth", token}; then server pushes {type:"state", state}
```

How the connector validates a request:
- The body is JSON, at most 1 KB, and contains only known keys. `championId` must satisfy `Number.isInteger`, be greater than 0, and be in the *fresh* pickable or bannable list for the type of my current action.
- The phase must match the action. Ready-check actions only work while a ready check is in progress. Champ-select actions only work while I have an active, uncompleted action (or pick intent during `PLANNING`).
- Everything else returns 404.

## 6. Security design

1. **Token:** `crypto.randomBytes(32)` encoded as base64url, newly generated at every launch. Comparison uses `timingSafeEqual` on SHA-256 digests of both values, so lengths always match. After 10 failed attempts an IP is locked out for 60 s.
2. **Binding:** the connector picks one RFC1918 IPv4 address on a physical adapter and binds to it only, never `0.0.0.0`. If several qualify, it lists them and uses the first; `--host` overrides. Every request also checks `remoteAddress` against private ranges (10/8, 172.16/12, 192.168/16, with IPv6-mapped forms normalised) and rejects anything else.
3. **DNS rebinding / CSRF:** `Host` must equal `<lan-ip>:<port>`. On the phone websocket, `Origin` must equal `http://<lan-ip>:<port>`. There is no cookie auth, so CSRF doesn't apply.
4. **Not a proxy:** this is the whitelist in §4/§5. The LCU path is built only from constants plus a validated integer.
5. **LCU TLS:** a dedicated `https.Agent({rejectUnauthorized:false})` is passed only to LCU calls, and the host is hard-coded to `127.0.0.1`. `NODE_TLS_REJECT_UNAUTHORIZED` is never touched. *Optional hardening:* pin Riot's published root CA (`riotgames.pem`) instead. I can try that if you want; you'd have to confirm it works on your client.
6. **Logging:** never logs the token, the LCU password, the Authorization header, or the `?t=` query. The QR code necessarily contains the token, so it's printed only to the console and never to a log file.
7. **Response headers:** CSP `default-src 'self'` (no inline scripts), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, so the token URL doesn't leak, and `Cache-Control: no-store` on `/api`.
8. **The phone strips `?t=`** from the address bar with `history.replaceState` right after saving it to localStorage.

**Known limits (I'd put these in the README):**
- **Traffic is plain HTTP on the LAN.** On home Wi-Fi (WPA2/3) that's fine. On shared or public Wi-Fi, anyone on that network could sniff the token and tap Accept or Decline for you. HTTPS would need a self-signed certificate installed on each phone, which goes against "easy to install".
- **"Installable PWA" is limited over plain HTTP.** Browsers only allow service workers and true PWA install on HTTPS. On iPhone, *Add to Home Screen* still gives a full-screen app. On Android it's likely only a home-screen shortcut that opens in Chrome. **You need to check this on your phone.** Vibration only works on Android; iOS has no Vibration API, so iPhone gets the sound alert instead.

## 7. Decided: one-time pairing code (option A)

The connector prints a QR code and an 8-character pairing code (`XXXX-XXXX`, Crockford base32). The code is valid for 5 minutes, allows 5 attempts in total, and works once. The phone sends `POST /api/pair {code}` and receives `{token}`. Pressing Enter in the connector window prints a new code. The session token still changes on every launch.

### Original options considered: a new token on every launch vs. the iPhone home-screen app

On iOS, a home-screen web app has **separate storage from Safari**. Scanning a new QR code each launch opens Safari, so the home-screen app keeps the old token. (Android usually opens the link in the right place.) Options:

- **A (recommended):** the connector also prints a short **one-time pairing code** (8 chars, base32, valid 5 min, 5 attempts). The phone app has a "Enter code" field and exchanges the code for the real token. The token still changes every launch, and brute force isn't feasible.
- **B:** QR only. iPhone users use Safari instead of the home-screen icon.
- **C:** an opt-in `--remember` flag that keeps the token in `%APPDATA%` between launches. This weakens your "new token each launch" rule.

Related: the phone app's origin is `http://<ip>:<port>`. I'll use a fixed default port (**47800**) so the origin stays stable. If the PC's LAN IP changes (DHCP), the home-screen icon stops working until it's re-added. A DHCP reservation on the router avoids this.

## 8. Build order and how you verify

1. **Connector + test mode.** Running `ward --events` (or `npm run dev:events`) does the following:
   - prints discovery (method used, port, PID; never the password)
   - prints a GET probe of every §4 endpoint
   - prints a live line per whitelisted LCU event (`uri`, `eventType`, a summary of the data)
   - reconnects when you close and reopen the client
   - **You check:** discovery works with no admin rights; events show while you queue, accept and enter champ select; reconnect works.
2. **Phone UI.** `npm run dev` serves both the UI and the API with the QR code. Unit tests cover my-action detection on fixture sessions.
   - **You check:** hover, lock, and ban in a real draft (a custom game with bots doesn't have bans, so use draft or ranked with a friend); accept and decline; start and cancel the queue.
3. **Packaging.** `npm run build:exe` → `dist/Ward.exe` + README.
   - **You check:** the exe runs on a PC without Node; the firewall prompt appears; the phone connects.

Things I **cannot** verify here (no League client on this machine, as far as I know):
- the current endpoint paths and payloads
- `/complete` vs the `PATCH completed` lock-in
- whether reading the `LeagueClientUx.exe` command line works without admin rights
- the lockfile location on your install
- real WS event shapes
