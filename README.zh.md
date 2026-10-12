# dsh-dock-vitals

在 DeepSeek Harness 的**对话输入框下方状态栏**里，实时显示本机的 CPU / 内存 / GPU 读数 —— 一枚可点击的小徽章，排在宿主自带的「上下文」状态项右侧。

```
2 轮 30 步 · 98 tok/s │ 1.8M tok · 缓存命中 84% │ 6%
CPU 13%  MEM 87%  GPU 15%
                      ↑ 本插件的徽章，挂在「上下文」右边
```

- **纯展示插件**，不为模型注册任何工具：采样数据不进对话上下文，也不会发往任何地方。
- 默认显示三项：**CPU / 内存 / GPU**；显存与 GPU 温度在设置页里一键打开。
- GPU 支持各厂商，且**不需要管理员权限**：`nvidia-smi`、`rocm-smi`、macOS 的 `ioreg`，Windows 上以 PDH 计数器兜底。哪个后端起的作用会写进快照；后端给不了的字段留空，而不是拿 `0` 充数。
- 点击徽章展开详情面板：逐项数值、GPU 型号、核心数与容量。
- 三档刷新间隔：**快 1.5 秒 / 中 3 秒 / 慢 10 秒**（默认 `3000 ms`）。
- 开十个会话也只采一次：所有徽章共享同一份快照与同一个定时器。
- 没有客户端取数 15 秒后自动停表，没人看的时候不空转。
- 界面跟随宿主语言（中文 / 英文），详情面板与悬停提示一并切换。

## 安装

```bash
dsh plugin --profile <profile> add dsh-dock-vitals
```

或直接装 tarball：

```bash
dsh plugin --profile <profile> add ./dsh-dock-vitals-0.1.0.tgz
```

装完重启 DSH 生效。

## 数据来源

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| CPU | Node `os.cpus()` 两次采样 | 口径为全机 busy 百分比（`1 - Δidle/Δtotal`），不是单核占比；首次采样没有基准，返回空值 |
| 内存 | `os.totalmem()` / `os.freemem()` | |
| GPU | 按平台探测的厂商命令行（见下表） | 都探测不到时 GPU 显示 `—`，CPU / 内存照常工作 |

GPU 后端按平台依次尝试，**谁先答应用谁**；成功过的后端会被记住，后续 tick 不再去撞已经失败的那个：

| 平台 | 后端 | 命令 | 权限 | 显存 / 温度 |
| --- | --- | --- | --- | --- |
| Windows / Linux，NVIDIA | `nvidia-smi` | `--query-gpu=... --format=csv,noheader,nounits` | 免 | 两项都有 |
| Windows，任意厂商 | PDH 计数器（`typeperf`） | `"\GPU Engine(*)\Utilization Percentage" -sc 2 -si 1` | 免 | **两项都没有** |
| Linux，AMD | `rocm-smi` | `-u --showmemuse --showmeminfo vram -t --showtemp --showproductname --csv` | 免 | 两项都有 |
| macOS，任意 GPU | `ioreg`（IOKit 注册表） | `-r -d 1 -w 0 -c IOAccelerator` | **免** | 只有已用量（没有总量） |

Windows 上 AMD / Intel 想读 GPU 占用，`typeperf` 是唯一的路（ROCm 只有 Linux 版），所以它的代价要知道：**一轮约 2.7 秒**，而 `nvidia-smi` 只要约 50 毫秒。因此 GPU 采样与徽章刷新节拍是**解耦**的 —— CPU / 内存按自己的节奏刷，GPU 用最近一次采完的读数。

聚合口径对齐任务管理器：同一引擎类型下各进程求和 → 取**最忙的引擎类型** → 多卡取最忙的那张。把全部实例一股脑相加会虚高，只看 3D 引擎则会漏掉视频编解码的负载。

当前后端报不了的字段在快照里是 `null`、**绝不是 `0`** —— 「读不到温度」和「温度 0°C」是两回事。详情面板会把这些行藏起来，而不是印一个编出来的数字。

宿主侧暴露一个只读接口：

```
GET /dsh-dock-vitals/snapshot
```

```json
{
  "cpu": { "percent": 13.2, "cores": 24 },
  "memory": { "usedPercent": 87.3, "usedGiB": 13.7, "totalGiB": 15.7 },
  "gpu": {
    "available": true,
    "name": "NVIDIA GeForce RTX 4060 Laptop GPU",
    "utilPercent": 15,
    "memoryUsedMiB": 1816,
    "memoryTotalMiB": 8188,
    "temperatureC": 64,
    "clockMegahertz": 2370
  },
  "gpuError": null,
  "gpuBackend": "nvidia-smi",
  "host": { "platform": "win32", "release": "10.0.26300" },
  "intervalMs": 3000,
  "updatedAt": 0
}
```

`gpuBackend` 是这次读数来自哪个后端 —— 「我的 GPU 怎么是空的 / 怎么没有温度」这类问题，看这一个字段就能回答。非 loopback 来源返回 `403`；非 `GET`/`HEAD` 返回 `405`。

## 设置项

设置 →「系统状态」：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 启用徽章 | 开 | 关掉后徽章完全不渲染，也不发起任何请求 |
| CPU | 开 | |
| 内存 | 开 | |
| GPU | 开 | |
| 显存 | 关 | 关掉「GPU」时不可用 |
| GPU 温度 | 关 | 同上 |
| 刷新间隔 | 3000 ms | 1500 ~ 60000 ms |

所有字段都是 `volatile` 的，改完立即生效，不用重启。配置落在 settings 命名空间 `dock-vitals` —— 即 profile 里 plugin entry 的 `id`。

## 兼容性

- dsh `>=0.2.0-rc.1`（本插件在 `0.2.0-rc.2` 上开发与验证）。
- Node `>=22`。
- Windows / macOS / Linux。CPU 与内存走 Node 的 `os`；GPU 后端全是只读命令行与注册表读取（`nvidia-smi`、`typeperf`、`rocm-smi`、`ioreg`）。全程不需要管理员权限 —— 这是刻意避开 `powermetrics` 的原因：它是 macOS 上信息最全的 GPU 源，但每次调用都要 `sudo`。
- 桌面版与浏览器版都能用：`dsh.client.platform` 是 `web`，而桌面版本就是同一个 web 前端套的壳。

## 开发约定

- 客户端组件只能 `require` 宿主白名单里的模块（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`）。白名单外的解析必失败，而 `require` 抛错会炸掉 factory → entry failed → 桌面版直接打不开。**每个 `require` 都要包 `try/catch` 并准备好降级。**
- 绝不在 `apply()` 里调用 hook。`useSyncExternalStore` 的 `getSnapshot` 必须返回**稳定引用** —— 每次调用都新建对象会导致无限重渲染。
- 样式只用 `--dsw-*` 主题 token；字面颜色只用于图形。
- 挂 UI 必须走 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`。

## License

MIT
