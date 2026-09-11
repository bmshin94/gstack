# Sign-in password visibility design

## Problem and user outcome
The existing sign-in form masks the password with no way to inspect it. A person
who suspects a typing or autofill mistake must re-enter it without seeing what
went wrong. Propose a reversible show/hide control beside that field.

## Proposed interaction
Use a visible text button, initially “Show password”, changing to “Hide password”
while the existing value is visible. Keep the field and submit button in their
current form. The visibility button does not submit; the normal sign-in action
still does. Keyboard users need an accessible name and visible focus. Keep the
control usable in the existing mobile layout, and keep typed/autofilled values
intact when visibility changes. A newly mounted form starts hidden.

## Existing boundary
`src/main.tsx` owns the current React form and Tailwind classes. The server's
login/session behavior is existing code, not a proposed redesign. The feature is
not implemented. Its implementation and verification proposal is
`.claude/plans/autoplan-password-visibility.md` and remains open to review.
