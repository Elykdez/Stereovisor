import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packaged = process.argv.includes("--packaged");
const serviceVersion = JSON.parse(readFileSync(path.join(root, "versions.json"), "utf8")).service;
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "stereovisor-linux-smoke-"));
const projectsRoot = path.join(temporaryRoot, "projects");
const modelsRoot = path.join(temporaryRoot, "models");
const userDataRoot = path.join(temporaryRoot, "user-data");
const children = [];
let output = "";

for (const directory of [projectsRoot, modelsRoot, userDataRoot]) {
  mkdirSync(directory, { recursive: true });
}

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
  const unpackedRoot = path.join(releaseRoot, "linux-unpacked");
  const executable = path.join(unpackedRoot, "stereovisor");
  if (!existsSync(executable)) throw new Error("The packaged Linux executable was not found.");
  const files = readdirSync(releaseRoot);
  const appImage = files.find((name) => name.endsWith("-linux-x64.AppImage"));
  const deb = files.find((name) => name.endsWith("-linux-x64.deb"));
  if (!appImage || !deb) throw new Error("The Linux AppImage and deb artifacts were not both found.");
  return {
    executable,
    runtimePython: path.join(unpackedRoot, "resources", ".python-runtime", "bin", "python3"),
    powerpaintPackages: path.join(unpackedRoot, "resources", ".python-runtime", "powerpaint-site-packages"),
    powerpaintVendor: path.join(unpackedRoot, "resources", ".cache", "vendor", "PowerPaint"),
    appImage: path.join(releaseRoot, appImage),
    deb: path.join(releaseRoot, deb),
  };
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("The Linux smoke test supports x64 only.");
  }

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    STEREOVISOR_MODE: "preview",
    STEREOVISOR_DEVICE: "auto",
    STEREOVISOR_PROJECT_ROOT: projectsRoot,
    STEREOVISOR_MODEL_ROOT: modelsRoot,
    STEREOVISOR_SERVICE_PORT: String(port),
    PYTHONDONTWRITEBYTECODE: "1",
  });

  let electronProcess;
  if (packaged) {
    const artifacts = packagedArtifacts();
    const binaryInfo = run("file", [artifacts.executable], "Architecture check");
    if (!binaryInfo.includes("x86-64") || binaryInfo.includes("ARM aarch64")) {
      throw new Error(`The packaged executable is not x64-only: ${binaryInfo}`);
    }
    run("dpkg-deb", ["--info", artifacts.deb], "deb verification");
    chmodSync(artifacts.appImage, 0o755);
    const extractionRoot = path.join(temporaryRoot, "appimage");
    mkdirSync(extractionRoot);
    run(artifacts.appImage, ["--appimage-extract"], "AppImage verification", {
      cwd: extractionRoot,
    });
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
    const electronArgs = [`--user-data-dir=${userDataRoot}`];
    if (process.env.CI) electronArgs.push("--no-sandbox");
    electronProcess = start(artifacts.executable, electronArgs, env);
  } else {
    run("sh", [path.join(root, "scripts", "setup-core.sh")], "Core setup");
    const python = path.join(root, ".venv", "bin", "python");
    const electron = path.join(root, "node_modules", "electron", "dist", "electron");
    env.STEREOVISOR_APP_ROOT = root;
    env.STEREOVISOR_PYTHON = python;
    start(python, [path.join(root, "service", "scripts", "run-service.py")], env);
    start("npm", ["run", "dev:renderer"], env);
    await waitForDocument("http://127.0.0.1:5173/");
    env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
    const electronArgs = [root, `--user-data-dir=${userDataRoot}`];
    if (process.env.CI) electronArgs.push("--no-sandbox");
    electronProcess = start(electron, electronArgs, env);
  }

  const health = await waitForJson(`${origin}/api/health`);
  if (
    health.status !== "ok" ||
    health.version !== serviceVersion ||
    health.activeEngine !== "preview" ||
    health.device !== "cpu"
  ) {
    throw new Error(`Unexpected service health: ${JSON.stringify(health)}`);
  }
  await runSample(origin);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (electronProcess.exitCode !== null) {
    throw new Error(`Electron exited during the smoke test with ${electronProcess.exitCode}.`);
  }
  console.log(
    packaged
      ? "Packaged x64 Linux app smoke test passed (ELF, AppImage, deb, Electron, CPU service, PowerPaint CPU fallback, and sample workflow)."
      : "x64 Linux development smoke test passed (renderer, Electron, service, and sample workflow).",
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
