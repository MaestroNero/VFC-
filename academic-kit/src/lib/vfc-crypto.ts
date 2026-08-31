import { vfcTrace } from '../data/vfc-trace'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ b[i]
  }
  return out
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0)
  const res = new Uint8Array(totalLen)
  let offset = 0
  for (const arr of arrays) {
    res.set(arr, offset)
    offset += arr.length
  }
  return res
}

// ---------------------------------------------------------------------------
// VFC Key Derivation (PBKDF2)
// ---------------------------------------------------------------------------

export interface DeriveVFCOptions {
  frameNumber?: number
  randomSaltHex?: string
}

export async function deriveVFCKeys(password: string, fingerprintHex: string, options?: DeriveVFCOptions) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )

  const fingerprintBytes = hexToBytes(fingerprintHex)
  const frameNo = options?.frameNumber ?? 30
  const frameNoBytes = new Uint8Array([(frameNo >> 24) & 0xff, (frameNo >> 16) & 0xff, (frameNo >> 8) & 0xff, frameNo & 0xff])
  const randomSalt = hexToBytes(options?.randomSaltHex ?? '00112233445566778899aabbccddeeff')

  const embedSalt = concatBytes(enc.encode('VFC-EMBED'), fingerprintBytes, frameNoBytes)
  const encSalt = concatBytes(enc.encode('VFC-ENCRYPT'), fingerprintBytes, frameNoBytes, randomSalt)
  const authSalt = concatBytes(enc.encode('VFC-AUTH'), fingerprintBytes, frameNoBytes, randomSalt)

  const getBits = async (salt: Uint8Array) => {
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: salt as unknown as BufferSource,
        iterations: 200000,
      },
      keyMaterial,
      256
    )
    return new Uint8Array(bits)
  }

  const [kEmbed, kEnc, kAuth] = await Promise.all([
    getBits(embedSalt),
    getBits(encSalt),
    getBits(authSalt),
  ])

  return { kEmbed, kEnc, kAuth }
}

// ---------------------------------------------------------------------------
// VFC SPN-128 Cipher implementation
// ---------------------------------------------------------------------------

function gmul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const high = a & 0x80
    a = (a << 1) & 0xff
    if (high) a ^= 0x1b
    b >>= 1
  }
  return p
}

const SBOX = vfcTrace.cipher.sbox
const MDS = vfcTrace.cipher.mds

function toState(block: Uint8Array): number[][] {
  const state = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      state[r][c] = block[c * 4 + r]
    }
  }
  return state
}

function fromState(state: number[][]): Uint8Array {
  const block = new Uint8Array(16)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      block[c * 4 + r] = state[r][c]
    }
  }
  return block
}

function subBytes(state: number[][]): number[][] {
  return state.map((row) => row.map((val) => SBOX[val]))
}

function shiftRows(state: number[][]): number[][] {
  return state.map((row, r) => [...row.slice(r), ...row.slice(0, r)])
}

function mixColumns(state: number[][]): number[][] {
  const out = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  for (let c = 0; c < 4; c++) {
    const col = [state[0][c], state[1][c], state[2][c], state[3][c]]
    for (let r = 0; r < 4; r++) {
      out[r][c] =
        gmul(MDS[r][0], col[0]) ^
        gmul(MDS[r][1], col[1]) ^
        gmul(MDS[r][2], col[2]) ^
        gmul(MDS[r][3], col[3])
    }
  }
  return out
}

function addRoundKey(state: number[][], rk: Uint8Array): number[][] {
  const rks = toState(rk)
  return state.map((row, r) => row.map((val, c) => val ^ rks[r][c]))
}

export async function getRoundKeys(kEnc: Uint8Array): Promise<Uint8Array[]> {
  const rks: Uint8Array[] = []
  for (let i = 0; i <= 6; i++) {
    const msg = concatBytes(kEnc, stringToBytes('VFC-RK'), new Uint8Array([0, i]))
    const hashBuffer = await crypto.subtle.digest('SHA-256', msg as unknown as BufferSource)
    rks.push(new Uint8Array(hashBuffer).slice(0, 16))
  }
  return rks
}

export async function encryptVFCBlock(block: Uint8Array, roundKeys: Uint8Array[]): Promise<Uint8Array> {
  let state = addRoundKey(toState(block), roundKeys[0])
  for (let r = 1; r <= 6; r++) {
    state = subBytes(state)
    state = shiftRows(state)
    state = mixColumns(state)
    state = addRoundKey(state, roundKeys[r])
  }
  return fromState(state)
}

