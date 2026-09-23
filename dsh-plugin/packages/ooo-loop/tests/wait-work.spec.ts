import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { captureWaitWorkSnapshot, parseWaitWorkProposal, WAIT_WORK_CONFIG_SCHEMA } from '../src/wait-work.ts'

const proposal = (text: string) => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'mock', model: 'mock' } })
describe('wait work proposal', () => {
  it('ignores proposals hidden in reasoning and tool arguments', () => {
    const hidden = '<ooo-work>{"task":"secret"}</ooo-work>'
    const message = createAssistantMessage({ content: [
      { type: 'reasoning', text: hidden },
      { type: 'tool-call', id: ToolCallId('hidden'), name: 'read', arguments: hidden },
    ], source: { provider: 'mock', model: 'mock' } })
    expect(parseWaitWorkProposal(message)).toBeUndefined()
  })
  it('retains main system authority and labels historical tool text without correlation structures', () => {
    const messages = [createSystemMessage('Never modify files', 'main'), createToolResultMessage({ callId: ToolCallId('read-1'), content: [{ type: 'text', text: 'read-only evidence' }], isError: false })]
    const snapshot = captureWaitWorkSnapshot(messages, 10000)!
    expect(snapshot.system).toBe('Never modify files')
    expect(snapshot.serialized).toContain('Historical tool result read-1')
    expect(snapshot.serialized).toContain('read-only evidence')
    expect(snapshot.serialized).not.toContain('tool-result')
  })
  it('accepts exactly one strict task JSON in current assistant text', () => {
    expect(parseWaitWorkProposal(proposal('thinking <ooo-work>{"task":"review"}</ooo-work>'))).toBe('review')
    for (const text of ['', '<ooo-work>{"task":""}</ooo-work>', '<ooo-work>{"task":"x","id":"fake"}</ooo-work>', '<ooo-work>{"task":"a","task":"b"}</ooo-work>', '<ooo-work>{"task":2}</ooo-work>', '<ooo-work>{"task":"x"}', '<ooo-work>{bad}</ooo-work>', '<ooo-work>{"task":"a"}</ooo-work><ooo-work>{"task":"b"}</ooo-work>', `<ooo-work>{"task":"${'x'.repeat(4097)}"}</ooo-work>`]) {
      expect(parseWaitWorkProposal(proposal(text))).toBeUndefined()
    }
  })
  it('captures a complete bounded text snapshot without reasoning or tool calls', () => {
    const message = createAssistantMessage({ content: [
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'visible' },
      { type: 'tool-call', id: 'call' as never, name: 'read', arguments: '{"secret":1}' },
    ], source: { provider: 'mock', model: 'mock' } })
    const snapshot = captureWaitWorkSnapshot([message], 10000)!
    expect(snapshot.serialized).toContain('visible')
    expect(snapshot.serialized).not.toMatch(/private|secret|tool-call/)
    expect(snapshot.evidenceMessageIds).toEqual([message.id])
    expect(captureWaitWorkSnapshot([message], snapshot.serialized.length - 1)).toBeUndefined()
    expect(captureWaitWorkSnapshot([message], snapshot.serialized.length)).toBeDefined()
    const multimodal = { ...message, content: [{ type: 'image', url: 'x' }] } as never
    expect(captureWaitWorkSnapshot([multimodal], 10000)).toBeUndefined()
  })
  it('validates strict bounded configuration with defaults', () => {
    expect(WAIT_WORK_CONFIG_SCHEMA.parse({}).maxCallsPerTurn).toBe(2)
    for (const input of [null, true, { unknown: 1 }, { graceMs: -1 }, { maxTokens: 0 }, { maxCallsPerTurn: 1000 }]) expect(WAIT_WORK_CONFIG_SCHEMA.safeParse(input).success).toBe(false)
  })
})
