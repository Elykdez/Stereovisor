# Client/Server Separation Plan

## 1. Answer: The Unified Local API Already Exists

Stereovisor already runs a single unified local HTTP server. Every AI capability is
reachable only through it; nothing in the renderer imports or invokes a model.

```text
Electron main (electron/main.ts)
  - spawns the Python service            .....  process lifecycle, not an API
  - spawns PowerShell model bootstrap    .....  writes status to a shared file
            |
            | IPC: save/open dialogs, settings only
            v
React renderer  --- HTTP/JSON --->  FastAPI  (127.0.0.1:5179)
  src/web/lib/api.ts                 service/app.py    30 routes, all /api/*
  single client chokepoint             |
                                       +-- ai_models.py      Grounding DINO-B + SAM 2.1
                                       +-- depth.py          Depth Anything 3
                                       +-- pipeline.py       InSPyReNet, Big LaMa
                                       +-- refinement.py     Qwen3-VL, PowerPaint (subprocess)
```

The 30 routes in `service/app.py` cover analysis, refinement, inpainting, layer
editing, history, assets, and package import/export. `src/web/lib/api.ts` is the
only place the renderer issues requests, and asset URLs are already emitted
server-relative (`storage.py:295`) and resolved through one function
(`api.ts:110`). The contract is typed on both ends: Pydantic in
`service/schemas.py`, TypeScript in `src/web/types.ts`.

So the question is not whether a unified server exists. It does. The question is
whether that server is *separable*, and today it is not.

## 2. What Blocks Separation

The service is a unified API with a set of embedded loopback assumptions. Each
one is small; together they are the whole gap.

### 2.1 The address is hardcoded in twelve places

| Location | Value |
| --- | --- |
| `src/web/lib/api.ts:5` | `import.meta.env.DEV ? "" : "http://127.0.0.1:5179"` |
| `vite.config.mts:18` | dev proxy target |
| `scripts/run-service.py:28` | `host="127.0.0.1", port=5179` |
| `scripts/run-ai.ps1` | 5 port probes and health polls |
| `scripts/smoke-test.ps1` | 4 health and sample calls |

`service/config.py:24` defines `SERVICE_ORIGIN` from `STEREOVISOR_SERVICE_ORIGIN`
and **never reads it anywhere** - dead configuration that looks like the hook
already exists.

### 2.2 There is no identity, and no tenancy

Every endpoint is unauthenticated. `ProjectStore` (`service/storage.py:48`) is a
flat directory of `uuid4().hex` IDs with no owner field. A project ID is the only
credential, and it grants full read/write to that project. On loopback this is
correct and appropriately simple; off loopback it is the whole security model.

CORS (`service/app.py:67-73`) allowlists `http://127.0.0.1:5173` and `null`. That
is a loopback assumption expressed as a security control, and it forced an API
design compromise: mutations are POST-only pseudo-verbs (`/layers/{id}/delete`,
`/layers/undo-merge`) because the policy permits only GET and POST. See the
comment at `app.py:789-790`.

### 2.3 Jobs live in one process's memory

`ProcessingJobStore` (`service/jobs.py:38`) is a `dict` behind a `threading.Lock`,
and `ProcessingJobPayload.result` holds an entire `ProjectPayload` in RAM until
the client polls for it. Work is dispatched with FastAPI `BackgroundTasks`, which
run in the same process. Consequences:

- Jobs do not survive a service restart. A crash mid-analysis is unrecoverable
  and the renderer polls a 404 forever.
- Exactly one server process is possible. No replicas, no rolling restart.
- Completed job results are never evicted; the store grows for the process
  lifetime.

### 2.4 GPU work is serialized by an in-process lock with no queue

`PIPELINE_LOCK` (`service/pipeline.py:46`) is a module-level `threading.Lock`
held across entire model stages. This is exactly right for one local GPU. As a
server it means a second concurrent request silently blocks a worker thread for
the full duration of someone else's inference, with no queue position, no
admission control, and no way for a client to know it is waiting rather than
running.

