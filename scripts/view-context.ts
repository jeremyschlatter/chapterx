#!/usr/bin/env npx tsx
/**
 * View the LLM context for a given Slack message
 *
 * Usage:
 *   ./scripts/view-context.ts <slack-url-or-message-ts>
 *   ./scripts/view-context.ts https://workspace.slack.com/archives/C123/p1234567890123456
 *   ./scripts/view-context.ts 1234567890.123456
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const TRACES_DIR = 'logs/traces'
const LLM_REQUESTS_DIR = 'logs/llm-requests'

function parseSlackUrl(url: string): { channel: string; ts: string; threadTs?: string } | null {
  const match = url.match(/archives\/([A-Z0-9]+)\/p(\d+)/)
  if (!match) return null
  const [, channel, pTimestamp] = match
  // Convert p1234567890123456 to 1234567890.123456
  const ts = pTimestamp!.slice(0, 10) + '.' + pTimestamp!.slice(10)

  // Check for thread_ts in query params
  const threadMatch = url.match(/thread_ts=([0-9.]+)/)
  const threadTs = threadMatch ? threadMatch[1] : undefined

  return { channel: channel!, ts, threadTs }
}

function findTraceByMessageTs(messageTs: string): any | null {
  // Search all bot directories
  const botDirs = readdirSync(TRACES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)

  for (const botDir of botDirs) {
    const traceDir = join(TRACES_DIR, botDir)
    const files = readdirSync(traceDir).sort().reverse() // newest first

    for (const file of files) {
      const content = readFileSync(join(traceDir, file), 'utf-8')
      const trace = JSON.parse(content)

      // Check if this trace's triggering message or any raw message matches
      if (trace.triggeringMessageId === messageTs) {
        return { trace, file, botDir }
      }

      // Also check raw messages
      const rawMsgs = trace.rawDiscordMessages || []
      if (rawMsgs.some((m: any) => m.id === messageTs)) {
        return { trace, file, botDir }
      }
    }
  }

  return null
}

function findLlmRequestByTimestamp(traceTimestamp: string): any | null {
  // Trace timestamp is like "2026-01-13T22:55:22.639Z"
  // LLM request is like "request-2026-01-13T22-55-23-242Z.json"
  // Find the closest one within a few seconds

  const traceDate = new Date(traceTimestamp)
  const files = readdirSync(LLM_REQUESTS_DIR).sort().reverse()

  for (const file of files) {
    const match = file.match(/request-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-\d+Z\.json/)
    if (!match) continue

    const fileTimestamp = match[1]!.replace(/-/g, (m, offset) => offset > 9 ? ':' : '-')
    const fileDate = new Date(fileTimestamp + 'Z')

    // Within 10 seconds
    if (Math.abs(fileDate.getTime() - traceDate.getTime()) < 10000) {
      const content = readFileSync(join(LLM_REQUESTS_DIR, file), 'utf-8')
      return { request: JSON.parse(content), file }
    }
  }

  return null
}

function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('Usage: view-context.ts <slack-url-or-message-ts>')
    console.error('  ./scripts/view-context.ts https://workspace.slack.com/archives/C123/p1234567890123456')
    console.error('  ./scripts/view-context.ts 1234567890.123456')
    process.exit(1)
  }

  // Parse input
  let messageTs: string
  let threadTs: string | undefined
  if (input.includes('slack.com')) {
    const parsed = parseSlackUrl(input)
    if (!parsed) {
      console.error('Could not parse Slack URL:', input)
      process.exit(1)
    }
    messageTs = parsed.ts
    threadTs = parsed.threadTs
    console.log(`Parsed URL: channel=${parsed.channel}, ts=${messageTs}${threadTs ? `, thread_ts=${threadTs}` : ''}\n`)
  } else {
    messageTs = input
  }

  // Find trace - try message ts first, then thread ts
  let traceResult = findTraceByMessageTs(messageTs)
  if (!traceResult && threadTs) {
    console.log(`Message ${messageTs} not found, trying thread parent ${threadTs}...\n`)
    traceResult = findTraceByMessageTs(threadTs)
  }
  if (!traceResult) {
    console.error('No trace found for message:', messageTs)
    console.error('\nAvailable traces:')
    const botDirs = readdirSync(TRACES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
    for (const botDir of botDirs) {
      const files = readdirSync(join(TRACES_DIR, botDir.name)).slice(-5)
      console.error(`  ${botDir.name}/: ${files.join(', ')}`)
    }
    process.exit(1)
  }

  const { trace, file, botDir } = traceResult
  console.log(`=== Trace: ${botDir}/${file} ===\n`)

  // Show activation info
  console.log('Activation:')
  console.log(`  Reason: ${trace.activation?.reason}`)
  console.log(`  Trigger: ${trace.triggeringMessageId}`)
  if (trace.activation?.triggerEvents?.[0]) {
    console.log(`  Content: "${trace.activation.triggerEvents[0].contentPreview}"`)
  }
  console.log()

  // Show raw messages (what was fetched)
  console.log('Raw Messages (fetched from Slack):')
  const rawMsgs = trace.rawDiscordMessages || []
  for (const msg of rawMsgs) {
    const ts = msg.id
    const author = msg.author?.username || 'unknown'
    const content = msg.content?.slice(0, 80) || ''
    const trigger = ts === trace.triggeringMessageId ? ' [TRIGGER]' : ''
    console.log(`  ${ts} ${author}: "${content}"${trigger}`)
  }
  console.log()

  // Show context build info
  if (trace.contextBuild) {
    console.log('Context Build:')
    console.log(`  Messages considered: ${trace.contextBuild.messagesConsidered}`)
    console.log(`  Messages included: ${trace.contextBuild.messagesIncluded}`)
    console.log(`  Did truncate: ${trace.contextBuild.didTruncate}`)
    console.log()
  }

  // Find and show LLM request
  const llmResult = findLlmRequestByTimestamp(trace.timestamp)
  if (llmResult) {
    console.log(`=== LLM Request: ${llmResult.file} ===\n`)
    console.log('Model:', llmResult.request.model)
    console.log('Max tokens:', llmResult.request.max_tokens)
    console.log('Temperature:', llmResult.request.temperature)
    console.log()
    console.log('Context sent to LLM:')
    console.log('---')
    for (const msg of llmResult.request.messages) {
      console.log(msg.content)
    }
    console.log('---')
    console.log()
    console.log('Stop sequences:', llmResult.request.stop_sequences)
  } else {
    console.log('(No matching LLM request found)')
  }
}

main()