export function encryptVFCBlockTrace(block: Uint8Array, roundKeys: Uint8Array[]): Uint8Array[] {
  const trace: Uint8Array[] = []
  trace.push(new Uint8Array(block)) // IN
  
  let state = addRoundKey(toState(block), roundKeys[0])
  trace.push(fromState(state)) // RK0
  
  for (let r = 1; r <= 6; r++) {
    state = subBytes(state)
    state = shiftRows(state)
    state = mixColumns(state)
    state = addRoundKey(state, roundKeys[r])
    trace.push(fromState(state)) // R1 to R6
  }
  return trace
}

export function padPKCS7(data: Uint8Array, blockSize: number = 16): Uint8Array {
  const padLen = blockSize - (data.length % blockSize)
  const padding = new Uint8Array(padLen).fill(padLen)
  return concatBytes(data, padding)
}

export async function encryptVFCCbc(plaintext: Uint8Array, kEnc: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const padded = padPKCS7(plaintext)
  const roundKeys = await getRoundKeys(kEnc)
  const ciphertext = new Uint8Array(padded.length)
  let prev = iv
  for (let i = 0; i < padded.length; i += 16) {
    const block = padded.slice(i, i + 16)
    const xorBlock = xorBytes(block, prev)
    const ctBlock = await encryptVFCBlock(xorBlock, roundKeys)
    ciphertext.set(ctBlock, i)
    prev = ctBlock
  }
  return ciphertext
}

// ---------------------------------------------------------------------------
// Payload formatting & HMAC
// ---------------------------------------------------------------------------

export async function generateVFCPayload(ciphertext: Uint8Array, kEmbed: Uint8Array, kAuth: Uint8Array, iv: Uint8Array, options?: DeriveVFCOptions) {
  // 1. Magic
  const magicMsg = concatBytes(kEmbed, stringToBytes('VFC-MAGIC'))
  const magicHash = await crypto.subtle.digest('SHA-256', magicMsg as unknown as BufferSource)
  const magic = new Uint8Array(magicHash).slice(0, 4)
  
  // 2. Header
  const version = new Uint8Array([2])
  const flags = new Uint8Array([0])
  const salt = hexToBytes(options?.randomSaltHex ?? '00112233445566778899aabbccddeeff')
  const frameNo = new Uint8Array([(30 >> 24) & 0xff, (30 >> 16) & 0xff, (30 >> 8) & 0xff, 30 & 0xff])
  
  // CT len (8 bytes)
  const ctLen = new Uint8Array(8)
  const view = new DataView(ctLen.buffer)
  view.setUint32(4, ciphertext.length, false) // Big-endian
  
  const header = concatBytes(magic, version, flags, salt, iv, frameNo, ctLen)
  const authenticatedData = concatBytes(header, ciphertext)
  
  // 3. HMAC
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    kAuth as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', hmacKey, authenticatedData as unknown as BufferSource)
  const hmacTag = new Uint8Array(signature)
  
  return {
    header,
    ciphertext,
    hmacTag,
    fullPayload: concatBytes(authenticatedData, hmacTag)
  }
}

// ---------------------------------------------------------------------------
// Steganography: LSB Audio embedding
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Position generator — exact TypeScript port of vfc/prng.py
//
// Keystream: block_i = SHA256(K_embed || counter_i) with counter as Big-Endian
// uint64. Integers in [0, n) come from rejection sampling so Fisher–Yates
// stays unbiased. Blocks are prefetched in batches purely for performance;
// the byte sequence is identical to the Python implementation.
// ---------------------------------------------------------------------------

class Sha256KeyStream {
  private readonly key: Uint8Array
  private buf = new Uint8Array(0)
  private pos = 0
  private nextCounter = 0

  constructor(key: Uint8Array) {
    this.key = key
  }

