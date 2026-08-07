import type { PackageJson } from '../project/discover.js';

/**
 * A framework adapter contributes detection, the preferred dev script,
 * default port expectations, URL-parsing hints, and error-overlay selectors.
 * Adding a framework means adding one adapter — the core never special-cases.
 */
export interface FrameworkAdapter {
  id: string;
  displayName: string;
  /** Return true when this framework drives the project. */
  detect(pkg: PackageJson, projectRoot: string): boolean;
  /** Script names to try, in order, from package.json "scripts". */
  devScriptCandidates: string[];
  /** Default port the framework uses when free. */
  defaultPort: number | null;
  /**
   * Regexes applied to dev-server stdout/stderr to find the served URL.
   * First capture group must be the URL.
   */
  urlPatterns: RegExp[];
  /** CSS selectors whose presence indicates a framework error overlay. */
  errorOverlaySelectors: string[];
  /** Root element selectors the app is expected to mount into. */
  appRootSelectors: string[];
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

export const nextAdapter: FrameworkAdapter = {
  id: 'next',
  displayName: 'Next.js',
  detect: (pkg) => hasDep(pkg, 'next'),
  devScriptCandidates: ['dev'],
  defaultPort: 3000,
  urlPatterns: [
    /Local:\s+(https?:\/\/\S+)/i,
    /ready.*?(https?:\/\/(?:localhost|127\.0\.0\.1):\d+)/i,
    /url:\s+(https?:\/\/\S+)/i,
  ],
  errorOverlaySelectors: ['nextjs-portal', '#__next-build-error', '[data-nextjs-dialog-overlay]'],
  appRootSelectors: ['#__next', 'body > main', '[data-nextjs-router]'],
};

export const viteAdapter: FrameworkAdapter = {
  id: 'vite',
  displayName: 'Vite',
  detect: (pkg) => hasDep(pkg, 'vite'),
  devScriptCandidates: ['dev', 'start'],
  defaultPort: 5173,
  urlPatterns: [/Local:\s+(https?:\/\/\S+?)\/?\s/i, /Local:\s+(https?:\/\/\S+)/i],
  errorOverlaySelectors: ['vite-error-overlay'],
  appRootSelectors: ['#root', '#app'],
};

export const genericAdapter: FrameworkAdapter = {
  id: 'generic',
  displayName: 'Node.js (generic)',
  detect: () => true,
  devScriptCandidates: ['dev', 'start', 'serve'],
  defaultPort: null,
  urlPatterns: [
    /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?)/i,
    /listening on(?:.*?port\s+)?.*?(\d{2,5})/i,
  ],
  errorOverlaySelectors: [],
  appRootSelectors: ['#root', '#app', '#__next', 'main'],
};

/** Order matters: first match wins; generic is the fallback. */
export const ADAPTERS: FrameworkAdapter[] = [nextAdapter, viteAdapter, genericAdapter];

export function detectFramework(pkg: PackageJson | null, projectRoot: string): FrameworkAdapter {
  if (!pkg) return genericAdapter;
  for (const adapter of ADAPTERS) {
    if (adapter.detect(pkg, projectRoot)) return adapter;
  }
  return genericAdapter;
}

export function adapterById(id: string | undefined): FrameworkAdapter | null {
  if (!id) return null;
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

/** Pick the dev script and its command line, if any. */
export function detectDevScript(
  pkg: PackageJson | null,
  adapter: FrameworkAdapter,
): { script: string; commandLine: string } | null {
  const scripts = pkg?.scripts ?? {};
  for (const candidate of adapter.devScriptCandidates) {
    const line = scripts[candidate];
    if (line) return { script: candidate, commandLine: line };
  }
  return null;
}
