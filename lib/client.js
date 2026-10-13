/**
 * dsh-dock-vitals — 浏览器侧。
 *
 * 两块 UI：
 * 1. 输入框下方状态栏里的徽章（`conversation.composer.dock` 槽）——
 *    就是「2 轮 30 步 · 98 tok/s ｜ 1.8M tok · 缓存命中 84% ｜ 6%」那一行的
 *    **最右侧**（排在宿主「上下文」状态项右边，靠 CSS `order` 实现，见 CSS 注释）。
 * 2. 设置页里的「系统状态」分区（`settings.section` 槽），控制显示哪些指标。
 *
 * ⚠️ 三条铁律（都是被 DSH 的 fail-closed 启动打过脸之后写下的）：
 *
 * 1. **`apply()` 里绝对不能调用任何 React hook。**
 *    `apply()` 是普通函数，不是组件；在里面调 `useSyncExternalStore` 会抛
 *    "Invalid hook call"，client entry 状态变 `failed`，而 DSH 前端 web boot
 *    只要有一个 entry 不是 active 就整体 throw、拒绝启动（桌面版直接打不开）。
 *    Hook 只能出现在组件函数体内。
 *
 * 2. **绝不把对象方法直接交给 `useSyncExternalStore`。**
 *    `store.subscribe` 这类原型/对象方法脱离 `this` 调用会炸，必须用模块级
 *    纯函数或箭头函数包一层。
 *
 * 3. **`apply()` 整体包 try/catch。**
 *    本插件坏掉只该让它自己不显示，不该把老板的整个 DSH 拖下水。
 *
 * 另外：**不要 require 白名单外的任何 Harness Client 包**。宿主 web 前端的
 * `staticModules` 只静态提供这几个名字：
 *
 *   react / react/jsx-runtime / react-dom / react-dom/client /
 *   @deepseek-ai/cordis / @deepseek-ai/dsh-client-store /
 *   @deepseek-ai/dsh-client-ui-slots / @deepseek-ai/dsh-client-ui-primitives /
 *   @deepseek-ai/dsh-client-ui-dockkit
 *
 * 白名单内的可以安全用（本文件软取 `react-dom` 与 `dsh-client-ui-primitives`
 * 来做 portal 浮层）；白名单外的解析必失败，而 require 抛错会直接炸掉 factory
 * → entry failed → 桌面版打不开。所以**任何 require 都要包 try/catch 并准备好降级**。
 * 样式只用 `--dsw-*` 主题 token。
 */

