<!-- AUTO-GENERATED from phase-close.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
Read this section afresh when the current phase's review work finishes. Use the
phase, amendment checkpoint and methodology path bound at that phase's exit.
This section prepares the full readback and publication packet for the current phase.
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
3. **Prepare this phase's close packet.** Run with the exit's phase/checkpoint:
```bash
bun "<SNAPSHOT_TOOL>" prepare-close "<PHASE>" "<ACTIVE_PLAN>" "<AMENDMENT_CHECKPOINT>" "<RESTORE_PATH>" "<methodologyPath>"
```
This applies the accepted requirements and exports a separate immutable close
packet. The blind reviewer input stays unchanged. The packet binds the current
phase, fixed checkpoint and implementation hashes; its complete implementation
text is followed by this phase's semantic verification and parent report.
4. **Read and execute the complete close packet.** For every returned `readRanges`
   entry, issue a Read of `closePacketPath` with that entry's exact `offset` and
   `limit`. Finish all ranges through EOF, including the continuation after the
   implementation. A Read of only the edited tail does not satisfy this step;
   previous snapshots do not satisfy it. If a result is truncated, read its missing
   ranges. If a Read fails, repair it and finish the missing ranges. Do not advance
   on a request without its result. Execute the packet's verification and publication
   continuation now; a successful helper result or Read never completes a phase.
   If verification requires an implementation or accepted-decision edit, regenerate
   the packet with the same checkpoint and Read the entire new packet before publication.

The packet owns the close continuation; the driver owns advancement after the
actual visible parent report. Do not resume at a later phase merely because the
implementation readback finished. After compaction, resume the current packet's
first incomplete step, or regenerate it if its bound inputs changed.
