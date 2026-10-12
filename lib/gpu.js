/**
 * GPU 采集：按平台挑后端，谁先答上来就用谁，并记住是谁答上来的。
 *
 * 为什么要多后端 —— 显卡厂商各有一套 CLI，谁也不通用：
 *   NVIDIA      : `nvidia-smi`（Windows / Linux，信息最全：型号 + 占用 + 显存 + 温度 + 频率）
 *   AMD / Linux : `rocm-smi`（要装 ROCm；Windows 上**不存在**这个命令）
 *   macOS       : 没有厂商 CLI，读 `ioreg` 的 IOKit 注册表（Apple Silicon 与 Intel Mac 都走这条）
 *   Windows 兜底: PDH 性能计数器（`typeperf`），任务管理器用的同一套，覆盖所有厂商
 *
 * 刻意**不做**的两条路：
 *   - `amd-smi`（ROCm 6.x）：拿不到逐字输出样例，而它的表头是动态的（APU 末列叫
 *     `GTT_USAGE`、独显叫 `VRAM_USAGE`），按猜的列名写解析器只会静默出错。
 *   - `powermetrics`（macOS 信息最全的源）：**每次调用都要 sudo**，与本插件
 *     「不需要管理员权限」的前提冲突，故舍去。
 *
 * ⚠️ 采集失败是**常态路径**，不是异常：大部分机器上第一顺位后端根本不存在。
 * 任何一个后端都可能抛错、超时、或者干脆不存在，全挂了就退回 `available:false`，
 * CPU / 内存照常显示。这里的每个 try/catch 都不是防御性编程，是主流程。
 *
 * ⚠️ `execFile` 可能**同步抛错**（沙箱 / 权限下是 `spawn EPERM`），不接住的话
 * Promise 执行器会把异常变成 reject，一路冒到 HTTP handler，整个快照接口挂掉 ——
 * 一个显卡探测失败不该拖垮 CPU / 内存读数。
 *
 * ⚠️ 读不到的字段一律 `null`，**绝不填 0**：「温度读不到」和「温度 0°C」是两回事，
 * 混为一谈会让界面理直气壮地显示一个假数字。
 */

import { execFile } from 'node:child_process'
import os from 'node:os'

/** nvidia-smi 一次问全：型号、占用、显存、温度、频率。 */
const NVIDIA_QUERY = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.current.graphics'
/** nvidia-smi 正常 50ms 内回来，给到 2.5 秒已经很宽松。 */
const NVIDIA_TIMEOUT = 2500
/**
 * typeperf（Windows 通用 GPU 计数器）。实测这台机器上：
 *   起进程 + 枚举 433 个计数器 ≈ 1.2~1.7 秒，`-sc 2 -si 1` 还要再等 1 秒，
 *   合计 **2.7 秒**左右。所以它只能当兜底，而且刷新周期必须单独放宽（见 minPeriodMs）。
 */
const PDH_PATH = '\\GPU Engine(*)\\Utilization Percentage'
const PDH_TIMEOUT = 12000
/** typeperf 一次会吐 50KB 上下的 CSV（每块卡几百个实例）。 */
const PDH_MAX_BUFFER = 8 * 1024 * 1024
/** 全链路都失败后的静默期：这台机器就是读不到 GPU，别每个 tick 都白跑一遍 2.7 秒。 */
const FAILURE_BACKOFF = 60000

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clampPercent(value) {
  return round(Math.min(100, Math.max(0, value)), 1)
}

/**
 * 统一包一层 execFile：同步抛错也变成 resolve，调用方只管看 error。
 * @returns {Promise<{ stdout: string, stderr: string, error: Error|null }>}
 */
function run(command, args, timeout, maxBuffer = 1024 * 1024) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout, windowsHide: true, maxBuffer }, (error, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error ?? null })
      })
    } catch (error) {
      resolve({ stdout: '', stderr: '', error })
    }
  })
}