### 2.5 Startup state travels through the filesystem, from client to server

This is the deepest coupling. `electron/main.ts:122` spawns a PowerShell
bootstrap; `scripts/bootstrap-status.ps1` writes `.stereovisor-bootstrap-status`
into the model root; `service/config.py:76` reads that file; `/api/health`
reports it as `startupState` / `startupProvider` / `startupProgress`
(`app.py:514-590`).

The server is therefore reporting the progress of a process **the client
started**, observed through a directory both happen to share. Split the two and
`/api/health` reports nothing during first-run preparation - which is precisely
when the startup gate depends on it.

### 2.6 The runtime is Windows-shaped

`config.py:26` resolves `.venv-powerpaint/Scripts/python.exe`. `electron/main.ts:153`
spawns `powershell.exe`. `scripts/` is PowerShell throughout. Setup, model
preparation, and smoke tests are all `.ps1`. A server deployment is normally
Linux.

### 2.7 PowerPaint is a second process wired through files

`refinement.py:145` spawns a separate interpreter from a pinned venv, passes
image/mask/output as **filesystem paths**, and reads progress by polling a JSON
sidecar every 200 ms (`refinement.py:198-215`). It assumes the API process and the
inference process share a disk. That assumption breaks the moment the GPU worker
is not the API server.

### 2.8 Configuration is frozen at import

`service/config.py` computes `MODE`, `DEVICE`, `MODEL_ROOT`, `PROJECT_ROOT` as
module constants at import; `ai_models.py:23-27` derives model paths the same
way. Nothing can be reconfigured without a process restart, and tests must reload
modules to vary it.

### 2.9 The AI components have no individual API

This is the gap closest to the original question. `/api/health` reports a
per-provider **inventory** - `runtime`, `segmentation`, `matting`, `depth`,
`inpainting`, `prompting`, `refinement` (`config.py:180-224`) - with readiness and
progress for each. But there is no endpoint behind any of them. Segmentation,
depth, matting, inpainting, and the VLM are internal stages of `analyze`,
`refine`, and `inpaint`, callable only as part of a whole workflow:

| Capability | Internal entry point | Public endpoint |
| --- | --- | --- |
| Segmentation | `ai_models.py:215 grounded_sam_instances` | none |
| Depth | `depth.py estimate_near_map` | none |
| Matting | `pipeline.py:989 _matte_mask` | none |
| Guided matting | `pipeline.py:1039 _guided_mask_refine` | none |
| Inpainting (fast) | `pipeline.py:1113 _lama_inpaint` | none |
| Inpainting (HQ) | `refinement.py:145 powerpaint_inpaint` | none |
| VLM vocabulary | `refinement.py:126 propose_object_vocabulary` | none |
| VLM caption | `refinement.py:87 generate_background_prompt` | none |

So the components advertise availability without exposing capability.

## 3. What Is Already Right

These do not need rework and should be preserved through the split.

- **One client chokepoint.** `src/web/lib/api.ts` is the only module issuing
  requests. Retargeting the client is a single-file change.
- **Server-relative asset URLs.** `asset_url()` (`storage.py:295`) emits
  `/api/projects/{id}/assets/{name}`; `resolveAssetUrl()` (`api.ts:110`) prefixes
  the origin and passes through absolute/data/blob URLs untouched. Assets
  re-point to a remote origin with no schema change.
- **A job protocol that already suits a network.** `POST /api/jobs/*` returns
  `{jobId}`; the client polls and can cancel. Long-running remote operations need
  exactly this shape; only the transport and durability need work.
- **Cooperative cancellation that reaches the GPU.** `jobs.ensure_active` is
  checked at stage boundaries and threaded into the PowerPaint subprocess loop.
- **Genuinely careful input validation.** Path containment in `storage.py:63-79`;
  zip-bomb, duplicate-entry, undeclared-file, and per-asset SHA-256 defenses in
  `import_package` (`storage.py:158-292`); real decode of uploads rather than
  trusting content type (`app.py:213-230`). This is the part of the codebase most
  ready for untrusted input.
