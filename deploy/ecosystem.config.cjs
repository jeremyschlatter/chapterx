const fs = require('fs');
const path = require('path');

// Bot configurations - add your bots here
// Each bot needs a Slack app with its own tokens in deploy/tokens/<bot-id>/
const bots = [
  'opus_45',
  'haiku_45',  // Uncomment when you have tokens for this bot
];

const readToken = (botId, filename) => {
  const tokenPath = path.join(__dirname, 'tokens', botId, filename);
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (e) {
    console.error(`Warning: Could not read ${tokenPath}`);
    return '';
  }
};

const botApps = bots.map((botId) => ({
  name: `slack-${botId}`,
  script: '/opt/chapterx-slack/dist/main.js',
  cwd: '/opt/chapterx-slack',
  env: {
    PLATFORM: 'slack',
    CONFIG_PATH: '/opt/chapterx-slack/config',
    CACHE_PATH: '/opt/chapterx-slack/cache',
    LOGS_DIR: '/opt/chapterx-slack/logs',
    BOT_NAME: botId,
    NODE_ENV: 'production',
    // Slack tokens - read from files
    SLACK_BOT_TOKEN: readToken(botId, 'bot_token'),
    SLACK_APP_TOKEN: readToken(botId, 'app_token'),
  },
}));

const traceServer = {
  name: 'trace-server',
  script: 'npx',
  args: 'tsx tools/trace-server.ts',
  cwd: '/opt/chapterx-slack',
  env: {
    HOST: '100.109.180.96',
    PORT: '80',
    LOGS_DIR: '/opt/chapterx-slack/logs',
  },
};

module.exports = {
  apps: [...botApps, traceServer],
};