/** 把 error / stderr 收敛成一句能给用户看的话。 */
function describeError(error, stderr, fallback) {
  const lines = String(stderr ?? '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const detail = lines.pop()
  if (detail !== undefined && detail.length > 0) return detail
  if (error?.code === 'ENOENT') return fallback
  const message = error?.message
  return typeof message === 'string' && message.length > 0 ? message : (fallback ?? 'unknown error')
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

/**
 * nvidia-smi 的 `--format=csv,noheader,nounits` 一行。
 * @param {string} line `name, util, memUsed, memTotal, temp, clock`
 */
export function parseNvidiaRow(line) {
  const cells = String(line).split(',').map((cell) => cell.trim())
  const numberAt = (index) => {
    const parsed = Number.parseFloat(cells[index] ?? '')
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    name: cells[0] ?? '',
    utilPercent: numberAt(1),
    memoryUsedMiB: numberAt(2),
    memoryTotalMiB: numberAt(3),
    temperatureC: numberAt(4),
    clockMegahertz: numberAt(5)
  }
}

/** 把 typeperf 的一行 CSV 拆成单元格（每格都被双引号包着）。 */
function splitPdhLine(line) {
  return String(line).split('","').map((cell) => cell.replace(/^"|"$/g, ''))
}

/**
 * 解析 `typeperf "\GPU Engine(*)\Utilization Percentage"` 的 CSV 输出。
 *
 * 输出形态（实测）：
 * ```
 * "(PDH-CSV 4.0) (China Standard Time)(-480)","\\MM\GPU Engine(pid_195872_luid_0x00000000_0x000131A5_phys_0_eng_0_engtype_3D)\Utilization Percentage",...
 * "10/12/2026 19:41:02.021"," "," ",...            ← 基线行：全是空格，没有数字
 * "10/12/2026 19:41:03.041","0","0","0.588445",...  ← 真实数据行
 * ```
 * PDH 的速率计数器要两个采样点才能算，所以**基线行必须跳过** ——
 * 判据就是「这一行有没有可解析的数字」，从后往前找第一行有数字的。
 *
 * 聚合口径（对齐任务管理器）：
 *   1. 同一个 luid 下、同一种引擎（`engtype_3D` / `VideoDecode` / …）的**各进程求和**，
 *      近似该引擎的忙碌时间占比 —— 同一时刻只有一个进程能占住引擎，所以求和比取最大值更贴近真相；
 *   2. 再对**引擎类型取最大值**：正在放视频时 3D 引擎是闲的，但 VideoDecode 很忙，
 *      只看 3D 会把「显卡明明在干活」显示成 0%；
 *   3. 多张显卡时取**最忙的那张**。
 *
 * @returns {{ utilPercent: number|null, adapter: string|null, engines: number }}
 */
export function parsePdhCsv(stdout) {
  const empty = { utilPercent: null, adapter: null, engines: 0 }
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('"'))
  if (lines.length < 2) return empty
  const header = splitPdhLine(lines[0])
  if (header.length < 2) return empty

  for (let index = lines.length - 1; index >= 1; index -= 1) {
    const data = splitPdhLine(lines[index])
    if (data.length !== header.length) continue
    // 基线行整行是空格，parseFloat 全是 NaN —— 用它把基线跳过去。
    const usable = data.slice(1).some((cell) => Number.isFinite(Number.parseFloat(cell)))
    if (!usable) continue

    /** @type {Map<string, Map<string, number>>} luid → 引擎类型 → 累计占用 */
    const perAdapter = new Map()
    let instances = 0
    for (let column = 1; column < header.length; column += 1) {
      const match = /luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\d+_eng_\d+_engtype_(\w+)/.exec(header[column])
      if (match === null) continue
      instances += 1
      const value = Number.parseFloat(data[column])
      if (!Number.isFinite(value)) continue
      const adapter = match[1]
      const engine = match[2]
      if (!perAdapter.has(adapter)) perAdapter.set(adapter, new Map())
      const engines = perAdapter.get(adapter)
      engines.set(engine, (engines.get(engine) ?? 0) + value)
    }
    if (perAdapter.size === 0) continue

    let best = null
    for (const [adapter, engines] of perAdapter) {
      let busiest = 0
      for (const total of engines.values()) busiest = Math.max(busiest, total)
      if (best === null || busiest > best.value) best = { adapter, value: busiest }
    }
    if (best === null) continue
    return { utilPercent: clampPercent(best.value), adapter: best.adapter, engines: instances }
  }
  return empty
}

// ── 后端 ─────────────────────────────────────────────────────────────────────

const unavailable = (error) => ({ gpu: { available: false }, error })

/**
 * @typedef {object} GpuBackend
 * @property {string} id 后端标识，会随快照回给客户端（排查时一眼看出数据是哪来的）
 * @property {string[]} platforms 适用的 `os.platform()` 值
 * @property {number} minPeriodMs 这个后端最快多久采一次；0 = 跟着刷新间隔走
 * @property {() => Promise<{ gpu: object, error: string|null }>} read
 */

/** NVIDIA：Windows / Linux 通用，信息最全，而且只有 ~50ms。 */
const nvidiaSmi = {
  id: 'nvidia-smi',
  platforms: ['win32', 'linux'],
  minPeriodMs: 0,
  async read() {
    const { stdout, stderr, error } = await run(
      'nvidia-smi',
      [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'],
      NVIDIA_TIMEOUT
    )
    if (error !== null) return unavailable(describeError(error, stderr, 'nvidia-smi not found on PATH'))
    const row = String(stdout).split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
    if (row === undefined) return unavailable('nvidia-smi returned no GPU rows')
    return { gpu: { available: true, ...parseNvidiaRow(row) }, error: null }
  }
}

/**
 * Windows 通用兜底：PDH 的 `\GPU Engine(*)\Utilization Percentage` 计数器。
 *
 * 这是 Windows 上**唯一能覆盖所有厂商**的路子 —— AMD / Intel 在 Windows 上
 * 没有任何官方命令行能读 GPU 占用（ROCm 的 `rocm-smi` 只有 Linux 版），
 * 而任务管理器用的就是这一套性能计数器。
 *
 * 代价：读不到显存占用和温度（PDH 没有这两个计数器），而且一次要 ~2.7 秒。
 */
const windowsPdh = {
  id: 'windows-pdh',
  platforms: ['win32'],
  minPeriodMs: 5000,
  async read() {
    const { stdout, stderr, error } = await run(
      'typeperf',
      [PDH_PATH, '-sc', '2', '-si', '1'],
      PDH_TIMEOUT,
      PDH_MAX_BUFFER
    )
    if (error !== null) return unavailable(describeError(error, stderr, 'typeperf unavailable'))
    const parsed = parsePdhCsv(stdout)
    if (parsed.utilPercent === null) return unavailable('no GPU performance counters reported')
    return {
      // name 留空：PDH 只给 luid，拿不到显卡型号。客户端见到空名会退回通用文案。
      gpu: {
        available: true,
        name: null,
        utilPercent: parsed.utilPercent,
        memoryUsedMiB: null,
        memoryTotalMiB: null,
        temperatureC: null,
        clockMegahertz: null
      },
      error: null
    }
  }
}

/**
 * 解析 `ioreg -r -d 1 -w 0 -c IOAccelerator` 的输出。
 *
 * 输出是 plist 风格的 `"key"=value` 文本（不是 JSON）。真正有用的那块是
 * `"PerformanceStatistics" = { ... }`，里面逗号分隔着所有计数器。
 *
 * ⚠️ 三个实测出来的坑：
 *   1. **`-w 0` 不能省**。ioreg 默认按终端宽度截断，`PerformanceStatistics` 会被
 *      从中间切断、整块键消失 —— 表现是「macOS 上永远读不到 GPU」。
 *   2. **占用率字段名随机器类型变**：Apple Silicon 是 `Device Utilization %`，
 *      AMD 独显（黑苹果）是 `GPU Activity(%)`，而且 AMD 的 `Device Utilization %`
 *      恒为 0。nvtop 的做法是**取两者中较大的那个**，这里照办。
 *   3. **`In use system memory` 有个同名兄弟 `In use system memory (driver)`**，
 *      必须精确匹配键名，否则会读到驱动自己那一份。
 *
 * @returns {{ name: string|null, utilPercent: number|null, memoryUsedMiB: number|null, coreCount: number|null, temperatureC: number|null, allZero: boolean }}
 */
export function parseIoreg(text) {
  const source = String(text)
  const empty = { name: null, utilPercent: null, memoryUsedMiB: null, coreCount: null, temperatureC: null, allZero: false }

  const stats = /"PerformanceStatistics"\s*=\s*\{([^}]*)\}/.exec(source)
  if (stats === null) return empty

  /** @type {Map<string, string>} 键名精确匹配，"In use system memory (driver)" 不会撞上。 */
  const fields = new Map()
  for (const pair of stats[1].split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim().replace(/^"|"$/g, '')
    const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, '')
    if (key.length > 0) fields.set(key, value)
  }
  const number = (key) => {
    // 注册表里的 0 是有效读数，别当缺失；`N/A` 才是缺失，绝不能让它变成 0。
    const raw = fields.get(key)
    if (raw === undefined || raw === '' || raw === 'N/A') return null
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  // 两个字段谁大信谁 —— AMD 的 Device Utilization % 恒为 0，只看它会显示成「显卡闲着」。
  const device = number('Device Utilization %')
  const activity = number('GPU Activity(%)')
  const candidates = [device, activity].filter((value) => value !== null)
  const utilPercent = candidates.length === 0 ? null : clampPercent(Math.max(...candidates))

  // 型号与核心数在 PerformanceStatistics 外面，是 IOAccelerator 对象的属性。
  const modelMatch = /"model"\s*=\s*"([^"]*)"/.exec(source)
  const coreMatch = /"gpu-core-count"\s*=\s*(\d+)/.exec(source)
  const usedBytes = number('In use system memory')
  const temperature = number('Temperature(C)')

  const watched = [device, activity, usedBytes, temperature].filter((value) => value !== null)
  return {
    name: modelMatch === null ? null : modelMatch[1],
    utilPercent,
    memoryUsedMiB: usedBytes === null ? null : round(usedBytes / (1024 * 1024), 0),
    coreCount: coreMatch === null ? null : Number.parseInt(coreMatch[1], 10),
    temperatureC: temperature,
    // 有的 AMD 卡（Navi 21 那批）驱动没接全，所有计数器都是 0。
    // 「全 0」要报成读不到，而不是「GPU 很闲」——空闲的显卡至少内存计数器不为 0。
    allZero: watched.length > 0 && watched.every((value) => value === 0)
  }
}

