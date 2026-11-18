# ESLint promotion PR permission runbook

The ESLint promotion workflow detects candidates and uses the repository
`GITHUB_TOKEN` to create a reviewable pull request. The job-level
`contents: write` and `pull-requests: write` declarations are necessary, but
they do not override the repository or organization policy that controls
whether GitHub Actions may create pull requests.

## Current external-only disposition

Issue #5939 records the refusal from scheduled run `43851254994`, job
`133244082695`, at main SHA
`085c4b3972b3076eb20de1584953bee163aba60e`. Candidate detection and artifact
upload succeeded, and branch `chore/eslint-promote/54` was pushed at
`c46f02e41a7267957ba4f19e2713225b71223971`, but the Create Pull Request step
failed. An independent lookup found no pull request for that branch.

An authenticated read of
`GET /repos/outliner-online/outliner/actions/permissions/workflow` returned:

```json
{
    "default_workflow_permissions": "read",
    "can_approve_pull_request_reviews": false
}
```

This establishes an external permission prerequisite, not a workflow-code or
library defect. It does not establish when or why the setting changed, whether
an organization or enterprise policy constrains it, or whether repository
transfer caused the refusal.

## Required owner action

A repository owner must separately approve and enable **Allow GitHub Actions
to create and approve pull requests** under **Settings > Actions > General >
Workflow permissions**. Do not expand workflow privileges, substitute another
credential, bypass the policy, or treat historical approval as current
approval.

Remain blocked until that action is approved and completed. Do not retry merely
because detection succeeded or the proposal branch exists.

## Authorized verification

After the prerequisite is completed:

1. Read the effective workflow-permissions endpoint again and retain the
   response with the execution evidence.
2. Read all open and closed pull requests for the intended proposal branch,
   and read the branch SHA and content before dispatching. If the preceding
   outcome is uncertain, repeat these reads before any retry to avoid a
   duplicate proposal.
3. Obtain separate approval before a manual dispatch or test pull request.
4. Execute the normal candidate-to-PR path for the recorded workflow identity.
   Do not use a dry run or no-candidate execution as creation evidence.
5. Independently read back the exact run, job, and head SHA; the created pull
   request's repository, base, and head; the proposal branch SHA; and the
   proposed content.
6. Confirm that a denied creation remains a failed run. Detector success,
   artifact upload, a pushed branch, or unrelated CI does not establish a
   successful candidate-to-PR result.

If the effective setting remains disabled, an organization policy prevents the
owner action, or approval is withheld, record that fact and remain blocked.
Do not modify the workflow to conceal or route around the refusal.