- **Structured errors.** Consistent `{code, message, detail}` with a matching
  client parser (`api.ts:64-76`).
- **A portable project format.** `.stereovisor` already round-trips a complete
  scene with checksums - a natural migration and backup path.

## 4. Plan

Five phases. Each is independently shippable and leaves the local app working.
Phases 1-3 are the real separation; 4-5 are deployment.

### Phase 0 - Make the boundary configurable (no behavior change)

Removes every hardcoded address without changing what runs where.

1. Introduce `resolveServiceOrigin()` in `src/web/lib/api.ts`, resolving in
   order: injected runtime config, `VITE_STEREOVISOR_SERVICE_ORIGIN`, then the
   current loopback default. Delete the `SERVICE_ORIGIN` constant.
2. Add `serviceOrigin` to the settings schema (`src/web/settings.ts`,
   `electron/settings.ts`, `src/global.d.ts`), clamped and validated at the
   boundary like every other setting.
3. Make `scripts/run-service.py` read host/port from
   `STEREOVISOR_SERVICE_HOST` / `STEREOVISOR_SERVICE_PORT`, defaulting to
   `127.0.0.1:5179`. Wire up or delete the dead `SERVICE_ORIGIN` in
   `config.py:24`.
4. Parameterize the port in `run-ai.ps1` and `smoke-test.ps1`.
5. Emit `openapi.json` in CI and generate `src/web/types.ts` from it, so drift
   between `service/schemas.py` and the client becomes a build failure rather
   than a runtime surprise.

*Verification:* `npm run check` unchanged; app runs against an origin set by env.

### Phase 1 - Identity and tenancy

The prerequisite for anything non-loopback.

1. Add a `workspace` concept: `ProjectStore` gains a workspace-scoped root, and
   `directory()` resolves within it. Preserves the existing containment check.
2. Bearer-token auth as FastAPI middleware. In local mode the service mints a
   token at startup, writes it where only the current user can read it, and
   Electron hands it to the renderer over the existing IPC channel - so the local
   experience gains no login step.
3. Replace the CORS allowlist with a configured origin list, and once auth exists
   restore proper verbs: `DELETE /layers/{id}`, `POST /layers/{id}:undo-merge`.
   Keep the current POST aliases for one release.
4. Per-workspace quotas: project count, total bytes, concurrent jobs.

*Risk:* touches every route. Do it as middleware plus a single dependency, not
per-endpoint edits.

### Phase 2 - Durable jobs and an explicit queue

Removes the single-process constraint.

1. Replace the in-memory dict with a persisted job store (SQLite is sufficient
   and adds no service dependency). Store status separately from the result
   payload; keep results on disk and return a reference.
2. Replace `BackgroundTasks` with an explicit worker loop consuming a queue, so
   the API process and the inference process can eventually be separated.
3. Convert `PIPELINE_LOCK` from an implicit thread-blocker into a real queue with
   depth: report `queued` with position, distinct from `running`. The renderer
   already renders a `queued` state (`schemas.py:136`) that the server never
   currently emits.
4. Add `GET /api/jobs/{id}/events` (SSE) alongside polling. Keep polling as the
   fallback; `api.ts:154` already isolates this behind `waitForJob`.
5. Evict completed jobs on a TTL.

### Phase 3 - The capability API

This is the piece the current architecture genuinely lacks.

1. `GET /api/capabilities` - machine-readable inventory: each provider's id,
   model, readiness, accepted parameters and ranges, and VRAM cost. Supersedes
   the ad-hoc provider map inside `/api/health`.
2. One endpoint per component, each stateless (pixels in, pixels or JSON out),
   each returning a job for anything long-running:

   ```text
   POST /api/capabilities/segmentation:detect    image, density, labels -> instances
   POST /api/capabilities/depth:estimate         image                  -> depth map
   POST /api/capabilities/matting:refine         image, mask            -> alpha
   POST /api/capabilities/inpainting:fill        image, mask, provider  -> image
   POST /api/capabilities/vlm:vocabulary         image, density         -> labels
   POST /api/capabilities/vlm:caption            image                  -> prompt
   ```

