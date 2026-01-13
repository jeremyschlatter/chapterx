# ChapterX: Discord to Slack Porting Plan

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Platform Abstraction | **Complete** | Created `src/platform/` with types and interface |
| 2. Slack Connector | **Complete** | Full implementation with @slack/bolt and @slack/web-api |
| 3. Activation Detection | **Complete** | Mention and reply handling via app_mention and message events |
| 4. Configuration | **Complete** | Pinned messages supported via `pins.list` |
| 5. Message Formats | **Complete** | Mention conversion, image/doc handling |
| 6. History Command | **Complete** | Recursive .history processing with Slack URL support |
| 7. Threading | Partial | Basic thread support via `thread_ts`, deep integration pending |
| 8. Testing | **Complete** | 36 unit tests for URL parsing and utilities |

### Summary of Changes

**Files Created:**
- `src/platform/types.ts` - Platform-agnostic types (PlatformMessage, PlatformContext, etc.)
- `src/platform/connector.ts` - PlatformConnector interface
- `src/platform/index.ts` - Re-exports
- `src/slack/connector.ts` - SlackConnector implementation (~950 LOC) with recursive .history support
- `src/slack/utils.ts` - URL parsing, mention handling, timestamp utilities
- `src/slack/index.ts` - Re-exports
- `src/slack/utils.test.ts` - 25 unit tests for Slack utilities
- `src/slack/connector.test.ts` - 11 unit tests for connector URL parsing logic

**Files Modified:**
- `src/main.ts` - Platform selection via PLATFORM env var
- `src/agent/loop.ts` - Uses PlatformConnector interface
- `src/api/server.ts` - Uses PlatformConnector interface, supports both Discord and Slack URLs
- `src/discord/connector.ts` - Implements PlatformConnector
- `package.json` - Added @slack/bolt@4.6.0, @slack/web-api@7.13.0

### Remaining Work

1. **Thread context building** - Proper parent message context inclusion for Slack threads (using `conversations.replies`)
2. **Integration testing** - Test against real Slack workspace with actual bot token
3. **Documentation** - Update README with Slack setup instructions

---

## Overview

ChapterX is a multi-LLM bot framework currently integrated with Discord. This document tracks the port to Slack.

### Key Architectural Insight

The codebase has a clean separation:
- **Platform-agnostic**: LLM middleware, tool system, config system, context builder (mostly)
- **Platform-specific**: Discord connector, activation detection, message format handling

The `ParticipantMessage` type serves as the abstraction boundary - everything above it is platform-agnostic.

---

## Phase 1: Platform Abstraction Layer

### Goal
Create interfaces that allow swapping Discord ↔ Slack without modifying core logic.

### Files to Create

```
src/platform/
├── types.ts           # Platform-agnostic message/event types
├── connector.ts       # PlatformConnector interface
└── index.ts           # Re-exports
```

### Key Interface

```typescript
// src/platform/connector.ts
export interface PlatformConnector {
  // Lifecycle
  start(): Promise<void>
  close(): Promise<void>

  // Identity
  getBotUserId(): string | undefined
  getBotUsername(): string | undefined

  // Events (called by connector, handled by agent loop)
  onMessage(handler: (event: PlatformMessageEvent) => void): void
  onEdit(handler: (event: PlatformEditEvent) => void): void
  onDelete(handler: (event: PlatformDeleteEvent) => void): void

  // Context fetching
  fetchContext(params: FetchContextParams): Promise<PlatformContext>
  fetchPinnedConfigs(channelId: string): Promise<string[]>

  // Actions
  sendMessage(channelId: string, content: string, replyTo?: string): Promise<string[]>
  sendMessageWithAttachment(channelId: string, content: string, attachment: Attachment, replyTo?: string): Promise<string[]>
  sendImageAttachment(channelId: string, imageBase64: string, mediaType: string, caption?: string, replyTo?: string): Promise<string[]>
  deleteMessage(channelId: string, messageId: string): Promise<void>
  startTyping(channelId: string): void
  stopTyping(channelId: string): void
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>

  // User resolution
  resolveUser(identifier: string, workspaceId: string): Promise<UserInfo | null>
  getChannelName(channelId: string): Promise<string | undefined>
  getParentChannelId(channelId: string): Promise<string | undefined>

  // Platform-specific
  getBotReplyChainDepth(channelId: string, message: any): Promise<number>
}
```

### Platform-Agnostic Types

