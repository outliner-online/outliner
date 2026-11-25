import { signInAnonymously } from "firebase/auth";
import { mount } from "svelte";
import { userManager } from "../../../src/auth/UserManager";
import SchedulePage from "../../../src/routes/schedule/+page.svelte";

// Mount the unmodified application page through a static Hosting entry, without
// any SvelteKit server/proxy. No token or storage contents cross this fixture API.
mount(SchedulePage, { target: document.getElementById("app")!, renderer: undefined });
Object.assign(globalThis, {
    async scheduleLogin() {
        await userManager.auth.authStateReady();
        return (await signInAnonymously(userManager.auth)).user.uid;
    },
});
