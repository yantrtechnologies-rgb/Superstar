import { Resolver } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export function outboundHttpsUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search
    || !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(url.hostname)) {
    throw new Error('Use an approved public HTTPS URL.');
  }
  return url;
}

export function allowedOutboundUrl(value: string, allowlist: string | undefined) {
  const url = outboundHttpsUrl(value);
  const allowed = (allowlist ?? '').split(',').some((entry) => {
    try { return outboundHttpsUrl(entry.trim()).href === url.href; } catch { return false; }
  });
  if (!allowed) throw new Error('This HTTPS URL is outside the operator allowlist.');
  return url;
}

export function publicOutboundIpv4(ip: string) {
  try {
    const address = ipaddr.parse(ip);
    return address.kind() === 'ipv4' && address.range() === 'unicast' && ip !== '168.63.129.16';
  } catch {
    return false;
  }
}

export async function pinPublicIpv4(hostname: string, signal: AbortSignal) {
  const addresses = await new Resolver({ timeout: 3000, tries: 2 }).resolve4(hostname);
  signal.throwIfAborted();
  const address = addresses[0];
  if (!address || addresses.some((candidate) => !publicOutboundIpv4(candidate))) {
    throw new Error('The endpoint must resolve to public IPv4 addresses.');
  }
  return address;
}
