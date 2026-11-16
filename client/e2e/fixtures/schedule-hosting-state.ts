import { createRequire } from "node:module";
import path from "node:path";

const requireFunctions = createRequire(path.resolve("../functions/package.json"));
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:58180";
const { initializeApp, deleteApp } = requireFunctions("firebase-admin/app");
const { getFirestore } = requireFunctions("firebase-admin/firestore");
const app = initializeApp({ projectId: "demo-schedule-contract" }, "private-hosting-fixtures");
const db = getFirestore(app);
export const scheduleCollection = (pageId: string) => db.collection("pages").doc(pageId).collection("schedules");
export async function scheduleState(pageId: string) {
    return (await scheduleCollection(pageId).orderBy("nextRunAt").get()).docs.map(
        (doc: { id: string; data(): unknown; }) => ({ id: doc.id, data: doc.data() }),
    );
}
export async function removeScheduleFixture(pageId: string) {
    await db.recursiveDelete(db.collection("pages").doc(pageId));
}
export async function closeScheduleFixtures() {
    await deleteApp(app);
}