/** 引号感知的 CSV 拆分：rocm-smi 的卡名里可能带逗号。 */
function splitCsvLine(line) {
  const cells = []
  let current = ''
  let quoted = false
  for (const char of String(line)) {
    if (char === '"') { quoted = !quoted; continue }
    if (char === ',' && !quoted) { cells.push(current); current = ''; continue }
    current += char
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/**
 * 解析 `rocm-smi ... --csv` 的输出。
 *
 * 形态：第一行表头、之后每卡一行。**按表头名取列，不要正则扫文本** ——
 * 有项目就是因为扫文本，把 `GFX Version` 那列当成了显卡型号。
 *
 * ⚠️ `N/A` 必须判在 `parseFloat` 之前。有项目栽在这：「先解析再忽略错误」，
 * 结果同一行里 `17.0` 和 `N/A` 并存时，好好的功耗值被 `N/A` 覆盖成 0。
 *
 * ⚠️ 要「显存已用 / 总量」必须带 `--showmeminfo vram`：`--showmemuse` 只给百分比。
 *
 * @returns {{ name: string|null, utilPercent: number|null, memoryUsedMiB: number|null, memoryTotalMiB: number|null, temperatureC: number|null }}
 */
export function parseRocmCsv(text) {
  const empty = { name: null, utilPercent: null, memoryUsedMiB: null, memoryTotalMiB: null, temperatureC: null }
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return empty

  const header = splitCsvLine(lines[0])
  if (header.length <= 1) return empty
  const column = (name) => header.findIndex((cell) => cell === name)

  const idxUse = column('GPU use (%)')
  const idxTotal = column('VRAM Total Memory (B)')
  const idxUsed = column('VRAM Total Used Memory (B)')
  const idxTemp = column('Temperature (Sensor edge) (C)')
  const idxSeries = column('Card Series')
  const idxModel = column('Card Model')

  const cell = (cells, index) => {
    if (index < 0 || index >= cells.length) return null
    const value = cells[index].trim()
    if (value === '' || value === 'N/A') return null
    return value
  }
  const numeric = (cells, index, scale = 1) => {
    const value = cell(cells, index)
    if (value === null) return null
    const parsed = Number.parseFloat(value.replace(/,/g, ''))
    return Number.isFinite(parsed) ? round(parsed / scale, 1) : null
  }

  let best = null
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line)
    // 列数对不上说明缺列，这一行不可信，丢掉。
    if (cells.length !== header.length) continue
    const util = numeric(cells, idxUse)
    if (util === null) continue
    if (best === null || util > best.utilPercent) {
      best = {
        name: cell(cells, idxSeries) ?? cell(cells, idxModel),
        utilPercent: clampPercent(util),
        memoryUsedMiB: numeric(cells, idxUsed, 1024 * 1024),
        memoryTotalMiB: numeric(cells, idxTotal, 1024 * 1024),
        temperatureC: numeric(cells, idxTemp)
      }
    }
  }
  return best ?? empty
}

