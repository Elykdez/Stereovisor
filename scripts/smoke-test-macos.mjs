import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packaged = process.argv.includes("--packaged");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "stereovisor-macos-smoke-"));
const projectsRoot = path.join(temporaryRoot, "projects");
const modelsRoot = packaged
  ? path.join(root, "service", ".models")
  : path.join(temporaryRoot, "models");
const userDataRoot = path.join(temporaryRoot, "user-data");
const children = [];
let output = "";

mkdirSync(projectsRoot, { recursive: true });
mkdirSync(modelsRoot, { recursive: true });
mkdirSync(userDataRoot, { recursive: true });

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stdout || ""}${result.stderr || ""}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  return child;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForJson(url, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}`);
}

async function waitForDocument(url, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      const body = response.ok ? await response.text() : "";
      if (body.includes("<title>Stereovisor</title>")) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}`);
}

async function runSample(origin) {
  const started = await fetch(`${origin}/api/jobs/sample`, { method: "POST" });
  if (!started.ok) throw new Error(`Sample job start returned HTTP ${started.status}`);
  const { jobId } = await started.json();
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await waitForJson(`${origin}/api/jobs/${jobId}`, 1);
    if (job.state === "completed") {
      if (!job.result?.id || job.result.layers?.length < 2) {
        throw new Error("The sample job did not create a layered project.");
      }
      return;
    }
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(`The sample job ended in state ${job.state}: ${job.message || ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The sample job did not complete within 30 seconds.");
}

function packagedArtifacts() {
  const releaseRoot = path.join(root, "release");
  const appCandidates = [
    path.join(releaseRoot, "mac-arm64", "Stereovisor.app"),
    path.join(releaseRoot, "mac", "Stereovisor.app"),
  ];
  const appBundle = appCandidates.find(existsSync);
  if (!appBundle) throw new Error("The packaged Stereovisor.app was not found.");
  const files = readdirSync(releaseRoot);
  const dmg = files.find((name) => name.endsWith("-mac-arm64.dmg"));
  const zip = files.find((name) => name.endsWith("-mac-arm64.zip"));
  if (!dmg || !zip) throw new Error("The macOS DMG and ZIP artifacts were not both found.");
  return {
    appBundle,
    executable: path.join(appBundle, "Contents", "MacOS", "Stereovisor"),
    runtimePython: path.join(appBundle, "Contents", "Resources", ".python-runtime", "bin", "python3"),
    powerpaintPackages: path.join(appBundle, "Contents", "Resources", ".python-runtime", "powerpaint-site-packages"),
    powerpaintVendor: path.join(appBundle, "Contents", "Resources", ".cache", "vendor", "PowerPaint"),
    dmg: path.join(releaseRoot, dmg),
    zip: path.join(releaseRoot, zip),
  };
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The macOS smoke test supports Apple Silicon only.");
  }

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    STEREOVISOR_MODE: packaged ? "ai" : "preview",
    STEREOVISOR_DEVICE: "mps",
    STEREOVISOR_PROJECT_ROOT: projectsRoot,
    STEREOVISOR_MODEL_ROOT: modelsRoot,
    STEREOVISOR_SERVICE_PORT: String(port),
    PYTORCH_ENABLE_MPS_FALLBACK: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  });

  let electronProcess;
  let packagedApp;
  if (packaged) {
    const artifacts = packagedArtifacts();
    packagedApp = artifacts.appBundle;
    const binaryInfo = run("file", [artifacts.executable], "Architecture check");
    if (!binaryInfo.includes("arm64") || binaryInfo.includes("x86_64")) {
      throw new Error(`The packaged executable is not arm64-only: ${binaryInfo}`);
    }
    run("codesign", ["--verify", "--deep", "--strict", artifacts.appBundle], "Code signature check");
    run("hdiutil", ["verify", artifacts.dmg], "DMG verification");
    run("unzip", ["-tq", artifacts.zip], "ZIP verification");
    const powerpaintInfo = run(
      artifacts.runtimePython,
      [
        "-W", "ignore", "-c",
        "import sys, torch, diffusers; sys.path.insert(0, sys.argv[1]); from powerpaint.models.BrushNet_CA import BrushNetModel; from powerpaint.pipelines.pipeline_PowerPaint_Brushnet_CA import StableDiffusionPowerPaintBrushNetPipeline; print(diffusers.__version__, 'CPU fallback' if not torch.cuda.is_available() else 'CUDA')",
        artifacts.powerpaintVendor,
      ],
      "Bundled PowerPaint runtime check",
      { env: { ...env, PYTHONPATH: artifacts.powerpaintPackages } },
    );
    if (!powerpaintInfo.includes("0.27.0 CPU fallback")) {
      throw new Error(`Unexpected PowerPaint runtime: ${powerpaintInfo}`);
    }
    electronProcess = start(
      artifacts.executable,
      [`--user-data-dir=${userDataRoot}`],
      env,
    );
  } else {
    run("sh", [path.join(root, "scripts", "setup-core.sh")], "Core setup");
    const python = path.join(root, ".venv", "bin", "python");
    const electron = path.join(
      root,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    );
    env.STEREOVISOR_APP_ROOT = root;
    env.STEREOVISOR_PYTHON = python;
    start(python, [path.join(root, "service", "scripts", "run-service.py")], env);
    start("npm", ["run", "dev:renderer"], env);
    await waitForDocument("http://127.0.0.1:5173/");
    env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
    electronProcess = start(electron, [root, `--user-data-dir=${userDataRoot}`], env);
  }

  const health = await waitForJson(`${origin}/api/health`);
  const expectedEngine = packaged ? "ai" : "preview";
  if (
    health.status !== "ok" ||
    health.version !== "0.1.0" ||
    health.activeEngine !== expectedEngine ||
    (packaged && (
      health.device !== "mps" ||
      health.startupState !== "ready" ||
      health.providers?.refinement?.available !== true ||
      !health.providers?.refinement?.warning?.includes("PowerPaint will load and run on CPU")
    ))
  ) {
    throw new Error(`Unexpected service health: ${JSON.stringify(health)}`);
  }
  await runSample(origin);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (electronProcess.exitCode !== null) {
    throw new Error(`Electron exited during the smoke test with ${electronProcess.exitCode}.`);
  }
  if (packagedApp) {
    run("codesign", ["--verify", "--deep", "--strict", packagedApp], "Post-launch code signature check");
  }
  console.log(
    packaged
      ? "Packaged Apple Silicon app smoke test passed (arm64, persistent signature, DMG, ZIP, Electron, MPS service, PowerPaint CPU fallback, and sample workflow)."
      : "Apple Silicon development smoke test passed (renderer, Electron, service, and sample workflow).",
  );
}

try {
  await main();
} catch (error) {
  if (output.trim()) console.error(output.trim());
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may have exited between the check and the signal.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
