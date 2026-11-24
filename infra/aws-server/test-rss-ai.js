// One-off end-to-end check of the AI RSS writer in the admin demo workspace. Run on the server as the superstar user:
//   node /opt/superstar/app/infra/aws-server/test-rss-ai.js
// Creates (or reuses) a paused rule, runs one feed check through AI and prints the resulting posts. Nothing is published.
const fs = require('node:fs');
for (const line of fs.readFileSync('/opt/superstar/superstar.env', 'utf8').split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) process.env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
}
const root = '/opt/superstar/app';
const d = require(root + '/packages/data/dist/index.js');
const { importRssRun } = require(root + '/apps/worker/dist/rss.js');
const { writeRssAiPosts } = require(root + '/apps/worker/dist/rss-ai.js');

(async () => {
  const slug = 'superstar-demo-19578bd3';
  const workspace = await d.prisma.workspace.findUnique({ where: { slug } });
  const owner = await d.prisma.membership.findFirst({ where: { workspaceId: workspace.id, role: 'OWNER' } });
  const facebook = await d.prisma.channel.findFirst({ where: { workspaceId: workspace.id, provider: 'facebook' } });
  await d.addRssRule(owner.userId, slug, 'Digital marketing news (AI test)', 'https://neilpatel.com/feed/', [facebook.id], {
    topic: 'Digital marketing tips for small businesses',
    instructions: 'We are Xolnet Technologies: digital marketing, IT products and IT training in India. Friendly, practical tone for business owners; end with a question.',
    image: true,
  });
  const rule = await d.prisma.rssRule.findFirst({ where: { workspaceId: workspace.id, sourceUrl: 'https://neilpatel.com/feed/' } });
  const run = await d.prisma.rssRun.create({ data: { ruleId: rule.id, bucket: new Date() } });
  const before = (await d.prisma.creditAccount.findUnique({ where: { workspaceId: workspace.id } })).available;
  await importRssRun(run.id);
  console.log('run', JSON.stringify(await d.prisma.rssRun.findUnique({ where: { id: run.id }, select: { state: true, imported: true, error: true } })));
  const started = Date.now();
  await writeRssAiPosts(run.id);
  console.log('AI step took', Math.round((Date.now() - started) / 1000), 's');
  const items = await d.prisma.feedImport.findMany({ where: { ruleId: rule.id, aiState: { not: null } }, orderBy: { importedAt: 'desc' }, include: { post: { include: { revisions: true } } } });
  for (const item of items.filter((i) => i.aiState !== 'SKIPPED' || !i.aiNote?.startsWith('Older'))) {
    console.log('\n==', item.aiState, '|', item.title);
    if (item.aiNote) console.log('note:', item.aiNote);
    if (item.post) {
      const revision = item.post.revisions[0];
      console.log('post state:', item.post.state, '| media:', revision.mediaIds.length, '| channels:', revision.channelIds.length);
      console.log('--- post ---\n' + revision.content + '\n--- suggestions ---\n' + item.post.aiNote);
    }
  }
  console.log('\nolder items skipped:', items.filter((i) => i.aiNote?.startsWith('Older')).length);
  const after = (await d.prisma.creditAccount.findUnique({ where: { workspaceId: workspace.id } })).available;
  console.log('credits used:', before - after);
  // Leave the test rule paused so it does not keep running.
  await d.prisma.rssRule.update({ where: { id: rule.id }, data: { enabled: false } });
  await d.prisma.$disconnect();
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
