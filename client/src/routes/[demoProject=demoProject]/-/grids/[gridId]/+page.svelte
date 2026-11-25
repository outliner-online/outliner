<script lang="ts">
import { page } from "$app/state";
import GridDetailView from "../../../../../components/management/GridDetailView.svelte";
import { parseGridObservationContext } from "../../../../../../../shared/src/notifications/gridProjection";

let projectName = $derived(page.params.demoProject ?? "");
let gridId = $derived(page.params.gridId ?? "");
let observation = $derived(parseGridObservationContext(page.url.searchParams.get("observation") ?? undefined));
</script>

<GridDetailView
    {projectName}
    {gridId}
    observationContext={observation.status === "supported" ? observation.context : undefined}
    observationError={observation.status === "unsupported" ? observation.reason : undefined}
/>
