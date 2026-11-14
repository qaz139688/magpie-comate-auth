import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "./index.mjs"

test("优先选择 Magpie 标记为首选的 Comate 账号", () => {
  const logins = [
    { agent: "plugin:comate", home: "comate", on: true },
    { agent: "plugin:comate", home: "comate#selected", on: true, first: true },
  ]
  assert.equal(_internal.activeAuthHome(logins, "comate"), "comate#selected")
  assert.deepEqual(_internal.authKeysFor(logins, "comate"), ["comate#selected", "comate"])
})

test("没有首选标记时使用账号列表中的第一项", () => {
  const logins = [
    { agent: "plugin:comate", home: "comate#first", on: true },
    { agent: "plugin:comate", home: "comate#second", on: true },
  ]
  assert.equal(_internal.activeAuthHome(logins, "comate"), "comate#first")
})

test("关闭的账号不会成为首选", () => {
  const logins = [
    { agent: "plugin:comate", home: "comate#off", on: false, first: true },
    { agent: "plugin:comate", home: "comate#on", on: true },
  ]
  assert.equal(_internal.activeAuthHome(logins, "comate"), "comate#on")
})

test("登录身份优先使用 Comate 显示名", () => {
  assert.equal(
    _internal.authIdentity({
      displayName: "account-name",
      name: "other-name",
      username: "username",
      license: "license-id",
    }),
    "account-name",
  )
  assert.equal(_internal.authIdentity({ username: "username", license: "license-id" }), "username")
  assert.equal(_internal.authIdentity({ license: "license-id" }), "license-id")
})
