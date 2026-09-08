const { existsSync } = require("node:fs");
const {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { npmInvocation } = require("./npm-invocation.cjs");

const opencodeVersion = "1.18.29";
const opencodePluginPackage = "@opencode-ai/plugin";

function prepareBundledOpenCodeConfig(projectDir) {
  const targetDirectory = join(
    projectDir,
    ".runtime-resources",
    "opencode-config",
  );
  try {
    const installed = JSON.parse(
      readFileSync(
        join(
          targetDirectory,
          "node_modules",
          "@opencode-ai",
          "plugin",
          "package.json",
        ),
        "utf8",
      ),
    );
    if (installed.version === opencodeVersion) {
      return targetDirectory;
    }
  } catch {
    // Rebuild an incomplete or stale offline config template.
  }

  const stagingDirectory = `${targetDirectory}.staging-${process.pid}`;
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  try {
    writeFileSync(
      join(stagingDirectory, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            [opencodePluginPackage]: opencodeVersion,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(join(stagingDirectory, ".gitignore"), "node_modules\n");
    const npm = npmInvocation(projectDir);
    const environment = { ...process.env };
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    const result = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        "install",
        "--ignore-scripts",
        "--bin-links=false",
        "--omit=dev",
        "--omit=optional",
        "--no-audit",
        "--no-fund",
        "--save-exact",
      ],
      {
        cwd: stagingDirectory,
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Unable to prepare bundled OpenCode config: ${
          result.error?.message ||
          result.stderr ||
          result.stdout ||
          `npm exited with ${result.status}`
        }`,
      );
    }
    rmSync(targetDirectory, { recursive: true, force: true });
    mkdirSync(join(targetDirectory, ".."), { recursive: true });
    renameSync(stagingDirectory, targetDirectory);
    return targetDirectory;
  } finally {
    if (existsSync(stagingDirectory)) {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }
}

module.exports = {
  opencodeVersion,
  prepareBundledOpenCodeConfig,
};
