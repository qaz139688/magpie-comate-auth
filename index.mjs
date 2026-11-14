// 文心快码 Baidu Comate → magpie：账号卡片（会员 / 席位积分 / 增购 / 赠送）+ 15 个模型。
//
// 百度搭子的 Pro/Max 会员与文心快码的会员权益是同一套：搭子下的订单，积分落在
// Comate 这边（comate.baidu.com 个人中心的「席位积分」）。搭子自己的配额接口看不到
// 这份积分，所以在 magpie 里加一个 Comate 账号卡片，才能看见会员那 25,000 分。
//
// 模型通道走的是 Comate 插件那套真实 HTTP API（不是 zulu CLI）：
//   GET  /api/key/valid/<license>                       验票
//   POST /autowork/v2/conversation   → conversationId    建会话
//   POST /autowork/v2/task           → taskId            建任务
//   POST /autowork/v2/execute        → SSE（ANSWER.delta）执行
// 认证只需要把 license 放进 login-name 头，没有签名 / 设备绑定，所以不需要起进程。
// 插件自己起一个 127.0.0.1 上的 OpenAI 兼容口，把这些接口翻译成 /v1/chat/completions。
// 服务随插件生命周期起落，删插件即消失。
//
// 本插件只读 magpie 的凭据：不写 magpie 的配置，只写一份用量缓存（comate-usage-cache.json）。

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { deviceLogin } from "./device-auth.mjs"

const PROVIDER_ID = "comate"
const PROVIDER_NAME = "文心快码 Comate"

const BASE = "https://comate.baidu.com"
const USER_CENTER = "https://comate.baidu.com/zh/user"
const directFetch = (input, init = {}) => fetch(input, { ...init, proxy: false })
const LOGIN_URL =
  "https://passport.baidu.com/v2/?login&tpl=mn&u=" + encodeURIComponent("https://comate.baidu.com/zh/user")

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// Comate 靠百度 passport 的 BDUSS 认人；BDUSS_BFESS 是同一份值的 HTTPS 版本。
const REQUIRED_COOKIES = ["BDUSS"]

const cardText = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max)

function authIdentity(info, fallback = PROVIDER_NAME) {
  return cardText(info?.displayName || info?.name || info?.username || info?.license || fallback)
}

