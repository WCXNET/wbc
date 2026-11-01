/**
 * `node --import ./src/register.mjs` 的入口：注册 WBC 加载器。
 * 优先用 Node 24+ 的同步钩子 registerHooks()，老版本回退到 register()。
 */
import { register, registerHooks } from 'node:module'
import { syncLoad } from './hook.mjs'

if (typeof registerHooks === 'function') {
  registerHooks({ load: syncLoad })
} else {
  register('./hook.mjs', import.meta.url)
}
