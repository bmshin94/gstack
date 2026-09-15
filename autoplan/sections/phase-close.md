<!-- AUTO-GENERATED from phase-close.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Read this section afresh when the current phase's review work finishes. Use the
phase, amendment checkpoint and methodology path bound at that phase's exit.
This section supplies the publication format and routing for every phase.
Close one phase before the driver starts another.
On hosts that inline sections, reread this close block in the installed Autoplan
SKILL.md at each exit; those hosts do not have a separate phase-close.md file.

1. **Finish and save the review.** Require the phase's full methodology/section
   Reads, required outputs, successful writes and terminal reviewer results.
   Match a completed native review's INPUT to its voice snapshot. A pending
   reviewer keeps the phase open. Apply the phase's failure policy to failed
   native attempts; unavailable/disabled voices receive no completion credit.
2. **Reconcile accepted requirements.** Record every accepted behavior, condition,
   test and manual checklist in this phase's accepted block. Taste remains
   provisional; User Challenges preserve the original requirements. A `None`
   record must explain why the implementation remains unchanged. Keep the
   amendment checkpoint fixed for this invocation, including after compaction.
3. **Export the current implementation.** Run with the exit's phase/checkpoint:
```bash
bun "<SNAPSHOT_TOOL>" amend-input "<PHASE>" "<ACTIVE_PLAN>" "<AMENDMENT_CHECKPOINT>" "<RESTORE_PATH>" "<methodologyPath>"
```
4. **Read the complete new export.** For every returned `readRanges` entry, issue
   a Read of `reviewInputPath` with that entry's exact `offset` and `limit`.
   Finish all ranges through EOF before leaving this readback step. A Read of only the
   edited tail does not satisfy this step; previous snapshots do not satisfy it.
   If a result is truncated, read its missing ranges. If a Read fails, repair it
   and finish the missing ranges. Do not advance on a request without its result.
5. **Verify the actual text.** Compare the complete current implementation with
   the accepted decisions, source requirements, conditions, tests and required
   outputs. Retention checks prove bytes; counts, hashes, keyword probes and a
   saved “Read-back” sentence do not perform this semantic review. Fix omissions,
   then repeat the export and full readback. Review history stays in Review record.
6. **Send the phase's completion message now.** Fill the publication format
   below using the bound phase's row and completed review data. Send it as your
   next visible parent assistant text block, with actual findings and voice
   statuses. Missing outside coverage means N/A consensus, never confirmed.
   Saving the message in ACTIVE_PLAN or printing it through Bash does not send
   it to the user. Send it before any next-phase Read/create/dispatch.

| Phase | Number | Consensus total | Next step |
|---|---|---|---|
| ceo | 1 | 6 | Phase 2 (Design Review) |
| design | 2 | rows in the completed design litmus scorecard | Phase 2.5 (DX Review) if DX scope was detected; otherwise Phase 3 (Eng Review) |
| dx | 2.5 | 6 | Phase 3 (Eng Review — the required gate reviews the final amended plan) |
| eng | 3 | 6 | Phase 4 (Final Gate) |

Use N/A when either review voice is missing; confirmed counts require both voices.
Include the DX score/TTHW line only for `dx`. Send filled text, not the code fence.

```text
**Phase [number] complete.**
[DX only: DX overall: [N]/10. TTHW: [N] min → [target] min.]
Codex: [completed: N concerns / unavailable / disabled]. Claude subagent: [completed: N issues / unavailable].
Consensus: [N/A (voice coverage missing) | X/[total] native+outside confirmed; Y disagreements → gate].
Passing to [next step].
```

After sending, return to the driver and continue in the same turn. After Eng,
continue to final synthesis/approval. The driver emits its declared skip message
for each inapplicable Design or DX phase; a skip is never a completion.
Do not wait for a “continue” reply.
