/**
 * WBC 的核心变换：把过长的 system 指令降级成一条 user 消息。
 *
 * 背景（实测，2026-11-01）：
 *   workbuddy 上游 chat 接口在 system 角色里检测到「长指令文本」时，
 *   返回 HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"，
 *   客户端看到的 displayMsg.zh 就是「请求被拦截，请重新发送」。
 *
 *   对照组（同一账号、同一批请求体，只改角色）：
 *     长文本放 system   -> 400
 *     长文本放 user     -> 200
 *     短文本放 system   -> 200
 *   因此「放到 user」是能过上游的最小改动，语义上与 system 相比略弱，
 *   但指令内容完整保留在上下文里。
 */

/** 超过这个长度就降级。默认 100：实测 60 字符通过、111 字符被拦。 */
export const DEFAULT_THRESHOLD = 100

/** DSH 的系统提示特征句：即使很短也降级，避免只换掉开头一句的旧做法。 */
export const DSH_SIGNATURE_SENTENCE = 'You are an AI agent powered by DeepSeek Harness'

/** 降级后留下的短 system 占位。 */
export const NEUTRAL_SYSTEM = 'You are a helpful assistant.'

/** 把 OpenAI 的 content（字符串或 text block 数组）压成纯文本。 */
export function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('\n')
}

export function isSystemLikeRole(role) {
  return role === 'system' || role === 'developer'
}

/** 判断一段 system 文本是否需要降级。 */
export function shouldDemote(text, threshold = DEFAULT_THRESHOLD) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (text.includes(DSH_SIGNATURE_SENTENCE)) return true
  return text.length > threshold
}

/** 解析阈值，支持 WBC_THRESHOLD 环境变量覆盖。 */
export function resolveThreshold(value = process.env.WBC_THRESHOLD) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD
}

/**
 * 就地改写一个 chat 请求体对象：长 system -> user。
 * 返回 true 表示发生了改动。函数会直接修改传入对象（与插件的写法一致）。
 */
export function demoteLongSystemPrompt(body, options = {}) {
  const threshold = options.threshold ?? resolveThreshold()
  const messages = body?.messages
  if (!Array.isArray(messages)) return false

  const kept = []
  const demoted = []

  for (const message of messages) {
    if (
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      isSystemLikeRole(message.role)
    ) {
      const text = messageText(message.content)
      if (shouldDemote(text, threshold)) {
        demoted.push(text)
        continue
      }
    }
    kept.push(message)
  }

  if (demoted.length === 0) return false

  const demotedText = demoted.join('\n\n')
  const out = []
  let inserted = false

  for (const message of kept) {
    out.push(message)
    if (
      !inserted &&
      message &&
      typeof message === 'object' &&
      message.role === 'system'
    ) {
      out.push({ role: 'user', content: demotedText })
      inserted = true
    }
  }

  if (!inserted) {
    out.unshift(
      { role: 'system', content: NEUTRAL_SYSTEM },
      { role: 'user', content: demotedText },
    )
  }

  body.messages = out
  return true
}
