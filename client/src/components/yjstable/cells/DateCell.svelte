<script lang="ts">
import { gridDisplayedCell } from "../../../../../shared/src/notifications/gridProjection";
interface Props {
    value: unknown;
    editable: boolean;
    ariaLabel?: string;
    onCommit: (value: string | number | boolean | null) => void;
    onEditStart?: () => void;
    onEditEnd?: () => void;
    onRequestFocus?: () => void;
}

let { value, editable, ariaLabel, onCommit, onEditStart, onEditEnd, onRequestFocus: _ }: Props = $props();
let interactionActive = false;

function beginEdit(): void {
    if (!editable || interactionActive) return;
    interactionActive = true;
    onEditStart?.();
}

function endEdit(): void {
    interactionActive = false;
    onEditEnd?.();
}

const current = $derived((gridDisplayedCell("date", value) as { value: string }).value);
</script>

<input
    type="date"
    class="cell-date"
    aria-label={ariaLabel || "Edit date"}
    value={current}
    disabled={!editable}
    onfocus={beginEdit}
    onblur={endEdit}
    onpointerdown={beginEdit}
    onkeydown={beginEdit}
    onchange={(e) => {
        const v = (e.target as HTMLInputElement).value;
        try {
            onCommit(v === "" ? null : v);
        } finally {
            endEdit();
        }
    }}
/>

<style>
.cell-date {
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    border: none;
    background: transparent;
    padding: 2px 4px;
    font: inherit;
}

.cell-date:disabled {
    color: #4b5563;
}
</style>
