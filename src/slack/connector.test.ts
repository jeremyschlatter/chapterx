/**
 * Unit tests for SlackConnector URL parsing logic
 * Tests URL extraction without requiring Slack API
 */

import { describe, it, expect } from 'vitest'
import { parseSlackMessageUrl, isSlackMessageUrl } from './utils.js'

/**
 * These functions mirror the SlackConnector.extractMessageIdFromUrl
 * and extractChannelIdFromUrl methods. Testing them directly avoids
 * the need to mock the Slack API.
 */

function extractMessageIdFromUrl(url: string): string | null {
  // Try Slack format first
  const slackParsed = parseSlackMessageUrl(url)
  if (slackParsed) {
    return slackParsed.ts
  }
  // Fallback to Discord format
  const discordMatch = url.match(/\/channels\/\d+\/\d+\/(\d+)/)
  return discordMatch ? discordMatch[1]! : null
}

function extractChannelIdFromUrl(url: string): string | null {
  // Try Slack format first
  const slackParsed = parseSlackMessageUrl(url)
  if (slackParsed) {
    return slackParsed.channel
  }
  // Fallback to Discord format
  const discordMatch = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
  return discordMatch ? discordMatch[1]! : null
}

function parseHistoryCommand(content: string): { last: string; first?: string } | null {
  const trimmed = content.trim()
  if (trimmed === '.history') {
    return null
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) {
    return null
  }

  const last = parts[1]!
  const first = parts.length > 2 ? parts[2] : undefined

  // Validate URLs
  if (!isSlackMessageUrl(last) && !last.includes('discord.com/channels')) {
    return null
  }

  return { last, first }
}

describe('URL Extraction (Slack Connector Logic)', () => {
  describe('extractMessageIdFromUrl', () => {
    it('extracts message ID from Slack URL', () => {
      const url = 'https://workspace.slack.com/archives/C123ABC/p1234567890123456'
      expect(extractMessageIdFromUrl(url)).toBe('1234567890.123456')
    })

    it('extracts message ID from Discord URL (fallback)', () => {
      const url = 'https://discord.com/channels/111/222/333'
      expect(extractMessageIdFromUrl(url)).toBe('333')
    })

    it('returns null for invalid URL', () => {
      expect(extractMessageIdFromUrl('not a url')).toBeNull()
      expect(extractMessageIdFromUrl('https://example.com')).toBeNull()
    })
  })

  describe('extractChannelIdFromUrl', () => {
    it('extracts channel ID from Slack URL', () => {
      const url = 'https://workspace.slack.com/archives/C123ABC/p1234567890123456'
      expect(extractChannelIdFromUrl(url)).toBe('C123ABC')
    })

    it('extracts channel ID from Discord URL (fallback)', () => {
      const url = 'https://discord.com/channels/111/222/333'
      expect(extractChannelIdFromUrl(url)).toBe('222')
    })

    it('returns null for invalid URL', () => {
      expect(extractChannelIdFromUrl('not a url')).toBeNull()
    })
  })
})

describe('History Command Parsing', () => {
  it('returns null for empty .history command', () => {
    expect(parseHistoryCommand('.history')).toBeNull()
    expect(parseHistoryCommand('.history   ')).toBeNull()
  })

  it('parses .history with single Slack URL', () => {
    const content = '.history https://workspace.slack.com/archives/C123/p1234567890123456'
    const result = parseHistoryCommand(content)
    expect(result).toEqual({
      last: 'https://workspace.slack.com/archives/C123/p1234567890123456',
      first: undefined,
    })
  })

  it('parses .history with two Slack URLs', () => {
    const content = '.history https://workspace.slack.com/archives/C123/p2222222222222222 https://workspace.slack.com/archives/C123/p1111111111111111'
    const result = parseHistoryCommand(content)
    expect(result).toEqual({
      last: 'https://workspace.slack.com/archives/C123/p2222222222222222',
      first: 'https://workspace.slack.com/archives/C123/p1111111111111111',
    })
  })

  it('parses .history with Discord URL (cross-platform)', () => {
    const content = '.history https://discord.com/channels/111/222/333'
    const result = parseHistoryCommand(content)
    expect(result).toEqual({
      last: 'https://discord.com/channels/111/222/333',
      first: undefined,
    })
  })

  it('returns null for .history with invalid URL', () => {
    expect(parseHistoryCommand('.history not-a-url')).toBeNull()
    expect(parseHistoryCommand('.history https://example.com')).toBeNull()
  })
})
