import { createRequire } from "node:module";
import path from "node:path";

// Collection runs without Functions dependencies; initialize only during a real fixture call.
function openFixtures() {
    const requireFunctions = createRequire(path.resolve("../functions/package.json"));
    process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:58180";
    const { initializeApp, deleteApp } = requireFunctions("firebase-admin/app");
    const { getFirestore } = requireFunctions("firebase-admin/firestore");
    const app = initializeApp({ projectId: "demo-schedule-contract" }, "private-hosting-fixtures");
    return { db: getFirestore(app), close: () => deleteApp(app) };
}
let fixtures: ReturnType<typeof openFixtures> | undefined;
const getFixtures = () => fixtures ??= openFixtures();
export const scheduleCollection = (pageId: string) =>
    getFixtures().db.collection("pages").doc(pageId).collection("schedules");
export async function scheduleState(pageId: string) {
    return (await scheduleCollection(pageId).orderBy("nextRunAt").get()).docs.map(
        (doc: { id: string; data(): unknown; }) => ({ id: doc.id, data: doc.data() }),
    );
}
export async function removeScheduleFixture(pageId: string) {
    const { db } = getFixtures();
    await db.recursiveDelete(db.collection("pages").doc(pageId));
}
export async function closeScheduleFixtures() {
    if (fixtures) await fixtures.close();
    fixtures = undefined;
}
