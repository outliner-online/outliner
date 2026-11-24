<script lang="ts">
import { page } from "$app/state";
import { decodeCalendarObservationContext } from "$shared/notifications/calendarProjection";
import CalendarDetailView from "../../../../../components/management/CalendarDetailView.svelte";

let projectName = $derived(page.params.demoProject ?? "");
let calendarName = $derived(page.params.calendar ?? "");
let contextResult = $derived.by(() => {
    if (!page.url.searchParams.has("context")) return undefined;
    return decodeCalendarObservationContext(page.url.searchParams.get("context") ?? "");
});
</script>

{#if contextResult && !contextResult.valid}
    <p role="alert" data-testid="calendar-context-error">{contextResult.error}</p>
{:else}
    <CalendarDetailView
        {projectName}
        {calendarName}
        observationContext={contextResult?.valid ? contextResult.context : undefined}
    />
{/if}
