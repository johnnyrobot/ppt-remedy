/**
 * Cloudflare Turnstile: loaded lazily only after the user enables AI for a deck, and a
 * fresh token is obtained for every attempt (spec §15). Client success alone is never
 * trusted; the gateway validates each token server-side.
 */
interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  execute(id: string): void;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | undefined;

function load(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile unavailable')));
    s.onerror = () => {
      loading = undefined;
      reject(new Error('Turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export type ChallengeAction = 'describe_image' | 'describe_link';

export class ChallengeClient {
  /** One widget per action: the action is fixed when a widget is rendered. */
  private widgets = new Map<ChallengeAction, string>();
  private pending: { resolve: (t: string) => void; reject: (e: Error) => void } | undefined;
  private readonly siteKey: string;
  private readonly container: HTMLElement;

  constructor(siteKey: string, container: HTMLElement) {
    this.siteKey = siteKey;
    this.container = container;
  }

  /** Obtain a fresh single-use token for one request. */
  async token(action: ChallengeAction = 'describe_image'): Promise<string> {
    const api = await load();
    let id = this.widgets.get(action);
    if (!id) {
      const host = document.createElement('div');
      this.container.appendChild(host);
      id = api.render(host, {
        sitekey: this.siteKey,
        action,
        execution: 'execute',
        appearance: 'interaction-only',
        callback: (t: string) => this.pending?.resolve(t),
        'error-callback': () => this.pending?.reject(new Error('Challenge failed')),
        'expired-callback': () => this.pending?.reject(new Error('Challenge expired')),
      });
      this.widgets.set(action, id);
    } else {
      api.reset(id);
    }
    const widgetId = id;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Challenge timed out')), 60_000);
      this.pending = {
        resolve: (t) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve(t);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pending = undefined;
          reject(e);
        },
      };
      api.execute(widgetId);
    });
  }

  dispose(): void {
    if (window.turnstile) for (const id of this.widgets.values()) window.turnstile.remove(id);
    this.widgets.clear();
    this.container.replaceChildren();
  }
}
