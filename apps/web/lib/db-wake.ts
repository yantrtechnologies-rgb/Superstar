import {
  AuthorizeSecurityGroupIngressCommand, DescribeSecurityGroupsCommand, EC2Client, RevokeSecurityGroupIngressCommand,
} from '@aws-sdk/client-ec2';
import { DescribeDBInstancesCommand, RDSClient, StartDBInstanceCommand } from '@aws-sdk/client-rds';
import { prisma } from '@cadencedesk/data';

/**
 * The RDS database is stopped by an idle-stop function to save cost. When a visitor arrives and the
 * database cannot be reached, start it (or, if it is running, point the firewall at this PC's current IP).
 * AWS credentials come from the default chain (AWS_PROFILE=superstar-app, a key limited to these actions).
 */
export type DatabaseState =
  | { ready: true }
  | { ready: false; status: 'starting' | 'stopping' | 'firewall' | 'unavailable'; message: string };

const FIREWALL_LABEL = 'Developer PC';
let lastReady = 0;
let lastCheck = 0;
let lastState: DatabaseState | null = null;
let inFlight: Promise<DatabaseState> | null = null;

let lastError = '';

async function reachable(timeoutMs: number) {
  const ping = prisma.$queryRaw`SELECT 1`.then(() => true);
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => { lastError = `no answer in ${timeoutMs} ms`; resolve(false); }, timeoutMs));
  return Promise.race([ping, timeout]).catch((error: unknown) => {
    lastError = error instanceof Error ? error.message : String(error);
    return false;
  });
}

/** Test runs only (DB_ERROR_DETAILS=1): append why the database check failed, since the server log isn't visible there. */
const details = (message: string) => process.env.DB_ERROR_DETAILS === '1' && lastError ? `${message} (${lastError.slice(0, 300)})` : message;

async function publicIp() {
  const res = await fetch('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
  const ip = (await res.text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Unexpected public IP response');
  return ip;
}

async function allowThisPc(region: string, groupIds: string[], port: number) {
  const ec2 = new EC2Client({ region });
  const ip = await publicIp();
  const { SecurityGroups = [] } = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: groupIds }));
  for (const group of SecurityGroups) {
    const ranges = (group.IpPermissions ?? []).filter((p) => p.FromPort === port).flatMap((p) => p.IpRanges ?? []);
    const mine = ranges.filter((r) => r.Description === FIREWALL_LABEL).map((r) => r.CidrIp!).filter(Boolean);
    if (mine.includes(`${ip}/32`)) continue;
    const rule = (CidrIp: string, Description?: string) => [{ IpProtocol: 'tcp', FromPort: port, ToPort: port, IpRanges: [{ CidrIp, Description }] }];
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: group.GroupId, IpPermissions: rule(`${ip}/32`, FIREWALL_LABEL) }));
    for (const old of mine) {
      await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: group.GroupId, IpPermissions: rule(old) })).catch(() => undefined);
    }
    console.info(JSON.stringify({ event: 'db.firewall-updated', group: group.GroupId, removed: mine.length }));
  }
}

async function wake(): Promise<DatabaseState> {
  const id = process.env.RDS_INSTANCE_ID;
  const region = process.env.RDS_REGION ?? process.env.OBJECT_STORAGE_REGION;
  if (!id || !region) return { ready: false, status: 'unavailable', message: details('The database is not reachable right now. Try again in a few minutes.') };
  const rds = new RDSClient({ region });
  const db = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }))).DBInstances?.[0];
  const status = db?.DBInstanceStatus ?? 'unknown';
  if (status === 'stopped') {
    await rds.send(new StartDBInstanceCommand({ DBInstanceIdentifier: id }));
    console.info(JSON.stringify({ event: 'db.wake', id }));
  }
  if (status === 'stopped' || status === 'starting' || status === 'rebooting' || status === 'modifying') {
    return { ready: false, status: 'starting', message: 'The database sleeps when nobody is using it, and it is starting up now. This takes about 5–10 minutes. This page checks again by itself.' };
  }
  if (status === 'stopping') {
    return { ready: false, status: 'stopping', message: 'The database is finishing going to sleep. It will be started as soon as that finishes, in a few minutes. This page checks again by itself.' };
  }
  if (status === 'available') {
    await allowThisPc(region, (db?.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId!).filter(Boolean), db?.Endpoint?.Port ?? 5432);
    // The first connection after a restart can be slow; try once more before showing a message.
    if (await reachable(8000)) { lastReady = Date.now(); return { ready: true }; }
    return { ready: false, status: 'firewall', message: 'Reconnecting to the database. This page checks again in a few seconds.' };
  }
  return { ready: false, status: 'starting', message: `The database is ${status}. This page checks again by itself.` };
}

/** Quick check used by the sign-in pages; starts the database when it is asleep. */
export async function databaseState(): Promise<DatabaseState> {
  if (Date.now() - lastReady < 60_000) return { ready: true };
  if (await reachable(6000)) { lastReady = Date.now(); return { ready: true }; }
  if (lastState && Date.now() - lastCheck < 20_000) return lastState;
  inFlight ??= wake()
    .catch((error) => {
      console.error(JSON.stringify({ event: 'db.wake-failed', message: error instanceof Error ? error.message : String(error) }));
      return { ready: false, status: 'unavailable', message: 'The database is not reachable right now, and it could not be started automatically. Try again in a few minutes.' } as DatabaseState;
    })
    .then((state) => { lastState = state; lastCheck = Date.now(); return state; })
    .finally(() => { inFlight = null; });
  return inFlight;
}
