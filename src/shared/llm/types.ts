// Types shared by the Electron main process, the web shim, the renderer and
// the headless arena. Nothing in src/shared/llm imports React or Electron.

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'

// 'claude-code': a Claude Pro/Max subscription, through the Claude Code CLI the
// user is signed in to on this computer (desktop app and arena only).
export type LlmProvider = 'anthropic' | 'openai' | 'claude-code'

export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LlmPlayerConfig {
  id: string
  name: string
  provider: LlmProvider
  model: string
  apiKey: string
  // Anthropic: defaults to https://api.anthropic.com.
  // OpenAI-compatible: the URL that `/chat/completions` is appended to,
  // e.g. https://api.openai.com/v1, https://api.deepseek.com/v1, http://localhost:11434/v1
  // Claude subscription: path of the `claude` command, defaults to `claude`.
  baseUrl?: string
  // Anthropic and Claude subscription: how hard the model thinks before answering.
  effort?: LlmEffort
  // OpenAI-compatible only. Left out of the request when undefined.
  temperature?: number
  // Include the list of legal moves in the prompt.
  showLegalMoves: boolean
  // How many extra attempts the model gets after an illegal or unreadable move.
  maxRetries: number
}

export interface LlmChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmChatRequest {
  config: LlmPlayerConfig
  system: string
  messages: LlmChatMessage[]
}

export type LlmChatResponse =
  | { ok: true; text: string; usage?: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: string }

export type LlmChatFn = (req: LlmChatRequest) => Promise<LlmChatResponse>
