const { createRequire } = require("node:module");
const path = require("node:path");
// Use the same locked SDK as the browser callers, not an invented token.
const clientRequire = createRequire(
  path.join(__dirname, "../../client/package.json"),
);
const { initializeApp, deleteApp } = clientRequire("firebase/app");
const { getAuth, connectAuthEmulator, signInAnonymously } = clientRequire(
  "firebase/auth",
);
const { initializeApp: initializeAdmin, deleteApp: deleteAdmin } = require(
  "firebase-admin/app",
);
const { getFirestore } = require("firebase-admin/firestore");
const { randomUUID } = require("node:crypto");

// This suite deliberately has no shared mock/setup: all HTTP crosses Hosting.
const projectId = "demo-schedule-contract";
const origin = "http://127.0.0.1:57100";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:58180";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:59199";
const admin = initializeAdmin({ projectId }, "schedule-contract");
const db = getFirestore(admin);
const app = initializeApp({ projectId, apiKey: "emulator-only" });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:59199", { disableWarnings: true });
const pageId = `private-schedule-${randomUUID()}`;
const collection = db.collection("pages").doc(pageId).collection("schedules");
const schedule = {
  strategy: "one_shot",
  nextRunAt: Date.now() + 86400000,
  params: {},
};
let idToken;

async function call(operation, body) {
  return globalThis.fetch(`${origin}/api/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pageId, ...body }),
    signal: globalThis.AbortSignal.timeout(20000),
  });
}
async function state() {
  return (await collection.orderBy("nextRunAt").get()).docs.map(doc => ({
    id: doc.id,
    ...doc.data(),
  }));
}
beforeAll(async () => {
  const credential = await signInAnonymously(auth);
  idToken = await credential.user.getIdToken();
  await db.collection("pages").doc(pageId).set({
    title: "Private Schedule contract fixture",
  });
});
afterAll(async () => {
  await db.recursiveDelete(db.collection("pages").doc(pageId));
  await deleteApp(app);
  await deleteAdmin(admin);
});

test("SDK credentials exercise all five Hosting rewrites with actual effects", async () => {
  const create = await call("create-schedule", { idToken, schedule });
  expect(create.status).toBe(200);
  expect(create.headers.get("content-type")).toContain("application/json");
  const { scheduleId } = await create.json();
  expect(typeof scheduleId).toBe("string");
  expect((await collection.doc(scheduleId).get()).data().createdBy).toBe(
    auth.currentUser.uid,
  );
  const beforeRead = await state();
  const list = await call("list-schedules", { idToken });
  expect(list.status).toBe(200);
  expect((await list.json()).schedules.map(entry => entry.id)).toContain(
    scheduleId,
  );
  const calendar = await call("export-schedules-ical", { idToken });
  expect(calendar.status).toBe(200);
  expect(calendar.headers.get("content-type")).toContain("text/calendar");
  expect(calendar.headers.get("content-disposition")).toContain(
    `outliner-schedules-${pageId}.ics`,
  );
  expect(await calendar.text()).toContain("BEGIN:VCALENDAR");
  expect(await state()).toEqual(beforeRead);
  const updated = { ...schedule, nextRunAt: schedule.nextRunAt + 60000 };
  const update = await call("update-schedule", {
    idToken,
    scheduleId,
    schedule: updated,
  });
  expect(update.status).toBe(200);
  expect(await update.json()).toEqual({ success: true });
  expect((await collection.doc(scheduleId).get()).data().nextRunAt).toBe(
    updated.nextRunAt,
  );
  const cancel = await call("cancel-schedule", { idToken, scheduleId });
  expect(cancel.status).toBe(200);
  expect(await cancel.json()).toEqual({ success: true });
  expect((await collection.doc(scheduleId).get()).exists).toBe(false);
});

for (
  const operation of [
    "create-schedule",
    "list-schedules",
    "update-schedule",
    "cancel-schedule",
    "export-schedules-ical",
  ]
) {
  test(`${operation}: invalid-string and missing credentials are distinct failures without effects`, async () => {
    const ref = collection.doc(`retained-${operation}`);
    await ref.set({
      ...schedule,
      createdBy: auth.currentUser.uid,
      executedAt: null,
    });
    const before = await state();
    const payload = { schedule, scheduleId: ref.id };
    const invalid = await call(operation, {
      ...payload,
      idToken: "not-a-firebase-id-token",
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("content-type")).toContain("application/json");
    expect(await invalid.json()).toEqual({ error: "Authentication failed" });
    expect(await state()).toEqual(before);
    const missing = await call(operation, payload);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "Invalid request" });
    expect(await state()).toEqual(before);
  });
}

test("SPA fallback cannot satisfy the authentication response oracle", async () => {
  const response = await globalThis.fetch(`${origin}/not-a-schedule-function`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  await expect(response.json()).rejects.toThrow();
});
