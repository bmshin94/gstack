import { describeE2ETier } from './helpers/e2e-gate';
import { registerOverlayCase } from './helpers/overlay-case';

describeE2ETier('periodic')('overlay efficacy harness (SDK)', () => {
  registerOverlayCase('claude-dedicated-tools-vs-bash');
});
