# TS3 → TS6 Server Roles Transfer

> A self-hosted web app that lets your users transfer their TeamSpeak 3 server groups to a TeamSpeak 6 server — verified by IP address.

Built with **Node.js**, **Express**, and **Docker**. Connects to TS3 via [ts3-nodejs-library](https://github.com/Multivit4min/TS3-NodeJS-Library) (ServerQuery, port 10011) and to TS6 via its HTTP ServerQuery API (port 10080).

---

## How It Works

1. User opens the web page — the app detects their **public IP address**
2. Queries the **TS3** server for clients connected from that IP
3. Queries the **TS6** server for clients connected from that IP
4. If **exactly one account** is found on each server — transfers the server groups (by group ID) from TS3 to TS6
5. If **more than one account** is detected on either server from the same IP — the transfer is **blocked** and an error is shown

This prevents abuse and ensures a 1-to-1 identity mapping between TS3 and TS6 accounts.

---

## Features

- **IP-based verification** — no login required, fully automatic identity matching
- **Duplicate detection** — blocks transfer if multiple accounts share the same IP
- **Group names** — displays human-readable server group names (not just IDs)
- **Multi-language support** — ships with Polish and English; add your own in `/locales`
- **Custom branding** — set your logo via `.env`
- **Rate limiting** — prevents spam (30s cooldown between transfers)
- **Docker-ready** — single `docker compose up` to deploy
- **Reverse proxy support** — proper `X-Forwarded-For` handling behind nginx

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/mrfroncu/ts-rank-transfer.git
cd ts-rank-transfer
```

### 2. Configure

```bash
cp .env.example .env
nano .env
```

Fill in your TeamSpeak server details:

```env
# TeamSpeak 3
TS3_HOST=192.168.1.100
TS3_QUERY_PORT=10011
TS3_USERNAME=serveradmin
TS3_PASSWORD=your_password
TS3_SERVER_ID=1

# TeamSpeak 6
TS6_HOST=192.168.1.100
TS6_QUERY_PORT=10080
TS6_USERNAME=serveradmin
TS6_PASSWORD=your_password
TS6_API_KEY=your_api_key
TS6_SERVER_ID=1

# Connect buttons (public addresses for users)
TS3_CONNECT_ADDRESS=ts3.example.com
TS6_CONNECT_ADDRESS=ts6.example.com

# Web
WEB_PORT=5540
LOGO_URL=https://example.com/logo.png
LANGUAGE=EN          # PL or EN
TRUST_PROXY=false    # true if behind nginx
```

### 3. Run with Docker

```bash
docker compose up -d --build
```

The app is now running at `http://your-server:5540`

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `TS3_HOST` | `127.0.0.1` | TS3 server IP address |
| `TS3_QUERY_PORT` | `10011` | TS3 ServerQuery port |
| `TS3_USERNAME` | `serveradmin` | ServerQuery username |
| `TS3_PASSWORD` | — | ServerQuery password |
| `TS3_SERVER_ID` | `1` | Virtual server ID |
| `TS6_HOST` | `127.0.0.1` | TS6 server IP address |
| `TS6_QUERY_PORT` | `10080` | TS6 HTTP query port |
| `TS6_SSH_PORT` | `10022` | TS6 SSH query port (reserved) |
| `TS6_USERNAME` | `serveradmin` | TS6 query username |
| `TS6_PASSWORD` | — | TS6 query password |
| `TS6_API_KEY` | — | TS6 API key (preferred over password) |
| `TS6_SERVER_ID` | `1` | TS6 virtual server ID |
| `TS3_CONNECT_ADDRESS` | — | Public address for TS3 "Join server" button |
| `TS6_CONNECT_ADDRESS` | — | Public address for TS6 "Join server" button |
| `WEB_PORT` | `5540` | Web server port |
| `LOGO_URL` | — | URL to your logo image |
| `LANGUAGE` | `PL` | Interface language (`PL` or `EN`) |
| `TRUST_PROXY` | `false` | Set `true` if behind a reverse proxy |

---

## Adding a Language

1. Copy `locales/en.json` to `locales/xx.json`
2. Translate all string values
3. Set `LANGUAGE=XX` in your `.env`
4. Restart the container

---

## Reverse Proxy (nginx)

If you're serving the app behind nginx with HTTPS:

```nginx
server {
    listen 443 ssl;
    server_name roles.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/.../fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/.../privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5540;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
    }
}
```

Set `TRUST_PROXY=true` in `.env` so the app reads the real client IP from headers.

---

## Tech Stack

- **Runtime:** Node.js 20 (Alpine)
- **Framework:** Express
- **TS3 connection:** [ts3-nodejs-library](https://github.com/Multivit4min/TS3-NodeJS-Library) (telnet ServerQuery)
- **TS6 connection:** HTTP ServerQuery API (JSON over HTTP)
- **Deployment:** Docker + Docker Compose

---

## Project Structure

```
ts-rank-transfer/
├── server.js            # Express backend, TS3 & TS6 services, API routes
├── public/
│   └── index.html       # Frontend (single-page, translation-driven)
├── locales/
│   ├── pl.json          # Polish translations
│   └── en.json          # English translations
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example         # Template configuration
└── .gitignore
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Cannot connect to TS3" | Verify ServerQuery is running on port 10011 and credentials are correct |
| "Cannot connect to TS6" | Verify HTTP query is running on port 10080, check API key |
| IP always shows `127.0.0.1` | Set `TRUST_PROXY=true` if behind a reverse proxy |
| Docker can't reach TS on localhost | Use `host.docker.internal` as host (uncomment `extra_hosts` in docker-compose.yml) |
| Groups don't transfer | Ensure the query account has `i_group_member_add_power` permission |
| TS6 "invalid serverID" | Check `TS6_SERVER_ID` matches your virtual server |

---

## Notes on TS6

TeamSpeak 6 exposes an HTTP-based ServerQuery on port `10080`. The URL format is:

```
http://host:port/{serverID}/{command}?param=value&-flag
```

Authentication is done via:
- **API Key** (preferred) — `x-api-key` header
- **Basic Auth** — `Authorization: Basic base64(user:pass)`

If your TS6 instance uses a different API, you'll need to adjust the `TS6Service` class in `server.js`.

---

#### DISCLAIMER: 
![AI Assisted](https://img.shields.io/badge/AI%20Assisted-Project-00ADD8?style=for-the-badge&logo=dependabot&logoColor=white)

---

## License

MIT

---

© [Alleria.pl](https://alleria.pl) 2026 | made by [Froncalke](https://github.com/mrfroncu)
