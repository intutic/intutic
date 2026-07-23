import { describe, it, expect } from 'vitest'
import { normalizeRequest, normalizeResponse } from '../src/schema-enforcer'

describe('schema-enforcer', () => {
  describe('normalizeRequest', () => {
    it('returns params as-is when provider is openai or omitted', () => {
      const params: any = { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] }
      expect(normalizeRequest(params)).toBe(params)
      expect(normalizeRequest(params, 'openai')).toBe(params)
    })

    it('translates OpenAI messages to Anthropic format when provider is anthropic', () => {
      const openAiParams: any = {
        model: 'claude-3',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'What is 2+2?' },
        ],
        temperature: 0.5,
      }

      const result = normalizeRequest(openAiParams, 'anthropic')

      expect(result.model).toBe('claude-3')
      expect(result.system).toBe('You are a helpful assistant.')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]).toEqual({
        role: 'user',
        content: 'What is 2+2?',
      })
      expect(result.temperature).toBe(0.5)
    })

    it('maps tools to input_schema for Anthropic', () => {
      const openAiParams: any = {
        model: 'claude-3',
        messages: [{ role: 'user', content: 'search' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'web_search',
              description: 'Searches the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
        ],
      }

      const result = normalizeRequest(openAiParams, 'anthropic')
      expect(result.tools).toHaveLength(1)
      expect(result.tools[0]).toEqual({
        name: 'web_search',
        description: 'Searches the web',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      })
    })
  })

  describe('normalizeResponse', () => {
    it('returns response as-is when provider is openai', () => {
      const response: any = { id: 'chatcmpl-123', choices: [] }
      expect(normalizeResponse(response)).toBe(response)
    })

    it('converts Anthropic Messages response back to OpenAI ChatResponse format', () => {
      const anthropicResponse = {
        id: 'msg_01X',
        model: 'claude-3-opus',
        content: [{ type: 'text', text: 'Anthropic text response.' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 15,
          output_tokens: 25,
        },
      }

      const result = normalizeResponse(anthropicResponse, 'anthropic')

      expect(result.id).toBe('msg_01X')
      expect(result.model).toBe('claude-3-opus')
      expect(result.choices[0].message.content).toBe('Anthropic text response.')
      expect(result.choices[0].message.role).toBe('assistant')
      expect(result.choices[0].finish_reason).toBe('stop')
      expect(result.usage).toEqual({
        prompt_tokens: 15,
        completion_tokens: 25,
        total_tokens: 40,
      })
    })
  })
})
