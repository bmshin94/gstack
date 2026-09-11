# eval-sdk

Synthetic product documentation for this review fixture. The eval-sdk implementation
is not included or installed here; the commands below describe its assumed existing
interface. They are not claims that this fixture can execute an SDK evaluation.

Evaluate an application's outputs against caller-supplied cases. Python 3.10 or
later; install the assumed package with `pip install eval-sdk`. The library is
`eval_sdk`; the companion command is `eval-sdk`.

## Quick start

This neutral example is mirrored in the getting-started guide. The existing
product's offline release checks verify both copies and their output contract.
The fixture does not run those product checks.

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

The readable result shows one case with score 1.0. The application supplies the
metric and decides what scores are acceptable; the SDK has no default quality bar.

**Current first-run requirement:** both the library and CLI block the first eval
for the mandatory five-minute compatibility/conformance check. There is no skip.
The diagnostic report is not consumed by evaluation. No first-run duration has
been measured, and no time-to-hello-world promise is made here.

[Getting started and free-text example](docs/getting-started.md).
[Stuck while getting started?](docs/feedback.md).

This is ordinary documentation, with no interactive demo or designed aha sequence.
The beta launch still has no selected primary developer persona or peer-DX study.
