export type IntranetCompatibilityReader = () => boolean

let readIntranetCompatibility: IntranetCompatibilityReader = () => true

export function isIntranetCompatibilityEnabled(): boolean {
  return readIntranetCompatibility()
}

export function setIntranetCompatibilityReader(
  reader: IntranetCompatibilityReader
): void {
  readIntranetCompatibility = reader
}
