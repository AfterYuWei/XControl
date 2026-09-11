import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const inputPath = process.argv[2]
const radiusRatio = Number(process.argv[3] ?? '0.22')

if (!inputPath) throw new Error('Usage: node scripts/round-app-icon.mjs <png> [radius-ratio]')
if (!Number.isFinite(radiusRatio) || radiusRatio <= 0 || radiusRatio >= 0.5) {
  throw new Error(`radius-ratio must be between 0 and 0.5, received ${process.argv[3]}`)
}

const source = readFileSync(inputPath)
if (!source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
  throw new Error(`${inputPath} is not a PNG file`)
}

let offset = PNG_SIGNATURE.length
let width = 0
let height = 0
let bitDepth = 0
let colorType = 0
let interlace = 0
const imageDataChunks = []

while (offset < source.length) {
  const length = source.readUInt32BE(offset)
  const type = source.toString('ascii', offset + 4, offset + 8)
  const data = source.subarray(offset + 8, offset + 8 + length)
  offset += length + 12

  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
    bitDepth = data[8]
    colorType = data[9]
    interlace = data[12]
  } else if (type === 'IDAT') {
    imageDataChunks.push(data)
  } else if (type === 'IEND') {
    break
  }
}

if (!width || width !== height) throw new Error('App icon must be a non-empty square PNG')
if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
  throw new Error('Only non-interlaced 8-bit RGB or RGBA PNG files are supported')
}

const bytesPerPixel = colorType === 2 ? 3 : 4
const stride = width * bytesPerPixel
const compressed = Buffer.concat(imageDataChunks)
const filtered = inflateSync(compressed)
const pixels = Buffer.alloc(width * height * bytesPerPixel)
let filteredOffset = 0
let previousRow = Buffer.alloc(stride)

for (let y = 0; y < height; y += 1) {
  const filter = filtered[filteredOffset]
  filteredOffset += 1
  const row = Buffer.from(filtered.subarray(filteredOffset, filteredOffset + stride))
  filteredOffset += stride

  for (let x = 0; x < stride; x += 1) {
    const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
    const above = previousRow[x]
    const upperLeft = x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0
    let predictor = 0

    if (filter === 1) predictor = left
    else if (filter === 2) predictor = above
    else if (filter === 3) predictor = Math.floor((left + above) / 2)
    else if (filter === 4) predictor = paeth(left, above, upperLeft)
    else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`)

    row[x] = (row[x] + predictor) & 0xff
  }

  row.copy(pixels, y * stride)
  previousRow = row
}

const radius = width * radiusRatio
const rgbaStride = width * 4
const unfilteredRgba = Buffer.alloc(height * (rgbaStride + 1))

for (let y = 0; y < height; y += 1) {
  const outputRow = y * (rgbaStride + 1)
  unfilteredRgba[outputRow] = 0

  for (let x = 0; x < width; x += 1) {
    const sourcePixel = y * stride + x * bytesPerPixel
    const outputPixel = outputRow + 1 + x * 4
    const sourceAlpha = colorType === 6 ? pixels[sourcePixel + 3] : 255
    const coverage = roundedRectCoverage(x, y, width, height, radius)

    unfilteredRgba[outputPixel] = pixels[sourcePixel]
    unfilteredRgba[outputPixel + 1] = pixels[sourcePixel + 1]
    unfilteredRgba[outputPixel + 2] = pixels[sourcePixel + 2]
    unfilteredRgba[outputPixel + 3] = Math.round(sourceAlpha * coverage)
  }
}

const header = Buffer.alloc(13)
header.writeUInt32BE(width, 0)
header.writeUInt32BE(height, 4)
header[8] = 8
header[9] = 6
header[10] = 0
header[11] = 0
header[12] = 0

const roundedPng = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(unfilteredRgba, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0)),
])

writeFileSync(inputPath, roundedPng)
console.log(`Rounded ${inputPath}: ${width}x${height}, radius ${Math.round(radius)}px`)

function roundedRectCoverage(x, y, imageWidth, imageHeight, cornerRadius) {
  if (
    (x + 1 >= cornerRadius && x < imageWidth - cornerRadius) ||
    (y + 1 >= cornerRadius && y < imageHeight - cornerRadius)
  ) {
    return 1
  }

  const samples = 4
  let inside = 0
  for (let sampleY = 0; sampleY < samples; sampleY += 1) {
    for (let sampleX = 0; sampleX < samples; sampleX += 1) {
      const px = x + (sampleX + 0.5) / samples
      const py = y + (sampleY + 0.5) / samples
      const centerX = px < cornerRadius ? cornerRadius : imageWidth - cornerRadius
      const centerY = py < cornerRadius ? cornerRadius : imageHeight - cornerRadius
      const dx = px - centerX
      const dy = py - centerY
      if (dx * dx + dy * dy <= cornerRadius * cornerRadius) inside += 1
    }
  }
  return inside / (samples * samples)
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  if (aboveDistance <= upperLeftDistance) return above
  return upperLeft
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), data.length + 8)
  return chunk
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
