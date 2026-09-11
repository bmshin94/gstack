# Plan: show or hide the sign-in password

## User goal
Let a person inspect the password they have typed before signing in, then hide it
again. Add a visibility control beside the existing password field.

## Existing behavior
The sign-in form is in `src/main.tsx`. Its password input uses `type="password"`,
`name="password"`, and `autoComplete="current-password"`. Submitting posts email
and password to `/api/login`; successful login navigates to `/workspace`.
Credential checking and session creation live in `src/server.ts` and `src/auth.ts`.

## Proposed UI
Start hidden. A text button changes between “Show password” and “Hide password”
and switches visibility without submitting the form, changing the value, or
replacing the input. Keep the existing autocomplete behavior. The control needs
a clear accessible name, keyboard operation, visible focus, and a layout that
fits the existing narrow sign-in form on mobile. Visibility is local to the
mounted form; do not store or log the password or visibility preference.

## Verification to plan
Cover show → hide, unchanged submitted value, normal Enter-to-submit behavior,
keyboard focus, and a fresh form returning to hidden. Include a browser check
that typing and password-manager autofill still work with the visibility control.

## Scope
This proposal does not add an endpoint or change credential validation, session
cookies, login errors, or the post-login destination. Password reset, strength
meters, remembering visibility, and a form redesign are separate product work.
The control is not implemented; the proposal remains subject to the full review.
