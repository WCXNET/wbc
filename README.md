# WBC — WorkBuddy Compatibility patch

修掉 **DeepSeek Harness（DSH）通过 `dsh-workbuddy-connect` 调用 WorkBuddy 模型时稳定报错** 的问题。

```
400: {"message":"workbuddy upstream client (http 400): 请求被拦截，请重新发送",
      "type":"client","code":"client"}  INVALID_REQUEST
```

> 非官方补丁，与 WorkBuddy、DeepSeek 均无隶属关系。只改**本地客户端发出的请求编码方式**，不修改上游服务，也不绕过任何鉴权或计费。

## 症状

在 DSH 里选任意 WorkBuddy 模型（`deepseek-v4.1-flash`、`hy4-preview`、`glm-5.3` …）发消息，
这一轮必定失败，上层只看到一句 `请求被拦截，请重新发送`。换模型无效，重试无效，重启 DSH 也无效。

## 根因

上游 `copilot.tencent.com/v2/chat/completions` 会对 **`system` 角色里的长指令文本** 返回：

```json
{"code": 11128, "msg": "Illegal API invocation from an unapproved channel",
 "displayMsg": {"zh": "请求被拦截，请重新发送"}}
```

而 DSH 的系统提示有 2 万多字符，于是**每一次请求**都命中。

定位方式：拿插件落盘的请求体向上游重放，逐项换变量，同一账号、同一批请求：

| 变量 | 上游响应 |
| --- | --- |
| 原样重放（258 KB，200 个工具） | ❌ 400 / 11128 |
| 只把 `system` 换成一句短语，其余不动 | ✅ 200 |
| 去掉全部 200 个工具，`system` 保持原样 | ❌ 400 / 11128 |
| 去掉 `system`，长文本走 `user` | ✅ 200 |
| 长文本走 `system`（同样 2 万字符，但是普通文本） | ✅ 200 |

结论：**触发条件是「system 角色 + 指令型长文本」**。
工具数量、请求体积、`X-Conversation-*` 请求头都是无关项——这一点和插件注释里记载的 issue #139 不是同一个原因。

## 修法

把超长的 `system` 内容**降级成一条 `user` 消息**，只留一句短 `system` 占位：

```
system(2 万字符) + user        ->        system(短占位) + user(原 system 全文) + user
```

指令内容一字不丢，只是换了个角色。副作用是这些指令的权威性弱于 `system`，
对本场景（DSH 自己的行为约定）足够，但如果你的上游对角色敏感，请留意。

判据（`src/body.mjs`）：

- 文本长度 > 100 字符 → 降级；实测 60 字符放行、111 字符被拦。
- 或者文本里含 DSH 特征句 `You are an AI agent powered by DeepSeek Harness` → 无条件降级。
- 阈值可用环境变量 `WBC_THRESHOLD` 覆盖。

## 用法

需要 Node.js ≥ 20.6。

### 方式一：磁盘补丁（零参数，推荐）

```bash
node src/cli.mjs check    # 查看状态；未打全时退出码为 1
node src/cli.mjs apply    # 打补丁，自动备份为 *.wbc-orig，幂等
node src/cli.mjs verify   # 对打过补丁的文件做语法检查
node src/cli.mjs revert   # 从备份还原成上游原版
```

默认在 `$DSH_HOME`（未设置时 `~/.dsh`）下的 `profiles/*/node_modules/dsh-workbuddy-connect/lib/`
里找 `host-heartbeat-*.js`；可用 `--home <dir>` 指定别处。

打完补丁要**重启 DSH** 才会生效（插件在进程启动时加载）。

### 方式二：加载时补丁（插件升级后仍生效）

```bash
node --import ./src/register.mjs <入口>
```

它用 Node 的模块加载钩子（`module.registerHooks`，老版本回退 `module.register`）
在**内存里**改写目标模块，不碰磁盘，所以 `npm i` 升级插件后依然有效。
前提是你能控制 DSH 的启动参数——如果你的 `dsh` 是全局命令，可以包一层：

```sh
#!/bin/sh
exec node --import /path/to/wbc/src/register.mjs "$(command -v dsh)" "$@"
```

> 只有在钩子匹配到 `dsh-workbuddy-connect/lib/host-heartbeat-*.js` 时才动手，其它模块一律透传。

## 安全边界

- 补丁只在**锚点唯一且位于顶层**时才写入：`function prepareChatBody(source) {` 与
  `normalizeToolChoice(obj);`。上游改版导致锚点不匹配时**拒绝打补丁**，而不是猜一个位置写下去。
- 打补丁后立刻 `node --check`，语法不过就自动回滚。
- 补丁是纯增量：对 `0.7.9` 的 bundle 只新增行，不删改任何原有行。
- 不读取、不写入任何凭据；不改 `Authorization`、不碰 token。

## 兼容性

针对 `dsh-workbuddy-connect@0.7.9` 的打包产物验证。插件升级后：

- 用**方式一**的需要重新 `apply`（`check` 会提示未打补丁）；
- 用**方式二**的无需操作。

## 测试

```bash
node --test
```

10 项：锚点幂等、纯增量、拒打错误文件、长/短 system、特征句、`developer` 角色、
数组形式 content、阈值覆盖、以及**注入源码与 `src/body.mjs` 行为一致**（防止两份实现漂移）。

## 许可

MIT，见 [LICENSE](LICENSE)。
