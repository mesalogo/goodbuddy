// Apple also inspects Mach-O files inside wheels. Sign only the packaged copy,
// leaving the verified download cache and upstream artifact locks unchanged.
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { basename, join } = require("node:path");
const { promisify } = require("node:util");
const { unzipSync, zipSync } = require("fflate");

const execute = promisify(execFile);
const machoMagic = new Set([
  "feedface", "cefaedfe", "feedfacf", "cffaedfe",
  "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
]);

function isMachO(bytes) {
  return bytes.length >= 4 && machoMagic.has(Buffer.from(bytes.subarray(0, 4)).toString("hex"));
}

function recordField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

async function signWheel(wheelPath, signBinary) {
  const entries = unzipSync(await readFile(wheelPath));
  const binaries = Object.keys(entries).filter((name) => isMachO(entries[name]));
  if (binaries.length === 0) return false;
  const records = Object.keys(entries).filter((name) => name.endsWith(".dist-info/RECORD"));
  if (records.length !== 1) throw new Error(`Expected one wheel RECORD: ${basename(wheelPath)}`);
  const record = records[0];
  if (entries[`${record}.jws`] || entries[`${record}.p7s`]) {
    throw new Error(`Cannot rewrite an independently signed wheel: ${basename(wheelPath)}`);
  }
  const stagingRoot = join(__dirname, "..", "temp", "macos-wheel-signing");
  await mkdir(stagingRoot, { recursive: true });
  const directory = await mkdtemp(join(stagingRoot, "wheel-"));
  try {
    for (const [index, name] of binaries.entries()) {
      const file = join(directory, `${index}-${basename(name)}`);
      await writeFile(file, entries[name], { mode: 0o755 });
      await signBinary(file);
      entries[name] = new Uint8Array(await readFile(file));
    }
    const rows = Object.entries(entries)
      .filter(([name]) => !name.endsWith("/") && name !== record)
      .map(([name, bytes]) => {
        const digest = createHash("sha256").update(bytes).digest("base64url");
        return `${recordField(name)},sha256=${digest},${bytes.length}`;
      });
    rows.push(`${recordField(record)},,`);
    entries[record] = new TextEncoder().encode(`${rows.join("\n")}\n`);
    await writeFile(wheelPath, zipSync(entries));
    return true;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function sign(options) {
  const wheels = join(options.app, "Contents", "Resources", "runtimes", "wecom", "wheels");
  const names = await readdir(wheels).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (names.some((name) => name.endsWith(".whl")) && !options.identity) {
    throw new Error("A signing identity is required for packaged WeCom wheels");
  }
  for (const name of names.filter((name) => name.endsWith(".whl"))) {
    await signWheel(join(wheels, name), async (binary) => {
      const args = ["--force", "--sign", options.identity, "--timestamp", "--options", "runtime"];
      if (options.keychain) args.push("--keychain", options.keychain);
      await execute("/usr/bin/codesign", [...args, binary]);
      await execute("/usr/bin/codesign", ["--verify", "--strict", binary]);
    });
  }
  // Preserve electron-builder's normal signing, entitlements and retry behavior.
  await require("app-builder-lib/out/codeSign/macCodeSign").sign(options);
}

module.exports = { sign, signWheel, isMachO };
