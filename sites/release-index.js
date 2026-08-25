(() => {
  "use strict";

  const mirrorIndexUrl =
    "https://goodbuddy.oss-cn-beijing.aliyuncs.com/releases/latest.json";
  const fallbackUrl =
    "https://github.com/mesalogo/goodbuddy/releases/latest";
  const maximumIndexBytes = 512 * 1024;
  const semVerPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+((?:[0-9a-zA-Z-]+)(?:\.[0-9a-zA-Z-]+)*))?$/u;
  const sha256Pattern = /^[a-f0-9]{64}$/u;
  const safeFileNamePattern = /^(?!\.{1,2}$)[^/\\\0]+$/u;
  const targetDefinitions = Object.freeze({
    "windows-x64": Object.freeze({
      platform: "windows",
      arch: "x64",
      formats: Object.freeze(["nsis", "portable"]),
    }),
    "windows-arm64": Object.freeze({
      platform: "windows",
      arch: "arm64",
      formats: Object.freeze(["nsis", "portable"]),
    }),
    "macos-x64": Object.freeze({
      platform: "macos",
      arch: "x64",
      formats: Object.freeze(["dmg", "zip"]),
    }),
    "macos-arm64": Object.freeze({
      platform: "macos",
      arch: "arm64",
      formats: Object.freeze(["dmg", "zip"]),
    }),
    "linux-x64": Object.freeze({
      platform: "linux",
      arch: "x64",
      formats: Object.freeze(["AppImage", "deb", "rpm"]),
    }),
    "linux-arm64": Object.freeze({
      platform: "linux",
      arch: "arm64",
      formats: Object.freeze(["AppImage", "deb", "rpm"]),
    }),
  });
  const targetKeys = Object.freeze(Object.keys(targetDefinitions));

  const isRecord = (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value);

  const hasExactKeys = (value, keys) => {
    if (!isRecord(value)) {
      return false;
    }
    const actualKeys = Object.keys(value);
    return (
      actualKeys.length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    );
  };

  const assert = (condition, message) => {
    if (!condition) {
      throw new Error(message);
    }
  };

  const canonicalFileName = (version, platform, arch, format) => {
    if (platform === "windows" && format === "nsis") {
      return `GoodBuddy-${version}-windows-${arch}-setup.exe`;
    }
    if (platform === "windows" && format === "portable") {
      return `GoodBuddy-${version}-windows-${arch}-portable.zip`;
    }

    if (platform === "macos") {
      return `GoodBuddy-${version}-mac-${arch}.${format}`;
    }

    const artifactArch =
      arch === "x64"
        ? format === "deb"
          ? "amd64"
          : "x86_64"
        : format === "rpm"
          ? "aarch64"
          : "arm64";
    return `GoodBuddy-${version}-linux-${artifactArch}.${format}`;
  };

  const assertExactUrl = (value, expected, label) => {
    assert(typeof value === "string" && value.length <= 2_048, `${label} 无效`);
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${label} 无效`);
    }
    assert(
      value === expected &&
        url.href === expected &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash,
      `${label} 不是受信任的正式地址`,
    );
  };

  const validateReleaseIndex = (index) => {
    assert(
      hasExactKeys(index, [
        "formatVersion",
        "productName",
        "version",
        "targets",
        "checksumUrl",
        "fallbackUrl",
      ]),
      "发布索引结构无效",
    );
    assert(index.formatVersion === 1, "发布索引版本无效");
    assert(index.productName === "GoodBuddy", "发布索引产品名称无效");
    assert(
      typeof index.version === "string" && index.version.length <= 256,
      "发布版本无效",
    );
    const parsedVersion = semVerPattern.exec(index.version);
    assert(parsedVersion && !parsedVersion[4], "发布索引必须指向稳定 SemVer 版本");
    assert(
      hasExactKeys(index.targets, targetKeys),
      "发布索引必须包含且仅包含六个平台目标",
    );

    const releaseBase = new URL(`v${index.version}/`, mirrorIndexUrl);
    const seenNames = new Set();
    const seenUrls = new Set();

    for (const key of targetKeys) {
      const definition = targetDefinitions[key];
      const target = index.targets[key];
      assert(
        hasExactKeys(target, ["platform", "arch", "files"]) &&
          target.platform === definition.platform &&
          target.arch === definition.arch,
        `发布目标与键不匹配：${key}`,
      );
      assert(
        hasExactKeys(target.files, definition.formats),
        `发布目标文件格式无效：${key}`,
      );

      for (const format of definition.formats) {
        const file = target.files[format];
        assert(
          hasExactKeys(file, ["name", "size", "sha256", "url"]),
          `发布文件结构无效：${key}/${format}`,
        );
        assert(
          typeof file.name === "string" &&
            file.name.length >= 1 &&
            file.name.length <= 255 &&
            safeFileNamePattern.test(file.name) &&
            file.name ===
              canonicalFileName(
                index.version,
                target.platform,
                target.arch,
                format,
              ),
          `发布文件名或扩展名无效：${key}/${format}`,
        );
        assert(
          Number.isSafeInteger(file.size) && file.size > 0,
          `发布文件大小无效：${key}/${format}`,
        );
        assert(
          typeof file.sha256 === "string" && sha256Pattern.test(file.sha256),
          `发布文件校验值无效：${key}/${format}`,
        );
        assert(!seenNames.has(file.name), `发布文件名重复：${file.name}`);
        seenNames.add(file.name);

        const expectedUrl = new URL(
          encodeURIComponent(file.name),
          releaseBase,
        ).href;
        assertExactUrl(file.url, expectedUrl, "发布文件地址");
        assert(!seenUrls.has(file.url), `发布文件地址重复：${file.url}`);
        seenUrls.add(file.url);
      }
    }

    assertExactUrl(
      index.checksumUrl,
      new URL("SHA256SUMS", releaseBase).href,
      "校验清单地址",
    );
    assertExactUrl(index.fallbackUrl, fallbackUrl, "GitHub 回退地址");
    return index;
  };

  window.GoodBuddyReleaseIndex = Object.freeze({
    maximumIndexBytes,
    validateReleaseIndex,
  });
})();
