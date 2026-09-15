import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = process.argv[2];
const forwarded = process.argv.slice(3);
const windows = process.platform === "win32";

function pythonPath(environment) {
  return path.join(
    root,
    environment,
    windows ? "Scripts" : "bin",
    windows ? "python.exe" : "python",
  );
}

function powershell(script, args = []) {
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
  };
}

function nativePython(preferredEnvironment = ".venv") {
  const configured = process.env.STEREOVISOR_PYTHON?.trim();
  if (configured) return configured;
  const preferred = pythonPath(preferredEnvironment);
  if (existsSync(preferred)) return preferred;
  return windows ? "python" : "python3";
}

let launch;
if (action === "service") {
  launch = windows
    ? powershell(path.join(root, "service", "scripts", "start-service.ps1"))
    : {
        command: nativePython(),
        args: [path.join(root, "service", "scripts", "run-service.py")],
        env: { STEREOVISOR_MODE: process.env.STEREOVISOR_MODE || "preview" },
      };
} else if (action === "test-service") {
  launch = windows
    ? powershell(path.join(root, "service", "scripts", "test-service.ps1"))
    : {
        command: nativePython(
          existsSync(pythonPath(".venv-ai")) ? ".venv-ai" : ".venv",
        ),
        args: ["-m", "pytest", path.join(root, "service", "tests"), "-q"],
        env: { STEREOVISOR_MODE: "preview" },
      };
} else if (action === "openapi") {
  launch = {
    command: nativePython(".venv"),
    args: [path.join(root, "service", "scripts", "export-openapi.py")],
  };
} else if (action === "setup-core") {
  launch = windows
    ? powershell(path.join(root, "scripts", "setup-core.ps1"))
    : { command: "sh", args: [path.join(root, "scripts", "setup-core.sh")] };
} else if (action === "smoke") {
  launch = windows
    ? powershell(path.join(root, "scripts", "smoke-test.ps1"), forwarded)
    : {
        command: process.execPath,
        args: [
          path.join(
            root,
            "scripts",
            process.platform === "darwin"
              ? "smoke-test-macos.mjs"
              : "smoke-test-linux.mjs",
          ),
          ...forwarded,
        ],
      };
} else {
  console.error(`Unknown platform action: ${action || "<missing>"}`);
  process.exit(2);
}

const child = spawn(launch.command, [...launch.args, ...(action === "smoke" ? [] : forwarded)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...launch.env },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
