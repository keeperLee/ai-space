/* ============================================================
   用户目录：纯逻辑（无 DOM、无 window、无副作用）
   ------------------------------------------------------------
   这里的函数同时被两处使用：
     · 浏览器：assets/js/auth.js（管理后台注册用户、导出名单）
     · 命令行：scripts/user.mjs（npm run user -- add/passwd/...）

   两处共用同一份校验与序列化代码，是为了避免出现
   「界面导出的格式」和「命令行写出的格式」不一致的情况 ——
   那种偏差在 CI 里很难发现，但会让 users.js 反复被改写。
   ============================================================ */

import { DEFAULT_ITERATIONS } from './crypto.js';

export const ROLES = ['admin', 'member'];
export const ROLE_LABEL = { admin: '管理员', member: '普通用户' };
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

export function normalizeUsername(v) {
  return String(v ?? '').trim().toLowerCase();
}

export function validateUsername(name) {
  if (!name) return '请填写登录名';
  if (!USERNAME_RE.test(name)) return '登录名只能包含小写字母、数字、下划线，长度 3~24 位';
  return '';
}

export function validateDisplayName(v) {
  const s = String(v ?? '').trim();
  if (!s) return '请填写显示名';
  if (s.length > 24) return '显示名太长（最多 24 字）';
  return '';
}

export function validatePassword(pw, username = '') {
  if (!pw) return '请填写密码';
  const s = String(pw);
  if (s.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (s.length > MAX_PASSWORD) return `密码过长（最多 ${MAX_PASSWORD} 位）`;
  if (username && s.toLowerCase() === String(username).toLowerCase()) return '密码不能与登录名相同';
  return '';
}

const COMMON_PASSWORDS = [
  'password', '12345678', '123456789', 'qwerty', '1qaz2wsx', '1qazxsw2',
  'admin123', '88888888', 'abc12345', 'iloveyou', 'letmein', 'welcome'
];

/**
 * 密码强度评估
 * @returns {{score:number, label:string, hints:string[], common:boolean}}
 */
export function passwordStrength(pw) {
  const s = String(pw || '');
  const hints = [];
  let score = 0;

  if (s.length >= 8) score++; else hints.push('至少 8 位');
  if (s.length >= 12) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++; else hints.push('混用大小写');
  if (/\d/.test(s)) score++; else hints.push('加入数字');
  if (/[^A-Za-z0-9]/.test(s)) score++; else hints.push('加入符号');

  const lower = s.toLowerCase();
  const common = COMMON_PASSWORDS.some((c) => lower.includes(c));
  if (common) {
    score = Math.min(score, 1);
    hints.push('包含常见弱口令片段');
  }

  const level = score <= 1 ? 0 : score === 2 ? 1 : score === 3 ? 2 : score === 4 ? 3 : 4;
  return {
    score: level,
    label: ['很弱', '弱', '一般', '较强', '很强'][level],
    hints,
    common
  };
}

/* ============================================================
   签名与指纹
   ------------------------------------------------------------
   只纳入「影响登录行为」的字段。这样管理员改一个备注不会被
   误判成需要重新发布的改动，而改密码、停用账号一定会。
   ============================================================ */
export function userSignature(u) {
  const c = u.credential || {};
  return JSON.stringify([
    u.username, u.displayName, u.role, u.active === true,
    c.salt, c.hash, c.iterations, u.mustChangePassword === true
  ]);
}

/** 整份名单的短指纹，用于检测「仓库名单是否已被他人改动」 */
export function directoryFingerprint(users, hashFn) {
  const joined = users.map(userSignature).sort().join('\u0002');
  // hashFn 由调用方注入（浏览器用 sha256Hex），避免这里硬依赖具体算法
  return hashFn ? hashFn(joined).slice(0, 12) : joined.slice(0, 12);
}

/* ============================================================
   序列化：生成可提交的 content/users.js
   ============================================================ */
const q = (s) => JSON.stringify(String(s ?? ''));

const today = () => new Date().toISOString().slice(0, 10);

/**
 * 把用户数组序列化成 content/users.js 的完整内容。
 * @param {Array} users 用户数组
 * @param {{header?:boolean, generatedAt?:string}} opts
 */
export function serializeDirectory(users, opts = {}) {
  const { header = true, generatedAt = new Date().toISOString() } = opts;

  const lines = users.map((u) => {
    const c = u.credential || {};
    const parts = [
      `      username: ${q(u.username)}`,
      `      displayName: ${q(u.displayName)}`,
      `      role: ${q(u.role)}`,
      `      active: ${u.active === true}`,
      `      credential: {
        algo: ${q(c.algo || 'sha256-iter-v1')},
        iterations: ${Number.isFinite(c.iterations) ? c.iterations : DEFAULT_ITERATIONS},
        salt: ${q(c.salt)},
        hash: ${q(c.hash)}
      }`,
      `      createdAt: ${q(u.createdAt || today())}`,
      `      createdBy: ${q(u.createdBy || 'unknown')}`
    ];
    if (u.mustChangePassword) parts.push('      mustChangePassword: true');
    if (u.note) parts.push(`      note: ${q(u.note)}`);
    return `    {\n${parts.join(',\n')}\n    }`;
  });

  const admins = users.filter((u) => u.role === 'admin').length;
  const offs = users.filter((u) => !u.active).length;

  const head = header ? `/* ============================================================
   用户目录 · 唯一数据源
   ------------------------------------------------------------
   导出时间 ${generatedAt}
   共 ${users.length} 个账号（${admins} 个管理员，${offs} 个已停用）

   ⚠️ 这个文件是「谁能登录」的权威名单，会被提交到仓库并公开。
      这里只存加盐哈希，任何情况下都不要写入明文密码。

   【为什么名单要写在这个文件里】
   本站是纯静态站点，没有服务端，localStorage 又只属于单个浏览器。
   管理员在自己浏览器里新建的用户，别的浏览器根本看不到。
   所以要让所有人都能登录，名单必须落到这个文件里，随代码一起发布。

   【新增用户的流程】
   推荐：登录管理员账号 → 右上角头像 → 用户管理 → 注册新用户
        → 点「下载 users.js」→ 覆盖本文件 → 提交推送
        → CI 校验通过后自动发布，约 1 分钟全员可见

   命令行（适合批量或忘记密码）：
     npm run user -- add <用户名> <密码> [角色] [显示名]
     npm run user -- passwd <用户名> <新密码>
     npm run user -- disable <用户名>
     npm run user -- enable <用户名>
     npm run user -- role <用户名> <admin|member>
     npm run user -- remove <用户名>
     npm run user -- list

   生成单条凭据（手工编辑时用）：
     npm run user -- hash <密码>

   【字段说明】
     username            登录名，小写字母/数字/下划线，3~24 位
     displayName         界面上显示的姓名
     role                admin（可进用户管理）| member（只能学习）
     active              false 表示已停用，无法登录（保留审计记录用）
     credential          加盐迭代哈希，由 assets/js/crypto.js 生成
     mustChangePassword  首次登录时提示改密（播种账号用）
     createdAt/createdBy 审计信息，记录谁在什么时候加进来的
   ============================================================ */

` : '';

  return `${head}window.USER_DIRECTORY = {
  version: 1,

  users: [
${lines.join(',\n')}
  ]
};
`;
}
