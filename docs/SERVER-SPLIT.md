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
(`api.ts:110`).

So the question is not whether a unified server exists. It does. The question is
whether the boundary is *explicit and correct*, and today it is not.

## 2. Design Constraints

These three constraints govern every decision below and are the reason this
revision reorders the original plan.

### C1 - Colocated by default, permanently

The server runs on the same machine as the app. That is not a transitional state
to be migrated away from; it is the shipped configuration and stays the default
forever. Remote hosting becomes *possible*, never *required*.

Consequences: the default bind stays `127.0.0.1:5179`. Nothing that only a
multi-machine deployment needs - accounts, tenancy, tokens, TLS - may be
introduced into the default path. Those move to an optional phase, gated behind
an explicit non-loopback bind.

### C2 - No functional change to the current app

Introducing the boundary must be invisible. Same startup gate, same Options
dialog, same workflow, same exports, same failure messages. Anything a user could
observe is frozen.

Consequences: every phase is a behavior-preserving refactor with a regression
gate (section 7). Response schemas in `service/schemas.py` are treated as a
frozen contract, not an implementation detail. The settings schema stays at
`version: 1` and gains no required field. Where a change would be observable, the
plan either avoids it or explicitly calls it out for a decision.

### C3 - Push, not polling, for status and queue

Status and queue reporting move to a real-time channel. Repeated `GET` requests
are a workaround for not having one.

Consequences: section 6 designs a single WebSocket. Both existing polling loops
retire behind it, and the HTTP endpoints remain as fallback so C2 holds when the
socket is unavailable.

### C4 - The service console must honor its setting

`service.showConsole` (`settings.ts:71-75`, Advanced) must keep a visible console
window for the service process when enabled. This behavior is in scope to
preserve - and currently only one of the two launch paths honors it in a useful
way. See section 9.

## 3. What Blocks Separation

Each is small; together they are the whole gap.

### 3.1 The address is hardcoded in twelve places

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

### 3.2 Two polling loops stand in for a push channel

| Loop | Location | Cadence |
| --- | --- | --- |
| Job progress | `api.ts:247` inside `waitForJob` | `pollIntervalMs`, default 1000 ms |
| Startup / health | `App.tsx:218-261`, `retryTimer` around `probeHealth()` | fixed 1000 ms |

The second is the costlier one. During first-run model preparation the gate polls
`/api/health` once per second for as long as the download takes - and each call
runs `ai_dependencies()`, which stats model directories and probes module specs
(`config.py:180-224`).

### 3.3 Jobs live in one process's memory

`ProcessingJobStore` (`service/jobs.py:38`) is a `dict` behind a `threading.Lock`,
and `ProcessingJobPayload.result` holds an entire `ProjectPayload` in RAM until
the client polls for it. Work is dispatched with FastAPI `BackgroundTasks`, which
run in the same process. Jobs do not survive a restart, completed results are
never evicted, and exactly one server process is possible.

### 3.4 GPU work is serialized by a lock with no queue

`PIPELINE_LOCK` (`service/pipeline.py:46`) is held across entire model stages.
Correct for one local GPU. But a second concurrent request silently blocks a
worker thread for the full duration of someone else's inference, with no queue
position and no way for a client to know it is waiting rather than running.
`schemas.py:136` already defines a `queued` state the server never emits.

### 3.5 Startup state travels through the filesystem, from client to server

The deepest coupling. `electron/main.ts:122` spawns a PowerShell bootstrap;
`scripts/bootstrap-status.ps1` writes `.stereovisor-bootstrap-status` into the
model root; `service/config.py:76` reads that file; `/api/health` reports it as
`startupState` / `startupProvider` / `startupProgress`.

The server reports the progress of a process **the client started**, observed
through a directory both happen to share.

### 3.6 PowerPaint is a second process wired through files

`refinement.py:145` spawns a separate interpreter from a pinned venv, passes
image/mask/output as filesystem **paths**, and polls a JSON sidecar every 200 ms
(`refinement.py:198-215`). It assumes the API process and the inference process
share a disk.

