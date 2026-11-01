/**
 * 加载时补丁（Node 自定义模块加载器）。
 *
 * 用法：node --import ./src/register.mjs <你的程序>
 *   - 不修改磁盘上的插件文件；
 *   - 插件升级后自动继续生效，不需要重打；
 *   - 只影响匹配 dsh-workbuddy-connect/lib/host-heartbeat-*.js 的模块。
 */
import { applyPatch } from './patch.mjs'

const TARGET_RE = /dsh-workbuddy-connect\/lib\/host-heartbeat-[^/]*\.js$/i

const matches = (url) => {
  try {
    return TARGET_RE.test(decodeURIComponent(new URL(url).pathname))
  } catch {
    return false
  }
}

const asText = (source) =>
  typeof source === 'string' ? source : Buffer.from(source).toString('utf8')

/** 把模块源码换成打过补丁的版本；任何异常都保持原样，避免打歪。 */
const transform = (url, result) => {
  if (!result?.source || !matches(url)) return result
  let patched
  try {
    patched = applyPatch(asText(result.source))
  } catch {
    return result
  }
  if (patched === asText(result.source)) return result
  return { ...result, source: patched, format: result.format ?? 'module' }
}

/** 给 `module.register()` 用的异步钩子。 */
export async function load(url, context, nextLoad) {
  return transform(url, await nextLoad(url, context))
}

/** 给 `module.registerHooks()` 用的同步钩子（Node 24+ 推荐）。 */
export function syncLoad(url, context, nextLoad) {
  return transform(url, nextLoad(url, context))
}
