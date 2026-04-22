# Alfaview — Self-Hosted Trading Signal Server

Live XAU/USD (Gold) trading signal generator with a real-time web dashboard and Telegram notifications. **Render-optimized** out of the box.

## What's inside

```
alfaview/
├── server.js          # Single-file Express server (API + signal engine)
├── public/            # Pre-built React dashboard (served as static)
├── data/              # Auto-created — positions.json + history.json
├── render.yaml        # Render Blueprint — one-click deploy
├── package.json
├── .env.example       # Copy → .env (local) or set in Render dashboard
└── README.md
```

## Deploy on Render (recommended)

**One-click via Blueprint:**

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New** → **Blueprint** → connect the repo.
3. Render reads `render.yaml` and creates the service.
4. In the new service's **Environment** tab, set:
   - `TELEGRAM_TOKEN` — from @BotFather
   - `CHAT_ID` — your Telegram chat/channel id
5. Done. Deploy will run `npm install && node server.js`. Health check is `/api/health`.

**Manual setup (no Blueprint):**

- Service type: **Web Service**, Runtime: **Node**
- Build: `npm install`  ·  Start: `node server.js`
- Health Check Path: `/api/health`
- Environment: `TELEGRAM_TOKEN`, `CHAT_ID` (required); optional `KEEPALIVE=1`, `AUTO_INTERVAL_SEC=30`

**Render-specific features built in:**
- Binds `0.0.0.0:$PORT` (Render assigns the port)
- `trust proxy` set for correct client IPs behind Render's load balancer
- Graceful **SIGTERM** shutdown — saves state before deploys, no dropped requests
- Optional **self-ping keep-alive** (`KEEPALIVE=1`) prevents free-tier sleep
- **Persistent disk support** via `DATA_DIR` (set to `/var/data` and attach a disk on paid plans to keep trade history across deploys)
- Lighter scan interval (30s default) tuned for free-tier CPU

> **Note on free tier:** Render free services sleep after ~15 min of no requests and have no persistent disk. Set `KEEPALIVE=1` to keep it awake. For trade history that survives deploys, upgrade to **Starter ($7/mo)** and uncomment the `disk:` block in `render.yaml`.

## Local quick start

Requires **Node.js 20+**.

```bash
# 1. Install dependencies (Express + dotenv only)
npm install

# 2. Configure Telegram (optional but recommended)
cp .env.example .env
# Edit .env and fill TELEGRAM_TOKEN + CHAT_ID

# 3. Run
npm start
```

Open http://localhost:5000 in your browser. The dashboard, API, and signal engine all run on this single port.

## Telegram setup (5 minutes)

1. On Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the bot token.
2. Send any message to your new bot.
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser → find `"chat":{"id":...}` → copy that number.
4. Put both into `.env`:
   ```
   TELEGRAM_TOKEN=123456:ABC...
   CHAT_ID=987654321
   PORT=5000
   ```
5. Restart the server.

If you skip Telegram, the dashboard and signal engine still work — you just won't get push notifications.

## Hosting options

Any Node.js host will work. Examples:

- **VPS (DigitalOcean, Hetzner, Linode, AWS EC2):**
  ```bash
  pm2 start server.js --name alfaview
  pm2 save && pm2 startup
  ```
- **Railway / Render / Fly.io:** point to this folder, set `npm start` as the start command, add `TELEGRAM_TOKEN` + `CHAT_ID` as env vars.
- **Docker:**
  ```dockerfile
  FROM node:20-alpine
  WORKDIR /app
  COPY package*.json ./
  RUN npm install --production
  COPY . .
  EXPOSE 5000
  CMD ["node", "server.js"]
  ```

## Features

- **Auto signal engine** — runs every 5 seconds, EMA20/50 + RSI14 + MACD + ATR14 with confidence scoring
- **One open position at a time** per pair (avoids signal spam)
- **TP/SL tracker** — checks every 60s and auto-sends RESULT messages with P/L
- **Live web dashboard** — TradingView OANDA chart, open positions with live P/L, performance stats, trade history
- **Manual close** button on any open position (books actual P/L)
- **Runtime settings** — adjust min confidence, risk:reward ratio, SL distance from the UI
- **Browser notifications** for new signals
- **Persistent state** — positions and history survive restarts (saved to `data/`)

## API endpoints

All under `/api`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Server health |
| GET | `/api/auto` | Auto-mode status & settings |
| POST | `/api/auto/start` \| `/api/auto/stop` | Toggle auto-mode |
| POST | `/api/settings` | `{minConfidence, rrRatio, slMultiplier}` |
| GET | `/api/positions` | List open positions |
| POST | `/api/positions/:id/close` | Manually close a position |
| POST | `/api/positions/clear` | Clear all open positions |
| GET | `/api/history?limit=50` | Closed-trade history |
| GET | `/api/stats` | Performance stats (win rate, P/L) |
| POST | `/api/history/clear` | Wipe history |
| GET | `/api/xauusd/price` | Live spot price |
| GET | `/api/xauusd/analysis` | One-off analysis (no signal fired) |

## Disclaimer

Educational use only. Not financial advice. Past performance does not guarantee future results. Use small position sizes.