/**
 * macOS：`ioreg` 读 IOKit 注册表。**免提权**，单次约 20ms，Intel Mac 也覆盖。
 *
 * 为什么不走 `powermetrics`：它每次都要 `sudo`，装个状态栏插件还要用户输密码说不过去。
 * 代价是 ioreg 给不了总显存（统一内存架构下「显存容量」本来也不是个固定数），
 * 所以 `memoryTotalMiB` 留 null，客户端会只显示已用量。
 */
const macosIoreg = {
  id: 'ioreg',
  platforms: ['darwin'],
  minPeriodMs: 0,
  async read() {
    const { stdout, error } = await run(
      'ioreg',
      // -w 0 不能省：少了它 PerformanceStatistics 会被按行宽截断，整块键消失。
      ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'],
      4000,
      4 * 1024 * 1024
    )
    if (error !== null) return unavailable(describeError(error, '', 'ioreg unavailable'))
    const parsed = parseIoreg(stdout)
    if (parsed.allZero) return unavailable('GPU counters report zero (driver may not expose them)')
    if (parsed.utilPercent === null && parsed.memoryUsedMiB === null) {
      return unavailable('no IOAccelerator performance statistics')
    }
    return {
      gpu: {
        available: true,
        name: parsed.name,
        utilPercent: parsed.utilPercent,
        memoryUsedMiB: parsed.memoryUsedMiB,
        memoryTotalMiB: null,
        temperatureC: parsed.temperatureC,
        clockMegahertz: null
      },
      error: null
    }
  }
}

