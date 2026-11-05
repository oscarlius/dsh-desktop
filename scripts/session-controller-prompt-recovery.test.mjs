import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Expose the private command controller only in this test process. All imports
// and the prompt/selectModel implementation come from Desktop's installed RC1.
const desktop = createRequire(new URL('../dsh-plugin-desktop-beta/package.json', import.meta.url))
const entry = pathToFileURL(desktop.resolve('@deepseek-ai/dsh-api-session-controller')).href
const hook = registerHooks({
  load(url, context, next) {
    if (url !== entry) return next(url, context)
    return {
      format: 'module', shortCircuit: true,
      source: readFileSync(fileURLToPath(url), 'utf8') + '\nexport { SessionCommandController };',
    }
  },
})
let Controller
try { ({ SessionCommandController: Controller } = await import(entry)) } finally { hook.deregister() }

const previous = { provider: 'p7-company-chat', model: 'Qwen3.8-Flash-Next' }
function fixture(target, resolveManagedModelSelection) {
  let selected = previous
  const sent = []
  const agent = {
    id: 'old-session', inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => selected, select: value => { selected = value } },
    session: { snapshotEvents: () => [] }, followup: message => sent.push(message),
  }
  const ctx = {
    get: key => key === 'p7CompanyModels' ? { resolveManagedModelSelection } : undefined,
    llm: {
      listProviders: () => [{ id: target.provider }],
      listModels: async provider => provider === target.provider ? [{ id: target.model }] : [],
      resolveCallConfig: async value => value,
    },
    fileUploads: { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) },
    attachments: { admitPromptContent: async value => value },
    agents: { get: () => agent }, agentDefaultModel: { saveSelection: async () => {} },
  }
  const agents = { resolveAgent: async () => ({ agent }), serializeImageAdmission: (_, body) => body() }
  const commands = new Controller(ctx, agents, process.cwd())
  const prompt = () => commands.prompt({
    sessionId: agent.id, requestId: 'retry', mode: 'followup', content: [{ type: 'text', text: 'continue' }],
  }, { kind: 'user' })
  return { prompt, select: () => commands.selectModel({ sessionId: agent.id, ...target }), sent, selected: () => selected }
}

test('a stale model blocks admission until the same session selects an available model', async () => {
  const target = { ...previous, model: 'another-model' }
  const app = fixture(target, current => ({ kind: current.model === target.model ? 'available' : 'unavailable' }))
  await assert.rejects(app.prompt, error => error.code === 'session/model-unavailable' || error.data?.code === 'session/model-unavailable')
  assert.equal(app.sent.length, 0)
  await app.select()
  assert.deepEqual(await app.prompt(), { accepted: true })
  assert.deepEqual(app.selected(), target)
  assert.equal(app.sent.length, 1)
})

test('the same alias can move to a unique authorized provider before enqueue', async () => {
  const target = { ...previous, provider: 'p7-company-responses' }
  const app = fixture(target, () => ({ kind: 'migrate', selection: target }))
  assert.deepEqual(await app.prompt(), { accepted: true })
  assert.deepEqual(app.selected(), target)
  assert.equal(app.sent.length, 1)
})
