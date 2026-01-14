# ChapterX Slack Deployment

## Server Info

- **IP:** 64.23.171.106
- **Path:** /opt/chapterx-slack

## Token Setup

Each bot needs a Slack app with Socket Mode enabled. Create token files:

```
deploy/tokens/
├── opus_45/
│   ├── bot_token      # xoxb-... (Bot User OAuth Token)
│   └── app_token      # xapp-... (App-Level Token with connections:write)
└── haiku_45/
    ├── bot_token
    └── app_token
```

## Quick Commands

```bash
# Deploy (syncs code + restarts bots)
./deploy/deploy.sh

# SSH into server
ssh root@64.23.171.106

# View logs
pm2 logs slack-opus_45

# Restart specific bot
pm2 restart slack-opus_45

# Restart all
pm2 restart all

# Check status
pm2 status
```

## Adding a New Bot

1. Create a Slack app at https://api.slack.com/apps
2. Enable Socket Mode and create an App-Level Token (connections:write scope)
3. Add bot scopes: app_mentions:read, channels:history, channels:read, chat:write, files:read, pins:read, reactions:read, reactions:write, users:read
4. Install to workspace and get Bot User OAuth Token
5. Create config: `config/bots/<bot_name>.yaml`
6. Create tokens:
   ```bash
   mkdir -p deploy/tokens/<bot_name>
   echo "xoxb-..." > deploy/tokens/<bot_name>/bot_token
   echo "xapp-..." > deploy/tokens/<bot_name>/app_token
   ```
7. Add bot to `deploy/ecosystem.config.cjs`
8. Run `./deploy/deploy.sh`

## Initial Server Setup

```bash
# Install Node.js 20 and pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git rsync
npm install -g pm2

# First deploy will create /opt/chapterx-slack
./deploy/deploy.sh

# Set up pm2 to start on boot
pm2 startup
pm2 save
```