/**
 * Linux + AMD：`rocm-smi`（装了 ROCm 才有）。只读，不需要 sudo。
 *
 * 没做 `amd-smi`（ROCm 6.x 的继任者）：它是 `rocm-smi` 的替代品，输出格式不同，
 * 但拿不到逐字的 CSV 样例 —— 与其照着文档猜列名写一个会静默出错的解析器，
 * 不如先不做。装了 amd-smi 的机器通常也还留着 rocm-smi。
 */
const linuxRocmSmi = {
  id: 'rocm-smi',
  platforms: ['linux'],
  // rocm-smi 慢是已知现象（有项目专门给它配 5 秒超时），别让它拖垮刷新节奏。
  minPeriodMs: 2000,
  async read() {
    const { stdout, stderr, error } = await run(
      'rocm-smi',
      ['-u', '--showmemuse', '--showmeminfo', 'vram', '-t', '--showtemp', '--showproductname', '--csv'],
      5000
    )
    if (error !== null) return unavailable(describeError(error, stderr, 'rocm-smi not found on PATH'))
    const parsed = parseRocmCsv(stdout)
    if (parsed.utilPercent === null) return unavailable('rocm-smi reported no GPU rows')
    return { gpu: { available: true, ...parsed }, error: null }
  }
}

/**
 * 按平台挑后端，数组顺序即优先级。
 *
 * Windows 上 AMD / Intel 没有厂商 CLI（ROCm 根本不支持 Windows），所以
 * `typeperf` 是那里唯一能覆盖所有厂商的路子 —— 任务管理器用的也是这套计数器。
 */