### 3.7 Configuration is frozen at import

`service/config.py` computes `MODE`, `DEVICE`, `MODEL_ROOT`, `PROJECT_ROOT` as
module constants at import; `ai_models.py:23-27` derives model paths the same
way. Nothing is reconfigurable without a restart, and tests must reload modules.

### 3.8 The AI components have no individual API

The gap closest to the original question. `/api/health` reports a per-provider
**inventory** - `runtime`, `segmentation`, `matting`, `depth`, `inpainting`,
`prompting`, `refinement` - with readiness and progress for each. But there is no
endpoint behind any of them:

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

The components advertise availability without exposing capability.

### 3.9 Windows-shaped runtime

`config.py:26` resolves `.venv-powerpaint/Scripts/python.exe`;
`electron/main.ts:153` spawns `powershell.exe`; `scripts/` is PowerShell
throughout. Only matters for the optional remote phase.

## 4. What Is Already Right

Preserve these through the split.

- **One client chokepoint.** `src/web/lib/api.ts` is the only module issuing
  requests. Retargeting the client is a single-file change.
- **Server-relative asset URLs.** `asset_url()` emits
  `/api/projects/{id}/assets/{name}`; `resolveAssetUrl()` prefixes the origin and
  passes absolute/data/blob URLs through untouched. Assets re-point to a remote
  origin with no schema change.
- **A job protocol that already suits a network.** `POST` returns `{jobId}`; the
  client observes and can cancel. Only the transport and durability need work.
- **Cooperative cancellation that reaches the GPU.** `jobs.ensure_active` is
  checked at stage boundaries and threaded into the PowerPaint subprocess loop.
- **Careful input validation.** Path containment (`storage.py:63-79`); zip-bomb,
  duplicate-entry, undeclared-file and per-asset SHA-256 defenses in
  `import_package`; real decode of uploads rather than trusting content type.
- **Structured errors** with a matching client parser (`api.ts:64-76`).
- **A portable project format** that already round-trips a complete scene.

## 5. Plan

Reordered from the previous revision. Auth and tenancy moved from first to last
and marked optional, because under C1 a colocated single-user server does not
need them. The real-time channel moved up, because C3 asks for it and it is
independent of everything else.

### Phase 0 - Configurable boundary (behavior-preserving)

Removes every hardcoded address without changing what runs where.

1. Introduce `resolveServiceOrigin()` in `src/web/lib/api.ts`, resolving in
   order: injected runtime config, `VITE_STEREOVISOR_SERVICE_ORIGIN`, then the
   current loopback default. Delete the `SERVICE_ORIGIN` constant.
2. Add an **optional** `service.origin` to the settings schema with the current
   value as its default. Optional-with-default keeps `version: 1` valid and needs
   no migration (`settings.ts` normalizes and clamps on read).
3. Make `scripts/run-service.py` read `STEREOVISOR_SERVICE_HOST` /
   `STEREOVISOR_SERVICE_PORT`, defaulting to `127.0.0.1:5179`. Wire up or delete
   the dead `SERVICE_ORIGIN` in `config.py:24`.
4. **Refuse a non-loopback bind unless Phase 5 auth is configured.** This is the
   safety gate that lets Phases 1-4 ignore authentication entirely.
5. Parameterize the port in `run-ai.ps1` and `smoke-test.ps1`.
6. Emit `openapi.json` in CI and generate `src/web/types.ts` from it, so drift
   between `service/schemas.py` and the client becomes a build failure.

*C2:* fully preserved. Defaults are byte-identical to today.

### Phase 1 - Real-time channel (C3)

Detailed design in section 6. Retires both polling loops.

1. Add `GET /api/events` (WebSocket) multiplexing two topics: `job` and `health`.
2. Client subscribes; HTTP endpoints stay as fallback and for authoritative reads.
3. `waitForJob` (`api.ts:216`) and the `App.tsx:218-261` health loop consume the
   socket, falling back to their current polling on failure.
4. Retain `processing.pollIntervalMs`; it governs the fallback cadence and the
   reconnect backoff ceiling. No Options, i18n, or schema change.

