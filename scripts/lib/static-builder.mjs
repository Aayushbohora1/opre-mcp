/**
 * The deterministic builder shared by the demos and the comparison harness.
 *
 * It renders whatever evidence it is handed and nothing it was not given:
 * raw HTML yields text and hrefs; OPRE evidence additionally yields form fields,
 * controls, image alts, landmarks and design tokens. Because the renderer is
 * identical in every mode, a fidelity difference measured across modes reflects
 * the *shape of the information*, not the quality of the code.
 */

export const SERVER_SOURCE = `const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const map = JSON.parse(readFileSync(join(__dirname, 'routes.json'), 'utf8'));
http
  .createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const file = map[pathname] ?? map['/'];
    if (file === undefined) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Not found</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(readFileSync(join(__dirname, file), 'utf8'));
  })
  .listen(Number(process.env.PORT || 4173), '127.0.0.1');
`;

/**
 * Renders one page from a normalised evidence record.
 *
 * @param {{route:string,title:string,headings:{level:number,text:string}[],
 *   text?:string[],links?:string[],forms?:{method:string,fields:string[]}[],
 *   interactive?:string[],images?:string[],landmarks?:string[],
 *   tokens?:{colors?:string[],fontFamilies?:string[],fontSizes?:string[],radii?:string[]}}} page
 */
export function renderPage(page) {
  if (page === undefined) {
    return '<!doctype html><html><body><h1>Not found</h1></body></html>';
  }

  const tokens = page.tokens ?? {};
  const [first, second, third] = tokens.colors ?? [];
  const radius = tokens.radii?.[0];
  const style = [
    tokens.fontFamilies?.[0] !== undefined
      ? `body{font-family:${escapeHtml(tokens.fontFamilies[0])},system-ui,sans-serif}`
      : '',
    tokens.fontSizes?.[0] !== undefined ? `body{font-size:${escapeHtml(tokens.fontSizes[0])}}` : '',
    first !== undefined ? `body{color:${escapeHtml(first)}}` : '',
    second !== undefined ? `body{background:${escapeHtml(second)}}` : '',
    third !== undefined ? `a{color:${escapeHtml(third)}}` : '',
    radius !== undefined ? `button,input{border-radius:${escapeHtml(radius)}}` : '',
  ]
    .filter(Boolean)
    .join('');

  const landmarks = new Set(page.landmarks ?? []);
  const headings = page.headings ?? [];
  const headingTexts = new Set(headings.map((heading) => heading.text));
  const links = (page.links ?? []).slice(0, 20);

  const main = [];
  for (const heading of headings) {
    const level = Math.min(6, Math.max(1, heading.level));
    main.push(`<h${level}>${escapeHtml(heading.text)}</h${level}>`);
  }
  for (const block of page.text ?? []) {
    if (!headingTexts.has(block)) {
      main.push(`<p>${escapeHtml(block)}</p>`);
    }
  }
  for (const form of page.forms ?? []) {
    main.push(`<form method="${escapeHtml(form.method ?? 'get')}">`);
    for (const field of form.fields ?? []) {
      const [name, rest] = field.split(':');
      const required = rest?.endsWith('*') === true;
      const type = (rest ?? 'text').replace('*', '');
      main.push(
        `<label>${escapeHtml(name)} <input name="${escapeHtml(name)}" type="${escapeHtml(type)}"${required ? ' required' : ''}></label>`,
      );
    }
    main.push('<button type="submit">Submit</button></form>');
  }
  for (const control of page.interactive ?? []) {
    main.push(`<button type="button">${escapeHtml(control.split(':').pop() ?? control)}</button>`);
  }
  for (const alt of page.images ?? []) {
    main.push(`<img alt="${escapeHtml(alt)}" width="120" height="80">`);
  }

  // Landmarks mirror what the fingerprint observed: structure is reproduced, not guessed.
  const body = [];
  if (landmarks.has('header')) {
    body.push('<header>');
  }
  if (landmarks.has('nav')) {
    body.push(
      `<nav>${links.map((link) => `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`).join('')}</nav>`,
    );
  } else {
    body.push(...links.map((link) => `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`));
  }
  if (landmarks.has('main')) {
    body.push('<main>', ...main, '</main>');
  } else {
    body.push(...main);
  }
  if (landmarks.has('aside')) {
    body.push('<aside></aside>');
  }
  if (landmarks.has('footer')) {
    body.push('<footer></footer>');
  }
  if (landmarks.has('header')) {
    body.push('</header>');
  }

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    (style === '' ? '' : `<style>${style}</style>`) +
    `<title>${escapeHtml(page.title)}</title></head><body>${body.join('')}</body></html>`
  );
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Writes a runnable static site: one HTML file per route plus a tiny static server. */
export async function writeSite(directory, evidence) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(directory, { recursive: true });

  const routeMap = {};
  let index = 0;
  for (const page of evidence) {
    const file = `page-${index}.html`;
    routeMap[page.route] = file;
    await writeFile(join(directory, file), renderPage(page));
    index += 1;
  }
  const fallback = evidence.find((page) => page.route === '/') ?? evidence[0];
  if (fallback !== undefined) {
    await writeFile(join(directory, 'index.html'), renderPage(fallback));
  }
  await writeFile(join(directory, 'routes.json'), JSON.stringify(routeMap, null, 2));
  await writeFile(join(directory, 'server.js'), SERVER_SOURCE);
  return routeMap;
}
