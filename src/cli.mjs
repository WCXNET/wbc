#!/usr/bin/env node
/**
 * wbc — WorkBuddy Compatibility patch 命令行。
 *
 *   wbc check    查看每个已安装插件的补丁状态（未打全则退出码 1）
 *   wbc apply    打补丁（自动备份到 *.wbc-orig，幂等）
 *   wbc revert   从备份还原
 *   wbc verify   对已打补丁的文件做语法检查
 *
 * 选项：--home <DSH_HOME>  指定 DSH 家目录（默认取 DSH_HOME 或 ~/.dsh）
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dshHome, findTargetFiles } from './locate.mjs'
import { applyPatch, isPatched, PATCH_MARK } from './patch.mjs'

const BACKUP_SUFFIX = '.wbc-orig'

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('-')) ?? 'check'
const homeFlag = argv.indexOf('--home')
const home = homeFlag >= 0 ? argv[homeFlag + 1] : dshHome()

const files = findTargetFiles(home)

const log = (...args) => console.log(...args)
const fail = (message) => {
  console.error(`错误：${message}`)
  process.exit(1)
}

if (!files.length) {
  fail(`没有在 ${home} 的 profiles/*/node_modules 下找到已安装的 dsh-workbuddy-connect`)
}

const backupOf = (file) => `${file}${BACKUP_SUFFIX}`

const statusOf = (file) => {
  const source = readFileSync(file, 'utf8')
  if (isPatched(source)) return 'patched'
  return existsSync(backupOf(file)) ? 'unpatched-backup-present' : 'unpatched'
}

const verifySyntax = (file) => {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  return result.status === 0 ? null : (result.stderr || '').trim().split('\n').slice(0, 3).join(' ')
}

log(`DSH 家目录：${home}`)
log(`发现 ${files.length} 个插件 bundle\n`)

let failures = 0

for (const file of files) {
  const status = statusOf(file)

  if (command === 'check') {
    const label =
      status === 'patched' ? '已打补丁' : status === 'unpatched-backup-present' ? '未打补丁（有备份）' : '未打补丁'
    if (status !== 'patched') failures++
    log(`${status === 'patched' ? '[OK]' : '[--]'} ${label}  ${file}`)
    continue
  }

  if (command === 'apply') {
    if (status === 'patched') {
      log(`[跳过] 已是最新  ${file}`)
      continue
    }
    const source = readFileSync(file, 'utf8')
    let patched
    try {
      patched = applyPatch(source)
    } catch (error) {
      failures++
      log(`[失败] ${file}\n       ${error.message}`)
      continue
    }
    if (!existsSync(backupOf(file))) copyFileSync(file, backupOf(file))
    writeFileSync(file, patched)
    const problem = verifySyntax(file)
    if (problem) {
      copyFileSync(backupOf(file), file)
      failures++
      log(`[回滚] 语法检查失败，已还原  ${file}\n       ${problem}`)
      continue
    }
    log(`[完成] 已打补丁并备份到 ${backupOf(file)}`)
    continue
  }

  if (command === 'revert') {
    if (!existsSync(backupOf(file))) {
      log(`[跳过] 没有备份，无从还原  ${file}`)
      continue
    }
    copyFileSync(backupOf(file), file)
    rmSync(backupOf(file))
    log(`[完成] 已还原为上游原版  ${file}`)
    continue
  }

  if (command === 'verify') {
    if (status !== 'patched') {
      log(`[--] 未打补丁，无需校验  ${file}`)
      continue
    }
    const problem = verifySyntax(file)
    if (problem) {
      failures++
      log(`[失败] ${file}\n       ${problem}`)
    } else {
      log(`[OK] 语法通过（含 ${PATCH_MARK}）  ${file}`)
    }
    continue
  }

  fail(`未知命令：${command}（可用：check / apply / revert / verify）`)
}

if (command === 'check') {
  log(
    failures === 0
      ? '\n全部已打补丁。'
      : `\n有 ${failures} 个文件未打补丁，运行 \`wbc apply\` 修复。`,
  )
}

process.exit(failures === 0 ? 0 : 1)
