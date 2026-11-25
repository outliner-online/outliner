<script lang="ts">
import type { CalendarObservationContextV1 } from "$shared/notifications/calendarProjection";

interface Props {
    projectName: string;
    calendarName: string;
    observationContext?: CalendarObservationContextV1;
}

let { projectName, calendarName, observationContext }: Props = $props();
</script>

<div data-testid="calendar-detail-probe">
    {projectName}:{calendarName}:{observationContext?.viewType ?? "ordinary"}:{observationContext?.timeZone ?? "local"}
</div>
