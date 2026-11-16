const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } = require("firebase/auth");

async function seed() {
    const app = initializeApp({ projectId: "demo-schedule-contract", apiKey: "emulator-only" });
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:59199", { disableWarnings: true });
    try {
        await createUserWithEmailAndPassword(auth, "test@example.com", "password");
    } finally {
        await deleteApp(app);
    }
}
seed().catch(() => {
    console.error("Private emulator user setup failed");
    process.exitCode = 1;
});
