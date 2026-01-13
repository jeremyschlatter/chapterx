/**
 * Slack-specific utility functions
 */

/**
 * Parse a Slack message URL to extract channel and timestamp
 *
 * URL formats:
 * - https://workspace.slack.com/archives/C123456/p1234567890123456
 * - https://workspace.slack.com/archives/C123456/p1234567890123456?thread_ts=1234567890.123456
 *
 * The 'p' prefix + timestamp (no decimal) represents the message ID.
 * We convert it to the API format: 1234567890.123456
 */
export function parseSlackMessageUrl(url: string): { channel: string; ts: string; threadTs?: string } | null {
  try {
    const parsed = new URL(url)

    // Match /archives/CHANNEL_ID/pTIMESTAMP pattern
    const match = parsed.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/)
    if (!match) {
      return null
    }

    const channel = match[1]!
    const rawTs = match[2]!

    // Convert p1234567890123456 to 1234567890.123456
    // The timestamp is microseconds since epoch, but stored without decimal
    // First 10 digits are seconds, rest are microseconds
    const ts = rawTs.slice(0, 10) + '.' + rawTs.slice(10)

    // Check for thread_ts in query params
    const threadTs = parsed.searchParams.get('thread_ts') || undefined

    return { channel, ts, threadTs }
  } catch {
    return null
  }
}

/**
 * Convert a Slack timestamp to a URL-safe format
 * 1234567890.123456 -> p1234567890123456
 */
export function tsToUrlFormat(ts: string): string {
  return 'p' + ts.replace('.', '')
}

/**
 * Build a Slack message URL
 */
export function buildSlackMessageUrl(
  workspace: string,
  channel: string,
  ts: string,
  threadTs?: string
): string {
  const base = `https://${workspace}.slack.com/archives/${channel}/${tsToUrlFormat(ts)}`
  if (threadTs) {
    return `${base}?thread_ts=${threadTs}`
  }
  return base
}

/**
 * Check if a string is a Slack message URL
 */
export function isSlackMessageUrl(text: string): boolean {
  return /slack\.com\/archives\/[A-Z0-9]+\/p\d+/.test(text)
}

/**
 * Extract all Slack message URLs from text
 */
export function extractSlackUrls(text: string): string[] {
  const regex = /https?:\/\/\S+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+[^\s]*/g
  return text.match(regex) || []
}

/**
 * Convert Slack's user mention format to a normalized format
 * <@U123456> -> <@username>
 *
 * This is an async operation that requires API calls
 */
export async function normalizeMentions(
  text: string,
  getUserName: (userId: string) => Promise<string | undefined>
): Promise<string> {
  const mentionRegex = /<@(\w+)>/g
  const matches = Array.from(text.matchAll(mentionRegex))

  let result = text
  for (const match of matches) {
    const userId = match[1]!
    const username = await getUserName(userId)
    if (username) {
      result = result.replace(match[0], `<@${username}>`)
    }
  }

  return result
}

/**
 * Convert normalized mentions back to Slack format
 * <@username> -> <@U123456>
 */
export async function denormalizeMentions(
  text: string,
  getUserId: (username: string) => Promise<string | undefined>
): Promise<string> {
  const mentionRegex = /<@([^>]+)>/g
  const matches = Array.from(text.matchAll(mentionRegex))

  let result = text
  for (const match of matches) {
    const username = match[1]!
    // Skip if already a user ID
    if (username.startsWith('U') && /^U\w+$/.test(username)) {
      continue
    }
    const userId = await getUserId(username)
    if (userId) {
      result = result.replace(match[0], `<@${userId}>`)
    }
  }

  return result
}

/**
 * Parse Slack's special link format
 * <URL|display text> -> just URL or display text
 */
export function parseSlackLinks(text: string, keepUrl = true): string {
  const linkRegex = /<(https?:\/\/[^|>]+)\|?([^>]*)>/g
  return text.replace(linkRegex, (_, url, display) => {
    if (keepUrl) {
      return url
    }
    return display || url
  })
}

/**
 * Convert Slack timestamp to Date
 */
export function tsToDate(ts: string): Date {
  return new Date(parseFloat(ts) * 1000)
}

/**
 * Convert Date to Slack timestamp
 */
export function dateToTs(date: Date): string {
  const seconds = Math.floor(date.getTime() / 1000)
  const microseconds = (date.getTime() % 1000) * 1000
  return `${seconds}.${microseconds.toString().padStart(6, '0')}`
}

/**
 * Compare two Slack timestamps
 * Returns negative if ts1 < ts2, positive if ts1 > ts2, 0 if equal
 */
export function compareTs(ts1: string, ts2: string): number {
  const [sec1, micro1] = ts1.split('.').map(Number)
  const [sec2, micro2] = ts2.split('.').map(Number)

  if (sec1! !== sec2!) {
    return sec1! - sec2!
  }
  return (micro1 || 0) - (micro2 || 0)
}
