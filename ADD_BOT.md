# Adding a New Bot

This guide walks through adding a new bot/model to the ChapterX Slack server.

## 1. Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From scratch**
3. Enter a name (e.g., "Opus 4.5") and select your workspace
4. Click **Create App**

## 2. Enable Socket Mode

1. In the left sidebar, go to **Socket Mode**
2. Toggle **Enable Socket Mode** ON
3. You'll be prompted to create an App-Level Token:
   - Name it something like "socket-token"
   - Add the `connections:write` scope
   - Click **Generate**
4. **Save this token** - it starts with `xapp-` (you'll need it later)

## 3. Add Bot Scopes

1. Go to **OAuth & Permissions** in the left sidebar
2. Scroll to **Scopes** → **Bot Token Scopes**
3. Add these scopes:
   - `app_mentions:read` - receive @mentions
   - `channels:history` - read channel messages
   - `channels:read` - see channel info
   - `chat:write` - send messages
   - `files:read` - access file content
   - `pins:read` - read pinned messages (for system prompts)
   - `reactions:read` - read emoji reactions
   - `reactions:write` - add emoji reactions (typing indicator)
   - `users:read` - get user display names

## 4. Enable Events

1. Go to **Event Subscriptions** in the left sidebar
2. Toggle **Enable Events** ON
3. Expand **Subscribe to bot events** and add:
   - `app_mention`
   - `message.channels`
4. Click **Save Changes**

## 5. Install to Workspace

1. Go to **Install App** in the left sidebar
2. Click **Install to Workspace**
3. Review permissions and click **Allow**
4. **Save the Bot User OAuth Token** - it starts with `xoxb-`

## 6. Create Bot Config

Create a config file at `config/bots/<bot_id>.yaml`:

```yaml
name: My Bot Name

mode: prefill
continuation_model: claude-opus-4-5-20251101  # or your model
temperature: 1.0
max_tokens: 4096

recency_window_messages: 400
rolling_threshold: 50

include_images: true
max_images: 5

tools_enabled: false
reply_on_random: 20  # 1 in N chance of random reply
```

See `config/bots/claude.yaml.example` for all available options.

## 7. Store Tokens Locally

Create a directory for your bot's tokens (these are gitignored):

```bash
mkdir -p deploy/tokens/<bot_id>
echo "xoxb-your-bot-token" > deploy/tokens/<bot_id>/bot_token
echo "xapp-your-app-token" > deploy/tokens/<bot_id>/app_token
```

Replace `<bot_id>` with the same name used in your config file (e.g., `opus_45`).

## 8. Add to PM2 Config

Edit `deploy/ecosystem.config.cjs` and add your bot to the `bots` array:

```javascript
const bots = [
  'opus_45',
  'haiku_45',
  'my_new_bot',  // Add your bot here
];
```

## 9. Deploy

Run the deploy script:

```bash
./deploy/deploy.sh
```

This will:
- Sync code to the server
- Copy your token files
- Build the project
- Start/restart all bots via pm2

## Verification

Check that your bot is running:

```bash
# SSH to server
ssh root@64.23.171.106

# Check pm2 status
pm2 status

# View logs for your bot
pm2 logs slack-<bot_id>
```

## Troubleshooting

**Bot not connecting:**
- Verify Socket Mode is enabled in Slack app settings
- Check that app token has `connections:write` scope
- Ensure tokens are correct in `deploy/tokens/<bot_id>/`

**Bot not responding to messages:**
- Verify Event Subscriptions are enabled
- Check that bot is invited to the channel
- Look at pm2 logs for errors

**Missing messages:**
- Verify all required bot scopes are added
- Reinstall the app to workspace if you added scopes after initial install