*C2:* preserved by construction - the fallback path *is* today's behavior.

### Phase 2 - Durable jobs and an explicit queue

Removes the single-process constraint and makes queue state reportable.

1. Replace the in-memory dict with a persisted store (SQLite; no new service
   dependency). Store status separately from the result payload.
2. Replace `BackgroundTasks` with an explicit worker loop consuming a queue, so
   API and inference processes can eventually separate.
3. Turn `PIPELINE_LOCK` from an implicit thread-blocker into a real queue with
   depth, and finally emit the `queued` state with position over the Phase 1
   channel.
4. Evict completed jobs on a TTL.

*C2:* emitting `queued` is the one intentional user-visible improvement. Today a
queued job is indistinguishable from a running one; there is no regression, only
a state that previously never appeared. Flagged rather than hidden.

### Phase 3 - The capability API

The piece the architecture genuinely lacks.

1. `GET /api/capabilities` - machine-readable inventory: each provider's id,
   model, readiness, accepted parameters and ranges, VRAM cost.
2. One endpoint per component, each stateless, each returning a job for anything
   long-running:

   ```text
   POST /api/capabilities/segmentation:detect    image, density, labels -> instances
   POST /api/capabilities/depth:estimate         image                  -> depth map
   POST /api/capabilities/matting:refine         image, mask            -> alpha
   POST /api/capabilities/inpainting:fill        image, mask, provider  -> image
   POST /api/capabilities/vlm:vocabulary         image, density         -> labels
   POST /api/capabilities/vlm:caption            image                  -> prompt
   ```

3. **These must be thin adapters over the exact functions the pipeline already
   calls.** The single largest risk in this plan is letting capability endpoints
   drift into a second implementation. Extract each stage into a named provider
   function, then have both the workflow routes and the capability routes call
   it. No stage logic moves into `app.py`.
4. Keep the workflow endpoints unchanged. They are the product; capabilities are
   the substrate.

*C2:* purely additive. The renderer keeps using workflow endpoints and is not
touched.

### Phase 4 - The server owns its own lifecycle

Cuts the filesystem side-channel of 3.5.

1. Port `prepare-packaged-ai.ps1` and `prepare-models.py` into a Python module
   the service supervises.
2. `/api/health` reports bootstrap state from in-process state rather than
   `.stereovisor-bootstrap-status`. **The response schema is unchanged**, so
   `StartupGate` and `startup.ts` need no rework - and with Phase 1, progress
   arrives as it happens instead of on the next 1 s tick.
3. Delete `startPackagedModelPreparation` (`electron/main.ts:122-190`), the
   stale-marker recovery path, and `scripts/bootstrap-status.ps1`.
4. Give PowerPaint a process-boundary abstraction so the file-path handoff in
   `refinement.py:145` is one implementation of an interface, not the contract.

*C2:* the highest-risk phase for behavior preservation, because the startup gate
is the most stateful surface in the app. `startup.ts` is pure and fully unit
tested, which makes it cheap to pin - see section 7.

**Worth doing even if the split never ships**, since it removes a fragile
cross-process file protocol from the local app.

### Phase 5 - Optional: remote hosting

Only if the server is ever actually hosted off-machine. Nothing here belongs in
the default configuration.

1. Bearer-token auth as middleware; the loopback default mints a token at startup
   and hands it to the renderer over existing IPC, so no login appears locally.
2. Workspace scoping in `ProjectStore`, preserving the existing containment check.
3. Replace the CORS allowlist with a configured origin list. With auth present,
   restore proper verbs (`DELETE /layers/{id}`) - the POST-only pseudo-verbs at
   `app.py:789` exist solely because the loopback CORS policy permits GET and
   POST. Keep the current aliases for one release.
4. Linux support, storage interface, container image, per-workspace quotas.

## 6. Real-Time Channel Design (C3)

### Transport

**One multiplexed WebSocket at `/api/events`**, not per-topic SSE streams.

