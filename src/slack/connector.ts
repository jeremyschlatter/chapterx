/**
 * Slack Connector
 * Handles all Slack API interactions
 * Implements PlatformConnector interface for platform abstraction
 */

import { App, LogLevel } from '@slack/bolt'
import { WebClient, ChatPostMessageResponse } from '@slack/web-api'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { EventQueue } from '../agent/event-queue.js'
import {
  CachedImage,
  CachedDocument,
} from '../types.js'
import {
  PlatformConnector,
  PlatformContext,
  PlatformMessage,
  PlatformAttachment,
  FetchContextParams,
  SendAttachment,
} from '../platform/index.js'
import { logger } from '../utils/logger.js'
import { parseSlackMessageUrl, isSlackMessageUrl } from './utils.js'

export interface SlackConnectorOptions {
  botToken: string      // xoxb-...
  appToken: string      // xapp-... (for socket mode)
  signingSecret?: string // For HTTP mode (optional with socket mode)
  cacheDir: string
  maxBackoffMs: number
}

// Re-export FetchContextParams for convenience
export type { FetchContextParams } from '../platform/index.js'

// Slack message type from API
interface SlackMessage {
  type: string
  subtype?: string
  ts: string
  user?: string
  bot_id?: string
  text?: string
  thread_ts?: string
  files?: SlackFile[]
  reactions?: Array<{ name: string; count: number; users: string[] }>
  attachments?: any[]
  blocks?: any[]
}

interface SlackFile {
  id: string
  name: string
  mimetype: string
  size: number
  url_private: string
  url_private_download?: string
  mode?: string
  thumb_360_w?: number
  thumb_360_h?: number
  original_w?: number
  original_h?: number
}

interface SlackUser {
  id: string
  name: string
  real_name?: string
  is_bot: boolean
  profile?: {
    display_name?: string
    real_name?: string
  }
}

export class SlackConnector implements PlatformConnector {
  private app: App
  private client: WebClient
  private botUserId?: string
  private botUsername?: string
  private imageCache = new Map<string, CachedImage>()
  private urlToFilename = new Map<string, string>()
  private urlMapPath: string
  private userCache = new Map<string, SlackUser>()

