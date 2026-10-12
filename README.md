# dsh-dock-vitals

Live **CPU / memory / GPU** readout in the DeepSeek Harness composer status bar — a small clickable badge next to the built-in context meter.

```
2 turns 30 steps · 98 tok/s │ 1.8M tok · cache 84% │ 6%
CPU 13%  MEM 87%  GPU 15%
                ↑ this plugin's badge, right of the context meter
```

- **Display-only plugin.** It registers no tools for the model. Samples never enter the conversation context and are never sent anywhere.
- Three metrics out of the box — **CPU / memory / GPU**; video memory and GPU temperature are one toggle away in settings.
- GPU works across vendors, no admin rights: `nvidia-smi`, `rocm-smi`, macOS `ioreg`, and Windows PDH counters as the catch-all. Whichever backend answers is named in the snapshot, and a backend that cannot report a field leaves it blank instead of printing `0`.
- Click the badge for a details panel: per-metric values, GPU model, core count and capacity.
- Three refresh presets: **fast 1.5 s / medium 3 s / slow 10 s** (default `3000 ms`).
- Opening ten sessions still samples once — every badge shares one snapshot and one timer.
- Sampling stops on its own 15 seconds after the last reader.
- Follows the host language (Chinese / English), including the details panel and tooltips.

## Install

```bash
dsh plugin --profile <profile> add dsh-dock-vitals
```

Or drop the tarball in:

```bash
dsh plugin --profile <profile> add ./dsh-dock-vitals-0.1.0.tgz
```

Restart DSH afterwards.

## Data sources

| Metric | Source | Notes |
| --- | --- | --- |
| CPU | Node `os.cpus()` sampled twice | Machine-wide busy percentage (`1 - Δidle/Δtotal`), not per-core. The first sample has no baseline and reads empty. |
| Memory | `os.totalmem()` / `os.freemem()` | |
| GPU | A vendor CLI, probed per platform (see below) | When nothing answers, GPU shows `—` while CPU and memory keep working. |

GPU backends, tried in this order on each platform — the first that answers wins, and the winner is remembered so later ticks skip the dead ones:

| Platform | Backend | Command | Permission | Video memory / temperature |
| --- | --- | --- | --- | --- |
| Windows / Linux, NVIDIA | `nvidia-smi` | `--query-gpu=... --format=csv,noheader,nounits` | none | both |
| Windows, any vendor | PDH counters via `typeperf` | `"\GPU Engine(*)\Utilization Percentage" -sc 2 -si 1` | none | **neither** |
| Linux, AMD | `rocm-smi` | `-u --showmemuse --showmeminfo vram -t --showtemp --showproductname --csv` | none | both |
| macOS, any GPU | `ioreg` (IOKit registry) | `-r -d 1 -w 0 -c IOAccelerator` | **none** | used only (no total) |

`typeperf` is the only way to read a GPU on Windows for AMD/Intel — ROCm is Linux-only — so it is worth knowing its cost: **one round takes ~2.7 s**, where `nvidia-smi` takes ~50 ms. That is why GPU sampling is decoupled from the badge refresh rate: CPU and memory keep their own cadence, and the GPU value is served from the last completed reading.

Aggregation follows Task Manager: sum each process per engine type, then take the **busiest engine type** per adapter, then the busiest adapter. Summing every instance together over-reports, and reading only the 3D engine misses video encode/decode load entirely.

A field the active backend cannot report is `null` in the snapshot, never `0` — a missing temperature and a 0 °C temperature are different things. The details panel hides those rows rather than printing a made-up number.

The host side exposes one read-only endpoint:

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

`gpuBackend` names the backend that produced the reading, so "why is my GPU blank / missing a temperature" is answerable from the payload itself. Non-loopback callers get `403`; anything but `GET`/`HEAD` gets `405`.

## Settings

Settings → **System Status**:

| Option | Default | Notes |
| --- | --- | --- |
| Enable badge | on | Off means the badge never renders and never fetches |
| CPU | on | |
| Memory | on | |
| GPU | on | |
| Video memory | off | Unavailable while GPU is off |
| GPU temperature | off | Same |
| Refresh interval | 3000 ms | 1500 – 60000 ms |

Every field is `volatile`, so changes apply immediately without a restart. Configuration lives in the settings namespace `dock-vitals` — the `id` of the plugin's entry in your profile.

## Compatibility

- dsh `>=0.2.0-rc.1` (developed and verified on `0.2.0-rc.2`).
- Node `>=22`.
- Windows / macOS / Linux. CPU and memory come from Node's `os`; the GPU backends are read-only CLIs and registry reads (`nvidia-smi`, `typeperf`, `rocm-smi`, `ioreg`). Nothing needs administrator rights — this deliberately avoids `powermetrics`, which is macOS's richest GPU source but requires `sudo` on every call.
- Works in both the desktop app and the browser GUI: `dsh.client.platform` is `web`, and the desktop app is a shell around the same web frontend.

## Development notes

- Client components may only `require` modules from the host whitelist (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`). Anything else fails to resolve, and a throwing `require` kills the factory → the entry fails → the desktop build refuses to open. **Wrap every `require` in `try/catch` and ship a fallback.**
- Never call a hook inside `apply()`. `useSyncExternalStore`'s `getSnapshot` must return a **stable reference** — an object rebuilt on every call causes an infinite re-render loop.
- Styles use `--dsw-*` theme tokens only; literal colours are reserved for graphics.
- UI is contributed through `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`.

## License

MIT
