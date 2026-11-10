import { defineConfig, type Plugin } from 'vite';

/** The proposed fix, applied to foldkit's html/boundary.js for the `?patched=1`
 * A/B: registerBoundaryWrap keeps one call site per boundary id, and frames are
 * formatted only when the duplicate-slotId error interpolates them. It is
 * gated on globalThis.__FOLDKIT_CALLSITE_PATCH__ so one build serves both. */
const callSitePatch = (): Plugin => ({
  name: 'foldkit-callsite-patch',
  enforce: 'pre',
  transform(code, id) {
    if (!/foldkit[/\\]dist[/\\]html[/\\]boundary\.js$/.test(id.split('?')[0]!)) return;
    const replace = (from: string, to: string) => {
      if (code.split(from).length !== 2) throw new Error(`foldkit boundary.js changed: ${from}`);
      code = code.replace(from, to);
    };
    // The original capture body becomes the formatter.
    replace(
      "const captureCallSite = () => {\n    const stack = new Error().stack ?? '';",
      'const formatCallSite = (stack) => {',
    );
    replace(
      "    return '(call site unavailable)';\n};",
      `    return '(call site unavailable)';
};
const patched = () => globalThis.__FOLDKIT_CALLSITE_PATCH__ === true;
const callSites = new Map();
const captureCallSite = () => {
    if (!patched()) return formatCallSite(new Error().stack ?? '');
    const error = new Error();
    let formatted;
    return { toString: () => (formatted ??= formatCallSite(error.stack ?? '')) };
};`,
    );
    replace(
      '    const callSite = captureCallSite();\n    writeBoundaryWrap(',
      `    const callSite = (patched() && callSites.get(boundaryId)) || captureCallSite();
    if (patched()) callSites.set(boundaryId, callSite);
    writeBoundaryWrap(`,
    );
    return code;
  },
});

export default defineConfig({
  plugins: [callSitePatch()],
  optimizeDeps: { exclude: ['foldkit'] },
});