3. **These must be thin adapters over the exact functions the pipeline already
   calls** - `grounded_sam_instances`, `estimate_near_map`, `_matte_mask`,
   `_lama_inpaint`, `powerpaint_inpaint`, `propose_object_vocabulary`,
   `generate_background_prompt`. The single largest risk in this plan is letting
   the capability endpoints drift into a second implementation of the pipeline.
   Extract each stage into a named provider function, then let both the workflow
   routes and the capability routes call it. No stage logic moves into `app.py`.
4. Keep the workflow endpoints. They are the product; capabilities are the
   substrate.

*Payoff:* an alternative client, a CLI, or a batch job can use one component
without driving the whole workflow - and each AI component finally has the
addressable API the inventory has been advertising.

### Phase 4 - The server owns its own lifecycle

Cuts the filesystem side-channel.

1. Move model bootstrap out of Electron and PowerShell into the service: port
   `prepare-packaged-ai.ps1` and `prepare-models.py` to a Python module the
   service supervises.
2. `/api/health` reports bootstrap state from in-process state, not from
   `.stereovisor-bootstrap-status`. Delete the file protocol in
   `config.py:76-125` and `scripts/bootstrap-status.ps1`. The response schema is
   unchanged, so `StartupGate` needs no rework.
3. Electron's role shrinks to: start the process, show the window. Delete
   `startPackagedModelPreparation` (`electron/main.ts:122-190`).
4. Give PowerPaint a process-boundary abstraction so the file-path handoff in
   `refinement.py:145` is one implementation of an interface, not the contract.

*This phase is worth doing even if the split never ships.* It removes a fragile
cross-process file protocol and a stale-marker recovery path
(`electron/main.ts:136-146`) from the local app.

### Phase 5 - Deployability

1. Linux support: remove `Scripts/python.exe` assumptions, port the setup scripts.
2. Storage behind an interface so `ProjectStore` can target object storage.
3. Container image with the model cache as a mounted volume.
4. Load and concurrency testing against the Phase 2 queue.

## 5. Sequencing and Cost

| Phase | Scope | Ships independently | Rough size |
| --- | --- | --- | --- |
| 0 Configurable boundary | client + scripts | yes | small |
| 1 Identity and tenancy | service-wide middleware | yes | medium |
| 2 Durable jobs and queue | `jobs.py`, `app.py` | yes | medium |
| 3 Capability API | `app.py` + provider extraction | yes | medium |
| 4 Server lifecycle | service + Electron + scripts | yes | large |
| 5 Deployability | scripts, storage, packaging | yes | large |

Phase 0 is a prerequisite for everything. Phases 1-3 are independent of one
another and can be reordered. Phase 4 is the largest single change and the one
that most improves the local app on its own. Phase 5 only matters if the server
is actually deployed remotely.

**Minimum useful subset:** Phase 0 + Phase 3. That yields a fully addressable,
retargetable local AI API without touching auth, jobs, or the bootstrap - and
answers the original question completely.

## 6. Required Contract Amendment

`docs/SRS.md:171` states that all inference runs locally and that no cloud
inference endpoint is supported by the service contract; line 189 lists cloud
inference and account synchronization as explicit non-goals.

This plan contradicts both. Before Phase 1, amend the SRS to distinguish:

- **Local-first remains the default and the shipped configuration.** The desktop
  app continues to run everything on the user's machine with no account.
- **Remote deployment becomes a supported configuration**, not the standard one.

Without that amendment, Phases 1-5 build something the product contract says the
service does not do. The distinction matters because the local-first guarantee is
a genuine product property here - `app.py` has no provider adapter, and network
access is used only to fetch weights (`DESIGN.md:25`). Keep that true by default.
