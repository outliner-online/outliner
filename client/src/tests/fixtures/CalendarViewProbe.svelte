<script lang="ts">
import type { Project } from "$shared/app-schema";

interface Props {
    project: Project;
    calendarId: string;
}

let { project, calendarId }: Props = $props();
</script>

<div data-testid="calendar-view-probe">{project.ydoc.guid}:{calendarId}</div>
