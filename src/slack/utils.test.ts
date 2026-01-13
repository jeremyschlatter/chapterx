/**
 * Unit tests for Slack utility functions
 */

import { describe, it, expect } from 'vitest'
import {
  parseSlackMessageUrl,
  tsToUrlFormat,
  buildSlackMessageUrl,
  isSlackMessageUrl,
  extractSlackUrls,
  parseSlackLinks,
  tsToDate,
  dateToTs,
  compareTs,
} from './utils.js'

describe('parseSlackMessageUrl', () => {
  it('parses standard Slack message URL', () => {
    const url = 'https://workspace.slack.com/archives/C123ABC/p1234567890123456'
    const result = parseSlackMessageUrl(url)
    expect(result).toEqual({
      channel: 'C123ABC',
      ts: '1234567890.123456',
      threadTs: undefined,
    })
  })

  it('parses URL with thread_ts parameter', () => {
    const url = 'https://workspace.slack.com/archives/C123ABC/p1234567890123456?thread_ts=1234567890.654321'
    const result = parseSlackMessageUrl(url)
    expect(result).toEqual({
      channel: 'C123ABC',
      ts: '1234567890.123456',
      threadTs: '1234567890.654321',
    })
  })

  it('handles different workspace names', () => {
    const url = 'https://my-company.slack.com/archives/C999XYZ/p9876543210654321'
    const result = parseSlackMessageUrl(url)
    expect(result).toEqual({
      channel: 'C999XYZ',
      ts: '9876543210.654321',
      threadTs: undefined,
    })
  })

  it('returns null for invalid URL', () => {
    expect(parseSlackMessageUrl('not a url')).toBeNull()
    expect(parseSlackMessageUrl('https://example.com')).toBeNull()
    expect(parseSlackMessageUrl('https://slack.com/missing/path')).toBeNull()
  })

  it('returns null for Discord URL', () => {
    const url = 'https://discord.com/channels/123/456/789'
    expect(parseSlackMessageUrl(url)).toBeNull()
  })
})

describe('tsToUrlFormat', () => {
  it('converts timestamp to URL format', () => {
    expect(tsToUrlFormat('1234567890.123456')).toBe('p1234567890123456')
  })

  it('handles timestamps with different decimal places', () => {
    expect(tsToUrlFormat('1234567890.000001')).toBe('p1234567890000001')
    expect(tsToUrlFormat('9999999999.999999')).toBe('p9999999999999999')
  })
})

describe('buildSlackMessageUrl', () => {
  it('builds URL without thread_ts', () => {
    const url = buildSlackMessageUrl('myworkspace', 'C123ABC', '1234567890.123456')
    expect(url).toBe('https://myworkspace.slack.com/archives/C123ABC/p1234567890123456')
  })

  it('builds URL with thread_ts', () => {
    const url = buildSlackMessageUrl('myworkspace', 'C123ABC', '1234567890.123456', '1234567890.000001')
    expect(url).toBe('https://myworkspace.slack.com/archives/C123ABC/p1234567890123456?thread_ts=1234567890.000001')
  })
})

describe('isSlackMessageUrl', () => {
  it('returns true for valid Slack URLs', () => {
    expect(isSlackMessageUrl('https://workspace.slack.com/archives/C123/p1234567890123456')).toBe(true)
    expect(isSlackMessageUrl('https://my-company.slack.com/archives/C999XYZ/p9876543210654321')).toBe(true)
  })

  it('returns false for non-Slack URLs', () => {
    expect(isSlackMessageUrl('https://discord.com/channels/123/456/789')).toBe(false)
    expect(isSlackMessageUrl('https://example.com')).toBe(false)
    expect(isSlackMessageUrl('not a url')).toBe(false)
  })
})

describe('extractSlackUrls', () => {
  it('extracts single URL from text', () => {
    const text = 'Check out this message: https://workspace.slack.com/archives/C123/p1234567890123456'
    const urls = extractSlackUrls(text)
    expect(urls).toEqual(['https://workspace.slack.com/archives/C123/p1234567890123456'])
  })

  it('extracts multiple URLs from text', () => {
    const text = `
      First: https://workspace.slack.com/archives/C123/p1111111111111111
      Second: https://workspace.slack.com/archives/C456/p2222222222222222
    `
    const urls = extractSlackUrls(text)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe('https://workspace.slack.com/archives/C123/p1111111111111111')
    expect(urls[1]).toBe('https://workspace.slack.com/archives/C456/p2222222222222222')
  })

  it('returns empty array when no URLs found', () => {
    expect(extractSlackUrls('no urls here')).toEqual([])
    expect(extractSlackUrls('')).toEqual([])
  })
})

describe('parseSlackLinks', () => {
  it('extracts URL from link format', () => {
    const text = 'Check <https://example.com|this link>'
    expect(parseSlackLinks(text)).toBe('Check https://example.com')
  })

  it('handles links without display text', () => {
    const text = 'Visit <https://example.com>'
    expect(parseSlackLinks(text)).toBe('Visit https://example.com')
  })

  it('extracts display text when keepUrl is false', () => {
    const text = 'Check <https://example.com|this link>'
    expect(parseSlackLinks(text, false)).toBe('Check this link')
  })

  it('handles multiple links', () => {
    const text = '<https://a.com|A> and <https://b.com|B>'
    expect(parseSlackLinks(text)).toBe('https://a.com and https://b.com')
  })
})

describe('tsToDate', () => {
  it('converts timestamp to Date', () => {
    const date = tsToDate('1234567890.123456')
    expect(date.getTime()).toBe(1234567890123)
  })

  it('handles round timestamps', () => {
    const date = tsToDate('1000000000.000000')
    expect(date.getTime()).toBe(1000000000000)
  })
})

describe('dateToTs', () => {
  it('converts Date to timestamp', () => {
    const date = new Date(1234567890123)
    const ts = dateToTs(date)
    expect(ts).toBe('1234567890.123000')
  })
})

describe('compareTs', () => {
  it('returns negative when ts1 < ts2', () => {
    expect(compareTs('1234567890.000000', '1234567891.000000')).toBeLessThan(0)
    expect(compareTs('1234567890.000001', '1234567890.000002')).toBeLessThan(0)
  })

  it('returns positive when ts1 > ts2', () => {
    expect(compareTs('1234567891.000000', '1234567890.000000')).toBeGreaterThan(0)
    expect(compareTs('1234567890.000002', '1234567890.000001')).toBeGreaterThan(0)
  })

  it('returns zero when timestamps are equal', () => {
    expect(compareTs('1234567890.123456', '1234567890.123456')).toBe(0)
  })

  it('compares seconds first, then microseconds', () => {
    // Same seconds, different microseconds
    expect(compareTs('1234567890.999999', '1234567890.000001')).toBeGreaterThan(0)
    // Different seconds (second wins)
    expect(compareTs('1234567891.000000', '1234567890.999999')).toBeGreaterThan(0)
  })
})
