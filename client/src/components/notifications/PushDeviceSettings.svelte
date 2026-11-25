<script lang="ts">
    import { onMount } from "svelte";
    import { BrowserPushRegistration } from "../../services/notifications/browserPushRegistration";
    const enrollment = new BrowserPushRegistration();
    let status = $state(enrollment.status);
    let detail = $state("");
    let ready = $state(false);
    async function run(action: "enroll" | "disable") {
        const pending = enrollment[action]();
        status = enrollment.status;
        detail = enrollment.detail;
        await pending;
        status = enrollment.status;
        detail = enrollment.detail;
    }
    onMount(async () => {
        await enrollment.reconcile();
        status = enrollment.status;
        detail = enrollment.detail;
        ready = true;
    });
    const labels = { unsupported: "Web Push is unsupported or requires a secure context.", denied: "Notification permission is denied.", unavailable: "Web Push configuration is unavailable.", "not-enrolled": "This browser is not enrolled.", enrolling: "Enrolling this browser…", registered: "This browser is registered.", disabled: "Notifications are disabled for this browser.", failed: "Enrollment failed.", incomplete: "Notification cleanup is incomplete." } as const;
</script>
<section class="mb-8" aria-labelledby="push-heading">
    <h2 id="push-heading" class="text-2xl font-semibold mb-4">Smartphone notifications</h2>
    <p data-testid="push-status" class="mb-3">{labels[status]}</p>
    {#if detail}<p role="alert" class="mb-3 text-red-700">{detail}</p>{/if}
    {#if status === "registered"}
        <button type="button" class="px-4 py-2 rounded bg-gray-700 text-white" onclick={() => run("disable")}>Disable notifications</button>
    {:else if ready && status !== "unsupported" && status !== "denied" && status !== "enrolling"}
        <button type="button" class="px-4 py-2 rounded bg-blue-700 text-white" onclick={() => run("enroll")}>Enable notifications</button>
    {/if}
</section>
