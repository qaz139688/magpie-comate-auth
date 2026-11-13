import test from "node:test"
import assert from "node:assert/strict"
import { deviceLogin } from "./device-auth.mjs"

const response = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json })

test("网页授权后自动换取 License，所有请求都对应本次设备且不读取 Cookie", async () => {
  const requests = []
  const replies = [response(401), response(200, { status: "OK", data: "test-device-token" }), response(200, { status: "OK", data: { key: "test-license", displayName: "test-user" } })]
  const login = deviceLogin({ fetchImpl: async (url, options) => { requests.push({ url: new URL(url), options }); return replies.shift() }, sleep: async () => {} })
  const result = await login.callback()
  const clientId = new URL(login.url).searchParams.get("clientId")
  assert.equal(new URL(login.url).searchParams.get("track"), "COMATE_CLI")
  assert.equal(result.type, "success")
  assert.equal(result.license, "test-license")
  assert.equal(result.clientToken, "test-device-token")
  assert.equal(result.name, "test-user")
  assert.equal(requests.length, 3)
  assert.ok(requests.every(r => r.url.searchParams.get("clientId") === clientId))
  assert.ok(requests.every(r => !Object.keys(r.options.headers).some(k => k.toLowerCase() === "cookie")))
  assert.equal(requests[2].url.pathname, "/api/client/key")
  assert.equal(requests[2].options.headers.token, "test-device-token")
})

test("每次登录使用独立设备标识", () => {
  assert.notEqual(new URL(deviceLogin().url).searchParams.get("clientId"), new URL(deviceLogin().url).searchParams.get("clientId"))
})

test("取消后不发起授权请求", async () => {
  const controller = new AbortController()
  controller.abort()
  const login = deviceLogin({ fetchImpl: async () => { assert.fail("取消后不应请求") } })
  const result = await login.callback(undefined, { signal: controller.signal })
  assert.equal(result.type, "failed")
  assert.equal(result.error, "已取消登录")
})

test("未确认的设备授权会按时停止", async () => {
  const login = deviceLogin({ timeoutMs: 10, pollMs: 100, fetchImpl: async () => response(401) })
  const result = await login.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /超时/)
})

test("拿到 token 但缺少 License 时明确报错，不报告登录成功", async () => {
  const replies = [response(200, { status: "OK", data: "test-token" }), response(200, { status: "OK", data: {} })]
  const login = deviceLogin({ fetchImpl: async () => replies.shift() })
  const result = await login.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /没有取得 License/)
})

test("服务错误不继续轮询", async () => {
  let requests = 0
  const login = deviceLogin({ fetchImpl: async () => { requests++; return response(500) } })
  const result = await login.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /HTTP 500/)
  assert.equal(requests, 1)
})