function backendsFor(platform) {
  if (platform === 'darwin') return [macosIoreg]
  if (platform === 'linux') return [nvidiaSmi, linuxRocmSmi]
  if (platform === 'win32') return [nvidiaSmi, windowsPdh]
  return []
}

// ── 对外 ─────────────────────────────────────────────────────────────────────

/**
 * 建一个 GPU 读取器。它会**记住上次成功的后端**并优先使用，
 * 免得在 AMD 机器上每个 tick 都白跑一遍 nvidia-smi。
 *
 * 全链路失败后会静默 `FAILURE_BACKOFF` 毫秒再重试 —— 没有显卡的机器不该
 * 每 3 秒付一次 typeperf 的 2.7 秒。
 */
export function createGpuReader() {
  const platform = os.platform()
  const available = backendsFor(platform)
  /** 上次成功的后端 id。 */
  let preferred = null
  /** 连续全链路失败时的静默截止时刻。 */
  let quietUntil = 0
  /** @type {GpuBackend|null} */
  let active = null

  return {
    /** 当前生效后端建议的最短刷新周期（毫秒）；还没探测出来时返回 0。 */
    get minPeriodMs() {
      return active === null ? 0 : active.minPeriodMs
    },
    /** 最近一次成功的后端 id，没成功过就是 null。 */
    get backendId() {
      return active === null ? null : active.id
    },
    /**
     * 采一次。永远 resolve，绝不 reject。
     * @returns {Promise<{ gpu: object, error: string|null }>}
     */
    async read() {
      if (available.length === 0) {
        return unavailable(`no GPU backend for platform "${platform}"`)
      }
      if (Date.now() < quietUntil) {
        return unavailable(`no readable GPU (retrying in ${Math.ceil((quietUntil - Date.now()) / 1000)}s)`)
      }
      // 上次成功的后端排最前，其余按声明顺序跟上 —— 首选挂了还能自动降级。
      const ordered = preferred === null
        ? available
        : [...available.filter((backend) => backend.id === preferred), ...available.filter((backend) => backend.id !== preferred)]
      let lastError = null
      for (const backend of ordered) {
        const result = await backend.read()
        if (result.gpu.available === true) {
          preferred = backend.id
          active = backend
          return result
        }
        if (result.error !== null) lastError = result.error
      }
      preferred = null
      active = null
      quietUntil = Date.now() + FAILURE_BACKOFF
      return unavailable(lastError ?? 'no readable GPU')
    }
  }
}
