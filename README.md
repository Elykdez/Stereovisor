# Stereovisor

**A photo is flat. A camera gives it depth.**

![Stereovisor turning a photograph into a moving 2.5D scene](docs/demo.gif)

(Demo poster is GTA VI by Rockstar Games) 

## Supported Language

- [English](./client/docs/USER-MANUAL.md) | [한국어](./client/docs/USER-MANUAL.ko.md) | [日本語](./client/docs/USER-MANUAL.ja.md) | [简体中文](./client/docs/USER-MANUAL.zh-CN.md)

## Principles & Compatibility

- **Local by default.** Source images and generated assets stay on your machine. The service has no cloud-provider adapter; the network is used to download runtime dependencies and model weights.
- **Inspectable.** Every stage reports its model, device, progress, and VRAM peak. Preview processing is never presented as AI processing.
- **Modest hardware.** GPU stages load one at a time and are released before the next, inside an 8 GB VRAM budget.

## How It Works

This app finds the objects in the frame, cuts them out, works out how far away each one sits, paints back the background that was hiding behind them, and hands you a scene you can move through.

1. **Drop an image.** PNG, JPEG, or WebP.
2. **Proposes layers.** An open-vocabulary detector finds the subjects, a segmenter cuts each one out, and a depth model orders them front to back.
3. **Decide.** Keep a layer, drop it, merge two, brush in one the detector missed, rename it, tighten its edge. The model's answer is a starting point, not a verdict.
4. **Rebuilds the background.** Your selected cutouts are joined into a single removal mask, expanded past the edge contamination, and inpainted, so the space behind the foreground is no longer a hole.
5. **Tweak the camera.** Drag the stage. Near layers travel further than far ones, the lens pulls focus from scene depth, and it stays interactive because no model runs per frame.

## What You Get

- **PNG** of the current composite at source resolution.
- **MP4** of a four-second parallax move, encoded by Electron's bundled Chromium encoder. No FFmpeg anywhere.
- **`.stereovisor` project** - a portable package holding every processed asset plus the exact editor state. Reopen it later and everything is where you left it.

## Quick Start

**Windows** - double-click `Run Stereovisor.cmd`.

**Apple Silicon macOS** - double-click `Run Stereovisor.command`.

- The first launch shows a preparation screen while it installs the local AI runtime and downloads model weights. Later launches go straight to the editor.

- Just looking around? `Run Stereovisor Preview.cmd` / `.command` starts a lightweight sample-only engine that downloads no weights at all.

## Architecture

You may check designated docs under clients and servers to learn about this project.

- `client/` - Mostly Typescript & Web: React renderer, Electron host, static assets, tests, build config.
- `service/` - Python API and pipeline, service tests, requirements, model cache.
- `scripts/` - Mostly Shell. launch, setup, and smoke-test orchestration across both sides.
- `docs/` - Documents about product and design that span both sides.

## Attribution

- [Elykdez](https://github.com/Elykdez) - Designer and director.

- **OpenAI Codex** - Client and Python service.
- **Anthropic Claude** - Code review and Product copy.

The vision stack is third-party work. Every model and its source is listed in [Technical References](docs/DESIGN.md#9-technical-references).
