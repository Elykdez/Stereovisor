# Stereovisor

**Put a camera inside your photograph.**

![Stereovisor turning a photograph into a moving 2.5D scene](docs/demo.gif)

(Demo poster is GTA VI by Rockstar Games) 

A photo is flat. Stereovisor gives it depth: it finds the objects in the frame, cuts them out, works out how far away each one sits, paints back the background that was hiding behind them, and hands you a scene you can move through.

All local, nothing leaves your machine.

## How It Works

1. **Drop an image.** PNG, JPEG, or WebP.
2. **It proposes layers.** An open-vocabulary detector finds the subjects, a segmenter cuts each one out, and a depth model orders them front to back.
3. **You decide.** Keep a layer, drop it, merge two, brush in one the detector missed, rename it, tighten its edge. The model's answer is a starting point, not a verdict.
4. **It rebuilds the background.** Your selected cutouts are joined into a single removal mask, expanded past the edge contamination, and inpainted, so the space behind the foreground is no longer a hole.
5. **You move the camera.** Drag the stage. Near layers travel further than far ones, the lens pulls focus from scene depth, and it stays interactive because no model runs per frame.

## What You Get Out

- **PNG** of the current composite at source resolution.
- **MP4** of a four-second parallax move, encoded by Electron's bundled Chromium encoder. No FFmpeg anywhere.
- **`.stereovisor` project** - a portable package holding every processed asset plus the exact editor state. Reopen it later and everything is where you left it.

## Quick Start

**Windows** - double-click `Run Stereovisor.cmd`.

**Apple Silicon macOS** - double-click `Run Stereovisor.command`.

The first launch shows a preparation screen while it installs the local AI runtime and downloads model weights. Later launches go straight to the editor.

Just looking around? `Run Stereovisor Preview.cmd` / `.command` starts a lightweight sample-only engine that downloads no weights at all.

## Principles

- **Local by default.** Source images and generated assets stay on your machine. The service has no cloud-provider adapter; the network is used only to acquire model weights.
- **Inspectable.** Every stage reports its model, device, progress, and VRAM peak. Preview processing is never presented as AI processing.
- **Modest hardware.** GPU stages load one at a time and are released before the next, inside an 8 GB VRAM budget.

## Documentation

| Where | What |
| --- | --- |
| [`client/docs`](client/docs/README.md) | Renderer, Electron host, compositor, exports, localization, settings, packaging |
| [`service/docs`](service/docs/README.md) | Local AI service, HTTP API, job queue, model stack, setup, LAN access |
| [`docs/SRS.md`](docs/SRS.md) | Product contract: what it must do |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Implementation design: how it does it |

## Architecture

- `client/` - React renderer, Electron host, static assets, tests, build config.
- `service/` - Python API and pipeline, service tests, requirements, model cache.
- `scripts/` - launch, setup, and smoke-test orchestration across both sides.
- `docs/` - product and design documents that span both sides.

## Verification

```powershell
npm run check
```

Version sync, localization sync, type checks, renderer tests, Python service
tests, and a production build.

## Versioning

The client and the service carry independent semver, both declared in
[`versions.json`](versions.json):

```powershell
npm run version:bump client minor
npm run version:set service 1.2.0
```

A bump rewrites the `version` field in `package.json` and regenerates
`service/src/_version.py`. `npm run check` fails if either output is stale, the
same way it fails on stale locales. Releases are tagged per component as
`client-vX.Y.Z` and `service-vX.Y.Z`.

## Attribution

- [Elykdez](https://github.com/Elykdez) - Designer and director.

- **OpenAI Codex** - Client and Python service.
- **Anthropic Claude** - Code review and Product copy.

The vision stack is third-party work. Every model and its source is listed in [Technical References](docs/DESIGN.md#9-technical-references).
