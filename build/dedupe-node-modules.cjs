const { createHash } = require('node:crypto');
const { cp, mkdir, readdir, readFile, rename, rm } = require('node:fs/promises');
const { dirname, join, relative, sep } = require('node:path');

// Collapse byte-identical copies of the same package that npm nested under many
// parents into one copy in the root node_modules.
//
// Safety rules:
// - Only packages whose name and version match their manifest, with no `bin`,
//   no `dsh` plugin metadata, no symlinks and no nested node_modules are moved
//   or removed. Plugins stay where the official loader found them.
// - Copies are compared by content (relative path and bytes of every file).
// - Resolution is modelled with Node's node_modules lookup. A copy is removed
//   only if every package that declares this dependency still resolves to
//   identical content afterwards, and the surviving root copy still resolves
//   its own dependencies to the same content as before. Anything else stays.

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

function keyOf(root, directory) {
  return relative(root, directory).split(sep).join('/');
}

async function scanTree(directory) {
  const files = [];
  let unsafe = false;
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) unsafe = true;
      else if (entry.isDirectory()) {
        if (entry.name === 'node_modules') unsafe = true;
        else await visit(path);
      } else files.push(path);
    }
  }
  await visit(directory);
  return { files: files.sort(), unsafe };
}

async function fingerprint(directory, files) {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const content = await readFile(file);
    bytes += content.length;
    hash.update(relative(directory, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), bytes };
}

async function discover(root) {
  const instances = new Map();
  async function packageAt(directory, name) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { return; }
    const dependencies = new Set();
    for (const field of DEPENDENCY_FIELDS) for (const dependency of Object.keys(manifest[field] ?? {})) dependencies.add(dependency);
    instances.set(keyOf(root, directory), {
      name, version: manifest.version, directory, dependencies: [...dependencies], label: `path:${keyOf(root, directory)}`,
      eligible: manifest.name === name && typeof manifest.version === 'string' && manifest.bin === undefined && manifest.dsh === undefined
    });
    await scan(join(directory, 'node_modules'));
  }
  async function scan(modules) {
    let entries;
    try { entries = await readdir(modules, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.startsWith('@')) {
        const scope = join(modules, entry.name);
        for (const child of await readdir(scope, { withFileTypes: true })) {
          if (child.isDirectory() && !child.isSymbolicLink()) await packageAt(join(scope, child.name), `${entry.name}/${child.name}`);
        }
      } else await packageAt(join(modules, entry.name), entry.name);
    }
  }
  await scan(join(root, 'node_modules'));
  return instances;
}

// Node searches <ancestor>/node_modules/<name> from the requiring directory upward.
function resolveLabel(root, instances, from, name) {
  for (let directory = from; ; directory = dirname(directory)) {
    const found = instances.get(keyOf(root, join(directory, 'node_modules', ...name.split('/'))));
    if (found) return found.label;
    if (directory === root || dirname(directory) === directory) return null;
  }
}

// Removing one library can make its dependents identical or movable, so repeat until stable.
async function dedupeNodeModules(root) {
  const total = { groups: 0, removedPackages: 0, removedFiles: 0, removedBytes: 0 };
  for (let pass = 0; pass < 6; pass += 1) {
    const stats = await dedupePass(root);
    for (const key of Object.keys(total)) total[key] += stats[key];
    if (stats.removedPackages === 0) break;
  }
  return total;
}