```typescript
// src/platform/types.ts
export interface PlatformMessage {
  id: string
  channelId: string
  workspaceId: string  // guildId in Discord, workspace in Slack
  author: {
    id: string
    username: string
    displayName: string
    bot: boolean
  }
  content: string
  timestamp: Date
  attachments: PlatformAttachment[]
  reactions: Array<{ emoji: string; count: number }>
  mentions: string[]
  referencedMessage?: string  // Reply to message ID
  threadId?: string  // For Slack thread support
}

export interface PlatformContext {
  messages: PlatformMessage[]
  pinnedConfigs: string[]
  images: CachedImage[]
  documents: CachedDocument[]
  workspaceId: string
  inheritanceInfo?: {
    parentChannelId?: string
    historyOriginChannelId?: string
  }
}

export interface PlatformMessageEvent {
  type: 'message'
  channelId: string
  workspaceId: string
  message: PlatformMessage
  raw: any  // Platform-specific raw event
}
```

### Migration Steps

1. Create `src/platform/types.ts` with platform-agnostic types
2. Create `src/platform/connector.ts` with interface
3. Rename `DiscordMessage` → `PlatformMessage` in types.ts (or alias)
4. Create `src/discord/connector.ts` implementing interface (wrap existing)
5. Update `AgentLoop` to use interface instead of concrete class
6. Update `main.ts` to instantiate via factory

---

## Phase 2: Slack Connector

### Dependencies to Add

```bash
npm install @slack/bolt @slack/web-api
```

### Slack API Mapping

| Discord | Slack | Notes |
|---------|-------|-------|
| `client.login()` | `app.start()` | Socket mode |
| `messageCreate` | `message` event | Via Bolt |
| `messageUpdate` | `message_changed` subtype | |
| `messageDelete` | `message_deleted` subtype | |
| `channel.messages.fetch()` | `conversations.history()` | |
| `channel.messages.fetchPinned()` | `pins.list()` | |
| `channel.send()` | `chat.postMessage()` | |
| `message.delete()` | `chat.delete()` | |
| `channel.sendTyping()` | N/A | Slack doesn't have typing |
| `message.react()` | `reactions.add()` | |
| User ID `<@123>` | User ID `<@U123>` | Same format! |

### File Structure

```
src/slack/
├── connector.ts       # SlackConnector implementing PlatformConnector
├── events.ts          # Event type conversions
└── utils.ts           # URL parsing, mention handling
```

### Slack Connector Skeleton

```typescript
// src/slack/connector.ts
import { App, LogLevel } from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import { PlatformConnector, PlatformContext, FetchContextParams } from '../platform/index.js'

export interface SlackConnectorOptions {
  botToken: string      // xoxb-...
  appToken: string      // xapp-... (for socket mode)
  signingSecret: string
  cacheDir: string
}

export class SlackConnector implements PlatformConnector {
  private app: App
  private client: WebClient
  private botUserId?: string
  private botUsername?: string
  private messageHandlers: Array<(event: any) => void> = []

  constructor(private options: SlackConnectorOptions) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    })
    this.client = this.app.client
    this.setupEventHandlers()
  }

  async start(): Promise<void> {
    await this.app.start()
    // Get bot identity
    const auth = await this.client.auth.test()
    this.botUserId = auth.user_id as string
    this.botUsername = auth.user as string
  }

  // ... implement interface methods
}
```

### Key Differences to Handle

1. **Message IDs**: Slack uses timestamps (`ts`) as message IDs
   - Format: `1234567890.123456`
   - Need to handle in URL parsing and comparisons

2. **Threads**: Slack threads use `thread_ts`
   - Messages in thread have both `ts` (their ID) and `thread_ts` (parent)
   - Different from Discord where threads are separate channels

3. **File access**: Slack files require authentication
   - Use `files.info` to get private download URL
   - Include token in request headers

4. **Rate limiting**: Slack has tiered rate limits
   - Tier 1: 1/min, Tier 2: 20/min, Tier 3: 50/min, Tier 4: 100/min
   - `conversations.history` is Tier 3
   - Need exponential backoff

---

## Phase 3: Activation Detection

### Current Discord Triggers

1. **m commands**: `m continue`, `m <action>` (addressed to bot)
2. **Mentions**: `@BotName`
3. **Replies**: Reply to bot's message
4. **Random**: Configurable probability

### Slack Equivalents

| Discord | Slack | Implementation |
|---------|-------|----------------|
| `@BotName` | `<@UBOT123>` | Check `event.text` for bot user ID |
| Reply to bot | Thread reply | Check `thread_ts` + parent author |
| `m continue` | `m continue` | Keep same format |
| `mentions.has(botId)` | `event.text.includes('<@' + botId + '>')` | String search |

