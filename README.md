# 101st Server Data

Automatically fetches DCS server status and leaderboard data from Discord channels every 10 minutes using GitHub Actions.

**Data files are served via GitHub Pages:**
- `data/server-status.json` — Live DCS server info
- `data/leaderboard.json` — Pilot rankings
- `data/status.json` — Combined status

## Setup

1. Create this repo on GitHub
2. Go to **Settings → Secrets → Actions** and add:
   - `DISCORD_BOT_TOKEN` — Your Discord bot token
   - `DISCORD_GUILD_ID` — Your Discord server ID
3. Go to **Settings → Pages** → Source: Deploy from branch → Branch: `main` → Folder: `/ (root)`
4. The action will auto-run every 10 minutes, or trigger manually from **Actions** tab

## API Endpoints

After GitHub Pages is enabled:
```
https://<username>.github.io/101st-server-data/data/server-status.json
https://<username>.github.io/101st-server-data/data/leaderboard.json
```
