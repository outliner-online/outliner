import { signInAnonymously } from "firebase/auth";
import { userManager } from "../../../src/auth/UserManager";
import * as service from "../../../src/services/scheduleService";

export const scheduleContract = {
    async login() {
        await userManager.auth.authStateReady();
        const { user } = await signInAnonymously(userManager.auth);
        return user.uid;
    },
    ...service,
    async exportCalendar(pageId: string) {
        const { blob, filename } = await service.exportSchedulesIcal(pageId);
        return { text: await blob.text(), filename, type: blob.type };
    },
};
Object.assign(globalThis, { scheduleContract });
