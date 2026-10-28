// Node only (Electron main process and the arena script): uses child_process.
//
// Plays with a Claude Pro/Max subscription by running the Claude Code CLI the
// user is already signed in to, in print mode with every tool switched off:
//   --tools ""             no built-in tools (no Bash, no file access, no web)
//   --strict-mcp-config    no MCP servers
//   --setting-sources ""   ignore user/project settings, hooks and plugins
// It runs in an empty temporary folder so no CLAUDE.md is picked up. The reply
// is also checked afterwards: exactly one model turn and no web requests.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatWithLlm } from './client'
import type { LlmChatRequest, LlmChatResponse } from './types'

const TIMEOUT_MS = 10 * 60 * 1000

// Retries are sent as one transcript, since each CLI call is a fresh conversation.
function transcript(req: LlmChatRequest): string {
  if (req.messages.length === 1) return req.messages[0].content
  return req.messages
    .map((m) => (m.role === 'user' ? `[Game]\n${m.content}` : `[Your earlier reply]\n${m.content}`))
    .join('\n\n')
}

export function claudeCodeArgs(req: LlmChatRequest, systemPromptFile: string): string[] {
  const args = [
    '-p',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--system-prompt-file', systemPromptFile,
    '--output-format', 'json',
    '--no-session-persistence'
  ]
  if (req.config.model) args.push('--model', req.config.model)
  if (req.config.effort) args.push('--effort', req.config.effort)
  return args
}

function run(cmd: string, args: string[], input: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32'
    // On Windows `claude` is a .cmd shim, which needs a shell; quote every argument.
    const child = win
      ? spawn([cmd, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' '), { cwd, shell: true })
      : spawn(cmd, args, { cwd })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

export async function chatClaudeCode(req: LlmChatRequest): Promise<LlmChatResponse> {
  const cmd = req.config.baseUrl?.trim() || 'claude'
  const dir = await mkdtemp(join(tmpdir(), 'chessin-llm-'))
  try {
    const systemFile = join(dir, 'system.txt')
    await writeFile(systemFile, req.system, 'utf-8')
    const { code, stdout, stderr } = await run(cmd, claudeCodeArgs(req, systemFile), transcript(req), dir)

    let out: Record<string, any>
    try {
      out = JSON.parse(stdout)
    } catch {
      return { ok: false, error: `claude exited with ${code}: ${(stderr || stdout).slice(0, 300)}` }
    }
    if (out.is_error) return { ok: false, error: `Claude Code: ${String(out.result ?? out.subtype).slice(0, 300)}` }
    const webUse = out.usage?.server_tool_use ?? {}
    if (out.num_turns !== 1 || webUse.web_search_requests || webUse.web_fetch_requests) {
      return { ok: false, error: 'Reply rejected: the model used a tool' }
    }
    if (typeof out.result !== 'string') return { ok: false, error: 'Claude Code returned no text' }
    return {
      ok: true,
      text: out.result,
      usage: { inputTokens: out.usage?.input_tokens ?? 0, outputTokens: out.usage?.output_tokens ?? 0 }
    }
  } catch (e) {
    const msg = (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? `Claude Code was not found ("${cmd}"). Install it and sign in with your Claude subscription.`
      : String(e)
    return { ok: false, error: msg }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Every provider, for code that runs in Node.
export function chatWithLlmNode(req: LlmChatRequest): Promise<LlmChatResponse> {
  if (req.config.provider === 'claude-code') return chatClaudeCode(req)
  return chatWithLlm(req)
}
