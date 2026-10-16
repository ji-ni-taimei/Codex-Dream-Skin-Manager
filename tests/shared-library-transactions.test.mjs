import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LibraryTransactions } from "../build/shared/core/library-transactions.mjs";
import { recoveryEntry, recoveryPage, prepareRecovery, recoverLibrary } from "../build/shared/core/library-recovery.mjs";
import { prepareDeletion, deleteTheme } from "../build/shared/core/theme-delete.mjs";
import { treeSnapshot, treeRevision } from "../build/shared/core/managed-tree.mjs";
import { readLocalTheme } from "../build/shared/core/local-files.mjs";
import { themeDetails } from "../build/shared/core/theme-model.mjs";

const id = () => `${randomUUID()}:${randomUUID()}`;
const revision = "a".repeat(64);
const code = expected => error => error.code === expected;
const present = async file => lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
async function fixture(t, platform = "windows") {
  const root = await mkdtemp(path.join(os.tmpdir(), "dreamskin-library-proof-"));
  // Only the exact random root created by this fixture may be recursively removed.
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, "state"), application = path.join(root, "application");
  await mkdir(path.join(state, "themes"), { recursive: true });
  await mkdir(path.join(application, "windows", "presets"), { recursive: true });
  const journals = new LibraryTransactions(state, application, platform);
  const status = { activeId: null, appliedId: null, paused: false, health: "healthy", diagnostics: [] };
  const adapter = { name: platform, async status() { return { ...status }; }, async applicationVersion() { return null; },
    async inventory() {
      const themes = [];
      for (const name of (await readdir(journals.root("library"))).filter(name => !name.startsWith("."))) {
        themes.push(await readLocalTheme(path.join(journals.root("library"), name), name.startsWith("preset-") ? "preset" : "saved", themes.length));
      }
      return { themes, warnings: [] };
    } };
  const validations = [];
  const validation = { async inspect() { validations.push("inspect"); }, async css() { validations.push("css"); }, async payload() { validations.push("payload"); } };
  const validateMedia = async () => { validations.push("decode-stub"); };
  const recycle = async () => { throw new Error("No real recycle allowed"); };
  const config = name => ({ schemaVersion: 1, id: name, name: "中文主题", image: "background.png", category: "custom", tags: ["样本"], art: {}, appearance: "auto" });
  async function theme(name) {
    const directory = path.join(journals.root("library"), name); await mkdir(directory);
    await writeFile(path.join(directory, "theme.json"), JSON.stringify(config(name)) + "\n");
    await writeFile(path.join(directory, "background.png"), "synthetic media bytes");
    await writeFile(path.join(directory, "LICENSE.txt"), "fixture attribution");
    return readLocalTheme(directory, name.startsWith("preset-") ? "preset" : "saved", 0);
  }
  async function staged(method = "themes.create") {
    const value = await journals.begin(id(), method, null, revision), stage = journals.stage(value);
    await mkdir(stage); await writeFile(path.join(stage, "theme.json"), JSON.stringify(config(value.theme.id)) + "\n");
    await writeFile(path.join(stage, "background.png"), "synthetic media bytes");
    await writeFile(path.join(stage, "LICENSE.txt"), "fixture attribution");
    value.tree = await treeSnapshot(stage); value.phase = "prepared"; await journals.write(value); return value;
  }
  async function recovery(value, action) {
    const item = await recoveryEntry(journals, await journals.read(value.operationId));
    const command = { method: "library.recover", params: { operationId: id(), transactionId: value.operationId, expectedRevision: item.revision, action } };
    return { command, fingerprint: (await prepareRecovery(journals, adapter, command)).challenge.fingerprint };
  }
  return { root, state, journals, adapter, status, validation, validations, validateMedia, recycle, config, theme, staged, recovery };
}

