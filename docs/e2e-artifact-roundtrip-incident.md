# E2E artifact round-trip lookup incident

## Observed evidence

On 2026-11-21 UTC, four attempt-1 jobs in `outliner-online/outliner` finalized a positive artifact and then failed to find that exact ID. All used upload action revision `cf430e030ddbb5b0abf93d22962f4752f3646cd9`, download action revision `9000827ccba6bdab643e8b6fd33ac0654aef8333`, and reusable workflow blob `ee0fd0bc8b8218fe3feb20e551cf5bf19d39f1fb`.

| Run / job / attempt                | Revision                                                         | Positive finalization (UTC) | Exact-ID lookup failure (UTC) | Artifact ID   |
| ---------------------------------- | ---------------------------------------------------------------- | --------------------------- | ----------------------------- | ------------- |
| `44920157405` / `136897162133` / 1 | `0d788d6a4e5ad6e7f4fd5e9d1855a5481a94984a`                       | 15:49:05.579                | 15:49:06.639                  | `14714005789` |
| `44923078390` / `136903821251` / 1 | synthetic PR revision `0678e8adc591a4f5e736bb547654777a313aaeea` | 16:12:51.398                | 16:12:52.762                  | `14714283762` |
| `44920327912` / `136895212445` / 1 | synthetic PR revision `4552d023663de08cfe7ff2ca53c56d044dc9382a` | 15:41:11.400                | 15:41:12.369                  | `14713526962` |
| `44920722233` / `136896959003` / 1 | synthetic PR revision `8f08648b3b17210f9eef5872b95e249b1864ce1d` | 15:48:29.277                | 15:48:31.045                  | `14713414714` |

The action logs show the exact positive ID as the `artifact-ids` input. The download action reported an inventory count of one or two artifacts immediately before reporting that none of the requested IDs were found. Later REST inventory responses contained each positive ID as non-expired and associated it with the same repository, run, attempt-specific name, and source head.

## What this evidence does not establish

The logs do not expose the identities returned by the action's immediate inventory query, the artifact service request or correlation IDs, or byte availability at that instant. The later REST inventory and the passing rerun of run `44923078390` demonstrate later visibility only. They do not identify whether propagation, an artifact-service incident, or another external condition caused the immediate lookup miss. No repository-controlled cause is established.

## Recovery and next evidence

The ordinary job uses the same local recovery action as the native failure controls and retries `actions/download-artifact` once, after ten seconds, with the unchanged upload output ID. Each attempt has an isolated destination, and only the successful attempt is compared with the source, so partial files from a failed attempt cannot combine with retry output. The retry is bounded by the existing five-minute job timeout. It does not use a name or run/attempt fallback, and a second miss still fails before byte comparison.

If the retry also fails, preserve the complete job log and request the artifact service's server-side lookup evidence for both action invocations, including request/correlation IDs, inventory identities, repository, run, attempt, artifact ID, action revisions, and timestamps. Do not infer root cause from a later inventory entry or a passing rerun. Escalate that evidence upstream before changing the lookup mechanism or timeout.