window.__ModuleLoader__.load({
  id: 'dsh-dock-vitals',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useSyncExternalStore } = React

    // ── 宿主白名单模块（软取，拿不到就降级，绝不抛错炸 factory） ────────────────
    //
    // 这几个名字由宿主 web 前端的 `staticModules` 静态提供（见文件头注释）。
    // 即便在白名单内也**必须**包 try/catch：require 抛错会炸掉整个 factory，
    // entry 变 failed，而桌面版 web boot 是 fail-closed 的 —— 会直接打不开。
    // 拿到哪个用哪个；一个都没拿到时退化成「绝对定位内联面板」，功能不丢。

    function softRequire(name) {
      try {
        return require(name)
      } catch (error) {
        console.warn('[dsh-dock-vitals] optional module unavailable:', name, error)
        return null
      }
    }

    /** ESM/CJS 互操作：既认 `mod.name`，也认 `mod.default.name`。 */
    function pickExport(mod, name) {
      if (mod === null || mod === undefined) return undefined
      if (typeof mod[name] === 'function') return mod[name]
      const fallback = mod.default
      if (fallback !== null && fallback !== undefined && typeof fallback[name] === 'function') return fallback[name]
      return undefined
    }

    const createPortal = pickExport(softRequire('react-dom'), 'createPortal')
    const Primitives = softRequire('@deepseek-ai/dsh-client-ui-primitives')
    const hostUseAnchoredPosition = pickExport(Primitives, 'useAnchoredPosition')
    const hostUseDismissOnOutsidePointer = pickExport(Primitives, 'useDismissOnOutsidePointer')
    const HostTooltip = pickExport(Primitives, 'Tooltip')

    // 悬停气泡：**一律用宿主那套**（与「上下文」等三个状态项同款），拿不到才退回原生 title。
    // 原生 title 由浏览器实现，要悬停 1~2 秒才弹、样式也改不了 —— 老板反馈过「悬停没作用」。
    // 200ms 与宿主 ContextMeter 的 delayMs 对齐：够快，又不会被鼠标划过时连环闪。
    const hasHostTooltip = typeof HostTooltip === 'function'
    const TOOLTIP_DELAY_MS = 200

    // ⚠️ hook 必须**无条件调用**，所以这两处把「有就用宿主的、没有就用空实现」
    // 在模块级定好，组件里照常调用 —— 绝不能写成 if (可用) useXxx(...)。
    /**
     * 定位 hook（宿主实现拿不到时的等价降级版）。
     * 与宿主 `useAnchoredPosition` 同签名：返回 `{left, top}`，首帧返回 `null`。
     * ⚠️ hook 调用数量固定，所以组件里可以无条件调用它。
     */
    function useAnchorPositionFallback(options) {
      const open = options.open
      const anchorRef = options.anchorRef
      const panelRef = options.panelRef
      const side = options.side ?? 'top'
      const align = options.align ?? 'end'
      const gap = options.gap ?? 8
      const margin = options.margin ?? 12
      const [position, setPosition] = React.useState(null)

      React.useLayoutEffect(function () {
        if (!open) { setPosition(null); return undefined }
        const place = function () {
          try {
            const anchor = anchorRef.current
            if (anchor === null || anchor === undefined) return
            if (typeof anchor.getBoundingClientRect !== 'function') return
            const rect = anchor.getBoundingClientRect()
            const panel = panelRef.current
            const width = panel === null || panel === undefined ? 0 : (panel.offsetWidth ?? 0)
            const height = panel === null || panel === undefined ? 0 : (panel.offsetHeight ?? 0)
            let left = align === 'end' ? rect.right - width : rect.left
            let top = side === 'top' ? rect.top - gap - height : rect.bottom + gap
            if (width > 0) left = Math.min(Math.max(left, margin), window.innerWidth - width - margin)
            if (height > 0) top = Math.min(Math.max(top, margin), window.innerHeight - height - margin)
            setPosition({ left, top })
          } catch (error) {
            // 量不到位就让它停在 visibility:hidden，绝不抛错。
          }
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        let observer = null
        const panel = panelRef.current
        if (typeof ResizeObserver === 'function' && panel !== null && panel !== undefined) {
          observer = new ResizeObserver(function () { place() })
          observer.observe(panel)
        }
        return function () {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
          if (observer !== null) observer.disconnect()
        }
      }, [open, anchorRef, panelRef, side, align, gap, margin])

      return position
    }

    /**
     * 外部点击收起（宿主实现拿不到时的等价降级版）。
     * 面板走 portal 渲染到 body 时必须把 panelRef 也算作「内部」，否则点面板就收起。
     */
    function useDismissOnOutsideFallback(rootRef, open, setOpen, panelRef) {
      React.useEffect(function () {
        if (!open) return undefined
        const onPointerDown = function (event) {
          const target = event.target
          if (target === null || target === undefined) return
          const root = rootRef.current
          const panel = panelRef.current
          if (root !== null && root !== undefined && typeof root.contains === 'function' && root.contains(target)) return
          if (panel !== null && panel !== undefined && typeof panel.contains === 'function' && panel.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        return function () { document.removeEventListener('pointerdown', onPointerDown) }
      }, [open, rootRef, panelRef, setOpen])
    }

    // ⚠️ 这两个常量必须是「同一个函数引用」且**永远可调用**，组件里才能无条件调用。
    const useAnchorPosition = typeof hostUseAnchoredPosition === 'function'
      ? hostUseAnchoredPosition
      : useAnchorPositionFallback
    const useDismissOnOutside = typeof hostUseDismissOnOutsidePointer === 'function'
      ? hostUseDismissOnOutsidePointer
      : useDismissOnOutsideFallback

    /** settings 命名空间，必须与 host 侧 SETTINGS_NAMESPACE、cordis.patch.yml 的 entry id 一致。 */
    const SETTINGS_NAMESPACE = 'dock-vitals'
    const DATA_URL = '/dsh-dock-vitals/snapshot'
    const DOCK_ID = 'dsh-dock-vitals-badge'
    const SECTION_ID = 'dock-vitals'
    const STYLE_ID = 'dsh-dock-vitals-style'
    const MIN_INTERVAL = 1500
    const MAX_INTERVAL = 60000
    /** 刷新间隔只留三档：快 / 中 / 慢，值与文案都在这里。 */
    const SPEEDS = [
      { value: 1500, key: 'panel.speed.fast' },
      { value: 3000, key: 'panel.speed.medium' },
      { value: 10000, key: 'panel.speed.slow' }
    ]
    const DEFAULT_CONFIG = {
      enabled: true,
      showCpu: true,
      showMemory: true,
      showGpu: true,
      showGpuMemory: false,
      showGpuTemperature: false,
      intervalMs: 3000
    }

    const DICT = {
      zh: {
        'badge.sampling': '采样中',
        'section.nav': '系统状态',
        'section.title': '系统状态',
        'section.desc': '控制输入框下方状态栏里的资源徽章显示哪些指标。点击徽章可展开详情并切换刷新档位。数据只在本机采集，不上传，也不会提供给模型。',
        'field.enabled': '启用徽章',
        'field.showCpu': 'CPU',
        'field.showMemory': '内存',
        'field.showGpu': 'GPU',
        'field.showGpuMemory': '显存',
        'field.showGpuTemperature': 'GPU 温度',
        'field.intervalMs': '刷新间隔',
        'section.preview': '当前采样：CPU {cpu} ｜ 内存 {memory} ｜ GPU {gpu}',
        'section.gpuMissing': '读不到 GPU：本机没有可用的采集后端（NVIDIA 的 nvidia-smi / Linux 的 rocm-smi / macOS 的 ioreg / Windows 的 PDH 计数器都取不到）。CPU 与内存照常显示。',
        'section.gpuPartial': '当前后端读不到显存与温度（常见于 Windows 的 PDH 计数器），这两项不会显示。',
        'section.readonly': '当前连接无法写入设置，以下选项为只读。',
        'panel.cpu': 'CPU',
        'panel.memory': '内存',
        'panel.gpu': 'GPU',
        'panel.vram': '显存',
        'panel.temp': 'GPU 温度',
        'panel.gpuGeneric': 'GPU',
        'panel.interval': '刷新间隔',
        'panel.speed.fast': '快 · 1.5 秒',
        'panel.speed.medium': '中 · 3 秒',
        'panel.speed.slow': '慢 · 10 秒',
        'field.intervalHint': '三档可选：快 1.5 秒 / 中 3 秒 / 慢 10 秒。',
        // 以下这些不是「界面标签」而是拼装片段：面板行、悬浮提示都要用，
        // 必须走字典，否则英文界面里会串出中文。
        'label.colon': '：',
        'unit.cores': '{count} 核',
        'unit.ofTotal': '共 {size} GB',
        'label.unknownReason': '未知原因',
        'badge.samplingFailed': '采集失败',
        'badge.tooltipCpu': 'CPU {percent}（{cores}）',
        'badge.tooltipMemory': '内存 {percent}（{used} / {total} GB）',
        'badge.tooltipGpu': 'GPU {percent}',
        'badge.tooltipVram': '显存 {used} / {total} GB',
        'badge.tooltipVramUsed': '显存 {used} GB',
        'badge.tooltipGpuMissing': 'GPU 不可用',
        'section.loading': '设置加载中…',
        'section.writeFailed': '没能写入设置：宿主拒绝了这次修改。'
      },
      en: {
        'badge.sampling': 'sampling',
        'section.nav': 'System Status',
        'section.title': 'System Status',
        'section.desc': 'Control which metrics the resource badge under the composer shows. Click the badge to expand details and switch the refresh preset. Sampled locally only; never uploaded and never exposed to the model.',
        'field.enabled': 'Enable badge',
        'field.showCpu': 'CPU',
        'field.showMemory': 'Memory',
        'field.showGpu': 'GPU',
        'field.showGpuMemory': 'Video memory',
        'field.showGpuTemperature': 'GPU temperature',
        'field.intervalMs': 'Refresh interval',
        'section.preview': 'Current sample: CPU {cpu} | memory {memory} | GPU {gpu}',
        'section.gpuMissing': 'No readable GPU: none of the platform backends answered (nvidia-smi, rocm-smi, macOS ioreg, Windows PDH counters). CPU and memory keep working.',
        'section.gpuPartial': 'The active backend reports neither video memory nor temperature (common with the Windows PDH counters), so those two rows stay hidden.',
        'section.readonly': 'This connection cannot write settings; the options below are read-only.',
        'panel.cpu': 'CPU',
        'panel.memory': 'Memory',
        'panel.gpu': 'GPU',
        'panel.vram': 'Video memory',
        'panel.temp': 'GPU temperature',
        'panel.gpuGeneric': 'GPU',
        'panel.interval': 'Refresh interval',
        'panel.speed.fast': 'Fast · 1.5 s',
        'panel.speed.medium': 'Medium · 3 s',
        'panel.speed.slow': 'Slow · 10 s',
        'field.intervalHint': 'Three presets: fast 1.5 s / medium 3 s / slow 10 s.',
        'label.colon': ': ',
        'unit.cores': '{count} cores',
        'unit.ofTotal': 'of {size} GB',
        'label.unknownReason': 'unknown reason',
        'badge.samplingFailed': 'sampling failed',
        'badge.tooltipCpu': 'CPU {percent} ({cores})',
        'badge.tooltipMemory': 'Memory {percent} ({used} / {total} GB)',
        'badge.tooltipGpu': 'GPU {percent}',
        'badge.tooltipVram': 'Video memory {used} / {total} GB',
        'badge.tooltipVramUsed': 'Video memory {used} GB',
        'badge.tooltipGpuMissing': 'GPU unavailable',
        'section.loading': 'Loading settings…',
        'section.writeFailed': 'Could not save: the host rejected this change.'
      }
    }

    // ── 语言 ─────────────────────────────────────────────────────────────────
    //
    // 模块级纯函数 + 一个 set，没有 `this`，可以安全地直接交给 useSyncExternalStore。
    // `apply()` 里只订阅宿主语言（普通函数调用），组件里才用 useT()。

    let activeLocale = 'zh'
    const localeListeners = new Set()

    function subscribeLocale(listener) {
      localeListeners.add(listener)
      return () => {
        localeListeners.delete(listener)
      }
    }

    function localeSnapshot() {
      return activeLocale
    }

    /**
     * 按宿主给的 locale id 归一化到本插件的两套词典。
     *
     * 宿主 `LocaleFace.getSnapshot().active` 是 BCP 47 风格的 id，内置只有
     * `zh` / `en`，但语言包可以注册任意 id（`dsh-client-locale` 的
     * `LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u`）。
     * 本插件只有中英两套词典，所以**凡 zh 开头走中文、其余一律走英文**——
     * 早先写成 `next === 'en' ? 'en' : 'zh'`，`en-GB` 这类会被误判成中文。
     * 读不到宿主语言（空串 / 非字符串）时保持当前值，不瞎猜。
     */
    function setLocale(next) {
      const raw = typeof next === 'string' ? next.trim().toLowerCase() : ''
      if (raw === '') return
      const value = raw.startsWith('zh') ? 'zh' : 'en'
      if (value === activeLocale) return
      activeLocale = value
      for (const listener of [...localeListeners]) listener()
    }

    /** 纯函数翻译；读的是调用时刻的模块级 locale。 */
    function translate(key, params) {
      const table = DICT[activeLocale] ?? DICT.zh
      const text = table[key] ?? DICT.zh[key] ?? key
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** 组件内使用：订阅语言变化触发重渲染，返回稳定的翻译函数。 */
    function useT() {
      useSyncExternalStore(subscribeLocale, localeSnapshot, localeSnapshot)
      return translate
    }

    // ── 采样数据的小仓库 ───────────────────────────────────────────────────────
    //
    // 同样是模块级纯函数：所有徽章共享同一份快照与同一个定时器，开几个会话都只采一次。
    // `useSyncExternalStore` 靠 getSnapshot 的引用变化判断要不要重渲染，
    // 所以 state 必须整体换新对象。

    let vitalsState = { snapshot: null, error: null }
    const vitalsListeners = new Set()
    let vitalsTimer = null
    let vitalsPeriod = 3000
    let vitalsConsumers = 0

    function subscribeVitals(listener) {
      vitalsListeners.add(listener)
      return () => {
        vitalsListeners.delete(listener)
      }
    }

    function vitalsSnapshot() {
      return vitalsState
    }

    function publishVitals(next) {
      vitalsState = { ...vitalsState, ...next }
      for (const listener of [...vitalsListeners]) listener()
    }

    function loadVitals() {
      fetch(DATA_URL, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
        .then((payload) => publishVitals({ snapshot: payload, error: null }))
        .catch((error) => publishVitals({ error: error instanceof Error ? error.message : String(error) }))
    }

    /**
     * 节拍的**唯一出入口**：定时器永远按 `vitalsPeriod` 重建。
     *
     * ⚠️ 不能让调用方各自 `vitalsPeriod = x` 再自己决定要不要重排 —— 多处写同一个
     * 记录值，只要有一处「改了记录值但没重排定时器」，就会出现「记录值 10 秒、
     * 真实节拍照旧 3 秒」的分裂，而且此后所有 `retimeVitals(同值)` 全会早退，
     * 面板高亮乖乖跟着走、请求频率纹丝不动，极难排查。
     */
    function setPeriod(period) {
      const next = clampPeriod(period)
      if (vitalsTimer !== null && next === vitalsPeriod) return
      vitalsPeriod = next
      if (vitalsTimer !== null) clearInterval(vitalsTimer)
      vitalsTimer = setInterval(loadVitals, next)
    }

    /** 起表（首个消费者才真起）并立刻采一次。 */
    function startVitals(period) {
      vitalsConsumers += 1
      setPeriod(period)
      loadVitals()
    }

    /** 卸载一个消费者；没人要了才停表。 */
    function releaseVitals() {
      if (vitalsConsumers > 0) vitalsConsumers -= 1
      if (vitalsConsumers > 0 || vitalsTimer === null) return
      clearInterval(vitalsTimer)
      vitalsTimer = null
    }

    /** 周期变了只重排节拍，不动消费者计数。 */
    function retimeVitals(period) {
      if (vitalsTimer === null) return
      setPeriod(period)
    }

    /** 徽章开着但组件尚未挂载时（首帧前）也要有数据，避免弹出「采样中」。 */
    function ensureVitals() {
      if (vitalsTimer === null) setPeriod(resolveSettings(vitalsState.snapshot).intervalMs)
      if (vitalsState.snapshot === null) loadVitals()
    }

    // ── 格式化 ────────────────────────────────────────────────────────────────

    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${Math.round(value)}%`
    }

    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toFixed(1)
    }

    function formatTemperature(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${Math.round(value)}°C`
    }

    function gpuAvailable(snapshot) {
      return snapshot !== null && snapshot !== undefined && snapshot.gpu !== undefined && snapshot.gpu.available === true
    }

    /** 数值可用性判断：后端读不到的字段是 null，不是 0 —— 0% 和「没这项」必须分开。 */
    function hasNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /** 当前后端能不能给显存读数（Windows 的 PDH 计数器就给不了）。 */
    function gpuHasMemory(snapshot) {
      return gpuAvailable(snapshot) && hasNumber(snapshot.gpu.memoryUsedMiB)
    }

    /** 当前后端能不能给温度读数。 */
    function gpuHasTemperature(snapshot) {
      return gpuAvailable(snapshot) && hasNumber(snapshot.gpu.temperatureC)
    }

    /** GPU 型号：PDH 后端只能给 luid，拿不到型号，退回通用文案而不是显示空白。 */
    function gpuLabel(snapshot, t) {
      const name = snapshot?.gpu?.name
      return typeof name === 'string' && name.length > 0 ? name : t('panel.gpuGeneric')
    }

    function clampPeriod(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 3000
      return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, value))
    }

    /**
     * 显示配置**优先取宿主的实时配置通道**，host 快照里的 `settings` 只当兜底。
     *
     * ⚠️ 这里曾经只从采样快照读 `settings`，埋了个死锁：取消勾选 → 徽章 return null
     * → 采样停表 → 快照冻结在「已关闭」那一帧 → 重新勾选写进的是宿主 config
     * （真值早已 true），可没人在拉数据，新值永远同步不回来 → 徽章再也不出现。
     * 配置住在 `ConfigFormController`（实时推送），采样快照必须靠轮询才更新，
     * 拿轮询快照当配置源，等于把开关焊死在最后一帧上。
     *
     * `live` 为 null/undefined 时（`configForms` 不可用）才退回快照解析，
     * 这样即使设置 UI 被禁用，徽章照样按默认值正常工作。
     */
    function resolveSettings(snapshot, live) {
      const s = (live !== null && live !== undefined)
        ? live
        : ((snapshot !== null && snapshot !== undefined && snapshot.settings !== undefined) ? snapshot.settings : {})
      return {
        enabled: s.enabled !== false,
        showCpu: s.showCpu !== false,
        showMemory: s.showMemory !== false,
        showGpu: s.showGpu !== false,
        showGpuMemory: s.showGpuMemory === true,
        showGpuTemperature: s.showGpuTemperature === true,
        intervalMs: clampPeriod(s.intervalMs)
      }
    }

    // ── 设置快照（组件内 hook） ────────────────────────────────────────────────

    /**
     * 本插件的设置由宿主 settings 通道托管，`configForms.get(ns)` 拿到的是
     * `ConfigFormController`：subscribe / getSnapshot 引用稳定，set 走宿主写入。
     * 它是对象方法，必须包一层箭头函数再交给 useSyncExternalStore。
     */
    function useConfig(form) {
      const subscribe = useCallback((listener) => form.subscribe(listener), [form])
      const getSnapshot = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return {
        writable: snapshot.writable === true,
        /**
         * 宿主把配置镜像下来的第一帧 `status` 是 `'loading'`（要等 remote 首个响应
         * 才 `derive()` 成 `'ready'`）。这期间 `writable` 可能已经是 true（镜像里说
         * 能写）、也可能还是 false。**把这一态单独拎出来**，界面才不会在还没拿到
         * 配置时就说「本连接无法写入设置」——那是句假话，半秒后自己就变了。
         */
        pending: snapshot.status === 'loading',
        value: snapshot.status === 'ready' && snapshot.value !== undefined ? snapshot.value : DEFAULT_CONFIG
      }
    }

    // ── 徽章组件 ──────────────────────────────────────────────────────────────

    function DockBadge() {
      const t = useT()
      const state = useSyncExternalStore(subscribeVitals, vitalsSnapshot, vitalsSnapshot)
      const snapshot = state.snapshot
      // 实时配置优先，采样快照兜底 —— 顺序不能反，理由见 resolveSettings 注释。
      const liveConfig = useDockConfig()
      const settings = resolveSettings(snapshot, liveConfig)
      const config = useSettingsWritable()

      const enabled = settings.enabled
      const period = settings.intervalMs
      /**
       * 「用户还想不想要指标」。决定要不要继续拉数据，也决定组件要不要 return null。
       * 比「界面上真有几行」宽松（理由见下），所以全部开关关掉时它一定为 false
       * —— README 承诺关掉后不再发请求，host 侧的 15 秒空闲停表靠这个触发。
       */
      // ⚠️ 显存 / 温度这两项**不能**用 gpuHasMemory(snapshot) 卡一道：
      // 快照要起表才更新，而这里的结果又决定要不要起表 —— 用户只勾了显存、
      // 后端又暂时没这项数据时，会算出「没有指标」→ 不起表 → 快照永远冻着，
      // 形成二级死锁（比 enabled 那个更隐蔽，因为它要特定勾选组合才触发）。
      // 所以这里只看开关，代表「用户想要指标」；界面真有几行由下面 rows 的
      // push 条件决定（那里仍然用 gpuHasMemory / gpuHasTemperature 判断）。
      // 代价：只勾显存而后端没有时，界面空着但仍会发请求 —— 这是必要的，
      // 因为后端可能下一轮就给出来了（例如 nvidia-smi 恢复）。
      const anyMetric = settings.showCpu || settings.showMemory || settings.showGpu
        || settings.showGpuMemory || settings.showGpuTemperature
      const [open, setOpen] = React.useState(false)
      const [writeFailed, setWriteFailed] = React.useState(false)
      const expanded = open && enabled
      // 仿宿主 ContextMeter：rootRef 只包 trigger，面板走 portal 渲到 body，
      // 所以外部点击判定要把 panelRef 也算进来，否则点面板自己就会收起。
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const position = useAnchorPosition({
        open: expanded,
        anchorRef: rootRef,
        panelRef,
        side: 'top',
        align: 'end',
        gap: 8,
        margin: 12
      })
      useDismissOnOutside(rootRef, expanded, setOpen, panelRef)

      // 挂载/卸载管表在不在。`anyMetric` 也要参与：三项全关时界面已经空了，
      // 再按 1.5~10 秒打一次请求纯属白耗电（README 承诺过这种时候不发请求）。
      React.useEffect(() => {
        if (!enabled || !anyMetric) return undefined
        startVitals(period)
        return () => releaseVitals()
      }, [enabled, anyMetric])

      // 间隔变化只管节拍。
      React.useEffect(() => {
        if (enabled && anyMetric) retimeVitals(period)
      }, [enabled, anyMetric, period])

      // 展开前预热一次采样；Escape 收起（与宿主一致）。
      React.useEffect(() => {
        if (!expanded) return undefined
        ensureVitals()
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [expanded])

      // 指标不可用/被关掉时收起面板，避免面板挂在已消失的锚点旁。
      React.useEffect(() => {
        if (!enabled && open) setOpen(false)
      }, [enabled, open])

      if (!enabled) return null

      const rows = []
      if (settings.showCpu) {
        rows.push({
          key: 'cpu',
          name: t('panel.cpu'),
          value: snapshot === null ? t('badge.sampling') : formatPercent(snapshot.cpu?.percent),
          detail: snapshot === null ? null : t('unit.cores', { count: snapshot.cpu?.cores ?? '—' })
        })
      }
      if (settings.showMemory) {
        rows.push({
          key: 'memory',
          name: t('panel.memory'),
          value: snapshot === null ? t('badge.sampling') : formatPercent(snapshot.memory?.usedPercent),
          detail: snapshot === null ? null : `${formatNumber(snapshot.memory?.usedGiB)} / ${formatNumber(snapshot.memory?.totalGiB)} GB`
        })
      }
      if (settings.showGpu) {
        rows.push({
          key: 'gpu',
          name: t('panel.gpu'),
          value: snapshot === null ? t('badge.sampling') : (gpuAvailable(snapshot) ? formatPercent(snapshot.gpu.utilPercent) : '—'),
          detail: snapshot === null ? null : (gpuAvailable(snapshot) ? gpuLabel(snapshot, t) : (snapshot.gpuError ?? t('badge.sampling')))
        })
      }
      // 显存 / 温度：不仅要后端活着，还得它真给了这一项（PDH 就没有）。
      if (settings.showGpuMemory && gpuHasMemory(snapshot)) {
        rows.push({
          key: 'vram',
          name: t('panel.vram'),
          value: `${formatNumber(snapshot.gpu.memoryUsedMiB / 1024)} GB`,
          detail: hasNumber(snapshot.gpu.memoryTotalMiB)
            ? t('unit.ofTotal', { size: formatNumber(snapshot.gpu.memoryTotalMiB / 1024) })
            : null
        })
      }
      if (settings.showGpuTemperature && gpuHasTemperature(snapshot)) {
        rows.push({
          key: 'temp',
          name: t('panel.temp'),
          value: formatTemperature(snapshot.gpu.temperatureC),
          detail: null
        })
      }
      if (rows.length === 0) return null

      const title = buildTooltip(state, t)

      // 徽章本体：仿宿主 ContextMeter 的 trigger —— 一个可以点的 button，
      // 文案只留「标签 + 数值」，不写「占用」二字。
      const trigger = h('button', {
        type: 'button',
        className: 'dshDockVitals',
        'aria-expanded': expanded ? 'true' : 'false',
        'aria-haspopup': 'dialog',
        title,
        onClick: () => setOpen(!open)
      }, rows.map((row) => h('span', { className: 'dshDockVitalsMetric', key: row.key },
        h('span', { className: 'dshDockVitalsKey' }, row.name),
        h('span', { className: 'dshDockVitalsValue' }, row.value)
      )))

      const writeInterval = (next) => {
        if (!config.writable) return
        config.set('intervalMs', next, () => setWriteFailed(true))
      }

      /** 面板 DOM：portal 与降级内联两种模式共用，只是外层 props 不同。 */
      const buildPanel = (extra) => h('div', Object.assign({
        className: 'dshDockVitalsPanel',
        role: 'dialog',
        'aria-label': t('section.title')
      }, extra),
        h('div', { className: 'dshDockVitalsPanelTitle' }, t('section.title')),
        rows.map((row) => h('div', { className: 'dshDockVitalsPanelRow', key: row.key },
          h('span', { className: 'dshDockVitalsPanelName' }, `${row.name}${t('label.colon')}`),
          row.detail === null ? null : h(DetailText, {
            className: 'dshDockVitalsPanelDetail',
            text: row.detail
          }),
          h('span', { className: 'dshDockVitalsPanelValue' }, row.value)
        )),
        h('div', { className: 'dshDockVitalsPanelRow' },
          h('span', { className: 'dshDockVitalsPanelName' }, `${t('panel.interval')}${t('label.colon')}`),
          h('span', { className: 'dshDockVitalsSpeeds' },
            SPEEDS.map((speed) => h('button', {
              type: 'button',
              key: speed.value,
              className: period === speed.value ? 'dshDockVitalsSpeed isActive' : 'dshDockVitalsSpeed',
              // ⚠️ 这里仍然只在 `writable` 时才放行：宿主在 loading 期间
              // revision 还是 undefined，此时提交写入走的是「没有版本号」的
              // 竞态路径，宁可先拦一下。差别只在**提示语**：说「加载中」是真的，
              // 说「本连接无法写入」是假的（见 useSettingsWritable 的注释）。
              disabled: !config.writable,
              onClick: () => writeInterval(speed.value)
            }, t(speed.key)))
          )
        ),
        config.writable || config.pending
          ? null
          : h('div', { className: 'dshDockVitalsPanelNote' }, t('section.readonly')),
        config.pending && !writeFailed
          ? h('div', { className: 'dshDockVitalsPanelNote' }, t('section.loading'))
          : null,
        writeFailed ? h('div', { className: 'dshDockVitalsPanelNote' }, t('section.writeFailed')) : null,
        !gpuAvailable(snapshot) && snapshot?.gpuError != null
          ? h('div', { className: 'dshDockVitalsPanelNote' }, t('section.gpuMissing'))
          : null,
        // 后端活着但给不了这两项（Windows 的 PDH 就是）：开了开关却没显示，得说清为什么。
        gpuAvailable(snapshot) && ((settings.showGpuMemory && !gpuHasMemory(snapshot)) || (settings.showGpuTemperature && !gpuHasTemperature(snapshot)))
          ? h('div', { className: 'dshDockVitalsPanelNote' }, t('section.gpuPartial'))
          : null
      )

      // 浮层：**完全照抄宿主** —— portal 渲到 body、`position:fixed`、
      // 首帧量不到位置时先 `visibility:hidden`，量好了再给 {left, top}。
      // 拿不到 react-dom 时降级：内联渲染，靠 `.dshDockVitalsPanel.isInline` 兜住。
      let panel = null
      if (expanded) {
        if (typeof createPortal === 'function' && typeof document !== 'undefined' && document.body !== null) {
          panel = createPortal(
            buildPanel({
              ref: panelRef,
              style: position === null
                ? { visibility: 'hidden', left: 0, top: 0 }
                : { left: `${position.left}px`, top: `${position.top}px` }
            }),
            document.body
          )
        } else {
          panel = buildPanel({ ref: panelRef, className: 'dshDockVitalsPanel isInline' })
        }
      }

      // ⚠️ 收起态与展开态**必须是同一个根元素结构**：顺序完全由这个根上的
      // `order` 决定（见 CSS），换了结构就会掉回左边。
      return h('span', { ref: rootRef, className: 'dshDockVitalsWrap' }, trigger, panel)
    }

    /**
     * 行内「具体信息」文本（GPU 型号 / 核数 / 容量）。
     *
     * 面板宽度锁死 264px（与宿主 ContextMeter 一致），长型号必然吃省略号。
     * 这里**只在真的被截断了**才挂气泡：鼠标移上去看全文，没截断就不弹，
     * 免得无缘无故挡视线。判据 `scrollWidth > clientWidth + 1` —— 省略号生效时
     * 二者必然不等（+1 是给亚像素取整留的余量）。
     *
     * 气泡用宿主自己的 `Tooltip`（跟「上下文」等三个状态项同款），**不用原生 title**：
     * 原生 title 要悬停 1~2 秒才弹、样式还改不了，老板反馈过「悬停没作用」。
     * 拿不到宿主 Tooltip 时才退回原生 title（有总比没有强）。
     */
    function DetailText(props) {
      const ref = React.useRef(null)
      const [truncated, setTruncated] = React.useState(false)

      React.useEffect(function () {
        const node = ref.current
        if (node === null || node === undefined) return
        try {
          setTruncated(node.scrollWidth > node.clientWidth + 1)
        } catch (error) {
          setTruncated(false)
        }
      }, [props.text])

      const node = h('span', {
        ref,
        className: props.className,
        // 只有在拿不到宿主 Tooltip 时才退回原生 title —— 它有 1~2 秒延迟，是下策。
        title: !hasHostTooltip && truncated ? props.text : undefined
      }, props.text)

      // 没被截断就不挂气泡：省得鼠标划过时乱弹，挡着下面的行。
      if (!hasHostTooltip || !truncated) return node

      // `portal: true` 让气泡渲到 body —— 面板自带 `backdrop-filter` 与 `position:fixed`，
      // 气泡留在面板里会被这层层叠上下文压住。Tooltip 会转发（并保留）我们的 ref。
      return h(HostTooltip, {
        label: props.text,
        side: 'top',
        align: 'end',
        delayMs: TOOLTIP_DELAY_MS,
        gap: 8,
        portal: true
      }, node)
    }

    function metric(key, name, value, suffix) {
      return h('span', { className: 'dshDockVitalsMetric', key },
        h('span', { className: 'dshDockVitalsKey' }, name),
        h('span', { className: 'dshDockVitalsValue' }, value),
        suffix === null ? null : h('span', { className: 'dshDockVitalsSuffix' }, suffix)
      )
    }

    function buildTooltip(state, t) {
      const snapshot = state.snapshot
      if (snapshot === null) {
        return state.error === null ? t('badge.sampling') : `${t('badge.samplingFailed')}${t('label.colon')}${state.error}`
      }
      const lines = [
        t('badge.tooltipCpu', {
          percent: formatPercent(snapshot.cpu?.percent),
          cores: t('unit.cores', { count: snapshot.cpu?.cores ?? '—' })
        }),
        t('badge.tooltipMemory', {
          percent: formatPercent(snapshot.memory?.usedPercent),
          used: formatNumber(snapshot.memory?.usedGiB),
          total: formatNumber(snapshot.memory?.totalGiB)
        })
      ]
      if (gpuAvailable(snapshot)) {
        // 各后端能给的字段不同（PDH 没有显存/温度），只拼真有的那几段。
        const parts = [t('badge.tooltipGpu', { percent: formatPercent(snapshot.gpu.utilPercent) })]
        if (gpuHasMemory(snapshot)) {
          parts.push(hasNumber(snapshot.gpu.memoryTotalMiB)
            ? t('badge.tooltipVram', {
              used: formatNumber(snapshot.gpu.memoryUsedMiB / 1024),
              total: formatNumber(snapshot.gpu.memoryTotalMiB / 1024)
            })
            : t('badge.tooltipVramUsed', { used: formatNumber(snapshot.gpu.memoryUsedMiB / 1024) }))
        }
        if (gpuHasTemperature(snapshot)) parts.push(formatTemperature(snapshot.gpu.temperatureC))
        lines.push(parts.join(' · '))
      } else {
        lines.push(`${t('badge.tooltipGpuMissing')}${t('label.colon')}${snapshot.gpuError ?? t('label.unknownReason')}`)
      }
      return lines.join('\n')
    }

    /**
     * 设置写入通道（可选）。`configForms` 由 `dsh-client-ui-settings` 提供，
     * 可能被禁用；所以这里做成惰性 + 全程 try/catch：拿不到就只读，徽章照常显示。
     */
    let settingsChannel = null
    let settingsChannelTried = false
    /**
     * 「配置通道就绪」的订阅者。`ConfigFormController` 可能在徽章首帧之后才注入
     * （`ctx.inject(['configForms'], ...)` 要等服务就绪才回调），而 settingsChannel
     * 是模块级变量、不是 React 状态 —— 光靠它变，徽章不会重渲染。所以通道建立后
     * 要主动通知一次，让 `useDockConfig` 的 getSnapshot 重新取值。
     */
    const configListeners = new Set()

    function acquireSettingsChannel(ctx) {
      if (settingsChannelTried) return settingsChannel
      settingsChannelTried = true
      try {
        ctx.inject(['configForms'], (child) => {
          settingsChannel = { form: child.configForms.get(SETTINGS_NAMESPACE) }
          // 通知等通道的订阅者（见 configListeners 注释）。
          for (const listener of [...configListeners]) {
            try {
              listener()
            } catch (error) {
              console.warn('[dsh-dock-vitals] config listener failed:', error)
            }
          }
        })
      } catch (error) {
        console.warn('[dsh-dock-vitals] settings channel unavailable:', error)
      }
      return settingsChannel
    }

    /**
     * 宿主写入的成败是用**返回值**表达的，不是抛异常：
     * `set(field, value)` → `mutate([...])` → `enqueue(...)`，
     * 持久化方式是 memory 时直接 `Promise.resolve(false)`，
     * 上游拒绝时 `return false`，只有真出错才抛。
     *
     * ⚠️ 所以光包 try/catch 是不够的 —— 失败会**静默消失**，用户看到的是
     * 「点了一下，开关自己弹回去，控制台一声不吭」。这里把两种失败都收敛到
     * 同一个回调上，让界面有机会说一句「没写进去」。
     */
    function reportWrite(result, onFailure) {
      if (result === false) {
        onFailure()
        return
      }
      if (result !== null && result !== undefined && typeof result.then === 'function') {
        result.then((accepted) => {
          if (accepted === false) onFailure()
        }, () => onFailure())
      }
    }

    /**
     * 徽章可写性（可选）。暴露给 `useSyncExternalStore` 的是**三种状态之一**：
     * `'ready'` / `'loading'` / `'unavailable'`。
     *
     * ⚠️ 三个字符串是原始值，比较天然稳定 —— 绝不能返回每次新建的对象，
     * React 拿 getSnapshot 的返回值做 `Object.is` 比较，新引用会被判定成
     * 「快照一直在变」→ 无限重渲染 → 组件崩掉、徽章消失。
     *
     * ⚠️ 也**不能把 loading 和 unavailable 合并成一个布尔**：宿主
     * `ConfigFormController` 初始 status 就是 `'loading'`，要等 mirror 首个响应
     * 到达、`derive()` 解码成功才置 `'ready'`，这是真实存在、可能持续几百毫秒的
     * 中间态。合并的后果是面板第一帧就把三档按钮画成灰的、还弹一句「当前连接
     * 无法写入设置」——**这句话是假的**，半秒后按钮自己又亮了，用户会以为坏了。
     */
    function useSettingsWritable() {
      const subscribe = useCallback((listener) => {
        if (settingsChannel === null) return () => {}
        try {
          const off = settingsChannel.form.subscribe(listener)
          return typeof off === 'function' ? off : () => {}
        } catch (error) {
          console.warn('[dsh-dock-vitals] settings subscribe failed:', error)
          return () => {}
        }
      }, [])
      const getSnapshot = useCallback(() => {
        if (settingsChannel === null) return 'unavailable'
        try {
          const snapshot = settingsChannel.form.getSnapshot()
          if (snapshot.writable !== true) return 'unavailable'
          return snapshot.status === 'ready' ? 'ready' : 'loading'
        } catch (error) {
          return 'unavailable'
        }
      }, [])
      const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const writable = state === 'ready'
      const pending = state === 'loading'
      const set = useCallback((field, next, onFailure) => {
        if (settingsChannel === null) return
        try {
          reportWrite(settingsChannel.form.set(field, next), onFailure)
        } catch (error) {
          console.warn('[dsh-dock-vitals] settings write failed:', error)
          if (typeof onFailure === 'function') onFailure()
        }
      }, [])
      return { writable, pending, set }
    }

    /**
     * 徽章读的**实时配置**。与 `useSettingsWritable` 共用同一个 form，但各开一路订阅
     * （两边 subscribe 相互独立，谁都不影响谁）。
     *
     * ⚠️ getSnapshot 必须返回**引用稳定**的值：宿主的 `derive()` 只在远端响应到达时
     * 才换新对象，平时同一个 `snapshot.value` 原样返回，可以直接交给
     * useSyncExternalStore；一旦这里每次 new 一个对象，React 拿 `Object.is` 一比对
     * 发现「快照一直在变」→ 无限重渲染 → 徽章直接消失。
     *
     * 通道没就绪 / 还在 loading / 字段缺失时一律返回 `null`（原始值，天然稳定），
     * 由调用方退回 host 快照解析。
     */
    function useDockConfig() {
      const subscribe = useCallback((listener) => {
        configListeners.add(listener)
        let off = () => {}
        if (settingsChannel !== null) {
          try {
            const raw = settingsChannel.form.subscribe(listener)
            if (typeof raw === 'function') off = raw
          } catch (error) {
            console.warn('[dsh-dock-vitals] config subscribe failed:', error)
          }
        }
        return () => {
          configListeners.delete(listener)
          off()
        }
      }, [])
      const getSnapshot = useCallback(() => {
        if (settingsChannel === null) return null
        try {
          const snapshot = settingsChannel.form.getSnapshot()
          if (snapshot.status !== 'ready') return null
          if (snapshot.value === undefined || snapshot.value === null) return null
          return snapshot.value
        } catch (error) {
          return null
        }
      }, [])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    // ── 设置页组件 ────────────────────────────────────────────────────────────

    function Toggle(props) {
      return h('label', { className: 'dshDockVitalsRow' },
        h('span', { className: 'dshDockVitalsLabel' }, props.label),
        h('input', {
          type: 'checkbox',
          role: 'switch',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked === true)
        })
      )
    }

    function SettingsSection(props) {
      const t = props.t
      const config = props.config
      const form = props.form
      const state = useSyncExternalStore(subscribeVitals, vitalsSnapshot, vitalsSnapshot)
      const snapshot = state.snapshot
      const value = config.value
      /**
       * 写入被宿主拒绝时（上游 `ok:false`、revision 冲突、连接退化成 memory），
       * 宿主是用**返回 false** 表达失败的，不抛异常 —— 所以光 try/catch 什么也看不见，
       * 用户只会看到开关自己弹回去。这里留一个状态位，好在界面上说一句。
       */
      const [writeFailed, setWriteFailed] = React.useState(false)
      /**
       * ⚠️ 必须 `form.set(...)` 这样调用，不能把方法摘下来赋给变量。
       * 宿主 `ConfigFormController.set(field, value)` 内部第一句就是 `this.mutate(...)`，
       * 一旦脱离接收者，`this` 变成 undefined，抛
       * `TypeError: Cannot read properties of undefined (reading 'mutate')`。
       * 这里再包一层 try/catch，写失败时最多是这一次点击不生效 + 一条警告，
       * 不会冒泡出去把整个设置面板炸掉。
       */
      const set = useCallback((field, next) => {
        if (typeof form.set !== 'function') return
        try {
          reportWrite(form.set(field, next), () => setWriteFailed(true))
        } catch (error) {
          console.warn('[dsh-dock-vitals] settings write failed:', error)
          setWriteFailed(true)
        }
      }, [form])
      const gpuOff = value.showGpu === false

      return h('div', { className: 'dshDockVitalsSection' },
        h('div', { className: 'dshDockVitalsTitle' }, t('section.title')),
        h('div', { className: 'dshDockVitalsDesc' }, t('section.desc')),
        h('div', { className: 'dshDockVitalsRows' },
          Toggle({ label: t('field.enabled'), checked: value.enabled, onChange: (v) => set('enabled', v), disabled: !config.writable }),
          Toggle({ label: t('field.showCpu'), checked: value.showCpu, onChange: (v) => set('showCpu', v), disabled: !config.writable }),
          Toggle({ label: t('field.showMemory'), checked: value.showMemory, onChange: (v) => set('showMemory', v), disabled: !config.writable }),
          Toggle({ label: t('field.showGpu'), checked: value.showGpu, onChange: (v) => set('showGpu', v), disabled: !config.writable }),
          Toggle({ label: t('field.showGpuMemory'), checked: value.showGpuMemory, onChange: (v) => set('showGpuMemory', v), disabled: !config.writable || gpuOff }),
          Toggle({ label: t('field.showGpuTemperature'), checked: value.showGpuTemperature, onChange: (v) => set('showGpuTemperature', v), disabled: !config.writable || gpuOff }),
          h('div', { className: 'dshDockVitalsRow' },
            h('span', { className: 'dshDockVitalsLabel' }, t('field.intervalMs')),
            h('span', { className: 'dshDockVitalsSpeeds' },
              SPEEDS.map((speed) => h('button', {
                type: 'button',
                key: speed.value,
                className: clampPeriod(value.intervalMs) === speed.value ? 'dshDockVitalsSpeed isActive' : 'dshDockVitalsSpeed',
                disabled: !config.writable,
                onClick: () => set('intervalMs', speed.value)
              }, t(speed.key)))
            )
          )
        ),
        h('div', { className: 'dshDockVitalsNote' }, t('field.intervalHint')),
        config.writable || config.pending
          ? null
          : h('div', { className: 'dshDockVitalsNote' }, t('section.readonly')),
        config.pending && !writeFailed
          ? h('div', { className: 'dshDockVitalsNote' }, t('section.loading'))
          : null,
        writeFailed ? h('div', { className: 'dshDockVitalsNote' }, t('section.writeFailed')) : null,
        h('div', { className: 'dshDockVitalsNote' }, t('section.preview', {
          cpu: formatPercent(snapshot?.cpu?.percent),
          memory: formatPercent(snapshot?.memory?.usedPercent),
          gpu: gpuAvailable(snapshot) ? formatPercent(snapshot.gpu.utilPercent) : '—'
        })),
        snapshot !== null && !gpuAvailable(snapshot) && snapshot.gpuError !== undefined && snapshot.gpuError !== null
          ? h('div', { className: 'dshDockVitalsNote' }, t('section.gpuMissing'))
          : null,
        snapshot !== null && gpuAvailable(snapshot) && ((value.showGpuMemory && !gpuHasMemory(snapshot)) || (value.showGpuTemperature && !gpuHasTemperature(snapshot)))
          ? h('div', { className: 'dshDockVitalsNote' }, t('section.gpuPartial'))
          : null
      )
    }

    // ── 样式 ──────────────────────────────────────────────────────────────────

    const CSS = `
.dshDockVitalsSection { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
.dshDockVitalsTitle { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dshDockVitalsDesc { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary); }
.dshDockVitalsRows { display: flex; flex-direction: column; gap: 12px; }
.dshDockVitalsRow { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dshDockVitalsLabel { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshDockVitalsNote { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-dimmed); }
/* 徽章本体：形态照抄宿主 ContextMeter 的 trigger —— 胶囊按钮、内边距 1px 8px、
   hover / 展开时给一层 hover 底色。 */
.dshDockVitals {
  box-sizing: border-box;
  corner-shape: round;
  font-family: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  font-variant-numeric: tabular-nums;
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  background: 0 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  display: inline-flex;
  cursor: pointer;
}
.dshDockVitals:hover,
.dshDockVitals[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dshDockVitals:focus-visible {
  outline: 1px solid var(--dsw-alias-button-info-fill);
  outline-offset: 3px;
}
.dshDockVitalsMetric { display: inline-flex; align-items: baseline; gap: 4px; }
.dshDockVitalsKey {
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--dsw-alias-label-tertiary);
}
.dshDockVitalsValue {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.dshDockVitals:hover .dshDockVitalsValue,
.dshDockVitals[aria-expanded='true'] .dshDockVitalsValue {
  color: var(--dsw-alias-label-primary);
}
.dshDockVitalsSuffix { font-size: 10px; color: var(--dsw-alias-label-dimmed); }

/* 排到「上下文」右侧：.dock 是 flex + justify-content:center，容器没有剩余空间，
   margin-left:auto 推不动；槽位 wrapper 又是 display:contents，所以顺序完全由
   这里根元素的 order 决定（宿主硬编码的 ContextMeter 是 order:0）。 */
.dshDockVitalsWrap { order: 1; position: relative; display: inline-flex; flex: none; }

/* 详情面板：样式对齐宿主 ContextMeter 的 panel —— position:fixed + portal 到 body，
   首帧量不到位置时先隐藏（由 JS 给 visibility:hidden）。 */
.dshDockVitalsPanel {
  z-index: 1100;
  box-sizing: border-box;
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 与宿主 ContextMeter 面板同宽（264px）。型号这类长文本不去撑宽面板 ——
     按省略号截断，鼠标移上去看全文（title + 宿主 Tooltip 双保险）。 */
  width: min(264px, 100vw - 24px);
  padding: 12px;
  border: 0;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  font-size: 12px;
  line-height: 20px;
  text-align: left;
  animation: dshDockVitalsPanelIn 120ms ease-out;
}
@keyframes dshDockVitalsPanelIn {
  from { opacity: 0; transform: translateY(2px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .dshDockVitalsPanel { animation: none; }
}
/* 降级模式：拿不到 react-dom 时面板内联渲染，退回相对锚点的绝对定位。 */
.dshDockVitalsPanel.isInline {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  width: auto;
}
.dshDockVitalsPanelTitle {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
/* 一行 = 「名称：」+ 具体信息（型号 / 核数 / 容量）+ 百分比。
   名称与具体信息贴左侧、各自不换行，百分比靠 margin-left:auto 顶到最右；
   具体信息过长时省略号截断（完整值在 title 里）。 */
.dshDockVitalsPanelRow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.dshDockVitalsPanelName {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dshDockVitalsPanelDetail {
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dshDockVitalsPanelValue {
  flex: none;
  margin-left: auto;
  padding-left: 8px;
  color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.dshDockVitalsPanelNote { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* 档位：三个小胶囊，整组顶到最右。 */
.dshDockVitalsSpeeds { display: inline-flex; flex: none; gap: 4px; margin-left: auto; }
.dshDockVitalsSpeed {
  appearance: none;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
}
.dshDockVitalsSpeed:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDockVitalsSpeed.isActive {
  border-color: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-label-primary-bluish);
}
.dshDockVitalsSpeed:disabled { opacity: 0.5; cursor: not-allowed; }
`

    function ensureStyle() {
      if (typeof document === 'undefined' || document.head === undefined) return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
    }

    // ── 组装 ──────────────────────────────────────────────────────────────────

    return {
      // ⚠️ 只依赖 `slots`（核心服务，永远在）。**绝不能把 `configForms` 写进 inject**：
      // 它由 `dsh-client-ui-settings` 提供，而那个插件可以被配置禁用；一旦不可用，
      // 本 entry 就会永远停在 `pending`，而 DSH 前端 web boot 对 pending 同样 fail-closed
      // —— 整个桌面版又会打不开。所以设置能力改成 apply 里条件挂载。
      inject: ['slots'],

      apply: function apply(ctx) {
        // ⚠️ 铁律：**slot 注册必须是 apply 的第一件事**。
        // 曾经把它放在语言订阅后面，结果语言那行抛错 → 被 apply 的整体 try/catch 吞掉
        // → 徽章永远注册不上，而且**控制台什么都不打**（症状：插件活着、接口 200、界面没反应）。
        // 现在注册放在最前且零依赖，语言/样式/诊断各自独立兜底，谁炸都不影响徽章。
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: DOCK_ID,
          order: 40
        }, DockBadge))

        // 设置分区是可选增强：只有在 configForms 可用时才挂，
        // 拿不到就只是没有设置页，徽章照常工作、启动不受影响。
        try {
          ctx.inject(['configForms'], (child) => {
            const form = child.configForms.get(SETTINGS_NAMESPACE)
            acquireSettingsChannel(ctx)
            const Section = () => h(SettingsSection, { t: useT(), config: useConfig(form), form })
            child.slots.inject('settings.section', () => child.slots.register({
              name: 'settings.section',
              id: SECTION_ID,
              order: 60,
              label: () => translate('section.nav')
            }, Section))
          })
        } catch (error) {
          console.warn('[dsh-dock-vitals] settings section skipped:', error)
        }

        // 以下全部独立兜底：任何一步坏掉都只降级，绝不影响已经注册好的徽章。
        try { ensureStyle() } catch (error) {
          console.warn('[dsh-dock-vitals] style skipped:', error)
        }

        try {
          // 订阅宿主语言。这里只是普通函数调用（不是 hook），apply 里做是安全的。
          const hostLocale = ctx.locale
          if (hostLocale != null && typeof hostLocale.subscribe === 'function') {
            const syncLocale = () => {
              try {
                setLocale(hostLocale.getSnapshot?.().active)
              } catch {
                /* 语言读不到就保持中文 */
              }
            }
            ctx.effect(() => hostLocale.subscribe(syncLocale), 'dsh-dock-vitals: locale watch')
            syncLocale()
          }
        } catch (error) {
          console.warn('[dsh-dock-vitals] locale watch skipped:', error)
        }

        try {
          // 诊断探针：把「组件真的渲染了吗」打到控制台。
          // 如果 console 里只有 dock-vitals registered、没有 badge rendered，
          // 说明 slot 挂上了但宿主没渲染它（渲染条件/顺序问题）；
          // 两者都没有，说明 apply 没跑（装载/加载问题）。
          const probe = () => console.info('[dsh-dock-vitals] badge rendered, snapshot =', vitalsSnapshot())
          ctx.effect(() => {
            const off = subscribeVitals(probe)
            probe()
            return off
          }, 'dsh-dock-vitals: render probe')
        } catch (error) {
          console.warn('[dsh-dock-vitals] render probe skipped:', error)
        }

        console.info('[dsh-dock-vitals] apply ok: dock slot registered, data url =', DATA_URL)
      }
    }
  }
})
