import { randomUUID } from "node:crypto"

const BASE = "https://comate.baidu.com"
const directFetch = (input, init = {}) => fetch(input, { ...init, proxy: false })

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason)
  const onAbort = () => {
    clearTimeout(timer)
    reject(signal.reason)
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort)
    resolve()
  }, ms)
  signal?.addEventListener("abort", onAbort, { once: true })
})

// 与百度官方 Zulu 1.7.21 的 SaaS 设备授权使用同一组接口。
// 网页负责登录与设备确认，插件只接收该设备对应的授权结果。
export function deviceLogin({ fetchImpl = directFetch, sleep = wait, timeoutMs = 180000, pollMs = 2000 } = {}) {
  const clientId = randomUUID()
  const url = new URL("/zh/login", BASE)
  url.searchParams.set("track", "COMATE_CLI")
  url.searchParams.set("clientId", clientId)
  url.searchParams.set("device", "Magpie Comate (Windows)")

  return {
    url: url.toString(),
    instructions: "在打开的百度 Comate 页面登录并确认授权这台设备，Magpie 会自动完成登录，无需复制 Cookie。授权页面提示成功后可以关闭；等待最长 3 分钟。",
    method: "auto",
    async callback(_code, { signal } = {}) {
      const deadline = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
      try {
        for (;;) {
          combined.throwIfAborted()
          const tokenUrl = new URL("/api/client/generate/token", BASE)
          tokenUrl.searchParams.set("clientId", clientId)
          const response = await fetchImpl(tokenUrl, {
            headers: { Accept: "application/json" },
            signal: combined,
            redirect: "error",
          })
          if (![200, 400, 401].includes(response.status)) {
            throw new Error(`设备授权接口返回 HTTP ${response.status}，请重试登录`)
          }
          const result = response.status === 200 ? await response.json() : null
          if (result?.status === "OK" && typeof result.data === "string" && result.data) {
            const keyUrl = new URL("/api/client/key", BASE)
            keyUrl.searchParams.set("clientId", clientId)
            const keyResponse = await fetchImpl(keyUrl, {
              headers: { Accept: "application/json", token: result.data },
              signal: combined,
              redirect: "error",
            })
            if (!keyResponse.ok) throw new Error(`获取 License 返回 HTTP ${keyResponse.status}，请重试登录`)
            const key = await keyResponse.json()
            if (key?.status !== "OK" || !key.data?.key) throw new Error("网页授权已完成，但没有取得 License，请重试登录")
            const accountName = key.data.displayName || key.data.key
            return {
              type: "success",
              access: key.data.key,
              refresh: "",
              expires: 0,
              license: key.data.key,
              clientId,
              clientToken: result.data,
              source: "device",
              accountId: accountName,
              name: accountName,
            }
          }
          await sleep(pollMs, combined)
        }
      } catch (error) {
        if (signal?.aborted) return { type: "failed", error: "已取消登录" }
        if (deadline.aborted) return { type: "failed", error: "设备授权超时，请重新点登录并在网页确认授权" }
        return { type: "failed", error: error?.message || "设备授权失败，请重试登录" }
      }
    },
  }
}
