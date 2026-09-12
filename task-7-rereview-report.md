# Task 7 fix re-review (ad53e8b..39eb142)

## Verification

Focused tests pass:

```text
2 files passed, 34 tests passed
```

Command: `cd postgres-interface && npx vitest run src/App.test.tsx src/components/ManagerDashboard.test.tsx`

## Prior findings

- Lifecycle/resource contradiction for an installed run with no resource is now
  derived in `App` and covered by an App test.
- Contradiction and compatibility warnings now take precedence over persisted
  installing/tearing-down progress in `ManagerDashboard`; the new regression
  test covers installing.
- The client/wire is created from an effect and cleanup is deferred by a
  generation check, which preserves one wire through React StrictMode effect
  replay. The unmount test now waits for the deferred cleanup and passes.

## Remaining finding

**Medium — client factory changes can reuse the old client and leak its wire.**

In `App.tsx`, the client-ownership effect depends on `createClient`, but its
setup checks only `clientRef.current === null`. On a real factory prop change,
the previous effect cleanup has only queued its microtask; the replacement
effect runs first, sees the still-populated ref, and adopts the old client
instead of calling the new factory. Its generation then causes the old cleanup
microtask to return without ending the old wire. This violates the stated
“replaced or component unmounts” ownership contract and can retain callbacks
and resources. StrictMode replay is the case the generation guard needs to
support, so the fix should distinguish replay from a genuine dependency
change (or synchronously retire/replace the prior client when the factory
identity changes).

## Conclusion

The previously reported rendering, contradiction-priority, and StrictMode
cleanup issues are fixed and focused tests pass. The factory-identity edge
case above remains before considering the fix package fully resolved.
