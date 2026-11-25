/** One authoritative input/output fixture consumed by both TableGrid and the headless server observation. */
export const GRID_OBSERVATION_PARITY = {
    choicesSchema: "CREATE TABLE choices (id TEXT PRIMARY KEY, observed_on DATE NOT NULL, hidden TEXT)",
    notesSchema: "CREATE TABLE notes (id TEXT PRIMARY KEY, observed_at TIMESTAMP NOT NULL, hidden TEXT)",
    choicesRow: { observed_on: "2026-11-21", hidden: "choice-secret" },
    notesRow: { observed_at: "2026-11-22 12:34:56", hidden: "note-secret" },
    branchA: "SELECT 'choices' AS source_kind, id AS source_id, observed_on AS value, hidden AS hidden FROM choices",
    branchB:
        "SELECT 'notes' AS source_kind, id AS source_id, observed_at + INTERVAL '0 seconds' AS value, hidden AS hidden FROM notes",
    expectedVisibleValues: ["2026-11-21", "2026-11-22T12:34:56.000Z"],
    expectedAmbiguousValues: ["2026-11-21T00:00:00.000Z", "2026-11-22T12:34:56.000Z"],
} as const;
