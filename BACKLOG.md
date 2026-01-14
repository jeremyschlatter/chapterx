# ChapterX Slack Port - Backlog

## Open Issues

### Multi-bot thread handling
When multiple bots have replied to a thread, they all respond to every message in that thread. Need to reconsider activation logic for shared threads.

### User tagging may be broken
Bots may not be tagging users correctly in Slack.
See: https://palisaderesearch.slack.com/archives/C0A8Y4VU1CH/p1768349464785319?thread_ts=1768349459.827689&cid=C0A8Y4VU1CH

## Completed

### Typing indicator
Added 👀 emoji reaction while bot is composing reply. Shows 😵 on error instead of removing reaction.
