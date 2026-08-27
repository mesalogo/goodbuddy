export function readFileAsDataUrl(
  file: Blob,
  mimeType: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort)
      reader.onload = null
      reader.onerror = null
      reader.onabort = null
    }
    const fail = (): void => {
      cleanup()
      reject(new Error('File could not be read'))
    }
    const abort = (): void => {
      reader.abort()
    }

    if (signal?.aborted) {
      fail()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        fail()
        return
      }
      const separatorIndex = reader.result.indexOf(',')
      if (separatorIndex < 0) {
        fail()
        return
      }
      const dataUrl =
        `data:${mimeType};base64,${reader.result.slice(separatorIndex + 1)}`
      cleanup()
      resolve(dataUrl)
    }
    reader.onerror = fail
    reader.onabort = fail
    reader.readAsDataURL(file)
  })
}

export function loadImageDimensions(
  source: string,
  signal?: AbortSignal
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const cleanup = (): void => {
      signal?.removeEventListener('abort', abort)
      image.onload = null
      image.onerror = null
    }
    const abort = (): void => {
      cleanup()
      image.src = ''
      reject(new Error('Image loading was cancelled'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      cleanup()
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight
      })
    }
    image.onerror = () => {
      cleanup()
      reject(new Error('Image could not be decoded'))
    }
    image.src = source
  })
}
