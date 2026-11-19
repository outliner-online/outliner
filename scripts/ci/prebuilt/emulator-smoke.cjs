// All requests are fixed loopback endpoints inside a network-none container.
async function main() {
    const hosting = await fetch("http://127.0.0.1:57100/");
    if (!hosting.ok || (await hosting.text()).trim() !== "prepared-private-fixture") {
        throw new Error("Hosting not ready");
    }
    const routed = await fetch("http://127.0.0.1:57100/api/probe");
    if (!routed.ok || (await routed.json()).preparedFixture !== true) throw new Error("Functions rewrite not ready");
    const auth = await fetch(
        "http://127.0.0.1:59199/identitytoolkit.googleapis.com/v1/accounts:signUp?key=private-fixture",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ returnSecureToken: true }),
        },
    );
    if (!auth.ok || !(await auth.json()).idToken) throw new Error("Private Auth not ready");
    const store = await fetch(
        "http://127.0.0.1:58180/v1/projects/demo-prepared-runtime/databases/(default)/documents/smoke",
    );
    if (!store.ok) throw new Error("Private Firestore not ready");
    console.log("Private Auth/Firestore/Functions/Hosting smoke passed; no production acceptance claim");
}
main().catch(() => {
    console.error("Private emulator smoke failed");
    process.exitCode = 1;
});
