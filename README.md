# WeiWatch

A tiny self-hosted watch party. One person is the **host** and drives a shared browser; everyone else in the room follows along. There is a chat panel next to the browser, and access is limited to the accounts you list in `credentials.json`.

- **Host-authoritative sync** - the host's browser is the source of truth. The server only relays small events (URL, scroll, play/pause/seek, chat), so it stays cheap.
- **Shared browser panel** - pages are loaded through a lightweight proxy that injects a sync agent. HTML5 `<video>`/`<audio>` playback, scrolling and navigation are mirrored to viewers.
- **YouTube mode** - YouTube links are detected automatically and played through the YouTube IFrame API, with real play/pause/seek sync.
- **Manual accounts** - no database, no sign-up. Edit `credentials.json` and restart (or just save the file - it is re-read on the next login).
- **Dockerized** - one `docker compose up -d --build`.

## Quick start

```bash
git clone <your-repo-url> weiwatch
cd weiwatch

cp credentials.example.json credentials.json   # then edit your users
cp .env.example .env                           # then set SESSION_SECRET

# generate a secret
openssl rand -hex 32

docker compose up -d --build
```

Open `http://localhost:3000` (or whatever `PORT` you set) and sign in with a user from `credentials.json`.

## credentials.json

```json
{
  "users": [
    { "username": "alice", "displayName": "Alice", "password": "a-strong-password" },
    { "username": "bob", "displayName": "Bob", "passwordHash": "scrypt$..." }
  ]
}
```

- `username` - 2-32 chars, `a-z 0-9 . _ -` (stored lowercase).
- `displayName` - optional, shown in chat and the member list.
- `password` - plain text. Fine for a private instance, but hashes are better.
- `passwordHash` - generated with `npm run hash -- "your password"` (scrypt). Takes precedence over `password`.

The file is re-read when its modification time changes, so adding a user does not require a restart. The file is mounted read-only into the container.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Host port (compose maps it to container port 3000). |
| `SESSION_SECRET` | - | **Required in production.** Signs session cookies. |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS. |
| `TRUST_PROXY` | `false` | Set `true` behind nginx/Caddy/Traefik. |
| `HOST_GRACE_SECONDS` | `90` | How long a room waits for the host to reconnect. |
| `ROOM_IDLE_MINUTES` | `180` | Idle rooms are swept after this. |
| `PROXY_TIMEOUT_MS` | `20000` | Upstream fetch timeout for the proxy. |
| `PROXY_MAX_HTML_BYTES` | `8388608` | Max HTML page size the proxy will rewrite. |

## Using it

1. Sign in and click **Start a room as host**.
2. Copy the invite link (or share the 6-character room code).
3. Paste a URL in the browser bar. Viewers follow automatically.
4. Chat in the sidebar. The host badge shows who is driving.

If the host refreshes or loses connection, the room waits up to `HOST_GRACE_SECONDS` for them to return. The host key is stored in the browser, so a refresh restores host control. If the host does not return, the room closes.

### Modes

- **Auto** (default) - YouTube links use YouTube mode, everything else uses the proxy.
- **Proxy** - the page is fetched by the server, frame-blocking headers are stripped, and a sync agent is injected. Best for plain HTML5 video pages. Same-origin, so scroll and video state are read directly.
- **Direct** - the URL is loaded in a plain iframe. Only the URL is synced; use it for sites that allow embedding but break under the proxy.

## How the sync works

The server keeps a small in-memory room state and relays events between sockets. It never renders pages or decodes video.

- Host navigation, scroll, and media events are sent to the server and fanned out to the room.
- A heartbeat every 3 seconds carries the current URL, playback time, paused state, rate and scroll position. Viewers correct drift above ~1.5 seconds.
- Late joiners receive the current room state and apply it once their player is ready.
- The proxy injects `/sync-agent.js`, which intercepts link clicks and `pushState`, and reports `<video>`/`<audio>` events to the parent app.

## Deploying under a subpath (nginx)

The app uses relative asset/API paths and derives its Socket.IO path from the
current URL, so it can be mounted under a prefix such as `/weiwatch` without a
rebuild. Add the block from [`deploy/nginx-weiwatch.conf`](deploy/nginx-weiwatch.conf)
inside the HTTPS server block, then reload nginx:

```bash
nginx -t && systemctl reload nginx
```

When serving over HTTPS behind nginx, set `COOKIE_SECURE=true` and
`TRUST_PROXY=true` in `.env` and recreate the container.

## Security notes

- The proxy is **authenticated** and blocks private/loopback/link-local addresses (including redirect hops) to reduce SSRF risk.
- Proxied pages run on the same origin as the app. Only give accounts to people you trust; a hostile page could make same-origin requests. Session cookies are `HttpOnly` and `SameSite=Lax`.
- Put the app behind HTTPS in production and set `COOKIE_SECURE=true`.
- `credentials.json` and `.env` are gitignored. Do not commit them.

## Development

```bash
npm install
cp credentials.example.json credentials.json
SESSION_SECRET=dev-secret npm run dev
```

Then open `http://localhost:3000`.

Generate a password hash:

```bash
npm run hash -- "correct horse battery staple"
```

## Project layout

```
deploy/
  nginx-weiwatch.conf  sample nginx location block for a subpath deployment
server/
  index.js          Express + Socket.IO, auth routes, room relay
  auth.js           credentials.json loading, scrypt, signed cookies
  rooms.js          in-memory rooms and state
  proxy.js          authenticated page proxy with agent injection
  config.js         environment configuration
public/
  index.html        login
  app.html          room UI
  js/app.js         room client, browser panel, sync, chat
  js/login.js       login form
  sync-agent.js     injected into proxied pages
  css/style.css     styles
```

## Limitations

- DRM video (Netflix, Disney+, etc.) will not work in an iframe or through the proxy.
- Sites that rely heavily on same-origin `fetch`/XHR may break in proxy mode; try direct mode.
- The proxy does not forward cookies or POST bodies.
- Rooms are in memory; restarting the server ends active rooms.