for (const platform of ["windows", "macos"]) {
  test(`${platform}: import publication and configuration commit preserve provenance and reject replay/overwrite`, async t => {
    const f = await fixture(t, platform), value = await f.staged("themes.copy"), stage = f.journals.stage(value);
    const expected = await treeSnapshot(stage), destination = path.join(f.journals.root("library"), value.theme.id);
    await f.journals.publish(value.operationId, stage, value.theme);
    assert.equal(treeRevision(await treeSnapshot(destination)), treeRevision(expected)); assert.equal(await present(stage), false);
    assert.equal((await f.journals.read(value.operationId)).phase, "committed");
    await assert.rejects(f.journals.begin(value.operationId, "themes.copy"), code("OPERATION_CONFLICT"));
    const file = path.join(destination, "theme.json"), config = { ...f.config(value.theme.id), name: "已修改" };
    const updateId = id(); await f.journals.begin(updateId, "themes.update", value.theme, revision);
    await f.journals.config(updateId, file, config, value.theme);
    const update = await f.journals.read(updateId), entry = await recoveryEntry(f.journals, update);
    assert.equal(update.phase, "committed"); assert.deepEqual(entry.actions, ["reconcile"]);
    assert.equal(JSON.parse(await readFile(file, "utf8")).name, "已修改");
    const result = { libraryChanged: true, resultTheme: value.theme, resultRevision: revision, error: null };
    await f.journals.finish(updateId, result);
    assert.equal(await recoveryEntry(f.journals, await f.journals.read(updateId)), null);
  });
  test(`${platform}: prepared/committing import recovery revalidates, publishes once and settles original receipt`, async t => {
    for (const phase of ["prepared", "committing"]) {
      const f = await fixture(t, platform), value = await f.staged("themes.importPackage");
      value.phase = phase; await f.journals.write(value);
      const { command, fingerprint } = await f.recovery(value, "finishImport");
      const result = await recoverLibrary(f.journals, f.adapter, command, fingerprint, f.validation, f.validateMedia, f.recycle);
      assert.equal(result.error, null); assert.equal(result.recoveryCompleted, true); assert.equal(result.libraryChanged, true);
      assert.deepEqual(f.validations, platform === "macos" ? ["inspect", "decode-stub", "payload"] : ["inspect", "decode-stub"]);
      const receipt = await f.journals.read(value.operationId);
      assert.equal(receipt.phase, "final"); assert.equal(receipt.outcome.disposition, "created");
      assert.equal(await present(f.journals.stage(value)), false);
      const before = treeRevision(await treeSnapshot(f.journals.root("library")));
      const again = await recoverLibrary(f.journals, f.adapter, command, fingerprint, f.validation, f.validateMedia, f.recycle);
      assert.equal(again.error.code, "RECOVERY_CHANGED"); assert.equal(treeRevision(await treeSnapshot(f.journals.root("library"))), before);
    }
  });
}
test("existing destination is never replaced and both trees are retained", async t => {
  const f = await fixture(t), value = await f.staged(), destination = path.join(f.journals.root("library"), value.theme.id);
  await f.theme(value.theme.id); await writeFile(path.join(destination, "LICENSE.txt"), "existing attribution");
  const before = treeRevision(await treeSnapshot(destination));
  await assert.rejects(f.journals.publish(value.operationId, f.journals.stage(value), value.theme), code("OPERATION_CONFLICT"));
  assert.equal(treeRevision(await treeSnapshot(destination)), before); assert.equal(await present(f.journals.stage(value)), true);
});
test("post-rename interruption reconciles exact bytes without running import validation again", async t => {
  const f = await fixture(t), value = await f.staged(); value.phase = "committing"; await f.journals.write(value);
  await rename(f.journals.stage(value), path.join(f.journals.root("library"), value.theme.id));
  const { command, fingerprint } = await f.recovery(value, "reconcile");
  const result = await recoverLibrary(f.journals, f.adapter, command, fingerprint, f.validation, f.validateMedia, f.recycle);
  assert.equal(result.error, null); assert.equal(result.libraryChanged, false); assert.equal(result.recoveryCompleted, true);
  assert.equal((await f.journals.read(value.operationId)).outcome.libraryChanged, true); assert.deepEqual(f.validations, []);
});
test("stage drift, protected state drift and decode failure retain stage and refuse publication", async t => {
  for (const mutation of ["bytes", "protected", "decode"]) {
    const f = await fixture(t), value = await f.staged(), prepared = await f.recovery(value, "finishImport");
    const file = path.join(f.journals.stage(value), "background.png");
    if (mutation === "bytes") await writeFile(file, "changed after confirmation");
    if (mutation === "protected") f.status.activeId = value.theme.id;
    const result = await recoverLibrary(f.journals, f.adapter, prepared.command, prepared.fingerprint, f.validation,
      mutation === "decode" ? async () => { throw new Error("simulated decoder refusal"); } : f.validateMedia, f.recycle);
    assert.ok(result.error); assert.equal(result.recoveryCompleted, false); assert.equal(await present(file), true);
    assert.equal(await present(path.join(f.journals.root("library"), value.theme.id)), false);
  }
});
test("drift during media validation is rechecked before publication", async t => {
  const f = await fixture(t), value = await f.staged(), prepared = await f.recovery(value, "finishImport");
  const result = await recoverLibrary(f.journals, f.adapter, prepared.command, prepared.fingerprint, f.validation,
    async file => writeFile(file, "replaced while decoding"), f.recycle);
  assert.equal(result.error.code, "RECOVERY_CHANGED"); assert.equal(await present(f.journals.stage(value)), true);
  assert.equal(await present(path.join(f.journals.root("library"), value.theme.id)), false);
});
test("explicit discard removes only its confirmed stage and retains unknown neighboring material", async t => {
  const f = await fixture(t), value = await f.staged(), neighbor = path.join(f.journals.root("library"), ".manager-import-" + randomUUID());
  await mkdir(neighbor); await writeFile(path.join(neighbor, "unknown.txt"), "never sweep this");
  const prepared = await f.recovery(value, "discardStage");
  const result = await recoverLibrary(f.journals, f.adapter, prepared.command, prepared.fingerprint, f.validation, f.validateMedia, f.recycle);
  assert.equal(result.error, null); assert.equal(await present(f.journals.stage(value)), false);
  assert.equal(await readFile(path.join(neighbor, "unknown.txt"), "utf8"), "never sweep this");
  assert.equal((await f.journals.read(value.operationId)).phase, "discarded");
});
test("tampered journal stage identities and damaged receipts are rejected without cleanup", async t => {
  const f = await fixture(t), value = await f.staged(), filename = f.journals.file(value.operationId);
  const original = await readFile(filename, "utf8");
  for (const stage of [{ location: "state", name: value.stage.name }, { location: "library", name: ".manager-import-" + randomUUID() },
    { location: "library", name: "../outside" }]) {
    await writeFile(filename, JSON.stringify({ ...value, stage }));
    await assert.rejects(f.journals.read(value.operationId), code("IO_ERROR")); assert.equal(await present(f.journals.stage(value)), true);
  }
  await writeFile(filename, "{broken"); await assert.rejects(recoveryPage(f.journals));
  assert.equal(await readFile(filename, "utf8"), "{broken"); assert.equal(await present(f.journals.stage(value)), true);
  await writeFile(filename, original);
});
test("preset recycle failure reports pending cleanup and explicit recovery preserves its provenance", async t => {
  const f = await fixture(t, "macos"), local = await f.theme("preset-removable"); await f.theme("preset-keep");
  const expectedRevision = (await themeDetails(local)).revision, operationId = id();
  const command = { method: "themes.delete", params: { operationId, theme: local.ref, expectedRevision } };
  const prepared = await prepareDeletion(f.journals, f.adapter, command);
  await f.journals.begin(operationId, "themes.delete", local.ref, expectedRevision);
  const removed = await deleteTheme(f.journals, f.adapter, command, prepared.challenge.fingerprint, f.recycle);
  assert.equal(removed.deleted, true); assert.equal(removed.cleanupPending, true); assert.equal(removed.error, null);
  await f.journals.finish(operationId, removed);
  const value = await f.journals.read(operationId), stage = f.journals.stage(value);
  assert.equal(value.phase, "removed"); assert.equal(await present(stage), true);
  assert.equal(JSON.parse(await readFile(path.join(f.state, "deleted-presets", local.ref.id), "utf8")).id, local.ref.id);
  const recovery = await f.recovery(value, "cleanupDeleted"), fakeTrash = path.join(f.root, "fake-trash");
  const result = await recoverLibrary(f.journals, f.adapter, recovery.command, recovery.fingerprint, f.validation, f.validateMedia,
    async transaction => rename(f.journals.stage(transaction), fakeTrash));
  assert.equal(result.error, null); assert.equal(result.cleanupPending, false); assert.equal(result.recoveryCompleted, true);
  assert.equal(await present(stage), false); assert.equal(treeRevision(await treeSnapshot(fakeTrash)), treeRevision(value.tree));
  assert.equal((await f.journals.read(operationId)).phase, "final");
});
