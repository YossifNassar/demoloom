// The example flow: add a task, start it, finish it. Record it with
//   demoloom record examples/todo/flow.mjs
// then render it with
//   demoloom render examples/todo --shape=both
export default {
  url: './app.html',                      // served on http://localhost:4173/app.html
  viewport: { width: 1440, height: 900 }, // recorded at DPR 2

  async run(loom) {
    const { page } = loom;
    const TASK = 'Write the launch post';
    const card = (col) => page.locator(`[data-col=${col}] .card`, { hasText: TASK });
    await loom.wait(0.8);

    await loom.beat('add');
    await loom.type(page.getByPlaceholder('Add a task...'), TASK, { label: 'task title' });
    await loom.click(page.getByRole('button', { name: 'Add task' }), { label: 'add task' });
    await loom.appear(card('todo'), { label: 'new card' });
    await loom.wait(2.4); // the board syncs: idle time demoloom speeds up

    await loom.beat('start');
    await loom.click(card('todo').getByRole('button', { name: 'Start' }), { label: 'start' });
    await loom.appear(card('doing'), { label: 'in progress' });
    await loom.wait(2.4);

    await loom.beat('finish');
    await loom.click(card('doing').getByRole('button', { name: 'Done' }), { label: 'finish' });
    await loom.appear(card('done'), { label: 'done card' });
    await loom.appear(page.locator('#status:not(.busy)'), { label: 'synced' });
    await loom.wait(1.0);
  },
};
