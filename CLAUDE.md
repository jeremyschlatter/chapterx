# ChapterX Slack

This is a Slack port of ChapterX, originally a Discord bot built by Anima. The bot connects LLMs to chat platforms, allowing AI assistants to participate in conversations.

## Architecture Overview

- **Platform Connectors**: `src/slack/connector.ts` (Slack), `src/discord/connector.ts` (Discord)
- **Agent Loop**: `src/agent/loop.ts` - handles activation detection and LLM orchestration
- **Context Builder**: `src/context/builder.ts` - formats messages for LLM consumption
- **LLM Middleware**: `src/llm/middleware.ts` - transforms messages to provider-specific formats

## Key Data Flow

1. Slack API messages → `PlatformMessage` (normalized format)
2. `PlatformMessage` → `ParticipantMessage` (for LLM context)
3. `ParticipantMessage` → plaintext prefill format for LLM

## Slack-Specific Behavior

- **Threads**: When bot is triggered in a thread, context includes channel messages before the thread + thread content
- **Thread summaries**: Channel messages with threads show `<thread snipped: N replies from names>`
- **Responses**: Bot responds at channel level (not in threads)
- **Typing indicator**: Uses 👀 emoji reaction instead of typing status

## Running

```bash
bun run src/index.ts --slack  # Run with Slack connector
```

## Configuration

Bot configuration via YAML files in `config/bots/` and pinned messages in Slack channels.
