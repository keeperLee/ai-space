/* ============================================================
   密码哈希 · 纯 JS SHA-256（浏览器与 Node 通用，零依赖）
   ------------------------------------------------------------
   ⚠️ 请务必读完整段说明再使用

   本模块解决的是「不留下明文密码」，**不是**访问安全。

   本站是纯静态站点，没有服务端。所有校验逻辑、用户目录、
   哈希值都在用户自己的浏览器里。这意味着：

     · 任何人都可以打开开发者工具，直接改写登录状态，
       完全跳过密码校验 —— 密码复杂度不参与这个过程
     · 用户目录需要提交到仓库才能被他人看到，
       因此哈希是公开的，可被离线爆破

   那为什么还要做哈希？因为它确实带来了三项实际收益：

     1. 不对明文做持久化 —— localStorage、导出的用户目录、
        git 历史里都不会出现明文密码
     2. 每用户独立随机盐 —— 同一密码在不同账号下哈希不同，
        无法用一张彩虹表通吃，也无法通过对比哈希判断
        "这两个人用了同一个密码"
     3. 迭代拉伸 —— 把单次校验的成本拉高到约 10ms，
        让大规模离线爆破的成本随之上升

   真正的安全边界必须由服务端提供。若未来要接入后端，
   只需替换 assets/js/auth.js 里的 provider 实现，
   本模块的哈希逻辑可以原样保留（服务端同样校验）。
   ============================================================ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** UTF-8 编码（TextEncoder 在所有目标环境均可用，保留手写兜底） */
function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}

/** SHA-256 主函数，返回 32 字节 */
export function sha256(data) {
  const len = data.length;
  const bitLen = len * 8;
  const padLen = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(padLen);
  buf.set(data);
  buf[len] = 0x80;

  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padLen - 4, bitLen % 0x100000000);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

/** SHA-256 → 64 位十六进制小写字符串 */
export function sha256Hex(input) {
  return bytesToHex(sha256(utf8Bytes(String(input))));
}

/* ============================================================
   密码哈希
   ============================================================ */

/** 默认迭代次数。1000 次约 8~20ms，用户无感，但显著抬高离线爆破成本 */
export const DEFAULT_ITERATIONS = 1000;

/** 当前哈希方案标识，便于日后平滑升级算法 */
export const ALGO = 'sha256-iter-v1';

/**
 * 迭代哈希：h₀ = sha256(盐 : 密码)，hₙ = sha256(hₙ₋₁ : 盐 : n)
 * 每轮都重新混入盐与轮次，避免出现可被预计算的固定链路。
 */
export function hashPassword(password, salt, iterations = DEFAULT_ITERATIONS) {
  let h = sha256Hex(`${salt}:${password}`);
  for (let i = 0; i < iterations; i++) h = sha256Hex(`${h}:${salt}:${i}`);
  return h;
}

/** 生成随机盐（十六进制） */
export function genSalt(bytes = 16) {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return bytesToHex(arr);
}

/** 生成随机会话令牌 */
export function genToken(bytes = 24) {
  return genSalt(bytes);
}

/** 定长比较，避免因提前返回而泄露前缀匹配长度 */
export function timingSafeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 校验密码
 * @param {string} password 明文输入
 * @param {{salt:string, hash:string, iterations?:number, algo?:string}} record 存储的凭据
 */
export function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const iterations = Number.isFinite(record.iterations) ? record.iterations : DEFAULT_ITERATIONS;
  return timingSafeEqual(hashPassword(password, record.salt, iterations), record.hash);
}

/** 生成一条完整凭据（注册 / 改密时使用） */
export function makeCredential(password, iterations = DEFAULT_ITERATIONS) {
  const salt = genSalt();
  return { algo: ALGO, iterations, salt, hash: hashPassword(password, salt, iterations) };
}
