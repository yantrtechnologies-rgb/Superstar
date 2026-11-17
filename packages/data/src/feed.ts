import { createHash } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import ipaddr from 'ipaddr.js';
import { allowedFeedUrl, RssConfigurationError } from './rss';

const feedLimit = 512 * 1024;

export function publicFeedAddress(ip: string) {
  try {
    const address = ipaddr.parse(ip);
    return address.kind() === 'ipv4' && address.range() === 'unicast';
  } catch {
    return false;
  }
}

export async function fetchFeed(source: string) {
  const url = allowedFeedUrl(source);
  const signal = AbortSignal.timeout(12_000);
  const addresses = await resolve4(url.hostname);
  signal.throwIfAborted();
  const address = addresses[0];
  if (!address || addresses.some((candidate) => !publicFeedAddress(candidate))) {
    throw new RssConfigurationError('The feed must resolve to a public IPv4 address.');
  }
  return new Promise<string>((resolve, reject) => {
    const req = request(url, {
      family: 4, signal, agent: false,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, (res) => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy();
        reject(new RssConfigurationError('The feed returned an unsupported response.'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > feedLimit) {
          res.destroy(new RssConfigurationError('The feed exceeds 512 KiB.'));
          return;
        }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.once('error', reject);
    req.end();
  });
}

function plain(value: unknown, limit: number) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function link(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function elements(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value])
    .filter((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

export function parseFeed(xml: string) {
  if (Buffer.byteLength(xml) > feedLimit || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new RssConfigurationError('This feed is too large or contains unsupported XML.');
  }
  const parser = new XMLParser({
    processEntities: false, ignoreAttributes: false, parseTagValue: false, maxNestedTags: 32,
  });
  const result = parser.parse(xml);
  const rss = result?.rss?.channel;
  const atom = result?.feed;
  if (!rss && !atom) throw new RssConfigurationError('Only RSS and Atom feeds are supported.');
  return elements(rss ? rss.item : atom.entry).slice(0, 40).flatMap((item) => {
    const title = plain(item.title, 300);
    const summary = plain(item.description ?? item.summary, 1300);
    const atomPath = elements(item.link).find((value) => !value['@_rel'] || value['@_rel'] === 'alternate');
    const source = link(rss ? item.link : atomPath?.['@_href']);
    const guid = item.guid && typeof item.guid === 'object' ? (item.guid as Record<string, unknown>)['#text'] : item.guid;
    const stable = plain(guid ?? item.id, 1000) || source || title;
    const content = [title, summary, source].filter(Boolean).join('\n\n').slice(0, 4096);
    return stable && content ? [{ sourceKey: createHash('sha256').update(stable).digest('hex'), content }] : [];
  });
}
