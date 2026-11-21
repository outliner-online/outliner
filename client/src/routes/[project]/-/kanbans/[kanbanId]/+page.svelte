<script lang="ts">
import { page } from "$app/state";
import KanbanDetailView from "../../../../../components/management/KanbanDetailView.svelte";
import { parseKanbanObservationContext } from "../../../../../../../shared/src/notifications/kanbanProjection";
let projectName = $derived(page.params.project ?? "");
let kanbanId = $derived(page.params.kanbanId ?? "");
let parsed = $derived(parseKanbanObservationContext(page.url.searchParams));
</script>
<KanbanDetailView {projectName} {kanbanId}
    observationContext={parsed.status === "valid" ? parsed.context : undefined}
    contextError={parsed.status === "invalid" ? parsed.reason : undefined}/>