  private async fill() {
    const batch = 256
    const merged = new Uint8Array(batch * 32)
    const digests: Promise<ArrayBuffer>[] = []
    for (let k = 0; k < batch; k++) {
      const counterBytes = new Uint8Array(8)
      new DataView(counterBytes.buffer).setBigUint64(0, BigInt(this.nextCounter + k), false)
      digests.push(crypto.subtle.digest('SHA-256', concatBytes(this.key, counterBytes) as unknown as BufferSource))
    }
    const results = await Promise.all(digests)
    for (let k = 0; k < batch; k++) merged.set(new Uint8Array(results[k]), k * 32)
    this.nextCounter += batch
    // Carry over any unconsumed tail so the byte stream stays continuous
    // across refills — exactly like the Python single-block KeyStream.
    const remaining = this.buf.length - this.pos
    if (remaining > 0) {
      const carried = new Uint8Array(remaining + merged.length)
      carried.set(this.buf.subarray(this.pos))
      carried.set(merged, remaining)
      this.buf = carried
    } else {
      this.buf = merged
    }
    this.pos = 0
  }

  private async ensure(byteCount: number) {
    if (this.pos + byteCount > this.buf.length) await this.fill()
  }

  async below(n: number): Promise<number> {
    if (n <= 1) return 0
    let nbytes = 1
    while (2 ** (8 * nbytes) < n) nbytes++
    const span = 2 ** (8 * nbytes)
    const bound = span - (span % n)
    for (;;) {
      await this.ensure(nbytes)
      let val = 0
      for (let i = 0; i < nbytes; i++) val = val * 256 + this.buf[this.pos++]
      if (val < bound) return val % n
    }
  }
}

export async function shuffledPositions(key: Uint8Array, eligibleIndices: number[]): Promise<number[]> {
  const idx = eligibleIndices.slice()
  const stream = new Sha256KeyStream(key)
  const n = idx.length
  for (let i = n - 1; i > 0; i--) {
    const j = await stream.below(i + 1)
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  return idx
}

export async function embedPayloadInAudio(payloadBytes: Uint8Array, kEmbed: Uint8Array) {
  const sampleRate = 48000
  const numSamples = sampleRate * 2 // 2 seconds
  const samples = new Int16Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate
    const env = Math.exp(-3 * t) // exponential decay for a bell-like sound
    const c4 = Math.sin(t * 2 * Math.PI * 211.63)
    const e4 = Math.sin(t * 2 * Math.PI * 329.63)
    const g4 = Math.sin(t * 2 * Math.PI * 392.00)
    const c5 = Math.sin(t * 2 * Math.PI * 523.25)
    
    const mix = (c4 + e4 + g4 + c5) / 4
    samples[i] = Math.floor(24000 * mix * env)
  }
  
  // Collect eligible sample indices (non-silent: abs(sample >> 1) >= 2),
  // then shuffle them with the same SHA-256 keystream Fisher–Yates as the
  // Python pipeline (vfc/prng.py) so positions match byte-for-byte.
  const eligibleIndices: number[] = []
  for (let i = 0; i < numSamples; i++) {
    if (Math.abs(samples[i] >> 1) >= 2) {
      eligibleIndices.push(i)
    }
  }
  const shuffled = await shuffledPositions(kEmbed, eligibleIndices)

  // Create original WAV Blob before modifying
  const originalSamples = new Int16Array(samples)
  const originalWavBuffer = createWavFile(originalSamples, sampleRate)
  const originalBlob = new Blob([originalWavBuffer], { type: 'audio/wav' })
  const originalUrl = URL.createObjectURL(originalBlob)

  let payloadBitIdx = 0
  const totalBits = payloadBytes.length * 8

  let modifiedCount = 0

  for (let i = 0; i < shuffled.length && payloadBitIdx < totalBits; i++) {
    const sampleIdx = shuffled[i]
    const val = samples[sampleIdx]
    const byteIdx = Math.floor(payloadBitIdx / 8)
    const bitOffset = 7 - (payloadBitIdx % 8) // MSB first
    const bit = (payloadBytes[byteIdx] >> bitOffset) & 1
    
    samples[sampleIdx] = (val & ~1) | bit
    payloadBitIdx++
    modifiedCount++
  }
  
  // Create modified WAV Blob
  const modifiedWavBuffer = createWavFile(samples, sampleRate)
  const modifiedBlob = new Blob([modifiedWavBuffer], { type: 'audio/wav' })
  const modifiedUrl = URL.createObjectURL(modifiedBlob)
  
  return { originalAudioUrl: originalUrl, modifiedAudioUrl: modifiedUrl, modifiedCount }
}

function createWavFile(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i))
    }
  }
  
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i], true)
    offset += 2
  }
  
  return buffer
}
