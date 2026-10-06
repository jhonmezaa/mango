import { z } from 'zod';

import { expect, leaves, note, test } from '../src/fixtures.ts';

// WITH EFFECT (`MANGO_INSTALL_EFFECTS=chat`): one short question to the agent of the release,
// which has to call a tool. It spends budget of the person who asks. Leaves: one conversation
// in that person's history (the API has no way to delete it), its events in Auditoría and the
// cost of one turn.

const agents = z.looseObject({
  items: z.array(z.looseObject({ id: z.string(), name: z.string() })),
});

test('one question to the agent is answered with a tool call', async ({
  as,
  config,
  needsEffect,
}, testInfo) => {
  needsEffect('chat');
  const chat = config.chat;
  test.skip(!chat, 'la configuración no trae la sección «chat»');
  if (!chat) return;
  test.setTimeout(240_000);
  const session = await as(chat.role);
  const { page } = session;

  const listed = agents.parse((await session.api('GET', '/api/agents')).body);
  const agent = listed.items.find((item) => item.name === chat.agent);
  expect(agent, 'the agent of the configuration is in the Marketplace of this person').toBeTruthy();
  if (!agent) return;
  leaves(
    testInfo,
    `Una conversación con «${chat.agent}» en el historial de «${chat.role}», sus eventos en Auditoría y el costo de un turno en su presupuesto.`,
  );

  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat') {
      sent.push(request.url());
    }
  });
  await page.goto(`/?agent=${encodeURIComponent(agent.id)}`);
  const input = page.getByRole('textbox', { name: `Mensaje a ${chat.agent}` });
  await input.fill(chat.question);
  const answered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/chat' && response.request().method() === 'POST',
  );
  answered.catch(() => undefined);
  await input.press('Enter');
  // The body is a stream the browser consumes: its events are judged by what the screen shows.
  expect((await answered).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Cancelar respuesta', exact: true })).toHaveCount(
    0,
    { timeout: 180_000 },
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  const answer = page.getByRole('article').last();
  await expect(answer.getByRole('heading', { name: 'Agente' })).toBeAttached();
  // «1 herramienta · 3,8 s»: the tools the agent called in this turn (the time is only there
  // right after the answer, not when the conversation is opened again).
  const tools = answer.getByRole('button', { name: /^\d+ herramientas?(?: ·|$)/ });
  await expect(tools, 'the agent called at least one tool').toBeVisible();
  await expect(answer.getByRole('paragraph').first()).toContainText(/\S{3,}/);
  expect(sent, 'exactly one question left the browser').toHaveLength(1);
  note(
    testInfo,
    `chat: 1 pregunta a «${chat.agent}», respondida con ${(await tools.innerText()).replace(/\s+/g, ' ').trim()}.`,
  );
});
