import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { chatWithLlmNode } from '../../shared/llm/claudeCode'
import type { LlmChatRequest } from '../../shared/llm/types'

// LLM requests run in the main process: no CORS limits and the API key
// never leaves the machine except to the provider the user configured.
export function registerLlmIpc(): void {
  ipcMain.handle(IPC.LLM_CHAT, (_, req: LlmChatRequest) => chatWithLlmNode(req))
}
