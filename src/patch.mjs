/**
 * WBC 补丁定义：对 dsh-workbuddy-connect 的打包产物做一次定点插入。
 *
 * 目标文件：<profile>/node_modules/dsh-workbuddy-connect/lib/host-heartbeat-<hash>.js
 * 只改一处函数内容——在 prepareChatBody 里多走一步 wbcDemoteLongSystemPrompt(obj)。
 * 其余字节保持与上游一致，因此 revert 就是还原备份，diff 干净可审阅。
 */
export const PATCH_MARK = 'WBC_PATCH_V1'

/** 函数定义的插入锚点；上游 0.7.9 中唯一。 */
const FN_ANCHOR = 'function prepareChatBody(source) {'

/** 调用的插入锚点；位于 prepareChatBody 内，上游 0.7.9 中唯一。 */
const CALL_ANCHOR = '\tnormalizeToolChoice(obj);'

/** 注入的代码：自包含、无 import，可直接嵌进插件的单文件 bundle。 */
export const INJECTED_SOURCE = `/* ${PATCH_MARK}: 把过长的 system 指令降级为 user 消息，绕开 workbuddy 上游的 code 11128 拦截。
 * 实测依据：同一请求体，长文本放 system -> HTTP 400 / 11128；放 user -> 200。
 * 阈值可用 WBC_THRESHOLD 覆盖。详见 https://github.com/WCXNET/wbc */
const WBC_THRESHOLD_DEFAULT = 100;
const WBC_SIGNATURE = "You are an AI agent powered by DeepSeek Harness";
const WBC_NEUTRAL_SYSTEM = "You are a helpful assistant.";
function wbcResolveThreshold() {
	const raw = process.env.WBC_THRESHOLD;
	const value = Number(raw);
	return raw !== undefined && raw !== "" && Number.isFinite(value) && value >= 0 ? value : WBC_THRESHOLD_DEFAULT;
}
function wbcMessageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block !== null && typeof block === "object" && typeof block.text === "string") out += (out === "" ? "" : String.fromCharCode(10)) + block.text;
	}
	return out;
}
function wbcDemoteLongSystemPrompt(body) {
	const messages = body.messages;
	if (!Array.isArray(messages)) return false;
	const threshold = wbcResolveThreshold();
	const kept = [];
	const demoted = [];
	for (const message of messages) {
		if (message !== null && typeof message === "object" && !Array.isArray(message)) {
			const role = message.role;
			if (role === "system" || role === "developer") {
				const text = wbcMessageText(message.content);
				if (text !== "" && (text.includes(WBC_SIGNATURE) || text.length > threshold)) {
					demoted.push(text);
					continue;
				}
			}
		}
		kept.push(message);
	}
	if (demoted.length === 0) return false;
	const demotedText = demoted.join(String.fromCharCode(10) + String.fromCharCode(10));
	const out = [];
	let inserted = false;
	for (const message of kept) {
		out.push(message);
		if (!inserted && message !== null && typeof message === "object" && message.role === "system") {
			out.push({ role: "user", content: demotedText });
			inserted = true;
		}
	}
	if (!inserted) {
		out.unshift({ role: "system", content: WBC_NEUTRAL_SYSTEM }, { role: "user", content: demotedText });
	}
	body.messages = out;
	return true;
}
`

export function isPatched(source) {
  return source.includes(PATCH_MARK)
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * 生成打过补丁的源码。已打过则原样返回（幂等）。
 * @throws 当锚点缺失或重复时抛出，避免把补丁打到不确定的位置。
 */
export function applyPatch(source) {
  if (typeof source !== 'string') throw new TypeError('applyPatch expects a string')
  if (isPatched(source)) return source
  // 用插件自身特征校验目标，避免把补丁打错文件：bundle 里不会出现自己的包路径。
  if (!source.includes('chatBase(credential)')) {
    throw new Error('目标文件不像 dsh-workbuddy-connect 的 chat 客户端（缺少 chatBase(credential)）')
  }

  const fnHits = countOccurrences(source, FN_ANCHOR)
  if (fnHits !== 1) {
    throw new Error(`函数锚点命中 ${fnHits} 次（期望 1 次），上游可能已改版，拒绝打补丁`)
  }
  // 补丁只能插在顶层声明之前：`export function ...` 会在 export 与 function 之间插坏语法。
  if (source[source.indexOf(FN_ANCHOR) - 1] !== "\n") {
    throw new Error('prepareChatBody 不是顶层声明（可能带 export 前缀），拒绝打补丁')
  }
  const callHits = countOccurrences(source, CALL_ANCHOR)
  if (callHits !== 1) {
    throw new Error(`调用锚点命中 ${callHits} 次（期望 1 次），上游可能已改版，拒绝打补丁`)
  }

  return source
    .replace(FN_ANCHOR, INJECTED_SOURCE + FN_ANCHOR)
    .replace(CALL_ANCHOR, `${CALL_ANCHOR}\n\twbcDemoteLongSystemPrompt(obj);`)
}

/** 从补丁后的源码里取出注入部分，供测试比对行为。 */
export function extractInjectedSource(patchedSource) {
  const start = patchedSource.indexOf(INJECTED_SOURCE)
  if (start < 0) return null
  return patchedSource.slice(start, start + INJECTED_SOURCE.length)
}
