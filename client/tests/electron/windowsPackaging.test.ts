import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type WindowsBuild = {
  icon?: string;
  requestedExecutionLevel?: string;
  signAndEditExecutable?: boolean;
  signExecutable?: boolean;
};

const repositoryRoot = process.cwd();
const packageJson = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
) as { build: { win: WindowsBuild } };

describe("Windows packaging", () => {
  it("embeds the application icon and metadata without requesting elevation", () => {
    const windows = packageJson.build.win;

    expect(windows.signAndEditExecutable).toBe(true);
    expect(windows.requestedExecutionLevel).toBe("asInvoker");
    expect(windows.icon).toBe("client/public/app-icon.png");
    expect(existsSync(path.join(repositoryRoot, windows.icon ?? ""))).toBe(true);
  });

  it("does not disable certificate-backed executable signing", () => {
    expect(packageJson.build.win.signExecutable).not.toBe(false);
  });
});
