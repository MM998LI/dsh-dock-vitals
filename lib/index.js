/**
 * dsh-dock-vitals — Host 侧采集泵。
 *
 * 在输入框下方的状态栏里显示本机 CPU / 内存 / GPU 的实时占用。
 * 数据来源刻意只用两种：
 *   1. Node 的 `os` 模块 —— CPU 用两次 `os.cpus()` 采样求差，内存用 totalmem/freemem；
 *   2. GPU 走 `./gpu.js` 的多后端采集器 —— 按平台挑厂商 CLI，全都取不到就只显示
 *      CPU / 内存，不让整个徽章消失。
 *
 * 不使用任何 WMI/CIM/PowerShell 调用来取显卡信息：实测那条路既慢（一轮 2.5~4.5 秒）
 * 又要权限。`typeperf` 是唯一的例外 —— 它读的是 PDH 性能计数器（任务管理器同款），
 * 是 Windows 上**唯一**能覆盖 AMD / Intel 的路子，代价是慢，所以放兜底位并单独放宽节拍。
 *
 * 结构：
 * - `Config`（全部 volatile）—— 显示内容与刷新间隔，在设置页改，热生效；
 * - 单个采集泵 —— 所有浏览器标签页共享同一份快照与同一次采样；
 *   没有消费者 15 秒后自动停表；
 * - HTTP 路由 —— 只提供只读快照，写设置走宿主 settings 通道。
 *
 * 所有可变状态都关在 `apply()` 的闭包里：插件可能被同时实例化多次
 * （多 profile），模块级单例会让两个实例互相踩 CPU 采样基准。
 */

import os from 'node:os'
import z from '@deepseek-ai/schemastery'

import { createGpuReader } from './gpu.js'

export const name = 'dsh-dock-vitals'

/**
 * 不声明顶层 inject：webServer 与 settings 都在 apply() 里用 ctx.inject() 条件挂载。
 * webServer 自己的 entry 声明了 `inject: [webStartup]`，本插件激活时它还没就绪，
 * 写进顶层 inject 会让整块跟着不激活；settings 同理，拿不到就只是没有设置页，
 * 徽章照常显示。
 */
export const inject = []

/** settings 命名空间 = profile 里这条 entry 的 id，两处必须一致（见 cordis.patch.yml）。 */
export const SETTINGS_NAMESPACE = 'dock-vitals'

const MIN_INTERVAL = 1500
const MAX_INTERVAL = 60000
const DEFAULT_INTERVAL = 3000
/** 没有客户端来取数据后，采集泵再跑多久就停下来（毫秒）。 */
const IDLE_GRACE = 15000

// ── 配置 ─────────────────────────────────────────────────────────────────────

export const Config = z.object({
  /** 总开关：关掉后徽章不渲染。 */
  enabled: z.boolean().default(true).volatile(),
  /** 显示 CPU 占用率。 */
  showCpu: z.boolean().default(true).volatile(),
  /** 显示内存占用率。 */
  showMemory: z.boolean().default(true).volatile(),
  /** 显示 GPU 核心占用率。 */
  showGpu: z.boolean().default(true).volatile(),
  /** 显示显存占用（需采集后端能读到显存）。 */
  showGpuMemory: z.boolean().default(false).volatile(),
  /** 显示 GPU 温度（需采集后端能读到温度）。 */
  showGpuTemperature: z.boolean().default(false).volatile(),
  /** 刷新间隔（毫秒）。 */
  intervalMs: z.number().step(500).min(MIN_INTERVAL).max(MAX_INTERVAL).default(DEFAULT_INTERVAL).volatile()
})

// ⚠️ 不要写 `export default Config`。
// dsh 的 loader 取插件回调时优先用 default 导出；而 schemastery 的 Schema 本身就是
// 一个函数，一旦把它当 default，loader 就会拿 Config 当插件本体去调用，
// 结果 apply() 永远不执行 —— 表现为「插件装了但没反应」，且不报错、极难查。
// 官方功能性插件（如 dsh-web-search-deepseek）一律是命名导出，没有 default。

// ── 纯函数工具 ───────────────────────────────────────────────────────────────

