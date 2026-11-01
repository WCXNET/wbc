import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_THRESHOLD,
  DSH_SIGNATURE_SENTENCE,
  demoteLongSystemPrompt,
} from '../src/body.mjs'
import { applyPatch, isPatched, INJECTED_SOURCE, PATCH_MARK } from '../src/patch.mjs'

/** 造一个与上游同构的最小 bundle，用于验证锚点与幂等。 */
const FAKE_BUNDLE = `// fake dsh-workbuddy-connect/lib/host-heartbeat-deadbeef.js
function normalizeToolChoice(obj) { return obj; }
function chatBase(credential) { return credential; }
${''}
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
export { prepareChatBody };
`

test('补丁写入标记，且对同一输入幂等', () => {
  const once = applyPatch(FAKE_BUNDLE)
  assert.equal(isPatched(once), true)
  assert.ok(once.includes(PATCH_MARK))
  const twice = applyPatch(once)
  assert.equal(twice, once, '重复打补丁不应改变内容')
})

test('补丁只插入、不删改上游代码', () => {
  const patched = applyPatch(FAKE_BUNDLE)
  const removed = FAKE_BUNDLE.split('\n').filter((line) => line.trim() && !patched.includes(line))
  assert.deepEqual(removed, [], '上游原有代码行应全部保留')
  assert.equal(patched.includes('wbcDemoteLongSystemPrompt(obj);'), true)
})

test('拒绝打在没有正确锚点的文件上', () => {
  assert.throws(() => applyPatch('const a = 1;'), /不像 dsh-workbuddy-connect/)
  assert.throws(
    () => applyPatch('function chatBase(credential) {}\nfunction prepareChatBody(source) {'),
    /调用锚点/,
  )
})

const long = 'x'.repeat(DEFAULT_THRESHOLD + 1)

test('过长的 system 被降级为 user，内容不丢', () => {
  const body = {
    model: 'm',
    messages: [
      { role: 'system', content: long },
      { role: 'user', content: 'hi' },
    ],
  }
  assert.equal(demoteLongSystemPrompt(body), true)
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['system', 'user', 'user'],
  )
  assert.equal(body.messages[0].content, 'You are a helpful assistant.')
  assert.equal(body.messages[1].content, long, '原 system 文本应完整保留')
})

test('短 system 保持不动', () => {
  const body = {
    messages: [
      { role: 'system', content: 'short' },
      { role: 'user', content: 'hi' },
    ],
  }
  assert.equal(demoteLongSystemPrompt(body), false)
  assert.equal(body.messages[0].role, 'system')
})

test('即使很短，命中 DSH 特征句也降级', () => {
  const body = { messages: [{ role: 'system', content: `${DSH_SIGNATURE_SENTENCE}.` }] }
  assert.equal(demoteLongSystemPrompt(body), true)
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['system', 'user'],
    '保留一个短 system 占位，原文本转入 user',
  )
  assert.equal(body.messages[1].content, `${DSH_SIGNATURE_SENTENCE}.`)
})

test('developer 角色同样按 system 处理', () => {
  const body = {
    messages: [
      { role: 'developer', content: long },
      { role: 'user', content: 'hi' },
    ],
  }
  assert.equal(demoteLongSystemPrompt(body), true)
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['system', 'user', 'user'],
  )
})

test('数组形式的 content 会被拼接后降级', () => {
  const body = {
    messages: [{ role: 'system', content: [{ type: 'text', text: long }] }],
  }
  assert.equal(demoteLongSystemPrompt(body), true)
  assert.equal(body.messages[1].content, long)
})

test('阈值可由 WBC_THRESHOLD 覆盖', () => {
  const body = { messages: [{ role: 'system', content: 'a'.repeat(50) }] }
  const original = process.env.WBC_THRESHOLD
  try {
    process.env.WBC_THRESHOLD = '10'
    assert.equal(demoteLongSystemPrompt(body), true)
  } finally {
    if (original === undefined) delete process.env.WBC_THRESHOLD
    else process.env.WBC_THRESHOLD = original
  }
})

test('注入的源码与 body.mjs 行为一致', () => {
  const factory = new Function(`${INJECTED_SOURCE}\nreturn wbcDemoteLongSystemPrompt;`)
  const injected = factory()

  const cases = [
    [{ messages: [{ role: 'system', content: long }, { role: 'user', content: 'hi' }] }, 100],
    [{ messages: [{ role: 'system', content: 'short' }] }, 100],
    [{ messages: [{ role: 'system', content: `${DSH_SIGNATURE_SENTENCE} short` }] }, 100],
    [{ messages: [{ role: 'developer', content: long }] }, 100],
    [{ messages: [{ role: 'system', content: [{ type: 'text', text: long }] }] }, 100],
    [{ messages: [] }, 100],
    [{}, 100],
  ]

  for (const [input, threshold] of cases) {
    const a = structuredClone(input)
    const b = structuredClone(input)
    const changedModule = demoteLongSystemPrompt(a, { threshold })
    const changedInjected = Boolean(injected(b))
    assert.equal(changedInjected, changedModule, '改动标记应一致')
    assert.deepEqual(b, a, '改写结果应一致')
  }
})