  constructor(
    private queue: EventQueue,
    private options: SlackConnectorOptions
  ) {
    this.app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    })

    this.client = this.app.client

    this.setupEventHandlers()

    // Ensure cache directory exists
    if (!existsSync(options.cacheDir)) {
      mkdirSync(options.cacheDir, { recursive: true })
    }

    // Load URL to filename map for persistent disk cache
    this.urlMapPath = join(options.cacheDir, 'url-map.json')
    this.loadUrlMap()
  }

  private loadUrlMap(): void {
    try {
      if (existsSync(this.urlMapPath)) {
        const data = readFileSync(this.urlMapPath, 'utf-8')
        const map = JSON.parse(data) as Record<string, string>
        for (const [url, filename] of Object.entries(map)) {
          this.urlToFilename.set(url, filename)
        }
        logger.debug({ count: this.urlToFilename.size }, 'Loaded image URL map from disk')
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to load image URL map, starting fresh')
    }
  }

  private saveUrlMap(): void {
    try {
      const map: Record<string, string> = {}
      for (const [url, filename] of this.urlToFilename) {
        map[url] = filename
      }
      writeFileSync(this.urlMapPath, JSON.stringify(map))
    } catch (error) {
      logger.warn({ error }, 'Failed to save image URL map')
    }
  }

  private setupEventHandlers(): void {
    // Handle all message events
    this.app.event('message', async ({ event }) => {
      try {
        const msg = event as any

        // Skip bot's own messages
        if (msg.bot_id && msg.user === this.botUserId) {
          return
        }

        // Handle message subtypes
        if (msg.subtype === 'message_changed') {
          this.queue.push({
            type: 'edit',
            channelId: msg.channel,
            guildId: '', // Will be set by context fetch
            data: msg,
            timestamp: new Date(parseFloat(msg.ts) * 1000),
          })
          return
        }

        if (msg.subtype === 'message_deleted') {
          this.queue.push({
            type: 'delete',
            channelId: msg.channel,
            guildId: '',
            data: msg,
            timestamp: new Date(parseFloat(msg.ts) * 1000),
          })
          return
        }

        // Regular message
        this.queue.push({
          type: 'message',
          channelId: msg.channel,
          guildId: '', // Slack doesn't expose team_id in socket mode easily
          data: msg,
          timestamp: new Date(parseFloat(msg.ts) * 1000),
        })
      } catch (error) {
        logger.error({ error }, 'Error handling Slack message event')
      }
    })

    // Handle app_mention events (when bot is @mentioned)
    this.app.event('app_mention', async ({ event }) => {
      try {
        // This is already handled by the message event
        // But we could use it for special handling if needed
        logger.debug({ event }, 'App mention received')
      } catch (error) {
        logger.error({ error }, 'Error handling app_mention event')
      }
    })

    // Handle reaction events
    this.app.event('reaction_added', async ({ event }) => {
      try {
        this.queue.push({
          type: 'reaction',
          channelId: event.item.channel,
          guildId: '',
          data: event,
          timestamp: new Date(parseFloat(event.event_ts) * 1000),
        })
      } catch (error) {
        logger.error({ error }, 'Error handling reaction_added event')
      }
    })
  }

  async start(): Promise<void> {
    await this.app.start()

    // Get bot identity
    const auth = await this.client.auth.test()
    this.botUserId = auth.user_id as string
    this.botUsername = auth.user as string

    logger.info({ botUserId: this.botUserId, botUsername: this.botUsername }, 'Slack connector started')
  }

  async close(): Promise<void> {
    this.saveUrlMap()
    await this.app.stop()
    logger.info('Slack connector closed')
  }

  getBotUserId(): string | undefined {
    return this.botUserId
  }

  getBotUsername(): string | undefined {
    return this.botUsername
  }

  // Track history origin for plugin state inheritance
  private lastHistoryOriginChannelId: string | null = null

  async fetchContext(params: FetchContextParams): Promise<PlatformContext> {
    const { channelId, depth, targetMessageId, firstMessageId, pinnedConfigs: providedConfigs } = params

    // Reset history tracking for this fetch
    this.lastHistoryOriginChannelId = null

    // Fetch pinned configs if not provided
    const pinnedConfigs = providedConfigs ?? await this.fetchPinnedConfigs(channelId)

    // Use recursive fetch with automatic .history processing
    const images: CachedImage[] = []
    const documents: CachedDocument[] = []

    let messages = await this.fetchMessagesRecursive(
      channelId,
      targetMessageId,
      undefined,  // Let .history commands define their own boundaries
      depth,
      images,
      documents
    )

    // Trim to firstMessageId if specified
    if (firstMessageId) {
      const firstIndex = messages.findIndex(m => m.id === firstMessageId)
      if (firstIndex >= 0) {
        messages = messages.slice(firstIndex)
      }
    }

    // Get team/workspace ID
    let guildId = ''
    try {
      const info = await this.client.conversations.info({ channel: channelId })
      guildId = (info.channel as any)?.context_team_id || ''
    } catch {
      // Ignore - not critical
    }

    // Build inheritance info
    const inheritanceInfo: { parentChannelId?: string; historyOriginChannelId?: string } = {}
    if (this.lastHistoryOriginChannelId) {
      inheritanceInfo.historyOriginChannelId = this.lastHistoryOriginChannelId
    }

    return {
      messages,
      pinnedConfigs,
      images,
      documents,
      guildId,
      inheritanceInfo: Object.keys(inheritanceInfo).length > 0 ? inheritanceInfo : undefined,
    }
  }

  /**
   * Recursively fetch messages with .history support
   */
  private async fetchMessagesRecursive(
    channelId: string,
    startFromTs: string | undefined,
    stopAtTs: string | undefined,
    maxMessages: number,
    images: CachedImage[],
    documents: CachedDocument[],
    recursionDepth: number = 0
  ): Promise<PlatformMessage[]> {
    if (recursionDepth > 10) {
      logger.warn({ channelId, recursionDepth }, 'Max .history recursion depth reached')
      return []
    }

    const results: PlatformMessage[] = []
    let latest = startFromTs
    let foundHistory = false
    const fetchId = Math.random().toString(36).substring(7)
    const pendingKey = `_pendingNewerMessages_${fetchId}`

    while (results.length < maxMessages) {
      const result = await this.client.conversations.history({
        channel: channelId,
        limit: Math.min(100, maxMessages - results.length),
        latest,
        inclusive: false,
      })

      if (!result.messages || result.messages.length === 0) {
        break
      }

      const batchResults: PlatformMessage[] = []

      for (const msg of result.messages as SlackMessage[]) {
        // Skip non-message subtypes we don't care about
        if (msg.subtype && !['bot_message', 'file_share', 'thread_broadcast'].includes(msg.subtype)) {
          continue
        }

        // Check if we hit the stop point
        if (stopAtTs && msg.ts === stopAtTs) {
          const converted = await this.convertSlackMessage(msg, channelId)
          batchResults.push(converted)
          results.push(...batchResults)
          return results
        }

        // Check for .history command
        if (msg.text?.startsWith('.history')) {
          logger.debug({ messageTs: msg.ts, content: msg.text }, 'Found .history command during traversal')

          const historyRange = this.parseHistoryCommand(msg.text)
          logger.debug({ historyRange, messageTs: msg.ts }, 'Parsed .history command')

          if (historyRange === null) {
            // Empty .history - clear history before this point
            logger.debug({
              resultsCount: results.length,
              batchResultsCount: batchResults.length,
            }, 'Empty .history command - keeping newer messages, discarding older')

            // Restore newer messages if we had a pending range
            if ((this as any)[pendingKey]) {
              results.length = 0
              results.push(...(this as any)[pendingKey])
              delete (this as any)[pendingKey]
            }

            batchResults.length = 0
            foundHistory = true
            continue
          } else {
            // Recursively fetch from history target
            const targetChannelId = this.extractChannelIdFromUrl(historyRange.last) || channelId
            const histLastTs = this.extractMessageIdFromUrl(historyRange.last) || undefined
            const histFirstTs = historyRange.first ? this.extractMessageIdFromUrl(historyRange.first) || undefined : undefined

            // Track that we jumped from this channel
            this.lastHistoryOriginChannelId = channelId

            logger.debug({
              targetChannelId,
              histLastTs,
              histFirstTs,
              remaining: maxMessages - results.length,
            }, 'Recursively fetching .history target')

            // Fetch historical messages
            const historicalMessages = await this.fetchMessagesRecursive(
              targetChannelId,
              histLastTs,
              histFirstTs,
              maxMessages - results.length,
              images,
              documents,
              recursionDepth + 1
            )

            logger.debug({
              historicalCount: historicalMessages.length,
              currentResultsCount: results.length,
            }, 'Fetched historical messages')

            foundHistory = true

            // Save newer messages
            const newerMessages = [...results]
            results.length = 0
            results.push(...historicalMessages)
            ;(this as any)[pendingKey] = newerMessages

            batchResults.length = 0
            continue
          }
        }

        // Regular message - collect it
        const converted = await this.convertSlackMessage(msg, channelId)
        batchResults.push(converted)

        // Collect images and documents
        if (msg.files) {
          for (const file of msg.files) {
            if (file.mimetype?.startsWith('image/')) {
              const cached = await this.fetchAndCacheImage(file)
              if (cached) images.push(cached)
            } else if (this.isTextFile(file.mimetype)) {
              const doc = await this.fetchTextDocument(file, msg.ts)
              if (doc) documents.push(doc)
            }
          }
        }
      }

      // After processing batch
      if (foundHistory) {
        results.push(...batchResults)
        const newerMessages = (this as any)[pendingKey] || []
        delete (this as any)[pendingKey]
        results.push(...newerMessages)
        break
      } else {
        results.unshift(...batchResults.reverse())
      }

      // Update cursor
      const lastMsg = result.messages[result.messages.length - 1] as SlackMessage
      latest = lastMsg.ts

      if (!result.has_more) {
        break
      }
    }

    return results
  }

  async fetchPinnedConfigs(channelId: string): Promise<string[]> {
    try {
      const result = await this.client.pins.list({ channel: channelId })
      const configs: string[] = []

      for (const item of result.items || []) {
        // Slack types don't include message property on Item, but it exists for pinned messages
        const msg = (item as any).message
        if (!msg?.text) continue

        // Look for .config format
        if (msg.text.startsWith('.config')) {
          const lines = msg.text.split('\n')
          const separatorIndex = lines.findIndex((l: string) => l.trim() === '---')
          if (separatorIndex >= 0) {
            configs.push(lines.slice(separatorIndex + 1).join('\n'))
          }
        }
      }

      return configs
    } catch (error) {
      logger.warn({ error, channelId }, 'Failed to fetch pinned configs')
      return []
    }
  }

  async getChannelName(channelId: string): Promise<string | undefined> {
    try {
      const result = await this.client.conversations.info({ channel: channelId })
      return (result.channel as any)?.name
    } catch {
      return undefined
    }
  }

  async getParentChannelId(channelId: string): Promise<string | undefined> {
    try {
      const result = await this.client.conversations.info({ channel: channelId })
      const channel = result.channel as any
      // Slack threads don't have parent channels in the same way
      // This would be used for thread parent context
      return channel?.parent_conversation
    } catch {
      return undefined
    }
  }

  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]> {
    // Slack has a 40,000 character limit, much higher than Discord
    // But we still split for readability at ~4000 chars
    const MAX_LENGTH = 4000
    const sentIds: string[] = []

    const segments = this.splitMessage(content, MAX_LENGTH)

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!
      const options: any = {
        channel: channelId,
        text: segment,
      }

      // Reply in thread if specified
      if (replyToMessageId) {
        options.thread_ts = replyToMessageId
      }

      const result = await this.client.chat.postMessage(options) as ChatPostMessageResponse
      if (result.ts) {
        sentIds.push(result.ts)
      }

      // Only the first message should be a reply
      // Subsequent messages continue in the same thread
      if (i === 0 && result.ts && !replyToMessageId) {
        // Not in a thread - subsequent messages are standalone
      } else if (result.ts) {
        // Continue in thread
        replyToMessageId = replyToMessageId || result.ts
      }
    }

    return sentIds
  }

  async sendMessageWithAttachment(
    channelId: string,
    content: string,
    attachment: SendAttachment,
    replyToMessageId?: string
  ): Promise<string[]> {
    const fileContent = typeof attachment.content === 'string'
      ? Buffer.from(attachment.content)
      : attachment.content

    const uploadArgs: any = {
      channel_id: channelId,
      filename: attachment.name,
      file: fileContent,
      initial_comment: content,
    }
    if (replyToMessageId) uploadArgs.thread_ts = replyToMessageId

    const result = await this.client.files.uploadV2(uploadArgs)

    // Extract message ts from upload result
    const file = (result as any).file
    if (file?.shares?.public) {
      const shares = Object.values(file.shares.public)[0] as any[]
      if (shares?.[0]?.ts) {
        return [shares[0].ts]
      }
    }

    return []
  }

  async sendImageAttachment(
    channelId: string,
    imageBase64: string,
    mediaType: string,
    caption?: string,
    replyToMessageId?: string
  ): Promise<string[]> {
    const buffer = Buffer.from(imageBase64, 'base64')
    const extension = mediaType.split('/')[1] || 'png'

    const uploadArgs: any = {
      channel_id: channelId,
      filename: `image.${extension}`,
      file: buffer,
      initial_comment: caption,
    }
    if (replyToMessageId) uploadArgs.thread_ts = replyToMessageId

    const result = await this.client.files.uploadV2(uploadArgs)

    const file = (result as any).file
    if (file?.shares?.public) {
      const shares = Object.values(file.shares.public)[0] as any[]
      if (shares?.[0]?.ts) {
        return [shares[0].ts]
      }
    }

    return []
  }

  async sendWebhook(channelId: string, content: string, username: string): Promise<void> {
    // Slack doesn't have webhooks in the same way as Discord
    // We can simulate by posting with a custom username in the message
    await this.client.chat.postMessage({
      channel: channelId,
      text: content,
      username: username,
      // Note: Custom usernames require specific bot permissions
    })
  }

  async pinMessage(channelId: string, messageId: string): Promise<void> {
    await this.client.pins.add({
      channel: channelId,
      timestamp: messageId,
    })
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      await this.client.chat.delete({
        channel: channelId,
        ts: messageId,
      })
    } catch (error) {
      logger.warn({ error, channelId, messageId }, 'Failed to delete message')
    }
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    // Remove colons if present (Slack uses name without colons)
    const name = emoji.replace(/^:|:$/g, '')

    await this.client.reactions.add({
      channel: channelId,
      timestamp: messageId,
      name,
    })
  }

  async startTyping(_channelId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots
    // This is a no-op
  }

  async stopTyping(_channelId: string): Promise<void> {
    // No-op for Slack
  }

  async getBotReplyChainDepth(channelId: string, message: any): Promise<number> {
    // In Slack, we check thread replies
    const msg = message as SlackMessage
    if (!msg.thread_ts) {
      return 0
    }

    try {
      const result = await this.client.conversations.replies({
        channel: channelId,
        ts: msg.thread_ts,
        limit: 10,
      })

      let depth = 0
      const messages = (result.messages || []) as SlackMessage[]

      // Count consecutive bot messages from the end
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!
        if (m.user === this.botUserId || m.bot_id) {
          depth++
        } else {
          break
        }
      }

      return depth
    } catch {
      return 0
    }
  }

  convertMessage(msg: any, _messageMap?: Map<string, any>): PlatformMessage {
    return this.convertSlackMessageSync(msg as SlackMessage, '')
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async convertSlackMessage(msg: SlackMessage, channelId: string): Promise<PlatformMessage> {
    const user = msg.user ? await this.getUser(msg.user) : undefined

    const attachments: PlatformAttachment[] = []
    if (msg.files) {
      for (const file of msg.files) {
        attachments.push({
          id: file.id,
          url: file.url_private,
          filename: file.name,
          contentType: file.mimetype,
          size: file.size,
          width: file.original_w,
          height: file.original_h,
        })
      }
    }

    // Convert reactions
    const reactions = (msg.reactions || []).map(r => ({
      emoji: r.name,
      count: r.count,
    }))

    // Extract mentions from text
    const mentions: string[] = []
    const mentionRegex = /<@(\w+)>/g
    let match
    while ((match = mentionRegex.exec(msg.text || '')) !== null) {
      mentions.push(match[1]!)
    }

    // Convert text: replace user mentions with usernames
    let content = msg.text || ''
    content = await this.convertMentionsToUsernames(content)

    return {
      id: msg.ts,
      channelId,
      guildId: '', // Set by caller
      author: {
        id: msg.user || msg.bot_id || '',
        username: user?.name || 'unknown',
        displayName: user?.profile?.display_name || user?.real_name || user?.name || 'Unknown',
        bot: !!msg.bot_id,
      },
      content,
      timestamp: new Date(parseFloat(msg.ts) * 1000),
      attachments,
      reactions,
      mentions,
      referencedMessage: msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
      threadId: msg.thread_ts,
    }
  }

  private convertSlackMessageSync(msg: SlackMessage, channelId: string): PlatformMessage {
    const attachments: PlatformAttachment[] = []
    if (msg.files) {
      for (const file of msg.files) {
        attachments.push({
          id: file.id,
          url: file.url_private,
          filename: file.name,
          contentType: file.mimetype,
          size: file.size,
          width: file.original_w,
          height: file.original_h,
        })
      }
    }

    const reactions = (msg.reactions || []).map(r => ({
      emoji: r.name,
      count: r.count,
    }))

    const mentions: string[] = []
    const mentionRegex = /<@(\w+)>/g
    let match
    while ((match = mentionRegex.exec(msg.text || '')) !== null) {
      mentions.push(match[1]!)
    }

    return {
      id: msg.ts,
      channelId,
      guildId: '',
      author: {
        id: msg.user || msg.bot_id || '',
        username: msg.user || 'unknown',
        displayName: msg.user || 'Unknown',
        bot: !!msg.bot_id,
      },
      content: msg.text || '',
      timestamp: new Date(parseFloat(msg.ts) * 1000),
      attachments,
      reactions,
      mentions,
      referencedMessage: msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
      threadId: msg.thread_ts,
    }
  }

  private async getUser(userId: string): Promise<SlackUser | undefined> {
    // Check cache first
    if (this.userCache.has(userId)) {
      return this.userCache.get(userId)
    }

    try {
      const result = await this.client.users.info({ user: userId })
      const user = result.user as SlackUser
      if (user) {
        this.userCache.set(userId, user)
      }
      return user
    } catch {
      return undefined
    }
  }

  private async convertMentionsToUsernames(text: string): Promise<string> {
    const mentionRegex = /<@(\w+)>/g
    const matches = text.matchAll(mentionRegex)

    let result = text
    for (const match of matches) {
      const userId = match[1]!
      const user = await this.getUser(userId)
      if (user) {
        const displayName = user.profile?.display_name || user.real_name || user.name
        result = result.replace(match[0], `<@${displayName}>`)
      }
    }

    return result
  }

  private async fetchAndCacheImage(file: SlackFile): Promise<CachedImage | null> {
    const url = file.url_private

    // Check memory cache
    if (this.imageCache.has(url)) {
      return this.imageCache.get(url)!
    }

    // Check disk cache
    const existingFilename = this.urlToFilename.get(url)
    if (existingFilename) {
      const cachePath = join(this.options.cacheDir, existingFilename)
      if (existsSync(cachePath)) {
        const data = readFileSync(cachePath)
        const hash = existingFilename.split('.')[0]! // Extract hash from filename
        const cached: CachedImage = {
          url,
          data,
          mediaType: file.mimetype,
          hash,
          width: file.original_w,
          height: file.original_h,
        }
        this.imageCache.set(url, cached)
        return cached
      }
    }

    // Fetch from Slack (requires auth)
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.options.botToken}`,
        },
      })

      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'Failed to fetch image')
        return null
      }

      const data = Buffer.from(await response.arrayBuffer())

      // Cache to disk
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 16)
      const ext = file.mimetype.split('/')[1] || 'bin'
      const filename = `${hash}.${ext}`
      const cachePath = join(this.options.cacheDir, filename)

      writeFileSync(cachePath, data)
      this.urlToFilename.set(url, filename)
      this.saveUrlMap()

      const cached: CachedImage = {
        url,
        data,
        mediaType: file.mimetype,
        hash,
        width: file.original_w,
        height: file.original_h,
      }
      this.imageCache.set(url, cached)

      return cached
    } catch (error) {
      logger.error({ error, url }, 'Error fetching image')
      return null
    }
  }

  private isTextFile(mimetype: string | undefined): boolean {
    if (!mimetype) return false
    return (
      mimetype.startsWith('text/') ||
      mimetype === 'application/json' ||
      mimetype === 'application/javascript' ||
      mimetype === 'application/xml' ||
      mimetype === 'application/yaml'
    )
  }

  private async fetchTextDocument(file: SlackFile, messageId: string): Promise<CachedDocument | null> {
    try {
      const response = await fetch(file.url_private, {
        headers: {
          'Authorization': `Bearer ${this.options.botToken}`,
        },
      })

      if (!response.ok) {
        return null
      }

      const text = await response.text()
      const maxSize = 200 * 1024 // 200KB limit

      return {
        messageId,
        url: file.url_private,
        filename: file.name,
        contentType: file.mimetype,
        text: text.slice(0, maxSize),
        size: file.size,
        truncated: file.size > maxSize,
      }
    } catch {
      return null
    }
  }

  private splitMessage(content: string, maxLength: number): string[] {
    if (content.length <= maxLength) {
      return [content]
    }

    const segments: string[] = []
    let remaining = content

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        segments.push(remaining)
        break
      }

      // Find a good split point
      let splitIndex = maxLength

      // Try to split at newline
      const newlineIndex = remaining.lastIndexOf('\n', maxLength)
      if (newlineIndex > maxLength * 0.5) {
        splitIndex = newlineIndex + 1
      } else {
        // Try to split at space
        const spaceIndex = remaining.lastIndexOf(' ', maxLength)
        if (spaceIndex > maxLength * 0.5) {
          splitIndex = spaceIndex + 1
        }
      }

      segments.push(remaining.slice(0, splitIndex))
      remaining = remaining.slice(splitIndex)
    }

    return segments
  }

  // URL parsing methods for .history command support
  extractMessageIdFromUrl(url: string): string | null {
    // Try Slack format first
    const slackParsed = parseSlackMessageUrl(url)
    if (slackParsed) {
      return slackParsed.ts
    }
    // Fallback to Discord format for cross-platform compatibility
    const discordMatch = url.match(/\/channels\/\d+\/\d+\/(\d+)/)
    return discordMatch ? discordMatch[1]! : null
  }

  extractChannelIdFromUrl(url: string): string | null {
    // Try Slack format first
    const slackParsed = parseSlackMessageUrl(url)
    if (slackParsed) {
      return slackParsed.channel
    }
    // Fallback to Discord format
    const discordMatch = url.match(/\/channels\/\d+\/(\d+)\/\d+/)
    return discordMatch ? discordMatch[1]! : null
  }

  /**
   * Parse a .history command to extract range URLs
   * Format: .history last_url first_url (optional)
   * Returns null for empty .history (clear command)
   */
  private parseHistoryCommand(content: string): { last: string; first?: string } | null {
    const trimmed = content.trim()
    if (trimmed === '.history') {
      return null  // Empty .history = clear
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
}
