import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const { test } = process.env.VITEST
  ? await import("vitest")
  : await import("node:test");
const source = await readFile(path.resolve("sites/release-index.js"), "utf8");
const context = vm.createContext({ URL, window: {} });
vm.runInContext(source, context, { filename: "release-index.js" });
const {
  validateReleaseIndex,
  validateLoongArchPreviewIndex,
} = context.window.GoodBuddyReleaseIndex;

const definitions = [
  ["windows", "x64", ["nsis", "portable"]],
  ["windows", "arm64", ["nsis", "portable"]],
  ["macos", "x64", ["dmg", "zip"]],
  ["macos", "arm64", ["dmg", "zip"]],
  ["linux", "x64", ["AppImage", "deb", "rpm"]],
  ["linux", "arm64", ["AppImage", "deb", "rpm"]],
];

const canonicalFileName = (version, platform, arch, format) => {
  const names = {
    "windows-x64": {
      nsis: `GoodBuddy-${version}-windows-x64-setup.exe`,
      portable: `GoodBuddy-${version}-windows-x64-portable.zip`,
    },
    "windows-arm64": {
      nsis: `GoodBuddy-${version}-windows-arm64-setup.exe`,
      portable: `GoodBuddy-${version}-windows-arm64-portable.zip`,
    },
    "macos-x64": {
      dmg: `GoodBuddy-${version}-mac-x64.dmg`,
      zip: `GoodBuddy-${version}-mac-x64.zip`,
    },
    "macos-arm64": {
      dmg: `GoodBuddy-${version}-mac-arm64.dmg`,
      zip: `GoodBuddy-${version}-mac-arm64.zip`,
    },
    "linux-x64": {
      AppImage: `GoodBuddy-${version}-linux-x86_64.AppImage`,
      deb: `GoodBuddy-${version}-linux-amd64.deb`,
      rpm: `GoodBuddy-${version}-linux-x86_64.rpm`,
    },
    "linux-arm64": {
      AppImage: `GoodBuddy-${version}-linux-arm64.AppImage`,
      deb: `GoodBuddy-${version}-linux-arm64.deb`,
      rpm: `GoodBuddy-${version}-linux-aarch64.rpm`,
    },
  };
  return names[`${platform}-${arch}`][format];
};

const validIndex = () => {
  const version = "1.2.3";
  const releaseBase =
    `https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v${version}/`;
  const targets = {};
  let fileNumber = 1;

  for (const [platform, arch, formats] of definitions) {
    const files = {};
    for (const format of formats) {
      const name = canonicalFileName(version, platform, arch, format);
      files[format] = {
        name,
        size: 1_024 * fileNumber,
        sha256: fileNumber.toString(16).padStart(64, "0"),
        url: new URL(encodeURIComponent(name), releaseBase).href,
      };
      fileNumber += 1;
    }
    targets[`${platform}-${arch}`] = { platform, arch, files };
  }

  return {
    formatVersion: 1,
    productName: "GoodBuddy",
    version,
    targets,
    checksumUrl: new URL("SHA256SUMS", releaseBase).href,
    fallbackUrl: "https://github.com/mesalogo/goodbuddy/releases/latest",
  };
};

const expectRejected = (mutate) => {
  const index = validIndex();
  mutate(index);
  assert.throws(() => validateReleaseIndex(index));
};

const validLoongArchPreviewIndex = () => {
  const goodBuddyVersion = "1.2.3";
  const previewBase =
    `https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/loongarch-preview/v${goodBuddyVersion}/`;
  const name =
    `GoodBuddy-${goodBuddyVersion}-linux-loong64-preview.deb`;
  return {
    formatVersion: 1,
    product: "GoodBuddy LoongArch Preview",
    goodBuddyVersion,
    previewVersion: `${goodBuddyVersion}-loong64-preview.1`,
    architecture: "loong64",
    format: "deb",
    artifact: {
      name,
      size: 186_000_000,
      sha256: "a".repeat(64),
      url: new URL(encodeURIComponent(name), previewBase).href,
    },
    manifestUrl: new URL("preview-manifest.json", previewBase).href,
    checksumUrl: new URL("SHA256SUMS", previewBase).href,
  };
};

const expectLoongArchPreviewRejected = (mutate) => {
  const index = validLoongArchPreviewIndex();
  mutate(index);
  assert.throws(() => validateLoongArchPreviewIndex(index));
};

test("accepts the canonical stable six-target release index", () => {
  const index = validIndex();
  assert.equal(validateReleaseIndex(index), index);
});

test("rejects unstable or non-strict versions and extra top-level fields", () => {
  for (const version of ["v1.2.3", "01.2.3", "1.2", "1.2.3-rc.1"]) {
    expectRejected((index) => {
      index.version = version;
    });
  }
  expectRejected((index) => {
    index.unexpected = true;
  });
});

