# Getting started

These are documentation examples for the assumed existing SDK. The SDK source,
package and release-check implementation are absent from this review fixture.
Do not run an install or infer a successful execution from these documents.

Install the assumed Python package with `pip install eval-sdk`. The mandatory
five-minute first-run compatibility check applies to both CLI and library evals,
including these examples, with no skip. It is not needed by the evaluator itself.

## Neutral first evaluation

```python
from eval_sdk import evaluate

def target(inputs):
    return {"ready": inputs["enabled"]}

def exact_match(actual, expected):
    # This application's structured-output rule.
    if not isinstance(actual, dict):
        return 0.0
    return float(actual == expected)

cases = [{"inputs": {"enabled": True}, "expected": {"ready": True}}]
result = evaluate(target, cases, exact_match)
print(result)
```

Output contract: one case, score 1.0. Existing offline release checks exercise the
same example and keep the README copy synchronized. No duration assertion exists.

## Caller-owned metric for free text

This separate reference example supplies a real callable, cases and metric. The
simple whitespace-insensitive metric demonstrates the API; applications choose
their own metric and acceptance rule. It is not a production quality threshold.

```python
from eval_sdk import evaluate

def text_metric(actual, expected):
    return float(" ".join(actual.split()) == " ".join(expected.split()))

def prose_target(inputs):
    return inputs["reply"]

cases = [
    {"inputs": {"reply": "The lamp is green."}, "expected": "The lamp is green."},
]
result = evaluate(prose_target, cases, text_metric)
print(result)
```

The public example returns one normal matching result with score 1.0. Separately,
the existing product's offline checks exercise this complete callable/metric path
with matching and mismatching prose and verify scores 1.0 and 0.0 plus the latter
case's expected/actual failure summary.
Structured result fields retain full values; displayed summaries may truncate.
This reference check already exists in the revised synthetic baseline. It adds
no launch gate, evaluator default, telemetry or designed onboarding delight beat.
No executable SDK or assertion of its execution is supplied in this fixture.

## Handling errors

The assumed SDK's existing release checks produce this malformed-case example:

```text
SDK_E001: case 0 is missing 'expected'
Cause: CaseValidationError at cases[0].expected
Next: add the expected output for this case and retry.
Reference: docs/reference-v1.md#sdk-e001
```

This is an authored synthetic output contract, not output obtained by executing
the SDK here. Error codes, originating causes, actionable next steps, secret
redaction, and versioned reference anchors are existing contracts.

## Next steps

- Use the same callable and cases in [pytest](reference-v1.md#api-and-pytest), with
  the application's own acceptance assertion.
- Before substituting a provider-backed callable, configure [deadlines and cost
  limits](reference-v1.md#configuration). Arbitrary application requests require
  their own bounds; SDK-managed limits do not intercept them.
- Run the [noninteractive CLI](reference-v1.md#cli) locally or in CI; the same
  invocation and exit codes apply to both.
- Find [error codes](reference-v1.md#errors), the [beta upgrade contract](reference-v1.md#upgrades),
  and the existing [support path](feedback.md).
