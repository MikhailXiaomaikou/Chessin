import Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_ANTHROPIC_MODEL, type LlmChatRequest, type LlmChatResponse } from './types'

// The no-engine rule is enforced here, by construction: an LLM player is a single
// plain chat request (position in, text out). We never send tools, function
// definitions, MCP servers, code execution or web search, so the model has no
// way to run Stockfish or any other program — only its own reasoning.
const TOOL_ACCESS_KEYS = [
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'mcp_servers',
  'container',
  'web_search_options',
  'plugins'
]

export function assertNoToolAccess(body: Record<string, unknown>): void {
  for (const key of TOOL_ACCESS_KEYS) {
    if (key in body) {
      throw new Error(`LLM players may not be given tool access (request contained "${key}")`)
    }
  }
}

export function buildAnthropicParams(req: LlmChatRequest): Anthropic.MessageCreateParamsNonStreaming {
  const { config, system, messages } = req
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: config.model || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: 16000,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content }))
  }
  if (config.effort) {
    params.output_config = { effort: config.effort }
  }
  assertNoToolAccess(params as unknown as Record<string, unknown>)
  return params
}

export function buildOpenAiBody(req: LlmChatRequest): Record<string, unknown> {
  const { config, system, messages } = req
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: 'system', content: system }, ...messages]
  }
  if (typeof config.temperature === 'number') {
    body.temperature = config.temperature
  }
  assertNoToolAccess(body)
  return body
}

async function chatAnthropic(req: LlmChatRequest, browser: boolean): Promise<LlmChatResponse> {
  const client = new Anthropic({
    apiKey: req.config.apiKey,
    baseURL: req.config.baseUrl?.trim() || undefined,
    dangerouslyAllowBrowser: browser
  })
  try {
    const response = await client.messages.create(buildAnthropicParams(req))
    if (response.stop_reason === 'refusal') {
      return { ok: false, error: 'The model declined to answer (stop_reason: refusal)' }
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    return {
      ok: true,
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      }
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: 'Invalid Anthropic API key' }
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, error: 'Rate limited by Anthropic, try again shortly' }
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, error: `Anthropic API error ${error.status ?? ''}: ${error.message}` }
    }
    return { ok: false, error: String(error) }
  }
}

async function chatOpenAi(req: LlmChatRequest): Promise<LlmChatResponse> {
  const base = (req.config.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (req.config.apiKey) headers.Authorization = `Bearer ${req.config.apiKey}`
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAiBody(req))
    })
    const raw = await res.text()
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${raw.slice(0, 300)}` }
    }
    const data = JSON.parse(raw)
    const text: unknown = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      return { ok: false, error: `Unexpected response: ${raw.slice(0, 300)}` }
    }
    return {
      ok: true,
      text,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
        : undefined
    }
  } catch (error) {
    return { ok: false, error: `Request to ${base} failed: ${String(error)}` }
  }
}

export async function chatWithLlm(
  req: LlmChatRequest,
  opts: { browser: boolean } = { browser: false }
): Promise<LlmChatResponse> {
  if (req.config.provider === 'anthropic') return chatAnthropic(req, opts.browser)
  return chatOpenAi(req)
}
