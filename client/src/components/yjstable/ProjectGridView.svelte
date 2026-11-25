<script lang="ts">
import type * as Y from "yjs";
import type { GridHandles } from "../../services/yjstable/gridDocs";
import YjsTableView from "./YjsTableView.svelte";
import type { GridObservationContextV1 } from "../../../../shared/src/notifications/gridProjection";
interface Props {
    grid: GridHandles;
    projectDoc: Y.Doc;
    projectId?: string;
    projectName?: string;
    placementId?: string;
    pageId?: string;
    pageTitle?: string;
    isReadOnly?: boolean;
    canWrite?: () => boolean;
    observationContext?: GridObservationContextV1;
}
let { grid, projectDoc, projectId, projectName, placementId, pageId, pageTitle, isReadOnly = false, canWrite, observationContext }: Props = $props();
// Preserve the instance during the parent's disappearing-prop teardown.
// svelte-ignore state_referenced_locally
const mountedGrid = grid;
</script>

<YjsTableView grid={mountedGrid} {projectDoc} {projectId} {projectName} {placementId} {pageId} {pageTitle} {isReadOnly} {canWrite} {observationContext} />
