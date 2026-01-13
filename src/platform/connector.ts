/**
 * Platform Connector Interface
 *
 * Abstract interface for chat platform connectors (Discord, Slack, etc.)
 * Implementations handle platform-specific API calls and event handling.
 */

import {
  PlatformContext,
  PlatformMessage,
  FetchContextParams,
  SendAttachment,
} from './types.js'

export interface PlatformConnector {
  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Start the connector (login, connect websocket, etc.)
   */
  start(): Promise<void>

  /**
   * Close the connector gracefully
   */
  close(): Promise<void>

  // ============================================================================
  // Identity
  // ============================================================================

  /**
   * Get bot's user ID on the platform
   */
  getBotUserId(): string | undefined

  /**
   * Get bot's username on the platform
   */
  getBotUsername(): string | undefined

  // ============================================================================
  // Context Fetching
  // ============================================================================

  /**
   * Fetch context from a channel (messages, images, documents, configs)
   */
  fetchContext(params: FetchContextParams): Promise<PlatformContext>

  /**
   * Fetch just pinned configs from a channel (fast - single API call)
   * Used to load config BEFORE determining fetch depth
   */
  fetchPinnedConfigs(channelId: string): Promise<string[]>

  /**
   * Get channel name by ID
   */
  getChannelName(channelId: string): Promise<string | undefined>

  /**
   * Get parent channel ID for a thread
   * Returns undefined for non-thread channels
   */
  getParentChannelId(channelId: string): Promise<string | undefined>

  // ============================================================================
  // Message Sending
  // ============================================================================

  /**
   * Send a text message (auto-splits if too long)
   * Returns array of sent message IDs
   */
  sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<string[]>

  /**
   * Send a message with a text file attachment
   */
  sendMessageWithAttachment(
    channelId: string,
    content: string,
    attachment: SendAttachment,
    replyToMessageId?: string
  ): Promise<string[]>

  /**
   * Send an image attachment (base64 encoded)
   */
  sendImageAttachment(
    channelId: string,
    imageBase64: string,
    mediaType: string,
    caption?: string,
    replyToMessageId?: string
  ): Promise<string[]>

  /**
   * Send a webhook message (for tool output display)
   * Falls back to regular message if webhooks aren't supported
   */
  sendWebhook(channelId: string, content: string, username: string): Promise<void>

  /**
   * Pin a message in a channel
   */
  pinMessage(channelId: string, messageId: string): Promise<void>

  // ============================================================================
  // Message Management
  // ============================================================================

  /**
   * Delete a message
   */
  deleteMessage(channelId: string, messageId: string): Promise<void>

  /**
   * Add a reaction to a message
   */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>

  // ============================================================================
  // Typing Indicator
  // ============================================================================

  /**
   * Start typing indicator (refreshes automatically)
   */
  startTyping(channelId: string): Promise<void>

  /**
   * Stop typing indicator
   */
  stopTyping(channelId: string): Promise<void>

  // ============================================================================
  // Bot Loop Prevention
  // ============================================================================

  /**
   * Get the bot reply chain depth for a message
   * Counts consecutive bot messages in the reply chain
   */
  getBotReplyChainDepth(channelId: string, message: any): Promise<number>

  // ============================================================================
  // Message Conversion (Platform-specific)
  // ============================================================================

  /**
   * Convert platform-native message to PlatformMessage format
   * Public for API access
   */
  convertMessage(msg: any, messageMap?: Map<string, any>): PlatformMessage
}

/**
 * Base options for platform connectors
 */
export interface ConnectorOptions {
  cacheDir: string
  maxBackoffMs: number
}
