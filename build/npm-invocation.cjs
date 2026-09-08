const { existsSync } = require("node:fs");
const { join } = require("node:path");

function npmInvocation(projectDir, environment = process.env) {
  const npmCli = environment.npm_execpath;
  if (npmCli) {
    return {
      command: process.execPath,
      prefixArgs: [npmCli],
    };
  }

  const bundledNpmCli = join(
    projectDir,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (existsSync(bundledNpmCli)) {
    return {
      command: process.execPath,
      prefixArgs: [bundledNpmCli],
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    prefixArgs: [],
  };
}

module.exports = { npmInvocation };
