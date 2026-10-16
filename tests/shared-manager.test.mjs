import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { build } from "esbuild";
import { PROTOCOL, MAX_MESSAGE_BYTES, CONFIRMATION_KINDS, confirmationCopy, parseRequest } from "../build/shared/contracts/manager.mjs";
import { serve } from "../build/shared/core/ndjson.mjs";
import { Operations } from "../build/shared/core/operations.mjs";
import { OperationStore } from "../build/shared/core/operation-store.mjs";

// Vite's locked esbuild dependency bundles pure UI helpers for Node; no DOM,
// native host, actual backend, network or user state is opened by this suite.
const bundled = await build({ stdin: { contents: 'export * from "./ui/manager/src/ui-message.ts"; export * from "./ui/manager/src/confirmation-copy.ts";',
  resolveDir: path.resolve(import.meta.dirname, ".."), loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { uiMessage, renderMessage, UiMessageError, errorMessage, confirmationText } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const revision = "a".repeat(64);
const theme = { source: "saved", id: "sample" };
const request = (method, params = {}, requestId = "request-1") => ({ protocol: PROTOCOL, kind: "request", requestId, method, params });
const code = expected => error => error.code === expected;

test("wire contract rejects unknown fields, methods, private envelopes and invalid identities", () => {
  assert.equal(parseRequest(request("status.get")).method, "status.get");
  for (const value of [{ ...request("status.get"), extra: true }, request("status.get", { path: "C:/private" }),
    { ...request("status.get"), kind: "native.request" }, request("themes.get", { theme: { source: "saved", id: "../outside" } })]) {
    assert.throws(() => parseRequest(value), code("INVALID_REQUEST"));
  }
  assert.throws(() => parseRequest(request("unknown.method")), code("METHOD_UNSUPPORTED"));
  assert.throws(() => parseRequest({ ...request("status.get"), protocol: "other/1" }), code("PROTOCOL_UNSUPPORTED"));
});

async function wire(chunks) {
  const lines = []; const calls = [];
  const output = new Writable({ write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  const service = { isClosing: false, attachEvents() {}, async execute(value) { calls.push(value.method); return value.params; },
    async executeNative() { throw new Error("No native calls expected"); } };
  await serve(Readable.from(chunks), output, service);
  return { replies: lines.join("").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), calls };
}
const line = value => Buffer.from(JSON.stringify(value) + "\n");
test("NDJSON requires a handshake and unique request IDs", async () => {
  const { replies, calls } = await wire([line(request("status.get", {}, "early")), line(request("system.hello", {}, "hello")),
    line(request("status.get", {}, "ok")), line(request("status.get", {}, "ok"))]);
  assert.deepEqual(calls, ["system.hello", "status.get"]);
  assert.deepEqual(replies.map(value => value.ok), [false, true, true, false]);
});
test("NDJSON rejects invalid UTF-8, truncated and oversized requests without execution", async () => {
  for (const chunks of [[Buffer.from([0xff, 10])], [Buffer.from('{"unfinished":')], [Buffer.alloc(MAX_MESSAGE_BYTES + 1, 32)]]) {
    const { replies, calls } = await wire(chunks);
    assert.deepEqual(calls, []); assert.equal(replies.length, 1); assert.equal(replies[0].error.code, "INVALID_REQUEST");
  }
});
test("NDJSON accepts UTF-8 and CRLF split across arbitrary chunks", async () => {
  const copy = request("themes.copy", { operationId: `${randomUUID()}:${randomUUID()}`, theme, expectedRevision: revision,
    patch: {}, name: "中文素材" }, "copy");
  const bytes = Buffer.from(JSON.stringify(request("system.hello", {}, "hello")) + "\r\n" + JSON.stringify(copy) + "\r\n");
  const { replies, calls } = await wire([...bytes].map(value => Buffer.from([value])));
  assert.deepEqual(calls, ["system.hello", "themes.copy"]); assert.equal(replies[0].ok, true);
  assert.equal(replies[1].result.name, "中文素材");
});

test("owned messages translate at display time while diagnostic and subject strings stay raw", () => {
  const owned = uiMessage("控制台");
  assert.equal(renderMessage("zh-CN", owned), "控制台"); assert.equal(renderMessage("en-US", owned), "Console");
  assert.equal(renderMessage("en-US", "控制台"), "控制台");
  assert.equal(renderMessage("en-US", uiMessage("删除“{subject}”？", { subject: "控制台" })), "Delete “控制台”?");
  assert.equal(renderMessage("en-US", errorMessage(new Error("控制台"), "已完成")), "控制台");
  assert.equal(renderMessage("en-US", errorMessage(new UiMessageError(owned), "已完成")), "Console");
  assert.equal(renderMessage("en-US", uiMessage("已完成", undefined, { before: "[", after: "]" })), "[Completed]");
});
test("all 13 confirmation kinds bind to their method and invalid copy fully falls back", () => {
  const methods = ["skin.apply", "skin.resume", "skin.reset", "runtime.repair", "skin.restore", "runtime.upgrade",
    "themes.delete", "themes.delete", ...Array(5).fill("library.recover")];
  CONFIRMATION_KINDS.forEach((kind, index) => {
    const copy = { kind, ...(kind.startsWith("delete") || kind.startsWith("recover") ? { subject: "控制台" } : {}) };
    const confirmation = { reason: "original reason", impact: "original impact", copy };
    const actual = confirmationText("en-US", { method: methods[index], confirmation });
    assert.notEqual(actual.reason, confirmation.reason); assert.notEqual(actual.impact, confirmation.impact);
    if (copy.subject) assert.ok(actual.reason.includes("控制台"));
    assert.equal(confirmationText("en-US", { method: "themes.copy", confirmation }), confirmation);
  });
  for (const copy of [undefined, { kind: "unknown" }, { kind: "deleteSaved" }, { kind: "applyRestart", subject: "bad" },
    { kind: "deleteSaved", subject: "ok", unexpected: true }, { kind: "deleteSaved", subject: "x".repeat(257) }]) {
    assert.equal(confirmationCopy(copy), undefined);
    const confirmation = { reason: "raw", impact: "raw impact", copy };
    assert.equal(confirmationText("en-US", { method: "themes.delete", confirmation }), confirmation);
  }
});

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dreamskin-shared-test-"));
  const session = randomUUID(), store = new OperationStore(root);
  let executions = 0, fingerprint = "original";
  const port = { async preflight() { return { fingerprint, requiresConfirmation: options.confirm ?? false, reason: "restart", impact: "work interrupted" }; },
    async apply() { executions++; if (options.fail) throw new Error("simulated connection loss");
      return { effects: { themeCommitted: true, rendererApplied: true, codexRestarted: false }, committedRevision: revision,
        verifiedRendererRevision: revision, runtimeSessionId: "fake-runtime" }; } };
  const operations = new Operations(session, store, port, async () => null, async () => {});
  t.after(async () => { try { await operations.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { operations, store, root, port, session, params: { operationId: `${session}:${randomUUID()}`, theme, expectedRevision: revision },
    executions: () => executions, drift() { fingerprint = "changed"; } };
}
test("same ID is queried without replay; changed arguments and old-session IDs are rejected", async t => {
  const f = await fixture(t);
  await f.operations.apply(f.params); await f.operations.drain();
  assert.equal((await f.operations.apply(f.params)).state, "succeeded"); assert.equal(f.executions(), 1);
  await assert.rejects(f.operations.apply({ ...f.params, expectedRevision: "b".repeat(64) }), code("OPERATION_CONFLICT"));
  await assert.rejects(f.operations.apply({ ...f.params, operationId: `${randomUUID()}:${randomUUID()}` }), code("OPERATION_UNKNOWN"));
  const reopened = new Operations(randomUUID(), f.store, f.port, async () => null, async () => {});
  assert.equal((await reopened.get(f.params.operationId)).state, "succeeded"); assert.equal(f.executions(), 1);
});
test("confirmation decline and fingerprint drift cannot execute the writer", async t => {
  const f = await fixture(t, { confirm: true });
  await f.operations.apply(f.params); await f.operations.drain();
  const first = await f.operations.get(f.params.operationId);
  assert.equal(first.state, "awaitingConfirmation"); assert.equal(f.executions(), 0);
  await assert.rejects(f.operations.confirm({ operationId: first.id, confirmationId: "wrong", accepted: true }), code("CONFIRMATION_EXPIRED"));
  f.drift();
  await f.operations.confirm({ operationId: first.id, confirmationId: first.confirmation.id, accepted: true }); await f.operations.drain();
  const changed = await f.operations.get(first.id);
  assert.equal(changed.state, "awaitingConfirmation"); assert.notEqual(changed.confirmation.id, first.confirmation.id); assert.equal(f.executions(), 0);
  await f.operations.confirm({ operationId: first.id, confirmationId: changed.confirmation.id, accepted: false });
  assert.equal((await f.operations.get(first.id)).state, "cancelled"); assert.equal(f.executions(), 0);
});
test("confirmation is single-use and session close cancels an unused confirmation", async t => {
  const f = await fixture(t, { confirm: true });
  await f.operations.apply(f.params); await f.operations.drain();
  const current = await f.operations.get(f.params.operationId);
  const approval = { operationId: current.id, confirmationId: current.confirmation.id, accepted: true };
  await f.operations.confirm(approval); await f.operations.drain();
  await assert.rejects(f.operations.confirm(approval), code("CONFIRMATION_EXPIRED")); assert.equal(f.executions(), 1);
  const next = { ...f.params, operationId: `${f.session}:${randomUUID()}` };
  await f.operations.apply(next); await f.operations.drain(); await f.operations.close();
  assert.equal((await f.store.read(next.operationId)).operation.state, "cancelled"); assert.equal(f.executions(), 1);
});
test("execution loss and reopened unfinished journal stay indeterminate without replay", async t => {
  const f = await fixture(t, { fail: true });
  await f.operations.apply(f.params); await f.operations.drain();
  assert.equal((await f.operations.get(f.params.operationId)).state, "indeterminate");
  await f.operations.apply(f.params); assert.equal(f.executions(), 1);
  const record = await f.store.read(f.params.operationId);
  record.operation.state = "running"; await f.store.write(record);
  const reopened = new Operations(randomUUID(), f.store, f.port, async () => null, async () => {});
  assert.equal((await reopened.get(f.params.operationId)).state, "indeterminate"); assert.equal(f.executions(), 1);
});
test("journal drops invalid optional display metadata and refuses corrupt required fields", async t => {
  const f = await fixture(t, { confirm: true });
  await f.operations.apply(f.params); await f.operations.drain();
  const record = await f.store.read(f.params.operationId);
  record.operation.confirmation.copy = { kind: "bad", subject: "wrong" }; await f.store.write(record);
  const sanitized = await f.store.read(f.params.operationId);
  assert.equal(sanitized.operation.confirmation.copy, undefined); assert.equal(sanitized.operation.confirmation.reason, "restart");
  const directory = path.join(f.root, "manager-operations", "ledger");
  const filename = path.join(directory, (await readdir(directory))[0]);
  const damaged = JSON.parse(await readFile(filename, "utf8")); damaged.operation.expectedRevision = "bad";
  await writeFile(filename, JSON.stringify(damaged));
  await assert.rejects(f.store.read(f.params.operationId), code("IO_ERROR"));
});
