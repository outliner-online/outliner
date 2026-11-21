<script lang="ts">
import { page } from "$app/state";
import KanbanDetailView from "../../../../../components/management/KanbanDetailView.svelte";
import type { KanbanObservationContextV1 } from "../../../../../../../shared/src/notifications/kanbanProjection";
let projectName = $derived(page.params.demoProject ?? "");
let kanbanId = $derived(page.params.kanbanId ?? "");
let parsed = $derived.by((): { context?: KanbanObservationContextV1; error?: string; } => {
    const parameters = page.url.searchParams;
    const keys = ["surface", "version", "locale", "timeZone"];
    if (!keys.some(key => parameters.has(key))) return {};
    const surface = parameters.get("surface"), version = parameters.get("version");
    const locale = parameters.get("locale"), timeZone = parameters.get("timeZone");
    if (surface !== "board" || version !== "1" || !locale || !timeZone) {
        return { error: "Unsupported Kanban observation context." };
    }
    return { context: { surface: "board", version: 1, locale, timeZone } };
});
</script>
<KanbanDetailView {projectName} {kanbanId} observationContext={parsed.context} contextError={parsed.error}/>