function clampPercent(value) {
  return round(Math.min(100, Math.max(0, value)), 1)
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Config 的运行时字段是盒子（`config.intervalMs.get()`），
 * 但纯 JSON 路径下也可能是裸值，这里两种都收。
 */
function readBox(field, fallback) {
  const raw = typeof field?.get === 'function' ? field.get() : field
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** 布尔版：Config 字段同样可能是盒子，也可能是裸值。 */
function readFlag(field, fallback) {
  const raw = typeof field?.get === 'function' ? field.get() : field
  return typeof raw === 'boolean' ? raw : fallback
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  /**
   * 采集泵的全部状态。单例于本插件实例，所有客户端共享。
   */
  const pump = {
    /** @type {object|null} 最近一次快照 */
    snapshot: null,
    /** @type {NodeJS.Timeout|null} 采样定时器 */
    timer: null,
    /** @type {NodeJS.Timeout|null} 空闲停表定时器 */
    idleTimer: null
  }

  /**
   * 上一次的 `os.cpus()` 快照。CPU 占用率只能靠两次累计值相除得到，
   * 所以基准必须跨 tick 保留；第一次调用没有基准，percent 为 null。
   */
  let cpuBaseline = null

  const intervalMs = () => Math.min(
    MAX_INTERVAL,
    Math.max(MIN_INTERVAL, readBox(config.intervalMs, DEFAULT_INTERVAL))
  )

  /** 多后端 GPU 读取器：按平台挑厂商 CLI，并记住哪个后端能用。 */
  const gpuReader = createGpuReader()

  /**
   * GPU 读数缓存。GPU 采样是**后台异步**的，不挂在采样节拍上 ——
   * 因为 Windows 的 `typeperf` 兜底一轮就要 2.7 秒，比最快的刷新档（1.5 秒）还长，
   * 挂在节拍上会让 CPU / 内存跟着一起卡成 2.7 秒一刷。
   */
  const gpuState = {
    /** @type {{ gpu: object, error: string|null }|null} 最近一次结果 */
    value: null,
    /** 上次采样完成的时刻 */
    at: 0,
    /** 是否已有一次采样在飞（防止慢后端堆积请求） */
    pending: false
  }

  /** GPU 该多久采一次：取「用户设的间隔」与「后端承受得起的最快节拍」中较慢的那个。 */
  function gpuPeriodMs() {
    return Math.max(intervalMs(), gpuReader.minPeriodMs)
  }

  /** 后台补一次 GPU 读数；还没到点或已有采样在飞就跳过。 */
  function refreshGpu() {
    if (gpuState.pending) return
    if (gpuState.value !== null && Date.now() - gpuState.at < gpuPeriodMs()) return
    gpuState.pending = true
    // read() 永远 resolve（内部把失败收敛成 available:false），所以这里不需要 catch。
    void gpuReader.read().then((result) => {
      gpuState.value = result
      gpuState.at = Date.now()
    }).finally(() => {
      gpuState.pending = false
    })
  }

  function sampleCpu() {
    const cpus = os.cpus()
    const cores = cpus.length
    if (cpuBaseline === null || cpuBaseline.length !== cores) {
      cpuBaseline = cpus.map((cpu) => ({ ...cpu.times }))
      return { percent: null, cores }
    }

    let idle = 0
    let total = 0
    for (let index = 0; index < cores; index += 1) {
      const now = cpus[index].times
      const before = cpuBaseline[index]
      idle += now.idle - before.idle
      total += (now.user - before.user)
        + (now.nice - before.nice)
        + (now.sys - before.sys)
        + (now.irq - before.irq)
        + (now.idle - before.idle)
    }
    cpuBaseline = cpus.map((cpu) => ({ ...cpu.times }))

    if (!(total > 0)) return { percent: null, cores }
    return { percent: clampPercent((1 - idle / total) * 100), cores }
  }

  function sampleMemory() {
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const usedBytes = Math.max(0, totalBytes - freeBytes)
    return {
      usedPercent: clampPercent((usedBytes / totalBytes) * 100),
      usedGiB: round(usedBytes / 1024 ** 3, 1),
      totalGiB: round(totalBytes / 1024 ** 3, 1)
    }
  }

  async function collect() {
    const cpu = sampleCpu()
    // 用缓存值，不阻塞：GPU 采样在后台按自己的节拍走（见 refreshGpu）。
    const gpuResult = gpuState.value
    const gpu = gpuResult === null ? { available: false } : gpuResult.gpu
    return {
      cpu: { percent: cpu.percent, cores: cpu.cores },
      memory: sampleMemory(),
      gpu: { available: gpu.available === true, ...(gpu.available === true ? gpu : {}) },
      gpuError: gpuResult === null ? null : gpuResult.error,
      /** 数据是从哪个后端读到的（nvidia-smi / windows-pdh / ioreg / rocm-smi），排查用。 */
      gpuBackend: gpuReader.backendId,
      host: { platform: os.platform(), release: os.release() },
      // 把「当前显示配置」一并回给客户端：这样徽章不必依赖客户端 settings 服务，
      // 设置 UI 被禁用/缺失时也能按默认值正常显示。
      settings: currentSettings(),
      intervalMs: intervalMs(),
      updatedAt: Date.now()
    }
  }

  /** 当前生效的显示配置（读的是 volatile 盒子，改完下一次采样即反映）。 */
  function currentSettings() {
    return {
      enabled: readFlag(config.enabled, true),
      showCpu: readFlag(config.showCpu, true),
      showMemory: readFlag(config.showMemory, true),
      showGpu: readFlag(config.showGpu, true),
      showGpuMemory: readFlag(config.showGpuMemory, false),
      showGpuTemperature: readFlag(config.showGpuTemperature, false),
      intervalMs: intervalMs()
    }
  }

  /**
   * 进行中的那一轮采集。冷启动时 handler 会先后触发两次 refresh
   * （起表时的 `void refresh()` 与紧接着的 `await refresh()`），
   * 没有这个句柄就会同时发起两轮采样 —— 第二次的采样窗口几乎为零
   * （实测两次 `os.cpus()` 间隔 0.425 毫秒），算出来的 CPU 占用是假值。
   * 定时器那一侧同理：一轮采集慢于间隔时，合并掉后续 tick 而不是叠加。
   */
  let inflight = null

  function refresh() {
    // GPU 走后台：慢后端（typeperf 2.7 秒）不该拖住 CPU / 内存的刷新节奏。
    refreshGpu()
    if (inflight !== null) return inflight
    inflight = collect()
      .then((snapshot) => {
        pump.snapshot = snapshot
        return snapshot
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  /** 没有消费者之后延迟停表；每次有人取数都把倒计时推后。 */
  function scheduleIdleStop() {
    if (pump.idleTimer !== null) clearTimeout(pump.idleTimer)
    pump.idleTimer = setTimeout(() => {
      pump.idleTimer = null
      if (pump.timer !== null) {
        clearInterval(pump.timer)
        pump.timer = null
      }
      // 停表即作废快照。漏掉这一句的话，下次请求会命中下面的 `??` 短路，
      // 直接回一份「停表前」的旧数据 —— 最坏是 IDLE_GRACE + intervalMs
      // （默认档约 16.5 秒，慢档 75 秒），而客户端不读 updatedAt，看不出来。
      pump.snapshot = null
    }, IDLE_GRACE)
    pump.idleTimer.unref?.()
  }

  /** 采样定时器的唯一出入口：间隔变了就按新的间隔重排。 */
  function ensureTimer() {
    if (pump.timer !== null) clearInterval(pump.timer)
    pump.timer = setInterval(() => {
      void refresh()
    }, intervalMs())
    pump.timer.unref?.()
  }

  function stopTimer() {
    if (pump.timer !== null) {
      clearInterval(pump.timer)
      pump.timer = null
    }
    if (pump.idleTimer !== null) {
      clearTimeout(pump.idleTimer)
      pump.idleTimer = null
    }
    pump.snapshot = null
  }

  async function handler(req, res) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: 'Forbidden' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' })
      return
    }

    // 这次请求本身就是「有人要数据」：把表起起来、把空闲倒计时推后。
    if (pump.timer === null) {
      ensureTimer()
      void refresh()
    }
    scheduleIdleStop()

    // 首屏不必等一整轮：还没采到就直接采一次（约 80 毫秒，远快于一个间隔）。
    sendJson(res, 200, pump.snapshot ?? await refresh())
  }

  // HTTP 路由：条件挂载，没有 webServer 时插件其余部分照常工作。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-dock-vitals',
      handler
    }), 'dsh-dock-vitals: http routes')
  })

  // 注册可热改的设置页：用户改完不用重启就生效。
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // 订阅间隔字段；值一变就重排定时器（effect 里的 get() 建立依赖）。
  ctx.effect(() => {
    intervalMs()
    if (pump.timer !== null) ensureTimer()
    return () => {}
  }, 'dsh-dock-vitals: interval watch')

  ctx.effect(() => () => stopTimer(), 'dsh-dock-vitals: teardown')

  ctx.logger.info('dsh-dock-vitals: ready (cpu/memory via os, gpu via platform backends)')
}