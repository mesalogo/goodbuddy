const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')

function sha256File(filePath) {
  const hash = createHash('sha256')
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

module.exports = { sha256File }