WebSocket over SSE because the channel needs to carry subscribe/unsubscribe
intent, because both topics share one connection, reconnect policy and (later)
auth handshake, and because `EventSource` cannot set an `Authorization` header -
which would force a token into the query string the moment Phase 5 arrives.
FastAPI has first-class WebSocket support and Electron's renderer has no proxy
complications. If the bidirectional channel proves unnecessary, SSE is the
lighter fallback with the same message shapes.

### Message shape

```jsonc
// server -> client
{ "topic": "job",    "seq": 42, "jobId": "...", "state": "running",
  "progress": 48, "stage": "Estimating depth", "message": "..." }
{ "topic": "job",    "seq": 43, "jobId": "...", "state": "queued", "position": 2 }
{ "topic": "health", "seq": 17, "startupState": "downloading",
  "startupProvider": "depth", "startupProgress": 62 }

// client -> server
{ "action": "subscribe",   "topic": "job", "jobId": "..." }
{ "action": "unsubscribe", "topic": "job", "jobId": "..." }
```

Progress fields mirror `ProcessingJobPayload` and `HealthPayload` exactly, so the
existing renderer reducers consume them unchanged.

### Three rules that keep C2 true

1. **The socket never carries the result.** On `state: "completed"` the client
   issues one `GET /api/jobs/{id}` for the authoritative `ProjectPayload`. The
   result path stays byte-identical to today, and the socket is a pure
   optimization rather than a new source of truth.
2. **HTTP is always authoritative.** On connect or reconnect the client reads
   current state over HTTP once, *then* subscribes. A monotonic `seq` per topic
   lets it discard frames older than what it has already applied. A dropped frame
   can never strand the UI, because the terminal state is always fetchable.
3. **Fallback is the current code path.** If the socket fails to open or drops
   and cannot recover, `waitForJob` and the health loop resume polling at
   `pollIntervalMs`. Degraded mode is exactly today's behavior.

### What retires

| Today | After |
| --- | --- |
| `api.ts:247` 1 s job poll | socket frames; poll only as fallback |
| `App.tsx:218-261` 1 s health poll | socket frames; poll only as fallback |
| `queued` state never emitted | emitted with queue position (Phase 2) |
| `pollIntervalMs` governs job polling | governs fallback cadence and reconnect ceiling |

## 7. How "No Functional Change" Is Verified (C2)

C2 is only meaningful with a regression gate. The repository already has most of
one: `npm run check` runs i18n check, typecheck, renderer tests, service tests
and a production build; `npm run smoke` drives a real launch, and
`npm run smoke -- -Preview` exercises the locked first-launch screen and asserts
the per-provider startup progress the mask renders.

Add before starting Phase 0:

1. **Golden contract fixtures.** Snapshot `/api/health` and a full job lifecycle
   (`queued` -> `running` -> `completed`) as JSON fixtures. Any schema drift
   fails a test rather than surfacing in the UI. This is the single highest-value
   addition, because `HealthPayload` is what the startup gate renders.
2. **Pin `startup.ts` behavior.** `isProviderPrepared`, `readyProviderCount`,
   `startupProgressPercent` and `isLocalAiReady` are pure functions over
   `HealthStatus` and already have tests (`src/tests/lib/startup.test.ts`).
   Extend them to cover every `state` value before touching Phase 4.
3. **Transport-parity test.** Run the same job lifecycle twice - once over the
   socket, once with the socket forced closed - and assert both produce an
   identical sequence of `ProcessingProgress` values. This is the specific test
   that proves Phase 1 changed nothing observable.
4. **Frozen surfaces.** These may not change without an explicit decision:
   startup gate rows and states; Options dialog entries and `SETTINGS_REGISTRY`
   keys; settings schema `version: 1`; i18n keys in `translations.csv`; the
   `.stereovisor` package format and version; asset URL shape; error `code`
   values.

Per-phase gate: `npm run check` for every phase; `npm run smoke` additionally for
Phases 1 and 4; `npm run package` plus a launch of
`release/win-unpacked/Stereovisor.exe` for Phase 4 and for the console fix in
section 9, since neither the packaged console window nor the packaged bootstrap
can be exercised from the dev harness.