### Slack-Specific: `app_mention` Event

Slack has a dedicated `app_mention` event that fires when the bot is mentioned. This is simpler than Discord's approach.

```typescript
this.app.event('app_mention', async ({ event }) => {
  // Bot was mentioned - activate
  this.messageHandlers.forEach(h => h({
    type: 'message',
    channelId: event.channel,
    // ...
  }))
})
```

### Changes to `loop.ts`

The `shouldActivate()` method needs to be platform-aware or moved to the connector:

```typescript
// Option 1: Platform-specific activation checker
interface ActivationChecker {
  shouldActivate(event: PlatformMessageEvent, botUserId: string): boolean
  isMCommand(content: string): boolean
}

// Option 2: Keep in AgentLoop, use platform-agnostic checks
// - Mention check: message.mentions.includes(botUserId)
// - Reply check: message references bot message ID
// - M command: same logic (content starts with "m ")
```

---

## Phase 4: Configuration Loading

### Current: Pinned Messages

Discord pinned messages with `.config` format:
```
.config [target]
---
yaml content
```

### Slack Options

1. **Pinned messages** (direct equivalent)
   - API: `pins.list`
   - Same format works

2. **Channel bookmarks** (alternative)
   - API: `bookmarks.list`
   - Could store config file URL

3. **Channel topic** (limited)
   - Very short length limit
   - Not suitable for full configs

### Recommendation

Start with pinned messages (direct port), same `.config` format.

```typescript
async fetchPinnedConfigs(channelId: string): Promise<string[]> {
  const result = await this.client.pins.list({ channel: channelId })
  const configs: string[] = []

  for (const item of result.items || []) {
    if (item.message?.text?.startsWith('.config')) {
      const lines = item.message.text.split('\n')
      if (lines[1] === '---') {
        configs.push(lines.slice(2).join('\n'))
      }
    }
  }

  return configs
}
```

---

## Phase 5: Message Format Handling

### Reply Prefix

Current Discord format: `<reply:@username> message`

Slack threads handle this differently:
- Thread replies don't need explicit prefix
- The `thread_ts` field indicates it's a reply
- May want to keep prefix for cross-thread references

### Mention Format

- Discord: `<@username>` (converted from `<@123456>`)
- Slack: `<@U123456>` (user ID format)

The connector should normalize to `<@username>` for LLM consumption.

```typescript
// In message conversion
private convertMentions(text: string, userMap: Map<string, string>): string {
  // Convert <@U123> to <@username>
  return text.replace(/<@(U\w+)>/g, (match, userId) => {
    const username = userMap.get(userId)
    return username ? `<@${username}>` : match
  })
}
```

### Image Handling

Slack files require authentication:

```typescript
async fetchImage(fileUrl: string): Promise<Buffer> {
  const response = await fetch(fileUrl, {
    headers: {
      'Authorization': `Bearer ${this.options.botToken}`
    }
  })
  return Buffer.from(await response.arrayBuffer())
}
```

---

## Phase 6: History Command

### Current Format

```
.history [target]
---
first: https://discord.com/channels/GUILD/CHANNEL/MESSAGE
last: https://discord.com/channels/GUILD/CHANNEL/MESSAGE
```

### Slack URL Format

```
https://WORKSPACE.slack.com/archives/CHANNEL_ID/p1234567890123456
```

The `p` prefix + timestamp (no decimal) is the message ID.

### URL Parsing

```typescript
function parseSlackMessageUrl(url: string): { channel: string; ts: string } | null {
  // https://workspace.slack.com/archives/C123456/p1234567890123456
  const match = url.match(/archives\/([A-Z0-9]+)\/p(\d+)/)
  if (!match) return null

  const channel = match[1]
  // Convert p1234567890123456 to 1234567890.123456
  const rawTs = match[2]
  const ts = rawTs.slice(0, 10) + '.' + rawTs.slice(10)

  return { channel, ts }
}
```

### API Differences

```typescript
// Discord: fetch before message ID
channel.messages.fetch({ before: messageId, limit: 100 })

// Slack: fetch before timestamp
client.conversations.history({
  channel: channelId,
  latest: ts,  // Exclusive - messages before this
  limit: 100
})
```

---

## Phase 7: Threading

### Discord Model

- Threads are separate channels with `parentId`
- Thread ID = message ID that started it
- Bot fetches parent context implicitly

### Slack Model

