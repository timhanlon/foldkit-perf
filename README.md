# foldkit: a stack trace per `h.submodel` per render

Minimal repro for foldkit **0.170.0** (also 0.169.0; `dist/html/boundary.js` is identical).

Every render, every `h.submodel` call runs `registerBoundaryWrap`, which calls
`captureCallSite()`:

```js
// node_modules/foldkit/dist/html/boundary.js
const captureCallSite = () => {
    const stack = new Error().stack ?? '';   // captured and formatted…
    const lines = stack.split('\n');         // …split and regex-filtered
    ...
};
export const registerBoundaryWrap = (registry, boundaryId, descriptor, mountOuterDispatch) => {
    assertBoundaryNotSeen(registry, boundaryId);
    const callSite = captureCallSite();      // on every registration, every render
    writeBoundaryWrap(registry, boundaryId, descriptor, mountOuterDispatch, callSite);
};
```

The call site is only read to word the duplicate-`slotId` error, which normally
never fires. This runs in production builds too.

The cost grows with call-stack depth. Constructing an `Error` walks the stack even
with the default `Error.stackTraceLimit` of 10: ~3µs at depth 10, ~26µs at depth 200
in this repro's micro-benchmark. Inside a real application's render the stack is
deep (nested views, the Effect runtime).

## Run

```sh
pnpm install
pnpm build && pnpm preview   # production build; `pnpm dev` also reproduces
```

Open the page and click **Run benchmark** (10 warm-up re-renders, then 60 measured).
Each re-render changes the model, so every slot re-renders.

| Query | Meaning |
| --- | --- |
| *(none)* | foldkit as published |
| `?patched=1` | the proposed fix below, applied by `vite.config.ts` |
| `?pad=150` | 150 extra plain call frames around each row, standing in for a deeper app |
| `?rows=N&depth=N` | `rows × depth` nested `h.submodel` slots (default 40 × 4 = 160) |
| `?count=1` | count `Error` constructions per render (the counting Proxy skews timings) |
| `?duplicate=1` | repeat a `slotId` to show the duplicate error (works with `&patched=1`) |

## Results

Production build, headless Chrome 156, Apple Silicon. Medians over 60 re-renders,
from the first `view` call to the end of the render task:

| Case | As published | `?patched=1` |
| --- | --- | --- |
| 160 slots | 1.4–3.2 ms (≈9–20 µs/slot) | 0.2–0.5 ms |
| 160 slots, `?pad=150` | 4.6 ms (≈29 µs/slot) | 0.3 ms |
| 320 slots, `?depth=8` | 3.1 ms | 0.3 ms |
| `Error` constructions per render (`?count=1`) | 160 | 0 |

In a real application this was larger. On a docs page of the app where this was
found, a sidebar toggle re-rendered 77 slots at ~160µs each, because the render stack
is deep. JS per toggle dropped from 28ms to 12ms with the fix, and the toggle frame
went from a 34ms median, with 3 in 10 over 50ms, to 17ms (one 60Hz frame).

## Proposed fix

Keep one call site per boundary id across renders, and format the frames only when
the error message interpolates them. Duplicate detection (`seenThisRender`) is
unchanged, and the error still names both registrations. `?duplicate=1` shows the
same message in both modes.

```diff
 export const createBoundaryRegistry = () => ({
     ...
     dedupeSeen: new Set(),
+    callSites: new Map(),
 });
-const captureCallSite = () => {
-    const stack = new Error().stack ?? '';
+const formatCallSite = (stack) => {
     const lines = stack.split('\n');
     ...
     return '(call site unavailable)';
 };
+const captureCallSite = () => {
+    const error = new Error();
+    let formatted;
+    return { toString: () => (formatted ??= formatCallSite(error.stack ?? '')) };
+};
 ...
 export const registerBoundaryWrap = (registry, boundaryId, descriptor, mountOuterDispatch) => {
     assertBoundaryNotSeen(registry, boundaryId);
-    const callSite = captureCallSite();
+    const callSite = registry.callSites.get(boundaryId) ?? captureCallSite();
+    registry.callSites.set(boundaryId, callSite);
     writeBoundaryWrap(registry, boundaryId, descriptor, mountOuterDispatch, callSite);
 };
```

Alternatives: capture only when `import.meta.hot` is set (the convention
`duplicateIdScanner` already uses). That would make production free but leave
development slow. Or drop the first call site from the message.

## Related: call-site frame filter

`captureCallSite` skips frames whose text includes `captureCallSite` or
`at submodel`. In a minified build those names are mangled, so both "First/Second
registration" lines point at the capture helper (`at XE (index-….js:98:430)`). In
Node the frame reads `at Object.submodel`, which `at submodel` does not match. In
both cases the message names foldkit internals instead of the caller.

## Files

- `src/main.ts`: the app (rows of nested `h.submodel` slots) and the benchmark
- `index.html`: query parameters, the `Error` counter, and the A/B switch
- `vite.config.ts`: applies the proposed fix to `foldkit/dist/html/boundary.js`,
  gated at runtime by `?patched=1`