// magpie 的凭据库在 <data>/plugin-auth.json。插件可能是原地加载（plugin add <路径>），
// 也可能是拷进 <data>/plugins/node_modules/<name>/，两种都要找得到：
// 先看 magpie 自己报的数据目录 / 可执行文件位置，再看插件自身位置，最后看 cwd。
function magpieAuthFiles() {
  const dirs = []
  if (process.env.MAGPIE_DATA) dirs.push(process.env.MAGPIE_DATA)
  for (const p of [process.execPath, process.argv?.[0], process.argv?.[1]]) {
    if (!p || !/magpie/i.test(String(p))) continue
    const d = dirname(String(p))
    dirs.push(d, join(d, ".."))
  }
  try {
    const pd = dirname(pathOf(new URL(import.meta.url)))
    // 装进 node_modules 时：<data>/plugins/node_modules/<name>/ → 上溯三级是 <data>
    dirs.push(resolve(pd, "../../.."), resolve(pd, "../../../.."))
  } catch {}
  try {
    dirs.push(process.cwd())
  } catch {}

  const seen = new Set()
  const out = []
  for (const d of dirs) {
    if (!d) continue
    for (const cand of [join(d, "data", "plugin-auth.json"), join(d, "plugin-auth.json")]) {
      const norm = String(cand).replace(/\\/g, "/")
      if (seen.has(norm)) continue
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

function pathOf(u) {
  // Windows: file:///C:/somewhere/data/... → /C:/somewhere/... → C:/somewhere/...
  let p = decodeURIComponent(u.pathname)
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}

function activeAuthHome(logins, providerId) {
  const rows = Array.isArray(logins) ? logins : []
  const providerRows = rows.filter((row) => row?.agent === `plugin:${providerId}` && row?.on !== false)
  return (
    providerRows.find((row) => row?.first || row?.order === 1)?.home ||
    providerRows[0]?.home ||
    providerId
  )
}

function authKeysFor(logins, providerId) {
  const active = activeAuthHome(logins, providerId)
  return [...new Set([active, providerId].filter(Boolean))]
}

// 读 magpie 里任意 provider 的 cookies（只读）。用于「复用已登录的百度账号」。
function readMagpieAuth(providerIds = ["comate", "dumate"]) {
  for (const file of magpieAuthFiles()) {
    if (!existsSync(file)) continue
    let data
    try {
      data = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    let logins = []
    try {
      const loginsPath = join(dirname(file), "logins.json")
      if (existsSync(loginsPath)) logins = JSON.parse(readFileSync(loginsPath, "utf8"))
    } catch {}
    for (const id of providerIds) {
      for (const key of authKeysFor(logins, id)) {
        const entry = data?.[key]
        if (entry?.source === "device" && entry.license) return entry
        const cookies = Array.isArray(entry?.cookies) ? entry.cookies : null
        if (!cookies?.length) continue
        if (!cookies.some((c) => c?.name === "BDUSS")) continue
        return { ...entry, cookies }
      }
    }
  }
  return null
}

function parseCookieString(raw) {
  const out = []
  for (const part of String(raw ?? "").split(";")) {
    const s = part.trim()
    if (!s) continue
    const i = s.indexOf("=")
    if (i <= 0) continue
    const name = s.slice(0, i).trim()
    const value = s.slice(i + 1).trim()
    if (!name || !value) continue
    out.push({ name, value, domain: ".baidu.com" })
  }
  // 去重，后者覆盖前者
  const map = new Map()
  for (const c of out) map.set(c.name, c)
  return [...map.values()]
}

function buildCookieHeader(cookies, hostname = "comate.baidu.com") {
  const h = String(hostname).toLowerCase()
  const pick = (cookies ?? []).filter((c) => {
    const name = String(c?.name ?? "").toLowerCase()
    // console.bce.baidu.com 的 bce-* 会话属于百度智能云控制台；带着它们访问
    // comate.baidu.com 会让服务端走 BCE 鉴权并判「没有授权」。x-bce-login-redirect-url
    // 这几个不在其内，要留着。
    if (name.startsWith("bce-")) return false
    const d = String(c?.domain ?? "").toLowerCase().replace(/^\./, "")
    if (!d) return true
    return h === d || h.endsWith("." + d)
  })
  return pick.map((c) => `${c.name}=${c.value}`).join("; ")
}

function missingCookies(cookies, required) {
  return required.filter((n) => !(cookies ?? []).some((c) => c?.name === n))
}

function signInError(message) {
  const err = new Error(message || "文心快码登录态已失效，请重新登录")
  err.signIn = "expired"
  return err
}

async function getJsonOnce(path, cookieHeader, timeoutMs, extraHeaders = {}) {
  const res = await directFetch(BASE + path, {
    method: "GET",
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      "User-Agent": UA,
      Accept: "application/json",
      Referer: USER_CENTER,
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) throw signInError(`Comate 拒绝访问（HTTP ${res.status}），请重新登录`)
  if (/^\s*</.test(text)) throw signInError("Comate 返回了登录页，登录态已失效")
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Comate 返回非 JSON（HTTP ${res.status}）`)
  }
  const status = String(json?.status ?? "").toUpperCase()
  if (status === "UNAUTHORIZED" || status === "NOT_LOGIN" || status === "FORBIDDEN") {
    // 该响应既可能来自无效凭据，也可能来自临时限制，不能直接认定为限流。
    // 不自动标记账号过期；提示用户确认官网登录并提交 Comate 自己的 Cookie。
    const err = new Error(`Comate 拒绝当前登录凭据（${cardText(json?.message) || status}）。请重新使用官网设备授权登录；若官网也无法访问，请稍后再试`)
    err.code = "COMATE_AUTHORIZATION_REJECTED"
    throw err
  }
  if (status && status !== "OK") throw new Error(`Comate 接口错误（${path}）：${cardText(json?.message) || status}`)
  return json?.data
}

// 不自动重试：拒绝授权的原因不确定，连续请求可能加重临时限制。
async function getJson(path, cookieHeader, { timeoutMs = 15000, headers = {} } = {}) {
  return getJsonOnce(path, cookieHeader, timeoutMs, headers)
}

// 卡片刷新很频繁，Comate 又不喜欢同一登录态连发：同一份 cookies 的用量 10 分钟内复用。
// CLI 每次调用是新进程（模块级 Map 会丢），所以再落一份到磁盘，GUI 和 CLI 共用。
const usageCache = new Map()
const CACHE_TTL_MS = 600_000
const CACHE_FILE = "comate-usage-cache.json"
const MODEL_CONTEXT_CACHE_FILE = "comate-model-contexts.json"
const MODEL_CONTEXT_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function dataDir() {
  for (const f of magpieAuthFiles()) {
    try {
      if (existsSync(f)) return dirname(f)
    } catch {}
  }
  return ""
}

function readDiskCache() {
  try {
    const d = dataDir()
    if (!d) return null
    const p = join(d, CACHE_FILE)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, "utf8"))
    return j?.at && j?.data ? j : null
  } catch {
    return null
  }
}

function writeDiskCache(data) {
  try {
    const d = dataDir()
    if (!d) return
    writeFileSync(join(d, CACHE_FILE), JSON.stringify({ at: Date.now(), data }), "utf8")
  } catch {}
}

const num = (v) => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

const packOf = (p) => ({
  total: num(p?.totalPoints),
  used: num(p?.usedPoints),
  available: p?.availablePoints == null ? num(p?.totalPoints) - num(p?.usedPoints) : num(p?.availablePoints),
})

// "2026-12-12 23:59:59" → ISO；解析不了返回 null
function parseCnTime(s) {
  if (!s) return null
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)).toISOString()
}

async function loadIcon() {
  for (const rel of ["./icon.png", "./icon.svg"]) {
    try {
      const p = pathOf(new URL(rel, import.meta.url))
      if (!existsSync(p)) continue
      const buf = readFileSync(p)
      const mime = rel.endsWith(".svg") ? "image/svg+xml" : "image/png"
      return `data:${mime};base64,${buf.toString("base64")}`
    } catch {}
  }
  return "data:image/svg+xml;base64," + Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2932E1"/><text x="32" y="42" font-size="28" font-family="sans-serif" fill="#fff" text-anchor="middle">码</text></svg>`,
  ).toString("base64")
}

const pluginIcon = await loadIcon()

// ───────────────────────────── 模型：走官方 zulu CLI，插件内起一个 OpenAI 兼容口 ─────────────────────────────
//
// Comate 没有公开的 OpenAI 兼容 API，但官方 CLI（@comate/zulu）能用 license 登录并跑 Ask 模式。
// 所以插件自己在 127.0.0.1 上起一个小服务，把 /v1/chat/completions 翻译成 `zulu run --mode Ask`，
// magpie 看到的就是一个普通的 OpenAI 兼容 provider。服务随插件生命周期起落，删插件即消失。
//
// 关键坑：zulu 的 API_MAP 里没有 SAAS 平台，默认掉到内网域名 comate.baidu-int.com；
// 必须显式 HTTP_HOST=https://comate.baidu.com，否则报 ENOTFOUND / TLS 断开。

const PROXY_PORT = Number(process.env.COMATE_PROXY_PORT ?? 3427)

// modelId 是 Comate 服务端认的完整 key（<type>_<hash>），从 `zulu list-model` 取一次，
// 会随服务端版本变；对不上时用 modelType 前缀兜底，再不行就报错让用户重跑 list-model。
const MODELS = [
  { id: "deepseek-v4-flash", modelId: "deepseek-v4-flash_a8668ea86c3d40e7ad1f8ee45715d447", label: "Deepseek V4 Flash", vision: false, context: 1_024_000 },
  { id: "deepseek-v4-pro", modelId: "deepseek-v4-pro_4ba5277b630243be9eeb19fe48f853fa", label: "Deepseek V4 Pro", vision: false, context: 1_024_000 },
  { id: "deepseek-v4.1-flash", modelId: "deepseek-v4.1-flash_4827e158760447029e6594bb2b1ab066", label: "Deepseek V4.1 Flash", vision: true, effort: ["low", "high", "max"], context: 1_000_000 },
  { id: "ernie-5.5-flash-preview", modelId: "ernie-5.5-flash-preview_996d9d76bb7c45ecbff286216aaeeab2", label: "ERNIE 5.5 Flash Preview", vision: true, context: 1_000_000 },
  { id: "glm-4.7-fc", modelId: "glm-4.7-fc_0b87452a03394418b5c8d5468deff6c7", label: "GLM-4.7", vision: false, context: 200_000 },
  { id: "glm-5-turbo-fc", modelId: "glm-5-turbo-fc_6748c832242b4bcb8f715c7c7902d1ad", label: "GLM-5-Turbo", vision: false, context: 200_000 },
  { id: "glm-5.1", modelId: "glm-5.1_a231cc317baf4eaaa0b5afdd4de5f1d9", label: "GLM-5.1", vision: false, context: 256_000 },
  { id: "glm-5.2", modelId: "glm-5.2_50c584482e9d47edbbe47938a88b56b1", label: "GLM-5.2", vision: false, context: 1_000_000 },
  { id: "glm-5.3", modelId: "glm-5.3_37c550fc6d5b4fb2825abc2c1c88a6b3", label: "GLM-5.3", vision: false, effort: ["low", "high", "max"], context: 1_000_000 },
  { id: "glm-5.3-flash", modelId: "glm-5.3-flash_805131a9381a4940ba0f2d90cad0e7eb", label: "GLM-5.3-Flash", vision: true, context: 1_000_000 },
  { id: "glm-5v-turbo", modelId: "glm-5v-turbo_ea9e4f222f0a40b281953ebcb6981dda", label: "GLM-5v-Turbo", vision: true, context: 200_000 },
  { id: "kimi-k2.6-oneapi", modelId: "kimi-k2.6-oneapi_123e4567e89b12d3a456426614174000", label: "Kimi-K2.6", vision: true, context: 256_000 },
  { id: "minimax-m2.5-fc", modelId: "minimax-m2.5-fc_c99ea14f526548a8bc28717d4e854123", label: "MiniMax M2.5", vision: false, context: 200_000 },
  { id: "minimax-m3", modelId: "minimax-m3_a8f465fbedb942efadace88370ad7ff1", label: "MiniMax M3", vision: true, context: 512_000 },
  { id: "minimax-m2.7-fc", modelId: "minimax-m2.7-fc_047f123f661c414bb253c05b605c391e", label: "MiniMax-M2.7", vision: false, context: 200_000 },
]

const modelOf = (name) => MODELS.find((m) => m.id === name || m.label === name) ?? MODELS[0]

let modelContextCache = null
let modelContextRefresh = null

function contextTokensOf(value) {
  const n = num(value)
  if (n <= 0) return 0
  return Math.round(n < 10000 ? n * 1000 : n)
}

function parseModelContexts(models) {
  const contexts = {}
  for (const item of Array.isArray(models) ? models : []) {
    const context = contextTokensOf(item?.maxContextWindow)
    if (context <= 0) continue
    if (item?.modelType) contexts[String(item.modelType)] = context
    if (item?.modelId) contexts[String(item.modelId)] = context
  }
  return contexts
}

function readModelContextCache() {
  try {
    const d = dataDir()
    if (!d) return null
    const p = join(d, MODEL_CONTEXT_CACHE_FILE)
    if (!existsSync(p)) return null
    const cached = JSON.parse(readFileSync(p, "utf8"))
    if (!cached?.at || !cached?.contexts) return null
    return cached
  } catch {
    return null
  }
}

function writeModelContextCache(contexts) {
  const cached = { at: Date.now(), contexts }
  try {
    const d = dataDir()
    if (d) writeFileSync(join(d, MODEL_CONTEXT_CACHE_FILE), JSON.stringify(cached), "utf8")
  } catch {}
  modelContextCache = cached
  return contexts
}

async function loadModelContexts() {
  if (modelContextCache && Date.now() - modelContextCache.at < MODEL_CONTEXT_CACHE_TTL_MS) return modelContextCache.contexts
  const disk = readModelContextCache()
  if (disk && Date.now() - disk.at < MODEL_CONTEXT_CACHE_TTL_MS) {
    modelContextCache = disk
    return disk.contexts
  }
  if (modelContextRefresh) return modelContextRefresh
  modelContextRefresh = (async () => {
    const auth = readMagpieAuth()
    let license = auth?.license || auth?.accountId
    if (!license && auth?.cookies?.length) {
      try {
        license = await getLicense(buildCookieHeader(auth.cookies))
      } catch {}
    }
    if (!license) return disk?.contexts ?? {}
    try {
      const response = await directFetch(`${BASE}/api/v2/api/models/available`, {
        method: "POST",
        headers: API_HEADERS(license),
        body: JSON.stringify({
          username: license,
          type: "ZULU",
          rootRepo: "",
          submodules: [],
          zuluVersion: "1.7.21",
          source: "cli",
          ideType: "zulucli",
        }),
        signal: AbortSignal.timeout(15000),
      })
      const result = await response.json()
      if (!response.ok || result?.status !== "OK" || !Array.isArray(result?.data?.models)) {
        return disk?.contexts ?? {}
      }
      const contexts = parseModelContexts(result.data.models)
      return Object.keys(contexts).length ? writeModelContextCache(contexts) : disk?.contexts ?? {}
    } catch {
      return disk?.contexts ?? {}
    } finally {
      modelContextRefresh = null
    }
  })()
  return modelContextRefresh
}

function modelEntry(m, baseURL, contexts = {}) {
  return [
    m.id,
    {
      id: m.id,
      name: m.label,
      provider: { npm: "@ai-sdk/openai-compatible", ...(baseURL ? { api: baseURL } : {}) },
      limit: { context: contexts[m.id] ?? contexts[m.modelId] ?? m.context ?? 128000, output: 8192 },
      reasoning: true,
      tool_call: false,
      attachment: !!m.vision,
      modalities: { input: m.vision ? ["text", "image"] : ["text"], output: ["text"] },
    },
  ]
}

function selfDir() {
  try {
    return dirname(pathOf(new URL(import.meta.url)))
  } catch {
    return ""
  }
}

// ── Comate 真实 HTTP API ──────────────────────────────────────────
// 认证只要把 license 放进 login-name / Uuap-login-name 头，没有签名、没有设备绑定，
// 所以不需要像 CLI 那样每次 spawn 一个进程。实测单轮 1.4 秒、1 万字长文 2.0 秒。
const API_HEADERS = (license) => ({
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "login-name": license,
  "Uuap-login-name": license,
  "X-Source": "COMATE",
  "plugin-version": "zulucli-4.13.0",
  "x-skip-fcnap": "yes",
  "Accept-Language": "zh-CN,zh",
  "User-Agent": "axios/1.16.1",
})
const apiBase = (license) => ({ username: license, ide: "zulucli", ideVersion: "1.7.21", pluginVersion: "4.13.0" })

let licenseCache = { value: "", at: 0 }

// license 就是 /api/user 返回的那串 UUID，和额度卡片共用同一份 cookie。
async function getLicense(cookieHeader) {
  if (licenseCache.value && Date.now() - licenseCache.at < 3600_000) return licenseCache.value
  const data = await getJsonOnce("/api/user", cookieHeader, 15000)
  const lic = data?.license ?? data?.data?.license ?? ""
  if (!lic) throw new Error("拿不到 license（/api/user 没有返回 license 字段）")
  licenseCache = { value: lic, at: Date.now() }
  return lic
}

async function apiPost(license, path, body, { timeoutMs = 60000 } = {}) {
  const r = await directFetch(BASE + path, {
    method: "POST",
    headers: { ...API_HEADERS(license), "X-Trace-Id": randomUUID() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let j = null
  try {
    j = JSON.parse(text)
  } catch {}
  if (!r.ok) throw new Error(`${path} ${r.status} ${text.slice(0, 160)}`)
  return j ?? {}
}

const mimeOf = (p) => {
  const e = String(p).split(".").pop().toLowerCase()
  if (e === "jpg" || e === "jpeg") return "image/jpeg"
  if (e === "webp") return "image/webp"
  if (e === "gif") return "image/gif"
  return "image/png"
}

// 图片要先上传换 file id，execute 时靠 contexts[type=IMAGE] 引用。
async function uploadImage(license, filePath) {
  const buf = readFileSync(filePath)
  const mime = mimeOf(filePath)
  const name = String(filePath).split(/[\\/]/).pop() || "image.png"
  const r = await apiPost(
    license,
    "/api/aidevops/autocomate/rest/autowork/v1/file/upload",
    { fileName: name, contentType: mime, scene: "Composer", fileData: `data:${mime};base64,${buf.toString("base64")}` },
    { timeoutMs: 120000 },
  )
  return { id: r?.data?.id, name }
}

// 一轮对话：建会话（或复用）→ 建任务 → execute；边收 SSE 边把增量交给 onDelta。
async function callComate({ question, history, model, conversationId, images = [], onDelta, timeoutMs = 300000 }) {
  const auth = readMagpieAuth()
  if (!auth?.license && !auth?.cookies?.length) throw new Error("文心快码未登录：先 `magpie plugin login comate` 登录一次")
  const license = auth.license || auth.accountId || await getLicense(buildCookieHeader(auth.cookies))
  const base = apiBase(license)

  // 图片：先上传拿 id，再在 contexts 里引用
  const contexts = []
  if (images.length && model.vision) {
    const uploaded = []
    for (const p of images) {
      try {
        const u = await uploadImage(license, p)
        if (u?.id) uploaded.push(u)
      } catch {}
    }
    if (uploaded.length) {
      contexts.push({
        type: "IMAGE",
        imageIds: uploaded.map((u) => u.id),
        images: uploaded.map((u) => ({
          id: u.id,
          name: u.name,
          url: `${BASE}/api/aidevops/autocomate/rest/autowork/v1/file/stream/${u.id}?authorization=${license}`,
        })),
      })
    }
  }

  let cid = conversationId
  if (!cid) {
    const conv = await apiPost(license, "/api/aidevops/autocomate/rest/autowork/v2/conversation", { agentId: 8, ...base })
    cid = conv?.data?.id
    if (!cid) throw new Error(`建会话失败：${JSON.stringify(conv).slice(0, 200)}`)
  }

  const taskId = (
    await apiPost(license, "/api/aidevops/autocomate/rest/autowork/v2/task", {
      agentInfo: { isProjectAgent: false, agentName: "Ask", canInvokeAgents: false },
      agentId: 8,
      conversationId: cid,
      signal: {},
      ...base,
    })
  )?.data?.taskId
  if (!taskId) throw new Error("建任务失败：没拿到 taskId")

  const query = history ? `${history}\n\n用户：${question}` : question
  const r = await directFetch(BASE + "/api/aidevops/autocomate/rest/autowork/v2/execute", {
    method: "POST",
    headers: { ...API_HEADERS(license), Accept: "text/event-stream", "X-Trace-Id": randomUUID() },
    body: JSON.stringify({
      ...base,
      taskId,
      conversationId: cid,
      agentId: 8,
      uploadBaseInfo: {
        os: "Windows 10",
        osVersion: "Windows 10",
        extName: "zulucli",
        extVersion: "4.13.0",
        ideType: "zulucli",
        ideName: "zulucli",
        ideVersion: "1.7.21",
        vcsRepo: "",
        vcsBranchName: "",
        username: license,
        license,
        pluginVersion: "4.13.0",
        device: randomUUID(),
        triggerSource: "Agent",
      },
      query,
      modelKey: model.modelId,
      toolUseResults: [],
      contexts,
      subAgents: [],
      sysInfo: {
        os: "Windows 10",
        defaultShell: "cmd.exe",
        homeDir: homedir(),
        installedCommands: [],
        notInstalledCommands: [],
        workspacePath: process.cwd(),
        workspaceRoots: [process.cwd()],
      },
      skillInfos: [],
      hasMcp: false,
      isUserQuery: true,
      isMockQuery: false,
      localIndex: false,
      // 下面这几个字段看着没用，缺了模型会返回空内容——都是 zulu 真实请求里带的，
      // 尤其 systemReminder 是 Ask 模式的系统提示，空了模型就不知道该干什么。
      agentVersion: 12,
      isFirstQuery: !conversationId,
      enableMemory: true,
      systemReminder:
        "<system-reminder>\nAsk mode is active; only read-only tools are available.\nIf code edits are needed, output the proposed change as assistant text for the user to copy/apply.\n</system-reminder>",
      extendUserQueryInfo: { commands: [], skills: [], subagents: [], rules: [] },
      extend: { isMultiWorkspace: false, useWorkflow: false },
      sendMode: "normal",
      agentInfo: { agentName: "Ask", isProjectAgent: false, canInvokeAgents: false, isCustomAgent: false },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`execute ${r.status} ${(await r.text()).slice(0, 160)}`)

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let text = ""
  let err = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const raw = line.slice(6).trim()
      if (!raw || raw === "[DONE]") continue
      let j
      try {
        j = JSON.parse(raw)
      } catch {
        continue
      }
      const c = j.content
      if (!c) continue
      if (c.type === "EXCEPTION") err = c.detail?.exceptionMsg ?? c.text ?? "unknown"
      if (c.type === "ANSWER") {
        const d = c.detail?.delta ?? ""
        if (d) {
          text += d
          onDelta?.(d)
        }
      }
    }
  }
  if (err && !text) throw new Error(err)
  return { text, cid }
}

// 把 OpenAI 的 messages 拼成 zulu 的单条 query。zulu 是 agent，不是多轮 chat API。
function toQuery(messages) {
  const parts = []
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role === "system" ? "系统设定" : m?.role === "assistant" ? "助手" : "用户"
    let text = ""
    if (typeof m?.content === "string") text = m.content
    else if (Array.isArray(m?.content)) text = m.content.map((c) => c?.text ?? "").join("")
    if (text.trim()) parts.push(`${role}：${text.trim()}`)
  }
  return parts.join("\n\n")
}

// 把「最后一条用户消息」和「之前的历史」拆开。问题本身要留在 -q 里，历史才进附件：
// 反过来的话（元指令进 -q、问题塞附件），模型会把那句元指令当成用户说的话，
// 回答里全是「文件最后一处要求是……因此最后提出的要求是……」这种复述。
function splitQuery(messages) {
  const list = Array.isArray(messages) ? messages : []
  let lastUserIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return { question: "", history: toQuery(list) }
  const question = textOf(list[lastUserIdx]).trim()
  const history = toQuery(list.filter((_, i) => i !== lastUserIdx))
  return { question, history }
}


function readJsonBody(req) {
  return new Promise((r) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      try {
        r(JSON.parse(raw || "{}"))
      } catch {
        r({})
      }
    })
  })
}

// ── 多轮：OpenAI 客户端每次都把全量历史发过来，但 zulu 自己有会话，只该收增量。
// 认「这是同一个会话」的办法：上一轮我返回的 assistant 文本，这一轮必然出现在 messages 里。
const REPLY_INDEX = new Map() // hash(assistant 文本) → conversationId
const REPLY_LIMIT = 300

function quickHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return String(h)
}

function textOf(m) {
  if (typeof m?.content === "string") return m.content
  if (Array.isArray(m?.content)) return m.content.map((c) => c?.text ?? "").join("")
  return ""
}

function findCid(messages, sessionKey) {
  // ① 客户端如果给了明确的会话标识（header / prompt_cache_key），优先用它
  if (sessionKey) {
    const cid = REPLY_INDEX.get("k:" + sessionKey)
    if (cid) return cid
  }
  // ② 兜底：上一轮我返回的 assistant 文本，客户端这一轮必然带回来
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue
    const cid = REPLY_INDEX.get(quickHash(textOf(messages[i])))
    if (cid) return cid
  }
  return ""
}

// 只认「明确是会话」的标识。不用 OpenAI 的 `user` 字段——那是用户身份，
// 拿它当会话 key 会把同一用户的不同对话串成一条。
function explicitSession(body, headers) {
  const cands = [
    body?.prompt_cache_key,
    headers?.["x-session-id"],
    headers?.["x-conversation-id"],
    headers?.["x-thread-id"],
  ]
  for (const v of cands) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

function rememberReply(text, cid, sessionKey) {
  if (!text || !cid) return
  REPLY_INDEX.set(quickHash(text), cid)
  if (sessionKey) REPLY_INDEX.set("k:" + sessionKey, cid)
  while (REPLY_INDEX.size > REPLY_LIMIT) REPLY_INDEX.delete(REPLY_INDEX.keys().next().value)
}

// 图片：OpenAI 传的是 data URL，zulu 要文件路径，落一份临时文件，用完就删。
function imageDir() {
  const d = join(selfDir(), ".tmp")
  try {
    mkdirSync(d, { recursive: true })
  } catch {}
  return d
}

function extractImages(message) {
  const out = []
  if (!Array.isArray(message?.content)) return out
  for (const part of message.content) {
    if (part?.type !== "image_url") continue
    const url = part?.image_url?.url ?? ""
    const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(url)
    if (!m) continue
    const ext = m[1] === "jpeg" ? "jpg" : m[1].replace(/[^a-z0-9]/gi, "") || "png"
    const file = join(imageDir(), `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    try {
      writeFileSync(file, Buffer.from(m[2], "base64"))
      out.push(file)
    } catch {}
  }
  return out
}

function dropImages(files) {
  for (const f of files) {
    try {
      unlinkSync(f)
    } catch {}
  }
}

// 起本地 OpenAI 兼容口。
let proxyReady = null
let proxyServer = null

async function proxyHandler(req, res) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const send = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
        res.end(JSON.stringify(body))
      }

      if (url.pathname.endsWith("/models") && req.method === "GET") {
        return send(200, {
          object: "list",
          data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: PROVIDER_ID })),
        })
      }

      if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
        const body = await readJsonBody(req)
        const model = modelOf(body.model)
        const msgs = Array.isArray(body.messages) ? body.messages : []
        const lastUser = [...msgs].reverse().find((m) => m?.role === "user")
        const images = extractImages(lastUser)
        // 续会话只发最后一句（历史在 zulu 那边），新会话才把 system + 历史拼成一条
        const sessionKey = explicitSession(body, req.headers)
        const cid = findCid(msgs, sessionKey)
        // 续会话只发最后一句（历史在服务端）；新会话把历史带上，长的话 runZulu 会转成附件
        const { question, history } = splitQuery(msgs)
        const askQuestion = cid ? (lastUser ? textOf(lastUser).trim() : question) : question
        const askHistory = cid ? "" : history
        if (!askQuestion && !askHistory) {
          dropImages(images)
          return send(400, { error: { message: "messages 是空的", type: "invalid_request_error" } })
        }
        const id = "chatcmpl-" + Date.now().toString(36)
        const created = Math.floor(Date.now() / 1000)
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: model.id,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        try {
          if (body.stream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              Connection: "keep-alive",
            })
            res.write(chunk({ role: "assistant" }))
            const { text, cid: newCid } = await callComate({
              question: askQuestion,
              history: askHistory,
              model,
              conversationId: cid,
              images,
              onDelta: (d) => res.write(chunk({ content: d })),
            })
            rememberReply(text, newCid, sessionKey)
            dropImages(images)
            res.write(chunk({}, "stop"))
            res.write("data: [DONE]\n\n")
            return res.end()
          }
          const { text, cid: newCid } = await callComate({
            question: askQuestion,
            history: askHistory,
            model,
            conversationId: cid,
            images,
          })
          rememberReply(text, newCid, sessionKey)
          dropImages(images)
          return send(200, {
            id,
            object: "chat.completion",
            created,
            model: model.id,
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
        } catch (e) {
          dropImages(images)
          const msg = String(e?.message ?? e)
          // 流式已经发过头了，只能把错误塞进流里，不能再改状态码
          if (res.headersSent) {
            try {
              res.write(chunk({}, "stop"))
              res.write(`data: ${JSON.stringify({ error: { message: msg, type: "upstream_error" } })}\n\n`)
              res.write("data: [DONE]\n\n")
              return res.end()
            } catch {}
            return
          }
          return send(502, { error: { message: msg, type: "upstream_error" } })
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("not found")
      }

      // 端口被占时不能盲目认定「已有实例在服务」：旧进程可能刚退出、端口已空，
      // 那样 magpie 会一直 ECONNREFUSED。先探测，探不通就换随机端口。
      function listenOn(port) {
      return new Promise((resolve) => {
        const server = createServer(proxyHandler)
        server.once("error", (e) => resolve({ ok: false, code: e?.code }))
        server.listen(port, "127.0.0.1", () => resolve({ ok: true, port: server.address().port, server }))
      })
      }

      async function probeProxy(port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) })
        return r.ok
      } catch {
        return false
      }
      }

      async function startProxy() {
      if (proxyReady) return proxyReady
      proxyReady = (async () => {
        const first = await listenOn(PROXY_PORT)
        if (first.ok) {
          proxyServer = first.server
          return `http://127.0.0.1:${first.port}/v1`
        }
        if (first.code === "EADDRINUSE" && (await probeProxy(PROXY_PORT))) {
          return `http://127.0.0.1:${PROXY_PORT}/v1` // 真有一个活着的实例
        }
        const fallback = await listenOn(0) // 端口被死进程占着 → 随机端口
        if (!fallback.ok) return ""
        proxyServer = fallback.server
        return `http://127.0.0.1:${fallback.port}/v1`
      })()
      return proxyReady
      }

export const ComatePlugin = async ({ client, magpie } = {}, options = {}) => {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "comate-auth", level: "info", message } })
    } catch {}
  }
  // 插件自己的 OpenAI 兼容口（起不来就只当额度卡片，不影响登录）
  const localBase = await startProxy().catch(() => "")
  if (localBase) log(`Comate: 模型通道在 ${localBase}`)

  const cookiesOf = (auth) => {
    if (auth?.type !== "oauth" || !Array.isArray(auth.cookies) || !auth.cookies.length) {
      throw signInError("文心快码未登录，请先在 magpie 登录")
    }
    return auth.cookies
  }

  const makeAuth = (cookies, info, source) => ({
    type: "success",
    access: "cookie:" + buildCookieHeader(cookies),
    refresh: "",
    expires: 0,
    source,
    license: String(info?.license || ""),
    accountId: authIdentity(info),
    name: authIdentity(info),
    cookies,
  })

  // 用一份 cookie 直接问 Comate 本人是谁；顺带把死会话挡在登录这一步。
  const verify = async (cookies) => {
    const header = buildCookieHeader(cookies)
    try {
      const info = await getJson("/api/user", header)
      if (info && (info.username || info.license)) return info
    } catch {}
    // /api/user 偶尔被限流，balance 能通就说明这份登录态是活的。
    const bal = await getJson("/api/user/agent/balance", header)
    if (!bal) throw signInError("Cookie 未换到 Comate 账号信息")
    throw new Error("Comate 登录已连通，但未取得账号名称；请稍后重试，避免生成重复账号")
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER_ID] ?? {}
      const base = localBase || was.api
      const contexts = await loadModelContexts()
      const generated = Object.fromEntries(MODELS.map((m) => modelEntry(m, base, contexts)))
      for (const m of MODELS) {
        const existing = was.models?.[m.id]
        if (!existing) continue
        generated[m.id] = {
          ...existing,
          ...generated[m.id],
          limit: { ...existing.limit, ...generated[m.id].limit },
        }
      }
      const extraModels = Object.fromEntries(
        Object.entries(was.models ?? {}).filter(([id]) => !generated[id]),
      )
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        ...(base ? { api: base } : {}),
        ...was,
        models: {
          ...extraModels,
          ...generated,
        },
      }
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        const base = localBase || provider?.api
        const contexts = await loadModelContexts()
        return Object.fromEntries(MODELS.map((m) => modelEntry(m, base, contexts)))
      },
    },

    auth: {
      provider: PROVIDER_ID,
      icon: pluginIcon,

      // 登录态是两个 httpOnly cookie，没有 refresh 流。这里只在「复用本机」来源时
      // 跟着 magpie 里 DuMate 的登录态走：那边重登了，这边自动换新的。
      async refresh(auth) {
        if (auth?.type !== "oauth" || auth.source !== "magpie") return undefined
        const d = readMagpieAuth(["dumate"])
        if (!d) return undefined
        const oldHeader = buildCookieHeader(auth.cookies ?? [])
        const newHeader = buildCookieHeader(d.cookies)
        if (newHeader === oldHeader) return undefined
        try {
          const info = await verify(d.cookies)
          return makeAuth(d.cookies, info, "magpie")
        } catch {
          return undefined
        }
      },

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return { error: cardText(e?.message) || "登录态读取失败", signIn: "expired" }
        }
        if (auth?.type !== "oauth" || (!auth.license && !auth.cookies?.length)) {
          return { error: "没有登录信息，请先在 magpie 登录文心快码", signIn: "kept" }
        }
        if (auth.source === "device" && auth.license) {
          return {
            plan: "文心快码 Comate · 官网设备授权",
            balance: "积分请到 Comate 官网查看",
            windows: [],
            user: auth.name || auth.accountId || PROVIDER_NAME,
            signIn: "kept",
          }
        }
        const header = buildCookieHeader(auth.cookies ?? [])
        const cacheKey = auth.license || header
        let cached = usageCache.get(cacheKey)
        if (!cached) {
          const disk = readDiskCache()
          if (disk) {
            cached = disk
            usageCache.set(cacheKey, disk)
          }
        }
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data
        try {
          // 只打一个接口：Comate 对同一登录态的短时间连发很敏感，请求越少越稳，
          // 卡片上要的席位/增购/赠送/独立包都在 balance 里。
          const headers = auth.license ? { ...API_HEADERS(auth.license), token: auth.clientToken } : {}
          const bal = await getJson("/api/user/agent/balance", header, { headers })
          if (!bal) throw new Error("Comate 积分接口不可用")

          const seat = packOf(bal.seatPoints)
          const add = packOf(bal.addonPoints)
          const gft = packOf(bal.giftPoints)
          const standalone = packOf(bal.standalonePackPoints)

          const groups = [
            { name: "席位积分", p: seat },
            { name: "增购积分", p: add },
            { name: "赠送积分", p: gft },
            { name: "独立积分包", p: standalone },
          ].filter((g) => g.p.total > 0)

          const availAll = groups.reduce((s, g) => s + g.p.available, 0)

          // 席位积分每月自动补满，下期发放时间在 seatPointsNextUpdate。
          // 日期按接口原串显示，别经 Date 转 UTC。
          const nextSeatRaw = String(bal.seatPointsNextUpdate ?? "")
          const nextSeat = parseCnTime(nextSeatRaw)
          const isMember = seat.total > 0
          const planBits = [isMember ? `会员 · 席位 ${Math.round(seat.total).toLocaleString("en-US")} 分/月` : "Free"]
          if (nextSeat) planBits.push(`下期 ${nextSeatRaw.slice(5, 10)} 补满`)

          const data = {
            plan: planBits.join(" · "),
            balance: `${availAll.toFixed(2)} 积分`,
            windows: groups.map((g) => ({
              name: g.name,
              used: g.p.total > 0 ? (100 * g.p.used) / g.p.total : 0,
              display: `${g.p.used.toFixed(2)} / ${g.p.total.toFixed(2)}`,
              amount: g.p.used,
              limit: g.p.total,
              unit: "points",
            })),
            user: auth.name || auth.accountId || PROVIDER_NAME,
            signIn: "kept",
          }
          usageCache.set(cacheKey, { at: Date.now(), data })
          writeDiskCache(data)
          return data
        } catch (e) {
          const expired = e?.signIn === "expired"
          // 被 Comate 临时拒了（短时间内请求过多会这样）：有旧数据就先给旧的，
          // 卡片不至于空着，下次刷新再拿新的。
          if (cached) {
            return {
              ...cached.data,
              plan: `${cached.data.plan || PROVIDER_NAME} · 额度为上次读取`,
              asOf: new Date(cached.at).toISOString(),
            }
          }
          return { error: cardText(e?.message) || "Comate 用量查询失败", signIn: expired ? "expired" : "kept" }
        }
      },

      methods: [
        {
          type: "oauth",
          label: "官网设备授权（自动登录，无需复制 Cookie）",
          authorize: () => deviceLogin(),
        },
        {
          type: "oauth",
          label: "复用 magpie 里已登录的百度账号（零操作）",
          authorize: async () => ({
            url: "",
            instructions:
              "尝试复用 magpie 中保存的 Comate 或百度搭子登录凭据，只读本机凭据文件。百度搭子的登录凭据不保证能用于 Comate。\n" +
              "如果复用被拒绝，请改用浏览器登录或手动粘贴 Comate 官网请求头中的 Cookie。",
            method: "auto",
            async callback() {
              const d = readMagpieAuth(["dumate", "comate"])
              if (!d) {
                return {
                  type: "failed",
                  error: "没找到可复用的百度登录态（magpie 里没有已登录的 DuMate/Comate 账号）。请改用浏览器登录方式。",
                }
              }
              if (d.source === "device" && d.license) return { ...d, type: "success" }
              try {
                const info = await verify(d.cookies)
                return makeAuth(d.cookies, info, "magpie")
              } catch (e) {
                return { type: "failed", error: `复用失败：${e?.message ?? e}` }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "百度账号浏览器登录（粘贴 Cookie）",
          authorize: async () => ({
            url: LOGIN_URL,
            instructions:
              "1. 点击上方链接，在浏览器登录你的百度账号（登录成功会跳到 comate.baidu.com 个人中心）。\n" +
              "2. 打开 https://comate.baidu.com/zh/user ，按 F12 → Network（网络），刷新页面，点第一个 comate.baidu.com 的请求。\n" +
              "3. 在 Request Headers（请求标头）里找到 Cookie 一行，右键 → Copy value（复制值），粘贴到下方。\n" +
              "（关键登录 Cookie 是 httpOnly，控制台 document.cookie 拿不到，必须从 Network 面板复制）",
            method: "code",
            async callback(input) {
              const raw = String(input ?? "").trim().replace(/^[\"']|[\"']$/g, "")
              if (!raw || !raw.includes("=")) return { type: "failed", error: "请粘贴请求头中 Cookie 行的完整值" }
              const cookies = parseCookieString(raw)
              const missing = missingCookies(cookies, REQUIRED_COOKIES)
              if (missing.length) {
                return {
                  type: "failed",
                  error: `Cookie 缺少关键字段：${missing.join(", ")}。请确认复制的是 comate.baidu.com 请求头里的 Cookie（不是 document.cookie）`,
                }
              }
              try {
                const info = await verify(cookies)
                return makeAuth(cookies, info, "browser")
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}。请重新登录并复制新的 Cookie` }
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Cookie 字符串",
          authorize: async () => ({
            url: "",
            instructions: "粘贴完整的 Cookie 字符串（name=value; name2=value2 格式，必须包含 BDUSS，来自 comate.baidu.com 的请求头）：",
            method: "code",
            async callback(input) {
              const cookies = parseCookieString(String(input ?? "").trim())
              if (cookies.length < 2) return { type: "failed", error: "无法解析 Cookie 字符串" }
              const missing = missingCookies(cookies, REQUIRED_COOKIES)
              if (missing.length) return { type: "failed", error: `Cookie 缺少关键字段：${missing.join(", ")}` }
              try {
                const info = await verify(cookies)
                return makeAuth(cookies, info, "manual")
              } catch (e) {
                return { type: "failed", error: `Cookie 验证失败：${e?.message ?? e}` }
              }
            },
          }),
        },
      ],
    },
  }
}

export default ComatePlugin

// 单元测试用的纯函数（不联网）。
export const _internal = {
  parseCookieString,
  buildCookieHeader,
  missingCookies,
  packOf,
  parseCnTime,
  contextTokensOf,
  parseModelContexts,
  activeAuthHome,
  authKeysFor,
  authIdentity,
}