async function dedupePass(root) {
  const instances = await discover(root);
  const bySpec = new Map();
  for (const instance of instances.values()) {
    if (!instance.eligible) continue;
    const spec = `${instance.name}@${instance.version}`;
    if (!bySpec.has(spec)) bySpec.set(spec, []);
    bySpec.get(spec).push(instance);
  }
  const groups = [];
  for (const members of bySpec.values()) {
    if (members.length < 2) continue;
    const byContent = new Map();
    for (const member of members) {
      const tree = await scanTree(member.directory);
      if (tree.unsafe) continue;
      const { hash, bytes } = await fingerprint(member.directory, tree.files);
      if (!byContent.has(hash)) byContent.set(hash, []);
      byContent.get(hash).push({ member, files: tree.files.length, bytes, hash });
    }
    for (const same of byContent.values()) {
      if (same.length < 2) continue;
      const label = `${same[0].member.name}@${same[0].member.version}#${same[0].hash.slice(0, 20)}`;
      for (const entry of same) entry.member.label = label;
      groups.push({ label, entries: same });
    }
  }
  groups.sort((a, b) => b.entries.length * b.entries[0].bytes - a.entries.length * a.entries[0].bytes);

  const stats = { groups: 0, removedPackages: 0, removedFiles: 0, removedBytes: 0 };
  for (const group of groups) {
    const { name } = group.entries[0].member;
    const target = join(root, 'node_modules', ...name.split('/'));
    const targetKey = keyOf(root, target);
    const atRoot = group.entries.find((entry) => entry.member.directory === target);
    if (!atRoot && instances.has(targetKey)) continue; // A different package already owns the root slot.
    const live = group.entries.filter((entry) => instances.get(keyOf(root, entry.member.directory)) === entry.member);
    if (live.length < 2) continue;

    // Consumers: every package declaring this name, with its resolution before any change.
    const consumers = [...instances.values()].filter((instance) => instance.dependencies.includes(name));
    const baseline = new Map(consumers.map((instance) => [instance, resolveLabel(root, instances, instance.directory, name)]));
    const stillSame = (staged, ignored) => consumers.every((consumer) => (
      ignored.has(consumer) || resolveLabel(root, staged, consumer.directory, name) === baseline.get(consumer)
    ));

    // Pick the copy that becomes the root copy: its own dependencies must resolve identically from the root.
    let canonical = atRoot;
    if (!canonical) {
      canonical = live.find((entry) => {
        const staged = new Map(instances);
        staged.delete(keyOf(root, entry.member.directory));
        staged.set(targetKey, { ...entry.member, directory: target });
        return entry.member.dependencies.every((dependency) => (
          resolveLabel(root, staged, target, dependency) === resolveLabel(root, instances, entry.member.directory, dependency)
        ));
      });
      if (!canonical) continue;
    }
    const moved = canonical.member.directory !== target;
    const removed = [];
    const staged = new Map(instances);
    if (moved) {
      staged.delete(keyOf(root, canonical.member.directory));
      staged.set(targetKey, { ...canonical.member, directory: target });
    }
    // The moved copy's own lookups are unchanged; consumers that ARE group members are judged individually below.
    for (const entry of live) {
      if (entry === canonical) continue;
      const key = keyOf(root, entry.member.directory);
      const next = new Map(staged);
      next.delete(key);
      const ignored = new Set(removed.map((item) => item.member));
      ignored.add(entry.member);
      if (stillSame(next, ignored)) {
        staged.delete(key);
        removed.push(entry);
      }
    }
    // Consumers that were group members and moved/removed do not resolve this name for others.
    if (removed.length === 0 && !moved) continue;
    // Moving without removing anything only helps if at least one copy goes away.
    if (removed.length === 0) continue;
    if (!stillSame(staged, new Set([...removed.map((item) => item.member), canonical.member]))) continue;

    for (const entry of removed) {
      await rm(entry.member.directory, { recursive: true, force: true });
      instances.delete(keyOf(root, entry.member.directory));
      stats.removedPackages += 1;
      stats.removedFiles += entry.files;
      stats.removedBytes += entry.bytes;
      await pruneEmptyParents(root, dirname(entry.member.directory));
    }
    if (moved) {
      const source = canonical.member.directory;
      await mkdir(dirname(target), { recursive: true });
      try { await rename(source, target); } catch {
        await cp(source, target, { recursive: true });
        await rm(source, { recursive: true, force: true });
      }
      instances.delete(keyOf(root, source));
      canonical.member.directory = target;
      instances.set(targetKey, canonical.member);
      await pruneEmptyParents(root, dirname(source));
    }
    stats.groups += 1;
  }
  return stats;
}

async function pruneEmptyParents(root, start) {
  for (let directory = start; directory.startsWith(root) && directory !== root; directory = dirname(directory)) {
    let entries;
    try { entries = await readdir(directory); } catch { return; }
    if (entries.length > 0) return;
    await rm(directory, { recursive: true, force: true });
  }
}

module.exports = { dedupeNodeModules };
