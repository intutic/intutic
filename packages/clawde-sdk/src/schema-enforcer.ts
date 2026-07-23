import { ChatParams, ChatResponse } from './types'

export function normalizeRequest(params: ChatParams, provider?: string): any {
  if (!provider || provider === 'openai') {
    return params
  }

  if (provider === 'anthropic') {
    // If request is formatted as OpenAI, but provider is Anthropic, translate it to Anthropic
    // 1. Separate system message
    let system = params.system || ''
    const filteredMessages = params.messages.filter((msg) => {
      if (msg.role === 'system') {
        system = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        return false
      }
      return true
    })

    const anthropicParams: any = {
      model: params.model,
      messages: filteredMessages.map((msg) => {
        // Translate roles
        let role = msg.role
        if (role === 'tool') {
          role = 'user' // Anthropic packages tool response in a user message block
        }
        return {
          role,
          content: msg.content,
        }
      }),
      max_tokens: params.max_tokens || params.max_tokens_to_sample || 1024,
      temperature: params.temperature ?? 0.7,
    }

    if (system) {
      anthropicParams.system = system
    }

    if (params.tools) {
      anthropicParams.tools = params.tools.map((tool: any) => {
        if (tool.type === 'function') {
          return {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          }
        }
        return tool
      })
    }

    return anthropicParams
  }

  return params
}

export function normalizeResponse(response: any, provider?: string): ChatResponse {
  if (!provider || provider === 'openai') {
    return response as ChatResponse
  }

  if (provider === 'anthropic') {
    // Translate Anthropic message response back to OpenAI ChatResponse
    const openAiChoice = {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: response.content?.[0]?.text || response.content || '',
      },
      finish_reason: response.stop_reason === 'end_turn' ? 'stop' : (response.stop_reason || 'stop'),
    }

    return {
      id: response.id || `anthropic-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model || 'unknown',
      choices: [openAiChoice],
      usage: response.usage ? {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      } : undefined,
    }
  }

  return response as ChatResponse
}
