/**
 * 在磁盘上找到 dsh-workbuddy-connect 的打包产物。
 * DSH 的插件装在 <DSH_HOME>/profiles/<profile>/node_modules/ 下，
 * 打包产物的文件名带内容哈希（host-heartbeat-<hash>.js），升级后会变，所以按模式匹配。
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_PACKAGE = 'dsh-workbuddy-connect'
export const PATCH_TARGET_DIR = `${PLUGIN_PACKAGE}/lib/`
const TARGET_FILE_RE = /^host-heartbeat-.*\.js$/i

/** DSH 家目录：优先 DSH_HOME，否则 ~/.dsh。 */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

/** 列出所有安装目录（可能有多个 profile）。 */
export function findPluginDirs(home = dshHome()) {
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return []
  const found = []
  for (const entry of safeReaddir(profilesDir)) {
    const libDir = join(profilesDir, entry, 'node_modules', PLUGIN_PACKAGE, 'lib')
    if (existsSync(libDir)) found.push(libDir)
  }
  return found
}

/** 列出所有待打补丁的 bundle 文件。 */
export function findTargetFiles(home = dshHome()) {
  const files = []
  for (const libDir of findPluginDirs(home)) {
    for (const name of safeReaddir(libDir)) {
      if (!TARGET_FILE_RE.test(name)) continue
      const path = join(libDir, name)
      if (statSync(path).isFile()) files.push(path)
    }
  }
  return files
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}