test("requires the exact six target keys and matching platform metadata", () => {
  expectRejected((index) => {
    delete index.targets["linux-arm64"];
  });
  expectRejected((index) => {
    index.targets["linux-arm64"].platform = "windows";
  });
  expectRejected((index) => {
    index.targets["unexpected-x64"] = index.targets["linux-arm64"];
  });
});

test("requires exact formats, extensions, positive safe sizes, and SHA-256", () => {
  expectRejected((index) => {
    index.targets["windows-x64"].files.nsis.name = "GoodBuddy-1.2.3.zip";
  });
  expectRejected((index) => {
    index.targets["macos-arm64"].files.extra =
      index.targets["macos-arm64"].files.zip;
  });
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expectRejected((index) => {
      index.targets["linux-x64"].files.deb.size = size;
    });
  }
  expectRejected((index) => {
    index.targets["linux-x64"].files.deb.sha256 = "A".repeat(64);
  });
});

test("binds every filename to the indexed release version", () => {
  expectRejected((index) => {
    const file = index.targets["macos-arm64"].files.dmg;
    file.name = file.name.replace(index.version, "1.2.2");
    file.url = new URL(
      encodeURIComponent(file.name),
      `https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v${index.version}/`,
    ).href;
  });
});

test("binds filenames to their target platform and architecture", () => {
  expectRejected((index) => {
    const file = index.targets["macos-x64"].files.zip;
    file.name = file.name.replace("-mac-x64.zip", "-linux-x64.zip");
    file.url = new URL(
      encodeURIComponent(file.name),
      `https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/v${index.version}/`,
    ).href;
  });

  expectRejected((index) => {
    const x64Files = index.targets["linux-x64"].files;
    index.targets["linux-x64"].files =
      index.targets["linux-arm64"].files;
    index.targets["linux-arm64"].files = x64Files;
  });
});

test("rejects swapped x64 and arm64 target records", () => {
  expectRejected((index) => {
    const x64Target = index.targets["windows-x64"];
    index.targets["windows-x64"] = index.targets["windows-arm64"];
    index.targets["windows-arm64"] = x64Target;
  });
});

test("rejects duplicate files and any non-canonical release URL", () => {
  expectRejected((index) => {
    const duplicate = index.targets["windows-x64"].files.nsis;
    index.targets["windows-arm64"].files.nsis.name = duplicate.name;
    index.targets["windows-arm64"].files.nsis.url = duplicate.url;
  });

  for (const changeUrl of [
    (url) => url.replace("https://", "http://"),
    (url) => url.replace("goodbuddy.", "user:pass@goodbuddy."),
    (url) => url.replace(".com/", ".com:444/"),
    (url) => `${url}?download=1`,
    (url) => `${url}#asset`,
    (url) => url.replace("/releases/v1.2.3/", "/releases/v9.9.9/"),
    (url) => url.replace("GoodBuddy-", "OtherBuddy-"),
  ]) {
    expectRejected((index) => {
      const file = index.targets["linux-arm64"].files.AppImage;
      file.url = changeUrl(file.url);
    });
  }
});

test("requires exact checksum and GitHub fallback URLs", () => {
  expectRejected((index) => {
    index.checksumUrl += "?raw=1";
  });
  expectRejected((index) => {
    index.fallbackUrl = "https://github.com/mesalogo/goodbuddy/releases";
  });
});

test("accepts the isolated immutable LoongArch preview index", () => {
  const index = validLoongArchPreviewIndex();
  assert.equal(validateLoongArchPreviewIndex(index), index);
});

test("binds the LoongArch preview to its stable version and exact OSS prefix", () => {
  for (const version of ["v1.2.3", "1.2.3-rc.1", "1.2"]) {
    expectLoongArchPreviewRejected((index) => {
      index.goodBuddyVersion = version;
    });
  }
  expectLoongArchPreviewRejected((index) => {
    index.previewVersion = "1.2.3-loong64-preview.0";
  });
  expectLoongArchPreviewRejected((index) => {
    index.artifact.url = index.artifact.url.replace(
      "/releases/loongarch-preview/v1.2.3/",
      "/releases/v1.2.3/",
    );
  });
  expectLoongArchPreviewRejected((index) => {
    index.manifestUrl += "?download=1";
  });
  expectLoongArchPreviewRejected((index) => {
    index.unexpected = true;
  });
});

test("requires one canonical LoongArch DEB with bounded metadata", () => {
  expectLoongArchPreviewRejected((index) => {
    index.architecture = "arm64";
  });
  expectLoongArchPreviewRejected((index) => {
    index.format = "rpm";
  });
  expectLoongArchPreviewRejected((index) => {
    index.artifact.name = "GoodBuddy-1.2.3-linux-loong64.deb";
  });
  expectLoongArchPreviewRejected((index) => {
    index.artifact.size = 0;
  });
  expectLoongArchPreviewRejected((index) => {
    index.artifact.sha256 = "A".repeat(64);
  });
});