- Threads are messages with `thread_ts` pointing to parent
- All in same channel, different view
- `conversations.replies` fetches thread

### Implementation

```typescript
async fetchThreadMessages(channelId: string, threadTs: string): Promise<Message[]> {
  const result = await this.client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 100
  })
  return result.messages || []
}
```

### Context Building Changes

When in a thread:
1. Fetch thread messages via `conversations.replies`
2. Include parent message context (configurable depth)
3. Handle thread-specific reply detection

---

## Phase 8: Testing

### Unit Tests

```
src/__tests__/
├── slack/
│   ├── connector.test.ts    # Mock Bolt app
│   ├── url-parsing.test.ts  # URL extraction
│   └── mentions.test.ts     # Mention conversion
├── platform/
│   └── types.test.ts        # Type compatibility
└── integration/
    └── slack-flow.test.ts   # End-to-end with mocks
```

### Test Strategy

1. **Mock Slack API**: Use `@slack/bolt` test utilities
2. **Snapshot testing**: Compare message conversions
3. **Integration**: Test against real Slack workspace (dev)

### Example Test

```typescript
import { describe, it, expect, vi } from 'vitest'
import { SlackConnector } from '../slack/connector'

describe('SlackConnector', () => {
  it('parses Slack message URLs', () => {
    const url = 'https://test.slack.com/archives/C123/p1234567890123456'
    const result = parseSlackMessageUrl(url)
    expect(result).toEqual({
      channel: 'C123',
      ts: '1234567890.123456'
    })
  })

  it('converts mentions to usernames', async () => {
    const connector = new SlackConnector(mockOptions)
    const text = 'Hello <@U123456>'
    const converted = await connector.convertMentions(text, new Map([['U123456', 'alice']]))
    expect(converted).toBe('Hello <@alice>')
  })
})
```

---

## Environment Variables

### Current (Discord)

```bash
DISCORD_TOKEN=...
CONFIG_PATH=./config
CACHE_PATH=./cache
API_PORT=3000
API_BEARER_TOKEN=...
```

### New (Slack)

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
CONFIG_PATH=./config
CACHE_PATH=./cache
API_PORT=3000
API_BEARER_TOKEN=...
```

### Platform Selection

```bash
PLATFORM=slack  # or 'discord'
```

---

## Migration Checklist

### Phase 1: Platform Abstraction
- [ ] Create `src/platform/types.ts`
- [ ] Create `src/platform/connector.ts`
- [ ] Create `src/platform/index.ts`
- [ ] Refactor `DiscordConnector` to implement interface
- [ ] Update `AgentLoop` to use interface
- [ ] Update `main.ts` with platform factory
- [ ] Run tests, verify Discord still works

### Phase 2: Slack Connector
- [ ] Add `@slack/bolt` and `@slack/web-api` dependencies
- [ ] Create `src/slack/connector.ts` skeleton
- [ ] Implement `start()` and `close()`
- [ ] Implement `fetchContext()`
- [ ] Implement `sendMessage()`
- [ ] Implement event handlers
- [ ] Test basic message send/receive

### Phase 3: Activation Detection
- [ ] Implement mention detection for Slack
- [ ] Implement reply detection (thread-based)
- [ ] Test m-command handling
- [ ] Verify bot doesn't respond to itself

### Phase 4: Configuration
- [ ] Implement `fetchPinnedConfigs()` for Slack
- [ ] Test `.config` parsing
- [ ] Verify config inheritance

### Phase 5: Message Formats
- [ ] Implement mention conversion
- [ ] Implement reply prefix handling
- [ ] Test image attachment fetching
- [ ] Verify text attachments work

### Phase 6: History Command
- [ ] Implement Slack URL parsing
- [ ] Adapt recursive history fetch
- [ ] Test cross-channel history

### Phase 7: Threading
- [ ] Implement thread detection
- [ ] Implement `conversations.replies` fetching
- [ ] Test parent context inclusion

### Phase 8: Testing
- [ ] Write unit tests for Slack connector
- [ ] Write integration tests
- [ ] Test against real Slack workspace
- [ ] Document any behavioral differences

---

## Risk Areas

1. **Thread semantics**: Discord threads vs Slack threads work differently
2. **Rate limiting**: Slack has stricter limits
3. **File authentication**: Slack files need auth headers
4. **Message timestamps**: Floating-point IDs need care in comparisons
5. **Workspace scope**: Multi-workspace support deferred

---

## Notes

- This document will be updated as implementation progresses
- Breaking changes from Discord behavior will be documented
- Performance comparisons will be tracked
