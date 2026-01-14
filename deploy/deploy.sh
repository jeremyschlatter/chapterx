#!/bin/bash
set -e

# Run from repo root
cd "$(dirname "$0")/.."

SERVER="root@64.23.171.106"
REMOTE_PATH="/opt/chapterx-slack"

echo "Deploying ChapterX Slack to $SERVER..."

# Sync the repo (excluding node_modules, logs, cache)
rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude 'logs' \
    --exclude 'cache' \
    --exclude '.git' \
    --exclude 'deploy/tokens' \
    ./ "$SERVER:$REMOTE_PATH/"

# Copy tokens separately (they're gitignored)
if [ -d "deploy/tokens" ] && [ "$(ls -A deploy/tokens 2>/dev/null)" ]; then
    echo "Copying tokens..."
    rsync -avz deploy/tokens/ "$SERVER:$REMOTE_PATH/deploy/tokens/"
fi

# Install dependencies and build on server
echo "Building on server..."
ssh "$SERVER" "cd $REMOTE_PATH && npm ci && npm run build"

# Start/restart bots
echo "Restarting bots..."
ssh "$SERVER" "cd $REMOTE_PATH/deploy && pm2 start ecosystem.config.cjs && pm2 save"

echo "Done. Checking status..."
ssh "$SERVER" "pm2 status"
