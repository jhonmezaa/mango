/**
 * The bridge of an MCP App's inner frame (D125 (3)): the first script of its `srcdoc`, before the
 * app's HTML. It takes the one port the runner hands over (the agreed exception to JS-MSG-001:
 * an opaque origin has no name to target) and delivers what arrives on it to the app as the
 * `message` events of `window.parent` that an MCP App listens to. What the app posts to
 * `window.parent` reaches the runner, which checks that it comes from this frame.
 *
 * Nothing the runner sends travels through `window.postMessage` with a `'*'` target: only the
 * port does. The bridge is as untrusted as the app (same document); the runner believes nothing
 * either says.
 */

const INNER_INIT = 'mango-inner-init';

let port: MessagePort | null = null;

function onInit(event: MessageEvent<unknown>): void {
  const data = event.data as { type?: unknown } | null;
  if (port !== null || event.source !== window.parent || data?.type !== INNER_INIT) return;
  const received = event.ports[0];
  if (event.ports.length !== 1 || received === undefined) return;
  // The app never sees the message that carried the port.
  event.stopImmediatePropagation();
  port = received;
  port.onmessage = (message: MessageEvent<unknown>) => {
    window.dispatchEvent(
      new MessageEvent('message', { data: message.data, source: window.parent }),
    );
  };
}

window.addEventListener('message', onInit);
