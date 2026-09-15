import { spawn } from "node:child_process";

const target =
  process.platform === "darwin"
    ? "package:mac"
    : process.platform === "win32"
      ? "package:win"
      : process.platform === "linux"
        ? "package:linux"
      : null;

if (!target) {
  console.error("Stereovisor packaging is supported on Windows, Apple Silicon macOS, and x64 Linux.");
  process.exit(2);
}
if (process.platform === "darwin" && process.arch !== "arm64") {
  console.error("The macOS package target supports Apple Silicon only.");
  process.exit(2);
}
if (process.platform === "linux" && process.arch !== "x64") {
  console.error("The Linux package target supports x64 only.");
  process.exit(2);
}

const windows = process.platform === "win32";
const command = windows ? (process.env.ComSpec || "cmd.exe") : "npm";
const args = windows ? ["/d", "/s", "/c", `npm.cmd run ${target}`] : ["run", target];
const child = spawn(command, args, {
  stdio: "inherit",
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
