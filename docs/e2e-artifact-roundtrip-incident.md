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

The logs do not expose the identities returned by the action's immediate inventory query, the artifact service request or correlation IDs, or byte availability at that instant. The later REST inventory and the passing rerun of run `44923078390` demonstrate later visibility only. They do not identify whether propagation, an artifact-service incident, or another external condition caused the immediate lookup miss. No repository-controlled cause is established, so this incident does not authorize a retry, delay, alternate lookup, or other repository correction.

## Resolution and next action

The job remains on its single exact-ID download path and retains the existing five-minute timeout, archive semantics, permissions, byte comparisons, and negative controls. A passing native run is evidence that the path worked for that attempt; it is not evidence of the intermittent failure's cause or resolution.

On another occurrence, preserve the complete job log and request the artifact service's server-side lookup evidence, including request or correlation IDs, the identities returned by the immediate inventory query, repository, run, attempt, requested artifact ID, action revisions, and timestamps. Correlate that response with upload finalization and any later REST inventory without treating the later entry or a passing rerun as root-cause evidence. Escalate the evidence upstream before proposing a repository behavior change.
