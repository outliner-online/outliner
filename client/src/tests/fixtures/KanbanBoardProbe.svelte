<script lang="ts">
    import type { KanbanObservationContextV1 } from "$shared/notifications/kanbanProjection";
    import type * as Y from "yjs";

    interface Props {
        projectDoc: Y.Doc;
        context?: KanbanObservationContextV1;
    }

    let { projectDoc, context }: Props = $props();
</script>

<p data-testid="kanban-board-probe">{projectDoc.guid}:{context?.locale}:{context?.timeZone}</p>
