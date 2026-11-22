const { readSync } = require('node:fs')

const localFileHeaderSignature = 0x04034b50
const centralDirectoryHeaderSignature = 0x02014b50
const endOfCentralDirectorySignature = 0x06054b50

function readExactZipBytes(handle, length, position, label) {
  const output = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const bytesRead = readSync(
      handle,
      output,
      offset,
      length - offset,
      position + offset
    )
    if (bytesRead <= 0) {
      throw new Error(`${label} is truncated`)
    }
    offset += bytesRead
  }
  return output
}

function readZipCentralDirectory(handle, archiveSize, limits) {
  if (archiveSize < 22) {
    throw new Error(`${limits.label} central directory is missing`)
  }
  const endSize = Math.min(archiveSize, 65_557)
  const endStart = archiveSize - endSize
  const end = readExactZipBytes(
    handle,
    endSize,
    endStart,
    `${limits.label} end record`
  )
  let endOffset = -1
  for (let index = end.length - 22; index >= 0; index -= 1) {
    if (
      end.readUInt32LE(index) === endOfCentralDirectorySignature &&
      index + 22 + end.readUInt16LE(index + 20) === end.length
    ) {
      endOffset = index
      break
    }
  }
  if (endOffset < 0) {
    throw new Error(`${limits.label} central directory is missing`)
  }
  let diskNumber = end.readUInt16LE(endOffset + 4)
  let centralDisk = end.readUInt16LE(endOffset + 6)
  let diskEntryCount = end.readUInt16LE(endOffset + 8)
  let entryCount = end.readUInt16LE(endOffset + 10)
  let centralSize = end.readUInt32LE(endOffset + 12)
  let centralOffset = end.readUInt32LE(endOffset + 16)
  let absoluteEndOffset = endStart + endOffset
  // MakeAppx emits ZIP64 directory records even for small packages. This opt-in
  // is for listing MSIX names only; extraction callers retain classic ZIP rules.
  if (limits.zip64DirectoryListing && absoluteEndOffset >= 20) {
    const locator = readExactZipBytes(handle, 20, absoluteEndOffset - 20, limits.label)
    if (locator.readUInt32LE(0) === 0x07064b50) {
      const number64 = (buffer, offset) => {
        const value = buffer.readBigUInt64LE(offset)
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${limits.label} ZIP64 value exceeds safe bounds`)
        return Number(value)
      }
      const recordOffset = number64(locator, 8)
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1 || recordOffset > absoluteEndOffset - 76) {
        throw new Error(`${limits.label} ZIP64 locator is invalid`)
      }
      const record = readExactZipBytes(handle, 56, recordOffset, limits.label)
      if (record.readUInt32LE(0) !== 0x06064b50 || recordOffset + 12 + number64(record, 4) !== absoluteEndOffset - 20 ||
          record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
        throw new Error(`${limits.label} ZIP64 end record is invalid`)
      }
      diskEntryCount = number64(record, 24)
      entryCount = number64(record, 32)
      diskNumber = record.readUInt32LE(16)
      centralDisk = record.readUInt32LE(20)
      centralSize = number64(record, 40)
      centralOffset = number64(record, 48)
      absoluteEndOffset = recordOffset
    }
  }
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0 ||
    entryCount === 0xffff ||
    entryCount < limits.minimumEntries ||
    entryCount > limits.maximumEntries ||
    centralSize === 0xffffffff ||
    centralSize < 46 ||
    centralSize > limits.maximumCentralDirectoryBytes ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== absoluteEndOffset
  ) {
    throw new Error(`${limits.label} central directory is invalid`)
  }
  const central = readExactZipBytes(
    handle,
    centralSize,
    centralOffset,
    `${limits.label} central directory`
  )
  const entries = []
  let offset = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > central.length ||
      central.readUInt32LE(offset) !==
        centralDirectoryHeaderSignature
    ) {
      throw new Error(
        `${limits.label} central directory entry is invalid`
      )
    }
    const nameLength = central.readUInt16LE(offset + 28)
    const extraLength = central.readUInt16LE(offset + 30)
    const commentLength = central.readUInt16LE(offset + 32)
    const entryLength =
      46 + nameLength + extraLength + commentLength
    if (offset + entryLength > central.length) {
      throw new Error(
        `${limits.label} central directory entry exceeds its bounds`
      )
    }
    const flags = central.readUInt16LE(offset + 8)
    const nameBytes = central.subarray(
      offset + 46,
      offset + 46 + nameLength
    )
    const name = new TextDecoder(
      flags & 0x0800 ? 'utf-8' : 'latin1',
      { fatal: true }
    ).decode(nameBytes)
    entries.push({
      name,
      nameBytes: Buffer.from(nameBytes),
      flags,
      compression: central.readUInt16LE(offset + 10),
      checksum: central.readUInt32LE(offset + 16),
      compressedSize: central.readUInt32LE(offset + 20),
      size: central.readUInt32LE(offset + 24),
      diskStart: central.readUInt16LE(offset + 34),
      localOffset: central.readUInt32LE(offset + 42)
    })
    offset += entryLength
  }
  if (offset !== central.length) {
    throw new Error(
      `${limits.label} central directory count is invalid`
    )
  }
  return {
    centralOffset,
    entries
  }
}

module.exports = {
  centralDirectoryHeaderSignature,
  endOfCentralDirectorySignature,
  localFileHeaderSignature,
  readExactZipBytes,
  readZipCentralDirectory
}
