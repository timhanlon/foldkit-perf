import { Schema } from 'effect';
import { Runtime, Submodel, type Update } from 'foldkit';
import type { Document, HtmlBuilder } from 'foldkit/html';
import { defineMessageUnion } from 'foldkit/message';

declare global {
  interface Window {
    __errors: number;
  }
  // eslint-disable-next-line no-var
  var __FOLDKIT_CALLSITE_PATCH__: boolean | undefined;
}

const params = new URLSearchParams(location.search);
const ROWS = Number(params.get('rows') ?? 40);
const DEPTH = Number(params.get('depth') ?? 4);
// Extra plain call frames around each row, standing in for a deeper app
// (layouts, wrappers, an effect runtime). Capture cost grows with depth.
const PAD = Number(params.get('pad') ?? 0);
// ?duplicate=1 gives two rows the same slotId, to check the error message.
const DUPLICATE = params.get('duplicate') === '1';
const padded = <A>(frames: number, run: () => A): A => (frames <= 0 ? run() : padded(frames - 1, run));

// MODEL / MESSAGE / UPDATE: one counter; every click re-renders every slot.

const Model = Schema.Struct({ renders: Schema.Number });
type Model = typeof Model.Type;

const Message = defineMessageUnion({ ClickedRerender: {} });
type Message = typeof Message.Type;

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedRerender: () => ({ model: { renders: model.renders + 1 } }),
  });

// VIEW: each row is a chain of DEPTH nested submodels, so ROWS × DEPTH
// h.submodel registrations per render. Nothing here is unusual: a list of
// rows whose cells are submodels (a select, a tooltip, a menu) is enough.

type LevelInputs = { readonly depth: number; readonly row: number };
const Level: Submodel.View<number, never, LevelInputs> = Submodel.defineView<
  number,
  never,
  LevelInputs
>((renders, inputs, h) =>
  h.span(
    [],
    [
      inputs.depth > 1
        ? h.submodel({
            slotId: 'inner',
            model: renders,
            view: Level,
            toParentMessage: (message) => message,
            viewInputs: { depth: inputs.depth - 1, row: inputs.row },
          })
        : `${inputs.row}:${renders}`,
    ],
  ),
);

const renderTimes: number[] = [];
const errorsPerRender: number[] = [];
let measuring = false;

// One sample per frame: from the first view call until the next microtask,
// which covers every child view (h.submodel renders synchronously) and the
// patch that follows in the same task.
const measure = () => {
  if (measuring) return;
  measuring = true;
  const start = performance.now();
  const errorsBefore = window.__errors;
  queueMicrotask(() => {
    measuring = false;
    renderTimes.push(performance.now() - start);
    errorsPerRender.push(window.__errors - errorsBefore);
  });
};

const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  measure();
  const body = h.div(
    [],
    [
      h.button([h.Id('rerender'), h.OnClick(Message.ClickedRerender())], [`Re-render (${model.renders})`]),
      h.div(
        [],
        Array.from({ length: ROWS }, (_, row) =>
          padded(PAD, () =>
            h.submodel({
              slotId: DUPLICATE && row === 1 ? 'row-0' : `row-${row}`,
              model: model.renders,
              view: Level,
              toParentMessage: (message) => message,
              viewInputs: { depth: DEPTH, row },
            }),
          ),
        ),
      ),
    ],
  );
  return { title: 'foldkit h.submodel stack capture', body };
};

const showError = (error: unknown) => {
  document.getElementById('results')!.textContent = String(
    error instanceof Error ? error.message : error,
  );
};
// Foldkit reports a crashed render through console.error.
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  consoleError(...args);
  showError(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
};

Runtime.run(
  Runtime.makeApplication({
    Model,
    init: () => ({ model: { renders: 0 } }),
    update,
    view,
    container: document.getElementById('root')!,
  }),
);



// BENCHMARK (plain DOM, outside the measured view)

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p90 = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)]!;

/** `new Error()` at a given call-stack depth, in microseconds. */
const errorCostAtDepth = (depth: number, iterations = 400) => {
  const at = (d: number): Error => (d === 0 ? new Error() : at(d - 1));
  const start = performance.now();
  for (let i = 0; i < iterations; i++) at(depth);
  return ((performance.now() - start) * 1000) / iterations;
};

document.getElementById('bench')!.addEventListener('click', async () => {
  const out = document.getElementById('results')!;
  out.textContent = 'Running…';
  const button = () => document.getElementById('rerender')!;
  for (let i = 0; i < 10; i++) {
    button().click();
    await frame();
    await frame();
  }
  renderTimes.length = 0;
  errorsPerRender.length = 0;
  for (let i = 0; i < 60; i++) {
    button().click();
    await frame();
    await frame();
  }
  const slots = ROWS * DEPTH;
  const renderMs = median(renderTimes);
  out.textContent = [
    `foldkit 0.170.0${globalThis.__FOLDKIT_CALLSITE_PATCH__ ? ' + proposed fix' : ' (as published)'} · ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? ''}`,
    `h.submodel slots per render: ${slots} (rows=${ROWS}, depth=${DEPTH}, pad=${PAD})`,
    `render per re-render: median ${renderMs.toFixed(2)} ms, p90 ${p90(renderTimes).toFixed(2)} ms`,
    `≈ ${((renderMs * 1000) / slots).toFixed(1)} µs per slot`,
    params.has('count')
      ? `Error constructions per render: ${median(errorsPerRender)}`
      : 'Error constructions per render: (add ?count=1)',
    `new Error() cost: depth 10 ${errorCostAtDepth(10).toFixed(2)} µs, depth 200 ${errorCostAtDepth(200).toFixed(2)} µs, depth 1000 ${errorCostAtDepth(1000).toFixed(2)} µs`,
  ].join('\n');
});
