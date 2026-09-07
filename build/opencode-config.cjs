const { existsSync } = require("node:fs");
const {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const opencodeVersion = "1.18.29";
const opencodePluginPackage = "@opencode-ai/plugin";

function npmInvocation() {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return { command: process.execPath, prefixArgs: [npmCli] };
  }
  if (process.platform === "win32") {
    throw new Error("npm_execpath is required to prepare OpenCode config");
  }
  return { command: "npm", prefixArgs: [] };
}

function pluginIntegrity(projectDir) {
  const lock = JSON.parse(
    readFileSync(join(projectDir, "package-lock.json"), "utf8"),
  );
  const entry = lock.packages?.[`node_modules/${opencodePluginPackage}`];
  if (
    entry?.version !== opencodeVersion ||
    typeof entry.integrity !== "string"
  ) {
    throw new Error(
      `Missing locked ${opencodePluginPackage}@${opencodeVersion} integrity`,
    );
  }
  return entry.integrity;
}

function prepareBundledOpenCodeConfig(projectDir) {
  const targetDirectory = join(
    projectDir,
    ".runtime-resources",
    "opencode-config",
  );
  const identity = {
    packageName: opencodePluginPackage,
    version: opencodeVersion,
    integrity: pluginIntegrity(projectDir),
  };
  const markerPath = join(targetDirectory, ".goodbuddy-ready.json");
  try {
    const ready = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      ready.packageName === identity.packageName &&
      ready.version === identity.version &&
      ready.integrity === identity.integrity &&
      statSync(
        join(
          targetDirectory,
          "node_modules",
          "@opencode-ai",
          "plugin",
          "package.json",
        ),
      ).isFile()
    ) {
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
    const npm = npmInvocation();
    const environment = { ...process.env };
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    const result = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        "install",
        "--ignore-scripts",
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
    writeFileSync(
      join(stagingDirectory, ".goodbuddy-ready.json"),
      `${JSON.stringify(identity)}\n`,
      "utf8",
    );
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
