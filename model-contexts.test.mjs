import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "./index.mjs"

test("官方目录的上下文单位转换为 tokens", () => {
  assert.equal(_internal.contextTokensOf(1000), 1_000_000)
  assert.equal(_internal.contextTokensOf(1024), 1_024_000)
  assert.equal(_internal.contextTokensOf(200), 200_000)
  assert.equal(_internal.contextTokensOf(128000), 128_000)
  assert.equal(_internal.contextTokensOf(0), 0)
  assert.equal(_internal.contextTokensOf("invalid"), 0)
})

test("官方模型目录按 modelType 和完整 modelId 建立上下文映射", () => {
  const contexts = _internal.parseModelContexts([
    { modelType: "model-a", modelId: "model-a_hash-a", maxContextWindow: 200 },
    { modelType: "model-b", modelId: "model-b_hash-b", maxContextWindow: 1000 },
    { modelType: "missing-context", modelId: "missing-context_hash" },
  ])
  assert.deepEqual(contexts, {
    "model-a": 200_000,
    "model-a_hash-a": 200_000,
    "model-b": 1_000_000,
    "model-b_hash-b": 1_000_000,
  })
})
