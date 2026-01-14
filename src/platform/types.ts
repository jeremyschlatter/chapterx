/**
 * Platform-agnostic types for ChapterX
 *
 * These types abstract away Discord/Slack specifics, allowing the core
 * bot logic to work with any chat platform.
 */

import { CachedImage, CachedDocument } from '../types.js'

/**
 * Platform-agnostic message format
 * This is the normalized format used throughout the system
 *
 * Note: Uses guildId for Discord compatibility. Slack connectors should map
 * workspace/team ID to this field.
 */
export interface PlatformMessage {
  id: string
  channelId: string
  guildId: string // Guild in Discord, workspace/team in Slack
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
  mentions: string[] // User IDs
  referencedMessage?: string // Reply to message ID
  threadId?: string // For Slack thread support (thread_ts)
}

export interface PlatformAttachment {
  id: string
  url: string
  filename: string
  contentType?: string
  size: number
  width?: number
  height?: number
}

/**
 * Context fetched from platform
 */
export interface PlatformContext {
  messages: PlatformMessage[]
  pinnedConfigs: string[] // Raw YAML strings from pinned messages
  images: CachedImage[]
  documents: CachedDocument[]
  guildId: string // Guild in Discord, workspace/team in Slack
  inheritanceInfo?: {
    parentChannelId?: string
    historyOriginChannelId?: string
  }
}

/**
 * Parameters for fetching context
 */
export interface FetchContextParams {
  channelId: string
  depth: number // Max messages
  targetMessageId?: string // Optional: Fetch backward from this message ID
  firstMessageId?: string // Optional: Stop when this message is encountered
  threadTs?: string // Optional: For Slack threads - fetch thread replies instead of channel history
  authorized_roles?: string[]
  pinnedConfigs?: string[] // Optional: Pre-fetched pinned configs
}

/**
 * Event types
 */
export type PlatformEventType =
  | 'message'
  | 'reaction'
  | 'edit'
  | 'delete'
  | 'self_activation'
  | 'timer'
  | 'internal'

export interface PlatformEvent {
  type: PlatformEventType
  channelId: string
  guildId: string // Guild in Discord, workspace/team in Slack
  data: any
  timestamp: Date
}

/**
 * User info returned from resolution
 */
export interface UserInfo {
  id: string
  username: string
  displayName: string
  bot: boolean
}

/**
 * File attachment for sending
 */
export interface SendAttachment {
  name: string
  content: string | Buffer
}

/**
 * Platform-specific error
 */
export class PlatformError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message)
    this.name = 'PlatformError'
  }
}