## 8. Sequencing

| Phase | Scope | C2 risk | Size |
| --- | --- | --- | --- |
| 0 Configurable boundary | client + scripts | none | small |
| 1 Real-time channel | `app.py`, `api.ts`, `App.tsx` | low - fallback is today's path | medium |
| 2 Durable jobs and queue | `jobs.py`, `app.py` | low - one new state, flagged | medium |
| 3 Capability API | `app.py` + provider extraction | none - purely additive | medium |
| 4 Server lifecycle | service + Electron + scripts | **high** - startup gate | large |
| 5 Optional remote | auth, tenancy, packaging | n/a - opt-in only | large |

Phase 0 precedes everything. Phases 1-3 are mutually independent and reorderable.
Phase 4 is the largest and the one that most improves the local app on its own.
Phase 5 only matters if the server is actually hosted remotely.

**Minimum useful subset: Phase 0 + Phase 1 + Phase 3.** That gives a fully
addressable, retargetable local AI API with push-based status - satisfying C1, C2
and C3 - without touching the bootstrap, jobs durability, or auth.

## 9. Service Console Window (C4)

The setting exists: `service.showConsole`, registered at `settings.ts:71-75` under
the Advanced category, surfaced in `SettingsDialog`, and persisted in
`settings.json`. **No new setting is needed.** But the two launch paths honor it
very differently.

**Launcher path - works.** `Run Stereovisor.cmd` reads the persisted setting via
`scripts/read-console-setting.ps1`, and `run-ai.ps1:103` maps it to
`$ServiceWindowStyle = "Normal"`, then `Start-Process -WindowStyle Normal`
(`run-ai.ps1:104-114`) with no output redirection. A real console window appears
with live service output.

**Packaged Electron path - window without output.** `electron/main.ts:231-240`
spawns the service with:

```ts
windowsHide: !showConsole,
stdio: "pipe",
```

`windowsHide: false` omits `CREATE_NO_WINDOW`, so Windows allocates a console for
the child. But `stdio: "pipe"` redirects the child's stdout and stderr into
Electron, which re-logs them via `console.info` (`main.ts:247-256`) - and a
packaged GUI Electron process has no console attached, so that output goes
nowhere. The allocated window is left with nothing written to it.

The same applies to `startPackagedModelPreparation` (`main.ts:165-170`), which
uses the identical `windowsHide` / `stdio: "pipe"` combination.

*This is inference from the `windowsHide` / `CREATE_NO_WINDOW` and pipe-redirect
semantics plus the code above, not an observed run - confirming it requires
`npm run package` and a launch with the setting enabled.*

**Fix:** select stdio from the same flag that selects window visibility, so the
child writes to the console it was given.

```ts
stdio: showConsole ? "inherit" : "pipe",
```

Contained by construction: it alters only the `showConsole === true` branch, which
is off by default, so the default experience cannot regress. The existing
`serviceProcess.stdout?.on(...)` handlers already use optional chaining and become
inert when stdio is inherited. Verified by `npm run package` plus a launch with
the setting on.

Carry this into the plan as a frozen surface: after Phase 4 removes
`startPackagedModelPreparation`, `service.showConsole` must still produce a
visible, populated console for the service process.

## 10. Contract Amendment

`docs/SRS.md:171` states that all inference runs locally and that no cloud
inference endpoint is supported; line 189 lists cloud inference and account
synchronization as explicit non-goals.

Under C1 this mostly survives: the shipped configuration remains fully local with
no account, so the local-first guarantee stays factually true of the product as
delivered. Only Phase 5 would contradict it, and only when opted into.

The SRS therefore needs a narrow amendment rather than a rewrite, and only before
Phase 5 - not before Phases 0-4:

- **Local-first is the default and the shipped configuration.** Unchanged.
- **Remote hosting is a supported optional deployment**, off by default, and
  requires authentication to bind beyond loopback (Phase 0, item 4).

Phases 0-4 need no amendment at all: they change where the boundary is drawn,
not where the inference runs.
