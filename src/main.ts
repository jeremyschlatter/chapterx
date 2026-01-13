/**
 * ChapterX - Multi-Platform Bot Framework
 * Main entry point
 *
 * Supports Discord and Slack platforms via PLATFORM env var
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { EventQueue } from './agent/event-queue.js'
import { AgentLoop } from './agent/loop.js'
import { ChannelStateManager } from './agent/state-manager.js'
import { DiscordConnector } from './discord/connector.js'
import { SlackConnector } from './slack/connector.js'
import { PlatformConnector } from './platform/index.js'
import { ConfigSystem } from './config/system.js'
import { ContextBuilder } from './context/builder.js'
import { LLMMiddleware } from './llm/middleware.js'
import { AnthropicProvider } from './llm/providers/anthropic.js'
import { OpenAIProvider } from './llm/providers/openai.js'
import { OpenAICompletionsProvider } from './llm/providers/openai-completions.js'
import { OpenAIImageProvider } from './llm/providers/openai-image.js'
import { OpenRouterProvider } from './llm/providers/openrouter.js'
import { ToolSystem } from './tools/system.js'
import { ApiServer } from './api/server.js'
import { logger } from './utils/logger.js'

type Platform = 'discord' | 'slack'

async function main() {
  try {
    // Determine platform
    const platform = (process.env.PLATFORM || 'discord').toLowerCase() as Platform
    if (!['discord', 'slack'].includes(platform)) {
      throw new Error(`Unknown platform: ${platform}. Supported: discord, slack`)
    }

    logger.info({ platform }, 'Starting ChapterX bot framework')

    // Support chapter2 EMS layout: EMS_PATH + BOT_NAME
    const emsPath = process.env.EMS_PATH
    const botNameOverride = process.env.BOT_NAME

    // Get configuration paths
    let configPath: string

    if (emsPath && botNameOverride) {
      configPath = emsPath
      logger.info({ emsPath, botName: botNameOverride }, 'Using chapter2 EMS layout')
    } else {
      configPath = process.env.CONFIG_PATH || './config'
      if (botNameOverride) {
        logger.info({ botName: botNameOverride }, 'Using local dev layout with BOT_NAME')
      }
    }

    const toolsPath = process.env.TOOLS_PATH || './tools'
    const cachePath = process.env.CACHE_PATH || './cache'

    logger.info({ configPath, toolsPath, cachePath, emsMode: !!emsPath }, 'Configuration loaded')

    // Initialize common components
    const queue = new EventQueue()
    const stateManager = new ChannelStateManager()
    const configSystem = new ConfigSystem(configPath)
    const contextBuilder = new ContextBuilder()
    const llmMiddleware = new LLMMiddleware()
    const toolSystem = new ToolSystem(toolsPath)

    // Load vendor configs and register providers
    const vendorConfigs = configSystem.loadVendors()
    llmMiddleware.setVendorConfigs(vendorConfigs)

    // Register providers for each vendor
    for (const [vendorName, vendorConfig] of Object.entries(vendorConfigs)) {
      const config = vendorConfig.config

      // Anthropic provider
      if (config?.anthropic_api_key) {
        const provider = new AnthropicProvider(config.anthropic_api_key)
        llmMiddleware.registerProvider(provider, vendorName)
        logger.info({ vendorName }, 'Registered Anthropic provider')
      }

      // OpenAI-compatible provider (chat completions)
      if (config?.openai_api_key) {
        const baseUrl = config.openai_base_url || config.api_base
        if (!baseUrl) {
          logger.warn({ vendorName }, 'Skipping OpenAI vendor without api_base')
          continue
        }
        const provider = new OpenAIProvider({
          apiKey: config.openai_api_key,
          baseUrl,
        })
        llmMiddleware.registerProvider(provider, vendorName)
        logger.info({ vendorName, baseUrl }, 'Registered OpenAI provider')
      }

      // OpenAI Completions provider (base models)
      if (config?.openai_completions_api_key) {
        const baseUrl = config.openai_completions_base_url || config.openai_base_url || config.api_base
        if (!baseUrl) {
          logger.warn({ vendorName }, 'Skipping OpenAI Completions vendor without base_url')
          continue
        }
        const provider = new OpenAICompletionsProvider({
          apiKey: config.openai_completions_api_key,
          baseUrl,
        })
        llmMiddleware.registerProvider(provider, vendorName)
        logger.info({ vendorName, baseUrl }, 'Registered OpenAI Completions provider')
      }

      // OpenRouter provider
      if (config?.openrouter_api_key) {
        const baseUrl = config.openrouter_base_url || 'https://openrouter.ai/api/v1'
        const provider = new OpenRouterProvider({
          apiKey: config.openrouter_api_key,
          baseUrl,
        })
        llmMiddleware.registerProvider(provider, vendorName)
        logger.info({ vendorName, baseUrl }, 'Registered OpenRouter provider')
      }

      // OpenAI Image provider
      if (config?.openai_image_api_key) {
        const baseUrl = config.openai_image_base_url || config.openai_base_url || 'https://api.openai.com/v1'
        const provider = new OpenAIImageProvider({
          apiKey: config.openai_image_api_key,
          baseUrl,
        })
        llmMiddleware.registerProvider(provider, vendorName)
        logger.info({ vendorName, baseUrl }, 'Registered OpenAI Image provider')
      }
    }

    // Initialize platform-specific connector
    let connector: PlatformConnector
    let botUserId: string | undefined
    let botUsername: string | undefined

    if (platform === 'discord') {
      connector = await initializeDiscordConnector(queue, cachePath, emsPath, botNameOverride, configPath)
    } else {
      connector = await initializeSlackConnector(queue, cachePath)
    }

    await connector.start()

    botUserId = connector.getBotUserId()
    botUsername = connector.getBotUsername()

    if (!botUserId || !botUsername) {
      throw new Error(`Failed to get bot identity from ${platform}`)
    }

    // Use BOT_NAME override or platform username for config loading
    const botName = botNameOverride || botUsername
    logger.info({ botUsername, botUserId, botName, platform, emsMode: !!emsPath }, 'Bot identity established')

    // Create and start agent loop
    const agentLoop = new AgentLoop(
      botName,
      queue,
      connector,
      stateManager,
      configSystem,
      contextBuilder,
      llmMiddleware,
      toolSystem
    )

    // Set bot's user ID for mention detection
    agentLoop.setBotUserId(botUserId)

    // Start API server if configured
    let apiServer: ApiServer | null = null
    const apiPort = process.env.API_PORT ? parseInt(process.env.API_PORT) : 3000
    const apiBearerToken = process.env.API_BEARER_TOKEN

    if (apiBearerToken) {
      apiServer = new ApiServer(
        { port: apiPort, bearerToken: apiBearerToken },
        connector
      )
      await apiServer.start()
    } else {
      logger.info('API server disabled (no API_BEARER_TOKEN set)')
    }

    // Handle shutdown
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutting down')

      agentLoop.stop()
      if (apiServer) {
        await apiServer.stop()
      }
      await connector.close()
      await toolSystem.close()

      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Start the loop
    await agentLoop.run()

  } catch (error) {
    logger.fatal({ error }, 'Fatal error')
    process.exit(1)
  }
}

async function initializeDiscordConnector(
  queue: EventQueue,
  cachePath: string,
  emsPath: string | undefined,
  botNameOverride: string | undefined,
  configPath: string
): Promise<DiscordConnector> {
  // Determine token file path
  let tokenFilePath: string

  if (emsPath && botNameOverride) {
    tokenFilePath = join(emsPath, botNameOverride, 'discord_token')
  } else if (botNameOverride) {
    tokenFilePath = process.env.DISCORD_TOKEN_FILE
      ? join(process.cwd(), process.env.DISCORD_TOKEN_FILE)
      : join(configPath, 'bots', `${botNameOverride}_discord_token`)
  } else {
    tokenFilePath = process.env.DISCORD_TOKEN_FILE
      ? join(process.cwd(), process.env.DISCORD_TOKEN_FILE)
      : join(process.cwd(), 'discord_token')
  }

  // Read Discord token from file
  let discordToken: string
  try {
    discordToken = readFileSync(tokenFilePath, 'utf-8').trim()
    logger.info({ tokenFile: tokenFilePath }, 'Discord token loaded from file')
  } catch (error) {
    logger.error({ error, tokenFile: tokenFilePath }, 'Failed to read discord_token file')
    throw new Error(`Could not read token file: ${tokenFilePath}. Please create it with your bot token.`)
  }

  if (!discordToken) {
    throw new Error('discord_token file is empty')
  }

  return new DiscordConnector(queue, {
    token: discordToken,
    cacheDir: cachePath + '/images',
    maxBackoffMs: 32000,
  })
}

async function initializeSlackConnector(
  queue: EventQueue,
  cachePath: string
): Promise<SlackConnector> {
  // Read Slack tokens from environment
  const botToken = process.env.SLACK_BOT_TOKEN
  const appToken = process.env.SLACK_APP_TOKEN
  const signingSecret = process.env.SLACK_SIGNING_SECRET

  if (!botToken) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required')
  }

  if (!appToken) {
    throw new Error('SLACK_APP_TOKEN environment variable is required (for socket mode)')
  }

  logger.info('Slack tokens loaded from environment')

  return new SlackConnector(queue, {
    botToken,
    appToken,
    signingSecret,
    cacheDir: cachePath + '/images',
    maxBackoffMs: 32000,
  })
}

// Run
main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
